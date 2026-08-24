import { v7 as uuidv7 } from 'uuid';

export function newTraceId() {
  return uuidv7();
}

export function supportCode(traceId) {
  return `QS-${String(traceId).replaceAll('-', '').slice(0, 8).toUpperCase()}`;
}

export function createContext({
  traceId = newTraceId(),
  causationId = null,
  actorType,
  actorId,
  guildId,
  idempotencyKey,
  messageId = null,
}) {
  if (!actorType || !actorId || !guildId || !idempotencyKey) {
    throw new TypeError('context requires actorType, actorId, guildId and idempotencyKey');
  }
  return Object.freeze({ traceId, causationId, actorType, actorId, guildId,
    idempotencyKey, messageId });
}
