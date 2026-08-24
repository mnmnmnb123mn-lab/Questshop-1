import { v7 as uuidv7 } from 'uuid';
import { setTimeout as delay } from 'node:timers/promises';
import { decryptSecret } from '../adapters/crypto/keyring.js';
import { createQuestApiClient, profileFromEnv } from '../quest-engine/api/client.js';
import { getPersistentDiscordRateLimitCoordinator } from '../quest-engine/rate-limits/coordinator.js';
import { selectQuestExecutor } from '../quest-engine/executors/registry.js';
import { executeQuestExecutor } from '../quest-engine/executors/contract.js';
import { createContext } from '../shared/correlation.js';
import { FencingLostError } from '../shared/errors.js';
import { ingestDiscovery } from '../domain/catalog/service.js';
import { reconcileIncident } from '../domain/incidents/service.js';
import { secureJitter } from '../shared/random.js';
import { withTransaction } from '../db/transaction.js';
import { RUNNER_VERSION_COMPATIBILITY } from '../config/versions.js';
import { assertTransition, recordTransition } from '../domain/shared/transition.js';
import { advanceMonitorTestBatch, markMonitorTestBatchPassed } from '../domain/catalog/test-gate.js';
import { TEST_TRANSITIONS, SALE_TRANSITIONS } from '../domain/catalog/states.js';
import { evaluateExpiryAdmission } from '../domain/catalog/expiry.js';

function mutationMayHaveBeenSent(error) {
  if (typeof error?.possiblySent === 'boolean') return error.possiblySent;
  if (error?.fatalAuth || error?.category === 'BUSINESS' || error?.category === 'VALIDATION') return false;
  const status = Number(error?.status);
  return error?.category === 'PROVIDER' || status === 429 || status >= 500 || error?.name === 'TypeError';
}

function canControlledRetryTestMutation(error) {
  if (!error) return true;
  if (mutationMayHaveBeenSent(error)) return true;
  return error?.retryable === true || error?.category === 'NETWORK' || Number(error?.status) === 429;
}

