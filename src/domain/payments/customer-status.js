import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { getRuntimePool } from '../../db/pools.js';
import { AuthorizationError, QuestshopError } from '../../shared/errors.js';

const CUSTOMER_SETTLED_STATES = new Set([
  'CREDITED', 'AMBIGUOUS', 'MANUAL_REVIEW', 'INVALID', 'EXPIRED',
  'ALREADY_REDEEMED', 'FAILED', 'REJECTED', 'REVERSED',
]);

export async function loadCustomerTopup({ topupId, discordUserId }, { pool = getRuntimePool() } = {}) {
  const topup = (await pool.query(`SELECT t.*,
      ledger.available_before_cents AS available_before,
      ledger.available_after_cents AS available_after,
      COALESCE(w.available_cents, 0) AS wallet_available_cents
    FROM topups t
    LEFT JOIN wallets w ON w.discord_user_id=t.discord_user_id
    LEFT JOIN LATERAL (
      SELECT x.available_before_cents,x.available_after_cents FROM wallet_transactions x
      WHERE x.reference_type='TOPUP' AND x.reference_id=t.id::text
        AND x.transaction_type='TOPUP_CREDIT'
      ORDER BY x.created_at DESC LIMIT 1
    ) ledger ON true
    WHERE t.id=$1`, [topupId])).rows[0];
  if (!topup) throw new QuestshopError('TOPUP_NOT_FOUND', 'ไม่พบรายการเติมเงิน');
  if (topup.discord_user_id !== discordUserId) throw new AuthorizationError('รายการเติมเงินนี้เป็นของผู้ใช้อื่น');
  return topup;
}

export async function waitForCustomerTopup({ topupId, discordUserId, timeoutMs = 55_000, signal = null },
  options = {}) {
  const started = performance.now();
  let topup = await loadCustomerTopup({ topupId, discordUserId }, options);
  while (!CUSTOMER_SETTLED_STATES.has(topup.status) && performance.now() - started < timeoutMs
    && !signal?.aborted) {
    try {
      await delay(1_000, undefined, signal ? { signal, ref: false } : { ref: false });
    } catch (error) {
      if (error?.name !== 'AbortError') throw error;
      break;
    }
    topup = await loadCustomerTopup({ topupId, discordUserId }, options);
  }
  return topup;
}
