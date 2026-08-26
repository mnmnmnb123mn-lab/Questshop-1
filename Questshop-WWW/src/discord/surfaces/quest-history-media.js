import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const QUEST_HISTORY_BANNER_FILENAME = 'quest-history-banner.png';
export const QUEST_HISTORY_BANNER_ATTACHMENT_URL = `attachment://${QUEST_HISTORY_BANNER_FILENAME}`;
const QUEST_HISTORY_BANNER_PATH = fileURLToPath(new URL('../assets/quest-history-banner.png', import.meta.url));
export const QUEST_HISTORY_BANNER_SIZE = 1_059;
const QUEST_HISTORY_BANNER_SHA256 = '42060510a8b296c6cccf8512ec376d18991665c6cdb63e6b912e2f148b08ccdb';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let cachedBanner = null;

export async function loadQuestHistoryBanner() {
  if (cachedBanner) return cachedBanner;
  const banner = await readFile(QUEST_HISTORY_BANNER_PATH);
  const validPng = banner.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  const digest = createHash('sha256').update(banner).digest('hex');
  if (banner.length !== QUEST_HISTORY_BANNER_SIZE || !validPng || digest !== QUEST_HISTORY_BANNER_SHA256) {
    throw new Error('Bundled Quest History banner failed integrity verification');
  }
  cachedBanner = banner;
  return cachedBanner;
}
