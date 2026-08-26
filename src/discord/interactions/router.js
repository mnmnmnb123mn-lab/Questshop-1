import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, LabelBuilder, ModalBuilder,
  PermissionFlagsBits, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder,
} from 'discord.js';
import { v7 as uuidv7 } from 'uuid';
import { createContext, supportCode } from '../../shared/correlation.js';
import { safeError } from '../../shared/redaction.js';
import { QuestshopError } from '../../shared/errors.js';
import { submitVoucher } from '../../domain/payments/service.js';
import {
  buildQuote, confirmOrder, createSession, getSelectionPage, selectAll, updateSelection,
} from '../../domain/checkout/service.js';
import { SURFACE_COMMANDS } from '../commands/definitions.js';
import { customId, parseCustomId } from '../components/custom-id.js';
import { setupSurface } from '../surfaces/setup.js';
import { assertRateLimitAvailable, consumeRateLimit } from '../../domain/admin/rate-limits.js';
import { minimumConfiguredPrice, minimumSellablePrice } from '../../domain/pricing/resolver.js';
import { withTransaction } from '../../db/transaction.js';
import {
  advanceAdminSession,
  bindSessionMessage,
  bindRenderedSessionMessages,
  createAdminSession,
  loadAdminSession,
  terminateAdminSession,
} from '../../domain/admin/session-service.js';
import {
  replaceManualPromotion, setManualPromotionEnabled, setQuestCategoryPrice, updateRuntimeConfig,
} from '../../domain/admin/config-service.js';
import { adjustWalletAsAdmin } from '../../domain/admin/money-service.js';
import { refundCapturedOrderItem } from '../../domain/wallet/service.js';
import { resolveSubjectReview } from '../../domain/reviews/service.js';
import { parseBahtToCents } from '../../shared/money.js';
import { activateReceiver } from '../../domain/admin/receiver-service.js';
import {
  addMonitor, checkAllMonitorHealth, checkMonitorHealth, rotateMonitorCredential, setMonitorState,
} from '../../domain/admin/monitor-service.js';
import {
  forcePublishFailedMonitorTest, openOrderItemReview, setCircuitBreakerState,
} from '../../domain/admin/operations-service.js';
import { loadCustomerQuestDiscovery } from '../../domain/catalog/customer-discovery-service.js';
import {
  loadCustomerDiscoveryCase, queueCustomerDiscoveryAnnouncement, retryCustomerDiscoveryCase,
} from '../../domain/catalog/customer-discovery-case-service.js';
import { loadTestFailureAlert, retryFailedTestAlert } from '../../domain/catalog/test-gate.js';
import { discardDeadLetter, replayDeadLetter } from '../../domain/outbox/dlq-service.js';
import { loadRuntimeConfig } from '../../config/runtime-config.js';
import { DEFAULT_FEATURE_GATES } from '../../config/feature-gates.js';
import {
  baht,
  renderOrderConfirmation,
  renderPaymentMethod,
  renderQuote,
  renderSelection,
  renderTopupProcessing,
  renderTopupResult,
} from '../renderers/checkout.js';
import { waitForCustomerTopup } from '../../domain/payments/customer-status.js';
import { adminNavigationComponents } from '../renderers/admin.js';
import { orderStateLabel } from '../renderers/labels.js';
import { QUEST_PRICE_CATEGORIES } from '../../domain/pricing/categories.js';
import { customerErrorText, DISCORD_LIMITS, safeDiscordText, truncateDiscordText } from '../payload.js';
import { ADMIN, CUSTOMER, OWNER, assertRouteContractCoverage, routeContract } from './contracts.js';
import {
  ACKNOWLEDGEMENT, acknowledgementOf, acknowledgeByContract, ephemeralResponse, installResponseController,
} from './response-controller.js';

function money(cents) { return baht(cents); }
function escapedText(value, fallback = 'ไม่ระบุ') {
  return safeDiscordText(value, { fallback });
}

export function parsePromotionBasisPoints(rawPercent) {
  const text = String(rawPercent).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new TypeError('ระดับโบนัสโปรโมชั่นไม่ถูกต้อง');
  const [whole, fraction = ''] = text.split('.');
  const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new TypeError('ระดับโบนัสโปรโมชั่นไม่ถูกต้อง');
  }
  return basisPoints;
}
function monitorHealthLabel(monitorState, healthState) {
  if (monitorState === 'DISABLED') {
    return healthState === 'READY' ? '⚪ พักใช้งาน (Token ปกติ)' : '⚪ พักใช้งาน (Token มีปัญหา)';
  }
  if (healthState === 'READY') return '🟢 พร้อม';
  if (healthState === 'DEGRADED') return '🟡 มีปัญหาชั่วคราว';
  return '🔴 ใช้ไม่ได้';
}
function monitorDetailHealthLabel(healthState) {
  if (healthState === 'READY') return '🟢 พร้อมใช้งาน';
  if (healthState === 'DEGRADED') return '🟡 มีปัญหาชั่วคราว';
  if (healthState === 'INVALID') return '🔴 Token ใช้ไม่ได้';
  return '⚫ ยังไม่ตรวจ';
}
const DISPLAY_STATES = Object.freeze({
  ACTIVE: 'เปิดใช้งาน', INACTIVE: 'ไม่ได้ใช้งาน', DISABLED: 'พักใช้งาน', DRAFT: 'แบบร่าง',
  SCHEDULED: 'ตั้งเวลาไว้', OPEN: 'เปิดอยู่', CLOSED: 'ปิดอยู่', PAUSED: 'พักชั่วคราว', EXPIRED: 'หมดอายุ',
  READY: 'พร้อม', DEGRADED: 'มีปัญหาชั่วคราว', INVALID: 'ใช้ไม่ได้', QUARANTINED: 'ระงับอัตโนมัติ',
  PENDING: 'รอดำเนินการ', LEASED: 'กำลังดำเนินการ', RUNNING: 'กำลังทำงาน', COMPLETED: 'เสร็จแล้ว',
  VERIFIED: 'ตรวจสอบแล้ว', FAILED: 'ไม่สำเร็จ', RESOLVED: 'จัดการแล้ว', DEAD_LETTER: 'รอตรวจสอบงานค้าง',
  HALF_OPEN: 'กำลังทดสอบการกลับมาใช้งาน', CREDITED: 'เพิ่มเครดิตแล้ว', REJECTED: 'ปฏิเสธรายการ',
  ASSIGNED: 'มีผู้รับผิดชอบแล้ว', EVIDENCE_PENDING: 'รอหลักฐาน', DECISION_READY: 'พร้อมสรุปผล',
});
function displayState(value) { return DISPLAY_STATES[value] ?? 'กำลังตรวจสอบ'; }
function breakerStateLabel(value) {
  return { CLOSED: 'เปิดทำงานปกติ', OPEN: 'หยุดรับรายการอัตโนมัติ', HALF_OPEN: 'กำลังทดสอบการกลับมาใช้งาน' }[value]
    ?? 'กำลังตรวจสอบ';
}
function dlqCategoryLabel(category) {
  if (category === 'FINANCIAL') return 'การเงิน';
  if (category === 'AUDIT') return 'บันทึก Audit';
  return 'งานระบบ';
}
function dlqSourceLabel(sourceType) {
  return sourceType === 'OUTBOX' ? 'Discord' : 'Worker';
}
function websocketPing(client) {
  const ping = client.ws?.ping;
  return Number.isFinite(ping) && ping >= 0 ? `${ping} ms` : 'กำลังเชื่อมต่อ';
}
function overviewRuntimeMetrics(interaction, runtime) {
  const health = runtime.health ?? {};
  const overview = health.overview ?? {};
  const workers = Object.values(health.workers ?? {});
  const healthyWorkers = workers.filter((worker) => worker.state === 'RUNNING').length;
  const uptimeMs = Math.max(0, Date.now() - Date.parse(health.startedAt ?? Date.now()));
  return {
    overview,
    workers,
    healthyWorkers,
    uptimeMinutes: Math.floor(uptimeMs / 60_000),
    discordReady: interaction.client.isReady(),
    rssMb: overview.memoryRssBytes == null ? 'ยังไม่มี' : `${Math.round(overview.memoryRssBytes / 1024 / 1024)} MB`,
    ping: websocketPing(interaction.client),
  };
}
function overviewDescription({ incidents, metrics, queue, reviews, surfaces, row, runtime }) {
  const { workers, healthyWorkers, uptimeMinutes, ping, discordReady } = metrics;
  const values = runtime.config.values ?? {};
  const questRole = values.questAnnouncementRoleId ? `<@&${values.questAnnouncementRoleId}>` : 'ปิด';
  return [
    '**ภาพรวมการเงิน**',
    `ลูกค้าที่มีเครดิต: **${row.users} คน**`, `เครดิตพร้อมใช้รวม: **${money(row.available)}**`, `เครดิตที่จองรวม: **${money(row.reserved)}**`,
    '', '**งานที่ต้องดูแล**',
    `งานในคิว: **${queue.rows[0].count}** • รอตรวจสอบ: **${reviews.rows[0].count}** • เหตุขัดข้อง: **${incidents.rows[0].count}**`,
    '', '**สุขภาพระบบ**',
    `ฐานข้อมูล: **${runtime.health?.checks?.database ?? (runtime.health?.ready ? 'พร้อม' : 'กำลังตรวจ')}** • Discord: **${discordReady ? 'พร้อม' : 'กำลังเชื่อมต่อ'}**`,
    `Worker พร้อมทำงาน: **${healthyWorkers}/${workers.length}** • Ping: **${ping}** • เปิดมาแล้ว: **${uptimeMinutes} นาที**`,
    `ห้อง/แผงที่ติดตั้ง: **${surfaces.rows[0].count}** • ผู้ดูแลหลังบ้าน: **สิทธิ์ Administrator** • ยศแจ้ง Quest: **${questRole}**`,
  ].join('\n');
}
function runnerConcurrency(runtime) {
  return Math.max(1, Math.min(runtime.env.RUNNER_CONCURRENCY_HARD_MAX,
    Number(runtime.config.values?.runnerConcurrency ?? runtime.env.RUNNER_CONCURRENCY)));
}
function actorTypeFor(interaction, runtime) {
  if (interaction.user.id === runtime.env.OWNER_ID) return 'OWNER';
  if (hasAdministratorPermission(interaction)) return 'ADMIN';
  return 'CUSTOMER';
}
function contextFor(interaction, operation) {
  const runtime = interaction.client.questshop;
  const actorType = actorTypeFor(interaction, runtime);
  return createContext({ traceId: interaction.__questshopTraceId ?? uuidv7(), actorType,
    actorId: interaction.user.id, guildId: interaction.guildId,
    idempotencyKey: `${operation}:${interaction.id}`,
    messageId: interaction.message?.id ?? null });
}
async function completeInteractionSession(session, interaction, runtime) {
  return terminateAdminSession({ sessionId: session.id, actorId: interaction.user.id,
    guildId: interaction.guildId, expectedVersion: session.state_version },
  contextFor(interaction, 'interaction_session_complete'), { pool: runtime.pool });
}
async function advanceInteractionSession(session, interaction, runtime, child, operation) {
  return advanceAdminSession({ parentSession: session, actorId: interaction.user.id,
    guildId: interaction.guildId, child: { ...child, channelId: child.channelId ?? interaction.channelId } },
  contextFor(interaction, operation), { pool: runtime.pool });
}
export function hasAdministratorPermission(interaction) {
  return interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator) === true;
}

function isBackoffice(interaction, runtime) {
  if (interaction.user.id === runtime.env.OWNER_ID) return true;
  return hasAdministratorPermission(interaction);
}
const CUSTOMER_ERROR_CODES = new Set([
  'OWNER_ONLY', 'ADMIN_ONLY', 'NOT_AUTHORIZED', 'SESSION_EXPIRED', 'STALE_SESSION',
  'STORE_CLOSED', 'TOPUP_CLOSED', 'ORDER_CLOSED', 'PRELAUNCH_RESTRICTED',
  'WALLET_INSUFFICIENT', 'NO_SELLABLE_QUEST', 'SURFACE_BINDING_INVALID',
  'PRICE_CONFIGURATION_MISSING', 'REVIEW_NOT_FOUND', 'ORDER_ITEM_NOT_FOUND',
  'DLQ_SELECTION_INVALID', 'DLQ_NOT_FOUND', 'RESERVATION_NOT_FOUND', 'ALREADY_REFUNDED',
  'REFUND_NOT_CAPTURED', 'PROMOTION_NOT_FOUND', 'TOKEN_INVALID', 'INVALID_VOUCHER_URL',
  'INVALID_VOUCHER_CODE', 'ROUTE_INTERACTION_INVALID',
  'RATE_LIMITED', 'QUOTE_EXPIRED', 'QUEUE_FULL', 'ACCOUNT_ACTIVE_ORDER', 'SESSION_NOT_FOUND',
  'QUEST_INSUFFICIENT_TIME', 'QUEST_EXTERNALLY_COMPLETED', 'TOKEN_ACCOUNT_CHANGED',
  'TOPUP_DAILY_LIMIT', 'RECEIVER_UNAVAILABLE', 'RUNTIME_NOT_ACTIVE', 'STALE_STATE',
  'INSUFFICIENT_BALANCE', 'ADMIN_CATEGORY_INVALID', 'SURFACE_CHANNEL_INVALID',
  'CUSTOMER_DISCOVERY_NOT_FOUND', 'CUSTOMER_DISCOVERY_DECIDED', 'QUEST_NOT_SALE_ELIGIBLE', 'QUEST_EXPIRED',
]);

const INCIDENT_ERROR_CODES = new Set([
  'SECRET_DECRYPT_FAILED', 'LEDGER_INVARIANT', 'RUNTIME_MIGRATOR_ROLE_CONFLICT',
  'FENCING_LOST', 'SCHEMA_INCOMPATIBLE',
]);

function interactionErrorOutcome(error) {
  if (!error) return 'SUCCESS';
  if (error instanceof QuestshopError && CUSTOMER_ERROR_CODES.has(error.code)) return 'REJECTED';
  if (error instanceof QuestshopError && !INCIDENT_ERROR_CODES.has(error.code)) return 'REJECTED';
  return 'ERROR';
}
export function formatInteractionError(error, interactionId) {
  const support = supportCode(error?.traceId ?? interactionId);
  let detail = 'เกิดข้อผิดพลาดภายใน ระบบบันทึกรหัสสำหรับตรวจสอบแล้ว';
  if (error instanceof QuestshopError && CUSTOMER_ERROR_CODES.has(error.code)) {
    detail = truncateDiscordText(error.message, 1_700);
  } else if (error instanceof TypeError) {
    detail = 'ข้อมูลที่กรอกไม่ถูกต้อง กรุณาตรวจสอบแล้วลองใหม่';
  }
  return customerErrorText(`ไม่สามารถดำเนินการได้: ${detail}`, support);
}
async function ephemeralError(interaction, error) {
  const message = formatInteractionError(error, interaction.__questshopTraceId ?? interaction.id);
  const acknowledgement = acknowledgementOf(interaction);
  if (acknowledgement === ACKNOWLEDGEMENT.MODAL) return null;
  if ([ACKNOWLEDGEMENT.DEFER_UPDATE, ACKNOWLEDGEMENT.UPDATE].includes(acknowledgement)) {
    return interaction.editReply({ content: message, embeds: [], components: [] });
  }
  if ([ACKNOWLEDGEMENT.DEFER_REPLY, ACKNOWLEDGEMENT.REPLY].includes(acknowledgement)) {
    return interaction.editReply({ content: message, embeds: [], components: [] });
  }
  return interaction.reply(ephemeralResponse({ content: message, allowedMentions: { parse: [] } }));
}

function pendingModalPreparations(runtime) {
  runtime.pendingModalPreparations ??= new Map();
  return runtime.pendingModalPreparations;
}

