import { once } from 'node:events';
import { Events, PermissionFlagsBits } from 'discord.js';
import { loadRuntimeEnvironment } from '../config/env.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { acquireSingleInstanceLock, closeSqliteDatabase, openSqliteDatabase, quickIntegrityCheck } from '../db/sqlite.js';
import { createDiscordClient } from '../discord/client.js';
import { routeInteraction } from '../discord/interactions/router.js';
import { createLogger } from '../shared/logger.js';
import { createSqliteWorkers } from '../workers/sqlite-worker-manager.js';
import { closeHealthServer, createHealthState, startHealthServer } from './health-server.js';

export async function waitForDiscordReady(client) {
  if (!client.isReady()) await once(client, Events.ClientReady);
}

async function assertBotAdministrator(client, guildId) {
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetchMe();
  if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
    const error = new Error('Questshop bot must have Discord Administrator permission');
    error.code = 'DISCORD_BOT_ADMIN_REQUIRED';
    throw error;
  }
}

function assertIntegrity(db) {
  const checked = quickIntegrityCheck(db);
  if (!checked.ok) {
    const error = new Error('SQLite quick integrity check failed');
    error.code = 'SQLITE_INTEGRITY_FAILED';
    error.details = checked;
    throw error;
  }
}

export async function startup({ health = createHealthState(), server: existingServer = null,
  onRuntimePrepared = null, onRuntimeLeaseLost = null, signal: startupSignal = null } = {}) {
  const env = loadRuntimeEnvironment();
  const logger = createLogger({ gitSha: env.GIT_SHA });
  const server = existingServer ?? await startHealthServer({ port: env.PORT,
    statusToken: env.STATUS_TOKEN, state: health });
  let db;
  let client;
  let workers;
  let instanceLock;
  let runtime;
  try {
    instanceLock = await acquireSingleInstanceLock(env.SQLITE_PATH, { onLost: async (error) => {
      health.checks.runtimeLease = 'LOST';
      health.ready = false;
      health.lastError = error;
      runtime?.abortController.abort(error);
      await onRuntimeLeaseLost?.(error);
    } });
    db = await openSqliteDatabase({ databasePath: env.SQLITE_PATH, secret: env.QUESTSHOP_SECRET_KEY });
    assertIntegrity(db);
    health.checks.database = 'OK';
    health.checks.schema = 'OK';
    health.checks.keyrings = 'OK';
    health.checks.runtimeLease = 'SINGLE_INSTANCE';
    const config = loadRuntimeConfig(db);
    runtime = { env, logger, health, server, db, instanceLock, config, client: null, workers: null,
      acceptingInteractions: false, abortController: new AbortController(), shutdownPromise: null };
    if (startupSignal) {
      if (startupSignal.aborted) runtime.abortController.abort(startupSignal.reason);
      else startupSignal.addEventListener('abort', () => runtime.abortController.abort(startupSignal.reason), { once: true });
    }
    client = createDiscordClient();
    client.questshop = runtime;
    client.on('interactionCreate', routeInteraction);
    client.on('error', (error) => logger.error({ error }, 'discord client error'));
    await client.login(env.DISCORD_BOT_TOKEN);
    await waitForDiscordReady(client);
    await assertBotAdministrator(client, env.DISCORD_GUILD_ID);
    runtime.client = client;
    health.checks.discord = 'OK';
    workers = createSqliteWorkers({ runtime });
    runtime.workers = workers;
    await onRuntimePrepared?.(runtime);
    workers.start();
    runtime.acceptingInteractions = true;
    health.ready = true;
    health.live = true;
    health.status = 'READY';
    health.checks.bootstrap = 'READY';
    logger.info({ sqlitePath: env.SQLITE_PATH, guildId: env.DISCORD_GUILD_ID }, 'Questshop SQLite runtime ready');
    return runtime;
  } catch (error) {
    health.ready = false;
    health.live = false;
    health.status = 'NOT_READY';
    health.lastError = error;
    await workers?.stop?.().catch(() => null);
    await client?.destroy?.().catch(() => null);
    closeSqliteDatabase(db);
    await instanceLock?.release?.().catch(() => null);
    await closeHealthServer(server).catch(() => null);
    throw error;
  }
}
