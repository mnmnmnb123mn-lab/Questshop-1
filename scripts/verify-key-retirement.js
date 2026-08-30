import '../src/config/load-local-environment.js';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { loadEnvironment } from '../src/config/env.js';
import { acquireSingleInstanceLock, closeSqliteDatabase, ensureSqliteDirectory, openSqliteDatabase, verifyKeyVerifier } from '../src/db/sqlite.js';
import { voucherHmacKeyring } from '../src/domain/sqlite/crypto.js';

const env = loadEnvironment();
await ensureSqliteDirectory(env.SQLITE_PATH);
const lock = await acquireSingleInstanceLock(env.SQLITE_PATH);
let db;
try {
  db = await openSqliteDatabase({ databasePath: env.SQLITE_PATH, secret: env.QUESTSHOP_SECRET_KEY });
  const row = db.prepare("SELECT value_json FROM settings WHERE key='secret_verifier'").get();
  const verifier = row ? JSON.parse(row.value_json)?.verifier : null;
  if (!verifier || !verifyKeyVerifier(env.QUESTSHOP_SECRET_KEY, verifier)) throw new Error('SQLite secret verifier is invalid');
  const versions = db.prepare('SELECT DISTINCT voucher_hmac_version AS version FROM topups').all().map((entry) => entry.version);
  voucherHmacKeyring(env.QUESTSHOP_SECRET_KEY, [...versions, env.VOUCHER_HMAC_ACTIVE_VERSION]);
  const credentialVersions = db.prepare('SELECT DISTINCT key_version AS version FROM credentials').all().map((entry) => entry.version);
  const backupDirectory = path.join(path.dirname(env.SQLITE_PATH), 'backups');
  const backups = (await readdir(backupDirectory, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.db')).map((entry) => path.join(backupDirectory, entry.name));
  const backupCredentialVersions = new Set();
  for (const backup of backups) {
    const backupDb = new DatabaseSync(backup, { readOnly: true, enableForeignKeyConstraints: true });
    try {
      for (const row of backupDb.prepare('SELECT DISTINCT key_version AS version FROM credentials').all()) backupCredentialVersions.add(row.version);
    } finally { backupDb.close(); }
  }
  const allCredentialVersions = [...new Set([...credentialVersions, ...backupCredentialVersions])];
  const unavailable = allCredentialVersions.filter((version) => !env.CREDENTIAL_ENCRYPTION_ALLOWED_VERSIONS.includes(version));
  if (unavailable.length) throw new Error(`Credential key versions still referenced but not allowed: ${unavailable.join(',')}`);
  console.log(JSON.stringify({ ok: true, voucherHmacVersions: versions, activeVoucherVersion: env.VOUCHER_HMAC_ACTIVE_VERSION,
    credentialVersions, backupCredentialVersions: [...backupCredentialVersions], activeCredentialVersion: env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION }));
} finally {
  closeSqliteDatabase(db);
  await lock.release();
}
