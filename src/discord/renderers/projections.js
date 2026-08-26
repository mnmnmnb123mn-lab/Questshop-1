import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { decryptSecret } from '../../adapters/crypto/keyring.js';
import {
  orderStateIcon,
  orderStateLabel,
  reservationStateLabel,
  saleStateLabel,
  terminalReasonLabel,
  topupStateLabel,
} from './labels.js';
import {
  adminActionLabel, adminReasonLabel, adminTargetLabel, analysisStateLabel, announcementStateLabel, checkoutStateLabel,
  discoveryStateLabel, incidentDefinition, questTestStateLabel, questTypeLabel, reasonLabel,
  routeLabel, runnerStateLabel, scopeLabel,
} from './backoffice-language.js';
import { baht } from './checkout.js';
import { renderQuestNewProjection } from './quest-new.js';
import { DISCORD_LIMITS, safeDiscordText, truncateDiscordText } from '../payload.js';
import {
  QUEST_HISTORY_BANNER_ATTACHMENT_URL, QUEST_HISTORY_BANNER_FILENAME, loadQuestHistoryBanner,
} from '../surfaces/quest-history-media.js';
import {
  PAYMENT_LOG_BANNER_ATTACHMENT_URL, PAYMENT_LOG_BANNER_FILENAME, loadPaymentLogBanner,
} from '../surfaces/payment-log-media.js';
import {
  ADMIN_LOG_BANNER_ATTACHMENT_URL, ADMIN_LOG_BANNER_FILENAME,
  BACKOFFICE_LOG_BANNER_ATTACHMENT_URL, BACKOFFICE_LOG_BANNER_FILENAME,
  LOG_SYSTEM_THUMBNAIL_ATTACHMENT_URL, LOG_SYSTEM_THUMBNAIL_FILENAME,
  loadAdminLogBanner, loadBackofficeLogBanner, loadLogSystemThumbnail,
} from '../surfaces/backoffice-log-media.js';

const color = { pending: 0xf0b232, success: 0x23a55a, failure: 0xf23f43, info: 0x5865f2 };
const escape = (value) => safeDiscordText(value, { maximum: 1_000 });
const title = (value) => truncateDiscordText(value, DISCORD_LIMITS.embedTitle);
const boundedDescription = (value) => truncateDiscordText(value, DISCORD_LIMITS.embedDescription);
const timestamp = (value, style = 'F') => value ? `<t:${Math.floor(new Date(value).getTime() / 1000)}:${style}>` : 'ไม่ระบุ';
const noMentions = { parse: [] };
const moneyOrUnknown = (value) => value == null ? 'ไม่ระบุ' : baht(value);
const reference = (values) => `**ข้อมูลอ้างอิง:** ${values.filter(Boolean).join(' • ')}`;
const summary = (value) => `**สรุป:** ${value}`;
const PAYMENT_REASON_LABELS = Object.freeze({
  PROVIDER_TRANSACTION_ID_MISSING: 'TrueMoney ยืนยันรับเงินแล้ว แต่ไม่ได้ส่งเลขธุรกรรม',
  PROVIDER_HTTP_AMBIGUOUS: 'TrueMoney ปฏิเสธคำขอ แต่ระบบอ่านเหตุผลไม่ได้',
  PROVIDER_SCHEMA_INCOMPATIBLE: 'รูปแบบข้อมูลจาก TrueMoney เปลี่ยนไป ระบบจึงหยุดรอตรวจสอบ',
  PROVIDER_CONFIRMATION_INCOMPLETE: 'TrueMoney ส่งข้อมูลยืนยันยอดหรือผู้รับมาไม่ครบ',
  PROVIDER_RESULT_AMBIGUOUS: 'การเชื่อมต่อขาดหลังส่งคำขอ จึงยังยืนยันผลไม่ได้',
  PROVIDER_HTTP_INCONSISTENT: 'ข้อมูลสถานะจาก TrueMoney ขัดแย้งกับรหัส HTTP',
  VOUCHER_OUT_OF_STOCK: 'ซองนี้ถูกใช้ไปแล้ว',
  VOUCHER_EXPIRED: 'ซองหมดอายุแล้ว',
  VOUCHER_NOT_FOUND: 'ไม่พบซองนี้',
  CANNOT_GET_OWN_VOUCHER: 'ไม่สามารถรับซองของตัวเองได้',
  RATE_LIMIT: 'TrueMoney ขอให้รอสักครู่ก่อนตรวจสอบใหม่',
});
function paymentReasonLabel(value) {
  if (!value) return null;
  if (PAYMENT_REASON_LABELS[value]) return PAYMENT_REASON_LABELS[value];
  return /^[A-Z0-9_]{3,100}$/.test(String(value)) ? 'ระบบยังระบุสาเหตุไม่ได้' : escape(value);
}
function paymentEmbedColor(status) {
  if (status === 'CREDITED') return color.success;
  if (status === 'MANUAL_REVIEW' || status === 'RETRY_WAIT') return color.pending;
  if (['PAYMENT_QUEUED', 'PROCESSING', 'VALIDATING', 'REDEEMED', 'RECEIVED'].includes(status)) return color.info;
  return color.failure;
}
function orderItemLine(item) {
  const refund = item.refund_id ? ' • ↩️ คืนเครดิตแล้ว' : '';
  return `${item.sequence_number}. ${orderStateIcon(item.state)} **${escape(item.quest_name)}** — ${orderStateLabel(item.state)} — ${baht(item.price_cents)}${refund}`;
}
function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value));
    const normalized = url.protocol === 'https:' ? url.toString() : null;
    return normalized && normalized.length <= 512 ? normalized : null;
  } catch { return null; }
}
function safeTrueMoneyVoucherUrl(value) {
  const url = safeHttpsUrl(value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'gift.truemoney.com' ? parsed.toString() : null;
  } catch { return null; }
}
function setSafeThumbnail(embed, value) {
  const url = safeHttpsUrl(value);
  if (url) embed.setThumbnail(url);
}
async function setDiscordUserThumbnail(embed, client, discordUserId) {
  if (!/^\d{17,20}$/.test(String(discordUserId)) || !client?.users?.fetch) return false;
  const user = await client.users.fetch(discordUserId).catch(() => null);
  if (!user) return false;
  try {
    const avatarUrl = safeHttpsUrl(user.displayAvatarURL({ size: 128 }));
    if (!avatarUrl) return false;
    embed.setThumbnail(avatarUrl);
    return true;
  } catch {
    return false;
  }
}
function missingProjection(message) {
  return { embeds: [new EmbedBuilder().setColor(color.info).setTitle(title(message))], allowedMentions: noMentions };
}

async function renderRefund(pool, projection, { client }) {
  const refund = (await pool.query(`SELECT f.*,i.order_id,i.quest_id,i.quest_name,
    w.available_before_cents,w.available_after_cents,w.id AS transaction_id
    FROM refunds f JOIN order_items i ON i.id=f.order_item_id
    JOIN wallet_transactions w ON w.id=f.wallet_transaction_id WHERE f.id=$1`, [projection.aggregate_id])).rows[0];
  if (!refund) return { embeds: [new EmbedBuilder().setColor(color.info).setTitle('ไม่พบ Refund Log')], allowedMentions: noMentions };
  const user = await client.users.fetch(refund.discord_user_id).catch(() => null);
  const lines = [
    `**ผู้ได้รับเงินคืน:** <@${refund.discord_user_id}> (\`${refund.discord_user_id}\`)`,
    `**Order:** \`${refund.order_id}\``, `**Item:** \`${refund.order_item_id}\``,
    `**Quest:** ${escape(refund.quest_name)} (\`${escape(refund.quest_id)}\`)`,
    `**จำนวน:** ${baht(refund.amount_cents)}`,
    `**Wallet ก่อน/หลัง:** ${baht(refund.available_before_cents)} → ${baht(refund.available_after_cents)}`,
    `**เหตุผล:** ${escape(refund.reason)}`,
    `**ดำเนินการโดย:** <@${refund.actor_id}> (\`${refund.actor_id}\`)`,
    `**Refund ID:** \`${refund.id}\``, `**Wallet transaction:** \`${refund.transaction_id}\``, `**Trace:** \`${refund.trace_id}\``,
  ];
  const embed = new EmbedBuilder().setColor(color.success).setTitle('↩️ คืนเงิน Order Item')
    .setDescription(boundedDescription(lines.join('\n'))).setTimestamp(refund.created_at);
  if (user) setSafeThumbnail(embed, user.displayAvatarURL({ size: 128 }));
  const users = /^\d{17,20}$/.test(refund.actor_id)
    ? [refund.discord_user_id, refund.actor_id] : [refund.discord_user_id];
  return { embeds: [embed], allowedMentions: { users, parse: [] } };
}

