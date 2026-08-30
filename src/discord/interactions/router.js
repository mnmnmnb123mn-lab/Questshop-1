import { randomUUID } from 'node:crypto';
import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, StringSelectMenuBuilder } from 'discord.js';
import { SURFACE_COMMANDS } from '../commands/definitions.js';
import { customId, parseCustomId } from '../components/custom-id.js';
import { setupSurface } from '../surfaces/setup.js';
import { submitTopup } from '../../domain/sqlite/payments.js';
import { decryptCredential, encryptCredential } from '../../domain/sqlite/crypto.js';
import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';
import { acknowledgeTopupAndStartSettlement } from './topup-acknowledgement.js';
import { createOrder } from '../../domain/sqlite/orders.js';
import { priceForQuest } from '../../domain/sqlite/pricing.js';
import { QuestshopError } from '../../shared/errors.js';
import { safeDiscordText } from '../payload.js';
import { currentFeatureGates } from '../../domain/sqlite/gates.js';
import { announceCustomerDiscovery, retryCustomerDiscovery } from '../../domain/sqlite/discovery.js';
import { loadRuntimeConfig } from '../../config/runtime-config.js';
import { adjustWallet, adminOverview, configureReceiverPhone, confirmFinancialReview, listOpenManualReviews, queueMonitorScanAndTest, resolveOperationalReview, retryNotificationDlq, setQuestPrice, upsertMonitorAccount, upsertPromotion } from '../../domain/sqlite/admin.js';
import { changeFeatureGate } from '../../domain/sqlite/admin.js';
import { supportedTaskTypes } from '../../domain/sqlite/pricing.js';
import { bindInteractionSessionMessage, consumeInteractionSession, consumeModalInteractionSession, createInteractionSession } from '../../domain/sqlite/interaction-sessions.js';
import { ADMIN, CUSTOMER, routeContract } from './contracts.js';
import { installResponseController } from './response-controller.js';
import { consumeInteractionRateLimit } from '../../domain/sqlite/interaction-rate-limits.js';

function ephemeral(content) { return { content, ephemeral: true, allowedMentions: { parse: [] } }; }

function sessionContext(interaction, runtime, operation, payload = {}, messageId = null) {
  return createInteractionSession(runtime.db, { actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId, operation, payload });
}

async function replyAndBindSessions(interaction, runtime, body, sessionIds) {
  await interaction.reply({ ...body, ephemeral: true, allowedMentions: { parse: [] } });
  const message = await interaction.fetchReply();
  for (const sessionId of sessionIds) bindInteractionSessionMessage(runtime.db, { sessionId, messageId: message.id });
  return message;
}

async function consumeAdminSession(interaction, runtime, sessionId, operation) {
  await assertBackoffice(interaction, runtime);
  return consumeInteractionSession(runtime.db, { sessionId, actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null, operation });
}

async function consumeAdminModalSession(interaction, runtime, sessionId, operation) {
  await assertBackoffice(interaction, runtime);
  return consumeModalInteractionSession(runtime.db, { sessionId, actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, operation });
}

function adminOverviewEmbed(runtime) {
  const overview = adminOverview(runtime.db);
  return new EmbedBuilder().setColor(0x5865f2).setTitle('ภาพรวม Questshop SQLite').setDescription([
    `Manual Review เปิดอยู่: **${overview.openReviews}**`, `Jobs ที่กำลังรอ/ทำงาน: **${overview.pendingJobs}**`,
    `Notification DLQ: **${overview.deadLetters}**`, `Monitor ที่ใช้งาน: **${overview.activeMonitors}**`,
    `เบอร์รับเงิน: **${overview.receiverConfigured ? 'ตั้งค่าแล้ว' : 'ยังไม่ได้ตั้งค่า'}**`,
  ].join('\n'));
}

async function showAdminGates(interaction, runtime) {
  const gates = currentFeatureGates(runtime.db);
  const entries = Object.entries(gates);
  const sessions = entries.map(([gate, enabled]) => ({ gate, enabled, id: sessionContext(interaction, runtime, 'ADMIN_GATE_TOGGLE', { gate, enabled: !enabled }) }));
  const rows = [];
  for (let index = 0; index < sessions.length; index += 5) {
    rows.push(new ActionRowBuilder().addComponents(sessions.slice(index, index + 5).map(({ gate, enabled, id }) => new ButtonBuilder()
      .setCustomId(customId('admin_gate_toggle', id)).setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setLabel(`${enabled ? 'เปิด' : 'ปิด'} ${gate}`.slice(0, 80)))));
  }
  return replyAndBindSessions(interaction, runtime, { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Feature gates')
    .setDescription('กดปุ่มเพื่อสลับสถานะ ระบบจะบันทึก audit และ surface จะอัปเดตตามรอบ maintenance')], components: rows }, sessions.map(({ id }) => id));
}

async function showAdminPrices(interaction, runtime) {
  const config = loadRuntimeConfig(runtime.db); runtime.config = config;
  const sessions = supportedTaskTypes().map((taskType) => ({ taskType, id: sessionContext(interaction, runtime, 'ADMIN_PRICE_EDIT', {
    taskType, expectedConfigVersion: config.version,
  }) }));
  const rows = [];
  for (let index = 0; index < sessions.length; index += 5) rows.push(new ActionRowBuilder().addComponents(
    sessions.slice(index, index + 5).map(({ taskType, id }) => new ButtonBuilder().setCustomId(customId('admin_price_edit', id))
      .setLabel(taskType).setStyle(ButtonStyle.Primary)),
  ));
  const detail = supportedTaskTypes().map((taskType) => `${taskType}: ${priceForQuest(config.values, taskType) == null
    ? 'ยังไม่ตั้ง' : `${priceForQuest(config.values, taskType) / 100} บาท`}`).join('\n');
  return replyAndBindSessions(interaction, runtime, { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('ตั้งราคา Quest')
    .setDescription(`${detail}\n\nกดประเภทเพื่อกรอกราคาเป็นสตางค์`)], components: rows }, sessions.map(({ id }) => id));
}

async function showAdminReceiver(interaction, runtime) {
  const sessionId = sessionContext(interaction, runtime, 'ADMIN_RECEIVER_EDIT');
  return replyAndBindSessions(interaction, runtime, { content: 'ตั้งค่าหรือหมุนเวียนเบอร์รับเงิน TrueMoney ใหม่', components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('admin_receiver_edit', sessionId)).setLabel('กรอกเบอร์รับเงิน').setStyle(ButtonStyle.Primary),
  )] }, [sessionId]);
}

async function showAdminMonitors(interaction, runtime) {
  const monitors = runtime.db.prepare('SELECT account_id,label,state,last_checked_at FROM monitor_accounts ORDER BY updated_at DESC LIMIT 20').all();
  const sessionId = sessionContext(interaction, runtime, 'ADMIN_MONITOR_ADD');
  const scanId = sessionContext(interaction, runtime, 'ADMIN_MONITOR_SCAN');
  const text = monitors.length ? monitors.map((row) => `${row.label} (…${String(row.account_id).slice(-4)}) — ${row.state}`).join('\n') : 'ยังไม่มีบัญชี Monitor';
  return replyAndBindSessions(interaction, runtime, { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('บัญชี Monitor').setDescription(text)],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId('admin_monitor_add', sessionId))
      .setLabel('เพิ่ม/หมุน Token Monitor').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(customId('admin_monitor_scan', scanId))
      .setLabel('Scan + Test Quest ที่ค้าง').setStyle(ButtonStyle.Secondary))] }, [sessionId, scanId]);
}

