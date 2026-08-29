import '../src/config/load-local-environment.js';
import { closeSqliteDatabase, fullIntegrityCheck, openSqliteDatabase } from '../src/db/sqlite.js';
import { replaceDatabaseFromBackup } from '../src/db/sqlite-backup.js';
import { loadEnvironment } from '../src/config/env.js';

const env = loadEnvironment();
const source = process.env.SQLITE_RESTORE_SOURCE;
if (process.env.QUESTSHOP_RESTORE_ACKNOWLEDGE !== 'true' || !source) {
  throw new Error('Restore requires QUESTSHOP_RESTORE_ACKNOWLEDGE=true and SQLITE_RESTORE_SOURCE');
}
// This script must run while the bot is stopped; the runtime single-instance
// lock prevents it from being used as an in-process recovery shortcut.
const restored = await replaceDatabaseFromBackup({ source, destination: env.SQLITE_PATH, secret: env.QUESTSHOP_SECRET_KEY });
const db = await openSqliteDatabase({ databasePath: env.SQLITE_PATH, secret: env.QUESTSHOP_SECRET_KEY });
try {
  const checked = fullIntegrityCheck(db);
  if (!checked.ok) throw new Error('Restored SQLite database failed integrity verification');
  console.log(JSON.stringify({ ok: true, quarantine: restored.quarantine }));
} finally { closeSqliteDatabase(db); }
