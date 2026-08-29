import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { decryptCredential } from './crypto.js';
import { enqueueJobInTransaction, completeJob, markJobPossiblySent, recordQuestAmbiguity, recordQuestVerifiedResult, updateRunningJobPayload } from './jobs.js';
import { enqueueNotificationInTransaction } from './notifications.js';
import { markOrderItemRunning, settleOrderItem, updateOrderItemProgress } from './orders.js';
import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';
import { QuestshopError } from '../../shared/errors.js';
import { currentFeatureGates } from './gates.js';

function json(value, fallback = {}) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}

function apiProfile(env) {
  return {
    clientVersion: env.DISCORD_CLIENT_VERSION,
    chromeVersion: env.DISCORD_CHROME_VERSION,
    electronVersion: env.DISCORD_ELECTRON_VERSION,
    buildNumber: env.DISCORD_BUILD_NUMBER,
    nativeBuildNumber: env.DISCORD_NATIVE_BUILD_NUMBER,
    locale: env.DISCORD_LOCALE,
  };
}

async function createApi(runtime, token) {
  if (runtime.questApiFactory) return runtime.questApiFactory({ token, profile: apiProfile(runtime.env) });
  // Keep the production Quest client outside the startup dependency graph.
  // Tests and PRELAUNCH inject a safe adapter; the real adapter is loaded only
  // by a worker immediately before an external request.
  const { createQuestApiClient } = await import('../../quest-engine/api/client.js');
  return createQuestApiClient({ token, profile: apiProfile(runtime.env), coordinator: runtime.questRateLimits });
}

function credentialFor(db, id) {
  const row = id ? db.prepare('SELECT * FROM credentials WHERE id=?').get(id) : null;
  if (!row) throw new QuestshopError('CREDENTIAL_NOT_FOUND', 'ไม่พบข้อมูลบัญชีที่ใช้ทำ Quest');
  return row;
}

function safeQuestRecord(quest) {
  return {
    id: String(quest.id), name: String(quest.name ?? quest.id).slice(0, 200), taskType: String(quest.eventName ?? 'UNKNOWN'),
    url: String(quest.url), artworkUrl: typeof quest.artworkUrl === 'string' && quest.artworkUrl.startsWith('https://')
      ? quest.artworkUrl : null,
    thumbnailUrl: typeof quest.thumbnailUrl === 'string' && quest.thumbnailUrl.startsWith('https://') ? quest.thumbnailUrl : null,
    startsAt: Number.isFinite(Date.parse(quest.startsAt)) ? Date.parse(quest.startsAt) : null,
    expiresAt: Number.isFinite(Date.parse(quest.expiresAt)) ? Date.parse(quest.expiresAt) : null,
    targetValue: Number.isSafeInteger(Number(quest.secondsNeeded)) && Number(quest.secondsNeeded) >= 0 ? Number(quest.secondsNeeded) : null,
    orbs: Number.isSafeInteger(Number(quest.orbs)) && Number(quest.orbs) >= 0 ? Number(quest.orbs) : null,
    orbMin: Number.isSafeInteger(Number(quest.orbReward?.minOrbs)) && Number(quest.orbReward.minOrbs) >= 0 ? Number(quest.orbReward.minOrbs) : null,
    orbMax: Number.isSafeInteger(Number(quest.orbReward?.maxOrbs)) && Number(quest.orbReward.maxOrbs) >= 0 ? Number(quest.orbReward.maxOrbs) : null,
    contractHash: typeof quest.contractHash === 'string' ? quest.contractHash.slice(0, 128) : null,
  };
}

