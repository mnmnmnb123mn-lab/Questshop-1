import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireSingleInstanceLock, closeSqliteDatabase, configureSecretVerifier, fullIntegrityCheck, openSqliteDatabase, quickIntegrityCheck, withImmediateTransaction } from '../../src/db/sqlite.js';
import { migrateSqlite } from '../../src/db/sqlite-migrations.js';
import { appendWalletTransaction } from '../../src/domain/sqlite/wallet.js';
import { creditRedeemedTopup, creditVerifiedTopup, recordRedeemedTopup, resolveTopupFinancialReview, reverseCreditedTopup, submitTopup, markTopupProcessing, moveTopupToReview, failTopup } from '../../src/domain/sqlite/payments.js';
import { createOrder, settleOrderItem } from '../../src/domain/sqlite/orders.js';
import { claimDueNotification, enqueueNotification, finishNotificationDelivery } from '../../src/domain/sqlite/notifications.js';
import { createRotatedSqliteBackup, replaceDatabaseFromBackup } from '../../src/db/sqlite-backup.js';
import { parseBahtToCents, percentageBonusHalfUp } from '../../src/shared/money.js';
import { encryptCredential } from '../../src/domain/sqlite/crypto.js';
import { claimDueJob, completeJob, enqueueJob, markJobPossiblySent, recoverInterruptedJobs, renewJobLease, updateRunningJobPayload } from '../../src/domain/sqlite/jobs.js';
import { processQuestWorkflowJob } from '../../src/domain/sqlite/quest-workflow.js';
import { assertCustomerAccess, assertGate, currentFeatureGates } from '../../src/domain/sqlite/gates.js';
import { deferNotification, recoverSendingNotifications } from '../../src/domain/sqlite/notifications.js';
import { refundReadyOrderItem } from '../../src/domain/sqlite/orders.js';

const secret = 'sqlite-test-secret-key-which-is-at-least-32-characters';

async function database() {
  const directory = await mkdtemp(path.join(tmpdir(), 'questshop-sqlite-test-'));
  const databasePath = path.join(directory, 'questshop.db');
  const db = await openSqliteDatabase({ databasePath, secret });
  await migrateSqlite({ db, directory: path.resolve('migrations/sqlite'), secret, backup: async () => {} });
  return { db, directory, databasePath, async close() { closeSqliteDatabase(db); await rm(directory, { recursive: true, force: true }); } };
}

test('SQLite migration creates strict financial schema and append-only audit', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const tables = fixture.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get();
  assert.equal(Number(tables.count), 16);
  assert.equal(fullIntegrityCheck(fixture.db).ok, true);
  appendWalletTransaction(fixture.db, { discordUserId: 'customer-a', transactionType: 'TOPUP', availableDeltaCents: 500,
    referenceType: 'TEST', referenceId: 'one', idempotencyKey: 'append-only-one', traceId: randomUUID() });
  assert.throws(() => fixture.db.prepare('DELETE FROM wallet_transactions').run(), /append-only/);
});

test('SQLite primitive rejects asynchronous transactions and a mismatched persistent secret', async () => {
  const fixture = await database();
  assert.equal(quickIntegrityCheck(fixture.db).ok, true);
  assert.equal(configureSecretVerifier(fixture.db, secret), false);
  assert.throws(() => withImmediateTransaction(fixture.db, () => Promise.resolve()), /must not await external work/);
  closeSqliteDatabase(fixture.db);
  await assert.rejects(openSqliteDatabase({ databasePath: fixture.databasePath, secret: 'a-different-secret-key-which-is-at-least-32' }),
    (error) => error.code === 'SQLITE_SECRET_MISMATCH');
  await rm(fixture.directory, { recursive: true, force: true });
});

test('voucher ownership is private and verified credit/reversal are exactly once', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const url = 'https://gift.truemoney.com/campaign/?v=0123456789abcdef0123456789abcdef01';
  const first = submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: 'owner', voucherUrl: url });
  assert.equal(submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: 'owner', voucherUrl: url }).idempotent, true);
  assert.throws(() => submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: 'other', voucherUrl: url }),
    (error) => error.code === 'NOT_AUTHORIZED');
  const credited = creditVerifiedTopup(fixture.db, { topupId: first.topup.id, principalCents: 1_000, bonusCents: 50 });
  assert.equal(credited.topup.status, 'CREDITED');
  assert.equal(Number(credited.wallet.available_cents), 1_050);
  assert.equal(creditVerifiedTopup(fixture.db, { topupId: first.topup.id, principalCents: 1_000 }).idempotent, true);
  const reversed = reverseCreditedTopup(fixture.db, { topupId: first.topup.id });
  assert.equal(reversed.topup.status, 'REVERSED');
  assert.equal(Number(reversed.wallet.available_cents), 0);
});