async function showAdminDlq(interaction, runtime) {
  const rows = runtime.db.prepare("SELECT id,notification_type,destination,last_error_code FROM notifications WHERE state='DEAD_LETTER' ORDER BY updated_at DESC LIMIT 25").all();
  if (!rows.length) return interaction.reply(ephemeral('ไม่มีข้อความค้างส่งใน DLQ'));
  const sessionId = sessionContext(interaction, runtime, 'ADMIN_DLQ_SELECT', { notificationIds: rows.map((row) => row.id) });
  const select = new StringSelectMenuBuilder().setCustomId(customId('admin_dlq_select', sessionId)).setPlaceholder('เลือกข้อความค้างส่งเพื่อ retry')
    .addOptions(rows.map((row) => ({ value: row.id, label: `${row.notification_type} → ${row.destination}`.slice(0, 100),
      description: String(row.last_error_code ?? 'DISCORD_DELIVERY_FAILED').slice(0, 100) })));
  return replyAndBindSessions(interaction, runtime, { components: [new ActionRowBuilder().addComponents(select)] }, [sessionId]);
}

async function showAdminWallet(interaction, runtime) {
  const sessionId = sessionContext(interaction, runtime, 'ADMIN_WALLET_ADJUST');
  return replyAndBindSessions(interaction, runtime, { content: 'ปรับเฉพาะยอดใช้ได้ของ Wallet พร้อมเหตุผลและ audit record', components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('admin_wallet_adjust', sessionId)).setLabel('ปรับ Wallet').setStyle(ButtonStyle.Danger),
  )] }, [sessionId]);
}

async function showAdminPromotions(interaction, runtime) {
  const active = runtime.db.prepare("SELECT * FROM promotions WHERE state='ACTIVE'").get();
  const sessionId = sessionContext(interaction, runtime, 'ADMIN_PROMOTION_EDIT', { id: active?.id ?? null });
  return replyAndBindSessions(interaction, runtime, { content: active ? `โปรโมชั่นปัจจุบัน: ${active.name}` : 'ยังไม่มีโปรโมชั่นที่เปิดอยู่', components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('admin_promotion_edit', sessionId)).setLabel('ตั้งโปรโมชั่น').setStyle(ButtonStyle.Primary),
  )] }, [sessionId]);
}

async function showAdminReviews(interaction, runtime) {
  const reviews = listOpenManualReviews(runtime.db);
  if (!reviews.length) return interaction.reply(ephemeral('ไม่มี Manual Review ที่รอตรวจสอบ'));
  const sessionId = sessionContext(interaction, runtime, 'ADMIN_REVIEW_SELECT', { reviewIds: reviews.map((review) => review.id) });
  const select = new StringSelectMenuBuilder().setCustomId(customId('admin_review_select', sessionId)).setPlaceholder('เลือกรายการรอตรวจสอบ')
    .addOptions(reviews.map((review) => ({ value: review.id, label: `${review.category}: ${review.reason_code}`.slice(0, 100),
      description: `${review.subject_type} • ${review.subject_id}`.slice(0, 100) })));
  return replyAndBindSessions(interaction, runtime, { components: [new ActionRowBuilder().addComponents(select)] }, [sessionId]);
}

async function handleAdminMenu(interaction, runtime) {
  await assertBackoffice(interaction, runtime);
  const choice = interaction.values?.[0];
  if (choice === 'overview') return interaction.reply({ embeds: [adminOverviewEmbed(runtime)], ephemeral: true, allowedMentions: { parse: [] } });
  if (choice === 'gates') return showAdminGates(interaction, runtime);
  if (choice === 'prices') return showAdminPrices(interaction, runtime);
  if (choice === 'receiver') return showAdminReceiver(interaction, runtime);
  if (choice === 'wallet') return showAdminWallet(interaction, runtime);
  if (choice === 'promotions') return showAdminPromotions(interaction, runtime);
  if (choice === 'monitors') return showAdminMonitors(interaction, runtime);
  if (choice === 'reviews') return showAdminReviews(interaction, runtime);
  if (choice === 'dlq') return showAdminDlq(interaction, runtime);
  throw new QuestshopError('ADMIN_MENU_INVALID', 'เมนูผู้ดูแลไม่ถูกต้อง');
}

function textInput(custom, label, { required = true, style = TextInputStyle.Short, maxLength = 1_000, placeholder = null } = {}) {
  const input = new TextInputBuilder().setCustomId(custom).setLabel(label).setStyle(style).setRequired(required).setMaxLength(maxLength);
  if (placeholder) input.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(input);
}

function openAdminModal(route, sessionId, title, fields) {
  return new ModalBuilder().setCustomId(customId(route, sessionId)).setTitle(title).addComponents(...fields);
}

export async function hasAdministratorPermission(interaction, runtime) {
  if (!interaction?.inGuild?.() || interaction.guildId !== runtime?.env?.DISCORD_GUILD_ID) return false;
  try {
    const guild = await runtime.client.guilds.fetch(interaction.guildId);
    const member = await guild.members.fetch({ user: interaction.user.id, force: true });
    return member.permissions.has(PermissionFlagsBits.Administrator);
  } catch {
    return false;
  }
}

async function assertBackoffice(interaction, runtime) {
  if (await hasAdministratorPermission(interaction, runtime)) return;
  throw new QuestshopError('NOT_AUTHORIZED', 'เมนูนี้ใช้ได้เฉพาะผู้ดูแล');
}

async function assertOwner(interaction, runtime) {
  if (interaction.user.id === runtime.env.OWNER_ID && await hasAdministratorPermission(interaction, runtime)) return;
  throw new QuestshopError('NOT_AUTHORIZED', 'การตัดสินใจทางการเงินขั้นสุดท้ายใช้ได้เฉพาะ Owner');
}

async function assertCustomerRoute(interaction, runtime, gate) {
  const gates = currentFeatureGates(runtime.db);
  if (!gates.STORE_OPEN || !gates.CUSTOMER_INTERACTIONS_ENABLED || !gates[gate]) {
    throw new QuestshopError('FEATURE_DISABLED', 'ส่วนนี้ยังไม่เปิดให้ใช้งาน กรุณาติดต่อผู้ดูแล');
  }
  if (runtime.env.PRELAUNCH && interaction.user.id !== runtime.env.OWNER_ID && !await hasAdministratorPermission(interaction, runtime)) {
    throw new QuestshopError('PRELAUNCH_RESTRICTED', 'ระบบกำลังทดสอบก่อนเปิดใช้งาน');
  }
}

function assertCurrentSurface(interaction, runtime, surfaceKey) {
  const surface = runtime.config.surfaces?.[surfaceKey];
  if (!surface || interaction.guildId !== runtime.env.DISCORD_GUILD_ID || interaction.channelId !== surface.channelId
    || interaction.message?.id !== surface.messageId) {
    throw new QuestshopError('INTERACTION_CONTEXT_INVALID', 'ปุ่มนี้ไม่ตรงกับแผงที่ตั้งค่าไว้ กรุณาใช้แผงล่าสุด');
  }
}