async function renderTopupReceipt(pool, projection) {
  const topup = (await pool.query(`SELECT t.*,w.available_cents,
    ledger.available_before_cents,ledger.available_after_cents
    FROM topups t JOIN wallets w ON w.discord_user_id=t.discord_user_id
    LEFT JOIN LATERAL (SELECT x.available_before_cents,x.available_after_cents
      FROM wallet_transactions x WHERE x.reference_type='TOPUP' AND x.reference_id=t.id::text
        AND x.transaction_type='TOPUP_CREDIT' ORDER BY x.created_at DESC LIMIT 1) ledger ON true
    WHERE t.id=$1`, [projection.aggregate_id])).rows[0];
  if (!topup) return { embeds: [new EmbedBuilder().setColor(color.info).setTitle('ไม่พบใบเสร็จเติมเงิน')], allowedMentions: noMentions };
  const total = BigInt(topup.amount_cents ?? 0) + BigInt(topup.bonus_cents ?? 0);
  const description = [
    `**Top-up ID:** \`${topup.id}\``, `**Provider transaction:** \`${escape(topup.provider_transaction_id)}\``,
    `**ยอดก่อนเติม:** ${baht(topup.available_before_cents)}`,
    `**เงินจากซอง:** ${baht(topup.amount_cents)}`, `**โบนัส:** ${baht(topup.bonus_cents)}`,
    `**ได้รับทั้งหมด:** ${baht(total)}`,
    `**ยอดคงเหลือใหม่:** ${baht(topup.available_after_cents ?? topup.available_cents)}`,
  ].filter(Boolean).join('\n');
  return { embeds: [new EmbedBuilder().setColor(color.success).setTitle('ใบเสร็จเติมเงิน Questshop')
    .setDescription(boundedDescription(description)).setFooter({ text: 'ใบเสร็จ Discord Embed — ไม่ใช่ใบกำกับภาษี' }).setTimestamp(topup.credited_at)],
  allowedMentions: noMentions };
}

async function renderOrderDm(pool, projection, { env = {} } = {}) {
  const aggregate = (await pool.query(`SELECT a.*,o.id,o.account_username FROM order_aggregates a
    JOIN orders o ON o.id=a.order_id WHERE a.order_id=$1`, [projection.aggregate_id])).rows[0];
  if (!aggregate) return { embeds: [new EmbedBuilder().setColor(color.info).setTitle('สรุป Order ไม่พบ')], allowedMentions: noMentions };
  const items = (await pool.query(`SELECT i.id,i.sequence_number,i.quest_name,i.state,i.price_cents,i.claim_url,
      i.terminal_reason,r.state AS reservation_state,r.amount_cents,p.message_id,f.id AS refund_id
    FROM order_items i LEFT JOIN wallet_reservations r ON r.order_item_id=i.id
    LEFT JOIN refunds f ON f.order_item_id=i.id
    LEFT JOIN message_projections p ON p.projection_type='QUEST_HISTORY'
      AND p.aggregate_id=i.id::text AND p.surface_key='QUEST_HISTORY'
    WHERE i.order_id=$1 ORDER BY i.sequence_number`, [projection.aggregate_id])).rows;
  const totals = (await pool.query(`SELECT
      COALESCE(sum(r.amount_cents) FILTER (WHERE r.state='CAPTURED'),0)::bigint AS captured_cents,
      COALESCE(sum(r.amount_cents) FILTER (WHERE r.state='RELEASED'),0)::bigint AS released_cents,
      COALESCE(sum(r.amount_cents) FILTER (WHERE r.state='RESERVED'),0)::bigint AS reserved_cents,
      COALESCE(sum(f.amount_cents),0)::bigint AS refunded_cents
    FROM order_items i JOIN wallet_reservations r ON r.order_item_id=i.id
    LEFT JOIN refunds f ON f.order_item_id=i.id WHERE i.order_id=$1`, [projection.aggregate_id])).rows[0];
  const orderUser = (await pool.query('SELECT discord_user_id FROM orders WHERE id=$1', [projection.aggregate_id])).rows[0];
  const wallet = orderUser ? (await pool.query('SELECT available_cents,reserved_cents FROM wallets WHERE discord_user_id=$1',
    [orderUser.discord_user_id])).rows[0] : null;
  const historySurface = (await pool.query("SELECT guild_id,channel_id FROM surfaces WHERE surface_key='QUEST_HISTORY'")).rows[0];
  const historyBase = historySurface && env.DISCORD_GUILD_ID
    ? `https://discord.com/channels/${historySurface.guild_id ?? env.DISCORD_GUILD_ID}/${historySurface.channel_id}` : null;
  const itemLines = items.map(orderItemLine);
  const description = [
    `**Order ID:** \`${aggregate.id}\``, `**บัญชี:** ${escape(aggregate.account_username)}`,
    `**ทั้งหมด:** ${aggregate.total_items}`, `**สำเร็จ:** ${aggregate.captured_items}`,
    `**คืนยอดก่อนคิดค่าบริการ:** ${aggregate.released_items}`, `**ตรวจสอบ:** ${aggregate.review_items}`,
    `**ยอด Capture:** ${baht(totals.captured_cents)}`, `**ยอด Release:** ${baht(totals.released_cents)}`,
    `**ยอด Refund ภายหลัง:** ${baht(totals.refunded_cents)}`, `**ยอดจองคงเหลือ:** ${baht(totals.reserved_cents)}`,
    `**Wallet ปัจจุบัน:** ${baht(wallet?.available_cents)} พร้อมใช้ / ${baht(wallet?.reserved_cents)} จอง`,
    '', '**รายละเอียดรายเควส:**', ...(itemLines.length ? itemLines : ['ยังไม่มีรายการ']),
  ].join('\n');
  const firstClaimUrl = items.filter((item) => item.state === 'READY_TO_CLAIM')
    .map((item) => safeHttpsUrl(item.claim_url)).find(Boolean);
  const claimButtons = firstClaimUrl
    ? [new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(firstClaimUrl).setLabel('รับรางวัลทั้งหมด')]
    : [];
  const navigationButtons = historyBase
    ? [new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(historyBase).setLabel('ดูประวัติ Quest ทั้งหมด')]
    : [];
  const components = [...claimButtons, ...navigationButtons].length
    ? [new ActionRowBuilder().addComponents(...claimButtons, ...navigationButtons)] : [];
  return { embeds: [new EmbedBuilder().setColor(color.info).setTitle('สรุป Order Questshop').setDescription(boundedDescription(description))],
    components, allowedMentions: noMentions };
}

async function renderPaymentLog(pool, projection, { env, client }) {
  const topup = (await pool.query(`SELECT t.*,p.key_version,p.nonce,p.ciphertext,p.auth_tag,
    (SELECT count(*)::integer FROM payment_attempts a WHERE a.topup_id=t.id) AS attempts,
    a.provider_http_status,a.provider_evidence,a.provider_status_code,
    l.available_before_cents AS available_before,l.available_after_cents AS available_after,
    l.reserved_before_cents AS reserved_before,l.reserved_after_cents AS reserved_after,l.id AS wallet_transaction_id
    FROM topups t LEFT JOIN topup_sensitive_payloads p ON p.topup_id=t.id
    LEFT JOIN LATERAL (SELECT w.* FROM wallet_transactions w WHERE w.reference_type='TOPUP'
      AND w.reference_id=t.id::text ORDER BY w.created_at DESC LIMIT 1) l ON true
    LEFT JOIN LATERAL (SELECT provider_http_status,provider_evidence,provider_status_code FROM payment_attempts a
      WHERE a.topup_id=t.id ORDER BY a.attempt_number DESC LIMIT 1) a ON true WHERE t.id=$1`, [projection.aggregate_id])).rows[0];
  if (!topup) return { embeds: [new EmbedBuilder().setColor(color.info).setTitle('ไม่พบ Payment Log')], allowedMentions: noMentions };
  const sensitive = topup.key_version == null ? null : JSON.parse(decryptSecret({
    keyVersion: topup.key_version, nonce: topup.nonce, ciphertext: topup.ciphertext, authTag: topup.auth_tag,
  }, env.DATA_ENCRYPTION_KEYS_JSON, `topup:${topup.id}:${env.DISCORD_GUILD_ID}`));
  const user = client?.users?.fetch
    ? await client.users.fetch(topup.discord_user_id).catch(() => null) : null;
  const logTitle = topup.status === 'CREDITED' ? '✅ เติมเงินสำเร็จ' : `⚠️ ${topupStateLabel(topup.status)}`;
  const statusLabel = topup.status === 'CREDITED' ? 'เติมเงินสำเร็จ' : topupStateLabel(topup.status);
  const voucherUrl = sensitive?.url ? safeTrueMoneyVoucherUrl(sensitive.url) : null;
  const diagnostic = topup.failure_code ?? topup.warning_code;
  const showReason = ['REJECTED', 'MANUAL_REVIEW', 'REVERSED'].includes(topup.status) && diagnostic;
  const evidence = topup.provider_evidence ?? {};
  const verifiedByProvider = evidence.receiverConfirmation === 'REQUEST_BOUND_SUCCESS';
  const settlementReference = evidence.settlementIdentity === 'VOUCHER_HMAC'
    ? 'รหัสซองที่เข้ารหัสและ Top-up ID' : evidence.settlementIdentity === 'PROVIDER_TRANSACTION_ID'
      ? 'เลขธุรกรรมจาก TrueMoney' : null;
  const httpStatus = Number.isInteger(topup.provider_http_status) && topup.provider_http_status >= 100
    && topup.provider_http_status <= 599 ? topup.provider_http_status : null;
  const description = [
    `**Top-up ID:** \`${topup.id}\``,
    `**สถานะ:** ${statusLabel}`,
    `**ลิงก์ซอง:** ${voucherUrl ? `<${voucherUrl}>` : 'payload เข้ารหัสหมดอายุแล้ว — กู้ลิงก์เดิมไม่ได้'}`,
    `**ผู้เติม:** <@${topup.discord_user_id}> (\`${topup.discord_user_id}\`)`,
    `**Provider transaction:** ${topup.provider_transaction_id ? `\`${escape(topup.provider_transaction_id)}\`` : 'ไม่ระบุ'}`,
    `**Wallet transaction:** ${topup.wallet_transaction_id ? `\`${escape(topup.wallet_transaction_id)}\`` : 'ไม่ระบุ'}`,
    `**ยอดเงินต้น:** ${moneyOrUnknown(topup.amount_cents)}`,
    `**โบนัส:** ${moneyOrUnknown(topup.bonus_cents)}`, `**Wallet ก่อน/หลัง:** ${moneyOrUnknown(topup.available_before)} → ${moneyOrUnknown(topup.available_after)}`,
    `**ยอดจองก่อน/หลัง:** ${moneyOrUnknown(topup.reserved_before)} → ${moneyOrUnknown(topup.reserved_after)}`, `**Attempts:** ${topup.attempts}`,
    `**เบอร์รับเงิน:** \`••••${escape(topup.receiver_phone_last4)}\``,
    ...(httpStatus != null ? [`**HTTP:** ${httpStatus}`] : []),
    ...(settlementReference ? [`**วิธีอ้างอิงรายการ:** ${settlementReference}`] : []),
    ...(verifiedByProvider ? ['**การยืนยันจาก TrueMoney:** ยืนยันยอดและผู้รับแล้ว'] : []),
    ...(showReason ? [`**เหตุผล:** ${paymentReasonLabel(diagnostic)}`] : []),
    `**Trace:** \`${topup.trace_id}\``,
  ].join('\n');
  const embed = new EmbedBuilder().setColor(paymentEmbedColor(topup.status))
    .setTitle(title(logTitle)).setDescription(boundedDescription(description))
    .setImage(PAYMENT_LOG_BANNER_ATTACHMENT_URL).setTimestamp(topup.updated_at);
  if (user) setSafeThumbnail(embed, user.displayAvatarURL({ size: 128 }));
  return {
    embeds: [embed], attachments: [],
    files: [{ attachment: await loadPaymentLogBanner(), name: PAYMENT_LOG_BANNER_FILENAME }],
    allowedMentions: { users: [topup.discord_user_id], parse: [] },
  };
}