async function waitForModalPreparation(runtime, sessionId) {
  const preparations = pendingModalPreparations(runtime);
  const pending = preparations.get(sessionId);
  if (!pending) return;
  if (pending.expiresAt <= Date.now()) {
    preparations.delete(sessionId);
    throw new QuestshopError('SESSION_EXPIRED', 'หน้ากรอกข้อมูลหมดอายุแล้ว กรุณาเริ่มใหม่');
  }
  if (pending.status === 'CONSUMING' || pending.status === 'CONSUMED') {
    throw new QuestshopError('STALE_SESSION', 'แบบฟอร์มนี้ถูกส่งไปแล้ว กรุณาเริ่มใหม่');
  }
  pending.status = 'CONSUMING';
  await pending.promise;
  preparations.delete(sessionId);
  if (pending.status === 'FAILED') throw pending.error;
  if (pending.status !== 'CONSUMING') throw new QuestshopError('SESSION_EXPIRED', 'หน้ากรอกข้อมูลหมดอายุแล้ว กรุณาเริ่มใหม่');
  pending.status = 'CONSUMED';
}

async function showPreparedModal({ interaction, runtime, route, modal, sessionId = uuidv7(), prepare }) {
  const preparations = pendingModalPreparations(runtime);
  const pending = { status: 'PENDING', error: null, expiresAt: Date.now() + 5 * 60_000, promise: null };
  preparations.set(sessionId, pending);
  // Invoke the acknowledgement before scheduling the small durable
  // preparation, but publish the Promise synchronously so an unusually fast
  // modal submit can never observe a missing preparation record.
  const modalAcknowledgement = interaction.showModal(modal(sessionId));
  pending.promise = Promise.resolve().then(async () => {
    await authorizeRoute(interaction, route, runtime);
    return prepare(sessionId);
  }).then((value) => {
    if (pending.status === 'PENDING') pending.status = 'SUCCEEDED';
    return value;
  }, (error) => {
    pending.status = 'FAILED';
    pending.error = error;
    runtime.logger?.info?.({ error: safeError(error), sessionId, route: route.route }, 'modal preparation failed');
    return null;
  });
  try {
    await modalAcknowledgement;
  } catch (error) {
    preparations.delete(sessionId);
    throw error;
  }
  return sessionId;
}
function tokenModal(sessionId) {
  const input = new TextInputBuilder().setCustomId('token').setStyle(TextInputStyle.Paragraph)
    .setRequired(true).setMinLength(20).setMaxLength(300).setPlaceholder('วาง Token ของบัญชีที่ต้องการทำ Quest');
  return new ModalBuilder().setCustomId(customId('token_submit', sessionId)).setTitle('ตรวจบัญชี Quest')
    .addLabelComponents(new LabelBuilder().setLabel('Discord Token')
      .setDescription('Token จะถูกเข้ารหัส ใช้เฉพาะ Order นี้ และไม่แสดงให้แอดมินเห็น').setTextInputComponent(input));
}
function voucherModal(sessionId) {
  const input = new TextInputBuilder().setCustomId('url')
    .setPlaceholder('https://gift.truemoney.com/campaign/?v=...').setStyle(TextInputStyle.Short).setRequired(true);
  return new ModalBuilder().setCustomId(customId('voucher_submit', sessionId)).setTitle('เติมเงิน TrueMoney Gift')
    .addLabelComponents(new LabelBuilder().setLabel('ลิงก์ซองอั่งเปา')
      .setDescription('รองรับซองผู้รับคนเดียว กรุณาตรวจยอดก่อนส่ง').setTextInputComponent(input));
}
function fieldsModal(route, sessionId, title, fields) {
  const modal = new ModalBuilder().setCustomId(customId(route, sessionId))
    .setTitle(truncateDiscordText(title, 45));
  for (const field of fields) {
    const input = new TextInputBuilder().setCustomId(field.id)
      .setStyle(field.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field.required !== false).setMaxLength(field.max ?? 500);
    if (field.placeholder) input.setPlaceholder(truncateDiscordText(field.placeholder, 100));
    const label = new LabelBuilder().setLabel(truncateDiscordText(field.label, 45)).setTextInputComponent(input);
    if (field.description) label.setDescription(truncateDiscordText(field.description, 100));
    modal.addLabelComponents(label);
  }
  return modal;
}
function parseSignedBaht(value) {
  const text = String(value).trim();
  const negative = text.startsWith('-');
  const amount = parseBahtToCents(negative ? text.slice(1) : text);
  return negative ? -amount : amount;
}
function listRows(rows, formatter, empty = 'ไม่มี') {
  const content = rows.map(formatter).join('\n');
  return content || empty;
}

function deadLetterLine(row) {
  const errorStatus = row.error_code ? 'มีรายละเอียดข้อผิดพลาด' : 'ไม่มีรหัสข้อผิดพลาด';
  return `• ${dlqCategoryLabel(row.category)} • ${displayState(row.state)} • ${errorStatus}`;
}

function incidentLine(row) {
  const severity = { CRITICAL: 'วิกฤต', HIGH: 'รุนแรง', WARNING: 'เฝ้าระวัง', INFO: 'แจ้งข้อมูล' }[row.severity] ?? 'ตรวจสอบ';
  return `• ${severity} • มีเหตุขัดข้องที่ต้องตรวจสอบ`;
}

function dlqSummary(dlq, incidents) {
  return ['**งานที่ส่งไม่สำเร็จและต้องตรวจ**', listRows(dlq, deadLetterLine, 'ไม่มีงานค้าง'), '',
    '**เหตุขัดข้องที่ยังเปิดอยู่**', listRows(incidents, incidentLine, 'ไม่มีเหตุขัดข้อง')].join('\n');
}

function ownerOnly(interaction, runtime, message) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', message);
}

function panelEmbed(color, title, description) {
  return new EmbedBuilder().setColor(color)
    .setTitle(truncateDiscordText(title, DISCORD_LIMITS.embedTitle))
    .setDescription(truncateDiscordText(description, DISCORD_LIMITS.embedDescription));
}

function adminReply(interaction, selected, payload) {
  const runtime = interaction.client.questshop;
  return interaction.editReply({ ...payload,
    components: adminNavigationComponents(selected, payload.components ?? [], {
      isOwner: interaction.user.id === runtime.env.OWNER_ID,
    }),
    allowedMentions: { parse: [] } });
}

function renderWalletPanel(interaction) {
  return adminReply(interaction, 'wallet', { embeds: [panelEmbed(0xf0b232, 'ปรับยอดและคืนเครดิต',
    'เลือกผู้ใช้หรือรายการงานจากหน้าถัดไป ระบบจะแสดงยอดก่อน–หลังและให้ยืนยันซ้ำ\nเครดิตที่กำลังจองแก้ตรงจากเมนูนี้ไม่ได้ และทุกการแก้ยอดมีประวัติถาวร')],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('wallet_adjust')).setLabel('เลือกผู้ใช้เพื่อปรับเครดิต').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(customId('refund_prepare')).setLabel('เลือกงานเพื่อคืนเครดิต').setStyle(ButtonStyle.Secondary),
  )] });
}

async function renderPaymentsPanel(interaction, runtime) {
  const reviews = (await runtime.pool.query(`SELECT r.*,t.discord_user_id,t.amount_cents,t.provider_transaction_id,
    t.status AS topup_status,count(e.id)::integer AS evidence_count
    FROM manual_reviews r JOIN topups t ON r.subject_type='TOPUP' AND r.subject_id=t.id::text
    LEFT JOIN review_evidence e ON e.review_id=r.id WHERE r.state<>'RESOLVED'
    GROUP BY r.id,t.id ORDER BY r.created_at LIMIT 25`)).rows;
  const summary = reviews.length
    ? reviews.map((review) => `• <@${review.discord_user_id}> • ${money(review.amount_cents ?? 0)} • ${displayState(review.topup_status)}`).join('\n')
    : 'ไม่มีรายการเติมเงินที่รอ Owner ตรวจสอบ';
  const components = reviews.length ? [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(customId('payment_review_pick')).setPlaceholder('เลือกรายการเติมเงินที่ต้องตรวจ')
    .addOptions(reviews.map((review) => ({
      label: `${review.discord_user_id} • ${money(review.amount_cents ?? 0)}`.slice(0, 100), value: review.id,
      description: `${displayState(review.topup_status)} • หลักฐาน ${review.evidence_count} รายการ`.slice(0, 100),
    }))))] : [];
  return adminReply(interaction, 'payments', { embeds: [panelEmbed(0xf0b232, 'เติมเงินที่ต้องตรวจ',
    summary)], components });
}

async function renderPricingPanel(interaction, runtime) {
  const rows = (await runtime.pool.query(`SELECT DISTINCT ON (task_type) task_type,amount_cents,state_version
    FROM price_rules WHERE enabled=true AND rule_type='TYPE'
    ORDER BY task_type,created_at DESC`)).rows;
  const byType = new Map(rows.map((row) => [row.task_type, row]));
  const categoryLine = (category) => {
    const rule = QUEST_PRICE_CATEGORIES[category].map((taskType) => byType.get(taskType)).find(Boolean);
    const amount = rule?.amount_cents ?? 500;
    return `• **${category === 'GAME' ? 'Quest เล่นเกม' : 'Quest ดูวิดีโอ'}** — ${money(amount)}`;
  };
  return adminReply(interaction, 'pricing', { embeds: [panelEmbed(0x5865f2, 'ราคาทำ Quest',
    `${categoryLine('GAME')}\n${categoryLine('VIDEO')}\n\nเลือกระเภทแล้วใส่ราคาใหม่เพียงช่องเดียว`)],
  components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(customId('price_category_pick')).setPlaceholder('เลือกประเภท Quest ที่ต้องการเปลี่ยนราคา')
    .addOptions(
      { label: 'Quest เล่นเกม', value: 'GAME', description: 'ครอบคลุม Quest เล่นเกมทุกชนิดที่ระบบรองรับ' },
      { label: 'Quest ดูวิดีโอ', value: 'VIDEO', description: 'ครอบคลุม Quest ดูวิดีโอทุกชนิดที่ระบบรองรับ' },
    ))] });
}

async function renderPromotionsPanel(interaction, runtime) {
  const promotion = (await runtime.pool.query(`SELECT * FROM promotions WHERE manual_controlled=true
    ORDER BY version DESC LIMIT 1`)).rows[0] ?? null;
  const tiers = promotion ? (await runtime.pool.query(`SELECT * FROM promotion_tiers
    WHERE promotion_id=$1 ORDER BY minimum_amount_cents`, [promotion.id])).rows : [];
  const tierText = tiers.length
    ? tiers.map((tier) => `${money(tier.minimum_amount_cents)} = ${(Number(tier.basis_points) / 100).toFixed(2)}%`).join('\n')
    : 'ยังไม่ได้ตั้งโบนัสเติมเงิน';
  const status = promotion?.state === 'ACTIVE' ? 'เปิดใช้งาน' : 'ปิดอยู่';
  const userLimit = promotion?.max_uses_per_user ?? 'ไม่จำกัด';
  const dailyBonusLimit = promotion?.max_bonus_per_day_cents == null
    ? 'ไม่จำกัด'
    : money(promotion.max_bonus_per_day_cents);
  const description = promotion ? [
    `สถานะ: **${status}**`, tierText, '',
    `จำกัดต่อผู้ใช้ตลอดรุ่นนี้: **${userLimit} ครั้ง**`,
    `โบนัสสูงสุดต่อผู้ใช้ต่อวัน: **${dailyBonusLimit}**`,
  ].join('\n') : tierText;
  return adminReply(interaction, 'promotions', { embeds: [panelEmbed(0x5865f2, 'โบนัสเติมเงิน', description)],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('promo_set')).setLabel(promotion ? 'แก้โบนัสเติมเงิน' : 'ตั้งโบนัสเติมเงิน').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(customId('promo_toggle')).setLabel(promotion?.state === 'ACTIVE' ? 'ปิดโบนัส' : 'เปิดโบนัส')
      .setStyle(promotion?.state === 'ACTIVE' ? ButtonStyle.Danger : ButtonStyle.Success).setDisabled(!promotion),
  )] });
}

async function renderReceiversPanel(interaction, runtime) {
  ownerOnly(interaction, runtime, 'เบอร์รับเงินใช้ได้เฉพาะเจ้าของร้าน');
  const receivers = (await runtime.pool.query('SELECT * FROM receiver_versions ORDER BY version DESC LIMIT 10')).rows;
  return adminReply(interaction, 'receivers', { embeds: [panelEmbed(0x5865f2, 'เบอร์รับเงิน TrueMoney',
    listRows(receivers, (receiver) => `• รุ่น ${receiver.version} • ***-***-${receiver.phone_last4} • **${displayState(receiver.state)}**`, 'ยังไม่ได้ตั้งเบอร์รับเงิน'))],
  components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId('receiver_activate'))
    .setLabel('เพิ่มและเปิดใช้เบอร์ใหม่').setStyle(ButtonStyle.Danger))] });
}

async function renderMonitorsPanel(interaction, runtime) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  const [monitorsResult, testsResult] = await Promise.all([
    runtime.pool.query('SELECT * FROM monitor_accounts ORDER BY priority DESC,created_at'),
    runtime.pool.query(`SELECT count(*)::integer AS count FROM quest_test_runs
      WHERE state IN ('TEST_QUEUED','TESTING')`),
  ]);
  const monitors = monitorsResult.rows;
  const summary = {
    ready: monitors.filter((row) => row.health_state === 'READY' && row.state === 'ACTIVE').length,
    degraded: monitors.filter((row) => row.health_state === 'DEGRADED').length,
    unavailable: monitors.filter((row) => ['INVALID', 'QUARANTINED', 'DISABLED'].includes(row.health_state)
      || ['QUARANTINED', 'DISABLED'].includes(row.state)).length,
  };
  const status = (monitor) => {
    if (monitor.state === 'DISABLED') return '⚪ พักใช้งาน';
    if (monitor.state === 'QUARANTINED' || monitor.health_state === 'INVALID') return '🔴 ใช้ไม่ได้';
    if (monitor.health_state === 'READY') return '🟢 พร้อม';
    if (monitor.health_state === 'DEGRADED') return '🟡 ตรวจพบปัญหา';
    return '⚫ ยังไม่ตรวจ';
  };
  const recent = listRows(monitors.slice(0, 10), (monitor) => `• ${status(monitor)} **${escapedText(monitor.username)}** (\`${escapedText(monitor.account_id)}\`)`, 'ยังไม่มี Token สำหรับตรวจสอบ Quest');
  const description = [
    `ทั้งหมด **${monitors.length}** • พร้อม **${summary.ready}** • มีปัญหา **${summary.degraded}** • ใช้ไม่ได้/พัก **${summary.unavailable}**`,
    `กำลังทดสอบ Quest: **${testsResult.rows[0].count}** งาน`, '', recent,
    '', 'ทุกบัญชีใช้ทั้งตรวจหาและทดสอบ Quest • ระบบไม่แสดง Token ในหน้าแอดมิน',
  ].join('\n');
  return adminReply(interaction, 'monitors', { embeds: [panelEmbed(0x5865f2, 'บัญชีตรวจสอบ Quest',
    description)],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('monitor_add')).setLabel('เพิ่ม Token').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(customId('monitor_check_all')).setLabel('เช็คระบบ Token').setStyle(ButtonStyle.Secondary).setDisabled(!monitors.length),
    new ButtonBuilder().setCustomId(customId('monitor_list')).setLabel('ดูบัญชีทั้งหมด').setStyle(ButtonStyle.Secondary).setDisabled(!monitors.length),
  )] });
}

function monitorHealthLine(result) {
  const monitor = result.monitor;
  const state = monitorHealthLabel(monitor.state, result.healthState);
  const detail = result.healthState === 'READY'
    ? `อ่าน Quest ได้ ${result.questCount} รายการ`
    : `สาเหตุ: ${result.errorCode}`;
  return `${state} **${escapedText(monitor.username)}** (\`${escapedText(monitor.account_id)}\`) — ${escapedText(detail)}`;
}

