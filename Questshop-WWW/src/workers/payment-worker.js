import { setTimeout as delay } from 'node:timers/promises';
import { decryptSecret } from '../adapters/crypto/keyring.js';
import { redeemVoucher } from '../adapters/truemoney/voucher.js';
import { createContext } from '../shared/correlation.js';
import {
  acquirePaymentJob, createPaymentAttempt, markPaymentPossiblySent, moveRedeemedTopupToReview,
  recordProviderResult, renewPaymentLease,
} from '../domain/payments/service.js';
import {
  loadPaymentPolicy, reconcileCurrentDailyTopupLocks, reconcileDailyTopupLock,
  lockTopupIntakeUntilBangkokDayEnds, topupAmountExceedsAutoCreditMaximum, topupAmountNeedsReview,
} from '../domain/payments/policy.js';
import { creditRedeemedTopup } from '../domain/wallet/service.js';
import { reconcileIncident } from '../domain/incidents/service.js';
import { getRuntimePool } from '../db/pools.js';

let nextSettlementAuditAt = 0;
let nextDailyLockReconcileAt = 0;

async function auditPaymentSettlement({ holder, env, pool }) {
  if (Date.now() < nextSettlementAuditAt) return;
  nextSettlementAuditAt = Date.now() + 60_000;
  const snapshot = (await pool.query(`SELECT
    count(*) FILTER (WHERE status='REDEEMED' AND redeemed_at<clock_timestamp()-interval '2 minutes')::integer AS redeemed_stuck,
    count(*) FILTER (WHERE status IN ('PAYMENT_QUEUED','RETRY_WAIT')
      AND updated_at<clock_timestamp()-interval '5 minutes')::integer AS queue_stuck
    FROM topups`)).rows[0];
  const context = createContext({ actorType: 'SYSTEM', actorId: holder, guildId: env.DISCORD_GUILD_ID,
    idempotencyKey: `payment-settlement-audit:${Math.floor(Date.now() / 60_000)}` });
  await reconcileIncident({ code: 'TOPUP_REDEEMED_STUCK', scope: 'TRUEMONEY',
    active: snapshot.redeemed_stuck > 0, severity: 'CRITICAL', evidence: { count: snapshot.redeemed_stuck } },
  context, { pool });
  await reconcileIncident({ code: 'PAYMENT_QUEUE_STUCK', scope: 'TRUEMONEY',
    active: snapshot.queue_stuck > 0, severity: 'ERROR', evidence: { count: snapshot.queue_stuck } },
  context, { pool });
}

async function reconcilePaymentPolicyState({ holder, env, pool }) {
  if (Date.now() < nextDailyLockReconcileAt) return;
  nextDailyLockReconcileAt = Date.now() + 60_000;
  const context = createContext({ actorType: 'SYSTEM', actorId: holder, guildId: env.DISCORD_GUILD_ID,
    idempotencyKey: `payment-policy-reconcile:${Math.floor(Date.now() / 60_000)}` });
  await reconcileCurrentDailyTopupLocks(context, { pool });
}

async function creditPendingRedemption({ holder, env, pool, policy }) {
  const topup = (await pool.query(`SELECT * FROM topups WHERE status = 'REDEEMED'
    ORDER BY redeemed_at LIMIT 1`)).rows[0];
  if (!topup) return false;
  const context = createContext({ traceId: topup.trace_id, actorType: 'SYSTEM', actorId: holder,
    guildId: env.DISCORD_GUILD_ID, idempotencyKey: `credit-recovery:${topup.id}` });
  await reconcileDailyTopupLock({ discordUserId: topup.discord_user_id,
    redeemedAt: topup.redeemed_at, policy }, context, { pool });
  await lockOverLimitTopupIntake({ topup, policy, context, pool });
  if (topupAmountNeedsReview(topup.amount_cents, policy)) {
    await moveRedeemedTopupToReview({ topupId: topup.id, reason: 'AMOUNT_OUTSIDE_AUTOCREDIT_RANGE' },
      context, { pool });
    return true;
  }
  try {
    await creditRedeemedTopup({ topupId: topup.id }, context, { pool });
    await recordOverLimitTopupWarning({ topup, policy, context, pool });
  } catch (error) {
    await reconcileIncident({ code: 'TOPUP_REDEEMED_STUCK', scope: 'TRUEMONEY', active: true,
      severity: 'CRITICAL', evidence: { topupId: topup.id, errorCode: error.code ?? error.name } }, context, { pool });
    throw error;
  }
  return true;
}