export async function acquireTestRun({ holder, pool }) {
  const engineVersions = RUNNER_VERSION_COMPATIBILITY.map((item) => item.engine);
  const executorVersions = RUNNER_VERSION_COMPATIBILITY.map((item) => item.executor);
  const contractVersions = RUNNER_VERSION_COMPATIBILITY.map((item) => item.contract);
  return withTransaction({ pool, isolation: 'READ COMMITTED' }, async (client) => {
    const candidate = (await client.query(`SELECT tr.*,q.task_type,q.executor_id,
      q.contract_version AS current_contract,m.id AS selected_monitor_id,m.account_id AS selected_account_id,
      m.username AS selected_username,m.capabilities AS selected_capabilities,m.state AS selected_state,
      m.priority AS selected_priority,m.consecutive_failures AS selected_failures,
      m.cooldown_until AS selected_cooldown,m.last_used_at AS selected_last_used,
      c.key_version,c.nonce,c.ciphertext,c.auth_tag
      FROM quest_test_runs tr JOIN quests q ON q.quest_id=tr.quest_id
      -- A recovered TESTING run must verify through the exact account that
      -- sent its prior mutation. Fresh queued work with no target may select
      -- any active monitor.
      JOIN monitor_accounts m ON (m.id=COALESCE(tr.monitor_id,tr.target_monitor_id)
        OR (tr.monitor_id IS NULL AND tr.target_monitor_id IS NULL))
      JOIN monitor_credentials c ON c.monitor_id=m.id
      WHERE (tr.state='TEST_QUEUED' AND tr.available_at<=clock_timestamp()
          OR tr.state='TESTING' AND tr.lease_expires_at<=clock_timestamp())
        AND tr.contract_hash IS NOT DISTINCT FROM q.current_contract_hash
        AND (tr.deadline_at IS NULL OR tr.deadline_at>clock_timestamp())
        AND m.state='ACTIVE' AND 'TEST'=ANY(m.capabilities)
        AND EXISTS (SELECT 1 FROM unnest($1::text[],$2::text[],$3::text[])
          AS supported(engine,executor,contract)
          WHERE supported.engine=tr.engine_version AND supported.executor=tr.executor_version
            AND supported.contract=tr.contract_version)
      ORDER BY tr.created_at,m.last_used_at NULLS FIRST,m.priority DESC
      FOR UPDATE OF tr,m SKIP LOCKED LIMIT 1`, [engineVersions, executorVersions, contractVersions])).rows[0];
    if (!candidate) return null;
    const isRecovery = candidate.state === 'TESTING';
    const run = (await client.query(`UPDATE quest_test_runs SET state='TESTING',state_version=state_version+1,
      monitor_id=$1,lease_owner=$2,lease_expires_at=clock_timestamp()+interval '120 seconds',
      fencing_token=fencing_token+1,started_at=COALESCE(started_at,clock_timestamp()),updated_at=clock_timestamp()
      WHERE id=$3 AND state=$4 AND state_version=$5 RETURNING *`, [
      candidate.selected_monitor_id, holder, candidate.id, candidate.state, candidate.state_version,
    ])).rows[0];
    if (!run) return null;
    const monitor = {
      id: candidate.selected_monitor_id, account_id: candidate.selected_account_id,
      username: candidate.selected_username, capabilities: candidate.selected_capabilities,
      state: candidate.selected_state, priority: candidate.selected_priority,
      consecutive_failures: candidate.selected_failures, cooldown_until: candidate.selected_cooldown,
      last_used_at: candidate.selected_last_used, key_version: candidate.key_version,
      nonce: candidate.nonce, ciphertext: candidate.ciphertext, auth_tag: candidate.auth_tag,
    };
    await client.query('UPDATE monitor_accounts SET last_used_at=clock_timestamp() WHERE id=$1', [monitor.id]);
    if (!isRecovery) await recordTransition(client, { aggregateType: 'QUEST_TEST', aggregateId: run.id,
      fromState: 'TEST_QUEUED', toState: 'TESTING', stateVersion: run.state_version,
      reasonCode: 'TEST_LEASED', context: { traceId: run.trace_id, causationId: null,
        actorType: 'SYSTEM', actorId: holder } });
    return { run: { ...run, task_type: candidate.task_type, executor_id: candidate.executor_id,
      current_contract: candidate.current_contract, recoveredAfterCrash: isRecovery }, monitor };
  });
}

export async function renewQuestTestLease(run, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const updated = (await client.query(`UPDATE quest_test_runs
      SET lease_expires_at=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp()
      WHERE id=$1 AND state='TESTING' AND lease_owner=$2 AND fencing_token=$3
        AND lease_expires_at>clock_timestamp() RETURNING *`,
    [run.id, run.lease_owner, run.fencing_token])).rows[0];
    if (!updated) throw new FencingLostError(`quest-test:${run.id}`);
    return updated;
  });
}

async function createTestMutation(pool, run, context, { kind, payload, baseline, parentMutationId = null }) {
  return withTransaction({ pool, isolation: 'READ COMMITTED' }, async (client) => {
    const owned = (await client.query(`SELECT 1 FROM quest_test_runs WHERE id=$1 AND state='TESTING'
      AND lease_owner=$2 AND fencing_token=$3 AND lease_expires_at>clock_timestamp() FOR UPDATE`,
    [run.id, run.lease_owner, run.fencing_token])).rowCount;
    if (!owned) throw new FencingLostError(`quest-test:${run.id}`);
    const sequence = Number((await client.query(`SELECT COALESCE(max(sequence_number),0)+1 AS value
      FROM quest_test_mutations WHERE test_run_id=$1`, [run.id])).rows[0].value);
    return (await client.query(`INSERT INTO quest_test_mutations(id,test_run_id,sequence_number,
      mutation_kind,status,baseline_progress,target_payload,trace_id,parent_mutation_id)
      VALUES($1,$2,$3,$4,'PREPARED',$5,$6,$7,$8) RETURNING *`,
    [uuidv7(), run.id, sequence, kind, baseline, payload, context.traceId, parentMutationId])).rows[0];
  });
}

