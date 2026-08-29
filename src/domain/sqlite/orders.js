import { randomUUID } from 'node:crypto';
import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';
import { appendWalletTransactionInTransaction } from './wallet.js';
import { enqueueNotificationInTransaction } from './notifications.js';
import { QuestshopError } from '../../shared/errors.js';

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

export function createOrder(db, { discordUserId, questAccountId, credentialId = null, items, traceId = randomUUID() }) {
  if (!Array.isArray(items) || !items.length) throw new QuestshopError('NO_SELLABLE_QUEST', 'ไม่มี Quest ที่เลือก');
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
      db.prepare(`INSERT INTO orders(id,discord_user_id,quest_account_id,credential_id,state,total_cents,trace_id,created_at,updated_at)
        VALUES(?,?,?,?,'PENDING',?,?,?,?)`).run(orderId, discordUserId, questAccountId, credentialId, total, traceId, timestamp, timestamp);
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

export function settleOrderItem(db, { itemId, outcome, claimUrl = null, reason = null }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const item = db.prepare(`SELECT i.*,o.discord_user_id,o.trace_id FROM order_items i JOIN orders o ON o.id=i.order_id
      WHERE i.id=?`).get(itemId);
    if (!item) throw new QuestshopError('ORDER_ITEM_NOT_FOUND', 'ไม่พบรายการ Quest');
    if (!['QUEUED', 'RUNNING', 'REVIEW'].includes(item.state)) return item;
    if (outcome === 'SUCCESS') {
      appendWalletTransactionInTransaction(db, { discordUserId: item.discord_user_id, transactionType: 'CAPTURE',
        reservedDeltaCents: -Number(item.price_cents), referenceType: 'ORDER_ITEM', referenceId: item.id,
        idempotencyKey: `capture:${item.id}`, traceId: item.trace_id, timestamp });
      db.prepare(`UPDATE order_items SET state='READY_TO_CLAIM',progress_percent=100,claim_url=?,completed_at=?,state_version=state_version+1,updated_at=?
        WHERE id=? AND state_version=?`).run(claimUrl, timestamp, timestamp, item.id, item.state_version);
    } else if (outcome === 'FAILED') {
      appendWalletTransactionInTransaction(db, { discordUserId: item.discord_user_id, transactionType: 'RELEASE',
        availableDeltaCents: Number(item.price_cents), reservedDeltaCents: -Number(item.price_cents),
        referenceType: 'ORDER_ITEM', referenceId: item.id, idempotencyKey: `release:${item.id}`,
        traceId: item.trace_id, reason, timestamp });
      db.prepare(`UPDATE order_items SET state='FAILED',state_version=state_version+1,updated_at=? WHERE id=? AND state_version=?`)
        .run(timestamp, item.id, item.state_version);
    } else {
      db.prepare(`UPDATE order_items SET state='REVIEW',state_version=state_version+1,updated_at=? WHERE id=? AND state_version=?`)
        .run(timestamp, item.id, item.state_version);
      db.prepare(`INSERT INTO manual_reviews(id,subject_type,subject_id,category,state,reason_code,safe_reason,created_at,updated_at)
        VALUES(?,?,?,'OPERATIONAL','OPEN',?,?,?,?) ON CONFLICT(subject_type,subject_id) WHERE state='OPEN'
        DO UPDATE SET reason_code=excluded.reason_code,safe_reason=excluded.safe_reason,updated_at=excluded.updated_at`).run(
        randomUUID(), 'ORDER_ITEM', item.id, reason ?? 'QUEST_RESULT_AMBIGUOUS', 'ผลการทำ Quest ยังยืนยันไม่ได้', timestamp, timestamp,
      );
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
  });
}

export function markOrderItemRunning(db, { itemId }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const item = db.prepare('SELECT * FROM order_items WHERE id=?').get(itemId);
    if (!item || item.state !== 'QUEUED') return item ?? null;
    db.prepare(`UPDATE order_items SET state='RUNNING',state_version=state_version+1,updated_at=? WHERE id=? AND state_version=?`)
      .run(timestamp, itemId, item.state_version);
    refreshOrderState(db, item.order_id, timestamp);
    return db.prepare('SELECT * FROM order_items WHERE id=?').get(itemId);
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
