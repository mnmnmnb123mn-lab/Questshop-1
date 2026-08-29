import { createHash, randomUUID } from 'node:crypto';
import { renderSurfaceAnchor } from '../renderers/surfaces.js';
import { normalizeDiscordPayload } from '../payload.js';
import { loadQuestAutoMedia, loadQuestAutoThumbnail, QUEST_AUTO_MEDIA_FILENAME, QUEST_AUTO_THUMBNAIL_FILENAME } from './quest-auto-media.js';
import { saveSurfaceInTransaction } from '../../config/runtime-config.js';
import { loadRuntimeConfig } from '../../config/runtime-config.js';
import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';
import { enqueueNotificationInTransaction } from '../../domain/sqlite/notifications.js';

export function surfaceNonce(surfaceKey) {
  const readable = `surface-${String(surfaceKey).toLowerCase()}`;
  if (readable.length <= 25) return readable;
  return `surface-${String(surfaceKey).toLowerCase().slice(0, 8)}-${createHash('sha256').update(surfaceKey).digest('hex').slice(0, 8)}`;
}

const activeSurfaceOperations = new Set();

function isUnknownMessage(error) {
  return Number(error?.status) === 404 || Number(error?.code) === 10008;
}

async function surfaceBody(surfaceKey, config) {
  const body = renderSurfaceAnchor(surfaceKey, config);
  if (surfaceKey !== 'QUEST_AUTO') return normalizeDiscordPayload({ ...body, nonce: surfaceNonce(surfaceKey) });
  return normalizeDiscordPayload({ ...body, nonce: surfaceNonce(surfaceKey), attachments: [], files: [
    { attachment: await loadQuestAutoMedia(), name: QUEST_AUTO_MEDIA_FILENAME },
    { attachment: await loadQuestAutoThumbnail(), name: QUEST_AUTO_THUMBNAIL_FILENAME },
  ] });
}

export async function fetchSurfaceMessageFresh(channel, messageId) {
  try { return await channel.messages.fetch({ message: messageId, force: true, cache: false }); }
  catch (error) { if (isUnknownMessage(error)) return null; throw error; }
}

async function findSurfaceMarker(channel, surfaceKey) {
  const nonce = surfaceNonce(surfaceKey);
  const legacyFooter = `Questshop Surface • ${surfaceKey}`;
  const botUserId = channel.client?.user?.id;
  let before;
  // Nonce is the durable primary identity.  The historical technical footer
  // is deliberately a migration-only fallback, so no customer-facing footer
  // is added to newly rendered storefronts.
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const values = page?.values ? [...page.values()] : [];
    const owned = (message) => !botUserId || message.author?.id === botUserId;
    const byNonce = values.find((message) => owned(message) && String(message.nonce ?? '') === nonce);
    if (byNonce) return byNonce;
    const byLegacyFooter = values.find((message) => owned(message)
      && message.embeds?.[0]?.footer?.text === legacyFooter);
    if (byLegacyFooter) return byLegacyFooter;
    const oldest = values.at(-1);
    if (!oldest?.id || oldest.id === before || values.length < 100) return null;
    before = oldest.id;
  }
  throw Object.assign(new Error('Unable to exhaust Discord surface reconciliation'), { code: 'SURFACE_RECONCILIATION_EXHAUSTED' });
}

export async function updateOrCreateSurfaceAnchor(channel, surfaceKey, config, existingMessage = null) {
  const body = await surfaceBody(surfaceKey, config, existingMessage);
  const previous = existingMessage ?? await findSurfaceMarker(channel, surfaceKey);
  if (previous) {
    try { return { message: await previous.edit(body), recreated: false }; }
    catch (error) {
      if (!isUnknownMessage(error)) throw error;
      // A confirmed deletion is the only condition that permits a replacement.
    }
  }
  return { message: await channel.send(body), recreated: true };
}

