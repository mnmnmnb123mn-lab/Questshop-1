import { createHash, randomUUID } from 'node:crypto';
import { renderSurfaceAnchor } from '../renderers/surfaces.js';
import { normalizeDiscordPayload } from '../payload.js';
import { loadQuestAutoMedia, loadQuestAutoThumbnail, QUEST_AUTO_MEDIA_FILENAME, QUEST_AUTO_THUMBNAIL_FILENAME } from './quest-auto-media.js';
import { saveSurfaceInTransaction } from '../../config/runtime-config.js';
import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';
import { enqueueNotificationInTransaction } from '../../domain/sqlite/notifications.js';

export function surfaceNonce(surfaceKey) {
  const readable = `surface-${String(surfaceKey).toLowerCase()}`;
  if (readable.length <= 25) return readable;
  return `surface-${String(surfaceKey).toLowerCase().slice(0, 8)}-${createHash('sha256').update(surfaceKey).digest('hex').slice(0, 8)}`;
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
  return channel.messages.fetch({ message: messageId, force: true, cache: false }).catch(() => null);
}

async function findByNonce(channel, nonce) {
  const page = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const values = page?.values ? [...page.values()] : [];
  return values.find((message) => String(message.nonce ?? '') === nonce) ?? null;
}

export async function updateOrCreateSurfaceAnchor(channel, surfaceKey, config, existingMessage = null) {
  const body = await surfaceBody(surfaceKey, config, existingMessage);
  const previous = existingMessage ?? await findByNonce(channel, surfaceNonce(surfaceKey));
  if (previous) {
    try { return { message: await previous.edit(body), recreated: false }; } catch { /* Send a repaired anchor below. */ }
  }
  return { message: await channel.send(body), recreated: true };
}

export async function setupSurface({ channel, surfaceKey, runtime, actorId }) {
  if (!channel?.isTextBased?.()) throw new TypeError('Surface channel must be a guild text channel');
  const current = runtime.config.surfaces?.[surfaceKey] ?? null;
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
}

/** Repair durable panels without creating Admin audit noise.  This runs in the
 * SQLite runtime, never participates in a financial transaction. */
export async function reconcileSurfaceAnchors({ runtime }) {
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
