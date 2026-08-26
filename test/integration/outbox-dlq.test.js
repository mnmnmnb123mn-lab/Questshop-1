import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { processOutbox } from '../../src/workers/outbox-worker.js';
import { createContext } from '../../src/shared/correlation.js';
import { replayDeadLetter, discardDeadLetter } from '../../src/domain/outbox/dlq-service.js';
import { acquireDelivery, recordDelivery, enqueueProjection } from '../../src/domain/outbox/service.js';
import { reconcileSurfaceAnchors, setupSurface } from '../../src/discord/surfaces/setup.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

async function activeReceiver(traceId) {
  const current = (await pool.query("SELECT id FROM receiver_versions WHERE state='ACTIVE' LIMIT 1")).rows[0];
  if (current) return current.id;
  const id = uuidv7();
  const version = Number((await pool.query('SELECT COALESCE(max(version),0)+1 AS version FROM receiver_versions')).rows[0].version);
  await pool.query(`INSERT INTO receiver_versions(id,version,encrypted_phone,encryption_key_version,
    nonce,auth_tag,phone_last4,state,actor_id,trace_id)
    VALUES($1,$2,$3,1,$4,$5,'1234','ACTIVE','owner',$6)`,
  [id, version, Buffer.alloc(10), Buffer.alloc(12), Buffer.alloc(16), traceId]);
  return id;
}

async function createTopupStatusDmFixture({ status = 'PAYMENT_QUEUED' } = {}) {
  const traceId = uuidv7();
  const receiverId = await activeReceiver(traceId);
  const topupId = uuidv7();
  const discordUserId = `dm-topup-${topupId}`;
  const projectionId = uuidv7();
  const eventId = uuidv7();
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,trace_id)
    VALUES($1,$2,$3,1,$4,$5,'1234',$6)`,
  [topupId, discordUserId, status, Buffer.from(topupId), receiverId, traceId]);
  await pool.query(`INSERT INTO message_projections(id,projection_type,aggregate_id,surface_key,nonce)
    VALUES($1,'TOPUP_STATUS_DM',$2,$3,$4)`,
  [projectionId, topupId, `DM:${discordUserId}`, `topup-dm-${topupId.slice(0, 12)}`]);
  await pool.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,aggregate_version,
    projection_id,projection_version,state,trace_id)
    VALUES($1,'TOPUP_STATUS_DM','TOPUP',$2,1,$3,1,'PENDING',$4)`,
  [eventId, topupId, projectionId, traceId]);
  return { traceId, topupId, discordUserId, projectionId, eventId };
}

