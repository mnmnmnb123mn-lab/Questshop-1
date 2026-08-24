import { v7 as uuidv7 } from 'uuid';
import { setTimeout as delay } from 'node:timers/promises';
import { isRetryableTransactionError, withTransaction } from '../../db/transaction.js';
import { allVoucherHmacs, encryptSecret } from '../../adapters/crypto/keyring.js';
import { normalizeVoucherUrl } from '../../adapters/truemoney/voucher.js';
import { AuthorizationError, QuestshopError, FencingLostError } from '../../shared/errors.js';
import { recordTransition } from '../shared/transition.js';
import { openReview } from '../reviews/service.js';
import { TOPUP_TRANSITIONS } from './states.js';
import { enqueueProjection } from '../outbox/service.js';
import {
  assertDailyTopupAdmissionInTransaction,
  DEFAULT_PAYMENT_POLICY,
  loadPaymentPolicy,
  topupAmountNeedsReview as paymentPolicyNeedsReview,
} from './policy.js';

const ACTIVE_TOPUP_STATES = ['RECEIVED', 'VALIDATING', 'PAYMENT_QUEUED', 'PROCESSING', 'RETRY_WAIT'];
export const AUTO_CREDIT_MIN_CENTS = DEFAULT_PAYMENT_POLICY.autoCreditMinCents;
export const AUTO_CREDIT_MAX_CENTS = DEFAULT_PAYMENT_POLICY.autoCreditMaxCents;

export function topupAmountNeedsReview(amountCents, policy = DEFAULT_PAYMENT_POLICY) {
  return paymentPolicyNeedsReview(amountCents, policy);
}

async function findVoucher(client, hashes) {
  for (const candidate of hashes) {
    const row = (await client.query(`
      SELECT * FROM topups WHERE voucher_hmac_version = $1 AND voucher_hmac = $2
    `, [candidate.version, candidate.digest])).rows[0];
    if (row) return row;
  }
  return null;
}

function assertVoucherOwner(existing, discordUserId) {
  if (existing.discord_user_id !== discordUserId) {
    throw new AuthorizationError('ซองนี้ถูกส่งเข้าระบบแล้ว');
  }
  return existing;
}

async function findCommittedVoucher(pool, hashes) {
  // PostgreSQL may report a serialization failure while the concurrent owner
  // is still committing. This is a read-only bounded reconciliation; it
  // never attempts to redeem or recreate a voucher.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const existing = await withTransaction({ pool, isolation: 'READ COMMITTED', maxAttempts: 1 }, (client) => (
      findVoucher(client, hashes)
    ));
    if (existing) return existing;
    if (attempt < 7) await delay(50 * (attempt + 1));
  }
  return null;
}

function paymentAttemptState(outcome) {
  if (outcome === 'REDEEMED') return 'VERIFIED';
  if (outcome === 'AMBIGUOUS') return 'AMBIGUOUS';
  return 'FAILED';
}

function paymentAttemptError(outcome, providerCode) {
  if (outcome === 'REDEEMED') return { errorClass: null, errorCode: null };
  if (outcome === 'AMBIGUOUS') return { errorClass: 'AMBIGUOUS', errorCode: providerCode ?? outcome };
  if (outcome === 'RETRY_WAIT') return { errorClass: 'RETRYABLE_PROVIDER', errorCode: providerCode ?? outcome };
  return { errorClass: 'PROVIDER_RESULT', errorCode: providerCode ?? outcome };
}

function amountWarningCode(amountCents, policy) {
  if (amountCents == null) return null;
  const amount = BigInt(amountCents);
  if (amount < policy.autoCreditMinCents) return 'AMOUNT_BELOW_CONFIGURED_LIMIT';
  if (policy.autoCreditMaxCents != null && amount > policy.autoCreditMaxCents) {
    return 'AMOUNT_OVER_CONFIGURED_LIMIT';
  }
  return null;
}

async function assertTopupSettlementAvailable(client) {
  const rows = (await client.query(`SELECT gate,enabled FROM feature_gates
    WHERE gate IN ('TOPUP_ACCEPTING','AUTO_CREDIT_ENABLED')`)).rows;
  const gates = new Map(rows.map((row) => [row.gate, row.enabled === true]));
  if (!gates.get('TOPUP_ACCEPTING') || !gates.get('AUTO_CREDIT_ENABLED')) {
    throw new QuestshopError('TOPUP_CLOSED', 'ระบบเติมเงินปิดชั่วคราว กรุณาลองใหม่ภายหลัง');
  }
}

