import { v7 as uuidv7 } from 'uuid';
import { enqueueProjection } from '../outbox/service.js';
import { recordTransition } from '../shared/transition.js';

const ACTIVE_BATCH_STATES = new Set(['QUEUED', 'RUNNING']);

export async function questDeadlinePassed(client, quest) {
  if (!quest?.expires_at) return false;
  return (await client.query('SELECT $1::timestamptz<=clock_timestamp() AS expired',
    [quest.expires_at])).rows[0]?.expired === true;
}

async function closeExpiredBatch(client, batch, context) {
  if (!batch || !ACTIVE_BATCH_STATES.has(batch.state)) return batch ?? null;
  const failed = (await client.query(`UPDATE quest_test_batches SET state='FAILED',
    state_version=state_version+1,latest_error=$2,completed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=$1 AND state=$3 AND state_version=$4 RETURNING *`, [
    batch.id,
    { code: 'TEST_QUEST_EXPIRED', message: 'Quest หมดอายุแล้ว จึงยกเลิก Monitor test โดยไม่สลับ Token ต่อ' },
    batch.state,
    batch.state_version,
  ])).rows[0] ?? batch;
  if (failed.state !== batch.state) await recordTransition(client, {
    aggregateType: 'QUEST_TEST_BATCH', aggregateId: failed.id, fromState: batch.state,
    toState: 'FAILED', stateVersion: failed.state_version,
    reasonCode: 'TEST_QUEST_EXPIRED', context,
  });
  return failed;
}

export async function hasCurrentTestPass(client, quest) {
  if (quest.public_test_gate_override
    && quest.public_test_gate_override_contract_hash === quest.current_contract_hash) return true;
  const result = await client.query(`SELECT 1 FROM quest_test_runs
    WHERE quest_id=$1 AND state='TEST_PASSED' AND engine_version=$2
      AND executor_version=$3 AND contract_version=$4 AND contract_hash=$5 LIMIT 1`, [
    quest.quest_id, quest.engine_version, quest.executor_version, quest.contract_version,
    quest.current_contract_hash,
  ]);
  return result.rowCount > 0;
}

async function activeTestMonitorIds(client) {
  const result = await client.query(`SELECT id FROM monitor_accounts
    WHERE state='ACTIVE' AND 'TEST'=ANY(capabilities)
    ORDER BY priority DESC,last_used_at NULLS FIRST,id`);
  return result.rows.map((row) => row.id);
}