test('outbox exhausts bounded retries into schema-valid DLQ evidence', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const projection = uuidv7(); const event = uuidv7(); const trace = uuidv7();
  await pool.query(`INSERT INTO surfaces(surface_key,guild_id,channel_id,message_id,state)
    VALUES('QUEST_NEW','guild','channel','anchor','ACTIVE') ON CONFLICT(surface_key) DO UPDATE SET
      guild_id=EXCLUDED.guild_id,channel_id=EXCLUDED.channel_id,message_id=EXCLUDED.message_id,state='ACTIVE'`);
  await pool.query("UPDATE feature_gates SET enabled=true WHERE gate='QUEST_ANNOUNCEMENT_ENABLED'");
  await pool.query(`INSERT INTO message_projections(id,projection_type,aggregate_id,surface_key,nonce)
    VALUES($1,'QUEST_OPERATION','quest-x','QUEST_NEW','nonce-x')`, [projection]);
  await pool.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,aggregate_version,
    projection_id,state,attempt_count,trace_id) VALUES($1,'REFRESH_PROJECTION','QUEST','quest-x',1,$2,'PENDING',6,$3)`,
  [event, projection, trace]);
  const client = { channels: { fetch: async () => { throw Object.assign(new Error('network down'), { code: 'NETWORK' }); } } };
  assert.equal(await processOutbox({ holder: uuidv7(), client, pool, env: {} }), true);
  const outbox = (await pool.query('SELECT * FROM outbox_events WHERE id=$1', [event])).rows[0];
  assert.equal(outbox.state, 'DEAD_LETTER');
  const dlq = (await pool.query("SELECT * FROM dead_letter_items WHERE source_type='OUTBOX' AND source_id=$1", [event])).rows[0];
  assert.equal(dlq.state, 'DEAD_LETTER');
  assert.equal(dlq.error_code, 'NETWORK');
  const context = createContext({ actorType: 'OWNER', actorId: 'owner', guildId: 'guild',
    idempotencyKey: 'replay-dlq' });
  const replay = await replayDeadLetter({ dlqId: dlq.id, reason: 'provider recovered' }, context, { pool });
  let acquired;
  for (let index = 0; index < 3; index += 1) {
    const holder = uuidv7();
    acquired = await acquireDelivery({ holder }, { pool });
    assert.ok(acquired);
    await recordDelivery({ outboxId: acquired.id, holder, fencingToken: acquired.fencing_token,
      messageId: `replayed-message-${index}` }, { pool });
    if (acquired.id === replay.replayOutboxId) break;
  }
  assert.equal(acquired.id, replay.replayOutboxId);
  assert.equal((await pool.query('SELECT state FROM dead_letter_items WHERE id=$1', [dlq.id])).rows[0].state, 'RESOLVED');
  const forbiddenProjection = uuidv7(); const forbiddenEvent = uuidv7();
  await pool.query(`INSERT INTO message_projections(id,projection_type,aggregate_id,surface_key,nonce)
    VALUES($1,'QUEST_OPERATION','quest-forbidden','QUEST_NEW','nonce-forbidden')`, [forbiddenProjection]);
  await pool.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,aggregate_version,
    projection_id,state,trace_id) VALUES($1,'REFRESH_PROJECTION','QUEST','quest-forbidden',1,$2,'PENDING',$3)`,
  [forbiddenEvent, forbiddenProjection, uuidv7()]);
  const forbiddenClient = { channels: { fetch: async () => {
    throw Object.assign(new Error('Missing Permissions'), { status: 403, code: 50013 });
  } } };
  assert.equal(await processOutbox({ holder: uuidv7(), client: forbiddenClient, pool, env: {} }), true);
  assert.equal((await pool.query('SELECT state FROM outbox_events WHERE id=$1', [forbiddenEvent])).rows[0].state,
    'DEAD_LETTER');
  assert.equal((await pool.query("SELECT state FROM surfaces WHERE surface_key='QUEST_NEW'")).rows[0].state,
    'ACTIVE');
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM incidents
    WHERE incident_code='DISCORD_SURFACE_FORBIDDEN' AND scope='QUEST_NEW' AND state='OPEN'`)).rows[0].count), 1);
});

test('financial DLQ cannot be discarded', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const id = uuidv7();
  await pool.query(`INSERT INTO dead_letter_items(id,source_type,source_id,category,state,error_code,
    parent_trace_id) VALUES($1,'PAYMENT','topup-x','FINANCIAL','DEAD_LETTER','AMBIGUOUS',$2)`, [id, uuidv7()]);
  const context = createContext({ actorType: 'OWNER', actorId: 'owner', guildId: 'guild',
    idempotencyKey: 'discard-financial' });
  await assert.rejects(() => discardDeadLetter({ dlqId: id, reason: 'never allowed', isOwner: true },
    context, { pool }), (error) => error.code === 'DLQ_DISCARD_FORBIDDEN');
});

test('final order DM is attempted once and a DM failure never retries or dead-letters it', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const orderId = uuidv7();
  const projectionId = uuidv7();
  const firstEvent = uuidv7();
  const trace = uuidv7();
  await pool.query(`INSERT INTO orders(id,discord_user_id,account_id,trace_id,completed_at)
    VALUES($1,'dm-customer','dm-account',$2,clock_timestamp())`, [orderId, trace]);
  await pool.query(`INSERT INTO message_projections(id,projection_type,aggregate_id,surface_key,nonce)
    VALUES($1,'ORDER_DM',$2,'DM:dm-customer',$3)`, [projectionId, orderId, `dm-${orderId.slice(0, 16)}`]);
  await pool.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,aggregate_version,
    projection_id,state,trace_id) VALUES($1,'REFRESH_PROJECTION','ORDER',$2,1,$3,'PENDING',$4)`,
  [firstEvent, orderId, projectionId, trace]);
  let fetches = 0;
  const client = { users: { fetch: async () => {
    fetches += 1;
    throw Object.assign(new Error('DM disabled'), { status: 403, code: 50007 });
  } } };
  assert.equal(await processOutbox({ holder: uuidv7(), client, pool, env: {} }), true);
  assert.equal(fetches, 1);
  assert.equal((await pool.query('SELECT state FROM outbox_events WHERE id=$1', [firstEvent])).rows[0].state,
    'DELIVERED');
  assert.ok((await pool.query('SELECT dm_summary_attempted_at FROM orders WHERE id=$1', [orderId]))
    .rows[0].dm_summary_attempted_at);
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM dead_letter_items
    WHERE source_id=$1`, [firstEvent])).rows[0].count), 0);

  const secondEvent = uuidv7();
  await pool.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,aggregate_version,
    projection_id,state,trace_id) VALUES($1,'REFRESH_PROJECTION','ORDER',$2,2,$3,'PENDING',$4)`,
  [secondEvent, orderId, projectionId, trace]);
  assert.equal(await processOutbox({ holder: uuidv7(), client, pool, env: {} }), true);
  assert.equal(fetches, 1);
  assert.equal((await pool.query('SELECT state FROM outbox_events WHERE id=$1', [secondEvent])).rows[0].state,
    'DELIVERED');
});

