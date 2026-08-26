import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { withTransaction } from '../../db/transaction.js';
import { AuthorizationError, QuestshopError, StaleStateError } from '../../shared/errors.js';
import { enqueueProjection } from '../outbox/service.js';
import { assertTransition, recordTransition } from '../shared/transition.js';
import { appendAdminAudit } from '../admin/audit.js';
import { redact } from '../../shared/redaction.js';
import { REVIEW_TRANSITIONS } from './states.js';
import { ORDER_ITEM_TRANSITIONS } from '../orders/states.js';
import { RUNNER_JOB_TRANSITIONS } from '../runner/states.js';
import { TOPUP_TRANSITIONS } from '../payments/states.js';
import { TEST_TRANSITIONS } from '../catalog/states.js';
import { createMonitorTestBatch, hasCurrentTestPass, questDeadlinePassed } from '../catalog/test-gate.js';
import { appendLedger } from '../wallet/ledger.js';
import {
  captureReservationInTransaction,
  creditRedeemedTopupInTransaction,
  releaseReservationInTransaction,
} from '../wallet/service.js';

export async function openReview(client, {
  subjectType,
  subjectId,
  reason,
  financial = false,
  ownerOnly = false,
  context,
}) {
  const id = uuidv7();
  const result = await client.query(`
    INSERT INTO manual_reviews(
      id, subject_type, subject_id, state, financial, owner_only,
      opened_reason, trace_id, remind_at
    ) VALUES ($1, $2, $3, 'OPEN', $4, $5, $6, $7, transaction_timestamp() + interval '1 hour')
    ON CONFLICT (subject_type, subject_id) WHERE state <> 'RESOLVED'
    DO UPDATE SET remind_at = LEAST(manual_reviews.remind_at, transaction_timestamp() + interval '1 hour')
    RETURNING *
  `, [id, subjectType, String(subjectId), financial, ownerOnly, reason, context.traceId]);
  const review = result.rows[0];
  await enqueueProjection(client, {
    projectionType: 'MANUAL_REVIEW', aggregateType: 'MANUAL_REVIEW', aggregateId: review.id,
    aggregateVersion: review.state_version, surfaceKey: 'ADMIN_PANEL', context,
  });
  return review;
}

export async function assignReview({ reviewId, assigneeId, expectedVersion }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    assertTransition(REVIEW_TRANSITIONS, 'OPEN', 'ASSIGNED');
    const updated = (await client.query(`
      UPDATE manual_reviews
      SET state = 'ASSIGNED', assigned_to = $2, state_version = state_version + 1
      WHERE id = $1 AND state = 'OPEN' AND state_version = $3
      RETURNING *
    `, [reviewId, assigneeId, expectedVersion])).rows[0];
    if (!updated) throw new StaleStateError('manual_review', reviewId);
    await recordTransition(client, {
      aggregateType: 'MANUAL_REVIEW', aggregateId: reviewId,
      fromState: 'OPEN', toState: 'ASSIGNED', stateVersion: updated.state_version, context,
    });
    await appendAdminAudit(client, { action: 'MANUAL_REVIEW_ASSIGNED', targetType: 'MANUAL_REVIEW',
      targetId: reviewId, actorId: context.actorId, before: { state: 'OPEN', assignedTo: null },
      after: { state: updated.state, assignedTo: updated.assigned_to }, reason: 'review assignment', context });
    return updated;
  });
}

