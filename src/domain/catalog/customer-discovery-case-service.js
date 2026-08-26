import { v7 as uuidv7 } from 'uuid';
import { withTransaction } from '../../db/transaction.js';
import { enqueueProjection } from '../outbox/service.js';
import { QuestshopError } from '../../shared/errors.js';
import { createMonitorTestBatch } from './test-gate.js';
import { appendAdminAudit } from '../admin/audit.js';
import { recordTransition } from '../shared/transition.js';

const TERMINAL_CHECK = new Set(['VISIBLE', 'VISIBLE_COMPLETED', 'NOT_VISIBLE', 'FAILED']);

async function enqueueCase(client, row, context) {
  await enqueueProjection(client, { projectionType: 'CUSTOMER_QUEST_DISCOVERY_CASE',
    aggregateType: 'CUSTOMER_QUEST_DISCOVERY_CASE', aggregateId: row.id,
    aggregateVersion: row.state_version, surfaceKey: 'LOG_QUEST_OPERATIONS', context });
}

async function startSearch(client, caseRow, context) {
  const active = (await client.query(`SELECT id FROM customer_quest_monitor_search_batches
    WHERE case_id=$1 AND state IN ('QUEUED','RUNNING') FOR UPDATE`, [caseRow.id])).rows[0];
  if (active) return { caseRow, batchId: active.id, reused: true };
  const cycle = Number((await client.query(`SELECT COALESCE(max(cycle_number),0)+1 AS value
    FROM customer_quest_monitor_search_batches WHERE case_id=$1`, [caseRow.id])).rows[0].value);
  const batch = (await client.query(`INSERT INTO customer_quest_monitor_search_batches(
    id,case_id,cycle_number,trace_id,requested_by
  ) VALUES($1,$2,$3,$4,$5) RETURNING *`, [uuidv7(), caseRow.id, cycle, context.traceId, context.actorId ?? 'SYSTEM'])).rows[0];
  const monitors = (await client.query(`SELECT id FROM monitor_accounts
    WHERE state='ACTIVE' AND 'TEST'=ANY(capabilities) ORDER BY priority DESC,last_used_at NULLS FIRST,id`)).rows;
  if (monitors.length) {
    for (const monitor of monitors) await client.query(`INSERT INTO customer_quest_monitor_search_checks(id,batch_id,monitor_id)
      VALUES($1,$2,$3)`, [uuidv7(), batch.id, monitor.id]);
    await client.query(`UPDATE customer_quest_monitor_search_batches SET state='RUNNING',state_version=state_version+1,
      updated_at=clock_timestamp() WHERE id=$1`, [batch.id]);
    await recordTransition(client, { aggregateType: 'CUSTOMER_MONITOR_SEARCH_BATCH', aggregateId: batch.id,
      fromState: 'QUEUED', toState: 'RUNNING', stateVersion: Number(batch.state_version) + 1,
      reasonCode: 'CUSTOMER_DISCOVERY_MONITOR_SEARCH_STARTED', metadata: { monitorCount: monitors.length }, context });
  } else {
    await client.query(`UPDATE customer_quest_monitor_search_batches SET state='NO_MONITORS',state_version=state_version+1,
      completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`, [batch.id]);
    await recordTransition(client, { aggregateType: 'CUSTOMER_MONITOR_SEARCH_BATCH', aggregateId: batch.id,
      fromState: 'QUEUED', toState: 'NO_MONITORS', stateVersion: Number(batch.state_version) + 1,
      reasonCode: 'CUSTOMER_DISCOVERY_NO_TEST_MONITORS', context });
  }
  const state = monitors.length ? 'CHECK_QUEUED' : 'CHECK_INCOMPLETE';
  const updated = (await client.query(`UPDATE customer_quest_discovery_cases SET verification_state=$2,
    current_search_batch_id=$3,state_version=state_version+1,last_result=$4,trace_id=$5,updated_at=clock_timestamp()
    WHERE id=$1 RETURNING *`, [caseRow.id, state, batch.id,
    monitors.length ? { checked: 0, total: monitors.length } : { code: 'TEST_MONITOR_UNAVAILABLE' }, context.traceId])).rows[0];
  if (caseRow.verification_state !== updated.verification_state) await recordTransition(client, {
    aggregateType: 'CUSTOMER_QUEST_DISCOVERY_CASE', aggregateId: updated.id,
    fromState: caseRow.verification_state, toState: updated.verification_state,
    stateVersion: updated.state_version, reasonCode: monitors.length
      ? 'CUSTOMER_DISCOVERY_MONITOR_SEARCH_QUEUED' : 'CUSTOMER_DISCOVERY_NO_TEST_MONITORS', context,
  });
  await enqueueCase(client, updated, context);
  return { caseRow: updated, batchId: batch.id, reused: false };
}