function customerTopupStatus(status) {
  return {
    PAYMENT_QUEUED: ['⏳ รับรายการเติมเงินแล้ว', 'ระบบบันทึกรายการแล้วและกำลังเริ่มตรวจสอบซองกับ TrueMoney'],
    PROCESSING: ['🔄 กำลังตรวจสอบซอง', 'ระบบกำลังตรวจสอบซองกับ TrueMoney กรุณาอย่าส่งซองเดิมซ้ำ'],
    RETRY_WAIT: ['🟡 กำลังลองตรวจสอบใหม่', 'การเชื่อมต่อก่อนส่งคำขอยังไม่สำเร็จ ระบบจะลองใหม่อย่างปลอดภัย'],
    REDEEMED: ['⏳ รับเงินจากซองแล้ว', 'TrueMoney ยืนยันการรับเงินแล้ว ระบบกำลังเพิ่มเครดิตเข้ากระเป๋า'],
    CREDITED: ['✅ เติมเครดิตสำเร็จ', 'เครดิตถูกเพิ่มเข้ากระเป๋าของคุณเรียบร้อยแล้ว'],
    MANUAL_REVIEW: ['🔎 รายการเติมเงินกำลังตรวจสอบ', 'ระบบยังไม่ได้เพิ่มเครดิต รายการนี้ถูกส่งให้ Owner ตรวจสอบ'],
    REJECTED: ['⚠️ รายการเติมเงินไม่ได้รับอนุมัติ', 'รายการนี้ไม่ได้เพิ่มเครดิต หากต้องการความช่วยเหลือให้ติดต่อ Owner พร้อม Top-up ID'],
    INVALID: ['❌ ใช้ซองนี้ไม่ได้', 'ระบบไม่ได้เพิ่มเครดิตจากซองนี้ กรุณาตรวจสอบลิงก์แล้วสร้างซองใหม่'],
    EXPIRED: ['❌ ซองหมดอายุแล้ว', 'ระบบไม่ได้เพิ่มเครดิตจากซองนี้ กรุณาสร้างซองใหม่แล้วส่งอีกครั้ง'],
    ALREADY_REDEEMED: ['❌ ซองถูกใช้ไปแล้ว', 'ระบบไม่ได้เพิ่มเครดิตจากซองนี้ กรุณาใช้ซองที่ยังไม่เคยรับ'],
    FAILED: ['❌ เติมเครดิตไม่สำเร็จ', 'รายการนี้ไม่ได้เพิ่มเครดิต คุณสามารถลองใหม่ด้วยซองใหม่ได้'],
    REVERSED: ['↩️ เครดิตถูกย้อนกลับ', 'เครดิตจากรายการนี้ถูกย้อนกลับตามผลการตรวจสอบ'],
  }[status] ?? ['ℹ️ อัปเดตสถานะเติมเงิน', 'สถานะรายการเติมเงินมีการเปลี่ยนแปลง'];
}

async function renderTopupStatusDm(pool, projection, { client } = {}) {
  const topup = (await pool.query(`SELECT t.*,
    l.available_before_cents,l.available_after_cents,w.available_cents AS wallet_available_cents
    FROM topups t
    LEFT JOIN wallets w ON w.discord_user_id=t.discord_user_id
    LEFT JOIN LATERAL (SELECT x.* FROM wallet_transactions x
      WHERE x.reference_type='TOPUP' AND x.reference_id=t.id::text
      ORDER BY x.created_at DESC LIMIT 1) l ON true
    WHERE t.id=$1`, [projection.aggregate_id])).rows[0];
  if (!topup) return { embeds: [new EmbedBuilder().setColor(color.info).setTitle('ไม่พบสถานะเติมเงิน')], allowedMentions: noMentions };
  const [heading, message] = customerTopupStatus(topup.status);
  const reason = paymentReasonLabel(topup.failure_code ?? topup.warning_code);
  const terminal = ['CREDITED', 'MANUAL_REVIEW', 'REJECTED', 'INVALID', 'EXPIRED', 'ALREADY_REDEEMED', 'FAILED', 'REVERSED']
    .includes(topup.status);
  const total = BigInt(topup.amount_cents ?? 0) + BigInt(topup.bonus_cents ?? 0);
  const hasCreditAmounts = ['CREDITED', 'REVERSED'].includes(topup.status);
  const lines = [
    message,
    '',
    '**ข้อมูลรายการ**',
    `**Top-up ID:** \`${escape(topup.id)}\``,
    `**สถานะ:** ${topupStateLabel(topup.status)}`,
    `**ส่งรายการเมื่อ:** ${timestamp(topup.created_at, 'F')}`,
    ...(topup.credited_at ? [`**${['CREDITED', 'REVERSED'].includes(topup.status) ? 'เติมสำเร็จเมื่อ' : 'ดำเนินการล่าสุดเมื่อ'}:** ${timestamp(topup.credited_at, 'F')}`] : []),
    ...(terminal && !topup.credited_at ? [`**ดำเนินการล่าสุดเมื่อ:** ${timestamp(topup.updated_at, 'F')}`] : []),
  ];
  if (hasCreditAmounts) {
    lines.push('', '**รายละเอียดเครดิต**');
    if (topup.status === 'REVERSED') {
      lines.push(`**ยอดที่ย้อนกลับ:** ${moneyOrUnknown(total)}`);
      lines.push(`**ยอดคงเหลือปัจจุบัน:** ${moneyOrUnknown(topup.wallet_available_cents)}`);
    } else {
      lines.push(`**ยอดก่อนเติม:** ${moneyOrUnknown(topup.available_before_cents)}`);
      lines.push(`**ยอดเงินจากซอง:** ${moneyOrUnknown(topup.amount_cents)}`);
      lines.push(`**โบนัสโปรโมชั่น:** ${moneyOrUnknown(topup.bonus_cents)}`);
      lines.push(`**ได้รับทั้งหมด:** ${moneyOrUnknown(total)}`);
      lines.push(`**ยอดคงเหลือใหม่:** ${moneyOrUnknown(topup.available_after_cents ?? topup.wallet_available_cents)}`);
    }
  }
  if (reason) lines.push('', `**เหตุผล:** ${reason}`);
  lines.push('', 'โปรดเก็บ Top-up ID ไว้สำหรับติดต่อผู้ดูแล');
  const embed = new EmbedBuilder().setColor(paymentEmbedColor(topup.status)).setTitle(title(heading))
    .setDescription(boundedDescription(lines.join('\n')))
    .setImage(PAYMENT_LOG_BANNER_ATTACHMENT_URL)
    .setTimestamp(topup.updated_at);
  await setDiscordUserThumbnail(embed, client, topup.discord_user_id);
  return {
    embeds: [embed], attachments: [],
    files: [{ attachment: await loadPaymentLogBanner(), name: PAYMENT_LOG_BANNER_FILENAME }],
    allowedMentions: noMentions,
  };
}