async function setMutationState(pool, run, mutation, state, evidence = {}) {
  return withTransaction({ pool, isolation: 'READ COMMITTED' }, async (client) => {
    const owned = (await client.query(`SELECT 1 FROM quest_test_runs WHERE id=$1 AND state='TESTING'
      AND lease_owner=$2 AND fencing_token=$3 AND lease_expires_at>clock_timestamp()`,
    [run.id, run.lease_owner, run.fencing_token])).rowCount;
    if (!owned) throw new FencingLostError(`quest-test:${run.id}`);
    return (await client.query(`UPDATE quest_test_mutations SET status=$2,evidence=evidence||$3::jsonb,
      attempted_at=CASE WHEN $2='IN_FLIGHT' THEN clock_timestamp() ELSE attempted_at END,
      verified_at=CASE WHEN $2='VERIFIED' THEN clock_timestamp() ELSE verified_at END
      WHERE id=$1 RETURNING *`, [mutation.id, state, evidence])).rows[0];
  });
}

function testContext(run, holder, env) {
  return createContext({ traceId: run.trace_id, actorType: 'SYSTEM', actorId: holder,
    guildId: env.DISCORD_GUILD_ID, idempotencyKey: `quest-test:${run.id}` });
}

function startTestHeartbeat(run, pool, signal) {
  const leaseAbort = new AbortController();
  const testSignal = AbortSignal.any([signal, leaseAbort.signal]);
  const heartbeat = (async () => {
    while (!testSignal.aborted) {
      await delay(30_000, undefined, { signal: testSignal, ref: false });
      if (!testSignal.aborted) await renewQuestTestLease(run, { pool });
    }
  })().catch((error) => { if (!testSignal.aborted) leaseAbort.abort(error); });
  return { testSignal, stop: async () => { leaseAbort.abort('quest test finished'); await heartbeat; } };
}

async function loadTestQuest({ monitor, run, env, pool, testSignal, allowCompleted = false }) {
  const token = decryptSecret({ keyVersion: monitor.key_version, nonce: monitor.nonce,
      ciphertext: monitor.ciphertext, authTag: monitor.auth_tag }, env.DATA_ENCRYPTION_KEYS_JSON,
    `monitor:${monitor.id}:${env.DISCORD_GUILD_ID}`);
  const api = createQuestApiClient({ token, profile: profileFromEnv(env),
    coordinator: getPersistentDiscordRateLimitCoordinator(pool) });
  const quest = (await api.fetchQuests(testSignal)).find((candidate) => candidate.id === run.quest_id);
  const executor = quest && selectQuestExecutor(quest);
  if (!quest || !executor?.supportsAutomaticProgress || executor.id !== run.executor_id) {
    throw Object.assign(new Error('Quest contract unsupported on monitor'), { code: 'TEST_CONTRACT_UNSUPPORTED' });
  }
  if (quest.contractHash !== run.contract_hash) {
    throw Object.assign(new Error('Quest contract changed since this test was queued'), {
      code: 'TEST_CONTRACT_CHANGED', category: 'BUSINESS',
    });
  }
  if (quest.completed && !allowCompleted) {
    throw Object.assign(new Error('Monitor already completed this Quest'), {
      code: 'MONITOR_QUEST_ALREADY_COMPLETED', accountSpecific: true,
    });
  }
  return { api, quest, executor };
}

function mutationApplied(kind, fresh, baseline) {
  if (kind === 'ENROLL') return fresh.enrolled;
  return fresh.completed || Number(fresh.progressSecs) > Number(baseline);
}

async function performTestMutation(pool, run, context, input) {
  let mutation = await createTestMutation(pool, run, context, input);
  mutation = await setMutationState(pool, run, mutation, 'IN_FLIGHT');
  try {
    await input.perform();
    return setMutationState(pool, run, mutation, 'ACCEPTED');
  } catch (cause) {
    const outcome = mutationMayHaveBeenSent(cause) ? 'UNCERTAIN' : 'FAILED';
    const updated = await setMutationState(pool, run, mutation, outcome, {
      code: cause.code ?? cause.name,
      possiblySent: outcome === 'UNCERTAIN',
    });
    return { ...updated, mutationError: cause };
  }
}

