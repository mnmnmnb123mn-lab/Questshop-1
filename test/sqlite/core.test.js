import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import { acquireSingleInstanceLock, closeSqliteDatabase, configureSecretVerifier, fullIntegrityCheck, openSqliteDatabase, quickIntegrityCheck, withImmediateTransaction } from '../../src/db/sqlite.js';
import { migrateSqlite } from '../../src/db/sqlite-migrations.js';
import { appendWalletTransaction } from '../../src/domain/sqlite/wallet.js';
import { creditRedeemedTopup, creditVerifiedTopup, recordRedeemedTopup, resolveTopupFinancialReview, reverseCreditedTopup, submitTopup, markTopupProcessing, moveTopupToReview, failTopup } from '../../src/domain/sqlite/payments.js';
import { createOrder, resolveOrderItemReview, settleOrderItem } from '../../src/domain/sqlite/orders.js';
import { claimDueNotification, enqueueNotification, finishNotificationDelivery } from '../../src/domain/sqlite/notifications.js';
import { createRotatedSqliteBackup, replaceDatabaseFromBackup } from '../../src/db/sqlite-backup.js';
import { parseBahtToCents, percentageBonusHalfUp } from '../../src/shared/money.js';
import { encryptCredential, voucherHmac, voucherIdentityHmac } from '../../src/domain/sqlite/crypto.js';
import { claimDueJob, completeJob, enqueueJob, markJobPossiblySent, recordQuestVerifiedResult, recoverInterruptedJobs, renewJobLease, updateRunningJobPayload } from '../../src/domain/sqlite/jobs.js';
import { processQuestWorkflowJob } from '../../src/domain/sqlite/quest-workflow.js';
import { deliverNotification, processPaymentJob, recoverInterruptedSubjects } from '../../src/workers/sqlite-worker-manager.js';
import { setupSurface, surfaceNonce, updateOrCreateSurfaceAnchor } from '../../src/discord/surfaces/setup.js';
import { bindInteractionSessionMessage, consumeInteractionSession, consumeModalInteractionSession, createInteractionSession } from '../../src/domain/sqlite/interaction-sessions.js';
import { adjustWallet, adminOverview, configureReceiverPhone, queueMonitorScanAndTest, retryNotificationDlq, setQuestPrice, upsertMonitorAccount, upsertPromotion } from '../../src/domain/sqlite/admin.js';
import { loadRuntimeConfig } from '../../src/config/runtime-config.js';
import { recomputeHealthStatus } from '../../src/bootstrap/health-status.js';
import { renderQuestAuto } from '../../src/discord/renderers/surfaces.js';
import { renderSurfaceAnchor, questAutoPriceRangeLabel } from '../../src/discord/renderers/surfaces.js';
import { renderSqliteNotification } from '../../src/discord/renderers/sqlite-projections.js';
import { normalizeDiscordPayload } from '../../src/discord/payload.js';
import { customId, parseCustomId } from '../../src/discord/components/custom-id.js';
import { assertCustomerAccess, assertGate, currentFeatureGates } from '../../src/domain/sqlite/gates.js';
import { deferNotification, recoverSendingNotifications, retryDeadLetterNotification } from '../../src/domain/sqlite/notifications.js';
import { refundReadyOrderItem } from '../../src/domain/sqlite/orders.js';
import { assertQuestExecutorContract, defineQuestExecutor, executeQuestExecutor } from '../../src/quest-engine/executors/contract.js';
import { listExecutorCapabilities, selectQuestExecutor } from '../../src/quest-engine/executors/registry.js';
import { nextVideoTimestamp, videoExecutor } from '../../src/quest-engine/executors/video.js';
import { desktopExecutor } from '../../src/quest-engine/executors/desktop.js';
import { EXTERNAL_OUTCOME, externalOutcome } from '../../src/domain/sqlite/external-outcome.js';

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
  assert.equal(Number(tables.count), 19);
  assert.equal(fullIntegrityCheck(fixture.db).ok, true);
  appendWalletTransaction(fixture.db, { discordUserId: 'customer-a', transactionType: 'TOPUP', availableDeltaCents: 500,
    referenceType: 'TEST', referenceId: 'one', idempotencyKey: 'append-only-one', traceId: randomUUID() });
  assert.throws(() => fixture.db.prepare('DELETE FROM wallet_transactions').run(), /append-only/);
  assert.ok(fixture.db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name='external_operation_evidence_append_only_update'").get());
});

test('external outcome and surface fallbacks reject unsafe data without changing customer contracts', () => {
  assert.deepEqual(externalOutcome({ outcome: EXTERNAL_OUTCOME.AMBIGUOUS, evidence: null }), {
    outcome: 'AMBIGUOUS', providerReference: null, reason: null, evidence: {},
  });
  assert.throws(() => externalOutcome({ outcome: 'RETRY' }), /Invalid external outcome/);
  assert.equal(questAutoPriceRangeLabel({ minCents: -1, maxCents: 500 }), null);
  assert.equal(renderSurfaceAnchor('UNRECOGNIZED').embeds[0].data.title, 'Questshop');
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

test('versioned voucher proofs retain one stable identity across rotations', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const url = 'https://gift.truemoney.com/campaign/?v=f123456789abcdef0123456789abcdef01';
  const first = submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret, VOUCHER_HMAC_ACTIVE_VERSION: 'v1' },
    { discordUserId: 'rotated-owner', voucherUrl: url });
  const replay = submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret, VOUCHER_HMAC_ACTIVE_VERSION: 'v2' },
    { discordUserId: 'rotated-owner', voucherUrl: url });
  assert.equal(replay.idempotent, true);
  const code = new URL(url).searchParams.get('v');
  assert.notDeepEqual(voucherHmac(secret, code, 'v1'), voucherHmac(secret, code, 'v2'));
  assert.deepEqual(Buffer.from(fixture.db.prepare('SELECT voucher_identity_hmac FROM topups WHERE id=?').get(first.topup.id).voucher_identity_hmac),
    voucherIdentityHmac(secret, code));
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
  assert.equal(fixture.db.prepare('SELECT state FROM manual_reviews WHERE id=?').get(review.id).state, 'RESOLVED_SUCCESS');
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
  assert.equal(fixture.db.prepare('SELECT state FROM manual_reviews WHERE id=?').get(rejectReview.id).state, 'RESOLVED_FAILURE');
  assert.equal(resolveTopupFinancialReview(fixture.db, { reviewId: rejectReview.id, actorId: 'owner', decision: 'REJECT' }).idempotent, true);

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
  assert.throws(() => settleOrderItem(fixture.db, { itemId: item.id, outcome: 'SUCCESS', claimUrl: 'https://discord.com/quests/claim' }),
    (error) => error.code === 'SETTLEMENT_VERIFICATION_REQUIRED');
  settleOrderItem(fixture.db, { itemId: item.id, outcome: 'SUCCESS', verified: true, claimUrl: 'https://discord.com/quests/claim' });
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
  settleOrderItem(fixture.db, { itemId: item.id, outcome: 'SUCCESS', verified: true, claimUrl: 'https://discord.com/quests/refund' });
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

