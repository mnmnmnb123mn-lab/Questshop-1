import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';

function canonical(fields) {
  return [
    fields.id,
    fields.discordUserId,
    fields.transactionType,
    fields.deltaAvailableCents,
    fields.deltaReservedCents,
    fields.availableAfterCents,
    fields.reservedAfterCents,
    fields.referenceType,
    fields.referenceId,
    fields.idempotencyKey,
    fields.previousHash ?? '',
  ].map(String).join('|');
}

export function ledgerHash(fields) {
  return createHash('sha256').update(canonical(fields)).digest('hex');
}

export async function appendLedger(client, {
  discordUserId,
  transactionGroupId,
  transactionType,
  deltaAvailableCents,
  deltaReservedCents,
  balances,
  referenceType,
  referenceId,
  idempotencyKey,
  reason = null,
  principalCents = null,
  bonusCents = null,
  metadata = {},
  context,
}) {
  const existing = (await client.query(
    'SELECT * FROM wallet_transactions WHERE idempotency_key = $1',
    [idempotencyKey],
  )).rows[0];
  if (existing) return existing;

  const previous = (await client.query(`
    SELECT entry_hash FROM wallet_transactions
    WHERE discord_user_id = $1
    ORDER BY created_at DESC, id DESC LIMIT 1
  `, [discordUserId])).rows[0];
  const checkpoint = previous ? null : (await client.query(`
    SELECT chain_hash FROM wallet_checkpoints WHERE discord_user_id=$1
    ORDER BY created_at DESC,id DESC LIMIT 1
  `, [discordUserId])).rows[0];
  const id = uuidv7();
  const fields = {
    id,
    discordUserId,
    transactionType,
    deltaAvailableCents,
    deltaReservedCents,
    availableAfterCents: balances.availableAfter,
    reservedAfterCents: balances.reservedAfter,
    referenceType,
    referenceId,
    idempotencyKey,
    previousHash: previous?.entry_hash ?? checkpoint?.chain_hash ?? null,
  };
  const entryHash = ledgerHash(fields);
  return (await client.query(`
    INSERT INTO wallet_transactions(
      id, discord_user_id, transaction_group_id, transaction_type,
      delta_available_cents, delta_reserved_cents,
      available_before_cents, available_after_cents,
      reserved_before_cents, reserved_after_cents,
      principal_cents, bonus_cents, reference_type, reference_id,
      idempotency_key, reason, metadata, previous_hash, entry_hash,
      trace_id, actor_type, actor_id
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
    ) RETURNING *
  `, [
    id, discordUserId, transactionGroupId, transactionType,
    deltaAvailableCents, deltaReservedCents,
    balances.availableBefore, balances.availableAfter,
    balances.reservedBefore, balances.reservedAfter,
    principalCents, bonusCents, referenceType, String(referenceId),
    idempotencyKey, reason, metadata, fields.previousHash, entryHash,
    context.traceId, context.actorType, context.actorId,
  ])).rows[0];
}
