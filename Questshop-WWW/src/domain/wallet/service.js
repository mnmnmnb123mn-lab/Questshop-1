import { v7 as uuidv7 } from 'uuid';
import { withTransaction } from '../../db/transaction.js';
import { FencingLostError, QuestshopError } from '../../shared/errors.js';
import { sumCents } from '../../shared/money.js';
import { enqueueProjection } from '../outbox/service.js';
import { assertTransition, recordTransition, requireUpdated } from '../shared/transition.js';
import {
  ORDER_ITEM_TRANSITIONS,
  RELEASED_STATES,
} from '../orders/states.js';
export { TERMINAL_ITEM_STATES } from '../orders/states.js';
import { appendLedger } from './ledger.js';
import { resolvePromotionBonus } from '../promotions/resolver.js';
import { bangkokDayBounds } from '../../db/postgres-time.js';
import { TOPUP_TRANSITIONS } from '../payments/states.js';
import { openReview } from '../reviews/service.js';
import { appendAdminAudit } from '../admin/audit.js';

async function lockWallet(client, discordUserId) {
  await client.query(`
    INSERT INTO wallets(discord_user_id) VALUES ($1)
    ON CONFLICT (discord_user_id) DO NOTHING
  `, [discordUserId]);
  return (await client.query(
    'SELECT * FROM wallets WHERE discord_user_id = $1 FOR UPDATE',
    [discordUserId],
  )).rows[0];
}

function walletBalances(wallet, deltaAvailable, deltaReserved) {
  const availableBefore = BigInt(wallet.available_cents);
  const reservedBefore = BigInt(wallet.reserved_cents);
  return {
    availableBefore,
    reservedBefore,
    availableAfter: availableBefore + BigInt(deltaAvailable),
    reservedAfter: reservedBefore + BigInt(deltaReserved),
  };
}

async function updateWallet(client, wallet, balances) {
  if (balances.availableAfter < 0n || balances.reservedAfter < 0n) {
    throw new QuestshopError('INSUFFICIENT_BALANCE', 'ยอดเงินไม่เพียงพอ', {
      category: 'BUSINESS',
    });
  }
  return (await client.query(`
    UPDATE wallets
    SET available_cents = $2,
        reserved_cents = $3,
        state_version = state_version + 1,
        updated_at = transaction_timestamp()
    WHERE discord_user_id = $1 AND state_version = $4
    RETURNING *
  `, [wallet.discord_user_id, balances.availableAfter, balances.reservedAfter, wallet.state_version])).rows[0];
}

async function durablePaymentLogType(client, topupId) {
  const sensitive = (await client.query('SELECT 1 FROM topup_sensitive_payloads WHERE topup_id=$1',
    [topupId])).rowCount > 0;
  // Preserve the original Discord message containing the full voucher link after its encrypted
  // database payload ages out. Later compensation gets a separate status-only projection.
  return sensitive ? 'PAYMENT_LOG' : 'PAYMENT_STATUS_LOG';
}

async function finalizeOrderIfTerminal(client, orderId, context) {
  const aggregate = (await client.query(
    'SELECT * FROM order_aggregates WHERE order_id = $1',
    [orderId],
  )).rows[0];
  if (!aggregate || Number(aggregate.active_items) !== 0) return;
  const order = (await client.query(`
    UPDATE orders SET completed_at = transaction_timestamp()
    WHERE id = $1 AND completed_at IS NULL
    RETURNING discord_user_id
  `, [orderId])).rows[0];
  // A terminal settlement can be retried after a process crash.  Publish the
  // final DM only for the transaction that first closes the aggregate.
  if (!order) return;
  await client.query('DELETE FROM order_credentials WHERE order_id = $1', [orderId]);
  await client.query('DELETE FROM active_quest_accounts WHERE order_id = $1', [orderId]);
  await enqueueProjection(client, { projectionType: 'ORDER_DM', aggregateType: 'ORDER',
    aggregateId: orderId, aggregateVersion: 1, surfaceKey: `DM:${order.discord_user_id}`, context });
}

