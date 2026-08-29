import { randomUUID } from 'node:crypto';
import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';
import { appendWalletTransactionInTransaction } from './wallet.js';
import { enqueueNotificationInTransaction } from './notifications.js';
import { QuestshopError } from '../../shared/errors.js';
import { assertActiveJobLeaseInTransaction } from './jobs.js';

function refreshOrderState(db, orderId, timestamp) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  const items = db.prepare('SELECT state FROM order_items WHERE order_id=?').all(orderId);
  const states = items.map((item) => item.state);
  const state = states.every((value) => value === 'READY_TO_CLAIM') ? 'COMPLETED'
    : states.every((value) => ['FAILED', 'REFUNDED'].includes(value)) ? 'CANCELLED'
      : states.some((value) => value === 'REVIEW') ? 'REVIEW'
        : states.some((value) => value === 'READY_TO_CLAIM') && states.some((value) => ['FAILED', 'REFUNDED'].includes(value)) ? 'PARTIAL'
          : states.some((value) => value === 'RUNNING') ? 'RUNNING' : 'PENDING';
  if (order && order.state !== state) db.prepare('UPDATE orders SET state=?,state_version=state_version+1,updated_at=? WHERE id=? AND state_version=?')
    .run(state, timestamp, orderId, order.state_version);
  return state;
}

function recordSettlementEvidenceInTransaction(db, { item, outcome, reason, evidence = {}, timestamp }) {
  const label = outcome === 'SUCCESS' ? 'CAPTURED' : outcome === 'FAILED' ? 'RELEASED' : 'REVIEWED';
  db.prepare(`INSERT INTO settlement_evidence(id,subject_type,subject_id,outcome,reason_code,evidence_json,trace_id,created_at)
    VALUES(?,?,?, ?,?,?,?,?) ON CONFLICT(subject_type,subject_id,outcome) DO NOTHING`).run(
    randomUUID(), 'ORDER_ITEM', item.id, label, String(reason ?? (outcome === 'SUCCESS' ? 'VERIFIED_SUCCESS'
      : outcome === 'FAILED' ? 'DEFINITE_FAILURE' : 'RESULT_AMBIGUOUS')).slice(0, 100), JSON.stringify(evidence),
    item.trace_id, timestamp,
  );
}

export function createOrder(db, { discordUserId, questAccountId, credentialId = null, items, traceId = randomUUID(), prelaunch = false }) {
  if (!Array.isArray(items) || !items.length) throw new QuestshopError('NO_SELLABLE_QUEST', 'ไม่มี Quest ที่เลือก');
  if (items.length > 25) throw new QuestshopError('ORDER_ITEM_LIMIT', 'เลือก Quest ได้สูงสุด 25 รายการต่อคำสั่งซื้อ');
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    if (credentialId) {
      const existing = db.prepare('SELECT * FROM orders WHERE credential_id=?').get(credentialId);
      if (existing) {
        if (existing.discord_user_id !== discordUserId) throw new QuestshopError('NOT_AUTHORIZED', 'รายการนี้ไม่ใช่ของคุณ');
        return existing;
      }
    }
    const total = items.reduce((sum, item) => sum + Number(item.priceCents), 0);
    if (!Number.isSafeInteger(total) || total <= 0) throw new TypeError('Invalid order total');
    const orderId = randomUUID();
    if (credentialId) {
      const credential = db.prepare("SELECT id FROM credentials WHERE id=? AND retention_class='TEMPORARY'").get(credentialId);
      if (!credential) throw new QuestshopError('CHECKOUT_EXPIRED', 'ข้อมูลบัญชีหมดอายุ กรุณาเริ่มทำ Quest ใหม่');
    }
    try {
      db.prepare(`INSERT INTO orders(id,discord_user_id,quest_account_id,credential_id,prelaunch,state,total_cents,trace_id,created_at,updated_at)
        VALUES(?,?,?,?,?,'PENDING',?,?,?,?)`).run(orderId, discordUserId, questAccountId, credentialId, prelaunch ? 1 : 0, total, traceId, timestamp, timestamp);
    } catch (error) {
      if (String(error?.message).includes('orders_one_active_quest_account')) {
        throw new QuestshopError('QUEST_ACCOUNT_BUSY', 'บัญชี Quest นี้กำลังมีงานที่ยังไม่จบ กรุณารอให้งานเดิมเสร็จก่อน');
      }
      throw error;
    }
    for (const item of items) {
      const quest = db.prepare('SELECT quest_id FROM quests WHERE quest_id=?').get(item.questId);
      if (!quest) throw new QuestshopError('QUEST_NOT_FOUND', 'ไม่พบ Quest ที่เลือก');
      const itemId = randomUUID();
      const price = Number(item.priceCents);
      appendWalletTransactionInTransaction(db, {
        discordUserId, transactionType: 'RESERVE', availableDeltaCents: -price, reservedDeltaCents: price,
        referenceType: 'ORDER_ITEM', referenceId: itemId, idempotencyKey: `reserve:${itemId}`, traceId, timestamp,
      });
      db.prepare(`INSERT INTO order_items(id,order_id,quest_id,state,price_cents,reserved_at,updated_at)
        VALUES(?,?,?,'QUEUED',?,?,?)`).run(itemId, orderId, item.questId, price, timestamp, timestamp);
      db.prepare(`INSERT INTO jobs(id,job_type,subject_type,subject_id,operation_key,state,checkpoint,next_run_at,payload_json,created_at,updated_at)
      VALUES(?,?, 'ORDER_ITEM', ?, ?, 'PENDING','NOT_STARTED',?,?,?,?)`).run(randomUUID(), 'QUEST_RUN', itemId,
        `quest-run:${itemId}`, timestamp, JSON.stringify({ orderId, itemId, credentialId }), timestamp, timestamp);
    }
    enqueueNotificationInTransaction(db, { notificationType: 'QUEST_HISTORY', aggregateType: 'ORDER', aggregateId: orderId,
      destination: 'QUEST_HISTORY', payload: { orderId }, timestamp });
    enqueueNotificationInTransaction(db, { notificationType: 'ORDER_STATUS_DM', aggregateType: 'ORDER', aggregateId: orderId,
      destination: `DM:${discordUserId}`, payload: { orderId }, timestamp });
    return db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  });
}