function upsertCustomerQuests(db, { quests, discordUserId = null, accountId = null, timestamp = nowMs() }) {
  const discovered = [];
  for (const sourceQuest of quests) {
    if (!sourceQuest?.id || !sourceQuest?.url?.startsWith('https://')) continue;
    const quest = safeQuestRecord(sourceQuest);
    const existing = db.prepare('SELECT * FROM quests WHERE quest_id=?').get(quest.id);
    db.prepare(`INSERT INTO quests(quest_id,name,task_type,url,artwork_url,thumbnail_url,starts_at,expires_at,target_value,orbs,orb_min,orb_max,contract_hash,source,first_discovered_by,last_discovered_by,first_account_id,last_account_id,first_seen_at,last_seen_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'CUSTOMER',?,?,?,?,?,?,?)
      ON CONFLICT(quest_id) DO UPDATE SET name=excluded.name,task_type=excluded.task_type,url=excluded.url,
       artwork_url=excluded.artwork_url,thumbnail_url=excluded.thumbnail_url,starts_at=excluded.starts_at,expires_at=excluded.expires_at,
       target_value=excluded.target_value,orbs=excluded.orbs,orb_min=excluded.orb_min,orb_max=excluded.orb_max,contract_hash=excluded.contract_hash,
       source='CUSTOMER',discovery_count=quests.discovery_count+1,last_discovered_by=excluded.last_discovered_by,
       last_account_id=excluded.last_account_id,last_seen_at=excluded.last_seen_at,state_version=quests.state_version+1,updated_at=excluded.updated_at`)
      .run(quest.id, quest.name, quest.taskType, quest.url, quest.artworkUrl, quest.thumbnailUrl, quest.startsAt, quest.expiresAt,
        quest.targetValue, quest.orbs, quest.orbMin, quest.orbMax, quest.contractHash,
        discordUserId, discordUserId, accountId, accountId, timestamp, timestamp, timestamp);
    discovered.push({ ...quest, isNew: !existing });
  }
  return discovered;
}

function logDiscovery(db, { checkoutId, discordUserId, accountId, discovered, timestamp = nowMs() }) {
  enqueueNotificationInTransaction(db, { notificationType: 'CUSTOMER_QUEST_DISCOVERY', aggregateType: 'CHECKOUT', aggregateId: checkoutId,
    destination: 'LOG_QUEST_OPERATIONS', payload: { checkoutId, discordUserId, accountId, count: discovered.length }, timestamp });
}

function queueMonitorSearches(db, discovered, checkoutId, { discordUserId = null, accountId = null, timestamp = nowMs() } = {}) {
  for (const quest of discovered.filter((item) => item.isNew)) {
    enqueueNotificationInTransaction(db, { notificationType: 'CUSTOMER_QUEST_DISCOVERY', aggregateType: 'QUEST', aggregateId: quest.id,
      destination: 'LOG_QUEST_OPERATIONS', payload: { questId: quest.id, discordUserId, accountId }, timestamp });
    enqueueJobInTransaction(db, { jobType: 'MONITOR_SEARCH', subjectType: 'QUEST', subjectId: quest.id,
      operationKey: `monitor-search:${quest.id}:${timestamp}`, payload: { questId: quest.id, checkoutId }, runAt: timestamp });
  }
}

export async function processCustomerDiscovery(runtime, job) {
  const payload = json(job.payload_json);
  const credential = credentialFor(runtime.db, payload.credentialId ?? job.subject_id);
  const token = decryptCredential(runtime.env.QUESTSHOP_SECRET_KEY, credential);
  const api = await createApi(runtime, token);
  const [profile, quests] = await Promise.all([
    api.fetchCurrentUser(runtime.abortController.signal), api.fetchQuests(runtime.abortController.signal),
  ]);
  const accountId = String(profile?.id ?? '').trim();
  if (!accountId) throw new QuestshopError('QUEST_ACCOUNT_UNVERIFIED', 'Discord ไม่ยืนยันบัญชี Quest');
  const timestamp = nowMs();
  let discovered;
  withImmediateTransaction(runtime.db, () => {
    discovered = upsertCustomerQuests(runtime.db, { quests, discordUserId: payload.discordUserId, accountId, timestamp });
    const resultPayload = { ...payload, accountId, questIds: discovered.map((item) => item.id), completedAt: timestamp };
    runtime.db.prepare(`UPDATE jobs SET payload_json=?,state_version=state_version+1,updated_at=? WHERE id=? AND state='RUNNING' AND lease_token=?`)
      .run(JSON.stringify(resultPayload), timestamp, job.id, job.lease_token);
    logDiscovery(runtime.db, { checkoutId: job.subject_id, discordUserId: payload.discordUserId, accountId, discovered, timestamp });
    queueMonitorSearches(runtime.db, discovered, job.subject_id, { discordUserId: payload.discordUserId, accountId, timestamp });
  });
  return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token });
}

