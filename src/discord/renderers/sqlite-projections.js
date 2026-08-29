import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { formatCents } from '../../shared/money.js';
import { safeDiscordText } from '../payload.js';
import { PAYMENT_LOG_BANNER_ATTACHMENT_URL, PAYMENT_LOG_BANNER_FILENAME, loadPaymentLogBanner } from '../surfaces/payment-log-media.js';
import {
  ADMIN_LOG_BANNER_ATTACHMENT_URL, ADMIN_LOG_BANNER_FILENAME, BACKOFFICE_LOG_BANNER_ATTACHMENT_URL,
  BACKOFFICE_LOG_BANNER_FILENAME, LOG_SYSTEM_THUMBNAIL_ATTACHMENT_URL, LOG_SYSTEM_THUMBNAIL_FILENAME,
  loadAdminLogBanner, loadBackofficeLogBanner, loadLogSystemThumbnail,
} from '../surfaces/backoffice-log-media.js';
import { customId } from '../components/custom-id.js';
import { priceForQuest } from '../../domain/sqlite/pricing.js';
import { loadRuntimeConfig } from '../../config/runtime-config.js';
import { decryptCredential } from '../../domain/sqlite/crypto.js';
import { ADMIN_AUDIT_ALLOWED_FIELDS } from '../../domain/sqlite/admin.js';
import { QUEST_HISTORY_BANNER_ATTACHMENT_URL, QUEST_HISTORY_BANNER_FILENAME, loadQuestHistoryBanner } from '../surfaces/quest-history-media.js';

const COLORS = Object.freeze({ info: 0x5865f2, warning: 0xf0b232, success: 0x23a55a, danger: 0xf23f43 });
const timestamp = (ms) => ms ? `<t:${Math.floor(Number(ms) / 1000)}:F>` : 'ไม่ระบุ';
const baht = (cents) => `${formatCents(cents)} บาท`;

function thaiPaymentReason(code) {
  return {
    VOUCHER_OUT_OF_STOCK: 'ซองนี้ถูกใช้ไปแล้ว', VOUCHER_EXPIRED: 'ซองหมดอายุแล้ว', VOUCHER_NOT_FOUND: 'ไม่พบซองนี้',
    CANNOT_GET_OWN_VOUCHER: 'ไม่สามารถรับซองของเบอร์เดียวกันได้', PROVIDER_RESULT_AMBIGUOUS: 'ระบบยังยืนยันผลจาก TrueMoney ไม่ได้',
    PAYMENT_CREDENTIAL_UNAVAILABLE: 'ข้อมูลรับเงินไม่พร้อมสำหรับตรวจซอง', REVERSAL_INSUFFICIENT_BALANCE: 'เครดิตคงเหลือไม่พอสำหรับย้อนรายการ',
  }[code] ?? (code ? 'ระบบไม่สามารถดำเนินการรายการนี้ได้ กรุณาติดต่อผู้ดูแลพร้อม Top-up ID' : null);
}

function topupStatus(topup) {
  return {
    PENDING: ['🔵 กำลังตรวจสอบซอง', COLORS.info], PROCESSING: ['🔵 กำลังตรวจสอบซอง', COLORS.info],
    CREDITED: ['✅ เติมเครดิตสำเร็จ', COLORS.success], REVIEW: ['🟡 รายการรอผู้ดูแลตรวจสอบ', COLORS.warning],
    REVERSED: ['🟠 ย้อนเครดิตแล้ว', COLORS.danger], FAILED: ['❌ เติมเครดิตไม่สำเร็จ', COLORS.danger],
    REDEEMED: ['🔵 TrueMoney ยืนยันแล้ว กำลังเพิ่มเครดิต', COLORS.info],
  }[topup.status] ?? ['🟡 กำลังตรวจสอบรายการ', COLORS.warning];
}

