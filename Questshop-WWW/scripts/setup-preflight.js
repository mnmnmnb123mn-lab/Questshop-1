import '../src/config/load-local-environment.js';
import { loadEnvironment } from '../src/config/env.js';
import { getRuntimePool, closePools } from '../src/db/pools.js';
import { validateRuntimeRole } from '../src/db/role-contract.js';
import { validateKeyringCoverage } from '../src/bootstrap/keyring-coverage.js';
import { validateKeyringSentinels } from '../src/bootstrap/keyring-sentinels.js';
import { createDiscordClient } from '../src/discord/client.js';

// Read-only operational preflight. It deliberately does not register
// commands, change feature gates, touch a provider, or generate a secret.
const env = loadEnvironment();
const pool = getRuntimePool(env);
let client;
try {
  await pool.query('SELECT 1');
  await validateRuntimeRole(pool, { enforce: true });
  await validateKeyringCoverage(pool, env);
  await validateKeyringSentinels(pool, env);
  client = createDiscordClient();
  await client.login(env.DISCORD_BOT_TOKEN);
  const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);
  const me = await guild.members.fetchMe();
  if (!me.permissions.has('Administrator')) throw new Error('Questshop bot must have Discord Administrator permission');
  console.log(JSON.stringify({ ok: true, database: 'OK', runtimeRole: 'OK', keyrings: 'OK', discordAdministrator: true }));
} finally {
  client?.destroy();
  await closePools();
}