async function renderMonitorList(interaction, runtime) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  const monitors = (await runtime.pool.query(`SELECT * FROM monitor_accounts
    ORDER BY priority DESC,created_at LIMIT 25`)).rows;
  const description = monitors.length
    ? 'เลือกบัญชีเพื่อดูสถานะ เช็ค Token เปลี่ยน Token หรือพักใช้งาน'
    : 'ยังไม่มี Token สำหรับตรวจสอบ Quest';
  const selectionSession = monitors.length ? await createAdminSession({ actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation: 'MONITOR_SELECT', payload: { monitorIds: monitors.map((monitor) => monitor.id) },
    configVersion: runtime.config.version }, contextFor(interaction, 'monitor_select_session'), { pool: runtime.pool }) : null;
  const components = monitors.length ? [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId('monitor_select', selectionSession.id)).setPlaceholder('เลือกบัญชีตรวจสอบ Quest')
      .addOptions(monitors.map((monitor) => ({
        label: String(monitor.username ?? monitor.account_id).slice(0, 100), value: monitor.id,
        description: `${monitor.account_id} • ${monitorHealthLabel(monitor.state, monitor.health_state)}`.slice(0, 100),
      }))),
  )] : [];
  return adminReply(interaction, 'monitors', { embeds: [panelEmbed(0x5865f2, 'รายการบัญชีตรวจสอบ Quest', description)], components });
}

async function renderMonitorDetail(interaction, runtime, monitorId) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  const monitor = (await runtime.pool.query('SELECT * FROM monitor_accounts WHERE id=$1', [monitorId])).rows[0];
  if (!monitor) throw new QuestshopError('MONITOR_NOT_FOUND', 'ไม่พบบัญชี Monitor');
  const health = monitorDetailHealthLabel(monitor.health_state);
  const checked = monitor.last_health_checked_at
    ? `<t:${Math.floor(new Date(monitor.last_health_checked_at).getTime() / 1000)}:R>` : 'ยังไม่เคยตรวจ';
  const lastHealthResult = monitor.last_health_error_code
    ? `พบปัญหา • รหัส \`${escapedText(monitor.last_health_error_code)}\``
    : 'ไม่พบปัญหา';
  const description = [
    `**บัญชี:** ${escapedText(monitor.username)}`, `**Account ID:** \`${escapedText(monitor.account_id)}\``,
    `**สถานะบัญชี:** ${displayState(monitor.state)}`, `**สถานะ Token:** ${health}`,
    `**ตรวจล่าสุด:** ${checked}`, `**Quest ตอนตรวจ:** ${monitor.last_health_quest_count ?? 'ไม่ระบุ'}`,
    `**ผลตรวจล่าสุด:** ${lastHealthResult}`,
    '', 'ปุ่มเช็คบัญชีนี้อ่านข้อมูลบัญชี/Quest เท่านั้น ไม่ทำ Quest จริง',
  ].join('\n');
  const intendedState = monitor.state === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
  const stateRoute = intendedState === 'ACTIVE' ? 'monitor_enable' : 'monitor_disable';
  const stateOperation = intendedState === 'ACTIVE' ? 'MONITOR_ENABLE' : 'MONITOR_DISABLE';
  const toggle = intendedState === 'ACTIVE' ? 'เปิดใช้งาน' : 'พักบัญชี';
  const session = (operation) => createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null, operation,
    payload: operation === stateOperation ? { monitorId: monitor.id, intendedState,
      expectedState: monitor.state, expectedStateVersion: monitor.state_version } : { monitorId: monitor.id },
    configVersion: runtime.config.version },
  contextFor(interaction, 'monitor_detail_session'), { pool: runtime.pool });
  const [check, rotate, state] = await Promise.all([
    session('MONITOR_CHECK_ONE'), session('MONITOR_ROTATE'), session(stateOperation),
  ]);
  return adminReply(interaction, 'monitors', { embeds: [panelEmbed(0x5865f2, 'รายละเอียดบัญชีตรวจสอบ Quest', description)],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('monitor_check_one', check.id)).setLabel('เช็คบัญชีนี้').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(customId('monitor_rotate', rotate.id)).setLabel('เปลี่ยน Token').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(customId(stateRoute, state.id)).setLabel(toggle).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(customId('monitor_list')).setLabel('กลับไปรายการ').setStyle(ButtonStyle.Secondary),
  )] });
}

async function renderOrdersPanel(interaction, runtime, offset = 0) {
  const pageSize = 25;
  const items = (await runtime.pool.query(`SELECT i.*,o.account_username FROM order_items i
    JOIN orders o ON o.id=i.order_id WHERE i.state NOT IN ('READY_TO_CLAIM','EXPIRED_RELEASED',
    'EXTERNAL_COMPLETED_RELEASED','STOPPED_RELEASED','FAILED_RELEASED')
    ORDER BY i.updated_at DESC LIMIT $1 OFFSET $2`, [pageSize, offset])).rows;
  const total = Number((await runtime.pool.query(`SELECT count(*)::integer AS count FROM order_items
    WHERE state NOT IN ('READY_TO_CLAIM','EXPIRED_RELEASED','EXTERNAL_COMPLETED_RELEASED',
    'STOPPED_RELEASED','FAILED_RELEASED')`)).rows[0].count);
  const configured = runtime.config.values?.runnerConcurrency ?? runtime.env.RUNNER_CONCURRENCY;
  const actionRows = [];
  if (items.length) {
    const picker = new StringSelectMenuBuilder()
      .setCustomId(customId('adminorder_pick')).setPlaceholder('เลือกงานลูกค้าเพื่อดูรายละเอียด');
    picker.addOptions(items.map((item) => ({
      label: `${item.quest_name} • ${orderStateLabel(item.state)}`.slice(0, 100), value: item.id,
      description: `${item.account_username ?? item.account_id ?? 'บัญชี Quest'} • ${item.progress_bucket}%`.slice(0, 100),
    })));
    actionRows.push(new ActionRowBuilder().addComponents(picker));
  }
  actionRows.push(new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(customId('config_concurrency')).setLabel(`จำนวนงานพร้อมกัน: ${configured}`)
    .setStyle(ButtonStyle.Secondary)));
  if (total > pageSize) {
    const previous = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
      channelId: interaction.channelId, messageId: interaction.message?.id ?? null, operation: 'ORDER_PAGE',
      payload: { offset: Math.max(0, offset - pageSize) }, configVersion: runtime.config.version },
    contextFor(interaction, 'order_page_previous'), { pool: runtime.pool });
    const next = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
      channelId: interaction.channelId, messageId: interaction.message?.id ?? null, operation: 'ORDER_PAGE',
      payload: { offset: offset + pageSize }, configVersion: runtime.config.version },
    contextFor(interaction, 'order_page_next'), { pool: runtime.pool });
    actionRows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('orders_page', previous.id)).setLabel('ก่อนหน้า').setStyle(ButtonStyle.Secondary)
        .setDisabled(offset === 0),
      new ButtonBuilder().setCustomId(customId('orders_page', next.id)).setLabel('ถัดไป').setStyle(ButtonStyle.Secondary)
        .setDisabled(offset + pageSize >= total),
    ));
  }
  const itemSummary = listRows(items,
    (item) => `• **${escapedText(item.quest_name)}** • ${orderStateLabel(item.state)} • ${item.progress_bucket}%`,
    'ไม่มีงาน Quest ที่กำลังดำเนินการ');
  const pageSummary = `หน้า ${Math.floor(offset / pageSize) + 1} • ทั้งหมด ${total} งาน`;
  return adminReply(interaction, 'orders', { embeds: [panelEmbed(0x5865f2, 'งานลูกค้าและคิว',
    [itemSummary, pageSummary].join('\n\n'))],
  components: actionRows });
}

async function renderDlqPanel(interaction, runtime) {
  const dlq = (await runtime.pool.query(`SELECT * FROM dead_letter_items
    WHERE state IN ('DEAD_LETTER','PENDING') ORDER BY created_at DESC LIMIT 10`)).rows;
  const activeIncidents = (await runtime.pool.query(`SELECT * FROM incidents WHERE state<>'RESOLVED'
    ORDER BY severity DESC,opened_at DESC LIMIT 10`)).rows;
  const breaker = (await runtime.pool.query("SELECT * FROM circuit_breakers WHERE breaker_key='TRUEMONEY_DIRECT'")).rows[0];
  const controls = [];
  if (dlq.length) {
    const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
      channelId: interaction.channelId, messageId: interaction.message?.id ?? null, operation: 'DLQ_SELECT',
      payload: { dlqIds: dlq.map((item) => item.id) }, configVersion: runtime.config.version },
    contextFor(interaction, 'dlq_select_session'), { pool: runtime.pool });
    controls.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(customId('dlq_pick', session.id)).setPlaceholder('เลือกรายการปัญหาเพื่อดูและจัดการ')
      .addOptions(dlq.map((item) => ({
        label: `${dlqCategoryLabel(item.category)} • ${dlqSourceLabel(item.source_type)}`.slice(0, 100), value: item.id,
        description: `${displayState(item.state)} • ${String(item.id).slice(0, 8)}`.slice(0, 100),
      })))));
  }
  if (breaker?.state === 'OPEN' && interaction.user.id === runtime.env.OWNER_ID) {
    controls.push(new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(customId('breaker_prepare')).setLabel('ตรวจสอบและเปิดระบบรับซองอีกครั้ง').setStyle(ButtonStyle.Danger)));
  }
  const breakerSummary = breaker?.state === 'OPEN'
    ? `**ระบบรับซอง:** ${breakerStateLabel(breaker.state)}`
    : null;
  const description = [dlqSummary(dlq, activeIncidents), breakerSummary].filter(Boolean).join('\n\n');
  return adminReply(interaction, 'dlq', { embeds: [panelEmbed(0xf23f43, 'ปัญหาที่ต้องจัดการ', description)], components: controls });
}

async function renderOverviewPanel(interaction, runtime) {
  const [wallets, queue, reviews, incidents, surfaces] = await Promise.all([
    runtime.pool.query('SELECT count(*)::integer AS users,COALESCE(sum(available_cents),0)::bigint AS available,COALESCE(sum(reserved_cents),0)::bigint AS reserved FROM wallets'),
    runtime.pool.query("SELECT count(*)::integer AS count FROM runner_jobs WHERE state NOT IN ('COMPLETED','FAILED')"),
    runtime.pool.query("SELECT count(*)::integer AS count FROM manual_reviews WHERE state<>'RESOLVED'"),
    runtime.pool.query("SELECT count(*)::integer AS count FROM incidents WHERE state<>'RESOLVED'"),
    runtime.pool.query("SELECT count(*)::integer AS count FROM surfaces WHERE state='ACTIVE'"),
  ]);
  const row = wallets.rows[0];
  const metrics = overviewRuntimeMetrics(interaction, runtime);
  const description = overviewDescription({ incidents, metrics, queue, reviews, surfaces, row, runtime });
  const controls = [new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(customId('config_quest_role')).setLabel('ตั้งยศแจ้ง Quest').setStyle(ButtonStyle.Secondary)
    .setDisabled(interaction.user.id !== runtime.env.OWNER_ID))];
  return adminReply(interaction, 'overview', { embeds: [panelEmbed(0x5865f2, 'ภาพรวมร้าน', description)], components: controls });
}

const ADMIN_PANEL_RENDERERS = Object.freeze({
  wallet: renderWalletPanel, payments: renderPaymentsPanel, pricing: renderPricingPanel,
  promotions: renderPromotionsPanel, receivers: renderReceiversPanel, monitors: renderMonitorsPanel,
  orders: renderOrdersPanel, dlq: renderDlqPanel,
});

async function handleSurfaceCommand(interaction, runtime) {
  if (!interaction.isChatInputCommand()) return false;
  const surface = SURFACE_COMMANDS[interaction.commandName];
  if (!surface) return false;
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'คำสั่งนี้ใช้ได้เฉพาะ Owner');
  await interaction.deferReply({ ephemeral: true });
  const message = await setupSurface({ interaction, surfaceKey: surface, config: runtime.config }, contextFor(interaction, 'setup'), { pool: runtime.pool });
  await interaction.editReply(`ติดตั้ง ${surface} ที่ <#${message.channelId}> เรียบร้อย`);
  return true;
}

async function assertSurfaceBinding(interaction, route, runtime) {
  if (!['start', 'topup', 'admin'].includes(route.route)) return;
  const surfaceKey = route.route === 'admin' ? 'ADMIN_PANEL' : 'QUEST_AUTO';
  const surface = (await runtime.pool.query("SELECT * FROM surfaces WHERE surface_key=$1 AND state='ACTIVE'", [surfaceKey])).rows[0];
  if (!surface || surface.guild_id !== interaction.guildId || surface.channel_id !== interaction.channelId
    || surface.message_id !== interaction.message?.id) {
    throw new QuestshopError('SURFACE_BINDING_INVALID', 'ปุ่มนี้ไม่ใช่แผงที่ใช้งานอยู่');
  }
}

async function assertTestFailureAlertBinding(interaction, alertId, runtime) {
  const alert = await withTransaction({ pool: runtime.pool, isolation: 'READ COMMITTED', maxAttempts: 1 },
    (client) => loadTestFailureAlert(client, alertId, { messageId: interaction.message?.id }));
  if (alert?.surface_key !== 'LOG_QUEST_OPERATIONS') {
    throw new QuestshopError('TEST_ALERT_BINDING_INVALID', 'ปุ่มนี้ไม่ใช่ข้อความแจ้งเตือน Quest ที่ใช้งานอยู่');
  }
  const surface = (await runtime.pool.query(`SELECT * FROM surfaces
    WHERE surface_key='LOG_QUEST_OPERATIONS' AND state='ACTIVE'`)).rows[0];
  if (!surface || surface.guild_id !== interaction.guildId || surface.channel_id !== interaction.channelId) {
    throw new QuestshopError('TEST_ALERT_SURFACE_INVALID', 'ห้อง Log นี้ไม่ใช่ Surface ที่ใช้งานอยู่');
  }
  return alert;
}

async function assertCustomerQuestDiscoveryBinding(interaction, discoveryId, runtime) {
  const discovery = await withTransaction({ pool: runtime.pool, isolation: 'READ COMMITTED', maxAttempts: 1 },
    (client) => loadCustomerQuestDiscovery(client, discoveryId, { messageId: interaction.message?.id }));
  if (discovery?.surface_key !== 'LOG_QUEST_OPERATIONS') {
    throw new QuestshopError('CUSTOMER_DISCOVERY_NOT_FOUND', 'ข้อความแจ้ง Quest จากลูกค้านี้หมดอายุแล้ว');
  }
  const surface = (await runtime.pool.query(`SELECT * FROM surfaces
    WHERE surface_key='LOG_QUEST_OPERATIONS' AND state='ACTIVE'`)).rows[0];
  if (!surface || surface.guild_id !== interaction.guildId || surface.channel_id !== interaction.channelId) {
    throw new QuestshopError('SURFACE_BINDING_INVALID', 'ห้อง Log นี้ไม่ใช่ Surface ที่ใช้งานอยู่');
  }
  return discovery;
}

async function assertCustomerQuestCaseBinding(interaction, caseId, runtime) {
  const found = await withTransaction({ pool: runtime.pool, isolation: 'READ COMMITTED', maxAttempts: 1 },
    (client) => loadCustomerDiscoveryCase(client, caseId, { messageId: interaction.message?.id }));
  if (found?.surface_key !== 'LOG_QUEST_OPERATIONS') {
    throw new QuestshopError('CUSTOMER_DISCOVERY_CASE_NOT_FOUND', 'ข้อความตรวจ Quest นี้หมดอายุแล้ว');
  }
  const surface = (await runtime.pool.query(`SELECT * FROM surfaces
    WHERE surface_key='LOG_QUEST_OPERATIONS' AND state='ACTIVE'`)).rows[0];
  if (!surface || surface.guild_id !== interaction.guildId || surface.channel_id !== interaction.channelId) {
    throw new QuestshopError('SURFACE_BINDING_INVALID', 'ห้อง Log นี้ไม่ใช่ Surface ที่ใช้งานอยู่');
  }
  return found;
}