export async function reserveOrderItemsInTransaction(client, { discordUserId, items }, context) {
  if (!items.length) throw new TypeError('at least one item is required');
  const total = sumCents(items.map((item) => item.amountCents));
  let wallet = await lockWallet(client, discordUserId);
  if (BigInt(wallet.available_cents) < total) {
    throw new QuestshopError('INSUFFICIENT_BALANCE', 'ยอดเงินไม่พอสำหรับจองรายการ', {
      category: 'BUSINESS',
    });
  }
  const groupId = uuidv7();
  for (const item of items) {
    const amount = BigInt(item.amountCents);
    const balances = walletBalances(wallet, -amount, amount);
    wallet = await updateWallet(client, wallet, balances);
    await client.query(`
      INSERT INTO wallet_reservations(id, order_item_id, discord_user_id, amount_cents, state)
      VALUES ($1, $2, $3, $4, 'RESERVED')
    `, [item.reservationId ?? uuidv7(), item.itemId, discordUserId, amount]);
    const updated = requireUpdated(await client.query(`
      UPDATE order_items SET state = 'RESERVED', state_version = state_version + 1,
        updated_at = transaction_timestamp()
      WHERE id = $1 AND state = 'SELECTED'
      RETURNING *
    `, [item.itemId]), 'order_item', item.itemId);
    await appendLedger(client, {
      discordUserId,
      transactionGroupId: groupId,
      transactionType: 'RESERVE',
      deltaAvailableCents: -amount,
      deltaReservedCents: amount,
      balances,
      referenceType: 'ORDER_ITEM',
      referenceId: item.itemId,
      idempotencyKey: `${context.idempotencyKey}:${item.itemId}:reserve`,
      context,
    });
    await recordTransition(client, {
      aggregateType: 'ORDER_ITEM', aggregateId: item.itemId,
      fromState: 'SELECTED', toState: 'RESERVED', stateVersion: updated.state_version,
      context,
    });
  }
  return wallet;
}

export async function reserveOrderItems(input, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, (client) => (
    reserveOrderItemsInTransaction(client, input, context)
  ));
}

export async function captureReservationInTransaction(client, { orderItemId, claimUrl,
  runnerOwnership = null }, context) {
    if (runnerOwnership) {
      const owned = (await client.query(`SELECT 1 FROM runner_jobs WHERE id=$1 AND order_item_id=$2
        AND lease_owner=$3 AND fencing_token=$4 AND lease_expires_at>clock_timestamp()`,
      [runnerOwnership.jobId, orderItemId, runnerOwnership.leaseOwner, runnerOwnership.fencingToken])).rowCount;
      if (!owned) throw new FencingLostError(`runner:${runnerOwnership.jobId}`);
    }
    const reservation = (await client.query(`
      SELECT r.*, i.order_id, i.task_type, i.started_at,
        i.state AS item_state, i.state_version AS item_version
      FROM wallet_reservations r JOIN order_items i ON i.id = r.order_item_id
      WHERE r.order_item_id = $1 FOR UPDATE OF r, i
    `, [orderItemId])).rows[0];
    if (!reservation) throw new QuestshopError('RESERVATION_NOT_FOUND', 'ไม่พบยอดจอง');
    if (reservation.state === 'CAPTURED') return reservation;
    if (reservation.state !== 'RESERVED') throw new QuestshopError('RESERVATION_NOT_ACTIVE', 'ยอดจองถูกคืนแล้ว');
    assertTransition(ORDER_ITEM_TRANSITIONS, reservation.item_state, 'READY_TO_CLAIM');
    const wallet = await lockWallet(client, reservation.discord_user_id);
    const amount = BigInt(reservation.amount_cents);
    const balances = walletBalances(wallet, 0n, -amount);
    await updateWallet(client, wallet, balances);
    await client.query(`
      UPDATE wallet_reservations SET state = 'CAPTURED', state_version = state_version + 1,
        settled_at = transaction_timestamp() WHERE id = $1 AND state = 'RESERVED'
    `, [reservation.id]);
    const item = requireUpdated(await client.query(`
      UPDATE order_items SET state = 'READY_TO_CLAIM', state_version = state_version + 1,
        progress_actual = 100, progress_bucket = 100, claim_url = $2,
        completed_at = transaction_timestamp(), updated_at = transaction_timestamp()
      WHERE id = $1 AND state = $3 AND state_version = $4 RETURNING *
    `, [orderItemId, claimUrl, reservation.item_state, reservation.item_version]), 'order_item', orderItemId);
    await appendLedger(client, {
      discordUserId: reservation.discord_user_id,
      transactionGroupId: uuidv7(),
      transactionType: 'CAPTURE',
      deltaAvailableCents: 0n,
      deltaReservedCents: -amount,
      balances,
      referenceType: 'ORDER_ITEM',
      referenceId: orderItemId,
      idempotencyKey: `${context.idempotencyKey}:${orderItemId}:capture`,
      context,
    });
    await recordTransition(client, {
      aggregateType: 'ORDER_ITEM', aggregateId: orderItemId,
      fromState: reservation.item_state, toState: 'READY_TO_CLAIM',
      stateVersion: item.state_version, context,
    });
    if (item.started_at) await client.query(`INSERT INTO runtime_samples(id,task_type,duration_ms,
      successful,order_item_id) VALUES($1,$2,GREATEST(0,extract(epoch FROM
      (transaction_timestamp()-$3::timestamptz))*1000)::bigint,true,$4)`,
    [uuidv7(), item.task_type, item.started_at, item.id]);
    await enqueueProjection(client, {
      projectionType: 'QUEST_HISTORY', aggregateType: 'ORDER_ITEM', aggregateId: orderItemId,
      aggregateVersion: item.state_version, surfaceKey: 'QUEST_HISTORY', context,
    });
    await finalizeOrderIfTerminal(client, reservation.order_id, context);
    return item;
}

