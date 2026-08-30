import { randomUUID } from 'node:crypto';
import { normalizeVoucherUrl } from '../../adapters/truemoney/voucher.js';
import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';
import { CURRENT_VOUCHER_HMAC_VERSION, encryptCredential, voucherHmac, voucherIdentityHmac } from './crypto.js';
import { enqueueNotificationInTransaction } from './notifications.js';
import { appendWalletTransactionInTransaction } from './wallet.js';
import { QuestshopError } from '../../shared/errors.js';
import { percentageBonusHalfUp } from '../../shared/money.js';
import { appendExternalOperationEvidenceInTransaction, assertActiveJobLeaseInTransaction } from './jobs.js';

const TEMPORARY_CREDENTIAL_LIFETIME_MS = 7 * 86_400_000;

export function submitTopup(db, env, { discordUserId, voucherUrl, traceId = randomUUID(), prelaunch = false }) {
  const voucher = normalizeVoucherUrl(voucherUrl);
  const voucherHmacVersion = env.VOUCHER_HMAC_ACTIVE_VERSION ?? CURRENT_VOUCHER_HMAC_VERSION;
  const fingerprint = voucherHmac(env.QUESTSHOP_SECRET_KEY, voucher.code, voucherHmacVersion);
  const identity = voucherIdentityHmac(env.QUESTSHOP_SECRET_KEY, voucher.code);
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const existing = db.prepare('SELECT * FROM topups WHERE voucher_identity_hmac=?').get(identity);
    if (existing) {
      if (existing.discord_user_id !== discordUserId) {
        throw new QuestshopError('NOT_AUTHORIZED', 'ซองนี้ถูกใช้กับรายการเติมเงินของบัญชีอื่นแล้ว', {
          category: 'AUTHORIZATION',
        });
      }
      return { topup: existing, idempotent: true };
    }
    const topupId = randomUUID();
    const encrypted = encryptCredential(env.QUESTSHOP_SECRET_KEY, voucher.url);
    db.prepare(`INSERT INTO topups(id,discord_user_id,voucher_hmac_version,voucher_identity_hmac,voucher_hmac,status,prelaunch,trace_id,created_at,updated_at)
      VALUES(?,?,?,?,?,'PENDING',?,?,?,?)`).run(topupId, discordUserId, voucherHmacVersion, identity, fingerprint, prelaunch ? 1 : 0, traceId, timestamp, timestamp);
    db.prepare(`INSERT INTO credentials(id,subject_type,subject_id,credential_type,retention_class,ciphertext,nonce,auth_tag,cleanup_after,created_at,updated_at)
      VALUES(?,?,?,'VOUCHER','TEMPORARY',?,?,?,?,?,?)`).run(randomUUID(), 'TOPUP', topupId,
      encrypted.ciphertext, encrypted.nonce, encrypted.authTag, timestamp + TEMPORARY_CREDENTIAL_LIFETIME_MS, timestamp, timestamp);
    db.prepare(`INSERT INTO jobs(id,job_type,subject_type,subject_id,operation_key,state,checkpoint,next_run_at,created_at,updated_at)
      VALUES(?,?, 'TOPUP', ?, ?, 'PENDING','NOT_STARTED',?,?,?)`).run(randomUUID(), 'PAYMENT_SETTLE', topupId,
      `payment-settlement:${topupId}`, timestamp, timestamp, timestamp);
    const topup = db.prepare('SELECT * FROM topups WHERE id=?').get(topupId);
    enqueueNotificationInTransaction(db, { notificationType: 'TOPUP_STATUS_DM', aggregateType: 'TOPUP', aggregateId: topupId,
      destination: `DM:${discordUserId}`, payload: { topupId }, timestamp });
    enqueueNotificationInTransaction(db, { notificationType: 'PAYMENT_LOG', aggregateType: 'TOPUP', aggregateId: topupId,
      destination: 'LOG_PAYMENTS', payload: { topupId }, timestamp });
    return { topup, idempotent: false };
  });
}

