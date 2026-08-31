import { copyFile, readdir, rename, stat, unlink, chmod, mkdir, open as openFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createOnlineBackup, fullIntegrityCheck, SQLITE_FILE_MODE, verifyKeyVerifier } from './sqlite.js';

function labelDate(now = new Date()) { return now.toISOString().replaceAll(':', '-').replaceAll('.', '-'); }

async function backupFiles(directory, prefix) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  return (await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.db'))
    .map(async (entry) => ({ path: path.join(directory, entry.name), mtime: (await stat(path.join(directory, entry.name))).mtimeMs })))).sort((a, b) => b.mtime - a.mtime);
}

async function rotate(directory, prefix, keep) {
  const stale = (await backupFiles(directory, prefix)).slice(keep);
  for (const file of stale) await unlink(file.path);
}

export async function createRotatedSqliteBackup(db, databasePath, { kind = 'daily', keep = 7, now = new Date() } = {}) {
  const directory = path.join(path.dirname(databasePath), 'backups');
  const prefix = `${kind}-`;
  const destination = path.join(directory, `${prefix}${labelDate(now)}.db`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await createOnlineBackup(db, destination);
  // Rotation occurs only after a complete, verified replacement exists.
  await rotate(directory, prefix, keep);
  return destination;
}

/** Restore is deliberately a process-offline operation.  The caller supplies
 * an already verified backup and owns stopping the runtime first. */
function assertBackupReadable(source, secret) {
  const db = new DatabaseSync(source, { readOnly: true, enableForeignKeyConstraints: true });
  try {
    const checked = fullIntegrityCheck(db);
    if (!checked.ok) throw new Error('Restore source failed SQLite integrity verification');
    const verifier = db.prepare("SELECT value_json FROM settings WHERE key='secret_verifier'").get();
    const parsed = verifier ? JSON.parse(verifier.value_json) : null;
    if (!parsed?.verifier || !verifyKeyVerifier(secret, parsed.verifier)) {
      throw Object.assign(new Error('Restore source does not match QUESTSHOP_SECRET_KEY'), { code: 'SQLITE_SECRET_MISMATCH' });
    }
  } finally { db.close(); }
}

export async function replaceDatabaseFromBackup({ source, destination, secret, fileOps = {} }) {
  const fs = {
    copyFile: fileOps.copyFile ?? copyFile,
    rename: fileOps.rename ?? rename,
    chmod: fileOps.chmod ?? chmod,
    openFile: fileOps.openFile ?? openFile,
    unlink: fileOps.unlink ?? unlink,
  };
  assertBackupReadable(source, secret);
  const quarantine = `${destination}.corrupt-${labelDate()}`;
  const temporary = `${destination}.restore-${randomUUID()}`;
  try {
    await fs.copyFile(source, temporary);
    await fs.chmod(temporary, SQLITE_FILE_MODE);
    const temporaryHandle = await fs.openFile(temporary, 'r');
    try { await temporaryHandle.sync(); } finally { await temporaryHandle.close(); }
    assertBackupReadable(temporary, secret);
  } catch (error) {
    // This path has not touched the live destination. Remove only the file
    // named by this invocation, including a partially copied candidate.
    try { await fs.unlink(temporary); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw error; }
    throw error;
  }
  let primaryMoved = false;
  const companionsMoved = [];
  try {
    try { await fs.rename(destination, quarantine); primaryMoved = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const suffix of ['-wal', '-shm']) {
      try {
        await fs.rename(destination + suffix, `${quarantine}${suffix}`);
        companionsMoved.push(suffix);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.rename(temporary, destination);
    assertBackupReadable(destination, secret);
    return { quarantine };
  } catch (error) {
    // If the swap fails after the old database moved, put every old file back
    // before surfacing the failure. A restore must never leave the database
    // path empty merely because one companion-file rename failed.
    try { await fs.unlink(destination); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw error; }
    if (primaryMoved) {
      try { await fs.rename(quarantine, destination); } catch { /* Preserve the original failure; the operator still has quarantine. */ }
    }
    for (const suffix of companionsMoved.reverse()) {
      try { await fs.rename(`${quarantine}${suffix}`, destination + suffix); } catch { /* see primary rollback note */ }
    }
    try { await fs.unlink(temporary); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw error; }
    throw error;
  }
}
