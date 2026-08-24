import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

function fingerprint(token) {
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
}

function normalizedRoute(path) {
  return String(path).replace(/\/quests\/[^/]+/, '/quests/:questId');
}

function deleteExpired(map, now) {
  for (const [key, until] of map) {
    if (until <= now) map.delete(key);
  }
}

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async acquire(signal) {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const abort = () => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      waiter.resolve = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      this.waiters.push(waiter);
    });
    this.active += 1;
  }

  release() {
    this.active -= 1;
    this.waiters.shift()?.resolve();
  }
}

export class DiscordRateLimitCoordinator {
  constructor({ concurrency = 5, maxQueued = 1000 } = {}) {
    this.semaphore = new Semaphore(concurrency);
    this.maxQueued = maxQueued;
    this.accountTails = new Map();
    this.queued = 0;
    this.globalBlockedUntil = 0;
    this.routeBlockedUntil = new Map();
    this.accountBlockedUntil = new Map();
  }

  async schedule({ token, path = '', signal, execute }) {
    if (this.queued >= this.maxQueued) throw new Error('Discord request queue is full');
    this.pruneExpired();
    const account = fingerprint(token);
    const previous = this.accountTails.get(account) ?? Promise.resolve();
    let releaseTail;
    const tail = new Promise((resolve) => { releaseTail = resolve; });
    this.accountTails.set(account, tail);
    this.queued += 1;
    try {
      await previous.catch(() => undefined);
      const route = normalizedRoute(path);
      const wait = Math.max(this.globalBlockedUntil, this.routeBlockedUntil.get(route) ?? 0,
        this.accountBlockedUntil.get(account) ?? 0) - Date.now();
      // A caller awaiting the rate-limit promise must keep Node alive until it
      // settles. Shutdown aborts this timer through its shared signal.
      if (wait > 0) await delay(wait, undefined, { signal });
      await this.semaphore.acquire(signal);
      try {
        return await execute();
      } finally {
        this.semaphore.release();
      }
    } finally {
      this.queued -= 1;
      releaseTail();
      if (this.accountTails.get(account) === tail) this.accountTails.delete(account);
    }
  }

  async blockGlobally(milliseconds) {
    this.pruneExpired();
    this.globalBlockedUntil = Math.max(this.globalBlockedUntil, Date.now() + milliseconds);
  }

  async blockRoute(path, milliseconds) {
    this.pruneExpired();
    const route = normalizedRoute(path);
    this.routeBlockedUntil.set(route, Math.max(this.routeBlockedUntil.get(route) ?? 0, Date.now() + milliseconds));
  }

  async blockAccount(token, milliseconds) {
    this.pruneExpired();
    const account = fingerprint(token);
    this.accountBlockedUntil.set(account, Math.max(this.accountBlockedUntil.get(account) ?? 0, Date.now() + milliseconds));
  }

  status() {
    this.pruneExpired();
    return { queued: this.queued, accounts: this.accountTails.size, globalBlockedUntil: this.globalBlockedUntil,
      routeBlocks: this.routeBlockedUntil.size, accountBlocks: this.accountBlockedUntil.size };
  }

  pruneExpired(now = Date.now()) {
    if (this.globalBlockedUntil <= now) this.globalBlockedUntil = 0;
    deleteExpired(this.routeBlockedUntil, now);
    deleteExpired(this.accountBlockedUntil, now);
  }
}

export const discordRateLimitCoordinator = new DiscordRateLimitCoordinator();

// The process-local coordinator protects a single runtime immediately. This
// adapter adds a PostgreSQL cooldown ledger so a 429 survives restart and is
// respected by every worker process without storing any raw credential.
export class PersistentDiscordRateLimitCoordinator extends DiscordRateLimitCoordinator {
  constructor({ pool, ...options }) {
    super(options);
    if (!pool) throw new TypeError('Persistent rate-limit coordinator requires a PostgreSQL pool');
    this.pool = pool;
  }

  async waitForPersistentBlocks({ token, path, signal }) {
    const account = fingerprint(token);
    const route = normalizedRoute(path);
    const row = (await this.pool.query(`SELECT EXTRACT(epoch FROM GREATEST(
      COALESCE(max(blocked_until) FILTER (WHERE scope='GLOBAL'), clock_timestamp()),
      COALESCE(max(blocked_until) FILTER (WHERE scope='ROUTE' AND block_key=$1), clock_timestamp()),
      COALESCE(max(blocked_until) FILTER (WHERE scope='ACCOUNT' AND block_key=$2), clock_timestamp())
    )-clock_timestamp())*1000 AS wait_ms FROM quest_api_rate_limit_blocks
      WHERE blocked_until>clock_timestamp()`, [route, account])).rows[0];
    const waitMs = Math.max(0, Math.ceil(Number(row?.wait_ms ?? 0)));
    if (waitMs > 0) await delay(waitMs, undefined, { signal });
  }

  async schedule(input) {
    await this.waitForPersistentBlocks(input);
    return super.schedule(input);
  }

  async persist(scope, key, milliseconds) {
    await this.pool.query(`INSERT INTO quest_api_rate_limit_blocks(scope,block_key,blocked_until)
      VALUES($1,$2,clock_timestamp()+make_interval(secs=>$3::double precision/1000))
      ON CONFLICT(scope,block_key) DO UPDATE SET blocked_until=GREATEST(
        quest_api_rate_limit_blocks.blocked_until,EXCLUDED.blocked_until),
        state_version=quest_api_rate_limit_blocks.state_version+1,updated_at=clock_timestamp()`,
    [scope, key, Math.max(0, Number(milliseconds) || 0)]);
  }

  async blockGlobally(milliseconds) {
    await super.blockGlobally(milliseconds);
    await this.persist('GLOBAL', '*', milliseconds);
  }

  async blockRoute(path, milliseconds) {
    await super.blockRoute(path, milliseconds);
    await this.persist('ROUTE', normalizedRoute(path), milliseconds);
  }

  async blockAccount(token, milliseconds) {
    await super.blockAccount(token, milliseconds);
    await this.persist('ACCOUNT', fingerprint(token), milliseconds);
  }
}

const persistentCoordinators = new WeakMap();

// Every Quest API caller in one runtime must share the same coordinator.  A
// WeakMap keeps that singleton tied to the lifetime of the PostgreSQL pool and
// avoids retaining a pool during tests or graceful shutdown.
export function getPersistentDiscordRateLimitCoordinator(pool, options = {}) {
  if (!pool) return discordRateLimitCoordinator;
  let coordinator = persistentCoordinators.get(pool);
  if (!coordinator) {
    coordinator = new PersistentDiscordRateLimitCoordinator({ pool, ...options });
    persistentCoordinators.set(pool, coordinator);
  }
  return coordinator;
}

export async function prunePersistentRateLimitBlocks({ pool, limit = 500, retentionSeconds = 3600 }) {
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 500));
  const boundedRetention = Math.max(0, Number(retentionSeconds) || 0);
  const result = await pool.query(`WITH expired AS (
      SELECT ctid FROM quest_api_rate_limit_blocks
      WHERE blocked_until < clock_timestamp()-make_interval(secs=>$1::double precision)
      ORDER BY blocked_until FOR UPDATE SKIP LOCKED LIMIT $2
    ) DELETE FROM quest_api_rate_limit_blocks blocks
    USING expired WHERE blocks.ctid=expired.ctid RETURNING 1`, [boundedRetention, boundedLimit]);
  return result.rowCount;
}
