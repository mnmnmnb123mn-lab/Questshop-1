export function discordErrorKind(error) {
  const status = Number(error?.status);
  const code = Number(error?.code);
  if (status === 403 || code === 50013) return 'FORBIDDEN';
  if (status === 404 || [10003, 10008].includes(code) || error?.code === 'DISCORD_404') return 'MISSING';
  if (status === 429 || code === 20028 || code === 20029) return 'RATE_LIMITED';
  if (status >= 500 && status <= 599) return 'TRANSIENT';
  return 'UNKNOWN';
}

export function isMissingDiscordMessage(error) {
  return discordErrorKind(error) === 'MISSING';
}

export async function fetchDiscordMessage(channel, messageId) {
  try {
    return await channel.messages.fetch({ message: messageId, force: true, cache: false });
  } catch (error) {
    if (isMissingDiscordMessage(error)) return null;
    throw error;
  }
}

function messageValues(page) {
  if (!page) return [];
  if (typeof page.values === 'function') return [...page.values()];
  return Array.isArray(page) ? page : [];
}

export async function findDiscordMessage(channel, predicate, { limit = 100, maximum = 500 } = {}) {
  let before = null;
  let inspected = 0;
  while (inspected < maximum) {
    const page = await channel.messages.fetch({ limit: Math.min(limit, maximum - inspected), ...(before ? { before } : {}) });
    const messages = messageValues(page);
    const match = messages.find((message) => predicate(message));
    if (match) return match;
    inspected += messages.length;
    if (messages.length < limit) return null;
    const oldest = messages.at(-1);
    if (!oldest?.id || oldest.id === before) return null;
    before = oldest.id;
  }
  return null;
}

export function findDiscordMessageByNonce(channel, nonce, options) {
  return findDiscordMessage(channel, (message) => String(message.nonce ?? '') === String(nonce), options);
}
