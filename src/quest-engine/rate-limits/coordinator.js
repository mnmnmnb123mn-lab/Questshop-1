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
