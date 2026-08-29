import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { decryptCredential } from '../domain/sqlite/crypto.js';
import { appendExternalOperationEvidenceInTransaction, assertActiveJobLeaseInTransaction, claimDueJob, completeJob, finishRecoveredJob, markJobPossiblySent, recoverInterruptedJobs, renewJobLease } from '../domain/sqlite/jobs.js';
import { creditRedeemedTopup, failTopup, markTopupProcessing, moveTopupToReview, recordRedeemedTopup } from '../domain/sqlite/payments.js';
import { settleOrderItem } from '../domain/sqlite/orders.js';
import { claimDueNotification, deferNotification, finishNotificationDelivery, recoverSendingNotifications } from '../domain/sqlite/notifications.js';
import { nowMs, withImmediateTransaction } from '../db/sqlite.js';
import { normalizeVoucherUrl, redeemVoucher } from '../adapters/truemoney/voucher.js';
import { renderSqliteNotification } from '../discord/renderers/sqlite-projections.js';
import { normalizeDiscordPayload } from '../discord/payload.js';
import { processQuestWorkflowJob } from '../domain/sqlite/quest-workflow.js';
import { currentFeatureGates } from '../domain/sqlite/gates.js';
import { createRotatedSqliteBackup } from '../db/sqlite-backup.js';
import { reconcileSurfaceAnchors } from '../discord/surfaces/setup.js';
import { recordSystemIncident } from '../domain/sqlite/incidents.js';
import { recomputeHealthStatus } from '../bootstrap/health-status.js';
import { EXTERNAL_OUTCOME } from '../domain/sqlite/external-outcome.js';

function cleanupExpiredRows(db) {
  const timestamp = nowMs();
  withImmediateTransaction(db, () => {
    db.prepare(`DELETE FROM credentials AS c WHERE c.retention_class='TEMPORARY' AND c.cleanup_after<=?
      AND (
        (c.credential_type='VOUCHER' AND EXISTS (SELECT 1 FROM topups t WHERE t.id=c.subject_id AND t.status IN ('CREDITED','FAILED','REVERSED'))
          AND NOT EXISTS (SELECT 1 FROM manual_reviews r WHERE r.subject_type='TOPUP' AND r.subject_id=c.subject_id AND r.state='OPEN')
          AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.aggregate_type='TOPUP' AND n.aggregate_id=c.subject_id
            AND n.notification_type IN ('TOPUP_STATUS_DM','PAYMENT_LOG') AND n.delivered_version<n.desired_version))
        OR
        (c.credential_type='CUSTOMER_QUEST_TOKEN' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.credential_id=c.id
          AND o.state NOT IN ('COMPLETED','PARTIAL','CANCELLED'))
          AND NOT EXISTS (SELECT 1 FROM orders o JOIN notifications n ON n.aggregate_type='ORDER' AND n.aggregate_id=o.id
            WHERE o.credential_id=c.id AND n.notification_type='QUEST_HISTORY' AND n.delivered_version<n.desired_version))
      )`).run(timestamp);
    db.prepare(`DELETE FROM jobs WHERE state IN ('COMPLETED','FAILED') AND completed_at IS NOT NULL AND completed_at<?`).run(timestamp - 7 * 86_400_000);
    db.prepare(`DELETE FROM quest_checks WHERE updated_at<?`).run(timestamp - 7 * 86_400_000);
    db.prepare('DELETE FROM interaction_sessions WHERE expires_at<?').run(timestamp);
    db.prepare(`DELETE FROM manual_reviews WHERE category='OPERATIONAL' AND state IN ('RESOLVED_SUCCESS','RESOLVED_FAILURE') AND resolved_at<?`).run(timestamp - 30 * 86_400_000);
  });
}

