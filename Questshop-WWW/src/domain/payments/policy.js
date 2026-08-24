import { withTransaction } from '../../db/transaction.js';
import { bangkokDayBounds } from '../../db/postgres-time.js';
import { QuestshopError } from '../../shared/errors.js';
import { appendAdminAudit } from '../admin/audit.js';

export const DEFAULT_PAYMENT_POLICY = Object.freeze({
  autoCreditMinCents: 1_000n,
  autoCreditMaxCents: 100_000n,
  dailyRedeemedLimitCents: 300_000n,
});

function parseCents(value, fallback, { nullable = false, minimum = 0n } = {}) {
  if (value === undefined) return fallback;
  if (value === null && nullable) return null;
  let cents;
  try { cents = BigInt(value); }
  catch { throw new TypeError('invalid payment policy amount'); }
  if (cents < minimum) throw new TypeError('invalid payment policy amount');
  return cents;
}

export function paymentPolicyFromConfigValues(values = {}) {
  const autoCreditMinCents = parseCents(values.topupAutoCreditMinCents,
    DEFAULT_PAYMENT_POLICY.autoCreditMinCents, { minimum: 0n });
  const autoCreditMaxCents = parseCents(values.topupAutoCreditMaxCents,
    DEFAULT_PAYMENT_POLICY.autoCreditMaxCents, { nullable: true, minimum: 1n });
  const dailyRedeemedLimitCents = parseCents(values.topupDailyLimitCents,
    DEFAULT_PAYMENT_POLICY.dailyRedeemedLimitCents, { nullable: true, minimum: 1n });
  if (autoCreditMaxCents != null && autoCreditMaxCents < autoCreditMinCents) {
    throw new TypeError('top-up automatic-credit maximum must be at least the minimum');
  }
  return Object.freeze({ autoCreditMinCents, autoCreditMaxCents, dailyRedeemedLimitCents });
}

export async function loadPaymentPolicy(source) {
  const config = (await source.query('SELECT payload FROM config_versions ORDER BY version DESC LIMIT 1')).rows[0];
  return paymentPolicyFromConfigValues(config?.payload ?? {});
}

export function topupAmountNeedsReview(amountCents, policy = DEFAULT_PAYMENT_POLICY) {
  if (amountCents == null) return true;
  const amount = BigInt(amountCents);
  // This policy is evaluated after the provider has redeemed the voucher.
  // A high amount must be credited in full; the daily admission lock prevents
  // another top-up. Only a missing/below-minimum amount remains ambiguous.
  return amount < policy.autoCreditMinCents;
}

export function topupAmountExceedsAutoCreditMaximum(amountCents, policy = DEFAULT_PAYMENT_POLICY) {
  if (amountCents == null || policy.autoCreditMaxCents == null) return false;
  return BigInt(amountCents) > policy.autoCreditMaxCents;
}

async function redeemedPrincipalForDay(client, discordUserId, bounds) {
  const row = (await client.query(`SELECT COALESCE(sum(amount_cents),0)::bigint AS total
    FROM topups WHERE discord_user_id=$1 AND redeemed_at IS NOT NULL AND amount_cents IS NOT NULL
      AND redeemed_at >= $2 AND redeemed_at < $3`,
  [discordUserId, bounds.starts_at, bounds.ends_at])).rows[0];
  return BigInt(row.total ?? 0);
}

async function hasOverLimitRedemptionForDay(client, discordUserId, bounds, policy) {
  if (policy.autoCreditMaxCents == null) return false;
  const row = (await client.query(`SELECT EXISTS(
    SELECT 1 FROM topups WHERE discord_user_id=$1 AND redeemed_at IS NOT NULL
      AND redeemed_at >= $2 AND redeemed_at < $3 AND amount_cents > $4
  ) AS over_limit`, [discordUserId, bounds.starts_at, bounds.ends_at, policy.autoCreditMaxCents])).rows[0];
  return row?.over_limit === true;
}

async function currentDailyLock(client, discordUserId) {
  return (await client.query(`SELECT * FROM topup_daily_locks
    WHERE discord_user_id=$1 AND expires_at>clock_timestamp() FOR UPDATE`, [discordUserId])).rows[0] ?? null;
}

async function removeDailyLock(client, existing, context, reason) {
  if (!existing) return false;
  await client.query('DELETE FROM topup_daily_locks WHERE discord_user_id=$1', [existing.discord_user_id]);
  await appendAdminAudit(client, { action: 'TOPUP_DAILY_LOCK_CLEARED', targetType: 'DISCORD_USER',
    targetId: existing.discord_user_id, actorId: context.actorId, before: existing,
    after: { cleared: true }, reason, context });
  return true;
}

