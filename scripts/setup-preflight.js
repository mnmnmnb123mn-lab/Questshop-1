import '../src/config/load-local-environment.js';
import { loadEnvironment } from '../src/config/env.js';
import { acquireSingleInstanceLock, closeSqliteDatabase, ensureSqliteDirectory, quickIntegrityCheck, openSqliteDatabase } from '../src/db/sqlite.js';
import { assertRequiredSchema } from '../src/db/sqlite-migrations.js';
import { createDiscordClient } from '../src/discord/client.js';
import { PermissionFlagsBits } from 'discord.js';

const env = loadEnvironment();
await ensureSqliteDirectory(env.SQLITE_PATH);
const lock = await acquireSingleInstanceLock(env.SQLITE_PATH);
let db;
let client;
try {
  db = await openSqliteDatabase({ databasePath: env.SQLITE_PATH, secret: env.QUESTSHOP_SECRET_KEY });
  assertRequiredSchema(db);
  const integrity = quickIntegrityCheck(db);
  if (!integrity.ok) throw Object.assign(new Error('SQLite preflight integrity check failed'), { code: 'SQLITE_INTEGRITY_FAILED' });
  client = createDiscordClient();
  await client.login(env.DISCORD_BOT_TOKEN);
  const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);
  const member = await guild.members.fetchMe();
  if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
    throw Object.assign(new Error('Questshop bot must have Discord Administrator permission'), { code: 'DISCORD_ADMINISTRATOR_REQUIRED' });
  }
  console.log(JSON.stringify({ ok: true, sqlitePath: env.SQLITE_PATH, prelaunch: env.PRELAUNCH,
    gitSha: env.GIT_SHA ?? null, discordAdministrator: true }));
} finally {
  client?.destroy();
  closeSqliteDatabase(db);
  await lock.release();
}
