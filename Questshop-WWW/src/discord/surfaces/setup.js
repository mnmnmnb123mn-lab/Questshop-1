import { createHash } from 'node:crypto';
import { withTransaction } from '../../db/transaction.js';
import { QuestshopError } from '../../shared/errors.js';
import { renderSurfaceAnchor } from '../renderers/surfaces.js';
import { appendAdminAudit } from '../../domain/admin/audit.js';
import { reconcileIncident } from '../../domain/incidents/service.js';
import { configuredQuestPriceRange } from '../../domain/pricing/resolver.js';
import {
  fetchDiscordMessage, findDiscordMessage, findDiscordMessageByNonce, isMissingDiscordMessage,
} from '../transport.js';
import { normalizeDiscordPayload } from '../payload.js';
import { parseCustomId } from '../components/custom-id.js';
import { QUEST_AUTO_MEDIA_FILENAME, QUEST_AUTO_MEDIA_SIZE, loadQuestAutoMedia } from './quest-auto-media.js';

const surfaceSetupLocks = new Map();

async function withSurfaceSetupLock(surfaceKey, work) {
  const previous = surfaceSetupLocks.get(surfaceKey) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  surfaceSetupLocks.set(surfaceKey, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (surfaceSetupLocks.get(surfaceKey) === queued) surfaceSetupLocks.delete(surfaceKey);
  }
}

function brandingWithPriceRange(config, priceRange) {
  const values = config?.values ?? config ?? {};
  if (priceRange === undefined) return values;
  const branding = values.branding && typeof values.branding === 'object' && !Array.isArray(values.branding)
    ? values.branding
    : {};
  return { ...values, branding: { ...branding, priceRange } };
}

async function surfacePayload(surfaceKey, config, pool = null) {
  const priceRange = surfaceKey === 'QUEST_AUTO' && pool
    ? await configuredQuestPriceRange(pool)
    : undefined;
  const body = renderSurfaceAnchor(surfaceKey, brandingWithPriceRange(config, priceRange));
  if (surfaceKey !== 'QUEST_AUTO') {
    body.embeds?.[0]?.setFooter?.({ text: `Questshop Surface • ${surfaceKey}` });
  }
  return normalizeDiscordPayload(body);
}

function messageAttachments(message) {
  const attachments = message?.attachments;
  if (!attachments) return [];
  if (Array.isArray(attachments)) return attachments;
  if (typeof attachments.values === 'function') return [...attachments.values()];
  return [];
}

function questAutoMediaAttachments(message) {
  return messageAttachments(message).filter((attachment) => (
    (attachment?.name === QUEST_AUTO_MEDIA_FILENAME || attachment?.filename === QUEST_AUTO_MEDIA_FILENAME)
      && Number(attachment?.size) === QUEST_AUTO_MEDIA_SIZE
  ));
}

function hasOnlyQuestAutoMedia(message) {
  const attachments = messageAttachments(message);
  return attachments.length === 1 && questAutoMediaAttachments(message).length === 1;
}

async function withSurfaceFiles(body, surfaceKey, message) {
  if (surfaceKey !== 'QUEST_AUTO' || hasOnlyQuestAutoMedia(message)) return body;
  return {
    ...body,
    attachments: [],
    files: [
      ...(body.files ?? []),
      { attachment: await loadQuestAutoMedia(), name: QUEST_AUTO_MEDIA_FILENAME },
    ],
  };
}

function firstEmbedData(value) {
  const embed = value?.embeds?.[0];
  if (!embed) return {};
  return typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
}

function componentData(value) {
  if (!value || typeof value !== 'object') return {};
  return typeof value.toJSON === 'function' ? value.toJSON() : value;
}

function normalizedEmoji(value) {
  if (!value) return null;
  return {
    id: value.id ?? null,
    name: value.name ?? null,
    animated: value.animated === true,
  };
}

function buttonContract(value) {
  const button = componentData(value);
  const route = parseCustomId(button.custom_id ?? button.customId)?.route ?? null;
  return {
    type: Number(button.type),
    style: Number(button.style),
    route,
    label: button.label ?? null,
    emoji: normalizedEmoji(button.emoji),
    disabled: button.disabled === true,
    url: button.url ?? null,
    skuId: button.sku_id ?? button.skuId ?? null,
  };
}