export async function addEvidence({ reviewId, evidenceType, payload }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    let review = (await client.query(
      'SELECT * FROM manual_reviews WHERE id = $1 FOR UPDATE', [reviewId],
    )).rows[0];
    if (!review || review.state === 'RESOLVED') throw new StaleStateError('manual_review', reviewId);
    if (review.state === 'OPEN') {
      assertTransition(REVIEW_TRANSITIONS, review.state, 'ASSIGNED');
      const assigned = (await client.query(`UPDATE manual_reviews SET state='ASSIGNED',assigned_to=$2,
        state_version=state_version+1 WHERE id=$1 AND state='OPEN' AND state_version=$3 RETURNING *`,
      [reviewId, context.actorId, review.state_version])).rows[0];
      if (!assigned) throw new StaleStateError('manual_review', reviewId);
      await recordTransition(client, { aggregateType: 'MANUAL_REVIEW', aggregateId: reviewId,
        fromState: 'OPEN', toState: 'ASSIGNED', stateVersion: assigned.state_version, context });
      review = assigned;
    }
    await client.query(`
      INSERT INTO review_evidence(id, review_id, evidence_type, payload, actor_type, actor_id, trace_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [uuidv7(), reviewId, evidenceType, redact(payload), context.actorType, context.actorId, context.traceId]);
    if (review.state !== 'ASSIGNED') {
      await appendAdminAudit(client, { action: 'MANUAL_REVIEW_EVIDENCE_ADDED', targetType: 'MANUAL_REVIEW',
        targetId: reviewId, actorId: context.actorId, before: { state: review.state },
        after: { evidenceType }, reason: 'review evidence added', context });
      return review;
    }
    assertTransition(REVIEW_TRANSITIONS, review.state, 'EVIDENCE_PENDING');
    const pending = (await client.query(`UPDATE manual_reviews SET state='EVIDENCE_PENDING',
      state_version=state_version+1 WHERE id=$1 AND state='ASSIGNED' AND state_version=$2 RETURNING *`,
    [reviewId, review.state_version])).rows[0];
    if (!pending) throw new StaleStateError('manual_review', reviewId);
    await recordTransition(client, { aggregateType: 'MANUAL_REVIEW', aggregateId: reviewId,
      fromState: 'ASSIGNED', toState: 'EVIDENCE_PENDING', stateVersion: pending.state_version, context });
    await appendAdminAudit(client, { action: 'MANUAL_REVIEW_EVIDENCE_ADDED', targetType: 'MANUAL_REVIEW',
      targetId: reviewId, actorId: context.actorId, before: { state: 'ASSIGNED' },
      after: { state: pending.state, evidenceType }, reason: 'review evidence added', context });
    return pending;
  });
}

async function advanceReviewState(client, review, nextState, context) {
  assertTransition(REVIEW_TRANSITIONS, review.state, nextState);
  const updated = (await client.query(`UPDATE manual_reviews SET state=$2,state_version=state_version+1
    WHERE id=$1 AND state=$3 AND state_version=$4 RETURNING *`,
  [review.id, nextState, review.state, review.state_version])).rows[0];
  if (!updated) throw new StaleStateError('manual_review', review.id);
  await recordTransition(client, { aggregateType: 'MANUAL_REVIEW', aggregateId: review.id,
    fromState: review.state, toState: nextState, stateVersion: updated.state_version, context });
  return updated;
}

async function prepareReviewDecision(client, review, context) {
  let prepared = review;
  if (prepared.state === 'OPEN') {
    prepared = await advanceReviewState(client, prepared, 'ASSIGNED', context);
    await client.query('UPDATE manual_reviews SET assigned_to=$2 WHERE id=$1', [prepared.id, context.actorId]);
    prepared.assigned_to = context.actorId;
  }
  if (prepared.state === 'ASSIGNED') prepared = await advanceReviewState(client, prepared, 'EVIDENCE_PENDING', context);
  if (prepared.state === 'EVIDENCE_PENDING') prepared = await advanceReviewState(client, prepared, 'DECISION_READY', context);
  if (prepared.state !== 'DECISION_READY') throw new StaleStateError('manual_review', prepared.id);
  return prepared;
}

export async function resolveReview({
  reviewId,
  decision,
  reason,
  isOwner,
  expectedVersion = null,
  decisionEvidence = null,
  applyDecision,
}, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    let review = (await client.query(
      'SELECT * FROM manual_reviews WHERE id = $1 FOR UPDATE', [reviewId],
    )).rows[0];
    if (!review || review.state === 'RESOLVED') throw new StaleStateError('manual_review', reviewId);
    if (expectedVersion != null && String(review.state_version) !== String(expectedVersion)) {
      throw new StaleStateError('manual_review', reviewId);
    }
    if (review.owner_only && !isOwner) throw new AuthorizationError('รายการนี้ให้ Owner ตัดสินเท่านั้น');
    if (decisionEvidence) await client.query(`INSERT INTO review_evidence(id,review_id,evidence_type,
      payload,actor_type,actor_id,trace_id) VALUES($1,$2,'DECISION_INPUT',$3,$4,$5,$6)`,
    [uuidv7(), reviewId, redact(decisionEvidence), context.actorType, context.actorId, context.traceId]);
    review = await prepareReviewDecision(client, review, context);
    assertTransition(REVIEW_TRANSITIONS, review.state, 'RESOLVED');
    const applied = await applyDecision(client, review);
    await client.query(`
      INSERT INTO review_decisions(id, review_id, decision, reason, actor_id, trace_id)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [uuidv7(), reviewId, decision, reason, context.actorId, context.traceId]);
    const updated = (await client.query(`
      UPDATE manual_reviews SET state = 'RESOLVED', state_version = state_version + 1,
        resolved_at = transaction_timestamp() WHERE id = $1 AND state='DECISION_READY'
        AND state_version=$2 RETURNING *
    `, [reviewId, review.state_version])).rows[0];
    if (!updated) throw new StaleStateError('manual_review', reviewId);
    await recordTransition(client, {
      aggregateType: 'MANUAL_REVIEW', aggregateId: reviewId,
      fromState: review.state, toState: 'RESOLVED', stateVersion: updated.state_version,
      reasonCode: decision, metadata: { decision, applied }, context,
    });
    return { review: updated, applied };
  });
}