test('Monitor test does not pass a Quest completed before its own mutation', async (t) => {
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
  assert.equal(fixture.db.prepare('SELECT monitor_status FROM quests WHERE quest_id=?').get('ready-quest').monitor_status, 'TEST_FAILED');
  assert.equal(fixture.db.prepare("SELECT state FROM quest_checks WHERE check_type='TEST'").get().state, 'FAILED');
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

test('Quest already completed before a paid run is released without capture', async (t) => {
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
  assert.equal(item.state, 'FAILED');
  assert.equal(item.claim_url, null);
  const wallet = fixture.db.prepare('SELECT available_cents,reserved_cents FROM wallets WHERE discord_user_id=?').get('runner-buyer');
  assert.deepEqual([Number(wallet.available_cents), Number(wallet.reserved_cents)], [600, 0]);
  assert.equal(fixture.db.prepare("SELECT outcome FROM settlement_evidence WHERE subject_id=?").get(item.id).outcome, 'RELEASED');
});

test('an incomplete Quest result remains reserved for operational review', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const now = Date.now();
  appendWalletTransaction(fixture.db, { discordUserId: 'incomplete-buyer', transactionType: 'TOPUP', availableDeltaCents: 600,
    referenceType: 'TEST', referenceId: 'incomplete-fund', idempotencyKey: 'incomplete-fund', traceId: randomUUID() });
  fixture.db.prepare(`INSERT INTO quests(quest_id,name,task_type,url,source,first_seen_at,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('incomplete-runner-quest', 'Incomplete', 'WATCH_VIDEO', 'https://discord.com/quests/incomplete-runner-quest', 'CUSTOMER', now, now, now);
  const credentialId = randomUUID(); const sealed = encryptCredential(secret, 'incomplete-token');
  fixture.db.prepare(`INSERT INTO credentials(id,subject_type,subject_id,credential_type,retention_class,ciphertext,nonce,auth_tag,cleanup_after,created_at,updated_at)
    VALUES(?,?,?,'CUSTOMER_QUEST_TOKEN','TEMPORARY',?,?,?,?,?,?)`).run(credentialId, 'CHECKOUT', credentialId,
    sealed.ciphertext, sealed.nonce, sealed.authTag, now + 60_000, now, now);
  const order = createOrder(fixture.db, { discordUserId: 'incomplete-buyer', questAccountId: 'incomplete-account', credentialId,
    traceId: randomUUID(), items: [{ questId: 'incomplete-runner-quest', priceCents: 500 }] });
  const runtime = { db: fixture.db, env: { QUESTSHOP_SECRET_KEY: secret, RUNNER_CONCURRENCY: 1 }, abortController: new AbortController(),
    questApiFactory: () => ({ fetchQuests: async () => [{ id: 'incomplete-runner-quest', eventName: 'WATCH_VIDEO', enrolled: true, completed: false,
      progressSecs: 10, secondsNeeded: 10, url: 'https://discord.com/quests/incomplete-runner-quest' }] }) };
  await processQuestWorkflowJob(runtime, claimDueJob(fixture.db));
  const item = fixture.db.prepare('SELECT * FROM order_items WHERE order_id=?').get(order.id);
  assert.equal(item.state, 'REVIEW');
  assert.deepEqual(Object.values(fixture.db.prepare('SELECT available_cents,reserved_cents FROM wallets WHERE discord_user_id=?').get('incomplete-buyer')).slice(0, 2).map(Number), [100, 500]);
  assert.equal(fixture.db.prepare("SELECT state FROM manual_reviews WHERE subject_id=?").get(item.id).state, 'OPEN');
});

test('unknown TrueMoney provider outcomes become financial review rather than failure', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  configureReceiverPhone(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { phone: '0912345678', actorId: 'owner' });
  const topup = submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: 'ambiguous-payer',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=7123456789abcdef0123456789abcdef01' }).topup;
  const job = claimDueJob(fixture.db);
  const runtime = { db: fixture.db, env: { QUESTSHOP_SECRET_KEY: secret }, abortController: new AbortController(),
    paymentProvider: async () => ({ outcome: 'AMBIGUOUS', providerCode: 'UNKNOWN_PROVIDER_RESULT', httpStatus: 400, providerEvidence: {} }) };
  await processPaymentJob(runtime, job);
  assert.equal(fixture.db.prepare('SELECT status FROM topups WHERE id=?').get(topup.id).status, 'REVIEW');
  assert.equal(fixture.db.prepare("SELECT state FROM manual_reviews WHERE subject_type='TOPUP' AND subject_id=?").get(topup.id).state, 'OPEN');
  assert.equal(fixture.db.prepare('SELECT outcome FROM payment_attempts WHERE topup_id=?').get(topup.id).outcome, 'AMBIGUOUS');
});

test('payment worker credits verified success and fails only explicit terminal voucher outcomes', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  configureReceiverPhone(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { phone: '0912345678', actorId: 'owner' });
  const success = submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: 'payment-success',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=9123456789abcdef0123456789abcdef01' }).topup;
  await processPaymentJob({ db: fixture.db, env: { QUESTSHOP_SECRET_KEY: secret }, abortController: new AbortController(),
    paymentProvider: async () => ({ outcome: 'SUCCESS', currency: 'THB', amountCents: 250, providerTransactionId: 'payment-success-id', providerEvidence: { httpStatus: 200 } }) }, claimDueJob(fixture.db));
  assert.equal(fixture.db.prepare('SELECT status FROM topups WHERE id=?').get(success.id).status, 'CREDITED');
  const rejected = submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: 'payment-reject',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=a123456789abcdef0123456789abcdef01' }).topup;
  await processPaymentJob({ db: fixture.db, env: { QUESTSHOP_SECRET_KEY: secret }, abortController: new AbortController(),
    paymentProvider: async () => ({ outcome: 'DEFINITE_FAILURE', reason: 'VOUCHER_EXPIRED', httpStatus: 400, providerEvidence: {} }) }, claimDueJob(fixture.db));
  assert.equal(fixture.db.prepare('SELECT status FROM topups WHERE id=?').get(rejected.id).status, 'FAILED');
  assert.equal(fixture.db.prepare('SELECT outcome FROM payment_attempts WHERE topup_id=?').get(rejected.id).outcome, 'DEFINITE_FAILURE');
  assert.match(fixture.db.prepare("SELECT evidence_json FROM external_operation_evidence WHERE subject_id=? AND stage='VERIFIED_RESULT'").get(rejected.id).evidence_json,
    /DEFINITE_FAILURE/);
});

test('operational review releases once or captures only with explicit verification', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const now = Date.now();
  appendWalletTransaction(fixture.db, { discordUserId: 'review-buyer', transactionType: 'TOPUP', availableDeltaCents: 500,
    referenceType: 'TEST', referenceId: 'review-fund', idempotencyKey: 'review-fund', traceId: randomUUID() });
  fixture.db.prepare(`INSERT INTO quests(quest_id,name,task_type,url,source,first_seen_at,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('reviewable', 'Review', 'TYPE', 'https://discord.com/quests/reviewable', 'CUSTOMER', now, now, now);
  const order = createOrder(fixture.db, { discordUserId: 'review-buyer', questAccountId: 'review-account', traceId: randomUUID(),
    items: [{ questId: 'reviewable', priceCents: 300 }] });
  const item = fixture.db.prepare('SELECT * FROM order_items WHERE order_id=?').get(order.id);
  settleOrderItem(fixture.db, { itemId: item.id, outcome: 'REVIEW', reason: 'AMBIGUOUS' });
  const review = fixture.db.prepare("SELECT * FROM manual_reviews WHERE subject_id=? AND state='OPEN'").get(item.id);
  assert.throws(() => resolveOrderItemReview(fixture.db, { reviewId: review.id, actorId: 'owner', decision: 'CAPTURE' }),
    (error) => error.code === 'REVIEW_EVIDENCE_INCOMPLETE');
  assert.equal(resolveOrderItemReview(fixture.db, { reviewId: review.id, actorId: 'owner', decision: 'RELEASE' }).item.state, 'FAILED');
  assert.equal(resolveOrderItemReview(fixture.db, { reviewId: review.id, actorId: 'owner', decision: 'RELEASE' }).idempotent, true);
});

test('server-side interaction sessions bind actor, location, message, operation and one-time use', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const id = createInteractionSession(fixture.db, { actorId: 'admin', guildId: 'guild', channelId: 'channel', operation: 'TEST', payload: { ok: true } });
  assert.equal(bindInteractionSessionMessage(fixture.db, { sessionId: id, messageId: 'message' }), true);
  assert.throws(() => consumeInteractionSession(fixture.db, { sessionId: id, actorId: 'other', guildId: 'guild', channelId: 'channel', messageId: 'message', operation: 'TEST' }),
    (error) => error.code === 'INTERACTION_CONTEXT_INVALID');
  assert.equal(consumeInteractionSession(fixture.db, { sessionId: id, actorId: 'admin', guildId: 'guild', channelId: 'channel', messageId: 'message', operation: 'TEST' }).payload.ok, true);
  assert.throws(() => consumeInteractionSession(fixture.db, { sessionId: id, actorId: 'admin', guildId: 'guild', channelId: 'channel', messageId: 'message', operation: 'TEST' }),
    (error) => error.code === 'INTERACTION_EXPIRED');
});

test('modal sessions bind actor and context without trusting a client message id', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const id = createInteractionSession(fixture.db, { actorId: 'modal-user', guildId: 'guild', channelId: 'channel', messageId: 'origin',
    operation: 'TOKEN_SUBMIT', payload: { origin: 'QUEST_AUTO' } });
  const consumed = consumeModalInteractionSession(fixture.db, { sessionId: id, actorId: 'modal-user', guildId: 'guild', channelId: 'channel', operation: 'TOKEN_SUBMIT' });
  assert.equal(consumed.payload.origin, 'QUEST_AUTO');
  assert.throws(() => consumeModalInteractionSession(fixture.db, { sessionId: id, actorId: 'modal-user', guildId: 'guild', channelId: 'channel', operation: 'TOKEN_SUBMIT' }),
    (error) => error.code === 'INTERACTION_EXPIRED');
});

test('surface permission errors do not create a replacement durable anchor', async () => {
  let sent = 0;
  const channel = { messages: { fetch: async () => new Map() }, send: async () => { sent += 1; return { id: 'new' }; } };
  const existing = { edit: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); } };
  await assert.rejects(() => updateOrCreateSurfaceAnchor(channel, 'ADMIN_PANEL', {}, existing), (error) => Number(error.status) === 403);
  assert.equal(sent, 0);
});