function freshQuestLoader(api, run, testSignal) {
  return async () => {
    const fresh = (await api.fetchQuests(testSignal)).find((candidate) => candidate.id === run.quest_id);
    if (!fresh) throw Object.assign(new Error('Quest disappeared during test'), { code: 'TEST_QUEST_MISSING' });
    return fresh;
  };
}

function createTestMutator({ pool, run, context, testSignal, freshQuest, getCurrent, setCurrent,
  recoveredMutation = null }) {
  return async (kind, payload, perform) => {
    const baseline = getCurrent().progressSecs;
    const recoveryRetry = recoveredMutation && recoveredMutation.mutation_kind === kind;
    let mutation = await performTestMutation(pool, run, context, {
      kind, payload: recoveryRetry ? { ...payload, controlledRetry: true } : payload, baseline, perform,
      parentMutationId: recoveryRetry ? recoveredMutation.id : null,
    });
    let fresh = await freshQuest();
    if (!mutationApplied(kind, fresh, baseline)) {
      if (mutation.mutationError?.fatalAuth) throw mutation.mutationError;
      if (!canControlledRetryTestMutation(mutation.mutationError)) throw mutation.mutationError;
      await setMutationState(pool, run, mutation, 'FAILED', { freshProgress: fresh.progressSecs });
      await delay(secureJitter(1000), undefined, { signal: testSignal, ref: false });
      mutation = await performTestMutation(pool, run, context, {
        kind, payload: { ...payload, controlledRetry: true }, baseline, perform,
        parentMutationId: mutation.id,
      });
      fresh = await freshQuest();
    }
    if (!mutationApplied(kind, fresh, baseline)) {
      throw Object.assign(new Error('Test mutation not verified'), { code: 'TEST_MUTATION_NOT_VERIFIED' });
    }
    await setMutationState(pool, run, mutation, 'VERIFIED', { freshProgress: fresh.progressSecs });
    setCurrent(fresh);
    return fresh;
  };
}

async function deferTestRun(pool, run, context, reasonCode, delayMs) {
  return withTransaction({ pool, isolation: 'READ COMMITTED' }, async (client) => {
    assertTransition(TEST_TRANSITIONS, 'TESTING', 'TEST_QUEUED');
    const seconds = Math.max(1, Math.ceil(delayMs / 1_000));
    const deferred = (await client.query(`UPDATE quest_test_runs SET state='TEST_QUEUED',
        state_version=state_version+1,available_at=clock_timestamp()+make_interval(secs=>$4),
        lease_owner=NULL,lease_expires_at=NULL,started_at=NULL,updated_at=clock_timestamp(),
        evidence=evidence||$5::jsonb
        WHERE id=$1 AND state='TESTING' AND lease_owner=$2 AND fencing_token=$3
          AND lease_expires_at>clock_timestamp() RETURNING *`, [
      run.id, run.lease_owner, run.fencing_token, seconds, { deferred: reasonCode },
    ])).rows[0];
    if (!deferred) throw new FencingLostError(`quest-test:${run.id}`);
    await recordTransition(client, { aggregateType: 'QUEST_TEST', aggregateId: deferred.id,
      fromState: 'TESTING', toState: 'TEST_QUEUED', stateVersion: deferred.state_version,
      reasonCode, context });
    return deferred;
  });
}

