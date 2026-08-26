import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import {
  acquirePaymentJob, createPaymentAttempt, escalateStuckRedeemedTopups, recordProviderResult,
  topupAmountNeedsReview,
} from '../../src/domain/payments/service.js';
import {
  paymentPolicyFromConfigValues,
  reconcileDailyTopupLock, topupAmountExceedsAutoCreditMaximum,
} from '../../src/domain/payments/policy.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

async function createReceiver(traceId) {
  const active = (await pool.query("SELECT id FROM receiver_versions WHERE state='ACTIVE' LIMIT 1")).rows[0];
  if (active) return active.id;
  const receiver = uuidv7();
  const version = Number((await pool.query('SELECT COALESCE(max(version),0)+1 AS version FROM receiver_versions')).rows[0].version);
  await pool.query(`INSERT INTO receiver_versions(id,version,encrypted_phone,encryption_key_version,
    nonce,auth_tag,phone_last4,state,actor_id,trace_id) VALUES($1,$2,$3,1,$4,$5,'1234','ACTIVE','owner',$6)`,
  [receiver, version, Buffer.alloc(10), Buffer.alloc(12), Buffer.alloc(16), traceId]);
  return receiver;
}

function context(traceId, key = 'payment-hardening') {
  return createContext({ traceId, actorType: 'SYSTEM', actorId: 'payment-hardening-test',
    guildId: '10000000000000002', idempotencyKey: key });
}

test('redeemed vouchers below the minimum require review, while over-limit vouchers credit in full', () => {
  assert.equal(topupAmountNeedsReview(null), true);
  assert.equal(topupAmountNeedsReview(999n), true);
  assert.equal(topupAmountNeedsReview(1_000n), false);
  assert.equal(topupAmountNeedsReview(100_000n), false);
  assert.equal(topupAmountNeedsReview(100_001n), false);
  assert.equal(topupAmountExceedsAutoCreditMaximum(100_000n), false);
  assert.equal(topupAmountExceedsAutoCreditMaximum(100_001n), true);
});

test('payment limits are configurable and upper/daily caps can be disabled', () => {
  const policy = paymentPolicyFromConfigValues({
    topupAutoCreditMinCents: '2500',
    topupAutoCreditMaxCents: null,
    topupDailyLimitCents: null,
  });
  assert.equal(policy.autoCreditMinCents, 2_500n);
  assert.equal(policy.autoCreditMaxCents, null);
  assert.equal(policy.dailyRedeemedLimitCents, null);
  assert.equal(topupAmountNeedsReview(2_499n, policy), true);
  assert.equal(topupAmountNeedsReview(5_000_000n, policy), false);
});

test('daily top-up limit follows successful redeemed_at even while the top-up is in manual review', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7();
  const receiver = await createReceiver(trace);
  const currentUser = `redeemed-day-current-${trace}`;
  const oldUser = `redeemed-day-old-${trace}`;
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,provider_transaction_id,amount_cents,currency,trace_id,redeemed_at)
    VALUES($1,$2,'MANUAL_REVIEW',1,$3,$4,'1234',$5,300000,'THB',$6,clock_timestamp()),
      ($7,$8,'MANUAL_REVIEW',1,$9,$4,'1234',$10,300000,'THB',$6,clock_timestamp()-interval '1 day')`, [
    uuidv7(), currentUser, Buffer.alloc(32, 93), receiver, `current-${trace}`, trace,
    uuidv7(), oldUser, Buffer.alloc(32, 94), `old-${trace}`,
  ]);
  const current = await reconcileDailyTopupLock({ discordUserId: currentUser },
    context(trace, 'current-redeemed-day'), { pool });
  const old = await reconcileDailyTopupLock({ discordUserId: oldUser },
    context(trace, 'old-redeemed-day'), { pool });
  assert.equal(current.locked, true);
  assert.equal(current.totalCents, 300_000n);
  assert.equal(old.locked, false);
  assert.equal(old.totalCents, 0n);
});

test('daily top-up lock blocks a voucher that was queued before the lock existed', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7();
  const receiver = await createReceiver(trace);
  const topup = uuidv7();
  const holder = uuidv7();
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,trace_id,created_at)
    VALUES($1,'prequeued-lock-user','PAYMENT_QUEUED',1,$2,$3,'1234',$4,clock_timestamp()-interval '1 hour')`,
  [topup, Buffer.alloc(32, 90), receiver, trace]);
  await pool.query(`INSERT INTO topup_daily_locks(discord_user_id,expires_at,trace_id)
    VALUES('prequeued-lock-user',clock_timestamp()+interval '1 hour',$1)`, [trace]);

  await acquirePaymentJob({ holder }, { pool });
  const target = (await pool.query('SELECT status,attempt_count FROM topups WHERE id=$1', [topup])).rows[0];
  assert.equal(target.status, 'PAYMENT_QUEUED');
  assert.equal(target.attempt_count, 0);
});

