import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { encryptSecret, decryptSecret } from '../../adapters/crypto/keyring.js';
import { withTransaction } from '../../db/transaction.js';
import { QuestshopError, AuthorizationError } from '../../shared/errors.js';
import { sumCents } from '../../shared/money.js';
import { createQuestApiClient, profileFromEnv } from '../../quest-engine/api/client.js';
import { getPersistentDiscordRateLimitCoordinator } from '../../quest-engine/rate-limits/coordinator.js';
import { ingestDiscovery, resolveSaleEligibility } from '../catalog/service.js';
import { resolvePrice } from '../pricing/resolver.js';
import { evaluateExpiryAdmission } from '../catalog/expiry.js';
import { enqueueProjection } from '../outbox/service.js';
import { recordTransition } from '../shared/transition.js';
import { reserveOrderItemsInTransaction } from '../wallet/service.js';
import {
  ENGINE_VERSION,
  EXECUTOR_VERSION,
  QUEST_CONTRACT_VERSION,
  RUNNER_STATE_SCHEMA_VERSION,
} from '../../config/versions.js';

const SESSION_TTL_MINUTES = 15;
const PREFLIGHT_TTL_SECONDS = 30;

function lineId() {
  return randomBytes(9).toString('base64url');
}
function selectionHash(items, configVersion) {
  const canonical = items.map((item) => `${item.line_id}:${item.quest_id}:${item.price_cents}:${item.price_rule_id}:${item.contract_hash ?? ''}`)
    .sort().join('|');
  return createHash('sha256').update(`${configVersion}|${canonical}`).digest('hex');
}

function preflightPayload({ session, credential, items, profile, quests, dbNow }) {
  const fresh = new Map(quests.map((quest) => [quest.id, quest]));
  return JSON.stringify({
    sessionId: session.id,
    traceId: session.trace_id,
    actorId: session.actor_id,
    guildId: session.guild_id,
    accountId: credential.account_id,
    profileId: String(profile.id),
    checkedAt: new Date(dbNow).toISOString(),
    selection: items.map((item) => ({ lineId: item.line_id, questId: item.quest_id,
      priceCents: String(item.price_cents), metadataRevision: String(item.metadata_revision),
      contractHash: item.contract_hash ?? null })),
    quests: items.map((item) => {
      const quest = fresh.get(item.quest_id);
      return { id: item.quest_id, completed: Boolean(quest?.completed),
        progress: Number(quest?.progress ?? 0), expiresAt: quest?.expiresAt ?? null };
    }),
  });
}

function preflightKey(env) {
  const keyring = env.DATA_ENCRYPTION_KEYS_JSON;
  const encoded = keyring?.keys?.[keyring?.current];
  if (typeof encoded !== 'string') throw new QuestshopError('PREFLIGHT_KEY_UNAVAILABLE', 'Preflight key ไม่พร้อมใช้งาน');
  return Buffer.from(encoded, 'base64');
}

function signPreflight(snapshot, profile, quests, env) {
  return createHmac('sha256', preflightKey(env))
    .update(preflightPayload({ ...snapshot, profile, quests })).digest('base64url');
}

function verifyPreflightSignature(preflight, env) {
  if (typeof preflight.signature !== 'string') return false;
  const expected = signPreflight(preflight, preflight.profile, preflight.quests, env);
  const actual = Buffer.from(preflight.signature);
  const value = Buffer.from(expected);
  return actual.length === value.length && timingSafeEqual(actual, value);
}

