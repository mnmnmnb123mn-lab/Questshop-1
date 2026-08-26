import { v7 as uuidv7 } from 'uuid';
import { encryptSecret } from '../../adapters/crypto/keyring.js';
import { withTransaction } from '../../db/transaction.js';
import { appendAdminAudit } from './audit.js';

export async function activateReceiver({ phone, env, reason }, context, options = {}) {
  if (!/^0\d{9}$/.test(phone) || !reason?.trim()) throw new TypeError('invalid receiver activation');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const previous = (await client.query("SELECT * FROM receiver_versions WHERE state='ACTIVE' FOR UPDATE")).rows[0] ?? null;
    const id = uuidv7();
    const encrypted = encryptSecret(phone, env.DATA_ENCRYPTION_KEYS_JSON, `receiver:${id}:${context.guildId}`);
    if (previous) await client.query(`UPDATE receiver_versions SET state='INACTIVE',
      deactivated_at=transaction_timestamp() WHERE id=$1`, [previous.id]);
    const version = Number((await client.query('SELECT COALESCE(max(version),0)::bigint+1 AS value FROM receiver_versions')).rows[0].value);
    const row = (await client.query(`INSERT INTO receiver_versions(id,version,encrypted_phone,
      encryption_key_version,nonce,auth_tag,phone_last4,state,actor_id,trace_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,$9) RETURNING *`, [id, version,
      encrypted.ciphertext, encrypted.keyVersion, encrypted.nonce, encrypted.authTag,
      phone.slice(-4), context.actorId, context.traceId])).rows[0];
    await appendAdminAudit(client, { action: 'ACTIVATE_RECEIVER', targetType: 'RECEIVER', targetId: id,
      actorId: context.actorId, before: previous && { id: previous.id, version: previous.version,
        phoneLast4: previous.phone_last4 }, after: { id, version, phoneLast4: phone.slice(-4) }, reason, context });
    return row;
  });
}