function insertQuestCheck(db, { questId, monitorAccountId, batchId, type, state, safeReason = null, timestamp = nowMs() }) {
  db.prepare(`INSERT INTO quest_checks(id,quest_id,monitor_account_id,batch_id,check_type,state,safe_reason,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(quest_id,monitor_account_id,batch_id,check_type)
    DO UPDATE SET state=excluded.state,safe_reason=excluded.safe_reason,attempt_count=quest_checks.attempt_count+1,updated_at=excluded.updated_at`)
    .run(randomUUID(), questId, monitorAccountId, batchId, type, state, safeReason, timestamp, timestamp);
}

export async function processMonitorSearch(runtime, job) {
  const payload = json(job.payload_json);
  const quest = runtime.db.prepare('SELECT * FROM quests WHERE quest_id=?').get(payload.questId ?? job.subject_id);
  if (!quest) throw new QuestshopError('QUEST_NOT_FOUND', 'ไม่พบ Quest ที่จะตรวจ');
  const monitors = runtime.db.prepare("SELECT * FROM monitor_accounts WHERE state='ACTIVE' ORDER BY account_id").all();
  const batchId = job.id;
  let foundReady = 0; let foundCompleted = 0; let unavailable = 0;
  for (const monitor of monitors) {
    try {
      const credential = credentialFor(runtime.db, monitor.credential_id);
      const api = await createApi(runtime, decryptCredential(runtime.env.QUESTSHOP_SECRET_KEY, credential));
      const profile = await api.fetchCurrentUser(runtime.abortController.signal);
      if (String(profile?.id) !== String(monitor.account_id)) throw new QuestshopError('MONITOR_ACCOUNT_MISMATCH', 'ข้อมูลบัญชีทดสอบไม่ตรงกับ Token');
      const candidate = (await api.fetchQuests(runtime.abortController.signal, { includeExpired: true }))
        .find((item) => String(item.id) === String(quest.quest_id));
      const timestamp = nowMs();
      withImmediateTransaction(runtime.db, () => {
        if (!candidate) insertQuestCheck(runtime.db, { questId: quest.quest_id, monitorAccountId: monitor.account_id,
          batchId, type: 'SEARCH', state: 'NOT_FOUND', timestamp });
        else if (candidate.completed) { foundCompleted += 1; insertQuestCheck(runtime.db, { questId: quest.quest_id,
          monitorAccountId: monitor.account_id, batchId, type: 'SEARCH', state: 'COMPLETED', timestamp }); }
        else { foundReady += 1; insertQuestCheck(runtime.db, { questId: quest.quest_id, monitorAccountId: monitor.account_id,
          batchId, type: 'SEARCH', state: 'FOUND', timestamp });
          enqueueJobInTransaction(runtime.db, { jobType: 'MONITOR_TEST', subjectType: 'QUEST_CHECK', subjectId: `${quest.quest_id}:${monitor.account_id}:${batchId}`,
            operationKey: `monitor-test:${quest.quest_id}:${monitor.account_id}:${batchId}`, payload: {
              questId: quest.quest_id, monitorAccountId: monitor.account_id, credentialId: monitor.credential_id, batchId,
            }, runAt: timestamp }); }
      });
    } catch (error) {
      unavailable += 1;
      withImmediateTransaction(runtime.db, () => insertQuestCheck(runtime.db, { questId: quest.quest_id,
        monitorAccountId: monitor.account_id, batchId, type: 'SEARCH', state: 'UNAVAILABLE',
        safeReason: error.code ?? 'MONITOR_CHECK_FAILED' }));
    }
  }
  const monitorStatus = foundReady ? 'FOUND_READY' : foundCompleted ? 'FOUND_COMPLETED'
    : unavailable ? 'INCOMPLETE' : 'NOT_FOUND';
  withImmediateTransaction(runtime.db, () => {
    runtime.db.prepare(`UPDATE quests SET monitor_status=?,state_version=state_version+1,updated_at=?
      WHERE quest_id=? AND state_version=?`).run(monitorStatus, nowMs(), quest.quest_id, quest.state_version);
      enqueueNotificationInTransaction(runtime.db, { notificationType: 'CUSTOMER_QUEST_DISCOVERY', aggregateType: 'QUEST', aggregateId: quest.quest_id,
      destination: 'LOG_QUEST_OPERATIONS', payload: { questId: quest.quest_id, monitorStatus }, timestamp: nowMs() });
  });
  return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token });
}

