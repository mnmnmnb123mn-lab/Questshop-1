import { randomUUID } from 'node:crypto';
import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';
import { QuestshopError } from '../../shared/errors.js';

const DEFAULT_LIFETIME_MS = 15 * 60_000;

export function createInteractionSession(db, { actorId, guildId, channelId, messageId = null, operation, payload = {},
  expiresAt = nowMs() + DEFAULT_LIFETIME_MS }) {
  if (!actorId || !guildId || !channelId || !operation) throw new TypeError('Incomplete interaction session context');
  const timestamp = nowMs();
  const id = randomUUID();
  withImmediateTransaction(db, () => db.prepare(`INSERT INTO interaction_sessions(
    id,actor_id,guild_id,channel_id,message_id,operation,payload_json,expires_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, actorId, guildId, channelId, messageId, operation,
    JSON.stringify(payload), expiresAt, timestamp, timestamp));
  return id;
}

export function bindInteractionSessionMessage(db, { sessionId, messageId }) {
  return withImmediateTransaction(db, () => db.prepare(`UPDATE interaction_sessions SET message_id=?,state_version=state_version+1,updated_at=?
    WHERE id=? AND message_id IS NULL AND consumed_at IS NULL`).run(messageId, nowMs(), sessionId).changes === 1);
}

export function consumeInteractionSession(db, { sessionId, actorId, guildId, channelId, messageId, operation }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const row = db.prepare('SELECT * FROM interaction_sessions WHERE id=?').get(sessionId);
    if (!row || row.consumed_at != null || Number(row.expires_at) <= timestamp) {
      throw new QuestshopError('INTERACTION_EXPIRED', 'ปุ่มนี้หมดอายุแล้ว กรุณาเปิดเมนูใหม่');
    }
    if (row.actor_id !== actorId || row.guild_id !== guildId || row.channel_id !== channelId || row.message_id !== messageId || row.operation !== operation) {
      throw new QuestshopError('INTERACTION_CONTEXT_INVALID', 'ปุ่มนี้ไม่ตรงกับรายการที่อนุญาต');
    }
    const changed = db.prepare(`UPDATE interaction_sessions SET consumed_at=?,state_version=state_version+1,updated_at=?
      WHERE id=? AND consumed_at IS NULL AND state_version=?`).run(timestamp, timestamp, row.id, row.state_version);
    if (!changed.changes) throw new QuestshopError('INTERACTION_CONFLICT', 'ปุ่มนี้ถูกใช้งานแล้ว');
    try { return { ...row, payload: JSON.parse(row.payload_json) }; }
    catch { throw new QuestshopError('INTERACTION_PAYLOAD_INVALID', 'ข้อมูลปุ่มไม่ถูกต้อง'); }
  });
}

/** Modal submits do not carry their originating Discord message.  Their
 * server-side session is nevertheless bound to that message when the modal
 * is opened; on submit we validate every context field that Discord exposes
 * and consume the opaque one-time session. */
export function consumeModalInteractionSession(db, { sessionId, actorId, guildId, channelId, operation }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const row = db.prepare('SELECT * FROM interaction_sessions WHERE id=?').get(sessionId);
    if (!row || row.consumed_at != null || Number(row.expires_at) <= timestamp) {
      throw new QuestshopError('INTERACTION_EXPIRED', 'แบบฟอร์มนี้หมดอายุแล้ว กรุณาเปิดใหม่');
    }
    if (row.actor_id !== actorId || row.guild_id !== guildId || row.channel_id !== channelId || row.operation !== operation) {
      throw new QuestshopError('INTERACTION_CONTEXT_INVALID', 'แบบฟอร์มนี้ไม่ตรงกับรายการที่อนุญาต');
    }
    const changed = db.prepare(`UPDATE interaction_sessions SET consumed_at=?,state_version=state_version+1,updated_at=?
      WHERE id=? AND consumed_at IS NULL AND state_version=?`).run(timestamp, timestamp, row.id, row.state_version);
    if (!changed.changes) throw new QuestshopError('INTERACTION_CONFLICT', 'แบบฟอร์มนี้ถูกใช้งานแล้ว');
    try { return { ...row, payload: JSON.parse(row.payload_json) }; }
    catch { throw new QuestshopError('INTERACTION_PAYLOAD_INVALID', 'ข้อมูลแบบฟอร์มไม่ถูกต้อง'); }
  });
}

export function cleanupExpiredInteractionSessions(db, { now = nowMs() } = {}) {
  return withImmediateTransaction(db, () => db.prepare('DELETE FROM interaction_sessions WHERE expires_at<?').run(now).changes);
}