async function customerAvatar(embed, client, discordUserId) {
  if (!client?.users?.fetch || !/^\d{17,20}$/.test(String(discordUserId))) return;
  const user = await client.users.fetch(discordUserId).catch(() => null);
  const url = user?.displayAvatarURL?.({ size: 128 });
  if (typeof url === 'string' && url.startsWith('https://')) embed.setThumbnail(url);
}

function ownerVoucherLink(db, runtime, topup) {
  if (!runtime?.env?.QUESTSHOP_SECRET_KEY) return null;
  const credential = db.prepare("SELECT * FROM credentials WHERE subject_type='TOPUP' AND subject_id=? AND credential_type='VOUCHER'").get(topup.id);
  if (!credential) return null;
  try {
    const url = decryptCredential(runtime.env.QUESTSHOP_SECRET_KEY, credential);
    return url.startsWith('https://gift.truemoney.com/campaign/') ? url : null;
  } catch { return null; }
}

async function renderTopup(db, client, notification, { log = false, runtime = null } = {}) {
  const topup = db.prepare('SELECT * FROM topups WHERE id=?').get(notification.aggregate_id);
  if (!topup) throw Object.assign(new Error('Top-up projection is missing'), { code: 'TOPUP_PROJECTION_MISSING' });
  const [heading, color] = topupStatus(topup);
  const before = db.prepare(`SELECT available_after_cents FROM wallet_transactions WHERE reference_type='TOPUP' AND reference_id=?
    ORDER BY created_at ASC LIMIT 1`).get(topup.id);
  const wallet = db.prepare('SELECT * FROM wallets WHERE discord_user_id=?').get(topup.discord_user_id);
  const walletBefore = before?.available_after_cents == null ? null : Number(before.available_after_cents) - Number(topup.credited_cents);
  const voucher = log ? ownerVoucherLink(db, runtime, topup) : null;
  const lines = log ? [
    `Top-up ID: \`${topup.id}\``, `สถานะ: ${heading.replace(/^..\s/, '')}`,
    voucher ? `ลิงก์ซอง: ${voucher}` : null,
    `ผู้เติม: <@${topup.discord_user_id}> (\`${topup.discord_user_id}\`)`,
    topup.provider_transaction_id ? `Provider transaction: \`${safeDiscordText(topup.provider_transaction_id)}\`` : null,
    topup.wallet_transaction_id ? `Wallet transaction: \`${topup.wallet_transaction_id}\`` : null,
    `ยอดเงินต้น: ${baht(topup.principal_cents)}`, `โบนัส: ${baht(topup.bonus_cents)}`,
    wallet ? `Wallet ก่อน/หลัง: ${baht(walletBefore ?? 0)} → ${baht(wallet.available_cents)}` : null,
    wallet ? `ยอดจองก่อน/หลัง: ${baht(wallet.reserved_cents)} → ${baht(wallet.reserved_cents)}` : null,
    topup.receiver_last4 ? `เบอร์รับเงิน: ••••${safeDiscordText(topup.receiver_last4)}` : null,
    `Attempts: ${topup.attempt_count}`, `Trace: \`${topup.trace_id}\``,
    topup.failure_reason ? `เหตุผล: ${thaiPaymentReason(topup.failure_reason)}` : null,
  ] : [
    topup.status === 'CREDITED' ? 'เครดิตถูกเพิ่มเข้ากระเป๋าของคุณเรียบร้อยแล้ว' : 'ระบบจะอัปเดตการ์ดนี้เมื่อสถานะเปลี่ยน', '',
    '**ข้อมูลรายการ**', `Top-up ID: \`${topup.id}\``, `ส่งรายการเมื่อ: ${timestamp(topup.created_at)}`,
    topup.credited_at ? `เติมสำเร็จเมื่อ: ${timestamp(topup.credited_at)}` : null, '', '**รายละเอียดเครดิต**',
    `ยอดก่อนเติม: ${baht(walletBefore ?? 0)}`,
    `ยอดเงินจากซอง: ${baht(topup.principal_cents)}`, `โบนัสโปรโมชั่น: ${baht(topup.bonus_cents)}`,
    `ได้รับทั้งหมด: ${baht(topup.credited_cents)}`, wallet ? `ยอดคงเหลือใหม่: ${baht(wallet.available_cents)}` : null,
    topup.failure_reason ? `เหตุผล: ${thaiPaymentReason(topup.failure_reason)}` : null,
    '', 'โปรดเก็บ Top-up ID ไว้สำหรับติดต่อผู้ดูแล',
  ];
  const embed = new EmbedBuilder().setColor(color).setTitle(heading).setDescription(lines.filter(Boolean).join('\n'))
    .setTimestamp(new Date(Number(topup.updated_at)));
  await customerAvatar(embed, client, topup.discord_user_id);
  embed.setImage(PAYMENT_LOG_BANNER_ATTACHMENT_URL);
  return { embeds: [embed], attachments: [], files: [{ attachment: await loadPaymentLogBanner(), name: PAYMENT_LOG_BANNER_FILENAME }],
    allowedMentions: { parse: [] } };
}

