import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const BACKOFFICE_LOG_BANNER_FILENAME = 'backoffice-log-banner.webp';
export const BACKOFFICE_LOG_BANNER_ATTACHMENT_URL = `attachment://${BACKOFFICE_LOG_BANNER_FILENAME}`;
export const ADMIN_LOG_BANNER_FILENAME = 'admin-log-banner.webp';
export const ADMIN_LOG_BANNER_ATTACHMENT_URL = `attachment://${ADMIN_LOG_BANNER_FILENAME}`;
export const LOG_SYSTEM_THUMBNAIL_FILENAME = 'log-system-thumbnail.gif';
export const LOG_SYSTEM_THUMBNAIL_ATTACHMENT_URL = `attachment://${LOG_SYSTEM_THUMBNAIL_FILENAME}`;

const bannerPath = fileURLToPath(new URL('../assets/backoffice-log-banner.webp', import.meta.url));
const adminBannerPath = fileURLToPath(new URL('../assets/admin-log-banner.webp', import.meta.url));
const thumbnailPath = fileURLToPath(new URL('../assets/log-system-thumbnail.gif', import.meta.url));
export const BACKOFFICE_LOG_BANNER_SIZE = 852;
export const BACKOFFICE_LOG_BANNER_SHA256 = '3b129f3cfb9d84a79b71cd95d3ffce017a96beed1b7c2ccc60e65f2d844b8e32';
export const ADMIN_LOG_BANNER_SIZE = 2_078;
export const ADMIN_LOG_BANNER_SHA256 = '48663851e31757bff486654f26bafc04440be13af12a6768ce91ff040b5814d9';
export const LOG_SYSTEM_THUMBNAIL_SIZE = 822_513;
export const LOG_SYSTEM_THUMBNAIL_SHA256 = '2d1e0e2c09138ac53384ac6272f4c8a9eedff28e2fe227ee06e26f7ef37a6542';

let cachedBanner = null;
let cachedAdminBanner = null;
let cachedThumbnail = null;

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function webpCanvas(buffer) {
  if (buffer.subarray(0, 4).toString() !== 'RIFF' || buffer.subarray(8, 12).toString() !== 'WEBP'
    || buffer.subarray(12, 16).toString() !== 'VP8X') return null;
  return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
}
function gifDetails(buffer) {
  if (buffer.subarray(0, 6).toString() !== 'GIF89a') return null;
  let frames = 0;
  for (const byte of buffer) if (byte === 0x2c) frames += 1;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), frames };
}

export async function loadBackofficeLogBanner() {
  if (cachedBanner) return cachedBanner;
  const banner = await readFile(bannerPath);
  const canvas = webpCanvas(banner);
  if (banner.length !== BACKOFFICE_LOG_BANNER_SIZE || canvas?.width !== 1_536 || canvas?.height !== 26
    || sha256(banner) !== BACKOFFICE_LOG_BANNER_SHA256) {
    throw new Error('Bundled backoffice Log banner failed integrity verification');
  }
  cachedBanner = banner;
  return cachedBanner;
}

export async function loadAdminLogBanner() {
  if (cachedAdminBanner) return cachedAdminBanner;
  const banner = await readFile(adminBannerPath);
  const canvas = webpCanvas(banner);
  if (banner.length !== ADMIN_LOG_BANNER_SIZE || canvas?.width !== 1_536 || canvas?.height !== 26
    || sha256(banner) !== ADMIN_LOG_BANNER_SHA256) {
    throw new Error('Bundled Admin Log banner failed integrity verification');
  }
  cachedAdminBanner = banner;
  return cachedAdminBanner;
}

export async function loadLogSystemThumbnail() {
  if (cachedThumbnail) return cachedThumbnail;
  const thumbnail = await readFile(thumbnailPath);
  const details = gifDetails(thumbnail);
  if (thumbnail.length !== LOG_SYSTEM_THUMBNAIL_SIZE || details?.width !== 498 || details?.height !== 498
    || details.frames < 2 || sha256(thumbnail) !== LOG_SYSTEM_THUMBNAIL_SHA256) {
    throw new Error('Bundled Log system thumbnail failed integrity verification');
  }
  cachedThumbnail = thumbnail;
  return cachedThumbnail;
}