async function assertNoPendingTopup(client, discordUserId) {
  const pending = Number((await client.query(`SELECT count(*)::integer AS count FROM topups
    WHERE discord_user_id=$1 AND status = ANY($2::text[])`, [discordUserId, ACTIVE_TOPUP_STATES])).rows[0].count);
  if (pending > 0) {
    throw new QuestshopError('RATE_LIMITED', 'มีรายการเติมเงินกำลังตรวจสอบอยู่ กรุณารอรายการเดิมให้เสร็จก่อน');
  }
}

export async function submitVoucher({ discordUserId, voucherUrl, env }, context, options = {}) {
  const normalized = normalizeVoucherUrl(voucherUrl);
  const hashes = allVoucherHmacs(normalized.code, env.VOUCHER_HMAC_KEYS_JSON);
  try {
    return await withTransaction({ ...options, isolation: 'SERIALIZABLE', maxAttempts: 5, deadlineMs: 10_000 }, async (client) => {
      await assertTopupSettlementAvailable(client);
      const existing = await findVoucher(client, hashes);
      if (existing) return { topup: assertVoucherOwner(existing, discordUserId), idempotent: true };
      await assertDailyTopupAdmissionInTransaction(client, discordUserId, context);
      await assertNoPendingTopup(client, discordUserId);
      const receiver = (await client.query(`
        SELECT * FROM receiver_versions WHERE state = 'ACTIVE' FOR SHARE
      `)).rows[0];
      if (!receiver) throw new QuestshopError('RECEIVER_UNAVAILABLE', 'ยังไม่ได้ตั้งค่าบัญชีรับซอง');
      const promotion = (await client.query(`SELECT * FROM promotions
        WHERE state='ACTIVE' AND (
          manual_controlled=true OR (starts_at<=clock_timestamp() AND ends_at>clock_timestamp())
        ) ORDER BY version DESC LIMIT 1`)).rows[0] ?? null;
      const topupId = uuidv7();
      const encrypted = encryptSecret(
        JSON.stringify({ code: normalized.code, url: normalized.url }),
        env.DATA_ENCRYPTION_KEYS_JSON,
        `topup:${topupId}:${context.guildId}`,
      );
      const currentHash = hashes.find((item) => item.version === env.VOUCHER_HMAC_KEYS_JSON.current);
      await client.query(`INSERT INTO wallets(discord_user_id) VALUES($1)
        ON CONFLICT(discord_user_id) DO NOTHING`, [discordUserId]);
      let topup = (await client.query(`
        INSERT INTO topups(
          id, discord_user_id, status, voucher_hmac_version, voucher_hmac,
          receiver_version_id, receiver_phone_last4, promotion_id, prelaunch, trace_id
        ) VALUES ($1,$2,'RECEIVED',$3,$4,$5,$6,$7,$8,$9) RETURNING *
      `, [
        topupId, discordUserId, currentHash.version, currentHash.digest,
        receiver.id, receiver.phone_last4, promotion?.id ?? null, env.PRELAUNCH, context.traceId,
      ])).rows[0];
      await client.query(`
        INSERT INTO topup_sensitive_payloads(topup_id, key_version, nonce, ciphertext, auth_tag)
        VALUES ($1,$2,$3,$4,$5)
      `, [topupId, encrypted.keyVersion, encrypted.nonce, encrypted.ciphertext, encrypted.authTag]);
      for (const next of ['VALIDATING', 'PAYMENT_QUEUED']) {
        const previous = topup.status;
        const updated = (await client.query(`
          UPDATE topups SET status = $2, state_version = state_version + 1,
            updated_at = transaction_timestamp() WHERE id = $1 AND state_version = $3 RETURNING *
        `, [topupId, next, topup.state_version])).rows[0];
        if (!updated) throw new QuestshopError('TOPUP_STALE', 'Top-up changed concurrently');
        await recordTransition(client, {
          aggregateType: 'TOPUP', aggregateId: topupId, fromState: previous,
          toState: next, stateVersion: updated.state_version, context,
        });
        topup = updated;
      }
      return { topup, idempotent: false };
    });
  } catch (error) {
    if (error.code !== '23505' && !isRetryableTransactionError(error)) throw error;
    const existing = await findCommittedVoucher(options.pool, hashes);
    if (!existing) throw error;
    return { topup: assertVoucherOwner(existing, discordUserId), idempotent: true };
  }
}