async function renderOrder(db, client, notification, runtime) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(notification.aggregate_id);
  if (!order) throw Object.assign(new Error('Order projection is missing'), { code: 'ORDER_PROJECTION_MISSING' });
  const items = db.prepare(`SELECT i.*,q.name,q.url FROM order_items i JOIN quests q ON q.quest_id=i.quest_id WHERE i.order_id=?`).all(order.id);
  const embed = new EmbedBuilder().setColor(order.state === 'COMPLETED' ? COLORS.success : COLORS.info)
    .setTitle(order.state === 'COMPLETED' ? '✅ ทำ Quest เสร็จแล้ว' : '🔵 สถานะการทำ Quest')
    .setDescription([`Order: \`${order.id}\``, ...items.map((item) => {
      const label = `${safeDiscordText(item.name)} — ${item.progress_percent}%`;
      return `${item.state === 'READY_TO_CLAIM' ? '✅' : '🔵'} ${String(item.url).startsWith('https://') ? `[${label}](${item.url})` : label}`;
    })].join('\n'))
    .setTimestamp(new Date(Number(order.updated_at)));
  await customerAvatar(embed, client, order.discord_user_id);
  embed.setImage(QUEST_HISTORY_BANNER_ATTACHMENT_URL);
  const components = [];
  if (notification.notification_type === 'ORDER_STATUS_DM') {
    const firstClaim = items.find((item) => item.state === 'READY_TO_CLAIM' && String(item.claim_url ?? '').startsWith('https://'));
    const history = db.prepare(`SELECT message_id FROM notifications WHERE notification_type='QUEST_HISTORY'
      AND aggregate_type='ORDER' AND aggregate_id=? AND destination='QUEST_HISTORY'`).get(order.id);
    const channel = runtime?.config?.surfaces?.QUEST_HISTORY?.channelId;
    const buttons = [];
    if (firstClaim) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(firstClaim.claim_url).setLabel('รับรางวัลทั้งหมด'));
    if (channel && history?.message_id) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${runtime.env.DISCORD_GUILD_ID}/${channel}/${history.message_id}`).setLabel('ดูประวัติ Quest ทั้งหมด'));
    if (buttons.length) components.push(new ActionRowBuilder().addComponents(buttons));
  } else if (items.length === 1 && String(items[0].claim_url ?? '').startsWith('https://')) {
    components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(items[0].claim_url).setLabel('รับรางวัล Quest นี้')));
  }
  return { embeds: [embed], components, attachments: [], files: [{ attachment: await loadQuestHistoryBanner(), name: QUEST_HISTORY_BANNER_FILENAME }], allowedMentions: { parse: [] } };
}

function readJson(value, fallback = {}) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}

function thaiItemState(state) {
  return {
    QUEUED: 'รอเริ่มทำ', RUNNING: 'กำลังทำ', READY_TO_CLAIM: 'ทำสำเร็จ รอรับรางวัล',
    FAILED: 'ทำไม่สำเร็จ', REVIEW: 'รอผู้ดูแลตรวจสอบ', REFUNDED: 'คืนเครดิตแล้ว',
  }[state] ?? 'ระบบกำลังตรวจสอบ';
}

function thaiMonitorStatus(state) {
  return {
    NOT_CHECKED: 'ยังไม่ได้ตรวจ', FOUND_READY: 'พบ Quest และมีบัญชีที่พร้อมทดสอบ',
    FOUND_COMPLETED: 'พบ Quest แต่บัญชีทดสอบทำเสร็จแล้ว', NOT_FOUND: 'ไม่พบ Quest ในบัญชีทดสอบ',
    INCOMPLETE: 'ตรวจบัญชีทดสอบไม่ครบ', TEST_PASSED: 'ทดสอบผ่าน', TEST_FAILED: 'ทดสอบไม่ผ่าน',
  }[state] ?? 'ระบบกำลังตรวจสอบ';
}

function thaiAdminAction(action) {
  return {
    SURFACE_SETUP: 'ติดตั้งหรือย้ายแผง Discord', TOPUP_REVERSED: 'ย้อนเครดิตรายการเติมเงิน',
    WALLET_ADJUSTMENT: 'ปรับเครดิต Wallet', CONFIG_UPDATED: 'เปลี่ยนการตั้งค่าร้าน',
    MONITOR_UPDATED: 'จัดการบัญชีทดสอบ', MANUAL_REVIEW_DECISION: 'ตัดสินรายการที่รอตรวจ',
  }[action] ?? 'ผู้ดูแลปรับข้อมูลระบบ';
}

function safeAuditChange(action, before, after) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return null;
  const changed = (ADMIN_AUDIT_ALLOWED_FIELDS[action] ?? []).filter((key) => before[key] !== after[key]).slice(0, 3);
  if (!changed.length) return null;
  return changed.map((key) => `${safeDiscordText(key)}: ${safeDiscordText(before[key] ?? 'ไม่ระบุ')} → ${safeDiscordText(after[key] ?? 'ไม่ระบุ')}`).join(', ');
}

async function renderQuestOperation(db, client, notification) {
  if (notification.notification_type === 'CUSTOMER_QUEST_DISCOVERY') {
    const quest = notification.aggregate_type === 'QUEST'
      ? db.prepare('SELECT * FROM quests WHERE quest_id=?').get(notification.aggregate_id) : null;
    const payload = readJson(notification.payload_json);
    const title = quest ? '🔎 ตรวจ Quest ที่พบจากลูกค้า' : '🔎 พบ Quest จากบัญชีลูกค้า';
    const lines = quest ? [
      `Quest: ${safeDiscordText(quest.name)}`, `ลิงก์ Quest: ${quest.url}`,
      `ผลการตรวจบัญชีทดสอบ: ${thaiMonitorStatus(quest.monitor_status)}`,
      `ข้อมูลอ้างอิง: \`${quest.quest_id}\``,
      `สรุป: ${quest.monitor_status === 'TEST_PASSED' ? 'ระบบทดสอบ Quest ผ่านแล้ว' : 'ระบบบันทึกผลตรวจล่าสุดแล้ว'}`,
    ] : [
      `พบ Quest ${Number(payload.count ?? 0)} รายการจากบัญชีลูกค้า`,
      payload.accountId ? `บัญชี Quest: \`${safeDiscordText(payload.accountId)}\`` : null,
      `ข้อมูลอ้างอิง: \`${notification.aggregate_id}\``, 'สรุป: ระบบกำลังตรวจบัญชีทดสอบโดยไม่ขัดขวางการสั่งทำของลูกค้า',
    ];
    const embed = new EmbedBuilder().setColor(COLORS.info).setTitle(title).setDescription(lines.filter(Boolean).join('\n'))
      .setTimestamp(new Date(Number(notification.updated_at))).setImage(BACKOFFICE_LOG_BANNER_ATTACHMENT_URL);
    await customerAvatar(embed, client, payload.discordUserId);
    const components = quest && quest.monitor_status !== 'TEST_PASSED' ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('customer_quest_case_retry', notification.id)).setLabel('ตรวจและทดสอบอีกครั้ง').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(customId('customer_quest_announce', notification.id)).setLabel('ส่งประกาศ').setStyle(ButtonStyle.Secondary),
    )] : [];
    return { embeds: [embed], components, attachments: [], files: [{ attachment: await loadBackofficeLogBanner(), name: BACKOFFICE_LOG_BANNER_FILENAME }], allowedMentions: { parse: [] } };
  }
  const item = db.prepare(`SELECT i.*,o.id AS order_id,o.discord_user_id,q.name,q.url,q.artwork_url FROM order_items i
    JOIN orders o ON o.id=i.order_id JOIN quests q ON q.quest_id=i.quest_id WHERE i.id=?`).get(notification.aggregate_id);
  if (!item) throw Object.assign(new Error('Quest operation projection is missing'), { code: 'QUEST_OPERATION_PROJECTION_MISSING' });
  const done = item.state === 'READY_TO_CLAIM';
  const embed = new EmbedBuilder().setColor(done ? COLORS.success : item.state === 'REVIEW' ? COLORS.warning : COLORS.info)
    .setTitle(done ? '✅ ทำ Quest สำเร็จ' : item.state === 'REVIEW' ? '🟡 Quest รอผู้ดูแลตรวจ' : '🎮 สถานะการทำ Quest')
    .setDescription([
      `Quest: ${safeDiscordText(item.name)}`, `Order: \`${item.order_id}\``, `สถานะ: ${thaiItemState(item.state)}`,
      `ความคืบหน้า: ${Number(item.progress_percent)}%`, `ค่าบริการ: ${baht(item.price_cents)}`,
      `ข้อมูลอ้างอิง: \`${item.id}\``, `สรุป: ${done ? 'ลูกค้ากดรับรางวัลจากลิงก์ Quest ได้เอง' : thaiItemState(item.state)}`,
    ].join('\n')).setTimestamp(new Date(Number(item.updated_at))).setImage(BACKOFFICE_LOG_BANNER_ATTACHMENT_URL);
  const artwork = typeof item.artwork_url === 'string' && item.artwork_url.startsWith('https://') ? item.artwork_url : null;
  if (artwork) embed.setThumbnail(artwork); else await customerAvatar(embed, client, item.discord_user_id);
  return { embeds: [embed], attachments: [], files: [{ attachment: await loadBackofficeLogBanner(), name: BACKOFFICE_LOG_BANNER_FILENAME }], allowedMentions: { parse: [] } };
}

