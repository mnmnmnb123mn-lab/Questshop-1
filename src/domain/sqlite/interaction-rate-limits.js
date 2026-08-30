import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';
import { QuestshopError } from '../../shared/errors.js';

/** A compact, restart-safe fixed window limiter for customer mutations. */
export function consumeInteractionRateLimit(db, { discordUserId, action, limit, windowMs, timestamp = nowMs() }) {
  if (!/^\d{1,32}$/.test(String(discordUserId ?? '')) || !/^[A-Z_]{3,64}$/.test(String(action ?? ''))
    || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new TypeError('Invalid interaction rate-limit policy');
  }
  return withImmediateTransaction(db, () => {
    const current = db.prepare('SELECT * FROM interaction_rate_limits WHERE discord_user_id=? AND action=?').get(discordUserId, action);
    const active = current && timestamp - Number(current.window_started_at) < windowMs;
    const count = active ? Number(current.count) : 0;
    if (count >= limit) {
      const error = new QuestshopError('INTERACTION_RATE_LIMITED', 'ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่');
      error.retryAt = Number(current.window_started_at) + windowMs;
      throw error;
    }
    if (!current) {
      db.prepare(`INSERT INTO interaction_rate_limits(discord_user_id,action,window_started_at,count,state_version,updated_at)
        VALUES(?,?,?,1,1,?)`).run(discordUserId, action, timestamp, timestamp);
    } else if (active) {
      db.prepare(`UPDATE interaction_rate_limits SET count=count+1,state_version=state_version+1,updated_at=?
        WHERE discord_user_id=? AND action=? AND state_version=?`).run(timestamp, discordUserId, action, current.state_version);
    } else {
      db.prepare(`UPDATE interaction_rate_limits SET window_started_at=?,count=1,state_version=state_version+1,updated_at=?
        WHERE discord_user_id=? AND action=? AND state_version=?`).run(timestamp, timestamp, discordUserId, action, current.state_version);
    }
    return { remaining: limit - count - 1, resetAt: (active ? Number(current.window_started_at) : timestamp) + windowMs };
  });
}
