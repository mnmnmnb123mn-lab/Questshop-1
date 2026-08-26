import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { ModalBuilder, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { createTestPool } from '../fixtures/postgres.js';
import { customId, parseCustomId } from '../../src/discord/components/custom-id.js';
import {
  ROUTE_HANDLERS, authorizeRoute, formatInteractionError, interactionMatchesContract, routeInteraction,
} from '../../src/discord/interactions/router.js';
import { ADMIN, CUSTOMER, OWNER, ROUTE_CONTRACTS, routeContract } from '../../src/discord/interactions/contracts.js';
import {
  advanceAdminSession,
  bindRenderedSessionMessages,
  bindSessionMessage,
  createAdminSession,
  loadAdminSession,
  terminateAdminSession,
} from '../../src/domain/admin/session-service.js';
import { createContext } from '../../src/shared/correlation.js';
import { QuestshopError } from '../../src/shared/errors.js';
import { expireSessions } from '../../src/domain/checkout/service.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

function memberPermissions(...permissions) {
  return new PermissionsBitField(permissions).freeze();
}

test('component custom IDs are versioned opaque and reject forged input', () => {
  const value = customId('quest_confirm');
  assert.ok(value.length <= 100);
  assert.equal(parseCustomId(value).route, 'quest_confirm');
  assert.equal(parseCustomId('qs:v2:quest_confirm:not-a-session'), null);
  assert.equal(parseCustomId('qs:v1:../../admin:00000000-0000-0000-0000-000000000000'), null);
});

test('every persistent route has an explicit audience and valid interaction contract', () => {
  assert.deepEqual(Object.keys(ROUTE_CONTRACTS).sort(), Object.keys(ROUTE_HANDLERS).sort());
  for (const [route, definition] of Object.entries(ROUTE_CONTRACTS)) {
    assert.ok([CUSTOMER, ADMIN, OWNER].includes(definition.access), `${route} has an audience`);
    assert.ok(['BUTTON', 'STRING_SELECT', 'USER_SELECT', 'MODAL_SUBMIT'].includes(definition.interaction), `${route} has interaction type`);
    assert.ok(['REPLY', 'UPDATE', 'MODAL'].includes(definition.response), `${route} has acknowledgement shape`);
  }
  assert.equal(routeContract('payment_review_pick').access, ADMIN);
  assert.equal(routeContract('orders_page').access, ADMIN);
  assert.equal(routeContract('topup_review_credit').access, OWNER);
  assert.equal(routeContract('admin_refresh_overview').access, ADMIN);
});

test('a forged custom ID cannot change a route component type', () => {
  const button = {
    isButton: () => true,
    isStringSelectMenu: () => false,
    isUserSelectMenu: () => false,
    isModalSubmit: () => false,
  };
  assert.equal(interactionMatchesContract(button, ROUTE_CONTRACTS.quest_confirm.interaction), true);
  assert.equal(interactionMatchesContract(button, ROUTE_CONTRACTS.payment_review_pick.interaction), false);
  assert.equal(interactionMatchesContract(button, ROUTE_CONTRACTS.voucher_submit.interaction), false);
});

test('backoffice route stays available when customer store gates are closed', async () => {
  const runtime = {
    env: { PRELAUNCH: false, OWNER_ID: 'owner' },
    config: { values: {}, gates: {
      STORE_OPEN: false, CUSTOMER_INTERACTIONS_ENABLED: false, TOPUP_ACCEPTING: false, ORDER_ACCEPTING: false,
    } },
    pool: { query: async () => ({ rows: [] }) },
  };
  const admin = {
    user: { id: 'admin' }, memberPermissions: memberPermissions(PermissionFlagsBits.Administrator),
    isButton: () => false,
  };
  await assert.doesNotReject(() => authorizeRoute(admin, { route: 'payment_review_pick' }, runtime));
  await assert.rejects(() => authorizeRoute(admin, { route: 'topup_review_credit' }, runtime),
    (error) => error.code === 'OWNER_ONLY');
});

test('a legacy configured role cannot grant backoffice access without Discord Administrator', async () => {
  const runtime = {
    env: { PRELAUNCH: false, OWNER_ID: 'owner' },
    config: { values: { adminRoleId: 'legacy-admin-role' }, gates: {} },
    pool: { query: async () => ({ rows: [] }) },
  };
  const legacyRoleMember = {
    user: { id: 'legacy-admin' },
    member: { roles: { cache: { has: () => true } } },
    memberPermissions: memberPermissions(),
    isButton: () => false,
  };
  await assert.rejects(() => authorizeRoute(legacyRoleMember, { route: 'payment_review_pick' }, runtime),
    (error) => error.code === 'ADMIN_ONLY');
});

test('interaction errors expose only safe business copy and a bounded support code', () => {
  const internal = new Error('password=not-for-customer postgresql://user:password@db.example/questshop');
  const rendered = formatInteractionError(internal, '123456789012345678');
  assert.match(rendered, /เกิดข้อผิดพลาดภายใน/);
  assert.doesNotMatch(rendered, /postgresql:|password=/i);
  assert.ok(rendered.length <= 2_000);
  const safe = formatInteractionError(new QuestshopError('STORE_CLOSED', 'ร้านปิดชั่วคราว'), '123456789012345678');
  assert.match(safe, /ร้านปิดชั่วคราว/);
  const invalid = formatInteractionError(new TypeError('internal parser detail'), '123456789012345678');
  assert.match(invalid, /ข้อมูลที่กรอกไม่ถูกต้อง/);
  assert.doesNotMatch(invalid, /internal parser detail/);
});

test('a route acknowledgement is sent before its first slow database operation', async () => {
  let releaseQuery;
  const calls = [];
  const queryStarted = new Promise((resolve) => { releaseQuery = resolve; });
  const runtime = {
    acceptingInteractions: true,
    env: { PRELAUNCH: false, OWNER_ID: 'owner', DISCORD_GUILD_ID: 'guild' },
    config: { values: {}, gates: { STORE_OPEN: true, CUSTOMER_INTERACTIONS_ENABLED: true,
      TOPUP_ACCEPTING: true, ORDER_ACCEPTING: true } },
    health: { workers: {}, startedAt: new Date().toISOString() },
    logger: { debug: () => {}, info: () => {}, error: () => {} },
    pool: { query: async () => { await queryStarted; return { rows: [] }; } },
  };
  const interaction = {
    id: '123456789012345678', customId: customId('monitor_list'), user: { id: 'owner' }, guildId: 'guild', channelId: 'channel',
    client: { questshop: runtime, isReady: () => true }, member: { roles: { cache: { has: () => true } } },
    inGuild: () => true, isChatInputCommand: () => false, isButton: () => true,
    isStringSelectMenu: () => false, isUserSelectMenu: () => false, isModalSubmit: () => false,
    deferUpdate: async () => { calls.push('deferUpdate'); }, editReply: async () => { calls.push('editReply'); },
  };
  const running = routeInteraction(interaction);
  await setImmediate();
  assert.deepEqual(calls, ['deferUpdate']);
  releaseQuery();
  await running;
  assert.deepEqual(calls, ['deferUpdate', 'editReply']);
});

test('router awaits handler failures and returns a safe ephemeral error instead of timing out', async () => {
  const replies = [];
  const runtime = {
    acceptingInteractions: true,
    env: { PRELAUNCH: false, OWNER_ID: 'owner', DISCORD_GUILD_ID: 'guild' },
    config: { values: {}, gates: { STORE_OPEN: true, CUSTOMER_INTERACTIONS_ENABLED: true,
      TOPUP_ACCEPTING: true, ORDER_ACCEPTING: true } },
    health: { workers: {}, startedAt: new Date().toISOString() },
    logger: { debug: () => {}, info: () => {}, error: () => {} },
    pool: { query: async (sql) => {
      if (String(sql).includes('FROM surfaces')) return { rows: [{ guild_id: 'guild', channel_id: 'channel', message_id: 'panel' }] };
      return { rows: [] };
    } },
  };
  const interaction = {
    id: '123456789012345678', customId: customId('admin'), user: { id: 'owner' }, guildId: 'guild', channelId: 'channel',
    message: { id: 'panel' }, values: ['not-a-real-category'], client: { questshop: runtime, isReady: () => true },
    member: { roles: { cache: { has: () => true } } },
    inGuild: () => true, isChatInputCommand: () => false, isButton: () => false,
    isStringSelectMenu: () => true, isUserSelectMenu: () => false, isModalSubmit: () => false,
    deferReply: async () => {}, editReply: async (payload) => { replies.push(payload); return { id: 'reply' }; },
  };
  await assert.doesNotReject(() => routeInteraction(interaction));
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /ไม่พบหมวด/);
});

