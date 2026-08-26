import { withTransaction } from '../../db/transaction.js';
import { QuestshopError } from '../../shared/errors.js';
import { evaluateExpiryAdmission } from '../catalog/expiry.js';
import { SALE_TRANSITIONS } from '../catalog/states.js';
import { resolvePrice } from '../pricing/resolver.js';
import { enqueueProjection } from '../outbox/service.js';
import { openReview } from '../reviews/service.js';
import { assertTransition, recordTransition } from '../shared/transition.js';
import { ORDER_ITEM_TRANSITIONS } from '../orders/states.js';
import { RUNNER_JOB_TRANSITIONS } from '../runner/states.js';
import { appendAdminAudit } from './audit.js';

// The only approved public-sale bypass for the Monitor gate is the auditable
// button on that Quest's failed-test alert; it never changes a failed run into
// TEST_PASSED and there is no generic manual catalog-sale control.
export async function forcePublishFailedMonitorTest({ alertId, reason }, context, options = {}) {
  if (!reason?.trim()) throw new TypeError('force publish reason is required');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const alert = (await client.query(`SELECT * FROM quest_test_failure_alerts
      WHERE id=$1 FOR UPDATE`, [alertId])).rows[0];
    if (!alert) throw new QuestshopError('QUEST_TEST_ALERT_NOT_FOUND', 'ไม่พบรายการทดสอบ Quest');
    if (alert.state === 'OVERRIDDEN') return { alert, idempotent: true };
    if (alert.state !== 'OPEN') throw new QuestshopError('QUEST_TEST_ALERT_NOT_OPEN', 'รายการนี้ไม่ได้รอการตัดสินใจ');
    const quest = (await client.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE', [alert.quest_id])).rows[0];
    if (!quest) throw new QuestshopError('QUEST_NOT_FOUND', 'ไม่พบ Quest');
    const batch = (await client.query('SELECT contract_hash FROM quest_test_batches WHERE id=$1 FOR SHARE',
      [alert.batch_id])).rows[0];
    if (!batch || batch.contract_hash !== quest.current_contract_hash) {
      throw new QuestshopError('QUEST_TEST_ALERT_STALE_CONTRACT',
        'ผลทดสอบนี้เป็นของรูปแบบ Quest เก่า จึงใช้เปิดขายรูปแบบปัจจุบันไม่ได้');
    }
    const price = await resolvePrice(client, { questId: quest.quest_id, taskType: quest.task_type });
    const expiry = await evaluateExpiryAdmission(client, { quest, runnerConcurrency: 2 });
    if (quest.analysis_state !== 'SUPPORTED' || !quest.executor_id || !price || !expiry.eligible) {
      throw new QuestshopError('QUEST_NOT_SALE_ELIGIBLE', 'Quest ยังมีข้อมูล ราคา หรือเวลาคงเหลือไม่พอสำหรับเปิดขาย');
    }
    if (quest.sale_state !== 'OPEN') assertTransition(SALE_TRANSITIONS, quest.sale_state, 'OPEN');
    const updatedQuest = (await client.query(`UPDATE quests SET public_test_gate_override=true,
      public_test_gate_override_by=$2,public_test_gate_override_at=clock_timestamp(),
      public_test_gate_override_reason=$3,
      public_test_gate_override_contract_hash=current_contract_hash,
      sale_state='OPEN',sale_version=sale_version+1,
      updated_at=clock_timestamp() WHERE quest_id=$1 AND sale_version=$4 RETURNING *`, [
      quest.quest_id, context.actorId, reason.trim(), quest.sale_version,
    ])).rows[0];
    if (!updatedQuest) throw new QuestshopError('STALE_STATE', 'Quest เปลี่ยนพร้อมกัน กรุณาลองใหม่');
    if (quest.sale_state !== 'OPEN') await recordTransition(client, {
      aggregateType: 'QUEST_SALE', aggregateId: quest.quest_id, fromState: quest.sale_state,
      toState: 'OPEN', stateVersion: updatedQuest.sale_version, reasonCode: 'ADMIN_TEST_GATE_OVERRIDE', context,
    });
    const overriddenBatch = (await client.query(`UPDATE quest_test_batches SET state='OVERRIDDEN',
      state_version=state_version+1,completed_at=COALESCE(completed_at,clock_timestamp()),updated_at=clock_timestamp()
      WHERE id=$1 AND state='FAILED' RETURNING *`, [alert.batch_id])).rows[0];
    if (overriddenBatch) await recordTransition(client, { aggregateType: 'QUEST_TEST_BATCH',
      aggregateId: overriddenBatch.id, fromState: 'FAILED', toState: 'OVERRIDDEN',
      stateVersion: overriddenBatch.state_version, reasonCode: 'ADMIN_TEST_GATE_OVERRIDE', context });
    const updatedAlert = (await client.query(`UPDATE quest_test_failure_alerts SET state='OVERRIDDEN',
      state_version=state_version+1,updated_at=clock_timestamp() WHERE id=$1 AND state_version=$2 RETURNING *`,
    [alert.id, alert.state_version])).rows[0];
    await appendAdminAudit(client, { action: 'QUEST_TEST_FORCE_PUBLISH', targetType: 'QUEST',
      targetId: quest.quest_id, actorId: context.actorId,
      before: { saleState: quest.sale_state, testAlert: alert.id },
      after: { saleState: 'OPEN', testGateOverride: true, alertState: updatedAlert.state }, reason: reason.trim(), context });
    await enqueueProjection(client, { projectionType: 'QUEST_NEW', aggregateType: 'QUEST',
      aggregateId: quest.quest_id, aggregateVersion: updatedQuest.sale_version, surfaceKey: 'QUEST_NEW', context });
    await enqueueProjection(client, { projectionType: 'QUEST_TEST_FAILURE', aggregateType: 'QUEST_TEST_ALERT',
      aggregateId: updatedAlert.id, aggregateVersion: updatedAlert.state_version,
      surfaceKey: 'LOG_QUEST_OPERATIONS', context });
    return { quest: updatedQuest, alert: updatedAlert, idempotent: false };
  });
}