function enqueueTopupProjections(db, topup, timestamp = nowMs()) {
  enqueueNotificationInTransaction(db, { notificationType: 'TOPUP_STATUS_DM', aggregateType: 'TOPUP', aggregateId: topup.id,
    destination: `DM:${topup.discord_user_id}`, payload: { topupId: topup.id }, timestamp });
  enqueueNotificationInTransaction(db, { notificationType: 'PAYMENT_LOG', aggregateType: 'TOPUP', aggregateId: topup.id,
    destination: 'LOG_PAYMENTS', payload: { topupId: topup.id }, timestamp });
}

function activePromotion(db, timestamp) {
  const row = db.prepare(`SELECT * FROM promotions WHERE state='ACTIVE'
    AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?)`).get(timestamp, timestamp);
  if (!row) return null;
  try { return { ...row, rule: JSON.parse(row.rule_json) }; } catch { return null; }
}

function promotionSnapshot(db, principalCents, timestamp) {
  const promotion = activePromotion(db, timestamp);
  if (!promotion) return { bonusCents: 0, snapshot: null };
  const rule = promotion.rule ?? {};
  const minimum = Number(rule.minimumCents ?? rule.minCents ?? 0);
  const basisPoints = Number(rule.basisPoints ?? rule.bonusBasisPoints ?? 0);
  const maximum = rule.maximumBonusCents ?? rule.maxBonusCents;
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(basisPoints) || principalCents < minimum || basisPoints < 0) {
    return { bonusCents: 0, snapshot: null };
  }
  let bonus = Number(percentageBonusHalfUp(principalCents, basisPoints));
  if (maximum != null && Number.isSafeInteger(Number(maximum))) bonus = Math.min(bonus, Number(maximum));
  return { bonusCents: bonus, snapshot: { id: promotion.id, name: promotion.name, basisPoints, minimumCents: minimum, bonusCents: bonus } };
}

function openFinancialReview(db, topup, reasonCode, safeReason, timestamp) {
  db.prepare(`INSERT INTO manual_reviews(id,subject_type,subject_id,category,state,reason_code,safe_reason,created_at,updated_at)
    VALUES(?,?,?,'FINANCIAL','OPEN',?,?,?,?)
    ON CONFLICT(subject_type,subject_id) WHERE state='OPEN' DO UPDATE SET reason_code=excluded.reason_code,
      safe_reason=excluded.safe_reason,updated_at=excluded.updated_at`).run(
    randomUUID(), 'TOPUP', topup.id, reasonCode, safeReason, timestamp, timestamp,
  );
}

