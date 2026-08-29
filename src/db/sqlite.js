import { createHash, hkdfSync, timingSafeEqual } from 'node:crypto';
import { mkdir, access, chmod, constants, unlink, open as openFile, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const DATABASE_DIRECTORY_MODE = 0o700;
const DATABASE_FILE_MODE = 0o600;

function scalar(db, sql) {
  return db.prepare(sql).get();
}

export function nowMs() {
  return Date.now();
}

export function deriveSecretKey(secret, context) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0),
    Buffer.from(`questshop:${context}`, 'utf8'), 32));
}

export function keyVerifier(secret) {
  return createHash('sha256').update(deriveSecretKey(secret, 'verifier')).digest('base64url');
}

export function verifyKeyVerifier(secret, expected) {
  const actual = Buffer.from(keyVerifier(secret));
  const configured = Buffer.from(String(expected ?? ''));
  return actual.length === configured.length && timingSafeEqual(actual, configured);
}

export async function ensureSqliteDirectory(databasePath) {
  const directory = path.dirname(databasePath);
  await mkdir(directory, { recursive: true, mode: DATABASE_DIRECTORY_MODE });
  await chmod(directory, DATABASE_DIRECTORY_MODE);
  await access(directory, constants.R_OK | constants.W_OK);
  return directory;
}

