import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { reconcileIncident } from '../../src/domain/incidents/service.js';
import { reconcileSurfaceAnchors } from '../../src/discord/surfaces/setup.js';
import { enqueueProjection } from '../../src/domain/outbox/service.js';
import { evaluateAlerts, reconcileStabilizedIncident } from '../../src/workers/alert-worker.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

function context(key) {
  return createContext({ actorType: 'SYSTEM', actorId: 'test', guildId: 'guild', idempotencyKey: key });
}

test('a resolved incident reopens its latest row and durable LOG_SYSTEM projection', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  await pool.query(`INSERT INTO surfaces(surface_key,guild_id,channel_id,message_id,state)
    VALUES('LOG_SYSTEM','guild','system','message','ACTIVE')`);
  const first = await reconcileIncident({ code: 'LOG_TEST', scope: 'SYSTEM', active: true,
    severity: 'WARNING', evidence: { count: 1 } }, context('incident-open'), { pool });
  await reconcileIncident({ code: 'LOG_TEST', scope: 'SYSTEM', active: false,
    severity: 'WARNING', evidence: {} }, context('incident-resolve'), { pool });
  const reopened = await reconcileIncident({ code: 'LOG_TEST', scope: 'SYSTEM', active: true,
    severity: 'ERROR', evidence: { count: 2 } }, context('incident-reopen'), { pool });
  assert.equal(reopened.incident.id, first.incident.id);
  assert.equal(reopened.incident.state, 'OPEN');
  assert.equal(Number((await pool.query("SELECT count(*)::integer AS count FROM incidents WHERE incident_code='LOG_TEST' AND scope='SYSTEM'"))
    .rows[0].count), 1);
  assert.equal(Number((await pool.query("SELECT count(*)::integer AS count FROM message_projections WHERE projection_type='SYSTEM_INCIDENT'"))
    .rows[0].count), 1);
});

test('queued projection refreshes coalesce before delivery and retain the newest version', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const projection = await enqueueProjection(pool, { projectionType: 'SYSTEM_INCIDENT', aggregateType: 'INCIDENT',
    aggregateId: 'projection-test', aggregateVersion: 1, surfaceKey: 'DM:test-user', context: context('projection-1') });
  await enqueueProjection(pool, { projectionType: 'SYSTEM_INCIDENT', aggregateType: 'INCIDENT',
    aggregateId: 'projection-test', aggregateVersion: 2, surfaceKey: 'DM:test-user', context: context('projection-2') });
  const events = (await pool.query(`SELECT state,projection_version FROM outbox_events WHERE projection_id=$1
    ORDER BY projection_version`, [projection.id])).rows;
  assert.deepEqual(events.map((event) => event.state), ['DELIVERED', 'PENDING']);
  assert.deepEqual(events.map((event) => Number(event.projection_version)), [1, 2]);
});

test('one Discord connectivity incident groups simultaneous surface network failures', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  await pool.query(`INSERT INTO surfaces(surface_key,guild_id,channel_id,message_id,state) VALUES
    ('QUEST_NEW','guild','new','new-message','ACTIVE'),
    ('QUEST_HISTORY','guild','history','history-message','ACTIVE')`);
  const client = { guilds: { fetch: async () => ({ channels: { fetch: async () => {
    throw Object.assign(new Error('DNS unavailable'), { code: 'ENOTFOUND' });
  } } }) } };
  await reconcileSurfaceAnchors({ client, pool, env: { DISCORD_GUILD_ID: 'guild' }, config: { version: 1, values: {} } },
    context(`network-${uuidv7()}`));
  const incident = (await pool.query("SELECT * FROM incidents WHERE incident_code='DISCORD_CONNECTIVITY' AND scope='DISCORD'"))
    .rows[0];
  assert.deepEqual(incident.evidence.surfaces, ['LOG_SYSTEM', 'QUEST_HISTORY', 'QUEST_NEW']);
  assert.equal(Number((await pool.query("SELECT count(*)::integer AS count FROM incidents WHERE incident_code='DISCORD_SURFACE_RECONCILE_FAILED'"))
    .rows[0].count), 0);
});

test('operational alert stabilization needs two failures and three healthy samples', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const input = (active) => ({ code: 'STABILIZED_TEST', scope: 'DISCORD', active,
    severity: 'WARNING', evidence: { p95Ms: active ? 9_000 : 100 }, samples: 10, minimumSamples: 5 });
  await reconcileStabilizedIncident(pool, input(true));
  assert.equal(Number((await pool.query("SELECT count(*)::integer AS count FROM incidents WHERE incident_code='STABILIZED_TEST'"))
    .rows[0].count), 0);
  await reconcileStabilizedIncident(pool, input(true));
  assert.equal((await pool.query("SELECT state FROM incidents WHERE incident_code='STABILIZED_TEST'")).rows[0].state, 'OPEN');
  await reconcileStabilizedIncident(pool, input(false));
  await reconcileStabilizedIncident(pool, input(false));
  assert.equal((await pool.query("SELECT state FROM incidents WHERE incident_code='STABILIZED_TEST'")).rows[0].state, 'OPEN');
  await reconcileStabilizedIncident(pool, input(false));
  assert.equal((await pool.query("SELECT state FROM incidents WHERE incident_code='STABILIZED_TEST'")).rows[0].state, 'RESOLVED');
});