async function runQuest(runtime, { credentialId, questId, job, onProgress }) {
  const credential = credentialFor(runtime.db, credentialId);
  const api = await createApi(runtime, decryptCredential(runtime.env.QUESTSHOP_SECRET_KEY, credential));
  const findFresh = async () => {
    const fresh = (await api.fetchQuests(runtime.abortController.signal, { includeExpired: true }))
      .find((entry) => String(entry.id) === String(questId));
    if (!fresh) throw new QuestshopError('QUEST_NOT_VISIBLE', 'Quest ไม่ปรากฏในบัญชีนี้แล้ว');
    return fresh;
  };
  let quest = await findFresh();
  if (quest.completed) return { ...quest, completedBeforeRun: true, verifiedCompleted: true };
  let mutationAttempted = false;
  const markPossibleMutation = () => {
    mutationAttempted = true;
    if (!markJobPossiblySent(runtime.db, { jobId: job.id, leaseToken: job.lease_token })) {
      throw Object.assign(new Error('Quest lease lost before mutation'), { code: 'JOB_LEASE_LOST' });
    }
  };
  try {
  if (!quest.enrolled) {
    markPossibleMutation();
    await api.enroll(quest.id, runtime.abortController.signal);
    updateRunningJobPayload(runtime.db, { jobId: job.id, leaseToken: job.lease_token, payload: json(job.payload_json) });
    quest = await findFresh();
  }
  const { selectQuestExecutor } = await import('../../quest-engine/executors/registry.js');
  const executor = selectQuestExecutor(quest);
  const valid = executor.validate(quest);
  if (!valid.ok || !executor.supportsAutomaticProgress) throw new QuestshopError('QUEST_NOT_AUTOMATABLE', 'Quest นี้ยังไม่รองรับการทำอัตโนมัติ');
  const result = await executor.execute({
    quest, api, signal: runtime.abortController.signal, now: Date.now,
    sleep: (milliseconds, signal) => sleep(milliseconds, undefined, { signal }),
    fetchFreshQuest: async () => findFresh(),
    onServerProgress: async (fresh) => onProgress?.(fresh),
    mutate: async (_kind, _evidence, execute) => {
      markPossibleMutation();
      const outcome = await execute();
      updateRunningJobPayload(runtime.db, { jobId: job.id, leaseToken: job.lease_token, payload: json(job.payload_json) });
      return outcome;
    },
  });
  return { ...result, completedBeforeRun: false, verifiedCompleted: result?.completed === true };
  } catch (error) {
    error.questPossiblyMutated = mutationAttempted;
    throw error;
  }
}