function assertCurrentDiscoveryCase(interaction, runtime, notificationId) {
  const notification = runtime.db.prepare(`SELECT n.*,q.state_version AS quest_state_version FROM notifications n
    JOIN quests q ON q.quest_id=n.aggregate_id WHERE n.id=? AND n.notification_type='CUSTOMER_QUEST_DISCOVERY'
      AND n.aggregate_type='QUEST' AND n.destination='LOG_QUEST_OPERATIONS'`).get(notificationId);
  const surface = runtime.config.surfaces?.LOG_QUEST_OPERATIONS;
  if (!notification || notification.message_id !== interaction.message?.id || surface?.channelId !== interaction.channelId) {
    throw new QuestshopError('INTERACTION_CONTEXT_INVALID', 'ปุ่มนี้ไม่ตรงกับข้อความ Quest ล่าสุด');
  }
  return notification;
}

function interactionKind(interaction) {
  if (interaction.isButton?.()) return 'BUTTON';
  if (interaction.isStringSelectMenu?.()) return 'STRING_SELECT';
  if (interaction.isModalSubmit?.()) return 'MODAL_SUBMIT';
  return null;
}

async function assertRouteContract(interaction, runtime, route) {
  const contract = routeContract(route);
  if (!contract || contract.interaction !== interactionKind(interaction)) {
    throw new QuestshopError('ROUTE_INTERACTION_INVALID', 'รูปแบบการกดเมนูไม่ถูกต้อง');
  }
  if (contract.access === ADMIN) await assertBackoffice(interaction, runtime);
  if (contract.access === CUSTOMER) {
    for (const gate of contract.gates) await assertCustomerRoute(interaction, runtime, gate);
  }
  return contract;
}

function voucherModal(sessionId) {
  const input = new TextInputBuilder().setCustomId('url').setLabel('ลิงก์ซอง TrueMoney')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(512)
    .setPlaceholder('https://gift.truemoney.com/campaign/?v=...');
  return new ModalBuilder().setCustomId(customId('voucher_submit', sessionId)).setTitle('เติมเงิน TrueMoney')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function tokenModal(sessionId) {
  const input = new TextInputBuilder().setCustomId('token').setLabel('Discord Token')
    .setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(20).setMaxLength(300)
    .setPlaceholder('Token ใช้เฉพาะการตรวจ Quest และจะถูกลบตามกำหนด');
  return new ModalBuilder().setCustomId(customId('token_submit', sessionId)).setTitle('เริ่มทำ Quest')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function handleSurfaceCommand(interaction, runtime) {
  const surfaceKey = SURFACE_COMMANDS[interaction.commandName];
  if (!surfaceKey) return false;
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('NOT_AUTHORIZED', 'คำสั่งติดตั้งแผงใช้ได้เฉพาะ Owner');
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;
  const result = await setupSurface({ channel, surfaceKey, runtime, actorId: interaction.user.id });
  await interaction.editReply(ephemeral(`${result.recreated ? 'ติดตั้ง' : 'อัปเดต'}แผง ${interaction.commandName} เรียบร้อยแล้ว`));
  return true;
}

function recordCustomerToken(runtime, interaction, token) {
  const timestamp = nowMs();
  const id = randomUUID();
  const encrypted = encryptCredential(runtime.env.QUESTSHOP_SECRET_KEY, token);
  withImmediateTransaction(runtime.db, () => {
    runtime.db.prepare(`INSERT INTO credentials(id,subject_type,subject_id,credential_type,retention_class,ciphertext,nonce,auth_tag,cleanup_after,created_at,updated_at)
      VALUES(?,?,?,'CUSTOMER_QUEST_TOKEN','TEMPORARY',?,?,?,?,?,?)`).run(id, 'CHECKOUT', id,
      encrypted.ciphertext, encrypted.nonce, encrypted.authTag, timestamp + 7 * 86_400_000, timestamp, timestamp);
    runtime.db.prepare(`INSERT INTO jobs(id,job_type,subject_type,subject_id,operation_key,state,checkpoint,next_run_at,payload_json,created_at,updated_at)
      VALUES(?,?, 'CHECKOUT', ?, ?, 'PENDING','NOT_STARTED',?,?,?,?)`).run(randomUUID(), 'CUSTOMER_QUEST_DISCOVERY', id,
      `customer-discovery:${id}`, timestamp, JSON.stringify({ discordUserId: interaction.user.id, credentialId: id,
        guildId: interaction.guildId, channelId: interaction.channelId, discoveryMessageId: null, checkoutMessageId: null,
        expiresAt: timestamp + 15 * 60_000 }), timestamp, timestamp);
  });
  return id;
}

function parsePayload(value, fallback = {}) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}

function checkoutSession(runtime, interaction, checkoutId) {
  const session = runtime.db.prepare("SELECT * FROM jobs WHERE id=? AND job_type='CUSTOMER_QUEST_DISCOVERY'").get(checkoutId);
  if (!session) throw new QuestshopError('CHECKOUT_EXPIRED', 'หน้ารายการ Quest หมดอายุ กรุณาเริ่มใหม่');
  const payload = parsePayload(session.payload_json);
  if (payload.discordUserId !== interaction.user.id) throw new QuestshopError('NOT_AUTHORIZED', 'รายการนี้ไม่ใช่ของคุณ');
  if (Number(payload.expiresAt) <= nowMs() || payload.guildId !== interaction.guildId || payload.channelId !== interaction.channelId) {
    throw new QuestshopError('CHECKOUT_EXPIRED', 'หน้ารายการ Quest หมดอายุ กรุณาเริ่มใหม่');
  }
  const expectedMessageId = payload.checkoutMessageId ?? payload.discoveryMessageId;
  if (!expectedMessageId || interaction.message?.id !== expectedMessageId) {
    throw new QuestshopError('INTERACTION_CONTEXT_INVALID', 'ปุ่มนี้ไม่ตรงกับหน้ารายการ Quest ของคุณ');
  }
  if (!payload.accountId || !Array.isArray(payload.questIds)) throw new QuestshopError('CHECKOUT_NOT_READY', 'ระบบกำลังค้นหา Quest อยู่ กรุณารอสักครู่');
  return { session, payload };
}

function selectedQuests(runtime, payload, selectedIds) {
  const ids = [...new Set((selectedIds ?? []).map(String))].filter((id) => payload.questIds.includes(id));
  if (!ids.length) throw new QuestshopError('NO_SELLABLE_QUEST', 'กรุณาเลือก Quest อย่างน้อยหนึ่งรายการ');
  if (ids.length > 25) throw new QuestshopError('ORDER_ITEM_LIMIT', 'เลือก Quest ได้สูงสุด 25 รายการต่อคำสั่งซื้อ');
  const rows = runtime.db.prepare(`SELECT * FROM quests WHERE quest_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  if (rows.length !== ids.length) throw new QuestshopError('QUEST_NOT_FOUND', 'Quest ที่เลือกมีการเปลี่ยนแปลง กรุณาเริ่มใหม่');
  const timestamp = nowMs();
  const config = loadRuntimeConfig(runtime.db);
  runtime.config = config;
  return rows.map((quest) => {
    if ((quest.starts_at != null && Number(quest.starts_at) > timestamp)
      || (quest.expires_at != null && Number(quest.expires_at) <= timestamp)) {
      throw new QuestshopError('QUEST_UNAVAILABLE', 'Quest บางรายการยังไม่เริ่มหรือหมดอายุแล้ว');
    }
    const priceCents = priceForQuest(config.values, quest.task_type);
    if (priceCents == null) throw new QuestshopError('PRICE_NOT_CONFIGURED', 'ร้านยังไม่ได้ตั้งราคาสำหรับ Quest บางรายการ');
    return { questId: quest.quest_id, name: quest.name, priceCents };
  });
}

function hasEverySupportedPrice(config) {
  return supportedTaskTypes().every((type) => Number.isSafeInteger(priceForQuest(config.values, type)));
}

function pricedCheckoutQuestRows(runtime, payload) {
  const ids = [...new Set(payload.questIds.map(String))];
  if (!ids.length) return [];
  const rows = runtime.db.prepare(`SELECT * FROM quests WHERE quest_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const byId = new Map(rows.map((row) => [row.quest_id, row]));
  const timestamp = nowMs();
  const config = loadRuntimeConfig(runtime.db);
  runtime.config = config;
  return ids.map((questId) => {
    const quest = byId.get(questId);
    if (!quest || (quest.starts_at != null && Number(quest.starts_at) > timestamp)
      || (quest.expires_at != null && Number(quest.expires_at) <= timestamp)) return null;
    const priceCents = priceForQuest(config.values, quest.task_type);
    return priceCents == null ? null : { ...quest, priceCents };
  }).filter(Boolean);
}

function checkoutPagePayload(runtime, checkoutId, payload) {
  const rows = pricedCheckoutQuestRows(runtime, payload);
  const pageCount = Math.max(1, Math.ceil(rows.length / 25));
  const page = Math.min(Math.max(0, Number(payload.page) || 0), pageCount - 1);
  const shown = rows.slice(page * 25, (page + 1) * 25);
  const selected = new Set(payload.selectedQuestIds ?? []);
  const select = new StringSelectMenuBuilder().setCustomId(customId('checkout_select', checkoutId))
    .setPlaceholder('เลือก Quest ที่ต้องการทำ (เลือกได้หลายรายการ)').setMinValues(0).setMaxValues(Math.max(1, shown.length))
    .addOptions(shown.map((quest) => ({ label: safeDiscordText(quest.name, { maximum: 95 }) || quest.quest_id,
      value: quest.quest_id, description: `${(quest.priceCents / 100).toFixed(2)} บาท`, default: selected.has(quest.quest_id) })));
  const selectedCount = rows.filter((quest) => selected.has(quest.quest_id)).length;
  const total = rows.filter((quest) => selected.has(quest.quest_id)).reduce((sum, quest) => sum + quest.priceCents, 0);
  return {
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('เลือก Quest ที่ต้องการทำ')
      .setDescription(`พบ Quest ที่สั่งทำได้ ${rows.length} รายการ\nหน้า ${page + 1}/${pageCount}\nเลือกแล้ว ${selectedCount} รายการ — **${(total / 100).toFixed(2)} บาท**\n\nระบบจะตรวจข้อมูล Quest อีกครั้งก่อนตัดเครดิต`)],
    components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('checkout_page_previous', checkoutId)).setLabel('ก่อนหน้า').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(customId('checkout_page_next', checkoutId)).setLabel('ถัดไป').setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount - 1),
      new ButtonBuilder().setCustomId(customId('checkout_quote', checkoutId)).setLabel('ดูราคาและยืนยัน').setStyle(ButtonStyle.Success).setDisabled(selectedCount === 0),
    )], allowedMentions: { parse: [] },
  };
}

