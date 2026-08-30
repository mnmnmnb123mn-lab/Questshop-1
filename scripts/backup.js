import '../src/config/load-local-environment.js';
import { acquireSingleInstanceLock, closeSqliteDatabase, ensureSqliteDirectory, openSqliteDatabase } from '../src/db/sqlite.js';
import { createRotatedSqliteBackup } from '../src/db/sqlite-backup.js';
import { loadEnvironment } from '../src/config/env.js';

const env = loadEnvironment();
await ensureSqliteDirectory(env.SQLITE_PATH);
const lock = await acquireSingleInstanceLock(env.SQLITE_PATH);
let db;
try {
  db = await openSqliteDatabase({ databasePath: env.SQLITE_PATH, secret: env.QUESTSHOP_SECRET_KEY });
  const destination = await createRotatedSqliteBackup(db, env.SQLITE_PATH, { kind: 'daily', keep: 7 });
  console.log(JSON.stringify({ ok: true, destination }));
} finally { closeSqliteDatabase(db); await lock.release(); }