test('surface reconciliation paginates nonce markers, supports legacy footer once, and replaces only confirmed deletion', async () => {
  const pageOne = new Map(Array.from({ length: 100 }, (_, index) => [`p${index}`, { id: `p${index}` }]));
  const nonceMessage = { id: 'nonce-anchor', nonce: surfaceNonce('ADMIN_PANEL'), edit: async () => nonceMessage };
  let pages = 0;
  const paginated = { messages: { fetch: async () => (++pages === 1 ? pageOne : new Map([['nonce', nonceMessage]])) },
    send: async () => { throw new Error('must find nonce'); } };
  assert.equal((await updateOrCreateSurfaceAnchor(paginated, 'ADMIN_PANEL', {})).message.id, 'nonce-anchor');
  assert.equal(pages, 2);

  const legacyMessage = { id: 'legacy-anchor', embeds: [{ footer: { text: 'Questshop Surface • ADMIN_PANEL' } }], edit: async () => legacyMessage };
  const legacy = { messages: { fetch: async () => new Map([['legacy', legacyMessage]]) }, send: async () => { throw new Error('must migrate footer'); } };
  assert.equal((await updateOrCreateSurfaceAnchor(legacy, 'ADMIN_PANEL', {})).message.id, 'legacy-anchor');

  let replacements = 0;
  const deleted = { edit: async () => { throw Object.assign(new Error('gone'), { status: 404, code: 10008 }); } };
  const replacementChannel = { messages: { fetch: async () => new Map() }, send: async () => ({ id: `replacement-${++replacements}` }) };
  assert.equal((await updateOrCreateSurfaceAnchor(replacementChannel, 'ADMIN_PANEL', {}, deleted)).recreated, true);
  assert.equal(replacements, 1);
  const timeout = { edit: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); } };
  await assert.rejects(() => updateOrCreateSurfaceAnchor(replacementChannel, 'ADMIN_PANEL', {}, timeout), /timeout/);
  assert.equal(replacements, 1);
});

test('setup moves one durable anchor and rejects overlapping setup for the same surface', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  let retired = 0; let resolveSend;
  const oldMessage = { id: 'old-anchor', edit: async () => { retired += 1; return oldMessage; } };
  const oldChannel = { id: 'old-channel', isTextBased: () => true, messages: { fetch: async () => oldMessage } };
  const newMessage = { id: 'new-anchor', edit: async () => newMessage };
  const newChannel = { id: 'new-channel', isTextBased: () => true, messages: { fetch: async () => new Map() },
    send: async () => new Promise((resolve) => { resolveSend = () => resolve(newMessage); }) };
  const runtime = { db: fixture.db, config: { surfaces: { ADMIN_PANEL: { channelId: 'old-channel', messageId: 'old-anchor' } } },
    client: { channels: { fetch: async () => oldChannel } } };
  const first = setupSurface({ channel: newChannel, surfaceKey: 'ADMIN_PANEL', runtime, actorId: 'owner' });
  await nextTurn();
  await assert.rejects(() => setupSurface({ channel: newChannel, surfaceKey: 'ADMIN_PANEL', runtime, actorId: 'owner' }),
    (error) => error.code === 'SURFACE_SETUP_IN_PROGRESS');
  resolveSend();
  assert.equal((await first).message.id, 'new-anchor');
  assert.equal(retired, 1);
  assert.deepEqual(JSON.parse(fixture.db.prepare("SELECT value_json FROM settings WHERE key='discord_surfaces'").get().value_json).ADMIN_PANEL.channelId, 'new-channel');
});

test('SQLite Admin services configure price, receiver, monitor, promotion and audited wallet adjustment', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  for (const taskType of ['PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2', 'WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']) {
    setQuestPrice(fixture.db, { taskType, amountCents: 500, actorId: 'admin', reason: 'UAT' });
  }
  assert.deepEqual(loadRuntimeConfig(fixture.db).priceRange, { minCents: 500, maxCents: 500 });
  assert.equal(configureReceiverPhone(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { phone: '0912345678', actorId: 'admin' }).last4, '5678');
  const monitor = upsertMonitorAccount(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { accountId: '12345678901234567', label: 'Monitor A', token: 'monitor-token', actorId: 'admin' });
  assert.equal(monitor.state, 'ACTIVE');
  const rotated = upsertMonitorAccount(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { accountId: '12345678901234567', label: 'Monitor A', token: 'rotated-monitor-token', actorId: 'admin' });
  assert.equal(rotated.credential_id, monitor.credential_id);
  assert.equal(upsertPromotion(fixture.db, { name: 'โบนัส', state: 'ACTIVE', minimumCents: 100, basisPoints: 500, actorId: 'admin' }).state, 'ACTIVE');
  const movement = adjustWallet(fixture.db, { discordUserId: '12345678901234567', availableDeltaCents: 700, actorId: 'admin', reason: 'UAT funding' });
  assert.equal(Number(movement.wallet.available_cents), 700);
  assert.deepEqual(adminOverview(fixture.db), { openReviews: 0, pendingJobs: 0, deadLetters: 0, activeMonitors: 1, receiverConfigured: true });
  assert.equal(fixture.db.prepare("SELECT count(*) AS count FROM admin_audit WHERE action IN ('PRICE_UPDATED','RECEIVER_UPDATED','MONITOR_UPDATED','PROMOTION_UPDATED','WALLET_ADJUSTMENT')").get().count >= 8, true);
});

