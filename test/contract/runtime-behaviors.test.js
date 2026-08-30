import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuestApiClient, profileFromEnv } from '../../src/quest-engine/api/client.js';
import { DiscordRateLimitCoordinator } from '../../src/quest-engine/rate-limits/coordinator.js';
import { normalizeQuest, normalizeQuestPayload } from '../../src/quest-engine/schema/normalizer.js';
import { extractQuestArray } from '../../src/quest-engine/schema/compatibility.js';
import { canonicalQuestContract, sameQuestContract } from '../../src/quest-engine/schema/contract.js';
import { fetchDiscordMessage, findDiscordMessage, findDiscordMessageByNonce, isMissingDiscordMessage } from '../../src/discord/transport.js';
import { redact, redactText, safeError, serializeError } from '../../src/shared/redaction.js';
import { loadEnvironment } from '../../src/config/env.js';
import { runtimeEnvironmentValues } from '../../src/config/runtime-environment-values.js';
import { decodeSecretBundle } from '../../src/config/secret-bundle.js';
import { inspectSourceSha } from '../../src/config/source-version.js';
import { createHealthState, closeHealthServer, startHealthServer } from '../../src/bootstrap/health-server.js';
import { runWorkerLoop } from '../../src/workers/loop.js';
import { allVoucherHmacs, decryptSecret, encryptSecret, hmacVoucher } from '../../src/adapters/crypto/keyring.js';
import { QuestCompatibilityError, assertQuestObject } from '../../src/quest-engine/schema/compatibility.js';
import { verifyConfiguredSourceSha } from '../../src/config/source-version.js';
import { assertQuestPriceCategory, questPriceCategoryForTaskType, taskTypesForQuestPriceCategory } from '../../src/domain/pricing/categories.js';
import { AuthorizationError, FencingLostError, StaleStateError } from '../../src/shared/errors.js';
import { assertAllowedQuestApiPath, discordQuestRequestPath, QUEST_ENDPOINT } from '../../src/quest-engine/api/endpoints.js';
import { secureJitter } from '../../src/shared/random.js';
import { hasAdministratorPermission, interactionMatchesContract, routeInteraction } from '../../src/discord/interactions/router.js';
import { customId } from '../../src/discord/components/custom-id.js';

const rawQuest = Object.freeze({
  id: 'quest-1',
  config: {
    starts_at: '2026-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z',
    messages: { quest_name: 'Quest test' }, application: { id: '42', icon: 'icon' },
    assets: { hero: 'hero.png', game_tile: 'tile.png' },
    rewards_config: { assignment_method: 2, rewards: [{ type: 4, orb_quantity: 10 }, { type: 4, orb_quantity: 20 }] },
    task_config_v2: { tasks: { WATCH_VIDEO: { event_name: 'WATCH_VIDEO', target: 60 } } },
  },
  user_status: { enrolled_at: '2026-01-01T00:00:00.000Z', progress: { WATCH_VIDEO: { value: 30 } } },
});

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

test('Quest normalizer and API client preserve the verified Quest contract', async () => {
  const normalized = normalizeQuest(rawQuest);
  assert.equal(normalized.progress, 50);
  assert.equal(normalized.orbReward.mode, 'TIERED');
  assert.equal(normalized.autoSupported, true);
  assert.equal(normalizeQuestPayload([rawQuest])[0].id, 'quest-1');
  assert.equal(extractQuestArray({ quests: [rawQuest] }).length, 1);
  assert.equal(canonicalQuestContract(normalized).questId, 'quest-1');
  assert.equal(sameQuestContract(normalized, { contractHash: normalized.contractHash }), true);

  const seen = [];
  const coordinator = new DiscordRateLimitCoordinator({ concurrency: 1 });
  const client = createQuestApiClient({ token: 'test-token', coordinator, profile: profileFromEnv({
    DISCORD_CLIENT_VERSION: '1.2.3', DISCORD_CHROME_VERSION: '2.3.4', DISCORD_ELECTRON_VERSION: '3.4.5',
    DISCORD_BUILD_NUMBER: 1, DISCORD_NATIVE_BUILD_NUMBER: 2, DISCORD_LOCALE: 'en-US',
  }), transport: async (request) => {
    seen.push(request);
    if (request.path === '/quests/@me') return response(200, { quests: [rawQuest] });
    return response(200, { id: 'me' });
  } });
  assert.equal((await client.fetchQuests())[0].id, 'quest-1');
  assert.deepEqual(await client.fetchCurrentUser(), { id: 'me' });
  await client.enroll('quest-1');
  await client.sendVideoProgress('quest-1', 12.8);
  await client.sendHeartbeat({ id: 'quest-1', applicationId: '42' }, true, true);
  assert.equal(seen.length, 5);
  assert.equal(coordinator.status().queued, 0);
});

