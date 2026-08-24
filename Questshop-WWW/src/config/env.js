import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/);
const booleanText = z.enum(['true', 'false']).transform((value) => value === 'true');
export const BACKUP_MODE = Object.freeze({
  AIVEN_MANAGED: 'AIVEN_MANAGED',
  LOCAL_S3: 'LOCAL_S3',
});
const keyringSchema = z.object({
  current: z.coerce.number().int().positive(),
  keys: z.record(z.string(), z.string().min(40)),
}).superRefine((value, ctx) => {
  if (!value.keys[String(value.current)]) {
    ctx.addIssue({ code: 'custom', message: 'current key version is missing from keys' });
  }
  for (const [version, encoded] of Object.entries(value.keys)) {
    let decoded;
    try {
      decoded = Buffer.from(encoded, 'base64');
    } catch {
      decoded = null;
    }
    if (!/^\d+$/.test(version) || decoded?.length !== 32) {
      ctx.addIssue({ code: 'custom', message: `key ${version} must be a 32-byte base64 value` });
    }
  }
});

function jsonKeyring(value, ctx) {
  try {
    return keyringSchema.parse(JSON.parse(value));
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: `invalid keyring: ${error.message}` });
    return z.NEVER;
  }
}

const environmentFields = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TIMEZONE: z.literal('Asia/Bangkok').default('Asia/Bangkok'),
  PRELAUNCH: booleanText.default('true'),
  DISCORD_BOT_TOKEN: z.string().min(20),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,
  OWNER_ID: snowflake,
  STATUS_TOKEN: z.string().min(32),
  DATABASE_POOL_URL: z.string().url(),
  DATABASE_DIRECT_URL: z.string().url(),
  BACKUP_MODE: z.enum([BACKUP_MODE.AIVEN_MANAGED, BACKUP_MODE.LOCAL_S3]).optional(),
  // BACKUP_ENABLED remains a compatibility switch for the legacy S3 backup
  // path. New installs use Aiven-managed backups by default.
  BACKUP_ENABLED: booleanText.optional(),
  DATABASE_BACKUP_URL: z.string().url().optional(),
  DATABASE_RESTORE_URL: z.string().url().optional(),
  DATABASE_SSL_CA_BASE64: z.string().min(1).optional(),
  PG_DUMP_PATH: z.string().min(1).default('pg_dump'),
  PG_RESTORE_PATH: z.string().min(1).default('pg_restore'),
  DATA_ENCRYPTION_KEYS_JSON: z.string().transform(jsonKeyring),
  VOUCHER_HMAC_KEYS_JSON: z.string().transform(jsonKeyring),
  BACKUP_ENCRYPTION_KEYS_JSON: z.string().optional().transform((value, ctx) => value == null ? undefined : jsonKeyring(value, ctx)),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).default('auto'),
  S3_BUCKET: z.string().min(3).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: booleanText.default('true'),
  RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(5).default(2),
  RUNNER_CONCURRENCY_HARD_MAX: z.coerce.number().int().min(1).max(5).default(5),
  GIT_SHA: z.string().min(1).default('unknown'),
  DISCORD_CLIENT_VERSION: z.string().regex(/^\d+(?:\.\d+)+$/).default('1.0.9267'),
  DISCORD_CHROME_VERSION: z.string().regex(/^\d+(?:\.\d+)+$/).default('138.0.7204.251'),
  DISCORD_ELECTRON_VERSION: z.string().regex(/^\d+(?:\.\d+)+$/).default('37.6.0'),
  DISCORD_BUILD_NUMBER: z.coerce.number().int().nonnegative().default(572700),
  DISCORD_NATIVE_BUILD_NUMBER: z.coerce.number().int().nonnegative().default(47491),
  DISCORD_LOCALE: z.string().min(2).max(20).default('en-US'),
};

const BACKUP_SETTING_KEYS = Object.freeze([
  'DATABASE_BACKUP_URL', 'S3_ENDPOINT', 'S3_BUCKET',
  'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'BACKUP_ENCRYPTION_KEYS_JSON',
]);

function addEnvironmentIssue(ctx, message, path) {
  ctx.addIssue({ code: 'custom', ...(path ? { path } : {}), message });
}

export function resolveBackupMode(value) {
  const hasCompleteLocalBackupConfiguration = BACKUP_SETTING_KEYS
    .every((key) => value[key] != null && value[key] !== '');
  return value.BACKUP_MODE ?? (value.BACKUP_ENABLED === true || hasCompleteLocalBackupConfiguration
    ? BACKUP_MODE.LOCAL_S3
    : BACKUP_MODE.AIVEN_MANAGED);
}

export function usesApplicationBackup(value) {
  return resolveBackupMode(value) === BACKUP_MODE.LOCAL_S3;
}

