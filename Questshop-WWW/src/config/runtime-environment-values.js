// Only values the long-running runtime actually needs may be imported from a
// mounted .env or stateless secret bundle. Deployment and recovery credentials
// stay available to their one-shot commands, never to `npm start`.
export const RUNTIME_ENVIRONMENT_KEYS = Object.freeze(new Set([
  'NODE_ENV', 'PORT', 'TIMEZONE', 'PRELAUNCH',
  'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'OWNER_ID', 'STATUS_TOKEN',
  'DATABASE_POOL_URL', 'DATABASE_BACKUP_URL', 'DATABASE_SSL_CA_BASE64',
  'BACKUP_MODE', 'BACKUP_ENABLED', 'PG_DUMP_PATH', 'PG_RESTORE_PATH',
  'DATA_ENCRYPTION_KEYS_JSON', 'VOUCHER_HMAC_KEYS_JSON', 'BACKUP_ENCRYPTION_KEYS_JSON',
  'S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_FORCE_PATH_STYLE',
  'RUNNER_CONCURRENCY', 'RUNNER_CONCURRENCY_HARD_MAX', 'GIT_SHA',
  'DISCORD_CLIENT_VERSION', 'DISCORD_CHROME_VERSION', 'DISCORD_ELECTRON_VERSION',
  'DISCORD_BUILD_NUMBER', 'DISCORD_NATIVE_BUILD_NUMBER', 'DISCORD_LOCALE',
]));

export function runtimeEnvironmentValues(values) {
  if (!values) return null;
  const filtered = {};
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string') {
      throw new Error('Runtime environment source contains an invalid entry');
    }
    if (RUNTIME_ENVIRONMENT_KEYS.has(key)) filtered[key] = value;
  }
  return filtered;
}
