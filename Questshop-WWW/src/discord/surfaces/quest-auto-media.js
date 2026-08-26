import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const QUEST_AUTO_MEDIA_FILENAME = 'quest-auto-demo.gif';
export const QUEST_AUTO_MEDIA_ATTACHMENT_URL = `attachment://${QUEST_AUTO_MEDIA_FILENAME}`;
const QUEST_AUTO_MEDIA_PATH = fileURLToPath(new URL('../assets/quest-auto-demo.gif', import.meta.url));
export const QUEST_AUTO_MEDIA_SIZE = 9_190_692;
const QUEST_AUTO_MEDIA_SHA256 = 'c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1';
export const QUEST_AUTO_THUMBNAIL_FILENAME = 'quest-auto-thumbnail.gif';
export const QUEST_AUTO_THUMBNAIL_ATTACHMENT_URL = `attachment://${QUEST_AUTO_THUMBNAIL_FILENAME}`;
const QUEST_AUTO_THUMBNAIL_PATH = fileURLToPath(new URL('../assets/quest-auto-thumbnail.gif', import.meta.url));
export const QUEST_AUTO_THUMBNAIL_SIZE = 822_513;
const QUEST_AUTO_THUMBNAIL_SHA256 = '2d1e0e2c09138ac53384ac6272f4c8a9eedff28e2fe227ee06e26f7ef37a6542';

let cachedMedia = null;
let cachedThumbnail = null;

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

export async function loadQuestAutoThumbnail() {
  if (cachedThumbnail) return cachedThumbnail;
  const thumbnail = await readFile(QUEST_AUTO_THUMBNAIL_PATH);
  const signature = thumbnail.subarray(0, 6).toString('ascii');
  const validGif = signature === 'GIF87a' || signature === 'GIF89a';
  const digest = createHash('sha256').update(thumbnail).digest('hex');
  if (thumbnail.length !== QUEST_AUTO_THUMBNAIL_SIZE || !validGif || digest !== QUEST_AUTO_THUMBNAIL_SHA256) {
    throw new Error('Bundled Quest Auto thumbnail failed integrity verification');
  }
  cachedThumbnail = thumbnail;
  return cachedThumbnail;
}
