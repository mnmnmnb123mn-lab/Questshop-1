import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProjection } from '../../src/discord/renderers/projections.js';
import { redactAuditState, serializeAuditState } from '../../src/domain/admin/audit.js';
import { encryptSecret } from '../../src/adapters/crypto/keyring.js';
import { adminActionLabel, incidentDefinition } from '../../src/discord/renderers/backoffice-language.js';
import {
  QUEST_HISTORY_BANNER_ATTACHMENT_URL, QUEST_HISTORY_BANNER_FILENAME, QUEST_HISTORY_BANNER_SIZE,
  loadQuestHistoryBanner,
} from '../../src/discord/surfaces/quest-history-media.js';
import {
  PAYMENT_LOG_BANNER_ATTACHMENT_URL, PAYMENT_LOG_BANNER_FILENAME, PAYMENT_LOG_BANNER_SIZE,
  loadPaymentLogBanner,
} from '../../src/discord/surfaces/payment-log-media.js';
import {
  BACKOFFICE_LOG_BANNER_ATTACHMENT_URL, BACKOFFICE_LOG_BANNER_FILENAME, BACKOFFICE_LOG_BANNER_SIZE,
  LOG_SYSTEM_THUMBNAIL_ATTACHMENT_URL, LOG_SYSTEM_THUMBNAIL_FILENAME, LOG_SYSTEM_THUMBNAIL_SIZE,
  loadBackofficeLogBanner, loadLogSystemThumbnail,
} from '../../src/discord/surfaces/backoffice-log-media.js';