async function renderAdmin(db, client, notification) {
  const audit = db.prepare('SELECT * FROM admin_audit WHERE id=?').get(notification.aggregate_id);
  if (!audit) throw Object.assign(new Error('Admin audit projection is missing'), { code: 'ADMIN_AUDIT_PROJECTION_MISSING' });
  const before = readJson(audit.before_json, null); const after = readJson(audit.after_json, null);
  const change = safeAuditChange(audit.action, before, after);
  const embed = new EmbedBuilder().setColor(COLORS.info).setTitle(`🛠️ ${thaiAdminAction(audit.action)}`)
    .setDescription([
      `ผู้ดำเนินการ: ${audit.actor_id === 'SYSTEM' ? 'ระบบ' : `<@${audit.actor_id}>`}`,
      `รายการที่แก้: ${safeDiscordText(audit.target_type)} \`${safeDiscordText(audit.target_id)}\``,
      audit.reason ? `เหตุผล: ${safeDiscordText(audit.reason)}` : null,
      change ? `การเปลี่ยนแปลง: ${change}` : null,
      `ข้อมูลอ้างอิง: \`${audit.trace_id}\``, `สรุป: ${thaiAdminAction(audit.action)} เรียบร้อยแล้ว`,
    ].filter(Boolean).join('\n')).setTimestamp(new Date(Number(audit.created_at))).setImage(ADMIN_LOG_BANNER_ATTACHMENT_URL);
  if (audit.actor_id === 'SYSTEM') {
    embed.setThumbnail(LOG_SYSTEM_THUMBNAIL_ATTACHMENT_URL);
    return { embeds: [embed], attachments: [], files: [{ attachment: await loadAdminLogBanner(), name: ADMIN_LOG_BANNER_FILENAME },
      { attachment: await loadLogSystemThumbnail(), name: LOG_SYSTEM_THUMBNAIL_FILENAME }], allowedMentions: { parse: [] } };
  }
  await customerAvatar(embed, client, audit.actor_id);
  return { embeds: [embed], attachments: [], files: [{ attachment: await loadAdminLogBanner(), name: ADMIN_LOG_BANNER_FILENAME }], allowedMentions: { parse: [] } };
}