test('pricing route sends an intact ModalBuilder and prepares its durable session', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  let receivedModal;
  const replies = [];
  const runtime = {
    acceptingInteractions: true,
    env: { PRELAUNCH: false, OWNER_ID: 'owner', DISCORD_GUILD_ID: 'guild' },
    config: { version: 1, values: {}, gates: { STORE_OPEN: true, CUSTOMER_INTERACTIONS_ENABLED: true,
      TOPUP_ACCEPTING: true, ORDER_ACCEPTING: true } },
    health: { workers: {}, startedAt: new Date().toISOString() },
    logger: { debug: () => {}, info: () => {}, error: () => {} },
    pool,
  };
  const interaction = {
    id: '123456789012345680', customId: customId('price_category_pick'), values: ['GAME'],
    user: { id: 'owner' }, guildId: 'guild', channelId: 'channel', message: { id: 'pricing-panel' },
    client: { questshop: runtime, isReady: () => true }, member: { roles: { cache: { has: () => true } } },
    inGuild: () => true, isChatInputCommand: () => false, isButton: () => false,
    isStringSelectMenu: () => true, isUserSelectMenu: () => false, isModalSubmit: () => false,
    showModal: async (modal) => {
      receivedModal = modal;
      return modal.toJSON();
    },
    reply: async (payload) => { replies.push(payload); },
  };

  await assert.doesNotReject(() => routeInteraction(interaction));
  assert.ok(receivedModal instanceof ModalBuilder);
  const modalData = receivedModal.toJSON();
  const route = parseCustomId(modalData.custom_id);
  assert.equal(route.route, 'price_category_submit');
  assert.equal(modalData.components[0].type, 18);
  assert.deepEqual(replies, []);

  await runtime.pendingModalPreparations?.get(route.sessionId)?.promise;
  const session = (await pool.query('SELECT * FROM interaction_sessions WHERE id=$1', [route.sessionId])).rows[0];
  assert.equal(session?.operation, 'PRICE_CATEGORY_PREPARE');
  assert.equal(session?.actor_id, 'owner');
});

