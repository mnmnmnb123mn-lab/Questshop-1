import { v7 as uuidv7 } from 'uuid';
import { withTransaction } from '../../db/transaction.js';
import { QuestshopError } from '../../shared/errors.js';

const POLICY = Object.freeze({
  BUTTON: { limit: 1, seconds: 2 }, TOKEN_VALIDATE: { limit: 3, seconds: 600 },
  VOUCHER_INVALID: { limit: 5, seconds: 1800 }, ORDER_CONFIRM: { limit: 5, seconds: 600 },
});

export async function assertRateLimitAvailable({ discordUserId, operation }, _context, options = {}) {
  const policy = POLICY[operation];
  if (!policy) throw new TypeError('unknown rate limit operation');
  return withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, async (client) => {
    const count = Number((await client.query(`SELECT count(*)::integer AS count
      FROM customer_rate_limit_events WHERE discord_user_id=$1 AND operation=$2
      AND created_at>clock_timestamp()-make_interval(secs=>$3)`,
    [discordUserId, operation, policy.seconds])).rows[0].count);
    if (count >= policy.limit) throw new QuestshopError('RATE_LIMITED', 'ทำรายการผิดซ้ำเกินกำหนด กรุณารอสักครู่');
    return { remaining: policy.limit - count };
  });
}

export async function consumeRateLimit({ discordUserId, operation }, context, options = {}) {
  const policy = POLICY[operation];
  if (!policy) throw new TypeError('unknown rate limit operation');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const count = Number((await client.query(`SELECT count(*)::integer AS count
      FROM customer_rate_limit_events WHERE discord_user_id=$1 AND operation=$2
      AND created_at > clock_timestamp()-make_interval(secs=>$3)`,
    [discordUserId, operation, policy.seconds])).rows[0].count);
    if (count >= policy.limit) throw new QuestshopError('RATE_LIMITED', 'ทำรายการถี่เกินไป กรุณารอสักครู่');
    await client.query(`INSERT INTO customer_rate_limit_events(id,discord_user_id,operation,trace_id)
      VALUES($1,$2,$3,$4)`, [uuidv7(), discordUserId, operation, context.traceId]);
    return { remaining: policy.limit - count - 1 };
  });
}