export async function captureReservation(input, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, (client) => (
    captureReservationInTransaction(client, input, context)
  ));
}

export async function releaseReservationInTransaction(client, { orderItemId, terminalState, reason,
  runnerOwnership = null }, context) {
  if (!RELEASED_STATES.includes(terminalState)) throw new TypeError('invalid released terminal state');
  if (runnerOwnership) {
      const owned = (await client.query(`SELECT 1 FROM runner_jobs WHERE id=$1 AND order_item_id=$2
        AND lease_owner=$3 AND fencing_token=$4 AND lease_expires_at>clock_timestamp()`,
      [runnerOwnership.jobId, orderItemId, runnerOwnership.leaseOwner, runnerOwnership.fencingToken])).rowCount;
      if (!owned) throw new FencingLostError(`runner:${runnerOwnership.jobId}`);
  }
  const reservation = (await client.query(`
      SELECT r.*, i.order_id, i.task_type, i.started_at,
        i.state AS item_state, i.state_version AS item_version
      FROM wallet_reservations r JOIN order_items i ON i.id = r.order_item_id
      WHERE r.order_item_id = $1 FOR UPDATE OF r, i
    `, [orderItemId])).rows[0];
  if (!reservation) {
    throw new QuestshopError('RESERVATION_NOT_FOUND', 'ไม่พบยอดจอง');
  }
  if (reservation.state === 'RELEASED') {
    return reservation;
  }
  if (reservation.state !== 'RESERVED') {
    throw new QuestshopError('RESERVATION_CAPTURED', 'ยอดจองถูกคิดค่าบริการแล้ว');
  }
  assertTransition(ORDER_ITEM_TRANSITIONS, reservation.item_state, terminalState);
  const wallet = await lockWallet(client, reservation.discord_user_id);
  const amount = BigInt(reservation.amount_cents);
  const balances = walletBalances(wallet, amount, -amount);
  await updateWallet(client, wallet, balances);
    await client.query(`
      UPDATE wallet_reservations SET state = 'RELEASED', state_version = state_version + 1,
        settled_at = transaction_timestamp() WHERE id = $1 AND state = 'RESERVED'
    `, [reservation.id]);
    const item = requireUpdated(await client.query(`
      UPDATE order_items SET state = $2, state_version = state_version + 1,
        terminal_reason = $3, completed_at = transaction_timestamp(), updated_at = transaction_timestamp()
      WHERE id = $1 AND state = $4 AND state_version = $5 RETURNING *
    `, [orderItemId, terminalState, reason, reservation.item_state, reservation.item_version]), 'order_item', orderItemId);
    await appendLedger(client, {
      discordUserId: reservation.discord_user_id,
      transactionGroupId: uuidv7(),
      transactionType: 'RELEASE',
      deltaAvailableCents: amount,
      deltaReservedCents: -amount,
      balances,
      referenceType: 'ORDER_ITEM',
      referenceId: orderItemId,
      idempotencyKey: `${context.idempotencyKey}:${orderItemId}:release`,
      reason,
      context,
    });
    await recordTransition(client, {
      aggregateType: 'ORDER_ITEM', aggregateId: orderItemId,
      fromState: reservation.item_state, toState: terminalState,
      stateVersion: item.state_version, reasonCode: reason, context,
    });
    if (item.started_at) await client.query(`INSERT INTO runtime_samples(id,task_type,duration_ms,
      successful,order_item_id) VALUES($1,$2,GREATEST(0,extract(epoch FROM
      (transaction_timestamp()-$3::timestamptz))*1000)::bigint,false,$4)`,
    [uuidv7(), item.task_type, item.started_at, item.id]);
    await enqueueProjection(client, {
      projectionType: 'QUEST_HISTORY', aggregateType: 'ORDER_ITEM', aggregateId: orderItemId,
      aggregateVersion: item.state_version, surfaceKey: 'QUEST_HISTORY', context,
    });
    await finalizeOrderIfTerminal(client, reservation.order_id, context);
    return item;
}

