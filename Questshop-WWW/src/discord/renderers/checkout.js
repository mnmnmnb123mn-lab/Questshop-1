import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { customId } from '../components/custom-id.js';
import { questTypeLabel, topupStateLabel } from './labels.js';
import { DISCORD_LIMITS, safeDiscordText, truncateDiscordText } from '../payload.js';

function discordColor(hex) {
  return Number.parseInt(hex, 16);
}

// Parse RGB text once so all colors remain exact without large numeric
// literals that cross-language static analyzers can misinterpret.
const COLOR = Object.freeze({
  primary: discordColor('5865f2'),
  success: discordColor('23a55a'),
  warning: discordColor('f0b232'),
  danger: discordColor('f23f43'),
});
const noMentions = { parse: [] };

export function baht(cents) {
  const value = BigInt(cents ?? 0);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toLocaleString('th-TH')}.${fraction} บาท`;
}

function escape(value, fallback = 'ไม่ระบุ') {
  return safeDiscordText(value, { fallback, maximum: 1_000 });
}

const boundedDescription = (value) => truncateDiscordText(value, DISCORD_LIMITS.embedDescription);
const optionLabel = (value) => truncateDiscordText(value, DISCORD_LIMITS.selectOptionLabel);
const optionDescription = (value) => truncateDiscordText(value, DISCORD_LIMITS.selectOptionDescription);

function timestamp(value, style = 'R') {
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? `<t:${Math.floor(millis / 1000)}:${style}>` : 'ไม่ระบุ';
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value));
    const normalized = url.protocol === 'https:' ? url.toString() : null;
    return normalized && normalized.length <= 512 ? normalized : null;
  } catch {
    return null;
  }
}

function walletAfter(available, total) {
  const result = BigInt(available ?? 0) - BigInt(total ?? 0);
  return result >= 0n ? baht(result) : `เครดิตไม่พอ (ขาด ${baht(-result)})`;
}

function questOptionDescription(row) {
  const orbs = row.orbs == null ? 'ไม่ระบุ Orbs' : `${row.orbs} Orbs`;
  const progress = `${Math.max(0, Math.min(100, Number(row.progress_actual ?? 0))).toFixed(0)}%`;
  const type = row.task_type?.startsWith('PLAY_ON_DESKTOP') ? 'เล่นเกม' : 'ดูวิดีโอ';
  return optionDescription(`${type} • ${orbs} • ${progress} • ${baht(row.price_cents)}`);
}

export function renderSelection(page) {
  const rows = page.rows.slice(0, 25);
  const select = new StringSelectMenuBuilder().setCustomId(customId('quest_select', page.session.id))
    .setPlaceholder('เลือก Quest ในหน้านี้').setMinValues(0).setMaxValues(Math.max(1, rows.length));
  if (rows.length) select.addOptions(rows.map((row) => ({
    label: optionLabel(safeDiscordText(row.quest_name, { maximum: DISCORD_LIMITS.selectOptionLabel })), value: row.line_id,
    description: questOptionDescription(row), default: row.selected,
  })));
  const description = [
    `**บัญชี:** ${escape(page.session.payload.username)}`,
    `**Account ID:** \`${escape(page.session.payload.accountId)}\``,
    `**เครดิตพร้อมใช้:** ${baht(page.walletAvailableCents)}`,
    '',
    `**เลือกแล้ว:** ${page.selectedCount} จาก ${page.count} Quest`,
    `**ยอดรวมที่เลือก:** ${baht(page.selectedTotalCents)}`,
    `**คงเหลือหลังยืนยัน:** ${walletAfter(page.walletAvailableCents, page.selectedTotalCents)}`,
    '',
    page.count ? `หน้า **${page.page + 1}/${page.pages}** • เลือกได้หลายรายการ` : 'บัญชีนี้ยังไม่มี Quest ที่ระบบรับทำได้ในขณะนี้',
  ].join('\n');
  const embed = new EmbedBuilder().setColor(COLOR.primary).setTitle('เลือก Quest ที่ต้องการ')
    .setDescription(boundedDescription(description)).setFooter({ text: 'ระบบจะตรวจราคา สถานะ และเวลาคงเหลืออีกครั้งก่อนยืนยัน' });
  const avatarUrl = safeHttpsUrl(page.session.payload.avatarUrl);
  if (avatarUrl) embed.setThumbnail(avatarUrl);
  const selectionComponents = rows.length
    ? [new ActionRowBuilder().addComponents(select)] : [];
  return {
    embeds: [embed],
    components: [...selectionComponents, new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('quest_prev', page.session.id)).setLabel('ก่อนหน้า')
        .setStyle(ButtonStyle.Secondary).setDisabled(page.page === 0),
      new ButtonBuilder().setCustomId(customId('quest_next', page.session.id)).setLabel('ถัดไป')
        .setStyle(ButtonStyle.Secondary).setDisabled(page.page + 1 >= page.pages),
      new ButtonBuilder().setCustomId(customId('quest_all', page.session.id)).setLabel('เลือกทั้งหมด')
        .setStyle(ButtonStyle.Secondary).setDisabled(!page.count),
      new ButtonBuilder().setCustomId(customId('quest_quote', page.session.id)).setLabel('ตรวจสอบรายการ')
        .setStyle(ButtonStyle.Primary).setDisabled(!page.selectedCount),
    )],
    allowedMentions: noMentions,
  };
}