const ORDER_RELEASE_DECISIONS = Object.freeze({
  RELEASE: 'FAILED_RELEASED',
  STOP: 'STOPPED_RELEASED',
  FAIL: 'FAILED_RELEASED',
});

async function applyReversalReviewDecision(client, review, topup, decision, input, context) {
  if (decision === 'REJECT') {
    return { topupId: topup.id, status: 'REVERSAL_CANCELLED', topupStatus: topup.status };
  }
  if (decision !== 'CREDIT') throw new TypeError('invalid reversal review decision');
  const confirmedPrincipal = BigInt(input.amountCents ?? 0);
  const storedPrincipal = BigInt(topup.amount_cents ?? 0);
  const confirmedProviderId = input.providerTransactionId?.trim() ?? '';
  if (confirmedPrincipal !== storedPrincipal || confirmedProviderId !== String(topup.provider_transaction_id ?? '')) {
    throw new QuestshopError('STALE_STATE', 'ยอดหรือเลขธุรกรรมไม่ตรงกับรายการที่ต้อง Reverse กรุณาตรวจสอบใหม่');
  }
  const bonus = BigInt(topup.bonus_cents ?? 0);
  const total = storedPrincipal + bonus;
  const wallet = (await client.query('SELECT * FROM wallets WHERE discord_user_id=$1 FOR UPDATE',
    [topup.discord_user_id])).rows[0];
  if (!wallet || BigInt(wallet.available_cents) < total) {
    throw new QuestshopError('INSUFFICIENT_BALANCE', 'เครดิตพร้อมใช้ยังไม่พอสำหรับ Reverse รายการนี้');
  }
  const balances = {
    availableBefore: BigInt(wallet.available_cents),
    reservedBefore: BigInt(wallet.reserved_cents),
    availableAfter: BigInt(wallet.available_cents) - total,
    reservedAfter: BigInt(wallet.reserved_cents),
  };
  const updatedWallet = (await client.query(`UPDATE wallets SET available_cents=$2,reserved_cents=$3,
    state_version=state_version+1,updated_at=transaction_timestamp()
    WHERE discord_user_id=$1 AND state_version=$4 RETURNING *`,
  [wallet.discord_user_id, balances.availableAfter, balances.reservedAfter, wallet.state_version])).rows[0];
  if (!updatedWallet) throw new StaleStateError('wallet', wallet.discord_user_id);
  const ledger = await appendLedger(client, {
    discordUserId: topup.discord_user_id,
    transactionGroupId: uuidv7(),
    transactionType: 'TOPUP_REVERSAL',
    deltaAvailableCents: -total,
    deltaReservedCents: 0n,
    balances,
    principalCents: storedPrincipal,
    bonusCents: bonus,
    referenceType: 'TOPUP',
    referenceId: topup.id,
    idempotencyKey: `topup:${topup.id}:reversal`,
    reason: input.reason,
    context,
  });
  assertTransition(TOPUP_TRANSITIONS, topup.status, 'REVERSED');
  const updated = (await client.query(`UPDATE topups SET status='REVERSED',state_version=state_version+1,
    updated_at=transaction_timestamp() WHERE id=$1 AND status='CREDITED' AND state_version=$2 RETURNING *`,
  [topup.id, topup.state_version])).rows[0];
  if (!updated) throw new StaleStateError('topup', topup.id);
  await recordTransition(client, { aggregateType: 'TOPUP', aggregateId: topup.id,
    fromState: 'CREDITED', toState: 'REVERSED', stateVersion: updated.state_version,
    reasonCode: 'OWNER_CONFIRMED_REVERSAL', context });
  await appendAdminAudit(client, { action: 'TOPUP_REVERSED', targetType: 'TOPUP', targetId: topup.id,
    actorId: context.actorId, before: { status: topup.status, availableCents: wallet.available_cents },
    after: { status: updated.status, reversalCents: String(total), transactionId: ledger.id },
    reason: input.reason, context });
  await enqueueProjection(client, { projectionType: 'PAYMENT_STATUS_LOG', aggregateType: 'TOPUP',
    aggregateId: topup.id, aggregateVersion: updated.state_version, surfaceKey: 'LOG_PAYMENTS', context });
  return { topupId: topup.id, status: updated.status, transactionId: ledger.id };
}