async function renderQuestOperation(pool, projection) {
  const quest = (await pool.query(`SELECT q.*,(SELECT count(*)::integer FROM quest_test_runs t WHERE t.quest_id=q.quest_id) AS test_attempts,
    (SELECT state FROM quest_test_runs t WHERE t.quest_id=q.quest_id ORDER BY created_at DESC LIMIT 1) AS latest_test_state
    FROM quests q WHERE q.quest_id=$1`, [projection.aggregate_id])).rows[0];
  if (!quest) return missingProjection('ไม่พบ Quest Operation');
  const ready = quest.sale_state === 'OPEN' && quest.analysis_state === 'SUPPORTED';
  const description = [
    `**Quest:** ${escape(quest.name)}`,
    `**ประเภท:** ${questTypeLabel(quest.task_type)}`,
    `**ตรวจข้อมูล:** ${analysisStateLabel(quest.analysis_state)}`,
    `**การเปิดขาย:** ${saleStateLabel(quest.sale_state)}`,
    `**การประกาศ:** ${announcementStateLabel(quest.announcement_state)}`,
    `**ผลทดสอบล่าสุด:** ${quest.test_attempts} ครั้ง • ${questTestStateLabel(quest.latest_test_state)}`,
    `**หมดอายุ:** ${timestamp(quest.expires_at, 'R')}`,
    reference([`รหัส Quest: \`${escape(quest.quest_id)}\``, `รหัสติดตาม: \`${escape(quest.trace_id)}\``, `รุ่นงาน: \`${escape(quest.executor_id)}\``]),
    summary(ready ? 'Quest นี้พร้อมรับทำ' : quest.sale_state === 'PAUSED' ? 'หยุดรับทำชั่วคราว' : 'Quest นี้ยังไม่พร้อมรับทำ'),
  ].join('\n');
  const questColor = ready ? color.success : quest.sale_state === 'PAUSED' ? color.pending
    : quest.analysis_state === 'UNSUPPORTED' || quest.sale_state === 'EXPIRED' ? color.failure : color.info;
  const embed = new EmbedBuilder().setColor(questColor).setTitle(ready ? '✅ Quest พร้อมรับทำ' : '🔎 สถานะ Quest')
    .setDescription(boundedDescription(description)).setTimestamp(quest.updated_at);
  setSafeThumbnail(embed, quest.artwork_url);
  return { embeds: [embed], allowedMentions: noMentions };
}

async function renderCheckoutAudit(pool, projection, { client } = {}) {
  const session = (await pool.query(`SELECT s.*,
    (SELECT count(*)::integer FROM checkout_quest_options o WHERE o.session_id=s.id) AS option_count,
    (SELECT count(*)::integer FROM checkout_quest_options o WHERE o.session_id=s.id AND o.selected) AS selected_count,
    (SELECT COALESCE(sum(o.price_cents) FILTER (WHERE o.selected),0)::bigint FROM checkout_quest_options o WHERE o.session_id=s.id) AS selected_total_cents
    FROM interaction_sessions s WHERE s.id=$1`, [projection.aggregate_id])).rows[0];
  if (!session) return missingProjection('ไม่พบ Checkout Audit');
  const profile = session.payload ?? {};
  const selected = (await pool.query(`SELECT quest_name FROM checkout_quest_options
    WHERE session_id=$1 AND selected=true ORDER BY created_at,id LIMIT 10`, [session.id])).rows;
  const more = Math.max(0, Number(session.selected_count ?? 0) - selected.length);
  const selectedText = selected.length ? selected.map((item) => `• ${escape(item.quest_name)}`).join('\n') : 'ยังไม่ได้เลือก Quest';
  const description = [
    `**บัญชี Quest:** ${escape(profile.username ?? 'ไม่ระบุ')}`,
    `**Quest ที่พบ:** ${session.option_count} รายการ`, `**เลือกแล้ว:** ${session.selected_count} รายการ • ${moneyOrUnknown(session.selected_total_cents)}`,
    '**รายการที่เลือก:**', selectedText, ...(more ? [`และอีก ${more} รายการ`] : []),
    `**สถานะ Checkout:** ${checkoutStateLabel(session.state)}`,
    ...(session.payload?.orderId ? [`**Order ที่สร้าง:** \`${escape(session.payload.orderId)}\``] : []),
    `**หมดอายุ:** ${timestamp(session.expires_at, 'R')}`,
    reference([`รหัส Checkout: \`${escape(session.id)}\``, `รหัสบัญชี Quest: \`${escape(profile.accountId)}\``, `รหัสติดตาม: \`${escape(session.trace_id)}\``]),
    summary(session.state === 'CONFIRMED' ? 'สร้าง Order จากรายการที่เลือกแล้ว' : session.state === 'EXPIRED' ? 'หมดเวลาเลือก Quest แล้ว' : 'ลูกค้ากำลังเลือก Quest อยู่'),
  ].join('\n');
  const embed = new EmbedBuilder().setColor(session.state === 'CONFIRMED' ? color.success : session.state === 'EXPIRED' ? color.pending : color.info).setTitle(session.state === 'CONFIRMED' ? '✅ สร้าง Order จาก Checkout แล้ว' : session.state === 'EXPIRED' ? '⌛ Checkout หมดเวลา' : '🔵 ลูกค้ากำลังเลือก Quest')
    .setDescription(boundedDescription(description)).setTimestamp(session.created_at);
  setSafeThumbnail(embed, profile.avatarUrl);
  if (!safeHttpsUrl(profile.avatarUrl)) await setDiscordUserThumbnail(embed, client, profile.accountId);
  return { embeds: [embed], allowedMentions: noMentions };
}

async function renderCustomerQuestDiscovery(pool, projection, { client } = {}) {
  const found = (await pool.query(`SELECT d.*,q.name,q.task_type,q.executor_id,q.sale_state
    FROM customer_quest_discoveries d JOIN quests q ON q.quest_id=d.quest_id WHERE d.id=$1`,
  [projection.aggregate_id])).rows[0];
  if (!found) return missingProjection('ไม่พบ Customer Quest Discovery');
  const pending = found.state === 'PENDING';
  const status = discoveryStateLabel(found.state);
  const description = [
    `**ผู้พบ Quest:** <@${found.discord_user_id}> (\`${found.discord_user_id}\`)`,
    `**บัญชี Quest:** ${escape(found.account_username)} (\`${escape(found.account_id)}\`)`,
    `**Quest:** ${escape(found.name)}`, `**ประเภท:** ${questTypeLabel(found.task_type)}`,
    `**สถานะ:** ${status}`,
    ...(pending ? ['**ต้องตัดสินใจ:** เลือก “ส่งประกาศ” เพื่อประกาศ Quest หรือ “ทดสอบก่อน” เพื่อตรวจผลก่อนเปิดขาย'] : []),
    reference([`รหัส Quest: \`${escape(found.quest_id)}\``, `รหัส Checkout: \`${escape(found.checkout_session_id)}\``, `รหัสติดตาม: \`${escape(found.trace_id)}\``]),
    summary(pending ? 'รอผู้ดูแลเลือกว่าจะประกาศหรือส่งไปทดสอบ' : found.state === 'PUBLISHED' ? 'ประกาศ Quest แล้ว' : 'ส่ง Quest ไปทดสอบแล้ว'),
  ].join('\n');
  const embed = new EmbedBuilder().setColor(pending ? color.pending : found.state === 'PUBLISHED' ? color.success : color.info).setTitle(pending ? '🔎 พบ Quest ใหม่จาก Checkout ลูกค้า' : found.state === 'PUBLISHED' ? '✅ ประกาศ Quest ที่ลูกค้าพบแล้ว' : '🔵 ส่ง Quest ที่ลูกค้าพบไปทดสอบแล้ว')
    .setDescription(boundedDescription(description)).setTimestamp(found.created_at);
  setSafeThumbnail(embed, found.account_avatar_url);
  if (!safeHttpsUrl(found.account_avatar_url)) await setDiscordUserThumbnail(embed, client, found.account_id);
  const components = pending ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`qs:v1:customer_quest_publish:${found.id}`)
      .setLabel('ส่งประกาศ').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`qs:v1:customer_quest_test:${found.id}`)
      .setLabel('ทดสอบก่อน').setStyle(ButtonStyle.Primary),
  )] : [];
  return { embeds: [embed], components, allowedMentions: { users: [found.discord_user_id], parse: [] } };
}

