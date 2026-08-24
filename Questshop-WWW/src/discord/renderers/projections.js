import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { decryptSecret } from '../../adapters/crypto/keyring.js';
import { supportCode } from '../../shared/correlation.js';
import {
  orderStateIcon,
  orderStateLabel,
  reservationStateLabel,
  terminalReasonLabel,
} from './labels.js';
import { baht } from './checkout.js';
import { renderQuestNewProjection } from './quest-new.js';
import { DISCORD_LIMITS, safeDiscordText, truncateDiscordText } from '../payload.js';

const color = { pending: 0xf0b232, success: 0x23a55a, failure: 0xf23f43, info: 0x5865f2 };
const escape = (value) => safeDiscordText(value, { maximum: 1_000 });
const title = (value) => truncateDiscordText(value, DISCORD_LIMITS.embedTitle);
const boundedDescription = (value) => truncateDiscordText(value, DISCORD_LIMITS.embedDescription);
const timestamp = (value, style = 'F') => value ? `<t:${Math.floor(new Date(value).getTime() / 1000)}:${style}>` : 'ไม่ระบุ';
const noMentions = { parse: [] };
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
function setSafeThumbnail(embed, value) {
  const url = safeHttpsUrl(value);
  if (url) embed.setThumbnail(url);
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
    r.encrypted_phone,r.encryption_key_version,r.nonce AS receiver_nonce,r.auth_tag AS receiver_auth_tag,
    (SELECT count(*)::integer FROM payment_attempts a WHERE a.topup_id=t.id) AS attempts,
    l.available_before_cents AS available_before,l.available_after_cents AS available_after,
    l.reserved_before_cents AS reserved_before,l.reserved_after_cents AS reserved_after,l.id AS wallet_transaction_id
    FROM topups t LEFT JOIN topup_sensitive_payloads p ON p.topup_id=t.id
    JOIN receiver_versions r ON r.id=t.receiver_version_id
    LEFT JOIN LATERAL (SELECT w.* FROM wallet_transactions w WHERE w.reference_type='TOPUP'
      AND w.reference_id=t.id::text ORDER BY w.created_at DESC LIMIT 1) l ON true WHERE t.id=$1`, [projection.aggregate_id])).rows[0];
  if (!topup) return { embeds: [new EmbedBuilder().setColor(color.info).setTitle('ไม่พบ Payment Log')], allowedMentions: noMentions };
  const sensitive = topup.key_version == null ? null : JSON.parse(decryptSecret({
    keyVersion: topup.key_version, nonce: topup.nonce, ciphertext: topup.ciphertext, authTag: topup.auth_tag,
  }, env.DATA_ENCRYPTION_KEYS_JSON, `topup:${topup.id}:${env.DISCORD_GUILD_ID}`));
  const receiverPhone = decryptSecret({ keyVersion: topup.encryption_key_version, nonce: topup.receiver_nonce,
    ciphertext: topup.encrypted_phone, authTag: topup.receiver_auth_tag }, env.DATA_ENCRYPTION_KEYS_JSON,
  `receiver:${topup.receiver_version_id}:${env.DISCORD_GUILD_ID}`);
  const user = await client.users.fetch(topup.discord_user_id).catch(() => null);
  const logTitle = topup.status === 'CREDITED' ? '✅ เติมเงินสำเร็จ' : `⚠️ Top-up ${escape(topup.status)}`;
  const voucherUrl = sensitive?.url ?? 'encrypted payload ถูกลบตามอายุข้อมูลแล้ว';
  const description = [
    `**Top-up ID:** \`${topup.id}\``,
    `**ลิงก์ซอง:** ${voucherUrl}`,
    `**ผู้เติม:** <@${topup.discord_user_id}> (\`${topup.discord_user_id}\`)`,
    `**Provider transaction:** \`${escape(topup.provider_transaction_id)}\``,
    `**Wallet transaction:** \`${escape(topup.wallet_transaction_id)}\``, `**ยอดเงินต้น:** ${baht(topup.amount_cents)}`,
    `**โบนัส:** ${baht(topup.bonus_cents)}`, `**Wallet ก่อน/หลัง:** ${baht(topup.available_before)} → ${baht(topup.available_after)}`,
    `**Reserved ก่อน/หลัง:** ${baht(topup.reserved_before)} → ${baht(topup.reserved_after)}`, `**Attempts:** ${topup.attempts}`,
    `**Receiver snapshot:** \`${receiverPhone}\``, `**เจ้าของซอง:** ${escape(topup.sender_name)} / ${escape(topup.sender_phone)}`,
    `**Warning/Error:** ${escape(topup.warning_code ?? topup.failure_code)}`,
  ].join('\n');
  const embed = new EmbedBuilder().setColor(topup.status === 'CREDITED' ? color.success : color.failure)
    .setTitle(title(logTitle)).setDescription(boundedDescription(description)).setTimestamp(topup.updated_at);
  if (user) setSafeThumbnail(embed, user.displayAvatarURL({ size: 128 }));
  return { embeds: [embed], allowedMentions: { users: [topup.discord_user_id], parse: [] } };
}