test('stuck redeemed top-up is escalated to an Owner-only manual review', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7();
  const receiver = await createReceiver(trace);
  const topup = uuidv7();
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,provider_transaction_id,amount_cents,currency,trace_id,redeemed_at)
    VALUES($1,'stuck-redeemed-user','REDEEMED',1,$2,$3,'1234',$4,2500,'THB',$5,
      clock_timestamp()-interval '10 minutes')`,
  [topup, Buffer.alloc(32, 91), receiver, `stuck-${topup}`, trace]);

  const results = await escalateStuckRedeemedTopups({ olderThanSeconds: 120, limit: 20 },
    context(trace, 'escalate-stuck'), { pool });
  assert.equal(results.some((entry) => entry.topup.id === topup), true);
  assert.equal((await pool.query('SELECT status FROM topups WHERE id=$1', [topup])).rows[0].status, 'MANUAL_REVIEW');
  const review = (await pool.query(`SELECT state,financial,owner_only,opened_reason FROM manual_reviews
    WHERE subject_type='TOPUP' AND subject_id=$1`, [topup])).rows[0];
  assert.equal(review.state, 'OPEN');
  assert.equal(review.financial, true);
  assert.equal(review.owner_only, true);
  assert.equal(review.opened_reason, 'REDEEMED_SETTLEMENT_STUCK');
});

test('payment attempts retain retry ancestry and normalized error metadata', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7();
  const receiver = await createReceiver(trace);
  const topupId = uuidv7();
  const firstHolder = uuidv7();
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,trace_id)
    VALUES($1,'attempt-forensics-user','PAYMENT_QUEUED',1,$2,$3,'1234',$4)`,
  [topupId, Buffer.alloc(32, 92), receiver, trace]);
  const firstTopup = await acquirePaymentJob({ holder: firstHolder }, { pool });
  assert.equal(firstTopup.id, topupId);
  const firstAttempt = await createPaymentAttempt({ topup: firstTopup }, context(trace, 'attempt-1'), { pool });
  await recordProviderResult({ topup: firstTopup, attemptId: firstAttempt.id,
    result: { outcome: 'RETRY_WAIT', providerCode: 'PROVIDER_NOT_SENT' } },
  context(trace, 'attempt-1-result'), { pool });
  const firstSaved = (await pool.query(`SELECT parent_attempt_id,error_class,error_code FROM payment_attempts WHERE id=$1`,
    [firstAttempt.id])).rows[0];
  assert.equal(firstSaved.parent_attempt_id, null);
  assert.equal(firstSaved.error_class, 'RETRYABLE_PROVIDER');
  assert.equal(firstSaved.error_code, 'PROVIDER_NOT_SENT');

  await pool.query(`UPDATE topups SET status='PAYMENT_QUEUED',available_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=$1`, [topupId]);
  const secondTopup = await acquirePaymentJob({ holder: uuidv7() }, { pool });
  assert.equal(secondTopup.id, topupId);
  const secondAttempt = await createPaymentAttempt({ topup: secondTopup }, context(trace, 'attempt-2'), { pool });
  assert.equal(secondAttempt.parent_attempt_id, firstAttempt.id);
});

test('verified SUCCESS without a provider transaction ID becomes redeemable exactly once', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7(); const receiver = await createReceiver(trace); const topupId = uuidv7();
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,trace_id)
    VALUES($1,'missing-provider-id-user','PAYMENT_QUEUED',1,$2,$3,'1234',$4)`,
  [topupId, Buffer.alloc(32, 95), receiver, trace]);
  const topup = await acquirePaymentJob({ holder: uuidv7() }, { pool });
  const attempt = await createPaymentAttempt({ topup }, context(trace, 'missing-provider-id-attempt'), { pool });
  const updated = await recordProviderResult({ topup, attemptId: attempt.id, result: {
    outcome: 'REDEEMED', providerCode: 'SUCCESS', httpStatus: 200, amountCents: 1_000n, currency: 'THB',
    receiverConfirmation: 'REQUEST_BOUND_SUCCESS', providerTransactionId: null,
    providerEvidence: { receiverConfirmation: 'REQUEST_BOUND_SUCCESS', settlementIdentity: 'VOUCHER_HMAC',
      providerTransactionIdPresent: false, bodyLength: 100, bodySha256: 'a'.repeat(64), topLevelKeys: ['status', 'data'] },
  } }, context(trace, 'missing-provider-id-result'), { pool });
  assert.equal(updated.status, 'REDEEMED');
  const saved = (await pool.query(`SELECT provider_transaction_id,amount_cents,currency FROM topups WHERE id=$1`, [topupId])).rows[0];
  assert.deepEqual(saved, { provider_transaction_id: null, amount_cents: '1000', currency: 'THB' });
  const evidence = (await pool.query('SELECT dispatch_state,provider_evidence FROM payment_attempts WHERE id=$1', [attempt.id])).rows[0];
  assert.equal(evidence.dispatch_state, 'VERIFIED');
  assert.equal(evidence.provider_evidence.settlementIdentity, 'VOUCHER_HMAC');
  assert.equal(evidence.provider_evidence.providerTransactionIdPresent, false);
});