async function recordOverLimitTopupWarning({ topup, policy, context, pool }) {
  if (!topupAmountExceedsAutoCreditMaximum(topup.amount_cents, policy)) return;
  await reconcileIncident({ code: 'TOPUP_AMOUNT_OVER_AUTOCREDIT_LIMIT', scope: 'TRUEMONEY', active: true,
    severity: 'WARNING', evidence: {
      topupId: topup.id,
      discordUserId: topup.discord_user_id,
      amountCents: String(topup.amount_cents),
      configuredMaximumCents: String(policy.autoCreditMaxCents),
      creditedInFull: true,
    } }, context, { pool });
}

async function lockOverLimitTopupIntake({ topup, policy, context, pool }) {
  if (!topupAmountExceedsAutoCreditMaximum(topup.amount_cents, policy)) return;
  await lockTopupIntakeUntilBangkokDayEnds({
    discordUserId: topup.discord_user_id,
    redeemedAt: topup.redeemed_at,
    reason: 'TOPUP_AMOUNT_OVER_AUTOCREDIT_LIMIT',
  }, context, { pool });
}

async function stopTopupIntakeWhenSettlementDisabled(pool) {
  await pool.query(`UPDATE feature_gates SET enabled=false,reason='AUTO_CREDIT_DISABLED',
    version=version+1,actor_type='SYSTEM',actor_id='payment-worker',updated_at=clock_timestamp()
    WHERE gate='TOPUP_ACCEPTING' AND enabled=true`);
}

function startLeaseHeartbeat(topup, pool, parentSignal) {
  const leaseAbort = new AbortController();
  const signal = AbortSignal.any([parentSignal, leaseAbort.signal]);
  const done = (async () => {
    while (!signal.aborted) {
      await delay(10_000, undefined, { signal, ref: false });
      if (!signal.aborted) await renewPaymentLease(topup, 30, { pool });
    }
  })().catch((error) => { leaseAbort.abort(error); });
  return { signal, stop: async () => { leaseAbort.abort('payment finished'); await done; } };
}

async function decryptPaymentSecrets(pool, topup, env) {
  const [payloadResult, receiverResult] = await Promise.all([
    pool.query('SELECT * FROM topup_sensitive_payloads WHERE topup_id = $1', [topup.id]),
    pool.query('SELECT * FROM receiver_versions WHERE id = $1', [topup.receiver_version_id]),
  ]);
  const payload = payloadResult.rows[0];
  const receiver = receiverResult.rows[0];
  if (!payload || !receiver) throw new Error('Payment credentials are unavailable');
  const sensitive = JSON.parse(decryptSecret({ keyVersion: payload.key_version,
    nonce: payload.nonce, ciphertext: payload.ciphertext, authTag: payload.auth_tag },
  env.DATA_ENCRYPTION_KEYS_JSON, `topup:${topup.id}:${env.DISCORD_GUILD_ID}`));
  const phone = decryptSecret({ keyVersion: receiver.encryption_key_version, nonce: receiver.nonce,
    ciphertext: receiver.encrypted_phone, authTag: receiver.auth_tag }, env.DATA_ENCRYPTION_KEYS_JSON,
  `receiver:${receiver.id}:${env.DISCORD_GUILD_ID}`);
  return { code: sensitive.code, phone };
}