async function createDailyBackupIfDue(runtime) {
  const now = nowMs();
  const row = runtime.db.prepare("SELECT value_json FROM settings WHERE key='last_daily_backup'").get();
  let last = 0;
  try { last = Number(JSON.parse(row?.value_json ?? '{}').at) || 0; } catch { /* create a fresh backup */ }
  if (now - last < 86_400_000) return false;
  await createRotatedSqliteBackup(runtime.db, runtime.env.SQLITE_PATH, { kind: 'daily', keep: 7 });
  withImmediateTransaction(runtime.db, () => runtime.db.prepare(`INSERT INTO settings(key,value_json,updated_at,updated_by)
    VALUES('last_daily_backup',?,?, 'SYSTEM') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
    .run(JSON.stringify({ at: now }), now));
  return true;
}

function getReceiverPhone(db, env) {
  const setting = db.prepare("SELECT value_json FROM settings WHERE key='receiver_credential_id'").get();
  const credentialId = setting ? JSON.parse(setting.value_json)?.credentialId : null;
  const row = credentialId ? db.prepare("SELECT * FROM credentials WHERE id=? AND credential_type='RECEIVER_PHONE'").get(credentialId) : null;
  if (!row) return null;
  const phone = decryptCredential(env.QUESTSHOP_SECRET_KEY, row);
  return { phone, last4: phone.slice(-4) };
}

function createAttempt(db, topupId, attemptNumber, traceId, workerJob) {
  const id = randomUUID();
  const timestamp = nowMs();
  withImmediateTransaction(db, () => {
    assertActiveJobLeaseInTransaction(db, { jobId: workerJob.jobId, leaseToken: workerJob.leaseToken,
      subjectType: 'TOPUP', subjectId: topupId });
    db.prepare(`INSERT INTO payment_attempts(id,topup_id,attempt_number,dispatch_state,evidence_json,trace_id,started_at)
      VALUES(?,?,?,'INTENT_RECORDED','{}',?,?)`).run(id, topupId, attemptNumber, traceId, timestamp);
    db.prepare(`UPDATE jobs SET checkpoint='INTENT_RECORDED',state_version=state_version+1,updated_at=?
      WHERE id=? AND state='RUNNING' AND lease_token=?`).run(timestamp, workerJob.jobId, workerJob.leaseToken);
    appendExternalOperationEvidenceInTransaction(db, { jobId: workerJob.jobId, subjectType: 'TOPUP', subjectId: topupId,
      stage: 'INTENT', evidence: { attemptNumber }, traceId, timestamp });
  });
  return id;
}

function recoveryEvidence(db, job, decision, details = {}) {
  appendExternalOperationEvidenceInTransaction(db, {
    jobId: job.id, subjectType: job.subject_type, subjectId: job.subject_id, stage: 'RECOVERY_DECISION',
    evidence: { decision, ...details }, traceId: JSON.parse(job.payload_json ?? '{}').traceId ?? job.operation_key,
  });
}

/** Recover only expired deliveries.  Aggregate mutations stay in their domain
 * services so restart paths retain the same idempotency and audit behavior as
 * normal settlement. */
export function recoverInterruptedSubjects(runtime) {
  const jobs = recoverInterruptedJobs(runtime.db);
  for (const job of jobs) {
    if (job.job_type === 'PAYMENT_SETTLE') {
      const topup = runtime.db.prepare('SELECT * FROM topups WHERE id=?').get(job.subject_id);
      if (!topup) { finishRecoveredJob(runtime.db, { jobId: job.id, state: 'FAILED', errorCode: 'TOPUP_NOT_FOUND' }); continue; }
      if (topup.status === 'REDEEMED') {
        creditRedeemedTopup(runtime.db, { topupId: topup.id });
        withImmediateTransaction(runtime.db, () => recoveryEvidence(runtime.db, job, 'CREDIT_REDEEMED_WITHOUT_PROVIDER_RETRY'));
        finishRecoveredJob(runtime.db, { jobId: job.id, state: 'COMPLETED' });
      } else if (['CREDITED', 'REVERSED'].includes(topup.status)) {
        finishRecoveredJob(runtime.db, { jobId: job.id, state: 'COMPLETED' });
      } else if (topup.status === 'FAILED') {
        finishRecoveredJob(runtime.db, { jobId: job.id, state: 'FAILED', errorCode: topup.failure_reason });
      } else if (topup.status === 'REVIEW') {
        finishRecoveredJob(runtime.db, { jobId: job.id, state: 'REVIEW', checkpoint: 'POSSIBLY_SENT', errorCode: topup.failure_reason });
      } else {
        moveTopupToReview(runtime.db, { topupId: topup.id, reasonCode: 'RESTART_AFTER_POSSIBLY_SENT',
          safeReason: 'คำขอ TrueMoney อาจถูกส่งแล้วและต้องตรวจสอบด้วยผู้ดูแล' });
        withImmediateTransaction(runtime.db, () => recoveryEvidence(runtime.db, job, 'FINANCIAL_REVIEW_NO_PROVIDER_RETRY'));
        finishRecoveredJob(runtime.db, { jobId: job.id, state: 'REVIEW', checkpoint: 'POSSIBLY_SENT', errorCode: 'RESTART_AFTER_POSSIBLY_SENT' });
      }
      continue;
    }
    if (job.job_type !== 'QUEST_RUN') {
      // An extension job without a declared subject recovery policy must not
      // be retried after a possible external send.
      finishRecoveredJob(runtime.db, { jobId: job.id, state: 'REVIEW', checkpoint: 'POSSIBLY_SENT', errorCode: 'RESTART_AFTER_POSSIBLY_SENT' });
      continue;
    }
    const item = runtime.db.prepare('SELECT * FROM order_items WHERE id=?').get(job.subject_id);
    if (!item) { finishRecoveredJob(runtime.db, { jobId: job.id, state: 'FAILED', errorCode: 'ORDER_ITEM_NOT_FOUND' }); continue; }
    if (item.state === 'READY_TO_CLAIM') { finishRecoveredJob(runtime.db, { jobId: job.id, state: 'COMPLETED' }); continue; }
    if (['FAILED', 'REFUNDED'].includes(item.state)) { finishRecoveredJob(runtime.db, { jobId: job.id, state: 'FAILED' }); continue; }
    const result = JSON.parse(job.payload_json ?? '{}').recoveryResult;
    if (result?.outcome === 'SUCCESS') {
      settleOrderItem(runtime.db, { itemId: item.id, outcome: 'SUCCESS', claimUrl: result.claimUrl, verified: true, evidence: result.evidence ?? {} });
      withImmediateTransaction(runtime.db, () => recoveryEvidence(runtime.db, job, 'CAPTURE_FROM_VERIFIED_RESULT'));
      finishRecoveredJob(runtime.db, { jobId: job.id, state: 'COMPLETED' });
    } else if (result?.outcome === 'FAILED') {
      settleOrderItem(runtime.db, { itemId: item.id, outcome: 'FAILED', reason: result.reason, evidence: result.evidence ?? {} });
      withImmediateTransaction(runtime.db, () => recoveryEvidence(runtime.db, job, 'RELEASE_FROM_VERIFIED_RESULT'));
      finishRecoveredJob(runtime.db, { jobId: job.id, state: 'FAILED', errorCode: result.reason });
    } else {
      settleOrderItem(runtime.db, { itemId: item.id, outcome: 'REVIEW', reason: 'RESTART_AFTER_POSSIBLY_SENT', evidence: { recovery: true } });
      withImmediateTransaction(runtime.db, () => recoveryEvidence(runtime.db, job, 'OPERATIONAL_REVIEW_RESERVED'));
      finishRecoveredJob(runtime.db, { jobId: job.id, state: 'REVIEW', checkpoint: 'POSSIBLY_SENT', errorCode: 'RESTART_AFTER_POSSIBLY_SENT' });
    }
  }
}

function assertPaymentAttemptLease(db, attemptId, workerJob) {
  const attempt = db.prepare('SELECT topup_id FROM payment_attempts WHERE id=?').get(attemptId);
  if (!attempt) throw Object.assign(new Error('Payment attempt is missing'), { code: 'PAYMENT_ATTEMPT_NOT_FOUND' });
  assertActiveJobLeaseInTransaction(db, { jobId: workerJob.jobId, leaseToken: workerJob.leaseToken,
    subjectType: 'TOPUP', subjectId: attempt.topup_id });
}

function recordAttemptSent(db, attemptId, workerJob) {
  withImmediateTransaction(db, () => {
    assertPaymentAttemptLease(db, attemptId, workerJob);
    db.prepare("UPDATE payment_attempts SET dispatch_state='POSSIBLY_SENT' WHERE id=?").run(attemptId);
  });
}

function recordAttemptResponse(db, attemptId, workerJob, {
  dispatchState = 'RESPONSE_RECEIVED', httpStatus = null, providerCode = null, evidence = {},
} = {}) {
  withImmediateTransaction(db, () => {
    assertPaymentAttemptLease(db, attemptId, workerJob);
    db.prepare(`UPDATE payment_attempts SET dispatch_state=?,provider_http_status=?,provider_code=?,evidence_json=?,completed_at=?
      WHERE id=? AND completed_at IS NULL`).run(dispatchState, Number(httpStatus) || null,
      providerCode == null ? null : String(providerCode).slice(0, 100), JSON.stringify(evidence), nowMs(), attemptId);
  });
}

function enqueueVerifiedMonitorAnnouncements(db) {
  if (!currentFeatureGates(db).QUEST_ANNOUNCEMENT_ENABLED) return 0;
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const rows = db.prepare("SELECT * FROM quests WHERE monitor_status='TEST_PASSED' AND announcement_status='NOT_ANNOUNCED'").all();
    for (const quest of rows) {
      const changed = db.prepare(`UPDATE quests SET announcement_status='QUEUED',state_version=state_version+1,updated_at=?
        WHERE quest_id=? AND announcement_status='NOT_ANNOUNCED' AND state_version=?`).run(timestamp, quest.quest_id, quest.state_version);
      if (changed.changes) {
        // Unique notification identity makes this restart-safe and prevents
        // a gate toggle from bumping a durable desired version.
        db.prepare(`INSERT INTO notifications(id,notification_type,aggregate_type,aggregate_id,destination,nonce,state,next_run_at,payload_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?, 'PENDING',?,?,?,?) ON CONFLICT(notification_type,aggregate_type,aggregate_id,destination) DO NOTHING`)
          .run(randomUUID(), 'QUEST_NEW', 'QUEST', quest.quest_id, 'QUEST_NEW', randomUUID(), timestamp,
            JSON.stringify({ questId: quest.quest_id, verifiedByMonitor: true }), timestamp, timestamp);
      }
    }
    return rows.length;
  });
}

export async function processPaymentJob(runtime, job) {
  const workerJob = { jobId: job.id, leaseToken: job.lease_token };
  let topup = runtime.db.prepare('SELECT * FROM topups WHERE id=?').get(job.subject_id);
  if (topup?.status === 'REDEEMED') {
    creditRedeemedTopup(runtime.db, { topupId: topup.id, workerJob });
    return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token });
  }
  topup = markTopupProcessing(runtime.db, job.subject_id, { workerJob });
  if (!topup || topup.status === 'CREDITED') return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token });
  const credential = runtime.db.prepare("SELECT * FROM credentials WHERE subject_type='TOPUP' AND subject_id=? AND credential_type='VOUCHER'").get(topup.id);
  const receiver = getReceiverPhone(runtime.db, runtime.env);
  if (!credential || !receiver) {
    moveTopupToReview(runtime.db, { topupId: topup.id, reasonCode: 'PAYMENT_CREDENTIAL_UNAVAILABLE', safeReason: 'ข้อมูลรับเงินไม่พร้อมสำหรับตรวจซอง', workerJob });
    return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token, state: 'REVIEW', errorCode: 'PAYMENT_CREDENTIAL_UNAVAILABLE' });
  }
  let voucher;
  try { voucher = normalizeVoucherUrl(decryptCredential(runtime.env.QUESTSHOP_SECRET_KEY, credential)); } catch {
    moveTopupToReview(runtime.db, { topupId: topup.id, reasonCode: 'VOUCHER_DECRYPT_FAILED', safeReason: 'ไม่สามารถอ่านข้อมูลซองอย่างปลอดภัย', workerJob });
    return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token, state: 'REVIEW', errorCode: 'VOUCHER_DECRYPT_FAILED' });
  }
  const attemptId = createAttempt(runtime.db, topup.id, Number(topup.attempt_count) + 1, topup.trace_id, workerJob);
  if (!markJobPossiblySent(runtime.db, { jobId: job.id, leaseToken: job.lease_token })) {
    throw Object.assign(new Error('Payment lease lost before provider dispatch'), { code: 'JOB_LEASE_LOST' });
  }
  recordAttemptSent(runtime.db, attemptId, workerJob);
  try {
    const provider = runtime.paymentProvider ?? redeemVoucher;
    const result = await provider({ code: voucher.code, receiverPhone: receiver.phone, signal: runtime.abortController.signal });
    if (result.outcome === EXTERNAL_OUTCOME.SUCCESS && result.currency === 'THB' && Number(result.amountCents) > 0) {
      recordRedeemedTopup(runtime.db, { topupId: topup.id, principalCents: result.amountCents,
        providerTransactionId: result.providerTransactionId ?? null, receiverLast4: receiver.last4,
        providerEvidence: result.providerEvidence ?? { httpStatus: result.httpStatus }, workerJob });
      creditRedeemedTopup(runtime.db, { topupId: topup.id, workerJob });
      return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token });
    }
    if (result.outcome === EXTERNAL_OUTCOME.DEFINITE_FAILURE) {
      const reason = result.reason ?? result.providerCode ?? 'PROVIDER_REJECTED';
      recordAttemptResponse(runtime.db, attemptId, workerJob, { providerCode: reason,
        httpStatus: result.httpStatus ?? result.evidence?.httpStatus, evidence: result.providerEvidence ?? result.evidence ?? {} });
      failTopup(runtime.db, { topupId: topup.id, reasonCode: reason, workerJob });
      return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token, state: 'FAILED', errorCode: reason });
    }
    // Any unknown adapter result follows the same path as an uncertain
    // transport result.  A payment request was already dispatched, so the
    // safe outcome is Reserved-for-review, never an automatic rejection.
    const reason = result.reason ?? result.providerCode ?? 'PROVIDER_RESULT_AMBIGUOUS';
    recordAttemptResponse(runtime.db, attemptId, workerJob, { providerCode: reason,
      httpStatus: result.httpStatus ?? result.evidence?.httpStatus, evidence: result.providerEvidence ?? result.evidence ?? {} });
    moveTopupToReview(runtime.db, { topupId: topup.id, reasonCode: reason,
      safeReason: 'ระบบยังยืนยันผลจาก TrueMoney ไม่ได้ จึงส่งให้ผู้ดูแลตรวจสอบ', workerJob });
    return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token, state: 'REVIEW',
      errorCode: reason, checkpoint: 'POSSIBLY_SENT' });
  } catch (error) {
    if (error.code === 'PROVIDER_NOT_SENT' || error.code === 'PAYMENT_INTENT_CHECKPOINT_FAILED') {
      recordAttemptResponse(runtime.db, attemptId, workerJob, { dispatchState: 'CONFIRMED_NOT_SENT', providerCode: error.code });
      return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token, retryAt: nowMs() + 15_000,
        errorCode: error.code, checkpoint: 'NOT_STARTED' });
    }
    recordAttemptResponse(runtime.db, attemptId, workerJob, {
      dispatchState: 'POSSIBLY_SENT', providerCode: error.code ?? 'PROVIDER_RESULT_AMBIGUOUS',
      httpStatus: error?.details?.httpStatus,
      evidence: error?.details && typeof error.details === 'object' ? error.details : {},
    });
    moveTopupToReview(runtime.db, { topupId: topup.id, reasonCode: error.code ?? 'PROVIDER_RESULT_AMBIGUOUS',
      safeReason: 'ระบบยังยืนยันผลจาก TrueMoney ไม่ได้ จึงส่งให้ผู้ดูแลตรวจสอบ', workerJob });
    return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token, state: 'REVIEW',
      errorCode: error.code ?? 'PROVIDER_RESULT_AMBIGUOUS', checkpoint: 'POSSIBLY_SENT' });
  }
}

async function processNonPaymentJob(runtime, job) {
  if (['CUSTOMER_QUEST_DISCOVERY', 'MONITOR_SEARCH', 'MONITOR_TEST', 'QUEST_RUN'].includes(job.job_type)) {
    return processQuestWorkflowJob(runtime, job);
  }
  // Optional maintenance extensions may still be injected at the runtime
  // edge.  Unknown work never mutates money or Quest state by itself.
  const processor = runtime.jobProcessors?.[job.job_type];
  if (!processor) return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token,
    state: 'REVIEW', errorCode: 'JOB_PROCESSOR_NOT_CONFIGURED' });
  try {
    await processor(job, runtime);
    return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token });
  } catch (error) {
    return completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token,
      state: 'REVIEW', errorCode: error.code ?? 'PROCESSOR_FAILED' });
  }
}

async function destinationFor(runtime, notification) {
  if (notification.destination.startsWith('DM:')) {
    const user = await runtime.client.users.fetch(notification.destination.slice(3));
    return user.createDM();
  }
  const surfaces = runtime.config.surfaces ?? {};
  const configured = surfaces[notification.destination];
  if (!configured?.channelId) throw Object.assign(new Error('Discord surface is not configured'), { code: 'SURFACE_UNAVAILABLE' });
  const channel = await runtime.client.channels.fetch(configured.channelId);
  if (!channel?.isTextBased?.()) throw Object.assign(new Error('Discord surface channel is unavailable'), { code: 'SURFACE_UNAVAILABLE' });
  return channel;
}

/**
 * A Discord send can succeed just before the process crashes, leaving the
 * notification without its message id.  Search every message created since
 * the durable notification intent before considering a new send.  Stopping
 * at the intent timestamp makes the search finite while still preventing a
 * duplicate after restart; a nonce is generated before the intent is saved.
 */
async function findNotificationByNonce(channel, notification) {
  const nonce = String(notification.nonce);
  const earliest = Number(notification.created_at) || 0;
  let before;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const messages = page?.values ? [...page.values()] : [];
    const match = messages.find((candidate) => String(candidate.nonce ?? '') === nonce);
    if (match) return match;
    if (!messages.length) return null;
    const oldest = messages.at(-1);
    if (Number(oldest?.createdTimestamp ?? 0) < earliest) return null;
    if (!oldest?.id || oldest.id === before) break;
    before = oldest.id;
  }
  // Sending after a bounded/incomplete reconciliation would risk a duplicate.
  // Keep the intent retryable and alertable instead.
  throw Object.assign(new Error('Unable to exhaust Discord nonce reconciliation'), { code: 'NONCE_RECONCILIATION_EXHAUSTED' });
}

function notificationDeliveryIsCurrent(db, notification) {
  const current = db.prepare(`SELECT state,lease_token,desired_version,sending_version FROM notifications WHERE id=?`).get(notification.id);
  return Boolean(current && current.state === 'SENDING' && current.lease_token === notification.lease_token
    && Number(current.desired_version) === Number(notification.sending_version));
}

export async function deliverNotification(runtime, notification) {
  if (notification.notification_type === 'QUEST_NEW' && !currentFeatureGates(runtime.db).QUEST_ANNOUNCEMENT_ENABLED) {
    deferNotification(runtime.db, { notificationId: notification.id, leaseToken: notification.lease_token, retryAt: nowMs() + 60_000,
      reason: 'QUEST_ANNOUNCEMENT_DISABLED' });
    return;
  }
  const financial = ['TOPUP_STATUS_DM', 'PAYMENT_LOG'].includes(notification.notification_type);
  try {
    const [channel, payload] = await Promise.all([
      destinationFor(runtime, notification), renderSqliteNotification(runtime, notification),
    ]);
    const body = normalizeDiscordPayload({ ...payload, nonce: notification.nonce });
    let message = null;
    if (notification.message_id) {
      try { message = await channel.messages.fetch(notification.message_id); }
      catch (error) {
        // Only Discord's explicit "unknown message" response authorizes a
        // replacement.  Permission and transport failures must retry the
        // existing delivery instead of creating a duplicate durable message.
        if (!(Number(error?.status) === 404 || Number(error?.code) === 10008)) throw error;
      }
    }
    if (!message) message = await findNotificationByNonce(channel, notification);
    // A newer desired version may have been saved while this worker awaited
    // Discord reads.  Release this old lease without publishing stale content.
    if (!notificationDeliveryIsCurrent(runtime.db, notification)) {
      finishNotificationDelivery(runtime.db, { notificationId: notification.id, leaseToken: notification.lease_token, financial });
      return;
    }
    if (message) await message.edit(body);
    else message = await channel.send(body);
    const delivered = finishNotificationDelivery(runtime.db, { notificationId: notification.id, leaseToken: notification.lease_token,
      messageId: message.id, financial });
    if (notification.notification_type === 'QUEST_NEW' && delivered) {
      withImmediateTransaction(runtime.db, () => runtime.db.prepare(`UPDATE quests SET announcement_status='ANNOUNCED',state_version=state_version+1,updated_at=?
        WHERE quest_id=? AND announcement_status='QUEUED'`).run(nowMs(), notification.aggregate_id));
    }
  } catch (error) {
    const failed = finishNotificationDelivery(runtime.db, { notificationId: notification.id, leaseToken: notification.lease_token,
      errorCode: error.code ?? error.status ?? 'DISCORD_DELIVERY_FAILED', financial });
    if (failed?.state === 'DEAD_LETTER' && notification.notification_type !== 'SYSTEM_LOG') {
      recordSystemIncident(runtime.db, { code: 'DISCORD_DELIVERY_FAILED', scope: notification.destination,
        severity: financial ? 'ERROR' : 'WARNING', details: { notificationType: notification.notification_type } });
    }
  }
}

export function createSqliteWorkers({ runtime }) {
  let task = null;
  const activeJobs = new Set();
  const activePayments = new Set();
  const maxActiveJobs = Math.max(1, Number(runtime.env.RUNNER_CONCURRENCY) || 1);
  function requiredGate(job) {
    if (job.job_type === 'PAYMENT_SETTLE') return 'AUTO_CREDIT_ENABLED';
    if (job.job_type === 'CUSTOMER_QUEST_DISCOVERY') return 'QUEST_SCANNER_ENABLED';
    if (job.job_type === 'MONITOR_SEARCH' || job.job_type === 'MONITOR_TEST') return 'QUEST_BACKGROUND_TESTING_ENABLED';
    if (job.job_type === 'QUEST_RUN') return 'RUNNER_DISPATCH_ENABLED';
    return null;
  }
  function dispatchJob(job) {
    const taskPromise = (async () => {
      // Network work may take longer than the normal job lease.  Renew only
      // while this worker owns the token; every later state change still uses
      // the same token, so a stale worker cannot settle money or overwrite a
      // newer recovery attempt.
      const jobAbortController = new AbortController();
      const abortForShutdown = () => jobAbortController.abort(runtime.abortController.signal.reason ?? 'shutdown');
      runtime.abortController.signal.addEventListener('abort', abortForShutdown, { once: true });
      const workerRuntime = { ...runtime, abortController: jobAbortController };
      const leaseTimer = setInterval(() => {
        try {
          const renewed = renewJobLease(runtime.db, { jobId: job.id, leaseToken: job.lease_token });
          if (!renewed) {
            jobAbortController.abort('job lease lost');
            runtime.logger?.warn?.({ jobId: job.id }, 'SQLite job lease was lost');
          }
        } catch (error) {
          jobAbortController.abort('job lease renewal failed');
          runtime.logger?.warn?.({ error, jobId: job.id }, 'SQLite job lease renewal failed');
        }
      }, 10_000);
      leaseTimer.unref?.();
      try {
        const gate = requiredGate(job);
        if (gate && !currentFeatureGates(runtime.db)[gate]) {
          await completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token, retryAt: nowMs() + 60_000,
            errorCode: `${gate}_DISABLED`, checkpoint: job.checkpoint });
          return;
        }
        if (job.job_type === 'PAYMENT_SETTLE') await processPaymentJob(workerRuntime, job);
        else await processNonPaymentJob(workerRuntime, job);
      } catch (error) {
        runtime.logger?.error?.({ error, jobId: job.id, jobType: job.job_type }, 'SQLite job failed');
        await completeJob(runtime.db, { jobId: job.id, leaseToken: job.lease_token, state: 'REVIEW',
          errorCode: error?.code ?? 'JOB_UNHANDLED_ERROR', checkpoint: job.checkpoint === 'POSSIBLY_SENT' ? 'POSSIBLY_SENT' : 'VERIFIED' });
      } finally {
        clearInterval(leaseTimer);
        runtime.abortController.signal.removeEventListener('abort', abortForShutdown);
      }
    })();
    const active = job.job_type === 'PAYMENT_SETTLE' ? activePayments : activeJobs;
    active.add(taskPromise);
    void taskPromise.finally(() => active.delete(taskPromise));
  }
  const runOne = async () => {
    const payment = activePayments.size < 1 ? claimDueJob(runtime.db, { jobType: 'PAYMENT_SETTLE' }) : null;
    if (payment) dispatchJob(payment);
    const job = activeJobs.size < maxActiveJobs ? claimDueJob(runtime.db, { excludeJobTypes: ['PAYMENT_SETTLE'] }) : null;
    if (job) dispatchJob(job);
    const notification = currentFeatureGates(runtime.db).NOTIFICATIONS_ENABLED ? claimDueNotification(runtime.db) : null;
    if (notification) await deliverNotification(runtime, notification);
    return Boolean(payment || job || notification);
  };
  const run = async () => {
    recoverInterruptedSubjects(runtime);
    recoverSendingNotifications(runtime.db);
    let cleanupAt = 0;
    let backupAt = 0;
    let reconcileAt = 0;
    let announcementAt = 0;
    while (!runtime.abortController.signal.aborted) {
      try {
        const work = await runOne();
        if (nowMs() >= cleanupAt) {
          if (currentFeatureGates(runtime.db).RETENTION_JOBS_ENABLED) cleanupExpiredRows(runtime.db);
          cleanupAt = nowMs() + 60_000;
        }
        if (nowMs() >= backupAt) {
          await createDailyBackupIfDue(runtime).catch((error) => runtime.logger?.error?.({ error }, 'SQLite daily backup failed'));
          backupAt = nowMs() + 3_600_000;
        }
        if (nowMs() >= reconcileAt) {
          await reconcileSurfaceAnchors({ runtime }).catch((error) => runtime.logger?.warn?.({ error }, 'Discord surface reconciliation deferred'));
          reconcileAt = nowMs() + 60_000;
        }
        if (nowMs() >= announcementAt) {
          enqueueVerifiedMonitorAnnouncements(runtime.db);
          announcementAt = nowMs() + 60_000;
        }
        runtime.health.checks.database = 'OK';
        // Readiness is derived from all startup/runtime checks, not merely
        // whether this worker loop happened to complete once.
        runtime.health.ready = !Object.values(runtime.health.checks).some((value) =>
          ['DEGRADED', 'FAILED', 'INVALID', 'MISSING_RECEIVER', 'NOT_READY', 'LOST'].includes(value));
        runtime.health.status = recomputeHealthStatus({ health: runtime.health });
        if (!work) await delay(500, undefined, { signal: runtime.abortController.signal, ref: false }).catch(() => null);
      } catch (error) {
        runtime.health.checks.database = 'DEGRADED';
        runtime.health.status = recomputeHealthStatus({ health: runtime.health });
        runtime.health.ready = false;
        runtime.health.lastError = error;
        runtime.logger.error({ error }, 'SQLite worker iteration failed');
        recordSystemIncident(runtime.db, { code: error.code ?? 'WORKER_ITERATION_FAILED', scope: 'RUNTIME', severity: 'ERROR' });
        await delay(1_000, undefined, { signal: runtime.abortController.signal, ref: false }).catch(() => null);
      }
    }
  };
  return {
    start() { task ??= run(); return task; },
    async stop() {
      runtime.abortController.abort('shutdown');
      await task?.catch(() => null);
      await Promise.allSettled([...activeJobs, ...activePayments]);
    },
    async processTopupNow(topupId) {
      runtime.db.prepare("UPDATE jobs SET next_run_at=?,state_version=state_version+1 WHERE job_type='PAYMENT_SETTLE' AND subject_id=? AND state IN ('PENDING','RETRY_WAIT')")
        .run(nowMs(), topupId);
      return runOne();
    },
  };
}
