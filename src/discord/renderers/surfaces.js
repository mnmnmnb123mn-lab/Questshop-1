import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { customId } from '../components/custom-id.js';
import { QUEST_AUTO_MEDIA_ATTACHMENT_URL, QUEST_AUTO_THUMBNAIL_ATTACHMENT_URL } from '../surfaces/quest-auto-media.js';

const COLORS = Object.freeze({ primary: 0x5865f2 });

function baht(cents) {
  const value = Number(cents);
  return Number.isSafeInteger(value) && value >= 0 ? `${value / 100}`.replace(/\.0$/, '') : null;
}

export function questAutoPriceRangeLabel(priceRange) {
  if (!priceRange || priceRange.minCents == null || priceRange.maxCents == null) return null;
  const min = baht(priceRange.minCents);
  const max = baht(priceRange.maxCents);
  return min && max ? (min === max ? min : `${min}-${max}`) : null;
}

export function renderQuestAuto(config = {}) {
  const price = questAutoPriceRangeLabel(config.priceRange);
  const embed = new EmbedBuilder().setColor(COLORS.primary).setTitle('Discord Quest Auto').setDescription([
    'ทำ Quest เพื่อสะสม **Discord Orbs** ด้วยระบบอัตโนมัติ',
    price ? `**ค่าบริการ ${price} บาท / Quest สำเร็จ**` : '**ค่าบริการยังไม่พร้อม**',
    'ใช้ **Discord Token** เฉพาะเพื่อให้ระบบตรวจและทำ Quest ของคุณ',
  ].join('\n')).setThumbnail(QUEST_AUTO_THUMBNAIL_ATTACHMENT_URL).setImage(QUEST_AUTO_MEDIA_ATTACHMENT_URL);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('start')).setLabel('เริ่มทำเควส').setEmoji('🎮').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(customId('topup')).setLabel('เติมเงิน').setEmoji('💰').setStyle(ButtonStyle.Success),
  )], allowedMentions: { parse: [] } };
}

export function renderAdminPanel() {
  return { embeds: [new EmbedBuilder().setColor(COLORS.primary).setTitle('แผงควบคุม Questshop')
    .setDescription('ผู้ดูแลใช้แผงนี้เพื่อตรวจสอบงาน การเงิน และการตั้งค่าร้าน\nทุกคำสั่งตรวจสิทธิ์ Administrator ใหม่ทุกครั้ง')],
  components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(customId('admin'))
    .setPlaceholder('เลือกการจัดการร้าน').addOptions(
      { label: 'ภาพรวมระบบ', value: 'overview' }, { label: 'Feature gates', value: 'gates' },
      { label: 'ตั้งราคา Quest', value: 'prices' }, { label: 'ตั้งค่าเบอร์รับเงิน', value: 'receiver' },
      { label: 'โปรโมชั่น', value: 'promotions' }, { label: 'ปรับ Wallet', value: 'wallet' },
      { label: 'บัญชี Monitor', value: 'monitors' }, { label: 'Manual reviews', value: 'reviews' }, { label: 'งานค้างส่ง (DLQ)', value: 'dlq' },
      { label: 'Orders และคืนเครดิต', value: 'orders' }, { label: 'ย้อนรายการเติมเงิน', value: 'topups' },
      { label: 'Admin audit ล่าสุด', value: 'audit' }, { label: 'Payment containment', value: 'containment' },
    ))], allowedMentions: { parse: [] } };
}

export function renderSurfaceAnchor(surfaceKey, config = {}) {
  if (surfaceKey === 'QUEST_AUTO') return renderQuestAuto(config.branding ?? config);
  if (surfaceKey === 'ADMIN_PANEL') return renderAdminPanel();
  const names = { QUEST_NEW: 'ประกาศ Quest ใหม่', QUEST_HISTORY: 'ประวัติการทำ Quest', LOG_PAYMENTS: 'บันทึกการเติมเงิน',
    LOG_QUEST_OPERATIONS: 'บันทึกการทำ Quest', LOG_ADMIN: 'บันทึกการทำงานของผู้ดูแล', LOG_SYSTEM: 'เหตุขัดข้องของระบบ' };
  return { embeds: [new EmbedBuilder().setColor(COLORS.primary).setTitle(names[surfaceKey] ?? 'Questshop')
    .setDescription('Questshop จะอัปเดตข้อความในห้องนี้เมื่อมีรายการใหม่')], allowedMentions: { parse: [] } };
}