export async function recordCustomerDiscoveryCase(client, discovery, context) {
  const row = (await client.query(`INSERT INTO customer_quest_discovery_cases(
      id,quest_id,first_discovery_id,latest_discovery_id,first_discord_user_id,latest_discord_user_id,
      first_account_id,latest_account_id,first_account_username,latest_account_username,latest_account_avatar_url,trace_id
    ) VALUES($1,$2,$3,$3,$4,$4,$5,$5,$6,$6,$7,$8)
    ON CONFLICT(quest_id) DO UPDATE SET latest_discovery_id=EXCLUDED.latest_discovery_id,
      latest_discord_user_id=EXCLUDED.latest_discord_user_id,latest_account_id=EXCLUDED.latest_account_id,
      latest_account_username=EXCLUDED.latest_account_username,latest_account_avatar_url=EXCLUDED.latest_account_avatar_url,
      sighting_count=customer_quest_discovery_cases.sighting_count+1,trace_id=EXCLUDED.trace_id,
      updated_at=clock_timestamp()
    RETURNING *`, [uuidv7(), discovery.quest_id, discovery.id, discovery.discord_user_id, discovery.account_id,
    discovery.account_username ?? null, discovery.account_avatar_url ?? null, context.traceId])).rows[0];
  return startSearch(client, row, context);
}

export async function retryCustomerDiscoveryCase({ caseId }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const row = (await client.query('SELECT * FROM customer_quest_discovery_cases WHERE id=$1 FOR UPDATE', [caseId])).rows[0];
    if (!row) throw new QuestshopError('CUSTOMER_DISCOVERY_CASE_NOT_FOUND', 'ไม่พบรายการ Quest ที่พบจากลูกค้า');
    return startSearch(client, row, context);
  });
}

export async function loadCustomerDiscoveryCase(client, caseId, { messageId = null } = {}) {
  const row = (await client.query(`SELECT c.*,p.message_id,p.surface_key FROM customer_quest_discovery_cases c
    LEFT JOIN message_projections p ON p.projection_type='CUSTOMER_QUEST_DISCOVERY_CASE'
      AND p.aggregate_id=c.id::text AND p.surface_key='LOG_QUEST_OPERATIONS' WHERE c.id=$1`, [caseId])).rows[0];
  if (!row || (messageId && row.message_id !== messageId)) return null;
  return row;
}

export async function acquireCustomerMonitorSearchCheck({ holder, ttlSeconds = 120 }, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const candidate = (await client.query(`SELECT ch.*,b.case_id,b.state AS batch_state,b.trace_id AS batch_trace_id,
      c.quest_id,c.verification_state,m.account_id,m.state AS monitor_state,
      cr.key_version,cr.nonce,cr.ciphertext,cr.auth_tag
      FROM customer_quest_monitor_search_checks ch
      JOIN customer_quest_monitor_search_batches b ON b.id=ch.batch_id
      JOIN customer_quest_discovery_cases c ON c.id=b.case_id
      JOIN monitor_accounts m ON m.id=ch.monitor_id JOIN monitor_credentials cr ON cr.monitor_id=m.id
      WHERE b.state='RUNNING' AND (ch.state='PENDING' OR (ch.state='LEASED' AND ch.lease_expires_at<=clock_timestamp()))
      ORDER BY ch.created_at FOR UPDATE OF ch SKIP LOCKED LIMIT 1`)).rows[0];
    if (!candidate) return null;
    const check = (await client.query(`UPDATE customer_quest_monitor_search_checks SET state='LEASED',
      state_version=state_version+1,attempt_count=attempt_count+1,lease_owner=$2,
      lease_expires_at=clock_timestamp()+make_interval(secs=>$3),fencing_token=fencing_token+1,updated_at=clock_timestamp()
      WHERE id=$1 RETURNING *`, [candidate.id, holder, ttlSeconds])).rows[0];
    const context = { traceId: candidate.batch_trace_id, causationId: null, actorType: 'SYSTEM', actorId: holder };
    if (candidate.state !== 'LEASED') await recordTransition(client, {
      aggregateType: 'CUSTOMER_MONITOR_SEARCH_CHECK', aggregateId: check.id,
      fromState: candidate.state, toState: 'LEASED', stateVersion: check.state_version,
      reasonCode: 'CUSTOMER_DISCOVERY_MONITOR_CHECK_LEASED', context,
    });
    if (candidate.verification_state === 'CHECK_QUEUED') {
      const checking = (await client.query(`UPDATE customer_quest_discovery_cases SET verification_state='CHECKING',
        state_version=state_version+1,updated_at=clock_timestamp()
        WHERE id=$1 AND verification_state='CHECK_QUEUED' RETURNING *`, [candidate.case_id])).rows[0];
      if (checking) {
        await recordTransition(client, { aggregateType: 'CUSTOMER_QUEST_DISCOVERY_CASE', aggregateId: checking.id,
          fromState: 'CHECK_QUEUED', toState: 'CHECKING', stateVersion: checking.state_version,
          reasonCode: 'CUSTOMER_DISCOVERY_MONITOR_SEARCH_RUNNING', context });
        await enqueueCase(client, checking, context);
      }
    }
    return { ...candidate, ...check };
  });
}