async function renderQuestOperation(pool, projection) {
  const quest = (await pool.query(`SELECT q.*,(SELECT count(*)::integer FROM quest_test_runs t WHERE t.quest_id=q.quest_id) AS test_attempts,
    (SELECT state FROM quest_test_runs t WHERE t.quest_id=q.quest_id ORDER BY created_at DESC LIMIT 1) AS latest_test_state
    FROM quests q WHERE q.quest_id=$1`, [projection.aggregate_id])).rows[0];
  if (!quest) return missingProjection('ไม่พบ Quest Operation');
  const description = [
    `**Quest:** ${escape(quest.name)} (\`${escape(quest.quest_id)}\`)`, `**Analysis:** ${escape(quest.analysis_state)} v${quest.analysis_version}`,
    `**Sale:** ${escape(quest.sale_state)} v${quest.sale_version}`, `**Announcement:** ${escape(quest.announcement_state)}`,
    `**Executor:** ${escape(quest.executor_id)} / ${escape(quest.executor_version)}`, `**Contract:** ${escape(quest.contract_version)}`,
    `**Background tests:** ${quest.test_attempts} • ${escape(quest.latest_test_state)}`, '**Trace source:** ดู Attempts/Evidence ฉบับเต็มใน PostgreSQL',
  ].join('\n');
  return { embeds: [new EmbedBuilder().setColor(color.info).setTitle('Quest Operation Summary').setDescription(boundedDescription(description))
    .setTimestamp(quest.updated_at)], allowedMentions: noMentions };
}

async function renderCheckoutAudit(pool, projection) {
  const session = (await pool.query(`SELECT s.*,
    (SELECT count(*)::integer FROM checkout_quest_options o WHERE o.session_id=s.id) AS option_count,
    (SELECT count(*)::integer FROM checkout_quest_options o WHERE o.session_id=s.id AND o.selected) AS selected_count
    FROM interaction_sessions s WHERE s.id=$1`, [projection.aggregate_id])).rows[0];
  if (!session) return missingProjection('ไม่พบ Checkout Audit');
  const profile = session.payload ?? {};
  const description = [
    '**Token check:** ผ่าน — Token ถูกเข้ารหัสและไม่บันทึก/แสดงใน Log',
    `**Quest account:** ${escape(profile.username)} (\`${escape(profile.accountId)}\`)`,
    `**Quest ที่ซื้อได้:** ${session.option_count}`, `**เลือกแล้ว:** ${session.selected_count}`,
    `**Session:** ${escape(session.state)}`, `**Trace:** \`${session.trace_id}\``,
    `**หมดอายุ:** ${timestamp(session.expires_at, 'R')}`,
  ].join('\n');
  const embed = new EmbedBuilder().setColor(color.info).setTitle('Checkout • ตรวจ Token')
    .setDescription(boundedDescription(description)).setTimestamp(session.created_at);
  setSafeThumbnail(embed, profile.avatarUrl);
  return { embeds: [embed], allowedMentions: noMentions };
}