async function applyTopupDecision(client, review, decision, input, context) {
  const topup = (await client.query('SELECT * FROM topups WHERE id=$1 FOR UPDATE',
    [review.subject_id])).rows[0];
  if (!topup) throw new StaleStateError('topup', review.subject_id);
  if (review.opened_reason === 'REVERSAL_INSUFFICIENT_AVAILABLE') {
    if (topup.status !== 'CREDITED') throw new StaleStateError('topup', review.subject_id);
    return applyReversalReviewDecision(client, review, topup, decision, input, context);
  }
  if (topup.status !== 'MANUAL_REVIEW') throw new StaleStateError('topup', review.subject_id);
  if (decision === 'REJECT') {
    assertTransition(TOPUP_TRANSITIONS, topup.status, 'REJECTED');
    const updated = (await client.query(`UPDATE topups SET status='REJECTED',state_version=state_version+1,
      failure_code=$2,updated_at=transaction_timestamp() WHERE id=$1 AND status='MANUAL_REVIEW' RETURNING *`,
    [topup.id, input.reason])).rows[0];
    if (!updated) throw new StaleStateError('topup', topup.id);
    await recordTransition(client, { aggregateType: 'TOPUP', aggregateId: topup.id,
      fromState: 'MANUAL_REVIEW', toState: 'REJECTED', stateVersion: updated.state_version,
      reasonCode: 'OWNER_REJECTED', context });
    await enqueueProjection(client, { projectionType: 'PAYMENT_LOG', aggregateType: 'TOPUP',
      aggregateId: topup.id, aggregateVersion: updated.state_version,
      surfaceKey: 'LOG_PAYMENTS', context });
    await enqueueProjection(client, { projectionType: 'TOPUP_STATUS_DM', aggregateType: 'TOPUP',
      aggregateId: topup.id, aggregateVersion: updated.state_version, surfaceKey: `DM:${updated.discord_user_id}`,
      topic: 'TOPUP_STATUS_DM', context });
    return { topupId: topup.id, status: updated.status };
  }
  if (decision !== 'CREDIT') throw new TypeError('invalid top-up review decision');
  const amount = BigInt(input.amountCents ?? topup.amount_cents ?? 0);
  const providerTransactionId = input.providerTransactionId?.trim() || null;
  const alternateSettlementEvidence = await hasVoucherSettlementEvidence(client, topup);
  if (amount <= 0n || (!providerTransactionId && !alternateSettlementEvidence)) {
    throw new TypeError('confirmed amount and provider transaction id are required unless TrueMoney settlement evidence is complete');
  }
  if (!providerTransactionId && amount !== BigInt(topup.amount_cents ?? 0)) {
    throw new QuestshopError('STALE_STATE', 'ยอดที่ยืนยันต้องตรงกับยอดที่ TrueMoney ตอบกลับมา');
  }
  assertTransition(TOPUP_TRANSITIONS, topup.status, 'REDEEMED');
  let redeemed;
  try {
    redeemed = (await client.query(`UPDATE topups SET status='REDEEMED',state_version=state_version+1,
      amount_cents=$2,currency='THB',provider_transaction_id=COALESCE($3,provider_transaction_id),
      redeemed_at=COALESCE(redeemed_at,transaction_timestamp()),
      failure_code=NULL,updated_at=transaction_timestamp()
      WHERE id=$1 AND status='MANUAL_REVIEW' RETURNING *`,
    [topup.id, amount, providerTransactionId])).rows[0];
  } catch (error) {
    if (error?.code === '23505') {
      throw new QuestshopError('STALE_STATE', 'เลขธุรกรรม TrueMoney นี้ถูกใช้กับรายการเติมเงินอื่นแล้ว');
    }
    throw error;
  }
  if (!redeemed) throw new StaleStateError('topup', topup.id);
  await recordTransition(client, { aggregateType: 'TOPUP', aggregateId: topup.id,
    fromState: 'MANUAL_REVIEW', toState: 'REDEEMED', stateVersion: redeemed.state_version,
    reasonCode: 'OWNER_CONFIRMED_REDEEMED', context });
  const credited = await creditRedeemedTopupInTransaction(client, { topupId: topup.id }, context);
  return { topupId: topup.id, status: credited.topup.status,
    transactionId: credited.transaction.id };
}

