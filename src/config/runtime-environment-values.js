// Only values the long-running runtime actually needs may be imported from a
// mounted .env or stateless secret bundle. Deployment and recovery credentials
// stay available to their one-shot commands, never to `npm start`.
export const RUNTIME_ENVIRONMENT_KEYS = Object.freeze(new Set([
  'NODE_ENV', 'PORT', 'TIMEZONE', 'PRELAUNCH',
  'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'OWNER_ID', 'STATUS_TOKEN',
  'SQLITE_PATH', 'QUESTSHOP_SECRET_KEY', 'GIT_SHA',
  'VOUCHER_HMAC_ACTIVE_VERSION', 'CREDENTIAL_ENCRYPTION_ACTIVE_VERSION', 'CREDENTIAL_ENCRYPTION_ALLOWED_VERSIONS',
  'RUNNER_CONCURRENCY', 'RUNNER_CONCURRENCY_HARD_MAX',
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