test('Owner role configuration modal contains only the Quest announcement role', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  let receivedModal;
  const runtime = {
    acceptingInteractions: true,
    env: { PRELAUNCH: false, OWNER_ID: 'owner', DISCORD_GUILD_ID: 'guild' },
    config: { version: 1, values: { adminRoleId: 'legacy-role' }, gates: {} },
    health: { workers: {}, startedAt: new Date().toISOString() },
    logger: { debug: () => {}, info: () => {}, error: () => {} },
    pool,
  };
  const interaction = {
    id: '123456789012345681', customId: customId('config_quest_role'),
    user: { id: 'owner' }, guildId: 'guild', channelId: 'channel', message: { id: 'overview-panel' },
    client: { questshop: runtime }, memberPermissions: memberPermissions(),
    inGuild: () => true, isChatInputCommand: () => false, isButton: () => true,
    isStringSelectMenu: () => false, isUserSelectMenu: () => false, isModalSubmit: () => false,
    showModal: async (modal) => { receivedModal = modal; return modal.toJSON(); },
    reply: async () => {},
  };

  await assert.doesNotReject(() => routeInteraction(interaction));
  const modalData = receivedModal.toJSON();
  const modalRoute = parseCustomId(modalData.custom_id);
  assert.equal(modalRoute.route, 'config_quest_role_submit');
  assert.match(JSON.stringify(modalData), /quest_role/);
  assert.doesNotMatch(JSON.stringify(modalData), /admin_role/);
  let session;
  for (let attempt = 0; attempt < 20 && !session; attempt += 1) {
    await setImmediate();
    session = (await pool.query('SELECT * FROM interaction_sessions WHERE id=$1', [modalRoute.sessionId])).rows[0];
  }
  assert.equal(session?.operation, 'CONFIG_QUEST_ROLE');
});