function quoteItemLine(item, index) {
  const orbs = item.orbs == null ? 'ไม่ระบุ Orbs' : `${item.orbs} Orbs`;
  const questName = escape(item.quest_name).slice(0, 120);
  return `${index + 1}. **${questName}**\n${questTypeLabel(item.task_type)} • ${orbs} • ${baht(item.price_cents)} • หมดอายุ ${timestamp(item.deadline_at)}`;
}

export function renderQuote(quote) {
  const shown = quote.items.slice(0, 12).map(quoteItemLine);
  if (quote.items.length > shown.length) shown.push(`…และอีก **${quote.items.length - shown.length} Quest** ที่เลือกไว้`);
  const description = [
    `**บัญชี:** ${escape(quote.session.payload.username)}`,
    `**Account ID:** \`${escape(quote.session.payload.accountId)}\``,
    `**จำนวนที่เลือก:** ${quote.items.length} Quest`,
    '',
    ...shown,
    '',
    `**ยอดคงเหลือก่อนยืนยัน:** ${baht(quote.walletAvailableCents)}`,
    `**ยอดที่จะจอง:** ${baht(quote.totalCents)}`,
    `**ยอดพร้อมใช้หลังยืนยัน:** ${walletAfter(quote.walletAvailableCents, quote.totalCents)}`,
  ].join('\n');
  const embed = new EmbedBuilder().setColor(COLOR.success).setTitle('ตรวจสอบและยืนยันรายการ')
    .setDescription(boundedDescription(description))
    .setFooter({ text: 'สำเร็จจึงคิดค่าบริการ • ล้มเหลวจะคืนเครดิตของ Quest นั้นอัตโนมัติ' });
  const avatarUrl = safeHttpsUrl(quote.session.payload.avatarUrl);
  if (avatarUrl) embed.setThumbnail(avatarUrl);
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('quest_back', quote.session.id)).setLabel('ย้อนกลับไปแก้รายการ')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(customId('quest_confirm', quote.session.id)).setLabel('ยืนยันทำ Quest')
        .setStyle(ButtonStyle.Success),
    )],
    allowedMentions: noMentions,
  };
}

export function renderOrderConfirmation(result, historyLink) {
  const description = [
    `**Order ID:** \`${result.orderId}\``,
    `**บัญชี:** ${escape(result.order?.account_username)}`,
    `**Account ID:** \`${escape(result.order?.account_id)}\``,
    `**จำนวน:** ${result.items.length} Quest`,
    `**ยอดที่จอง:** ${baht(result.totalCents)}`,
    `**เครดิตพร้อมใช้:** ${baht(result.wallet?.available_cents)}`,
    `**เครดิตที่จองทั้งหมด:** ${baht(result.wallet?.reserved_cents)}`,
    '',
    '**สถานะ:** รับรายการแล้วและกำลังรอเข้าคิว',
    'ระบบจะคิดค่าบริการเฉพาะ Quest ที่สำเร็จ และคืนเครดิตของ Quest ที่ล้มเหลวโดยอัตโนมัติ',
  ].join('\n');
  const embed = new EmbedBuilder().setColor(COLOR.success).setTitle('✅ รับรายการเรียบร้อยแล้ว')
    .setDescription(boundedDescription(description)).setFooter({ text: 'เก็บ Order ID ไว้สำหรับติดต่อ Support' });
  const avatarUrl = safeHttpsUrl(result.order?.account_avatar_url);
  if (avatarUrl) embed.setThumbnail(avatarUrl);
  const components = historyLink
    ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link)
      .setURL(historyLink).setLabel('ดูความคืบหน้าการทำ Quest'))]
    : [];
  return { content: null, embeds: [embed], components, allowedMentions: noMentions };
}

export function renderPaymentMethod(walletAvailableCents, sessionId) {
  const embed = new EmbedBuilder().setColor(COLOR.primary).setTitle('เติมเครดิต Questshop')
    .setDescription(boundedDescription(`**ยอดคงเหลือปัจจุบัน:** ${baht(walletAvailableCents)}\n\nเลือกช่องทางการชำระเงินด้านล่าง`))
    .setFooter({ text: 'ขณะนี้รองรับ TrueMoney Gift แบบซองผู้รับคนเดียว' });
  const select = new StringSelectMenuBuilder().setCustomId(customId('payment_method', sessionId))
    .setPlaceholder('เลือกช่องทางเติมเครดิต')
    .addOptions({ label: 'TrueMoney Gift', description: 'เติมเครดิตด้วยลิงก์ซองอั่งเปา', value: 'truemoney', emoji: '💰' });
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], allowedMentions: noMentions };
}

