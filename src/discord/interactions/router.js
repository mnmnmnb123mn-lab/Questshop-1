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

function ephemeral(content) { return { content, ephemeral: true, allowedMentions: { parse: [] } }; }

export function hasAdministratorPermission(interaction) {
  return interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator) === true;
}

function assertBackoffice(interaction, runtime) {
  if (interaction.user.id === runtime.env.OWNER_ID || hasAdministratorPermission(interaction)) return;
  throw new QuestshopError('NOT_AUTHORIZED', 'เมนูนี้ใช้ได้เฉพาะผู้ดูแล');
}

function assertCustomerRoute(interaction, runtime, gate) {
  const gates = currentFeatureGates(runtime.db);
  if (!gates.STORE_OPEN || !gates.CUSTOMER_INTERACTIONS_ENABLED || !gates[gate]) {
    throw new QuestshopError('FEATURE_DISABLED', 'ส่วนนี้ยังไม่เปิดให้ใช้งาน กรุณาติดต่อผู้ดูแล');
  }
  if (runtime.env.PRELAUNCH && interaction.user.id !== runtime.env.OWNER_ID && !hasAdministratorPermission(interaction)) {
    throw new QuestshopError('PRELAUNCH_RESTRICTED', 'ระบบกำลังทดสอบก่อนเปิดใช้งาน');
  }
}