async function renderCustomerQuestDiscoveryCase(pool, projection, { client } = {}) {
  const found = (await pool.query(`SELECT c.*,q.name,q.task_type,q.url,q.artwork_url,b.cycle_number,b.state AS search_state,
      latest.created_at AS latest_discovered_at
    FROM customer_quest_discovery_cases c JOIN quests q ON q.quest_id=c.quest_id
    LEFT JOIN customer_quest_discoveries latest ON latest.id=c.latest_discovery_id
    LEFT JOIN customer_quest_monitor_search_batches b ON b.id=c.current_search_batch_id
    LEFT JOIN LATERAL (SELECT enabled AS background_testing_enabled FROM feature_gates
      WHERE gate='QUEST_BACKGROUND_TESTING_ENABLED') gate ON true WHERE c.id=$1`,
  [projection.aggregate_id])).rows[0];
  if (!found) return missingProjection('ไม่พบรายการ Quest ที่พบจากลูกค้า');
  const labels = {
    NOT_CHECKED: 'ยังไม่ได้ตรวจบัญชีทดสอบ', CHECK_QUEUED: 'กำลังเข้าคิวตรวจบัญชีทดสอบ', CHECKING: 'กำลังตรวจบัญชีทดสอบ',
    NOT_FOUND: 'ไม่พบ Quest ในบัญชีทดสอบ', CHECK_INCOMPLETE: 'ตรวจบัญชีทดสอบไม่ครบ',
    FOUND_NOT_TESTABLE: 'พบ Quest แต่ไม่มีบัญชีที่พร้อมทดสอบ', TESTING: 'กำลังทดสอบ Quest',
    TEST_FAILED: 'ทดสอบ Quest ไม่ผ่าน', PASSED: 'ทดสอบ Quest ผ่านแล้ว',
  };
  const verification = labels[found.verification_state] ?? 'กำลังตรวจสอบ Quest';
  const testingEnabled = found.background_testing_enabled !== false;
  const result = found.last_result ?? {};
  const action = found.verification_state === 'PASSED'
    ? (found.announcement_state === 'ANNOUNCED' ? 'ระบบทดสอบผ่านและประกาศ Quest แล้ว' : 'ระบบทดสอบผ่านและส่ง Quest เข้าคิวประกาศแล้ว')
    : ['NOT_FOUND', 'CHECK_INCOMPLETE', 'FOUND_NOT_TESTABLE', 'TEST_FAILED'].includes(found.verification_state)
      ? 'ผู้ดูแลเลือกตรวจและทดสอบใหม่ หรือส่งประกาศจากข้อมูลที่ลูกค้าพบได้'
      : !testingEnabled ? 'ระบบทดสอบอัตโนมัติปิดอยู่ Checkout ของลูกค้ายังใช้งานได้ตามปกติ'
      : 'ระบบกำลังดำเนินการตรวจ Quest นี้โดยอัตโนมัติ';
  const questUrl = safeHttpsUrl(found.url);
  const description = [
    `**ผู้พบครั้งแรก:** <@${escape(found.first_discord_user_id)}> • ${timestamp(found.created_at)}`,
    `**พบล่าสุด:** ${timestamp(found.latest_discovered_at ?? found.created_at)}`,
    `**บัญชี Quest ล่าสุด:** ${escape(found.latest_account_username ?? 'ไม่ระบุ')} (\`${escape(found.latest_account_id ?? 'ไม่ระบุ')}\`)`,
    `**Quest:** ${escape(found.name)}`, `**ประเภท:** ${questTypeLabel(found.task_type)}`,
    questUrl ? `**ลิงก์ Quest:** ${questUrl}` : null,
    `**สถานะตรวจ:** ${verification}`,
    !testingEnabled && ['CHECK_QUEUED', 'CHECKING'].includes(found.verification_state)
      ? '**ระบบทดสอบ:** ปิดอยู่ — รอเปิดใช้งานก่อนจึงจะตรวจต่อ' : null,
    `**ตรวจบัญชีทดสอบ:** ${Number(result.total ?? 0)} บัญชี • พบ ${Number(result.found ?? 0)} • พร้อมทดสอบ ${Number(result.testable ?? 0)} • ไม่พบ ${Number(result.notFound ?? 0)} • ตรวจไม่ได้ ${Number(result.failed ?? 0)}`,
    `**สถานะประกาศ:** ${found.announcement_state === 'ANNOUNCED' ? 'ประกาศแล้ว' : found.announcement_state === 'QUEUED' ? 'กำลังส่งประกาศ' : 'ยังไม่ประกาศ'}`,
    reference([`รหัส Quest: \`${escape(found.quest_id)}\``, `พบจากลูกค้า ${found.sighting_count} ครั้ง`, `รหัสติดตาม: \`${escape(found.trace_id)}\``]),
    summary(action),
  ].filter(Boolean).join('\n');
  const terminal = ['NOT_CHECKED', 'NOT_FOUND', 'CHECK_INCOMPLETE', 'FOUND_NOT_TESTABLE', 'TEST_FAILED'].includes(found.verification_state);
  const embed = new EmbedBuilder().setColor(found.verification_state === 'PASSED' ? color.success
    : terminal ? color.pending : color.info).setTitle(title(found.verification_state === 'PASSED'
    ? '✅ ตรวจและทดสอบ Quest จากลูกค้าแล้ว' : terminal ? '⚠️ ตรวจ Quest จากลูกค้ายังไม่สำเร็จ' : '🔎 พบ Quest ใหม่จาก Checkout ลูกค้า'))
    .setDescription(boundedDescription(description)).setTimestamp(found.updated_at);
  setSafeThumbnail(embed, found.latest_account_avatar_url);
  if (!safeHttpsUrl(found.latest_account_avatar_url)) await setDiscordUserThumbnail(embed, client, found.latest_discord_user_id);
  const components = [];
  if (terminal) components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`qs:v1:customer_quest_case_retry:${found.id}`)
      .setLabel('ตรวจและทดสอบอีกครั้ง').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`qs:v1:customer_quest_case_announce:${found.id}`)
      .setLabel('ส่งประกาศ').setStyle(ButtonStyle.Danger).setDisabled(found.announcement_state !== 'NOT_ANNOUNCED'),
  ));
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

async function renderQuestTestFailure(pool, projection, { client } = {}) {
  const alert = (await pool.query(`SELECT a.*,q.name,q.task_type,q.sale_state,q.artwork_url,b.monitor_order,
    b.current_monitor_index,b.max_attempts_per_monitor,b.latest_error,b.state AS batch_state,
    (SELECT count(*)::integer FROM quest_test_runs r WHERE r.batch_id=a.batch_id) AS attempts,
    (SELECT count(DISTINCT r.target_monitor_id)::integer FROM quest_test_runs r WHERE r.batch_id=a.batch_id) AS monitor_count,
    (SELECT m.account_id FROM quest_test_runs r JOIN monitor_accounts m ON m.id=r.monitor_id
      WHERE r.batch_id=a.batch_id AND r.monitor_id IS NOT NULL ORDER BY r.created_at DESC LIMIT 1) AS latest_monitor_account_id
    FROM quest_test_failure_alerts a JOIN quests q ON q.quest_id=a.quest_id
    JOIN quest_test_batches b ON b.id=a.batch_id WHERE a.id=$1`, [projection.aggregate_id])).rows[0];
  if (!alert) return missingProjection('ไม่พบ Quest Test Failure');
  const failureCode = alert.last_error?.code ?? alert.latest_error?.code ?? alert.last_error?.message ?? alert.latest_error?.message;
  const isOpen = alert.state === 'OPEN';
  const description = [
    `**Quest:** ${escape(alert.name)}`, `**ประเภท:** ${questTypeLabel(alert.task_type)}`,
    `**ผลทดสอบ:** ไม่ผ่านหลังลอง ${alert.attempts} ครั้ง ด้วยบัญชีทดสอบ ${alert.monitor_count} บัญชี`,
    `**เหตุผลล่าสุด:** ${escape(reasonLabel(failureCode))}`, `**สถานะขาย:** ${saleStateLabel(alert.sale_state)}`,
    '**ผลกระทบ:** Quest นี้ยังไม่ควรเปิดขายจากผลทดสอบปกติ',
    'หากเลือก **ส่งเลย** ผู้ดูแลจะเปิดขายโดยไม่รอผลทดสอบ และระบบจะบันทึกการตัดสินใจนี้ไว้',
    reference([`รหัส Quest: \`${escape(alert.quest_id)}\``, `รหัสชุดทดสอบ: \`${escape(alert.batch_id)}\``, failureCode ? `รหัสข้อผิดพลาด: \`${escape(failureCode)}\`` : null, `รหัสติดตาม: \`${escape(alert.trace_id)}\``]),
    summary(isOpen ? 'รอผู้ดูแลตัดสินใจว่าจะทดสอบอีกครั้งหรือเปิดขายเอง' : 'รายการทดสอบนี้ได้รับการจัดการแล้ว'),
  ].join('\n');
  const send = new ButtonBuilder().setCustomId(`qs:v1:test_fail_send:${alert.id}`)
    .setLabel('ส่งเลย').setStyle(ButtonStyle.Danger).setDisabled(!isOpen);
  const retry = new ButtonBuilder().setCustomId(`qs:v1:test_fail_retry:${alert.id}`)
    .setLabel('ลองทดสอบอีกครั้ง').setStyle(ButtonStyle.Primary).setDisabled(!isOpen);
  const alertTitle = alert.state === 'OPEN' ? '⚠️ ทดสอบ Quest ไม่ผ่าน' : '✅ จัดการผลทดสอบ Quest แล้ว';
  const embed = new EmbedBuilder().setColor(isOpen ? color.failure : color.success).setTitle(title(alertTitle))
    .setDescription(boundedDescription(description)).setTimestamp(alert.updated_at);
  const monitorFound = await setDiscordUserThumbnail(embed, client, alert.latest_monitor_account_id);
  if (!monitorFound) setSafeThumbnail(embed, alert.artwork_url);
  return { embeds: [embed],
  components: [new ActionRowBuilder().addComponents(send, retry)], allowedMentions: noMentions };
}