test('unknown components always receive an expiry response', async () => {
  const replies = [];
  const runtime = {
    acceptingInteractions: true, env: { DISCORD_GUILD_ID: 'guild', OWNER_ID: 'owner' }, config: { values: {}, gates: {} },
    health: { workers: {}, startedAt: new Date().toISOString() }, logger: { debug: () => {}, info: () => {}, error: () => {} },
    pool: { query: async () => ({ rows: [] }) },
  };
  const interaction = {
    id: '123456789012345679', customId: 'legacy-panel-button', user: { id: 'owner' }, guildId: 'guild', channelId: 'channel',
    client: { questshop: runtime }, inGuild: () => true, isChatInputCommand: () => false,
    isButton: () => true, isStringSelectMenu: () => false, isUserSelectMenu: () => false, isModalSubmit: () => false,
    reply: async (payload) => { replies.push(payload); return { id: 'reply' }; },
  };
  await routeInteraction(interaction);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /รุ่นเก่าหรือหมดอายุ/);
});

test('pre-launch keeps customer routes limited to Owner or Admin even when UAT gates are open', async () => {
  const runtime = {
    env: { PRELAUNCH: true, OWNER_ID: 'owner' },
    config: { values: {} },
    pool: { query: async () => ({ rows: [
      { gate: 'STORE_OPEN', enabled: true }, { gate: 'CUSTOMER_INTERACTIONS_ENABLED', enabled: true },
      { gate: 'TOPUP_ACCEPTING', enabled: true },
    ] }) },
  };
  const customer = {
    user: { id: 'customer' }, memberPermissions: memberPermissions(),
    isButton: () => false,
  };
  await assert.rejects(() => authorizeRoute(customer, { route: 'payment_method' }, runtime),
    (error) => error.code === 'PRELAUNCH_RESTRICTED');

  const admin = {
    user: { id: 'admin' }, memberPermissions: memberPermissions(PermissionFlagsBits.Administrator),
    isButton: () => false,
  };
  const gates = await authorizeRoute(admin, { route: 'payment_method' }, runtime);
  assert.equal(gates.TOPUP_ACCEPTING, true);
});

