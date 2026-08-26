import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';

const { Pool } = pg;
// Keep this as a decimal string: node-postgres sends it to PostgreSQL as a
// bigint without relying on JavaScript numeric precision or analyzer-specific
// integer-width assumptions.
const TEST_SCHEMA_LOCK_KEY = '8481701225';

export function assertDisposableTestDatabase(url = process.env.TEST_DATABASE_URL) {
  if (!url) return;
  const database = new URL(url).pathname.slice(1);
  if (process.env.QUESTSHOP_ALLOW_TEST_DATABASE_RESET !== 'true'
    || !/^questshop_(?:ci|test|verify|loadtest)(?:_|$)/.test(database)) {
    throw new Error('Refusing to reset TEST_DATABASE_URL without explicit disposable database authorization');
  }
}

export async function createIsolatedTestPool({ max = 12, applyMigrations = true } = {}) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  assertDisposableTestDatabase(url);
  const pool = new Pool({ connectionString: url, max });
  const lock = await pool.connect();
  let closed = false;
  const releaseLock = async () => {
    if (closed) return;
    closed = true;
    try { await lock.query('SELECT pg_advisory_unlock($1::bigint)', [TEST_SCHEMA_LOCK_KEY]); }
    finally { lock.release(); }
  };
  const originalEnd = pool.end.bind(pool);
  pool.end = async (...argumentsList) => {
    await releaseLock();
    return originalEnd(...argumentsList);
  };
  try {
    await lock.query('SELECT pg_advisory_lock($1::bigint)', [TEST_SCHEMA_LOCK_KEY]);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    if (applyMigrations) {
      const directory = new URL('../../migrations/', import.meta.url);
      for (const name of (await readdir(directory)).filter((item) => item.endsWith('.sql')).sort()) {
        await pool.query(await readFile(new URL(name, directory), 'utf8'));
      }
    }
    return pool;
  } catch (error) {
    await releaseLock();
    await originalEnd();
    throw error;
  }
}

export function createTestPool() {
  return createIsolatedTestPool();
}
