import { withTransaction } from '../../db/transaction.js';
import { adjustBalanceInTransaction } from '../wallet/service.js';
import { appendAdminAudit } from './audit.js';

export async function adjustWalletAsAdmin({ discordUserId, amountCents, reason,
  expectedVersion }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const before = (await client.query(`SELECT available_cents,reserved_cents,state_version
      FROM wallets WHERE discord_user_id=$1 FOR UPDATE`, [discordUserId])).rows[0]
      ?? { available_cents: '0', reserved_cents: '0', state_version: '0' };
    if (String(before.state_version) !== String(expectedVersion)) {
      throw new Error('STALE_WALLET_PREVIEW');
    }
    const wallet = await adjustBalanceInTransaction(client, { discordUserId, amountCents, reason }, context);
    await appendAdminAudit(client, { action: BigInt(amountCents) > 0n ? 'WALLET_CREDIT' : 'WALLET_DEBIT',
      targetType: 'WALLET', targetId: discordUserId, actorId: context.actorId, before,
      after: { availableCents: wallet.available_cents, reservedCents: wallet.reserved_cents,
        stateVersion: wallet.state_version, deltaAvailableCents: String(amountCents) },
      reason, context });
    return wallet;
  });
}
