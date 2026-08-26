import { expireSessions } from '../domain/checkout/service.js';
import { createContext } from '../shared/correlation.js';
import { withTransaction } from '../db/transaction.js';
import { assertTransition, recordTransition } from '../domain/shared/transition.js';
import {
  containRunnerQueueMismatch,
  materializeNextOrderItem,
  releaseExpiredOrderItem,
  requeueDueRunnerJobsInTransaction,
} from '../domain/runner/service.js';
import { RUNNER_JOB_TRANSITIONS } from '../domain/runner/states.js';
import { ORDER_ITEM_TRANSITIONS } from '../domain/orders/states.js';
import { TOPUP_TRANSITIONS } from '../domain/payments/states.js';
import { enqueueCustomerTopupStatus } from '../domain/payments/customer-notification.js';
import { ANALYSIS_TRANSITIONS, SALE_TRANSITIONS, TEST_TRANSITIONS } from '../domain/catalog/states.js';
import { enqueueProjection } from '../domain/outbox/service.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { appendAdminAudit } from '../domain/admin/audit.js';
import { evaluateExpiryAdmission } from '../domain/catalog/expiry.js';
import { resolvePrice } from '../domain/pricing/resolver.js';
import { pauseQuestForRetest } from '../domain/catalog/service.js';
import {
  advanceMonitorTestBatch,
  hasCurrentTestPass,
  reconcileFailedMonitorTestBatches,
  reconcilePassedMonitorTestBatches,
} from '../domain/catalog/test-gate.js';
import { reconcileSurfaceAnchors } from '../discord/surfaces/setup.js';
import { openReview } from '../domain/reviews/service.js';
import { acquireLease, releaseLease, renewLease } from '../db/leases.js';
import { setTimeout as delay } from 'node:timers/promises';
import { v7 as uuidv7 } from 'uuid';
import { QuestshopError } from '../shared/errors.js';
import { prunePersistentRateLimitBlocks } from '../quest-engine/rate-limits/coordinator.js';

function assertRunnerPairTransition(jobState, itemState, nextState) {
  assertTransition(RUNNER_JOB_TRANSITIONS, jobState, nextState);
  assertTransition(ORDER_ITEM_TRANSITIONS, itemState, nextState);
}

async function transitionRunnerPair(database, job, item, nextState, context, reasonCode, {
  delaySeconds = null,
  makeAvailableNow = false,
  clearLease = true,
} = {}) {
  assertRunnerPairTransition(job.state, item.state, nextState);
  const updatedJob = (await database.query(`UPDATE runner_jobs SET state=$2,
      state_version=state_version+1,
      available_at=CASE WHEN $3::integer IS NOT NULL THEN clock_timestamp()+make_interval(secs=>$3)
        WHEN $4::boolean THEN clock_timestamp() ELSE available_at END,
      lease_owner=CASE WHEN $5::boolean THEN NULL ELSE lease_owner END,
      lease_expires_at=CASE WHEN $5::boolean THEN NULL ELSE lease_expires_at END,
      updated_at=clock_timestamp()
      WHERE id=$1 AND state=$6 AND state_version=$7 RETURNING *`,
  [job.id, nextState, delaySeconds, makeAvailableNow, clearLease, job.state, job.state_version])).rows[0];
  if (!updatedJob) throw new QuestshopError('STALE_RUNNER_STATE', `Runner job ${job.id} changed during recovery`);
  const updatedItem = (await database.query(`UPDATE order_items SET state=$2,state_version=state_version+1,
      updated_at=clock_timestamp() WHERE id=$1 AND state=$3 AND state_version=$4 RETURNING *`,
  [item.id, nextState, item.state, item.state_version])).rows[0];
  if (!updatedItem) throw new QuestshopError('STALE_ITEM_STATE', `Order item ${item.id} changed during recovery`);
  await recordTransition(database, { aggregateType: 'RUNNER_JOB', aggregateId: updatedJob.id,
    fromState: job.state, toState: nextState, stateVersion: updatedJob.state_version,
    reasonCode, context });
  await recordTransition(database, { aggregateType: 'ORDER_ITEM', aggregateId: updatedItem.id,
    fromState: item.state, toState: nextState, stateVersion: updatedItem.state_version,
    reasonCode, context });
  return { job: updatedJob, item: updatedItem };
}