function updateCheckoutPayload(runtime, session, payload) {
  withImmediateTransaction(runtime.db, () => {
    const changed = runtime.db.prepare(`UPDATE jobs SET payload_json=?,state_version=state_version+1,updated_at=?
      WHERE id=? AND state_version=?`).run(JSON.stringify(payload), nowMs(), session.id, session.state_version);
    if (!changed.changes) throw new QuestshopError('CHECKOUT_CONFLICT', 'หน้ารายการถูกอัปเดตแล้ว กรุณาเปิดใหม่');
  });
}

async function openCheckout(interaction, runtime, checkoutId) {
  await assertCustomerRoute(interaction, runtime, 'ORDER_ACCEPTING');
  const { session, payload } = checkoutSession(runtime, interaction, checkoutId);
  await interaction.reply({ ...checkoutPagePayload(runtime, checkoutId, payload), ephemeral: true });
  const message = await interaction.fetchReply();
  updateCheckoutPayload(runtime, session, { ...payload, checkoutMessageId: message.id });
}

async function moveCheckoutPage(interaction, runtime, checkoutId, direction) {
  await assertCustomerRoute(interaction, runtime, 'ORDER_ACCEPTING');
  const { session, payload } = checkoutSession(runtime, interaction, checkoutId);
  const next = { ...payload, page: Math.max(0, (Number(payload.page) || 0) + direction) };
  updateCheckoutPayload(runtime, session, next);
  return interaction.update(checkoutPagePayload(runtime, checkoutId, next));
}

async function selectCheckoutQuests(interaction, runtime, checkoutId) {
  await assertCustomerRoute(interaction, runtime, 'ORDER_ACCEPTING');
  const { session, payload } = checkoutSession(runtime, interaction, checkoutId);
  const pageRows = pricedCheckoutQuestRows(runtime, payload).slice((Number(payload.page) || 0) * 25, ((Number(payload.page) || 0) + 1) * 25);
  const selected = new Set(payload.selectedQuestIds ?? []);
  for (const quest of pageRows) selected.delete(quest.quest_id);
  for (const questId of interaction.values ?? []) selected.add(String(questId));
  if (selected.size > 25) throw new QuestshopError('ORDER_ITEM_LIMIT', 'เลือก Quest ได้สูงสุด 25 รายการต่อคำสั่งซื้อ');
  const next = { ...payload, selectedQuestIds: [...selected] };
  updateCheckoutPayload(runtime, session, next);
  return interaction.update(checkoutPagePayload(runtime, checkoutId, next));
}

async function freshCheckoutQuests(runtime, payload, selected) {
  const credential = runtime.db.prepare("SELECT * FROM credentials WHERE id=? AND credential_type='CUSTOMER_QUEST_TOKEN'").get(payload.credentialId);
  if (!credential) throw new QuestshopError('CHECKOUT_EXPIRED', 'ข้อมูลบัญชีหมดอายุ กรุณาเริ่มทำ Quest ใหม่');
  const token = decryptCredential(runtime.env.QUESTSHOP_SECRET_KEY, credential);
  const api = runtime.questApiFactory
    ? await runtime.questApiFactory({ token })
    : (await import('../../quest-engine/api/client.js')).createQuestApiClient({ token, profile: {
      clientVersion: runtime.env.DISCORD_CLIENT_VERSION, chromeVersion: runtime.env.DISCORD_CHROME_VERSION,
      electronVersion: runtime.env.DISCORD_ELECTRON_VERSION, buildNumber: runtime.env.DISCORD_BUILD_NUMBER,
      nativeBuildNumber: runtime.env.DISCORD_NATIVE_BUILD_NUMBER, locale: runtime.env.DISCORD_LOCALE,
    }, coordinator: runtime.questRateLimits });
  const [profile, fresh] = await Promise.all([api.fetchCurrentUser(runtime.abortController.signal), api.fetchQuests(runtime.abortController.signal)]);
  if (String(profile?.id ?? '') !== String(payload.accountId)) throw new QuestshopError('QUEST_ACCOUNT_CHANGED', 'บัญชี Quest เปลี่ยนไป กรุณาเริ่มใหม่');
  const byId = new Map(fresh.map((quest) => [String(quest.id), quest]));
  for (const selectedQuest of selected) {
    const current = byId.get(selectedQuest.questId);
    if (!current || current.completed === true || (current.startsAt && Date.parse(current.startsAt) > nowMs())
      || (current.expiresAt && Date.parse(current.expiresAt) <= nowMs())
      || (selectedQuest.contractHash && current.contractHash !== selectedQuest.contractHash)) {
      throw new QuestshopError('QUEST_CHANGED', 'Quest ที่เลือกเปลี่ยนแปลงหรือทำเสร็จแล้ว กรุณาสร้างราคาใหม่');
    }
  }
  return selected;
}

