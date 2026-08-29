import '../src/config/load-local-environment.js';
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
  console.log(JSON.stringify({ ok: true, voucherHmacVersions: versions, activeVersion: env.VOUCHER_HMAC_ACTIVE_VERSION }));
} finally {
  closeSqliteDatabase(db);
  await lock.release();
}