async function hasVoucherSettlementEvidence(client, topup) {
  if (topup.provider_transaction_id || BigInt(topup.amount_cents ?? 0) <= 0n || topup.currency !== 'THB') return false;
  const attempt = (await client.query(`SELECT provider_http_status,provider_evidence,error_code
    FROM payment_attempts WHERE topup_id=$1 ORDER BY attempt_number DESC LIMIT 1`, [topup.id])).rows[0];
  if (!attempt || attempt.provider_http_status < 200 || attempt.provider_http_status >= 300) return false;
  const evidence = attempt.provider_evidence ?? {};
  const currentEvidence = evidence.receiverConfirmation === 'REQUEST_BOUND_SUCCESS'
    && evidence.settlementIdentity === 'VOUCHER_HMAC';
  // Compatibility for a pre-fix review: it recorded the confirmation and
  // amount but labelled the missing transaction ID as ambiguous.
  const legacyEvidence = evidence.receiverConfirmation === 'REQUEST_BOUND_SUCCESS'
    && (attempt.error_code === 'PROVIDER_TRANSACTION_ID_MISSING'
      || topup.failure_code === 'PROVIDER_TRANSACTION_ID_MISSING');
  return currentEvidence || legacyEvidence;
}

async function loadReviewedOrderItem(client, review) {
  const item = (await client.query(`SELECT i.*,q.url AS quest_url FROM order_items i
    JOIN quests q ON q.quest_id=i.quest_id WHERE i.id=$1 FOR UPDATE OF i`,
  [review.subject_id])).rows[0];
  if (item?.state !== 'MANUAL_REVIEW') throw new StaleStateError('order_item', review.subject_id);
  return item;
}

async function loadReviewedJobs(client, itemId, onlyManual = false) {
  const jobs = (await client.query('SELECT * FROM runner_jobs WHERE order_item_id=$1 FOR UPDATE', [itemId])).rows;
  return onlyManual ? jobs.filter((job) => job.state === 'MANUAL_REVIEW') : jobs;
}

async function transitionReviewedJob(client, job, nextState, reasonCode, context, { availableNow = false } = {}) {
  assertTransition(RUNNER_JOB_TRANSITIONS, job.state, nextState);
  const updated = (await client.query(`UPDATE runner_jobs SET state=$2,state_version=state_version+1,
    available_at=CASE WHEN $3 THEN clock_timestamp() ELSE available_at END,
    lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE id=$1 AND state=$4 AND state_version=$5 RETURNING *`,
  [job.id, nextState, availableNow, job.state, job.state_version])).rows[0];
  if (!updated) throw new StaleStateError('runner_job', job.id);
  await recordTransition(client, { aggregateType: 'RUNNER_JOB', aggregateId: job.id,
    fromState: job.state, toState: nextState, stateVersion: updated.state_version, reasonCode, context });
  return updated;
}

async function retryReviewedOrderItem(client, item, context) {
  assertTransition(ORDER_ITEM_TRANSITIONS, item.state, 'QUEUED');
  const updated = (await client.query(`UPDATE order_items SET state='QUEUED',state_version=state_version+1,
    updated_at=transaction_timestamp() WHERE id=$1 AND state='MANUAL_REVIEW' AND state_version=$2 RETURNING *`,
  [item.id, item.state_version])).rows[0];
  if (!updated) throw new StaleStateError('order_item', item.id);
  const jobs = await loadReviewedJobs(client, item.id, true);
  for (const job of jobs) await transitionReviewedJob(client, job, 'QUEUED', 'ADMIN_RETRY', context, { availableNow: true });
  await recordTransition(client, { aggregateType: 'ORDER_ITEM', aggregateId: item.id,
    fromState: item.state, toState: 'QUEUED', stateVersion: updated.state_version, reasonCode: 'ADMIN_RETRY', context });
  await enqueueProjection(client, { projectionType: 'QUEST_HISTORY', aggregateType: 'ORDER_ITEM',
    aggregateId: item.id, aggregateVersion: updated.state_version, surfaceKey: 'QUEST_HISTORY', context });
  return { orderItemId: item.id, status: updated.state };
}

