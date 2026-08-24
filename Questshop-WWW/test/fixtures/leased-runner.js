import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { encryptSecret } from '../../src/adapters/crypto/keyring.js';
import { createContext } from '../../src/shared/correlation.js';
import { adjustBalance, reserveOrderItems } from '../../src/domain/wallet/service.js';

const TEST_CHROME_VERSION = ['120', '0', '0', '0'].join('.');

export async function seedLeasedRunner(pool, {
  questId = `quest-${uuidv7()}`,
  userId = `user-${uuidv7()}`,
  accountId = `account-${uuidv7()}`,
  guildId = '10000000000000003',
  taskTarget = 60,
  amountCents = 500n,
  attemptCount = 0,
} = {}) {
  const trace = uuidv7(); const owner = uuidv7(); const orderId = uuidv7();
  const itemId = uuidv7(); const jobId = uuidv7(); const ruleId = uuidv7();
  const keyring = { current: 1, keys: { 1: randomBytes(32).toString('base64') } };
  const env = { DISCORD_GUILD_ID: guildId, DATA_ENCRYPTION_KEYS_JSON: keyring,
    RUNNER_CONCURRENCY: 3, DISCORD_CLIENT_VERSION: '1.0.0', DISCORD_CHROME_VERSION: TEST_CHROME_VERSION,
    DISCORD_ELECTRON_VERSION: '28.0.0', DISCORD_BUILD_NUMBER: 1, DISCORD_NATIVE_BUILD_NUMBER: 1,
    DISCORD_LOCALE: 'en-US' };
  const context = createContext({ traceId: trace, actorType: 'SYSTEM', actorId: owner, guildId,
    idempotencyKey: `runner-fixture:${itemId}` });
  await adjustBalance({ discordUserId: userId, amountCents, reason: 'seed' }, context, { pool });
  await pool.query(`INSERT INTO price_rules(id,rule_type,amount_cents,config_version,actor_id,trace_id)
    VALUES($1,'DEFAULT',$2,1,'owner',$3)`, [ruleId, amountCents, trace]);
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,url,
    starts_at,expires_at,executor_id) VALUES($1,'SUPPORTED','OPEN',$1,'WATCH_VIDEO',$2,$3,
    clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day','video')`,
  [questId, taskTarget, `https://discord.com/quests/${questId}`]);
  await pool.query(`INSERT INTO orders(id,discord_user_id,account_id,trace_id) VALUES($1,$2,$3,$4)`,
    [orderId, userId, accountId, trace]);
  await pool.query(`INSERT INTO order_items(id,order_id,sequence_number,quest_id,quest_name,task_type,
    price_cents,price_rule_id,config_version,metadata_revision,engine_version,executor_version,
    contract_version,runner_state_schema_version,state,deadline_at) VALUES($1,$2,1,$3,$3,
    'WATCH_VIDEO',$4,$5,1,1,'1','1','1',1,'SELECTED',clock_timestamp()+interval '1 day')`,
  [itemId, orderId, questId, amountCents, ruleId]);
  await reserveOrderItems({ discordUserId: userId, items: [{ itemId, amountCents }] }, context, { pool });
  await pool.query(`UPDATE order_items SET state='LEASED',state_version=state_version+1 WHERE id=$1`, [itemId]);
  await pool.query(`INSERT INTO runner_jobs(id,order_item_id,discord_user_id,account_id,state,lease_owner,
    lease_expires_at,fencing_token,attempt_count,deadline_at,engine_version,executor_version,contract_version,
    runner_state_schema_version,trace_id) VALUES($1,$2,$3,$4,'LEASED',$5,clock_timestamp()+interval '1 minute',
    1,$6,clock_timestamp()+interval '1 day','1','1','1',1,$7)`,
  [jobId, itemId, userId, accountId, owner, attemptCount, trace]);
  const encrypted = encryptSecret('customer-token', keyring, `order:${orderId}:${guildId}`);
  await pool.query(`INSERT INTO order_credentials(order_id,account_id,key_version,nonce,ciphertext,auth_tag)
    VALUES($1,$2,$3,$4,$5,$6)`, [orderId, accountId, encrypted.keyVersion, encrypted.nonce,
    encrypted.ciphertext, encrypted.authTag]);
  const job = (await pool.query('SELECT * FROM runner_jobs WHERE id=$1', [jobId])).rows[0];
  return { trace, owner, orderId, itemId, jobId, ruleId, userId, accountId, guildId,
    keyring, env, context, job, questId, amountCents };
}