export function renderTopupProcessing(topupId) {
  return { embeds: [new EmbedBuilder().setColor(COLOR.warning).setTitle('⏳ กำลังตรวจสอบซอง')
    .setDescription(boundedDescription(`ระบบรับรายการแล้วและกำลังตรวจสอบกับ TrueMoney\n\n**Top-up ID:** \`${escape(topupId)}\`\nกรุณารอสักครู่ ไม่ต้องส่งซองซ้ำ`))],
  components: [], allowedMentions: noMentions };
}

function topupFailureDescription(topup) {
  const guidance = {
    INVALID: 'ตรวจสอบว่าลิงก์เป็นซอง TrueMoney ที่ถูกต้องแล้วลองใหม่',
    EXPIRED: 'กรุณาสร้างซองใหม่แล้วส่งอีกครั้ง',
    ALREADY_REDEEMED: 'กรุณาตรวจสอบว่าซองยังไม่เคยถูกใช้',
    FAILED: 'รายการนี้ไม่ได้เพิ่มเครดิต คุณสามารถลองด้วยซองใหม่ได้',
    REJECTED: 'เจ้าของร้านตรวจสอบแล้วและไม่ได้เพิ่มเครดิตจากรายการนี้',
    REVERSED: 'เครดิตจากรายการนี้ถูกย้อนกลับตามผลการตรวจสอบ',
  };
  return guidance[topup.status] ?? 'รายการนี้ไม่ได้เพิ่มเครดิต หากต้องการความช่วยเหลือให้แจ้ง Top-up ID กับเจ้าของร้าน';
}

export function renderTopupResult(topup) {
  if (topup.status === 'CREDITED') {
    const total = BigInt(topup.amount_cents ?? 0) + BigInt(topup.bonus_cents ?? 0);
    const lines = [
      `**Top-up ID:** \`${topup.id}\``,
      `**ยอดก่อนเติม:** ${baht(topup.available_before)}`,
      `**ยอดเงินจากซอง:** ${baht(topup.amount_cents)}`,
      `**โบนัสโปรโมชั่น:** ${baht(topup.bonus_cents)}`,
      `**ได้รับทั้งหมด:** ${baht(total)}`,
      `**ยอดคงเหลือใหม่:** ${baht(topup.available_after ?? topup.wallet_available_cents)}`,
    ];
    if (topup.promotion_name) lines.splice(4, 0, `**โปรโมชั่น:** ${escape(topup.promotion_name)}`);
    return { embeds: [new EmbedBuilder().setColor(COLOR.success).setTitle('✅ เติมเครดิตสำเร็จ')
      .setDescription(boundedDescription(lines.join('\n'))).setFooter({ text: 'ใบเสร็จฉบับเต็มจะส่งทาง DM อีกครั้ง' })],
    components: [], allowedMentions: noMentions };
  }
  if (['AMBIGUOUS', 'MANUAL_REVIEW', 'REDEEMED'].includes(topup.status)) {
    const received = topup.status === 'REDEEMED' ? '\nระบบรับเงินจากซองแล้ว แต่ยังเพิ่มเครดิตไม่เสร็จ' : '';
    return { embeds: [new EmbedBuilder().setColor(COLOR.warning).setTitle('🟠 กำลังตรวจสอบรายการ')
      .setDescription(boundedDescription(`**สถานะ:** ${topupStateLabel(topup.status)}${received}\n**Top-up ID:** \`${escape(topup.id)}\`\n\nห้ามส่งซองเดิมซ้ำ เจ้าของร้านจะตรวจสอบหลักฐานและดำเนินการต่อ`))],
    components: [], allowedMentions: noMentions };
  }
  if (['INVALID', 'EXPIRED', 'ALREADY_REDEEMED', 'FAILED', 'REJECTED', 'REVERSED'].includes(topup.status)) {
    return { embeds: [new EmbedBuilder().setColor(COLOR.danger).setTitle('❌ เติมเครดิตไม่สำเร็จ')
      .setDescription(boundedDescription(`**สถานะ:** ${topupStateLabel(topup.status)}\n**Top-up ID:** \`${escape(topup.id)}\`\n\n${topupFailureDescription(topup)}`))],
    components: [], allowedMentions: noMentions };
  }
  return { embeds: [new EmbedBuilder().setColor(COLOR.warning).setTitle('⏳ ระบบยังดำเนินการอยู่')
    .setDescription(boundedDescription(`**สถานะ:** ${topupStateLabel(topup.status)}\n**Top-up ID:** \`${escape(topup.id)}\`\n\nคุณปิดข้อความนี้ได้ ระบบยังทำงานต่อและจะส่งใบเสร็จทาง DM เมื่อเสร็จ`))],
  components: [], allowedMentions: noMentions };
}