test('REDEEMED is a durable boundary and restart recovery can credit it exactly once', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const topup = submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: 'redeemed-owner',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=2123456789abcdef0123456789abcdef01' }).topup;
  markTopupProcessing(fixture.db, topup.id);
  const redeemed = recordRedeemedTopup(fixture.db, { topupId: topup.id, principalCents: 2_500,
    providerEvidence: { httpStatus: 200, providerCode: 'SUCCESS', receiverConfirmation: 'REQUEST_BOUND_SUCCESS' } });
  assert.equal(redeemed.topup.status, 'REDEEMED');
  assert.equal(fixture.db.prepare('SELECT count(*) AS count FROM wallet_transactions WHERE reference_id=?').get(topup.id).count, 0);
  const firstCredit = creditRedeemedTopup(fixture.db, { topupId: topup.id });
  const replay = creditRedeemedTopup(fixture.db, { topupId: topup.id });
  assert.equal(firstCredit.topup.status, 'CREDITED');
  assert.equal(replay.idempotent, true);
  assert.equal(fixture.db.prepare('SELECT count(*) AS count FROM wallet_transactions WHERE reference_id=?').get(topup.id).count, 1);
  assert.throws(() => creditRedeemedTopup(fixture.db, { topupId: 'missing-topup' }), (error) => error.code === 'TOPUP_NOT_FOUND');
  assert.equal(moveTopupToReview(fixture.db, { topupId: 'missing-topup', reasonCode: 'NOOP', safeReason: 'ไม่มีรายการ' }), null);
});

test('financial review requires two confirmations and credits only with complete replacement evidence', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const topup = submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: 'review-credit-owner',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=3123456789abcdef0123456789abcdef01' }).topup;
  markTopupProcessing(fixture.db, topup.id);
  moveTopupToReview(fixture.db, { topupId: topup.id, reasonCode: 'AMBIGUOUS', safeReason: 'ต้องตรวจหลักฐาน' });
  const review = fixture.db.prepare("SELECT * FROM manual_reviews WHERE subject_id=? AND state='OPEN'").get(topup.id);
  assert.equal(resolveTopupFinancialReview(fixture.db, { reviewId: review.id, actorId: 'owner', decision: 'CREDIT' }).state,
    'AWAITING_SECOND_CONFIRMATION');
  assert.throws(() => resolveTopupFinancialReview(fixture.db, { reviewId: review.id, actorId: 'owner', decision: 'CREDIT', principalCents: 500,
    providerEvidence: { httpStatus: 200, providerCode: 'SUCCESS' } }), (error) => error.code === 'REVIEW_EVIDENCE_INCOMPLETE');
  const credited = resolveTopupFinancialReview(fixture.db, { reviewId: review.id, actorId: 'owner', decision: 'CREDIT', principalCents: 500,
    providerEvidence: { httpStatus: 200, providerCode: 'SUCCESS', receiverConfirmation: 'REQUEST_BOUND_SUCCESS', receiverLast4: '1234' } });
  assert.equal(credited.status, 'CREDITED');
  assert.equal(fixture.db.prepare('SELECT state FROM manual_reviews WHERE id=?').get(review.id).state, 'RESOLVED');
});

test('promotion snapshots, rejected reviews, and insufficient reversals retain the correct financial state', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const now = Date.now();
  fixture.db.prepare(`INSERT INTO promotions(id,name,state,rule_json,starts_at,ends_at,updated_at)
    VALUES(?,?, 'ACTIVE', ?,NULL,NULL,?)`).run('promo', 'โบนัสสิบเปอร์เซ็นต์', JSON.stringify({ minimumCents: 1_000, basisPoints: 1_000, maximumBonusCents: 150 }), now);
  const first = submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: 'promo-owner',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=4123456789abcdef0123456789abcdef01' }).topup;
  markTopupProcessing(fixture.db, first.id);
  const credited = creditVerifiedTopup(fixture.db, { topupId: first.id, principalCents: 2_000 });
  assert.deepEqual([Number(credited.topup.principal_cents), Number(credited.topup.bonus_cents), Number(credited.topup.credited_cents)], [2_000, 150, 2_150]);
  assert.equal(recordRedeemedTopup(fixture.db, { topupId: first.id, principalCents: 0 }).idempotent, true);

  const rejected = submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: 'review-reject',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=5123456789abcdef0123456789abcdef01' }).topup;
  markTopupProcessing(fixture.db, rejected.id);
  moveTopupToReview(fixture.db, { topupId: rejected.id, reasonCode: 'UNKNOWN', safeReason: 'ตรวจเพิ่ม' });
  const rejectReview = fixture.db.prepare("SELECT * FROM manual_reviews WHERE subject_id=? AND state='OPEN'").get(rejected.id);
  resolveTopupFinancialReview(fixture.db, { reviewId: rejectReview.id, actorId: 'owner', decision: 'REJECT' });
  assert.equal(resolveTopupFinancialReview(fixture.db, { reviewId: rejectReview.id, actorId: 'owner', decision: 'REJECT' }).status, 'FAILED');

  const reversal = reverseCreditedTopup(fixture.db, { topupId: first.id });
  assert.equal(reversal.topup.status, 'REVERSED');
  const notCredited = reverseCreditedTopup(fixture.db, { topupId: first.id });
  assert.equal(notCredited.idempotent, true);

  const held = submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: 'held-credit',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=6123456789abcdef0123456789abcdef01' }).topup;
  markTopupProcessing(fixture.db, held.id);
  creditVerifiedTopup(fixture.db, { topupId: held.id, principalCents: 1_000 });
  appendWalletTransaction(fixture.db, { discordUserId: 'held-credit', transactionType: 'RESERVE', availableDeltaCents: -1_000,
    reservedDeltaCents: 1_000, referenceType: 'TEST', referenceId: 'held', idempotencyKey: 'held-reserve', traceId: randomUUID() });
  const blockedReversal = reverseCreditedTopup(fixture.db, { topupId: held.id });
  assert.equal(blockedReversal.reviewOpened, true);
  assert.equal(fixture.db.prepare('SELECT status FROM topups WHERE id=?').get(held.id).status, 'CREDITED');

  const mismatch = fixture.db.prepare("SELECT id FROM manual_reviews WHERE subject_id=? AND state='OPEN'").get(held.id);
  assert.equal(resolveTopupFinancialReview(fixture.db, { reviewId: mismatch.id, actorId: 'owner', decision: 'REVERSE' }).state,
    'AWAITING_SECOND_CONFIRMATION');
  assert.throws(() => resolveTopupFinancialReview(fixture.db, { reviewId: mismatch.id, actorId: 'other-owner', decision: 'REVERSE' }),
    (error) => error.code === 'REVIEW_CONFIRMATION_ACTOR_MISMATCH');
});