async function queueAttempt(client, batch, quest, monitorId, attempt, context) {
  return (await client.query(`INSERT INTO quest_test_runs(
      id,quest_id,batch_id,target_monitor_id,state,engine_version,executor_version,
      contract_version,contract_hash,attempt_in_monitor,deadline_at,trace_id
    ) VALUES($1,$2,$3,$4,'TEST_QUEUED',$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [
    uuidv7(), quest.quest_id, batch.id, monitorId, quest.engine_version,
    quest.executor_version, quest.contract_version, quest.current_contract_hash, attempt,
    quest.expires_at, context.traceId,
  ])).rows[0];
}

async function activeMonitorAt(client, monitorOrder, startIndex) {
  if (!monitorOrder.length) return null;
  const result = await client.query(`SELECT id FROM monitor_accounts
    WHERE id=ANY($1::uuid[]) AND state='ACTIVE' AND 'TEST'=ANY(capabilities)`, [monitorOrder]);
  const active = new Set(result.rows.map((row) => row.id));
  for (let index = startIndex; index < monitorOrder.length; index += 1) {
    if (active.has(monitorOrder[index])) return { id: monitorOrder[index], index };
  }
  return null;
}

async function enqueueFailureAlert(client, batch, quest, error, context) {
  const existing = (await client.query(`SELECT * FROM quest_test_failure_alerts
    WHERE quest_id=$1 AND state IN ('OPEN','RETRYING') FOR UPDATE`, [quest.quest_id])).rows[0];
  const errorPayload = { code: error?.code ?? error?.name ?? 'TEST_MONITORS_EXHAUSTED',
    message: String(error?.message ?? 'Monitor ทุกบัญชีทดสอบ Quest ไม่ผ่าน').slice(0, 1000) };
  const alert = existing
    ? (await client.query(`UPDATE quest_test_failure_alerts SET batch_id=$2,state='OPEN',
        state_version=state_version+1,last_error=$3,trace_id=$4,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *`, [existing.id, batch.id, errorPayload, context.traceId])).rows[0]
    : (await client.query(`INSERT INTO quest_test_failure_alerts(
        id,quest_id,batch_id,state,last_error,trace_id
      ) VALUES($1,$2,$3,'OPEN',$4,$5) RETURNING *`, [
      uuidv7(), quest.quest_id, batch.id, errorPayload, context.traceId,
    ])).rows[0];
  if (!batch.customer_discovery_case_id) await enqueueProjection(client, {
    projectionType: 'QUEST_TEST_FAILURE', aggregateType: 'QUEST_TEST_ALERT', aggregateId: alert.id,
    aggregateVersion: alert.state_version, surfaceKey: 'LOG_QUEST_OPERATIONS', context,
  });
  if (batch.customer_discovery_case_id) {
    const beforeCase = (await client.query(`SELECT verification_state FROM customer_quest_discovery_cases
      WHERE id=$1 FOR UPDATE`, [batch.customer_discovery_case_id])).rows[0];
    const updatedCase = (await client.query(`UPDATE customer_quest_discovery_cases SET verification_state='TEST_FAILED',
      state_version=state_version+1,current_test_batch_id=$2,last_result=$3,trace_id=$4,updated_at=clock_timestamp()
      WHERE id=$1 RETURNING *`, [batch.customer_discovery_case_id, batch.id, {
      code: errorPayload.code, message: errorPayload.message,
    }, context.traceId])).rows[0];
    if (updatedCase) {
      await recordTransition(client, { aggregateType: 'CUSTOMER_QUEST_DISCOVERY_CASE', aggregateId: updatedCase.id,
        fromState: beforeCase?.verification_state ?? null, toState: 'TEST_FAILED', stateVersion: updatedCase.state_version,
        reasonCode: errorPayload.code, context });
      await enqueueProjection(client, { projectionType: 'CUSTOMER_QUEST_DISCOVERY_CASE',
        aggregateType: 'CUSTOMER_QUEST_DISCOVERY_CASE', aggregateId: updatedCase.id,
        aggregateVersion: updatedCase.state_version, surfaceKey: 'LOG_QUEST_OPERATIONS', context });
    }
  }
  return alert;
}

async function failBatch(client, batch, quest, error, context) {
  const failed = (await client.query(`UPDATE quest_test_batches SET state='FAILED',
    state_version=state_version+1,latest_error=$2,completed_at=clock_timestamp(),
    updated_at=clock_timestamp() WHERE id=$1 AND state IN ('QUEUED','RUNNING') RETURNING *`, [
    batch.id, { code: error?.code ?? error?.name ?? 'TEST_MONITORS_EXHAUSTED',
      message: String(error?.message ?? 'Monitor ทุกบัญชีทดสอบ Quest ไม่ผ่าน').slice(0, 1000) },
  ])).rows[0] ?? batch;
  if (failed.state !== batch.state) await recordTransition(client, {
    aggregateType: 'QUEST_TEST_BATCH', aggregateId: failed.id, fromState: batch.state,
    toState: 'FAILED', stateVersion: failed.state_version,
    reasonCode: error?.code ?? error?.name ?? 'TEST_MONITORS_EXHAUSTED', context,
  });
  const alert = await enqueueFailureAlert(client, failed, quest, error, context);
  return { batch: failed, alert, queued: null };
}

export async function createMonitorTestBatch(client, {
  quest, context, requestedBy = 'SYSTEM', force = false, monitorIds = null, customerDiscoveryCaseId = null,
}) {
  if (await questDeadlinePassed(client, quest)) {
    return { batch: null, queued: null, reused: false, skipped: 'QUEST_EXPIRED' };
  }
  // Customer discovery owns its Test batch.  Reusing a generic or completed
  // batch would either test accounts that did not see the Quest or leave the
  // Case stuck waiting for a terminal batch to transition again.
  const existing = customerDiscoveryCaseId
    ? (await client.query(`SELECT * FROM quest_test_batches
      WHERE quest_id=$1 AND contract_hash IS NOT DISTINCT FROM $2
        AND customer_discovery_case_id=$3 AND state IN ('QUEUED','RUNNING')
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [quest.quest_id, quest.current_contract_hash,
      customerDiscoveryCaseId])).rows[0]
    : (await client.query(`SELECT * FROM quest_test_batches
      WHERE quest_id=$1 AND contract_hash IS NOT DISTINCT FROM $2
        AND customer_discovery_case_id IS NULL
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [quest.quest_id, quest.current_contract_hash])).rows[0];
  if (existing && (ACTIVE_BATCH_STATES.has(existing.state) || !force)) {
    return { batch: existing, queued: null, reused: true };
  }
  const availableMonitors = await activeTestMonitorIds(client);
  const monitorOrder = monitorIds == null
    ? availableMonitors
    : monitorIds.filter((id) => availableMonitors.includes(id));
  const batch = (await client.query(`INSERT INTO quest_test_batches(
        id,quest_id,state,monitor_order,contract_hash,trace_id,requested_by,customer_discovery_case_id
  ) VALUES($1,$2,'QUEUED',$3,$4,$5,$6,$7) RETURNING *`, [
    uuidv7(), quest.quest_id, monitorOrder, quest.current_contract_hash, context.traceId, requestedBy, customerDiscoveryCaseId,
  ])).rows[0];
  const target = await activeMonitorAt(client, monitorOrder, 0);
  if (!target) return failBatch(client, batch, quest,
    { code: 'TEST_MONITOR_UNAVAILABLE', message: 'ไม่มี Monitor Token ที่ใช้ทดสอบได้' }, context);
  const queued = await queueAttempt(client, batch, quest, target.id, 1, context);
  const running = (await client.query(`UPDATE quest_test_batches SET state='RUNNING',
    current_monitor_index=$2,state_version=state_version+1,updated_at=clock_timestamp()
    WHERE id=$1 AND state='QUEUED' RETURNING *`, [batch.id, target.index])).rows[0];
  await recordTransition(client, { aggregateType: 'QUEST_TEST_BATCH', aggregateId: running.id,
    fromState: 'QUEUED', toState: 'RUNNING', stateVersion: running.state_version,
    reasonCode: 'MONITOR_TEST_BATCH_STARTED', context });
  return { batch: running, queued, reused: false };
}

export async function advanceMonitorTestBatch(client, { run, quest, error, context }) {
  if (!run.batch_id) return null;
  const batch = (await client.query('SELECT * FROM quest_test_batches WHERE id=$1 FOR UPDATE', [run.batch_id])).rows[0];
  if (!batch || !ACTIVE_BATCH_STATES.has(batch.state)) return null;
  if (await questDeadlinePassed(client, quest)) {
    const expired = await closeExpiredBatch(client, batch, context);
    return { batch: expired, queued: null, alert: null, expired: true };
  }
  const monitorOrder = batch.monitor_order ?? [];
  const currentIndex = Math.max(0, monitorOrder.indexOf(run.target_monitor_id ?? run.monitor_id));
  // A Quest disappearing, or being completed, is specific to this Monitor.
  // Do not spend retry attempts on the same account and do not call it a
  // contract failure; continue with the next account that saw the Quest.
  const accountSpecific = Boolean(error?.accountSpecific)
    || ['TEST_QUEST_MISSING', 'MONITOR_QUEST_ALREADY_COMPLETED'].includes(error?.code);
  const sameMonitor = !accountSpecific
    && Number(run.attempt_in_monitor ?? 1) < Number(batch.max_attempts_per_monitor);
  const target = sameMonitor
    ? await activeMonitorAt(client, monitorOrder, currentIndex)
    : await activeMonitorAt(client, monitorOrder, currentIndex + 1);
  if (!target) return failBatch(client, batch, quest, error, context);
  const attempt = target.index === currentIndex ? Number(run.attempt_in_monitor ?? 1) + 1 : 1;
  const queued = await queueAttempt(client, batch, quest, target.id, attempt, context);
  const updated = (await client.query(`UPDATE quest_test_batches SET state='RUNNING',
    current_monitor_index=$2,state_version=state_version+1,latest_error=$3,
    updated_at=clock_timestamp() WHERE id=$1 AND state_version=$4 RETURNING *`, [
    batch.id, target.index, { code: error?.code ?? error?.name ?? 'TEST_FAILED' }, batch.state_version,
  ])).rows[0];
  return { batch: updated, queued, alert: null };
}

export async function markMonitorTestBatchPassed(client, { run, context }) {
  if (!run.batch_id) return null;
  const before = (await client.query(`SELECT * FROM quest_test_batches WHERE id=$1 FOR UPDATE`, [run.batch_id])).rows[0];
  if (!before || !ACTIVE_BATCH_STATES.has(before.state)) return null;
  const batch = (await client.query(`UPDATE quest_test_batches SET state='PASSED',
    state_version=state_version+1,completed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=$1 AND state_version=$2 RETURNING *`, [run.batch_id, before.state_version])).rows[0];
  if (!batch) return null;
  await recordTransition(client, { aggregateType: 'QUEST_TEST_BATCH', aggregateId: batch.id,
    fromState: before.state, toState: 'PASSED', stateVersion: batch.state_version,
    reasonCode: 'MONITOR_TEST_PASSED', context });
  const alerts = await client.query(`UPDATE quest_test_failure_alerts SET state='RESOLVED',
    state_version=state_version+1,updated_at=clock_timestamp()
    WHERE quest_id=$1 AND state IN ('OPEN','RETRYING') RETURNING *`, [batch.quest_id]);
  for (const alert of alerts.rows) await enqueueProjection(client, {
    projectionType: 'QUEST_TEST_FAILURE', aggregateType: 'QUEST_TEST_ALERT', aggregateId: alert.id,
    aggregateVersion: alert.state_version, surfaceKey: 'LOG_QUEST_OPERATIONS', context,
  });
  if (batch.customer_discovery_case_id) {
    const beforeCase = (await client.query(`SELECT verification_state FROM customer_quest_discovery_cases
      WHERE id=$1 FOR UPDATE`, [batch.customer_discovery_case_id])).rows[0];
    const updatedCase = (await client.query(`UPDATE customer_quest_discovery_cases SET verification_state='PASSED',
      announcement_state=CASE WHEN announcement_state='NOT_ANNOUNCED' THEN 'QUEUED' ELSE announcement_state END,
      state_version=state_version+1,current_test_batch_id=$2,last_result=last_result||$3::jsonb,
      trace_id=$4,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [batch.customer_discovery_case_id, batch.id,
    { test: 'PASSED', testedMonitorId: run.monitor_id, attempts: run.attempt_in_monitor }, context.traceId])).rows[0];
    if (updatedCase) {
      await recordTransition(client, { aggregateType: 'CUSTOMER_QUEST_DISCOVERY_CASE', aggregateId: updatedCase.id,
        fromState: beforeCase?.verification_state ?? null, toState: 'PASSED', stateVersion: updatedCase.state_version,
        reasonCode: 'MONITOR_TEST_PASSED', context });
      if (updatedCase.announcement_state === 'QUEUED') await enqueueProjection(client, {
        projectionType: 'QUEST_NEW', aggregateType: 'QUEST', aggregateId: batch.quest_id,
        aggregateVersion: updatedCase.state_version, surfaceKey: 'QUEST_NEW', context,
      });
      await enqueueProjection(client, { projectionType: 'CUSTOMER_QUEST_DISCOVERY_CASE',
        aggregateType: 'CUSTOMER_QUEST_DISCOVERY_CASE', aggregateId: updatedCase.id,
        aggregateVersion: updatedCase.state_version, surfaceKey: 'LOG_QUEST_OPERATIONS', context });
    }
  }
  return batch;
}