async function recoverExpiredLeases(database, context) {
  const leased = (await database.query(`
      SELECT j.*,i.state AS item_state,i.state_version AS item_state_version
      FROM runner_jobs j JOIN order_items i ON i.id=j.order_item_id
      WHERE j.state='LEASED' AND j.lease_expires_at<=clock_timestamp()
      FOR UPDATE OF j,i SKIP LOCKED
    `)).rows;
  for (const job of leased) {
    if (job.item_state !== 'LEASED') {
      await containRunnerQueueMismatch(database, job, context, 'EXPIRED_LEASE_STATE_MISMATCH');
      continue;
    }
    await transitionRunnerPair(database, job, { id: job.order_item_id, state: job.item_state,
      state_version: job.item_state_version }, 'QUEUED', context, 'LEASE_EXPIRED_BEFORE_RUN', {
      makeAvailableNow: true,
    });
  }
  const settled = (await database.query(`
      SELECT j.* FROM runner_jobs j JOIN order_items i ON i.id=j.order_item_id
      WHERE i.state='READY_TO_CLAIM' AND j.state='SETTLING'
      FOR UPDATE OF j,i SKIP LOCKED
    `)).rows;
  for (const job of settled) {
    assertTransition(RUNNER_JOB_TRANSITIONS, job.state, 'COMPLETED');
    const updated = (await database.query(`UPDATE runner_jobs SET state='COMPLETED',
      state_version=state_version+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND state='SETTLING' AND state_version=$2 RETURNING *`,
    [job.id, job.state_version])).rows[0];
    if (!updated) throw new QuestshopError('STALE_RUNNER_STATE', `Runner job ${job.id} changed during settlement recovery`);
    await recordTransition(database, { aggregateType: 'RUNNER_JOB', aggregateId: updated.id,
      fromState: job.state, toState: 'COMPLETED', stateVersion: updated.state_version,
      reasonCode: 'ITEM_ALREADY_READY_TO_CLAIM', context });
  }
}

async function recoverCrashedRunnerJobs(database, context) {
  const crashed = await database.query(`SELECT j.*,
      i.state AS item_state,i.state_version AS item_state_version,
      EXISTS(SELECT 1 FROM runner_mutations m WHERE m.job_id=j.id
        AND m.status IN ('IN_FLIGHT','ACCEPTED','UNCERTAIN')) AS uncertain
      FROM runner_jobs j JOIN order_items i ON i.id=j.order_item_id
      WHERE j.state IN ('RUNNING','VERIFYING','SETTLING')
        AND j.lease_expires_at<=clock_timestamp() FOR UPDATE OF j,i SKIP LOCKED`);
  for (const job of crashed.rows) {
    // An expired runner with a possibly-sent mutation must be reacquired and
    // verified against Discord first. Moving it directly to Manual Review
    // loses the only safe automated recovery path and leaves money reserved.
    // SETTLING is different: wallet settlement cannot be inferred from Quest
    // state alone and remains a financial review case.
    const review = job.state === 'SETTLING';
    const next = review ? 'MANUAL_REVIEW' : 'WAITING_RETRY';
    if (job.item_state !== job.state) {
      await containRunnerQueueMismatch(database, job, context, 'CRASH_RECOVERY_STATE_MISMATCH');
      continue;
    }
    await transitionRunnerPair(database, job, {
      id: job.order_item_id, state: job.item_state, state_version: job.item_state_version,
    }, next, context, 'WORKER_CRASH_RECOVERY', {
      delaySeconds: next === 'WAITING_RETRY' ? 5 : null,
    });
    if (review) await openReview(database, { subjectType: 'ORDER_ITEM', subjectId: job.order_item_id,
      reason: 'WORKER_CRASH_REQUIRES_VERIFICATION', financial: true, ownerOnly: false,
      context: { ...context, traceId: job.trace_id } });
  }
}