function normalizeProviderResult(result, topup) {
  if (result.outcome === 'REDEEMED' && !result.providerTransactionId) {
    return { ...result, outcome: 'AMBIGUOUS', providerCode: 'PROVIDER_TRANSACTION_ID_MISSING' };
  }
  if (result.outcome === 'RETRY_WAIT' && topup.attempt_count >= 3) return { ...result, outcome: 'FAILED' };
  return result;
}

async function closeSuccessfulProbe(pool, breaker, context) {
  if (breaker?.state !== 'HALF_OPEN') return;
  const closed = await pool.query(`UPDATE circuit_breakers SET state='CLOSED',reason='PROBE_SCHEMA_VALID',
    failure_count=0,next_probe_at=NULL,state_version=state_version+1,trace_id=$2,
    updated_at=clock_timestamp() WHERE breaker_key=$1 AND state='HALF_OPEN' RETURNING breaker_key`,
  ['TRUEMONEY_DIRECT', context.traceId]);
  if (!closed.rowCount) return;
  await pool.query(`UPDATE feature_gates SET enabled=true,reason='TRUEMONEY_SCHEMA_PROBE_RECOVERED',
    version=version+1,actor_type='SYSTEM',actor_id='payment-worker',trace_id=$1,
    updated_at=clock_timestamp() WHERE gate IN ('AUTO_CREDIT_ENABLED','TOPUP_ACCEPTING')
      AND enabled=false AND reason='TRUEMONEY_SCHEMA_CIRCUIT_OPEN'`, [context.traceId]);
  await reconcileIncident({ code: 'PROVIDER_SCHEMA_CHANGED', scope: 'TRUEMONEY_DIRECT', active: false,
    severity: 'CRITICAL', evidence: { recoveredBy: 'HALF_OPEN_PROBE' } }, context, { pool });
}

async function openCircuit(pool, error, context, breaker) {
  const schemaFailure = error.category === 'PROVIDER_SCHEMA';
  const failedProbe = breaker?.state === 'HALF_OPEN';
  if (!schemaFailure && !failedProbe) return;
  await pool.query(`UPDATE circuit_breakers SET state='OPEN',reason=$2,
    failure_count=failure_count+1,opened_at=clock_timestamp(),
    next_probe_at=clock_timestamp()+interval '15 minutes',state_version=state_version+1,
    trace_id=$3,updated_at=clock_timestamp() WHERE breaker_key=$1${failedProbe ? " AND state='HALF_OPEN'" : ''}`,
  ['TRUEMONEY_DIRECT', error.code ?? error.name, context.traceId]);
  if (!schemaFailure) return;
  await pool.query(`UPDATE feature_gates SET enabled=false,reason='TRUEMONEY_SCHEMA_CIRCUIT_OPEN',
    version=version+CASE WHEN enabled THEN 1 ELSE 0 END,actor_type='SYSTEM',actor_id='payment-worker',trace_id=$1,
    updated_at=clock_timestamp() WHERE gate IN ('AUTO_CREDIT_ENABLED','TOPUP_ACCEPTING')`, [context.traceId]);
  await reconcileIncident({ code: 'PROVIDER_SCHEMA_CHANGED', scope: 'TRUEMONEY_DIRECT', active: true,
    severity: 'CRITICAL', evidence: { errorCode: error.code ?? error.name } }, context, { pool });
}

function failureResult(error, topup) {
  const ambiguous = error.category === 'AMBIGUOUS' || error.category === 'PROVIDER_SCHEMA'
    || error.code === 'PROVIDER_RESULT_AMBIGUOUS';
  if (ambiguous) return { outcome: 'AMBIGUOUS', providerCode: error.code ?? error.name };
  return { outcome: error.retryable && topup.attempt_count < 3 ? 'RETRY_WAIT' : 'FAILED',
    providerCode: error.code ?? error.name };
}

async function recordProviderFailure({ topup, attempt, error, context, breaker, pool }) {
  const updated = await recordProviderResult({ topup, attemptId: attempt.id, result: failureResult(error, topup) },
    context, { pool });
  await openCircuit(pool, error, context, breaker);
  return updated;
}