async function enforceTestAdmission({ pool, run, quest, runnerConcurrency, context }) {
  const blockedUntil = Date.parse(quest.enrollmentBlockedUntil);
  if (Number.isFinite(blockedUntil)) {
    const result = await pool.query(`SELECT GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)::bigint AS wait_ms`,
      [new Date(blockedUntil).toISOString()]);
    const waitMs = Number(result.rows[0].wait_ms);
    if (waitMs > 0) {
      await deferTestRun(pool, run, context, 'TEST_ENROLLMENT_BLOCKED', waitMs);
      return { deferred: true };
    }
  }
  const admission = await withTransaction({ pool, isolation: 'READ COMMITTED', maxAttempts: 1 },
    (client) => evaluateExpiryAdmission(client, { quest, runnerConcurrency }));
  if (admission.eligible) return { deferred: false };
  if (admission.reason === 'QUEST_NOT_STARTED') {
    const result = await pool.query(`SELECT GREATEST(1000,extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)::bigint AS wait_ms`,
      [admission.availableAt]);
    const delayMs = Number(result.rows[0].wait_ms);
    await deferTestRun(pool, run, context, 'TEST_QUEST_NOT_STARTED', delayMs);
    return { deferred: true };
  }
  throw Object.assign(new Error('Quest does not have enough time for a safe Monitor test'), {
    code: 'TEST_EXPIRY_ADMISSION_FAILED', category: 'BUSINESS', admission,
  });
}

async function latestRecoverableMutation(pool, run) {
  return (await pool.query(`SELECT * FROM quest_test_mutations WHERE test_run_id=$1
      AND status IN ('PREPARED','IN_FLIGHT','ACCEPTED','UNCERTAIN')
      ORDER BY sequence_number DESC LIMIT 1`, [run.id])).rows[0] ?? null;
}

async function verifyRecoveredTestMutation({ pool, run, quest }) {
  const mutation = await latestRecoverableMutation(pool, run);
  if (!mutation) return { mutation: null, completed: false };
  const applied = mutationApplied(mutation.mutation_kind, quest, mutation.baseline_progress);
  await setMutationState(pool, run, mutation, applied ? 'VERIFIED' : 'FAILED', {
    recovery: 'FRESH_READ_AFTER_CRASH', freshProgress: quest.progressSecs,
  });
  // Enrollment alone is not proof that this worker completed the Quest.  A
  // crash after ENROLL may coincide with an unrelated completion, so only a
  // durable progress mutation can recover the test as passed.
  return { mutation, completed: applied && mutation.mutation_kind !== 'ENROLL'
    && quest.completed && Boolean(quest.completedAt) };
}

async function markTestPassed({ pool, run, monitor, executor, quest, context }) {
  await withTransaction({ pool, isolation: 'SERIALIZABLE' }, async (client) => {
    assertTransition(TEST_TRANSITIONS, 'TESTING', 'TEST_PASSED');
    const passed = (await client.query(`UPDATE quest_test_runs SET state='TEST_PASSED',
      state_version=state_version+1,evidence=$4,completed_at=clock_timestamp(),
      lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND state='TESTING' AND lease_owner=$2 AND fencing_token=$3
        AND lease_expires_at>clock_timestamp() RETURNING *`, [run.id, run.lease_owner, run.fencing_token,
      { accountVisible: true, executorId: executor.id, completedAt: quest.completedAt, traceId: context.traceId }])).rows[0];
    if (!passed) throw new FencingLostError(`quest-test:${run.id}`);
    await recordTransition(client, { aggregateType: 'QUEST_TEST', aggregateId: passed.id,
      fromState: 'TESTING', toState: 'TEST_PASSED', stateVersion: passed.state_version,
      reasonCode: 'TEST_COMPLETION_VERIFIED', context });
    await markMonitorTestBatchPassed(client, { run: passed, context });
  });
  await pool.query(`UPDATE monitor_accounts SET consecutive_failures=0,updated_at=clock_timestamp()
      WHERE id=$1`, [monitor.id]);
}

