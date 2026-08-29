import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { deriveSecretKey } from '../../db/sqlite.js';

const ALGORITHM = 'aes-256-gcm';
export const CURRENT_VOUCHER_HMAC_VERSION = 'v1';

function assertVoucherHmacVersion(version) {
  if (!/^v[0-9]+$/.test(version)) throw new TypeError('Invalid voucher HMAC version');
}

/**
 * Voucher proof keys are deliberately derived by version from the persistent
 * application secret.  The version is stored with each row, which makes a
 * future proof-key rotation explicit while keeping old rows verifiable.
 */
export function voucherHmacKeyring(secret, versions = [CURRENT_VOUCHER_HMAC_VERSION]) {
  if (typeof secret !== 'string' || secret.length < 32) throw new TypeError('Invalid voucher HMAC root secret');
  return Object.freeze(Object.fromEntries([...new Set(versions)].map((version) => {
    assertVoucherHmacVersion(version);
    return [version, deriveSecretKey(secret, `voucher-hmac:${version}`)];
  })));
}

export function voucherHmac(secret, code, version = CURRENT_VOUCHER_HMAC_VERSION) {
  assertVoucherHmacVersion(version);
  return createHmac('sha256', voucherHmacKeyring(secret, [version])[version]).update(code, 'utf8').digest();
}

/** Stable identity is intentionally not versioned: the unique index prevents
 * the same raw voucher from being submitted again after a proof-key rotation. */
export function voucherIdentityHmac(secret, code) {
  return createHmac('sha256', deriveSecretKey(secret, 'voucher-identity')).update(code, 'utf8').digest();
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