function avatarUrl(profile) {
  if (!profile?.id || !profile?.avatar) return null;
  const extension = profile.avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.${extension}?size=256`;
}

async function activeConfigVersion(client) {
  return Number((await client.query(
    'SELECT COALESCE(MAX(version), 1)::bigint AS version FROM config_versions',
  )).rows[0].version);
}

export async function createSession({
  discordUserId,
  guildId,
  channelId,
  messageId,
  token,
  env,
  runnerConcurrency = env.RUNNER_CONCURRENCY,
}, context, options = {}) {
  const apiFactory = options.questApiFactory ?? createQuestApiClient;
  const api = apiFactory({ token, profile: profileFromEnv(env),
    coordinator: options.coordinator ?? getPersistentDiscordRateLimitCoordinator(options.pool) });
  const [profile, quests] = await Promise.all([
    api.fetchCurrentUser(),
    api.fetchQuests(),
  ]);
  if (!profile?.id) throw new QuestshopError('TOKEN_PROFILE_INVALID', 'ไม่สามารถตรวจบัญชี Discord ได้');
  const discoveries = new Map();
  for (const quest of quests) {
    discoveries.set(quest.id, await ingestDiscovery({
      normalized: quest,
      source: 'CUSTOMER_CHECKOUT',
      runnerConcurrency,
    }, context, options));
  }
  const candidates = [];
  for (const quest of quests) {
    if (quest.completed) continue;
    const eligibility = await resolveSaleEligibility({
      questId: quest.id,
      progressActual: quest.progress,
      runnerConcurrency,
      allowCustomerAccount: true,
    }, context, options);
    if (eligibility.eligible) candidates.push({ quest, eligibility });
  }

  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const sessionId = uuidv7();
    const configVersion = await activeConfigVersion(client);
    const encrypted = encryptSecret(token, env.DATA_ENCRYPTION_KEYS_JSON, `checkout:${sessionId}:${guildId}`);
    const session = (await client.query(`
      INSERT INTO interaction_sessions(
        id, actor_id, guild_id, channel_id, message_id, operation,
        config_version, payload, trace_id, expires_at
      ) VALUES ($1,$2,$3,$4,$5,'CHECKOUT',$6,$7,$8,
        transaction_timestamp() + interval '${SESSION_TTL_MINUTES} minutes') RETURNING *
    `, [sessionId, discordUserId, guildId, channelId, messageId, configVersion, {
      accountId: String(profile.id),
      username: profile.global_name ?? profile.username ?? String(profile.id),
      avatarUrl: avatarUrl(profile),
    }, context.traceId])).rows[0];
    await client.query(`
      INSERT INTO checkout_credentials(
        session_id, account_id, key_version, nonce, ciphertext, auth_tag
      ) VALUES ($1,$2,$3,$4,$5,$6)
    `, [
      sessionId, String(profile.id), encrypted.keyVersion,
      encrypted.nonce, encrypted.ciphertext, encrypted.authTag,
    ]);
    for (const { quest, eligibility } of candidates) {
      await client.query(`
      INSERT INTO checkout_quest_options(
        id, session_id, line_id, quest_id, quest_name, task_type,
          price_cents, price_rule_id, metadata_revision, contract_hash, deadline_at, progress_actual,admission_scope
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `, [
        uuidv7(), sessionId, lineId(), quest.id, quest.name, quest.eventName,
        eligibility.price.amount_cents, eligibility.price.id,
        eligibility.quest.current_metadata_revision, eligibility.quest.current_contract_hash,
        eligibility.quest.expires_at, quest.progress,
        eligibility.admissionScope,
      ]);
    }
    for (const quest of quests) {
      const monitorSeen = (await client.query(`SELECT 1 FROM quest_metadata_revisions
        WHERE quest_id=$1 AND source='MONITOR' LIMIT 1`, [quest.id])).rowCount > 0;
      if (monitorSeen) continue;
      const discovery = discoveries.get(quest.id);
      const customerDiscovery = (await client.query(`INSERT INTO customer_quest_discoveries(
        id,checkout_session_id,quest_id,metadata_revision,discord_user_id,account_id,
        account_username,account_avatar_url,trace_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(checkout_session_id,quest_id) DO NOTHING RETURNING *`, [
        uuidv7(), sessionId, quest.id, discovery?.revision ?? 0, discordUserId,
        String(profile.id), profile.global_name ?? profile.username ?? String(profile.id),
        avatarUrl(profile), context.traceId,
      ])).rows[0];
      if (customerDiscovery) await enqueueProjection(client, {
        projectionType: 'CUSTOMER_QUEST_DISCOVERY', aggregateType: 'CUSTOMER_QUEST_DISCOVERY',
        aggregateId: customerDiscovery.id, aggregateVersion: 1,
        surfaceKey: 'LOG_QUEST_OPERATIONS', context,
      });
    }
    await enqueueProjection(client, {
      projectionType: 'CHECKOUT_AUDIT', aggregateType: 'INTERACTION_SESSION', aggregateId: sessionId,
      aggregateVersion: session.state_version, surfaceKey: 'LOG_QUEST_OPERATIONS', context,
    });
    return { session, profile, optionsCount: candidates.length };
  });
}

function coreMetadataPresent(quest) {
  return Boolean(quest?.name && quest.task_type && Number(quest.task_target) > 0
    && quest.url && quest.starts_at && quest.expires_at && quest.executor_id);
}

async function validateOptionAdmission(client, option, quest) {
  if (option.admission_scope === 'PUBLIC') {
    if (quest?.sale_state !== 'OPEN' || quest.analysis_state !== 'SUPPORTED') {
      throw new QuestshopError('QUEST_NOT_FOR_SALE', `Quest ${option.quest_name} ไม่เปิดขายแล้ว`);
    }
    return;
  }
  if (option.admission_scope === 'CUSTOMER_ACCOUNT'
    && quest?.analysis_state === 'SUPPORTED'
    && !['PAUSED', 'EXPIRED'].includes(quest.sale_state)
    && coreMetadataPresent(quest)) return;
  throw new QuestshopError('QUEST_NOT_FOR_SALE', `Quest ${option.quest_name} ไม่รองรับสำหรับบัญชีนี้`);
}

async function lockAuthorizedSession(client, { sessionId, actorId, guildId, channelId = null,
  messageId = null }, { allowConfirmed = false } = {}) {
  const session = (await client.query(`
    SELECT *, expires_at > clock_timestamp() AS is_fresh
    FROM interaction_sessions WHERE id = $1 FOR UPDATE
  `, [sessionId])).rows[0];
  const confirmedReplay = allowConfirmed && session?.state === 'CONFIRMED'
    && typeof session.payload?.orderId === 'string';
  if ((!confirmedReplay && session?.state !== 'ACTIVE') || (!confirmedReplay && !session.is_fresh)) {
    throw new QuestshopError('SESSION_EXPIRED', 'เซสชันหมดอายุ กรุณาเริ่มใหม่');
  }
  if (session.actor_id !== actorId || session.guild_id !== guildId) {
    throw new AuthorizationError('เซสชันนี้เป็นของผู้ใช้อื่น');
  }
  if (session.operation !== 'CHECKOUT') {
    throw new AuthorizationError('เซสชันนี้ไม่ใช่ Checkout session');
  }
  if (channelId && session.channel_id !== channelId) {
    throw new AuthorizationError('เซสชันนี้ถูกเรียกจากห้องอื่น');
  }
  if (messageId && session.message_id && session.message_id !== messageId) {
    throw new AuthorizationError('เซสชันนี้ถูกเรียกจากข้อความอื่น');
  }
  return session;
}

async function orderResult(client, orderId) {
  const order = (await client.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0];
  if (!order) throw new QuestshopError('CHECKOUT_RESULT_MISSING', 'ไม่พบผลลัพธ์ Order เดิม');
  const items = (await client.query(`
    SELECT i.*,q.orbs FROM order_items i LEFT JOIN quests q ON q.quest_id=i.quest_id
    WHERE i.order_id = $1 ORDER BY i.sequence_number, i.id
  `, [orderId])).rows;
  if (!items.length) throw new QuestshopError('CHECKOUT_RESULT_MISSING', 'ไม่พบผลลัพธ์ Order เดิม');
  const wallet = (await client.query(`SELECT available_cents,reserved_cents FROM wallets
    WHERE discord_user_id=$1`, [order.discord_user_id])).rows[0];
  return { orderId, order, items, wallet,
    totalCents: sumCents(items.map((item) => item.price_cents)) };
}

async function loadConfirmedOrder({ sessionId, actorId, guildId, channelId = null,
  messageId = null }, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, async (client) => {
    const session = (await client.query(`
      SELECT * FROM interaction_sessions WHERE id = $1
    `, [sessionId])).rows[0];
    if (!session) throw new QuestshopError('SESSION_NOT_FOUND', 'ไม่พบ Checkout session');
    if (session.actor_id !== actorId || session.guild_id !== guildId) {
      throw new AuthorizationError('เซสชันนี้เป็นของผู้ใช้อื่น');
    }
    if (session.operation !== 'CHECKOUT') {
      throw new AuthorizationError('เซสชันนี้ไม่ใช่ Checkout session');
    }
    if (channelId && session.channel_id !== channelId) {
      throw new AuthorizationError('เซสชันนี้ถูกเรียกจากห้องอื่น');
    }
    if (messageId && session.message_id && session.message_id !== messageId) {
      throw new AuthorizationError('เซสชันนี้ถูกเรียกจากข้อความอื่น');
    }
    if (session.state !== 'CONFIRMED' || typeof session.payload?.orderId !== 'string') return null;
    return { ...(await orderResult(client, session.payload.orderId)), idempotent: true };
  });
}

export async function updateSelection({ sessionId, actorId, guildId, channelId = null,
  messageId = null, lineIds, selected }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const session = await lockAuthorizedSession(client, { sessionId, actorId, guildId, channelId, messageId });
    const currentConfigVersion = await activeConfigVersion(client);
    if (currentConfigVersion !== Number(session.config_version)) {
      throw new QuestshopError('QUOTE_EXPIRED', 'การตั้งค่าร้านเปลี่ยนไป กรุณาเริ่ม Quote ใหม่');
    }
    const result = await client.query(`
      UPDATE checkout_quest_options SET selected = $3
      WHERE session_id = $1 AND line_id = ANY($2::text[]) RETURNING *
    `, [sessionId, lineIds, selected]);
    await client.query(`
      UPDATE interaction_sessions SET state_version = state_version + 1,
        updated_at = transaction_timestamp() WHERE id = $1
    `, [sessionId]);
    return { session, changed: result.rowCount };
  });
}

export async function getSelectionPage({ sessionId, actorId, guildId, channelId = null,
  messageId = null, direction = 0 }, _context, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const session = await lockAuthorizedSession(client, { sessionId, actorId, guildId, channelId, messageId });
    const summary = (await client.query(`SELECT count(*)::integer AS count,
      count(*) FILTER (WHERE selected)::integer AS selected_count,
      COALESCE(sum(price_cents) FILTER (WHERE selected),0)::bigint AS selected_total_cents
      FROM checkout_quest_options WHERE session_id=$1`, [sessionId])).rows[0];
    const count = Number(summary.count);
    const pages = Math.max(1, Math.ceil(count / 25));
    const oldPage = Number(session.payload?.page ?? 0);
    const page = Math.max(0, Math.min(pages - 1, oldPage + direction));
    if (page !== oldPage) {
      await client.query(`
        UPDATE interaction_sessions SET payload = jsonb_set(payload, '{page}', to_jsonb($2::integer)),
          state_version = state_version + 1, updated_at = transaction_timestamp()
        WHERE id = $1
      `, [sessionId, page]);
    }
    const rows = (await client.query(`
      SELECT option.line_id,option.quest_id,option.quest_name,option.task_type,
        option.price_cents,option.selected,option.progress_actual,option.deadline_at,quest.orbs
      FROM checkout_quest_options option LEFT JOIN quests quest ON quest.quest_id=option.quest_id
      WHERE option.session_id = $1
      ORDER BY option.created_at,option.id OFFSET $2 LIMIT 25
    `, [sessionId, page * 25])).rows;
    const wallet = (await client.query('SELECT available_cents FROM wallets WHERE discord_user_id=$1',
      [actorId])).rows[0];
    return { session: { ...session, payload: { ...session.payload, page } }, rows, page, pages, count,
      selectedCount: Number(summary.selected_count), selectedTotalCents: summary.selected_total_cents,
      walletAvailableCents: wallet?.available_cents ?? 0 };
  });
}

export async function selectAll({ sessionId, actorId, guildId, channelId = null,
  messageId = null }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const session = await lockAuthorizedSession(client, { sessionId, actorId, guildId, channelId, messageId });
    const result = await client.query(`
      UPDATE checkout_quest_options SET selected = true WHERE session_id = $1 RETURNING id
    `, [sessionId]);
    return { session, changed: result.rowCount };
  });
}

export async function buildQuote({ sessionId, actorId, guildId, channelId = null,
  messageId = null, runnerConcurrency = 2 }, _context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const session = await lockAuthorizedSession(client, { sessionId, actorId, guildId, channelId, messageId });
    const items = (await client.query(`
      SELECT option.*,quest.orbs FROM checkout_quest_options option
      LEFT JOIN quests quest ON quest.quest_id=option.quest_id
      WHERE option.session_id = $1 AND option.selected = true ORDER BY option.created_at,option.id
    `, [sessionId])).rows;
    if (!items.length) throw new QuestshopError('NO_QUEST_SELECTED', 'กรุณาเลือก Quest อย่างน้อยหนึ่งรายการ');
    for (const item of items) {
      const quest = (await client.query('SELECT * FROM quests WHERE quest_id=$1 FOR SHARE', [item.quest_id])).rows[0];
      if (!quest || !item.contract_hash || item.contract_hash !== quest.current_contract_hash) {
        throw new QuestshopError('QUEST_CONTRACT_CHANGED', 'รูปแบบ Quest เปลี่ยนไป กรุณาเริ่มเลือกใหม่');
      }
      await validateOptionAdmission(client, item, quest);
      const price = await resolvePrice(client, { questId: quest.quest_id, taskType: quest.task_type });
      if (!price || price.id !== item.price_rule_id || BigInt(price.amount_cents) !== BigInt(item.price_cents)) {
        throw new QuestshopError('QUOTE_EXPIRED', 'ราคามีการเปลี่ยนแปลง กรุณาเริ่ม Quote ใหม่');
      }
      const expiry = await evaluateExpiryAdmission(client, { quest: { ...quest,
        progress_actual: item.progress_actual }, runnerConcurrency });
      if (!expiry.eligible) throw new QuestshopError('QUEST_INSUFFICIENT_TIME',
        `เวลา Quest ${item.quest_name} ไม่เพียงพอ`);
    }
    const totalCents = sumCents(items.map((item) => item.price_cents));
    const wallet = (await client.query('SELECT available_cents,reserved_cents FROM wallets WHERE discord_user_id=$1',
      [actorId])).rows[0];
    if (BigInt(wallet?.available_cents ?? 0) < totalCents) {
      throw new QuestshopError('WALLET_INSUFFICIENT', 'เครดิตไม่เพียงพอสำหรับรายการที่เลือก กรุณาเติมเครดิตหรือลดจำนวน Quest');
    }
    const quoteHash = selectionHash(items, session.config_version);
    const updated = (await client.query(`UPDATE interaction_sessions SET
      payload=payload||jsonb_build_object('quoteHash',$2::text,'quotedAt',transaction_timestamp()),
      state_version=state_version+1,updated_at=transaction_timestamp() WHERE id=$1 RETURNING *`,
    [sessionId, quoteHash])).rows[0];
    return { session: updated, items, quoteHash, totalCents,
      walletAvailableCents: wallet.available_cents, walletReservedCents: wallet.reserved_cents };
  });
}

async function loadPreflight({ sessionId, actorId, guildId, channelId, messageId, env }, options) {
  const snapshot = await withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, async (client) => {
    const session = await lockAuthorizedSession(client, { sessionId, actorId, guildId, channelId, messageId });
    const credential = (await client.query(`
      SELECT * FROM checkout_credentials WHERE session_id = $1
    `, [sessionId])).rows[0];
    const items = (await client.query(`
      SELECT * FROM checkout_quest_options WHERE session_id = $1 AND selected = true
      ORDER BY created_at, id
    `, [sessionId])).rows;
    const dbNow = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now;
    return { session, credential, items, dbNow };
  });
  if (!snapshot.credential) {
    throw new QuestshopError('CHECKOUT_CREDENTIAL_MISSING', 'ไม่พบ Credential ของ Checkout session');
  }
  if (!snapshot.items.length) throw new QuestshopError('NO_QUEST_SELECTED', 'กรุณาเลือก Quest อย่างน้อยหนึ่งรายการ');
  const token = decryptSecret({
    keyVersion: snapshot.credential.key_version,
    nonce: snapshot.credential.nonce,
    ciphertext: snapshot.credential.ciphertext,
    authTag: snapshot.credential.auth_tag,
  }, env.DATA_ENCRYPTION_KEYS_JSON, `checkout:${sessionId}:${guildId}`);
  const apiFactory = options.questApiFactory ?? createQuestApiClient;
  const api = apiFactory({ token, profile: profileFromEnv(env),
    coordinator: options.coordinator ?? getPersistentDiscordRateLimitCoordinator(options.pool) });
  const [profile, quests] = await Promise.all([api.fetchCurrentUser(), api.fetchQuests()]);
  if (String(profile.id) !== snapshot.credential.account_id) {
    throw new QuestshopError('TOKEN_ACCOUNT_CHANGED', 'Token ไม่ตรงกับบัญชีที่ตรวจครั้งแรก');
  }
  const preflight = { ...snapshot, token, profile, quests };
  return { ...preflight, signature: signPreflight(preflight, profile, quests, env) };
}

async function validateConfirmationSession(client, sessionInput, preflight, env) {
  const { sessionId, actorId, guildId, channelId, messageId } = sessionInput;
  const session = await lockAuthorizedSession(client, { sessionId, actorId, guildId, channelId, messageId }, {
    allowConfirmed: true,
  });
  if (session.state === 'CONFIRMED' && typeof session.payload?.orderId === 'string') {
    return { session, selected: [], idempotentOrderId: session.payload.orderId };
  }
  if (session.trace_id !== preflight.session.trace_id) {
    throw new QuestshopError('PREFLIGHT_TRACE_MISMATCH', 'ผลการตรวจบัญชีไม่ตรงกับ Checkout session');
  }
  const currentConfigVersion = await activeConfigVersion(client);
  if (currentConfigVersion !== Number(session.config_version)) {
    throw new QuestshopError('QUOTE_EXPIRED', 'การตั้งค่าร้านเปลี่ยนไป กรุณาเริ่ม Quote ใหม่');
  }
  const freshEnough = (await client.query(`
    SELECT $1::timestamptz >= clock_timestamp() - interval '${PREFLIGHT_TTL_SECONDS} seconds' AS ok
  `, [preflight.dbNow])).rows[0].ok;
  if (!freshEnough) throw new QuestshopError('PREFLIGHT_EXPIRED', 'การตรวจบัญชีหมดอายุ กรุณายืนยันใหม่');
  if (!verifyPreflightSignature(preflight, env)) {
    throw new QuestshopError('PREFLIGHT_SIGNATURE_INVALID', 'ผลการตรวจบัญชีไม่ถูกต้อง กรุณาเริ่มใหม่');
  }
  const queueCount = Number((await client.query(`
    SELECT count(*)::integer AS count FROM runner_jobs
    WHERE state IN ('QUEUED','LEASED','RUNNING','WAITING_RATE_LIMIT','WAITING_RETRY')
  `)).rows[0].count);
  if (queueCount >= 500) throw new QuestshopError('QUEUE_FULL', 'คิวงานเต็ม กรุณาลองใหม่ภายหลัง');
  const selected = (await client.query(`
    SELECT * FROM checkout_quest_options WHERE session_id = $1 AND selected = true
    ORDER BY created_at, id FOR UPDATE
  `, [sessionId])).rows;
  if (!selected.length) throw new QuestshopError('NO_QUEST_SELECTED', 'กรุณาเลือก Quest');
  if (!session.payload?.quoteHash
    || session.payload.quoteHash !== selectionHash(selected, session.config_version)) {
    throw new QuestshopError('QUOTE_EXPIRED', 'รายการที่เลือกเปลี่ยนไป กรุณาตรวจ Quote ใหม่');
  }
  return { session, selected };
}

function withSessionTrace(context, session) {
  return { ...context, traceId: session.trace_id };
}

async function validateSelectedOptions(client, selected, freshById, runnerConcurrency) {
  const validated = [];
  for (const option of selected) {
      const fresh = freshById.get(option.quest_id);
      if (!fresh || fresh.completed) {
        throw new QuestshopError('QUEST_EXTERNALLY_COMPLETED', `Quest ${option.quest_name} ทำเสร็จจากที่อื่นแล้ว`);
      }
      const quest = (await client.query(
        'SELECT * FROM quests WHERE quest_id = $1 FOR SHARE', [option.quest_id],
      )).rows[0];
      if (!quest || !option.contract_hash || option.contract_hash !== quest.current_contract_hash
        || option.contract_hash !== fresh.contractHash) {
        throw new QuestshopError('QUEST_CONTRACT_CHANGED', 'รูปแบบ Quest เปลี่ยนไป กรุณาตรวจรายการใหม่');
      }
      await validateOptionAdmission(client, option, quest);
      const price = await resolvePrice(client, { questId: quest.quest_id, taskType: quest.task_type });
      if (!price || BigInt(price.amount_cents) !== BigInt(option.price_cents) || price.id !== option.price_rule_id) {
        throw new QuestshopError('QUOTE_EXPIRED', 'ราคามีการเปลี่ยนแปลง กรุณาตรวจ Quote ใหม่');
      }
      const expiry = await evaluateExpiryAdmission(client, {
        quest: { ...quest, progress_actual: fresh.progress },
        runnerConcurrency,
      });
      if (!expiry.eligible) throw new QuestshopError('QUEST_INSUFFICIENT_TIME', `เวลา Quest ${option.quest_name} ไม่เพียงพอ`);
    validated.push({ option, fresh, quest, price });
  }
  return validated;
}

async function createOrder(client, actorId, preflight, context, env) {
  const orderId = uuidv7();
  await client.query(`
      INSERT INTO orders(
        id, discord_user_id, account_id, account_username, account_avatar_url,
        trace_id, prelaunch
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [
      orderId, actorId, String(preflight.profile.id),
      preflight.profile.global_name ?? preflight.profile.username,
      avatarUrl(preflight.profile), context.traceId, env.PRELAUNCH,
  ]);
  try {
    await client.query(`
        INSERT INTO active_quest_accounts(account_id, order_id) VALUES ($1,$2)
    `, [String(preflight.profile.id), orderId]);
  } catch (error) {
    if (error.code === '23505') {
      throw new QuestshopError('ACCOUNT_ACTIVE_ORDER', 'บัญชี Quest นี้มีงานที่กำลังดำเนินการอยู่');
    }
    throw error;
  }
  return orderId;
}

async function storeOrderCredential(client, orderId, preflight, env, guildId) {
  const orderSecret = encryptSecret(preflight.token, env.DATA_ENCRYPTION_KEYS_JSON, `order:${orderId}:${guildId}`);
  await client.query(`
      INSERT INTO order_credentials(
        order_id, account_id, key_version, nonce, ciphertext, auth_tag
      ) VALUES ($1,$2,$3,$4,$5,$6)
  `, [
      orderId, String(preflight.profile.id), orderSecret.keyVersion,
      orderSecret.nonce, orderSecret.ciphertext, orderSecret.authTag,
  ]);
}

async function createOrderItems(client, orderId, session, validated) {
  // An order has no item limit.  Insert all its durable items in one statement
  // so a large checkout does not keep a SERIALIZABLE transaction open for one
  // round-trip per quest.  Only the first item is materialized as a runnable
  // job below; the remainder stay RESERVED until their turn.
  const values = validated.map(({ option, quest, fresh }, index) => ({
    id: uuidv7(),
    sequence_number: index + 1,
    quest_id: option.quest_id,
    quest_name: option.quest_name,
    task_type: option.task_type,
    price_cents: String(option.price_cents),
    price_rule_id: option.price_rule_id,
    metadata_revision: String(quest.current_metadata_revision),
    contract_hash: option.contract_hash,
    progress_actual: Number(fresh.progress),
    progress_bucket: Math.floor(Math.min(99.999, Number(fresh.progress)) / 25) * 25,
    deadline_at: option.deadline_at,
    admission_scope: option.admission_scope,
  }));
  const result = await client.query(`
    INSERT INTO order_items(
      id, order_id, sequence_number, quest_id, quest_name, task_type,
      price_cents, price_rule_id, config_version, metadata_revision,
      engine_version, executor_version, contract_version, contract_hash,
      runner_state_schema_version, state, progress_actual, progress_bucket, deadline_at, admission_scope
    )
    SELECT rows.id, $2, rows.sequence_number, rows.quest_id, rows.quest_name, rows.task_type,
      rows.price_cents, rows.price_rule_id, $3, rows.metadata_revision,
      $4, $5, $6, rows.contract_hash, $7, 'SELECTED', rows.progress_actual, rows.progress_bucket, rows.deadline_at, rows.admission_scope
    FROM jsonb_to_recordset($1::jsonb) AS rows(
      id uuid,
      sequence_number integer,
      quest_id text,
      quest_name text,
      task_type text,
      price_cents bigint,
      price_rule_id uuid,
      metadata_revision bigint,
      contract_hash text,
      progress_actual numeric(7,3),
      progress_bucket smallint,
      deadline_at timestamptz,
      admission_scope text
    )
    ORDER BY rows.sequence_number
    RETURNING *
  `, [JSON.stringify(values), orderId, session.config_version, ENGINE_VERSION,
    EXECUTOR_VERSION, QUEST_CONTRACT_VERSION, RUNNER_STATE_SCHEMA_VERSION]);
  return result.rows;
}

async function queueFirstOrderItem(client, itemRows, actorId, preflight, context) {
  const first = itemRows[0];
  const queued = (await client.query(`
      UPDATE order_items SET state = 'QUEUED', state_version = state_version + 1,
        updated_at = transaction_timestamp() WHERE id = $1 AND state = 'RESERVED' RETURNING *
  `, [first.id])).rows[0];
  await recordTransition(client, {
      aggregateType: 'ORDER_ITEM', aggregateId: first.id,
      fromState: 'RESERVED', toState: 'QUEUED', stateVersion: queued.state_version, context,
  });
  await client.query(`
      INSERT INTO runner_jobs(
        id, order_item_id, discord_user_id, account_id, state, deadline_at,
        engine_version, executor_version, contract_version, contract_hash,
        runner_state_schema_version, trace_id
      ) VALUES ($1,$2,$3,$4,'QUEUED',$5,$6,$7,$8,$9,$10,$11)
  `, [
      uuidv7(), first.id, actorId, String(preflight.profile.id), first.deadline_at,
      ENGINE_VERSION, EXECUTOR_VERSION, QUEST_CONTRACT_VERSION, first.contract_hash,
      RUNNER_STATE_SCHEMA_VERSION, context.traceId,
  ]);
  await client.query(`
      INSERT INTO scheduler_users(discord_user_id) VALUES ($1)
      ON CONFLICT (discord_user_id) DO NOTHING
  `, [actorId]);
}

async function enqueueOrderHistory(client, itemRows, context) {
  for (let index = 0; index < itemRows.length; index += 1) {
      const item = itemRows[index];
      const notBefore = (await client.query(
        "SELECT clock_timestamp() + make_interval(secs => $1) AS value",
        [Math.floor(index / 5) * 10],
      )).rows[0].value;
    await enqueueProjection(client, {
        projectionType: 'QUEST_HISTORY', aggregateType: 'ORDER_ITEM', aggregateId: item.id,
        aggregateVersion: item.state_version + (index === 0 ? 1 : 0),
        surfaceKey: 'QUEST_HISTORY', notBefore, context,
    });
  }
}

async function finishCheckout(client, sessionId, orderId) {
  await client.query(`
    UPDATE interaction_sessions SET state = 'CONFIRMED', state_version = state_version + 1,
        payload = payload || jsonb_build_object('orderId', $2::text),
        updated_at = transaction_timestamp() WHERE id = $1
  `, [sessionId, orderId]);
  await client.query('DELETE FROM checkout_credentials WHERE session_id = $1', [sessionId]);
}

export async function confirmOrder({ sessionId, actorId, guildId, channelId = null,
  messageId = null, env, runnerConcurrency = env.RUNNER_CONCURRENCY }, context, options = {}) {
  const input = { sessionId, actorId, guildId, channelId, messageId };
  const existing = await loadConfirmedOrder(input, options);
  if (existing) return existing;
  let preflight;
  try {
    preflight = await loadPreflight({ ...input, env }, options);
  } catch (error) {
    if (error.code === 'SESSION_EXPIRED' || error.code === 'CHECKOUT_CREDENTIAL_MISSING') {
      const replay = await loadConfirmedOrder(input, options);
      if (replay) return replay;
    }
    throw error;
  }
  const freshById = new Map(preflight.quests.map((quest) => [quest.id, quest]));
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const { session, selected, idempotentOrderId } = await validateConfirmationSession(client, input, preflight, env);
    if (idempotentOrderId) {
      return { ...(await orderResult(client, idempotentOrderId)), idempotent: true };
    }
    const correlatedContext = withSessionTrace(context, session);
    const validated = await validateSelectedOptions(client, selected, freshById, runnerConcurrency);
    const orderId = await createOrder(client, actorId, preflight, correlatedContext, env);
    await storeOrderCredential(client, orderId, preflight, env, guildId);
    const itemRows = await createOrderItems(client, orderId, session, validated);
    await reserveOrderItemsInTransaction(client, {
      discordUserId: actorId,
      items: itemRows.map((item) => ({ itemId: item.id, amountCents: item.price_cents })),
    }, correlatedContext);
    await queueFirstOrderItem(client, itemRows, actorId, preflight, correlatedContext);
    await enqueueOrderHistory(client, itemRows, correlatedContext);
    await finishCheckout(client, sessionId, orderId);
    return orderResult(client, orderId);
  });
}

export async function expireSessions(_input, _context, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const result = await client.query(`
      WITH expired AS (
        SELECT id FROM interaction_sessions
        WHERE state IN ('ACTIVE','PENDING_BIND') AND expires_at <= clock_timestamp()
        ORDER BY expires_at,id LIMIT 500 FOR UPDATE SKIP LOCKED
      )
      UPDATE interaction_sessions AS session SET state = 'EXPIRED', state_version = session.state_version + 1,
        updated_at = clock_timestamp()
      FROM expired WHERE session.id = expired.id RETURNING session.id
    `);
    if (result.rows.length) {
      await client.query('DELETE FROM checkout_credentials WHERE session_id=ANY($1::uuid[])',
        [result.rows.map((row) => row.id)]);
    }
    await client.query(`
      WITH stale AS (
        SELECT id FROM interaction_sessions
        WHERE state IN ('CONFIRMED','EXPIRED','CANCELLED','TERMINAL')
          AND updated_at < clock_timestamp() - interval '7 days'
        ORDER BY updated_at,id LIMIT 500 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM interaction_sessions AS session USING stale WHERE session.id = stale.id
    `);
    return result.rowCount;
  });
}
