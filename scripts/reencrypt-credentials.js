import '../src/config/load-local-environment.js';
import { loadEnvironment } from '../src/config/env.js';
import { acquireSingleInstanceLock, closeSqliteDatabase, ensureSqliteDirectory, openSqliteDatabase, withImmediateTransaction } from '../src/db/sqlite.js';
import { decryptCredential, encryptCredential } from '../src/domain/sqlite/crypto.js';

const env = loadEnvironment();
await ensureSqliteDirectory(env.SQLITE_PATH);
const lock = await acquireSingleInstanceLock(env.SQLITE_PATH);
let db;
try {
  db = await openSqliteDatabase({ databasePath: env.SQLITE_PATH, secret: env.QUESTSHOP_SECRET_KEY });
  const rows = db.prepare('SELECT * FROM credentials WHERE key_version<>? ORDER BY id').all(env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION);
  let changed = 0;
  for (const row of rows) {
    const plaintext = decryptCredential(env.QUESTSHOP_SECRET_KEY, row, { allowedVersions: [row.key_version] });
    const encrypted = encryptCredential(env.QUESTSHOP_SECRET_KEY, plaintext, { keyVersion: env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION });
    withImmediateTransaction(db, () => {
      const updated = db.prepare(`UPDATE credentials SET key_version=?,ciphertext=?,nonce=?,auth_tag=?,updated_at=?
        WHERE id=? AND key_version=?`).run(encrypted.keyVersion, encrypted.ciphertext, encrypted.nonce, encrypted.authTag,
        Date.now(), row.id, row.key_version);
      if (!updated.changes) throw new Error(`Credential changed while rotating: ${row.id}`);
    });
    changed += 1;
  }
  console.log(JSON.stringify({ ok: true, activeVersion: env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION, changed }));
} finally {
  closeSqliteDatabase(db);
  await lock.release();
}
