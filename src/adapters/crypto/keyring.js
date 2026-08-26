import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { QuestshopError } from '../../shared/errors.js';

function keyFor(keyring, version) {
  const encoded = keyring.keys[String(version)];
  if (!encoded) {
    throw new QuestshopError('KEY_VERSION_MISSING', `Key version ${version} is unavailable`, {
      category: 'SECRET',
    });
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new TypeError(`Key version ${version} is not 32 bytes`);
  return key;
}

export function encryptSecret(plaintext, keyring, aad) {
  const version = keyring.current;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(keyring, version), nonce);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(String(plaintext), 'utf8')),
    cipher.final(),
  ]);
  return {
    keyVersion: version,
    nonce,
    ciphertext,
    authTag: cipher.getAuthTag(),
  };
}

export function decryptSecret(payload, keyring, aad) {
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyFor(keyring, payload.keyVersion),
      Buffer.from(payload.nonce),
    );
    decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(Buffer.from(payload.authTag));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext)),
      decipher.final(),
    ]).toString('utf8');
  } catch (cause) {
    throw new QuestshopError('SECRET_DECRYPT_FAILED', 'Encrypted secret could not be decrypted', {
      category: 'SECRET',
      cause,
    });
  }
}

export function hmacVoucher(code, keyring, version = keyring.current) {
  return {
    version: Number(version),
    digest: createHmac('sha256', keyFor(keyring, version))
      .update(String(code), 'utf8')
      .digest(),
  };
}

export function allVoucherHmacs(code, keyring) {
  return Object.keys(keyring.keys)
    .map(Number)
    .sort((a, b) => b - a)
    .map((version) => hmacVoucher(code, keyring, version));
}

