import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { customId } from '../components/custom-id.js';

export const ADMIN_CATEGORIES = Object.freeze([
  ['overview', 'ภาพรวมร้าน'],
  ['pricing', 'ราคาทำ Quest'],
  ['promotions', 'โบนัสเติมเงิน'],
  ['orders', 'งานลูกค้าและคิว'],
  ['payments', 'เติมเงินที่ต้องตรวจ'],
  ['wallet', 'ปรับเครดิตและคืนเงิน'],
  ['monitors', 'บัญชีตรวจสอบ Quest'],
  ['receivers', 'เบอร์รับเงิน TrueMoney'],
  ['dlq', 'ปัญหาที่ต้องจัดการ'],
]);

export function adminCategoryOptions(selected = null, { isOwner = false } = {}) {
  return ADMIN_CATEGORIES
    .filter(([value]) => isOwner || !['monitors', 'receivers'].includes(value))
    .map(([value, label]) => ({ value, label, default: value === selected }));
}

export function adminNavigationComponents(selected, actionRows = [], { isOwner = false } = {}) {
  const menu = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(customId('admin_nav')).setPlaceholder('เปลี่ยนหมวดการตั้งค่า')
    .addOptions(adminCategoryOptions(selected, { isOwner })));
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId(`admin_refresh_${selected}`)).setLabel('รีเฟรช')
      .setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
    new ButtonBuilder().setCustomId(customId('admin_refresh_overview')).setLabel('กลับภาพรวม')
      .setStyle(ButtonStyle.Secondary).setDisabled(selected === 'overview'),
  );
  return [menu, ...actionRows, controls];
}
