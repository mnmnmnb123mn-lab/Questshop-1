import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProjection } from '../../src/discord/renderers/projections.js';

test('history projection renders truthful released and review terminal states', async () => {
  const pool = { query: async (sql) => {
    if (sql.includes('FROM order_items i JOIN orders')) return { rows: [{ id: 'item', state: 'FAILED_RELEASED',
      account_id: 'account', account_username: 'Quest account', account_avatar_url: null, order_id: 'order',
      quest_name: 'Quest', progress_bucket: 25, trace_id: '019fc886-ffcd-70e3-bd14-fb61772e84c7',
      reservation_state: 'RELEASED', reservation_amount: 500, terminal_reason: 'EXECUTOR_FAILED', updated_at: new Date() }] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const body = await renderProjection(pool, { projection_type: 'QUEST_HISTORY', aggregate_id: 'item' });
  assert.match(body.embeds[0].data.title, /คืนเครดิตแล้ว/);
  assert.match(body.embeds[0].data.description, /คืนเครดิตแล้ว/);
  assert.doesNotMatch(body.embeds[0].data.description, /FAILED_RELEASED|RELEASED/);
  assert.deepEqual(body.components, []);
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
  assert.match(body.embeds[0].data.description, /รอ Admin ตัดสินใจ/);
  assert.doesNotMatch(body.embeds[0].data.description, /เปิดขายสาธารณะ/);
  assert.deepEqual(body.components[0].components.map((button) => button.data.label), ['ส่งประกาศ', 'ทดสอบก่อน']);
  assert.deepEqual(body.allowedMentions, { users: [found.discord_user_id], parse: [] });

  const terminal = await renderProjection({ query: async () => ({ rows: [{ ...found, state: 'PUBLISHED' }] }) },
    { projection_type: 'CUSTOMER_QUEST_DISCOVERY', aggregate_id: found.id });
  assert.deepEqual(terminal.components, []);
  assert.match(terminal.embeds[0].data.description, /ประกาศสาธารณะแล้ว/);
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
