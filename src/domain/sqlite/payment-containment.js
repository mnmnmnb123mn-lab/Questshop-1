import { randomUUID } from 'node:crypto';
import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';
import { currentFeatureGates } from './gates.js';
import { enqueueNotificationInTransaction } from './notifications.js';
import { recordSystemIncidentInTransaction } from './incidents.js';
import { QuestshopError } from '../../shared/errors.js';

const KEY = 'payment_containment';
const CLOSED = Object.freeze({ state: 'CLOSED', stateVersion: 1, reasonCode: null, probeTopupId: null });

function read(row) {
  try {
    const value = JSON.parse(row?.value_json ?? '{}');
    if (['CLOSED', 'OPEN', 'PROBE_PENDING', 'PROBE_VERIFIED'].includes(value.state)) {
      return { ...CLOSED, ...value, stateVersion: Number(value.stateVersion) || 1 };
    }
  } catch { /* fail closed below */ }
  return { ...CLOSED };
}

function save(db, value, { actorId, timestamp }) {
  db.prepare(`INSERT INTO settings(key,value_json,updated_at,updated_by) VALUES(?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
    .run(KEY, JSON.stringify(value), timestamp, actorId);
}

function audit(db, { actorId, action, reason, before, after, timestamp }) {
  const id = randomUUID();
  db.prepare(`INSERT INTO admin_audit(id,actor_id,action,target_type,target_id,reason,before_json,after_json,trace_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, actorId, action, 'PAYMENT_CONTAINMENT', KEY, reason,
    JSON.stringify(before), JSON.stringify(after), randomUUID(), timestamp);
  enqueueNotificationInTransaction(db, { notificationType: 'ADMIN_LOG', aggregateType: 'ADMIN_AUDIT', aggregateId: id,
    destination: 'LOG_ADMIN', payload: { auditId: id }, timestamp });
}

export function currentPaymentContainment(db) {
  return Object.freeze(read(db.prepare('SELECT value_json FROM settings WHERE key=?').get(KEY)));
}

export function assertPaymentAutomationSafe(db) {
  const containment = currentPaymentContainment(db);
  if (containment.state !== 'CLOSED') {
    throw new QuestshopError('PAYMENT_CONTAINMENT_OPEN', 'การเติมเงินอัตโนมัติถูกระงับเพื่อความปลอดภัย');
  }
}

/** Close money intake and auto-credit together whenever adapter data cannot be
 * trusted. This boundary is persistent and deliberately idempotent. */
export function openPaymentContainment(db, { reasonCode, details = {}, actorId = 'SYSTEM', timestamp = nowMs() }) {
  return withImmediateTransaction(db, () => {
    const before = currentPaymentContainment(db);
    const next = before.state === 'OPEN'
      ? before
      : { ...before, state: 'OPEN', stateVersion: before.stateVersion + 1, reasonCode: String(reasonCode).slice(0, 100),
        openedAt: timestamp, openedBy: actorId, probeTopupId: null, probeVerifiedAt: null };
    if (next !== before) save(db, next, { actorId, timestamp });
    const gates = currentFeatureGates(db);
    const guarded = { ...gates, TOPUP_ACCEPTING: false, AUTO_CREDIT_ENABLED: false };
    db.prepare(`INSERT INTO settings(key,value_json,updated_at,updated_by) VALUES('feature_gates',?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .run(JSON.stringify(guarded), timestamp, actorId);
    if (next !== before) {
      audit(db, { actorId, action: 'PAYMENT_CONTAINMENT_OPENED', reason: next.reasonCode, before, after: next, timestamp });
      recordSystemIncidentInTransaction(db, { code: 'PAYMENT_CONTAINMENT_OPEN', scope: 'TRUEMONEY', severity: 'ERROR',
        details: { reasonCode: next.reasonCode, ...details }, timestamp });
    }
    return { containment: next, gates: guarded, idempotent: next === before };
  });
}

export function beginPaymentProbe(db, { actorId, timestamp = nowMs() }) {
  return withImmediateTransaction(db, () => {
    const before = currentPaymentContainment(db);
    if (before.state !== 'OPEN') throw new QuestshopError('PAYMENT_PROBE_STATE_INVALID', 'ยังไม่อยู่ในสถานะระงับการเติมเงิน');
    const next = { ...before, state: 'PROBE_PENDING', stateVersion: before.stateVersion + 1, probeStartedAt: timestamp, probeStartedBy: actorId,
      probeOwnerId: actorId, probeTopupId: null, probeVerifiedAt: null };
    save(db, next, { actorId, timestamp });
    audit(db, { actorId, action: 'PAYMENT_PROBE_STARTED', reason: before.reasonCode, before, after: next, timestamp });
    return next;
  });
}

export function verifyPaymentProbe(db, { topupId, actorId = 'SYSTEM', timestamp = nowMs() }) {
  return withImmediateTransaction(db, () => {
    const before = currentPaymentContainment(db);
    if (before.state !== 'PROBE_PENDING') return before;
    const topup = db.prepare("SELECT * FROM topups WHERE id=? AND status='CREDITED' AND discord_user_id=?").get(topupId, before.probeOwnerId);
    if (!topup) throw new QuestshopError('PAYMENT_PROBE_NOT_CREDITED', 'รายการทดสอบยังไม่ได้รับเครดิตสำเร็จ');
    const next = { ...before, state: 'PROBE_VERIFIED', stateVersion: before.stateVersion + 1, probeTopupId: topup.id,
      probeVerifiedAt: timestamp, probeVerifiedBy: actorId };
    save(db, next, { actorId, timestamp });
    audit(db, { actorId, action: 'PAYMENT_PROBE_VERIFIED', reason: before.reasonCode, before, after: next, timestamp });
    return next;
  });
}

/** A probe is the sole contained exception: it is still submitted, settled,
 * and credited through the ordinary top-up path, but only for the Owner that
 * opened the explicit probe. */
export function paymentProbeAllowsTopup(db, topupId) {
  const containment = currentPaymentContainment(db);
  if (containment.state !== 'PROBE_PENDING' || !containment.probeOwnerId) return false;
  return Boolean(db.prepare('SELECT 1 FROM topups WHERE id=? AND discord_user_id=?').get(topupId, containment.probeOwnerId));
}

export function closePaymentContainment(db, { actorId, timestamp = nowMs() }) {
  return withImmediateTransaction(db, () => {
    const before = currentPaymentContainment(db);
    if (before.state !== 'PROBE_VERIFIED') throw new QuestshopError('PAYMENT_PROBE_REQUIRED', 'ต้องยืนยันรายการทดสอบที่เครดิตสำเร็จก่อนเปิดระบบ');
    const next = { ...before, state: 'CLOSED', stateVersion: before.stateVersion + 1, closedAt: timestamp, closedBy: actorId };
    save(db, next, { actorId, timestamp });
    audit(db, { actorId, action: 'PAYMENT_CONTAINMENT_CLOSED', reason: before.reasonCode, before, after: next, timestamp });
    recordSystemIncidentInTransaction(db, { code: 'PAYMENT_CONTAINMENT_OPEN', scope: 'TRUEMONEY', severity: 'INFO', resolved: true,
      details: { probeTopupId: before.probeTopupId }, timestamp });
    return next;
  });
}