function settleOrderItemInTransaction(db, { itemId, outcome, claimUrl = null, reason = null, verified = false, evidence = {}, workerJob = null, timestamp = nowMs() }) {
  if (workerJob) assertActiveJobLeaseInTransaction(db, { jobId: workerJob.jobId, leaseToken: workerJob.leaseToken,
    subjectType: 'ORDER_ITEM', subjectId: itemId, expectedStateVersion: workerJob.expectedJobVersion ?? null });
  const item = db.prepare(`SELECT i.*,o.discord_user_id,o.trace_id FROM order_items i JOIN orders o ON o.id=i.order_id
    WHERE i.id=?`).get(itemId);
    if (!item) throw new QuestshopError('ORDER_ITEM_NOT_FOUND', 'ไม่พบรายการ Quest');
    if (!['QUEUED', 'RUNNING', 'REVIEW'].includes(item.state)) return item;
    if (outcome === 'SUCCESS') {
      if (verified !== true) throw new QuestshopError('SETTLEMENT_VERIFICATION_REQUIRED', 'ยังยืนยันผล Quest ไม่ครบ จึงตัดเครดิตไม่ได้');
      appendWalletTransactionInTransaction(db, { discordUserId: item.discord_user_id, transactionType: 'CAPTURE',
        reservedDeltaCents: -Number(item.price_cents), referenceType: 'ORDER_ITEM', referenceId: item.id,
        idempotencyKey: `capture:${item.id}`, traceId: item.trace_id, timestamp });
      db.prepare(`UPDATE order_items SET state='READY_TO_CLAIM',progress_percent=100,claim_url=?,completed_at=?,state_version=state_version+1,updated_at=?
        WHERE id=? AND state_version=?`).run(claimUrl, timestamp, timestamp, item.id, item.state_version);
      recordSettlementEvidenceInTransaction(db, { item, outcome, reason, evidence: { verifiedCompleted: true, claimUrl, ...evidence }, timestamp });
    } else if (outcome === 'FAILED') {
      appendWalletTransactionInTransaction(db, { discordUserId: item.discord_user_id, transactionType: 'RELEASE',
        availableDeltaCents: Number(item.price_cents), reservedDeltaCents: -Number(item.price_cents),
        referenceType: 'ORDER_ITEM', referenceId: item.id, idempotencyKey: `release:${item.id}`,
        traceId: item.trace_id, reason, timestamp });
      db.prepare(`UPDATE order_items SET state='FAILED',state_version=state_version+1,updated_at=? WHERE id=? AND state_version=?`)
        .run(timestamp, item.id, item.state_version);
      recordSettlementEvidenceInTransaction(db, { item, outcome, reason, evidence, timestamp });
    } else {
      db.prepare(`UPDATE order_items SET state='REVIEW',state_version=state_version+1,updated_at=? WHERE id=? AND state_version=?`)
        .run(timestamp, item.id, item.state_version);
      db.prepare(`INSERT INTO manual_reviews(id,subject_type,subject_id,category,state,reason_code,safe_reason,created_at,updated_at)
        VALUES(?,?,?,'OPERATIONAL','OPEN',?,?,?,?) ON CONFLICT(subject_type,subject_id) WHERE state='OPEN'
        DO UPDATE SET reason_code=excluded.reason_code,safe_reason=excluded.safe_reason,updated_at=excluded.updated_at`).run(
        randomUUID(), 'ORDER_ITEM', item.id, reason ?? 'QUEST_RESULT_AMBIGUOUS', 'ผลการทำ Quest ยังยืนยันไม่ได้', timestamp, timestamp,
      );
      recordSettlementEvidenceInTransaction(db, { item, outcome: 'REVIEW', reason, evidence, timestamp });
    }
    refreshOrderState(db, item.order_id, timestamp);
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(item.order_id);
    enqueueNotificationInTransaction(db, { notificationType: 'QUEST_HISTORY', aggregateType: 'ORDER', aggregateId: order.id,
      destination: 'QUEST_HISTORY', payload: { orderId: order.id }, timestamp });
    enqueueNotificationInTransaction(db, { notificationType: 'ORDER_STATUS_DM', aggregateType: 'ORDER', aggregateId: order.id,
      destination: `DM:${order.discord_user_id}`, payload: { orderId: order.id }, timestamp });
    enqueueNotificationInTransaction(db, { notificationType: 'QUEST_OPERATION_LOG', aggregateType: 'ORDER_ITEM', aggregateId: item.id,
      destination: 'LOG_QUEST_OPERATIONS', payload: { itemId: item.id }, timestamp });
    return db.prepare('SELECT * FROM order_items WHERE id=?').get(item.id);
}