async function renderQuestAnnouncement(db, notification) {
  const quest = db.prepare('SELECT * FROM quests WHERE quest_id=?').get(notification.aggregate_id);
  if (!quest) throw Object.assign(new Error('Quest announcement projection is missing'), { code: 'QUEST_ANNOUNCEMENT_MISSING' });
  const task = { WATCH_VIDEO: 'ดูวิดีโอ', WATCH_VIDEO_ON_MOBILE: 'ดูวิดีโอบนมือถือ', PLAY_ON_DESKTOP: 'เล่นบนคอมพิวเตอร์', PLAY_ON_DESKTOP_V2: 'เล่นบนคอมพิวเตอร์' }[quest.task_type] ?? 'Quest Discord';
  const price = priceForQuest(loadRuntimeConfig(db).values, quest.task_type);
  const reward = quest.orbs != null ? `${quest.orbs} Discord Orbs`
    : quest.orb_min != null && quest.orb_max != null ? `${quest.orb_min}-${quest.orb_max} Discord Orbs` : null;
  const embed = new EmbedBuilder().setColor(COLORS.success).setTitle(`🎉 พบ Quest ใหม่: ${safeDiscordText(quest.name)}`)
    .setDescription([
      `ประเภท: ${task}`,
      quest.target_value != null ? `เป้าหมาย: ${quest.target_value}` : null,
      reward ? `รางวัล: ${reward}` : null,
      price != null ? `ค่าบริการ: ${baht(price)}` : 'ค่าบริการ: ยังไม่พร้อม',
      quest.starts_at ? `เริ่ม: ${timestamp(quest.starts_at)}` : null,
      quest.expires_at ? `หมดอายุ: ${timestamp(quest.expires_at)}` : null,
      'สรุป: Quest นี้เป็นข้อมูลประกาศ ไม่ได้ยืนยันว่าจะปรากฏในทุกบัญชี Discord',
    ].filter(Boolean).join('\n'));
  if (typeof quest.artwork_url === 'string' && quest.artwork_url.startsWith('https://')) embed.setImage(quest.artwork_url);
  if (typeof quest.thumbnail_url === 'string' && quest.thumbnail_url.startsWith('https://')) embed.setThumbnail(quest.thumbnail_url);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(quest.url).setLabel('ดู Quest ได้ที่นี่'),
  )], allowedMentions: { parse: [] } };
}