test('disabled Top-up DM retries all backoff slots before Financial DLQ without changing money', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const fixture = await createTopupStatusDmFixture();
  let fetches = 0;
  const disabledClient = { users: { fetch: async () => {
    fetches += 1;
    throw Object.assign(new Error('DM disabled'), { status: 403, code: 50007 });
  } } };
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    assert.equal(await processOutbox({ holder: uuidv7(), client: disabledClient, pool, env: {} }), true);
    const event = (await pool.query('SELECT state FROM outbox_events WHERE id=$1', [fixture.eventId])).rows[0];
    assert.equal(event.state, 'RETRY_WAIT', `attempt ${attempt}`);
    assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM dead_letter_items
      WHERE source_id=$1`, [fixture.eventId])).rows[0].count), 0);
    await pool.query('UPDATE outbox_events SET available_at=clock_timestamp() WHERE id=$1', [fixture.eventId]);
  }
  assert.equal(await processOutbox({ holder: uuidv7(), client: disabledClient, pool, env: {} }), true);
  assert.equal(fetches, 7);
  assert.equal((await pool.query('SELECT state FROM outbox_events WHERE id=$1', [fixture.eventId])).rows[0].state,
    'DEAD_LETTER');
  assert.equal((await pool.query(`SELECT category,state FROM dead_letter_items WHERE source_id=$1`, [fixture.eventId]))
    .rows[0].category, 'FINANCIAL');
  assert.equal((await pool.query('SELECT status FROM topups WHERE id=$1', [fixture.topupId])).rows[0].status,
    'PAYMENT_QUEUED');
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM wallet_transactions
    WHERE reference_type='TOPUP' AND reference_id=$1`, [fixture.topupId])).rows[0].count), 0);
});