/** The only public settlement boundary.  Capturing requires explicit provider
 * verification; release and review leave their own immutable evidence. */
export function settleOrderItem(db, input) {
  return withImmediateTransaction(db, () => settleOrderItemInTransaction(db, input));
}

/** Resolve an operational review exactly once.  Capture is allowed only when
 * an Owner supplies evidence that the Quest really completed; otherwise the
 * safe resolution is a compensating Release. */
export function resolveOrderItemReview(db, { reviewId, actorId, decision, reason = '', claimUrl = null, evidence = {} }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const review = db.prepare("SELECT * FROM manual_reviews WHERE id=? AND subject_type='ORDER_ITEM' AND category='OPERATIONAL'").get(reviewId);
    if (!review) throw new QuestshopError('REVIEW_NOT_FOUND', 'ไม่พบรายการที่รอตรวจสอบ');
    if (['RESOLVED_SUCCESS', 'RESOLVED_FAILURE'].includes(review.state)) return { state: review.state, idempotent: true, decision: review.decision };
    if (review.state !== 'OPEN') throw new QuestshopError('REVIEW_NOT_OPEN', 'รายการนี้ไม่ได้รอตรวจสอบแล้ว');
    let item;
    if (decision === 'CAPTURE') {
      if (evidence?.verifiedCompleted !== true) throw new QuestshopError('REVIEW_EVIDENCE_INCOMPLETE', 'ต้องมีหลักฐานว่า Quest ทำสำเร็จก่อนตัดเครดิต');
      item = settleOrderItemInTransaction(db, { itemId: review.subject_id, outcome: 'SUCCESS', claimUrl,
        reason: reason || 'OWNER_VERIFIED_SUCCESS', verified: true, evidence: { ...evidence, resolvedBy: actorId }, timestamp });
    } else if (decision === 'RELEASE') {
      item = settleOrderItemInTransaction(db, { itemId: review.subject_id, outcome: 'FAILED',
        reason: reason || 'OWNER_RELEASED', evidence: { ...evidence, resolvedBy: actorId }, timestamp });
    } else {
      throw new QuestshopError('REVIEW_DECISION_INVALID', 'รูปแบบการตัดสินใจไม่ถูกต้อง');
    }
    const resolvedState = decision === 'CAPTURE' ? 'RESOLVED_SUCCESS' : 'RESOLVED_FAILURE';
    const changed = db.prepare(`UPDATE manual_reviews SET state=?,decision=?,resolved_by=?,resolved_at=?,state_version=state_version+1,updated_at=?
      WHERE id=? AND state='OPEN' AND state_version=?`).run(resolvedState, decision, actorId, timestamp, timestamp, review.id, review.state_version);
    if (!changed.changes) throw new QuestshopError('REVIEW_CONFLICT', 'รายการถูกแก้ไขพร้อมกัน กรุณาลองใหม่');
    return { state: resolvedState, idempotent: false, decision, item };
  });
}