async function recoverCrashedQuestTests(database, context) {
  const crashedTests = await database.query(`SELECT tr.*,EXISTS(
      SELECT 1 FROM quest_test_mutations m WHERE m.test_run_id=tr.id
        AND m.status IN ('IN_FLIGHT','ACCEPTED','UNCERTAIN')) AS uncertain
      FROM quest_test_runs tr WHERE tr.state='TESTING'
        AND tr.lease_expires_at<=clock_timestamp() FOR UPDATE`);
  for (const testRun of crashedTests.rows) {
    // A durable mutation checkpoint means the old worker may have changed
    // Discord after its last database write.  Do not turn that uncertainty
    // into a review before a replacement worker has fetched the Quest once.
    // The replacement claims TESTING with a new fence and verifies first.
    if (testRun.uncertain) {
      const recovered = (await database.query(`UPDATE quest_test_runs
          SET lease_owner=NULL,lease_expires_at=clock_timestamp(),error_class='TEST_WORKER_CRASH',
              evidence=evidence||$2::jsonb,updated_at=clock_timestamp()
          WHERE id=$1 AND state='TESTING' AND state_version=$3 RETURNING *`, [
        testRun.id,
        { recovery: 'VERIFY_PENDING_AFTER_CRASH', traceId: testRun.trace_id },
        testRun.state_version,
      ])).rows[0];
      if (recovered) await enqueueProjection(database, { projectionType: 'QUEST_OPERATION',
        aggregateType: 'QUEST', aggregateId: testRun.quest_id,
        aggregateVersion: recovered.state_version, surfaceKey: 'LOG_QUEST_OPERATIONS',
        context: { ...context, traceId: testRun.trace_id } });
      continue;
    }
    const next = 'TEST_FAILED';
    assertTransition(TEST_TRANSITIONS, testRun.state, next);
    const updated = (await database.query(`UPDATE quest_test_runs SET state=$2,
        state_version=state_version+1,lease_owner=NULL,lease_expires_at=NULL,
        error_class='TEST_WORKER_CRASH',completed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 AND state='TESTING' AND state_version=$3 RETURNING *`,
      [testRun.id, next, testRun.state_version])).rows[0];
    if (!updated) continue;
    const tracedContext = { ...context, traceId: testRun.trace_id };
    await recordTransition(database, { aggregateType: 'QUEST_TEST', aggregateId: testRun.id,
      fromState: 'TESTING', toState: next, stateVersion: updated.state_version,
      reasonCode: 'TEST_WORKER_CRASH', context: tracedContext });
    if (updated.batch_id) {
      const quest = (await database.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE',
        [updated.quest_id])).rows[0];
      await advanceMonitorTestBatch(database, { run: updated, quest,
        error: { code: 'TEST_WORKER_CRASH', message: 'Quest test worker stopped before completion' },
        context: tracedContext });
    } else await database.query(`INSERT INTO quest_test_runs(id,quest_id,state,engine_version,
        executor_version,contract_version,contract_hash,deadline_at,trace_id)
        SELECT gen_random_uuid(),quest_id,'TEST_QUEUED',$2,$3,$4,current_contract_hash,expires_at,$5
        FROM quests WHERE quest_id=$1`,
      [testRun.quest_id, testRun.engine_version, testRun.executor_version,
        testRun.contract_version, testRun.trace_id]);
    await enqueueProjection(database, { projectionType: 'QUEST_OPERATION', aggregateType: 'QUEST',
      aggregateId: testRun.quest_id, aggregateVersion: updated.state_version,
      surfaceKey: 'LOG_QUEST_OPERATIONS', context: tracedContext });
  }
}

async function expireQueuedQuestTests(database, context) {
  const due = (await database.query(`SELECT * FROM quest_test_runs
    WHERE state='TEST_QUEUED' AND deadline_at IS NOT NULL AND deadline_at<=clock_timestamp()
    FOR UPDATE SKIP LOCKED`)).rows;
  for (const run of due) {
    assertTransition(TEST_TRANSITIONS, 'TEST_QUEUED', 'TEST_FAILED');
    const failed = (await database.query(`UPDATE quest_test_runs SET state='TEST_FAILED',
      state_version=state_version+1,error_class='TEST_QUEST_EXPIRED',
      completed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND state='TEST_QUEUED' AND state_version=$2 RETURNING *`,
    [run.id, run.state_version])).rows[0];
    if (!failed) continue;
    const traced = { ...context, traceId: run.trace_id };
    await recordTransition(database, { aggregateType: 'QUEST_TEST', aggregateId: run.id,
      fromState: 'TEST_QUEUED', toState: 'TEST_FAILED', stateVersion: failed.state_version,
      reasonCode: 'TEST_QUEST_EXPIRED', context: traced });
    if (!failed.batch_id) continue;
    const quest = (await database.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE',
      [failed.quest_id])).rows[0];
    if (quest) await advanceMonitorTestBatch(database, { run: failed, quest,
      error: { code: 'TEST_QUEST_EXPIRED', message: 'Quest หมดอายุก่อนเริ่ม Monitor test' }, context: traced });
  }
}