test('Top-up DM recovery coalesces a retry and edits the same message with the latest state', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const fixture = await createTopupStatusDmFixture();
  const disabledClient = { users: { fetch: async () => {
    throw Object.assign(new Error('DM disabled'), { status: 403, code: 50007 });
  } } };
  assert.equal(await processOutbox({ holder: uuidv7(), client: disabledClient, pool, env: {} }), true);
  assert.equal((await pool.query('SELECT state FROM outbox_events WHERE id=$1', [fixture.eventId])).rows[0].state,
    'RETRY_WAIT');

  const context = createContext({ traceId: fixture.traceId, actorType: 'SYSTEM', actorId: 'test',
    guildId: 'guild', idempotencyKey: `topup-dm-recover:${fixture.topupId}` });
  const processing = (await pool.query(`UPDATE topups SET status='PROCESSING',state_version=state_version+1,
    updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [fixture.topupId])).rows[0];
  await enqueueProjection(pool, { projectionType: 'TOPUP_STATUS_DM', aggregateType: 'TOPUP',
    aggregateId: fixture.topupId, aggregateVersion: processing.state_version,
    surfaceKey: `DM:${fixture.discordUserId}`, topic: 'TOPUP_STATUS_DM', context });
  assert.equal((await pool.query('SELECT state FROM outbox_events WHERE id=$1', [fixture.eventId])).rows[0].state,
    'DELIVERED');

  let sends = 0; let edits = 0;
  const message = { id: 'topup-status-message', edit: async (body) => {
    edits += 1;
    assert.deepEqual(body.attachments, []);
    assert.equal(body.files.length, 1);
    return message;
  } };
  const channel = { isTextBased: () => true, send: async (body) => {
    sends += 1;
    assert.deepEqual(body.attachments, []);
    assert.equal(body.files.length, 1);
    return message;
  }, messages: { fetch: async (input) => input.message ? message : [] } };
  const enabledClient = { users: { fetch: async () => ({ createDM: async () => channel }) } };
  const renderer = async () => ({ embeds: [], attachments: [], files: [{ attachment: Buffer.from('banner'), name: 'banner.webp' }],
    allowedMentions: { parse: [] } });
  assert.equal(await processOutbox({ holder: uuidv7(), client: enabledClient, pool, env: {},
    renderProjectionFunction: renderer }), true);
  const createdProjection = (await pool.query('SELECT message_id FROM message_projections WHERE id=$1',
    [fixture.projectionId])).rows[0];
  assert.equal(createdProjection.message_id, message.id);

  const credited = (await pool.query(`UPDATE topups SET status='CREDITED',state_version=state_version+1,
    amount_cents=5000,currency='THB',credited_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=$1 RETURNING *`, [fixture.topupId])).rows[0];
  await enqueueProjection(pool, { projectionType: 'TOPUP_STATUS_DM', aggregateType: 'TOPUP',
    aggregateId: fixture.topupId, aggregateVersion: credited.state_version,
    surfaceKey: `DM:${fixture.discordUserId}`, topic: 'TOPUP_STATUS_DM', context });
  assert.equal(await processOutbox({ holder: uuidv7(), client: enabledClient, pool, env: {},
    renderProjectionFunction: renderer }), true);
  assert.equal(sends, 1);
  assert.equal(edits, 1);
  assert.equal((await pool.query('SELECT message_id FROM message_projections WHERE id=$1', [fixture.projectionId]))
    .rows[0].message_id, message.id);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM dead_letter_items
    WHERE source_id=$1`, [fixture.eventId])).rows[0].count), 0);
});