async function captureReviewedOrderItem(client, item, input, context) {
  assertTransition(ORDER_ITEM_TRANSITIONS, item.state, 'SETTLING');
  const settling = (await client.query(`UPDATE order_items SET state='SETTLING',state_version=state_version+1,
    updated_at=transaction_timestamp() WHERE id=$1 AND state='MANUAL_REVIEW' AND state_version=$2 RETURNING *`,
  [item.id, item.state_version])).rows[0];
  if (!settling) throw new StaleStateError('order_item', item.id);
  const jobs = await loadReviewedJobs(client, item.id, true);
  const settlingJobs = [];
  for (const job of jobs) settlingJobs.push(await transitionReviewedJob(client, job, 'SETTLING', 'ADMIN_CAPTURE', context));
  await recordTransition(client, { aggregateType: 'ORDER_ITEM', aggregateId: item.id,
    fromState: item.state, toState: 'SETTLING', stateVersion: settling.state_version, reasonCode: 'ADMIN_CAPTURE', context });
  const captured = await captureReservationInTransaction(client,
    { orderItemId: item.id, claimUrl: input.claimUrl ?? item.claim_url ?? item.quest_url }, context);
  for (const job of settlingJobs) await transitionReviewedJob(client, job, 'COMPLETED', 'ADMIN_CAPTURE', context);
  return { orderItemId: item.id, status: captured.state };
}

async function releaseReviewedOrderItem(client, item, terminalState, input, context) {
  assertTransition(ORDER_ITEM_TRANSITIONS, item.state, terminalState);
  const released = await releaseReservationInTransaction(client, { orderItemId: item.id,
    terminalState, reason: input.reason }, context);
  const jobs = await loadReviewedJobs(client, item.id);
  for (const job of jobs) {
    if (!['COMPLETED', 'FAILED'].includes(job.state)) await transitionReviewedJob(client, job, 'FAILED', input.reason, context);
  }
  return { orderItemId: item.id, status: released.state };
}

async function applyOrderItemDecision(client, review, decision, input, context) {
  const item = await loadReviewedOrderItem(client, review);
  if (decision === 'RETRY') return retryReviewedOrderItem(client, item, context);
  if (decision === 'CAPTURE') return captureReviewedOrderItem(client, item, input, context);
  const terminalState = ORDER_RELEASE_DECISIONS[decision];
  if (!terminalState) throw new TypeError('invalid order-item review decision');
  return releaseReviewedOrderItem(client, item, terminalState, input, context);
}

async function loadQuestReviewContext(client, review) {
  const quest = (await client.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE',
    [review.subject_id])).rows[0];
  if (!quest) throw new StaleStateError('quest', review.subject_id);
  const active = (await client.query(`SELECT id,state FROM quest_test_runs
    WHERE quest_id=$1 AND state IN ('TEST_QUEUED','TESTING')
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [quest.quest_id])).rows[0];
  const manual = (await client.query(`SELECT * FROM quest_test_runs
    WHERE quest_id=$1 AND state='MANUAL_REVIEW'
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [quest.quest_id])).rows[0];
  if (!manual) throw new StaleStateError('quest_test', quest.quest_id);
  const batch = manual.batch_id
    ? (await client.query('SELECT * FROM quest_test_batches WHERE id=$1 FOR UPDATE', [manual.batch_id])).rows[0]
    : null;
  const targetMonitorReady = manual.target_monitor_id && (await client.query(`SELECT 1 FROM monitor_accounts
    WHERE id=$1 AND state='ACTIVE' AND 'TEST'=ANY(capabilities)`, [manual.target_monitor_id])).rowCount > 0;
  return { quest, active, manual, batch, targetMonitorReady };
}

async function requeueManualQuestTest(client, manual, batch, review, context) {
  assertTransition(TEST_TRANSITIONS, manual.state, 'TEST_QUEUED');
  const queued = (await client.query(`UPDATE quest_test_runs SET state='TEST_QUEUED',
    state_version=state_version+1,error_class='ADMIN_RETRY',completed_at=NULL,
    lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),
    evidence=evidence||$3::jsonb
    WHERE id=$1 AND state='MANUAL_REVIEW' AND state_version=$2 RETURNING *`, [
    manual.id, manual.state_version, { reviewId: review.id, decision: 'RETRY' },
  ])).rows[0];
  if (!queued) throw new StaleStateError('quest_test', manual.id);
  await recordTransition(client, { aggregateType: 'QUEST_TEST', aggregateId: queued.id,
    fromState: manual.state, toState: 'TEST_QUEUED', stateVersion: queued.state_version,
    reasonCode: 'ADMIN_RETRY', context });
  return { questId: queued.quest_id, status: queued.state, testRunId: queued.id, batchId: batch.id };
}

