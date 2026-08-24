import { withTransaction } from '../../db/transaction.js';
import { QuestshopError } from '../../shared/errors.js';
import { enqueueProjection } from '../outbox/service.js';
import { resolvePrice } from '../pricing/resolver.js';
import { appendAdminAudit } from '../admin/audit.js';
import { assertTransition, recordTransition } from '../shared/transition.js';
import { evaluateExpiryAdmission } from './expiry.js';
import { SALE_TRANSITIONS } from './states.js';
import { createMonitorTestBatch } from './test-gate.js';

const PENDING = 'PENDING';
const TEST_REQUESTED = 'TEST_REQUESTED';
const PUBLISHED = 'PUBLISHED';

const CUSTOMER_DISCOVERY_TRANSITIONS = Object.freeze({
  [PENDING]: Object.freeze([TEST_REQUESTED, PUBLISHED]),
  [TEST_REQUESTED]: Object.freeze([]),
  [PUBLISHED]: Object.freeze([]),
});

function hasCoreMetadata(quest) {
  return Boolean(quest?.name && quest.task_type && Number(quest.task_target) > 0
    && quest.url && quest.starts_at && quest.expires_at && quest.executor_id
    && quest.current_contract_hash);
}

async function loadDiscoveryForUpdate(client, discoveryId) {
  const discovery = (await client.query(`SELECT * FROM customer_quest_discoveries
    WHERE id=$1 FOR UPDATE`, [discoveryId])).rows[0];
  if (!discovery) throw new QuestshopError('CUSTOMER_DISCOVERY_NOT_FOUND', 'ไม่พบรายการ Quest ที่พบจากลูกค้า');
  return discovery;
}

async function loadQuestForDecision(client, discovery) {
  const quest = (await client.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE', [discovery.quest_id])).rows[0];
  if (!quest) throw new QuestshopError('QUEST_NOT_FOUND', 'ไม่พบ Quest นี้แล้ว');
  return quest;
}

async function assertQuestCanBePublished(client, quest, runnerConcurrency) {
  const price = await resolvePrice(client, { questId: quest.quest_id, taskType: quest.task_type });
  const expiry = await evaluateExpiryAdmission(client, { quest, runnerConcurrency });
  if (quest.analysis_state !== 'SUPPORTED' || !hasCoreMetadata(quest) || !price || !expiry.eligible) {
    throw new QuestshopError('QUEST_NOT_SALE_ELIGIBLE', 'Quest ยังมีข้อมูล ราคา หรือเวลาคงเหลือไม่พอสำหรับประกาศ');
  }
  return { price, expiry };
}

async function updateDiscovery(client, discovery, nextState, context, updates = {}) {
  assertTransition(CUSTOMER_DISCOVERY_TRANSITIONS, discovery.state, nextState);
  const updated = (await client.query(`UPDATE customer_quest_discoveries SET
      state=$2,state_version=state_version+1,decision_by=$3,decision_reason=$4,
      test_batch_id=COALESCE($5,test_batch_id),decided_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=$1 AND state=$6 AND state_version=$7 RETURNING *`, [
    discovery.id, nextState, context.actorId, updates.reason ?? null, updates.testBatchId ?? null,
    discovery.state, discovery.state_version,
  ])).rows[0];
  if (!updated) throw new QuestshopError('STALE_STATE', 'รายการ Quest ถูกตัดสินใจจากหน้าต่างอื่นแล้ว');
  await recordTransition(client, {
    aggregateType: 'CUSTOMER_QUEST_DISCOVERY', aggregateId: discovery.id,
    fromState: discovery.state, toState: nextState, stateVersion: updated.state_version,
    reasonCode: updates.reasonCode, context,
  });
  return updated;
}

async function enqueueDiscoveryRefresh(client, discovery, context) {
  await enqueueProjection(client, {
    projectionType: 'CUSTOMER_QUEST_DISCOVERY', aggregateType: 'CUSTOMER_QUEST_DISCOVERY',
    aggregateId: discovery.id, aggregateVersion: discovery.state_version,
    surfaceKey: 'LOG_QUEST_OPERATIONS', context,
  });
}

export async function loadCustomerQuestDiscovery(client, discoveryId, { messageId = null } = {}) {
  const discovery = (await client.query(`SELECT d.*,p.message_id,p.surface_key
    FROM customer_quest_discoveries d
    LEFT JOIN message_projections p ON p.projection_type='CUSTOMER_QUEST_DISCOVERY'
      AND p.aggregate_id=d.id::text AND p.surface_key='LOG_QUEST_OPERATIONS'
    WHERE d.id=$1`, [discoveryId])).rows[0];
  if (!discovery || (messageId && discovery.message_id !== messageId)) return null;
  return discovery;
}

/**
 * Explicit Admin override for a Quest discovered by a customer.  This is the
 * only customer-discovery path that may bypass the Monitor test gate, and it
 * writes both a durable decision and an append-only Admin audit row.
 */
export async function publishCustomerDiscoveredQuest({ discoveryId, runnerConcurrency = 2 }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const discovery = await loadDiscoveryForUpdate(client, discoveryId);
    if (discovery.state === PUBLISHED) return { discovery, idempotent: true };
    if (discovery.state !== PENDING) {
      throw new QuestshopError('CUSTOMER_DISCOVERY_DECIDED', 'รายการนี้ถูกส่งทดสอบแล้ว ให้รอผลจาก Monitor ก่อน');
    }
    const quest = await loadQuestForDecision(client, discovery);
    await assertQuestCanBePublished(client, quest, runnerConcurrency);
    let publishedQuest = quest;
    if (quest.sale_state !== 'OPEN') {
      assertTransition(SALE_TRANSITIONS, quest.sale_state, 'OPEN');
      publishedQuest = (await client.query(`UPDATE quests SET
          public_test_gate_override=true,public_test_gate_override_by=$2,
          public_test_gate_override_at=clock_timestamp(),
          public_test_gate_override_reason=$3,
          public_test_gate_override_contract_hash=current_contract_hash,
          sale_state='OPEN',sale_version=sale_version+1,updated_at=clock_timestamp()
        WHERE quest_id=$1 AND sale_version=$4 RETURNING *`, [
        quest.quest_id, context.actorId, 'Admin approved customer-discovered Quest publication', quest.sale_version,
      ])).rows[0];
      if (!publishedQuest) throw new QuestshopError('STALE_STATE', 'Quest เปลี่ยนระหว่างการประกาศ กรุณาลองใหม่');
    }
    if (quest.sale_state !== 'OPEN') await recordTransition(client, {
      aggregateType: 'QUEST_SALE', aggregateId: quest.quest_id,
      fromState: quest.sale_state, toState: 'OPEN', stateVersion: publishedQuest.sale_version,
      reasonCode: 'ADMIN_CUSTOMER_DISCOVERY_OVERRIDE', context,
    });
    const updatedDiscovery = await updateDiscovery(client, discovery, PUBLISHED, context, {
      reason: 'ADMIN_CUSTOMER_DISCOVERY_OVERRIDE', reasonCode: 'ADMIN_CUSTOMER_DISCOVERY_OVERRIDE',
    });
    await appendAdminAudit(client, {
      action: 'CUSTOMER_DISCOVERY_FORCE_PUBLISH', targetType: 'QUEST', targetId: quest.quest_id,
      actorId: context.actorId,
      before: { saleState: quest.sale_state, discoveryState: discovery.state },
      after: { saleState: publishedQuest.sale_state, discoveryState: updatedDiscovery.state,
        publicTestGateOverride: true },
      reason: 'Admin approved public announcement from customer discovery', context,
    });
    await enqueueProjection(client, {
      projectionType: 'QUEST_NEW', aggregateType: 'QUEST', aggregateId: quest.quest_id,
      aggregateVersion: publishedQuest.sale_version, surfaceKey: 'QUEST_NEW', context,
    });
    await enqueueDiscoveryRefresh(client, updatedDiscovery, context);
    return { quest: publishedQuest, discovery: updatedDiscovery, idempotent: false };
  });
}