export async function acquirePaymentJob({ holder, ttlSeconds = 30 }, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const result = await client.query(`
      WITH candidate AS (
        SELECT t.id FROM topups t
        WHERE t.status = 'PAYMENT_QUEUED' AND t.available_at <= clock_timestamp()
          AND NOT EXISTS (
            SELECT 1 FROM topup_daily_locks l
            WHERE l.discord_user_id=t.discord_user_id AND l.expires_at>clock_timestamp()
          )
        ORDER BY t.created_at FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE topups t SET
        status = 'PROCESSING', state_version = state_version + 1,
        lease_owner = $1, lease_expires_at = clock_timestamp() + make_interval(secs => $2),
        fencing_token = fencing_token + 1, attempt_count = attempt_count + 1,
        updated_at = clock_timestamp()
      FROM candidate WHERE t.id = candidate.id RETURNING t.*
    `, [holder, ttlSeconds]);
    const topup = result.rows[0] ?? null;
    if (topup) {
      await client.query(`INSERT INTO state_transitions(id,aggregate_type,aggregate_id,from_state,to_state,
        state_version,actor_type,actor_id,trace_id,reason_code)
        VALUES($1,'TOPUP',$2,'PAYMENT_QUEUED','PROCESSING',$3,'SYSTEM',$4,$5,'PAYMENT_LEASED')`,
      [uuidv7(), topup.id, topup.state_version, holder, topup.trace_id]);
    }
    return topup;
  });
}

export async function createPaymentAttempt({ topup, parentAttemptId = null }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const parent = parentAttemptId ?? (await client.query(`SELECT id FROM payment_attempts
      WHERE topup_id=$1 ORDER BY attempt_number DESC LIMIT 1`, [topup.id])).rows[0]?.id ?? null;
    return (await client.query(`
      INSERT INTO payment_attempts(
        id, topup_id, attempt_number, parent_attempt_id, dispatch_state, trace_id
      ) VALUES ($1,$2,$3,$4,'INTENT_RECORDED',$5) RETURNING *
    `, [uuidv7(), topup.id, topup.attempt_count, parent, context.traceId])).rows[0];
  });
}

export async function renewPaymentLease(topup, ttlSeconds = 30, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const row = (await client.query(`UPDATE topups SET lease_expires_at=clock_timestamp()+make_interval(secs=>$4),
      updated_at=clock_timestamp() WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3
      AND status='PROCESSING' AND lease_expires_at>clock_timestamp() RETURNING *`,
    [topup.id, topup.lease_owner, topup.fencing_token, ttlSeconds])).rows[0];
    if (!row) throw new FencingLostError(`topup:${topup.id}`);
    return row;
  });
}

export async function markPaymentPossiblySent({ attemptId }, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => (
    (await client.query(`
      UPDATE payment_attempts SET dispatch_state = 'POSSIBLY_SENT',
        possibly_sent_at = clock_timestamp()
      WHERE id = $1 AND dispatch_state = 'INTENT_RECORDED' RETURNING *
    `, [attemptId])).rows[0]
  ));
}

export async function recordProviderResult({ topup, attemptId, result, policy = null }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const locked = (await client.query(`
      SELECT * FROM topups WHERE id = $1 AND lease_owner=$2 AND fencing_token=$3
        AND lease_expires_at>clock_timestamp() FOR UPDATE
    `, [topup.id, topup.lease_owner, topup.fencing_token])).rows[0];
    if (!locked) throw new FencingLostError(`topup:${topup.id}`);
    const next = result.outcome;
    if (!(TOPUP_TRANSITIONS[locked.status] ?? []).includes(next)) {
      throw new QuestshopError('TOPUP_TRANSITION_INVALID', `${locked.status} cannot become ${next}`);
    }
    const attemptError = paymentAttemptError(next, result.providerCode);
    const effectivePolicy = policy ?? await loadPaymentPolicy(client);
    const warningCode = amountWarningCode(result.amountCents, effectivePolicy);
    await client.query(`
      UPDATE payment_attempts SET dispatch_state = $2, provider_status_code = $3,
        provider_http_status = $4, provider_evidence = $5,
        error_class=$6,error_code=$7,completed_at = clock_timestamp() WHERE id = $1
    `, [attemptId, paymentAttemptState(next), result.providerCode ?? null, result.httpStatus ?? null,
      { receiverConfirmation: result.receiverConfirmation ?? null }, attemptError.errorClass, attemptError.errorCode]);
    let updated = (await client.query(`
      UPDATE topups SET status = $2, state_version = state_version + 1,
        provider_transaction_id = $3, amount_cents = $4::bigint, currency = $5,
        sender_name = $6, sender_phone = $7, failure_code = $8,
        warning_code = COALESCE($11, warning_code),
        redeemed_at = CASE WHEN $2 = 'REDEEMED' THEN transaction_timestamp() ELSE redeemed_at END,
        available_at = CASE WHEN $2 = 'RETRY_WAIT' THEN clock_timestamp() + make_interval(
          secs => floor(random() * LEAST(60::double precision,
            10::double precision * power(2::double precision, GREATEST(0, $10 - 1))))::integer
        ) ELSE available_at END,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = transaction_timestamp()
      WHERE id = $1 AND state_version = $9 RETURNING *
    `, [topup.id, next, result.providerTransactionId ?? null, result.amountCents ?? null,
      result.currency ?? null, result.senderName ?? null, result.senderPhone ?? null,
      result.providerCode ?? null, locked.state_version, topup.attempt_count, warningCode])).rows[0];
    if (!updated) throw new QuestshopError('TOPUP_STALE', 'Top-up changed concurrently');
    await recordTransition(client, { aggregateType: 'TOPUP', aggregateId: topup.id,
      fromState: locked.status, toState: next, stateVersion: updated.state_version, context });
    if (['INVALID', 'EXPIRED', 'ALREADY_REDEEMED'].includes(next)) {
      await client.query(`INSERT INTO customer_rate_limit_events(id,discord_user_id,operation,trace_id)
        VALUES($1,$2,'VOUCHER_INVALID',$3)`, [uuidv7(), updated.discord_user_id, context.traceId]);
    }
    if (next === 'AMBIGUOUS') {
      const ambiguous = updated;
      updated = (await client.query(`UPDATE topups SET status = 'MANUAL_REVIEW', state_version = state_version + 1,
        updated_at = transaction_timestamp() WHERE id = $1 AND state_version = $2 RETURNING *`,
      [topup.id, ambiguous.state_version])).rows[0];
      await recordTransition(client, { aggregateType: 'TOPUP', aggregateId: topup.id,
        fromState: 'AMBIGUOUS', toState: 'MANUAL_REVIEW', stateVersion: updated.state_version, context });
      await openReview(client, { subjectType: 'TOPUP', subjectId: topup.id,
        reason: 'AMBIGUOUS_PROVIDER_RESULT', financial: true, ownerOnly: true, context });
    }
    await enqueueProjection(client, { projectionType: 'PAYMENT_LOG', aggregateType: 'TOPUP',
      aggregateId: topup.id, aggregateVersion: updated.state_version, surfaceKey: 'LOG_PAYMENTS', context });
    return updated;
  });
}

