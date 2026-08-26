import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../../src/shared/logger.js';

function captureDestination() {
  const chunks = [];
  return {
    chunks,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  };
}

test('logger redacts every secret class from bindings, fields and message text', () => {
  const token = ['mfa', 'this_is_a_fake_discord_token_for_logger_123456789'].join('.');
  const password = ['logger', 'fixture', 'password'].join('-');
  const authorization = ['Bearer', 'logger-authorization-secret'].join(' ');
  const apiKey = ['api', 'key', 'fixture'].join('-');
  const encryptionKey = ['encryption', 'key', 'fixture'].join('-');
  const hmacKey = ['hmac', 'key', 'fixture'].join('-');
  const databaseUrl = ['postgresql://runtime:', password, '@db.invalid/questshop'].join('');
  const destination = captureDestination();
  const logger = createLogger({ hmac_key: hmacKey }, destination);
  logger.error({ password }, [
    `token=${token}`,
    `database=${databaseUrl}`,
    `password=${password}`,
    `authorization=${authorization}`,
    `api_key=${apiKey}`,
    `encryption key=${encryptionKey}`,
    `hmac_key=${hmacKey}`,
  ].join(' '));

  const output = destination.chunks.join('');
  assert.match(output, /REDACTED/);
  for (const value of [token, databaseUrl, password, authorization, apiKey, encryptionKey, hmacKey]) {
    assert.equal(output.includes(value), false, `log output must not include ${value}`);
  }
});
