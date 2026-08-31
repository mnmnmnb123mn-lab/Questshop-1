import { randomUUID } from 'node:crypto';
import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';
import { currentFeatureGates } from './gates.js';
import { enqueueNotificationInTransaction } from './notifications.js';
import { QuestshopError } from '../../shared/errors.js';
import { resolveTopupFinancialReview, reverseCreditedTopup } from './payments.js';
import { decryptCredential, encryptCredential } from './crypto.js';
import { refundReadyOrderItem, resolveOrderItemReview } from './orders.js';
import { supportedTaskTypes } from './pricing.js';
import { appendWalletTransactionInTransaction } from './wallet.js';
import { enqueueJobInTransaction } from './jobs.js';
import { resolveQuestCheckReview } from './quest-workflow.js';

export const ADMIN_AUDIT_ALLOWED_FIELDS = Object.freeze({
  FEATURE_GATE_CHANGE: ['gate', 'enabled'],
  PROMOTION_UPDATED: ['name', 'state', 'startsAt', 'endsAt', 'basisPoints', 'minimumCents', 'maximumBonusCents', 'maxUsesPerUser', 'maxBonusPerDayCents'],
  MONITOR_UPDATED: ['label', 'state', 'cooldownUntil'],
  MONITOR_HEALTH_CHECKED: ['healthState', 'questCount', 'errorCode'],
  MONITOR_SCAN_QUEUED: ['queued'],
  DLQ_RETRY: ['notificationType', 'destination'],
  WALLET_ADJUSTMENT: ['availableDeltaCents', 'reservedDeltaCents'],
  MANUAL_REVIEW_DECISION: ['decision', 'status'],
  TOPUP_REVERSED: ['status', 'walletTransactionId'],
  ORDER_ITEM_REFUNDED: ['state', 'refundCents'],
  DISCOVERY_RETRY: ['queued'],
  QUEST_ANNOUNCED: ['monitorVerified'],
  SURFACE_SETUP: ['channelId', 'messageId'],
  PRICE_UPDATED: ['taskType', 'amountCents'],
  RECEIVER_UPDATED: ['last4'],
  DLQ_DISCARDED: ['notificationType', 'destination'],
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

export function setQuestPrice(db, { taskType, amountCents, actorId, reason = '', expectedConfigVersion = null }) {
  const normalizedType = String(taskType ?? '').toUpperCase();
  const amount = Number(amountCents);
  if (!supportedTaskTypes().includes(normalizedType) || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new QuestshopError('PRICE_INVALID', 'ประเภท Quest หรือราคาที่ตั้งไม่ถูกต้อง');
  }
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const currentVersion = Number(db.prepare("SELECT value_json FROM settings WHERE key='runtime_config_version'").get()?.value_json ?? '1');
    if (expectedConfigVersion != null && Number(expectedConfigVersion) !== currentVersion) {
      throw new QuestshopError('CONFIG_CONFLICT', 'การตั้งค่าราคาถูกเปลี่ยนแล้ว กรุณาเปิดเมนูใหม่');
    }
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

export function configureReceiverPhone(db, env, { phone, actorId, reason = '', expectedVersion = null }) {
  if (!/^0\d{9}$/.test(String(phone ?? ''))) throw new QuestshopError('RECEIVER_INVALID', 'เบอร์รับเงินต้องเป็นหมายเลขไทย 10 หลัก');
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const previous = db.prepare("SELECT value_json FROM settings WHERE key='receiver_credential_id'").get();
    let pointer = {};
    try { pointer = JSON.parse(previous?.value_json ?? '{}'); } catch { /* replace malformed pointer safely */ }
    const previousCredentialId = pointer.credentialId ?? null;
    const currentVersion = Number(pointer.version) || 1;
    if (expectedVersion != null && Number(expectedVersion) !== currentVersion) {
      throw new QuestshopError('RECEIVER_CONFLICT', 'เบอร์รับเงินถูกเปลี่ยนแล้ว กรุณาเปิดเมนูใหม่');
    }
    const credentialId = randomUUID();
    const encrypted = encryptCredential(env.QUESTSHOP_SECRET_KEY, phone, { keyVersion: env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION });
    db.prepare(`INSERT INTO credentials(id,subject_type,subject_id,credential_type,key_version,retention_class,ciphertext,nonce,auth_tag,created_at,updated_at)
      VALUES(?,?,?,'RECEIVER_PHONE',?,'PERSISTENT',?,?,?,?,?)`).run(credentialId, 'CONFIG', credentialId, encrypted.keyVersion,
      encrypted.ciphertext, encrypted.nonce, encrypted.authTag, timestamp, timestamp);
    db.prepare(`INSERT INTO settings(key,value_json,updated_at,updated_by) VALUES('receiver_credential_id',?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .run(JSON.stringify({ credentialId, version: currentVersion + 1 }), timestamp, actorId);
    if (previousCredentialId && previousCredentialId !== credentialId) {
      db.prepare(`DELETE FROM credentials WHERE id=? AND credential_type='RECEIVER_PHONE'
        AND NOT EXISTS (SELECT 1 FROM settings WHERE key='receiver_credential_id' AND value_json LIKE '%' || credentials.id || '%')`).run(previousCredentialId);
    }
    appendAdminAuditInTransaction(db, { actorId, action: 'RECEIVER_UPDATED', targetType: 'RECEIVER', targetId: credentialId, reason,
      after: { last4: String(phone).slice(-4) }, timestamp });
    return { credentialId, last4: String(phone).slice(-4), version: currentVersion + 1 };
  });
}

export function upsertMonitorAccount(db, env, { accountId, label, token, actorId, state = 'ACTIVE', reason = '', expectedStateVersion = null }) {
  if (!/^\d{1,32}$/.test(String(accountId ?? '')) || !String(label ?? '').trim()
    || !['ACTIVE', 'COOLDOWN', 'DISABLED'].includes(state)) throw new QuestshopError('MONITOR_INVALID', 'ข้อมูลบัญชีทดสอบไม่ถูกต้อง');
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const before = db.prepare('SELECT * FROM monitor_accounts WHERE account_id=?').get(accountId);
    if (before && expectedStateVersion != null && Number(expectedStateVersion) !== Number(before.state_version)) {
      throw new QuestshopError('MONITOR_CONFLICT', 'ข้อมูล Monitor ถูกเปลี่ยนแล้ว กรุณาเปิดใหม่');
    }
    const hasNewToken = Boolean(String(token ?? '').trim());
    if (!before && !hasNewToken) throw new QuestshopError('MONITOR_TOKEN_REQUIRED', 'ต้องกรอก Token เมื่อเพิ่ม Monitor ใหม่');
    const credentialId = before?.credential_id ?? randomUUID();
    if (hasNewToken) {
      const encrypted = encryptCredential(env.QUESTSHOP_SECRET_KEY, token, { keyVersion: env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION });
      db.prepare(`INSERT INTO credentials(id,subject_type,subject_id,credential_type,key_version,retention_class,ciphertext,nonce,auth_tag,created_at,updated_at)
        VALUES(?,?,?,'MONITOR_TOKEN',?,'PERSISTENT',?,?,?,?,?)
        ON CONFLICT(subject_type,subject_id,credential_type) DO UPDATE SET key_version=excluded.key_version,ciphertext=excluded.ciphertext,nonce=excluded.nonce,
          auth_tag=excluded.auth_tag,updated_at=excluded.updated_at`).run(credentialId, 'MONITOR', accountId, encrypted.keyVersion,
        encrypted.ciphertext, encrypted.nonce, encrypted.authTag, timestamp, timestamp);
    }
    if (!before) {
      db.prepare(`INSERT INTO monitor_accounts(account_id,label,state,credential_id,cooldown_until,last_checked_at,updated_at)
        VALUES(?,?,?,?,NULL,NULL,?)`).run(accountId, String(label).trim().slice(0, 100), state, credentialId, timestamp);
    } else {
      const changed = db.prepare(`UPDATE monitor_accounts SET label=?,state=?,credential_id=?,cooldown_until=NULL,state_version=state_version+1,updated_at=?
        WHERE account_id=? AND state_version=?`).run(String(label).trim().slice(0, 100), state, credentialId, timestamp, accountId, before.state_version);
      if (!changed.changes) throw new QuestshopError('MONITOR_CONFLICT', 'ข้อมูล Monitor ถูกเปลี่ยนแล้ว กรุณาเปิดใหม่');
    }
    appendAdminAuditInTransaction(db, { actorId, action: 'MONITOR_UPDATED', targetType: 'MONITOR_ACCOUNT', targetId: accountId, reason,
      before: before ? { label: before.label, state: before.state, cooldownUntil: before.cooldown_until } : null,
      after: { label: String(label).trim().slice(0, 100), state, cooldownUntil: null }, timestamp });
    return db.prepare('SELECT account_id,label,state,credential_id,cooldown_until,last_checked_at,health_state,last_health_error_code,last_health_quest_count,state_version,updated_at FROM monitor_accounts WHERE account_id=?').get(accountId);
  });
}

function monitorHealthErrorCode(error) {
  const code = String(error?.code ?? 'MONITOR_CHECK_FAILED');
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'MONITOR_CHECK_FAILED';
}

async function monitorApi(runtime, token) {
  if (runtime.questApiFactory) return runtime.questApiFactory({ token });
  const { createQuestApiClient } = await import('../../quest-engine/api/client.js');
  return createQuestApiClient({ token, profile: {
    clientVersion: runtime.env.DISCORD_CLIENT_VERSION, chromeVersion: runtime.env.DISCORD_CHROME_VERSION,
    electronVersion: runtime.env.DISCORD_ELECTRON_VERSION, buildNumber: runtime.env.DISCORD_BUILD_NUMBER,
    nativeBuildNumber: runtime.env.DISCORD_NATIVE_BUILD_NUMBER, locale: runtime.env.DISCORD_LOCALE,
  }, coordinator: runtime.questRateLimits });
}

/** Read-only Discord verification followed by a short CAS update.  The token
 * is never persisted or returned, and a newer Monitor edit wins over this
 * delayed external result. */
export async function checkMonitorHealth(runtime, { accountId, actorId, expectedStateVersion = null }) {
  const monitor = runtime.db.prepare('SELECT * FROM monitor_accounts WHERE account_id=?').get(accountId);
  if (!monitor) throw new QuestshopError('MONITOR_NOT_FOUND', 'ไม่พบบัญชี Monitor');
  if (expectedStateVersion != null && Number(expectedStateVersion) !== Number(monitor.state_version)) {
    throw new QuestshopError('MONITOR_CONFLICT', 'ข้อมูล Monitor ถูกเปลี่ยนแล้ว กรุณาเปิดใหม่');
  }
  const credential = monitor.credential_id ? runtime.db.prepare('SELECT * FROM credentials WHERE id=?').get(monitor.credential_id) : null;
  if (!credential) throw new QuestshopError('CREDENTIAL_NOT_FOUND', 'ไม่พบ Token ของ Monitor');
  const timestamp = nowMs();
  let healthState = 'READY'; let errorCode = null; let questCount = null;
  try {
    const token = decryptCredential(runtime.env.QUESTSHOP_SECRET_KEY, credential,
      { allowedVersions: runtime.env.CREDENTIAL_ENCRYPTION_ALLOWED_VERSIONS });
    const api = await monitorApi(runtime, token);
    const signal = runtime.abortController?.signal;
    const [profile, quests] = await Promise.all([api.fetchCurrentUser(signal), api.fetchQuests(signal, { includeExpired: true })]);
    if (String(profile?.id ?? '') !== String(monitor.account_id)) {
      throw new QuestshopError('MONITOR_ACCOUNT_MISMATCH', 'Token ของ Monitor ไม่ตรงกับบัญชีที่ตั้งไว้');
    }
    questCount = Array.isArray(quests) ? quests.length : 0;
  } catch (error) {
    errorCode = monitorHealthErrorCode(error);
    healthState = ['TOKEN_INVALID', 'MONITOR_ACCOUNT_MISMATCH', 'CREDENTIAL_KEY_VERSION_DISABLED'].includes(errorCode) ? 'INVALID' : 'DEGRADED';
  }
  return withImmediateTransaction(runtime.db, () => {
    const changed = runtime.db.prepare(`UPDATE monitor_accounts SET health_state=?,last_health_error_code=?,last_health_quest_count=?,
      last_checked_at=?,state_version=state_version+1,updated_at=? WHERE account_id=? AND state_version=?`).run(
      healthState, errorCode, questCount, timestamp, timestamp, monitor.account_id, monitor.state_version);
    if (!changed.changes) throw new QuestshopError('MONITOR_CONFLICT', 'ข้อมูล Monitor ถูกเปลี่ยนแล้ว กรุณาเปิดใหม่');
    appendAdminAuditInTransaction(runtime.db, { actorId, action: 'MONITOR_HEALTH_CHECKED', targetType: 'MONITOR_ACCOUNT', targetId: monitor.account_id,
      reason: 'ตรวจสุขภาพ Monitor', after: { healthState, questCount, errorCode }, timestamp });
    return runtime.db.prepare('SELECT account_id,label,state,health_state,last_checked_at,last_health_error_code,last_health_quest_count,state_version FROM monitor_accounts WHERE account_id=?').get(monitor.account_id);
  });
}

export async function checkAllMonitorHealth(runtime, { actorId }) {
  const monitors = runtime.db.prepare("SELECT account_id,state_version FROM monitor_accounts WHERE state='ACTIVE' ORDER BY account_id").all();
  const results = [];
  for (const monitor of monitors) {
    try { results.push(await checkMonitorHealth(runtime, { accountId: monitor.account_id, actorId, expectedStateVersion: monitor.state_version })); }
    catch (error) { results.push({ account_id: monitor.account_id, health_state: 'UNCHANGED', error_code: error.code ?? 'MONITOR_CHECK_FAILED' }); }
  }
  return results;
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
      const active = db.prepare("SELECT id FROM jobs WHERE job_type='MONITOR_SEARCH' AND subject_id=? AND state IN ('PENDING','RUNNING','WAITING_RETRY','WAITING_RATE_LIMIT')").get(quest.quest_id);
      if (active) continue;
      enqueueJobInTransaction(db, { jobType: 'MONITOR_SEARCH', subjectType: 'QUEST', subjectId: quest.quest_id,
        operationKey: `monitor-search:${quest.quest_id}:${timestamp}`, payload: { questId: quest.quest_id, requestedBy: actorId }, runAt: timestamp });
      queued += 1;
    }
    let monitorQueued = 0;
    if (!questId) {
      const monitors = db.prepare("SELECT account_id FROM monitor_accounts WHERE state='ACTIVE' AND health_state='READY' AND (cooldown_until IS NULL OR cooldown_until<=?) ORDER BY account_id").all(timestamp);
      for (const monitor of monitors) {
        const active = db.prepare(`SELECT id FROM jobs WHERE job_type='MONITOR_DISCOVERY' AND subject_id=?
          AND state IN ('PENDING','RUNNING','WAITING_RETRY','WAITING_RATE_LIMIT')`).get(monitor.account_id);
        if (active) continue;
        enqueueJobInTransaction(db, { jobType: 'MONITOR_DISCOVERY', subjectType: 'MONITOR', subjectId: monitor.account_id,
          operationKey: `monitor-discovery:${monitor.account_id}:${timestamp}`, payload: { monitorAccountId: monitor.account_id, requestedBy: actorId }, runAt: timestamp });
        monitorQueued += 1;
      }
    }
    appendAdminAuditInTransaction(db, { actorId, action: 'MONITOR_SCAN_QUEUED', targetType: 'MONITOR', targetId: questId ?? 'PENDING_QUESTS',
      reason: 'สั่ง Scan + Test จากแผงผู้ดูแล', after: { queued }, timestamp });
    return { queued, monitorQueued };
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

export function discardNotificationDlq(db, { notificationId, actorId }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const before = db.prepare("SELECT * FROM notifications WHERE id=? AND state='DEAD_LETTER'").get(notificationId);
    if (!before) throw new QuestshopError('DLQ_NOT_FOUND', 'ไม่พบข้อความที่ค้างส่ง');
    const protectedRecord = before.destination === 'LOG_PAYMENTS' || before.destination === 'LOG_ADMIN'
      || ['TOPUP', 'WALLET', 'ADMIN_AUDIT'].includes(before.aggregate_type);
    if (protectedRecord) throw new QuestshopError('DLQ_DISCARD_FORBIDDEN', 'ห้ามทิ้งรายการการเงินหรือหลักฐาน audit');
    const changed = db.prepare(`UPDATE notifications SET state='DISCARDED',lease_token=NULL,lease_expires_at=NULL,updated_at=?
      WHERE id=? AND state='DEAD_LETTER'`).run(timestamp, notificationId);
    if (!changed.changes) throw new QuestshopError('DLQ_CONFLICT', 'รายการค้างส่งถูกเปลี่ยนแล้ว กรุณาเปิดใหม่');
    appendAdminAuditInTransaction(db, { actorId, action: 'DLQ_DISCARDED', targetType: 'NOTIFICATION', targetId: notificationId,
      reason: 'Owner ทิ้งข้อความค้างส่งที่ไม่ใช่การเงินหรือ audit', after: { notificationType: before.notification_type, destination: before.destination }, timestamp });
    return db.prepare('SELECT * FROM notifications WHERE id=?').get(notificationId);
  });
}

export function listOpenManualReviews(db, { limit = 25 } = {}) {
  return db.prepare(`SELECT * FROM manual_reviews WHERE state='OPEN' ORDER BY created_at LIMIT ?`).all(Math.max(1, Math.min(25, Number(limit) || 25)));
}

export function adminOverview(db) {
  const count = (sql) => Number(db.prepare(sql).get().count);
  const receiver = db.prepare("SELECT value_json FROM settings WHERE key='receiver_credential_id'").get();
  const containment = db.prepare("SELECT value_json FROM settings WHERE key='payment_containment'").get();
  const backup = db.prepare("SELECT value_json FROM settings WHERE key='last_daily_backup'").get();
  let containmentState = 'CLOSED'; let backupAt = null;
  try { containmentState = JSON.parse(containment?.value_json ?? '{}').state ?? containmentState; } catch { /* report safe default */ }
  try { backupAt = Number(JSON.parse(backup?.value_json ?? '{}').at) || null; } catch { /* no backup yet */ }
  return {
    openReviews: count("SELECT count(*) AS count FROM manual_reviews WHERE state='OPEN'"),
    pendingJobs: count("SELECT count(*) AS count FROM jobs WHERE state IN ('PENDING','RUNNING','WAITING_RETRY','WAITING_RATE_LIMIT')"),
    deadLetters: count("SELECT count(*) AS count FROM notifications WHERE state='DEAD_LETTER'"),
    activeMonitors: count("SELECT count(*) AS count FROM monitor_accounts WHERE state='ACTIVE'"),
    receiverConfigured: Boolean(receiver),
    expiredLeases: count("SELECT count(*) AS count FROM jobs WHERE state='RUNNING' AND lease_expires_at<=strftime('%s','now')*1000"),
    stuckRedeemed: count("SELECT count(*) AS count FROM topups WHERE status='REDEEMED'"),
    reservedCents: Number(db.prepare('SELECT COALESCE(sum(reserved_cents),0) AS total FROM wallets').get().total),
    availableCents: Number(db.prepare('SELECT COALESCE(sum(available_cents),0) AS total FROM wallets').get().total),
    containmentState, backupAt,
  };
}

export function resolveOperationalReview(db, input) {
  if (input?.subjectType === 'QUEST_CHECK') return resolveQuestCheckReview(db, input);
  if (input?.subjectType === 'JOB') return resolveUnknownJobReview(db, input);
  return resolveOrderItemReview(db, input);
}

function resolveUnknownJobReview(db, { reviewId, actorId, decision, reason = '' }) {
  if (decision !== 'CLOSE') throw new QuestshopError('REVIEW_DECISION_INVALID', 'งานที่ไม่รู้จักปิดเคสได้เท่านั้น');
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const review = db.prepare("SELECT * FROM manual_reviews WHERE id=? AND subject_type='JOB' AND category='OPERATIONAL'").get(reviewId);
    if (!review) throw new QuestshopError('REVIEW_NOT_FOUND', 'ไม่พบรายการงานที่รอตรวจสอบ');
    if (review.state !== 'OPEN') return { state: review.state, idempotent: true };
    const job = db.prepare('SELECT operation_key FROM jobs WHERE id=?').get(review.subject_id);
    const changed = db.prepare(`UPDATE manual_reviews SET state='RESOLVED_FAILURE',decision='CLOSE',resolved_by=?,resolved_at=?,
      state_version=state_version+1,updated_at=? WHERE id=? AND state='OPEN' AND state_version=?`).run(actorId, timestamp, timestamp, review.id, review.state_version);
    if (!changed.changes) throw new QuestshopError('REVIEW_CONFLICT', 'รายการถูกเปลี่ยนแล้ว กรุณาลองใหม่');
    appendAdminAuditInTransaction(db, { actorId, action: 'MANUAL_REVIEW_DECISION', targetType: 'JOB', targetId: review.subject_id,
      reason: reason || 'OWNER_CLOSED_UNKNOWN_JOB_REVIEW', before: { state: 'OPEN' }, after: { decision: 'CLOSE', status: 'RESOLVED_FAILURE' }, traceId: job?.operation_key ?? review.id, timestamp });
    return { state: 'RESOLVED_FAILURE', idempotent: false, decision: 'CLOSE' };
  });
}

export function adjustWallet(db, { discordUserId, availableDeltaCents, actorId, reason, expectedWalletVersion = null }) {
  const amount = Number(availableDeltaCents);
  if (!/^\d{17,20}$/.test(String(discordUserId ?? '')) || !Number.isSafeInteger(amount) || amount === 0 || !String(reason ?? '').trim()) {
    throw new QuestshopError('WALLET_ADJUSTMENT_INVALID', 'ข้อมูลปรับเครดิตไม่ถูกต้อง');
  }
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const wallet = db.prepare('SELECT * FROM wallets WHERE discord_user_id=?').get(discordUserId);
    if (expectedWalletVersion != null && Number(wallet?.version) !== Number(expectedWalletVersion)) {
      throw new QuestshopError('WALLET_CONFLICT', 'ยอด Wallet ถูกเปลี่ยนแล้ว กรุณาเปิดเมนูใหม่');
    }
    const traceId = randomUUID();
    const movement = appendWalletTransactionInTransaction(db, { discordUserId, transactionType: 'ADJUSTMENT', availableDeltaCents: amount,
      referenceType: 'ADMIN_ADJUSTMENT', referenceId: traceId, idempotencyKey: `wallet-adjustment:${traceId}`, traceId, reason: String(reason).trim(), timestamp });
    appendAdminAuditInTransaction(db, { actorId, action: 'WALLET_ADJUSTMENT', targetType: 'WALLET', targetId: discordUserId, reason,
      after: { availableDeltaCents: amount, reservedDeltaCents: 0 }, traceId, timestamp });
    return movement;
  });
}

export function listAdminOrders(db, { offset = 0, limit = 25 } = {}) {
  return db.prepare(`SELECT o.id,o.discord_user_id,o.quest_account_id,o.state,o.created_at,o.updated_at,
    count(i.id) AS item_count, sum(CASE WHEN i.state='MANUAL_REVIEW' THEN 1 ELSE 0 END) AS review_count
    FROM orders o JOIN order_items i ON i.order_id=o.id GROUP BY o.id ORDER BY o.updated_at DESC LIMIT ? OFFSET ?`)
    .all(Math.max(1, Math.min(25, Number(limit) || 25)), Math.max(0, Number(offset) || 0));
}

export function orderDetail(db, orderId) {
  const order = db.prepare('SELECT id,discord_user_id,quest_account_id,state,created_at,updated_at FROM orders WHERE id=?').get(orderId);
  if (!order) throw new QuestshopError('ORDER_NOT_FOUND', 'ไม่พบ Order');
  return { order, items: db.prepare(`SELECT i.id,i.quest_id,q.task_type,i.state,i.price_cents,i.progress_percent,i.claim_url,i.refund_cents,i.state_version
    FROM order_items i JOIN quests q ON q.quest_id=i.quest_id WHERE i.order_id=? ORDER BY i.reserved_at,i.id`).all(orderId) };
}

export function refundOrderItem(db, input) {
  return refundReadyOrderItem(db, input);
}

export function reverseTopup(db, input) {
  return reverseCreditedTopup(db, input);
}

export function listRecentAdminAudit(db, { limit = 25 } = {}) {
  return db.prepare(`SELECT id,actor_id,action,target_type,target_id,reason,before_json,after_json,created_at
    FROM admin_audit ORDER BY created_at DESC LIMIT ?`).all(Math.max(1, Math.min(25, Number(limit) || 25)));
}

export function upsertPromotion(db, { id = randomUUID(), name, state, minimumCents, basisPoints, maximumBonusCents = null,
  maxUsesPerUser = null, maxBonusPerDayCents = null, startsAt = null, endsAt = null, actorId, reason = '', expectedStateVersion = null }) {
  const minimum = Number(minimumCents); const rate = Number(basisPoints); const maximum = maximumBonusCents == null || maximumBonusCents === '' ? null : Number(maximumBonusCents);
  const maxUses = maxUsesPerUser == null || maxUsesPerUser === '' ? null : Number(maxUsesPerUser);
  const maxDaily = maxBonusPerDayCents == null || maxBonusPerDayCents === '' ? null : Number(maxBonusPerDayCents);
  const starts = startsAt == null || startsAt === '' ? null : Number(startsAt);
  const ends = endsAt == null || endsAt === '' ? null : Number(endsAt);
  if (!String(name ?? '').trim() || !['ACTIVE', 'INACTIVE'].includes(state) || !Number.isSafeInteger(minimum) || minimum < 0
    || !Number.isSafeInteger(rate) || rate < 0 || (maximum != null && (!Number.isSafeInteger(maximum) || maximum < 0))
    || (maxUses != null && (!Number.isSafeInteger(maxUses) || maxUses < 0)) || (maxDaily != null && (!Number.isSafeInteger(maxDaily) || maxDaily < 0))
    || (starts != null && (!Number.isSafeInteger(starts) || starts <= 0)) || (ends != null && (!Number.isSafeInteger(ends) || ends <= 0))
    || (starts != null && ends != null && starts >= ends)) {
    throw new QuestshopError('PROMOTION_INVALID', 'ข้อมูลโปรโมชั่นไม่ถูกต้อง');
  }
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const before = db.prepare('SELECT * FROM promotions WHERE id=?').get(id);
    if (before && expectedStateVersion != null && Number(expectedStateVersion) !== Number(before.state_version)) {
      throw new QuestshopError('PROMOTION_CONFLICT', 'โปรโมชั่นถูกเปลี่ยนแล้ว กรุณาเปิดใหม่');
    }
    const rule = { minimumCents: minimum, basisPoints: rate, ...(maximum == null ? {} : { maximumBonusCents: maximum }),
      ...(maxUses == null ? {} : { maxUsesPerUser: maxUses }), ...(maxDaily == null ? {} : { maxBonusPerDayCents: maxDaily }) };
    if (state === 'ACTIVE') {
      db.prepare("UPDATE promotions SET state='INACTIVE',state_version=state_version+1,updated_at=? WHERE state='ACTIVE' AND id<>?").run(timestamp, id);
    }
    if (!before) {
      db.prepare(`INSERT INTO promotions(id,name,state,rule_json,starts_at,ends_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
        .run(id, String(name).trim().slice(0, 100), state, JSON.stringify(rule), starts, ends, timestamp);
    } else {
      const changed = db.prepare(`UPDATE promotions SET name=?,state=?,rule_json=?,starts_at=?,ends_at=?,state_version=state_version+1,updated_at=?
        WHERE id=? AND state_version=?`).run(String(name).trim().slice(0, 100), state, JSON.stringify(rule),
        starts, ends, timestamp, id, before.state_version);
      if (!changed.changes) throw new QuestshopError('PROMOTION_CONFLICT', 'โปรโมชั่นถูกเปลี่ยนแล้ว กรุณาเปิดใหม่');
    }
    appendAdminAuditInTransaction(db, { actorId, action: 'PROMOTION_UPDATED', targetType: 'PROMOTION', targetId: id, reason,
      before: before ? { name: before.name, state: before.state } : null,
      after: { name: String(name).trim().slice(0, 100), state, startsAt, endsAt, basisPoints: rate, minimumCents: minimum,
        maximumBonusCents: maximum, maxUsesPerUser: maxUses, maxBonusPerDayCents: maxDaily }, timestamp });
    return db.prepare('SELECT * FROM promotions WHERE id=?').get(id);
  });
}