test('Discord 404 reconciles only the affected surface and 429 honors Retry-After', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7();
  await pool.query(`INSERT INTO surfaces(surface_key,guild_id,channel_id,message_id,state)
    VALUES('LOG_SYSTEM','guild','missing-channel','anchor','ACTIVE') ON CONFLICT(surface_key) DO UPDATE SET
      channel_id=EXCLUDED.channel_id,message_id=EXCLUDED.message_id,state='ACTIVE'`);
  const missingProjection = uuidv7();
  const missingEvent = uuidv7();
  await pool.query(`INSERT INTO message_projections(id,projection_type,aggregate_id,surface_key,nonce)
    VALUES($1,'SYSTEM_INCIDENT',$2,'LOG_SYSTEM',$3)`, [missingProjection, `missing-${missingEvent}`, `nonce-${missingEvent.slice(0, 16)}`]);
  await pool.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,aggregate_version,
    projection_id,state,trace_id) VALUES($1,'REFRESH_PROJECTION','INCIDENT',$2,1,$3,'PENDING',$4)`,
  [missingEvent, `missing-${missingEvent}`, missingProjection, trace]);
  const missingClient = { channels: { fetch: async () => null } };
  assert.equal(await processOutbox({ holder: uuidv7(), client: missingClient, pool, env: {} }), true);
  assert.equal((await pool.query("SELECT state FROM surfaces WHERE surface_key='LOG_SYSTEM'")).rows[0].state, 'RECONCILING');
  assert.equal((await pool.query('SELECT state FROM outbox_events WHERE id=$1', [missingEvent])).rows[0].state, 'RETRY_WAIT');

  await pool.query("UPDATE surfaces SET state='ACTIVE' WHERE surface_key='LOG_SYSTEM'");
  const throttledProjection = uuidv7();
  const throttledEvent = uuidv7();
  await pool.query(`INSERT INTO message_projections(id,projection_type,aggregate_id,surface_key,nonce)
    VALUES($1,'SYSTEM_INCIDENT',$2,'LOG_SYSTEM',$3)`, [throttledProjection, `throttle-${throttledEvent}`, `nonce-${throttledEvent.slice(0, 16)}`]);
  await pool.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,aggregate_version,
    projection_id,state,trace_id) VALUES($1,'REFRESH_PROJECTION','INCIDENT',$2,1,$3,'PENDING',$4)`,
  [throttledEvent, `throttle-${throttledEvent}`, throttledProjection, trace]);
  const throttledClient = { channels: { fetch: async () => {
    throw Object.assign(new Error('rate limited'), { status: 429, retryAfter: 60 });
  } } };
  assert.equal(await processOutbox({ holder: uuidv7(), client: throttledClient, pool, env: {} }), true);
  const throttled = (await pool.query(`SELECT state,EXTRACT(EPOCH FROM available_at-clock_timestamp()) AS delay
    FROM outbox_events WHERE id=$1`, [throttledEvent])).rows[0];
  assert.equal(throttled.state, 'RETRY_WAIT');
  assert.ok(Number(throttled.delay) >= 59);
  // The test intentionally leaves both retry paths queued. Mark them done
  // after asserting their state so later cases always acquire their own event.
  await pool.query("UPDATE outbox_events SET state='DELIVERED',lease_owner=NULL,lease_expires_at=NULL WHERE id = ANY($1::uuid[])",
    [[missingEvent, throttledEvent]]);
});

test('delivery coalesces obsolete outbox events for the same Discord message', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'SYSTEM', actorId: 'worker', guildId: 'guild',
    idempotencyKey: 'projection-coalesce' });
  await pool.query(`INSERT INTO surfaces(surface_key,guild_id,channel_id,message_id,state)
    VALUES('LOG_SYSTEM','guild','channel','anchor','ACTIVE') ON CONFLICT(surface_key) DO UPDATE SET state='ACTIVE'`);
  const first = await enqueueProjection(pool, { projectionType: 'SYSTEM_INCIDENT', aggregateType: 'INCIDENT',
    aggregateId: 'coalesce-incident', aggregateVersion: 1, surfaceKey: 'LOG_SYSTEM', context });
  await enqueueProjection(pool, { projectionType: 'SYSTEM_INCIDENT', aggregateType: 'INCIDENT',
    aggregateId: 'coalesce-incident', aggregateVersion: 2, surfaceKey: 'LOG_SYSTEM', context });
  const holder = uuidv7();
  const acquired = await acquireDelivery({ holder }, { pool });
  assert.ok(acquired);
  assert.equal(acquired.projection_id, first.id);
  await recordDelivery({ outboxId: acquired.id, holder, fencingToken: acquired.fencing_token,
    messageId: 'coalesced-message' }, { pool });
  const events = (await pool.query(`SELECT state FROM outbox_events WHERE projection_id=$1 ORDER BY aggregate_version`,
    [first.id])).rows;
  assert.deepEqual(events.map((event) => event.state), ['DELIVERED', 'DELIVERED']);
});

