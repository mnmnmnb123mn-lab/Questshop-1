export const QUEST_API_VERSION = 9;
export const QUEST_API_PREFIX = `/api/v${QUEST_API_VERSION}`;
export const QUEST_LIST_PATHS = Object.freeze(['/quests/@me', '/users/@me/quests']);
const FIXED_QUEST_API_PATHS = new Set(['/users/@me', ...QUEST_LIST_PATHS]);
const QUEST_ACTION_PATH = /^\/quests\/[A-Za-z0-9_-]+\/(?:enroll|video-progress|heartbeat)$/;

// These are the only endpoints where a 403 proves that the credential itself
// is unusable. A 403 from an individual Quest action can be a Quest-specific
// restriction and must not quarantine a Monitor account.
export const FATAL_FORBIDDEN_PATHS = new Set(['/users/@me', ...QUEST_LIST_PATHS]);

function questPath(questId, suffix) {
  const id = String(questId ?? '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new TypeError('Quest id is invalid');
  return `/quests/${id}/${suffix}`;
}

// The Quest adapter never accepts a host, query string, or arbitrary Discord
// route from a caller.  Keeping this allowlist next to endpoint construction
// makes the fixed-host request boundary independently auditable.
export function isAllowedQuestApiPath(path) {
  return FIXED_QUEST_API_PATHS.has(path) || QUEST_ACTION_PATH.test(path);
}

// This is deliberately stricter than URL parsing.  Quest callers may choose
// only a documented path; they can never influence a host, protocol, query,
// fragment, or path traversal sequence at the HTTP boundary.
export function assertAllowedQuestApiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
    || path.includes('\\') || path.includes('?') || path.includes('#')
    || /\/(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/i.test(path) || !isAllowedQuestApiPath(path)) {
    throw new TypeError('unsafe Discord API path');
  }
  return path;
}

export function discordQuestRequestPath(path) {
  return `${QUEST_API_PREFIX}${assertAllowedQuestApiPath(path)}`;
}

export const QUEST_ENDPOINT = Object.freeze({
  me: () => '/users/@me',
  enroll: (id) => questPath(id, 'enroll'),
  videoProgress: (id) => questPath(id, 'video-progress'),
  heartbeat: (id) => questPath(id, 'heartbeat'),
});