export async function requestCustomerDiscoveryTest({ discoveryId }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const discovery = await loadDiscoveryForUpdate(client, discoveryId);
    if (discovery.state === TEST_REQUESTED) return { discovery, batch: null, idempotent: true };
    if (discovery.state !== PENDING) {
      throw new QuestshopError('CUSTOMER_DISCOVERY_DECIDED', 'รายการนี้ถูกประกาศแล้ว');
    }
    const quest = await loadQuestForDecision(client, discovery);
    if (quest.analysis_state !== 'SUPPORTED' || !hasCoreMetadata(quest)) {
      throw new QuestshopError('QUEST_NOT_SALE_ELIGIBLE', 'Quest ยังไม่พร้อมสำหรับการทดสอบ Monitor');
    }
    const test = await createMonitorTestBatch(client, { quest, context, requestedBy: context.actorId });
    if (!test.batch) throw new QuestshopError('QUEST_EXPIRED', 'Quest หมดอายุแล้ว จึงไม่สามารถส่งทดสอบได้');
    const updatedDiscovery = await updateDiscovery(client, discovery, TEST_REQUESTED, context, {
      reason: 'ADMIN_REQUESTED_MONITOR_TEST', reasonCode: 'ADMIN_REQUESTED_MONITOR_TEST', testBatchId: test.batch.id,
    });
    await appendAdminAudit(client, {
      action: 'CUSTOMER_DISCOVERY_TEST_REQUESTED', targetType: 'QUEST', targetId: quest.quest_id,
      actorId: context.actorId,
      before: { discoveryState: discovery.state },
      after: { discoveryState: updatedDiscovery.state, testBatchId: test.batch.id },
      reason: 'Admin requested Monitor test for customer-discovered Quest', context,
    });
    await enqueueDiscoveryRefresh(client, updatedDiscovery, context);
    return { discovery: updatedDiscovery, batch: test.batch, idempotent: false };
  });
}