function createCheckoutQuote(interaction, runtime, checkoutId) {
  const { payload } = checkoutSession(runtime, interaction, checkoutId);
  const items = selectedQuests(runtime, payload, payload.selectedQuestIds).map((item) => {
    const quest = runtime.db.prepare('SELECT state_version,contract_hash,starts_at,expires_at,task_type FROM quests WHERE quest_id=?').get(item.questId);
    return { ...item, taskType: quest.task_type, questVersion: quest.state_version, contractHash: quest.contract_hash,
      startsAt: quest.starts_at, expiresAt: quest.expires_at };
  });
  const config = loadRuntimeConfig(runtime.db); runtime.config = config;
  const configHash = JSON.stringify(config.values.priceRules ?? config.values.prices ?? {});
  const quoteId = sessionContext(interaction, runtime, 'CHECKOUT_CONFIRM', {
    checkoutId, credentialId: payload.credentialId, questAccountId: payload.accountId, items,
    totalCents: items.reduce((total, item) => total + item.priceCents, 0), configHash, runtimeConfigVersion: config.version,
    checkoutStateVersion: runtime.db.prepare('SELECT state_version FROM jobs WHERE id=?').get(checkoutId)?.state_version ?? null,
  });
  return { quoteId, items };
}

async function quoteCheckout(interaction, runtime, checkoutId) {
  await assertCustomerRoute(interaction, runtime, 'ORDER_ACCEPTING');
  const { quoteId, items } = createCheckoutQuote(interaction, runtime, checkoutId);
  const total = items.reduce((sum, item) => sum + item.priceCents, 0);
  return replyAndBindSessions(interaction, runtime, { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('ยืนยันราคา Quest')
    .setDescription(`${items.length} รายการ • **${(total / 100).toFixed(2)} บาท**\nราคานี้จะหมดอายุใน 15 นาที และระบบจะตรวจ Quest อีกครั้งก่อนกันเครดิต`)],
  components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId('checkout_confirm', quoteId))
    .setLabel('ยืนยันและตัดเครดิต').setStyle(ButtonStyle.Success))] }, [quoteId]);
}

async function confirmCheckout(interaction, runtime, quoteId) {
  await assertCustomerRoute(interaction, runtime, 'ORDER_ACCEPTING');
  consumeInteractionRateLimit(runtime.db, { discordUserId: interaction.user.id, action: 'ORDER_CONFIRM', limit: 5, windowMs: 10 * 60_000 });
  const quote = consumeInteractionSession(runtime.db, { sessionId: quoteId, actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null, operation: 'CHECKOUT_CONFIRM' });
  const snapshot = quote.payload;
  const config = loadRuntimeConfig(runtime.db); runtime.config = config;
  if (config.version !== snapshot.runtimeConfigVersion
    || JSON.stringify(config.values.priceRules ?? config.values.prices ?? {}) !== snapshot.configHash) {
    throw new QuestshopError('QUOTE_STALE', 'ราคามีการเปลี่ยนแปลง กรุณาสร้างราคาใหม่');
  }
  const quests = snapshot.items;
  for (const item of quests) {
    const current = runtime.db.prepare(`SELECT task_type,contract_hash,starts_at,expires_at FROM quests WHERE quest_id=?`).get(item.questId);
    if (!current || current.task_type !== item.taskType || current.contract_hash !== item.contractHash
      || current.starts_at !== item.startsAt || current.expires_at !== item.expiresAt) {
      throw new QuestshopError('QUOTE_STALE', 'ข้อมูล Quest มีการเปลี่ยนแปลง กรุณาสร้างราคาใหม่');
    }
  }
  await interaction.deferUpdate();
  await freshCheckoutQuests(runtime, { credentialId: snapshot.credentialId, accountId: snapshot.questAccountId }, quests);
  const order = createOrder(runtime.db, { discordUserId: interaction.user.id, questAccountId: snapshot.questAccountId,
    credentialId: snapshot.credentialId, items: quests, traceId: randomUUID(), prelaunch: runtime.env.PRELAUNCH });
  return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x23a55a).setTitle('✅ รับ Order แล้ว')
    .setDescription(`Order: \`${order.id}\`\nระบบกันเครดิตและเริ่มทำ Quest ให้แล้ว คุณจะได้รับความคืบหน้าทาง DM`)],
  components: [], allowedMentions: { parse: [] } });
}

