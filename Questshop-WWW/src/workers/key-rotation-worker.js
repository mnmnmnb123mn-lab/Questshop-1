import { decryptSecret, encryptSecret } from '../adapters/crypto/keyring.js';

async function rotateRows({ pool, env, query, aad, update }) {
  const rows = (await pool.query(query, [env.DATA_ENCRYPTION_KEYS_JSON.current])).rows;
  for (const row of rows) {
    const plaintext = decryptSecret({ keyVersion: row.key_version, nonce: row.nonce,
      ciphertext: row.ciphertext, authTag: row.auth_tag }, env.DATA_ENCRYPTION_KEYS_JSON, aad(row, env));
    const next = encryptSecret(plaintext, env.DATA_ENCRYPTION_KEYS_JSON, aad(row, env));
    await pool.query(update, [row.row_id, row.key_version, next.keyVersion, next.nonce, next.ciphertext, next.authTag]);
  }
  return rows.length;
}

export async function rotateEncryptedRows({ pool, env }) {
  let changed = 0;
  changed += await rotateRows({ pool, env,
    query: `SELECT c.session_id AS row_id,c.key_version,c.nonce,c.ciphertext,c.auth_tag,s.guild_id
      FROM checkout_credentials c JOIN interaction_sessions s ON s.id=c.session_id
      WHERE c.key_version<>$1 LIMIT 25`,
    aad: (row) => `checkout:${row.row_id}:${row.guild_id}`,
    update: `UPDATE checkout_credentials SET key_version=$3,nonce=$4,ciphertext=$5,auth_tag=$6
      WHERE session_id=$1 AND key_version=$2`,
  });
  changed += await rotateRows({ pool, env,
    query: `SELECT order_id AS row_id,key_version,nonce,ciphertext,auth_tag FROM order_credentials
      WHERE key_version<>$1 LIMIT 25`, aad: (row, value) => `order:${row.row_id}:${value.DISCORD_GUILD_ID}`,
    update: `UPDATE order_credentials SET key_version=$3,nonce=$4,ciphertext=$5,auth_tag=$6
      WHERE order_id=$1 AND key_version=$2`,
  });
  changed += await rotateRows({ pool, env,
    query: `SELECT monitor_id AS row_id,key_version,nonce,ciphertext,auth_tag FROM monitor_credentials
      WHERE key_version<>$1 LIMIT 25`, aad: (row, value) => `monitor:${row.row_id}:${value.DISCORD_GUILD_ID}`,
    update: `UPDATE monitor_credentials SET key_version=$3,nonce=$4,ciphertext=$5,auth_tag=$6,updated_at=clock_timestamp()
      WHERE monitor_id=$1 AND key_version=$2`,
  });
  changed += await rotateRows({ pool, env,
    query: `SELECT topup_id AS row_id,key_version,nonce,ciphertext,auth_tag FROM topup_sensitive_payloads
      WHERE key_version<>$1 LIMIT 25`, aad: (row, value) => `topup:${row.row_id}:${value.DISCORD_GUILD_ID}`,
    update: `UPDATE topup_sensitive_payloads SET key_version=$3,nonce=$4,ciphertext=$5,auth_tag=$6
      WHERE topup_id=$1 AND key_version=$2`,
  });
  const receivers = (await pool.query(`SELECT id AS row_id,encryption_key_version AS key_version,
    nonce,encrypted_phone AS ciphertext,auth_tag FROM receiver_versions WHERE encryption_key_version<>$1 LIMIT 25`,
  [env.DATA_ENCRYPTION_KEYS_JSON.current])).rows;
  for (const row of receivers) {
    const aad = `receiver:${row.row_id}:${env.DISCORD_GUILD_ID}`;
    const next = encryptSecret(decryptSecret({ keyVersion: row.key_version, nonce: row.nonce,
      ciphertext: row.ciphertext, authTag: row.auth_tag }, env.DATA_ENCRYPTION_KEYS_JSON, aad), env.DATA_ENCRYPTION_KEYS_JSON, aad);
    await pool.query(`UPDATE receiver_versions SET encryption_key_version=$3,nonce=$4,encrypted_phone=$5,auth_tag=$6
      WHERE id=$1 AND encryption_key_version=$2`, [row.row_id, row.key_version, next.keyVersion, next.nonce, next.ciphertext, next.authTag]);
  }
  return changed + receivers.length;
}
