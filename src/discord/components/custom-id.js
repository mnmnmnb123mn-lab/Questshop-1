import { randomUUID } from 'node:crypto';

const ROUTE = /^[a-z0-9_-]{1,32}$/;
const ID = /^qs:v1:([a-z0-9_-]{1,32}):([0-9a-f-]{36})$/;

export function customId(route, sessionId = randomUUID()) {
  if (!ROUTE.test(route)) throw new TypeError('Invalid component route');
  return `qs:v1:${route}:${sessionId}`;
}

export function parseCustomId(value) {
  const match = ID.exec(value ?? '');
  return match ? { version: 1, route: match[1], sessionId: match[2] } : null;
}
