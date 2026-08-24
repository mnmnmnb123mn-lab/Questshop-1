import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { customId } from '../components/custom-id.js';
import { adminCategoryOptions } from './admin.js';
import { DISCORD_LIMITS, truncateDiscordText } from '../payload.js';
import { DEFAULT_QUEST_PRICE_CENTS } from '../../domain/pricing/categories.js';
import { QUEST_AUTO_MEDIA_ATTACHMENT_URL } from '../surfaces/quest-auto-media.js';

const COLORS = Object.freeze({ primary: 0x5865f2, success: 0x23a55a, warning: 0xf0b232, danger: 0xf23f43 });

function compactBaht(cents) {
  const amount = BigInt(cents);
  const whole = amount / 100n;
  const fraction = amount % 100n;
  if (fraction === 0n) return whole.toLocaleString('th-TH');
  return `${whole.toLocaleString('th-TH')}.${String(fraction).padStart(2, '0').replace(/0$/, '')}`;
}

export function questAutoPriceRangeLabel(priceRange = undefined) {
  const normalized = priceRange === undefined
    ? { minCents: DEFAULT_QUEST_PRICE_CENTS, maxCents: DEFAULT_QUEST_PRICE_CENTS }
    : priceRange;
  if (normalized?.minCents == null || normalized?.maxCents == null) return null;
  const minimum = BigInt(normalized.minCents);
  const maximum = BigInt(normalized.maxCents);
  return minimum === maximum
    ? compactBaht(minimum)
    : `${compactBaht(minimum)}-${compactBaht(maximum)}`;
}

export function renderQuestAuto(config = {}) {
  const priceLabel = questAutoPriceRangeLabel(config.priceRange);
  const defaultDescription = [
    'ทำ Quest เพื่อสะสม **Discord Orbs** ด้วยระบบอัตโนมัติ',
    priceLabel
      ? `**ค่าบริการ ${priceLabel} บาท / เควสสำเร็จ**`
      : '**ค่าบริการยังไม่พร้อม / เควสสำเร็จ**',
    'ใช้ **Discord Token** เพื่อให้ระบบเข้าไปทำ Quest ให้โดยอัตโนมัติ',
    'เลือก Quest ที่ต้องการ แล้วติดตามสถานะได้จนสำเร็จ',
  ].join('\n');
  const embed = new EmbedBuilder().setColor(COLORS.primary)
    .setTitle(truncateDiscordText('Discord Quest • Auto', DISCORD_LIMITS.embedTitle))
    .setDescription(truncateDiscordText(defaultDescription, DISCORD_LIMITS.embedDescription))
    .setImage(QUEST_AUTO_MEDIA_ATTACHMENT_URL);
  return {
    content: null,
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('start')).setLabel('เริ่มทำเควส').setEmoji('🎮').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(customId('topup')).setLabel('เติมเงิน').setEmoji('💰').setStyle(ButtonStyle.Success),
    )],
    allowedMentions: { parse: [] },
  };
}

export function renderAdminPanel() {
  const options = adminCategoryOptions();
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.primary).setTitle('แผงควบคุม Questshop')
      .setDescription('เลือกหมวดที่ต้องการจัดการจากเมนูด้านล่าง\nรายการที่มีผลต่อเงินจะให้ตรวจสอบและยืนยันซ้ำทุกครั้ง')],
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(customId('admin')).setPlaceholder('เลือกหมวดการตั้งค่า').addOptions(options),
    )],
    allowedMentions: { parse: [] },
  };
}

export function renderSurfaceAnchor(surfaceKey, config = {}) {
  if (surfaceKey === 'QUEST_AUTO') return renderQuestAuto(config.branding);
  if (surfaceKey === 'ADMIN_PANEL') return renderAdminPanel();
  const names = {
    QUEST_NEW: 'Quest ใหม่', QUEST_HISTORY: 'ประวัติการทำ Quest', LOG_PAYMENTS: 'บันทึกการเติมเงิน',
    LOG_QUEST_OPERATIONS: 'บันทึกการทำ Quest', LOG_ADMIN: 'บันทึกการทำงานของแอดมิน', LOG_SYSTEM: 'เหตุขัดข้องของระบบ',
  };
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.primary).setTitle(truncateDiscordText(names[surfaceKey] ?? surfaceKey, DISCORD_LIMITS.embedTitle))
      .setDescription('Questshop ดูแลข้อความในห้องนี้และกู้การแจ้งเตือนที่ค้างอยู่ให้อัตโนมัติหลังระบบเริ่มใหม่')],
    allowedMentions: { parse: [] },
  };
}
