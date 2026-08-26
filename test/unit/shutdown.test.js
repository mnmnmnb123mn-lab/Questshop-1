import test from 'node:test';
import assert from 'node:assert/strict';
import { shutdown } from '../../src/bootstrap/shutdown.js';

test('runtime lease loss disables ingress and destroys Discord without releasing the lost lease', async () => {
  let destroyed = 0;
  let stopped = 0;
  let released = 0;
  const runtime = {
    acceptingInteractions: true,
    health: { ready: true, status: 'HEALTHY', live: true },
    abortController: new AbortController(),
    client: { destroy: () => { destroyed += 1; } },
    workers: { stop: async () => { stopped += 1; } },
    heartbeat: Promise.resolve(),
    pool: { query: async () => ({ rows: [{ count: 0 }] }) },
    env: { DISCORD_GUILD_ID: 'guild' },
    runtimeHolder: 'holder',
    runtimeLease: { fencing_token: 4 },
    server: null,
  };
  // The shutdown implementation intentionally does not invoke releaseLease on
  // a lost runtime lease; this sentinel documents the safety boundary.
  runtime.releaseLease = () => { released += 1; };
  await Promise.all([
    shutdown(runtime, 'RUNTIME_LEASE_LOST', { leaseLost: true, error: new Error('fenced') }),
    shutdown(runtime, 'RUNTIME_LEASE_LOST', { leaseLost: true }),
  ]);
  assert.equal(runtime.acceptingInteractions, false);
  assert.equal(runtime.health.ready, false);
  assert.equal(runtime.health.status, 'INCIDENT');
  assert.equal(destroyed, 1);
  assert.equal(stopped, 1);
  assert.equal(released, 0);
});

test('Discord cleanup failure does not skip worker, database, or health cleanup', async () => {
  let stopped = 0;
  const runtime = {
    acceptingInteractions: true,
    health: { ready: true, status: 'HEALTHY', live: true },
    abortController: new AbortController(),
    client: { destroy: () => { throw new Error('discord destroy failed'); } },
    workers: { stop: async () => { stopped += 1; } },
    heartbeat: null,
    pool: { query: async () => ({ rows: [{ count: 0 }] }) },
    env: { DISCORD_GUILD_ID: 'guild' },
    runtimeHolder: 'holder',
    runtimeLease: { fencing_token: 4 },
    server: null,
  };
  await assert.rejects(() => shutdown(runtime, 'SIGTERM'), /discord destroy failed/);
  assert.equal(stopped, 1);
  assert.equal(runtime.health.live, false);
});
