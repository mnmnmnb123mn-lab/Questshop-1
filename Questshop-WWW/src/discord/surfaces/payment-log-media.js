import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const PAYMENT_LOG_BANNER_FILENAME = 'payment-log-banner.webp';
export const PAYMENT_LOG_BANNER_ATTACHMENT_URL = `attachment://${PAYMENT_LOG_BANNER_FILENAME}`;
const PAYMENT_LOG_BANNER_PATH = fileURLToPath(new URL('../assets/payment-log-banner.webp', import.meta.url));
export const PAYMENT_LOG_BANNER_SIZE = 2_078;
const PAYMENT_LOG_BANNER_SHA256 = '48663851e31757bff486654f26bafc04440be13af12a6768ce91ff040b5814d9';
const WEBP_RIFF_SIGNATURE = Buffer.from('RIFF');
const WEBP_FORMAT_SIGNATURE = Buffer.from('WEBP');

let cachedBanner = null;

export async function loadPaymentLogBanner() {
  if (cachedBanner) return cachedBanner;
  const banner = await readFile(PAYMENT_LOG_BANNER_PATH);
  const validWebp = banner.subarray(0, WEBP_RIFF_SIGNATURE.length).equals(WEBP_RIFF_SIGNATURE)
    && banner.subarray(8, 8 + WEBP_FORMAT_SIGNATURE.length).equals(WEBP_FORMAT_SIGNATURE);
  const digest = createHash('sha256').update(banner).digest('hex');
  if (banner.length !== PAYMENT_LOG_BANNER_SIZE || !validWebp || digest !== PAYMENT_LOG_BANNER_SHA256) {
    throw new Error('Bundled Payment Log banner failed integrity verification');
  }
  cachedBanner = banner;
  return cachedBanner;
}