function actionRowButtons(value) {
  const rows = Array.isArray(value?.components) ? value.components : [];
  if (rows.length !== 1) return null;
  const row = componentData(rows[0]);
  if (Number(row.type) !== 1 || !Array.isArray(row.components) || row.components.length !== 2) return null;
  return row.components.map(buttonContract);
}

function questAutoComponentsMatch(message, expectedBody) {
  const actual = actionRowButtons(message);
  const expected = actionRowButtons(expectedBody);
  return actual !== null && expected !== null && JSON.stringify(actual) === JSON.stringify(expected);
}

function normalizedEmbedContract(embed) {
  return {
    title: embed.title ?? null,
    description: embed.description ?? null,
    color: embed.color ?? null,
    url: embed.url ?? null,
    timestamp: embed.timestamp ?? null,
    author: embed.author ? {
      name: embed.author.name ?? null,
      url: embed.author.url ?? null,
      iconUrl: embed.author.icon_url ?? embed.author.iconURL ?? null,
    } : null,
    footer: embed.footer ? {
      text: embed.footer.text ?? null,
      iconUrl: embed.footer.icon_url ?? embed.footer.iconURL ?? null,
    } : null,
    thumbnail: embed.thumbnail ? comparableImageUrl(embed.thumbnail.url) : null,
    fields: Array.isArray(embed.fields) ? embed.fields.map((field) => ({
      name: field.name ?? null,
      value: field.value ?? null,
      inline: field.inline === true,
    })) : [],
  };
}

function questAutoEmbedMatches(message, expectedBody) {
  if (!Array.isArray(message?.embeds) || message.embeds.length !== 1
    || !Array.isArray(expectedBody?.embeds) || expectedBody.embeds.length !== 1) return false;
  const actual = firstEmbedData(message);
  const expected = firstEmbedData(expectedBody);
  return JSON.stringify(normalizedEmbedContract(actual)) === JSON.stringify(normalizedEmbedContract(expected));
}

function comparableAttachmentUrls(attachment) {
  return [attachment?.url, attachment?.proxyURL, attachment?.proxy_url]
    .filter((url) => typeof url === 'string' && url.length > 0)
    .map((url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return url;
      }
    });
}

function comparableImageUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function questAutoImageMatchesAttachment(message, imageUrl) {
  const actual = comparableImageUrl(imageUrl);
  if (!actual) return false;
  return questAutoMediaAttachments(message).some((attachment) => (
    comparableAttachmentUrls(attachment).includes(actual)
  ));
}

export function questAutoSurfaceMatches(message, expectedBody) {
  if (!message || !hasOnlyQuestAutoMedia(message)) return false;
  const actual = firstEmbedData(message);
  return String(message.content ?? '') === String(expectedBody.content ?? '')
    && questAutoEmbedMatches(message, expectedBody)
    && questAutoImageMatchesAttachment(message, actual.image?.url)
    && questAutoComponentsMatch(message, expectedBody);
}

export function assertSensitiveSurfacePrivacy(_channel, _surfaceKey) {
  // LOG_PAYMENTS intentionally follows the Owner-managed Discord permission policy.
  // The runtime validates only that a surface points at a usable guild text channel;
  // it does not infer which human roles/members the Owner intends to grant access to.
  return true;
}

async function findSurfaceMarker(channel, surfaceKey) {
  const botUserId = channel.client?.user?.id;
  if (surfaceKey === 'QUEST_AUTO') {
    const byNonce = await findDiscordMessageByNonce(channel, surfaceNonce(surfaceKey));
    if (byNonce && byNonce.author?.id === botUserId) return byNonce;
  }
  return findDiscordMessage(channel, (message) => message.author?.id === botUserId
    && message.embeds?.[0]?.footer?.text === `Questshop Surface • ${surfaceKey}`);
}

export async function fetchSurfaceMessageFresh(channel, messageId) {
  return fetchDiscordMessage(channel, messageId);
}

export function surfaceNonce(surfaceKey) {
  const readable = `surface-${surfaceKey.toLowerCase()}`;
  if (readable.length <= 25) return readable;
  const prefix = surfaceKey.toLowerCase().replaceAll('_', '').slice(0, 8);
  const digest = createHash('sha256').update(surfaceKey).digest('hex').slice(0, 8);
  return `surface-${prefix}-${digest}`;
}