async function renderManualReview(pool, projection) {
  const review = (await pool.query(`SELECT r.*,
    (SELECT count(*)::integer FROM review_evidence e WHERE e.review_id=r.id) AS evidence_count,
    w.available_cents,w.reserved_cents,
    COALESCE(payment_attempts.attempt_count,0)+COALESCE(runner_attempts.attempt_count,0) AS attempt_count,
    COALESCE(payment_attempts.last_error_class,runner_attempts.last_error_class) AS last_error_class
    FROM manual_reviews r
    LEFT JOIN topups t ON r.subject_type='TOPUP' AND t.id::text=r.subject_id
    LEFT JOIN order_items i ON r.subject_type='ORDER_ITEM' AND i.id::text=r.subject_id
    LEFT JOIN orders o ON o.id=i.order_id
    LEFT JOIN wallets w ON w.discord_user_id=COALESCE(t.discord_user_id,o.discord_user_id)
    LEFT JOIN LATERAL (SELECT count(*)::integer AS attempt_count,
      (array_agg(p.error_class ORDER BY p.started_at DESC) FILTER (WHERE p.error_class IS NOT NULL))[1] AS last_error_class
      FROM payment_attempts p WHERE p.topup_id::text=r.subject_id AND r.subject_type='TOPUP') payment_attempts ON true
    LEFT JOIN LATERAL (SELECT count(*)::integer AS attempt_count,
      (array_agg(a.error_class ORDER BY a.started_at DESC) FILTER (WHERE a.error_class IS NOT NULL))[1] AS last_error_class
      FROM runner_attempts a JOIN runner_jobs j ON j.id=a.job_id
      WHERE j.order_item_id::text=r.subject_id AND r.subject_type='ORDER_ITEM') runner_attempts ON true
    WHERE r.id=$1`, [projection.aggregate_id])).rows[0];
  if (!review) return missingProjection('ไม่พบ Manual Review');
  const wallet = review.available_cents == null ? 'ไม่พบ Wallet' : `${baht(review.available_cents)} / จอง ${baht(review.reserved_cents)}`;
  const description = [
    `**Review ID:** \`${review.id}\``, `**Subject:** ${escape(review.subject_type)} / \`${escape(review.subject_id)}\``,
    `**เหตุผล:** ${escape(review.opened_reason)}`, `**Financial:** ${review.financial ? 'ใช่' : 'ไม่'}`,
    `**Owner-only:** ${review.owner_only ? 'ใช่' : 'ไม่'}`, `**Assignee:** ${escape(review.assigned_to)}`,
    `**Wallet (พร้อมใช้ / จอง):** ${wallet}`, `**Attempts:** ${review.attempt_count}`,
    `**Error class ล่าสุด:** ${escape(review.last_error_class ?? 'ไม่ระบุ')}`,
    `**Evidence:** ${review.evidence_count}`, `**Trace:** \`${review.trace_id}\``, `**เตือนอีกครั้ง:** ${timestamp(review.remind_at, 'R')}`,
  ].join('\n');
  return { embeds: [new EmbedBuilder().setColor(review.financial ? color.failure : color.pending)
    .setTitle(title(`Manual Review • ${escape(review.state)}`)).setDescription(boundedDescription(description)).setTimestamp(review.created_at)], allowedMentions: noMentions };
}

async function renderRunnerSummary(pool, projection, { client } = {}) {
  const job = (await pool.query(`SELECT j.*,i.order_id,i.quest_id,i.quest_name,i.state AS item_state,i.progress_actual,i.progress_bucket,i.price_cents,
    o.account_id,o.account_username,o.account_avatar_url,
    (SELECT a.error_class FROM runner_attempts a WHERE a.job_id=j.id AND a.error_class IS NOT NULL
      ORDER BY a.started_at DESC LIMIT 1) AS last_error_class
    FROM runner_jobs j JOIN order_items i ON i.id=j.order_item_id JOIN orders o ON o.id=i.order_id
    WHERE j.id=$1`, [projection.aggregate_id])).rows[0];
  if (!job) return missingProjection('ไม่พบ Runner Summary');
  let runnerColor = color.info;
  if (job.state === 'COMPLETED') runnerColor = color.success;
  else if (job.state === 'FAILED') runnerColor = color.failure;
  else if (job.state === 'MANUAL_REVIEW' || job.state === 'WAITING_RATE_LIMIT') runnerColor = color.pending;
  const progress = Number(job.progress_actual ?? job.progress_bucket ?? 0);
  const description = [
    `**บัญชี Quest:** ${escape(job.account_username)} (\`${escape(job.account_id)}\`)`,
    `**Quest:** ${escape(job.quest_name)}`, `**สถานะ:** ${runnerStateLabel(job.state)}`,
    `**ความคืบหน้า:** ${Number(job.progress_bucket ?? 0)}% (${Number.isFinite(progress) ? progress : 0}%)`, `**ค่าบริการ:** ${baht(job.price_cents)}`,
    `**จำนวนครั้งที่ลอง:** ${job.attempt_count ?? 0}`,
    ...(job.last_error_class ? [`**ปัญหาล่าสุด:** ${escape(reasonLabel(job.last_error_class))}`] : []),
    reference([`Order: \`${escape(job.order_id)}\``, `รหัส Quest: \`${escape(job.quest_id)}\``, `รหัสงาน: \`${escape(job.id)}\``, `รหัสรายการ: \`${escape(job.order_item_id)}\``, `รหัสติดตาม: \`${escape(job.trace_id)}\``]),
    summary(job.state === 'COMPLETED' ? 'ทำ Quest เสร็จแล้ว' : job.state === 'FAILED' ? 'งานจบโดยทำ Quest ไม่สำเร็จ' : job.state === 'MANUAL_REVIEW' ? 'รอผู้ดูแลตรวจรายการนี้' : 'ระบบกำลังทำงานต่อเอง'),
  ].join('\n');
  const embed = new EmbedBuilder().setColor(runnerColor).setTitle(title(job.state === 'COMPLETED' ? '✅ ทำ Quest สำเร็จ' : job.state === 'FAILED' ? '❌ ทำ Quest ไม่สำเร็จ' : job.state === 'WAITING_RETRY' ? '🔵 กำลังลองทำ Quest ใหม่' : '🔵 กำลังทำ Quest'))
    .setDescription(boundedDescription(description)).setTimestamp(job.updated_at);
  setSafeThumbnail(embed, job.account_avatar_url);
  if (!safeHttpsUrl(job.account_avatar_url)) await setDiscordUserThumbnail(embed, client, job.account_id);
  return { embeds: [embed], allowedMentions: noMentions };
}