async function renderCustomerQuestDiscovery(pool, projection) {
  const found = (await pool.query(`SELECT d.*,q.name,q.task_type,q.executor_id,q.sale_state
    FROM customer_quest_discoveries d JOIN quests q ON q.quest_id=d.quest_id WHERE d.id=$1`,
  [projection.aggregate_id])).rows[0];
  if (!found) return missingProjection('ไม่พบ Customer Quest Discovery');
  const pending = found.state === 'PENDING';
  const status = {
    PENDING: 'รอ Admin ตัดสินใจว่าจะประกาศหรือส่งทดสอบ',
    TEST_REQUESTED: 'ส่งให้ Monitor ทดสอบแล้ว — ผลจะจัดการตาม Flow ทดสอบ Quest',
    PUBLISHED: 'ประกาศสาธารณะแล้วโดย Admin',
  }[found.state] ?? 'กำลังตรวจสอบ';
  const description = [
    `**ผู้พบ Quest:** <@${found.discord_user_id}> (\`${found.discord_user_id}\`)`,
    `**บัญชี Quest:** ${escape(found.account_username)} (\`${escape(found.account_id)}\`)`,
    `**Quest:** ${escape(found.name)} (\`${escape(found.quest_id)}\`)`,
    `**ประเภท / Executor:** ${escape(found.task_type)} / ${escape(found.executor_id)}`,
    `**สถานะการตัดสินใจ:** ${escape(status)}`,
    '**Token:** ไม่บันทึกหรือแสดง — ใช้เฉพาะข้อมูลระบุตัวบัญชีที่ผ่านการตรวจ',
    `**Checkout session:** \`${found.checkout_session_id}\``, `**Trace:** \`${found.trace_id}\``,
  ].join('\n');
  const embed = new EmbedBuilder().setColor(color.pending).setTitle('🔎 พบ Quest ใหม่จาก Checkout ลูกค้า')
    .setDescription(boundedDescription(description)).setTimestamp(found.created_at);
  setSafeThumbnail(embed, found.account_avatar_url);
  const components = pending ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`qs:v1:customer_quest_publish:${found.id}`)
      .setLabel('ส่งประกาศ').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`qs:v1:customer_quest_test:${found.id}`)
      .setLabel('ทดสอบก่อน').setStyle(ButtonStyle.Primary),
  )] : [];
  return { embeds: [embed], components, allowedMentions: { users: [found.discord_user_id], parse: [] } };
}