function validateRuntimeLimits(value, ctx) {
  if (value.RUNNER_CONCURRENCY > value.RUNNER_CONCURRENCY_HARD_MAX) {
    addEnvironmentIssue(ctx, 'RUNNER_CONCURRENCY exceeds hard max');
  }
  if (value.NODE_ENV === 'production' && !/^[0-9a-f]{40}$/i.test(value.GIT_SHA)) {
    addEnvironmentIssue(ctx, 'GIT_SHA must be the 40-character deployment commit SHA in production');
  }
}

function validateBackupSettings(value, ctx, { requireRestore }) {
  const backupMode = resolveBackupMode(value);
  if (value.BACKUP_MODE === BACKUP_MODE.AIVEN_MANAGED && value.BACKUP_ENABLED === true) {
    addEnvironmentIssue(ctx, 'BACKUP_MODE=AIVEN_MANAGED cannot be combined with BACKUP_ENABLED=true');
  }
  if (value.BACKUP_MODE === BACKUP_MODE.LOCAL_S3 && value.BACKUP_ENABLED === false) {
    addEnvironmentIssue(ctx, 'BACKUP_MODE=LOCAL_S3 cannot be combined with BACKUP_ENABLED=false');
  }
  if (backupMode === BACKUP_MODE.LOCAL_S3 && BACKUP_SETTING_KEYS.some((key) => value[key] == null || value[key] === '')) {
    addEnvironmentIssue(ctx, 'BACKUP_MODE=LOCAL_S3 requires backup database, S3 and encryption settings');
  }
  if (requireRestore && backupMode === BACKUP_MODE.LOCAL_S3 && !value.DATABASE_RESTORE_URL) {
    addEnvironmentIssue(ctx,
      'DATABASE_RESTORE_URL is required for deployment and restore-drill tooling with BACKUP_MODE=LOCAL_S3',
      ['DATABASE_RESTORE_URL']);
  }
  return backupMode;
}

function databaseUrlFields({ requireDirect, requireRestore, backupMode }) {
  return [
    'DATABASE_POOL_URL',
    ...(requireDirect ? ['DATABASE_DIRECT_URL'] : []),
    ...(backupMode === BACKUP_MODE.LOCAL_S3
      ? ['DATABASE_BACKUP_URL', ...(requireRestore ? ['DATABASE_RESTORE_URL'] : [])]
      : []),
  ];
}

function validateDatabaseTls(value, ctx, requirements) {
  for (const key of databaseUrlFields(requirements)) {
    if (!value[key]) continue;
    const url = new URL(value[key]);
    if (value.NODE_ENV === 'production' && url.searchParams.get('sslmode') !== 'verify-full') {
      addEnvironmentIssue(ctx, `${key} must use sslmode=verify-full`);
    }
  }
}

function refineEnvironment(value, ctx, { requireDirect, requireRestore }) {
  if (requireDirect && !value.DATABASE_DIRECT_URL) {
    addEnvironmentIssue(ctx, 'DATABASE_DIRECT_URL is required', ['DATABASE_DIRECT_URL']);
  }
  validateRuntimeLimits(value, ctx);
  const backupMode = validateBackupSettings(value, ctx, { requireRestore });
  validateDatabaseTls(value, ctx, { requireDirect, requireRestore, backupMode });
}

const schema = z.object(environmentFields)
  .superRefine((value, ctx) => refineEnvironment(value, ctx, { requireDirect: true, requireRestore: true }));
const {
  DATABASE_DIRECT_URL: _deploymentOnlyDatabaseUrl,
  DATABASE_RESTORE_URL: _disasterRecoveryOnlyDatabaseUrl,
  ...runtimeEnvironmentFields
} = environmentFields;
const runtimeSchema = z.object(runtimeEnvironmentFields)
  .superRefine((value, ctx) => refineEnvironment(value, ctx, { requireDirect: false, requireRestore: false }));

let cached;
let runtimeCached;

function withResolvedBackupMode(parsed) {
  return { ...parsed, BACKUP_MODE: resolveBackupMode(parsed) };
}

export function loadEnvironment(source = process.env) {
  if (source === process.env && cached) return cached;
  const parsed = withResolvedBackupMode(schema.parse(source));
  if (source === process.env) cached = Object.freeze(parsed);
  return parsed;
}

export function loadRuntimeEnvironment(source = process.env) {
  if (source === process.env && runtimeCached) return runtimeCached;
  const parsed = withResolvedBackupMode(runtimeSchema.parse(source));
  if (source === process.env) runtimeCached = Object.freeze(parsed);
  return parsed;
}

export function clearEnvironmentCacheForTests() {
  cached = undefined;
  runtimeCached = undefined;
}