test('Discord router delegates durable session state writes to domain services', async () => {
  const source = await readFile(new URL('../../src/discord/interactions/router.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /UPDATE\s+interaction_sessions/i);
  assert.doesNotMatch(source, /INSERT\s+INTO\s+(?:wallets|wallet_transactions|orders|order_items)/i);
  assert.doesNotMatch(source, /(?:block_add|catalog_sale|price_create|promo_create|admin_gate_pick)/);
  assert.match(source, /completeInteractionSession/);
  assert.match(source, /bindSessionMessage/);
});

test('server interaction session enforces actor guild channel operation and PostgreSQL expiry', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'ADMIN', actorId: 'actor-a', guildId: 'guild-a',
    idempotencyKey: 'session-security' });
  const session = await createAdminSession({ actorId: 'actor-a', guildId: 'guild-a',
    channelId: 'channel-a', messageId: 'message-a', operation: 'SECURITY_TEST',
    payload: { opaque: true }, configVersion: 1 }, context, { pool });
  assert.equal(session.trace_id, context.traceId);
  assert.equal((await loadAdminSession({ sessionId: session.id, actorId: 'actor-a', guildId: 'guild-a',
    channelId: 'channel-a', messageId: 'message-a', operation: 'SECURITY_TEST' }, context, { pool })).id, session.id);
  // Modal submit events do not reliably contain the source Message ID.  The
  // remaining durable bindings still apply when that ID is absent.
  assert.equal((await loadAdminSession({ sessionId: session.id, actorId: 'actor-a', guildId: 'guild-a',
    channelId: 'channel-a', operation: 'SECURITY_TEST' }, context, { pool })).id, session.id);
  await assert.rejects(() => loadAdminSession({ sessionId: session.id, actorId: 'actor-b',
    guildId: 'guild-a', channelId: 'channel-a', operation: 'SECURITY_TEST' }, context, { pool }),
  (error) => error.code === 'NOT_AUTHORIZED');
  await assert.rejects(() => loadAdminSession({ sessionId: session.id, actorId: 'actor-a',
    guildId: 'guild-a', channelId: 'channel-b', operation: 'SECURITY_TEST' }, context, { pool }),
  (error) => error.code === 'NOT_AUTHORIZED');
  await assert.rejects(() => loadAdminSession({ sessionId: session.id, actorId: 'actor-a',
    guildId: 'guild-a', channelId: 'channel-a', messageId: 'message-forged',
    operation: 'SECURITY_TEST' }, context, { pool }),
  (error) => error.code === 'NOT_AUTHORIZED');
  await pool.query("UPDATE interaction_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [session.id]);
  await assert.rejects(() => loadAdminSession({ sessionId: session.id, actorId: 'actor-a',
    guildId: 'guild-a', channelId: 'channel-a', operation: 'SECURITY_TEST' }, context, { pool }),
  (error) => error.code === 'SESSION_EXPIRED');
});

test('session message binding and terminal transition are domain-owned compare-and-swap operations', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'CUSTOMER', actorId: 'actor-a', guildId: 'guild-a',
    idempotencyKey: 'session-cas' });
  const session = await createAdminSession({ actorId: 'actor-a', guildId: 'guild-a',
    channelId: 'channel-a', messageId: null, operation: 'SESSION_CAS', payload: {}, configVersion: 1 },
  context, { pool });
  assert.equal(session.state, 'PENDING_BIND');
  const bound = await bindSessionMessage({ sessionId: session.id, actorId: 'actor-a', guildId: 'guild-a',
    messageId: 'reply-a', expectedVersion: session.state_version }, context, { pool });
  assert.equal(bound.message_id, 'reply-a');
  assert.equal(bound.state, 'ACTIVE');
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM state_transitions
    WHERE aggregate_type='INTERACTION_SESSION' AND aggregate_id=$1 AND from_state='PENDING_BIND'
      AND to_state='ACTIVE'`, [session.id])).rows[0].count), 1);
  await assert.rejects(() => bindSessionMessage({ sessionId: session.id, actorId: 'actor-a', guildId: 'guild-a',
    messageId: 'reply-b', expectedVersion: session.state_version }, context, { pool }),
  (error) => error.code === 'STALE_SESSION');
  const terminal = await terminateAdminSession({ sessionId: session.id, actorId: 'actor-a', guildId: 'guild-a',
    expectedVersion: bound.state_version }, context, { pool });
  assert.equal(terminal.state, 'TERMINAL');
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM state_transitions
    WHERE aggregate_type='INTERACTION_SESSION' AND aggregate_id=$1 AND to_state='TERMINAL'`, [session.id])).rows[0].count), 1);
  await assert.rejects(() => terminateAdminSession({ sessionId: session.id, actorId: 'actor-a', guildId: 'guild-a',
    expectedVersion: terminal.state_version }, context, { pool }), (error) => error.code === 'STALE_SESSION');
});

