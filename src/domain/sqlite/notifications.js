import { createHash, randomUUID } from 'node:crypto';
import { nowMs } from '../../db/sqlite.js';
import { withImmediateTransaction } from '../../db/sqlite.js';

function notificationNonce(id) {
  return createHash('sha256').update(id).digest('base64url').slice(0, 25);
}

export function enqueueNotification(db, {
  notificationType, aggregateType, aggregateId, destination, payload = {}, timestamp = nowMs(),
}) {
  return withImmediateTransaction(db, () => enqueueNotificationInTransaction(db, {
    notificationType, aggregateType, aggregateId, destination, payload, timestamp,
  }));
}

/** The aggregate service already owns the transaction. */
export function enqueueNotificationInTransaction(db, {
  notificationType, aggregateType, aggregateId, destination, payload = {}, timestamp = nowMs(),
}) {
  const existing = db.prepare(`SELECT * FROM notifications
      WHERE notification_type=? AND aggregate_type=? AND aggregate_id=? AND destination=?`)
      .get(notificationType, aggregateType, aggregateId, destination);
  if (existing) {
      const nextVersion = Number(existing.desired_version) + 1;
      db.prepare(`UPDATE notifications SET desired_version=?,state=CASE WHEN state='SENDING' THEN state ELSE 'PENDING' END,
        attempt_count=CASE WHEN state='SENDING' THEN attempt_count ELSE 0 END,
        attempt_version=CASE WHEN state='SENDING' THEN attempt_version ELSE 0 END,
        next_run_at=?,payload_json=?,updated_at=? WHERE id=?`).run(nextVersion, timestamp, JSON.stringify(payload), timestamp, existing.id);
    return { ...existing, desired_version: nextVersion, payload_json: JSON.stringify(payload) };
  }
  const id = randomUUID();
  const row = { id, notificationType, aggregateType, aggregateId, destination, nonce: notificationNonce(id) };
  db.prepare(`INSERT INTO notifications(id,notification_type,aggregate_type,aggregate_id,destination,nonce,state,
      desired_version,delivered_version,attempt_count,next_run_at,payload_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'PENDING',1,0,0,?,?,?,?)`).run(
      row.id, row.notificationType, row.aggregateType, row.aggregateId, row.destination, row.nonce,
      timestamp, JSON.stringify(payload), timestamp, timestamp,
    );
  return db.prepare('SELECT * FROM notifications WHERE id=?').get(id);
}

export function claimDueNotification(db, { now = nowMs(), leaseMs = 30_000 } = {}) {
  return withImmediateTransaction(db, () => {
    const row = db.prepare(`SELECT * FROM notifications WHERE state IN ('PENDING','RETRY_WAIT') AND next_run_at<=?
      ORDER BY next_run_at,created_at LIMIT 1`).get(now);
    if (!row) return null;
    const token = randomUUID();
    const changed = db.prepare(`UPDATE notifications SET state='SENDING',sending_version=desired_version,lease_token=?,
      lease_expires_at=?,attempt_count=CASE WHEN attempt_version=desired_version THEN attempt_count+1 ELSE 1 END,
      attempt_version=desired_version,updated_at=? WHERE id=? AND state IN ('PENDING','RETRY_WAIT')
        AND desired_version=?`).run(token, now + leaseMs, now, row.id, row.desired_version);
    if (!changed.changes) return null;
    return db.prepare('SELECT * FROM notifications WHERE id=?').get(row.id);
  });
}

/** Renew an in-flight Discord delivery before it performs another network
 * action.  A stale sender therefore cannot complete after recovery has taken
 * ownership of the projection. */
export function renewNotificationLease(db, { notificationId, leaseToken, now = nowMs(), leaseMs = 30_000 } = {}) {
  return withImmediateTransaction(db, () => {
    const changed = db.prepare(`UPDATE notifications SET lease_expires_at=?,updated_at=?
      WHERE id=? AND state='SENDING' AND lease_token=? AND lease_expires_at>?`).run(
      now + leaseMs, now, notificationId, leaseToken, now,
    );
    return changed.changes === 1;
  });
}