async function routeButton(interaction, runtime, route, sessionId) {
  if (route === 'topup') {
    assertCurrentSurface(interaction, runtime, 'QUEST_AUTO'); await assertCustomerRoute(interaction, runtime, 'TOPUP_ACCEPTING');
    consumeInteractionRateLimit(runtime.db, { discordUserId: interaction.user.id, action: 'CUSTOMER_BUTTON', limit: 1, windowMs: 2_000 });
    return interaction.showModal(voucherModal(sessionContext(interaction, runtime, 'VOUCHER_SUBMIT', {}, interaction.message?.id ?? null)));
  }
  if (route === 'start') {
    assertCurrentSurface(interaction, runtime, 'QUEST_AUTO'); await assertCustomerRoute(interaction, runtime, 'ORDER_ACCEPTING');
    consumeInteractionRateLimit(runtime.db, { discordUserId: interaction.user.id, action: 'CUSTOMER_BUTTON', limit: 1, windowMs: 2_000 });
    const config = loadRuntimeConfig(runtime.db);
    if (!hasEverySupportedPrice(config)) {
      throw new QuestshopError('PRICE_NOT_CONFIGURED', 'ร้านยังตั้งราคา Quest ไม่ครบ กรุณาติดต่อผู้ดูแล');
    }
    const minimum = Math.min(...supportedTaskTypes().map((type) => priceForQuest(config.values, type)).filter(Number.isSafeInteger));
    const wallet = runtime.db.prepare('SELECT available_cents FROM wallets WHERE discord_user_id=?').get(interaction.user.id);
    if (Number.isSafeInteger(minimum) && Number(wallet?.available_cents ?? 0) < minimum) {
      throw new QuestshopError('INSUFFICIENT_BALANCE', 'ยอด Wallet ยังไม่พอสำหรับเริ่มทำ Quest กรุณาเติมเงินก่อน');
    }
    return interaction.showModal(tokenModal(sessionContext(interaction, runtime, 'TOKEN_SUBMIT', {}, interaction.message?.id ?? null)));
  }
  if (route === 'admin') {
    assertCurrentSurface(interaction, runtime, 'ADMIN_PANEL');
    await assertBackoffice(interaction, runtime);
    return interaction.reply({ embeds: [adminOverviewEmbed(runtime)], ephemeral: true, allowedMentions: { parse: [] } });
  }
  if (route === 'admin_gate_toggle') {
    const session = await consumeAdminSession(interaction, runtime, sessionId, 'ADMIN_GATE_TOGGLE');
    const gates = changeFeatureGate(runtime.db, { gate: session.payload.gate, enabled: session.payload.enabled, actorId: interaction.user.id,
      reason: 'เปลี่ยนจากแผงผู้ดูแล SQLite' });
    runtime.config = loadRuntimeConfig(runtime.db);
    return interaction.update({ content: `${session.payload.gate}: ${gates[session.payload.gate] ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว'}`,
      embeds: [], components: [], allowedMentions: { parse: [] } });
  }
  if (route === 'admin_price_edit') {
    const session = await consumeAdminSession(interaction, runtime, sessionId, 'ADMIN_PRICE_EDIT');
    const submitId = sessionContext(interaction, runtime, 'ADMIN_PRICE_SUBMIT', {
      taskType: session.payload.taskType, expectedConfigVersion: session.payload.expectedConfigVersion,
    });
    return interaction.showModal(openAdminModal('admin_price_submit', submitId, `ตั้งราคา ${session.payload.taskType}`,
      [textInput('amountCents', 'ราคาเป็นสตางค์', { placeholder: 'เช่น 500 สำหรับ 5 บาท', maxLength: 12 }), textInput('reason', 'เหตุผล', { required: false })]));
  }
  if (route === 'admin_receiver_edit') {
    await consumeAdminSession(interaction, runtime, sessionId, 'ADMIN_RECEIVER_EDIT');
    const submitId = sessionContext(interaction, runtime, 'ADMIN_RECEIVER_SUBMIT');
    return interaction.showModal(openAdminModal('admin_receiver_submit', submitId, 'ตั้งค่าเบอร์รับเงิน', [
      textInput('phone', 'เบอร์ TrueMoney 10 หลัก', { placeholder: '0xxxxxxxxx', maxLength: 10 }), textInput('reason', 'เหตุผล', { required: false }),
    ]));
  }
  if (route === 'admin_monitor_add') {
    await consumeAdminSession(interaction, runtime, sessionId, 'ADMIN_MONITOR_ADD');
    const submitId = sessionContext(interaction, runtime, 'ADMIN_MONITOR_SUBMIT');
    return interaction.showModal(openAdminModal('admin_monitor_submit', submitId, 'เพิ่มบัญชี Monitor', [
      textInput('accountId', 'Discord Account ID', { maxLength: 32 }), textInput('label', 'ชื่อเรียกบัญชี', { maxLength: 100 }),
      textInput('token', 'Discord Token สำหรับ Monitor', { style: TextInputStyle.Paragraph, maxLength: 300 }),
    ]));
  }
  if (route === 'admin_monitor_scan') {
    await consumeAdminSession(interaction, runtime, sessionId, 'ADMIN_MONITOR_SCAN');
    const result = queueMonitorScanAndTest(runtime.db, { actorId: interaction.user.id });
    return interaction.update({ content: `เข้าคิว Scan + Test แล้ว ${result.queued} Quest`, embeds: [], components: [], allowedMentions: { parse: [] } });
  }
  if (route === 'admin_wallet_adjust') {
    await assertOwner(interaction, runtime);
    await consumeAdminSession(interaction, runtime, sessionId, 'ADMIN_WALLET_ADJUST');
    const submitId = sessionContext(interaction, runtime, 'ADMIN_WALLET_SUBMIT');
    return interaction.showModal(openAdminModal('admin_wallet_submit', submitId, 'ปรับ Wallet', [
      textInput('discordUserId', 'Discord User ID', { maxLength: 20 }), textInput('amountCents', 'จำนวนสตางค์ (+/-)', { maxLength: 14 }),
      textInput('reason', 'เหตุผล', { maxLength: 300 }),
    ]));
  }
  if (route === 'admin_promotion_edit') {
    const session = await consumeAdminSession(interaction, runtime, sessionId, 'ADMIN_PROMOTION_EDIT');
    const submitId = sessionContext(interaction, runtime, 'ADMIN_PROMOTION_SUBMIT', { id: session.payload.id });
    return interaction.showModal(openAdminModal('admin_promotion_submit', submitId, 'ตั้งโปรโมชั่น', [
      textInput('name', 'ชื่อโปรโมชั่น', { maxLength: 100 }), textInput('state', 'ACTIVE หรือ INACTIVE', { maxLength: 8 }),
      textInput('minimumCents', 'ยอดขั้นต่ำ (สตางค์)', { maxLength: 12 }), textInput('basisPoints', 'โบนัส basis points (1000 = 10%)', { maxLength: 8 }),
      textInput('maximumBonusCents', 'โบนัสสูงสุด (สตางค์; เว้นว่างได้)', { required: false, maxLength: 12 }),
    ]));
  }
  if (route === 'admin_review_decide') {
    await assertOwner(interaction, runtime);
    const session = await consumeAdminSession(interaction, runtime, sessionId, 'ADMIN_REVIEW_DECIDE');
    const submitId = sessionContext(interaction, runtime, 'ADMIN_REVIEW_SUBMIT', { reviewId: session.payload.reviewId, subjectType: session.payload.subjectType });
    return interaction.showModal(openAdminModal('admin_review_submit', submitId, 'ตัดสิน Manual Review', [
      textInput('decision', session.payload.subjectType === 'TOPUP' ? 'CREDIT, REJECT หรือ REVERSE' : 'CAPTURE หรือ RELEASE', { maxLength: 10 }),
      textInput('reason', 'เหตุผล', { required: false, maxLength: 300 }), textInput('amountCents', 'จำนวนเงินจากหลักฐาน (สตางค์; เฉพาะ CREDIT)', { required: false, maxLength: 12 }),
      textInput('evidence', 'หลักฐาน JSON (CREDIT ต้องมี providerCode, httpStatus, receiverConfirmation)', { required: false, style: TextInputStyle.Paragraph, maxLength: 1_000 }),
    ]));
  }
  if (route === 'admin_dlq_retry') {
    const session = await consumeAdminSession(interaction, runtime, sessionId, 'ADMIN_DLQ_RETRY');
    retryNotificationDlq(runtime.db, { notificationId: session.payload.notificationId, actorId: interaction.user.id });
    return interaction.update({ content: 'ส่งข้อความกลับเข้าคิว retry แล้ว (ใช้ nonce เดิม)', embeds: [], components: [], allowedMentions: { parse: [] } });
  }
  if (route === 'customer_quest_case_retry') {
    await assertBackoffice(interaction, runtime);
    assertCurrentDiscoveryCase(interaction, runtime, sessionId);
    const result = retryCustomerDiscovery(runtime.db, { notificationId: sessionId, actorId: interaction.user.id });
    return interaction.reply(ephemeral(result.queued ? 'เริ่มตรวจและทดสอบ Quest ใหม่แล้ว' : 'Quest นี้มีงานตรวจอยู่แล้ว'));
  }
  if (route === 'customer_quest_announce') {
    await assertBackoffice(interaction, runtime);
    const notification = assertCurrentDiscoveryCase(interaction, runtime, sessionId);
    const result = announceCustomerDiscovery(runtime.db, { notificationId: sessionId, actorId: interaction.user.id,
      expectedQuestVersion: notification.quest_state_version });
    return interaction.reply(ephemeral(result.queued ? 'ส่ง Quest เข้าคิวประกาศแล้ว' : 'Quest นี้ถูกส่งเข้าคิวประกาศไว้แล้ว'));
  }
  if (route === 'checkout_open') return openCheckout(interaction, runtime, sessionId);
  if (route === 'checkout_page_previous') return moveCheckoutPage(interaction, runtime, sessionId, -1);
  if (route === 'checkout_page_next') return moveCheckoutPage(interaction, runtime, sessionId, 1);
  if (route === 'checkout_quote') return quoteCheckout(interaction, runtime, sessionId);
  if (route === 'checkout_confirm') return confirmCheckout(interaction, runtime, sessionId);
  throw new QuestshopError('ROUTE_INTERACTION_INVALID', 'ปุ่มนี้หมดอายุแล้ว กรุณาเปิดแผงใหม่');
}