export async function releaseReservation(input, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, (client) => (
    releaseReservationInTransaction(client, input, context)
  ));
}

export async function refundCapturedOrderItemInTransaction(client, {
  orderItemId, reason, expectedReservationVersion = null,
}, context) {
  if (!reason?.trim()) throw new TypeError('refund reason is required');
  const existing = (await client.query(`SELECT f.*,w.available_cents,w.reserved_cents
    FROM refunds f JOIN wallets w ON w.discord_user_id=f.discord_user_id
    WHERE f.order_item_id=$1`, [orderItemId])).rows[0];
  if (existing) return existing;

  const reservation = (await client.query(`SELECT r.*,i.order_id,i.quest_id,i.quest_name,
    i.state AS item_state,i.state_version AS item_version
    FROM wallet_reservations r JOIN order_items i ON i.id=r.order_item_id
    WHERE r.order_item_id=$1 FOR UPDATE OF r,i`, [orderItemId])).rows[0];
  if (!reservation) throw new QuestshopError('RESERVATION_NOT_FOUND', 'ไม่พบยอดจองของ Item นี้');
  if (reservation.state !== 'CAPTURED') {
    throw new QuestshopError('REFUND_NOT_CAPTURED', 'คืนเงินได้เฉพาะ Item ที่ Capture แล้ว');
  }
  if (expectedReservationVersion != null
    && String(reservation.state_version) !== String(expectedReservationVersion)) {
    throw new QuestshopError('STALE_REFUND_PREVIEW', 'สถานะยอดจองเปลี่ยนหลัง Preview กรุณาเริ่มใหม่');
  }

  const wallet = await lockWallet(client, reservation.discord_user_id);
  const amount = BigInt(reservation.amount_cents);
  const balances = walletBalances(wallet, amount, 0n);
  const updatedWallet = await updateWallet(client, wallet, balances);
  const refundId = uuidv7();
  const ledger = await appendLedger(client, {
    discordUserId: reservation.discord_user_id,
    transactionGroupId: uuidv7(),
    transactionType: 'REFUND_CREDIT',
    deltaAvailableCents: amount,
    deltaReservedCents: 0n,
    balances,
    referenceType: 'REFUND',
    referenceId: refundId,
    idempotencyKey: `refund:${orderItemId}:full`,
    reason: reason.trim(),
    metadata: { orderItemId, orderId: reservation.order_id, questId: reservation.quest_id },
    context,
  });
  const refund = (await client.query(`INSERT INTO refunds(id,order_item_id,discord_user_id,
    amount_cents,reason,actor_id,trace_id,wallet_transaction_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [refundId, orderItemId,
    reservation.discord_user_id, amount, reason.trim(), context.actorId, context.traceId, ledger.id])).rows[0];
  await appendAdminAudit(client, {
    action: 'ORDER_ITEM_REFUND', targetType: 'ORDER_ITEM', targetId: orderItemId,
    actorId: context.actorId,
    before: { reservationState: reservation.state, availableCents: String(balances.availableBefore) },
    after: { reservationState: reservation.state, availableCents: String(balances.availableAfter), refundId },
    reason: reason.trim(), context,
  });
  await enqueueProjection(client, {
    projectionType: 'REFUND_LOG', aggregateType: 'REFUND', aggregateId: refundId,
    aggregateVersion: 1, surfaceKey: 'LOG_PAYMENTS', context,
  });
  await enqueueProjection(client, {
    projectionType: 'QUEST_HISTORY', aggregateType: 'ORDER_ITEM', aggregateId: orderItemId,
    aggregateVersion: Number(reservation.item_version) * 1000 + 999,
    surfaceKey: 'QUEST_HISTORY', context,
  });
  return { ...refund, available_cents: updatedWallet.available_cents,
    reserved_cents: updatedWallet.reserved_cents };
}

export async function refundCapturedOrderItem(input, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, (client) => (
    refundCapturedOrderItemInTransaction(client, input, context)
  ));
}

export async function adjustBalanceInTransaction(client, { discordUserId, amountCents, reason }, context) {
  const amount = BigInt(amountCents);
  if (amount === 0n || !reason?.trim()) throw new TypeError('non-zero amount and reason are required');
  const existing = (await client.query('SELECT discord_user_id FROM wallet_transactions WHERE idempotency_key=$1',
      [context.idempotencyKey])).rows[0];
  if (existing) return (await client.query('SELECT * FROM wallets WHERE discord_user_id=$1',
      [existing.discord_user_id])).rows[0];
  const wallet = await lockWallet(client, discordUserId);
    const balances = walletBalances(wallet, amount, 0n);
    const updated = await updateWallet(client, wallet, balances);
    await appendLedger(client, {
      discordUserId,
      transactionGroupId: uuidv7(),
      transactionType: amount > 0n ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT',
      deltaAvailableCents: amount,
      deltaReservedCents: 0n,
      balances,
      referenceType: 'ADMIN_ADJUSTMENT',
      referenceId: context.idempotencyKey,
      idempotencyKey: context.idempotencyKey,
      reason,
      context,
    });
    return updated;
}

export async function adjustBalance(input, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, (client) => (
    adjustBalanceInTransaction(client, input, context)
  ));
}

export async function creditRedeemedTopupInTransaction(client, { topupId }, context) {
    const topup = (await client.query('SELECT * FROM topups WHERE id = $1 FOR UPDATE', [topupId])).rows[0];
    if (!topup) throw new QuestshopError('TOPUP_NOT_FOUND', 'ไม่พบรายการเติมเงิน');
    if (topup.status === 'CREDITED') {
      const transaction = (await client.query(`
        SELECT * FROM wallet_transactions
        WHERE reference_type = 'TOPUP' AND reference_id = $1 AND transaction_type = 'TOPUP_CREDIT'
      `, [topupId])).rows[0];
      return { topup, transaction, idempotent: true };
    }
    assertTransition(TOPUP_TRANSITIONS, topup.status, 'CREDITED');
    if (topup.amount_cents == null || topup.currency !== 'THB') {
      throw new QuestshopError('TOPUP_EVIDENCE_INCOMPLETE', 'ข้อมูลรับเงินไม่ครบ ห้ามเพิ่มเครดิต', {
        category: 'FINANCIAL_INVARIANT',
      });
    }
    let wallet = await lockWallet(client, topup.discord_user_id);
    const bounds = await bangkokDayBounds(client, topup.redeemed_at ?? null);
    // Provider redemption time is the authoritative Bangkok accounting day.
    // Manual Review may credit later, but promotion/day evidence must not drift across midnight.
    const day = bounds.bangkok_day;
    const promotion = await resolvePromotionBonus(client, {
      promotionId: topup.promotion_id,
      discordUserId: topup.discord_user_id,
      principalCents: BigInt(topup.amount_cents),
      bangkokDay: day,
    });
    const principal = BigInt(topup.amount_cents);
    const bonus = promotion.bonusCents;
    const total = principal + bonus;
    const balances = walletBalances(wallet, total, 0n);
    wallet = await updateWallet(client, wallet, balances);
    const ledger = await appendLedger(client, {
      discordUserId: topup.discord_user_id,
      transactionGroupId: uuidv7(),
      transactionType: 'TOPUP_CREDIT',
      deltaAvailableCents: total,
      deltaReservedCents: 0n,
      balances,
      principalCents: principal,
      bonusCents: bonus,
      referenceType: 'TOPUP',
      referenceId: topupId,
      idempotencyKey: `topup:${topupId}:credit`,
      metadata: { promotionId: topup.promotion_id, promotionTierId: promotion.tierId },
      context,
    });
    if (promotion.eligible) {
      await client.query(`
        INSERT INTO promotion_usages(
          id, promotion_id, discord_user_id, topup_id, bangkok_day,
          principal_cents, bonus_cents
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (topup_id) DO NOTHING
      `, [uuidv7(), topup.promotion_id, topup.discord_user_id, topupId, day, principal, bonus]);
    }
    const updated = (await client.query(`
      UPDATE topups SET status = 'CREDITED', state_version = state_version + 1,
        bonus_cents = $2, credited_at = transaction_timestamp(), updated_at = transaction_timestamp(),
        lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1 AND state_version = $3 RETURNING *
    `, [topupId, bonus, topup.state_version])).rows[0];
    if (!updated) throw new QuestshopError('TOPUP_STALE', 'Top-up changed concurrently');
    await recordTransition(client, {
      aggregateType: 'TOPUP', aggregateId: topupId,
      fromState: topup.status, toState: 'CREDITED', stateVersion: updated.state_version,
      context,
    });
    await client.query(`INSERT INTO operation_metrics(id,operation,outcome,duration_ms,trace_id)
      VALUES($1,'TOPUP_CREDIT','SUCCESS',GREATEST(0,floor(extract(epoch FROM transaction_timestamp()-$2::timestamptz)*1000))::integer,$3)`,
    [uuidv7(), topup.created_at, context.traceId]);
    await enqueueProjection(client, {
      projectionType: await durablePaymentLogType(client, topupId), aggregateType: 'TOPUP', aggregateId: topupId,
      aggregateVersion: updated.state_version, surfaceKey: 'LOG_PAYMENTS', context,
    });
    await enqueueProjection(client, { projectionType: 'TOPUP_RECEIPT', aggregateType: 'TOPUP',
      aggregateId: topupId, aggregateVersion: updated.state_version,
      surfaceKey: `DM:${topup.discord_user_id}`, context });
    return { topup: updated, wallet, transaction: ledger, idempotent: false };
}

export async function creditRedeemedTopup(input, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, (client) => (
    creditRedeemedTopupInTransaction(client, input, context)
  ));
}

export async function reverseTopup({ topupId, reason }, context, options = {}) {
  if (!reason?.trim()) throw new TypeError('reversal reason is required');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const topup = (await client.query('SELECT * FROM topups WHERE id = $1 FOR UPDATE', [topupId])).rows[0];
    if (!topup) throw new QuestshopError('TOPUP_NOT_FOUND', 'ไม่พบรายการเติมเงิน');
    if (topup.status === 'REVERSED') return topup;
    assertTransition(TOPUP_TRANSITIONS, topup.status, 'REVERSED');
    const total = BigInt(topup.amount_cents) + BigInt(topup.bonus_cents ?? 0);
    const wallet = await lockWallet(client, topup.discord_user_id);
    if (BigInt(wallet.available_cents) < total) {
      const review = await openReview(client, { subjectType: 'TOPUP', subjectId: topupId,
        reason: 'REVERSAL_INSUFFICIENT_AVAILABLE', financial: true, ownerOnly: true, context });
      await appendAdminAudit(client, { action: 'TOPUP_REVERSAL_REVIEW_OPENED', targetType: 'TOPUP',
        targetId: topupId, actorId: context.actorId,
        before: { availableCents: wallet.available_cents, reversalCents: String(total) },
        after: { reviewId: review.id }, reason, context });
      return { pendingReview: true, review, topup };
    }
    const balances = walletBalances(wallet, -total, 0n);
    await updateWallet(client, wallet, balances);
    await appendLedger(client, {
      discordUserId: topup.discord_user_id,
      transactionGroupId: uuidv7(),
      transactionType: 'TOPUP_REVERSAL',
      deltaAvailableCents: -total,
      deltaReservedCents: 0n,
      balances,
      principalCents: BigInt(topup.amount_cents),
      bonusCents: BigInt(topup.bonus_cents ?? 0),
      referenceType: 'TOPUP', referenceId: topupId,
      idempotencyKey: `topup:${topupId}:reversal`, reason, context,
    });
    const updated = (await client.query(`
      UPDATE topups SET status = 'REVERSED', state_version = state_version + 1,
        updated_at = transaction_timestamp() WHERE id = $1 RETURNING *
    `, [topupId])).rows[0];
    await recordTransition(client, { aggregateType: 'TOPUP', aggregateId: topupId,
      fromState: topup.status, toState: 'REVERSED', stateVersion: updated.state_version,
      reasonCode: 'COMPENSATING_REVERSAL', context });
    await appendAdminAudit(client, { action: 'TOPUP_REVERSED', targetType: 'TOPUP', targetId: topupId,
      actorId: context.actorId, before: { status: topup.status, availableCents: wallet.available_cents },
      after: { status: updated.status, reversalCents: String(total) }, reason, context });
    await enqueueProjection(client, { projectionType: await durablePaymentLogType(client, topupId), aggregateType: 'TOPUP',
      aggregateId: topupId, aggregateVersion: updated.state_version,
      surfaceKey: 'LOG_PAYMENTS', context });
    return updated;
  });
}