function durationLabel(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'ไม่ระบุ';
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} วินาที`;
  return `${(milliseconds / 60_000).toFixed(1)} นาที`;
}

function incidentEvidenceText(incident) {
  const evidence = incident.evidence && typeof incident.evidence === 'object' ? incident.evidence : {};
  if (incident.incident_code === 'DISCORD_CONNECTIVITY') {
    return `เชื่อมต่อไม่ได้ชั่วคราวใน: ${(evidence.surfaces ?? []).map(scopeLabel).join(', ') || 'ส่วนที่ระบุไว้ในข้อมูลอ้างอิง'}`;
  }
  if (incident.incident_code === 'OUTBOX_STUCK') {
    return `ค้าง ${evidence.stuck ?? 0} รายการ • รอส่ง ${evidence.pending ?? 0} • กำลังส่ง ${evidence.leased ?? 0} • เก่าสุด ${durationLabel(evidence.oldest_age_ms)}`;
  }
  if (incident.incident_code.endsWith('_LATENCY_SLO')) {
    const routes = Array.isArray(evidence.topRoutes) ? evidence.topRoutes.slice(0, 3).map((route) => (
      `${routeLabel(route.route)} ${durationLabel(route.p95Ms)} จาก ${route.samples} คำขอ`
    )).join(' • ') : '';
    return `เวลาตอบกลับของคำขอส่วนใหญ่: ${durationLabel(evidence.p95Ms ?? evidence.p99Ms)}${evidence.samples != null ? ` จาก ${evidence.samples} คำขอ` : ''}${routes ? `\n**ส่วนที่ช้าที่สุด:** ${routes}` : ''}`;
  }
  if (incident.incident_code === 'ERROR_RATE_HIGH') {
    const failures = Array.isArray(evidence.topFailures) ? evidence.topFailures.slice(0, 3).map((failure) => (
      `${routeLabel(failure.route)} (${failure.failed} ครั้ง)`
    )).join(' • ') : '';
    return `ไม่สำเร็จ ${evidence.failed ?? 0} จาก ${evidence.total ?? 0} คำขอใน 5 นาทีล่าสุด${failures ? `\n**จุดที่พบมากสุด:** ${failures}` : ''}`;
  }
  if (incident.incident_code === 'WORKER_HEARTBEAT_MISSING') {
    const workers = (evidence.workers ?? []).map((worker) => typeof worker === 'string' ? worker : worker.name).filter(Boolean);
    return `งานเบื้องหลังไม่ตอบกลับตามเวลา: ${workers.map(escape).join(', ') || 'ไม่ระบุ'}`;
  }
  if (incident.incident_code === 'FINANCIAL_INVARIANT') {
    return `Wallet ติดลบ ${evidence.negative ?? 0} รายการ • ยอดไม่ตรงบัญชี ${evidence.mismatch ?? 0} รายการ • เสี่ยงเพิ่มเครดิตซ้ำ ${evidence.duplicate_credit ?? 0} รายการ`;
  }
  if (incident.incident_code === 'SCHEDULER_LAG') {
    return `มีงานรอ ${evidence.queued ?? 0} รายการ • การจัดคิวช้าที่สุด ${durationLabel(evidence.lag_ms)}`;
  }
  if (incident.incident_code === 'QUEUE_STUCK') return `มีงานอัตโนมัติค้าง ${evidence.stuck ?? 0} รายการ`;
  if (incident.incident_code === 'MEMORY_PRESSURE') {
    const percent = Number(evidence.percent ?? evidence.memoryPercent);
    return `ใช้หน่วยความจำ ${Number.isFinite(percent) ? `${percent.toFixed(1)}%` : 'ไม่ระบุ'}${evidence.rssBytes ? ` • ใช้อยู่ ${(Number(evidence.rssBytes) / 1_048_576).toFixed(0)} MB` : ''}`;
  }
  if (incident.incident_code === 'EVENT_LOOP_LAG') return `ระบบประมวลผลช้า ${durationLabel(evidence.p99Ms ?? evidence.eventLoopLagMs)}`;
  if (evidence.age_ms != null || evidence.ageMs != null) return `ข้อมูลล่าสุดมีอายุ ${durationLabel(evidence.age_ms ?? evidence.ageMs)}`;
  if (evidence.count != null) return `พบ ${evidence.count} รายการที่ต้องตรวจสอบ`;
  return 'ระบบตรวจพบเหตุนี้แล้วและกำลังเก็บข้อมูลเพิ่มเติม';
}

async function renderIncident(pool, projection) {
  const incident = (await pool.query(`SELECT i.*,
    1+(SELECT count(*)::integer FROM state_transitions t WHERE t.aggregate_type='INCIDENT'
      AND t.aggregate_id=i.id::text AND t.from_state='RESOLVED' AND t.to_state='OPEN') AS occurrence_count
    FROM incidents i WHERE i.id=$1`, [projection.aggregate_id])).rows[0];
  if (!incident) return missingProjection('ไม่พบ System Incident');
  const incidentColor = incident.state === 'RESOLVED' ? color.success
    : incident.severity === 'CRITICAL' ? color.failure
      : incident.severity === 'ERROR' ? 0xed8a19 : color.pending;
  const definition = incidentDefinition(incident.incident_code);
  const requiresOperator = Boolean(definition.guidance && !definition.guidance.startsWith('ระบบ'));
  const description = [
    `**เกิดอะไรขึ้น:** ${incident.state === 'RESOLVED' ? `${definition.title} กลับมาปกติแล้ว` : definition.title}`,
    `**กระทบ:** ${definition.impact}`, `**ส่วนที่เกี่ยวข้อง:** ${scopeLabel(incident.scope)}`,
    `**รายละเอียดที่พบ:** ${incidentEvidenceText(incident)}`,
    ...(incident.state !== 'RESOLVED' && definition.guidance
      ? [`**${requiresOperator ? 'ควรทำ' : 'การจัดการ'}:** ${definition.guidance}`] : []),
    `**เกิดซ้ำ:** ${incident.occurrence_count} ครั้ง • ล่าสุด ${timestamp(incident.updated_at, 'R')}`,
    reference([`รหัสเหตุ: \`${escape(incident.incident_code)}\``, `ขอบเขต: \`${escape(incident.scope)}\``, `รหัสติดตาม: \`${escape(incident.trace_id)}\``]),
    summary(incident.state === 'RESOLVED' ? 'ระบบกลับมาทำงานตามปกติแล้ว' : requiresOperator ? 'ผู้ดูแลต้องตรวจตามคำแนะนำข้างต้น' : 'ระบบกำลังจัดการเหตุนี้อยู่'),
  ].join('\n');
  return { embeds: [new EmbedBuilder().setColor(incidentColor).setTitle(title(incident.state === 'RESOLVED' ? `✅ ${definition.title} กลับมาปกติแล้ว` : `⚠️ ${definition.title}`))
    .setDescription(boundedDescription(description)).setTimestamp(incident.updated_at)], allowedMentions: noMentions };
}

const ADMIN_AUDIT_FIELDS = Object.freeze({
  WALLET: [['availableCents', 'available_cents', 'เครดิตพร้อมใช้', 'money'], ['reservedCents', 'reserved_cents', 'ยอดจอง', 'money'], ['deltaAvailableCents', 'delta_available_cents', 'ยอดที่เปลี่ยน', 'money']],
  TOPUP: [['status', 'status', 'สถานะ', 'topup'], ['amountCents', 'amount_cents', 'ยอดเงินต้น', 'money'], ['reversalCents', 'reversal_cents', 'ยอดย้อนกลับ', 'money'], ['reviewId', 'review_id', 'รหัสรายการตรวจ', 'text']],
  FEATURE_GATE: [['enabled', 'enabled', 'การใช้งาน', 'boolean'], ['reason', 'reason', 'เหตุผล', 'reason']],
  QUEST_PRICE_CATEGORY: [['taskType', 'task_type', 'ประเภท Quest', 'questType'], ['amountCents', 'amount_cents', 'ราคา', 'money']],
  PROMOTION: [['state', 'state', 'สถานะ', 'state'], ['tiers', 'tiers', 'เงื่อนไขโบนัส', 'tiers'], ['maxUsesPerUser', 'max_uses_per_user', 'ใช้ได้ต่อคน', 'number'], ['maxBonusPerDayCents', 'max_bonus_per_day_cents', 'โบนัสสูงสุดต่อวัน', 'money']],
  MONITOR: [['accountId', 'account_id', 'บัญชี Discord', 'text'], ['state', 'state', 'สถานะ', 'state'], ['capabilities', 'capabilities', 'ความสามารถ', 'list']],
  RECEIVER: [['phoneLast4', 'phone_last4', 'เบอร์รับเงิน', 'phone'], ['state', 'state', 'สถานะ', 'state']],
  MANUAL_REVIEW: [['state', 'state', 'สถานะ', 'state'], ['assignedTo', 'assigned_to', 'ผู้รับผิดชอบ', 'text'], ['decision', 'decision', 'ผลการตัดสินใจ', 'state']],
  ORDER_ITEM: [['state', 'state', 'สถานะ Quest', 'order'], ['reservationState', 'reservation_state', 'สถานะเครดิต', 'state']],
  QUEST: [['saleState', 'sale_state', 'การเปิดขาย', 'sale'], ['testGateOverride', 'test_gate_override', 'เปิดขายโดยไม่รอผลทดสอบ', 'boolean'], ['alertState', 'alert_state', 'สถานะการแจ้งเตือน', 'state']],
  CIRCUIT_BREAKER: [['state', 'state', 'สถานะ', 'state'], ['reason', 'reason', 'เหตุผล', 'reason'], ['failureCount', 'failure_count', 'จำนวนที่ไม่สำเร็จ', 'number']],
  SURFACE: [['channelId', 'channel_id', 'ห้อง Discord', 'text'], ['messageId', 'message_id', 'ข้อความ Discord', 'text']],
  DLQ: [['state', 'state', 'สถานะ', 'state'], ['category', 'category', 'ประเภทงาน', 'state'], ['errorCode', 'error_code', 'สาเหตุ', 'reason']],
  CONFIG: [['runnerConcurrency', 'runner_concurrency', 'จำนวนงานอัตโนมัติพร้อมกัน', 'number'],
    ['topupAutoCreditMinCents', 'topup_auto_credit_min_cents', 'ยอดขั้นต่ำที่เพิ่มเครดิตอัตโนมัติ', 'money'],
    ['topupAutoCreditMaxCents', 'topup_auto_credit_max_cents', 'ยอดสูงสุดที่เพิ่มเครดิตอัตโนมัติ', 'money'],
    ['topupDailyLimitCents', 'topup_daily_limit_cents', 'วงเงินเติมต่อวัน', 'money'],
    ['questAnnouncementRoleId', 'quest_announcement_role_id', 'Role ประกาศ Quest', 'text']],
  DISCORD_USER: [['expiresAt', 'expires_at', 'หมดอายุ', 'date'], ['totalCents', 'total_cents', 'ยอดรวม', 'money'], ['limitCents', 'limit_cents', 'วงเงิน', 'money'], ['cleared', 'cleared', 'ปลดล็อกแล้ว', 'boolean']],
});

function readAuditValue(item, camel, snake) { return item?.[camel] ?? item?.[snake]; }
function auditValue(value, type = 'text') {
  if (value == null) return 'ไม่ระบุ';
  if (type === 'money') return baht(value);
  if (type === 'boolean') return value ? 'เปิด' : 'ปิด';
  if (type === 'phone') return `••••${escape(value)}`;
  if (type === 'questType') return questTypeLabel(value);
  if (type === 'sale') return saleStateLabel(value);
  if (type === 'order') return orderStateLabel(value);
  if (type === 'topup') return topupStateLabel(value);
  if (type === 'reason') return escape(reasonLabel(value));
  if (type === 'date') return timestamp(value, 'F');
  if (type === 'list') return Array.isArray(value) ? value.map((item) => escape(item)).join(', ') || 'ไม่มี' : escape(value);
  if (type === 'tiers') return Array.isArray(value) ? value.map((tier) => {
    const minimum = tier.minimumAmountCents ?? tier.minimum_amount_cents;
    const basisPoints = Number(tier.basisPoints ?? tier.basis_points);
    return `${minimum != null ? baht(minimum) : 'ไม่ระบุ'} ขึ้นไป: โบนัส ${Number.isFinite(basisPoints) ? `${(basisPoints / 100).toFixed(2).replace(/\.00$/, '')}%` : 'ไม่ระบุ'}`;
  }).join('; ') : 'มีเงื่อนไขโปรโมชั่น';
  if (type === 'state') return reasonLabel(value);
  return escape(value);
}