async function executeTestQuest({ pool, run, monitor, env, runnerConcurrency, testSignal, context }) {
  const { api, quest, executor } = await loadTestQuest({ monitor, run, env, pool, testSignal,
    allowCompleted: Boolean(run.recoveredAfterCrash) });
  const admission = await enforceTestAdmission({ pool, run, quest, runnerConcurrency, context });
  if (admission.deferred) return { deferred: true };
  const recovered = run.recoveredAfterCrash
    ? await verifyRecoveredTestMutation({ pool, run, quest }) : { mutation: null, completed: false };
  if (recovered.completed) {
    await markTestPassed({ pool, run, monitor, executor, quest, context });
    await ingestDiscovery({ normalized: quest, source: 'MONITOR', runnerConcurrency }, context, { pool });
    return { recovered: true };
  }
  if (quest.completed) throw Object.assign(new Error('Monitor already completed this Quest'), {
    code: 'MONITOR_QUEST_ALREADY_COMPLETED', accountSpecific: true,
  });
  let current = quest;
  const freshQuest = freshQuestLoader(api, run, testSignal);
  const mutate = createTestMutator({ pool, run, context, testSignal, freshQuest,
    getCurrent: () => current, setCurrent: (fresh) => { current = fresh; },
    recoveredMutation: recovered.mutation });
  if (!current.enrolled) current = await mutate('ENROLL', {}, () => api.enroll(current.id, testSignal));
  const execution = await executeQuestExecutor(executor, { quest: current, api, signal: testSignal, mutate,
      fetchFreshQuest: freshQuest, onServerProgress: async () => {},
      sleep: (ms, abortSignal) => delay(ms, undefined, { signal: abortSignal, ref: false }),
      now: () => Date.now() });
  current = await freshQuest();
  if (!execution.verified || !current.completed || !current.completedAt) {
    throw Object.assign(new Error('Background test completion not verified'), { code: 'TEST_COMPLETION_NOT_VERIFIED' });
  }
  await markTestPassed({ pool, run, monitor, executor, quest: current, context });
  await ingestDiscovery({ normalized: current, source: 'MONITOR',
      runnerConcurrency }, context, { pool });
}

function monitorFailureState(error, failures) {
  if (error.fatalAuth || failures >= 5) return 'QUARANTINED';
  if (failures >= 3) return 'COOLDOWN';
  return 'ACTIVE';
}

async function finishFailedTestRun(client, run, error, context) {
  const nextTestState = error.fatalAuth ? 'MANUAL_REVIEW' : 'TEST_FAILED';
  assertTransition(TEST_TRANSITIONS, 'TESTING', nextTestState);
  const failed = (await client.query(`UPDATE quest_test_runs SET state=$4,state_version=state_version+1,
    error_class=$5,evidence=$6,completed_at=clock_timestamp(),lease_owner=NULL,
    lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE id=$1 AND state='TESTING' AND lease_owner=$2 AND fencing_token=$3
      AND lease_expires_at>clock_timestamp() RETURNING *`, [run.id, run.lease_owner, run.fencing_token,
    nextTestState, error.code ?? error.name,
    { accountSpecific: Boolean(error.fatalAuth || error.accountSpecific), traceId: context.traceId }])).rows[0];
  if (!failed) throw new FencingLostError(`quest-test:${run.id}`);
  await recordTransition(client, { aggregateType: 'QUEST_TEST', aggregateId: run.id,
    fromState: 'TESTING', toState: nextTestState, stateVersion: failed.state_version,
    reasonCode: error.code ?? error.name, context });
  return failed;
}

async function updateMonitorForFailure(database, monitor, error, context) {
  if (!(error.fatalAuth || error.retryable || error.category === 'NETWORK')) return;
  const failures = Number(monitor.consecutive_failures) + 1;
  const state = monitorFailureState(error, failures);
  const updated = (await database.query(`UPDATE monitor_accounts SET state=$2,consecutive_failures=$3,
    state_version=state_version+CASE WHEN state<>$2 THEN 1 ELSE 0 END,
    cooldown_until=CASE WHEN $2='COOLDOWN' THEN clock_timestamp()+interval '15 minutes'
      ELSE cooldown_until END,updated_at=clock_timestamp()
    WHERE id=$1 AND state<>'DISABLED' RETURNING state`, [monitor.id, state, failures])).rows[0];
  if (updated?.state !== 'QUARANTINED') return;
  await reconcileIncident({ code: 'MONITOR_QUARANTINED', scope: monitor.id, active: true,
    severity: 'ERROR', evidence: { errorCode: error.code ?? error.name } }, context, { client: database });
}