test('an old outbox delivery holder cannot acknowledge after a newer projection fence is acquired', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const projection = uuidv7();
  const event = uuidv7();
  const trace = uuidv7();
  await pool.query(`INSERT INTO message_projections(id,projection_type,aggregate_id,surface_key,nonce)
    VALUES($1,'SYSTEM_INCIDENT',$2,'LOG_SYSTEM',$3)`, [projection, `fence-${event}`, `nonce-${event.slice(0, 16)}`]);
  await pool.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,aggregate_version,
    projection_id,state,trace_id) VALUES($1,'REFRESH_PROJECTION','INCIDENT',$2,1,$3,'PENDING',$4)`,
  [event, `fence-${event}`, projection, trace]);
  const firstHolder = uuidv7();
  const first = await acquireDelivery({ holder: firstHolder }, { pool });
  assert.equal(first.id, event);

  // Simulate a process pause past both leases. A different worker must get a
  // new event and projection fence, after which the old worker cannot commit.
  await pool.query(`UPDATE outbox_events SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [event]);
  await pool.query(`UPDATE message_projections SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [projection]);
  const secondHolder = uuidv7();
  const second = await acquireDelivery({ holder: secondHolder }, { pool });
  assert.equal(second.id, event);
  assert.ok(BigInt(second.state_version) > BigInt(first.state_version));
  assert.ok(BigInt(second.fencing_token) > BigInt(first.fencing_token));
  assert.ok(BigInt(second.projection_fencing_token) > BigInt(first.projection_fencing_token));

  const stale = await recordDelivery({ outboxId: event, holder: firstHolder,
    fencingToken: first.fencing_token, messageId: 'stale-message' }, { pool });
  assert.equal(stale, null);
  assert.equal((await pool.query('SELECT state FROM outbox_events WHERE id=$1', [event])).rows[0].state, 'LEASED');
  await recordDelivery({ outboxId: event, holder: secondHolder,
    fencingToken: second.fencing_token, messageId: 'current-message' }, { pool });
  const delivered = (await pool.query('SELECT state FROM outbox_events WHERE id=$1', [event])).rows[0];
  assert.equal(delivered.state, 'DELIVERED');
  assert.equal((await pool.query('SELECT message_id FROM message_projections WHERE id=$1', [projection])).rows[0].message_id,
    'current-message');
  const transitions = (await pool.query(`SELECT from_state,to_state FROM state_transitions
    WHERE aggregate_type='OUTBOX_EVENT' AND aggregate_id=$1 ORDER BY created_at`, [event])).rows;
  assert.deepEqual(transitions, [
    { from_state: 'PENDING', to_state: 'LEASED' },
    { from_state: 'LEASED', to_state: 'DELIVERED' },
  ]);
});

test('quest-new role ping is durable and is not repeated when the message is recreated', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const projection = uuidv7();
  const trace = uuidv7();
  await pool.query(`INSERT INTO config_versions(id,version,payload,payload_hash,actor_type,actor_id,trace_id)
    VALUES($1,1,$2,'hash','OWNER','owner',$3)`, [uuidv7(), { questAnnouncementRoleId: '123456789012345678' }, trace]);
  await pool.query(`INSERT INTO surfaces(surface_key,guild_id,channel_id,message_id,state)
    VALUES('QUEST_NEW','guild','channel','anchor','ACTIVE') ON CONFLICT(surface_key) DO UPDATE SET
      guild_id=EXCLUDED.guild_id,channel_id=EXCLUDED.channel_id,message_id=EXCLUDED.message_id,state='ACTIVE'`);
  await pool.query("UPDATE feature_gates SET enabled=true WHERE gate='QUEST_ANNOUNCEMENT_ENABLED'");
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,url)
    VALUES('quest-ping','SUPPORTED','OPEN','Ping Quest','WATCH_VIDEO',60,'https://discord.com/quests/quest-ping')`);
  await pool.query(`INSERT INTO message_projections(id,projection_type,aggregate_id,surface_key,nonce)
    VALUES($1,'QUEST_NEW','quest-ping','QUEST_NEW','nonce-ping')`, [projection]);
  await pool.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,aggregate_version,
    projection_id,state,trace_id) VALUES($1,'REFRESH_PROJECTION','QUEST','quest-ping',1,$2,'PENDING',$3)`,
  [uuidv7(), projection, trace]);
  const sent = [];
  const channel = { isTextBased: () => true, messages: { fetch: async () => null },
    send: async (body) => { sent.push(body); return { id: `message-${sent.length}` }; } };
  const client = { channels: { fetch: async () => channel } };
  assert.equal(await processOutbox({ holder: uuidv7(), client, pool, env: {} }), true);
  assert.equal(sent[0].content, '<@&123456789012345678>');
  const delivered = (await pool.query('SELECT * FROM message_projections WHERE id=$1', [projection])).rows[0];
  assert.ok(delivered.ping_sent_at);

  await pool.query(`UPDATE message_projections SET message_id=NULL,desired_version=desired_version+1 WHERE id=$1`, [projection]);
  await pool.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,aggregate_version,
    projection_id,state,trace_id) VALUES($1,'REFRESH_PROJECTION','QUEST','quest-ping',2,$2,'PENDING',$3)`,
  [uuidv7(), projection, trace]);
  assert.equal(await processOutbox({ holder: uuidv7(), client, pool, env: {} }), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].content, undefined);
  assert.deepEqual(sent[1].allowedMentions, { parse: [] });
});