export async function openSqliteDatabase({ databasePath, timeoutMs = 5_000, secret }) {
  await ensureSqliteDirectory(databasePath);
  const db = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    timeout: timeoutMs,
  });
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA secure_delete = ON;
      PRAGMA busy_timeout = ${Math.max(0, Math.floor(timeoutMs))};
    `);
    // The database contains encrypted credentials and financial records. It is
    // always Owner-only; changing a too-open mode to 0600 narrows access.
    await chmod(databasePath, DATABASE_FILE_MODE);
    const schemaVersion = Number(scalar(db, 'PRAGMA user_version').user_version);
    const row = schemaVersion > 0
      ? scalar(db, "SELECT value_json FROM settings WHERE key='secret_verifier'")
      : null;
    if (row) {
      const value = JSON.parse(row.value_json);
      if (!verifyKeyVerifier(secret, value.verifier)) {
        const error = new Error('QUESTSHOP_SECRET_KEY does not match this SQLite database');
        error.code = 'SQLITE_SECRET_MISMATCH';
        throw error;
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const RUNTIME_LOCK_STALE_MS = 90_000;

/** A small filesystem lease for the one permitted runtime.  A clean shutdown
 * removes it immediately; a crash can be reclaimed only after its heartbeat is
 * stale, so a second runtime never starts during a normal redeploy. */
export async function acquireSingleInstanceLock(databasePath, { staleAfterMs = RUNTIME_LOCK_STALE_MS, onLost = null } = {}) {
  const lockPath = `${databasePath}.runtime.lock`;
  const owner = randomUUID();
  let handle;
  let timer;
  let released = false;
  const heartbeat = async () => {
    if (released) return;
    const current = await readFile(lockPath, 'utf8').catch(() => null);
    if (!current) {
      released = true;
      clearInterval(timer);
      const error = Object.assign(new Error('SQLite runtime lock disappeared'), { code: 'SQLITE_SINGLE_INSTANCE_LOST' });
      void onLost?.(error);
      return;
    }
    let parsed;
    try { parsed = JSON.parse(current); } catch {
      released = true;
      clearInterval(timer);
      const error = Object.assign(new Error('SQLite runtime lock became invalid'), { code: 'SQLITE_SINGLE_INSTANCE_LOST' });
      void onLost?.(error);
      return;
    }
    if (parsed.owner !== owner) {
      released = true;
      clearInterval(timer);
      const error = Object.assign(new Error('SQLite runtime lock was replaced by another process'), { code: 'SQLITE_SINGLE_INSTANCE_LOST' });
      void onLost?.(error);
      return;
    }
    const next = JSON.stringify({ ...parsed, heartbeatAt: nowMs() });
    // FileHandle.writeFile() writes at the current cursor.  After a truncate
    // that cursor may still be at the old EOF, which would corrupt the JSON
    // lease with leading NUL bytes.  Always write the heartbeat from offset 0
    // and truncate the old tail afterwards.
    const bytes = Buffer.from(next, 'utf8');
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.truncate(bytes.length);
  };
  try {
    handle = await openFile(lockPath, 'wx', DATABASE_FILE_MODE);
    await handle.writeFile(JSON.stringify({ owner, pid: process.pid, createdAt: nowMs(), heartbeatAt: nowMs() }), 'utf8');
    timer = setInterval(() => { void heartbeat(); }, Math.max(5_000, Math.floor(staleAfterMs / 3)));
    timer.unref?.();
    return Object.freeze({ path: lockPath, owner, async release() {
      released = true;
      clearInterval(timer);
      await handle.close();
      const current = await readFile(lockPath, 'utf8').catch(() => null);
      try {
        if (current && JSON.parse(current).owner === owner) await unlink(lockPath);
      } catch { /* A malformed replacement must never be removed by this runtime. */ }
    } });
  } catch (error) {
    if (error.code === 'EEXIST') {
      const details = await Promise.all([readFile(lockPath, 'utf8').catch(() => null), stat(lockPath).catch(() => null)]);
      let heartbeatAt = 0;
      try { heartbeatAt = Number(JSON.parse(details[0] ?? '{}').heartbeatAt) || 0; } catch { /* stale by mtime below */ }
      const observedAt = Math.max(heartbeatAt, Number(details[1]?.mtimeMs) || 0);
      if (observedAt > 0 && nowMs() - observedAt > staleAfterMs) {
        const stalePath = `${lockPath}.stale-${nowMs()}-${owner}`;
        try {
          await rename(lockPath, stalePath);
          return acquireSingleInstanceLock(databasePath, { staleAfterMs });
        } catch (renameError) {
          if (renameError.code !== 'ENOENT') throw renameError;
          return acquireSingleInstanceLock(databasePath, { staleAfterMs });
        }
      }
      const conflict = new Error('Another Questshop runtime already owns this SQLite database');
      conflict.code = 'SQLITE_SINGLE_INSTANCE_LOCKED';
      throw conflict;
    }
    throw error;
  }
}

export function configureSecretVerifier(db, secret, timestamp = nowMs()) {
  const existing = scalar(db, "SELECT value_json FROM settings WHERE key='secret_verifier'");
  if (existing) {
    const parsed = JSON.parse(existing.value_json);
    if (!verifyKeyVerifier(secret, parsed.verifier)) {
      const error = new Error('QUESTSHOP_SECRET_KEY does not match this SQLite database');
      error.code = 'SQLITE_SECRET_MISMATCH';
      throw error;
    }
    return false;
  }
  db.prepare(`INSERT INTO settings(key,value_json,updated_at,updated_by)
    VALUES('secret_verifier',?,?, 'SYSTEM')`).run(JSON.stringify({ verifier: keyVerifier(secret) }), timestamp);
  return true;
}

export function withImmediateTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work(db);
    if (result && typeof result.then === 'function') {
      throw new TypeError('SQLite transaction callbacks must not await external work');
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

export function quickIntegrityCheck(db) {
  const quick = db.prepare('PRAGMA quick_check').all();
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  return { ok: quick.length === 1 && quick[0].quick_check === 'ok' && foreignKeys.length === 0, quick, foreignKeys };
}

export function fullIntegrityCheck(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  return { ok: integrity.length === 1 && integrity[0].integrity_check === 'ok' && foreignKeys.length === 0,
    integrity, foreignKeys };
}

export async function createOnlineBackup(db, destination) {
  await mkdir(path.dirname(destination), { recursive: true, mode: DATABASE_DIRECTORY_MODE });
  await sqliteBackup(db, destination);
  await chmod(destination, DATABASE_FILE_MODE);
  const backupDb = new DatabaseSync(destination, { readOnly: true, enableForeignKeyConstraints: true });
  try {
    const checked = fullIntegrityCheck(backupDb);
    if (!checked.ok) {
      const error = new Error('SQLite backup integrity check failed');
      error.code = 'SQLITE_BACKUP_INVALID';
      error.details = checked;
      throw error;
    }
  } finally {
    backupDb.close();
    // SQLite may create empty shared-memory/WAL companions while opening a
    // checked backup. They are never part of the backup artifact and must not
    // accompany a later restore.
    await Promise.all(['-wal', '-shm'].map((suffix) => unlink(destination + suffix).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    })));
  }
}

export function closeSqliteDatabase(db) {
  if (db?.isOpen) db.close();
}

export const SQLITE_FILE_MODE = DATABASE_FILE_MODE;