export async function updateOrCreateSurfaceAnchor(channel, surfaceKey, config, existingMessage = null, options = {}) {
  const body = await surfacePayload(surfaceKey, config, options.pool);
  let message = existingMessage;
  if (message) {
    try {
      return { message: await message.edit(await withSurfaceFiles(body, surfaceKey, message)), recreated: false };
    } catch (error) {
      if (!isMissingDiscordMessage(error)) throw error;
    }
  }
  message = await findSurfaceMarker(channel, surfaceKey);
  if (message) {
    try {
      return { message: await message.edit(await withSurfaceFiles(body, surfaceKey, message)), recreated: false };
    } catch (error) {
      if (!isMissingDiscordMessage(error)) throw error;
    }
  }
  const created = await channel.send({
    ...await withSurfaceFiles(body, surfaceKey, null),
    nonce: surfaceNonce(surfaceKey),
    enforceNonce: true,
  });
  return { message: created, recreated: true };
}

async function setupSurfaceLocked({ interaction, surfaceKey, config }, context, options = {}) {
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;
  if (!channel?.isTextBased() || channel.isDMBased()) {
    throw new QuestshopError('SURFACE_CHANNEL_INVALID', 'ต้องเลือกห้องข้อความในเซิร์ฟเวอร์');
  }
  assertSensitiveSurfacePrivacy(channel, surfaceKey);
  const existing = (await options.pool.query('SELECT * FROM surfaces WHERE surface_key = $1', [surfaceKey])).rows[0];
  let message = null;
  if (existing?.channel_id === channel.id && existing.message_id) {
    message = await fetchSurfaceMessageFresh(channel, existing.message_id);
  }
  message ??= await findSurfaceMarker(channel, surfaceKey);
  const anchor = await updateOrCreateSurfaceAnchor(channel, surfaceKey, config, message, { pool: options.pool });
  try {
    await withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
      const values = [surfaceKey, interaction.guildId, channel.id, anchor.message.id, Number(config?.version ?? 0)];
      let persisted;
      if (existing) {
        persisted = (await client.query(`UPDATE surfaces SET guild_id=$2,channel_id=$3,message_id=$4,
          state='ACTIVE',rendered_config_version=$5,state_version=state_version+1,
          last_validated_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE surface_key=$1 AND state_version=$6 RETURNING *`, [...values, existing.state_version])).rows[0];
      } else {
        persisted = (await client.query(`INSERT INTO surfaces(surface_key,guild_id,channel_id,message_id,
          state,last_validated_at,rendered_config_version)
          VALUES($1,$2,$3,$4,'ACTIVE',clock_timestamp(),$5)
          ON CONFLICT(surface_key) DO NOTHING RETURNING *`, values)).rows[0];
      }
      if (!persisted) throw new QuestshopError('STALE_SURFACE', 'มีการติดตั้งแผงนี้จากคำสั่งอื่นพร้อมกัน');
      await appendAdminAudit(client, { action: 'SURFACE_SETUP', targetType: 'SURFACE', targetId: surfaceKey,
        actorId: interaction.user.id, before: existing ?? null,
        after: { channelId: channel.id, messageId: anchor.message.id }, reason: 'setup command', context });
    });
  } catch (error) {
    if (anchor.recreated) await deactivateOrphan(anchor.message, options.pool, surfaceKey, context);
    throw error;
  }
  let cleanupFailed = false;
  if (existing?.message_id && (existing.channel_id !== channel.id || existing.message_id !== anchor.message.id)) {
    try {
      const old = await interaction.guild.channels.fetch(existing.channel_id);
      const oldMessage = old?.isTextBased() ? await fetchSurfaceMessageFresh(old, existing.message_id) : null;
      await oldMessage?.edit({ content: 'แผงนี้ถูกย้ายแล้ว', embeds: [], components: [], attachments: [] });
    } catch (error) {
      await recordSurfaceIncidentSafely(options.pool, surfaceKey, error, context);
      cleanupFailed = true;
    }
  }
  if (!cleanupFailed) await resolveSurfaceIncidentSafely(options.pool, surfaceKey, context);
  return anchor.message;
}

export async function setupSurface(input, context, options = {}) {
  return withSurfaceSetupLock(input.surfaceKey, () => setupSurfaceLocked(input, context, options));
}

async function recordSurfaceIncident(pool, surfaceKey, error, context) {
  return reconcileIncident({ code: 'DISCORD_SURFACE_RECONCILE_FAILED', scope: surfaceKey, active: true,
    severity: 'ERROR', evidence: {
    code: String(error?.code ?? error?.name ?? 'UNKNOWN').slice(0, 100),
    status: Number(error?.status) || null,
  } }, context, { pool });
}