test('history projection renders truthful released and review terminal states', async () => {
  const pool = { query: async (sql) => {
    if (sql.includes('FROM order_items i JOIN orders')) return { rows: [{ id: 'item', state: 'FAILED_RELEASED',
      account_username: 'Quest account', account_avatar_url: null, order_id: 'order', quest_url: 'https://discord.com/quests/quest',
      quest_name: 'Quest', progress_bucket: 25, trace_id: '019fc886-ffcd-70e3-bd14-fb61772e84c7',
      reservation_state: 'RELEASED', reservation_amount: 500, terminal_reason: 'EXECUTOR_FAILED', updated_at: new Date() }] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const body = await renderProjection(pool, { projection_type: 'QUEST_HISTORY', aggregate_id: 'item' });
  assert.match(body.embeds[0].data.title, /คืนเครดิตแล้ว/);
  assert.match(body.embeds[0].data.description, /คืนเครดิตแล้ว/);
  assert.match(body.embeds[0].data.description, /\*\*\[Quest — 25%\]\(https:\/\/discord\.com\/quests\/quest\)\*\*/);
  assert.match(body.embeds[0].data.description, /\*\*ค่าบริการ:\*\* 5\.00 บาท/);
  assert.doesNotMatch(body.embeds[0].data.description, /Account ID|Support:|ราคา\/ยอดจอง/);
  assert.doesNotMatch(body.embeds[0].data.description, /FAILED_RELEASED|RELEASED/);
  assert.deepEqual(body.components, []);
  assert.equal(body.embeds[0].data.image.url, QUEST_HISTORY_BANNER_ATTACHMENT_URL);
  assert.equal(body.files[0].name, QUEST_HISTORY_BANNER_FILENAME);
  assert.equal(body.files[0].attachment.length, QUEST_HISTORY_BANNER_SIZE);
  assert.deepEqual([...body.attachments], []);
});

test('Quest History banner is the exact RGB 461x8 PNG asset', async () => {
  const banner = await loadQuestHistoryBanner();
  assert.equal(banner.length, QUEST_HISTORY_BANNER_SIZE);
  assert.deepEqual([...banner.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(banner.readUInt32BE(16), 461);
  assert.equal(banner.readUInt32BE(20), 8);
  assert.equal(banner[24], 8);
  assert.equal(banner[25], 2);
});

test('Payment Log banner is the exact supplied WebP asset', async () => {
  const banner = await loadPaymentLogBanner();
  assert.equal(banner.length, PAYMENT_LOG_BANNER_SIZE);
  assert.equal(banner.subarray(0, 4).toString(), 'RIFF');
  assert.equal(banner.subarray(8, 12).toString(), 'WEBP');
});

test('backoffice banner and system thumbnail are the exact supplied assets', async () => {
  const [banner, thumbnail] = await Promise.all([loadBackofficeLogBanner(), loadLogSystemThumbnail()]);
  assert.equal(banner.length, BACKOFFICE_LOG_BANNER_SIZE);
  assert.equal(banner.subarray(0, 4).toString(), 'RIFF');
  assert.equal(banner.subarray(8, 12).toString(), 'WEBP');
  assert.equal(banner.readUIntLE(24, 3) + 1, 1_536);
  assert.equal(banner.readUIntLE(27, 3) + 1, 26);
  assert.equal(thumbnail.length, LOG_SYSTEM_THUMBNAIL_SIZE);
  assert.equal(thumbnail.subarray(0, 6).toString(), 'GIF89a');
  assert.equal(thumbnail.readUInt16LE(6), 498);
  assert.equal(thumbnail.readUInt16LE(8), 498);
  assert.ok([...thumbnail].filter((byte) => byte === 0x2c).length > 1);
});

test('every source-emitted admin action and system incident has readable Thai copy', () => {
  const actions = ['ACTIVATE_RECEIVER', 'ADD_MONITOR', 'CIRCUIT_BREAKER_CHANGE', 'CUSTOMER_DISCOVERY_FORCE_PUBLISH',
    'CUSTOMER_DISCOVERY_TEST_REQUESTED', 'DLQ_DISCARD', 'DLQ_REPLAY', 'FEATURE_GATE_CHANGE', 'MANUAL_REVIEW_ASSIGNED',
    'MANUAL_REVIEW_EVIDENCE_ADDED', 'MANUAL_REVIEW_RESOLVED', 'MONITOR_HEALTH_CHECK', 'MONITOR_STATE_CHANGE',
    'ORDER_ITEM_REFUND', 'ORDER_ITEM_REVIEW_OPENED', 'PROMOTION_VERSION_REPLACED', 'QUEST_CATEGORY_PRICE_CHANGED',
    'QUEST_TEST_FORCE_PUBLISH', 'ROTATE_MONITOR_CREDENTIAL', 'RUNTIME_CONFIG_CHANGE', 'SURFACE_RECONCILED',
    'SURFACE_SETUP', 'TOPUP_DAILY_LOCK_CLEARED', 'TOPUP_DAILY_LOCK_CREATED', 'TOPUP_DAILY_LOCK_EXPIRED',
    'TOPUP_MANUAL_CREDIT_CONFIRMATION_PREPARED', 'TOPUP_REVERSAL_REVIEW_OPENED', 'TOPUP_REVERSED'];
  const incidents = ['BACKUP_FAILED', 'BACKUP_RETENTION_FAILED', 'DISCORD_CONNECTIVITY', 'DISCORD_SURFACE_FORBIDDEN',
    'DISCORD_SURFACE_RECONCILE_FAILED', 'FINANCIAL_INVARIANT', 'OUTBOX_STUCK', 'PANEL_LATENCY_SLO', 'PAYMENT_QUEUE_STUCK',
    'PROVIDER_SCHEMA_CHANGED', 'QUEST_CONTRACT_FAILURE', 'RUNNER_QUEUE_STATE_MISMATCH', 'SECRET_DECRYPT_FAILED',
    'TOPUP_AMOUNT_OVER_AUTOCREDIT_LIMIT', 'TOPUP_REDEEMED_STUCK', 'WORKER_HEARTBEAT_MISSING'];
  for (const action of actions) assert.doesNotMatch(adminActionLabel(action), /[A-Z_]{4,}/);
  for (const code of incidents) assert.doesNotMatch(incidentDefinition(code).title, /[A-Z_]{4,}/);
});

test('automatic incidents do not tell operators to act and admin keeps user-entered reasons', async () => {
  const trace = '019fc886-ffcd-70e3-bd14-fb61772e84c7';
  const incident = await renderProjection({ query: async () => ({ rows: [{ id: 'incident',
    incident_code: 'OUTBOX_STUCK', state: 'OPEN', severity: 'ERROR', scope: 'DISCORD', occurrence_count: 1,
    evidence: { stuck: 2, pending: 2, leased: 0, oldest_age_ms: 5_000 }, trace_id: trace, updated_at: new Date() }] }) },
  { projection_type: 'SYSTEM_INCIDENT', aggregate_id: 'incident' });
  assert.match(incident.embeds[0].data.description, /การจัดการ.*ระบบกำลังส่งซ้ำเอง/);
  assert.doesNotMatch(incident.embeds[0].data.description, /ควรทำ|ผู้ดูแลต้องตรวจ/);

  const audit = await renderProjection({ query: async () => ({ rows: [{ id: 'audit', actor_id: '123456789012345678',
    target_type: 'CONFIG', target_id: '2', action: 'RUNTIME_CONFIG_CHANGE', reason: 'OWNER_REQUEST_2026',
    before_state: { topupDailyLimitCents: '5000' }, after_state: { topupDailyLimitCents: '10000' },
    correlation_code: 'REFERENCE', trace_id: trace, created_at: new Date() }] }) },
  { projection_type: 'ADMIN_AUDIT', aggregate_id: 'audit' });
  assert.match(audit.embeds[0].data.description, /วงเงินเติมต่อวัน.*50\.00 บาท → 100\.00 บาท/);
  assert.match(audit.embeds[0].data.description, /OWNER\\_REQUEST\\_2026/);
});

test('history projection keeps the profile thumbnail and claim button for a successful linked Quest', async () => {
  const pool = { query: async () => ({ rows: [{ state: 'READY_TO_CLAIM', account_username: 'Quest account',
    account_avatar_url: 'https://cdn.discordapp.com/avatars/account.png', order_id: 'order',
    quest_url: 'https://discord.com/quests/quest', quest_name: 'Quest', progress_bucket: 100,
    reservation_state: 'CAPTURED', reservation_amount: 500, claim_url: 'https://discord.com/quests/quest',
    terminal_reason: null, updated_at: new Date() }] }) };
  const body = await renderProjection(pool, { projection_type: 'QUEST_HISTORY', aggregate_id: 'item' });
  assert.equal(body.embeds[0].data.thumbnail.url, 'https://cdn.discordapp.com/avatars/account.png');
  assert.match(body.embeds[0].data.description, /\*\*\[Quest — 100%\]\(https:\/\/discord\.com\/quests\/quest\)\*\*/);
  assert.equal(body.components[0].components[0].data.label, 'รับรางวัล Quest นี้');
  assert.equal(body.files.length, 1);
});

test('quest-new projection does not expose internal sale state', async () => {
  const pool = { query: async () => ({ rows: [{ quest_id: 'q', task_type: 'WATCH_VIDEO', task_target: 60,
    orbs: 10, price_cents: 500, name: 'New Quest', detected_at: new Date(), updated_at: new Date(),
    expires_at: new Date(), url: 'https://discord.com/quests/q', sale_state: 'OPEN' }] }) };
  const body = await renderProjection(pool, { projection_type: 'QUEST_NEW', aggregate_id: 'q' });
  assert.doesNotMatch(body.embeds[0].data.description, /OPEN|WATCH(?:_\\)?VIDEO|สถานะการรับงาน/);
  assert.doesNotMatch(body.embeds[0].data.description, /สถานะ:/);
  assert.equal(body.embeds[0].data.footer, undefined);
  assert.match(body.embeds[0].data.description, /ดูวิดีโอ/);
  assert.match(body.embeds[0].data.description, /ดู Quest ได้ที่นี่/);
});

test('customer Quest discovery stays in the backoffice until an Admin chooses its path', async () => {
  const found = {
    id: '019fc886-ffcd-70e3-bd14-fb61772e84c7', state: 'PENDING', discord_user_id: '123456789012345678',
    account_id: 'quest-account', account_username: 'Quest account', account_avatar_url: null,
    quest_id: 'customer-quest', name: 'Customer Quest', task_type: 'WATCH_VIDEO', executor_id: 'video',
    sale_state: 'CLOSED', checkout_session_id: 'session', trace_id: '019fc886-ffcd-70e3-bd14-fb61772e84c7', created_at: new Date(),
  };
  const pool = { query: async () => ({ rows: [found] }) };
  const body = await renderProjection(pool, { projection_type: 'CUSTOMER_QUEST_DISCOVERY', aggregate_id: found.id });
  assert.match(body.embeds[0].data.description, /รอผู้ดูแลตัดสินใจ/);
  assert.doesNotMatch(body.embeds[0].data.description, /เปิดขายสาธารณะ/);
  assert.deepEqual(body.components[0].components.map((button) => button.data.label), ['ส่งประกาศ', 'ทดสอบก่อน']);
  assert.deepEqual(body.allowedMentions, { users: [found.discord_user_id], parse: [] });
  assert.equal(body.embeds[0].data.image.url, BACKOFFICE_LOG_BANNER_ATTACHMENT_URL);
  assert.deepEqual(body.files.map((file) => file.name), [BACKOFFICE_LOG_BANNER_FILENAME]);
  assert.deepEqual(body.attachments, []);

  const terminal = await renderProjection({ query: async () => ({ rows: [{ ...found, state: 'PUBLISHED' }] }) },
    { projection_type: 'CUSTOMER_QUEST_DISCOVERY', aggregate_id: found.id });
  assert.deepEqual(terminal.components, []);
  assert.match(terminal.embeds[0].data.description, /ประกาศ Quest แล้ว/);
});

test('dynamic projection metadata stays inside Discord embed limits', async () => {
  const long = `ชื่อ Quest ที่ยาวมาก ${'x'.repeat(10_000)}`;
  const pool = { query: async () => ({ rows: [{ quest_id: 'q', task_type: 'WATCH_VIDEO', task_target: 60,
    orbs: 10, price_cents: 500, name: long, detected_at: new Date(), updated_at: new Date(),
    expires_at: new Date(), url: 'https://discord.com/quests/q', sale_state: 'OPEN' }] }) };
  const body = await renderProjection(pool, { projection_type: 'QUEST_NEW', aggregate_id: 'q' });
  assert.ok(body.embeds[0].data.title.length <= 256);
  assert.ok(body.embeds[0].data.description.length <= 4_096);
});

test('refund and quest-new projections render safe fallbacks when their aggregate row disappeared', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const client = { users: { fetch: async () => { throw new Error('must not fetch a missing refund user'); } } };
  const refund = await renderProjection(pool, { projection_type: 'REFUND_LOG', aggregate_id: 'missing' }, { client });
  const quest = await renderProjection(pool, { projection_type: 'QUEST_NEW', aggregate_id: 'missing' });
  assert.equal(refund.embeds[0].data.title, 'ไม่พบ Refund Log');
  assert.equal(quest.embeds[0].data.title, 'ไม่พบข้อมูล Quest ใหม่');
  assert.deepEqual(refund.allowedMentions, { parse: [] });
  assert.deepEqual(quest.allowedMentions, { parse: [] });
});

test('customer receives a safe status DM for manual review or a rejected top-up', async () => {
  const pool = { query: async () => ({ rows: [{ id: 'topup', status: 'MANUAL_REVIEW',
    failure_code: 'AMBIGUOUS_PROVIDER_RESULT', updated_at: new Date() }] }) };
  const manual = await renderProjection(pool, { projection_type: 'TOPUP_STATUS_DM', aggregate_id: 'topup' });
  assert.match(manual.embeds[0].data.title, /กำลังตรวจสอบ/);
  assert.match(manual.embeds[0].data.description, /ยังไม่ได้เพิ่มเครดิต/);
  const rejected = await renderProjection({ query: async () => ({ rows: [{ id: 'topup', status: 'REJECTED',
    failure_code: 'OWNER_REJECTED', updated_at: new Date() }] }) },
  { projection_type: 'TOPUP_STATUS_DM', aggregate_id: 'topup' });
  assert.match(rejected.embeds[0].data.title, /ไม่ได้รับอนุมัติ/);
  assert.match(rejected.embeds[0].data.description, /ไม่ได้เพิ่มเครดิต/);
});

test('order DM uses Discord link buttons instead of markdown action links', async () => {
  const pool = { query: async (sql) => {
    if (sql.includes('FROM order_aggregates')) return { rows: [{ id: 'order', account_username: 'Account',
      total_items: 3, captured_items: 2, released_items: 1, review_items: 0 }] };
    if (sql.includes('FROM order_items i LEFT JOIN wallet_reservations')) return { rows: [
      { id: 'item-1', sequence_number: 1, quest_name: 'Quest 1', state: 'READY_TO_CLAIM', price_cents: 500,
        claim_url: 'https://discord.com/quests/first', terminal_reason: null, reservation_state: 'CAPTURED',
        amount_cents: 500, message_id: 'message-1' },
      { id: 'item-2', sequence_number: 2, quest_name: 'Quest 2', state: 'READY_TO_CLAIM', price_cents: 500,
        claim_url: 'https://discord.com/quests/second', terminal_reason: null, reservation_state: 'CAPTURED',
        amount_cents: 500, message_id: 'message-2' },
      { id: 'item-3', sequence_number: 3, quest_name: 'Quest 3', state: 'FAILED_RELEASED', price_cents: 500,
        claim_url: null, terminal_reason: 'EXECUTOR_FAILED', reservation_state: 'RELEASED',
        amount_cents: 500, message_id: 'message-3' },
    ] };
    if (sql.includes('COALESCE(sum(r.amount_cents)')) return { rows: [{ captured_cents: 1000,
      released_cents: 500, reserved_cents: 0 }] };
    if (sql.includes('SELECT discord_user_id FROM orders')) return { rows: [{ discord_user_id: 'user' }] };
    if (sql.includes('SELECT available_cents,reserved_cents FROM wallets')) return { rows: [{ available_cents: 1000,
      reserved_cents: 0 }] };
    if (sql.includes('SELECT guild_id,channel_id FROM surfaces')) return { rows: [{ guild_id: 'guild', channel_id: 'history' }] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const body = await renderProjection(pool, { projection_type: 'ORDER_DM', aggregate_id: 'order' },
    { env: { DISCORD_GUILD_ID: 'guild' } });
  assert.doesNotMatch(body.embeds[0].data.description, /\[ประวัติ\]|\[รับรางวัล\]/);
  assert.deepEqual(body.components[0].components.map((button) => button.data.label),
    ['รับรางวัลทั้งหมด', 'ดูประวัติ Quest ทั้งหมด']);
  assert.deepEqual(body.components[0].components.map((button) => button.data.url),
    ['https://discord.com/quests/first', 'https://discord.com/channels/guild/history']);
});

test('operational projections bound untrusted evidence without Discord builder failures', async () => {
  const now = new Date();
  const long = '@everyone `evidence` '.repeat(800);
  const pool = { query: async (sql) => {
    if (sql.includes('FROM runner_jobs')) return { rows: [{ id: 'job', state: 'FAILED', quest_name: long,
      item_state: 'WAITING_RETRY', progress_actual: 23.125, progress_bucket: 0, price_cents: 500,
      account_id: 'account', account_username: long, attempt_count: 3, updated_at: now }] };
    if (sql.includes('FROM incidents')) return { rows: [{ id: 'incident', incident_code: long, state: 'OPEN',
      severity: 'CRITICAL', scope: long, trace_id: '019fc886-ffcd-70e3-bd14-fb61772e84c7', evidence: { long }, updated_at: now }] };
    if (sql.includes('FROM admin_audit_logs')) return { rows: [{ id: 'audit', actor_id: '123456789012345678',
      target_type: long, target_id: long, reason: long, correlation_code: 'support', action: long, created_at: now }] };
    if (sql.includes('FROM manual_reviews')) return { rows: [{ id: 'review', subject_type: 'ORDER_ITEM', subject_id: 'item',
      opened_reason: long, financial: true, owner_only: false, assigned_to: long, available_cents: 500,
      reserved_cents: 100, attempt_count: 3, last_error_class: long, evidence_count: 4,
      trace_id: '019fc886-ffcd-70e3-bd14-fb61772e84c7', remind_at: now, state: 'OPEN', created_at: now }] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  for (const projectionType of ['RUNNER_SUMMARY', 'SYSTEM_INCIDENT', 'ADMIN_AUDIT', 'MANUAL_REVIEW']) {
    const body = await renderProjection(pool, { projection_type: projectionType, aggregate_id: projectionType });
    assert.ok(body.embeds[0].data.title.length <= 256);
    assert.ok(body.embeds[0].data.description.length <= 4_096);
    assert.doesNotMatch(body.embeds[0].data.description, /@everyone/);
  }
});

test('system incident is Thai, green when resolved, and exposes route diagnostics without raw JSON', async () => {
  const pool = { query: async () => ({ rows: [{ id: 'incident', incident_code: 'PANEL_LATENCY_SLO', state: 'RESOLVED',
    severity: 'WARNING', scope: 'DISCORD', trace_id: '019fc886-ffcd-70e3-bd14-fb61772e84c7', occurrence_count: 3,
    evidence: { p95Ms: 6_500, samples: 8, topRoutes: [{ route: 'admin_panel', p95Ms: 7_000, samples: 5 }] },
    updated_at: new Date() }] }) };
  const body = await renderProjection(pool, { projection_type: 'SYSTEM_INCIDENT', aggregate_id: 'incident' });
  assert.equal(body.embeds[0].data.color, 0x23a55a);
  assert.match(body.embeds[0].data.description, /กลับมาปกติแล้ว/);
  assert.match(body.embeds[0].data.description, /ส่วนที่ช้าที่สุด.*แผงผู้ดูแล/);
  assert.match(body.embeds[0].data.description, /เกิดซ้ำ:\*\* 3 ครั้ง/);
  assert.doesNotMatch(body.embeds[0].data.description, /\{"p95Ms"|Questshop Surface/);
  assert.equal(body.embeds[0].data.image.url, BACKOFFICE_LOG_BANNER_ATTACHMENT_URL);
  assert.equal(body.embeds[0].data.thumbnail.url, LOG_SYSTEM_THUMBNAIL_ATTACHMENT_URL);
  assert.deepEqual(body.files.map((file) => file.name), [BACKOFFICE_LOG_BANNER_FILENAME, LOG_SYSTEM_THUMBNAIL_FILENAME]);
});

test('backoffice thumbnails use safe stored, fetched, and system-logo sources', async () => {
  const now = new Date();
  const client = { users: { fetch: async (id) => ({ displayAvatarURL: () => `https://cdn.discordapp.com/${id}.png` }) } };
  const checkoutPool = { query: async (sql) => ({ rows: sql.includes('SELECT quest_name') ? [] : [{
    id: 'checkout', payload: { username: 'Account', accountId: '123456789012345678' }, option_count: 1,
    selected_count: 0, selected_total_cents: 0, state: 'ACTIVE', trace_id: 'trace', expires_at: now, created_at: now,
  }] }) };
  const checkout = await renderProjection(checkoutPool, { projection_type: 'CHECKOUT_AUDIT', aggregate_id: 'checkout' }, { client });
  assert.equal(checkout.embeds[0].data.thumbnail.url, 'https://cdn.discordapp.com/123456789012345678.png');

  const discovery = await renderProjection({ query: async () => ({ rows: [{ id: 'discovery', state: 'PENDING',
    discord_user_id: '223456789012345678', account_id: '323456789012345678', account_username: 'Account',
    account_avatar_url: null, quest_id: 'quest', name: 'Quest', task_type: 'WATCH_VIDEO', sale_state: 'CLOSED',
    checkout_session_id: 'session', trace_id: 'trace', created_at: now }] }) },
  { projection_type: 'CUSTOMER_QUEST_DISCOVERY', aggregate_id: 'discovery' }, { client });
  assert.equal(discovery.embeds[0].data.thumbnail.url, 'https://cdn.discordapp.com/323456789012345678.png');

  const quest = await renderProjection({ query: async () => ({ rows: [{ quest_id: 'quest', name: 'Quest', task_type: 'WATCH_VIDEO',
    analysis_state: 'SUPPORTED', sale_state: 'OPEN', announcement_state: 'ANNOUNCED', executor_id: 'video', test_attempts: 1,
    latest_test_state: 'TEST_PASSED', artwork_url: 'https://cdn.discordapp.com/quest.png', trace_id: 'trace', updated_at: now }] }) },
  { projection_type: 'QUEST_OPERATION', aggregate_id: 'quest' });
  assert.equal(quest.embeds[0].data.thumbnail.url, 'https://cdn.discordapp.com/quest.png');

  const testFailure = await renderProjection({ query: async () => ({ rows: [{ id: 'alert', state: 'OPEN', name: 'Quest',
    quest_id: 'quest', batch_id: 'batch', task_type: 'WATCH_VIDEO', attempts: 1, monitor_count: 1,
    latest_monitor_account_id: '123456789012345678', artwork_url: 'https://cdn.discordapp.com/fallback.png',
    sale_state: 'CLOSED', trace_id: 'trace', updated_at: now }] }) },
  { projection_type: 'QUEST_TEST_FAILURE', aggregate_id: 'alert' }, {
    client: { users: { fetch: async () => ({ displayAvatarURL: () => 'javascript:unsafe' }) } },
  });
  assert.equal(testFailure.embeds[0].data.thumbnail.url, 'https://cdn.discordapp.com/fallback.png');

  const runner = await renderProjection({ query: async () => ({ rows: [{ id: 'job', state: 'RUNNING',
    order_id: 'order', quest_id: 'quest', order_item_id: 'item', quest_name: 'Quest', item_state: 'RUNNING',
    progress_actual: 25, progress_bucket: 25, price_cents: 500, account_id: '423456789012345678',
    account_username: 'Account', account_avatar_url: null, attempt_count: 1, trace_id: 'trace', updated_at: now }] }) },
  { projection_type: 'RUNNER_SUMMARY', aggregate_id: 'job' }, { client });
  assert.equal(runner.embeds[0].data.thumbnail.url, 'https://cdn.discordapp.com/423456789012345678.png');

  const admin = await renderProjection({ query: async () => ({ rows: [{ id: 'audit', actor_id: 'SYSTEM', target_type: 'CONFIG',
    target_id: 'config', action: 'RUNTIME_CONFIG_CHANGE', reason: 'system update', before_state: {}, after_state: {},
    correlation_code: 'reference', trace_id: 'trace', created_at: now }] }) }, { projection_type: 'ADMIN_AUDIT', aggregate_id: 'audit' });
  assert.equal(admin.embeds[0].data.image.url, BACKOFFICE_LOG_BANNER_ATTACHMENT_URL);
  assert.equal(admin.embeds[0].data.thumbnail.url, LOG_SYSTEM_THUMBNAIL_ATTACHMENT_URL);
  assert.deepEqual(admin.files.map((file) => file.name), [BACKOFFICE_LOG_BANNER_FILENAME, LOG_SYSTEM_THUMBNAIL_FILENAME]);

  const adminUser = await renderProjection({ query: async () => ({ rows: [{ id: 'audit', actor_id: '523456789012345678',
    target_type: 'CONFIG', target_id: 'config', action: 'RUNTIME_CONFIG_CHANGE', reason: 'update',
    before_state: {}, after_state: {}, correlation_code: 'reference', trace_id: 'trace', created_at: now }] }) },
  { projection_type: 'ADMIN_AUDIT', aggregate_id: 'audit' }, { client });
  assert.equal(adminUser.embeds[0].data.thumbnail.url, 'https://cdn.discordapp.com/523456789012345678.png');
  assert.deepEqual(adminUser.files.map((file) => file.name), [BACKOFFICE_LOG_BANNER_FILENAME]);
});

test('credited payment log matches the confirmed Thai format and profile thumbnail', async () => {
  const key = Buffer.alloc(32, 1).toString('base64');
  const keyring = { current: 1, keys: { 1: key } };
  const encrypted = encryptSecret(JSON.stringify({ url: 'https://gift.truemoney.com/campaign/?v=ABCDEFGHIJKLMNO' }), keyring,
    'topup:topup:guild');
  const topup = { id: 'topup', status: 'CREDITED', discord_user_id: '123456789012345678',
    ...{ key_version: encrypted.keyVersion, nonce: encrypted.nonce, ciphertext: encrypted.ciphertext, auth_tag: encrypted.authTag },
    trace_id: '019fc886-ffcd-70e3-bd14-fb61772e84c7',
    receiver_phone_last4: '1234', attempts: 1, amount_cents: 5_000, bonus_cents: 500, available_before: 1_000,
    available_after: 6_500, reserved_before: 0, reserved_after: 0, provider_transaction_id: 'provider-transaction',
    wallet_transaction_id: 'wallet-transaction', warning_code: null, failure_code: null, updated_at: new Date() };
  const pool = { query: async () => ({ rows: [topup] }) };
  const body = await renderProjection(pool, { projection_type: 'PAYMENT_LOG', aggregate_id: 'topup' }, {
    env: { DATA_ENCRYPTION_KEYS_JSON: keyring, DISCORD_GUILD_ID: 'guild' },
    client: { users: { fetch: async () => ({ displayAvatarURL: () => 'https://cdn.discordapp.com/avatar.png' }) } },
  });
  assert.equal(body.embeds[0].data.title, '✅ เติมเงินสำเร็จ');
  assert.match(body.embeds[0].data.description, /สถานะ:\*\* เติมเงินสำเร็จ/);
  assert.match(body.embeds[0].data.description, /https:\/\/gift\.truemoney\.com/);
  assert.match(body.embeds[0].data.description, /ยอดเงินต้น:\*\* 50\.00 บาท/);
  assert.match(body.embeds[0].data.description, /โบนัส:\*\* 5\.00 บาท/);
  assert.match(body.embeds[0].data.description, /Wallet ก่อน\/หลัง:\*\* 10\.00 บาท → 65\.00 บาท/);
  assert.match(body.embeds[0].data.description, /ยอดจองก่อน\/หลัง:\*\* 0\.00 บาท → 0\.00 บาท/);
  assert.match(body.embeds[0].data.description, /เบอร์รับเงิน:\*\* `••••1234`/);
  assert.match(body.embeds[0].data.description, /Trace:/);
  assert.doesNotMatch(body.embeds[0].data.description, /Reserved|Receiver snapshot|ข้อมูลวินิจฉัย|เหตุผล|sender_phone|ciphertext/);
  assert.equal(body.embeds[0].data.thumbnail.url, 'https://cdn.discordapp.com/avatar.png');
  assert.equal(body.embeds[0].data.image.url, PAYMENT_LOG_BANNER_ATTACHMENT_URL);
  assert.equal(body.files[0].name, PAYMENT_LOG_BANNER_FILENAME);
  assert.equal(body.files[0].attachment.length, PAYMENT_LOG_BANNER_SIZE);
  assert.deepEqual([...body.attachments], []);
});

test('payment log renders queued and exceptional states with safe conditional reasons', async () => {
  const base = { id: 'topup', discord_user_id: '123456789012345678', key_version: null,
    trace_id: '019fc886-ffcd-70e3-bd14-fb61772e84c7', receiver_phone_last4: '1234', attempts: 1,
    amount_cents: null, bonus_cents: null, available_before: null, available_after: null,
    reserved_before: null, reserved_after: null, provider_transaction_id: null, wallet_transaction_id: null,
    warning_code: null, failure_code: null, updated_at: new Date() };
  const cases = [
    ['PAYMENT_QUEUED', 'กำลังรอตรวจสอบซอง', null],
    ['REJECTED', 'รายการถูกปฏิเสธ', 'VOUCHER_REJECTED'],
    ['MANUAL_REVIEW', 'เจ้าของร้านกำลังตรวจสอบ', 'PAYMENT_AMBIGUOUS'],
    ['REVERSED', 'รายการเติมเงินถูกย้อนกลับ', 'REVERSAL_REQUIRED'],
  ];
  for (const [status, expectedLabel, reason] of cases) {
    const row = { ...base, status, failure_code: reason };
    const body = await renderProjection({ query: async () => ({ rows: [row] }) },
      { projection_type: 'PAYMENT_LOG', aggregate_id: 'topup' }, {
        env: {}, client: { users: { fetch: async () => { throw new Error('Discord unavailable'); } } },
      });
    assert.match(body.embeds[0].data.description, new RegExp(expectedLabel));
    assert.match(body.embeds[0].data.description, /ยอดจองก่อน\/หลัง/);
    assert.match(body.embeds[0].data.description, /เบอร์รับเงิน/);
    assert.equal(body.embeds[0].data.thumbnail, undefined);
    assert.equal(body.embeds[0].data.image.url, PAYMENT_LOG_BANNER_ATTACHMENT_URL);
    assert.equal(body.files[0].name, PAYMENT_LOG_BANNER_FILENAME);
    assert.deepEqual([...body.attachments], []);
    if (reason) assert.match(body.embeds[0].data.description, /เหตุผล:\*\*/);
    else assert.doesNotMatch(body.embeds[0].data.description, /เหตุผล/);
  }
});

test('admin audit renders an allowlisted before-after summary and persistence scrubs secrets', async () => {
  const scrubbed = redactAuditState({ token: 'secret-token', nested: { ciphertext: 'cipher', enabled: true } });
  assert.deepEqual(scrubbed, { token: '[REDACTED]', nested: { ciphertext: '[REDACTED]', enabled: true } });
  assert.doesNotMatch(serializeAuditState({ cookie: 'secret-cookie', version: 2 }), /secret-cookie/);
  const pool = { query: async () => ({ rows: [{ id: 'audit', actor_id: '123456789012345678', target_type: 'FEATURE_GATE',
    target_id: 'TOPUP_ACCEPTING', action: 'FEATURE_GATE_CHANGE', reason: 'maintenance',
    before_state: { enabled: true, token: 'must-not-render' }, after_state: { enabled: false, reason: 'maintenance' },
    correlation_code: 'SUPPORT', trace_id: '019fc886-ffcd-70e3-bd14-fb61772e84c7', created_at: new Date() }] }) };
  const body = await renderProjection(pool, { projection_type: 'ADMIN_AUDIT', aggregate_id: 'audit' });
  assert.match(body.embeds[0].data.description, /การใช้งาน:\*\* เปิด → ปิด/);
  assert.match(body.embeds[0].data.description, /รหัสติดตาม/);
  assert.doesNotMatch(body.embeds[0].data.description, /must-not-render|\{"enabled"/);
});

test('backoffice renderer branches keep fallbacks, statuses, and diagnostics safe', async () => {
  const now = new Date();
  const trace = '019fc886-ffcd-70e3-bd14-fb61772e84c7';
  const render = (projectionType, row, dependencies = {}) => renderProjection({
    query: async () => ({ rows: row == null ? [] : [row] }),
  }, { projection_type: projectionType, aggregate_id: 'aggregate' }, dependencies);

  assert.equal((await render('PAYMENT_LOG', null, { env: {}, client: { users: { fetch: async () => null } } })).embeds[0].data.title,
    'ไม่พบ Payment Log');
  const maskedPayment = await render('PAYMENT_LOG', { id: 'topup', status: 'REVERSED', discord_user_id: '1',
    key_version: null, receiver_phone_last4: '1234', attempts: 2, amount_cents: 100, bonus_cents: 0,
    available_before: 200, available_after: 100, reserved_before: 0, reserved_after: 0,
    provider_transaction_id: 'provider', wallet_transaction_id: 'wallet', warning_code: 'WARN', trace_id: trace, updated_at: now },
  { env: {}, client: { users: { fetch: async () => ({ displayAvatarURL: () => 'https://cdn.discordapp.com/avatar.png' }) } } });
  assert.match(maskedPayment.embeds[0].data.description, /หมดอายุแล้ว/);
  assert.equal(maskedPayment.embeds[0].data.thumbnail.url, 'https://cdn.discordapp.com/avatar.png');

  assert.equal((await render('TOPUP_STATUS_DM', null)).embeds[0].data.title, 'ไม่พบสถานะเติมเงิน');
  const genericStatus = await render('TOPUP_STATUS_DM', { id: 'topup', status: 'PROCESSING', updated_at: now });
  assert.match(genericStatus.embeds[0].data.title, /อัปเดตสถานะ/);
  assert.doesNotMatch(genericStatus.embeds[0].data.description, /เหตุผล/);
  assert.equal((await render('QUEST_OPERATION', null)).embeds[0].data.title, 'ไม่พบ Quest Operation');
  const quest = await render('QUEST_OPERATION', { quest_id: 'quest', name: 'Quest', analysis_state: 'SUPPORTED',
    analysis_version: 2, sale_state: 'OPEN', sale_version: 3, announcement_state: 'ANNOUNCED', executor_id: 'video',
    contract_version: '1', test_attempts: 2, latest_test_state: 'PASSED', trace_id: trace, updated_at: now });
  assert.match(quest.embeds[0].data.description, /พร้อมรับทำ/);
  assert.match(quest.embeds[0].data.description, /รหัสติดตาม/);

  assert.equal((await render('CHECKOUT_AUDIT', null)).embeds[0].data.title, 'ไม่พบ Checkout Audit');
  const checkout = await render('CHECKOUT_AUDIT', { payload: { username: 'Account', accountId: 'account',
    avatarUrl: 'not-a-url' }, option_count: 2, selected_count: 1, state: 'QUOTE', trace_id: trace,
    expires_at: now, created_at: now });
  assert.equal(checkout.embeds[0].data.thumbnail, undefined);

  const closedDiscovery = await render('CUSTOMER_QUEST_DISCOVERY', { id: 'discovery', state: 'UNKNOWN',
    discord_user_id: '1', account_id: 'account', account_username: 'Account', account_avatar_url: 'https://cdn.discordapp.com/a.png',
    quest_id: 'quest', name: 'Quest', task_type: 'TYPE', executor_id: 'runner', sale_state: 'CLOSED',
    checkout_session_id: 'session', trace_id: trace, created_at: now });
  assert.deepEqual(closedDiscovery.components, []);
  assert.match(closedDiscovery.embeds[0].data.description, /ระบบยังระบุสถานะไม่ได้/);

  const testAlert = await render('QUEST_TEST_FAILURE', { id: 'alert', state: 'RESOLVED', name: 'Quest', quest_id: 'quest',
    task_type: 'TYPE', attempts: 2, monitor_count: 1, last_error: null, latest_error: { message: 'failed' },
    sale_state: 'CLOSED', trace_id: trace, updated_at: now });
  assert.equal(testAlert.components[0].components.every((button) => button.data.disabled), true);

  assert.equal((await render('MANUAL_REVIEW', null)).embeds[0].data.title, 'ไม่พบ Manual Review');
  const review = await render('MANUAL_REVIEW', { id: 'review', subject_type: 'TOPUP', subject_id: 'topup', opened_reason: 'reason',
    financial: false, owner_only: true, assigned_to: null, available_cents: null, reserved_cents: null, attempt_count: 0,
    last_error_class: null, evidence_count: 0, trace_id: trace, remind_at: now, state: 'OPEN', created_at: now });
  assert.match(review.embeds[0].data.description, /ไม่พบ Wallet/);

  assert.equal((await render('RUNNER_SUMMARY', null)).embeds[0].data.title, 'ไม่พบ Runner Summary');
  const completed = await render('RUNNER_SUMMARY', { id: 'job', state: 'COMPLETED', order_item_id: 'item', quest_name: 'Quest',
    item_state: 'READY_TO_CLAIM', progress_actual: 100, progress_bucket: 100, price_cents: 500, account_id: 'account',
    account_username: 'Account', attempt_count: 1, last_error_class: null, trace_id: trace, updated_at: now });
  assert.equal(completed.embeds[0].data.color, 0x23a55a);
  const failed = await render('RUNNER_SUMMARY', { id: 'job', state: 'FAILED', order_item_id: 'item', quest_name: 'Quest',
    item_state: 'FAILED_RELEASED', progress_actual: 20, progress_bucket: 20, price_cents: 500, account_id: 'account',
    account_username: 'Account', attempt_count: 2, last_error_class: 'TIMEOUT', trace_id: trace, updated_at: now });
  assert.equal(failed.embeds[0].data.color, 0xf23f43);

  const incident = async (incident_code, evidence, state = 'OPEN', severity = 'WARNING') => render('SYSTEM_INCIDENT', {
    id: 'incident', incident_code, state, severity, scope: 'SCOPE', trace_id: trace, occurrence_count: 1,
    evidence, updated_at: now,
  });
  assert.match((await incident('DISCORD_CONNECTIVITY', { surfaces: [] })).embeds[0].data.description, /ส่วนที่ระบุไว้/);
  assert.match((await incident('OUTBOX_STUCK', { stuck: 1, pending: 2, leased: 3, oldest_age_ms: 120_000 })).embeds[0].data.description, /2.0 นาที/);
  assert.match((await incident('ERROR_RATE_HIGH', { failed: 1, total: 20,
    topFailures: [{ route: 'route', errorClass: 'TIMEOUT', failed: 1 }] }, 'OPEN', 'ERROR')).embeds[0].data.description, /จุดที่พบมากสุด/);
  assert.match((await incident('WORKER_HEARTBEAT_MISSING', { workers: ['worker-a', { name: 'worker-b' }] })).embeds[0].data.description, /worker\-a/);
  assert.match((await incident('COUNT', { count: 2 }, 'OPEN', 'CRITICAL')).embeds[0].data.description, /พบ 2/);
  assert.match((await incident('CODE', { code: 'CODE', status: 403 })).embeds[0].data.description, /ระบบตรวจพบเหตุนี้/);
  assert.match((await incident('UNKNOWN', {})).embeds[0].data.description, /ยังระบุรายละเอียดไม่ได้/);

  assert.equal((await render('ADMIN_AUDIT', null)).embeds[0].data.title, 'ไม่พบ Admin Audit');
  const nonUserAudit = await render('ADMIN_AUDIT', { id: 'audit', actor_id: 'SYSTEM', target_type: 'UNKNOWN', target_id: 'id',
    action: 'ACTION', reason: 'reason', before_state: ['value'], after_state: { secret: 'hidden' }, correlation_code: 'CODE',
    trace_id: trace, created_at: now });
  assert.doesNotMatch(nonUserAudit.embeds[0].data.description, /<@/);
  assert.match(nonUserAudit.embeds[0].data.description, /ไม่มีข้อมูลที่ปลอดภัยให้แสดงเพิ่มเติม/);
});

test('operational receipt, refund, order, history and fallback projections cover safe edge cases', async () => {
  const now = new Date();
  const trace = '019fc886-ffcd-70e3-bd14-fb61772e84c7';
  const empty = { query: async () => ({ rows: [] }) };
  assert.equal((await renderProjection(empty, { projection_type: 'TOPUP_RECEIPT', aggregate_id: 'x' })).embeds[0].data.title,
    'ไม่พบใบเสร็จเติมเงิน');
  assert.equal((await renderProjection(empty, { projection_type: 'ORDER_DM', aggregate_id: 'x' })).embeds[0].data.title,
    'สรุป Order ไม่พบ');
  assert.equal((await renderProjection(empty, { projection_type: 'QUEST_HISTORY', aggregate_id: 'x' })).embeds[0].data.title,
    'ไม่พบประวัติ Quest');

  const receipt = await renderProjection({ query: async () => ({ rows: [{ id: 'topup', provider_transaction_id: null,
    amount_cents: 100, bonus_cents: 25, available_before_cents: null, available_after_cents: null,
    available_cents: 125, credited_at: now }] }) }, { projection_type: 'TOPUP_RECEIPT', aggregate_id: 'topup' });
  assert.match(receipt.embeds[0].data.description, /1.25 บาท/);

  const refund = await renderProjection({ query: async () => ({ rows: [{ id: 'refund', discord_user_id: 'customer',
    order_id: 'order', order_item_id: 'item', quest_id: 'quest', quest_name: 'Quest', amount_cents: 500,
    available_before_cents: 0, available_after_cents: 500, reason: 'reason', actor_id: 'SYSTEM',
    transaction_id: 'wallet', trace_id: trace, created_at: now }] }) }, { projection_type: 'REFUND_LOG', aggregate_id: 'refund' },
  { client: { users: { fetch: async () => null } } });
  assert.deepEqual(refund.allowedMentions, { users: ['customer'], parse: [] });

  const noActionsOrderPool = { query: async (sql) => {
    if (sql.includes('FROM order_aggregates')) return { rows: [{ id: 'order', account_username: 'Account', total_items: 0,
      captured_items: 0, released_items: 0, review_items: 0 }] };
    if (sql.includes('FROM order_items i LEFT JOIN')) return { rows: [] };
    if (sql.includes('COALESCE(sum(r.amount_cents)')) return { rows: [{ captured_cents: 0, released_cents: 0, reserved_cents: 0, refunded_cents: 0 }] };
    if (sql.includes('SELECT discord_user_id')) return { rows: [] };
    if (sql.includes('SELECT guild_id,channel_id')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const order = await renderProjection(noActionsOrderPool, { projection_type: 'ORDER_DM', aggregate_id: 'order' });
  assert.deepEqual(order.components, []);
  assert.match(order.embeds[0].data.description, /ยังไม่มีรายการ/);

  const history = await renderProjection({ query: async () => ({ rows: [{ state: 'MANUAL_REVIEW', account_username: 'Account',
    account_avatar_url: 'not-a-url', order_id: 'order', quest_url: 'http://invalid', quest_name: 'Quest', progress_bucket: 50,
    reservation_state: 'RESERVED', reservation_amount: null, price_cents: 500, claim_url: 'http://invalid', refund_id: null,
    terminal_reason: null, updated_at: now }] }) }, { projection_type: 'QUEST_HISTORY', aggregate_id: 'item' });
  assert.deepEqual(history.components, []);
  assert.doesNotMatch(history.embeds[0].data.description, /\]\(http/);
  assert.equal(history.embeds[0].data.thumbnail, undefined);

  const fallback = await renderProjection({ query: async () => { throw new Error('must not query fallback'); } },
    { projection_type: 'UNKNOWN', aggregate_id: 'aggregate' });
  assert.match(fallback.embeds[0].data.description, /Aggregate/);
});

test('backoffice renderers handle safe alternate values without leaking technical payloads', async () => {
  const now = new Date();
  const trace = '019fc886-ffcd-70e3-bd14-fb61772e84c7';
  const receipt = await renderProjection({ query: async () => ({ rows: [{ id: 'topup', provider_transaction_id: 'provider',
    amount_cents: null, bonus_cents: null, available_before_cents: 0, available_after_cents: 0,
    available_cents: 0, credited_at: now }] }) }, { projection_type: 'TOPUP_RECEIPT', aggregate_id: 'topup' });
  assert.match(receipt.embeds[0].data.description, /0\.00 บาท/);

  const refund = await renderProjection({ query: async () => ({ rows: [{ id: 'refund', discord_user_id: '123456789012345678',
    order_id: 'order', order_item_id: 'item', quest_id: 'quest', quest_name: 'Quest', amount_cents: 500,
    available_before_cents: 0, available_after_cents: 500, reason: 'reason', actor_id: '234567890123456789',
    transaction_id: 'wallet', trace_id: trace, created_at: now }] }) }, { projection_type: 'REFUND_LOG', aggregate_id: 'refund' },
  { client: { users: { fetch: async () => ({ displayAvatarURL: () => 'https://cdn.discordapp.com/avatar.png' }) } } });
  assert.deepEqual(refund.allowedMentions, { users: ['123456789012345678', '234567890123456789'], parse: [] });
  assert.equal(refund.embeds[0].data.thumbnail.url, 'https://cdn.discordapp.com/avatar.png');

  const renderer = (projectionType, row) => renderProjection({ query: async () => ({ rows: row ? [row] : [] }) },
    { projection_type: projectionType, aggregate_id: 'aggregate' });
  assert.equal((await renderer('CHECKOUT_AUDIT', { payload: null, option_count: 0, selected_count: 0, state: 'NEW',
    trace_id: trace, expires_at: null, created_at: now })).embeds[0].data.thumbnail, undefined);
  assert.equal((await renderer('CUSTOMER_QUEST_DISCOVERY', null)).embeds[0].data.title, 'ไม่พบ Customer Quest Discovery');
  assert.equal((await renderer('QUEST_TEST_FAILURE', null)).embeds[0].data.title, 'ไม่พบ Quest Test Failure');
  const openTest = await renderer('QUEST_TEST_FAILURE', { id: 'alert', state: 'OPEN', name: 'Quest', quest_id: 'quest',
    task_type: 'TYPE', attempts: 1, monitor_count: 1, last_error: { message: 'last failure' }, latest_error: null,
    sale_state: 'OPEN', trace_id: trace, updated_at: now });
  assert.match(openTest.embeds[0].data.title, /ไม่ผ่าน/);
  assert.equal(openTest.components[0].components.every((button) => !button.data.disabled), true);

  const incident = await renderer('SYSTEM_INCIDENT', { id: 'incident', incident_code: 'OUTBOX_STUCK', state: 'OPEN',
    severity: 'OTHER', scope: 'scope', trace_id: trace, occurrence_count: 1, evidence: {}, updated_at: now });
  assert.match(incident.embeds[0].data.description, /ไม่ระบุ/);
  assert.match(incident.embeds[0].data.description, /รหัสเหตุ/);
});

test('customer-discovery case keeps the Quest link and offers a safe full retry after Monitor search fails', async () => {
  const now = new Date();
  const body = await renderProjection({ query: async () => ({ rows: [{
    id: '11111111-1111-7111-8111-111111111111', quest_id: 'quest-customer', name: 'Customer Quest',
    task_type: 'WATCH_VIDEO', url: 'https://discord.com/quests/customer', latest_account_username: 'Account',
    latest_account_id: 'account', latest_account_avatar_url: null, latest_discord_user_id: '123456789012345678',
    first_discord_user_id: '123456789012345678', sighting_count: 2, verification_state: 'NOT_FOUND',
    announcement_state: 'NOT_ANNOUNCED', last_result: { total: 3, found: 0, testable: 0, notFound: 3, failed: 0 },
    trace_id: '019fc886-ffcd-70e3-bd14-fb61772e84c7', updated_at: now,
  }] }) }, { projection_type: 'CUSTOMER_QUEST_DISCOVERY_CASE', aggregate_id: '11111111-1111-7111-8111-111111111111' }, {
    client: { users: { fetch: async () => ({ displayAvatarURL: () => 'https://cdn.discordapp.com/avatar.png' }) } },
  });
  assert.match(body.embeds[0].data.description, /https:\/\/discord\.com\/quests\/customer/);
  assert.match(body.embeds[0].data.description, /ไม่พบ Quest ในบัญชีทดสอบ/);
  assert.equal(body.components[0].components[0].data.label, 'ตรวจและทดสอบอีกครั้ง');
  assert.equal(body.components[0].components[1].data.label, 'ส่งประกาศ');
  assert.equal(body.embeds[0].data.thumbnail.url, 'https://cdn.discordapp.com/avatar.png');
});