test('runtime support helpers serve redacted status and stop a worker loop', async () => {
  assert.equal(isMissingDiscordMessage({ code: 10008 }), true);
  assert.equal(isMissingDiscordMessage({ status: 500 }), false);
  const pages = [[{ id: '2', nonce: 'no' }, { id: '1', nonce: 'yes' }]];
  const channel = { messages: { fetch: async () => ({ values: () => pages.shift().values() }) } };
  assert.equal((await findDiscordMessageByNonce(channel, 'yes')).id, '1');
  assert.equal(await fetchDiscordMessage({ messages: { fetch: async () => { throw { status: 404 }; } } }, 'gone'), null);
  assert.equal((await findDiscordMessage({ messages: { fetch: async () => [{ id: 'one' }] } }, (message) => message.id === 'one')).id, 'one');
  assert.match(redactText('token=secret https://gift.truemoney.com/campaign/?v=0123456789abcdef'), /REDACTED/);
  assert.equal(redact({ token: 'secret', nested: ['ok'] }).token, '[REDACTED]');
  const circular = {}; circular.self = circular;
  assert.equal(redact(circular).self, '[CIRCULAR]');
  assert.equal(serializeError(new Error('outer', { cause: new Error('inner') })).cause.name, 'Error');
  assert.equal(safeError(Object.assign(new Error('token=secret'), { code: 'FAIL' })).code, 'FAIL');
  assert.deepEqual(runtimeEnvironmentValues({ PORT: '3000', OTHER: 'ignored' }), { PORT: '3000' });
  assert.equal(decodeSecretBundle(null), null);
  assert.equal(inspectSourceSha({ execute: () => 'a'.repeat(40) }), 'a'.repeat(40));
  const env = loadEnvironment({ NODE_ENV: 'test', DISCORD_BOT_TOKEN: 'x'.repeat(20), DISCORD_CLIENT_ID: '1'.repeat(17),
    DISCORD_GUILD_ID: '2'.repeat(17), OWNER_ID: '3'.repeat(17), STATUS_TOKEN: 's'.repeat(32), QUESTSHOP_SECRET_KEY: 'k'.repeat(32) });
  assert.deepEqual(env.CREDENTIAL_ENCRYPTION_ALLOWED_VERSIONS, ['v1']);
  assert.throws(() => loadEnvironment({ ...env, NODE_ENV: 'production', GIT_SHA: undefined,
    CREDENTIAL_ENCRYPTION_ALLOWED_VERSIONS: 'v1' }), /GIT_SHA/);
  assert.throws(() => runtimeEnvironmentValues({ PORT: 3000 }), /invalid entry/);

  const state = createHealthState();
  const server = await startHealthServer({ port: 0, statusToken: 's'.repeat(32), state });
  const port = server.address().port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 503);
  state.ready = true;
  assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 200);
  await closeHealthServer(server);

  const controller = new AbortController();
  let runs = 0;
  await runWorkerLoop({ name: 'test', signal: controller.signal, idleMs: 1, health: { workers: {} }, logger: { error() {} }, runOnce: async () => {
    runs += 1; controller.abort(); return false;
  } });
  assert.equal(runs, 1);
});