function voucherModal() {
  const input = new TextInputBuilder().setCustomId('url').setLabel('ลิงก์ซอง TrueMoney')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(512)
    .setPlaceholder('https://gift.truemoney.com/campaign/?v=...');
  return new ModalBuilder().setCustomId(customId('voucher_submit')).setTitle('เติมเงิน TrueMoney')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function tokenModal() {
  const input = new TextInputBuilder().setCustomId('token').setLabel('Discord Token')
    .setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(20).setMaxLength(300)
    .setPlaceholder('Token ใช้เฉพาะการตรวจ Quest และจะถูกลบตามกำหนด');
  return new ModalBuilder().setCustomId(customId('token_submit')).setTitle('เริ่มทำ Quest')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function handleSurfaceCommand(interaction, runtime) {
  const surfaceKey = SURFACE_COMMANDS[interaction.commandName];
  if (!surfaceKey) return false;
  assertBackoffice(interaction, runtime);
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
      `customer-discovery:${id}`, timestamp, JSON.stringify({ discordUserId: interaction.user.id, credentialId: id }), timestamp, timestamp);
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
  if (!payload.accountId || !Array.isArray(payload.questIds)) throw new QuestshopError('CHECKOUT_NOT_READY', 'ระบบกำลังค้นหา Quest อยู่ กรุณารอสักครู่');
  return { session, payload };
}

function selectedQuests(runtime, payload, selectedIds) {
  const ids = [...new Set((selectedIds ?? []).map(String))].filter((id) => payload.questIds.includes(id)).slice(0, 25);
  if (!ids.length) throw new QuestshopError('NO_SELLABLE_QUEST', 'กรุณาเลือก Quest อย่างน้อยหนึ่งรายการ');
  const rows = runtime.db.prepare(`SELECT * FROM quests WHERE quest_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  if (rows.length !== ids.length) throw new QuestshopError('QUEST_NOT_FOUND', 'Quest ที่เลือกมีการเปลี่ยนแปลง กรุณาเริ่มใหม่');
  const timestamp = nowMs();
  const config = loadRuntimeConfig(runtime.db);
  runtime.config = config;
  return rows.map((quest) => {
    if (quest.expires_at != null && Number(quest.expires_at) <= timestamp) throw new QuestshopError('QUEST_EXPIRED', 'Quest บางรายการหมดอายุแล้ว');
    const priceCents = priceForQuest(config.values, quest.task_type);
    if (priceCents == null) throw new QuestshopError('PRICE_NOT_CONFIGURED', 'ร้านยังไม่ได้ตั้งราคาสำหรับ Quest บางรายการ');
    return { questId: quest.quest_id, name: quest.name, priceCents };
  });
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
    if (!quest || (quest.expires_at != null && Number(quest.expires_at) <= timestamp)) return null;
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
      new ButtonBuilder().setCustomId(customId('checkout_confirm', checkoutId)).setLabel('ยืนยันและตัดเครดิต').setStyle(ButtonStyle.Success).setDisabled(selectedCount === 0),
    )], allowedMentions: { parse: [] },
  };
}

function updateCheckoutPayload(runtime, checkoutId, payload) {
  withImmediateTransaction(runtime.db, () => runtime.db.prepare('UPDATE jobs SET payload_json=?,updated_at=? WHERE id=?')
    .run(JSON.stringify(payload), nowMs(), checkoutId));
}

async function openCheckout(interaction, runtime, checkoutId) {
  assertCustomerRoute(interaction, runtime, 'ORDER_ACCEPTING');
  const { payload } = checkoutSession(runtime, interaction, checkoutId);
  return interaction.reply({ ...checkoutPagePayload(runtime, checkoutId, payload), ephemeral: true });
}

async function moveCheckoutPage(interaction, runtime, checkoutId, direction) {
  assertCustomerRoute(interaction, runtime, 'ORDER_ACCEPTING');
  const { payload } = checkoutSession(runtime, interaction, checkoutId);
  const next = { ...payload, page: Math.max(0, (Number(payload.page) || 0) + direction) };
  updateCheckoutPayload(runtime, checkoutId, next);
  return interaction.update(checkoutPagePayload(runtime, checkoutId, next));
}

async function selectCheckoutQuests(interaction, runtime, checkoutId) {
  assertCustomerRoute(interaction, runtime, 'ORDER_ACCEPTING');
  const { payload } = checkoutSession(runtime, interaction, checkoutId);
  const pageRows = pricedCheckoutQuestRows(runtime, payload).slice((Number(payload.page) || 0) * 25, ((Number(payload.page) || 0) + 1) * 25);
  const selected = new Set(payload.selectedQuestIds ?? []);
  for (const quest of pageRows) selected.delete(quest.quest_id);
  for (const questId of interaction.values ?? []) selected.add(String(questId));
  const next = { ...payload, selectedQuestIds: [...selected] };
  updateCheckoutPayload(runtime, checkoutId, next);
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
  const ids = new Set(fresh.map((quest) => String(quest.id)));
  if (selected.some((quest) => !ids.has(quest.questId))) throw new QuestshopError('QUEST_CHANGED', 'Quest ที่เลือกไม่อยู่ในบัญชีนี้แล้ว กรุณาเลือกใหม่');
  return selected;
}

async function confirmCheckout(interaction, runtime, checkoutId) {
  assertCustomerRoute(interaction, runtime, 'ORDER_ACCEPTING');
  const { payload } = checkoutSession(runtime, interaction, checkoutId);
  const quests = selectedQuests(runtime, payload, payload.selectedQuestIds);
  await interaction.deferUpdate();
  await freshCheckoutQuests(runtime, payload, quests);
  const order = createOrder(runtime.db, { discordUserId: interaction.user.id, questAccountId: payload.accountId,
    credentialId: payload.credentialId, items: quests, traceId: randomUUID() });
  return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x23a55a).setTitle('✅ รับ Order แล้ว')
    .setDescription(`Order: \`${order.id}\`\nระบบกันเครดิตและเริ่มทำ Quest ให้แล้ว คุณจะได้รับความคืบหน้าทาง DM`)],
  components: [], allowedMentions: { parse: [] } });
}

async function routeButton(interaction, runtime, route, sessionId) {
  if (route === 'topup') { assertCustomerRoute(interaction, runtime, 'TOPUP_ACCEPTING'); return interaction.showModal(voucherModal()); }
  if (route === 'start') { assertCustomerRoute(interaction, runtime, 'ORDER_ACCEPTING'); return interaction.showModal(tokenModal()); }
  if (route === 'admin') {
    assertBackoffice(interaction, runtime);
    return interaction.reply(ephemeral('แผงผู้ดูแลกำลังย้ายมาใช้ SQLite เมนูตั้งค่าพื้นฐานจะกลับมาเมื่อเปิด Runtime ใหม่'));
  }
  if (route === 'customer_quest_case_retry') {
    assertBackoffice(interaction, runtime);
    const result = retryCustomerDiscovery(runtime.db, { notificationId: sessionId, actorId: interaction.user.id });
    return interaction.reply(ephemeral(result.queued ? 'เริ่มตรวจและทดสอบ Quest ใหม่แล้ว' : 'Quest นี้มีงานตรวจอยู่แล้ว'));
  }
  if (route === 'customer_quest_announce') {
    assertBackoffice(interaction, runtime);
    announceCustomerDiscovery(runtime.db, { notificationId: sessionId, actorId: interaction.user.id });
    return interaction.reply(ephemeral('ส่ง Quest เข้าคิวประกาศแล้ว'));
  }
  if (route === 'checkout_open') return openCheckout(interaction, runtime, sessionId);
  if (route === 'checkout_page_previous') return moveCheckoutPage(interaction, runtime, sessionId, -1);
  if (route === 'checkout_page_next') return moveCheckoutPage(interaction, runtime, sessionId, 1);
  if (route === 'checkout_confirm') return confirmCheckout(interaction, runtime, sessionId);
  throw new QuestshopError('ROUTE_INTERACTION_INVALID', 'ปุ่มนี้หมดอายุแล้ว กรุณาเปิดแผงใหม่');
}

