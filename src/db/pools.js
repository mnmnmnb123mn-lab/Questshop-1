import pg from 'pg';
import { loadEnvironment, loadRuntimeEnvironment } from '../config/env.js';
import { createLogger } from '../shared/logger.js';

const { Pool } = pg;
let runtimePool;
let directPool;
const poolErrorObservers = new WeakMap();
const poolLogger = createLogger({ component: 'postgres-pool' });

const PG_SSL_URL_PARAMETERS = Object.freeze([
  'ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat',
]);

// node-postgres parses connectionString after the explicit `ssl` option.  SSL
// parameters in a libpq URL can therefore replace the verified CA object with
// an empty object.  Keep the original URL for policy validation, but pass pg a
// copy without the parameters that control SSL.
export function sanitizePostgresConnectionString(connectionString) {
  const url = new URL(connectionString);
  for (const parameter of PG_SSL_URL_PARAMETERS) url.searchParams.delete(parameter);
  return url.toString();
}

export function postgresSslOptions(env, connectionString) {
  const databaseUrl = new URL(connectionString);
  const sslDisabledForTest = env.NODE_ENV === 'test' && databaseUrl.searchParams.get('sslmode') === 'disable';
  return sslDisabledForTest ? false : {
    ...(env.DATABASE_SSL_CA_BASE64
      ? { ca: Buffer.from(env.DATABASE_SSL_CA_BASE64, 'base64').toString('utf8') }
      : {}),
    rejectUnauthorized: true,
  };
}

export function postgresPoolOptions(env, connectionString) {
  const ssl = postgresSslOptions(env, connectionString);
  return {
    connectionString: sanitizePostgresConnectionString(connectionString),
    ssl,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
    options: '-c timezone=UTC -c statement_timeout=15000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=15000',
  };
}

function guardPoolErrors(pool, role) {
  const state = { observers: new Set(), role };
  poolErrorObservers.set(pool, state);
  // node-postgres emits this for an idle client. Without a listener Node can
  // terminate the process before Health has a chance to mark the DB degraded.
  pool.on('error', (error) => {
    poolLogger.error({ error, databaseRole: state.role }, 'postgres pool client error');
    for (const observer of state.observers) {
      try { observer(error); } catch (observerError) {
        poolLogger.error({ error: observerError, databaseRole: state.role }, 'postgres pool error observer failed');
      }
    }
  });
  return pool;
}

export function observePoolErrors(pool, observer) {
  const state = poolErrorObservers.get(pool);
  if (!state) throw new TypeError('pool is not managed by Questshop');
  state.observers.add(observer);
  return () => state.observers.delete(observer);
}

export function getRuntimePool(env = loadRuntimeEnvironment()) {
  runtimePool ??= guardPoolErrors(new Pool({
    ...postgresPoolOptions(env, env.DATABASE_POOL_URL),
    max: 8,
    application_name: 'questshop-runtime',
  }), 'runtime');
  return runtimePool;
}

export function getDirectPool(env = loadEnvironment()) {
  directPool ??= guardPoolErrors(new Pool({
    ...postgresPoolOptions(env, env.DATABASE_DIRECT_URL),
    max: 1,
    application_name: 'questshop-migrator',
  }), 'migrator');
  return directPool;
}

export async function closeDirectPool() {
  if (!directPool) return;
  const pool = directPool;
  directPool = undefined;
  await pool.end();
}

export async function closePools() {
  const pools = [runtimePool, directPool].filter(Boolean);
  runtimePool = undefined;
  directPool = undefined;
  await Promise.allSettled(pools.map((pool) => pool.end()));
}