async function renderBackoffice(db, _client, notification) {
  const system = notification.notification_type === 'SYSTEM_LOG';
  const admin = notification.notification_type === 'ADMIN_LOG';
  const title = system ? '⚠️ สถานะระบบ Questshop' : admin ? '🛠️ การทำงานของผู้ดูแล' : '🎮 การทำงานของ Quest';
  const incident = system ? readJson(notification.payload_json) : null;
  const systemTitle = {
    DISCORD_DELIVERY_FAILED: 'Discord ส่งข้อความไม่สำเร็จ', SQLITE_INTEGRITY_FAILED: 'ฐานข้อมูลต้องตรวจสอบ',
    SQLITE_BACKUP_FAILED: 'การสำรองข้อมูลไม่สำเร็จ', JOB_UNHANDLED_ERROR: 'งานเบื้องหลังทำงานไม่สำเร็จ',
  }[incident?.code] ?? 'ระบบพบเหตุที่ต้องติดตาม';
  const systemSummary = incident?.resolved ? 'เหตุการณ์นี้กลับมาปกติแล้ว' : 'ระบบกำลังลองดำเนินการต่อ หรือผู้ดูแลควรตรวจข้อมูลอ้างอิง';
  const embed = new EmbedBuilder().setColor(system ? (incident?.resolved ? COLORS.success : COLORS.warning) : COLORS.info).setTitle(system ? `${incident?.resolved ? '✅' : '⚠️'} ${systemTitle}` : title)
    .setDescription(system ? [
      `ส่วนที่ได้รับผลกระทบ: ${safeDiscordText(incident?.scope ?? 'ระบบ')}`,
      `เกิดขึ้น ${Number(incident?.occurrenceCount ?? 1)} ครั้ง ล่าสุด ${timestamp(incident?.lastSeenAt)}`,
      `ข้อมูลอ้างอิง: \`${safeDiscordText(incident?.code ?? notification.aggregate_id)}\``, `สรุป: ${systemSummary}`,
    ].join('\n') : `ข้อมูลอ้างอิง: \`${notification.aggregate_type}:${notification.aggregate_id}\`\nสรุป: ระบบอัปเดตข้อมูลรายการนี้แล้ว`)
    .setTimestamp(new Date(Number(notification.updated_at)));
  const files = admin
    ? [{ attachment: await loadAdminLogBanner(), name: ADMIN_LOG_BANNER_FILENAME }]
    : [{ attachment: await loadBackofficeLogBanner(), name: BACKOFFICE_LOG_BANNER_FILENAME }];
  embed.setImage(admin ? ADMIN_LOG_BANNER_ATTACHMENT_URL : BACKOFFICE_LOG_BANNER_ATTACHMENT_URL);
  if (system) {
    embed.setThumbnail(LOG_SYSTEM_THUMBNAIL_ATTACHMENT_URL);
    files.push({ attachment: await loadLogSystemThumbnail(), name: LOG_SYSTEM_THUMBNAIL_FILENAME });
  }
  return { embeds: [embed], attachments: [], files, allowedMentions: { parse: [] } };
}

export async function renderSqliteNotification(runtime, notification) {
  const { db, client } = runtime;
  if (notification.notification_type === 'TOPUP_STATUS_DM') return renderTopup(db, client, notification, { runtime });
  if (notification.notification_type === 'PAYMENT_LOG') return renderTopup(db, client, notification, { log: true, runtime });
  if (notification.notification_type === 'QUEST_HISTORY' || notification.notification_type === 'ORDER_STATUS_DM') return renderOrder(db, client, notification, runtime);
  if (notification.notification_type === 'QUEST_OPERATION_LOG' || notification.notification_type === 'CUSTOMER_QUEST_DISCOVERY') {
    return renderQuestOperation(db, client, notification);
  }
  if (notification.notification_type === 'ADMIN_LOG') return renderAdmin(db, client, notification);
  if (notification.notification_type === 'QUEST_NEW') return renderQuestAnnouncement(db, notification);
  return renderBackoffice(db, client, notification);
}
