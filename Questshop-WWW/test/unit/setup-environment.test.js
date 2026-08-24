import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  completeSetupValues,
  parseEnvironmentText,
  upsertEnvironmentText,
  writeEnvironmentFile,
} from '../../src/config/setup-environment.js';
import { decodeSecretBundle } from '../../src/config/secret-bundle.js';
import { runtimeEnvironmentValues } from '../../src/config/runtime-environment-values.js';
import { assertDisposableTestDatabase } from '../fixtures/postgres.js';

const certificate = '-----BEGIN CERTIFICATE-----\nTEST-CA\n-----END CERTIFICATE-----\n';

function databaseUrl(role) {
  const url = new URL(['postgresql', ':', '/', '/db.example.invalid'].join(''));
  url.username = role;
  url.hostname = 'db.example.invalid';
  url.pathname = '/questshop_test';
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

const external = Object.freeze({
  NODE_ENV: 'production',
  DISCORD_BOT_TOKEN: 'x'.repeat(25),
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_GUILD_ID: '123456789012345679',
  OWNER_ID: '123456789012345680',
  DATABASE_POOL_URL: databaseUrl('runtime'),
  DATABASE_DIRECT_URL: databaseUrl('migrator'),
  GIT_SHA: 'a'.repeat(40),
  DATABASE_SSL_CA_INPUT: certificate,
});

function deterministicRandom() {
  let value = 0;
  return (size) => Buffer.alloc(size, ++value);
}

test('first-run setup creates the persistent secrets it needs and selects Aiven-managed backups', async () => {
  const result = await completeSetupValues({
    fileValues: external,
    processValues: {},
    randomBytesFunction: deterministicRandom(),
  });
  assert.deepEqual(result.missing, []);
  assert.equal(result.validated.BACKUP_MODE, 'AIVEN_MANAGED');
  assert.equal(result.generated.STATUS_TOKEN.length, 64);
  const data = JSON.parse(result.generated.DATA_ENCRYPTION_KEYS_JSON).keys['1'];
  const voucher = JSON.parse(result.generated.VOUCHER_HMAC_KEYS_JSON).keys['1'];
  assert.equal(new Set([data, voucher]).size, 2);
  assert.equal(result.generated.BACKUP_ENCRYPTION_KEYS_JSON, undefined);
  assert.equal(Buffer.from(result.generated.DATABASE_SSL_CA_BASE64, 'base64').toString(), certificate.trim());
});

test('re-running setup preserves existing secret values without generating replacements', async () => {
  const first = await completeSetupValues({
    fileValues: external,
    processValues: {},
    randomBytesFunction: deterministicRandom(),
  });
  const fileValues = { ...external, ...first.generated };
  const second = await completeSetupValues({
    fileValues,
    processValues: {},
    randomBytesFunction() {
      throw new Error('must not generate replacement secrets');
    },
  });
  assert.equal(second.generated.STATUS_TOKEN, first.generated.STATUS_TOKEN);
  assert.equal(second.generated.DATA_ENCRYPTION_KEYS_JSON, first.generated.DATA_ENCRYPTION_KEYS_JSON);
  assert.equal(second.generated.VOUCHER_HMAC_KEYS_JSON, first.generated.VOUCHER_HMAC_KEYS_JSON);
});

test('setup rejects a process-level key conflict instead of rotating durable secrets', async () => {
  const first = await completeSetupValues({
    fileValues: external,
    processValues: {},
    randomBytesFunction: deterministicRandom(),
  });
  await assert.rejects(() => completeSetupValues({
    fileValues: { ...external, ...first.generated },
    processValues: createOverrideValues(),
  }), /refusing implicit secret rotation/);
});

function createOverrideValues() {
  const key = Buffer.alloc(32, 9).toString('base64');
  const keyring = JSON.stringify({ current: 1, keys: { 1: key } });
  return {
    STATUS_TOKEN: 'f'.repeat(64),
    DATA_ENCRYPTION_KEYS_JSON: keyring,
    VOUCHER_HMAC_KEYS_JSON: keyring,
  };
}

test('environment writer updates keys atomically with owner-only permissions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'questshop-setup-'));
  const target = path.join(directory, '.env');
  try {
    const original = '# external\nDISCORD_CLIENT_ID=old\n';
    const written = await writeEnvironmentFile(pathToFileURL(target), original, {
      DISCORD_CLIENT_ID: '123456789012345678',
      STATUS_TOKEN: 'a'.repeat(64),
      DATA_ENCRYPTION_KEYS_JSON: JSON.stringify({ current: 1, keys: { 1: 'b'.repeat(44) } }),
    });
    assert.equal(written.path, target);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    const parsed = parseEnvironmentText(await readFile(target, 'utf8'));
    assert.equal(parsed.DISCORD_CLIENT_ID, '123456789012345678');
    assert.equal(parsed.STATUS_TOKEN, 'a'.repeat(64));
    assert.deepEqual(JSON.parse(parsed.DATA_ENCRYPTION_KEYS_JSON), {
      current: 1,
      keys: { 1: 'b'.repeat(44) },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('environment text upsert preserves unrelated comments and settings', () => {
  const result = upsertEnvironmentText('# keep\nPORT=4000\n', {
    BACKUP_MODE: 'AIVEN_MANAGED',
  });
  assert.match(result, /^# keep\nPORT=4000/m);
  assert.match(result, /BACKUP_MODE=AIVEN_MANAGED/);
});

test('environment parsing preserves export-prefixed assignments', () => {
  assert.deepEqual(parseEnvironmentText("export STATUS_TOKEN='stable'\n"), { STATUS_TOKEN: 'stable' });
  assert.match(upsertEnvironmentText('export PORT=3000\n', { PORT: '4000' }), /^export PORT=4000$/m);
});

test('stateless secret bundle is decoded without accepting malformed data', () => {
  const bundle = Buffer.from(JSON.stringify({ STATUS_TOKEN: 'x'.repeat(32), PORT: '3000' })).toString('base64url');
  assert.deepEqual(decodeSecretBundle(bundle), { STATUS_TOKEN: 'x'.repeat(32), PORT: '3000' });
  assert.throws(() => decodeSecretBundle('not-base64-json'));
  const invalid = Buffer.from(JSON.stringify({ 'not valid': 'x' })).toString('base64url');
  assert.throws(() => decodeSecretBundle(invalid));
});

test('runtime environment allowlist excludes deployment and unknown values before process mutation', () => {
  const values = runtimeEnvironmentValues({
    STATUS_TOKEN: Buffer.alloc(32, 6).toString('hex'),
    DATABASE_POOL_URL: databaseUrl('runtime'),
    DATABASE_DIRECT_URL: databaseUrl('migrator'),
    DATABASE_RESTORE_URL: databaseUrl('restore'),
    UNRELATED_DEPLOYMENT_SECRET: 'ignored',
  });
  assert.equal(values.STATUS_TOKEN.length, 64);
  assert.equal(values.DATABASE_POOL_URL, databaseUrl('runtime'));
  assert.equal(values.DATABASE_DIRECT_URL, undefined);
  assert.equal(values.DATABASE_RESTORE_URL, undefined);
  assert.equal(values.UNRELATED_DEPLOYMENT_SECRET, undefined);
});

test('destructive PostgreSQL fixtures require explicit disposable-database authorization', () => {
  const previous = process.env.QUESTSHOP_ALLOW_TEST_DATABASE_RESET;
  const disposableUrl = (name) => {
    const url = new URL(['postgresql', ':', '/', '/test-host.invalid'].join(''));
    url.hostname = 'test-host.invalid';
    url.pathname = `/${name}`;
    return url;
  };
  try {
    delete process.env.QUESTSHOP_ALLOW_TEST_DATABASE_RESET;
    assert.throws(() => assertDisposableTestDatabase(disposableUrl('questshop_ci')));
    process.env.QUESTSHOP_ALLOW_TEST_DATABASE_RESET = 'true';
    assert.doesNotThrow(() => assertDisposableTestDatabase(disposableUrl('questshop_ci')));
    assert.throws(() => assertDisposableTestDatabase(disposableUrl('questshop_production')));
  } finally {
    if (previous == null) delete process.env.QUESTSHOP_ALLOW_TEST_DATABASE_RESET;
    else process.env.QUESTSHOP_ALLOW_TEST_DATABASE_RESET = previous;
  }
});
