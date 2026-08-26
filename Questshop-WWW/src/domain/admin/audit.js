import { v7 as uuidv7 } from 'uuid';
import { enqueueProjection } from '../outbox/service.js';

const SENSITIVE_AUDIT_KEY = /(?:token|cookie|secret|credential|ciphertext|auth(?:entication)?[_-]?tag|nonce|voucher|password|authorization|session)/i;
const REDACTED = '[REDACTED]';

// Admin evidence is append-only, but it must never become a second storage
// path for secrets.  Domain callers may pass full database rows, so enforce a
// defensive recursive scrub at the common persistence boundary.
export function redactAuditState(value, key = '', depth = 0) {
  if (SENSITIVE_AUDIT_KEY.test(key)) return REDACTED;
  if (depth >= 12) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => redactAuditState(item, '', depth + 1));
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey,
      redactAuditState(child, childKey, depth + 1)]));
  }
  return value;
}

// node-postgres treats JavaScript arrays as PostgreSQL arrays, while audit
// columns are JSONB.  Serialize the safe value here so arrays remain JSON and
// integer satang values are represented without losing precision.
export function serializeAuditState(value) {
  if (value == null) return null;
  return JSON.stringify(redactAuditState(value), (_key, child) => (typeof child === 'bigint' ? child.toString() : child));
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