const RETRY_DELAYS_MS = Object.freeze([1_000, 5_000, 15_000, 60_000, 300_000, 900_000]);

export function finishNotificationDelivery(db, { notificationId, leaseToken, messageId = null, errorCode = null,
  now = nowMs() }) {
  return withImmediateTransaction(db, () => {
    const row = db.prepare('SELECT * FROM notifications WHERE id=?').get(notificationId);
    if (!row || row.state !== 'SENDING' || row.lease_token !== leaseToken || Number(row.lease_expires_at) <= now) return null;
    if (!errorCode) {
      const current = Number(row.desired_version) > Number(row.sending_version);
      db.prepare(`UPDATE notifications SET message_id=COALESCE(?,message_id),delivered_version=?,state=?,
        lease_token=NULL,lease_expires_at=NULL,next_run_at=?,last_error_code=NULL,
        attempt_count=CASE WHEN ? THEN 0 ELSE attempt_count END,attempt_version=CASE WHEN ? THEN 0 ELSE attempt_version END,updated_at=? WHERE id=?`).run(
        messageId, row.sending_version, current ? 'PENDING' : 'DELIVERED', now, current ? 1 : 0, current ? 1 : 0, now, notificationId,
      );
      return db.prepare('SELECT * FROM notifications WHERE id=?').get(notificationId);
    }
    const retryIndex = Number(row.attempt_count) - 1;
    const delay = RETRY_DELAYS_MS[retryIndex];
    const state = delay == null ? 'DEAD_LETTER' : 'RETRY_WAIT';
    db.prepare(`UPDATE notifications SET state=?,lease_token=NULL,lease_expires_at=NULL,next_run_at=?,last_error_code=?,updated_at=?
      WHERE id=?`).run(state, now + (delay ?? 0), String(errorCode).slice(0, 100), now, notificationId);
    return db.prepare('SELECT * FROM notifications WHERE id=?').get(notificationId);
  });
}

export function deferNotification(db, { notificationId, leaseToken, retryAt, reason = 'FEATURE_DISABLED', now = nowMs() }) {
  return withImmediateTransaction(db, () => {
    const row = db.prepare('SELECT * FROM notifications WHERE id=?').get(notificationId);
    if (!row || row.state !== 'SENDING' || row.lease_token !== leaseToken || Number(row.lease_expires_at) <= now) return null;
    db.prepare(`UPDATE notifications SET state='RETRY_WAIT',lease_token=NULL,lease_expires_at=NULL,next_run_at=?,
      attempt_count=MAX(0,attempt_count-1),last_error_code=?,updated_at=? WHERE id=?`).run(retryAt, reason, now, notificationId);
    return db.prepare('SELECT * FROM notifications WHERE id=?').get(notificationId);
  });
}

export function recoverSendingNotifications(db, { now = nowMs() } = {}) {
  return withImmediateTransaction(db, () => db.prepare(`UPDATE notifications SET state='RETRY_WAIT',lease_token=NULL,
    lease_expires_at=NULL,next_run_at=?,updated_at=? WHERE state='SENDING' AND lease_expires_at<?`).run(now, now, now).changes);
}

/** A dead-lettered Discord projection can be retried by an Administrator.
 * It preserves the same logical notification/nonce, so a crash recovery will
 * edit the original message instead of creating a second projection. */
export function retryDeadLetterNotification(db, { notificationId, now = nowMs() }) {
  return withImmediateTransaction(db, () => {
    const row = db.prepare("SELECT * FROM notifications WHERE id=? AND state='DEAD_LETTER'").get(notificationId);
    if (!row) return null;
    db.prepare(`UPDATE notifications SET state='PENDING',attempt_count=0,attempt_version=0,next_run_at=?,last_error_code=NULL,
      lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='DEAD_LETTER'`).run(now, now, notificationId);
    return db.prepare('SELECT * FROM notifications WHERE id=?').get(notificationId);
  });
}
