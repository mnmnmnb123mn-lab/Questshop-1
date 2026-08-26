import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { postgresPoolOptions, sanitizePostgresConnectionString } from '../../src/db/pools.js';

const VERIFIED_URL = 'postgresql://runtime:secret@db.example.invalid:5432/questshop?application_name=keep&sslmode=verify-full&sslrootcert=ignored';
const CA = '-----BEGIN CERTIFICATE-----\nfixture-ca\n-----END CERTIFICATE-----';

test('pool URL sanitization preserves verified CA while retaining non-SSL options', () => {
  const env = { NODE_ENV: 'production', DATABASE_SSL_CA_BASE64: Buffer.from(CA).toString('base64') };
  const options = postgresPoolOptions(env, VERIFIED_URL);
  const parsed = new pg.Client(options).connectionParameters;
  assert.equal(new URL(options.connectionString).searchParams.get('application_name'), 'keep');
  assert.equal(new URL(options.connectionString).searchParams.has('sslmode'), false);
  assert.equal(parsed.ssl.ca, CA);
  assert.equal(parsed.ssl.rejectUnauthorized, true);
});

test('a raw libpq sslmode URL replaces explicit pg SSL options before sanitization', () => {
  const rawUrl = VERIFIED_URL.replace('&sslrootcert=ignored', '');
  const raw = new pg.Client({ connectionString: rawUrl, ssl: { ca: CA, rejectUnauthorized: true } }).connectionParameters;
  assert.deepEqual(raw.ssl, {});
  const fixed = new pg.Client(postgresPoolOptions({ NODE_ENV: 'production', DATABASE_SSL_CA_BASE64: Buffer.from(CA).toString('base64') }, rawUrl)).connectionParameters;
  assert.equal(fixed.ssl.ca, CA);
  assert.equal(fixed.ssl.rejectUnauthorized, true);
});

test('sanitized URL removes every pg SSL override without changing endpoint identity', () => {
  const original = `${VERIFIED_URL}&ssl=1&sslcert=cert&sslkey=key&uselibpqcompat=true`;
  const clean = new URL(sanitizePostgresConnectionString(original));
  assert.equal(clean.username, 'runtime');
  assert.equal(clean.hostname, 'db.example.invalid');
  assert.equal(clean.port, '5432');
  assert.equal(clean.pathname, '/questshop');
  for (const name of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) {
    assert.equal(clean.searchParams.has(name), false);
  }
});

test('disposable test URL can explicitly disable TLS', () => {
  const options = postgresPoolOptions({ NODE_ENV: 'test' }, 'postgresql://test:secret@db.invalid/questshop_test?sslmode=disable');
  assert.equal(options.ssl, false);
});