async function queueAlternativeMonitorTest(pool, run, monitor, error) {
  if (!(error.accountSpecific || error.fatalAuth)) return;
  const alternate = Number((await pool.query(`SELECT count(*)::integer AS count FROM monitor_accounts
    WHERE id<>$1 AND state='ACTIVE' AND 'TEST'=ANY(capabilities)`, [monitor.id])).rows[0].count);
  if (!alternate) return;
  await pool.query(`INSERT INTO quest_test_runs(id,quest_id,state,engine_version,
    executor_version,contract_version,contract_hash,deadline_at,trace_id)
    SELECT gen_random_uuid(),quest_id,'TEST_QUEUED',$2,$3,$4,current_contract_hash,expires_at,$5
    FROM quests WHERE quest_id=$1`,
  [run.quest_id, run.engine_version, run.executor_version, run.contract_version, run.trace_id]);
}

async function pauseQuestForTestFailure(pool, run, error, context) {
  const globalFailure = !error.accountSpecific && !error.fatalAuth
    && ['TEST_CONTRACT_UNSUPPORTED', 'TEST_MUTATION_NOT_VERIFIED', 'TEST_COMPLETION_NOT_VERIFIED'].includes(error.code);
  if (!globalFailure) return;
  await withTransaction({ pool, isolation: 'SERIALIZABLE' }, async (client) => {
    assertTransition(SALE_TRANSITIONS, 'OPEN', 'PAUSED');
    const quest = (await client.query(`UPDATE quests SET sale_state='PAUSED',
      sale_version=sale_version+1,updated_at=clock_timestamp()
      WHERE quest_id=$1 AND sale_state='OPEN' RETURNING *`, [run.quest_id])).rows[0];
    if (!quest) return;
    await recordTransition(client, { aggregateType: 'QUEST_SALE', aggregateId: run.quest_id,
      fromState: 'OPEN', toState: 'PAUSED', stateVersion: quest.sale_version,
      reasonCode: error.code, context });
  });
}

export async function handleTestFailure(pool, run, monitor, error, context) {
  let failedRun;
  if (run.batch_id) {
    failedRun = await withTransaction({ pool, isolation: 'SERIALIZABLE' }, async (client) => {
      const failed = await finishFailedTestRun(client, run, error, context);
      // A Monitor that is no longer usable must transition before batch
      // selection. Otherwise the batch can queue a successor for the same
      // token and strand that successor after it is quarantined/cooling down.
      await updateMonitorForFailure(client, monitor, error, context);
      const quest = (await client.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE', [failed.quest_id])).rows[0];
      if (quest) await advanceMonitorTestBatch(client, { run: failed, quest, error, context });
      return failed;
    });
  } else {
    failedRun = await withTransaction({ pool, isolation: 'READ COMMITTED' },
      (client) => finishFailedTestRun(client, run, error, context));
  }
  if (!failedRun.batch_id) await updateMonitorForFailure(pool, monitor, error, context);
  if (failedRun.batch_id) return;
  await queueAlternativeMonitorTest(pool, run, monitor, error);
  await pauseQuestForTestFailure(pool, run, error, context);
}

export async function testQuest({ env, pool, signal, holder, runnerConcurrency = env.RUNNER_CONCURRENCY }) {
  const acquired = await acquireTestRun({ holder, pool });
  if (!acquired) return false;
  const { run, monitor } = acquired;
  const context = testContext(run, holder, env);
  const heartbeat = startTestHeartbeat(run, pool, signal);
  try {
    await executeTestQuest({ pool, run, monitor, env, runnerConcurrency, testSignal: heartbeat.testSignal, context });
  } catch (error) {
    if (error.code === 'FENCING_LOST') throw error;
    await handleTestFailure(pool, run, monitor, error, context);
  } finally {
    await heartbeat.stop();
  }
  return true;
}