test('Quest Auto and public Quest announcement render stored Thai metadata without internal identifiers', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const now = Date.now();
  for (const taskType of ['PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2', 'WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']) {
    setQuestPrice(fixture.db, { taskType, amountCents: 500, actorId: 'admin' });
  }
  const storefront = renderQuestAuto(loadRuntimeConfig(fixture.db));
  assert.match(storefront.embeds[0].data.description, /5 บาท/);
  fixture.db.prepare(`INSERT INTO quests(quest_id,name,task_type,url,thumbnail_url,starts_at,expires_at,target_value,orb_min,orb_max,source,first_seen_at,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('internal-quest-id', 'Quest สาธารณะ', 'WATCH_VIDEO', 'https://discord.com/quests/public',
    'https://cdn.discordapp.com/thumb.png', now, now + 60_000, 120, 10, 20, 'CUSTOMER', now, now, now);
  const notification = enqueueNotification(fixture.db, { notificationType: 'QUEST_NEW', aggregateType: 'QUEST', aggregateId: 'internal-quest-id', destination: 'QUEST_NEW' });
  const payload = await renderSqliteNotification({ db: fixture.db, client: {} }, notification);
  const data = payload.embeds[0].data;
  assert.match(data.description, /ประเภท: ดูวิดีโอ/);
  assert.match(data.description, /10-20 Discord Orbs/);
  assert.doesNotMatch(data.description, /internal-quest-id/);
});

test('notification delivery reuses a nonce-matched message after an uncertain checkpoint', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const pending = enqueueNotification(fixture.db, { notificationType: 'SYSTEM_LOG', aggregateType: 'SYSTEM', aggregateId: 'incident', destination: 'LOG_SYSTEM', payload: { code: 'X' } });
  const notification = claimDueNotification(fixture.db);
  let sends = 0; let edits = 0;
  const existing = { id: 'existing-message', nonce: notification.nonce, edit: async () => { edits += 1; return existing; } };
  const channel = { isTextBased: () => true, messages: { fetch: async () => new Map([[existing.id, existing]]) }, send: async () => { sends += 1; return { id: 'new-message' }; } };
  await deliverNotification({ db: fixture.db, config: { surfaces: { LOG_SYSTEM: { channelId: 'channel' } } }, client: { channels: { fetch: async () => channel } } }, notification);
  assert.deepEqual([edits, sends], [1, 0]);
  assert.equal(fixture.db.prepare('SELECT state,message_id FROM notifications WHERE id=?').get(pending.id).message_id, 'existing-message');
});

test('health becomes degraded when a runtime component fails and recovers only with ready checks', () => {
  const health = { ready: true, checks: { database: 'OK', discord: 'OK' } };
  assert.equal(recomputeHealthStatus({ health }), 'HEALTHY');
  health.checks.database = 'DEGRADED';
  assert.equal(recomputeHealthStatus({ health }), 'DEGRADED');
  health.ready = false;
  assert.equal(recomputeHealthStatus({ health }), 'NOT_READY');
});

test('notification renderers cover customer, payment, order, operations and admin projections', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const client = { users: { fetch: async (id) => ({ displayAvatarURL: () => `https://cdn.discordapp.com/${id}.png` }) } };
  const topup = submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: 'render-user',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=8123456789abcdef0123456789abcdef01' }).topup;
  creditVerifiedTopup(fixture.db, { topupId: topup.id, principalCents: 500 });
  const topupNotification = fixture.db.prepare("SELECT * FROM notifications WHERE notification_type='TOPUP_STATUS_DM' AND aggregate_id=?").get(topup.id);
  assert.equal((await renderSqliteNotification({ db: fixture.db, client }, topupNotification)).embeds.length, 1);
  const paymentLog = fixture.db.prepare("SELECT * FROM notifications WHERE notification_type='PAYMENT_LOG' AND aggregate_id=?").get(topup.id);
  assert.equal((await renderSqliteNotification({ db: fixture.db, client }, paymentLog)).files.length, 1);

  appendWalletTransaction(fixture.db, { discordUserId: 'render-buyer', transactionType: 'TOPUP', availableDeltaCents: 600,
    referenceType: 'TEST', referenceId: 'render-fund', idempotencyKey: 'render-fund', traceId: randomUUID() });
  const now = Date.now();
  fixture.db.prepare(`INSERT INTO quests(quest_id,name,task_type,url,source,first_seen_at,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('render-quest', 'Render Quest', 'WATCH_VIDEO', 'https://discord.com/quests/render', 'CUSTOMER', now, now, now);
  const order = createOrder(fixture.db, { discordUserId: 'render-buyer', questAccountId: 'render-account', traceId: randomUUID(), items: [{ questId: 'render-quest', priceCents: 500 }] });
  const item = fixture.db.prepare('SELECT * FROM order_items WHERE order_id=?').get(order.id);
  settleOrderItem(fixture.db, { itemId: item.id, outcome: 'SUCCESS', verified: true, claimUrl: 'https://discord.com/quests/render' });
  const orderNotification = fixture.db.prepare("SELECT * FROM notifications WHERE notification_type='ORDER_STATUS_DM' AND aggregate_id=?").get(order.id);
  assert.equal((await renderSqliteNotification({ db: fixture.db, client, config: { surfaces: {} }, env: { DISCORD_GUILD_ID: 'guild' } }, orderNotification)).components.length, 1);
  const operationNotification = fixture.db.prepare("SELECT * FROM notifications WHERE notification_type='QUEST_OPERATION_LOG' AND aggregate_id=?").get(item.id);
  assert.equal((await renderSqliteNotification({ db: fixture.db, client }, operationNotification)).embeds.length, 1);
  adjustWallet(fixture.db, { discordUserId: '12345678901234567', availableDeltaCents: 1, actorId: 'admin', reason: 'render audit' });
  const auditNotification = fixture.db.prepare("SELECT * FROM notifications WHERE notification_type='ADMIN_LOG' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal((await renderSqliteNotification({ db: fixture.db, client }, auditNotification)).embeds.length, 1);
});

test('custom IDs and payload normalization protect transport boundaries', () => {
  const id = customId('checkout_open');
  assert.equal(parseCustomId(id).route, 'checkout_open');
  assert.equal(parseCustomId('bad'), null);
  const normalized = normalizeDiscordPayload({ content: '@everyone', allowedMentions: { parse: ['everyone'] }, embeds: [{ title: 'x', description: 'y' }] });
  assert.equal(normalized.allowedMentions.parse.length, 0);
  assert.match(normalized.content, /@\u200beveryone/);
});

test('job checkpoints requeue safe reads and identify possibly sent mutations for subject recovery', async (t) => {
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
  const interrupted = recoverInterruptedJobs(fixture.db);
  assert.equal(interrupted.some((job) => job.id === uncertain.id), true);
  recoverInterruptedSubjects({ db: fixture.db });
  assert.equal(fixture.db.prepare('SELECT state FROM jobs WHERE id=?').get(uncertain.id).state, 'REVIEW');

  enqueueJob(fixture.db, { jobType: 'READ', subjectType: 'TEST', subjectId: 'restart', operationKey: 'safe-restart' });
  const safe = claimDueJob(fixture.db);
  assert.equal(renewJobLease(fixture.db, { jobId: safe.id, leaseToken: safe.lease_token }), true);
  assert.equal(updateRunningJobPayload(fixture.db, { jobId: safe.id, leaseToken: safe.lease_token, payload: { stage: 'read' } }).checkpoint, 'NOT_STARTED');
  fixture.db.prepare('UPDATE jobs SET lease_expires_at=0 WHERE id=?').run(safe.id);
  recoverInterruptedJobs(fixture.db);
  assert.equal(fixture.db.prepare('SELECT state FROM jobs WHERE id=?').get(safe.id).state, 'PENDING');
});

test('subject-aware recovery creates reviews and settles only durable redeemed credit', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const env = { QUESTSHOP_SECRET_KEY: secret };
  const uncertain = submitTopup(fixture.db, env, { discordUserId: 'recovery-customer',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=6123456789abcdef0123456789abcdef01' }).topup;
  const uncertainJob = claimDueJob(fixture.db, { jobType: 'PAYMENT_SETTLE' });
  markTopupProcessing(fixture.db, uncertain.id);
  markJobPossiblySent(fixture.db, { jobId: uncertainJob.id, leaseToken: uncertainJob.lease_token });
  fixture.db.prepare('UPDATE jobs SET lease_expires_at=0 WHERE id=?').run(uncertainJob.id);
  recoverInterruptedSubjects({ db: fixture.db });
  assert.equal(fixture.db.prepare('SELECT status FROM topups WHERE id=?').get(uncertain.id).status, 'REVIEW');
  assert.equal(fixture.db.prepare("SELECT category FROM manual_reviews WHERE subject_type='TOPUP' AND subject_id=? AND state='OPEN'").get(uncertain.id).category, 'FINANCIAL');
  assert.equal(fixture.db.prepare('SELECT state FROM jobs WHERE id=?').get(uncertainJob.id).state, 'REVIEW');

  const redeemed = submitTopup(fixture.db, env, { discordUserId: 'recovery-customer',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=7123456789abcdef0123456789abcdef01' }).topup;
  markTopupProcessing(fixture.db, redeemed.id);
  recordRedeemedTopup(fixture.db, { topupId: redeemed.id, principalCents: 500 });
  const redeemedJob = claimDueJob(fixture.db, { jobType: 'PAYMENT_SETTLE' });
  markJobPossiblySent(fixture.db, { jobId: redeemedJob.id, leaseToken: redeemedJob.lease_token });
  fixture.db.prepare('UPDATE jobs SET lease_expires_at=0 WHERE id=?').run(redeemedJob.id);
  recoverInterruptedSubjects({ db: fixture.db });
  assert.equal(fixture.db.prepare('SELECT state FROM jobs WHERE id=?').get(redeemedJob.id).state, 'COMPLETED');
  assert.equal(fixture.db.prepare('SELECT status FROM topups WHERE id=?').get(redeemed.id).status, 'CREDITED');
  const evidence = fixture.db.prepare("SELECT evidence_json FROM external_operation_evidence WHERE job_id=? AND stage='RECOVERY_DECISION'").get(redeemedJob.id);
  assert.match(evidence.evidence_json, /CREDIT_REDEEMED_WITHOUT_PROVIDER_RETRY/);

  const failed = submitTopup(fixture.db, env, { discordUserId: 'recovery-customer',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=9123456789abcdef0123456789abcdef01' }).topup;
  failTopup(fixture.db, { topupId: failed.id, reasonCode: 'VOUCHER_USED' });
  const failedJob = claimDueJob(fixture.db, { jobType: 'PAYMENT_SETTLE' });
  markJobPossiblySent(fixture.db, { jobId: failedJob.id, leaseToken: failedJob.lease_token });
  fixture.db.prepare('UPDATE jobs SET lease_expires_at=0 WHERE id=?').run(failedJob.id);
  recoverInterruptedSubjects({ db: fixture.db });
  assert.equal(fixture.db.prepare('SELECT state FROM jobs WHERE id=?').get(failedJob.id).state, 'FAILED');

  const credited = submitTopup(fixture.db, env, { discordUserId: 'recovery-customer',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=a123456789abcdef0123456789abcdef01' }).topup;
  markTopupProcessing(fixture.db, credited.id);
  recordRedeemedTopup(fixture.db, { topupId: credited.id, principalCents: 500 });
  creditRedeemedTopup(fixture.db, { topupId: credited.id });
  const creditedJob = claimDueJob(fixture.db, { jobType: 'PAYMENT_SETTLE' });
  markJobPossiblySent(fixture.db, { jobId: creditedJob.id, leaseToken: creditedJob.lease_token });
  fixture.db.prepare('UPDATE jobs SET lease_expires_at=0 WHERE id=?').run(creditedJob.id);
  recoverInterruptedSubjects({ db: fixture.db });
  assert.equal(fixture.db.prepare('SELECT state FROM jobs WHERE id=?').get(creditedJob.id).state, 'COMPLETED');
});

test('a stale payment lease cannot mutate its Top-up', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const topup = submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: 'lease-customer',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=8123456789abcdef0123456789abcdef01' }).topup;
  const job = claimDueJob(fixture.db, { jobType: 'PAYMENT_SETTLE' });
  fixture.db.prepare("UPDATE jobs SET lease_token='replacement-lease' WHERE id=?").run(job.id);
  assert.throws(() => markTopupProcessing(fixture.db, topup.id, { workerJob: { jobId: job.id, leaseToken: job.lease_token } }),
    (error) => error.code === 'JOB_LEASE_LOST');
  assert.equal(fixture.db.prepare('SELECT status FROM topups WHERE id=?').get(topup.id).status, 'PENDING');
});

test('Quest recovery settles a durable verified result without another mutation', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const timestamp = Date.now();
  appendWalletTransaction(fixture.db, { discordUserId: 'quest-recovery', transactionType: 'TOPUP', availableDeltaCents: 500,
    referenceType: 'TEST', referenceId: 'quest-recovery-funds', idempotencyKey: 'quest-recovery-funds', traceId: randomUUID() });
  fixture.db.prepare(`INSERT INTO quests(quest_id,name,task_type,url,source,first_seen_at,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('quest-recovery', 'Recoverable Quest', 'WATCH_VIDEO', 'https://discord.com/quests/recovery', 'CUSTOMER', timestamp, timestamp, timestamp);
  const order = createOrder(fixture.db, { discordUserId: 'quest-recovery', questAccountId: 'quest-recovery-account',
    items: [{ questId: 'quest-recovery', priceCents: 500 }] });
  const item = fixture.db.prepare('SELECT * FROM order_items WHERE order_id=?').get(order.id);
  const job = claimDueJob(fixture.db, { jobType: 'QUEST_RUN' });
  recordQuestVerifiedResult(fixture.db, { jobId: job.id, leaseToken: job.lease_token, subjectId: item.id,
    result: { outcome: 'SUCCESS', claimUrl: 'https://discord.com/quests/recovery', evidence: { verifiedCompleted: true } } });
  fixture.db.prepare('UPDATE jobs SET lease_expires_at=0 WHERE id=?').run(job.id);
  recoverInterruptedSubjects({ db: fixture.db });
  assert.equal(fixture.db.prepare('SELECT state FROM order_items WHERE id=?').get(item.id).state, 'READY_TO_CLAIM');
  assert.equal(fixture.db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id).state, 'COMPLETED');

  appendWalletTransaction(fixture.db, { discordUserId: 'quest-release', transactionType: 'TOPUP', availableDeltaCents: 500,
    referenceType: 'TEST', referenceId: 'quest-release-funds', idempotencyKey: 'quest-release-funds', traceId: randomUUID() });
  const releaseOrder = createOrder(fixture.db, { discordUserId: 'quest-release', questAccountId: 'quest-release-account',
    items: [{ questId: 'quest-recovery', priceCents: 500 }] });
  const releaseItem = fixture.db.prepare('SELECT * FROM order_items WHERE order_id=?').get(releaseOrder.id);
  const releaseJob = claimDueJob(fixture.db, { jobType: 'QUEST_RUN' });
  recordQuestVerifiedResult(fixture.db, { jobId: releaseJob.id, leaseToken: releaseJob.lease_token, subjectId: releaseItem.id,
    result: { outcome: 'FAILED', reason: 'EXTERNAL_COMPLETED_RELEASED', evidence: { completedBeforeRun: true } } });
  fixture.db.prepare('UPDATE jobs SET lease_expires_at=0 WHERE id=?').run(releaseJob.id);
  recoverInterruptedSubjects({ db: fixture.db });
  assert.equal(fixture.db.prepare('SELECT state FROM order_items WHERE id=?').get(releaseItem.id).state, 'FAILED');

  const missingTopup = enqueueJob(fixture.db, { jobType: 'PAYMENT_SETTLE', subjectType: 'TOPUP', subjectId: 'missing-topup', operationKey: 'missing-topup-recovery' });
  const missingTopupJob = claimDueJob(fixture.db, { jobType: 'PAYMENT_SETTLE' });
  markJobPossiblySent(fixture.db, { jobId: missingTopupJob.id, leaseToken: missingTopupJob.lease_token });
  fixture.db.prepare('UPDATE jobs SET lease_expires_at=0 WHERE id=?').run(missingTopup.id);
  recoverInterruptedSubjects({ db: fixture.db });
  assert.equal(fixture.db.prepare('SELECT state FROM jobs WHERE id=?').get(missingTopup.id).state, 'FAILED');

  const missingQuest = enqueueJob(fixture.db, { jobType: 'QUEST_RUN', subjectType: 'ORDER_ITEM', subjectId: 'missing-item', operationKey: 'missing-item-recovery' });
  const missingQuestJob = claimDueJob(fixture.db, { jobType: 'QUEST_RUN' });
  markJobPossiblySent(fixture.db, { jobId: missingQuestJob.id, leaseToken: missingQuestJob.lease_token });
  fixture.db.prepare('UPDATE jobs SET lease_expires_at=0 WHERE id=?').run(missingQuest.id);
  recoverInterruptedSubjects({ db: fixture.db });
  assert.equal(fixture.db.prepare('SELECT state FROM jobs WHERE id=?').get(missingQuest.id).state, 'FAILED');

  const completedQuest = enqueueJob(fixture.db, { jobType: 'QUEST_RUN', subjectType: 'ORDER_ITEM', subjectId: item.id, operationKey: 'completed-item-recovery' });
  const completedQuestJob = claimDueJob(fixture.db, { jobType: 'QUEST_RUN' });
  markJobPossiblySent(fixture.db, { jobId: completedQuestJob.id, leaseToken: completedQuestJob.lease_token });
  fixture.db.prepare('UPDATE jobs SET lease_expires_at=0 WHERE id=?').run(completedQuest.id);
  recoverInterruptedSubjects({ db: fixture.db });
  assert.equal(fixture.db.prepare('SELECT state FROM jobs WHERE id=?').get(completedQuest.id).state, 'COMPLETED');
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

test('a notification worker does not publish after its desired revision is superseded', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const notification = enqueueNotification(fixture.db, { notificationType: 'SYSTEM_LOG', aggregateType: 'SYSTEM', aggregateId: 'stale-worker', destination: 'LOG_SYSTEM' });
  const sending = claimDueNotification(fixture.db);
  let sent = 0;
  const channel = {
    isTextBased: () => true,
    messages: { fetch: async () => {
      enqueueNotification(fixture.db, { notificationType: 'SYSTEM_LOG', aggregateType: 'SYSTEM', aggregateId: 'stale-worker', destination: 'LOG_SYSTEM', payload: { revision: 2 } });
      return new Map();
    } },
    send: async () => { sent += 1; return { id: 'must-not-send' }; },
  };
  await deliverNotification({ db: fixture.db, config: { surfaces: { LOG_SYSTEM: { channelId: 'system-channel' } } },
    client: { channels: { fetch: async () => channel } } }, sending);
  const updated = fixture.db.prepare('SELECT * FROM notifications WHERE id=?').get(notification.id);
  assert.equal(sent, 0);
  assert.equal(updated.state, 'PENDING');
  assert.equal(Number(updated.desired_version), 2);
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

test('payment worker distinguishes retry, terminal rejection, and definitely-unsent failures', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  configureReceiverPhone(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { phone: '0912345678', actorId: 'admin' });
  const runtime = (outcome) => ({ db: fixture.db, env: { QUESTSHOP_SECRET_KEY: secret }, abortController: new AbortController(),
    paymentProvider: async () => outcome });
  const submit = (suffix) => submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: `worker-${suffix}`,
    voucherUrl: `https://gift.truemoney.com/campaign/?v=${suffix}23456789abcdef0123456789abcdef01` }).topup;

  const waiting = submit('a');
  await processPaymentJob(runtime({ outcome: 'AMBIGUOUS', reason: 'TEMPORARY', providerEvidence: { retry: true } }), claimDueJob(fixture.db, { jobType: 'PAYMENT_SETTLE' }));
  assert.equal(fixture.db.prepare('SELECT state FROM jobs WHERE subject_id=?').get(waiting.id).state, 'REVIEW');

  const rejected = submit('b');
  await processPaymentJob(runtime({ outcome: 'DEFINITE_FAILURE', reason: 'VOUCHER_EXPIRED', providerEvidence: {} }), claimDueJob(fixture.db, { jobType: 'PAYMENT_SETTLE' }));
  assert.equal(fixture.db.prepare('SELECT status FROM topups WHERE id=?').get(rejected.id).status, 'FAILED');

  const notSent = submit('c');
  const error = Object.assign(new Error('before dispatch'), { code: 'PROVIDER_NOT_SENT' });
  await processPaymentJob({ ...runtime(null), paymentProvider: async () => { throw error; } }, claimDueJob(fixture.db, { jobType: 'PAYMENT_SETTLE' }));
  assert.equal(fixture.db.prepare('SELECT status FROM topups WHERE id=?').get(notSent.id).status, 'PROCESSING');
  assert.equal(fixture.db.prepare('SELECT state FROM jobs WHERE subject_id=?').get(notSent.id).state, 'RETRY_WAIT');
});

test('Admin can queue private Monitor Scan + Test and retry a durable DLQ nonce', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const now = Date.now();
  fixture.db.prepare(`INSERT INTO quests(quest_id,name,task_type,url,expires_at,source,first_seen_at,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run('scan-quest', 'Scan Quest', 'WATCH_VIDEO', 'https://discord.com/quests/scan', now + 60_000, 'CUSTOMER', now, now, now);
  assert.equal(queueMonitorScanAndTest(fixture.db, { actorId: 'admin' }).queued, 1);
  assert.equal(queueMonitorScanAndTest(fixture.db, { actorId: 'admin', questId: 'scan-quest' }).queued, 0);
  assert.throws(() => queueMonitorScanAndTest(fixture.db, { actorId: 'admin', questId: 'missing' }), (error) => error.code === 'QUEST_NOT_FOUND');
  const notification = enqueueNotification(fixture.db, { notificationType: 'SYSTEM_LOG', aggregateType: 'SYSTEM', aggregateId: 'dlq-test', destination: 'LOG_SYSTEM' });
  fixture.db.prepare("UPDATE notifications SET state='DEAD_LETTER',attempt_count=7 WHERE id=?").run(notification.id);
  assert.equal(retryDeadLetterNotification(fixture.db, { notificationId: notification.id }).state, 'PENDING');
  fixture.db.prepare("UPDATE notifications SET state='DEAD_LETTER',attempt_count=7 WHERE id=?").run(notification.id);
  assert.equal(retryNotificationDlq(fixture.db, { notificationId: notification.id, actorId: 'admin' }).state, 'PENDING');
  assert.throws(() => retryNotificationDlq(fixture.db, { notificationId: 'missing', actorId: 'admin' }), (error) => error.code === 'DLQ_NOT_FOUND');
});

test('payload normalization bounds embeds, components, URLs, options, and explicit mentions', () => {
  const normalized = normalizeDiscordPayload({
    content: '<@12345678901234567> <@&99999999999999999> @everyone',
    allowedMentions: { roles: ['99999999999999999', 'bad'], users: ['12345678901234567'] }, nonce: 'x'.repeat(40),
    embeds: [{ title: 'x'.repeat(300), description: 'y'.repeat(4_200), footer: { text: 'z'.repeat(1_100) },
      author: { name: 'a'.repeat(300) }, fields: Array.from({ length: 30 }, () => ({ name: 'n'.repeat(300), value: 'v'.repeat(1_100) })) }],
    components: [{ components: [{ custom_id: 'i'.repeat(120), label: 'l'.repeat(100), url: 'http://not-allowed' },
      { custom_id: 'good', label: 'good', url: 'https://discord.com/ok' }], options: Array.from({ length: 30 }, () => ({ label: 'o'.repeat(120), description: 'd'.repeat(120) })) }],
  });
  assert.equal(normalized.nonce.length, 25);
  assert.equal(normalized.embeds[0].fields.length, 25);
  assert.equal(normalized.components[0].components.length, 1);
  assert.equal(normalized.allowedMentions.roles.length, 1);
  assert.match(normalized.content, /@\u200beveryone/);
});

test('notification projections cover failed payments, order links, private Monitor cases, admin, and system variants', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const now = Date.now();
  const client = { users: { fetch: async () => { throw new Error('avatar unavailable'); } } };
  const failedTopup = submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: '12345678901234567',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=d23456789abcdef0123456789abcdef01' }).topup;
  markTopupProcessing(fixture.db, failedTopup.id); failTopup(fixture.db, { topupId: failedTopup.id, reasonCode: 'VOUCHER_EXPIRED' });
  const failedDm = fixture.db.prepare("SELECT * FROM notifications WHERE notification_type='TOPUP_STATUS_DM' AND aggregate_id=?").get(failedTopup.id);
  const failedLog = fixture.db.prepare("SELECT * FROM notifications WHERE notification_type='PAYMENT_LOG' AND aggregate_id=?").get(failedTopup.id);
  assert.match((await renderSqliteNotification({ db: fixture.db, client }, failedDm)).embeds[0].data.title, /ไม่สำเร็จ/);
  assert.equal((await renderSqliteNotification({ db: fixture.db, client }, failedLog)).files.length, 1);

  appendWalletTransaction(fixture.db, { discordUserId: 'projection-buyer', transactionType: 'TOPUP', availableDeltaCents: 900,
    referenceType: 'TEST', referenceId: 'projection-fund', idempotencyKey: 'projection-fund', traceId: randomUUID() });
  fixture.db.prepare(`INSERT INTO quests(quest_id,name,task_type,url,orbs,source,first_seen_at,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run('projection-quest', 'Quest @projection', 'PLAY_ON_DESKTOP', 'https://discord.com/quests/projection', 15, 'CUSTOMER', now, now, now);
  const order = createOrder(fixture.db, { discordUserId: 'projection-buyer', questAccountId: 'projection-account', traceId: randomUUID(),
    items: [{ questId: 'projection-quest', priceCents: 500 }] });
  const item = fixture.db.prepare('SELECT * FROM order_items WHERE order_id=?').get(order.id);
  settleOrderItem(fixture.db, { itemId: item.id, outcome: 'SUCCESS', verified: true, claimUrl: 'https://discord.com/quests/projection' });
  const history = fixture.db.prepare("SELECT * FROM notifications WHERE notification_type='QUEST_HISTORY' AND aggregate_id=?").get(order.id);
  fixture.db.prepare("UPDATE notifications SET message_id='history-message' WHERE id=?").run(history.id);
  const orderDm = fixture.db.prepare("SELECT * FROM notifications WHERE notification_type='ORDER_STATUS_DM' AND aggregate_id=?").get(order.id);
  assert.equal((await renderSqliteNotification({ db: fixture.db, client, config: { surfaces: { QUEST_HISTORY: { channelId: 'history-channel' } } },
    env: { DISCORD_GUILD_ID: 'guild' } }, orderDm)).components[0].components.length, 2);

  fixture.db.prepare("UPDATE quests SET monitor_status='FOUND_READY',artwork_url='not-a-url' WHERE quest_id='projection-quest'").run();
  const caseNotification = enqueueNotification(fixture.db, { notificationType: 'CUSTOMER_QUEST_DISCOVERY', aggregateType: 'QUEST',
    aggregateId: 'projection-quest', destination: 'LOG_QUEST_OPERATIONS', payload: { discordUserId: '12345678901234567' } });
  assert.equal((await renderSqliteNotification({ db: fixture.db, client }, caseNotification)).components.length, 1);

  const auditId = randomUUID();
  fixture.db.prepare(`INSERT INTO admin_audit(id,actor_id,action,target_type,target_id,reason,before_json,after_json,trace_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(auditId, 'SYSTEM', 'FEATURE_GATE_CHANGE', 'FEATURE_GATE', 'STORE_OPEN', 'test',
    JSON.stringify({ gate: 'STORE_OPEN', enabled: false }), JSON.stringify({ gate: 'STORE_OPEN', enabled: true }), randomUUID(), now);
  const audit = enqueueNotification(fixture.db, { notificationType: 'ADMIN_LOG', aggregateType: 'ADMIN_AUDIT', aggregateId: auditId, destination: 'LOG_ADMIN' });
  assert.equal((await renderSqliteNotification({ db: fixture.db, client }, audit)).files.length, 2);
  const system = enqueueNotification(fixture.db, { notificationType: 'SYSTEM_LOG', aggregateType: 'SYSTEM', aggregateId: 'system-case', destination: 'LOG_SYSTEM',
    payload: { code: 'SQLITE_INTEGRITY_FAILED', scope: 'DATABASE', resolved: true, occurrenceCount: 2, lastSeenAt: now } });
  assert.equal((await renderSqliteNotification({ db: fixture.db, client }, system)).files.length, 2);

  const announcement = enqueueNotification(fixture.db, { notificationType: 'QUEST_NEW', aggregateType: 'QUEST', aggregateId: 'projection-quest', destination: 'QUEST_NEW' });
  const announcementPayload = await renderSqliteNotification({ db: fixture.db, client }, announcement);
  assert.match(announcementPayload.embeds[0].data.description, /15 Discord Orbs/);
});

test('notification delivery edits checkpointed messages, replaces only confirmed 404s, and retries permission failures', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const baseRuntime = (channel) => ({ db: fixture.db, config: { surfaces: { LOG_SYSTEM: { channelId: 'system-channel' } } },
    client: { channels: { fetch: async () => channel } } });
  const editMessage = { id: 'checkpointed', edit: async () => editMessage };
  const editChannel = { isTextBased: () => true, messages: { fetch: async (value) => (typeof value === 'string' ? editMessage : new Map()) },
    send: async () => { throw new Error('must not send'); } };
  const edited = enqueueNotification(fixture.db, { notificationType: 'SYSTEM_LOG', aggregateType: 'SYSTEM', aggregateId: 'edit-checkpoint', destination: 'LOG_SYSTEM' });
  fixture.db.prepare("UPDATE notifications SET message_id='checkpointed' WHERE id=?").run(edited.id);
  await deliverNotification(baseRuntime(editChannel), claimDueNotification(fixture.db));
  assert.equal(fixture.db.prepare('SELECT state FROM notifications WHERE id=?').get(edited.id).state, 'DELIVERED');

  let sent = 0;
  const recreateChannel = { isTextBased: () => true, messages: { fetch: async (value) => {
    if (typeof value === 'string') throw Object.assign(new Error('unknown message'), { status: 404, code: 10008 });
    return new Map();
  } }, send: async () => { sent += 1; return { id: 'replacement', edit: async () => null }; } };
  const missing = enqueueNotification(fixture.db, { notificationType: 'SYSTEM_LOG', aggregateType: 'SYSTEM', aggregateId: 'missing-checkpoint', destination: 'LOG_SYSTEM' });
  fixture.db.prepare("UPDATE notifications SET message_id='missing-message' WHERE id=?").run(missing.id);
  await deliverNotification(baseRuntime(recreateChannel), claimDueNotification(fixture.db));
  assert.equal(sent, 1);

  const forbiddenChannel = { isTextBased: () => true, messages: { fetch: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); } },
    send: async () => { throw new Error('must not send after 403'); } };
  const forbidden = enqueueNotification(fixture.db, { notificationType: 'SYSTEM_LOG', aggregateType: 'SYSTEM', aggregateId: 'forbidden-checkpoint', destination: 'LOG_SYSTEM' });
  fixture.db.prepare("UPDATE notifications SET message_id='forbidden-message' WHERE id=?").run(forbidden.id);
  await deliverNotification(baseRuntime(forbiddenChannel), claimDueNotification(fixture.db));
  assert.equal(fixture.db.prepare('SELECT state FROM notifications WHERE id=?').get(forbidden.id).state, 'RETRY_WAIT');
});

test('payment worker moves missing settlement credentials to review without external redemption', async (t) => {
  const fixture = await database(); t.after(() => fixture.close());
  const topup = submitTopup(fixture.db, { QUESTSHOP_SECRET_KEY: secret }, { discordUserId: 'no-receiver',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=e23456789abcdef0123456789abcdef01' }).topup;
  await processPaymentJob({ db: fixture.db, env: { QUESTSHOP_SECRET_KEY: secret }, abortController: new AbortController() },
    claimDueJob(fixture.db, { jobType: 'PAYMENT_SETTLE' }));
  assert.equal(fixture.db.prepare('SELECT status FROM topups WHERE id=?').get(topup.id).status, 'REVIEW');
  assert.equal(fixture.db.prepare("SELECT state FROM manual_reviews WHERE subject_id=? AND subject_type='TOPUP'").get(topup.id).state, 'OPEN');
});

test('Quest executor contracts validate unsupported, invalid, and verified video paths', async () => {
  assert.throws(() => assertQuestExecutorContract({}), /non-empty id/);
  assert.throws(() => defineQuestExecutor({ id: 'broken', supportsAutomaticProgress: true }), /missing matches/);
  assert.equal(selectQuestExecutor({ eventName: 'UNKNOWN' }).id, 'unknown');
  assert.equal(selectQuestExecutor({ eventName: 'WATCH_VIDEO' }).id, 'video');
  assert.equal(selectQuestExecutor({ eventName: 'WATCH_VIDEO', autoSupported: false }).id, 'unsupported');
  assert.equal(listExecutorCapabilities().some((entry) => entry.id === 'video'), true);
  assert.equal(nextVideoTimestamp(0, 10, Number.NaN), 1);
  assert.equal(nextVideoTimestamp(0, 10, Date.now() - 30_000, Date.now()), 10);
  await assert.rejects(executeQuestExecutor(videoExecutor, { quest: { id: 'q', secondsNeeded: 0 } }), /invalid target/);
  const executor = defineQuestExecutor({ id: 'verified', supportsAutomaticProgress: true, matches: () => true,
    validate: () => true, estimateDuration: () => 0, execute: async () => ({ done: true }), verify: async () => true, describeUnsupportedReason: () => null });
  assert.deepEqual(await executeQuestExecutor(executor, { quest: {} }), { executionResult: { done: true }, verified: true });
});

test('desktop executor verifies progressing and terminal-heartbeat Quest states', async () => {
  assert.equal(desktopExecutor.matches('PLAY_ON_DESKTOP'), true);
  assert.equal(desktopExecutor.matches({ eventName: 'OTHER' }), false);
  assert.equal(desktopExecutor.estimateDuration({ secondsNeeded: 0, progressSecs: 2 }), 0);
  assert.deepEqual(desktopExecutor.validate({}), { ok: false, issues: ['missing id'] });
  await assert.rejects(executeQuestExecutor(desktopExecutor, { quest: { id: 'bad', secondsNeeded: 0 } }), /invalid target/);
  let first = true;
  const progressing = { id: 'desktop-1', eventName: 'PLAY_ON_DESKTOP', progressSecs: 0, secondsNeeded: 1, completed: false, applicationId: 'app' };
  const context = { quest: progressing, signal: new AbortController().signal, now: Date.now, sleep: async () => {},
    mutate: async (_kind, _evidence, send) => send(), api: { sendHeartbeat: async () => {} },
    fetchFreshQuest: async () => ({ ...progressing, progressSecs: 1, completed: first ? (first = false, true) : true }), onServerProgress: async () => {} };
  assert.equal((await executeQuestExecutor(desktopExecutor, context)).verified, true);
  const terminal = { ...context, quest: { id: 'desktop-2', eventName: 'PLAY_ON_DESKTOP_V2', progressSecs: 1, secondsNeeded: 1, completed: false },
    fetchFreshQuest: async () => ({ id: 'desktop-2', completed: true, progressSecs: 1 }) };
  assert.equal((await executeQuestExecutor(desktopExecutor, terminal)).verified, true);
  const stalled = { ...context, quest: { id: 'desktop-stalled', eventName: 'PLAY_ON_DESKTOP', progressSecs: 0, secondsNeeded: 1, completed: false, applicationId: 'app' },
    fetchFreshQuest: async () => ({ id: 'desktop-stalled', progressSecs: 0, secondsNeeded: 1, completed: false, applicationId: 'app' }) };
  await assert.rejects(executeQuestExecutor(desktopExecutor, stalled), /did not confirm desktop progress/);
});

test('video executor reports server progress and confirms completion', async () => {
  assert.equal(videoExecutor.matches('WATCH_VIDEO_ON_MOBILE'), true);
  assert.equal(videoExecutor.matches({ eventName: 'OTHER' }), false);
  assert.equal(videoExecutor.estimateDuration({ secondsNeeded: 10, progressSecs: 20 }), 0);
  assert.deepEqual(videoExecutor.validate({}), { ok: false, issues: ['missing id'] });
  const quest = { id: 'video-1', eventName: 'WATCH_VIDEO', progressSecs: 0, secondsNeeded: 1, completed: false };
  let progress = 0;
  const result = await executeQuestExecutor(videoExecutor, { quest, signal: new AbortController().signal, now: Date.now, sleep: async () => {},
    mutate: async (_kind, _evidence, send) => send(), api: { sendVideoProgress: async () => {} },
    fetchFreshQuest: async () => ({ ...quest, progressSecs: ++progress, completed: true }), onServerProgress: async () => {} });
  assert.equal(result.verified, true);
});