test('payment log delivers without a channel privacy preflight', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const projection = uuidv7(); const event = uuidv7(); const trace = uuidv7(); const topupId = uuidv7();
  await pool.query(`INSERT INTO surfaces(surface_key,guild_id,channel_id,message_id,state)
    VALUES('LOG_PAYMENTS','guild','payments-channel','anchor','ACTIVE')
    ON CONFLICT(surface_key) DO UPDATE SET channel_id=EXCLUDED.channel_id,state='ACTIVE'`);
  await pool.query(`INSERT INTO message_projections(id,projection_type,aggregate_id,surface_key,nonce)
    VALUES($1,'PAYMENT_LOG',$2,'LOG_PAYMENTS',$3)`, [projection, topupId, `payment-${event.slice(0, 16)}`]);
  await pool.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,aggregate_version,
    projection_id,state,trace_id) VALUES($1,'REFRESH_PROJECTION','TOPUP',$2,1,$3,'PENDING',$4)`,
  [event, topupId, projection, trace]);
  let rendered = 0; const sent = [];
  const channel = {
    isTextBased: () => true,
    messages: { fetch: async () => null },
    send: async (body) => { sent.push(body); return { id: 'payment-log-message' }; },
  };
  const client = {
    channels: { fetch: async () => channel },
  };
  assert.equal(await processOutbox({ holder: uuidv7(), client, pool,
    env: { DISCORD_GUILD_ID: 'guild', OWNER_ID: 'owner' },
    renderProjectionFunction: async () => { rendered += 1; return { content: 'payment-log' }; } }), true);
  assert.equal(rendered, 1);
  assert.equal(sent.length, 1);
  assert.equal((await pool.query('SELECT state FROM outbox_events WHERE id=$1', [event])).rows[0].state, 'DELIVERED');
  assert.equal((await pool.query("SELECT state FROM surfaces WHERE surface_key='LOG_PAYMENTS'")).rows[0].state, 'ACTIVE');
});

test('surface reconciliation refreshes existing anchors after config version changes', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  await pool.query("UPDATE surfaces SET state='DISABLED' WHERE surface_key<>'QUEST_AUTO'");
  await pool.query("DELETE FROM surfaces WHERE surface_key='QUEST_AUTO'");
  await pool.query(`INSERT INTO surfaces(surface_key,guild_id,channel_id,message_id,state,rendered_config_version)
    VALUES('QUEST_AUTO','guild','channel','anchor','ACTIVE',1)`);
  const edits = [];
  const message = { id: 'anchor', edit: async (body) => { edits.push(body); return message; } };
  const channel = { isTextBased: () => true, isDMBased: () => false,
    messages: { fetch: async (input) => (input?.message === 'anchor' ? message : []) } };
  const guild = { channels: { fetch: async () => channel } };
  const client = { guilds: { fetch: async () => guild } };
  const context = createContext({ actorType: 'SYSTEM', actorId: 'runtime', guildId: 'guild',
    idempotencyKey: 'surface-refresh' });
  const result = await reconcileSurfaceAnchors({ client, pool,
    env: { DISCORD_GUILD_ID: 'guild' }, config: { version: 2,
      values: { branding: { title: 'ชื่อใหม่', description: 'รายละเอียดใหม่' } } } }, context);
  assert.equal(edits.length, 1);
  assert.equal(result[0].refreshed, true);
  const surface = (await pool.query("SELECT * FROM surfaces WHERE surface_key='QUEST_AUTO'")).rows[0];
  assert.equal(Number(surface.rendered_config_version), 2);
});

test('surface reconciliation persists a replacement when an anchor disappears during refresh', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  await pool.query("UPDATE surfaces SET state='DISABLED' WHERE surface_key<>'QUEST_AUTO'");
  await pool.query(`INSERT INTO surfaces(surface_key,guild_id,channel_id,message_id,state,rendered_config_version)
    VALUES('QUEST_AUTO','guild','channel','deleted-anchor','RECONCILING',1)
    ON CONFLICT(surface_key) DO UPDATE SET guild_id=EXCLUDED.guild_id,channel_id=EXCLUDED.channel_id,
      message_id=EXCLUDED.message_id,state=EXCLUDED.state,rendered_config_version=EXCLUDED.rendered_config_version`);
  const deleted = { id: 'deleted-anchor', edit: async () => {
    throw Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 });
  } };
  const replacement = { id: 'replacement-anchor' };
  const channel = { isTextBased: () => true, isDMBased: () => false,
    messages: { fetch: async (input) => (input?.message === 'deleted-anchor' ? deleted : []) },
    send: async () => replacement };
  const guild = { channels: { fetch: async () => channel } };
  const client = { guilds: { fetch: async () => guild } };
  const context = createContext({ actorType: 'SYSTEM', actorId: 'runtime', guildId: 'guild',
    idempotencyKey: 'surface-refresh-replacement' });
  const result = await reconcileSurfaceAnchors({ client, pool,
    env: { DISCORD_GUILD_ID: 'guild' }, config: { version: 2, values: {} } }, context);
  assert.equal(result[0].recreated, true);
  const surface = (await pool.query("SELECT * FROM surfaces WHERE surface_key='QUEST_AUTO'")).rows[0];
  assert.equal(surface.message_id, 'replacement-anchor');
  assert.equal(Number(surface.rendered_config_version), 2);
});

test('setup reuses an anchor, moves it atomically, and records old-anchor cleanup failure', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  await pool.query("UPDATE surfaces SET state='DISABLED' WHERE surface_key<>'QUEST_AUTO'");
  await pool.query("DELETE FROM surfaces WHERE surface_key='QUEST_AUTO'");
  const created = { id: 'setup-anchor', edit: async (body) => { created.edits.push(body); return created; }, edits: [] };
  const firstChannel = {
    id: 'setup-first', isTextBased: () => true, isDMBased: () => false,
    client: { user: { id: 'bot' } }, messages: { fetch: async () => [] }, send: async () => created,
  };
  const context = createContext({ actorType: 'OWNER', actorId: 'owner', guildId: 'guild',
    idempotencyKey: 'setup-anchor' });
  const firstInteraction = {
    guildId: 'guild', user: { id: 'owner' }, channel: firstChannel,
    options: { getChannel: () => firstChannel }, guild: { channels: { fetch: async () => firstChannel } },
  };
  await setupSurface({ interaction: firstInteraction, surfaceKey: 'QUEST_AUTO', config: { version: 1, values: {} } }, context, { pool });
  assert.equal((await pool.query("SELECT message_id FROM surfaces WHERE surface_key='QUEST_AUTO'")).rows[0].message_id, 'setup-anchor');

  const replacement = { id: 'setup-replacement', edit: async () => replacement };
  const secondChannel = {
    id: 'setup-second', isTextBased: () => true, isDMBased: () => false,
    client: { user: { id: 'bot' } }, messages: { fetch: async () => [] }, send: async () => replacement,
  };
  const oldChannel = {
    isTextBased: () => true,
    messages: { fetch: async () => { throw Object.assign(new Error('Missing Permissions'), { status: 403, code: 50013 }); } },
  };
  const moveInteraction = {
    guildId: 'guild', user: { id: 'owner' }, channel: secondChannel,
    options: { getChannel: () => secondChannel }, guild: { channels: { fetch: async () => oldChannel } },
  };
  await setupSurface({ interaction: moveInteraction, surfaceKey: 'QUEST_AUTO', config: { version: 2, values: {} } }, context, { pool });
  const moved = (await pool.query("SELECT channel_id,message_id FROM surfaces WHERE surface_key='QUEST_AUTO'")).rows[0];
  assert.deepEqual(moved, { channel_id: 'setup-second', message_id: 'setup-replacement' });
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM incidents
    WHERE incident_code='DISCORD_SURFACE_RECONCILE_FAILED' AND scope='QUEST_AUTO'`)).rows[0].count), 1);
});