test('order settlement moves reserved credit atomically', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  appendWalletTransaction(fixture.db, { discordUserId: 'buyer', transactionType: 'TOPUP', availableDeltaCents: 2_000,
    referenceType: 'TEST', referenceId: 'fund', idempotencyKey: 'fund-buyer', traceId: randomUUID() });
  const now = Date.now();
  fixture.db.prepare(`INSERT INTO quests(quest_id,name,task_type,url,source,first_seen_at,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('quest-1', 'Quest ทดสอบ', 'TYPE', 'https://discord.com/quests/quest-1', 'CUSTOMER', now, now, now);
  const order = createOrder(fixture.db, { discordUserId: 'buyer', questAccountId: 'account', traceId: randomUUID(),
    items: [{ questId: 'quest-1', priceCents: 500 }] });
  let wallet = fixture.db.prepare('SELECT * FROM wallets WHERE discord_user_id=?').get('buyer');
  assert.deepEqual([Number(wallet.available_cents), Number(wallet.reserved_cents)], [1_500, 500]);
  const item = fixture.db.prepare('SELECT * FROM order_items WHERE order_id=?').get(order.id);
  settleOrderItem(fixture.db, { itemId: item.id, outcome: 'SUCCESS', claimUrl: 'https://discord.com/quests/claim' });
  wallet = fixture.db.prepare('SELECT * FROM wallets WHERE discord_user_id=?').get('buyer');
  assert.deepEqual([Number(wallet.available_cents), Number(wallet.reserved_cents)], [1_500, 0]);
  const failedOrder = createOrder(fixture.db, { discordUserId: 'buyer', questAccountId: 'account', traceId: randomUUID(),
    items: [{ questId: 'quest-1', priceCents: 500 }] });
  const failedItem = fixture.db.prepare('SELECT * FROM order_items WHERE order_id=?').get(failedOrder.id);
  settleOrderItem(fixture.db, { itemId: failedItem.id, outcome: 'FAILED', reason: 'TEST_FAILURE' });
  wallet = fixture.db.prepare('SELECT * FROM wallets WHERE discord_user_id=?').get('buyer');
  assert.deepEqual([Number(wallet.available_cents), Number(wallet.reserved_cents)], [1_500, 0]);
});

test('a ready-to-claim item refunds once with its Wallet movement in the same transition', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const now = Date.now();
  appendWalletTransaction(fixture.db, { discordUserId: 'refund-buyer', transactionType: 'TOPUP', availableDeltaCents: 900,
    referenceType: 'TEST', referenceId: 'refund-fund', idempotencyKey: 'refund-fund', traceId: randomUUID() });
  fixture.db.prepare(`INSERT INTO quests(quest_id,name,task_type,url,source,first_seen_at,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('refund-quest', 'Refund', 'TYPE', 'https://discord.com/quests/refund', 'CUSTOMER', now, now, now);
  const order = createOrder(fixture.db, { discordUserId: 'refund-buyer', questAccountId: 'refund-account', traceId: randomUUID(),
    items: [{ questId: 'refund-quest', priceCents: 500 }] });
  const item = fixture.db.prepare('SELECT * FROM order_items WHERE order_id=?').get(order.id);
  settleOrderItem(fixture.db, { itemId: item.id, outcome: 'SUCCESS', claimUrl: 'https://discord.com/quests/refund' });
  assert.equal(refundReadyOrderItem(fixture.db, { itemId: item.id, actorId: 'owner' }).item.state, 'REFUNDED');
  assert.equal(refundReadyOrderItem(fixture.db, { itemId: item.id, actorId: 'owner' }).idempotent, true);
  assert.equal(fixture.db.prepare('SELECT available_cents FROM wallets WHERE discord_user_id=?').get('refund-buyer').available_cents, 900);
});

test('orders are idempotent per temporary checkout and ambiguous work stays reserved', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const now = Date.now();
  appendWalletTransaction(fixture.db, { discordUserId: 'checkout-buyer', transactionType: 'TOPUP', availableDeltaCents: 900,
    referenceType: 'TEST', referenceId: 'fund-checkout', idempotencyKey: 'fund-checkout', traceId: randomUUID() });
  fixture.db.prepare(`INSERT INTO quests(quest_id,name,task_type,url,source,first_seen_at,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('quest-review', 'Quest review', 'TYPE', 'https://discord.com/quests/quest-review', 'CUSTOMER', now, now, now);
  fixture.db.prepare(`INSERT INTO credentials(id,subject_type,subject_id,credential_type,retention_class,ciphertext,nonce,auth_tag,cleanup_after,created_at,updated_at)
    VALUES(?,?,?,'CUSTOMER_QUEST_TOKEN','TEMPORARY',X'00',X'00',X'00',?,?,?)`).run('11111111-1111-4111-8111-111111111111', 'CHECKOUT', 'test', now + 1_000, now, now);
  const input = { discordUserId: 'checkout-buyer', questAccountId: 'account', credentialId: '11111111-1111-4111-8111-111111111111',
    traceId: randomUUID(), items: [{ questId: 'quest-review', priceCents: 300 }] };
  const first = createOrder(fixture.db, input);
  assert.equal(createOrder(fixture.db, input).id, first.id);
  const item = fixture.db.prepare('SELECT id FROM order_items WHERE order_id=?').get(first.id);
  settleOrderItem(fixture.db, { itemId: item.id, outcome: 'REVIEW', reason: 'UNCERTAIN' });
  const wallet = fixture.db.prepare('SELECT available_cents,reserved_cents FROM wallets WHERE discord_user_id=?').get('checkout-buyer');
  assert.deepEqual([Number(wallet.available_cents), Number(wallet.reserved_cents)], [600, 300]);
  assert.equal(fixture.db.prepare("SELECT state FROM manual_reviews WHERE subject_type='ORDER_ITEM' AND subject_id=?").get(item.id).state, 'OPEN');
  assert.throws(() => createOrder(fixture.db, { ...input, credentialId: 'missing-credential' }), (error) => error.code === 'CHECKOUT_EXPIRED');
});

test('customer Quest discovery persists safe metadata, an ephemeral-ready session, and a Monitor search', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const now = Date.now();
  const credentialId = randomUUID();
  const sealed = encryptCredential(secret, 'customer-token-never-rendered');
  fixture.db.prepare(`INSERT INTO credentials(id,subject_type,subject_id,credential_type,retention_class,ciphertext,nonce,auth_tag,cleanup_after,created_at,updated_at)
    VALUES(?,?,?,'CUSTOMER_QUEST_TOKEN','TEMPORARY',?,?,?,?,?,?)`).run(credentialId, 'CHECKOUT', credentialId,
    sealed.ciphertext, sealed.nonce, sealed.authTag, now + 1_000, now, now);
  const checkout = enqueueJob(fixture.db, { jobType: 'CUSTOMER_QUEST_DISCOVERY', subjectType: 'CHECKOUT', subjectId: credentialId,
    operationKey: `checkout:${credentialId}`, payload: { credentialId, discordUserId: '12345678901234567' } });
  const job = claimDueJob(fixture.db);
  const runtime = { db: fixture.db, env: { QUESTSHOP_SECRET_KEY: secret, RUNNER_CONCURRENCY: 1 }, abortController: new AbortController(),
    questApiFactory: () => ({ fetchCurrentUser: async () => ({ id: 'quest-account' }), fetchQuests: async () => [{
      id: 'customer-quest', name: 'Quest ลูกค้า', eventName: 'WATCH_VIDEO', url: 'https://discord.com/quests/customer-quest',
      expiresAt: new Date(now + 60_000).toISOString(), artworkUrl: 'https://cdn.discordapp.com/image.png', contractHash: 'contract',
    }] }) };
  await processQuestWorkflowJob(runtime, job);
  assert.equal(fixture.db.prepare('SELECT source FROM quests WHERE quest_id=?').get('customer-quest').source, 'CUSTOMER');
  assert.equal(fixture.db.prepare("SELECT state FROM jobs WHERE id=?").get(checkout.id).state, 'COMPLETED');
  assert.equal(fixture.db.prepare("SELECT count(*) AS count FROM jobs WHERE job_type='MONITOR_SEARCH'").get().count, 1);
  // Checkout choices deliberately are not a DM notification: the customer
  // opens this persisted session through the Ephemeral interaction UI.
  assert.equal(fixture.db.prepare("SELECT count(*) AS count FROM notifications WHERE notification_type='CHECKOUT_OPTIONS'").get().count, 0);
  assert.equal(fixture.db.prepare("SELECT count(*) AS count FROM notifications WHERE notification_type='CUSTOMER_QUEST_DISCOVERY'").get().count >= 1, true);
  fixture.db.prepare("UPDATE jobs SET state='COMPLETED',completed_at=? WHERE job_type='MONITOR_SEARCH'").run(Date.now());
  enqueueJob(fixture.db, { jobType: 'CUSTOMER_QUEST_DISCOVERY', subjectType: 'CHECKOUT', subjectId: credentialId,
    operationKey: `checkout-repeat:${credentialId}`, payload: { credentialId, discordUserId: '12345678901234567' } });
  await processQuestWorkflowJob(runtime, claimDueJob(fixture.db));
  assert.equal(fixture.db.prepare('SELECT discovery_count FROM quests WHERE quest_id=?').get('customer-quest').discovery_count, 2);
});

test('Monitor search and test use only matching active account credentials', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const now = Date.now();
  fixture.db.prepare(`INSERT INTO quests(quest_id,name,task_type,url,source,first_seen_at,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('monitor-quest', 'Quest Monitor', 'WATCH_VIDEO', 'https://discord.com/quests/monitor-quest', 'CUSTOMER', now, now, now);
  const credentialId = randomUUID();
  const sealed = encryptCredential(secret, 'monitor-token');
  fixture.db.prepare(`INSERT INTO credentials(id,subject_type,subject_id,credential_type,retention_class,ciphertext,nonce,auth_tag,created_at,updated_at)
    VALUES(?,?,?,'MONITOR_TOKEN','PERSISTENT',?,?,?,?,?)`).run(credentialId, 'MONITOR', 'monitor-account', sealed.ciphertext, sealed.nonce, sealed.authTag, now, now);
  fixture.db.prepare(`INSERT INTO monitor_accounts(account_id,label,state,credential_id,updated_at) VALUES(?,?,?,?,?)`)
    .run('monitor-account', 'บัญชีทดสอบ', 'ACTIVE', credentialId, now);
  const runtime = { db: fixture.db, env: { QUESTSHOP_SECRET_KEY: secret, RUNNER_CONCURRENCY: 1 }, abortController: new AbortController(),
    questApiFactory: ({ token }) => ({
      fetchCurrentUser: async () => ({ id: token === 'monitor-token' ? 'monitor-account' : 'wrong' }),
      fetchQuests: async () => [{ id: 'monitor-quest', name: 'Quest Monitor', eventName: 'WATCH_VIDEO',
        url: 'https://discord.com/quests/monitor-quest', expiresAt: new Date(now + 60_000).toISOString(), completed: true }],
    }) };
  enqueueJob(fixture.db, { jobType: 'MONITOR_SEARCH', subjectType: 'QUEST', subjectId: 'monitor-quest',
    operationKey: 'monitor-search-test', payload: { questId: 'monitor-quest' } });
  await processQuestWorkflowJob(runtime, claimDueJob(fixture.db));
  assert.equal(fixture.db.prepare('SELECT monitor_status FROM quests WHERE quest_id=?').get('monitor-quest').monitor_status, 'FOUND_COMPLETED');
  assert.equal(fixture.db.prepare("SELECT state FROM quest_checks WHERE check_type='SEARCH'").get().state, 'COMPLETED');
});

test('Monitor test records a passed Quest after a ready search result', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const now = Date.now();
  fixture.db.prepare(`INSERT INTO quests(quest_id,name,task_type,url,source,first_seen_at,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('ready-quest', 'Quest ready', 'WATCH_VIDEO', 'https://discord.com/quests/ready-quest', 'CUSTOMER', now, now, now);
  const credentialId = randomUUID();
  const sealed = encryptCredential(secret, 'monitor-ready-token');
  fixture.db.prepare(`INSERT INTO credentials(id,subject_type,subject_id,credential_type,retention_class,ciphertext,nonce,auth_tag,created_at,updated_at)
    VALUES(?,?,?,'MONITOR_TOKEN','PERSISTENT',?,?,?,?,?)`).run(credentialId, 'MONITOR', 'ready-monitor', sealed.ciphertext, sealed.nonce, sealed.authTag, now, now);
  fixture.db.prepare('INSERT INTO monitor_accounts(account_id,label,state,credential_id,updated_at) VALUES(?,?,?,?,?)')
    .run('ready-monitor', 'พร้อมทดสอบ', 'ACTIVE', credentialId, now);
  let reads = 0;
  const runtime = { db: fixture.db, env: { QUESTSHOP_SECRET_KEY: secret, RUNNER_CONCURRENCY: 1 }, abortController: new AbortController(),
    questApiFactory: () => ({ fetchCurrentUser: async () => ({ id: 'ready-monitor' }), fetchQuests: async () => [{
      id: 'ready-quest', name: 'Quest ready', eventName: 'WATCH_VIDEO', url: 'https://discord.com/quests/ready-quest',
      expiresAt: new Date(now + 60_000).toISOString(), completed: ++reads > 1,
    }] }) };
  enqueueJob(fixture.db, { jobType: 'MONITOR_SEARCH', subjectType: 'QUEST', subjectId: 'ready-quest',
    operationKey: 'ready-search', payload: { questId: 'ready-quest' } });
  await processQuestWorkflowJob(runtime, claimDueJob(fixture.db));
  await processQuestWorkflowJob(runtime, claimDueJob(fixture.db));
  assert.equal(fixture.db.prepare('SELECT monitor_status FROM quests WHERE quest_id=?').get('ready-quest').monitor_status, 'TEST_PASSED');
  assert.equal(fixture.db.prepare("SELECT state FROM quest_checks WHERE check_type='TEST'").get().state, 'PASSED');
});

test('a Quest absent from every active Monitor becomes not found without a test mutation', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const now = Date.now();
  fixture.db.prepare(`INSERT INTO quests(quest_id,name,task_type,url,source,first_seen_at,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('absent-quest', 'Quest absent', 'WATCH_VIDEO', 'https://discord.com/quests/absent-quest', 'CUSTOMER', now, now, now);
  enqueueJob(fixture.db, { jobType: 'MONITOR_SEARCH', subjectType: 'QUEST', subjectId: 'absent-quest',
    operationKey: 'absent-search', payload: { questId: 'absent-quest' } });
  const runtime = { db: fixture.db, env: { QUESTSHOP_SECRET_KEY: secret, RUNNER_CONCURRENCY: 1 }, abortController: new AbortController() };
  await processQuestWorkflowJob(runtime, claimDueJob(fixture.db));
  assert.equal(fixture.db.prepare('SELECT monitor_status FROM quests WHERE quest_id=?').get('absent-quest').monitor_status, 'NOT_FOUND');
  assert.equal(fixture.db.prepare("SELECT count(*) AS count FROM quest_checks WHERE quest_id='absent-quest'").get().count, 0);
});

test('an unusable Monitor is reported as incomplete rather than pretending Quest is absent', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const now = Date.now();
  fixture.db.prepare(`INSERT INTO quests(quest_id,name,task_type,url,source,first_seen_at,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('incomplete-quest', 'Quest incomplete', 'WATCH_VIDEO', 'https://discord.com/quests/incomplete-quest', 'CUSTOMER', now, now, now);
  const credentialId = randomUUID();
  const sealed = encryptCredential(secret, 'wrong-monitor-token');
  fixture.db.prepare(`INSERT INTO credentials(id,subject_type,subject_id,credential_type,retention_class,ciphertext,nonce,auth_tag,created_at,updated_at)
    VALUES(?,?,?,'MONITOR_TOKEN','PERSISTENT',?,?,?,?,?)`).run(credentialId, 'MONITOR', 'expected-account', sealed.ciphertext, sealed.nonce, sealed.authTag, now, now);
  fixture.db.prepare('INSERT INTO monitor_accounts(account_id,label,state,credential_id,updated_at) VALUES(?,?,?,?,?)')
    .run('expected-account', 'Token ไม่ตรง', 'ACTIVE', credentialId, now);
  enqueueJob(fixture.db, { jobType: 'MONITOR_SEARCH', subjectType: 'QUEST', subjectId: 'incomplete-quest',
    operationKey: 'incomplete-search', payload: { questId: 'incomplete-quest' } });
  const runtime = { db: fixture.db, env: { QUESTSHOP_SECRET_KEY: secret, RUNNER_CONCURRENCY: 1 }, abortController: new AbortController(),
    questApiFactory: () => ({ fetchCurrentUser: async () => ({ id: 'different-account' }) }) };
  await processQuestWorkflowJob(runtime, claimDueJob(fixture.db));
  assert.equal(fixture.db.prepare('SELECT monitor_status FROM quests WHERE quest_id=?').get('incomplete-quest').monitor_status, 'INCOMPLETE');
  assert.equal(fixture.db.prepare("SELECT state FROM quest_checks WHERE quest_id='incomplete-quest'").get().state, 'UNAVAILABLE');
});

test('Quest runner captures a completed Quest once and preserves its claim link', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const now = Date.now();
  appendWalletTransaction(fixture.db, { discordUserId: 'runner-buyer', transactionType: 'TOPUP', availableDeltaCents: 600,
    referenceType: 'TEST', referenceId: 'runner-fund', idempotencyKey: 'runner-fund', traceId: randomUUID() });
  fixture.db.prepare(`INSERT INTO quests(quest_id,name,task_type,url,source,first_seen_at,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('runner-quest', 'Quest Runner', 'WATCH_VIDEO', 'https://discord.com/quests/runner-quest', 'CUSTOMER', now, now, now);
  const credentialId = randomUUID();
  const sealed = encryptCredential(secret, 'runner-token');
  fixture.db.prepare(`INSERT INTO credentials(id,subject_type,subject_id,credential_type,retention_class,ciphertext,nonce,auth_tag,cleanup_after,created_at,updated_at)
    VALUES(?,?,?,'CUSTOMER_QUEST_TOKEN','TEMPORARY',?,?,?,?,?,?)`).run(credentialId, 'CHECKOUT', credentialId,
    sealed.ciphertext, sealed.nonce, sealed.authTag, now + 60_000, now, now);
  const order = createOrder(fixture.db, { discordUserId: 'runner-buyer', questAccountId: 'runner-account', credentialId,
    traceId: randomUUID(), items: [{ questId: 'runner-quest', priceCents: 500 }] });
  const runtime = { db: fixture.db, env: { QUESTSHOP_SECRET_KEY: secret, RUNNER_CONCURRENCY: 1 }, abortController: new AbortController(),
    questApiFactory: () => ({ fetchQuests: async () => [{ id: 'runner-quest', completed: true, url: 'https://discord.com/quests/runner-quest' }] }) };
  const job = claimDueJob(fixture.db);
  await processQuestWorkflowJob(runtime, job);
  const item = fixture.db.prepare('SELECT * FROM order_items WHERE order_id=?').get(order.id);
  assert.equal(item.state, 'READY_TO_CLAIM');
  assert.equal(item.claim_url, 'https://discord.com/quests/runner-quest');
  const wallet = fixture.db.prepare('SELECT available_cents,reserved_cents FROM wallets WHERE discord_user_id=?').get('runner-buyer');
  assert.deepEqual([Number(wallet.available_cents), Number(wallet.reserved_cents)], [100, 0]);
});

test('job checkpoints recover safe reads and quarantine possibly sent mutations', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const first = enqueueJob(fixture.db, { jobType: 'SAFE_READ', subjectType: 'TEST', subjectId: 'safe', operationKey: 'safe-read' });
  const claimed = claimDueJob(fixture.db);
  assert.equal(completeJob(fixture.db, { jobId: claimed.id, leaseToken: claimed.lease_token, retryAt: 1, errorCode: 'RETRY' }).state, 'RETRY_WAIT');
  fixture.db.prepare('UPDATE jobs SET next_run_at=0 WHERE id=?').run(first.id);
  const retried = claimDueJob(fixture.db);
  assert.equal(completeJob(fixture.db, { jobId: retried.id, leaseToken: retried.lease_token }).state, 'COMPLETED');

  enqueueJob(fixture.db, { jobType: 'MUTATION', subjectType: 'TEST', subjectId: 'sent', operationKey: 'possibly-sent' });
  const uncertain = claimDueJob(fixture.db);
  assert.equal(markJobPossiblySent(fixture.db, { jobId: uncertain.id, leaseToken: uncertain.lease_token }), true);
  fixture.db.prepare('UPDATE jobs SET lease_expires_at=0 WHERE id=?').run(uncertain.id);
  recoverInterruptedJobs(fixture.db);
  assert.equal(fixture.db.prepare('SELECT state FROM jobs WHERE id=?').get(uncertain.id).state, 'REVIEW');

  enqueueJob(fixture.db, { jobType: 'READ', subjectType: 'TEST', subjectId: 'restart', operationKey: 'safe-restart' });
  const safe = claimDueJob(fixture.db);
  assert.equal(renewJobLease(fixture.db, { jobId: safe.id, leaseToken: safe.lease_token }), true);
  assert.equal(updateRunningJobPayload(fixture.db, { jobId: safe.id, leaseToken: safe.lease_token, payload: { stage: 'read' } }).checkpoint, 'NOT_STARTED');
  fixture.db.prepare('UPDATE jobs SET lease_expires_at=0 WHERE id=?').run(safe.id);
  recoverInterruptedJobs(fixture.db);
  assert.equal(fixture.db.prepare('SELECT state FROM jobs WHERE id=?').get(safe.id).state, 'PENDING');
});

test('gates are closed by default and Notification recovery/defer preserves a durable projection', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  assert.equal(currentFeatureGates(fixture.db).TOPUP_ACCEPTING, false);
  assert.throws(() => assertGate(fixture.db, 'TOPUP_ACCEPTING'), (error) => error.code === 'FEATURE_DISABLED');
  const notification = enqueueNotification(fixture.db, { notificationType: 'SYSTEM_LOG', aggregateType: 'SYSTEM', aggregateId: 'defer', destination: 'LOG_SYSTEM' });
  const sending = claimDueNotification(fixture.db);
  assert.equal(deferNotification(fixture.db, { notificationId: notification.id, leaseToken: sending.lease_token, retryAt: Date.now() + 10_000 }).state, 'RETRY_WAIT');
  fixture.db.prepare("UPDATE notifications SET state='SENDING',lease_expires_at=0 WHERE id=?").run(notification.id);
  assert.equal(recoverSendingNotifications(fixture.db) >= 1, true);
});

test('prelaunch customer access requires the Owner after all runtime gates are open', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  fixture.db.prepare(`INSERT INTO settings(key,value_json,updated_at,updated_by) VALUES('feature_gates',?,?,?)`).run(
    JSON.stringify({ STORE_OPEN: true, CUSTOMER_INTERACTIONS_ENABLED: true, TOPUP_ACCEPTING: true }), Date.now(), 'owner');
  const env = { PRELAUNCH: true, OWNER_ID: 'owner' };
  assert.throws(() => assertCustomerAccess(fixture.db, env, { user: { id: 'customer' }, memberPermissions: { has: () => false } }, 'TOPUP_ACCEPTING'),
    (error) => error.code === 'PRELAUNCH_RESTRICTED');
  assert.doesNotThrow(() => assertCustomerAccess(fixture.db, env, { user: { id: 'owner' }, memberPermissions: { has: () => false } }, 'TOPUP_ACCEPTING'));
  assert.doesNotThrow(() => assertCustomerAccess(fixture.db, env, { user: { id: 'administrator' }, memberPermissions: { has: () => true } }, 'TOPUP_ACCEPTING'));
});

test('notification delivery preserves a newer desired version', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const first = enqueueNotification(fixture.db, { notificationType: 'SYSTEM_LOG', aggregateType: 'SYSTEM', aggregateId: 'one', destination: 'LOG_SYSTEM' });
  const sending = claimDueNotification(fixture.db);
  enqueueNotification(fixture.db, { notificationType: 'SYSTEM_LOG', aggregateType: 'SYSTEM', aggregateId: 'one', destination: 'LOG_SYSTEM', payload: { revision: 2 } });
  const done = finishNotificationDelivery(fixture.db, { notificationId: first.id, leaseToken: sending.lease_token, messageId: 'discord-message' });
  assert.equal(done.state, 'PENDING');
  assert.equal(Number(done.delivered_version), 1);
  assert.equal(Number(done.desired_version), 2);
});