function appendFinancialAudit(db, { actorId, action, topupId, reason = null, before = null, after = null, traceId, timestamp }) {
  const id = randomUUID();
  db.prepare(`INSERT INTO admin_audit(id,actor_id,action,target_type,target_id,reason,before_json,after_json,trace_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, actorId, action, 'TOPUP', topupId, reason,
    before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), traceId, timestamp);
  enqueueNotificationInTransaction(db, { notificationType: 'ADMIN_LOG', aggregateType: 'ADMIN_AUDIT', aggregateId: id,
    destination: 'LOG_ADMIN', payload: { auditId: id }, timestamp });
}

function assertPaymentWorkerLease(db, workerJob, topupId) {
  if (!workerJob) return;
  assertActiveJobLeaseInTransaction(db, { jobId: workerJob.jobId, leaseToken: workerJob.leaseToken,
    subjectType: 'TOPUP', subjectId: topupId });
}

function updatePaymentAttemptInTransaction(db, {
  topupId, attemptId = null, dispatchState = 'RESPONSE_RECEIVED', outcome = null, httpStatus = null,
  providerCode = null, providerReference = null, reasonCode = null, evidence = {}, timestamp = nowMs(),
}) {
  const attempt = attemptId
    ? db.prepare('SELECT id FROM payment_attempts WHERE id=? AND topup_id=?').get(attemptId, topupId)
    : db.prepare('SELECT id FROM payment_attempts WHERE topup_id=? AND completed_at IS NULL ORDER BY attempt_number DESC LIMIT 1').get(topupId);
  if (!attempt) return null;
  db.prepare(`UPDATE payment_attempts SET dispatch_state=?,outcome=?,provider_http_status=?,provider_code=?,provider_reference=?,reason_code=?,
    evidence_json=?,completed_at=? WHERE id=? AND completed_at IS NULL`).run(
    dispatchState, outcome, Number(httpStatus) || null, providerCode == null ? null : String(providerCode).slice(0, 100),
    providerReference == null ? null : String(providerReference).slice(0, 200), reasonCode == null ? null : String(reasonCode).slice(0, 100),
    JSON.stringify(evidence), timestamp, attempt.id,
  );
  return attempt.id;
}

export function markTopupProcessing(db, topupId, { workerJob = null } = {}) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    assertPaymentWorkerLease(db, workerJob, topupId);
    const topup = db.prepare('SELECT * FROM topups WHERE id=?').get(topupId);
    if (!topup || !['PENDING', 'PROCESSING'].includes(topup.status)) return topup ?? null;
    db.prepare(`UPDATE topups SET status='PROCESSING',attempt_count=attempt_count+1,state_version=state_version+1,updated_at=?
      WHERE id=? AND state_version=?`).run(timestamp, topupId, topup.state_version);
    const updated = db.prepare('SELECT * FROM topups WHERE id=?').get(topupId);
    enqueueTopupProjections(db, updated, timestamp);
    return updated;
  });
}

/** Persist TrueMoney's verified result before touching the Wallet.  This is a
 * deliberate crash boundary: recovery can safely complete REDEEMED later. */
export function recordRedeemedTopup(db, {
  topupId, principalCents, bonusCents = null, providerTransactionId = null, providerEvidence = {}, receiverLast4 = null,
  attemptId = null, workerJob = null,
}) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    assertPaymentWorkerLease(db, workerJob, topupId);
    const topup = db.prepare('SELECT * FROM topups WHERE id=?').get(topupId);
    if (!topup) throw new QuestshopError('TOPUP_NOT_FOUND', 'ไม่พบรายการเติมเงิน');
    if (['REDEEMED', 'CREDITED'].includes(topup.status)) return { topup, idempotent: true };
    if (!['PENDING', 'PROCESSING'].includes(topup.status)) {
      throw new QuestshopError('TOPUP_STATE_INVALID', 'รายการเติมเงินไม่อยู่ในสถานะที่บันทึกผลได้');
    }
    const principal = Number(principalCents);
    if (!Number.isSafeInteger(principal) || principal <= 0) {
      throw new TypeError('Invalid verified top-up amount');
    }
    const promotion = bonusCents == null ? promotionSnapshot(db, principal, timestamp) : {
      bonusCents: Number(bonusCents), snapshot: Number(bonusCents) > 0 ? { source: 'VERIFIED_INPUT', bonusCents: Number(bonusCents) } : null,
    };
    if (!Number.isSafeInteger(promotion.bonusCents) || promotion.bonusCents < 0) throw new TypeError('Invalid verified bonus amount');
    db.prepare(`UPDATE topups SET status='REDEEMED',principal_cents=?,bonus_cents=?,credited_cents=?,promotion_snapshot_json=?,
      provider_transaction_id=?,receiver_last4=COALESCE(?,receiver_last4),failure_reason=NULL,redeemed_at=?,
      state_version=state_version+1,updated_at=? WHERE id=? AND state_version=?`).run(
      principal, promotion.bonusCents, principal + promotion.bonusCents, promotion.snapshot ? JSON.stringify(promotion.snapshot) : null,
      providerTransactionId, receiverLast4, timestamp, timestamp, topup.id, topup.state_version,
    );
    updatePaymentAttemptInTransaction(db, { topupId, attemptId, outcome: 'SUCCESS', httpStatus: providerEvidence.httpStatus,
      providerCode: 'SUCCESS', providerReference: providerTransactionId, evidence: providerEvidence, timestamp });
    if (workerJob) appendExternalOperationEvidenceInTransaction(db, { jobId: workerJob.jobId, subjectType: 'TOPUP', subjectId: topupId,
      stage: 'VERIFIED_RESULT', evidence: { outcome: 'SUCCESS', principalCents: principal, providerTransactionId, providerEvidence },
      traceId: topup.trace_id, timestamp });
    const updated = db.prepare('SELECT * FROM topups WHERE id=?').get(topupId);
    enqueueTopupProjections(db, updated, timestamp);
    return { topup: updated, idempotent: false };
  });
}

export function recordTopupDefiniteFailure(db, {
  topupId, attemptId = null, reasonCode, providerEvidence = {}, providerReference = null, workerJob = null,
}) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    assertPaymentWorkerLease(db, workerJob, topupId);
    const topup = db.prepare('SELECT * FROM topups WHERE id=?').get(topupId);
    if (!topup || ['CREDITED', 'REVERSED', 'REVIEW', 'FAILED'].includes(topup.status)) return topup ?? null;
    updatePaymentAttemptInTransaction(db, { topupId, attemptId, outcome: 'DEFINITE_FAILURE', httpStatus: providerEvidence.httpStatus,
      providerCode: reasonCode, providerReference, reasonCode, evidence: providerEvidence, timestamp });
    if (workerJob) appendExternalOperationEvidenceInTransaction(db, { jobId: workerJob.jobId, subjectType: 'TOPUP', subjectId: topupId,
      stage: 'VERIFIED_RESULT', evidence: { outcome: 'DEFINITE_FAILURE', reasonCode, providerReference, providerEvidence },
      traceId: topup.trace_id, timestamp });
    db.prepare(`UPDATE topups SET status='FAILED',failure_reason=?,state_version=state_version+1,updated_at=?
      WHERE id=? AND state_version=?`).run(reasonCode, timestamp, topupId, topup.state_version);
    const updated = db.prepare('SELECT * FROM topups WHERE id=?').get(topupId);
    enqueueTopupProjections(db, updated, timestamp);
    return updated;
  });
}

export function recordTopupAmbiguity(db, {
  topupId, attemptId = null, reasonCode, safeReason, providerEvidence = {}, workerJob = null,
}) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    assertPaymentWorkerLease(db, workerJob, topupId);
    const topup = db.prepare('SELECT * FROM topups WHERE id=?').get(topupId);
    if (!topup || ['CREDITED', 'REVERSED', 'REVIEW'].includes(topup.status)) return topup ?? null;
    updatePaymentAttemptInTransaction(db, { topupId, attemptId, outcome: 'AMBIGUOUS', httpStatus: providerEvidence.httpStatus,
      providerCode: reasonCode, reasonCode, evidence: providerEvidence, timestamp });
    db.prepare(`UPDATE topups SET status='REVIEW',failure_reason=?,state_version=state_version+1,updated_at=?
      WHERE id=? AND state_version=?`).run(reasonCode, timestamp, topupId, topup.state_version);
    const updated = db.prepare('SELECT * FROM topups WHERE id=?').get(topupId);
    openFinancialReview(db, updated, reasonCode, safeReason, timestamp);
    if (workerJob) appendExternalOperationEvidenceInTransaction(db, { jobId: workerJob.jobId, subjectType: 'TOPUP', subjectId: topupId,
      stage: 'AMBIGUOUS', evidence: { outcome: 'AMBIGUOUS', reasonCode, providerEvidence }, traceId: topup.trace_id, timestamp });
    enqueueTopupProjections(db, updated, timestamp);
    return updated;
  });
}

export function recordTopupNotSent(db, { topupId, attemptId, reasonCode, workerJob = null }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    assertPaymentWorkerLease(db, workerJob, topupId);
    updatePaymentAttemptInTransaction(db, { topupId, attemptId, dispatchState: 'CONFIRMED_NOT_SENT', providerCode: reasonCode,
      reasonCode, timestamp });
  });
}

export function creditRedeemedTopup(db, { topupId, workerJob = null }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    assertPaymentWorkerLease(db, workerJob, topupId);
    const topup = db.prepare('SELECT * FROM topups WHERE id=?').get(topupId);
    if (!topup) throw new QuestshopError('TOPUP_NOT_FOUND', 'ไม่พบรายการเติมเงิน');
    if (topup.status === 'CREDITED') return { topup, idempotent: true };
    if (topup.status !== 'REDEEMED') throw new QuestshopError('TOPUP_STATE_INVALID', 'รายการเติมเงินยังยืนยันไม่ครบ');
    const credit = appendWalletTransactionInTransaction(db, {
      discordUserId: topup.discord_user_id, transactionType: 'TOPUP', availableDeltaCents: Number(topup.credited_cents),
      referenceType: 'TOPUP', referenceId: topup.id, idempotencyKey: `topup-credit:${topup.id}`,
      traceId: topup.trace_id, timestamp,
    });
    db.prepare(`UPDATE topups SET status='CREDITED',wallet_transaction_id=?,credited_at=?,state_version=state_version+1,updated_at=?
      WHERE id=? AND state_version=?`).run(credit.transaction.id, timestamp, timestamp, topup.id, topup.state_version);
    const updated = db.prepare('SELECT * FROM topups WHERE id=?').get(topup.id);
    enqueueTopupProjections(db, updated, timestamp);
    return { topup: updated, wallet: credit.wallet, idempotent: credit.idempotent };
  });
}

/** Compatibility helper for callers/tests that already have a verified
 * provider result. Worker code uses the two durable stages above. */
export function creditVerifiedTopup(db, input) {
  const redeemed = recordRedeemedTopup(db, input);
  if (redeemed.topup.status === 'CREDITED') return redeemed;
  return creditRedeemedTopup(db, { topupId: input.topupId });
}

export function moveTopupToReview(db, { topupId, reasonCode, safeReason, workerJob = null }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    assertPaymentWorkerLease(db, workerJob, topupId);
    const topup = db.prepare('SELECT * FROM topups WHERE id=?').get(topupId);
    if (!topup || ['CREDITED', 'REVERSED', 'REVIEW'].includes(topup.status)) return topup ?? null;
    db.prepare(`UPDATE topups SET status='REVIEW',failure_reason=?,state_version=state_version+1,updated_at=? WHERE id=? AND state_version=?`)
      .run(reasonCode, timestamp, topupId, topup.state_version);
    const updated = db.prepare('SELECT * FROM topups WHERE id=?').get(topupId);
    openFinancialReview(db, updated, reasonCode, safeReason, timestamp);
    if (workerJob) appendExternalOperationEvidenceInTransaction(db, { jobId: workerJob.jobId, subjectType: 'TOPUP', subjectId: topupId,
      stage: 'AMBIGUOUS', evidence: { reasonCode }, traceId: topup.trace_id, timestamp });
    enqueueTopupProjections(db, updated, timestamp);
    return updated;
  });
}

export function failTopup(db, { topupId, reasonCode, workerJob = null }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    assertPaymentWorkerLease(db, workerJob, topupId);
    const topup = db.prepare('SELECT * FROM topups WHERE id=?').get(topupId);
    if (!topup || ['CREDITED', 'REVERSED', 'REVIEW'].includes(topup.status)) return topup ?? null;
    db.prepare(`UPDATE topups SET status='FAILED',failure_reason=?,state_version=state_version+1,updated_at=? WHERE id=? AND state_version=?`)
      .run(reasonCode, timestamp, topupId, topup.state_version);
    const updated = db.prepare('SELECT * FROM topups WHERE id=?').get(topupId);
    enqueueTopupProjections(db, updated, timestamp);
    return updated;
  });
}

export function reverseCreditedTopup(db, { topupId, actorId = 'SYSTEM', reason = 'REVERSAL_APPROVED' }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const topup = db.prepare('SELECT * FROM topups WHERE id=?').get(topupId);
    if (!topup) throw new QuestshopError('TOPUP_NOT_FOUND', 'ไม่พบรายการเติมเงิน');
    if (topup.status === 'REVERSED') return { topup, idempotent: true };
    if (topup.status !== 'CREDITED') throw new QuestshopError('TOPUP_STATE_INVALID', 'รายการนี้ยังย้อนเครดิตไม่ได้');
    let reversal;
    try {
      reversal = appendWalletTransactionInTransaction(db, {
        discordUserId: topup.discord_user_id, transactionType: 'REVERSAL', availableDeltaCents: -Number(topup.credited_cents),
        referenceType: 'TOPUP', referenceId: topup.id, idempotencyKey: `topup-reversal:${topup.id}`,
        traceId: topup.trace_id, reason, timestamp,
      });
    } catch (error) {
      if (error.code === 'INSUFFICIENT_BALANCE') {
        openFinancialReview(db, topup, 'REVERSAL_INSUFFICIENT_BALANCE', 'เครดิตคงเหลือไม่พอสำหรับย้อนรายการ', timestamp);
        return { topup, idempotent: false, reviewOpened: true };
      }
      throw error;
    }
    db.prepare(`UPDATE topups SET status='REVERSED',failure_reason=?,state_version=state_version+1,updated_at=? WHERE id=? AND state_version=?`)
      .run(reason, timestamp, topup.id, topup.state_version);
    appendFinancialAudit(db, { actorId, action: 'TOPUP_REVERSED', topupId: topup.id, reason,
      before: { status: 'CREDITED' }, after: { status: 'REVERSED', walletTransactionId: reversal.transaction.id },
      traceId: topup.trace_id, timestamp });
    const updated = db.prepare('SELECT * FROM topups WHERE id=?').get(topup.id);
    enqueueTopupProjections(db, updated, timestamp);
    return { topup: updated, wallet: reversal.wallet, idempotent: false };
  });
}

/**
 * Financial review is intentionally a two-confirmation operation.  The first
 * confirmation only records intent; the second performs the selected wallet
 * mutation in the same SQLite transaction as the Top-up/review transition.
 * This function is the domain boundary used by an Admin panel, never by a
 * customer interaction.
 */
export function resolveTopupFinancialReview(db, {
  reviewId, actorId, decision, reason = '', principalCents = null, providerEvidence = {}, providerTransactionId = null,
}) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const review = db.prepare("SELECT * FROM manual_reviews WHERE id=? AND subject_type='TOPUP' AND category='FINANCIAL'").get(reviewId);
    if (!review) throw new QuestshopError('REVIEW_NOT_FOUND', 'ไม่พบรายการที่รอตรวจสอบ');
    if (['RESOLVED_SUCCESS', 'RESOLVED_FAILURE'].includes(review.state)) {
      return { state: review.state, idempotent: true, decision: review.decision };
    }
    if (review.state !== 'OPEN') throw new QuestshopError('REVIEW_NOT_OPEN', 'รายการนี้ไม่ได้รอตรวจสอบแล้ว');
    if (!review.first_confirmation_at) {
      const changed = db.prepare(`UPDATE manual_reviews SET first_confirmation_by=?,first_confirmation_at=?,state_version=state_version+1,updated_at=?
        WHERE id=? AND state='OPEN' AND state_version=?`).run(actorId, timestamp, timestamp, review.id, review.state_version);
      if (!changed.changes) throw new QuestshopError('REVIEW_CONFLICT', 'รายการถูกแก้ไขพร้อมกัน กรุณาลองใหม่');
      appendFinancialAudit(db, { actorId, action: 'MANUAL_REVIEW_DECISION', topupId: review.subject_id,
        reason: `ยืนยันขั้นที่ 1${reason ? `: ${reason}` : ''}`, after: { decision: 'FIRST_CONFIRMATION', status: 'OPEN' },
        traceId: topupTraceId(db, review.subject_id), timestamp });
      return { state: 'AWAITING_SECOND_CONFIRMATION' };
    }
    if (review.first_confirmation_by !== actorId) {
      throw new QuestshopError('REVIEW_CONFIRMATION_ACTOR_MISMATCH', 'ผู้ดูแลคนเดิมต้องยืนยันขั้นที่ 2');
    }
    const topup = db.prepare('SELECT * FROM topups WHERE id=?').get(review.subject_id);
    if (!topup) throw new QuestshopError('TOPUP_NOT_FOUND', 'ไม่พบรายการเติมเงิน');
    let nextStatus;
    if (decision === 'CREDIT') {
      const principal = Number(principalCents);
      const httpStatus = Number(providerEvidence?.httpStatus);
      if (topup.status !== 'REVIEW' || !Number.isSafeInteger(principal) || principal <= 0 || httpStatus < 200 || httpStatus >= 300
        || providerEvidence?.providerCode !== 'SUCCESS' || providerEvidence?.receiverConfirmation !== 'REQUEST_BOUND_SUCCESS') {
        throw new QuestshopError('REVIEW_EVIDENCE_INCOMPLETE', 'หลักฐาน TrueMoney ยังไม่ครบสำหรับเพิ่มเครดิต');
      }
      const promotion = promotionSnapshot(db, principal, timestamp);
      db.prepare(`UPDATE topups SET status='REDEEMED',principal_cents=?,bonus_cents=?,credited_cents=?,promotion_snapshot_json=?,
        provider_transaction_id=?,receiver_last4=COALESCE(?,receiver_last4),failure_reason=NULL,redeemed_at=?,state_version=state_version+1,updated_at=?
        WHERE id=? AND status='REVIEW' AND state_version=?`).run(principal, promotion.bonusCents, principal + promotion.bonusCents,
        promotion.snapshot ? JSON.stringify(promotion.snapshot) : null, providerTransactionId, providerEvidence.receiverLast4 ?? null,
        timestamp, timestamp, topup.id, topup.state_version);
      const redeemed = db.prepare('SELECT * FROM topups WHERE id=?').get(topup.id);
      const credit = appendWalletTransactionInTransaction(db, { discordUserId: redeemed.discord_user_id, transactionType: 'TOPUP',
        availableDeltaCents: Number(redeemed.credited_cents), referenceType: 'TOPUP', referenceId: redeemed.id,
        idempotencyKey: `topup-credit:${redeemed.id}`, traceId: redeemed.trace_id, timestamp });
      db.prepare(`UPDATE topups SET status='CREDITED',wallet_transaction_id=?,credited_at=?,state_version=state_version+1,updated_at=?
        WHERE id=? AND status='REDEEMED' AND state_version=?`).run(credit.transaction.id, timestamp, timestamp, redeemed.id, redeemed.state_version);
      nextStatus = 'CREDITED';
    } else if (decision === 'REJECT') {
      if (topup.status !== 'REVIEW') throw new QuestshopError('TOPUP_STATE_INVALID', 'สถานะเติมเงินนี้ปฏิเสธไม่ได้');
      db.prepare(`UPDATE topups SET status='FAILED',failure_reason='OWNER_REJECTED',state_version=state_version+1,updated_at=?
        WHERE id=? AND state_version=?`).run(timestamp, topup.id, topup.state_version);
      nextStatus = 'FAILED';
    } else if (decision === 'REVERSE') {
      if (topup.status !== 'CREDITED') throw new QuestshopError('TOPUP_STATE_INVALID', 'รายการนี้ยังย้อนเครดิตไม่ได้');
      let reversal;
      try {
        reversal = appendWalletTransactionInTransaction(db, { discordUserId: topup.discord_user_id, transactionType: 'REVERSAL',
          availableDeltaCents: -Number(topup.credited_cents), referenceType: 'TOPUP', referenceId: topup.id,
          idempotencyKey: `topup-reversal:${topup.id}`, traceId: topup.trace_id, reason, timestamp });
      } catch (error) {
        if (error.code === 'INSUFFICIENT_BALANCE') throw new QuestshopError('REVERSAL_INSUFFICIENT_BALANCE', 'เครดิตคงเหลือไม่พอสำหรับย้อนรายการ');
        throw error;
      }
      db.prepare(`UPDATE topups SET status='REVERSED',failure_reason=?,state_version=state_version+1,updated_at=?
        WHERE id=? AND state_version=?`).run(reason || 'OWNER_REVERSAL', timestamp, topup.id, topup.state_version);
      nextStatus = reversal.transaction ? 'REVERSED' : 'CREDITED';
    } else {
      throw new QuestshopError('REVIEW_DECISION_INVALID', 'รูปแบบการตัดสินใจไม่ถูกต้อง');
    }
    const resolvedState = decision === 'CREDIT' ? 'RESOLVED_SUCCESS' : 'RESOLVED_FAILURE';
    const resolved = db.prepare(`UPDATE manual_reviews SET state=?,decision=?,resolved_by=?,resolved_at=?,state_version=state_version+1,updated_at=?
      WHERE id=? AND state='OPEN' AND state_version=?`).run(resolvedState, decision, actorId, timestamp, timestamp, review.id, review.state_version);
    if (!resolved.changes) throw new QuestshopError('REVIEW_CONFLICT', 'รายการถูกแก้ไขพร้อมกัน กรุณาลองใหม่');
    const updated = db.prepare('SELECT * FROM topups WHERE id=?').get(topup.id);
    enqueueTopupProjections(db, updated, timestamp);
    appendFinancialAudit(db, { actorId, action: 'MANUAL_REVIEW_DECISION', topupId: topup.id, reason,
      before: { status: topup.status }, after: { decision, status: nextStatus }, traceId: topup.trace_id, timestamp });
    return { state: resolvedState, decision, topup: updated, status: nextStatus };
  });
}

function topupTraceId(db, topupId) {
  return db.prepare('SELECT trace_id FROM topups WHERE id=?').get(topupId)?.trace_id ?? randomUUID();
}
