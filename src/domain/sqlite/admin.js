import { randomUUID } from 'node:crypto';
import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';
import { currentFeatureGates } from './gates.js';
import { enqueueNotificationInTransaction } from './notifications.js';
import { QuestshopError } from '../../shared/errors.js';
import { resolveTopupFinancialReview } from './payments.js';

export const ADMIN_AUDIT_ALLOWED_FIELDS = Object.freeze({
  FEATURE_GATE_CHANGE: ['gate', 'enabled'],
  PROMOTION_UPDATED: ['name', 'state', 'startsAt', 'endsAt', 'basisPoints', 'minimumCents', 'maximumBonusCents'],
  MONITOR_UPDATED: ['label', 'state', 'cooldownUntil'],
  WALLET_ADJUSTMENT: ['availableDeltaCents', 'reservedDeltaCents'],
  MANUAL_REVIEW_DECISION: ['decision', 'status'],
  TOPUP_REVERSED: ['status', 'walletTransactionId'],
  ORDER_ITEM_REFUNDED: ['state', 'refundCents'],
  DISCOVERY_RETRY: ['queued'],
  QUEST_ANNOUNCED: ['monitorVerified'],
  SURFACE_SETUP: ['channelId', 'messageId'],
});

function filtered(action, value) {
  if (!value || typeof value !== 'object') return null;
  const allowed = ADMIN_AUDIT_ALLOWED_FIELDS[action] ?? [];
  return Object.fromEntries(allowed.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}

export function appendAdminAuditInTransaction(db, { actorId, action, targetType, targetId, reason = null, before = null, after = null, traceId = randomUUID(), timestamp = nowMs() }) {
  const id = randomUUID();
  db.prepare(`INSERT INTO admin_audit(id,actor_id,action,target_type,target_id,reason,before_json,after_json,trace_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, actorId, action, targetType, targetId, reason,
    before == null ? null : JSON.stringify(filtered(action, before)), after == null ? null : JSON.stringify(filtered(action, after)), traceId, timestamp);
  enqueueNotificationInTransaction(db, { notificationType: 'ADMIN_LOG', aggregateType: 'ADMIN_AUDIT', aggregateId: id,
    destination: 'LOG_ADMIN', payload: { auditId: id }, timestamp });
  return id;
}

export function changeFeatureGate(db, { gate, enabled, actorId, reason = '' }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const current = currentFeatureGates(db);
    if (!Object.hasOwn(current, gate)) throw new QuestshopError('FEATURE_GATE_UNKNOWN', 'ไม่พบสวิตช์ระบบนี้');
    const next = { ...current, [gate]: enabled === true };
    db.prepare(`INSERT INTO settings(key,value_json,updated_at,updated_by) VALUES('feature_gates',?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .run(JSON.stringify(next), timestamp, actorId);
    appendAdminAuditInTransaction(db, { actorId, action: 'FEATURE_GATE_CHANGE', targetType: 'FEATURE_GATE', targetId: gate,
      reason, before: { gate, enabled: current[gate] }, after: { gate, enabled: next[gate] }, timestamp });
    return next;
  });
}

export function confirmFinancialReview(db, input) {
  return resolveTopupFinancialReview(db, input);
}