async function renderQuestTestFailure(pool, projection) {
  const alert = (await pool.query(`SELECT a.*,q.name,q.task_type,q.sale_state,b.monitor_order,
    b.current_monitor_index,b.max_attempts_per_monitor,b.latest_error,b.state AS batch_state,
    (SELECT count(*)::integer FROM quest_test_runs r WHERE r.batch_id=a.batch_id) AS attempts,
    (SELECT count(DISTINCT r.target_monitor_id)::integer FROM quest_test_runs r WHERE r.batch_id=a.batch_id) AS monitor_count
    FROM quest_test_failure_alerts a JOIN quests q ON q.quest_id=a.quest_id
    JOIN quest_test_batches b ON b.id=a.batch_id WHERE a.id=$1`, [projection.aggregate_id])).rows[0];
  if (!alert) return missingProjection('ไม่พบ Quest Test Failure');
  const failure = alert.last_error?.message ?? alert.latest_error?.message ?? 'ไม่พบรายละเอียดข้อผิดพลาด';
  const description = [
    `**Quest:** ${escape(alert.name)} (\`${escape(alert.quest_id)}\`)`,
    `**ประเภท:** ${escape(alert.task_type)}`, `**ผลทดสอบ:** ไม่ผ่านหลัง ${alert.attempts} attempt / ${alert.monitor_count} Monitor`,
    `**เหตุผลล่าสุด:** ${escape(failure)}`, `**สถานะขาย:** ${escape(alert.sale_state)}`,
    `**Trace:** \`${alert.trace_id}\``,
    'หากเลือก **ส่งเลย** ระบบจะเปิดขายและประกาศโดยบันทึกว่า Admin override; จะไม่ปลอมผลเป็น TEST_PASSED.',
  ].join('\n');
  const isOpen = alert.state === 'OPEN';
  const send = new ButtonBuilder().setCustomId(`qs:v1:test_fail_send:${alert.id}`)
    .setLabel('ส่งเลย').setStyle(ButtonStyle.Danger).setDisabled(!isOpen);
  const retry = new ButtonBuilder().setCustomId(`qs:v1:test_fail_retry:${alert.id}`)
    .setLabel('ลองทดสอบอีกครั้ง').setStyle(ButtonStyle.Primary).setDisabled(!isOpen);
  const alertTitle = alert.state === 'OPEN' ? '⚠️ Monitor ทดสอบ Quest ไม่ผ่าน' : `Monitor Test • ${escape(alert.state)}`;
  return { embeds: [new EmbedBuilder().setColor(color.failure).setTitle(title(alertTitle))
    .setDescription(boundedDescription(description)).setTimestamp(alert.updated_at)],
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

async function renderRunnerSummary(pool, projection) {
  const job = (await pool.query(`SELECT j.*,i.quest_name,i.state AS item_state,i.progress_actual,i.progress_bucket,i.price_cents,
    o.account_id,o.account_username FROM runner_jobs j JOIN order_items i ON i.id=j.order_item_id JOIN orders o ON o.id=i.order_id
    WHERE j.id=$1`, [projection.aggregate_id])).rows[0];
  if (!job) return missingProjection('ไม่พบ Runner Summary');
  let runnerColor = color.info;
  if (job.state === 'COMPLETED') runnerColor = color.success;
  else if (job.state === 'FAILED') runnerColor = color.failure;
  const description = [
    `**Job:** \`${job.id}\``, `**Account:** ${escape(job.account_username)} (\`${job.account_id}\`)`,
    `**Quest:** ${escape(job.quest_name)}`, `**Item state:** ${escape(job.item_state)}`,
    `**Progress:** ${job.progress_bucket}% (${escape(job.progress_actual)}%)`, `**ราคา:** ${baht(job.price_cents)}`, `**Attempts:** ${job.attempt_count}`,
  ].join('\n');
  return { embeds: [new EmbedBuilder().setColor(runnerColor).setTitle(title(`Runner • ${escape(job.state)}`))
    .setDescription(boundedDescription(description)).setTimestamp(job.updated_at)], allowedMentions: noMentions };
}

async function renderIncident(pool, projection) {
  const incident = (await pool.query('SELECT * FROM incidents WHERE id=$1', [projection.aggregate_id])).rows[0];
  if (!incident) return missingProjection('ไม่พบ System Incident');
  const incidentColor = incident.severity === 'CRITICAL' ? color.failure : color.pending;
  const description = [
    `**สถานะ:** ${escape(incident.state)}`, `**Severity:** ${escape(incident.severity)}`,
    `**Scope:** ${escape(incident.scope)}`, `**Trace:** \`${incident.trace_id}\``, `**Evidence:** \`${escape(JSON.stringify(incident.evidence))}\``,
  ].join('\n');
  return { embeds: [new EmbedBuilder().setColor(incidentColor).setTitle(title(`System • ${escape(incident.incident_code)}`))
    .setDescription(boundedDescription(description)).setTimestamp(incident.updated_at)], allowedMentions: noMentions };
}

async function renderAdminAudit(pool, projection) {
  const audit = (await pool.query('SELECT * FROM admin_audit_logs WHERE id=$1', [projection.aggregate_id])).rows[0];
  if (!audit) return missingProjection('ไม่พบ Admin Audit');
  const actorIsUser = /^\d{17,20}$/.test(audit.actor_id);
  const actor = actorIsUser ? `<@${audit.actor_id}>` : escape(audit.actor_id);
  const description = [
    `**Actor:** ${actor} (\`${audit.actor_id}\`)`, `**Target:** ${escape(audit.target_type)} / \`${escape(audit.target_id)}\``,
    `**เหตุผล:** ${escape(audit.reason)}`, `**Correlation:** \`${audit.correlation_code}\``,
  ].join('\n');
  const allowedMentions = actorIsUser ? { users: [audit.actor_id], parse: [] } : noMentions;
  return { embeds: [new EmbedBuilder().setColor(color.info).setTitle(title(`Admin • ${escape(audit.action)}`))
    .setDescription(boundedDescription(description)).setTimestamp(audit.created_at)], allowedMentions };
}

async function renderQuestHistory(pool, projection) {
  const item = (await pool.query(`SELECT i.*,o.account_id,o.account_username,o.account_avatar_url,o.trace_id,
      r.state AS reservation_state,r.amount_cents AS reservation_amount,
      f.id AS refund_id,f.amount_cents AS refund_amount,f.created_at AS refunded_at
    FROM order_items i JOIN orders o ON o.id=i.order_id
    LEFT JOIN wallet_reservations r ON r.order_item_id=i.id
    LEFT JOIN refunds f ON f.order_item_id=i.id WHERE i.id=$1`, [projection.aggregate_id])).rows[0];
  if (!item) return { embeds: [new EmbedBuilder().setColor(color.info).setTitle('ไม่พบประวัติ Quest')], allowedMentions: noMentions };
  let tone = color.pending;
  if (item.state === 'READY_TO_CLAIM') tone = color.success;
  else if (item.state?.endsWith('_RELEASED')) tone = color.failure;
  const status = { title: `${orderStateIcon(item.state)} ${orderStateLabel(item.state)}`, tone };
  const claimUrl = safeHttpsUrl(item.claim_url);
  const creditState = item.refund_id
    ? `↩️ คืนเครดิตแล้ว ${baht(item.refund_amount)} • ${timestamp(item.refunded_at, 'R')}`
    : reservationStateLabel(item.reservation_state);
  const description = [
    `**บัญชี:** ${escape(item.account_username)}`, `**Account ID:** \`${escape(item.account_id)}\``,
    `**Quest:** ${escape(item.quest_name)}`, `**Order:** \`${escape(item.order_id)}\``,
    `**สถานะเครดิต:** ${creditState}`, `**ราคา/ยอดจอง:** ${baht(item.reservation_amount ?? item.price_cents)}`,
    `${orderStateIcon(item.state)} **${escape(item.quest_name)} — ${item.progress_bucket}%**`, `**Support:** \`${supportCode(item.trace_id)}\``,
    item.terminal_reason ? `**เหตุผล:** ${terminalReasonLabel(item.terminal_reason)}` : null,
  ].filter(Boolean).join('\n');
  const embed = new EmbedBuilder().setColor(status.tone).setTitle(title(status.title)).setDescription(boundedDescription(description)).setTimestamp(item.updated_at);
  setSafeThumbnail(embed, item.account_avatar_url);
  const components = item.state === 'READY_TO_CLAIM' && claimUrl
    ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(claimUrl).setLabel('รับรางวัล Quest นี้'))]
    : [];
  return { embeds: [embed], components, allowedMentions: noMentions };
}