export async function reconcileDailyTopupLockInTransaction(client, {
  discordUserId,
  redeemedAt = null,
  policy,
}, context) {
  const effectivePolicy = policy ?? await loadPaymentPolicy(client);
  const existing = await currentDailyLock(client, discordUserId);
  if (effectivePolicy.dailyRedeemedLimitCents == null) {
    const bounds = await bangkokDayBounds(client, redeemedAt);
    const overLimitVoucher = await hasOverLimitRedemptionForDay(client, discordUserId, bounds, effectivePolicy);
    if (overLimitVoucher) {
      const lock = (await client.query(`INSERT INTO topup_daily_locks(discord_user_id,expires_at,trace_id)
        VALUES($1,$2,$3) ON CONFLICT(discord_user_id) DO UPDATE SET
          expires_at=EXCLUDED.expires_at,trace_id=EXCLUDED.trace_id,updated_at=clock_timestamp()
        RETURNING *`, [discordUserId, bounds.ends_at, context.traceId])).rows[0];
      return { locked: true, totalCents: 0n, limitCents: null, overLimitVoucher, bounds, lock };
    }
    await removeDailyLock(client, existing, context, 'DAILY_TOPUP_LIMIT_DISABLED');
    return { locked: false, totalCents: 0n, limitCents: null };
  }
  const bounds = await bangkokDayBounds(client, redeemedAt);
  const totalCents = await redeemedPrincipalForDay(client, discordUserId, bounds);
  const overLimitVoucher = await hasOverLimitRedemptionForDay(client, discordUserId, bounds, effectivePolicy);
  const shouldLock = totalCents >= effectivePolicy.dailyRedeemedLimitCents || overLimitVoucher;
  if (!shouldLock) {
    await removeDailyLock(client, existing, context, 'DAILY_TOPUP_LIMIT_BELOW_THRESHOLD');
    return { locked: false, totalCents, limitCents: effectivePolicy.dailyRedeemedLimitCents, bounds };
  }
  const lock = (await client.query(`INSERT INTO topup_daily_locks(discord_user_id,expires_at,trace_id)
    VALUES($1,$2,$3) ON CONFLICT(discord_user_id) DO UPDATE SET
      expires_at=EXCLUDED.expires_at,trace_id=EXCLUDED.trace_id,updated_at=clock_timestamp()
    RETURNING *`, [discordUserId, bounds.ends_at, context.traceId])).rows[0];
  if (!existing) {
    await appendAdminAudit(client, { action: 'TOPUP_DAILY_LOCK_CREATED', targetType: 'DISCORD_USER',
      targetId: discordUserId, actorId: context.actorId,
      after: { expiresAt: lock.expires_at, totalCents: String(totalCents),
        limitCents: String(effectivePolicy.dailyRedeemedLimitCents), redeemedDay: bounds.bangkok_day,
        overLimitVoucher },
      reason: overLimitVoucher ? 'TOPUP_AMOUNT_OVER_AUTOCREDIT_LIMIT' : 'DAILY_REDEEMED_TOPUP_LIMIT', context });
  }
  return { locked: true, totalCents, limitCents: effectivePolicy.dailyRedeemedLimitCents,
    overLimitVoucher, bounds, lock };
}

export async function reconcileDailyTopupLock(input, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => (
    reconcileDailyTopupLockInTransaction(client, { ...input,
      policy: input.policy ?? await loadPaymentPolicy(client) }, context)
  ));
}

// A voucher can only reveal its amount after a successful direct redemption.
// If it exceeds the configured per-voucher maximum, preserve the full credit
// but close further intake until the Bangkok business day rolls over.
export async function lockTopupIntakeUntilBangkokDayEnds({ discordUserId, redeemedAt = null, reason }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const bounds = await bangkokDayBounds(client, redeemedAt);
    const existing = await currentDailyLock(client, discordUserId);
    const lock = (await client.query(`INSERT INTO topup_daily_locks(discord_user_id,expires_at,trace_id)
      VALUES($1,$2,$3) ON CONFLICT(discord_user_id) DO UPDATE SET
        expires_at=GREATEST(topup_daily_locks.expires_at,EXCLUDED.expires_at),
        trace_id=EXCLUDED.trace_id,updated_at=clock_timestamp()
      RETURNING *`, [discordUserId, bounds.ends_at, context.traceId])).rows[0];
    if (!existing) {
      await appendAdminAudit(client, { action: 'TOPUP_DAILY_LOCK_CREATED', targetType: 'DISCORD_USER',
        targetId: discordUserId, actorId: context.actorId,
        after: { expiresAt: lock.expires_at, reason, redeemedDay: bounds.bangkok_day },
        reason, context });
    }
    return { ...lock, bounds };
  });
}

export async function assertDailyTopupAdmissionInTransaction(client, discordUserId, context, policy = null) {
  const result = await reconcileDailyTopupLockInTransaction(client, {
    discordUserId, policy: policy ?? await loadPaymentPolicy(client),
  }, context);
  if (result.locked) {
    throw new QuestshopError('TOPUP_DAILY_LIMIT', 'เติมเงินครบเพดานของวันนี้แล้ว กรุณาลองใหม่หลังเที่ยงคืน');
  }
  return result;
}

export async function reconcileCurrentDailyTopupLocks(context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const policy = await loadPaymentPolicy(client);
    const users = (await client.query(`SELECT DISTINCT discord_user_id FROM (
      SELECT discord_user_id FROM topups WHERE redeemed_at IS NOT NULL
        AND redeemed_at >= date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok'
        AND redeemed_at < (date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Bangkok') + interval '1 day') AT TIME ZONE 'Asia/Bangkok'
      UNION SELECT discord_user_id FROM topup_daily_locks WHERE expires_at>clock_timestamp()
    ) users ORDER BY discord_user_id`)).rows;
    const results = [];
    for (const row of users) results.push(await reconcileDailyTopupLockInTransaction(client,
      { discordUserId: row.discord_user_id, policy }, context));
    return results;
  });
}