async function retireOldAnchor(runtime, surfaceKey, current, nextChannelId) {
  if (!current?.channelId || !current?.messageId || !runtime.client || current.channelId === nextChannelId) return;
  const oldChannel = await runtime.client.channels.fetch(current.channelId);
  if (!oldChannel?.isTextBased?.()) return;
  const oldMessage = await fetchSurfaceMessageFresh(oldChannel, current.messageId);
  if (!oldMessage) return;
  await oldMessage.edit(normalizeDiscordPayload({
    content: `แผง ${surfaceKey} ถูกย้ายไปยังห้องใหม่แล้ว`, embeds: [], components: [], allowedMentions: { parse: [] },
  }));
}

export async function setupSurface({ channel, surfaceKey, runtime, actorId }) {
  if (!channel?.isTextBased?.()) throw new TypeError('Surface channel must be a guild text channel');
  if (activeSurfaceOperations.has(surfaceKey)) {
    const error = new Error('Surface setup is already in progress'); error.code = 'SURFACE_SETUP_IN_PROGRESS'; throw error;
  }
  activeSurfaceOperations.add(surfaceKey);
  try {
  const current = runtime.config.surfaces?.[surfaceKey] ?? null;
  await retireOldAnchor(runtime, surfaceKey, current, channel.id);
  const existing = current?.channelId === channel.id && current?.messageId
    ? await fetchSurfaceMessageFresh(channel, current.messageId) : null;
  const { message, recreated } = await updateOrCreateSurfaceAnchor(channel, surfaceKey, runtime.config, existing);
  const timestamp = nowMs();
  withImmediateTransaction(runtime.db, () => {
    saveSurfaceInTransaction(runtime.db, surfaceKey, { channelId: channel.id, messageId: message.id, nonce: surfaceNonce(surfaceKey) }, actorId);
    const auditId = randomUUID();
    const traceId = randomUUID();
    runtime.db.prepare(`INSERT INTO admin_audit(id,actor_id,action,target_type,target_id,reason,after_json,trace_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(auditId, actorId, 'SURFACE_SETUP', 'SURFACE', surfaceKey, null,
      JSON.stringify({ channelId: channel.id, messageId: message.id }), traceId, timestamp);
    enqueueNotificationInTransaction(runtime.db, { notificationType: 'ADMIN_LOG', aggregateType: 'ADMIN_AUDIT',
      aggregateId: auditId, destination: 'LOG_ADMIN', payload: { auditId }, timestamp });
  });
  runtime.config = { ...runtime.config, surfaces: { ...(runtime.config.surfaces ?? {}),
    [surfaceKey]: { channelId: channel.id, messageId: message.id, nonce: surfaceNonce(surfaceKey) } } };
  return { message, recreated };
  } finally {
    activeSurfaceOperations.delete(surfaceKey);
  }
}

/** Repair durable panels without creating Admin audit noise.  This runs in the
 * SQLite runtime, never participates in a financial transaction. */
export async function reconcileSurfaceAnchors({ runtime }) {
  runtime.config = loadRuntimeConfig(runtime.db);
  const entries = Object.entries(runtime.config.surfaces ?? {});
  for (const [surfaceKey, stored] of entries) {
    if (!stored?.channelId) continue;
    const channel = await runtime.client.channels.fetch(stored.channelId).catch(() => null);
    if (!channel?.isTextBased?.()) continue;
    const existing = stored.messageId ? await fetchSurfaceMessageFresh(channel, stored.messageId) : null;
    const result = await updateOrCreateSurfaceAnchor(channel, surfaceKey, runtime.config, existing).catch(() => null);
    if (!result || result.message.id === stored.messageId) continue;
    withImmediateTransaction(runtime.db, () => saveSurfaceInTransaction(runtime.db, surfaceKey,
      { channelId: channel.id, messageId: result.message.id, nonce: surfaceNonce(surfaceKey) }, 'SYSTEM'));
    runtime.config = { ...runtime.config, surfaces: { ...runtime.config.surfaces,
      [surfaceKey]: { channelId: channel.id, messageId: result.message.id, nonce: surfaceNonce(surfaceKey) } } };
  }
}

export function assertSensitiveSurfacePrivacy() { return true; }
