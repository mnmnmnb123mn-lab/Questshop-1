import pg from 'pg';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

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
  await Promise.all(Array.from({ length: 200 }, () => pool.query(`SELECT count(*) FROM runner_jobs
    WHERE state='QUEUED'; SELECT count(*) FROM wallets WHERE available_cents>=0`)));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const rss = process.memoryUsage().rss;
  const eventLoopP95Ms = delay.percentile(95) / 1e6;
  const report = { users: 200, orders: 100, elapsedMs: Math.round(performance.now()-started),
    rssBytes: rss, eventLoopP95Ms };
  console.log(JSON.stringify(report));
  if (rss >= 400*1024*1024 || eventLoopP95Ms >= 100) throw new Error('capacity threshold failed');
} finally { delay.disable(); await pool.end(); }