async function handleCustomerQuestPublish({ interaction, route, runtime, gates: _gates }) {
  if (route.route !== 'customer_quest_publish' || !interaction.isButton()) return;
  const discovery = await assertCustomerQuestDiscoveryBinding(interaction, route.sessionId, runtime);
  const caseRow = (await runtime.pool.query(`SELECT id FROM customer_quest_discovery_cases WHERE quest_id=$1`, [discovery.quest_id])).rows[0];
  if (!caseRow) return interaction.editReply('รายการเก่านี้ยังไม่มี Case ใหม่ กรุณารอการตรวจครั้งถัดไป');
  const result = await queueCustomerDiscoveryAnnouncement({ caseId: caseRow.id },
    contextFor(interaction, 'customer_discovery_publish'), { pool: runtime.pool });
  return interaction.editReply(result.reused
    ? 'Quest นี้ถูกสั่งประกาศแล้ว'
    : 'รับคำสั่งแล้ว Quest จะถูกประกาศในห้อง Quest ใหม่');
}

async function handleCustomerQuestTest({ interaction, route, runtime, gates: _gates }) {
  if (route.route !== 'customer_quest_test' || !interaction.isButton()) return;
  const discovery = await assertCustomerQuestDiscoveryBinding(interaction, route.sessionId, runtime);
  const caseRow = (await runtime.pool.query(`SELECT id FROM customer_quest_discovery_cases WHERE quest_id=$1`, [discovery.quest_id])).rows[0];
  if (!caseRow) return interaction.editReply('รายการเก่านี้ยังไม่มี Case ใหม่ กรุณารอการตรวจครั้งถัดไป');
  const result = await retryCustomerDiscoveryCase({ caseId: caseRow.id },
    contextFor(interaction, 'customer_discovery_test'), { pool: runtime.pool });
  return interaction.editReply(result.idempotent
    ? 'ระบบกำลังตรวจ Quest นี้อยู่แล้ว'
    : 'รับคำสั่งแล้ว ระบบจะค้นในบัญชีทดสอบทั้งหมดก่อนเริ่มทดสอบ');
}

async function handleCustomerQuestCaseRetry({ interaction, route, runtime, gates: _gates }) {
  if (route.route !== 'customer_quest_case_retry' || !interaction.isButton()) return;
  await interaction.deferReply({ ephemeral: true });
  await assertCustomerQuestCaseBinding(interaction, route.sessionId, runtime);
  const result = await retryCustomerDiscoveryCase({ caseId: route.sessionId },
    contextFor(interaction, 'customer_discovery_case_retry'), { pool: runtime.pool });
  return interaction.editReply(result.reused
    ? 'ระบบกำลังตรวจ Quest นี้อยู่แล้ว'
    : 'รับคำสั่งแล้ว ระบบจะค้นในบัญชีทดสอบทั้งหมดและทดสอบเมื่อพบ Quest');
}

async function handleCustomerQuestCaseAnnounce({ interaction, route, runtime, gates: _gates }) {
  if (route.route !== 'customer_quest_case_announce' || !interaction.isButton()) return;
  await interaction.deferReply({ ephemeral: true });
  await assertCustomerQuestCaseBinding(interaction, route.sessionId, runtime);
  const result = await queueCustomerDiscoveryAnnouncement({ caseId: route.sessionId },
    contextFor(interaction, 'customer_discovery_case_announce'), { pool: runtime.pool });
  return interaction.editReply(result.idempotent ? 'Quest นี้อยู่ระหว่างประกาศหรือประกาศแล้ว'
    : 'รับคำสั่งแล้ว จะส่งประกาศจากข้อมูลที่ลูกค้าพบโดยระบุว่ายังไม่ยืนยันด้วย Monitor');
}

async function handleTestFailureSend({ interaction, route, runtime, gates: _gates }) {
  if (route.route !== 'test_fail_send' || !interaction.isButton()) return;
  await interaction.deferReply({ ephemeral: true });
  await assertTestFailureAlertBinding(interaction, route.sessionId, runtime);
  const result = await forcePublishFailedMonitorTest({ alertId: route.sessionId,
    reason: 'Admin selected ส่งเลย from Monitor test failure log' },
  contextFor(interaction, 'test_failure_force_publish'), { pool: runtime.pool });
  return interaction.editReply(result.idempotent
    ? 'Quest นี้ถูกสั่งส่งประกาศไปแล้ว'
    : `เปิดขายและส่งประกาศ Quest แล้ว (Admin override) • Support: \`${result.quest.trace_id?.slice(0, 8) ?? 'see-log'}\``);
}

async function handleTestFailureRetry({ interaction, route, runtime, gates: _gates }) {
  if (route.route !== 'test_fail_retry' || !interaction.isButton()) return;
  await interaction.deferReply({ ephemeral: true });
  await assertTestFailureAlertBinding(interaction, route.sessionId, runtime);
  const result = await withTransaction({ pool: runtime.pool, isolation: 'SERIALIZABLE' },
    (client) => retryFailedTestAlert(client, { alertId: route.sessionId,
      context: contextFor(interaction, 'test_failure_retry') }));
  return interaction.editReply(result.idempotent
    ? 'รายการนี้ไม่ได้อยู่ในสถานะที่เริ่มทดสอบใหม่ได้'
    : 'รับคำสั่งแล้ว ระบบจะทดสอบใหม่สูงสุด 3 ครั้งต่อ Monitor และหยุดทันทีเมื่อผ่าน');
}

function assertPrelaunchRouteAccess(interaction, contract, runtime) {
  const customerRoute = contract.access === CUSTOMER;
  // Pre-launch intentionally uses the production guild, database and real
  // financial adapters.  It must therefore be an Owner/Admin-only test round:
  // opening a gate for UAT must not accidentally make the store public.
  if (runtime.env.PRELAUNCH && customerRoute && !isBackoffice(interaction, runtime)) {
    throw new QuestshopError('PRELAUNCH_RESTRICTED', 'ช่วงทดสอบ Pre-launch ใช้ได้เฉพาะ Owner/Admin');
  }
}

async function consumeCustomerButtonRateLimit(interaction, route, runtime) {
  if (interaction.isButton() && ['start', 'topup'].includes(route.route)) {
    await consumeRateLimit({ discordUserId: interaction.user.id, operation: 'BUTTON' },
      contextFor(interaction, 'button_rate'), { pool: runtime.pool });
  }
}

function assertRouteRole(interaction, contract, runtime) {
  if (contract.access === OWNER && interaction.user.id !== runtime.env.OWNER_ID) {
    throw new QuestshopError('OWNER_ONLY', 'เมนูนี้ใช้ได้เฉพาะ Owner');
  }
  if (contract.access === ADMIN && !isBackoffice(interaction, runtime)) {
    throw new QuestshopError('ADMIN_ONLY', 'เมนูนี้ใช้ได้เฉพาะ Owner/Admin');
  }
}

function assertCustomerRouteGates(contract, gates) {
  if (!gates.STORE_OPEN || !gates.CUSTOMER_INTERACTIONS_ENABLED) {
    throw new QuestshopError('STORE_CLOSED', 'ร้านปิดรับรายการชั่วคราว');
  }
  if (contract.gates.includes('TOPUP_ACCEPTING') && !gates.TOPUP_ACCEPTING) {
    throw new QuestshopError('TOPUP_CLOSED', 'ระบบเติมเงินปิดชั่วคราว');
  }
  if (contract.gates.includes('ORDER_ACCEPTING') && !gates.ORDER_ACCEPTING) {
    throw new QuestshopError('ORDER_CLOSED', 'ระบบรับ Quest ปิดชั่วคราว');
  }
}

export function preAuthorizeRoute(interaction, route, runtime) {
  const contract = routeContract(route.route);
  if (!contract) return null;
  assertPrelaunchRouteAccess(interaction, contract, runtime);
  const gates = runtime.config?.gates ?? DEFAULT_FEATURE_GATES;
  assertRouteRole(interaction, contract, runtime);
  if (contract.access === CUSTOMER) assertCustomerRouteGates(contract, gates);
  return gates;
}

export async function authorizeRoute(interaction, route, runtime) {
  const gates = preAuthorizeRoute(interaction, route, runtime);
  await assertSurfaceBinding(interaction, route, runtime);
  await consumeCustomerButtonRateLimit(interaction, route, runtime);
  return gates;
}

async function handleStart({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'start' && interaction.isButton()) {
  if (!_gates.ORDER_ACCEPTING) throw new QuestshopError('ORDER_CLOSED', 'ระบบรับ Quest ปิดชั่วคราว');
  const minimum = await withTransaction({ pool: runtime.pool, isolation: 'READ COMMITTED', maxAttempts: 1 },
    async (client) => (await minimumSellablePrice(client)) ?? minimumConfiguredPrice(client));
  if (minimum == null) throw new QuestshopError('NO_SELLABLE_QUEST', 'ขณะนี้ยังไม่มี Quest ที่เปิดขาย');
  const wallet = (await runtime.pool.query('SELECT available_cents FROM wallets WHERE discord_user_id = $1', [interaction.user.id])).rows[0];
  if (BigInt(wallet?.available_cents ?? 0) < BigInt(minimum)) throw new QuestshopError('WALLET_INSUFFICIENT', `ต้องมีเครดิตขั้นต่ำ ${money(minimum)}`);
  const entry = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: null, operation: 'TOKEN_ENTRY',
    payload: {}, configVersion: runtime.config.version, ttlMinutes: 15 },
  contextFor(interaction, 'token_entry'), { pool: runtime.pool });
  const reply = await interaction.editReply({ content: 'เครดิตพร้อมแล้ว กรุณากรอก Token ของบัญชีที่ต้องการทำ Quest',
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(customId('token_open', entry.id)).setLabel('กรอก Token').setStyle(ButtonStyle.Primary))] });
  await bindSessionMessage({ sessionId: entry.id, actorId: interaction.user.id, guildId: interaction.guildId,
    messageId: reply.id, expectedVersion: entry.state_version },
  contextFor(interaction, 'token_entry_message'), { pool: runtime.pool });
  return reply;
}
}

async function handleTokenOpen({ interaction, route, runtime, gates: _gates }) {
  if (route.route !== 'token_open' || !interaction.isButton()) return;
  return showPreparedModal({ interaction, runtime, route, sessionId: route.sessionId,
    modal: tokenModal,
    prepare: () => loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
      guildId: interaction.guildId, channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
      operation: 'TOKEN_ENTRY' },
    contextFor(interaction, 'token_entry_open'), { pool: runtime.pool }) });
}

async function handleTopup({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'topup' && interaction.isButton()) {
  if (!_gates.TOPUP_ACCEPTING) throw new QuestshopError('TOPUP_CLOSED', 'ระบบเติมเงินปิดชั่วคราว');
  await interaction.deferReply({ ephemeral: true });
  const entry = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'TOPUP_ENTRY',
    payload: {}, configVersion: runtime.config.version, ttlMinutes: 15 },
  contextFor(interaction, 'topup_entry'), { pool: runtime.pool });
  const wallet = (await runtime.pool.query('SELECT available_cents FROM wallets WHERE discord_user_id=$1',
    [interaction.user.id])).rows[0];
  await interaction.editReply(renderPaymentMethod(wallet?.available_cents ?? 0, entry.id));
  const reply = await interaction.fetchReply();
  await bindSessionMessage({ sessionId: entry.id, actorId: interaction.user.id,
    guildId: interaction.guildId, messageId: reply.id, expectedVersion: entry.state_version },
  contextFor(interaction, 'topup_entry_message'), { pool: runtime.pool });
  return reply;
}
}

async function handlePaymentMethod({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'payment_method' && interaction.isStringSelectMenu()) {
  return showPreparedModal({ interaction, runtime, route, sessionId: route.sessionId,
    modal: voucherModal,
    prepare: async () => {
      await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
        guildId: interaction.guildId, channelId: interaction.channelId, operation: 'TOPUP_ENTRY' }, contextFor(interaction, 'topup_entry_load'), { pool: runtime.pool });
      return assertRateLimitAvailable({ discordUserId: interaction.user.id, operation: 'VOUCHER_INVALID' },
        contextFor(interaction, 'voucher_invalid_check'), { pool: runtime.pool });
    } });
}
}

async function handleVoucherSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'voucher_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'TOPUP_ENTRY' }, contextFor(interaction, 'topup_entry_load'), { pool: runtime.pool });
  await assertRateLimitAvailable({ discordUserId: interaction.user.id, operation: 'VOUCHER_INVALID' },
    contextFor(interaction, 'voucher_invalid_submit_check'), { pool: runtime.pool });
  let result;
  try {
    result = await submitVoucher({ discordUserId: interaction.user.id,
      voucherUrl: interaction.fields.getTextInputValue('url'), env: runtime.env }, contextFor(interaction, 'topup'),
    { pool: runtime.pool });
  } catch (error) {
    if (['INVALID_VOUCHER_URL','INVALID_VOUCHER_CODE'].includes(error.code)) {
      await consumeRateLimit({ discordUserId: interaction.user.id, operation: 'VOUCHER_INVALID' },
        contextFor(interaction, 'voucher_invalid'), { pool: runtime.pool });
    }
    throw error;
  }
  await completeInteractionSession(session, interaction, runtime);
  await interaction.editReply(renderTopupProcessing(result.topup.id));
  const topup = await waitForCustomerTopup({ topupId: result.topup.id,
    discordUserId: interaction.user.id, signal: runtime.abortController?.signal }, { pool: runtime.pool });
  return interaction.editReply(renderTopupResult(topup));
}
}

async function handleTokenSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'token_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const entry = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'TOKEN_ENTRY' }, contextFor(interaction, 'token_entry_load'), { pool: runtime.pool });
  await consumeRateLimit({ discordUserId: interaction.user.id, operation: 'TOKEN_VALIDATE' },
    contextFor(interaction, 'token_rate'), { pool: runtime.pool });
  const created = await createSession({ discordUserId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    token: interaction.fields.getTextInputValue('token'), env: runtime.env,
    runnerConcurrency: runnerConcurrency(runtime) }, contextFor(interaction, 'checkout'), { pool: runtime.pool });
  await completeInteractionSession(entry, interaction, runtime);
  const page = await getSelectionPage({ sessionId: created.session.id, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId }, contextFor(interaction, 'checkout_page'), { pool: runtime.pool });
  const reply = await interaction.editReply(renderSelection(page));
  await bindSessionMessage({ sessionId: created.session.id, actorId: interaction.user.id,
    guildId: interaction.guildId, messageId: reply.id, expectedVersion: created.session.state_version },
  contextFor(interaction, 'checkout_message'), { pool: runtime.pool });
  return reply;
}
}

async function handleQuestPaging({ interaction, route, runtime, gates: _gates }) {
if (['quest_prev', 'quest_next'].includes(route.route)) {
  await interaction.deferUpdate();
  const page = await getSelectionPage({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null,
    direction: route.route === 'quest_next' ? 1 : -1 }, contextFor(interaction, 'checkout_page'), { pool: runtime.pool });
  return interaction.editReply(renderSelection(page));
}
}

async function handleQuestSelect({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'quest_select' && interaction.isStringSelectMenu()) {
  await interaction.deferUpdate();
  const page = await getSelectionPage({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null }, contextFor(interaction, 'checkout_page'), { pool: runtime.pool });
  const pageIds = page.rows.map((row) => row.line_id);
  await updateSelection({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null, lineIds: pageIds,
    selected: false }, contextFor(interaction, 'selection'), { pool: runtime.pool });
  await updateSelection({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null, lineIds: interaction.values,
    selected: true }, contextFor(interaction, 'selection'), { pool: runtime.pool });
  const refreshed = await getSelectionPage({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null }, contextFor(interaction, 'checkout_page'), { pool: runtime.pool });
  return interaction.editReply(renderSelection(refreshed));
}
}