async function routeModal(interaction, runtime, route) {
  if (route === 'voucher_submit') {
    await assertCustomerRoute(interaction, runtime, 'TOPUP_ACCEPTING');
    consumeModalInteractionSession(runtime.db, { sessionId: parseCustomId(interaction.customId).sessionId, actorId: interaction.user.id,
      guildId: interaction.guildId, channelId: interaction.channelId, operation: 'VOUCHER_SUBMIT' });
    await interaction.deferReply({ ephemeral: true });
    let result;
    try {
      result = submitTopup(runtime.db, runtime.env, { discordUserId: interaction.user.id,
        voucherUrl: interaction.fields.getTextInputValue('url'), traceId: randomUUID(), prelaunch: runtime.env.PRELAUNCH });
    } catch (error) {
      if (String(error?.code ?? '').startsWith('INVALID_VOUCHER')) {
        consumeInteractionRateLimit(runtime.db, { discordUserId: interaction.user.id, action: 'INVALID_VOUCHER', limit: 5, windowMs: 30 * 60_000 });
      }
      throw error;
    }
    return acknowledgeTopupAndStartSettlement({ interaction, result, runtime });
  }
  if (route === 'token_submit') {
    await assertCustomerRoute(interaction, runtime, 'ORDER_ACCEPTING');
    consumeInteractionRateLimit(runtime.db, { discordUserId: interaction.user.id, action: 'TOKEN_VALIDATION', limit: 3, windowMs: 10 * 60_000 });
    consumeModalInteractionSession(runtime.db, { sessionId: parseCustomId(interaction.customId).sessionId, actorId: interaction.user.id,
      guildId: interaction.guildId, channelId: interaction.channelId, operation: 'TOKEN_SUBMIT' });
    await interaction.deferReply({ ephemeral: true });
    const checkoutId = recordCustomerToken(runtime, interaction, interaction.fields.getTextInputValue('token'));
    await interaction.editReply({ ...ephemeral('รับข้อมูลบัญชีแล้ว ระบบกำลังค้นหา Quest ของบัญชีนี้ เมื่อเสร็จแล้วกดปุ่มด้านล่างเพื่อเลือกรายการ'),
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId('checkout_open', checkoutId))
        .setLabel('เปิดรายการ Quest').setStyle(ButtonStyle.Primary))] });
    const message = await interaction.fetchReply();
    const job = runtime.db.prepare("SELECT * FROM jobs WHERE id=? AND job_type='CUSTOMER_QUEST_DISCOVERY'").get(checkoutId);
    if (!job) throw new QuestshopError('CHECKOUT_EXPIRED', 'หน้ารายการ Quest หมดอายุ กรุณาเริ่มใหม่');
    const payload = parsePayload(job.payload_json);
    updateCheckoutPayload(runtime, job, { ...payload, discoveryMessageId: message.id });
    return;
  }
  if (route === 'admin_price_submit') {
    const session = await consumeAdminModalSession(interaction, runtime, parseCustomId(interaction.customId).sessionId, 'ADMIN_PRICE_SUBMIT');
    const next = setQuestPrice(runtime.db, { taskType: session.payload.taskType,
      amountCents: interaction.fields.getTextInputValue('amountCents'), actorId: interaction.user.id,
      reason: interaction.fields.getTextInputValue('reason'), expectedConfigVersion: session.payload.expectedConfigVersion });
    runtime.config = loadRuntimeConfig(runtime.db);
    return interaction.reply(ephemeral(`บันทึกราคา ${session.payload.taskType} แล้ว (${next.priceRules[session.payload.taskType].amountCents / 100} บาท)`));
  }
  if (route === 'admin_receiver_submit') {
    await consumeAdminModalSession(interaction, runtime, parseCustomId(interaction.customId).sessionId, 'ADMIN_RECEIVER_SUBMIT');
    const receiver = configureReceiverPhone(runtime.db, runtime.env, { phone: interaction.fields.getTextInputValue('phone'), actorId: interaction.user.id,
      reason: interaction.fields.getTextInputValue('reason') });
    return interaction.reply(ephemeral(`ตั้งค่าเบอร์รับเงิน ••••${receiver.last4} แล้ว`));
  }
  if (route === 'admin_monitor_submit') {
    await consumeAdminModalSession(interaction, runtime, parseCustomId(interaction.customId).sessionId, 'ADMIN_MONITOR_SUBMIT');
    const monitor = upsertMonitorAccount(runtime.db, runtime.env, { accountId: interaction.fields.getTextInputValue('accountId'),
      label: interaction.fields.getTextInputValue('label'), token: interaction.fields.getTextInputValue('token'), actorId: interaction.user.id });
    return interaction.reply(ephemeral(`บันทึก Monitor ${monitor.label} แล้ว`));
  }
  if (route === 'admin_wallet_submit') {
    await consumeAdminModalSession(interaction, runtime, parseCustomId(interaction.customId).sessionId, 'ADMIN_WALLET_SUBMIT');
    const result = adjustWallet(runtime.db, { discordUserId: interaction.fields.getTextInputValue('discordUserId'),
      availableDeltaCents: interaction.fields.getTextInputValue('amountCents'), actorId: interaction.user.id, reason: interaction.fields.getTextInputValue('reason') });
    return interaction.reply(ephemeral(`ปรับ Wallet แล้ว ยอดใช้ได้ปัจจุบัน ${(Number(result.wallet.available_cents) / 100).toFixed(2)} บาท`));
  }
  if (route === 'admin_promotion_submit') {
    const session = await consumeAdminModalSession(interaction, runtime, parseCustomId(interaction.customId).sessionId, 'ADMIN_PROMOTION_SUBMIT');
    const promotion = upsertPromotion(runtime.db, { id: session.payload.id ?? undefined, name: interaction.fields.getTextInputValue('name'),
      state: interaction.fields.getTextInputValue('state').trim().toUpperCase(), minimumCents: interaction.fields.getTextInputValue('minimumCents'),
      basisPoints: interaction.fields.getTextInputValue('basisPoints'), maximumBonusCents: interaction.fields.getTextInputValue('maximumBonusCents'), actorId: interaction.user.id });
    return interaction.reply(ephemeral(`บันทึกโปรโมชั่น ${promotion.name} แล้ว`));
  }
  if (route === 'admin_review_submit') {
    await assertOwner(interaction, runtime);
    const session = await consumeAdminModalSession(interaction, runtime, parseCustomId(interaction.customId).sessionId, 'ADMIN_REVIEW_SUBMIT');
    const decision = interaction.fields.getTextInputValue('decision').trim().toUpperCase();
    const reason = interaction.fields.getTextInputValue('reason');
    const amountText = interaction.fields.getTextInputValue('amountCents').trim();
    let evidence = {};
    const evidenceText = interaction.fields.getTextInputValue('evidence').trim();
    if (evidenceText) {
      try { evidence = JSON.parse(evidenceText); } catch { throw new QuestshopError('REVIEW_EVIDENCE_INVALID', 'หลักฐานต้องเป็น JSON ที่ถูกต้อง'); }
    }
    const result = session.payload.subjectType === 'TOPUP'
      ? confirmFinancialReview(runtime.db, { reviewId: session.payload.reviewId, actorId: interaction.user.id, decision, reason,
        principalCents: amountText ? Number(amountText) : null, providerEvidence: evidence,
        providerTransactionId: evidence.providerTransactionId ?? null })
      : resolveOperationalReview(runtime.db, { reviewId: session.payload.reviewId, actorId: interaction.user.id, decision, reason,
        claimUrl: evidence.claimUrl ?? null, evidence });
    return interaction.reply(ephemeral(result.state === 'AWAITING_SECOND_CONFIRMATION' ? 'บันทึกการยืนยันขั้นที่ 1 แล้ว ให้ยืนยันซ้ำอีกครั้ง' : 'ตัดสิน Manual Review แล้ว'));
  }
  throw new QuestshopError('ROUTE_INTERACTION_INVALID', 'แบบฟอร์มนี้หมดอายุแล้ว กรุณาเริ่มใหม่');
}

