import { v7 as uuidv7 } from 'uuid';
import { enqueueProjection } from '../outbox/service.js';

// node-postgres treats JavaScript arrays as PostgreSQL arrays, while audit
// columns are JSONB.  Serialize the full value here so arrays remain JSON and
// integer satang values are represented without losing precision.
export function serializeAuditState(value) {
  if (value == null) return null;
  return JSON.stringify(value, (_key, child) => (typeof child === 'bigint' ? child.toString() : child));
}

export async function appendAdminAudit(client, {
  action, targetType, targetId, actorId, before = null, after = null, reason, context,
}) {
  const row = (await client.query(`
    INSERT INTO admin_audit_logs(id,action,target_type,target_id,actor_id,before_state,after_state,
      reason,trace_id,correlation_code)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
  `, [uuidv7(), action, targetType, String(targetId), actorId,
    serializeAuditState(before), serializeAuditState(after), reason,
    context.traceId, context.traceId.replaceAll('-', '').slice(0, 10).toUpperCase()])).rows[0];
  await enqueueProjection(client, { projectionType: 'ADMIN_AUDIT', aggregateType: 'ADMIN_AUDIT',
    aggregateId: row.id, aggregateVersion: 1, surfaceKey: 'LOG_ADMIN', context });
  return row;
}