async function routeModal(interaction, runtime, route) {
  if (route === 'voucher_submit') {
    assertCustomerRoute(interaction, runtime, 'TOPUP_ACCEPTING');
    await interaction.deferReply({ ephemeral: true });
    const result = submitTopup(runtime.db, runtime.env, { discordUserId: interaction.user.id,
      voucherUrl: interaction.fields.getTextInputValue('url'), traceId: randomUUID() });
    return acknowledgeTopupAndStartSettlement({ interaction, result, runtime });
  }
  if (route === 'token_submit') {
    assertCustomerRoute(interaction, runtime, 'ORDER_ACCEPTING');
    await interaction.deferReply({ ephemeral: true });
    const checkoutId = recordCustomerToken(runtime, interaction, interaction.fields.getTextInputValue('token'));
    return interaction.editReply({ ...ephemeral('รับข้อมูลบัญชีแล้ว ระบบกำลังค้นหา Quest ของบัญชีนี้ เมื่อเสร็จแล้วกดปุ่มด้านล่างเพื่อเลือกรายการ'),
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId('checkout_open', checkoutId))
        .setLabel('เปิดรายการ Quest').setStyle(ButtonStyle.Primary))] });
  }
  throw new QuestshopError('ROUTE_INTERACTION_INVALID', 'แบบฟอร์มนี้หมดอายุแล้ว กรุณาเริ่มใหม่');
}

function customerError(error) {
  if (error instanceof QuestshopError) return error.message;
  if (error instanceof TypeError) return 'ข้อมูลที่กรอกไม่ถูกต้อง กรุณาตรวจสอบแล้วลองใหม่';
  return 'ระบบขัดข้องชั่วคราว กรุณาลองใหม่ภายหลัง';
}

export async function routeInteraction(interaction) {
  const runtime = interaction.client.questshop;
  if (!runtime || runtime.acceptingInteractions === false) return;
  try {
    const parsedRoute = parseCustomId(interaction.customId);
    const isCheckoutDm = ['checkout_select', 'checkout_confirm'].includes(parsedRoute?.route);
    if ((!interaction.inGuild() && !isCheckoutDm) || (interaction.inGuild() && interaction.guildId !== runtime.env.DISCORD_GUILD_ID)) return;
    if (interaction.isChatInputCommand() && await handleSurfaceCommand(interaction, runtime)) return;
    const route = parsedRoute;
    if (!route) {
      if (interaction.isChatInputCommand()) await interaction.reply(ephemeral('คำสั่งนี้ไม่มีในระบบ Questshop'));
      return;
    }
    if (interaction.isButton()) return routeButton(interaction, runtime, route.route, route.sessionId);
    if (interaction.isStringSelectMenu() && route.route === 'checkout_select') return selectCheckoutQuests(interaction, runtime, route.sessionId);
    if (interaction.isModalSubmit()) return routeModal(interaction, runtime, route.route);
    throw new QuestshopError('ROUTE_INTERACTION_INVALID', 'รูปแบบการกดเมนูไม่ถูกต้อง');
  } catch (error) {
    const message = safeDiscordText(customerError(error), { maximum: 1_800 });
    if (interaction.deferred || interaction.replied) await interaction.editReply(ephemeral(message));
    else await interaction.reply(ephemeral(message));
    runtime.logger?.warn?.({ code: error?.code, message: error?.message }, 'interaction rejected');
  }
}

export function interactionMatchesContract() { return true; }