function isDefiniteQuestFailure(error) {
  return error?.definite === true || error?.category === 'DEFINITE_FAILURE'
    || (!error?.questPossiblyMutated && ['QUEST_NOT_VISIBLE', 'QUEST_NOT_AUTOMATABLE', 'QUEST_EXPIRED'].includes(error?.code));
}

export async function processQuestRun(runtime, job) {
  const workerJob = { jobId: job.id, leaseToken: job.lease_token };
  const item = runtime.db.prepare(`SELECT i.*,o.credential_id,o.trace_id,q.url FROM order_items i
    JOIN orders o ON o.id=i.order_id JOIN quests q ON q.quest_id=i.quest_id WHERE i.id=?`).get(job.subject_id);
  if (!item) return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token, state: 'FAILED', errorCode: 'ORDER_ITEM_NOT_FOUND' });
  markOrderItemRunning(runtime.db, { itemId: item.id, workerJob });
  try {
    const result = await runQuest(runtime, { credentialId: item.credential_id, questId: item.quest_id, job,
      onProgress: (fresh) => updateOrderItemProgress(runtime.db, { itemId: item.id, progressPercent: fresh.progress, workerJob }) });
    if (result.completedBeforeRun) {
      recordQuestVerifiedResult(runtime.db, { jobId: job.id, leaseToken: job.lease_token, subjectId: item.id,
        result: { outcome: 'FAILED', reason: 'EXTERNAL_COMPLETED_RELEASED', evidence: { completedBeforeRun: true } } });
      settleOrderItem(runtime.db, { itemId: item.id, outcome: 'FAILED', reason: 'EXTERNAL_COMPLETED_RELEASED',
        evidence: { completedBeforeRun: true }, workerJob });
      return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token, state: 'FAILED', errorCode: 'EXTERNAL_COMPLETED_RELEASED' });
    }
    if (result.verifiedCompleted) {
      recordQuestVerifiedResult(runtime.db, { jobId: job.id, leaseToken: job.lease_token, subjectId: item.id,
        result: { outcome: 'SUCCESS', claimUrl: result.url ?? item.url, evidence: { verifiedCompleted: true } } });
      settleOrderItem(runtime.db, { itemId: item.id, outcome: 'SUCCESS', claimUrl: result.url ?? item.url, verified: true,
        evidence: { verifiedCompleted: true }, workerJob });
      return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token });
    }
    recordQuestAmbiguity(runtime.db, { jobId: job.id, leaseToken: job.lease_token, subjectId: item.id,
      evidence: { reason: 'QUEST_COMPLETION_UNVERIFIED', completed: result.completed === true, progress: result.progress ?? null } });
    settleOrderItem(runtime.db, { itemId: item.id, outcome: 'REVIEW', reason: 'QUEST_COMPLETION_UNVERIFIED',
      evidence: { completed: result.completed === true, progress: result.progress ?? null }, workerJob });
    return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token, state: 'REVIEW',
      errorCode: 'QUEST_COMPLETION_UNVERIFIED', checkpoint: 'POSSIBLY_SENT' });
  } catch (error) {
    // A worker cannot prove whether a Quest API mutation happened after a
    // network ambiguity, so it deliberately keeps the customer's funds
    // reserved and asks an Owner to review rather than guessing a release.
    if (isDefiniteQuestFailure(error)) {
      recordQuestVerifiedResult(runtime.db, { jobId: job.id, leaseToken: job.lease_token, subjectId: item.id,
        result: { outcome: 'FAILED', reason: error.code ?? 'QUEST_DEFINITE_FAILURE', evidence: { definite: true } } });
      settleOrderItem(runtime.db, { itemId: item.id, outcome: 'FAILED', reason: error.code ?? 'QUEST_DEFINITE_FAILURE',
        evidence: { definite: true }, workerJob });
      return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token, state: 'FAILED',
        errorCode: error.code ?? 'QUEST_DEFINITE_FAILURE', checkpoint: 'VERIFIED' });
    }
    recordQuestAmbiguity(runtime.db, { jobId: job.id, leaseToken: job.lease_token, subjectId: item.id,
      evidence: { reason: error.code ?? 'QUEST_RESULT_AMBIGUOUS', possiblyMutated: error.questPossiblyMutated === true } });
    settleOrderItem(runtime.db, { itemId: item.id, outcome: 'REVIEW', reason: error.code ?? 'QUEST_RESULT_AMBIGUOUS',
      evidence: { possiblyMutated: error.questPossiblyMutated === true }, workerJob });
    return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token, state: 'REVIEW',
      errorCode: error.code ?? 'QUEST_RESULT_AMBIGUOUS', checkpoint: 'POSSIBLY_SENT' });
  }
}

