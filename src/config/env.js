import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/);
const booleanText = z.enum(['true', 'false']).transform((value) => value === 'true');

const fields = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TIMEZONE: z.literal('Asia/Bangkok').default('Asia/Bangkok'),
  PRELAUNCH: booleanText.default('true'),
  DISCORD_BOT_TOKEN: z.string().min(20),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,
  OWNER_ID: snowflake,
  STATUS_TOKEN: z.string().min(32),
  SQLITE_PATH: z.string().min(1).default('/data/questshop.db'),
  QUESTSHOP_SECRET_KEY: z.string().min(32),
  VOUCHER_HMAC_ACTIVE_VERSION: z.string().regex(/^v[0-9]+$/).default('v1'),
  CREDENTIAL_ENCRYPTION_ACTIVE_VERSION: z.string().regex(/^v[0-9]+$/).default('v1'),
  CREDENTIAL_ENCRYPTION_ALLOWED_VERSIONS: z.string().regex(/^v[0-9]+(?:,v[0-9]+)*$/).default('v1')
    .transform((value) => Object.freeze([...new Set(value.split(','))])),
  RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(5).default(1),
  RUNNER_CONCURRENCY_HARD_MAX: z.coerce.number().int().min(1).max(5).default(1),
  GIT_SHA: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
  DISCORD_CLIENT_VERSION: z.string().regex(/^\d+(?:\.\d+)+$/).default('1.0.9267'),
  DISCORD_CHROME_VERSION: z.string().regex(/^\d+(?:\.\d+)+$/).default('138.0.7204.251'),
  DISCORD_ELECTRON_VERSION: z.string().regex(/^\d+(?:\.\d+)+$/).default('37.6.0'),
  DISCORD_BUILD_NUMBER: z.coerce.number().int().nonnegative().default(572700),
  DISCORD_NATIVE_BUILD_NUMBER: z.coerce.number().int().nonnegative().default(47491),
  DISCORD_LOCALE: z.string().min(2).max(20).default('en-US'),
};

const schema = z.object(fields).superRefine((value, ctx) => {
  if (value.RUNNER_CONCURRENCY > value.RUNNER_CONCURRENCY_HARD_MAX) {
    ctx.addIssue({ code: 'custom', message: 'RUNNER_CONCURRENCY exceeds hard max' });
  }
  if (value.NODE_ENV === 'production' && !value.SQLITE_PATH.startsWith('/data/')) {
    ctx.addIssue({ code: 'custom', path: ['SQLITE_PATH'],
      message: 'production SQLITE_PATH must be located under /data' });
  }
  if (value.NODE_ENV === 'production' && !value.GIT_SHA) {
    ctx.addIssue({ code: 'custom', path: ['GIT_SHA'], message: 'production GIT_SHA is required' });
  }
});

let cached;

export function loadEnvironment(source = process.env) {
  if (source === process.env && cached) return cached;
  const parsed = schema.parse(source);
  if (source === process.env) cached = Object.freeze(parsed);
  return parsed;
}

export const loadRuntimeEnvironment = loadEnvironment;

export function clearEnvironmentCacheForTests() {
  cached = undefined;
}