async function recordProviderSuccess({ topup, attempt, result, context, policy, pool }) {
  try {
    return await recordProviderResult({ topup, attemptId: attempt.id, result, policy }, context, { pool });
  } catch (error) {
    if (error?.code !== '23505' || result.outcome !== 'REDEEMED') throw error;
    return recordProviderResult({
      topup,
      attemptId: attempt.id,
      policy,
      result: {
        outcome: 'AMBIGUOUS',
        providerCode: 'PROVIDER_TRANSACTION_ID_CONFLICT',
        httpStatus: result.httpStatus ?? null,
        amountCents: result.amountCents ?? null,
        currency: result.currency ?? null,
        senderName: result.senderName ?? null,
        senderPhone: result.senderPhone ?? null,
        receiverConfirmation: result.receiverConfirmation ?? null,
        providerTransactionId: null,
      },
    }, context, { pool });
  }
}

async function processClaimedPayment({ topup, breaker, holder, env, signal, autoCredit, policy, pool }) {
  const context = createContext({ traceId: topup.trace_id, actorType: 'SYSTEM', actorId: holder,
    guildId: env.DISCORD_GUILD_ID, idempotencyKey: `payment:${topup.id}:${topup.attempt_count}` });
  const attempt = await createPaymentAttempt({ topup }, context, { pool });
  const heartbeat = startLeaseHeartbeat(topup, pool, signal);
  const recoveryProbe = breaker?.state === 'HALF_OPEN';
  try {
    let result;
    try {
      const { code, phone } = await decryptPaymentSecrets(pool, topup, env);
      result = normalizeProviderResult(await redeemVoucher({ code, receiverPhone: phone, signal: heartbeat.signal,
        onPossiblySent: () => markPaymentPossiblySent({ attemptId: attempt.id }, { pool }) }), topup);
    } catch (error) {
      await recordProviderFailure({ topup, attempt, error, context, breaker, pool });
      return;
    }

    const updated = await recordProviderSuccess({ topup, attempt, result, context, policy, pool });
    if (updated.status === 'REDEEMED') {
      await reconcileDailyTopupLock({ discordUserId: updated.discord_user_id,
        redeemedAt: updated.redeemed_at, policy }, context, { pool });
      await lockOverLimitTopupIntake({ topup: updated, policy, context, pool });
    }
    if (updated.status === 'REDEEMED' && topupAmountNeedsReview(updated.amount_cents, policy)) {
      await moveRedeemedTopupToReview({ topupId: topup.id, reason: 'AMOUNT_OUTSIDE_AUTOCREDIT_RANGE' },
        context, { pool });
    } else if (updated.status === 'REDEEMED' && (autoCredit || recoveryProbe)) {
      await creditRedeemedTopup({ topupId: topup.id }, context, { pool });
      await recordOverLimitTopupWarning({ topup: updated, policy, context, pool });
    }
    await closeSuccessfulProbe(pool, breaker, context);
  } finally {
    await heartbeat.stop();
  }
}

export async function processPayment({ holder, env, signal, autoCredit = false, pool = getRuntimePool() }) {
  await auditPaymentSettlement({ holder, env, pool });
  await reconcilePaymentPolicyState({ holder, env, pool });
  const policy = await loadPaymentPolicy(pool);
  if (autoCredit && await creditPendingRedemption({ holder, env, pool, policy })) return true;
  const breaker = (await pool.query("SELECT state FROM circuit_breakers WHERE breaker_key='TRUEMONEY_DIRECT'")).rows[0];
  if (breaker?.state === 'OPEN') return false;
  if (!autoCredit && breaker?.state !== 'HALF_OPEN') {
    await stopTopupIntakeWhenSettlementDisabled(pool);
    return false;
  }
  const topup = await acquirePaymentJob({ holder }, { pool });
  if (!topup) return false;
  await processClaimedPayment({ topup, breaker, holder, env, signal, autoCredit, policy, pool });
  return true;
}