async function handleQuestAll({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'quest_all') {
  await interaction.deferUpdate();
  await selectAll({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null }, contextFor(interaction, 'selection_all'), { pool: runtime.pool });
  const page = await getSelectionPage({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null }, contextFor(interaction, 'checkout_page'), { pool: runtime.pool });
  return interaction.editReply(renderSelection(page));
}
}

async function handleQuestQuote({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'quest_quote') {
  await interaction.deferUpdate();
  const quote = await buildQuote({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null,
    runnerConcurrency: runnerConcurrency(runtime) },
  contextFor(interaction, 'quote'), { pool: runtime.pool });
  return interaction.editReply(renderQuote(quote));
}
}

async function handleQuestBack({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'quest_back') {
  await interaction.deferUpdate();
  const page = await getSelectionPage({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null }, contextFor(interaction, 'checkout_page'), { pool: runtime.pool });
  return interaction.editReply(renderSelection(page));
}
}

async function handleQuestConfirm({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'quest_confirm') {
  await interaction.deferUpdate();
  await consumeRateLimit({ discordUserId: interaction.user.id, operation: 'ORDER_CONFIRM' },
    contextFor(interaction, 'confirm_rate'), { pool: runtime.pool });
  const order = await confirmOrder({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null,
    env: runtime.env, runnerConcurrency: runnerConcurrency(runtime) }, contextFor(interaction, 'confirm'), { pool: runtime.pool });
  const history = (await runtime.pool.query("SELECT * FROM surfaces WHERE surface_key='QUEST_HISTORY' AND state='ACTIVE'")).rows[0];
  const historyLink = history ? `https://discord.com/channels/${interaction.guildId}/${history.channel_id}` : null;
  return interaction.editReply(renderOrderConfirmation(order, historyLink));
}
}

async function handleAdminPanel({ interaction, route, runtime, gates: _gates }) {
  const refresh = route.route.startsWith('admin_refresh_');
  if (!['admin', 'admin_nav'].includes(route.route) && !refresh) return;
  if (!isBackoffice(interaction, runtime)) throw new QuestshopError('ADMIN_ONLY', 'เมนูนี้ใช้ได้เฉพาะ Owner/Admin');
  if (route.route === 'admin') await interaction.deferReply({ ephemeral: true });
  else await interaction.deferUpdate();
  const selected = refresh ? route.route.slice('admin_refresh_'.length) : interaction.values?.[0] ?? 'overview';
  const renderer = selected === 'overview' ? renderOverviewPanel : ADMIN_PANEL_RENDERERS[selected];
  if (!renderer) throw new QuestshopError('ADMIN_CATEGORY_INVALID', 'ไม่พบหมวดการตั้งค่านี้');
  return renderer(interaction, runtime);
}

async function handleWalletAdjust({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'wallet_adjust' && interaction.isButton()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'ADMIN_WALLET_USER',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'wallet_prepare'), { pool: runtime.pool });
  await interaction.editReply({ content: 'เลือกสมาชิกในเซิร์ฟเวอร์ หรือค้นหาด้วย Discord ID สำหรับผู้ที่ออกจากเซิร์ฟเวอร์แล้ว',
    components: [
      new ActionRowBuilder().addComponents(new UserSelectMenuBuilder()
        .setCustomId(customId('wallet_user_pick', session.id)).setPlaceholder('เลือกสมาชิก').setMinValues(1).setMaxValues(1)),
      new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(customId('wallet_user_search')).setLabel('ค้นหาด้วย Discord ID').setStyle(ButtonStyle.Secondary)),
    ] });
}
}

async function handleWalletUserSearch({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'wallet_user_search' && interaction.isButton()) {
  return showPreparedModal({ interaction, runtime, route,
    modal: (sessionId) => fieldsModal('wallet_user_search_submit', sessionId, 'ค้นหาผู้ใช้ด้วย Discord ID', [
      { id: 'discord_user_id', label: 'Discord User ID', max: 20 },
    ]),
    prepare: (sessionId) => createAdminSession({ id: sessionId, actorId: interaction.user.id, guildId: interaction.guildId,
      channelId: interaction.channelId, messageId: interaction.message?.id ?? null, operation: 'ADMIN_WALLET_SEARCH',
      payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'wallet_search_session'), { pool: runtime.pool }) });
}
}

async function handleWalletUserSearchSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'wallet_user_search_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const search = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_WALLET_SEARCH' },
  contextFor(interaction, 'wallet_search_load'), { pool: runtime.pool });
  const discordUserId = interaction.fields.getTextInputValue('discord_user_id').trim();
  if (!/^\d{17,20}$/.test(discordUserId)) throw new TypeError('Discord User ID ไม่ถูกต้อง');
  const prepare = await advanceInteractionSession(search, interaction, runtime, {
    messageId: interaction.message?.id ?? null, operation: 'ADMIN_WALLET_PREPARE',
    payload: { discordUserId }, configVersion: runtime.config.version,
  }, 'wallet_search_selected');
  return interaction.editReply({ content: `กรอก Discord ID \`${discordUserId}\` แล้ว กดปุ่มเพื่อกรอกยอดปรับเครดิต`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(customId('wallet_adjust_from_search', prepare.id)).setLabel('ปรับเครดิตผู้ใช้นี้').setStyle(ButtonStyle.Primary))] });
}
}

async function handleWalletAdjustFromSearch({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'wallet_adjust_from_search' && interaction.isButton()) {
  return showPreparedModal({ interaction, runtime, route, sessionId: route.sessionId,
    modal: (sessionId) => fieldsModal('wallet_adjust_submit', sessionId, 'ปรับเครดิตลูกค้า', [
      { id: 'amount', label: 'จำนวนบาท (+ เพิ่ม / - ลด)', placeholder: '100.00 หรือ -50.00', max: 24 },
      { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
    ]),
    prepare: () => loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
      guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_WALLET_PREPARE' },
    contextFor(interaction, 'wallet_search_prepare_load'), { pool: runtime.pool }) });
}
}

async function handleWalletUserPick({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'wallet_user_pick' && interaction.isUserSelectMenu()) {
  return showPreparedModal({ interaction, runtime, route,
    modal: (sessionId) => fieldsModal('wallet_adjust_submit', sessionId, 'ปรับเครดิตลูกค้า', [
      { id: 'amount', label: 'จำนวนบาท (+ เพิ่ม / - ลด)', placeholder: '100.00 หรือ -50.00', max: 24 },
      { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
    ]),
    prepare: async (sessionId) => {
      const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
        guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_WALLET_USER' },
      contextFor(interaction, 'wallet_user_load'), { pool: runtime.pool });
      return advanceInteractionSession(session, interaction, runtime, {
        id: sessionId, messageId: interaction.message?.id ?? null, operation: 'ADMIN_WALLET_PREPARE',
        payload: { discordUserId: interaction.values[0] }, configVersion: runtime.config.version,
      }, 'wallet_prepare_selected');
    } });
}
}

async function handleWalletAdjustSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'wallet_adjust_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_WALLET_PREPARE' },
  contextFor(interaction, 'wallet_prepare_load'), { pool: runtime.pool });
  const discordUserId = session.payload.discordUserId;
  const amountCents = parseSignedBaht(interaction.fields.getTextInputValue('amount'));
  if (amountCents === 0n) throw new TypeError('จำนวนเงินต้องไม่เป็นศูนย์');
  const reason = interaction.fields.getTextInputValue('reason').trim();
  const before = (await runtime.pool.query(`SELECT available_cents,reserved_cents,state_version
    FROM wallets WHERE discord_user_id=$1`, [discordUserId])).rows[0]
    ?? { available_cents: '0', reserved_cents: '0', state_version: '0' };
  const after = BigInt(before.available_cents) + amountCents;
  if (after < 0n) throw new QuestshopError('INSUFFICIENT_BALANCE', 'ยอดหลังปรับห้ามติดลบ');
  const confirm = await advanceInteractionSession(session, interaction, runtime, {
    messageId: interaction.message?.id ?? null, operation: 'ADMIN_WALLET_CONFIRM',
    payload: { discordUserId, amountCents: String(amountCents), expectedVersion: String(before.state_version), reason },
    configVersion: runtime.config.version,
  }, 'wallet_confirm_session');
  return interaction.editReply({ content: `ยืนยันปรับเครดิตของ \`${discordUserId}\`\nเครดิตพร้อมใช้: **${money(before.available_cents)} → ${money(after)}**\nเครดิตที่กำลังจอง: **${money(before.reserved_cents)}**\nเหตุผล: ${reason}`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(customId('wallet_adjust_confirm', confirm.id)).setLabel('ยืนยันการแก้ยอด')
      .setStyle(ButtonStyle.Danger))] });
}
}

async function handleWalletAdjustConfirm({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'wallet_adjust_confirm' && interaction.isButton()) {
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_WALLET_CONFIRM' },
  contextFor(interaction, 'wallet_confirm_load'), { pool: runtime.pool });
  const current = (await runtime.pool.query('SELECT state_version FROM wallets WHERE discord_user_id=$1',
    [session.payload.discordUserId])).rows[0];
  if (String(current?.state_version ?? '0') !== session.payload.expectedVersion) {
    throw new QuestshopError('STALE_STATE', 'ยอดเครดิตเปลี่ยนหลังเปิดหน้าตรวจสอบ กรุณาเริ่มใหม่');
  }
  const wallet = await adjustWalletAsAdmin({ discordUserId: session.payload.discordUserId,
    amountCents: BigInt(session.payload.amountCents), reason: session.payload.reason,
    expectedVersion: session.payload.expectedVersion },
  contextFor(interaction, 'wallet_adjust_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply({ content: `ปรับยอดสำเร็จ เครดิตพร้อมใช้ปัจจุบัน **${money(wallet.available_cents)}**`, components: [] });
}
}

async function handleRefundPrepare({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'refund_prepare' && interaction.isButton()) {
  await interaction.deferReply({ ephemeral: true });
  const items = (await runtime.pool.query(`SELECT i.id,i.quest_name,i.price_cents,o.account_username
    FROM order_items i JOIN orders o ON o.id=i.order_id JOIN wallet_reservations r ON r.order_item_id=i.id
    WHERE r.state='CAPTURED' AND NOT EXISTS(SELECT 1 FROM refunds f WHERE f.order_item_id=i.id)
    ORDER BY i.completed_at DESC NULLS LAST LIMIT 25`)).rows;
  if (!items.length) return interaction.editReply({ content: 'ยังไม่มีงานที่คิดค่าบริการแล้วและคืนเครดิตได้' });
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'ADMIN_REFUND_SELECT',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'refund_prepare'), { pool: runtime.pool });
  return interaction.editReply({ content: 'เลือกงานที่ต้องการคืนเครดิต',
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(customId('refund_item_pick', session.id)).setPlaceholder('เลือกงาน Quest')
      .addOptions(items.map((item) => ({ label: item.quest_name.slice(0, 100), value: item.id,
        description: `${item.account_username ?? 'บัญชี Quest'} • ${money(item.price_cents)}`.slice(0, 100) }))))] });
}
}

async function handleRefundItemPick({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'refund_item_pick' && interaction.isStringSelectMenu()) {
  return showPreparedModal({ interaction, runtime, route,
    modal: (sessionId) => fieldsModal('refund_prepare_submit', sessionId, 'คืนเครดิตงาน Quest', [
      { id: 'reason', label: 'เหตุผลการคืนเงิน', long: true, max: 500 },
    ]),
    prepare: async (sessionId) => {
      const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
        guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_REFUND_SELECT' },
      contextFor(interaction, 'refund_item_load'), { pool: runtime.pool });
      return advanceInteractionSession(session, interaction, runtime, {
        id: sessionId, messageId: interaction.message?.id ?? null, operation: 'ADMIN_REFUND_PREPARE',
        payload: { orderItemId: interaction.values[0] }, configVersion: runtime.config.version,
      }, 'refund_prepare_selected');
    } });
}
}

async function handleRefundPrepareSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'refund_prepare_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_REFUND_PREPARE' },
  contextFor(interaction, 'refund_prepare_load'), { pool: runtime.pool });
  const orderItemId = session.payload.orderItemId;
  const reason = interaction.fields.getTextInputValue('reason').trim();
  const row = (await runtime.pool.query(`SELECT r.*,i.order_id,i.quest_name,w.available_cents,
    EXISTS(SELECT 1 FROM refunds f WHERE f.order_item_id=r.order_item_id) AS refunded
    FROM wallet_reservations r JOIN order_items i ON i.id=r.order_item_id
    JOIN wallets w ON w.discord_user_id=r.discord_user_id WHERE r.order_item_id=$1`, [orderItemId])).rows[0];
  if (!row) throw new QuestshopError('RESERVATION_NOT_FOUND', 'ไม่พบงาน Quest หรือยอดที่เกี่ยวข้อง');
  if (row.refunded) throw new QuestshopError('ALREADY_REFUNDED', 'งานนี้คืนเครดิตแล้ว');
  if (row.state !== 'CAPTURED') throw new QuestshopError('REFUND_NOT_CAPTURED', 'คืนได้เฉพาะงานที่คิดค่าบริการแล้ว');
  const after = BigInt(row.available_cents) + BigInt(row.amount_cents);
  const confirm = await advanceInteractionSession(session, interaction, runtime, {
    messageId: interaction.message?.id ?? null, operation: 'ADMIN_REFUND_CONFIRM',
    payload: { orderItemId, reason, expectedReservationVersion: String(row.state_version) }, configVersion: runtime.config.version,
  }, 'refund_confirm_session');
  return interaction.editReply({ content: `ยืนยันคืนเครดิต **${row.quest_name}**\nออเดอร์: \`${row.order_id}\`\nงาน: \`${orderItemId}\`\nจำนวน: **${money(row.amount_cents)}**\nเครดิตพร้อมใช้: **${money(row.available_cents)} → ${money(after)}**\nเหตุผล: ${reason}`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(customId('refund_confirm', confirm.id)).setLabel('ยืนยันคืนเงิน')
      .setStyle(ButtonStyle.Danger))] });
}
}

async function handleRefundConfirm({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'refund_confirm' && interaction.isButton()) {
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_REFUND_CONFIRM' },
  contextFor(interaction, 'refund_confirm_load'), { pool: runtime.pool });
  const refund = await refundCapturedOrderItem({ orderItemId: session.payload.orderItemId,
    reason: session.payload.reason, expectedReservationVersion: session.payload.expectedReservationVersion },
  contextFor(interaction, 'refund_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply({ content: `คืนเครดิตสำเร็จ **${money(refund.amount_cents)}**\nรหัสการคืน: \`${refund.id}\`\nเครดิตพร้อมใช้ปัจจุบัน: **${money(refund.available_cents)}**`, components: [] });
}
}

async function handlePaymentReviewPick({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'payment_review_pick' && interaction.isStringSelectMenu()) {
  await interaction.deferReply({ ephemeral: true });
  const review = (await runtime.pool.query(`SELECT r.*,t.discord_user_id,t.amount_cents,t.provider_transaction_id,
    t.status AS topup_status,t.failure_code,t.warning_code,
    COALESCE((SELECT a.provider_http_status BETWEEN 200 AND 299
      AND a.provider_evidence->>'receiverConfirmation'='REQUEST_BOUND_SUCCESS'
      AND (a.provider_evidence->>'settlementIdentity'='VOUCHER_HMAC'
        OR a.error_code='PROVIDER_TRANSACTION_ID_MISSING')
      FROM payment_attempts a WHERE a.topup_id=t.id ORDER BY a.attempt_number DESC LIMIT 1),false)
      AS alternate_settlement_evidence
    FROM manual_reviews r JOIN topups t ON r.subject_type='TOPUP' AND r.subject_id=t.id::text
    WHERE r.id=$1 AND r.state<>'RESOLVED'`, [interaction.values[0]])).rows[0];
  if (!review) throw new QuestshopError('REVIEW_NOT_FOUND', 'รายการเติมเงินนี้ถูกจัดการไปแล้ว');
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null, operation: 'TOPUP_REVIEW_DETAIL',
    payload: { reviewId: review.id, expectedVersion: String(review.state_version),
      alternateSettlementEvidence: review.alternate_settlement_evidence === true }, configVersion: runtime.config.version },
  contextFor(interaction, 'topup_review_detail'), { pool: runtime.pool });
  const detail = [
    `ผู้เติม: <@${review.discord_user_id}> (\`${review.discord_user_id}\`)`,
    `สถานะ: **${displayState(review.topup_status)}**`,
    `ยอดที่ยืนยันได้: **${review.amount_cents == null ? 'ยังไม่ทราบ' : money(review.amount_cents)}**`,
    `เลขธุรกรรม: \`${review.provider_transaction_id ?? 'ยังไม่มี'}\``,
    ...(review.alternate_settlement_evidence === true
      ? ['หลักฐานจาก TrueMoney: ยืนยันยอดและผู้รับแล้ว — ยืนยันด้วยรหัสซองที่เข้ารหัสได้'] : []),
    `สาเหตุ: ${escapedText(review.failure_code ?? review.opened_reason ?? 'ต้องตรวจในแอป TrueMoney')}`,
  ].join('\n');
  return interaction.editReply({ content: detail, components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('topup_review_credit', session.id)).setLabel('เพิ่มเครดิต').setStyle(ButtonStyle.Success)
      .setDisabled(interaction.user.id !== runtime.env.OWNER_ID),
    new ButtonBuilder().setCustomId(customId('topup_review_reject', session.id)).setLabel('ปฏิเสธรายการ').setStyle(ButtonStyle.Danger)
      .setDisabled(interaction.user.id !== runtime.env.OWNER_ID),
  )] });
}
}

