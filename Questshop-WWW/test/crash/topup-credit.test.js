import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { adjustBalance, creditRedeemedTopup, reverseTopup } from '../../src/domain/wallet/service.js';
import { reconcileDailyTopupLock } from '../../src/domain/payments/policy.js';
import { resolveSubjectReview } from '../../src/domain/reviews/service.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

function ownerContext(trace, key) {
  return createContext({ traceId: trace, actorType: 'OWNER', actorId: 'owner',
    guildId: '10000000000000002', idempotencyKey: key });
}

test('crash/replay at REDEEMED to CREDITED credits exactly once', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const receiver = uuidv7(); const topup = uuidv7(); const trace = uuidv7();
  await pool.query(`INSERT INTO receiver_versions(id,version,encrypted_phone,encryption_key_version,
    nonce,auth_tag,phone_last4,state,actor_id,trace_id) VALUES($1,1,$2,1,$3,$4,'1234','ACTIVE','owner',$5)`,
  [receiver, Buffer.alloc(10), Buffer.alloc(12), Buffer.alloc(16), trace]);
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,provider_transaction_id,amount_cents,currency,trace_id,redeemed_at)
    VALUES($1,'credit-user','REDEEMED',1,$2,$3,'1234','provider-1',1000,'THB',$4,clock_timestamp())`,
  [topup, Buffer.alloc(32, 1), receiver, trace]);
  const makeContext = (key) => createContext({ traceId: trace, actorType: 'SYSTEM', actorId: 'payment-worker',
    guildId: '10000000000000002', idempotencyKey: key });
  const results = await Promise.all([
    creditRedeemedTopup({ topupId: topup }, makeContext('credit-a'), { pool }),
    creditRedeemedTopup({ topupId: topup }, makeContext('credit-b'), { pool }),
  ]);
  assert.equal(results.filter((result) => result.topup.status === 'CREDITED').length, 2);
  const wallet = (await pool.query("SELECT * FROM wallets WHERE discord_user_id='credit-user'")).rows[0];
  assert.equal(BigInt(wallet.available_cents), 1000n);
  const ledger = (await pool.query(`SELECT count(*)::integer AS count FROM wallet_transactions
    WHERE reference_type='TOPUP' AND reference_id=$1 AND transaction_type='TOPUP_CREDIT'`, [topup])).rows[0];
  assert.equal(ledger.count, 1);
});

test('owner manual review requires a distinct matching confirmation and an insufficient reversal can later finish', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const topup = uuidv7(); const review = uuidv7(); const trace = uuidv7();
  const receiver = (await pool.query("SELECT id FROM receiver_versions WHERE state='ACTIVE'")).rows[0].id;
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,trace_id) VALUES($1,'review-user','MANUAL_REVIEW',1,$2,$3,'5678',$4)`,
  [topup, Buffer.alloc(32, 2), receiver, trace]);
  await pool.query(`INSERT INTO manual_reviews(id,subject_type,subject_id,state,financial,owner_only,
    opened_reason,trace_id) VALUES($1,'TOPUP',$2,'OPEN',true,true,'AMBIGUOUS',$3)`,
  [review, topup, trace]);
  const input = { reviewId: review, decision: 'CREDIT',
    reason: 'verified in TrueMoney application', isOwner: true, amountCents: 1_250n,
    providerTransactionId: 'provider-manual-1' };
  const prepared = await resolveSubjectReview(input, ownerContext(trace, 'manual-credit-prepare'), { pool });
  assert.equal(prepared.applied.confirmationRequired, true);
  const replayedPrepare = await resolveSubjectReview(input, ownerContext(trace, 'manual-credit-prepare'), { pool });
  assert.equal(replayedPrepare.applied.confirmationRequired, true);
  assert.equal((await pool.query('SELECT status FROM topups WHERE id=$1', [topup])).rows[0].status, 'MANUAL_REVIEW');
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM review_evidence
    WHERE review_id=$1 AND evidence_type='CREDIT_CONFIRMATION_PREPARED'`, [review])).rows[0].count), 1);

  const result = await resolveSubjectReview(input, ownerContext(trace, 'manual-credit-confirm'), { pool });
  assert.equal(result.review.state, 'RESOLVED');
  assert.equal(result.applied.status, 'CREDITED');
  const wallet = (await pool.query("SELECT * FROM wallets WHERE discord_user_id='review-user'")).rows[0];
  assert.equal(BigInt(wallet.available_cents), 1_250n);
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM review_decisions WHERE review_id=$1',
    [review])).rows[0].count), 1);
  assert.deepEqual((await pool.query(`SELECT from_state,to_state FROM state_transitions
    WHERE aggregate_type='MANUAL_REVIEW' AND aggregate_id=$1 ORDER BY created_at`, [review])).rows, [
    { from_state: 'OPEN', to_state: 'ASSIGNED' },
    { from_state: 'ASSIGNED', to_state: 'EVIDENCE_PENDING' },
    { from_state: 'EVIDENCE_PENDING', to_state: 'DECISION_READY' },
    { from_state: 'DECISION_READY', to_state: 'RESOLVED' },
  ]);
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM review_evidence
    WHERE review_id=$1 AND evidence_type='DECISION_INPUT'`, [review])).rows[0].count), 1);
  assert.ok(Number((await pool.query(`SELECT count(*) AS count FROM admin_audit_logs
    WHERE target_type='TOPUP' AND target_id=$1`, [topup])).rows[0].count) >= 2);

  await adjustBalance({ discordUserId: 'review-user', amountCents: -1_000n,
    reason: 'spent before reversal' }, ownerContext(trace, 'spend-before-reversal'), { pool });
  const reversal = await reverseTopup({ topupId: topup, reason: 'provider reversal requested' },
    ownerContext(trace, 'reversal-review'), { pool });
  assert.equal(reversal.pendingReview, true);
  assert.equal((await pool.query('SELECT status FROM topups WHERE id=$1', [topup])).rows[0].status, 'CREDITED');
  assert.equal(reversal.review.owner_only, true);

  await adjustBalance({ discordUserId: 'review-user', amountCents: 1_000n,
    reason: 'restore balance for approved reversal' }, ownerContext(trace, 'restore-before-reversal'), { pool });
  const reversalInput = { reviewId: reversal.review.id, decision: 'CREDIT',
    reason: 'confirmed provider reversal', isOwner: true, amountCents: 1_250n,
    providerTransactionId: 'provider-manual-1' };
  const reversalPrepared = await resolveSubjectReview(reversalInput,
    ownerContext(trace, 'reversal-confirm-prepare'), { pool });
  assert.equal(reversalPrepared.applied.confirmationRequired, true);
  const reversed = await resolveSubjectReview(reversalInput,
    ownerContext(trace, 'reversal-confirm-execute'), { pool });
  assert.equal(reversed.applied.status, 'REVERSED');
  assert.equal((await pool.query('SELECT status FROM topups WHERE id=$1', [topup])).rows[0].status, 'REVERSED');
  assert.equal(BigInt((await pool.query("SELECT available_cents FROM wallets WHERE discord_user_id='review-user'")).rows[0].available_cents), 0n);
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM wallet_transactions
    WHERE reference_type='TOPUP' AND reference_id=$1 AND transaction_type='TOPUP_REVERSAL'`, [topup])).rows[0].count), 1);
});

test('owner manual review maps duplicate provider transaction id to a safe business error', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const receiver = (await pool.query("SELECT id FROM receiver_versions WHERE state='ACTIVE' LIMIT 1")).rows[0].id;
  const trace = uuidv7();
  const existing = uuidv7();
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,provider_transaction_id,amount_cents,currency,trace_id,credited_at)
    VALUES($1,'existing-tx-user','CREDITED',1,$2,$3,'1234','provider-duplicate',1000,'THB',$4,clock_timestamp())`,
  [existing, Buffer.alloc(32, 50), receiver, trace]);
  const topup = uuidv7(); const review = uuidv7();
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,trace_id) VALUES($1,'duplicate-review-user','MANUAL_REVIEW',1,$2,$3,'1234',$4)`,
  [topup, Buffer.alloc(32, 51), receiver, trace]);
  await pool.query(`INSERT INTO manual_reviews(id,subject_type,subject_id,state,financial,owner_only,
    opened_reason,trace_id) VALUES($1,'TOPUP',$2,'OPEN',true,true,'AMBIGUOUS',$3)`, [review, topup, trace]);
  const input = { reviewId: review, decision: 'CREDIT', reason: 'verified duplicate check', isOwner: true,
    amountCents: 1_000n, providerTransactionId: 'provider-duplicate' };
  const prepared = await resolveSubjectReview(input, ownerContext(trace, 'duplicate-manual-prepare'), { pool });
  assert.equal(prepared.applied.confirmationRequired, true);
  await assert.rejects(() => resolveSubjectReview(input, ownerContext(trace, 'duplicate-manual-confirm'), { pool }),
    (error) => error.code === 'STALE_STATE' && /ถูกใช้/.test(error.message));
  assert.equal((await pool.query('SELECT status FROM topups WHERE id=$1', [topup])).rows[0].status, 'MANUAL_REVIEW');
  assert.equal((await pool.query('SELECT state FROM manual_reviews WHERE id=$1', [review])).rows[0].state, 'OPEN');
});

test('owner may confirm a no-transaction-ID settlement only with complete TrueMoney evidence', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const receiver = (await pool.query("SELECT id FROM receiver_versions WHERE state='ACTIVE' LIMIT 1")).rows[0].id;
  const trace = uuidv7(); const topup = uuidv7(); const review = uuidv7();
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,amount_cents,currency,trace_id)
    VALUES($1,'fallback-settlement-user','MANUAL_REVIEW',1,$2,$3,'1234',1000,'THB',$4)`,
  [topup, Buffer.alloc(32, 54), receiver, trace]);
  await pool.query(`INSERT INTO payment_attempts(id,topup_id,attempt_number,dispatch_state,provider_status_code,
    provider_http_status,provider_evidence,trace_id)
    VALUES($1,$2,1,'VERIFIED','SUCCESS',200,$3,$4)`, [uuidv7(), topup,
    { receiverConfirmation: 'REQUEST_BOUND_SUCCESS', settlementIdentity: 'VOUCHER_HMAC' }, trace]);
  await pool.query(`INSERT INTO manual_reviews(id,subject_type,subject_id,state,financial,owner_only,
    opened_reason,trace_id) VALUES($1,'TOPUP',$2,'OPEN',true,true,'AMOUNT_OUTSIDE_AUTOCREDIT_RANGE',$3)`,
  [review, topup, trace]);
  const input = { reviewId: review, decision: 'CREDIT', reason: 'confirmed provider settlement evidence',
    isOwner: true, amountCents: 1_000n, providerTransactionId: null };
  const prepared = await resolveSubjectReview(input, ownerContext(trace, 'fallback-credit-prepare'), { pool });
  assert.equal(prepared.applied.confirmationRequired, true);
  const completed = await resolveSubjectReview(input, ownerContext(trace, 'fallback-credit-confirm'), { pool });
  assert.equal(completed.applied.status, 'CREDITED');
  const settled = (await pool.query('SELECT status,provider_transaction_id FROM topups WHERE id=$1', [topup])).rows[0];
  assert.deepEqual(settled, { status: 'CREDITED', provider_transaction_id: null });
  assert.equal(BigInt((await pool.query("SELECT available_cents FROM wallets WHERE discord_user_id='fallback-settlement-user'"))
    .rows[0].available_cents), 1_000n);
});

