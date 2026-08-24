import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const QUEST_AUTO_MEDIA_FILENAME = 'quest-auto-demo.gif';
export const QUEST_AUTO_MEDIA_ATTACHMENT_URL = `attachment://${QUEST_AUTO_MEDIA_FILENAME}`;
const QUEST_AUTO_MEDIA_PATH = fileURLToPath(new URL('../assets/quest-auto-demo.gif', import.meta.url));
export const QUEST_AUTO_MEDIA_SIZE = 9_190_692;
const QUEST_AUTO_MEDIA_SHA256 = 'c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1';

let cachedMedia = null;

export async function loadQuestAutoMedia() {
  if (cachedMedia) return cachedMedia;
  const media = await readFile(QUEST_AUTO_MEDIA_PATH);
  const signature = media.subarray(0, 6).toString('ascii');
  const validGif = signature === 'GIF87a' || signature === 'GIF89a';
  const digest = createHash('sha256').update(media).digest('hex');
  if (media.length !== QUEST_AUTO_MEDIA_SIZE || !validGif || digest !== QUEST_AUTO_MEDIA_SHA256) {
    throw new Error('Bundled Quest Auto GIF failed integrity verification');
  }
  cachedMedia = media;
  return cachedMedia;
}