async function handleTopupReviewDecision({ interaction, route, runtime, gates: _gates }) {
if (['topup_review_credit', 'topup_review_reject'].includes(route.route) && interaction.isButton()) {
  ownerOnly(interaction, runtime, 'รายการเติมเงินที่ผลไม่ชัดเจนให้ Owner ตัดสินเท่านั้น');
  const credit = route.route === 'topup_review_credit';
  const detailSession = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'TOPUP_REVIEW_DETAIL' },
  contextFor(interaction, 'topup_review_action_preview'), { pool: runtime.pool });
  const providerIdRequired = detailSession.payload.alternateSettlementEvidence !== true;
  return showPreparedModal({ interaction, runtime, route,
    modal: (sessionId) => fieldsModal('topup_review_decision_submit', sessionId,
      credit ? 'ยืนยันเพิ่มเครดิตจากซอง' : 'ปฏิเสธรายการเติมเงิน', credit ? [
      { id: 'amount', label: 'ยอดที่ยืนยันได้ (บาท)', max: 24 },
      { id: 'provider_id', label: providerIdRequired ? 'เลขธุรกรรม TrueMoney' : 'เลขธุรกรรม TrueMoney (ถ้ามี)', max: 200,
        required: providerIdRequired },
      { id: 'reason', label: 'หลักฐานและเหตุผล', long: true, max: 500 },
    ] : [{ id: 'reason', label: 'เหตุผลที่ปฏิเสธ', long: true, max: 500 }]),
    prepare: async (sessionId) => {
      const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
        guildId: interaction.guildId, channelId: interaction.channelId, operation: 'TOPUP_REVIEW_DETAIL' },
      contextFor(interaction, 'topup_review_action_load'), { pool: runtime.pool });
      return advanceInteractionSession(session, interaction, runtime, {
        id: sessionId, messageId: interaction.message?.id ?? null, operation: 'TOPUP_REVIEW_DECISION',
        payload: { ...session.payload, decision: credit ? 'CREDIT' : 'REJECT' }, configVersion: runtime.config.version,
      }, 'topup_review_decision_session');
    } });
}
}

async function handleTopupReviewDecisionSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'topup_review_decision_submit' && interaction.isModalSubmit()) {
  ownerOnly(interaction, runtime, 'รายการเติมเงินที่ผลไม่ชัดเจนให้ Owner ตัดสินเท่านั้น');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'TOPUP_REVIEW_DECISION' },
  contextFor(interaction, 'topup_review_decision_load'), { pool: runtime.pool });
  const credit = session.payload.decision === 'CREDIT';
  const result = await resolveSubjectReview({
    reviewId: session.payload.reviewId, expectedVersion: session.payload.expectedVersion, decision: session.payload.decision,
    reason: interaction.fields.getTextInputValue('reason').trim(), isOwner: true,
    amountCents: credit ? parseBahtToCents(interaction.fields.getTextInputValue('amount')) : null,
    providerTransactionId: credit ? interaction.fields.getTextInputValue('provider_id').trim() : null,
  }, contextFor(interaction, 'topup_review_decision_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`จัดการรายการเติมเงินแล้ว: **${result.applied.status ?? session.payload.decision}**`);
}
}
async function handleOrderReview({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'adminorder_review' && interaction.isButton()) {
  return showPreparedModal({ interaction, runtime, route, sessionId: route.sessionId,
    modal: (sessionId) => fieldsModal('adminorder_review_submit', sessionId, 'เปิดรายการตรวจสอบงาน Quest', [
      { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
    ]),
    prepare: () => loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
      guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ORDER_ITEM_DETAIL' },
    contextFor(interaction, 'order_review_load_detail'), { pool: runtime.pool }) });
}
}

async function handleOrderPick({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'adminorder_pick' && interaction.isStringSelectMenu()) {
  await interaction.deferReply({ ephemeral: true });
  const item = (await runtime.pool.query(`SELECT i.*,o.account_id,o.account_username,o.id AS order_id,
    r.state AS reservation_state,r.amount_cents,r.state_version AS reservation_version,
    count(a.id)::integer AS attempts
    FROM order_items i JOIN orders o ON o.id=i.order_id
    LEFT JOIN wallet_reservations r ON r.order_item_id=i.id
    LEFT JOIN runner_jobs j ON j.order_item_id=i.id
    LEFT JOIN runner_attempts a ON a.job_id=j.id
    WHERE i.id=$1 GROUP BY i.id,o.id,r.id`, [interaction.values[0]])).rows[0];
  if (!item) throw new QuestshopError('ORDER_ITEM_NOT_FOUND', 'ไม่พบงาน Quest นี้');
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null, operation: 'ORDER_ITEM_DETAIL',
    payload: { orderItemId: item.id, expectedVersion: String(item.state_version) }, configVersion: runtime.config.version },
  contextFor(interaction, 'order_item_detail'), { pool: runtime.pool });
  const detail = [
    `Quest: **${escapedText(item.quest_name)}**`,
    `บัญชี Quest: **${escapedText(item.account_username ?? item.account_id)}** (\`${item.account_id}\`)`,
    `สถานะ: **${orderStateLabel(item.state)}** • ความคืบหน้า **${item.progress_bucket}%**`,
    `ออเดอร์: \`${item.order_id}\` • ราคา: **${money(item.price_cents)}**`,
    `ยอดจอง: **${item.reservation_state ?? 'ไม่พบ'}** • Attempts: **${item.attempts}**`,
  ].join('\n');
  return interaction.editReply({ content: detail, components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('adminorder_review', session.id)).setLabel('ส่งตรวจสอบงานนี้').setStyle(ButtonStyle.Danger)
      .setDisabled(['READY_TO_CLAIM', 'EXPIRED_RELEASED', 'EXTERNAL_COMPLETED_RELEASED', 'STOPPED_RELEASED', 'FAILED_RELEASED'].includes(item.state)),
  )] });
}
}

async function handleOrderPage({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'orders_page' && interaction.isButton()) {
  await interaction.deferUpdate();
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ORDER_PAGE' },
  contextFor(interaction, 'order_page_load'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return renderOrdersPanel(interaction, runtime, Number(session.payload.offset ?? 0));
}
}

async function handleOrderReviewSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'adminorder_review_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ORDER_ITEM_DETAIL' },
  contextFor(interaction, 'order_review_load'), { pool: runtime.pool });
  const review = await openOrderItemReview({ orderItemId: session.payload.orderItemId,
    reason: interaction.fields.getTextInputValue('reason').trim(), ownerOnly: false },
  contextFor(interaction, 'order_review_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`เปิดรายการตรวจสอบงาน **${review.subject_id}** แล้ว`);
}
}

function parsePromotionTiersInput(raw) {
  const tiers = String(raw).split(',').map((entry) => {
    const [amount, percent, ...extra] = entry.split('=').map((value) => value.trim());
    if (!amount || !percent || extra.length) throw new TypeError('รูปแบบ Tier ต้องเป็น ยอด=เปอร์เซ็นต์ เช่น 100=10');
    return { minimumAmountCents: parseBahtToCents(amount), basisPoints: parsePromotionBasisPoints(percent) };
  });
  if (!tiers.length) throw new TypeError('ต้องมีโบนัสอย่างน้อยหนึ่งระดับ');
  return tiers;
}

function parseOptionalPositiveInteger(value, label) {
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new TypeError(`${label} ไม่ถูกต้อง`);
  return parsed;
}

async function handlePriceCategoryPick({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'price_category_pick' && interaction.isStringSelectMenu()) {
  const category = interaction.values[0];
  const taskTypes = QUEST_PRICE_CATEGORIES[category];
  if (!taskTypes) throw new TypeError('ประเภท Quest ไม่ถูกต้อง');
  return showPreparedModal({ interaction, runtime, route,
    modal: (sessionId) => fieldsModal('price_category_submit', sessionId,
      category === 'GAME' ? 'ตั้งราคา Quest เล่นเกม' : 'ตั้งราคา Quest ดูวิดีโอ', [
        { id: 'amount', label: 'ราคาใหม่ (บาท)', placeholder: '5.00', max: 24 },
      ]),
    prepare: async (sessionId) => {
      const rules = (await runtime.pool.query(`SELECT task_type,amount_cents,state_version FROM price_rules
        WHERE enabled=true AND rule_type='TYPE' AND task_type=ANY($1::text[])`, [taskTypes])).rows;
      if (rules.length !== taskTypes.length) throw new QuestshopError('PRICE_CONFIGURATION_MISSING', 'ยังตั้งราคาประเภทนี้ไม่ครบ');
      return createAdminSession({ id: sessionId, actorId: interaction.user.id, guildId: interaction.guildId,
        channelId: interaction.channelId, messageId: interaction.message?.id ?? null, operation: 'PRICE_CATEGORY_PREPARE',
        payload: { category, expectedVersions: Object.fromEntries(rules.map((rule) => [rule.task_type, String(rule.state_version)])) },
        configVersion: runtime.config.version }, contextFor(interaction, 'price_category_prepare'), { pool: runtime.pool });
    } });
}
}

async function handlePriceCategorySubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'price_category_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'PRICE_CATEGORY_PREPARE' },
  contextFor(interaction, 'price_category_load'), { pool: runtime.pool });
  const amountCents = parseBahtToCents(interaction.fields.getTextInputValue('amount'));
  const old = (await runtime.pool.query(`SELECT amount_cents FROM price_rules WHERE enabled=true
    AND rule_type='TYPE' AND task_type=ANY($1::text[]) ORDER BY created_at LIMIT 1`,
  [QUEST_PRICE_CATEGORIES[session.payload.category]])).rows[0];
  const confirm = await advanceInteractionSession(session, interaction, runtime, {
    messageId: interaction.message?.id ?? null, operation: 'PRICE_CATEGORY_CONFIRM',
    payload: { category: session.payload.category, amountCents: String(amountCents), expectedVersions: session.payload.expectedVersions },
    configVersion: runtime.config.version,
  }, 'price_category_confirm_session');
  return interaction.editReply({ content: `ยืนยันเปลี่ยนราคา **${session.payload.category === 'GAME' ? 'Quest เล่นเกม' : 'Quest ดูวิดีโอ'}**\n${money(old.amount_cents)} → **${money(amountCents)}**\nราคานี้ใช้ต่อเนื่องจนกว่าจะเปลี่ยนครั้งถัดไป`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(customId('price_category_confirm', confirm.id)).setLabel('ยืนยันเปลี่ยนราคา').setStyle(ButtonStyle.Danger))] });
}
}

async function handlePriceCategoryConfirm({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'price_category_confirm' && interaction.isButton()) {
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'PRICE_CATEGORY_CONFIRM' },
  contextFor(interaction, 'price_category_confirm_load'), { pool: runtime.pool });
  const result = await setQuestCategoryPrice({ category: session.payload.category,
    amountCents: BigInt(session.payload.amountCents), expectedVersions: session.payload.expectedVersions },
  contextFor(interaction, 'price_category_change'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`ตั้งราคา ${result.category === 'GAME' ? 'Quest เล่นเกม' : 'Quest ดูวิดีโอ'} เป็น **${money(result.amountCents)}** แล้ว`);
}
}

async function handlePromotionSet({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'promo_set' && interaction.isButton()) {
  return showPreparedModal({ interaction, runtime, route,
    modal: (sessionId) => fieldsModal('promo_set_submit', sessionId, 'ตั้งโบนัสเติมเงิน', [
      { id: 'tiers', label: 'ยอดเติม=โบนัสเปอร์เซ็นต์', placeholder: '100=10, 300=15, 600=20', max: 300 },
      { id: 'uses', label: 'จำนวนครั้งต่อผู้ใช้ตลอดรุ่นนี้', placeholder: 'เว้นว่างได้', required: false, max: 10 },
      { id: 'daily_cap', label: 'โบนัสสูงสุดต่อผู้ใช้ต่อวัน (บาท)', placeholder: 'เว้นว่างได้', required: false, max: 24 },
    ]),
    prepare: (sessionId) => createAdminSession({ id: sessionId, actorId: interaction.user.id, guildId: interaction.guildId,
      channelId: interaction.channelId, messageId: interaction.message?.id ?? null, operation: 'PROMOTION_TERMS_PREPARE',
      payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'promotion_terms_prepare'), { pool: runtime.pool }) });
}
}

async function handlePromotionSetSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'promo_set_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'PROMOTION_TERMS_PREPARE' },
  contextFor(interaction, 'promotion_terms_load'), { pool: runtime.pool });
  const tiers = parsePromotionTiersInput(interaction.fields.getTextInputValue('tiers'));
  const maxUsesPerUser = parseOptionalPositiveInteger(interaction.fields.getTextInputValue('uses'), 'จำนวนครั้งต่อผู้ใช้');
  const dailyCapText = interaction.fields.getTextInputValue('daily_cap').trim();
  const maxBonusPerDayCents = dailyCapText ? parseBahtToCents(dailyCapText) : null;
  const confirm = await advanceInteractionSession(session, interaction, runtime, {
    messageId: interaction.message?.id ?? null, operation: 'PROMOTION_TERMS_CONFIRM',
    payload: { tiers: tiers.map((tier) => ({ minimumAmountCents: String(tier.minimumAmountCents), basisPoints: tier.basisPoints })),
      maxUsesPerUser, maxBonusPerDayCents: maxBonusPerDayCents == null ? null : String(maxBonusPerDayCents) },
    configVersion: runtime.config.version,
  }, 'promotion_terms_confirm_session');
  const preview = tiers.map((tier) => `${money(tier.minimumAmountCents)} = ${(tier.basisPoints / 100).toFixed(2)}%`).join('\n');
  return interaction.editReply({ content: `ยืนยันตั้งโบนัสเติมเงิน\n${preview}\nจำนวนครั้งต่อผู้ใช้: **${maxUsesPerUser ?? 'ไม่จำกัด'}**\nโบนัสต่อวัน: **${maxBonusPerDayCents == null ? 'ไม่จำกัด' : money(maxBonusPerDayCents)}**`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(customId('promo_set_confirm', confirm.id)).setLabel('ยืนยันบันทึกโบนัส').setStyle(ButtonStyle.Danger))] });
}
}