test('daily top-up limit credits the full received amount and redeemed-day reconciliation locks later intake', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const receiver = (await pool.query("SELECT id FROM receiver_versions WHERE state='ACTIVE' LIMIT 1")).rows[0].id;
  const trace = uuidv7();
  const topups = [uuidv7(), uuidv7()];
  for (const [index, topupId] of topups.entries()) {
    await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
      receiver_version_id,receiver_phone_last4,provider_transaction_id,amount_cents,currency,trace_id,redeemed_at)
      VALUES($1,'daily-limit-user','REDEEMED',1,$2,$3,'1234',$4,$5,'THB',$6,clock_timestamp())`,
    [topupId, Buffer.alloc(32, 20 + index), receiver, `daily-provider-${index}`, index === 0 ? 200_000 : 150_000, trace]);
  }
  const workerContext = (key) => createContext({ traceId: trace, actorType: 'SYSTEM', actorId: 'payment-worker',
    guildId: '10000000000000002', idempotencyKey: key });
  await creditRedeemedTopup({ topupId: topups[0] }, workerContext('daily-credit-1'), { pool });
  await creditRedeemedTopup({ topupId: topups[1] }, workerContext('daily-credit-2'), { pool });
  const wallet = (await pool.query("SELECT * FROM wallets WHERE discord_user_id='daily-limit-user'")).rows[0];
  assert.equal(BigInt(wallet.available_cents), 350_000n);
  const daily = await reconcileDailyTopupLock({ discordUserId: 'daily-limit-user' },
    workerContext('daily-lock-reconcile'), { pool });
  assert.equal(daily.locked, true);
  assert.equal(daily.totalCents, 350_000n);
  const lock = (await pool.query(`SELECT * FROM topup_daily_locks WHERE discord_user_id='daily-limit-user'`)).rows[0];
  assert.ok(new Date(lock.expires_at).getTime() > Date.now());
});
