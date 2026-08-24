import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, safeError, serializeError } from '../../src/shared/redaction.js';

test('structured redaction removes secret fields', () => {
  const databaseUrl = ['postgresql', '://', 'sensitive', '@', 'db.invalid', '/test'].join('');
  const output = redact({ token: 'abc', nested: { database_url: databaseUrl } });
  assert.equal(output.token, '[REDACTED]');
  assert.equal(output.nested.database_url, '[REDACTED]');
});

test('error serialization retains safe diagnostics without leaking credentials or cyclic causes', () => {
  const secret = ['mfa', 'this_is_a_fake_discord_token_for_testing_only_123456789'].join('.');
  const fixturePassword = ['fixture', 'pass', 'word'].join('-');
  const databaseUrl = ['postgresql://runtime:', fixturePassword, '@db.invalid/questshop?sslmode=verify-full'].join('');
  const root = Object.assign(new Error(`failed database=${databaseUrl} encryption_key=${fixturePassword}`), {
    code: 'CONNECTION_FAILED', password: fixturePassword, token: secret,
  });
  const child = Object.assign(new Error(`authorization: Bearer ${secret}`), { cause: root });
  root.cause = child;
  const output = serializeError(root);
  const text = JSON.stringify(output);
  assert.equal(output.code, 'CONNECTION_FAILED');
  assert.match(output.stack, /Error/);
  assert.equal(typeof output.cause, 'object');
  assert.equal(output.cause.cause.code, 'CIRCULAR_CAUSE');
  assert.match(text, /REDACTED/);
  assert.doesNotMatch(text, /postgresql:\/\/runtime/);
  assert.doesNotMatch(text, /fixture-pass-word|this_is_a_fake/);
  assert.equal(safeError(root).stack, undefined);
  assert.match(JSON.stringify(redact({ error: root })), /CONNECTION_FAILED/);
});