// A worker can finish its durable TEST_PASSED transition immediately before a
// process crash. This recovery pass closes that gap: it derives the batch
// outcome from the already-verified run and lets normal sale reconciliation
// reopen the eligible Quest afterwards.
export async function reconcilePassedMonitorTestBatches(client, context) {
  const candidates = (await client.query(`SELECT b.id AS batch_id,tr.*
    FROM quest_test_batches b JOIN LATERAL (
      SELECT * FROM quest_test_runs tr WHERE tr.batch_id=b.id AND tr.state='TEST_PASSED'
      ORDER BY tr.completed_at DESC NULLS LAST,tr.updated_at DESC LIMIT 1
    ) tr ON true
    WHERE b.state IN ('QUEUED','RUNNING')
    ORDER BY b.updated_at,b.id FOR UPDATE OF b SKIP LOCKED`)).rows;
  let reconciled = 0;
  for (const run of candidates) {
    const batch = await markMonitorTestBatchPassed(client, { run, context: { ...context, traceId: run.trace_id } });
    if (batch) reconciled += 1;
  }
  return reconciled;
}

// Versions before the failed-run transaction fix could commit TEST_FAILED and
// stop before advancing the owning batch. Reconcile only when that failed run
// is still the latest attempt, so an already queued successor is never doubled.
export async function reconcileFailedMonitorTestBatches(client, context) {
  const candidates = (await client.query(`SELECT b.id AS batch_id,tr.*
    FROM quest_test_batches b JOIN LATERAL (
      SELECT * FROM quest_test_runs tr WHERE tr.batch_id=b.id
      ORDER BY tr.created_at DESC,tr.id DESC LIMIT 1
    ) tr ON true
    WHERE b.state IN ('QUEUED','RUNNING') AND tr.state='TEST_FAILED'
    ORDER BY b.updated_at,b.id FOR UPDATE OF b SKIP LOCKED`)).rows;
  let reconciled = 0;
  for (const run of candidates) {
    const quest = (await client.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE', [run.quest_id])).rows[0];
    if (!quest) continue;
    const advanced = await advanceMonitorTestBatch(client, { run, quest,
      error: { code: run.error_class ?? 'TEST_FAILED', message: 'Recovered incomplete failed Monitor test batch' },
      context: { ...context, traceId: run.trace_id } });
    if (advanced) reconciled += 1;
  }
  return reconciled;
}

export async function retryFailedTestAlert(client, { alertId, context }) {
  const alert = (await client.query(`SELECT * FROM quest_test_failure_alerts WHERE id=$1 FOR UPDATE`, [alertId])).rows[0];
  if (alert?.state !== 'OPEN') return { alert, batch: null, idempotent: true };
  const quest = (await client.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE', [alert.quest_id])).rows[0];
  if (await questDeadlinePassed(client, quest)) {
    const resolved = (await client.query(`UPDATE quest_test_failure_alerts SET state='RESOLVED',
      state_version=state_version+1,updated_at=clock_timestamp()
      WHERE id=$1 AND state_version=$2 RETURNING *`, [alert.id, alert.state_version])).rows[0] ?? alert;
    return { alert: resolved, batch: null, queued: null, idempotent: true, expired: true };
  }
  const retrying = (await client.query(`UPDATE quest_test_failure_alerts SET state='RETRYING',
    state_version=state_version+1,trace_id=$2,updated_at=clock_timestamp()
    WHERE id=$1 AND state_version=$3 RETURNING *`, [alert.id, context.traceId, alert.state_version])).rows[0];
  const monitorOrder = await activeTestMonitorIds(client);
  const batch = (await client.query(`INSERT INTO quest_test_batches(
        id,quest_id,state,monitor_order,contract_hash,trace_id,requested_by
  ) VALUES($1,$2,'QUEUED',$3,$4,$5,$6) RETURNING *`, [
    uuidv7(), quest.quest_id, monitorOrder, quest.current_contract_hash, context.traceId, context.actorId,
  ])).rows[0];
  const target = await activeMonitorAt(client, monitorOrder, 0);
  if (!target) {
    const failed = await failBatch(client, batch, quest,
      { code: 'TEST_MONITOR_UNAVAILABLE', message: 'ไม่มี Monitor Token ที่ใช้ทดสอบได้' }, context);
    return { alert: failed.alert, batch: failed.batch, queued: null, idempotent: false };
  }
  const queued = await queueAttempt(client, batch, quest, target.id, 1, context);
  const running = (await client.query(`UPDATE quest_test_batches SET state='RUNNING',
    current_monitor_index=$2,state_version=state_version+1,updated_at=clock_timestamp()
    WHERE id=$1 RETURNING *`, [batch.id, target.index])).rows[0];
  await recordTransition(client, { aggregateType: 'QUEST_TEST_BATCH', aggregateId: running.id,
    fromState: 'QUEUED', toState: 'RUNNING', stateVersion: running.state_version,
    reasonCode: 'ADMIN_MONITOR_TEST_RETRY', context });
  const updatedAlert = (await client.query(`UPDATE quest_test_failure_alerts SET batch_id=$2,
    state='RETRYING',state_version=state_version+1,trace_id=$3,updated_at=clock_timestamp()
    WHERE id=$1 RETURNING *`, [retrying.id, running.id, context.traceId])).rows[0];
  await enqueueProjection(client, {
    projectionType: 'QUEST_TEST_FAILURE', aggregateType: 'QUEST_TEST_ALERT', aggregateId: updatedAlert.id,
    aggregateVersion: updatedAlert.state_version, surfaceKey: 'LOG_QUEST_OPERATIONS', context,
  });
  return { alert: updatedAlert, batch: running, queued, idempotent: false };
}

export async function loadTestFailureAlert(client, alertId, { messageId = null } = {}) {
  const alert = (await client.query(`SELECT a.*,p.message_id,p.surface_key FROM quest_test_failure_alerts a
    LEFT JOIN message_projections p ON p.projection_type='QUEST_TEST_FAILURE'
      AND p.aggregate_id=a.id::text AND p.surface_key='LOG_QUEST_OPERATIONS'
    WHERE a.id=$1`, [alertId])).rows[0];
  if (!alert) return null;
  if (messageId && alert.message_id !== messageId) return null;
  return alert;
}
