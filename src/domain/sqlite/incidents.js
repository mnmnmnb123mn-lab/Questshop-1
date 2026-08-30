import { createHash } from 'node:crypto';
import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';
import { enqueueNotificationInTransaction } from './notifications.js';

function idFor(code, scope) {
  return createHash('sha256').update(`${code}:${scope}`).digest('hex').slice(0, 36);
}

/** Notifications are intentionally the one durable record and one Discord
 * message for a lightweight system incident; no metrics-history table is
 * needed in the SQLite design. */
export function recordSystemIncidentInTransaction(db, { code, scope = 'RUNTIME', severity = 'ERROR', details = {}, resolved = false,
  timestamp = nowMs() }) {
  const aggregateId = idFor(code, scope);
  const existing = db.prepare(`SELECT * FROM notifications WHERE notification_type='SYSTEM_LOG'
    AND aggregate_type='INCIDENT' AND aggregate_id=? AND destination='LOG_SYSTEM'`).get(aggregateId);
  let occurrenceCount = 1;
  try { occurrenceCount = Number(JSON.parse(existing?.payload_json ?? '{}').occurrenceCount ?? 0) + 1; } catch { /* reset safely */ }
  enqueueNotificationInTransaction(db, { notificationType: 'SYSTEM_LOG', aggregateType: 'INCIDENT', aggregateId,
    destination: 'LOG_SYSTEM', payload: { code: String(code).slice(0, 100), scope: String(scope).slice(0, 100),
      severity: String(severity).slice(0, 20), resolved: resolved === true, occurrenceCount, lastSeenAt: timestamp, details }, timestamp });
  return aggregateId;
}

export function recordSystemIncident(db, input) {
  return withImmediateTransaction(db, () => recordSystemIncidentInTransaction(db, input));
}