async function routeSelect(interaction, runtime, route, sessionId) {
  if (route === 'checkout_select') return selectCheckoutQuests(interaction, runtime, sessionId);
  if (route === 'admin') { assertCurrentSurface(interaction, runtime, 'ADMIN_PANEL'); return handleAdminMenu(interaction, runtime); }
  if (route === 'admin_review_select') {
    const session = await consumeAdminSession(interaction, runtime, sessionId, 'ADMIN_REVIEW_SELECT');
    const reviewId = interaction.values?.[0];
    if (!session.payload.reviewIds.includes(reviewId)) throw new QuestshopError('INTERACTION_CONTEXT_INVALID', 'รายการตรวจสอบไม่อยู่ในเมนูนี้');
    const review = runtime.db.prepare("SELECT * FROM manual_reviews WHERE id=? AND state='OPEN'").get(reviewId);
    if (!review) throw new QuestshopError('REVIEW_NOT_OPEN', 'รายการนี้ไม่ได้รอตรวจสอบแล้ว');
    const decideId = sessionContext(interaction, runtime, 'ADMIN_REVIEW_DECIDE', { reviewId: review.id, subjectType: review.subject_type });
    return replyAndBindSessions(interaction, runtime, { content: `${review.category}: ${review.reason_code}\n${review.subject_type} ${review.subject_id}`,
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId('admin_review_decide', decideId))
        .setLabel('ตัดสินรายการนี้').setStyle(ButtonStyle.Danger))] }, [decideId]);
  }
  if (route === 'admin_dlq_select') {
    const session = await consumeAdminSession(interaction, runtime, sessionId, 'ADMIN_DLQ_SELECT');
    const notificationId = interaction.values?.[0];
    if (!session.payload.notificationIds.includes(notificationId)) throw new QuestshopError('INTERACTION_CONTEXT_INVALID', 'ข้อความนี้ไม่อยู่ในเมนู DLQ');
    const row = runtime.db.prepare("SELECT * FROM notifications WHERE id=? AND state='DEAD_LETTER'").get(notificationId);
    if (!row) throw new QuestshopError('DLQ_NOT_FOUND', 'ข้อความนี้ไม่ได้ค้างส่งแล้ว');
    const retryId = sessionContext(interaction, runtime, 'ADMIN_DLQ_RETRY', { notificationId });
    return replyAndBindSessions(interaction, runtime, { content: `${row.notification_type} → ${row.destination}\nสาเหตุล่าสุด: ${row.last_error_code ?? '-'}`,
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId('admin_dlq_retry', retryId))
        .setLabel('Retry ด้วย nonce เดิม').setStyle(ButtonStyle.Primary))] }, [retryId]);
  }
  throw new QuestshopError('ROUTE_INTERACTION_INVALID', 'เมนูนี้หมดอายุแล้ว กรุณาเปิดใหม่');
}

function customerError(error) {
  if (error instanceof QuestshopError) return error.message;
  if (error instanceof TypeError) return 'ข้อมูลที่กรอกไม่ถูกต้อง กรุณาตรวจสอบแล้วลองใหม่';
  return 'ระบบขัดข้องชั่วคราว กรุณาลองใหม่ภายหลัง';
}

export async function routeInteraction(interaction) {
  const runtime = interaction.client.questshop;
  if (!runtime || runtime.acceptingInteractions === false) return;
  installResponseController(interaction);
  try {
    const parsedRoute = parseCustomId(interaction.customId);
    if (!interaction.inGuild() || interaction.guildId !== runtime.env.DISCORD_GUILD_ID) return;
    if (interaction.isChatInputCommand() && await handleSurfaceCommand(interaction, runtime)) return;
    const route = parsedRoute;
    if (!route) {
      if (interaction.isChatInputCommand()) await interaction.reply(ephemeral('คำสั่งนี้ไม่มีในระบบ Questshop'));
      return;
    }
    await assertRouteContract(interaction, runtime, route.route);
    if (interaction.isButton()) return routeButton(interaction, runtime, route.route, route.sessionId);
    if (interaction.isStringSelectMenu()) return routeSelect(interaction, runtime, route.route, route.sessionId);
    if (interaction.isModalSubmit()) return routeModal(interaction, runtime, route.route);
    throw new QuestshopError('ROUTE_INTERACTION_INVALID', 'รูปแบบการกดเมนูไม่ถูกต้อง');
  } catch (error) {
    const message = safeDiscordText(customerError(error), { maximum: 1_800 });
    if (interaction.deferred || interaction.replied) await interaction.editReply(ephemeral(message));
    else await interaction.reply(ephemeral(message));
    runtime.logger?.warn?.({ code: error?.code, message: error?.message }, 'interaction rejected');
  }
}

export function interactionMatchesContract(interaction, runtime) {
  if (!interaction?.inGuild?.() || interaction.guildId !== runtime?.env?.DISCORD_GUILD_ID) return false;
  if (interaction.isChatInputCommand?.()) return Boolean(SURFACE_COMMANDS[interaction.commandName]);
  const parsed = parseCustomId(interaction.customId);
  return Boolean(parsed && routeContract(parsed.route)?.interaction === interactionKind(interaction));
}