async function handlePromotionSetConfirm({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'promo_set_confirm' && interaction.isButton()) {
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'PROMOTION_TERMS_CONFIRM' },
  contextFor(interaction, 'promotion_terms_confirm_load'), { pool: runtime.pool });
  const result = await replaceManualPromotion({
    tiers: session.payload.tiers.map((tier) => ({ ...tier, minimumAmountCents: BigInt(tier.minimumAmountCents) })),
    maxUsesPerUser: session.payload.maxUsesPerUser,
    maxBonusPerDayCents: session.payload.maxBonusPerDayCents == null ? null : BigInt(session.payload.maxBonusPerDayCents),
  }, contextFor(interaction, 'promotion_terms_replace'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`บันทึกโบนัสเติมเงินรุ่น **${result.promotion.version}** และเปิดใช้งานแล้ว`);
}
}

async function handlePromotionToggle({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'promo_toggle' && interaction.isButton()) {
  await interaction.deferReply({ ephemeral: true });
  const current = (await runtime.pool.query(`SELECT * FROM promotions WHERE manual_controlled=true
    ORDER BY version DESC LIMIT 1`)).rows[0];
  if (!current) throw new QuestshopError('PROMOTION_NOT_FOUND', 'ยังไม่มีโบนัสเติมเงินให้เปิดหรือปิด');
  const enabled = current.state !== 'ACTIVE';
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null, operation: 'PROMOTION_TOGGLE_CONFIRM',
    payload: { enabled, expectedVersion: String(current.state_version) }, configVersion: runtime.config.version },
  contextFor(interaction, 'promotion_toggle_session'), { pool: runtime.pool });
  return interaction.editReply({ content: `ยืนยัน${enabled ? 'เปิด' : 'ปิด'}โบนัสเติมเงิน?`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(customId('promo_toggle_confirm', session.id)).setLabel(`ยืนยัน${enabled ? 'เปิด' : 'ปิด'}โบนัส`)
      .setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Danger))] });
}
}

async function handlePromotionToggleConfirm({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'promo_toggle_confirm' && interaction.isButton()) {
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'PROMOTION_TOGGLE_CONFIRM' },
  contextFor(interaction, 'promotion_toggle_load'), { pool: runtime.pool });
  const updated = await setManualPromotionEnabled(session.payload,
    contextFor(interaction, 'promotion_toggle_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`โบนัสเติมเงิน${updated.state === 'ACTIVE' ? 'เปิดใช้งานแล้ว' : 'ปิดแล้ว'}`);
}
}
async function handleReceiverActivate({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'receiver_activate' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'เบอร์รับเงินใช้ได้เฉพาะเจ้าของร้าน');
  return showPreparedModal({ interaction, runtime, route,
    modal: (sessionId) => fieldsModal('receiver_activate_submit', sessionId, 'เพิ่มเบอร์รับเงินใหม่', [
      { id: 'phone', label: 'เบอร์ TrueMoney 10 หลัก', max: 10 },
      { id: 'reason', label: 'เหตุผลการเปลี่ยนเบอร์', long: true, max: 500 },
    ]),
    prepare: (sessionId) => createAdminSession({ id: sessionId, actorId: interaction.user.id, guildId: interaction.guildId,
      channelId: interaction.channelId, messageId: interaction.message.id, operation: 'RECEIVER_PREPARE',
      payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'receiver_session'), { pool: runtime.pool }) });
}
}

async function handleReceiverActivateSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'receiver_activate_submit' && interaction.isModalSubmit()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'เบอร์รับเงินใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'RECEIVER_PREPARE' },
  contextFor(interaction, 'receiver_load'), { pool: runtime.pool });
  const phone = interaction.fields.getTextInputValue('phone').trim();
  if (!/^0\d{9}$/.test(phone)) throw new TypeError('เบอร์รับเงินไม่ถูกต้อง');
  const payload = { phone, reason: interaction.fields.getTextInputValue('reason').trim() };
  const confirm = await advanceInteractionSession(session, interaction, runtime, {
    messageId: interaction.message?.id ?? null, operation: 'RECEIVER_CONFIRM', payload,
    configVersion: runtime.config.version,
  }, 'receiver_confirm_session');
  return interaction.editReply({ content: `ยืนยันเปิดเบอร์รับเงินใหม่ ***-***-${phone.slice(-4)}**\nรายการใหม่จะใช้เบอร์นี้ทันที ส่วนรายการเดิมจะใช้เบอร์เดิมที่บันทึกไว้\nเหตุผล: ${payload.reason}`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(customId('receiver_activate_confirm', confirm.id)).setLabel('ยืนยันเบอร์รับเงินใหม่')
      .setStyle(ButtonStyle.Danger))] });
}
}

async function handleReceiverActivateConfirm({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'receiver_activate_confirm' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'เบอร์รับเงินใช้ได้เฉพาะเจ้าของร้าน');
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'RECEIVER_CONFIRM' },
  contextFor(interaction, 'receiver_confirm_load'), { pool: runtime.pool });
  const receiver = await activateReceiver({ phone: session.payload.phone, env: runtime.env,
    reason: session.payload.reason }, contextFor(interaction, 'receiver_activate_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`เปิดเบอร์รับเงินรุ่น ${receiver.version} (***-***-${receiver.phone_last4}) แล้ว`);
}
}

async function handleMonitorAdd({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_add' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  return showPreparedModal({ interaction, runtime, route,
    modal: (sessionId) => fieldsModal('monitor_add_submit', sessionId, 'เพิ่มบัญชีตรวจสอบ Quest', [
      { id: 'token', label: 'Discord Token', long: true, max: 300 },
    ]),
    prepare: (sessionId) => createAdminSession({ id: sessionId, actorId: interaction.user.id, guildId: interaction.guildId,
      channelId: interaction.channelId, messageId: interaction.message.id, operation: 'MONITOR_ADD',
      payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'monitor_session'), { pool: runtime.pool }) });
}
}

async function handleMonitorAddSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_add_submit' && interaction.isModalSubmit()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'MONITOR_ADD' },
  contextFor(interaction, 'monitor_load'), { pool: runtime.pool });
  const monitor = await addMonitor({ token: interaction.fields.getTextInputValue('token'), env: runtime.env },
  contextFor(interaction, 'monitor_add_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`เพิ่มบัญชีตรวจสอบ **${escapedText(monitor.username)}** (\`${escapedText(monitor.account_id)}\`) แล้ว\nบัญชีนี้จะตรวจหาและทดสอบ Quest อัตโนมัติ โดย Token ถูกเข้ารหัสและไม่สามารถเปิดดูจากหน้าแอดมินได้`);
}
}

async function handleMonitorCheckAll({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_check_all' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const results = await checkAllMonitorHealth({ env: runtime.env },
    contextFor(interaction, 'monitor_check_all_execute'), { pool: runtime.pool });
  const ready = results.filter((result) => result.healthState === 'READY').length;
  const paused = results.filter((result) => result.monitor.state === 'DISABLED').length;
  return interaction.editReply({ embeds: [panelEmbed(0x5865f2, 'ผลตรวจระบบ Token', [
    `ตรวจ **${results.length}** Token • Token ปกติ **${ready}** • มีปัญหา/ใช้ไม่ได้ **${results.length - ready}** • พักใช้งาน **${paused}**`, '',
    listRows(results, monitorHealthLine, 'ยังไม่มี Token Monitor'),
    '', 'การตรวจนี้เช็คการถอดรหัส Token, ล็อกอิน และอ่านรายการ Quest เท่านั้น — ไม่ทำ Quest จริง',
  ].join('\n'))] });
}
}

async function handleMonitorList({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_list' && interaction.isButton()) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferUpdate();
  return renderMonitorList(interaction, runtime);
}
}

async function handleMonitorSelect({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_select' && interaction.isStringSelectMenu()) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation: 'MONITOR_SELECT' }, contextFor(interaction, 'monitor_select_load'), { pool: runtime.pool });
  const monitorId = interaction.values[0];
  if (!session.payload.monitorIds?.includes(monitorId)) throw new QuestshopError('MONITOR_SELECTION_INVALID', 'รายการบัญชีตรวจสอบหมดอายุแล้ว');
  await interaction.deferUpdate();
  return renderMonitorDetail(interaction, runtime, monitorId);
}
}

async function handleMonitorCheckOne({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_check_one' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation: 'MONITOR_CHECK_ONE' }, contextFor(interaction, 'monitor_check_one_load'), { pool: runtime.pool });
  const result = await checkMonitorHealth({ monitorId: session.payload.monitorId, env: runtime.env },
    contextFor(interaction, 'monitor_check_one_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`${monitorHealthLine(result)}\nการตรวจนี้ไม่สั่งทำ Quest จริง`);
}
}

async function handleMonitorRotate({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_rotate' && interaction.isButton()) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  return showPreparedModal({ interaction, runtime, route, sessionId: route.sessionId,
    modal: (sessionId) => fieldsModal('monitor_rotate_submit', sessionId, 'เปลี่ยน Token บัญชีตรวจสอบ', [
      { id: 'token', label: 'Discord Token ใหม่', long: true, max: 300 },
    ]),
    prepare: () => loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
      guildId: interaction.guildId, channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
      operation: 'MONITOR_ROTATE' }, contextFor(interaction, 'monitor_rotate_load_button'), { pool: runtime.pool }) });
}
}

async function handleMonitorRotateSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_rotate_submit' && interaction.isModalSubmit()) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'MONITOR_ROTATE' },
  contextFor(interaction, 'monitor_rotate_load'), { pool: runtime.pool });
  const monitor = await rotateMonitorCredential({ monitorId: session.payload.monitorId,
    token: interaction.fields.getTextInputValue('token'), env: runtime.env },
  contextFor(interaction, 'monitor_rotate_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`เปลี่ยน Token ของ **${escapedText(monitor.username ?? monitor.account_id)}** เรียบร้อยแล้ว และเปิดใช้งานบัญชีนี้อีกครั้ง`);
}
}

async function handleMonitorState({ interaction, route, runtime, gates: _gates }) {
if (['monitor_enable', 'monitor_disable'].includes(route.route) && interaction.isButton()) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const intendedState = route.route === 'monitor_enable' ? 'ACTIVE' : 'DISABLED';
  const operation = intendedState === 'ACTIVE' ? 'MONITOR_ENABLE' : 'MONITOR_DISABLE';
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation }, contextFor(interaction, 'monitor_state_load'), { pool: runtime.pool });
  if (session.payload.intendedState !== intendedState) {
    throw new QuestshopError('MONITOR_STATE_COMMAND_INVALID', 'คำสั่งเปลี่ยนสถานะบัญชีไม่ตรงกับหน้าที่เปิดไว้');
  }
  const changed = await setMonitorState({ monitorId: session.payload.monitorId, state: intendedState,
    expectedState: session.payload.expectedState, expectedVersion: session.payload.expectedStateVersion },
  contextFor(interaction, 'monitor_state_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`${intendedState === 'ACTIVE' ? 'เปิดใช้งาน' : 'พักใช้งาน'} **${changed.username ?? changed.account_id}** แล้ว`);
}
}

async function handleLegacyMonitorToggle({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_toggle' && interaction.isButton()) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  return interaction.editReply({ content: 'ปุ่มนี้เป็นหน้ารุ่นเก่า กรุณาเปิดรายละเอียดบัญชีใหม่ก่อนเปลี่ยนสถานะ' });
}
}

async function handleDlqAction({ interaction, route, runtime, gates: _gates }) {
  if (!['dlq_replay', 'dlq_discard'].includes(route.route) || !interaction.isButton()) {
    return;
  }
  const replay = route.route === 'dlq_replay';
  if (!replay && interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'การปิดงานค้างใช้ได้เฉพาะเจ้าของร้าน');
  const operation = replay ? 'DLQ_REPLAY' : 'DLQ_DISCARD';
  return showPreparedModal({ interaction, runtime, route,
    modal: (sessionId) => fieldsModal(replay ? 'dlq_replay_submit' : 'dlq_discard_submit', sessionId,
      replay ? 'ลองส่งงานค้างใหม่' : 'ปิดงานค้างที่ไม่เกี่ยวกับเงิน', [
        { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
      ]),
    prepare: async (sessionId) => {
      const selected = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
        guildId: interaction.guildId, channelId: interaction.channelId, operation: 'DLQ_DETAIL' },
      contextFor(interaction, 'dlq_action_load'), { pool: runtime.pool });
      return advanceInteractionSession(selected, interaction, runtime, {
        id: sessionId, messageId: interaction.message?.id ?? null, operation,
        payload: { dlqId: selected.payload.dlqId }, configVersion: runtime.config.version,
      }, 'dlq_action_session');
    } });
}

async function handleDlqSubmit({ interaction, route, runtime, gates: _gates }) {
if (['dlq_replay_submit', 'dlq_discard_submit'].includes(route.route) && interaction.isModalSubmit()) {
  const replay = route.route === 'dlq_replay_submit';
  if (!replay && interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'การปิดงานค้างใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const operation = replay ? 'DLQ_REPLAY' : 'DLQ_DISCARD';
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation },
  contextFor(interaction, 'dlq_load'), { pool: runtime.pool });
  const input = { dlqId: session.payload.dlqId, reason: interaction.fields.getTextInputValue('reason').trim() };
  const result = replay
    ? await replayDeadLetter(input, contextFor(interaction, 'dlq_replay_execute'), { pool: runtime.pool })
    : await discardDeadLetter({ ...input, isOwner: true }, contextFor(interaction, 'dlq_discard_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`${replay ? 'ส่งงานค้างใหม่' : 'ปิดงานค้าง'} สำเร็จ: \`${replay ? result.replayOutboxId : result.id}\``);
}
}

async function handleDlqPick({ interaction, route, runtime, gates: _gates }) {
  if (route.route !== 'dlq_pick' || !interaction.isStringSelectMenu()) {
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const selection = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'DLQ_SELECT' },
  contextFor(interaction, 'dlq_pick_load'), { pool: runtime.pool });
  const dlqId = interaction.values[0];
  if (!selection.payload.dlqIds?.includes(dlqId)) throw new QuestshopError('DLQ_SELECTION_INVALID', 'รายการปัญหานี้หมดอายุแล้ว');
  const item = (await runtime.pool.query(`SELECT * FROM dead_letter_items WHERE id=$1
    AND state IN ('DEAD_LETTER','PENDING')`, [dlqId])).rows[0];
  if (!item) throw new QuestshopError('DLQ_NOT_FOUND', 'ไม่พบรายการปัญหาที่ยังจัดการได้');
  const detail = await advanceInteractionSession(selection, interaction, runtime, {
    messageId: interaction.message?.id ?? null, operation: 'DLQ_DETAIL',
    payload: { dlqId: item.id }, configVersion: runtime.config.version,
  }, 'dlq_detail_session');
  const discardAllowed = !['FINANCIAL', 'AUDIT'].includes(item.category) && interaction.user.id === runtime.env.OWNER_ID;
  const description = [
    '**รายละเอียดงานค้าง**',
    'ระบบตรวจสอบสิทธิ์และสถานะของรายการนี้แล้ว',
    'เลือกลองส่งใหม่เพื่อให้ระบบสร้าง Attempt ใหม่ หรือปิดงานเมื่อยืนยันว่าไม่ต้องดำเนินการต่อ',
    'รายการการเงินและ Audit จะไม่สามารถปิดทิ้งได้',
  ].join('\n');
  return interaction.editReply({ content: description, components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('dlq_replay', detail.id)).setLabel('ลองส่งงานนี้ใหม่').setStyle(ButtonStyle.Primary)
      .setDisabled(item.state !== 'DEAD_LETTER'),
    new ButtonBuilder().setCustomId(customId('dlq_discard', detail.id)).setLabel('ปิดงานนี้').setStyle(ButtonStyle.Danger)
      .setDisabled(!discardAllowed || item.state !== 'DEAD_LETTER'),
  )] });
}

