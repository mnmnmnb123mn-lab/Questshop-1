const SECRET_KEYS = new Set([
  'token', 'authorization', 'cookie', 'password', 'secret', 'credential', 'session',
  'database_url', 'api_key', 'ciphertext', 'auth_tag', 'encryption_key', 'hmac_key',
]);
const MFA_DISCORD_TOKEN = /\bmfa\.[A-Za-z0-9_-]{20,}\b/g;
const DISCORD_TOKEN = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g;
const DATABASE_URL = /(?:postgres(?:ql)?|sqlite):\/\/[^\s]+/gi;
const TRUEMONEY_VOUCHER_URL = /https:\/\/gift\.truemoney\.com\/campaign\/?\?v=[A-Za-z0-9]{16,128}/gi;
const SENSITIVE_ASSIGNMENTS = [
  /(\b(?:token|cookie|password|secret|credential|session)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
  /(\bauthorization\s*[=:]\s*)(?:"[^"]*"|'[^']*'|Bearer\s+[^\s,;]+|[^\s,;]+)/gi,
  /(\b(?:api|encryption|hmac)[\s_-]?key\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
];
const MAX_ERROR_MESSAGE = 1_000;
const MAX_ERROR_STACK = 12_000;
const MAX_CAUSE_DEPTH = 3;

export function redactText(value) {
  let text = String(value)
    .replace(MFA_DISCORD_TOKEN, '[REDACTED_DISCORD_TOKEN]')
    .replace(DISCORD_TOKEN, '[REDACTED_DISCORD_TOKEN]')
    .replace(DATABASE_URL, '[REDACTED_DATABASE_URL]')
    .replace(TRUEMONEY_VOUCHER_URL, '[REDACTED_TRUEMONEY_VOUCHER]');
  for (const assignment of SENSITIVE_ASSIGNMENTS) text = text.replace(assignment, '$1[REDACTED]');
  return text;
}

function normalizedKey(key) {
  return String(key).toLowerCase().replaceAll('-', '_');
}

function isSecretKey(key) {
  const normalized = normalizedKey(key);
  return SECRET_KEYS.has(normalized) || normalized.endsWith('_token') || normalized.endsWith('_secret');
}

export function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Error) return serializeError(value);
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = isSecretKey(key) ? '[REDACTED]' : redact(child, seen);
  }
  return result;
}

function truncate(value, maximum) {
  const text = redactText(value ?? '');
  return text.length > maximum ? `${text.slice(0, maximum)}…[TRUNCATED]` : text;
}

function errorMarker(code, message) {
  return { name: 'Error', code, message };
}

function serializeCause(cause, depth, seen) {
  if (depth >= MAX_CAUSE_DEPTH) return errorMarker('CAUSE_DEPTH_LIMIT', 'Error cause depth limit reached');
  if (typeof cause !== 'object') return errorMarker('NON_ERROR_CAUSE', truncate(cause, MAX_ERROR_MESSAGE));
  if (seen.has(cause)) return errorMarker('CIRCULAR_CAUSE', 'Circular Error cause');
  if (cause instanceof Error) return serializeError(cause, { depth: depth + 1, seen });
  seen.add(cause);
  return errorMarker('NON_ERROR_CAUSE', truncate(String(cause), MAX_ERROR_MESSAGE));
}

// Error instances have no enumerable own properties in JavaScript, which used
// to produce `{}` in structured logs.  Deliberately serialize only a bounded,
// redacted diagnostic allowlist and never copy provider config/payload fields.
export function serializeError(error, { depth = 0, seen = new WeakSet() } = {}) {
  if (error && typeof error === 'object') {
    if (seen.has(error)) return errorMarker('CIRCULAR_ERROR', 'Circular Error cause');
    seen.add(error);
  }
  const result = {
    name: truncate(error?.name ?? 'Error', 80),
    message: truncate(error?.message ?? String(error ?? 'Unknown error'), MAX_ERROR_MESSAGE),
    code: truncate(error?.code ?? 'UNKNOWN', 100),
  };
  if (error?.stack) result.stack = truncate(error.stack, MAX_ERROR_STACK);
  if (error?.cause != null) result.cause = serializeCause(error.cause, depth, seen);
  return result;
}

export function safeError(error) {
  const serialized = serializeError(error);
  return { name: serialized.name, code: serialized.code, message: serialized.message };
}