function auditChanges(targetType, before, after) {
  const fields = ADMIN_AUDIT_FIELDS[targetType] ?? [];
  const from = Array.isArray(before) ? before[0] : before ?? {};
  const to = Array.isArray(after) ? after[0] : after ?? {};
  return fields.map(([camel, snake, label, type]) => {
    const oldValue = readAuditValue(from, camel, snake);
    const newValue = readAuditValue(to, camel, snake);
    if (newValue == null || String(oldValue) === String(newValue)) return null;
    return `• **${label}:** ${auditValue(oldValue, type)} → ${auditValue(newValue, type)}`;
  }).filter(Boolean);
}

async function renderAdminAudit(pool, projection, { client } = {}) {
  const audit = (await pool.query('SELECT * FROM admin_audit_logs WHERE id=$1', [projection.aggregate_id])).rows[0];
  if (!audit) return missingProjection('ไม่พบ Admin Audit');
  const actorIsUser = /^\d{17,20}$/.test(audit.actor_id);
  const actor = actorIsUser ? `<@${audit.actor_id}>` : audit.actor_id === 'SYSTEM' ? 'ระบบ' : escape(audit.actor_id);
  const changes = auditChanges(audit.target_type, audit.before_state, audit.after_state);
  const description = [
    `**ผู้ดำเนินการ:** ${actor}${actorIsUser ? ` (\`${audit.actor_id}\`)` : ''}`,
    `**รายการที่แก้:** ${adminTargetLabel(audit.target_type)}`,
    ...(changes.length ? ['**สิ่งที่เปลี่ยน:**', ...changes] : ['**สิ่งที่เปลี่ยน:** ไม่มีข้อมูลที่ปลอดภัยให้แสดงเพิ่มเติม']),
    `**เหตุผล:** ${escape(adminReasonLabel(audit.reason))}`,
    reference([`รหัสการทำงาน: \`${escape(audit.action)}\``, `รหัสรายการ: \`${escape(audit.target_id)}\``, `รหัสอ้างอิง: \`${escape(audit.correlation_code)}\``, `รหัสติดตาม: \`${escape(audit.trace_id)}\``]),
    summary(`${actorIsUser ? 'ผู้ดูแล' : actor}${adminActionLabel(audit.action)}แล้ว`),
  ].join('\n');
  const allowedMentions = actorIsUser ? { users: [audit.actor_id], parse: [] } : noMentions;
  const embed = new EmbedBuilder().setColor(color.info).setTitle(title(`🛠️ ${adminActionLabel(audit.action)}`))
    .setDescription(boundedDescription(description)).setTimestamp(audit.created_at);
  if (actorIsUser) await setDiscordUserThumbnail(embed, client, audit.actor_id);
  return { embeds: [embed], allowedMentions, backofficeSystemThumbnail: audit.actor_id === 'SYSTEM' };
}

async function renderQuestHistory(pool, projection) {
  const item = (await pool.query(`SELECT i.*,o.account_username,o.account_avatar_url,q.url AS quest_url,
      r.state AS reservation_state,r.amount_cents AS reservation_amount,
      f.id AS refund_id,f.amount_cents AS refund_amount,f.created_at AS refunded_at
    FROM order_items i JOIN orders o ON o.id=i.order_id
    JOIN quests q ON q.quest_id=i.quest_id
    LEFT JOIN wallet_reservations r ON r.order_item_id=i.id
    LEFT JOIN refunds f ON f.order_item_id=i.id WHERE i.id=$1`, [projection.aggregate_id])).rows[0];
  if (!item) return { embeds: [new EmbedBuilder().setColor(color.info).setTitle('ไม่พบประวัติ Quest')], allowedMentions: noMentions };
  let tone = color.pending;
  if (item.state === 'READY_TO_CLAIM') tone = color.success;
  else if (item.state?.endsWith('_RELEASED')) tone = color.failure;
  const status = { title: `${orderStateIcon(item.state)} ${orderStateLabel(item.state)}`, tone };
  const claimUrl = safeHttpsUrl(item.claim_url);
  const questUrl = safeHttpsUrl(item.quest_url);
  const creditState = item.refund_id
    ? `↩️ คืนเครดิตแล้ว ${baht(item.refund_amount)} • ${timestamp(item.refunded_at, 'R')}`
    : reservationStateLabel(item.reservation_state);
  const progressText = `${escape(item.quest_name)} — ${item.progress_bucket}%`;
  const progressLine = questUrl ? `[${progressText}](${questUrl})` : progressText;
  const description = [
    `**บัญชี:** ${escape(item.account_username)}`,
    `**Quest:** ${escape(item.quest_name)}`, `**Order:** \`${escape(item.order_id)}\``,
    `**สถานะเครดิต:** ${creditState}`, `**ค่าบริการ:** ${baht(item.reservation_amount ?? item.price_cents)}`,
    `${orderStateIcon(item.state)} **${progressLine}**`,
    item.terminal_reason ? `**เหตุผล:** ${terminalReasonLabel(item.terminal_reason)}` : null,
  ].filter(Boolean).join('\n');
  const embed = new EmbedBuilder().setColor(status.tone).setTitle(title(status.title))
    .setDescription(boundedDescription(description)).setImage(QUEST_HISTORY_BANNER_ATTACHMENT_URL)
    .setTimestamp(item.updated_at);
  setSafeThumbnail(embed, item.account_avatar_url);
  const components = item.state === 'READY_TO_CLAIM' && claimUrl
    ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(claimUrl).setLabel('รับรางวัล Quest นี้'))]
    : [];
  return {
    embeds: [embed], components, attachments: [],
    files: [{ attachment: await loadQuestHistoryBanner(), name: QUEST_HISTORY_BANNER_FILENAME }],
    allowedMentions: noMentions,
  };
}

function renderFallback(_pool, projection) {
  const embed = new EmbedBuilder().setColor(color.info).setTitle(title(escape(projection.projection_type)))
    .setDescription(boundedDescription(`Aggregate: **${escape(projection.aggregate_id)}**\nอัปเดตจากสถานะล่าสุดใน PostgreSQL`)).setTimestamp();
  return { embeds: [embed], allowedMentions: noMentions };
}

const renderers = {
  REFUND_LOG: renderRefund, TOPUP_RECEIPT: renderTopupReceipt, ORDER_DM: renderOrderDm,
  PAYMENT_LOG: renderPaymentLog, PAYMENT_STATUS_LOG: renderPaymentLog, TOPUP_STATUS_DM: renderTopupStatusDm,
  QUEST_NEW: renderQuestNewProjection,
  QUEST_OPERATION: renderQuestOperation, MANUAL_REVIEW: renderManualReview, RUNNER_SUMMARY: renderRunnerSummary,
  CHECKOUT_AUDIT: renderCheckoutAudit, SYSTEM_INCIDENT: renderIncident, ADMIN_AUDIT: renderAdminAudit,
  QUEST_HISTORY: renderQuestHistory, CUSTOMER_QUEST_DISCOVERY: renderCustomerQuestDiscovery,
  CUSTOMER_QUEST_DISCOVERY_CASE: renderCustomerQuestDiscoveryCase,
  QUEST_TEST_FAILURE: renderQuestTestFailure,
};

const backofficeProjectionTypes = new Set([
  'CHECKOUT_AUDIT', 'CUSTOMER_QUEST_DISCOVERY', 'CUSTOMER_QUEST_DISCOVERY_CASE', 'QUEST_OPERATION', 'QUEST_TEST_FAILURE', 'RUNNER_SUMMARY',
  'ADMIN_AUDIT', 'SYSTEM_INCIDENT',
]);

async function withBackofficeMedia(projection, body) {
  if (!backofficeProjectionTypes.has(projection.projection_type)) return body;
  const { backofficeSystemThumbnail = false, ...payload } = body;
  const embed = payload.embeds?.[0];
  const adminAudit = projection.projection_type === 'ADMIN_AUDIT';
  const bannerUrl = adminAudit ? ADMIN_LOG_BANNER_ATTACHMENT_URL : BACKOFFICE_LOG_BANNER_ATTACHMENT_URL;
  if (embed?.setImage) embed.setImage(bannerUrl);
  const needsSystemThumbnail = projection.projection_type === 'SYSTEM_INCIDENT' || backofficeSystemThumbnail;
  if (needsSystemThumbnail && embed?.setThumbnail) embed.setThumbnail(LOG_SYSTEM_THUMBNAIL_ATTACHMENT_URL);
  const files = [adminAudit
    ? { attachment: await loadAdminLogBanner(), name: ADMIN_LOG_BANNER_FILENAME }
    : { attachment: await loadBackofficeLogBanner(), name: BACKOFFICE_LOG_BANNER_FILENAME }];
  if (needsSystemThumbnail) files.push({ attachment: await loadLogSystemThumbnail(), name: LOG_SYSTEM_THUMBNAIL_FILENAME });
  return { ...payload, attachments: [], files };
}

export async function renderProjection(pool, projection, dependencies = {}) {
  const renderer = renderers[projection.projection_type] ?? renderFallback;
  return withBackofficeMedia(projection, await renderer(pool, projection, dependencies));
}