test('online backup is verified and database files are owner-only', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const destination = await createRotatedSqliteBackup(fixture.db, fixture.databasePath, { kind: 'daily', keep: 7 });
  assert.equal((await stat(destination)).size > 0, true);
  assert.equal((await stat(fixture.databasePath)).mode & 0o777, 0o600);
});

test('single-instance lock rejects a live process, reclaims a stale lease, and verified backup restore replaces only the database', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'questshop-lock-test-'));
  const databasePath = path.join(directory, 'questshop.db');
  const db = await openSqliteDatabase({ databasePath, secret });
  await migrateSqlite({ db, directory: path.resolve('migrations/sqlite'), secret, backup: async () => {} });
  const lock = await acquireSingleInstanceLock(databasePath, { staleAfterMs: 20 });
  await assert.rejects(acquireSingleInstanceLock(databasePath, { staleAfterMs: 20 }), (error) => error.code === 'SQLITE_SINGLE_INSTANCE_LOCKED');
  await lock.release();
  await writeFile(`${databasePath}.runtime.lock`, JSON.stringify({ owner: 'dead', heartbeatAt: 0 }));
  await sleep(5);
  const reclaimed = await acquireSingleInstanceLock(databasePath, { staleAfterMs: 1 });
  await reclaimed.release();
  const backup = await createRotatedSqliteBackup(db, databasePath, { kind: 'daily', keep: 7 });
  closeSqliteDatabase(db);
  const restored = await replaceDatabaseFromBackup({ source: backup, destination: databasePath, secret });
  assert.equal(Boolean(restored.quarantine), true);
  const reopened = await openSqliteDatabase({ databasePath, secret });
  assert.equal(fullIntegrityCheck(reopened).ok, true);
  closeSqliteDatabase(reopened);
  await rm(directory, { recursive: true, force: true });
});