function renderFallback(_pool, projection) {
  const embed = new EmbedBuilder().setColor(color.info).setTitle(title(escape(projection.projection_type)))
    .setDescription(boundedDescription(`Aggregate: **${escape(projection.aggregate_id)}**\nอัปเดตจากสถานะล่าสุดใน PostgreSQL`)).setTimestamp();
  return { embeds: [embed], allowedMentions: noMentions };
}

const renderers = {
  REFUND_LOG: renderRefund, TOPUP_RECEIPT: renderTopupReceipt, ORDER_DM: renderOrderDm,
  PAYMENT_LOG: renderPaymentLog, PAYMENT_STATUS_LOG: renderPaymentLog, QUEST_NEW: renderQuestNewProjection,
  QUEST_OPERATION: renderQuestOperation, MANUAL_REVIEW: renderManualReview, RUNNER_SUMMARY: renderRunnerSummary,
  CHECKOUT_AUDIT: renderCheckoutAudit, SYSTEM_INCIDENT: renderIncident, ADMIN_AUDIT: renderAdminAudit,
  QUEST_HISTORY: renderQuestHistory, CUSTOMER_QUEST_DISCOVERY: renderCustomerQuestDiscovery,
  QUEST_TEST_FAILURE: renderQuestTestFailure,
};

export async function renderProjection(pool, projection, dependencies = {}) {
  const renderer = renderers[projection.projection_type] ?? renderFallback;
  return renderer(pool, projection, dependencies);
}
