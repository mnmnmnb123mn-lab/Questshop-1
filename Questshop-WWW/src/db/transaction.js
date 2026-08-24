import { setTimeout as delay } from 'node:timers/promises';
import { getRuntimePool } from './pools.js';
import { secureJitter } from '../shared/random.js';

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);
const ISOLATION_LEVELS = new Set(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);

function fullJitter(attempt, capMs = 1000, baseMs = 25) {
  return secureJitter(Math.min(capMs, baseMs * (2 ** attempt)));
}

async function rollbackOrRelease(client, error) {
  try {
    await client.query('ROLLBACK');
    return { destroyed: false, error };
  } catch (rollbackError) {
    // Mark the client as destroyed before invoking release.  node-postgres
    // can throw while destroying a broken socket; the outer finally must never
    // attempt a second release and hide the original transaction failure.
    const result = { destroyed: true, error };
    try {
      client.release(true);
    } catch (releaseError) {
      result.rollbackError = rollbackError;
      result.releaseError = releaseError;
    }
    if (!result.rollbackError) result.rollbackError = rollbackError;
    return result;
  }
}

function retryExhausted(error, attempt, maxAttempts) {
  return !isRetryableTransactionError(error) || attempt + 1 >= maxAttempts;
}

async function executeAttempt(pool, isolation, callback, attempt) {
  const client = await pool.connect();
  let destroyed = false;
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const transactionTime = (await client.query(
      'SELECT transaction_timestamp() AS transaction_time',
    )).rows[0].transaction_time;
    const result = await callback(client, Object.freeze({ attempt, transactionTime }));
    await client.query('COMMIT');
    return { result, retry: false };
  } catch (error) {
    const rollback = await rollbackOrRelease(client, error);
    destroyed = rollback.destroyed;
    if (destroyed || !isRetryableTransactionError(error)) throw rollback.error;
    return { result: null, retry: true, error: rollback.error };
  } finally {
    if (!destroyed) client.release();
  }
}

export function isRetryableTransactionError(error) {
  return RETRYABLE_SQLSTATES.has(error?.code);
}

export async function withTransaction({
  pool = getRuntimePool(),
  isolation = 'READ COMMITTED',
  maxAttempts = 3,
  deadlineMs = 5_000,
} = {}, callback) {
  const normalizedIsolation = String(isolation).toUpperCase();
  if (!ISOLATION_LEVELS.has(normalizedIsolation)) throw new TypeError('invalid isolation level');
  const started = performance.now();
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (performance.now() - started >= deadlineMs) break;
    try {
      const outcome = await executeAttempt(pool, normalizedIsolation, callback, attempt);
      if (!outcome.retry) return outcome.result;
      lastError = outcome.error;
    } catch (error) {
      lastError = error;
      if (retryExhausted(error, attempt, maxAttempts)) throw error;
    }
    if (attempt + 1 >= maxAttempts) break;
    // A transaction retry owns this wait.  An unref'ed timer can leave an
    // awaited retry pending while Node exits when this is the final handle.
    await delay(fullJitter(attempt));
  }
  throw lastError ?? new Error('transaction deadline exceeded');
}
