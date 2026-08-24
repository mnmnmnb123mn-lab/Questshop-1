import { v7 as uuidv7 } from 'uuid';
import { withTransaction } from '../../db/transaction.js';
import { AuthorizationError, QuestshopError } from '../../shared/errors.js';
import { appendAdminAudit } from '../admin/audit.js';
import { recordTransition } from '../shared/transition.js';

export async function replayDeadLetter({ dlqId, reason }, context, options = {}) {
  if (!reason?.trim()) throw new TypeError('DLQ replay reason is required');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const dlq = (await client.query('SELECT * FROM dead_letter_items WHERE id=$1 FOR UPDATE', [dlqId])).rows[0];
    if (dlq?.state !== 'DEAD_LETTER') throw new QuestshopError('DLQ_NOT_REPLAYABLE', 'DLQ ไม่อยู่ในสถานะที่ Replay ได้');
    if (dlq.source_type !== 'OUTBOX') throw new QuestshopError('DLQ_REPLAY_UNSUPPORTED', 'DLQ ประเภทนี้ต้องใช้ Runbook เฉพาะ');
    const source = (await client.query('SELECT * FROM outbox_events WHERE id=$1 FOR UPDATE', [dlq.source_id])).rows[0];
    if (!source) throw new QuestshopError('DLQ_SOURCE_MISSING', 'ไม่พบ Outbox ต้นทาง');
    const replayId = uuidv7(); const replayTraceId = uuidv7();
    await client.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,aggregate_version,
      projection_id,state,available_at,trace_id,causation_id)
      VALUES($1,$2,$3,$4,$5,$6,'PENDING',clock_timestamp(),$7,$8)`, [replayId,
      `REPLAY:${dlq.id}`, source.aggregate_type, source.aggregate_id, source.aggregate_version,
      source.projection_id, replayTraceId, source.trace_id]);
    const updated = (await client.query(`UPDATE dead_letter_items SET state='PENDING',state_version=state_version+1,
      replay_trace_id=$2,evidence=evidence||$3::jsonb WHERE id=$1 AND state='DEAD_LETTER'
        AND state_version=$4 RETURNING *`, [dlq.id, replayTraceId,
      { replayOutboxId: replayId, reason, parentOutboxId: source.id }, dlq.state_version])).rows[0];
    if (!updated) throw new QuestshopError('DLQ_STALE', 'DLQ changed during replay');
    await recordTransition(client, { aggregateType: 'DEAD_LETTER', aggregateId: dlq.id,
      fromState: 'DEAD_LETTER', toState: 'PENDING', stateVersion: updated.state_version,
      reasonCode: 'ADMIN_REPLAY', context });
    await appendAdminAudit(client, { action: 'DLQ_REPLAY', targetType: 'DLQ', targetId: dlq.id,
      actorId: context.actorId, before: dlq, after: updated, reason, context });
    return { dlq: updated, replayOutboxId: replayId, replayTraceId };
  });
}

export async function discardDeadLetter({ dlqId, reason, isOwner }, context, options = {}) {
  if (!isOwner) throw new AuthorizationError('การ Discard DLQ ใช้ได้เฉพาะ Owner');
  if (!reason?.trim()) throw new TypeError('DLQ discard reason is required');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const dlq = (await client.query('SELECT * FROM dead_letter_items WHERE id=$1 FOR UPDATE', [dlqId])).rows[0];
    if (dlq?.state !== 'DEAD_LETTER') throw new QuestshopError('DLQ_NOT_DISCARDABLE', 'DLQ ไม่อยู่ในสถานะที่ Discard ได้');
    if (['FINANCIAL', 'AUDIT'].includes(dlq.category)) {
      throw new QuestshopError('DLQ_DISCARD_FORBIDDEN', 'Financial/Audit DLQ ห้าม Discard');
    }
    const updated = (await client.query(`UPDATE dead_letter_items SET state='DISCARDED',state_version=state_version+1,
      resolved_at=clock_timestamp(),evidence=evidence||$2::jsonb WHERE id=$1 AND state='DEAD_LETTER'
        AND state_version=$3 RETURNING *`, [dlq.id, { discardReason: reason }, dlq.state_version])).rows[0];
    if (!updated) throw new QuestshopError('DLQ_STALE', 'DLQ changed during discard');
    await recordTransition(client, { aggregateType: 'DEAD_LETTER', aggregateId: dlq.id,
      fromState: 'DEAD_LETTER', toState: 'DISCARDED', stateVersion: updated.state_version,
      reasonCode: 'OWNER_DISCARD', context });
    await appendAdminAudit(client, { action: 'DLQ_DISCARD', targetType: 'DLQ', targetId: dlq.id,
      actorId: context.actorId, before: dlq, after: updated, reason, context });
    return updated;
  });
}
