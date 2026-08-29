import '../src/config/load-local-environment.js';
import path from 'node:path';
import { access, constants, stat } from 'node:fs/promises';
import { loadEnvironment } from '../src/config/env.js';
import { acquireSingleInstanceLock, ensureSqliteDirectory, fullIntegrityCheck, openSqliteDatabase, closeSqliteDatabase } from '../src/db/sqlite.js';
import { migrateSqlite } from '../src/db/sqlite-migrations.js';
import { createRotatedSqliteBackup } from '../src/db/sqlite-backup.js';

const env = loadEnvironment();
const migrationDirectory = path.resolve('migrations/sqlite');
await ensureSqliteDirectory(env.SQLITE_PATH);
const migrationLock = await acquireSingleInstanceLock(env.SQLITE_PATH);

async function hasExistingDatabase() {
  try {
    return (await stat(env.SQLITE_PATH)).size > 0;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

let databaseExisted = false;
let db;

async function preMigrationBackup(label) {
  if (!databaseExisted) return null;
  const destination = await createRotatedSqliteBackup(db, env.SQLITE_PATH, { kind: label, keep: 3 });
  await access(destination, constants.R_OK);
  return destination;
}

try {
  databaseExisted = await hasExistingDatabase();
  db = await openSqliteDatabase({ databasePath: env.SQLITE_PATH, secret: env.QUESTSHOP_SECRET_KEY });
  const before = fullIntegrityCheck(db);
  // A newly-created SQLite file has no schema yet. It becomes verifiable after
  // the initial atomic migration.
  if (Number(db.prepare('PRAGMA user_version').get().user_version) > 0 && !before.ok) {
    throw Object.assign(new Error('SQLite database integrity check failed before migration'), {
      code: 'SQLITE_INTEGRITY_FAILED', details: before,
    });
  }
  const result = await migrateSqlite({ db, directory: migrationDirectory,
    secret: env.QUESTSHOP_SECRET_KEY, backup: preMigrationBackup });
  console.log(JSON.stringify({ ok: true, ...result, sqlitePath: env.SQLITE_PATH }));
} finally {
  closeSqliteDatabase(db);
  await migrationLock.release();
}
