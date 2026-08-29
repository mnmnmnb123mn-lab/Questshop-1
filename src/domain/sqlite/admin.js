import { randomUUID } from 'node:crypto';
import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';
import { currentFeatureGates } from './gates.js';
import { enqueueNotificationInTransaction } from './notifications.js';
import { QuestshopError } from '../../shared/errors.js';
import { resolveTopupFinancialReview } from './payments.js';
import { encryptCredential } from './crypto.js';
import { resolveOrderItemReview } from './orders.js';
import { supportedTaskTypes } from './pricing.js';
import { appendWalletTransactionInTransaction } from './wallet.js';
import { enqueueJobInTransaction } from './jobs.js';

export const ADMIN_AUDIT_ALLOWED_FIELDS = Object.freeze({
  FEATURE_GATE_CHANGE: ['gate', 'enabled'],
  PROMOTION_UPDATED: ['name', 'state', 'startsAt', 'endsAt', 'basisPoints', 'minimumCents', 'maximumBonusCents'],
  MONITOR_UPDATED: ['label', 'state', 'cooldownUntil'],
  MONITOR_SCAN_QUEUED: ['queued'],
  DLQ_RETRY: ['notificationType', 'destination'],
  PROMOTION_UPDATED: ['name', 'state', 'startsAt', 'endsAt', 'basisPoints', 'minimumCents', 'maximumBonusCents'],
  WALLET_ADJUSTMENT: ['availableDeltaCents', 'reservedDeltaCents'],
  WALLET_ADJUSTMENT: ['availableDeltaCents', 'reservedDeltaCents'],
  MANUAL_REVIEW_DECISION: ['decision', 'status'],
  TOPUP_REVERSED: ['status', 'walletTransactionId'],
  ORDER_ITEM_REFUNDED: ['state', 'refundCents'],
  DISCOVERY_RETRY: ['queued'],
  QUEST_ANNOUNCED: ['monitorVerified'],
  SURFACE_SETUP: ['channelId', 'messageId'],
  PRICE_UPDATED: ['taskType', 'amountCents'],
  RECEIVER_UPDATED: ['last4'],
  MONITOR_UPDATED: ['label', 'state', 'cooldownUntil'],
});