export async function completeCustomerMonitorSearchCheck({ check, state, evidence = {}, errorClass = null }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const updated = (await client.query(`UPDATE customer_quest_monitor_search_checks SET state=$4,state_version=state_version+1,
      evidence=$5,error_class=$6,checked_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND state='LEASED' AND lease_owner=$2 AND fencing_token=$3 RETURNING *`,
    [check.id, check.lease_owner, check.fencing_token, state, evidence, errorClass])).rows[0];
    if (!updated) return null;
    await recordTransition(client, { aggregateType: 'CUSTOMER_MONITOR_SEARCH_CHECK', aggregateId: updated.id,
      fromState: 'LEASED', toState: state, stateVersion: updated.state_version,
      reasonCode: state === 'NOT_VISIBLE' ? 'CUSTOMER_DISCOVERY_QUEST_NOT_VISIBLE'
        : state === 'VISIBLE' ? 'CUSTOMER_DISCOVERY_QUEST_VISIBLE'
          : state === 'VISIBLE_COMPLETED' ? 'CUSTOMER_DISCOVERY_QUEST_ALREADY_COMPLETED'
            : state === 'PENDING' ? 'CUSTOMER_DISCOVERY_MONITOR_CHECK_RETRY'
            : 'CUSTOMER_DISCOVERY_MONITOR_CHECK_FAILED', metadata: { errorClass }, context });
    const batch = (await client.query('SELECT * FROM customer_quest_monitor_search_batches WHERE id=$1 FOR UPDATE', [check.batch_id])).rows[0];
    const checks = (await client.query(`SELECT state,monitor_id,evidence FROM customer_quest_monitor_search_checks WHERE batch_id=$1 FOR UPDATE`, [check.batch_id])).rows;
    if (!checks.every((item) => TERMINAL_CHECK.has(item.state))) return updated;
    const visible = checks.filter((item) => item.state === 'VISIBLE');
    const visibleCompleted = checks.filter((item) => item.state === 'VISIBLE_COMPLETED');
    const failed = checks.filter((item) => item.state === 'FAILED');
    let next = visible.length ? 'FOUND' : failed.length ? 'INCOMPLETE' : 'NOT_FOUND';
    if (!visible.length && visibleCompleted.length && !failed.length) next = 'FOUND';
    await client.query(`UPDATE customer_quest_monitor_search_batches SET state=$2,state_version=state_version+1,
      completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`, [batch.id, next]);
    await recordTransition(client, { aggregateType: 'CUSTOMER_MONITOR_SEARCH_BATCH', aggregateId: batch.id,
      fromState: batch.state, toState: next, stateVersion: Number(batch.state_version) + 1,
      reasonCode: `CUSTOMER_DISCOVERY_MONITOR_SEARCH_${next}`, context });
    const caseRow = (await client.query('SELECT * FROM customer_quest_discovery_cases WHERE id=$1 FOR UPDATE', [batch.case_id])).rows[0];
    let verificationState = next === 'NOT_FOUND' ? 'NOT_FOUND' : next === 'INCOMPLETE' ? 'CHECK_INCOMPLETE'
      : visible.length ? 'TESTING' : 'FOUND_NOT_TESTABLE';
    let testBatchId = null;
    if (visible.length) {
      const quest = (await client.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE', [caseRow.quest_id])).rows[0];
      const test = await createMonitorTestBatch(client, { quest, context, monitorIds: visible.map((item) => item.monitor_id),
        requestedBy: 'CUSTOMER_DISCOVERY', customerDiscoveryCaseId: caseRow.id });
      testBatchId = test.batch?.id ?? null;
      if (!testBatchId) verificationState = 'FOUND_NOT_TESTABLE';
      else if (test.batch.state === 'FAILED') verificationState = 'TEST_FAILED';
    }
    const result = { total: checks.length, found: visible.length + visibleCompleted.length, testable: visible.length,
      notFound: checks.filter((item) => item.state === 'NOT_VISIBLE').length, failed: failed.length };
    const updatedCase = (await client.query(`UPDATE customer_quest_discovery_cases SET verification_state=$2,
      current_test_batch_id=$3,state_version=state_version+1,last_result=$4,trace_id=$5,updated_at=clock_timestamp()
      WHERE id=$1 RETURNING *`, [caseRow.id, verificationState, testBatchId, result, context.traceId])).rows[0];
    if (caseRow.verification_state !== updatedCase.verification_state) await recordTransition(client, {
      aggregateType: 'CUSTOMER_QUEST_DISCOVERY_CASE', aggregateId: updatedCase.id,
      fromState: caseRow.verification_state, toState: updatedCase.verification_state,
      stateVersion: updatedCase.state_version, reasonCode: `CUSTOMER_DISCOVERY_MONITOR_SEARCH_${next}`, context,
    });
    await enqueueCase(client, updatedCase, context);
    return updated;
  });
}