export async function processMonitorTest(runtime, job) {
  const payload = json(job.payload_json);
  try {
    const completed = await runQuest(runtime, { credentialId: payload.credentialId, questId: payload.questId, job });
    withImmediateTransaction(runtime.db, () => {
      // A Quest already completed before this test is evidence that this
      // account cannot verify *this run*.  It must never open the public
      // announcement gate as a successful monitor mutation.
      const passed = completed.verifiedCompleted === true && completed.completedBeforeRun !== true;
      insertQuestCheck(runtime.db, { questId: payload.questId, monitorAccountId: payload.monitorAccountId,
        batchId: payload.batchId, type: 'TEST', state: passed ? 'PASSED' : 'FAILED',
        safeReason: completed.completedBeforeRun ? 'COMPLETED_BEFORE_MONITOR_TEST' : null });
      const quest = runtime.db.prepare('SELECT * FROM quests WHERE quest_id=?').get(payload.questId);
      const announce = passed && currentFeatureGates(runtime.db).QUEST_ANNOUNCEMENT_ENABLED;
      runtime.db.prepare(`UPDATE quests SET monitor_status=?,announcement_status=CASE WHEN ? AND announcement_status='NOT_ANNOUNCED' THEN 'QUEUED' ELSE announcement_status END,
        state_version=state_version+1,updated_at=? WHERE quest_id=? AND state_version=?`)
        .run(passed ? 'TEST_PASSED' : 'TEST_FAILED', announce ? 1 : 0, nowMs(), payload.questId, quest?.state_version);
      enqueueNotificationInTransaction(runtime.db, { notificationType: 'CUSTOMER_QUEST_DISCOVERY', aggregateType: 'QUEST', aggregateId: payload.questId,
        destination: 'LOG_QUEST_OPERATIONS', payload: { questId: payload.questId, result: passed ? 'PASSED' : 'FAILED' }, timestamp: nowMs() });
      if (announce) {
        enqueueNotificationInTransaction(runtime.db, { notificationType: 'QUEST_NEW', aggregateType: 'QUEST', aggregateId: payload.questId,
          destination: 'QUEST_NEW', payload: { questId: payload.questId, verifiedByMonitor: true }, timestamp: nowMs() });
      }
    });
    return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token });
  } catch (error) {
    withImmediateTransaction(runtime.db, () => insertQuestCheck(runtime.db, { questId: payload.questId,
      monitorAccountId: payload.monitorAccountId, batchId: payload.batchId, type: 'TEST', state: 'REVIEW', safeReason: error.code ?? 'TEST_RESULT_AMBIGUOUS' }));
    return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token, state: 'REVIEW',
      errorCode: error.code ?? 'TEST_RESULT_AMBIGUOUS', checkpoint: 'POSSIBLY_SENT' });
  }
}

export async function processQuestWorkflowJob(runtime, job) {
  if (job.job_type === 'CUSTOMER_QUEST_DISCOVERY') return processCustomerDiscovery(runtime, job);
  if (job.job_type === 'MONITOR_SEARCH') return processMonitorSearch(runtime, job);
  if (job.job_type === 'MONITOR_TEST') return processMonitorTest(runtime, job);
  if (job.job_type === 'QUEST_RUN') return processQuestRun(runtime, job);
  return null;
}