async function moveRedeemedTopupToReviewInTransaction(client, { topupId, reason }, context) {
  const locked = (await client.query('SELECT * FROM topups WHERE id=$1 FOR UPDATE', [topupId])).rows[0];
  if (!locked) throw new QuestshopError('TOPUP_NOT_FOUND', 'ไม่พบรายการเติมเงิน');
  if (locked.status === 'MANUAL_REVIEW') {
    const review = await openReview(client, { subjectType: 'TOPUP', subjectId: topupId,
      reason, financial: true, ownerOnly: true, context });
    return { topup: locked, review, idempotent: true };
  }
  if (locked.status !== 'REDEEMED') throw new QuestshopError('STALE_STATE', 'สถานะรายการเติมเงินเปลี่ยนไปแล้ว');
  const updated = (await client.query(`UPDATE topups SET status='MANUAL_REVIEW',
    state_version=state_version+1,failure_code=$2,lease_owner=NULL,lease_expires_at=NULL,
    updated_at=clock_timestamp() WHERE id=$1 AND status='REDEEMED' AND state_version=$3 RETURNING *`,
  [topupId, reason, locked.state_version])).rows[0];
  if (!updated) throw new QuestshopError('STALE_STATE', 'สถานะรายการเติมเงินเปลี่ยนไปแล้ว');
  await recordTransition(client, { aggregateType: 'TOPUP', aggregateId: topupId,
    fromState: 'REDEEMED', toState: 'MANUAL_REVIEW', stateVersion: updated.state_version,
    reasonCode: reason, context });
  const review = await openReview(client, { subjectType: 'TOPUP', subjectId: topupId,
    reason, financial: true, ownerOnly: true, context });
  await enqueueProjection(client, { projectionType: 'PAYMENT_LOG', aggregateType: 'TOPUP',
    aggregateId: topupId, aggregateVersion: updated.state_version, surfaceKey: 'LOG_PAYMENTS', context });
  return { topup: updated, review, idempotent: false };
}

export async function moveRedeemedTopupToReview(input, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, (client) => (
    moveRedeemedTopupToReviewInTransaction(client, input, context)
  ));
}

export async function escalateStuckRedeemedTopups({ olderThanSeconds = 120, limit = 20 } = {}, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const rows = (await client.query(`SELECT id FROM topups WHERE status='REDEEMED'
      AND redeemed_at < clock_timestamp()-make_interval(secs=>$1)
      ORDER BY redeemed_at FOR UPDATE SKIP LOCKED LIMIT $2`, [olderThanSeconds, limit])).rows;
    const escalated = [];
    for (const row of rows) {
      escalated.push(await moveRedeemedTopupToReviewInTransaction(client,
        { topupId: row.id, reason: 'REDEEMED_SETTLEMENT_STUCK' }, context));
    }
    return escalated;
  });
}