async function handleConcurrency({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'config_concurrency' && interaction.isButton()) {
  return showPreparedModal({ interaction, runtime, route,
    modal: (sessionId) => fieldsModal('config_concurrency_submit', sessionId, 'ตั้งจำนวนงานพร้อมกัน', [
      { id: 'concurrency', label: `จำนวน Worker (1-${runtime.env.RUNNER_CONCURRENCY_HARD_MAX})`, max: 1 },
      { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
    ]),
    prepare: (sessionId) => createAdminSession({ id: sessionId, actorId: interaction.user.id, guildId: interaction.guildId,
      channelId: interaction.channelId, messageId: interaction.message.id, operation: 'CONFIG_CONCURRENCY',
      payload: { expectedVersion: runtime.config.version }, configVersion: runtime.config.version },
    contextFor(interaction, 'config_concurrency_session'), { pool: runtime.pool }) });
}
}

async function handleConcurrencySubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'config_concurrency_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'CONFIG_CONCURRENCY' },
  contextFor(interaction, 'config_concurrency_load'), { pool: runtime.pool });
  const concurrency = Number(interaction.fields.getTextInputValue('concurrency').trim());
  if (!Number.isInteger(concurrency) || concurrency < 1
    || concurrency > runtime.env.RUNNER_CONCURRENCY_HARD_MAX) throw new TypeError('จำนวนงานพร้อมกันไม่ถูกต้อง');
  const changed = await updateRuntimeConfig({ patch: { runnerConcurrency: concurrency },
    expectedVersion: session.payload.expectedVersion,
    reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'config_concurrency_execute'), { pool: runtime.pool });
  runtime.config = await loadRuntimeConfig(runtime.pool);
  interaction.client.questshop.config = runtime.config;
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`ตั้งจำนวนงานพร้อมกันเป็น **${concurrency}** แล้ว • การตั้งค่ารุ่น ${changed.version}`);
}
}

async function handleConfig({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'config_quest_role' && interaction.isButton()) {
  ownerOnly(interaction, runtime, 'การตั้งค่ายศแจ้ง Quest ใช้ได้เฉพาะเจ้าของร้าน');
  return showPreparedModal({ interaction, runtime, route,
    modal: (sessionId) => fieldsModal('config_quest_role_submit', sessionId, 'ตั้งยศแจ้ง Quest ใหม่', [
      { id: 'quest_role', label: 'ID ยศแจ้ง Quest ใหม่', required: false, max: 20 },
      { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
    ]),
    prepare: (sessionId) => createAdminSession({ id: sessionId, actorId: interaction.user.id, guildId: interaction.guildId,
      channelId: interaction.channelId, messageId: interaction.message.id, operation: 'CONFIG_QUEST_ROLE',
      payload: { expectedVersion: runtime.config.version }, configVersion: runtime.config.version },
    contextFor(interaction, 'config_session'), { pool: runtime.pool }) });
}
}

function roleConfigPatch(interaction) {
  const questAnnouncementRoleId = interaction.fields.getTextInputValue('quest_role').trim() || null;
  if (questAnnouncementRoleId && !/^\d{17,20}$/.test(questAnnouncementRoleId)) {
    throw new TypeError('ID ยศไม่ถูกต้อง');
  }
  return { questAnnouncementRoleId };
}

async function handleConfigSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'config_quest_role_submit' && interaction.isModalSubmit()) {
  ownerOnly(interaction, runtime, 'การตั้งค่ายศแจ้ง Quest ใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'CONFIG_QUEST_ROLE' },
  contextFor(interaction, 'config_load'), { pool: runtime.pool });
  const changed = await updateRuntimeConfig({ patch: roleConfigPatch(interaction), expectedVersion: session.payload.expectedVersion,
    reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'config_execute'), { pool: runtime.pool });
  runtime.config = await loadRuntimeConfig(runtime.pool);
  interaction.client.questshop.config = runtime.config;
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`บันทึกการตั้งค่ารุ่น **${changed.version}** แล้ว หน้าร้านจะเปลี่ยนเมื่อรีเฟรชหรือติดตั้งแผงข้อความอีกครั้ง`);
}
}

async function handleBreakerPrepare({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'breaker_prepare' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'ระบบป้องกันการรับซองผิดปกติใช้ได้เฉพาะเจ้าของร้าน');
  return showPreparedModal({ interaction, runtime, route,
    modal: (sessionId) => fieldsModal('breaker_submit', sessionId, 'ทดสอบระบบรับซองอีกครั้ง', [
      { id: 'reason', label: 'หลักฐานและเหตุผล', long: true, max: 500 },
    ]),
    prepare: async (sessionId) => {
      const breaker = (await runtime.pool.query("SELECT * FROM circuit_breakers WHERE breaker_key='TRUEMONEY_DIRECT'")).rows[0];
      return createAdminSession({ id: sessionId, actorId: interaction.user.id, guildId: interaction.guildId,
        channelId: interaction.channelId, messageId: interaction.message.id, operation: 'BREAKER_CHANGE',
        payload: { breakerKey: breaker.breaker_key, expectedVersion: String(breaker.state_version),
          beforeState: breaker.state }, configVersion: runtime.config.version },
      contextFor(interaction, 'breaker_session'), { pool: runtime.pool });
    } });
}
}

async function handleBreakerSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'breaker_submit' && interaction.isModalSubmit()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'ระบบป้องกันการรับซองผิดปกติใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'BREAKER_CHANGE' },
  contextFor(interaction, 'breaker_load'), { pool: runtime.pool });
  const breaker = await setCircuitBreakerState({ breakerKey: session.payload.breakerKey,
    // A direct provider probe could redeem a real voucher. HALF_OPEN instead
    // lets the payment worker verify the next legitimate request and only it
    // can close the breaker after the pinned provider schema succeeds.
    nextState: 'HALF_OPEN',
    expectedVersion: session.payload.expectedVersion,
    reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'breaker_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`ระบบรับซองเป็น **${breakerStateLabel(breaker.state)}** แล้ว${breaker.state === 'HALF_OPEN' ? ' และจะทดสอบด้วยรายการถัดไปหนึ่งรายการ' : ''}`);
}
}

export const ROUTE_HANDLERS = Object.freeze({
  "start": handleStart,
  "token_open": handleTokenOpen,
  "topup": handleTopup,
  "payment_method": handlePaymentMethod,
  "voucher_submit": handleVoucherSubmit,
  "token_submit": handleTokenSubmit,
  "quest_prev": handleQuestPaging,
  "quest_next": handleQuestPaging,
  "quest_select": handleQuestSelect,
  "quest_all": handleQuestAll,
  "quest_quote": handleQuestQuote,
  "quest_back": handleQuestBack,
  "quest_confirm": handleQuestConfirm,
  "admin": handleAdminPanel,
  "admin_nav": handleAdminPanel,
  "wallet_adjust": handleWalletAdjust,
  "wallet_user_pick": handleWalletUserPick,
  "wallet_user_search": handleWalletUserSearch,
  "wallet_user_search_submit": handleWalletUserSearchSubmit,
  "wallet_adjust_from_search": handleWalletAdjustFromSearch,
  "wallet_adjust_submit": handleWalletAdjustSubmit,
  "wallet_adjust_confirm": handleWalletAdjustConfirm,
  "refund_prepare": handleRefundPrepare,
  "refund_item_pick": handleRefundItemPick,
  "refund_prepare_submit": handleRefundPrepareSubmit,
  "refund_confirm": handleRefundConfirm,
  "payment_review_pick": handlePaymentReviewPick,
  "topup_review_credit": handleTopupReviewDecision,
  "topup_review_reject": handleTopupReviewDecision,
  "topup_review_decision_submit": handleTopupReviewDecisionSubmit,
  "adminorder_pick": handleOrderPick,
  "orders_page": handleOrderPage,
  "adminorder_review": handleOrderReview,
  "adminorder_review_submit": handleOrderReviewSubmit,
  "price_category_pick": handlePriceCategoryPick,
  "price_category_submit": handlePriceCategorySubmit,
  "price_category_confirm": handlePriceCategoryConfirm,
  "promo_set": handlePromotionSet,
  "promo_set_submit": handlePromotionSetSubmit,
  "promo_set_confirm": handlePromotionSetConfirm,
  "promo_toggle": handlePromotionToggle,
  "promo_toggle_confirm": handlePromotionToggleConfirm,
  "receiver_activate": handleReceiverActivate,
  "receiver_activate_submit": handleReceiverActivateSubmit,
  "receiver_activate_confirm": handleReceiverActivateConfirm,
  "monitor_add": handleMonitorAdd,
  "monitor_add_submit": handleMonitorAddSubmit,
  "monitor_check_all": handleMonitorCheckAll,
  "monitor_list": handleMonitorList,
  "monitor_select": handleMonitorSelect,
  "monitor_check_one": handleMonitorCheckOne,
  "monitor_rotate": handleMonitorRotate,
  "monitor_rotate_submit": handleMonitorRotateSubmit,
  "monitor_enable": handleMonitorState,
  "monitor_disable": handleMonitorState,
  "monitor_toggle": handleLegacyMonitorToggle,
  "dlq_pick": handleDlqPick,
  "dlq_replay": handleDlqAction,
  "dlq_discard": handleDlqAction,
  "dlq_replay_submit": handleDlqSubmit,
  "dlq_discard_submit": handleDlqSubmit,
  "config_concurrency": handleConcurrency,
  "config_concurrency_submit": handleConcurrencySubmit,
  "config_quest_role": handleConfig,
  "config_quest_role_submit": handleConfigSubmit,
  "breaker_prepare": handleBreakerPrepare,
  "breaker_submit": handleBreakerSubmit,
  "customer_quest_publish": handleCustomerQuestPublish,
  "customer_quest_test": handleCustomerQuestTest,
  "customer_quest_case_retry": handleCustomerQuestCaseRetry,
  "customer_quest_case_announce": handleCustomerQuestCaseAnnounce,
  "test_fail_send": handleTestFailureSend,
  "test_fail_retry": handleTestFailureRetry,
});

assertRouteContractCoverage(ROUTE_HANDLERS);

async function dispatchRoute(context) {
  const handler = ROUTE_HANDLERS[context.route.route]
    ?? (context.route.route.startsWith('admin_refresh_') ? handleAdminPanel : null);
  if (!handler) {
    return context.interaction.reply({
      content: 'เมนูนี้เป็นแผงรุ่นเก่าและหมดอายุแล้ว กรุณาเปิด `/admin-panel` ใหม่',
      ephemeral: true,
    });
  }
  return handler(context);
}

function sessionIdsFromComponents(components) {
  const ids = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    const data = typeof value.toJSON === 'function' ? value.toJSON() : value;
    const parsed = typeof data.custom_id === 'string' ? parseCustomId(data.custom_id) : null;
    if (parsed?.sessionId) ids.add(parsed.sessionId);
    for (const child of data.components ?? []) visit(child);
  };
  for (const component of components ?? []) visit(component);
  return [...ids];
}

async function bindRenderedSessions(interaction, runtime, { payload, result }) {
  let messageId = result?.id;
  const sessionIds = sessionIdsFromComponents(payload?.components);
  if (!sessionIds.length) return;
  if (!messageId && typeof interaction.fetchReply === 'function') {
    const reply = await interaction.fetchReply();
    messageId = reply?.id;
  }
  if (!messageId) return;
  await bindRenderedSessionMessages({ sessionIds, actorId: interaction.user.id,
    guildId: interaction.guildId, messageId }, contextFor(interaction, 'interaction_session_bind'), { pool: runtime.pool });
}

function startInteractionMetrics(interaction, runtime) {
  const started = performance.now();
  const traceId = uuidv7();
  const route = parseCustomId(interaction.customId)?.route ?? interaction.commandName ?? null;
  interaction.__questshopTraceId = traceId;
  let acknowledged = false;
  let acknowledgement = ACKNOWLEDGEMENT.NONE;
  const write = (operation, outcome, durationMs, errorClass = null) => runtime.pool.query(`
    INSERT INTO operation_metrics(id,operation,outcome,duration_ms,error_class,trace_id,route,acknowledgement)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
  `, [uuidv7(), operation, outcome, Math.max(0, Math.round(durationMs)), errorClass, traceId, route, acknowledgement]).catch(() => {});
  const markAcknowledged = (method) => {
    if (acknowledged) return;
    acknowledged = true;
    acknowledgement = method;
    write('INTERACTION_ACK', 'SUCCESS', performance.now() - started);
  };
  installResponseController(interaction, {
    onAcknowledged: markAcknowledged,
    onMessage: async (event) => bindRenderedSessions(interaction, runtime, event),
  });
  return {
    complete(error = null) {
      const operation = isBackoffice(interaction, runtime) ? 'PANEL_REQUEST' : 'CUSTOMER_INTERACTION';
      const outcome = interactionErrorOutcome(error);
      write(operation, outcome, performance.now() - started,
        error?.code ?? error?.category ?? error?.name ?? null);
      if (!acknowledged) write('INTERACTION_ACK', 'ACK_FAILED', performance.now() - started,
        error?.code ?? error?.category ?? error?.name ?? null);
      runtime.logger?.debug?.({ traceId, interactionId: interaction.id,
        acknowledgement, durationMs: Math.round(performance.now() - started), outcome }, 'interaction completed');
    },
  };
}

export function interactionMatchesContract(interaction, expectedType) {
  return {
    BUTTON: interaction.isButton(),
    STRING_SELECT: interaction.isStringSelectMenu(),
    USER_SELECT: interaction.isUserSelectMenu(),
    MODAL_SUBMIT: interaction.isModalSubmit(),
  }[expectedType] === true;
}

export async function routeInteraction(interaction) {
  const runtime = interaction.client.questshop;
  const metrics = startInteractionMetrics(interaction, runtime);
  let failure = null;
  try {
    if (runtime.acceptingInteractions === false) {
      throw new QuestshopError('RUNTIME_NOT_ACTIVE', 'ระบบกำลังหยุดทำงานชั่วคราว กรุณาลองใหม่ภายหลัง');
    }
    if (!interaction.inGuild() || interaction.guildId !== runtime.env.DISCORD_GUILD_ID) return;
    if (await handleSurfaceCommand(interaction, runtime)) return;
    if (interaction.isChatInputCommand()) {
      return interaction.reply(ephemeralResponse({
        content: 'คำสั่งนี้ไม่มีแล้วหรือหมดอายุ กรุณาใช้คำสั่งติดตั้งแผง Questshop ใหม่',
      }));
    }
    const route = parseCustomId(interaction.customId);
    if (!route) {
      return interaction.reply(ephemeralResponse({
        content: 'แผงนี้เป็นรุ่นเก่าหรือหมดอายุแล้ว กรุณาเปิดแผงใหม่แล้วลองอีกครั้ง',
      }));
    }
    if (!routeContract(route.route)) {
      return interaction.reply({
        content: 'เมนูนี้เป็นแผงรุ่นเก่าและหมดอายุแล้ว กรุณาเปิด `/admin-panel` ใหม่',
        ephemeral: true,
      });
    }
    if (!interactionMatchesContract(interaction, routeContract(route.route).interaction)) {
      throw new QuestshopError('ROUTE_INTERACTION_INVALID', 'รูปแบบการกดเมนูไม่ถูกต้อง กรุณาเปิดแผงใหม่แล้วลองอีกครั้ง');
    }
    const contract = routeContract(route.route);
    const gates = preAuthorizeRoute(interaction, route, runtime);
    if (contract.response !== 'MODAL') await acknowledgeByContract(interaction, contract.response);
    if (contract.response === 'MODAL') {
      return await dispatchRoute({ interaction, route, runtime, gates });
    }
    await authorizeRoute(interaction, route, runtime);
    if (interaction.isModalSubmit()) await waitForModalPreparation(runtime, route.sessionId);
    return await dispatchRoute({ interaction, route, runtime, gates });
  } catch (error) {
    failure = error;
    const log = error instanceof QuestshopError ? runtime.logger.info.bind(runtime.logger) : runtime.logger.error.bind(runtime.logger);
    log({ error: safeError(error), traceId: interaction.__questshopTraceId, interactionId: interaction.id,
      route: parseCustomId(interaction.customId)?.route ?? interaction.commandName ?? null,
      acknowledgement: acknowledgementOf(interaction) }, error instanceof QuestshopError ? 'interaction rejected' : 'interaction failed');
    return ephemeralError(interaction, error).catch(() => null);
  } finally {
    metrics.complete(failure);
  }
}