async function resolveSurfaceIncidentSafely(pool, surfaceKey, context) {
  try {
    await reconcileIncident({ code: 'DISCORD_SURFACE_RECONCILE_FAILED', scope: surfaceKey,
      active: false, severity: 'ERROR', evidence: {} }, context, { pool });
  } catch {
    // A successful Discord repair must not be reported as failed because the
    // non-financial incident projection could not be updated.
  }
}

async function recordSurfaceIncidentSafely(pool, surfaceKey, error, context) {
  try {
    await recordSurfaceIncident(pool, surfaceKey, error, context);
  } catch {
    // A database outage is already the authoritative failure. Do not hide
    // the original Discord error or stop reconciliation of other surfaces.
  }
}

async function deactivateOrphan(message, pool, surfaceKey, context) {
  try {
    await message.edit({ content: 'แผงนี้ถูกแทนที่แล้ว', embeds: [], components: [], attachments: [] });
  } catch (error) {
    await recordSurfaceIncidentSafely(pool, surfaceKey, error, context);
  }
}

async function persistReconciledSurface(pool, surface, message, config, anchor, context) {
  return withTransaction({ pool, isolation: 'SERIALIZABLE' }, async (database) => {
    const updated = (await database.query(`UPDATE surfaces SET message_id=$2,state='ACTIVE',
      rendered_config_version=$4,state_version=state_version+1,updated_at=clock_timestamp()
      WHERE surface_key=$1 AND state_version=$3 RETURNING *`,
    [surface.surface_key, message.id, surface.state_version, Number(config?.version ?? 0)])).rows[0];
    if (!updated) return null;
    await appendAdminAudit(database, { action: 'SURFACE_RECONCILED', targetType: 'SURFACE',
      targetId: surface.surface_key, actorId: context.actorId,
      before: { messageId: surface.message_id, state: surface.state },
      after: { messageId: message.id, state: 'ACTIVE' },
      reason: anchor.recreated ? 'anchor missing during reconciliation' : 'anchor refreshed or recovered by marker', context });
    return updated;
  });
}

async function reconcileOneSurface({ guild, pool, surface, config, context }) {
  const channel = await guild.channels.fetch(surface.channel_id);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    throw new QuestshopError('SURFACE_CHANNEL_INVALID', 'Surface channel is unavailable');
  }
  assertSensitiveSurfacePrivacy(channel, surface.surface_key);
  let message = surface.message_id ? await fetchSurfaceMessageFresh(channel, surface.message_id) : null;
  message ??= await findSurfaceMarker(channel, surface.surface_key);
  const questAutoChanged = message && surface.surface_key === 'QUEST_AUTO'
    ? !questAutoSurfaceMatches(message, await surfacePayload(surface.surface_key, config, pool))
    : false;
  const needsRefresh = !message || surface.state === 'RECONCILING'
    || Number(surface.rendered_config_version) < Number(config?.version ?? 0)
    || questAutoChanged;
  if (!needsRefresh) {
    await resolveSurfaceIncidentSafely(pool, surface.surface_key, context);
    return { surfaceKey: surface.surface_key, skipped: true };
  }
  const anchor = await updateOrCreateSurfaceAnchor(channel, surface.surface_key, config, message, { pool });
  const updated = await persistReconciledSurface(pool, surface, anchor.message, config, anchor, context);
  if (updated) {
    await resolveSurfaceIncidentSafely(pool, surface.surface_key, context);
    return { surfaceKey: surface.surface_key, recreated: anchor.recreated,
      refreshed: Boolean(message), messageId: anchor.message.id };
  }
  if (anchor.recreated) await deactivateOrphan(anchor.message, pool, surface.surface_key, context);
  return { surfaceKey: surface.surface_key, reconciled: false, reason: 'STALE_SURFACE' };
}

export async function reconcileSurfaceAnchors({ client, pool, env, config }, context) {
  const surfaces = (await pool.query(`SELECT * FROM surfaces WHERE state IN ('ACTIVE','RECONCILING')`)).rows;
  const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);
  const results = [];
  for (const surface of surfaces) {
    try {
      results.push(await reconcileOneSurface({ guild, pool, surface, config, context }));
    } catch (error) {
      await recordSurfaceIncidentSafely(pool, surface.surface_key, error, context);
      results.push({ surfaceKey: surface.surface_key, reconciled: false,
        reason: String(error?.code ?? error?.name ?? 'DISCORD_ERROR') });
    }
  }
  return results;
}