async function retireQuestTestBatch(client, batch, review, context) {
  if (!batch || !['QUEUED', 'RUNNING'].includes(batch.state)) return;
  const retired = (await client.query(`UPDATE quest_test_batches SET state='FAILED',
    state_version=state_version+1,latest_error=latest_error||$3::jsonb,
    completed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=$1 AND state=$2 AND state_version=$4 RETURNING *`, [batch.id, batch.state,
    { code: 'ADMIN_RETRY_RESEEDED', reviewId: review.id }, batch.state_version])).rows[0];
  if (!retired) throw new StaleStateError('quest_test_batch', batch.id);
  await recordTransition(client, { aggregateType: 'QUEST_TEST_BATCH', aggregateId: retired.id,
    fromState: batch.state, toState: 'FAILED', stateVersion: retired.state_version,
    reasonCode: 'ADMIN_RETRY_RESEEDED', context });
}

async function applyQuestDecision(client, review, decision, context) {
  if (decision !== 'RETRY') {
    throw new TypeError('Quest Manual Review รองรับเฉพาะ RETRY; ใช้ Catalog action หากต้องการเปลี่ยนสถานะขาย');
  }
  const { quest, active, manual, batch, targetMonitorReady } = await loadQuestReviewContext(client, review);
  if (await questDeadlinePassed(client, quest)) {
    return { questId: quest.quest_id, status: 'QUEST_EXPIRED' };
  }
  if (await hasCurrentTestPass(client, quest)) return { questId: quest.quest_id, status: 'TEST_ALREADY_PASSED' };
  if (active) return { questId: quest.quest_id, status: 'TEST_ALREADY_SCHEDULED', testRunId: active.id };

  // Reuse an active batch only when its original Monitor is still usable.  An
  // auth/quarantine review must seed a fresh batch, otherwise the queued run
  // would be permanently ineligible for acquisition.
  if (batch && ['QUEUED', 'RUNNING'].includes(batch.state) && targetMonitorReady) {
    return requeueManualQuestTest(client, manual, batch, review, context);
  }
  await retireQuestTestBatch(client, batch, review, context);
  const seeded = await createMonitorTestBatch(client, { quest, context,
    requestedBy: context.actorId, force: true });
  return { questId: quest.quest_id,
    status: seeded.skipped === 'QUEST_EXPIRED' ? 'QUEST_EXPIRED' : seeded.queued ? 'TEST_QUEUED' : 'NO_ACTIVE_MONITOR',
    batchId: seeded.batch?.id ?? null, testRunId: seeded.queued?.id ?? null };
}

function topupCreditFingerprint({ reviewId, reason, amountCents, providerTransactionId, settlementIdentity }) {
  return createHash('sha256').update(JSON.stringify({
    reviewId,
    reason: reason.trim(),
    amountCents: String(amountCents),
    providerTransactionId: providerTransactionId ?? null,
    settlementIdentity,
  })).digest('hex');
}

