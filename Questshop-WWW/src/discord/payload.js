import { escapeMarkdown } from 'discord.js';

export const DISCORD_LIMITS = Object.freeze({
  content: 2_000,
  embedTitle: 256,
  embedDescription: 4_096,
  embedFieldName: 256,
  embedFieldValue: 1_024,
  embedTotal: 6_000,
  selectOptions: 25,
  selectOptionLabel: 100,
  selectOptionDescription: 100,
  buttonLabel: 80,
  customId: 100,
  nonce: 25,
});

export function truncateDiscordText(value, maximum, suffix = '…') {
  const text = String(value ?? '');
  if (text.length <= maximum) return text;
  if (maximum <= suffix.length) return text.slice(0, maximum);
  return `${text.slice(0, maximum - suffix.length)}${suffix}`;
}

export function safeDiscordText(value, { maximum = DISCORD_LIMITS.embedDescription, fallback = 'ไม่ระบุ' } = {}) {
  const text = String(value ?? fallback).replaceAll('@', '@\u200b');
  return truncateDiscordText(escapeMarkdown(text), maximum);
}

export function discordDescription(lines, maximum = DISCORD_LIMITS.embedDescription) {
  const output = [];
  let remaining = maximum;
  for (const line of lines.filter(Boolean)) {
    const separator = output.length ? 1 : 0;
    if (remaining <= separator) break;
    const bounded = truncateDiscordText(line, remaining - separator);
    output.push(bounded);
    remaining -= bounded.length + separator;
  }
  return output.join('\n');
}

export function customerErrorText(message, supportCode) {
  return truncateDiscordText(`${message}\nSupport: \`${supportCode}\``, DISCORD_LIMITS.content);
}

function boundedText(value, maximum) {
  return typeof value === 'string'
    ? truncateDiscordText(value.replaceAll('@', '@\u200b'), maximum)
    : value;
}

function embedData(embed) {
  if (!embed || typeof embed !== 'object') return null;
  return typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
}

function embedCharacterCount(embed) {
  return [embed.title, embed.description, embed.footer?.text, embed.author?.name,
    ...(embed.fields ?? []).flatMap((field) => [field.name, field.value])]
    .reduce((total, value) => total + String(value ?? '').length, 0);
}

function trimEmbedTotal(embed) {
  let excess = embedCharacterCount(embed) - DISCORD_LIMITS.embedTotal;
  if (excess <= 0) return embed;
  if (typeof embed.description === 'string') {
    const nextLength = Math.max(0, embed.description.length - excess);
    embed.description = truncateDiscordText(embed.description, nextLength);
    excess = embedCharacterCount(embed) - DISCORD_LIMITS.embedTotal;
  }
  for (const field of [...(embed.fields ?? [])].reverse()) {
    if (excess <= 0) break;
    const nextLength = Math.max(0, String(field.value ?? '').length - excess);
    field.value = truncateDiscordText(field.value ?? '', nextLength);
    excess = embedCharacterCount(embed) - DISCORD_LIMITS.embedTotal;
  }
  return embed;
}

function normalizeEmbed(embed) {
  const data = embedData(embed);
  if (!data) return data;
  const normalized = { ...data };
  normalized.title = boundedText(normalized.title, DISCORD_LIMITS.embedTitle);
  normalized.description = boundedText(normalized.description, DISCORD_LIMITS.embedDescription);
  if (normalized.footer?.text) normalized.footer = { ...normalized.footer,
    text: boundedText(normalized.footer.text, DISCORD_LIMITS.embedFieldValue) };
  if (normalized.author?.name) normalized.author = { ...normalized.author,
    name: boundedText(normalized.author.name, DISCORD_LIMITS.embedFieldName) };
  if (Array.isArray(normalized.fields)) {
    normalized.fields = normalized.fields.slice(0, 25).map((field) => ({ ...field,
      name: boundedText(field.name, DISCORD_LIMITS.embedFieldName) ?? 'ไม่ระบุ',
      value: boundedText(field.value, DISCORD_LIMITS.embedFieldValue) ?? 'ไม่ระบุ',
    }));
  }
  return trimEmbedTotal(normalized);
}

function safeComponentUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.toString().length <= 512 ? url.toString() : undefined;
  } catch {
    return null;
  }
}

function componentData(component) {
  return component && typeof component === 'object' && typeof component.toJSON === 'function'
    ? component.toJSON()
    : component;
}

function normalizeComponent(component) {
  const data = componentData(component);
  if (!data || typeof data !== 'object') return data;
  const normalized = { ...data };
  normalized.custom_id = boundedText(normalized.custom_id, DISCORD_LIMITS.customId);
  normalized.label = boundedText(normalized.label, DISCORD_LIMITS.buttonLabel);
  if (Object.hasOwn(normalized, 'url')) {
    normalized.url = safeComponentUrl(normalized.url);
    if (!normalized.url) return null;
  }
  if (Array.isArray(normalized.options)) {
    normalized.options = normalized.options.slice(0, DISCORD_LIMITS.selectOptions).map((option) => ({ ...option,
      label: boundedText(option.label, DISCORD_LIMITS.selectOptionLabel),
      description: boundedText(option.description, DISCORD_LIMITS.selectOptionDescription),
    }));
  }
  if (Array.isArray(normalized.components)) {
    normalized.components = normalized.components.slice(0, 5).map(normalizeComponent).filter(Boolean);
  }
  return normalized;
}

function normalizeAllowedMentions(value) {
  const supplied = value && typeof value === 'object' ? value : {};
  const roles = Array.isArray(supplied.roles) ? supplied.roles.filter((id) => /^\d{17,20}$/.test(String(id))) : [];
  const users = Array.isArray(supplied.users) ? supplied.users.filter((id) => /^\d{17,20}$/.test(String(id))) : [];
  return {
    // Mentions are deny-by-default. The first Quest announcement can still
    // ping one explicitly configured role by supplying its exact role ID.
    parse: [],
    ...(roles.length ? { roles } : {}),
    ...(users.length ? { users } : {}),
  };
}

function suppressUnallowedMentions(value, allowedMentions) {
  const text = String(value);
  const mentions = /<@&(\d+)>|<@!?(\d+)>/g;
  let cursor = 0;
  let result = '';

  for (const match of text.matchAll(mentions)) {
    const [mention, roleId, userId] = match;
    const offset = match.index ?? cursor;
    result += text.slice(cursor, offset).replaceAll('@', '@\u200b');

    const allowed = roleId
      ? (allowedMentions.roles ?? []).includes(roleId)
      : (allowedMentions.users ?? []).includes(userId);
    result += allowed ? mention : mention.replace('@', '@\u200b');
    cursor = offset + mention.length;
  }

  return `${result}${text.slice(cursor).replaceAll('@', '@\u200b')}`;
}

/**
 * Final transport boundary for interaction payloads.  Builders already
 * validate their own component shape; this function makes the values that
 * Discord otherwise accepts as arbitrary strings safe and bounded.
 */
export function normalizeDiscordPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const normalized = { ...payload, allowedMentions: normalizeAllowedMentions(payload.allowedMentions) };
  if (typeof normalized.content === 'string') {
    // Do not escape all Markdown here: the application deliberately uses
    // Discord formatting for trusted labels/receipts.  Dynamic fields are
    // escaped at their renderer boundary; this final boundary disables
    // mentions and caps content for every remaining transport path.
    normalized.content = truncateDiscordText(
      suppressUnallowedMentions(normalized.content, normalized.allowedMentions), DISCORD_LIMITS.content,
    );
  }
  if (Array.isArray(normalized.embeds)) normalized.embeds = normalized.embeds.slice(0, 10).map(normalizeEmbed);
  if (Array.isArray(normalized.components)) {
    normalized.components = normalized.components.slice(0, 5).map(normalizeComponent)
      .filter((row) => row?.components?.length || !Object.hasOwn(row ?? {}, 'components'));
  }
  if (typeof normalized.nonce === 'string') normalized.nonce = truncateDiscordText(normalized.nonce, DISCORD_LIMITS.nonce, '');
  return normalized;
}
