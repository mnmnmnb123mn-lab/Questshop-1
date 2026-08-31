import { randomUUID } from 'node:crypto';
import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';
import { QuestshopError } from '../../shared/errors.js';

export function ensureWallet(db, discordUserId, timestamp = nowMs()) {
  db.prepare(`INSERT INTO wallets(discord_user_id,available_cents,reserved_cents,version,created_at,updated_at)
    VALUES(?,0,0,1,?,?) ON CONFLICT(discord_user_id) DO NOTHING`).run(discordUserId, timestamp, timestamp);
  return db.prepare('SELECT * FROM wallets WHERE discord_user_id=?').get(discordUserId);
}

export function appendWalletTransaction(db, {
  discordUserId, transactionType, availableDeltaCents = 0, reservedDeltaCents = 0,
  referenceType, referenceId, idempotencyKey, traceId, reason = null, timestamp = nowMs(),
}) {
  return withImmediateTransaction(db, () => appendWalletTransactionInTransaction(db, {
    discordUserId, transactionType, availableDeltaCents, reservedDeltaCents,
    referenceType, referenceId, idempotencyKey, traceId, reason, timestamp,
  }));
}

/**
 * The financial aggregate owns the outer transaction.  This primitive never
 * opens one itself, so an Item/Top-up state change and its money movement can
 * commit or rollback together.
 */
export function appendWalletTransactionInTransaction(db, {
  discordUserId, transactionType, availableDeltaCents = 0, reservedDeltaCents = 0,
  referenceType, referenceId, idempotencyKey, traceId, reason = null, timestamp = nowMs(),
}) {
  const duplicate = db.prepare('SELECT * FROM wallet_transactions WHERE idempotency_key=?').get(idempotencyKey);
  if (duplicate) {
    const matches = duplicate.discord_user_id === discordUserId
      && duplicate.transaction_type === transactionType
      && Number(duplicate.available_delta_cents) === Number(availableDeltaCents)
      && Number(duplicate.reserved_delta_cents) === Number(reservedDeltaCents)
      && duplicate.reference_type === referenceType
      && duplicate.reference_id === referenceId
      && duplicate.trace_id === traceId;
    if (!matches) throw new QuestshopError('IDEMPOTENCY_CONFLICT', 'รหัสธุรกรรมนี้ถูกใช้กับคำขออื่นแล้ว');
    return { transaction: duplicate, wallet: ensureWallet(db, discordUserId, timestamp), idempotent: true };
  }
  const wallet = ensureWallet(db, discordUserId, timestamp);
  const available = Number(wallet.available_cents) + Number(availableDeltaCents);
  const reserved = Number(wallet.reserved_cents) + Number(reservedDeltaCents);
  if (available < 0 || reserved < 0) {
    const error = new Error('Wallet balance would become negative');
    error.code = 'INSUFFICIENT_BALANCE';
    throw error;
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO wallet_transactions(id,discord_user_id,transaction_type,available_delta_cents,reserved_delta_cents,
    available_after_cents,reserved_after_cents,reference_type,reference_id,idempotency_key,trace_id,reason,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, discordUserId, transactionType, availableDeltaCents, reservedDeltaCents,
    available, reserved, referenceType, referenceId, idempotencyKey, traceId, reason, timestamp);
  db.prepare(`UPDATE wallets SET available_cents=?,reserved_cents=?,version=version+1,updated_at=? WHERE discord_user_id=?`)
    .run(available, reserved, timestamp, discordUserId);
  return { transaction: db.prepare('SELECT * FROM wallet_transactions WHERE id=?').get(id),
    wallet: db.prepare('SELECT * FROM wallets WHERE discord_user_id=?').get(discordUserId), idempotent: false };
}

export const WALLET_MOVEMENTS = Object.freeze({
  reserve: { transactionType: 'RESERVE', availableDeltaCents: -1, reservedDeltaCents: 1 },
  capture: { transactionType: 'CAPTURE', availableDeltaCents: 0, reservedDeltaCents: -1 },
  release: { transactionType: 'RELEASE', availableDeltaCents: 1, reservedDeltaCents: -1 },
  refund: { transactionType: 'REFUND', availableDeltaCents: 1, reservedDeltaCents: 0 },
  topup: { transactionType: 'TOPUP', availableDeltaCents: 1, reservedDeltaCents: 0 },
  reversal: { transactionType: 'REVERSAL', availableDeltaCents: -1, reservedDeltaCents: 0 },
});