export async function openOrderItemReview({ orderItemId, reason, ownerOnly = false }, context, options = {}) {
  if (!reason?.trim()) throw new TypeError('review reason is required');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const item = (await client.query('SELECT * FROM order_items WHERE id=$1 FOR UPDATE', [orderItemId])).rows[0];
    if (!item) throw new QuestshopError('ORDER_ITEM_NOT_FOUND', 'ไม่พบ Order item');
    if (item.state !== 'MANUAL_REVIEW') {
      assertTransition(ORDER_ITEM_TRANSITIONS, item.state, 'MANUAL_REVIEW');
      const updated = (await client.query(`UPDATE order_items SET state='MANUAL_REVIEW',
        state_version=state_version+1,updated_at=transaction_timestamp()
        WHERE id=$1 AND state_version=$2 RETURNING *`, [orderItemId, item.state_version])).rows[0];
      if (!updated) throw new QuestshopError('STALE_STATE', `Order item ${orderItemId} changed during review`);
      const jobs = (await client.query('SELECT * FROM runner_jobs WHERE order_item_id=$1 FOR UPDATE', [orderItemId])).rows;
      for (const job of jobs) {
        if (['COMPLETED', 'FAILED', 'MANUAL_REVIEW'].includes(job.state)) continue;
        assertTransition(RUNNER_JOB_TRANSITIONS, job.state, 'MANUAL_REVIEW');
        const updatedJob = (await client.query(`UPDATE runner_jobs SET state='MANUAL_REVIEW',
          state_version=state_version+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE id=$1 AND state=$2 AND state_version=$3 RETURNING *`,
        [job.id, job.state, job.state_version])).rows[0];
        if (!updatedJob) throw new QuestshopError('STALE_STATE', `Runner job ${job.id} changed during review`);
        await recordTransition(client, { aggregateType: 'RUNNER_JOB', aggregateId: job.id,
          fromState: job.state, toState: 'MANUAL_REVIEW', stateVersion: updatedJob.state_version,
          reasonCode: 'ADMIN_REVIEW', context });
      }
      await recordTransition(client, { aggregateType: 'ORDER_ITEM', aggregateId: orderItemId,
        fromState: item.state, toState: 'MANUAL_REVIEW', stateVersion: updated.state_version,
        reasonCode: 'ADMIN_REVIEW', context });
      await enqueueProjection(client, { projectionType: 'QUEST_HISTORY', aggregateType: 'ORDER_ITEM',
        aggregateId: orderItemId, aggregateVersion: updated.state_version,
        surfaceKey: 'QUEST_HISTORY', context });
    }
    const review = await openReview(client, { subjectType: 'ORDER_ITEM', subjectId: orderItemId,
      reason, financial: true, ownerOnly, context });
    await appendAdminAudit(client, { action: 'ORDER_ITEM_REVIEW_OPENED', targetType: 'ORDER_ITEM',
      targetId: orderItemId, actorId: context.actorId, before: { state: item.state },
      after: { state: 'MANUAL_REVIEW', reviewId: review.id }, reason, context });
    return review;
  });
}

export async function setCircuitBreakerState({ breakerKey, nextState, expectedVersion,
  reason }, context, options = {}) {
  if (!['HALF_OPEN', 'CLOSED'].includes(nextState) || !reason?.trim()) throw new TypeError('invalid circuit breaker change');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const before = (await client.query('SELECT * FROM circuit_breakers WHERE breaker_key=$1 FOR UPDATE',
      [breakerKey])).rows[0];
    if (!before || String(before.state_version) !== String(expectedVersion)) {
      throw new QuestshopError('STALE_STATE', 'Circuit breaker เปลี่ยนหลัง Preview');
    }
    const updated = (await client.query(`UPDATE circuit_breakers SET state=$2,reason=$3,
      failure_count=CASE WHEN $2='CLOSED' THEN 0 ELSE failure_count END,
      next_probe_at=CASE WHEN $2='HALF_OPEN' THEN clock_timestamp() ELSE NULL END,
      state_version=state_version+1,trace_id=$4,updated_at=clock_timestamp()
      WHERE breaker_key=$1 AND state_version=$5 RETURNING *`, [breakerKey, nextState,
      reason, context.traceId, expectedVersion])).rows[0];
    await appendAdminAudit(client, { action: 'CIRCUIT_BREAKER_CHANGE', targetType: 'CIRCUIT_BREAKER',
      targetId: breakerKey, actorId: context.actorId, before, after: updated, reason, context });
    return updated;
  });
}