async function recoverCrashedPayments(database, context) {
  const crashedPayments = await database.query(`SELECT * FROM topups WHERE status='PROCESSING'
      AND lease_expires_at<=clock_timestamp() FOR UPDATE`);
  for (const row of crashedPayments.rows) {
    assertTransition(TOPUP_TRANSITIONS, row.status, 'AMBIGUOUS');
    const ambiguous = (await database.query(`UPDATE topups SET status='AMBIGUOUS',
        state_version=state_version+1,failure_code='PROCESS_CRASH_AFTER_POSSIBLE_SEND',
        lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND status='PROCESSING' AND state_version=$2 RETURNING *`,
      [row.id, row.state_version])).rows[0];
    if (!ambiguous) continue;
    const tracedContext = { ...context, traceId: row.trace_id };
    await recordTransition(database, { aggregateType: 'TOPUP', aggregateId: row.id,
      fromState: 'PROCESSING', toState: 'AMBIGUOUS', stateVersion: ambiguous.state_version,
      reasonCode: 'PROCESS_CRASH_AFTER_POSSIBLE_SEND', context: tracedContext });
    assertTransition(TOPUP_TRANSITIONS, ambiguous.status, 'MANUAL_REVIEW');
    const reviewState = (await database.query(`UPDATE topups SET status='MANUAL_REVIEW',
        state_version=state_version+1,updated_at=clock_timestamp()
        WHERE id=$1 AND status='AMBIGUOUS' AND state_version=$2 RETURNING *`,
      [row.id, ambiguous.state_version])).rows[0];
    await recordTransition(database, { aggregateType: 'TOPUP', aggregateId: row.id,
      fromState: 'AMBIGUOUS', toState: 'MANUAL_REVIEW', stateVersion: reviewState.state_version,
      reasonCode: 'PROCESS_CRASH_AFTER_POSSIBLE_SEND', context: tracedContext });
    await openReview(database, { subjectType: 'TOPUP', subjectId: row.id,
      reason: 'PROCESS_CRASH_AFTER_POSSIBLE_SEND', financial: true, ownerOnly: true, context: tracedContext });
    await enqueueCustomerTopupStatus(database, reviewState, tracedContext);
  }
  const retries = (await database.query(`SELECT * FROM topups
      WHERE status='RETRY_WAIT' AND available_at<=clock_timestamp()
      FOR UPDATE SKIP LOCKED`)).rows;
  for (const row of retries) {
    assertTransition(TOPUP_TRANSITIONS, row.status, 'PAYMENT_QUEUED');
    const updated = (await database.query(`UPDATE topups SET status='PAYMENT_QUEUED',
      state_version=state_version+1,updated_at=clock_timestamp()
      WHERE id=$1 AND status=$2 AND state_version=$3 RETURNING *`,
    [row.id, row.status, row.state_version])).rows[0];
    if (!updated) throw new QuestshopError('STALE_TOPUP_STATE', `Top-up ${row.id} changed during recovery`);
    await recordTransition(database, { aggregateType: 'TOPUP', aggregateId: updated.id,
      fromState: row.status, toState: 'PAYMENT_QUEUED', stateVersion: updated.state_version, context });
    await enqueueCustomerTopupStatus(database, updated, context);
  }
}

async function maintainMonitorsAndDailyTopupLocks(database, context) {
  await database.query(`UPDATE monitor_accounts SET state='ACTIVE',state_version=state_version+1,cooldown_until=NULL,
      updated_at=clock_timestamp() WHERE state='COOLDOWN' AND cooldown_until<=clock_timestamp()`);
  const expiredLocks = await database.query(`DELETE FROM topup_daily_locks
    WHERE expires_at<=clock_timestamp() RETURNING *`);
  for (const lock of expiredLocks.rows) await appendAdminAudit(database, { action: 'TOPUP_DAILY_LOCK_EXPIRED',
      targetType: 'DISCORD_USER', targetId: lock.discord_user_id, actorId: 'SYSTEM', before: lock,
      after: { expiredAt: lock.expires_at }, reason: 'daily top-up cycle ended', context });
}

