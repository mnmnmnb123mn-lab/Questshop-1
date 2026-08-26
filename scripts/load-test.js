import pg from 'pg';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  reserveOrderItems,
  captureReservation,
  releaseReservation,
} from '../src/domain/wallet/service.js';
import { acquireRunnableJob, renewRunnerJob } from '../src/domain/runner/service.js';
import { acquireDelivery } from '../src/domain/outbox/service.js';
import { createContext } from '../src/shared/correlation.js';

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

async function timed(work) {
  const started = performance.now();
  const result = await work();
  return { result, durationMs: performance.now() - started };
}

const urlText = process.env.LOAD_TEST_DATABASE_URL;
if (!urlText) throw new Error('LOAD_TEST_DATABASE_URL is required and must point to a disposable database');
const url = new URL(urlText);
if (!url.pathname.includes('questshop_loadtest')) throw new Error('Refusing load test: database name must contain questshop_loadtest');
const { Pool } = pg;
const pool = new Pool({ connectionString: urlText, max: 8 });
const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
const started = performance.now();
try {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, directory), 'utf8'));
  }
  const trace = randomUUID(); const rule = randomUUID();
  await pool.query(`INSERT INTO price_rules(id,rule_type,amount_cents,config_version,actor_id,trace_id)
    VALUES($1,'DEFAULT',500,1,'load-test',$2)`, [rule, trace]);
  await pool.query(`INSERT INTO wallets(discord_user_id,available_cents)
    SELECT 'load-user-'||n,100000 FROM generate_series(1,200) n`);
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,url,expires_at)
    SELECT 'load-quest-'||n,'SUPPORTED','OPEN','Load Quest '||n,'WATCH_VIDEO',60,
      'https://discord.com/quests/load-'||n,clock_timestamp()+interval '1 day' FROM generate_series(1,100) n`);
  await pool.query(`INSERT INTO orders(id,discord_user_id,account_id,trace_id)
    SELECT gen_random_uuid(),'load-user-'||n,'load-account-'||n,$1 FROM generate_series(1,100) n`, [trace]);
  await pool.query(`INSERT INTO order_items(id,order_id,sequence_number,quest_id,quest_name,task_type,
    price_cents,price_rule_id,config_version,metadata_revision,engine_version,executor_version,
    contract_version,runner_state_schema_version,state,deadline_at)
    SELECT gen_random_uuid(),o.id,1,'load-quest-'||row_number() OVER (ORDER BY o.id),
      'Load Quest','WATCH_VIDEO',500,$1,1,1,'1','1','1',1,'QUEUED',clock_timestamp()+interval '1 day'
    FROM orders o`, [rule]);
  await pool.query(`INSERT INTO scheduler_users(discord_user_id)
    SELECT discord_user_id FROM orders ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO runner_jobs(id,order_item_id,discord_user_id,account_id,state,deadline_at,
    engine_version,executor_version,contract_version,runner_state_schema_version,trace_id)
    SELECT gen_random_uuid(),i.id,o.discord_user_id,o.account_id,'QUEUED',i.deadline_at,'1','1','1',1,$1
    FROM order_items i JOIN orders o ON o.id=i.order_id`, [trace]);

  const contentionUser = 'load-contention-user';
  const contentionOrder = randomUUID();
  const contentionCount = 100;
  await pool.query(`INSERT INTO wallets(discord_user_id,available_cents)
    VALUES($1,$2) ON CONFLICT(discord_user_id) DO UPDATE SET available_cents=EXCLUDED.available_cents,
      reserved_cents=0,state_version=wallets.state_version+1`, [contentionUser, contentionCount * 1_000]);
  await pool.query(`INSERT INTO orders(id,discord_user_id,account_id,trace_id)
    VALUES($1,$2,$3,$4)`, [contentionOrder, contentionUser, 'load-contention-account', trace]);
  await pool.query(`INSERT INTO order_items(id,order_id,sequence_number,quest_id,quest_name,task_type,
    price_cents,price_rule_id,config_version,metadata_revision,engine_version,executor_version,
    contract_version,runner_state_schema_version,state,deadline_at)
    SELECT gen_random_uuid(),$1,n,'load-quest-'||n,'Contention Quest','WATCH_VIDEO',500,$2,1,1,'1','1','1',1,
      'SELECTED',clock_timestamp()+interval '1 day' FROM generate_series(1,$3) n`, [contentionOrder, rule, contentionCount]);
  const contentionItems = (await pool.query(`SELECT id FROM order_items WHERE order_id=$1 ORDER BY sequence_number`,
    [contentionOrder])).rows;
  const reservationTimings = await Promise.all(contentionItems.map((item, index) => timed(() => reserveOrderItems({
    discordUserId: contentionUser,
    items: [{ itemId: item.id, amountCents: 500 }],
  }, createContext({ actorType: 'SYSTEM', actorId: `load-reserver-${index}`, guildId: 'load-test',
    idempotencyKey: `load-reserve:${item.id}` }), { pool, maxAttempts: 10, deadlineMs: 30_000 }))));
  const contentionWallet = (await pool.query(
    'SELECT available_cents,reserved_cents FROM wallets WHERE discord_user_id=$1', [contentionUser],
  )).rows[0];
  if (BigInt(contentionWallet.available_cents) !== BigInt(contentionCount * 500)
    || BigInt(contentionWallet.reserved_cents) !== BigInt(contentionCount * 500)) {
    throw new Error('wallet contention invariant failed');
  }
  await pool.query(`UPDATE order_items SET state='SETTLING', state_version=state_version+1
    WHERE order_id=$1 AND sequence_number <= $2`, [contentionOrder, contentionCount / 2]);

  const settlementTimings = await Promise.all(contentionItems.map((item, index) => timed(() => {
    const context = createContext({ actorType: 'SYSTEM', actorId: `load-settler-${index}`, guildId: 'load-test',
      idempotencyKey: `load-settle:${item.id}` });
    return index < contentionCount / 2
      ? captureReservation({ orderItemId: item.id, claimUrl: `https://load.test/claim/${item.id}` }, context,
        { pool, maxAttempts: 10, deadlineMs: 30_000 })
      : releaseReservation({ orderItemId: item.id, terminalState: 'STOPPED_RELEASED', reason: 'LOAD_TEST' }, context,
        { pool, maxAttempts: 10, deadlineMs: 30_000 });
  })));
  const settledWallet = (await pool.query(
    'SELECT available_cents,reserved_cents FROM wallets WHERE discord_user_id=$1', [contentionUser],
  )).rows[0];
  if (BigInt(settledWallet.available_cents) !== BigInt(contentionCount * 750)
    || BigInt(settledWallet.reserved_cents) !== 0n) {
    throw new Error('capture/release wallet invariant failed');
  }

  const runnerTimings = await Promise.all(Array.from({ length: 200 }, (_, index) => timed(() => (
    acquireRunnableJob({ holder: randomUUID() }, createContext({ actorType: 'SYSTEM', actorId: `load-runner-${index}`,
      guildId: 'load-test', idempotencyKey: `load-runner:${index}` }), { pool })
  ))));
  const acquiredRunnerIds = runnerTimings.map(({ result }) => result?.id).filter(Boolean);
  if (new Set(acquiredRunnerIds).size !== acquiredRunnerIds.length) throw new Error('runner lease uniqueness failed');
  const firstRunner = runnerTimings.find(({ result }) => result)?.result;
  await pool.query('UPDATE runner_jobs SET fencing_token=fencing_token+1 WHERE id=$1', [firstRunner.id]);
  let fencingRejected = false;
  try {
    await renewRunnerJob(firstRunner, 60, { pool });
  } catch (error) {
    fencingRejected = error?.code === 'FENCING_LOST';
  }
  if (!fencingRejected) throw new Error('stale runner fencing token was accepted');

  const projectionCount = 100;
  await pool.query(`INSERT INTO message_projections(
    id,projection_type,aggregate_id,surface_key,nonce,next_allowed_at
  ) SELECT gen_random_uuid(),'LOAD_TEST','load-'||n,'DM:load-user',
    substr(md5(random()::text || clock_timestamp()::text),1,25),clock_timestamp() FROM generate_series(1,$1) n`, [projectionCount]);
  await pool.query(`INSERT INTO outbox_events(
    id,topic,aggregate_type,aggregate_id,aggregate_version,projection_id,state,trace_id
  ) SELECT gen_random_uuid(),'LOAD_TEST','LOAD',p.aggregate_id,1,p.id,'PENDING',$1
    FROM message_projections p WHERE p.projection_type='LOAD_TEST'`, [trace]);
  const outboxTimings = await Promise.all(Array.from({ length: projectionCount }, () => timed(() => (
    acquireDelivery({ holder: randomUUID() }, { pool })
  ))));
  const acquiredOutboxIds = outboxTimings.map(({ result }) => result?.id).filter(Boolean);
  if (new Set(acquiredOutboxIds).size !== acquiredOutboxIds.length) throw new Error('outbox lease uniqueness failed');

  const operationTimings = [
    ...reservationTimings.map(({ durationMs }) => durationMs),
    ...settlementTimings.map(({ durationMs }) => durationMs),
    ...runnerTimings.map(({ durationMs }) => durationMs),
    ...outboxTimings.map(({ durationMs }) => durationMs),
  ];
  await new Promise((resolve) => setTimeout(resolve, 250));
  const rss = process.memoryUsage().rss;
  const eventLoopP95Ms = delay.percentile(95) / 1e6;
  const report = { users: 200, orders: 100, elapsedMs: Math.round(performance.now()-started),
    operations: operationTimings.length, operationP95Ms: Math.round(percentile(operationTimings, 0.95)),
    reservations: reservationTimings.length, captures: contentionCount / 2, releases: contentionCount / 2,
    runnerLeases: acquiredRunnerIds.length, staleFenceRejected: fencingRejected,
    outboxLeases: acquiredOutboxIds.length, rssBytes: rss, eventLoopP95Ms };
  console.log(JSON.stringify(report));
  if (rss >= 400*1024*1024 || eventLoopP95Ms >= 100) throw new Error('capacity threshold failed');
} finally { delay.disable(); await pool.end(); }
