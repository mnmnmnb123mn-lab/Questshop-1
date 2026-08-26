import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const PAYMENT_LOG_BANNER_FILENAME = 'payment-log-banner.png';
export const PAYMENT_LOG_BANNER_ATTACHMENT_URL = `attachment://${PAYMENT_LOG_BANNER_FILENAME}`;
const PAYMENT_LOG_BANNER_PATH = fileURLToPath(new URL('../assets/payment-log-banner.png', import.meta.url));
export const PAYMENT_LOG_BANNER_SIZE = 1_059;
const PAYMENT_LOG_BANNER_SHA256 = '42060510a8b296c6cccf8512ec376d18991665c6cdb63e6b912e2f148b08ccdb';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PAYMENT_LOG_BANNER_WIDTH = 461;
const PAYMENT_LOG_BANNER_HEIGHT = 8;

let cachedBanner = null;

export async function loadPaymentLogBanner() {
  if (cachedBanner) return cachedBanner;
  const banner = await readFile(PAYMENT_LOG_BANNER_PATH);
  const validPng = banner.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    && banner.readUInt32BE(16) === PAYMENT_LOG_BANNER_WIDTH
    && banner.readUInt32BE(20) === PAYMENT_LOG_BANNER_HEIGHT
    && banner[24] === 8
    && banner[25] === 2;
  const digest = createHash('sha256').update(banner).digest('hex');
  if (banner.length !== PAYMENT_LOG_BANNER_SIZE || !validPng || digest !== PAYMENT_LOG_BANNER_SHA256) {
    throw new Error('Bundled Payment Log banner failed integrity verification');
  }
  cachedBanner = banner;
  return cachedBanner;
}