test('rendered replies bind every pending child session to the actual reply message once', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'ADMIN', actorId: 'actor-a', guildId: 'guild-a',
    idempotencyKey: 'session-render-bind' });
  const first = await createAdminSession({ actorId: 'actor-a', guildId: 'guild-a', channelId: 'channel-a',
    messageId: null, operation: 'FIRST', payload: {}, configVersion: 1 }, context, { pool });
  const second = await createAdminSession({ actorId: 'actor-a', guildId: 'guild-a', channelId: 'channel-a',
    messageId: null, operation: 'SECOND', payload: {}, configVersion: 1 }, context, { pool });
  const bound = await bindRenderedSessionMessages({ sessionIds: [first.id, second.id], actorId: 'actor-a',
    guildId: 'guild-a', messageId: 'ephemeral-message-id' }, context, { pool });
  assert.equal(bound.length, 2);
  assert.ok(bound.every((session) => session.state === 'ACTIVE' && session.message_id === 'ephemeral-message-id'));
  assert.equal((await bindRenderedSessionMessages({ sessionIds: [first.id, second.id], actorId: 'actor-a',
    guildId: 'guild-a', messageId: 'another-message' }, context, { pool })).length, 0);
});

test('admin session advances parent to terminal before creating one child session', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'ADMIN', actorId: 'actor-a', guildId: 'guild-a',
    idempotencyKey: 'session-advance' });
  const parent = await createAdminSession({ actorId: 'actor-a', guildId: 'guild-a', channelId: 'channel-a',
    messageId: 'message-a', operation: 'PARENT', payload: {}, configVersion: 1 }, context, { pool });
  const child = await advanceAdminSession({ parentSession: parent, actorId: 'actor-a', guildId: 'guild-a', child: {
    channelId: 'channel-a', messageId: 'message-a', operation: 'CHILD', payload: { selected: true }, configVersion: 1,
  } }, context, { pool });
  assert.equal(child.operation, 'CHILD');
  assert.equal((await pool.query('SELECT state FROM interaction_sessions WHERE id=$1', [parent.id])).rows[0].state, 'TERMINAL');
  await assert.rejects(() => advanceAdminSession({ parentSession: parent, actorId: 'actor-a', guildId: 'guild-a', child: {
    channelId: 'channel-a', operation: 'SECOND_CHILD', payload: {}, configVersion: 1,
  } }, context, { pool }), (error) => error.code === 'STALE_SESSION');
});

test('confirmed checkout sessions and their encrypted credentials are pruned after seven days', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'SYSTEM', actorId: 'retention', guildId: 'guild-a',
    idempotencyKey: 'confirmed-checkout-retention' });
  const sessionId = '019fc530-2000-7000-8000-000000000099';
  await pool.query(`INSERT INTO interaction_sessions(id,actor_id,guild_id,channel_id,operation,state,
    config_version,payload,trace_id,expires_at,updated_at) VALUES($1,'customer','guild-a','channel-a',
    'CHECKOUT','CONFIRMED',1,'{"accountId":"account-a"}',$2,clock_timestamp()-interval '8 days',
    clock_timestamp()-interval '8 days')`, [sessionId, context.traceId]);
  await pool.query(`INSERT INTO checkout_credentials(session_id,account_id,key_version,nonce,ciphertext,auth_tag)
    VALUES($1,'account-a',1,$2,$3,$4)`, [sessionId, Buffer.alloc(12), Buffer.from('encrypted'), Buffer.alloc(16)]);
  await expireSessions({}, context, { pool });
  assert.equal(Number((await pool.query('SELECT count(*)::integer AS count FROM interaction_sessions WHERE id=$1', [sessionId]))
    .rows[0].count), 0);
  assert.equal(Number((await pool.query('SELECT count(*)::integer AS count FROM checkout_credentials WHERE session_id=$1', [sessionId]))
    .rows[0].count), 0);
});

test('session expiration and retention are bounded to 500 rows per maintenance batch', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'SYSTEM', actorId: 'retention', guildId: 'guild-a',
    idempotencyKey: 'session-expiration-batch' });
  await pool.query(`INSERT INTO interaction_sessions(id,actor_id,guild_id,channel_id,operation,
    config_version,payload,trace_id,expires_at)
    SELECT gen_random_uuid(),'customer','guild-a','channel-a','CHECKOUT',1,'{}',$1,
      clock_timestamp()-interval '1 minute' FROM generate_series(1,501)`, [context.traceId]);
  assert.equal(await expireSessions({}, context, { pool }), 500);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM interaction_sessions
    WHERE state='ACTIVE' AND expires_at<=clock_timestamp()`)).rows[0].count), 1);
});