export async function queueCustomerDiscoveryAnnouncement({ caseId }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const row = (await client.query('SELECT * FROM customer_quest_discovery_cases WHERE id=$1 FOR UPDATE', [caseId])).rows[0];
    if (!row) throw new QuestshopError('CUSTOMER_DISCOVERY_CASE_NOT_FOUND', 'ไม่พบรายการ Quest ที่พบจากลูกค้า');
    if (row.announcement_state === 'ANNOUNCED' || row.announcement_state === 'QUEUED') return { caseRow: row, idempotent: true };
    const updated = (await client.query(`UPDATE customer_quest_discovery_cases SET announcement_state='QUEUED',
      state_version=state_version+1,trace_id=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [row.id, context.traceId])).rows[0];
    await recordTransition(client, { aggregateType: 'CUSTOMER_QUEST_DISCOVERY_CASE', aggregateId: updated.id,
      fromState: row.announcement_state, toState: updated.announcement_state, stateVersion: updated.state_version,
      reasonCode: 'CUSTOMER_DISCOVERY_ANNOUNCEMENT_QUEUED', context });
    await enqueueProjection(client, { projectionType: 'QUEST_NEW', aggregateType: 'QUEST', aggregateId: updated.quest_id,
      aggregateVersion: updated.state_version, surfaceKey: 'QUEST_NEW', context });
    if (context.actorType === 'ADMIN' || context.actorType === 'OWNER') await appendAdminAudit(client, {
      action: 'CUSTOMER_DISCOVERY_FORCE_PUBLISH', targetType: 'QUEST', targetId: updated.quest_id,
      actorId: context.actorId, before: { announcementState: row.announcement_state },
      after: { announcementState: updated.announcement_state, monitorVerified: row.verification_state === 'PASSED' },
      reason: row.verification_state === 'PASSED' ? 'Published after Monitor verification' : 'Published from customer-discovered Quest without Monitor verification', context,
    });
    await enqueueCase(client, updated, context);
    return { caseRow: updated, idempotent: false };
  });
}

export async function markCustomerDiscoveryAnnouncementDelivered(client, questId, context) {
  const row = (await client.query(`UPDATE customer_quest_discovery_cases SET announcement_state='ANNOUNCED',
    state_version=state_version+1,updated_at=clock_timestamp() WHERE quest_id=$1 AND announcement_state='QUEUED'
    RETURNING *`, [questId])).rows[0];
  if (row) {
    await recordTransition(client, { aggregateType: 'CUSTOMER_QUEST_DISCOVERY_CASE', aggregateId: row.id,
      fromState: 'QUEUED', toState: 'ANNOUNCED', stateVersion: row.state_version,
      reasonCode: 'CUSTOMER_DISCOVERY_ANNOUNCEMENT_DELIVERED', context });
    await enqueueCase(client, row, context);
  }
  return row;
}
