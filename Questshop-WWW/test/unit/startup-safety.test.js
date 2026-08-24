import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import { connectDiscord, openRuntimeDatabase, renewRuntimeLease, waitForDiscordReady } from '../../src/bootstrap/startup.js';
import { FencingLostError } from '../../src/shared/errors.js';

test('runtime startup rejects changed key material before role validation or ingress', async () => {
  const calls = [];
  const health = { checks: {} };
  const mismatch = Object.assign(new Error('different bytes under key version one'), { code: 'KEY_SENTINEL_MISMATCH' });
  await assert.rejects(() => openRuntimeDatabase({ NODE_ENV: 'production' }, health, {
    getRuntimePool: () => ({ query: async () => ({ rows: [] }) }),
    validateSchemaCompatibility: async () => calls.push('schema'),
    validateMigrationChecksums: async () => calls.push('checksums'),
    validateKeyringCoverage: async () => calls.push('coverage'),
    validateKeyringSentinels: async () => { calls.push('sentinel'); throw mismatch; },
    validateRuntimeRole: async () => { calls.push('role'); return { violations: [] }; },
  }), (error) => error.code === 'KEY_SENTINEL_MISMATCH');
  assert.deepEqual(calls, ['schema', 'checksums', 'coverage', 'sentinel']);
  assert.equal(health.checks.keyrings, undefined);
});

test('runtime database pool errors degrade readiness instead of becoming an unhandled event', async () => {
  let observer;
  const health = { checks: {}, ready: true, status: 'HEALTHY' };
  const pool = { query: async () => ({ rows: [] }) };
  await openRuntimeDatabase({ NODE_ENV: 'test' }, health, {
    getRuntimePool: () => pool,
    observePoolErrors: (_pool, callback) => { observer = callback; return () => {}; },
    validateSchemaCompatibility: async () => {},
    validateMigrationChecksums: async () => {},
    validateKeyringCoverage: async () => {},
    validateKeyringSentinels: async () => {},
    validateRuntimeRole: async () => ({ violations: [] }),
  });
  const outage = new Error('idle client lost');
  observer(outage);
  assert.equal(health.checks.database, 'DEGRADED');
  assert.equal(health.status, 'DEGRADED');
  assert.equal(health.lastError, outage);
});

test('Discord readiness uses clientReady and does not wait when already ready', async () => {
  const client = new EventEmitter();
  client.isReady = () => false;
  const waiting = waitForDiscordReady(client);
  client.emit(Events.ClientReady, client);
  await waiting;
  assert.equal(client.listenerCount(Events.ClientReady), 0);
  client.isReady = () => true;
  await waitForDiscordReady(client);
  assert.equal(client.listenerCount(Events.ClientReady), 0);
});

test('Discord login failure destroys its client and stops before Guild/Admin validation', async () => {
  const calls = [];
  const client = new EventEmitter();
  client.login = async () => { calls.push('login'); throw new Error('fixture login failure'); };
  client.destroy = () => { calls.push('destroy'); };
  client.guilds = { fetch: async () => { calls.push('guild'); } };
  await assert.rejects(() => connectDiscord({ DISCORD_BOT_TOKEN: 'fixture-token', DISCORD_GUILD_ID: 'guild' },
    { error: () => null }, { checks: {} }, {}, { createDiscordClient: () => client }), /fixture login failure/);
  assert.deepEqual(calls, ['login', 'destroy']);
});

test('runtime lease retries a transient database failure but self-fences immediately when ownership is lost', async () => {
  const abortController = new AbortController();
  let attempts = 0;
  const lease = await renewRuntimeLease({ abortController, env: { DISCORD_GUILD_ID: 'guild' }, holder: 'holder',
    pool: {}, lease: { fencing_token: 7 }, wait: async () => {}, renew: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient database outage');
      return { fencing_token: 7 };
    } });
  assert.equal(attempts, 3);
  assert.equal(lease.fencing_token, 7);
  await assert.rejects(() => renewRuntimeLease({ abortController, env: { DISCORD_GUILD_ID: 'guild' }, holder: 'holder',
    pool: {}, lease: { fencing_token: 7 }, wait: async () => { throw new Error('wait must not run'); },
    renew: async () => { throw new FencingLostError('runtime'); } }), /lost ownership/);
});
