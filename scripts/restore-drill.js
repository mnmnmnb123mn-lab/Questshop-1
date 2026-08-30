import '../src/config/load-local-environment.js';
import { acquireSingleInstanceLock, closeSqliteDatabase, fullIntegrityCheck, openSqliteDatabase } from '../src/db/sqlite.js';
import { replaceDatabaseFromBackup } from '../src/db/sqlite-backup.js';
import { loadEnvironment } from '../src/config/env.js';

const env = loadEnvironment();
const source = process.env.SQLITE_RESTORE_SOURCE;
if (process.env.QUESTSHOP_RESTORE_ACKNOWLEDGE !== 'true' || !source) {
  throw new Error('Restore requires QUESTSHOP_RESTORE_ACKNOWLEDGE=true and SQLITE_RESTORE_SOURCE');
}
// Acquiring the same lock as the runtime turns the offline-only requirement
// into an enforced precondition: a live bot causes restore to fail before any
// file is renamed.
const restoreLock = await acquireSingleInstanceLock(env.SQLITE_PATH);
let db;
try {
  const restored = await replaceDatabaseFromBackup({ source, destination: env.SQLITE_PATH, secret: env.QUESTSHOP_SECRET_KEY });
  db = await openSqliteDatabase({ databasePath: env.SQLITE_PATH, secret: env.QUESTSHOP_SECRET_KEY });
  const checked = fullIntegrityCheck(db);
  if (!checked.ok) throw new Error('Restored SQLite database failed integrity verification');
  console.log(JSON.stringify({ ok: true, quarantine: restored.quarantine }));
} finally { closeSqliteDatabase(db); await restoreLock.release(); }
