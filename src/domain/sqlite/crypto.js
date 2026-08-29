import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { deriveSecretKey } from '../../db/sqlite.js';

const ALGORITHM = 'aes-256-gcm';

export function voucherHmac(secret, code) {
  return createHmac('sha256', deriveSecretKey(secret, 'voucher-hmac')).update(code, 'utf8').digest();
}

export function encryptCredential(secret, plaintext) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, deriveSecretKey(secret, 'credential-encryption'), nonce);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}

export function decryptCredential(secret, row) {
  const decipher = createDecipheriv(ALGORITHM, deriveSecretKey(secret, 'credential-encryption'), row.nonce);
  decipher.setAuthTag(row.auth_tag);
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
}