function filtered(action, value) {
  if (!value || typeof value !== 'object') return null;
  const allowed = ADMIN_AUDIT_ALLOWED_FIELDS[action] ?? [];
  return Object.fromEntries(allowed.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}

export function appendAdminAuditInTransaction(db, { actorId, action, targetType, targetId, reason = null, before = null, after = null, traceId = randomUUID(), timestamp = nowMs() }) {
  const id = randomUUID();
  db.prepare(`INSERT INTO admin_audit(id,actor_id,action,target_type,target_id,reason,before_json,after_json,trace_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, actorId, action, targetType, targetId, reason,
    before == null ? null : JSON.stringify(filtered(action, before)), after == null ? null : JSON.stringify(filtered(action, after)), traceId, timestamp);
  enqueueNotificationInTransaction(db, { notificationType: 'ADMIN_LOG', aggregateType: 'ADMIN_AUDIT', aggregateId: id,
    destination: 'LOG_ADMIN', payload: { auditId: id }, timestamp });
  return id;
}

export function changeFeatureGate(db, { gate, enabled, actorId, reason = '' }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const current = currentFeatureGates(db);
    if (!Object.hasOwn(current, gate)) throw new QuestshopError('FEATURE_GATE_UNKNOWN', 'ไม่พบสวิตช์ระบบนี้');
    const next = { ...current, [gate]: enabled === true };
    db.prepare(`INSERT INTO settings(key,value_json,updated_at,updated_by) VALUES('feature_gates',?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .run(JSON.stringify(next), timestamp, actorId);
    appendAdminAuditInTransaction(db, { actorId, action: 'FEATURE_GATE_CHANGE', targetType: 'FEATURE_GATE', targetId: gate,
      reason, before: { gate, enabled: current[gate] }, after: { gate, enabled: next[gate] }, timestamp });
    return next;
  });
}

export function confirmFinancialReview(db, input) {
  return resolveTopupFinancialReview(db, input);
}

function updateRuntimeValuesInTransaction(db, values, actorId, timestamp) {
  const version = Number(db.prepare("SELECT value_json FROM settings WHERE key='runtime_config_version'").get()?.value_json ?? '1') + 1;
  db.prepare(`INSERT INTO settings(key,value_json,updated_at,updated_by) VALUES('runtime_config',?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
    .run(JSON.stringify(values), timestamp, actorId);
  db.prepare(`INSERT INTO settings(key,value_json,updated_at,updated_by) VALUES('runtime_config_version',?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
    .run(JSON.stringify(version), timestamp, actorId);
}

export function setQuestPrice(db, { taskType, amountCents, actorId, reason = '' }) {
  const normalizedType = String(taskType ?? '').toUpperCase();
  const amount = Number(amountCents);
  if (!supportedTaskTypes().includes(normalizedType) || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new QuestshopError('PRICE_INVALID', 'ประเภท Quest หรือราคาที่ตั้งไม่ถูกต้อง');
  }
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const row = db.prepare("SELECT value_json FROM settings WHERE key='runtime_config'").get();
    let values = {};
    try { values = JSON.parse(row?.value_json ?? '{}'); } catch { /* fail closed to empty owner configuration */ }
    const priceRules = { ...(values.priceRules ?? values.prices ?? {}), [normalizedType]: { amountCents: amount } };
    const next = { ...values, priceRules };
    updateRuntimeValuesInTransaction(db, next, actorId, timestamp);
    appendAdminAuditInTransaction(db, { actorId, action: 'PRICE_UPDATED', targetType: 'PRICE_RULE', targetId: normalizedType, reason,
      before: { taskType: normalizedType, amountCents: values.priceRules?.[normalizedType]?.amountCents ?? values.prices?.[normalizedType]?.amountCents ?? null },
      after: { taskType: normalizedType, amountCents: amount }, timestamp });
    return next;
  });
}

export function configureReceiverPhone(db, env, { phone, actorId, reason = '' }) {
  if (!/^0\d{9}$/.test(String(phone ?? ''))) throw new QuestshopError('RECEIVER_INVALID', 'เบอร์รับเงินต้องเป็นหมายเลขไทย 10 หลัก');
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const credentialId = randomUUID();
    const encrypted = encryptCredential(env.QUESTSHOP_SECRET_KEY, phone);
    db.prepare(`INSERT INTO credentials(id,subject_type,subject_id,credential_type,retention_class,ciphertext,nonce,auth_tag,created_at,updated_at)
      VALUES(?,?,?,'RECEIVER_PHONE','PERSISTENT',?,?,?,?,?)`).run(credentialId, 'CONFIG', credentialId,
      encrypted.ciphertext, encrypted.nonce, encrypted.authTag, timestamp, timestamp);
    db.prepare(`INSERT INTO settings(key,value_json,updated_at,updated_by) VALUES('receiver_credential_id',?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .run(JSON.stringify({ credentialId }), timestamp, actorId);
    appendAdminAuditInTransaction(db, { actorId, action: 'RECEIVER_UPDATED', targetType: 'RECEIVER', targetId: credentialId, reason,
      after: { last4: String(phone).slice(-4) }, timestamp });
    return { credentialId, last4: String(phone).slice(-4) };
  });
}

export function upsertMonitorAccount(db, env, { accountId, label, token, actorId, state = 'ACTIVE', reason = '' }) {
  if (!/^\d{1,32}$/.test(String(accountId ?? '')) || !String(label ?? '').trim() || !String(token ?? '').trim()
    || !['ACTIVE', 'COOLDOWN', 'DISABLED'].includes(state)) throw new QuestshopError('MONITOR_INVALID', 'ข้อมูลบัญชีทดสอบไม่ถูกต้อง');
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const credentialId = randomUUID();
    const encrypted = encryptCredential(env.QUESTSHOP_SECRET_KEY, token);
    db.prepare(`INSERT INTO credentials(id,subject_type,subject_id,credential_type,retention_class,ciphertext,nonce,auth_tag,created_at,updated_at)
      VALUES(?,?,?,'MONITOR_TOKEN','PERSISTENT',?,?,?,?,?)`).run(credentialId, 'MONITOR', accountId,
      encrypted.ciphertext, encrypted.nonce, encrypted.authTag, timestamp, timestamp);
    const before = db.prepare('SELECT * FROM monitor_accounts WHERE account_id=?').get(accountId);
    db.prepare(`INSERT INTO monitor_accounts(account_id,label,state,credential_id,cooldown_until,last_checked_at,updated_at)
      VALUES(?,?,?,?,NULL,NULL,?) ON CONFLICT(account_id) DO UPDATE SET label=excluded.label,state=excluded.state,
      credential_id=excluded.credential_id,cooldown_until=NULL,updated_at=excluded.updated_at`)
      .run(accountId, String(label).trim().slice(0, 100), state, credentialId, timestamp);
    appendAdminAuditInTransaction(db, { actorId, action: 'MONITOR_UPDATED', targetType: 'MONITOR_ACCOUNT', targetId: accountId, reason,
      before: before ? { label: before.label, state: before.state, cooldownUntil: before.cooldown_until } : null,
      after: { label: String(label).trim().slice(0, 100), state, cooldownUntil: null }, timestamp });
    return db.prepare('SELECT account_id,label,state,cooldown_until,last_checked_at,updated_at FROM monitor_accounts WHERE account_id=?').get(accountId);
  });
}

/** Queue a fresh Scan + Test cycle.  Search jobs themselves enqueue the test
 * only for a matching active Monitor account, keeping discoveries private
 * until that test passes (or an audited explicit announcement is used). */
export function queueMonitorScanAndTest(db, { actorId, questId = null }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const quests = questId
      ? db.prepare('SELECT quest_id FROM quests WHERE quest_id=?').all(questId)
      : db.prepare("SELECT quest_id FROM quests WHERE monitor_status<>'TEST_PASSED' AND expires_at IS NOT NULL AND expires_at>? ORDER BY updated_at DESC LIMIT 25").all(timestamp);
    if (questId && !quests.length) throw new QuestshopError('QUEST_NOT_FOUND', 'ไม่พบ Quest ที่ต้องการตรวจ');
    let queued = 0;
    for (const quest of quests) {
      const active = db.prepare("SELECT id FROM jobs WHERE job_type='MONITOR_SEARCH' AND subject_id=? AND state IN ('PENDING','RUNNING','RETRY_WAIT')").get(quest.quest_id);
      if (active) continue;
      enqueueJobInTransaction(db, { jobType: 'MONITOR_SEARCH', subjectType: 'QUEST', subjectId: quest.quest_id,
        operationKey: `monitor-search:${quest.quest_id}:${timestamp}`, payload: { questId: quest.quest_id, requestedBy: actorId }, runAt: timestamp });
      queued += 1;
    }
    appendAdminAuditInTransaction(db, { actorId, action: 'MONITOR_SCAN_QUEUED', targetType: 'MONITOR', targetId: questId ?? 'PENDING_QUESTS',
      reason: 'สั่ง Scan + Test จากแผงผู้ดูแล', after: { queued }, timestamp });
    return { queued };
  });
}

export function retryNotificationDlq(db, { notificationId, actorId }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const before = db.prepare("SELECT * FROM notifications WHERE id=? AND state='DEAD_LETTER'").get(notificationId);
    if (!before) throw new QuestshopError('DLQ_NOT_FOUND', 'ไม่พบข้อความที่ค้างส่ง');
    db.prepare(`UPDATE notifications SET state='PENDING',attempt_count=0,attempt_version=0,next_run_at=?,last_error_code=NULL,
      lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='DEAD_LETTER'`).run(timestamp, timestamp, notificationId);
    const notification = db.prepare('SELECT * FROM notifications WHERE id=?').get(notificationId);
    appendAdminAuditInTransaction(db, { actorId, action: 'DLQ_RETRY', targetType: 'NOTIFICATION', targetId: notificationId,
      reason: 'ส่งข้อความค้างใหม่จากแผงผู้ดูแล', after: { notificationType: before.notification_type, destination: before.destination }, timestamp });
    return notification;
  });
}

export function listOpenManualReviews(db, { limit = 25 } = {}) {
  return db.prepare(`SELECT * FROM manual_reviews WHERE state='OPEN' ORDER BY created_at LIMIT ?`).all(Math.max(1, Math.min(25, Number(limit) || 25)));
}

export function adminOverview(db) {
  const count = (sql) => Number(db.prepare(sql).get().count);
  const receiver = db.prepare("SELECT value_json FROM settings WHERE key='receiver_credential_id'").get();
  return {
    openReviews: count("SELECT count(*) AS count FROM manual_reviews WHERE state='OPEN'"),
    pendingJobs: count("SELECT count(*) AS count FROM jobs WHERE state IN ('PENDING','RUNNING','RETRY_WAIT')"),
    deadLetters: count("SELECT count(*) AS count FROM notifications WHERE state='DEAD_LETTER'"),
    activeMonitors: count("SELECT count(*) AS count FROM monitor_accounts WHERE state='ACTIVE'"),
    receiverConfigured: Boolean(receiver),
  };
}

export function resolveOperationalReview(db, input) {
  return resolveOrderItemReview(db, input);
}

export function adjustWallet(db, { discordUserId, availableDeltaCents, actorId, reason }) {
  const amount = Number(availableDeltaCents);
  if (!/^\d{17,20}$/.test(String(discordUserId ?? '')) || !Number.isSafeInteger(amount) || amount === 0 || !String(reason ?? '').trim()) {
    throw new QuestshopError('WALLET_ADJUSTMENT_INVALID', 'ข้อมูลปรับเครดิตไม่ถูกต้อง');
  }
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const traceId = randomUUID();
    const movement = appendWalletTransactionInTransaction(db, { discordUserId, transactionType: 'ADJUSTMENT', availableDeltaCents: amount,
      referenceType: 'ADMIN_ADJUSTMENT', referenceId: traceId, idempotencyKey: `wallet-adjustment:${traceId}`, traceId, reason: String(reason).trim(), timestamp });
    appendAdminAuditInTransaction(db, { actorId, action: 'WALLET_ADJUSTMENT', targetType: 'WALLET', targetId: discordUserId, reason,
      after: { availableDeltaCents: amount, reservedDeltaCents: 0 }, traceId, timestamp });
    return movement;
  });
}

export function upsertPromotion(db, { id = randomUUID(), name, state, minimumCents, basisPoints, maximumBonusCents = null, startsAt = null, endsAt = null,
  actorId, reason = '' }) {
  const minimum = Number(minimumCents); const rate = Number(basisPoints); const maximum = maximumBonusCents == null || maximumBonusCents === '' ? null : Number(maximumBonusCents);
  if (!String(name ?? '').trim() || !['ACTIVE', 'INACTIVE'].includes(state) || !Number.isSafeInteger(minimum) || minimum < 0
    || !Number.isSafeInteger(rate) || rate < 0 || (maximum != null && (!Number.isSafeInteger(maximum) || maximum < 0))) {
    throw new QuestshopError('PROMOTION_INVALID', 'ข้อมูลโปรโมชั่นไม่ถูกต้อง');
  }
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const before = db.prepare('SELECT * FROM promotions WHERE id=?').get(id);
    const rule = { minimumCents: minimum, basisPoints: rate, ...(maximum == null ? {} : { maximumBonusCents: maximum }) };
    db.prepare(`INSERT INTO promotions(id,name,state,rule_json,starts_at,ends_at,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,state=excluded.state,rule_json=excluded.rule_json,starts_at=excluded.starts_at,ends_at=excluded.ends_at,updated_at=excluded.updated_at`)
      .run(id, String(name).trim().slice(0, 100), state, JSON.stringify(rule), startsAt == null || startsAt === '' ? null : Number(startsAt), endsAt == null || endsAt === '' ? null : Number(endsAt), timestamp);
    appendAdminAuditInTransaction(db, { actorId, action: 'PROMOTION_UPDATED', targetType: 'PROMOTION', targetId: id, reason,
      before: before ? { name: before.name, state: before.state } : null,
      after: { name: String(name).trim().slice(0, 100), state, startsAt, endsAt, basisPoints: rate, minimumCents: minimum, maximumBonusCents: maximum }, timestamp });
    return db.prepare('SELECT * FROM promotions WHERE id=?').get(id);
  });
}