export function markOrderItemRunning(db, { itemId, workerJob = null }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    if (workerJob) assertActiveJobLeaseInTransaction(db, { jobId: workerJob.jobId, leaseToken: workerJob.leaseToken,
      subjectType: 'ORDER_ITEM', subjectId: itemId, expectedStateVersion: workerJob.expectedJobVersion ?? null });
    const item = db.prepare('SELECT * FROM order_items WHERE id=?').get(itemId);
    if (!item || item.state !== 'QUEUED') return item ?? null;
    db.prepare(`UPDATE order_items SET state='RUNNING',state_version=state_version+1,updated_at=? WHERE id=? AND state_version=?`)
      .run(timestamp, itemId, item.state_version);
    refreshOrderState(db, item.order_id, timestamp);
    return db.prepare('SELECT * FROM order_items WHERE id=?').get(itemId);
  });
}

export function updateOrderItemProgress(db, { itemId, progressPercent, workerJob }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    assertActiveJobLeaseInTransaction(db, { jobId: workerJob.jobId, leaseToken: workerJob.leaseToken,
      subjectType: 'ORDER_ITEM', subjectId: itemId, expectedStateVersion: workerJob.expectedJobVersion ?? null });
    const item = db.prepare('SELECT * FROM order_items WHERE id=?').get(itemId);
    if (!item || !['QUEUED', 'RUNNING'].includes(item.state)) return item ?? null;
    const progress = Math.max(0, Math.min(100, Math.round(Number(progressPercent) || 0)));
    const changed = db.prepare(`UPDATE order_items SET progress_percent=?,state_version=state_version+1,updated_at=?
      WHERE id=? AND state_version=?`).run(progress, timestamp, itemId, item.state_version);
    return changed.changes ? db.prepare('SELECT * FROM order_items WHERE id=?').get(itemId) : null;
  });
}

export function refundReadyOrderItem(db, { itemId, actorId = 'SYSTEM', reason = 'REFUND_APPROVED' }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const item = db.prepare(`SELECT i.*,o.discord_user_id,o.trace_id FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.id=?`).get(itemId);
    if (!item) throw new QuestshopError('ORDER_ITEM_NOT_FOUND', 'ไม่พบรายการ Quest');
    if (item.state === 'REFUNDED') return { item, idempotent: true };
    if (item.state !== 'READY_TO_CLAIM') throw new QuestshopError('ORDER_ITEM_STATE_INVALID', 'คืนเครดิตได้เฉพาะงานที่ทำเสร็จแล้ว');
    const refund = appendWalletTransactionInTransaction(db, {
      discordUserId: item.discord_user_id, transactionType: 'REFUND', availableDeltaCents: Number(item.price_cents),
      referenceType: 'ORDER_ITEM', referenceId: item.id, idempotencyKey: `refund:${item.id}`, traceId: item.trace_id,
      reason, timestamp,
    });
    db.prepare(`UPDATE order_items SET state='REFUNDED',refund_cents=?,state_version=state_version+1,updated_at=? WHERE id=? AND state_version=?`)
      .run(item.price_cents, timestamp, item.id, item.state_version);
    refreshOrderState(db, item.order_id, timestamp);
    const updated = db.prepare('SELECT * FROM order_items WHERE id=?').get(item.id);
    const auditId = randomUUID();
    db.prepare(`INSERT INTO admin_audit(id,actor_id,action,target_type,target_id,reason,before_json,after_json,trace_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(auditId, actorId, 'ORDER_ITEM_REFUNDED', 'ORDER_ITEM', item.id, reason,
      JSON.stringify({ state: 'READY_TO_CLAIM' }), JSON.stringify({ state: 'REFUNDED', refundCents: item.price_cents }), item.trace_id, timestamp);
    enqueueNotificationInTransaction(db, { notificationType: 'ADMIN_LOG', aggregateType: 'ADMIN_AUDIT', aggregateId: auditId,
      destination: 'LOG_ADMIN', payload: { auditId }, timestamp });
    return { item: updated, wallet: refund.wallet, idempotent: false };
  });
}