export async function queueMaintenanceNotifications(database, context) {
  const incidents = await database.query(`SELECT * FROM incidents WHERE state<>'RESOLVED'`);
  for (const incident of incidents.rows) await enqueueProjection(database, {
      projectionType: 'SYSTEM_INCIDENT', aggregateType: 'INCIDENT', aggregateId: incident.id,
      aggregateVersion: incident.state_version, surfaceKey: 'LOG_SYSTEM', context,
    });
  const dueReviews = await database.query(`UPDATE manual_reviews SET
      remind_at=CASE
        WHEN clock_timestamp()<created_at+interval '6 hours' THEN created_at+interval '6 hours'
        WHEN clock_timestamp()<created_at+interval '24 hours' THEN created_at+interval '24 hours'
        ELSE clock_timestamp()+interval '24 hours' END
      WHERE state<>'RESOLVED' AND remind_at<=clock_timestamp()
      RETURNING *,
        CASE WHEN clock_timestamp()<created_at+interval '6 hours' THEN '1H'
          WHEN clock_timestamp()<created_at+interval '24 hours' THEN '6H'
          ELSE '24H_OWNER' END AS reminder_stage,
        floor(extract(epoch FROM clock_timestamp()))::bigint AS reminder_version`);
  for (const review of dueReviews.rows) {
    await database.query(`INSERT INTO review_evidence(id,review_id,evidence_type,payload,actor_type,actor_id,trace_id)
      VALUES($1,$2,'REMINDER_SENT',$3,'SYSTEM','maintenance-worker',$4)`,
    [uuidv7(), review.id, { stage: review.reminder_stage,
      ownerEscalated: review.reminder_stage === '24H_OWNER' }, context.traceId]);
    await enqueueProjection(database, {
      projectionType: 'MANUAL_REVIEW', aggregateType: 'MANUAL_REVIEW', aggregateId: review.id,
      aggregateVersion: review.reminder_version, surfaceKey: 'ADMIN_PANEL', context,
    });
  }
}

async function runTransactionalMaintenanceSection(pool, context, work) {
  return withTransaction({ pool, isolation: 'SERIALIZABLE' }, work);
}

async function runTransactionalMaintenance(pool, context) {
  // Recovery used to put every independent repair in one serializable
  // transaction. A harmless stale row could then roll back payment recovery,
  // reminders, leases and monitor cleanup together. Keep related runner work
  // atomic, but commit each durable maintenance concern separately.
  const sections = [
    async (database) => {
      await recoverExpiredLeases(database, context);
      await recoverCrashedRunnerJobs(database, context);
      await requeueDueRunnerJobsInTransaction(database, context, { includeExpired: true });
    },
    async (database) => {
      await recoverCrashedQuestTests(database, context);
      await expireQueuedQuestTests(database, context);
      await reconcilePassedMonitorTestBatches(database, context);
      await reconcileFailedMonitorTestBatches(database, context);
    },
    async (database) => recoverCrashedPayments(database, context),
    async (database) => maintainMonitorsAndDailyTopupLocks(database, context),
    async (database) => queueMaintenanceNotifications(database, context),
  ];
  for (const section of sections) await runTransactionalMaintenanceSection(pool, context, section);
}

async function releaseExpiredOrderItems(pool, context) {
  const expiredItems = (await pool.query(`SELECT i.id FROM order_items i
    WHERE i.state IN ('RESERVED','QUEUED') AND i.deadline_at<=clock_timestamp() LIMIT 100`)).rows;
  for (const item of expiredItems) {
    await releaseExpiredOrderItem({ orderItemId: item.id,
      reason: 'QUEST_EXPIRED_BEFORE_START' }, { ...context,
      idempotencyKey: `${context.idempotencyKey}:expiry:${item.id}` }, { pool });
  }
}

