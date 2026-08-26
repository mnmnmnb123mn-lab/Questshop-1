import { ChannelType, SlashCommandBuilder } from 'discord.js';

export const SURFACE_COMMANDS = Object.freeze({
  'quest-auto': 'QUEST_AUTO',
  'quest-new': 'QUEST_NEW',
  'quest-history': 'QUEST_HISTORY',
  'admin-panel': 'ADMIN_PANEL',
  'log-payments': 'LOG_PAYMENTS',
  'log-quest-operations': 'LOG_QUEST_OPERATIONS',
  'log-admin': 'LOG_ADMIN',
  'log-system': 'LOG_SYSTEM',
});

export const commandData = Object.keys(SURFACE_COMMANDS).map((name) => (
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(`ติดตั้งหรือย้าย ${name}`)
    .addChannelOption((option) => option.setName('channel').setDescription('ห้องปลายทาง')
      .addChannelTypes(ChannelType.GuildText).setRequired(false))
    .toJSON()
));
