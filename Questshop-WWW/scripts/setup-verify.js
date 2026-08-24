import '../src/config/load-local-environment.js';
import { loadEnvironment } from '../src/config/env.js';
import { verifyConfiguredSourceSha } from '../src/config/source-version.js';

// This command deliberately validates only local configuration. It never
// generates/replaces a secret, connects to Discord/TrueMoney, or prints a
// credential. Startup performs the database key-sentinel verification.
const env = loadEnvironment();
const source = verifyConfiguredSourceSha(env);
console.log(JSON.stringify({ ok: true, nodeEnv: env.NODE_ENV, guildIdConfigured: Boolean(env.DISCORD_GUILD_ID),
  backupMode: env.BACKUP_MODE, sourceSha: source.sourceSha, sourceShaVerified: source.verified, keyringVersions: {
    data: env.DATA_ENCRYPTION_KEYS_JSON.current, voucher: env.VOUCHER_HMAC_KEYS_JSON.current,
    backup: env.BACKUP_ENCRYPTION_KEYS_JSON?.current ?? null,
  } }));