async function prepareOrConfirmTopupCredit({ reviewId, reason, amountCents, providerTransactionId,
  expectedVersion, isOwner }, context, options) {
  if (!isOwner) throw new AuthorizationError('Top-up ที่ผลไม่ชัดเจนให้ Owner ตัดสินเท่านั้น');
  if (amountCents == null || BigInt(amountCents) <= 0n) {
    throw new TypeError('confirmed amount is required');
  }
  const normalizedProviderTransactionId = providerTransactionId?.trim() || null;
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const review = (await client.query('SELECT * FROM manual_reviews WHERE id=$1 FOR UPDATE', [reviewId])).rows[0];
    if (!review || review.state === 'RESOLVED') throw new StaleStateError('manual_review', reviewId);
    if (review.subject_type !== 'TOPUP') return { confirmed: true, review };
    if (expectedVersion != null && String(review.state_version) !== String(expectedVersion)) {
      throw new StaleStateError('manual_review', reviewId);
    }
    if (review.owner_only && !isOwner) throw new AuthorizationError('รายการนี้ให้ Owner ตัดสินเท่านั้น');
    const topup = (await client.query('SELECT * FROM topups WHERE id=$1 FOR SHARE', [review.subject_id])).rows[0];
    if (!topup) throw new StaleStateError('topup', review.subject_id);
    const reversalReview = review.opened_reason === 'REVERSAL_INSUFFICIENT_AVAILABLE';
    let settlementIdentity = 'PROVIDER_TRANSACTION_ID';
    if (reversalReview) {
      if (!normalizedProviderTransactionId) throw new TypeError('provider transaction id is required for reversal');
    } else {
      if (topup.status !== 'MANUAL_REVIEW') throw new StaleStateError('topup', review.subject_id);
      const alternateSettlementEvidence = await hasVoucherSettlementEvidence(client, topup);
      if (!normalizedProviderTransactionId && !alternateSettlementEvidence) {
        throw new QuestshopError('TOPUP_SETTLEMENT_EVIDENCE_INCOMPLETE',
          'ยังต้องระบุเลขธุรกรรม TrueMoney เพราะหลักฐานยืนยันการรับเงินยังไม่ครบ');
      }
      if (!normalizedProviderTransactionId && BigInt(amountCents) !== BigInt(topup.amount_cents ?? 0)) {
        throw new QuestshopError('STALE_STATE', 'ยอดที่ยืนยันต้องตรงกับยอดที่ TrueMoney ตอบกลับมา');
      }
      settlementIdentity = normalizedProviderTransactionId ? 'PROVIDER_TRANSACTION_ID' : 'VOUCHER_HMAC';
    }
    const fingerprint = topupCreditFingerprint({ reviewId, reason, amountCents,
      providerTransactionId: normalizedProviderTransactionId, settlementIdentity });
    const evidence = (await client.query(`SELECT payload FROM review_evidence
      WHERE review_id=$1 AND evidence_type='CREDIT_CONFIRMATION_PREPARED' AND actor_id=$2
        AND created_at>=clock_timestamp()-interval '5 minutes'
      ORDER BY created_at DESC LIMIT 1`, [reviewId, context.actorId])).rows[0];
    if (evidence?.payload?.fingerprint === fingerprint
      && evidence.payload.preparedByIdempotencyKey !== context.idempotencyKey) {
      return { confirmed: true, review };
    }
    if (evidence?.payload?.fingerprint === fingerprint
      && evidence.payload.preparedByIdempotencyKey === context.idempotencyKey) {
      return { confirmed: false, review };
    }
    await client.query(`INSERT INTO review_evidence(id,review_id,evidence_type,payload,actor_type,actor_id,trace_id)
      VALUES($1,$2,'CREDIT_CONFIRMATION_PREPARED',$3,$4,$5,$6)`, [uuidv7(), reviewId,
      redact({ fingerprint, amountCents: String(amountCents), providerTransactionId: normalizedProviderTransactionId,
        settlementIdentity,
        reason: reason.trim(), expiresInSeconds: 300, preparedByIdempotencyKey: context.idempotencyKey }),
      context.actorType, context.actorId, context.traceId]);
    await appendAdminAudit(client, { action: 'TOPUP_MANUAL_CREDIT_CONFIRMATION_PREPARED',
      targetType: 'TOPUP', targetId: review.subject_id, actorId: context.actorId,
      before: { reviewState: review.state }, after: { amountCents: String(amountCents),
        providerTransactionId: normalizedProviderTransactionId, settlementIdentity }, reason: reason.trim(), context });
    return { confirmed: false, review };
  });
}

export async function resolveSubjectReview({ reviewId, decision, reason, isOwner,
  amountCents = null, providerTransactionId = null, claimUrl = null,
  expectedVersion = null }, context, options = {}) {
  if (!reason?.trim()) throw new TypeError('review resolution reason is required');
  if (decision === 'CREDIT') {
    const confirmation = await prepareOrConfirmTopupCredit({ reviewId, reason, amountCents,
      providerTransactionId, expectedVersion, isOwner }, context, options);
    if (!confirmation.confirmed) {
      return { review: confirmation.review, applied: {
        status: 'รอยืนยันซ้ำ — ตรวจสอบยอดและเลขธุรกรรม แล้วกดดำเนินการอีกครั้ง',
        confirmationRequired: true,
      } };
    }
  }
  return resolveReview({ reviewId, decision, reason, isOwner, expectedVersion,
    decisionEvidence: { decision, amountCents: amountCents == null ? null : String(amountCents),
      providerTransactionId, claimUrl },
    applyDecision: async (client, review) => {
      const input = { reason: reason.trim(), amountCents, providerTransactionId, claimUrl };
      let applied;
      if (review.subject_type === 'TOPUP') {
        if (!isOwner) throw new AuthorizationError('Top-up ที่ผลไม่ชัดเจนให้ Owner ตัดสินเท่านั้น');
        applied = await applyTopupDecision(client, review, decision, input, context);
      } else if (review.subject_type === 'ORDER_ITEM') {
        applied = await applyOrderItemDecision(client, review, decision, input, context);
      } else if (review.subject_type === 'QUEST') {
        applied = await applyQuestDecision(client, review, decision, context);
      } else {
        throw new TypeError(`unsupported manual review subject: ${review.subject_type}`);
      }
      await appendAdminAudit(client, { action: 'MANUAL_REVIEW_RESOLVED',
        targetType: review.subject_type, targetId: review.subject_id, actorId: context.actorId,
        before: { reviewState: review.state }, after: { decision, applied }, reason, context });
      return applied;
    } }, context, options);
}
