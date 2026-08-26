export class QuestCompatibilityError extends Error {
  constructor(message, { code = 'QUEST_SCHEMA_INCOMPATIBLE', details = null } = {}) {
    super(message);
    this.name = 'QuestCompatibilityError';
    this.code = code;
    this.details = details;
  }
}

export function questCompatibilityIssue(code, message, details = null) {
  return Object.freeze({ code, message, details });
}

export function assertQuestObject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.id == null) {
    throw new QuestCompatibilityError('Quest entry must be an object with id', {
      code: 'QUEST_ENTRY_INVALID',
    });
  }
  return raw;
}

export function extractQuestArray(candidate, path = 'Quest API') {
  if (Array.isArray(candidate)) return candidate;
  if (Array.isArray(candidate?.quests)) return candidate.quests;
  throw new QuestCompatibilityError(`${path} did not return a Quest array`, {
    code: 'QUEST_PAYLOAD_NOT_ARRAY',
  });
}