export async function reconcileSellableQuests(pool, context, runnerConcurrency) {
  const sellable = (await pool.query(`SELECT * FROM quests WHERE sale_state IN ('OPEN','PAUSED','CLOSED')
    ORDER BY CASE sale_state WHEN 'OPEN' THEN 0 WHEN 'PAUSED' THEN 1 ELSE 2 END,
      expires_at NULLS LAST,updated_at,quest_id LIMIT 100`)).rows;
  for (const quest of sellable) {
    const admission = await withTransaction({ pool, isolation: 'READ COMMITTED', maxAttempts: 1 },
      (database) => evaluateExpiryAdmission(database, { quest, runnerConcurrency }));
    if (!admission.eligible) {
      await withTransaction({ pool, isolation: 'READ COMMITTED' }, async (database) => {
        const current = (await database.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE', [quest.quest_id])).rows[0];
        if (!current) return;
        const currentAdmission = await evaluateExpiryAdmission(database, { quest: current, runnerConcurrency });
        if (currentAdmission.eligible) return;
        const expired = currentAdmission.reason !== 'EXPIRY_MISSING'
          && currentAdmission.reason !== 'QUEST_NOT_STARTED'
          && Number.isFinite(currentAdmission.remainingMs) && currentAdmission.remainingMs <= 0;
        const next = expired ? 'EXPIRED' : 'PAUSED';
        if (current.sale_state === next) return;
        assertTransition(SALE_TRANSITIONS, current.sale_state, next);
        const analysisExpires = next === 'EXPIRED' && current.analysis_state !== 'EXPIRED';
        if (analysisExpires) assertTransition(ANALYSIS_TRANSITIONS, current.analysis_state, 'EXPIRED');
        const updated = (await database.query(`UPDATE quests SET sale_state=$2,
          analysis_state=CASE WHEN $2='EXPIRED' THEN 'EXPIRED' ELSE analysis_state END,
          sale_version=sale_version+1,
          analysis_version=analysis_version+CASE WHEN $2='EXPIRED' AND analysis_state<>'EXPIRED' THEN 1 ELSE 0 END,
          updated_at=clock_timestamp() WHERE quest_id=$1 AND sale_state=$3 AND sale_version=$4 RETURNING *`,
        [current.quest_id, next, current.sale_state, current.sale_version])).rows[0];
        if (!updated) return;
        if (current.sale_state !== updated.sale_state) {
          await recordTransition(database, { aggregateType: 'QUEST_SALE', aggregateId: updated.quest_id,
            fromState: current.sale_state, toState: updated.sale_state,
            stateVersion: updated.sale_version, reasonCode: currentAdmission.reason, context });
        }
        if (current.analysis_state !== updated.analysis_state) {
          await recordTransition(database, { aggregateType: 'QUEST_ANALYSIS', aggregateId: updated.quest_id,
            fromState: current.analysis_state, toState: updated.analysis_state,
            stateVersion: updated.analysis_version, reasonCode: currentAdmission.reason, context });
        }
        await enqueueProjection(database, { projectionType: 'QUEST_NEW', aggregateType: 'QUEST',
          aggregateId: updated.quest_id, aggregateVersion: updated.sale_version,
          surfaceKey: 'QUEST_NEW', context });
      });
      continue;
    }
    await withTransaction({ pool, isolation: 'READ COMMITTED' }, async (database) => {
      const current = (await database.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE', [quest.quest_id])).rows[0];
      const testPassed = await hasCurrentTestPass(database, current);
      if (!testPassed) {
        if (current.sale_state === 'OPEN') await pauseQuestForRetest(database, current, context);
        return;
      }
      if (!['CLOSED', 'PAUSED'].includes(current.sale_state) || current.analysis_state !== 'SUPPORTED') return;
      const coreComplete = Boolean(current.name && current.task_type && Number(current.task_target) > 0
        && current.url && current.starts_at && current.expires_at && current.executor_id);
      const price = await resolvePrice(database, { questId: current.quest_id, taskType: current.task_type });
      if (!coreComplete || !price) return;
      assertTransition(SALE_TRANSITIONS, current.sale_state, 'OPEN');
      const opened = (await database.query(`UPDATE quests SET sale_state='OPEN',sale_version=sale_version+1,
        updated_at=clock_timestamp() WHERE quest_id=$1 AND sale_state=$2 AND sale_version=$3 RETURNING *`,
      [current.quest_id, current.sale_state, current.sale_version])).rows[0];
      if (!opened) return;
      await recordTransition(database, { aggregateType: 'QUEST_SALE', aggregateId: opened.quest_id,
        fromState: current.sale_state, toState: 'OPEN', stateVersion: opened.sale_version,
        reasonCode: 'MONITOR_TEST_PASSED', context });
      await enqueueProjection(database, { projectionType: 'QUEST_NEW', aggregateType: 'QUEST',
        aggregateId: opened.quest_id, aggregateVersion: opened.sale_version,
        surfaceKey: 'QUEST_NEW', context });
    });
  }
}

async function materializeAvailableOrders(pool, context) {
  const orders = (await pool.query(`SELECT DISTINCT i.order_id FROM order_items i
    WHERE i.state='RESERVED' AND NOT EXISTS(SELECT 1 FROM runner_jobs j JOIN order_items active
      ON active.id=j.order_item_id WHERE active.order_id=i.order_id
      AND j.state NOT IN ('COMPLETED','FAILED')) LIMIT 100`)).rows;
  for (const order of orders) await materializeNextOrderItem({ orderId: order.order_id }, context, { pool });
}

function startMaintenanceHeartbeat(lease, pool) {
  const abort = new AbortController();
  let lost = null;
  const done = (async () => {
    while (!abort.signal.aborted) {
      await delay(30_000, undefined, { signal: abort.signal, ref: false });
      if (abort.signal.aborted) break;
      try {
        await renewLease({ resourceType: 'MAINTENANCE', resourceId: lease.resource_id,
          holder: lease.lease_owner, fencingToken: lease.fencing_token, ttlSeconds: 120 }, { pool });
      } catch (error) {
        lost = error;
        abort.abort(error);
      }
    }
  })().catch((error) => {
    if (error?.name !== 'AbortError') {
      lost = error;
      abort.abort(error);
    }
  });
  return {
    assertOwned() { if (lost) throw lost; },
    async stop() { abort.abort('maintenance complete'); await done; },
  };
}

async function runMaintainedStep(heartbeat, action) {
  heartbeat.assertOwned();
  const result = await action();
  heartbeat.assertOwned();
  return result;
}

export async function runMaintenance({ env, holder, client, pool, runnerConcurrency = env.RUNNER_CONCURRENCY }) {
  // Startup recovery historically used a human-readable holder.  The durable
  // lease owner is UUID typed, so keep that diagnostic actor separately.
  const leaseHolder = typeof holder === 'string' && /^[0-9a-f]{8}-/i.test(holder) ? holder : uuidv7();
  const lease = await acquireLease({ resourceType: 'MAINTENANCE', resourceId: env.DISCORD_GUILD_ID,
    holder: leaseHolder, ttlSeconds: 120 }, { pool });
  if (!lease) return false;
  const heartbeat = startMaintenanceHeartbeat(lease, pool);
  const context = createContext({ actorType: 'SYSTEM', actorId: holder, guildId: env.DISCORD_GUILD_ID,
    idempotencyKey: `maintenance:${new Date().toISOString().slice(0, 16)}` });
  try {
    await runMaintainedStep(heartbeat, () => expireSessions({}, context, { pool }));
    await runMaintainedStep(heartbeat, () => runTransactionalMaintenance(pool, context));
    await runMaintainedStep(heartbeat, () => releaseExpiredOrderItems(pool, context));
    await runMaintainedStep(heartbeat, () => reconcileSellableQuests(pool, context, runnerConcurrency));
    await runMaintainedStep(heartbeat, () => materializeAvailableOrders(pool, context));
    await runMaintainedStep(heartbeat, () => prunePersistentRateLimitBlocks({ pool }));
    client.questshop.config = await runMaintainedStep(heartbeat, () => loadRuntimeConfig(pool));
    await runMaintainedStep(heartbeat, () => reconcileSurfaceAnchors({ client, pool, env,
      config: client.questshop.config }, context));
    return true;
  } finally {
    await heartbeat.stop();
    await releaseLease({ resourceType: 'MAINTENANCE', resourceId: env.DISCORD_GUILD_ID,
      holder: lease.lease_owner, fencingToken: lease.fencing_token }, { pool });
  }
}