test('failure paths retain money safely and notification retries reach the financial DLQ', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const topup = submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: 'review-user',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=1123456789abcdef0123456789abcdef01' }).topup;
  assert.equal(markTopupProcessing(fixture.db, topup.id).status, 'PROCESSING');
  assert.equal(moveTopupToReview(fixture.db, { topupId: topup.id, reasonCode: 'AMBIGUOUS', safeReason: 'รอตรวจ' }).status, 'REVIEW');
  assert.equal(failTopup(fixture.db, { topupId: topup.id, reasonCode: 'SHOULD_NOT_OVERWRITE_REVIEW' }).status, 'REVIEW');
  const notification = enqueueNotification(fixture.db, { notificationType: 'TOPUP_STATUS_DM', aggregateType: 'TOPUP',
    aggregateId: 'retry', destination: 'DM:12345678901234567' });
  for (let attempt = 0; attempt < 7; attempt += 1) {
    fixture.db.prepare("UPDATE notifications SET next_run_at=0 WHERE id=?").run(notification.id);
    const claimed = claimDueNotification(fixture.db);
    finishNotificationDelivery(fixture.db, { notificationId: notification.id, leaseToken: claimed.lease_token,
      errorCode: 'DM_CLOSED', financial: true });
  }
  assert.equal(fixture.db.prepare('SELECT state FROM notifications WHERE id=?').get(notification.id).state, 'DEAD_LETTER');
  assert.equal(parseBahtToCents('10.05'), 1005n);
  assert.equal(percentageBonusHalfUp(101, 500), 5n);
  assert.equal(parseBahtToCents('10'), 1000n);
  assert.throws(() => parseBahtToCents('-1'));
});