test('backlog repair preserves a lease, retains only the latest queued version, and records coalescing', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const projection = uuidv7();
  const leasedProjection = uuidv7();
  const loneLeaseProjection = uuidv7();
  const trace = uuidv7();
  await pool.query(`INSERT INTO message_projections(id,projection_type,aggregate_id,surface_key,nonce,desired_version) VALUES
    ($1,'SYSTEM_INCIDENT','backlog-a','DM:backlog-a','backlog-a',5),
    ($2,'SYSTEM_INCIDENT','backlog-b','DM:backlog-b','backlog-b',4),
    ($3,'SYSTEM_INCIDENT','backlog-c','DM:backlog-c','backlog-c',3)`, [projection, leasedProjection, loneLeaseProjection]);
  const insert = async (projectionId, state, version, seconds) => pool.query(`INSERT INTO outbox_events(
    id,topic,aggregate_type,aggregate_id,aggregate_version,projection_id,projection_version,state,available_at,trace_id,created_at
  ) VALUES($1,'REFRESH_PROJECTION','INCIDENT',$2,1,$3,$4,$5,clock_timestamp(),$6,clock_timestamp()-make_interval(secs=>$7))`,
  [uuidv7(), projectionId, projectionId, version, state, trace, seconds]);
  await insert(projection, 'PENDING', -1, 30);
  await insert(projection, 'RETRY_WAIT', -2, 10);
  await insert(leasedProjection, 'LEASED', -1, 30);
  await insert(leasedProjection, 'PENDING', -2, 10);
  await insert(loneLeaseProjection, 'LEASED', -1, 10);
  await pool.query(await readFile(new URL('../../migrations/0031_repair_outbox_projection_backlog.sql', import.meta.url), 'utf8'));
  const first = (await pool.query(`SELECT state,projection_version FROM outbox_events WHERE projection_id=$1 ORDER BY created_at`, [projection])).rows;
  assert.deepEqual(first.map((row) => row.state), ['DELIVERED', 'RETRY_WAIT']);
  assert.equal(Number(first[1].projection_version), 5);
  const leased = (await pool.query(`SELECT state,projection_version FROM outbox_events WHERE projection_id=$1 ORDER BY created_at`, [leasedProjection])).rows;
  assert.deepEqual(leased.map((row) => row.state), ['LEASED', 'PENDING']);
  assert.equal(Number(leased[1].projection_version), 4);
  const loneLease = (await pool.query('SELECT projection_version FROM outbox_events WHERE projection_id=$1', [loneLeaseProjection])).rows[0];
  assert.equal(Number(loneLease.projection_version), 3);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM state_transitions
    WHERE aggregate_type='OUTBOX_EVENT' AND reason_code='COALESCED_BY_NEWER_PROJECTION'`)).rows[0].count) >= 1, true);
});

test('operational incidents include the slowest routes and failure classes without customer input', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7();
  await pool.query(`INSERT INTO operation_metrics(id,operation,outcome,duration_ms,error_class,trace_id,route)
    SELECT gen_random_uuid(),'PANEL_REQUEST',CASE WHEN item<=5 THEN 'ERROR' ELSE 'SUCCESS' END,
      CASE WHEN item<=5 THEN 9000 ELSE 100 END,
      CASE WHEN item<=5 THEN 'DATABASE_TIMEOUT' ELSE NULL END,$1,
      CASE WHEN item<=5 THEN 'admin_panel' ELSE 'admin_refresh' END
    FROM generate_series(1,20) AS item`, [trace]);
  const health = { ready: true, checks: {}, workers: {} };
  await evaluateAlerts({ pool, health, env: { BACKUP_MODE: 'AIVEN_MANAGED' } });
  await evaluateAlerts({ pool, health, env: { BACKUP_MODE: 'AIVEN_MANAGED' } });
  const panel = (await pool.query("SELECT evidence FROM incidents WHERE incident_code='PANEL_LATENCY_SLO' AND scope='DISCORD'")).rows[0];
  const errors = (await pool.query("SELECT evidence FROM incidents WHERE incident_code='ERROR_RATE_HIGH' AND scope='OPERATIONS'")).rows[0];
  assert.equal(panel.evidence.topRoutes[0].route, 'admin_panel');
  assert.equal(errors.evidence.topFailures[0].errorClass, 'DATABASE_TIMEOUT');
  assert.equal(JSON.stringify({ ...panel.evidence, ...errors.evidence }).includes('customer input'), false);
});
