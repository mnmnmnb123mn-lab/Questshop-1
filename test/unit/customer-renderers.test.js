import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baht,
  renderOrderConfirmation,
  renderQuote,
  renderSelection,
  renderTopupAccepted,
} from '../../src/discord/renderers/checkout.js';
import { adminNavigationComponents } from '../../src/discord/renderers/admin.js';

const session = {
  id: '019fc886-ffcd-70e3-bd14-fb61772e84c7',
  payload: { username: 'บัญชีทดสอบ', accountId: '123456789012345678',
    avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png' },
};

test('baht formatting preserves exact integer cents beyond Number safe range', () => {
  assert.equal(baht(900719925474099301n), '9,007,199,254,740,993.01 บาท');
});

test('selection shows account, wallet, selection totals and a review action without a raw price button', () => {
  const body = renderSelection({ session, count: 2, selectedCount: 1, selectedTotalCents: 500,
    walletAvailableCents: 2_000, page: 0, pages: 1, rows: [
      { line_id: 'line', quest_name: 'Dolly’s Factory', task_type: 'PLAY_ON_DESKTOP', orbs: 10,
        progress_actual: 25, price_cents: 500, selected: true },
    ] });
  const description = body.embeds[0].data.description;
  const buttons = body.components[1].components.map((button) => button.data.label);
  assert.match(description, /บัญชีทดสอบ/);
  assert.match(description, /20\.00 บาท/);
  assert.match(description, /เลือกแล้ว:\*\* 1 จาก 2/);
  assert.match(description, /15\.00 บาท/);
  assert.equal(body.components[0].toJSON().components[0].options[0].description.includes('เล่นเกม'), true);
  assert.equal(body.components[0].toJSON().components[0].options[0].description.includes('หมด'), false);
  assert.equal(buttons.includes('ดูราคา'), false);
  assert.equal(buttons.includes('ตรวจสอบรายการ'), true);
});

test('selection omits the Discord select component when no eligible Quest exists', () => {
  const body = renderSelection({ session, count: 0, selectedCount: 0, selectedTotalCents: 0,
    walletAvailableCents: 2_000, page: 0, pages: 1, rows: [] });
  assert.equal(body.components.length, 1);
  assert.deepEqual(body.components[0].components.map((button) => button.data.label),
    ['ก่อนหน้า', 'ถัดไป', 'เลือกทั้งหมด', 'ตรวจสอบรายการ']);
});

test('customer checkout payloads bound long untrusted Quest text to Discord limits', () => {
  const longQuest = '@everyone **'.repeat(500);
  const body = renderSelection({ session: { ...session, payload: { ...session.payload, username: longQuest } },
    count: 1, selectedCount: 1, selectedTotalCents: 500, walletAvailableCents: 2_000, page: 0, pages: 1,
    rows: [{ line_id: 'line', quest_name: longQuest, task_type: 'PLAY_ON_DESKTOP', orbs: 10,
      progress_actual: 25, price_cents: 500, selected: true }] });
  const select = body.components[0].toJSON().components[0];
  assert.ok(body.embeds[0].data.description.length <= 4_096);
  assert.ok(select.options[0].label.length <= 100);
  assert.doesNotMatch(select.options[0].label, /@everyone/);
});

test('quote keeps the explicit revalidation boundary with edit and confirm actions', () => {
  const body = renderQuote({ session, walletAvailableCents: 2_000, totalCents: 500, items: [
    { quest_name: 'Dolly’s Factory', task_type: 'PLAY_ON_DESKTOP', orbs: 10,
      price_cents: 500, deadline_at: '2030-01-01T00:00:00.000Z' },
  ] });
  const description = body.embeds[0].data.description;
  const buttons = body.components[0].components.map((button) => button.data.label);
  assert.match(description, /ยอดที่จะจอง/);
  assert.match(description, /ยอดพร้อมใช้หลังยืนยัน/);
  assert.deepEqual(buttons, ['ย้อนกลับไปแก้รายการ', 'ยืนยันทำ Quest']);
});

test('order confirmation is a receipt and links to durable history', () => {
  const body = renderOrderConfirmation({ orderId: 'order', totalCents: 500,
    order: { account_username: 'บัญชีทดสอบ', account_id: 'account', account_avatar_url: null },
    items: [{ id: 'item' }], wallet: { available_cents: 1_500, reserved_cents: 500 } },
  'https://discord.com/channels/1/2');
  assert.match(body.embeds[0].data.title, /รับรายการเรียบร้อย/);
  assert.match(body.embeds[0].data.description, /ยอดที่จอง/);
  assert.equal(body.components[0].components[0].data.label, 'ดูความคืบหน้าการทำ Quest');
});

test('top-up acknowledgement confirms durable acceptance and directs the customer to DM', () => {
  const received = renderTopupAccepted({ topup: { id: 'topup', status: 'PAYMENT_QUEUED',
    created_at: '2030-01-01T00:00:00.000Z' } });
  assert.match(received.embeds[0].data.title, /รับรายการเติมเงินแล้ว/);
  assert.match(received.embeds[0].data.description, /Top-up ID/);
  assert.match(received.embeds[0].data.description, /ข้อความส่วนตัว/);
  const existing = renderTopupAccepted({ idempotent: true, topup: { id: 'topup', status: 'CREDITED',
    created_at: '2030-01-01T00:00:00.000Z' } });
  assert.match(existing.embeds[0].data.title, /รายการเติมเงินเดิม/);
  assert.match(existing.embeds[0].data.description, /ไม่เรียก TrueMoney เพิ่ม/);
});

test('admin navigation always includes category navigation and refresh controls', () => {
  const rows = adminNavigationComponents('pricing');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].toJSON().components[0].options.find((option) => option.value === 'pricing').default, true);
  assert.deepEqual(rows[1].components.map((button) => button.data.label), ['รีเฟรช', 'กลับภาพรวม']);
});