test('runtime adapters reject incompatible input and use their documented fallbacks', async () => {
  assert.throws(() => assertQuestObject(null), QuestCompatibilityError);
  assert.throws(() => extractQuestArray({}), (error) => error.code === 'QUEST_PAYLOAD_NOT_ARRAY');
  const fallback = normalizeQuest({ id: 'fallback', config: { task_config: { tasks: { UNKNOWN: { target: 0 } } } } });
  assert.equal(fallback.contractComplete, false);

  let heartbeatCalls = 0;
  const client = createQuestApiClient({ token: 'fallback-token', profile: profileFromEnv({
    DISCORD_CLIENT_VERSION: '1.2.3', DISCORD_CHROME_VERSION: '2.3.4', DISCORD_ELECTRON_VERSION: '3.4.5',
    DISCORD_BUILD_NUMBER: 1, DISCORD_NATIVE_BUILD_NUMBER: 2, DISCORD_LOCALE: 'en-US',
  }), transport: async (request) => {
    if (request.path.includes('/heartbeat')) {
      heartbeatCalls += 1;
      return heartbeatCalls === 1 ? response(400, { message: 'stream payload rejected' }) : response(200, { ok: true });
    }
    return response(401, { message: 'bad token' });
  } });
  assert.deepEqual(await client.sendHeartbeat({ id: 'quest-1', applicationId: '42' }, false, false), { ok: true });
  assert.equal(heartbeatCalls, 2);
  await assert.rejects(client.fetchCurrentUser(), (error) => error.code === 'TOKEN_INVALID');

  const keyring = { current: 'v2', keys: { v1: Buffer.alloc(32, 1).toString('base64'), v2: Buffer.alloc(32, 2).toString('base64') } };
  const encrypted = encryptSecret('private', keyring, 'test');
  assert.equal(decryptSecret(encrypted, keyring, 'test'), 'private');
  assert.notEqual(hmacVoucher('voucher', keyring, 'v1'), hmacVoucher('voucher', keyring, 'v2'));
  assert.equal(allVoucherHmacs('voucher', { current: 2, keys: { 1: keyring.keys.v1, 2: keyring.keys.v2 } }).length, 2);
  assert.throws(() => decryptSecret({ ...encrypted, keyVersion: 'missing' }, keyring, 'test'), (error) => error.code === 'SECRET_DECRYPT_FAILED');
  assert.deepEqual(decodeSecretBundle(Buffer.from(JSON.stringify({ PORT: '3000' })).toString('base64url')), { PORT: '3000' });
  assert.throws(() => decodeSecretBundle('not-json'), /base64url/);
  assert.equal(verifyConfiguredSourceSha({ NODE_ENV: 'test', GIT_SHA: 'a'.repeat(40) }, { execute: () => 'a'.repeat(40) }).verified, true);
  assert.throws(() => verifyConfiguredSourceSha({ NODE_ENV: 'production' }, { execute: () => '' }), /Production requires/);
  assert.equal(assertQuestPriceCategory('video'), 'VIDEO');
  assert.equal(questPriceCategoryForTaskType('watch_video'), 'VIDEO');
  assert.equal(taskTypesForQuestPriceCategory('GAME').length, 2);
  assert.throws(() => assertQuestPriceCategory('unknown'), /invalid Quest/);
  assert.equal(new StaleStateError('ORDER', 'id').retryable, true);
  assert.equal(new AuthorizationError().code, 'NOT_AUTHORIZED');
  assert.equal(new FencingLostError('job').code, 'FENCING_LOST');
  assert.equal(assertAllowedQuestApiPath('/quests/quest-1/enroll'), '/quests/quest-1/enroll');
  assert.equal(discordQuestRequestPath(QUEST_ENDPOINT.videoProgress('quest-1')), '/api/v9/quests/quest-1/video-progress');
  assert.throws(() => assertAllowedQuestApiPath('https://example.test'), /unsafe Discord/);
  assert.equal(secureJitter(0), 0);
  assert.ok(secureJitter(2) >= 0);
});

test('persistent Admin routes re-check the current Discord Administrator permission', async () => {
  const runtime = { acceptingInteractions: true, env: { DISCORD_GUILD_ID: 'guild', OWNER_ID: 'owner' }, client: { guilds: { fetch: async () => ({ members: {
    fetch: async () => ({ permissions: { has: () => false } }),
  } }) } } };
  const interaction = { guildId: 'guild', user: { id: 'admin' }, customId: customId('admin_gate_toggle'),
    inGuild: () => true, isButton: () => true, isChatInputCommand: () => false };
  assert.equal(await hasAdministratorPermission(interaction, runtime), false);
  assert.equal(interactionMatchesContract(interaction, runtime), true);
  assert.equal(interactionMatchesContract({ ...interaction, isChatInputCommand: () => true, commandName: 'unknown' }, runtime), false);
  assert.equal(interactionMatchesContract({ ...interaction, guildId: 'other' }, runtime), false);
  runtime.client.guilds.fetch = async () => ({ members: { fetch: async () => ({ permissions: { has: () => true } }) } });
  assert.equal(await hasAdministratorPermission(interaction, runtime), true);
  runtime.client.guilds.fetch = async () => { throw new Error('Discord unavailable'); };
  assert.equal(await hasAdministratorPermission(interaction, runtime), false);

  // A copied financial component may have a valid opaque shape but no
  // server-side session. It must reach the route only far enough to reject
  // that authority; it cannot trigger a reversal or disclose details.
  runtime.client.guilds.fetch = async () => ({ members: { fetch: async () => ({ permissions: { has: () => true } }) } });
  const replies = [];
  const forged = { client: { questshop: runtime }, guildId: 'guild', channelId: 'channel', user: { id: 'owner' },
    customId: customId('admin_topup_reverse_confirm'), inGuild: () => true, isButton: () => true,
    isChatInputCommand: () => false, reply: async (payload) => { replies.push(payload); } };
  await routeInteraction(forged);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /ข้อมูลที่กรอกไม่ถูกต้อง/);
});

test('Owner setup commands also require current Discord Administrator permission', async () => {
  const replies = [];
  const runtime = { acceptingInteractions: true, env: { DISCORD_GUILD_ID: 'guild', OWNER_ID: 'owner' }, logger: { warn() {} },
    client: { guilds: { fetch: async () => ({ members: { fetch: async () => ({ permissions: { has: () => false } }) } }) } } };
  const interaction = { client: { questshop: runtime }, guildId: 'guild', user: { id: 'owner' }, commandName: 'quest-auto',
    inGuild: () => true, isChatInputCommand: () => true, reply: async (payload) => { replies.push(payload); },
    deferReply: async () => { throw new Error('setup must not start without current permission'); } };
  await routeInteraction(interaction);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /เฉพาะ Owner/);
});
