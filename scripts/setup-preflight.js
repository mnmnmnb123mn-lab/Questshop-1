import '../src/config/load-local-environment.js';
import { loadEnvironment } from '../src/config/env.js';
import { acquireSingleInstanceLock, closeSqliteDatabase, ensureSqliteDirectory, quickIntegrityCheck, openSqliteDatabase } from '../src/db/sqlite.js';
import { assertRequiredSchema } from '../src/db/sqlite-migrations.js';

const env = loadEnvironment();
await ensureSqliteDirectory(env.SQLITE_PATH);
const lock = await acquireSingleInstanceLock(env.SQLITE_PATH);
let db;
try {
  db = await openSqliteDatabase({ databasePath: env.SQLITE_PATH, secret: env.QUESTSHOP_SECRET_KEY });
  assertRequiredSchema(db);
  const integrity = quickIntegrityCheck(db);
  if (!integrity.ok) throw Object.assign(new Error('SQLite preflight integrity check failed'), { code: 'SQLITE_INTEGRITY_FAILED' });
  console.log(JSON.stringify({ ok: true, sqlitePath: env.SQLITE_PATH, prelaunch: env.PRELAUNCH, gitSha: env.GIT_SHA ?? null }));
} finally {
  closeSqliteDatabase(db);
  await lock.release();
}
