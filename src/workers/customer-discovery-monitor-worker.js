import { decryptSecret } from '../adapters/crypto/keyring.js';
import { createQuestApiClient, profileFromEnv } from '../quest-engine/api/client.js';
import { getPersistentDiscordRateLimitCoordinator } from '../quest-engine/rate-limits/coordinator.js';
import { createContext } from '../shared/correlation.js';
import { ingestDiscovery } from '../domain/catalog/service.js';
import {
  acquireCustomerMonitorSearchCheck, completeCustomerMonitorSearchCheck,
} from '../domain/catalog/customer-discovery-case-service.js';

async function markMonitorFailure(pool, monitorId, error) {
  if (!(error?.fatalAuth || error?.retryable || error?.category === 'NETWORK')) return;
  await pool.query(`UPDATE monitor_accounts SET consecutive_failures=consecutive_failures+1,
    state=CASE WHEN $2 OR consecutive_failures+1>=5 THEN 'QUARANTINED'
      WHEN consecutive_failures+1>=3 THEN 'COOLDOWN' ELSE state END,
    cooldown_until=CASE WHEN NOT $2 AND consecutive_failures+1>=3 THEN clock_timestamp()+interval '15 minutes'
      ELSE cooldown_until END,state_version=state_version+1,updated_at=clock_timestamp()
    WHERE id=$1 AND state='ACTIVE'`, [monitorId, Boolean(error?.fatalAuth)]);
}

export async function processCustomerDiscoveryMonitorSearch({ env, pool, signal, holder, runnerConcurrency = env.RUNNER_CONCURRENCY }) {
  const check = await acquireCustomerMonitorSearchCheck({ holder }, { pool });
  if (!check) return false;
  const context = createContext({ traceId: check.trace_id, actorType: 'SYSTEM', actorId: holder,
    guildId: env.DISCORD_GUILD_ID, idempotencyKey: `customer-discovery-search:${check.id}:${check.fencing_token}` });
  try {
    const token = decryptSecret({ keyVersion: check.key_version, nonce: check.nonce,
      ciphertext: check.ciphertext, authTag: check.auth_tag }, env.DATA_ENCRYPTION_KEYS_JSON,
    `monitor:${check.monitor_id}:${env.DISCORD_GUILD_ID}`);
    const api = createQuestApiClient({ token, profile: profileFromEnv(env),
      coordinator: getPersistentDiscordRateLimitCoordinator(pool) });
    const [profile, quests] = await Promise.all([api.fetchCurrentUser(signal), api.fetchQuests(signal)]);
    if (String(profile.id) !== String(check.account_id)) {
      throw Object.assign(new Error('Monitor account mismatch'), { fatalAuth: true, code: 'MONITOR_ACCOUNT_MISMATCH' });
    }
    const quest = quests.find((item) => item.id === check.quest_id);
    if (!quest) {
      await completeCustomerMonitorSearchCheck({ check, state: 'NOT_VISIBLE', evidence: { result: 'NOT_VISIBLE' } }, context, { pool });
      return true;
    }
    // Store the Monitor observation but do not let generic Monitor ingestion
    // create a second batch; this case owns the test workflow.
    await ingestDiscovery({ normalized: quest, source: 'MONITOR', runnerConcurrency, skipMonitorTest: true }, context, { pool });
    const state = quest.completed ? 'VISIBLE_COMPLETED' : 'VISIBLE';
    await completeCustomerMonitorSearchCheck({ check, state, evidence: {
      result: state, enrolled: Boolean(quest.enrolled), completed: Boolean(quest.completed),
    } }, context, { pool });
  } catch (error) {
    await markMonitorFailure(pool, check.monitor_id, error);
    const retryable = Boolean(error?.retryable || error?.category === 'NETWORK' || Number(error?.status) === 429);
    // Quest reads are safe to repeat.  Keep the retry evidence durable and
    // give a transient failure up to three worker acquisitions before the
    // Case reports that this Monitor could not be checked.
    const state = retryable && Number(check.attempt_count) < 3 ? 'PENDING' : 'FAILED';
    await completeCustomerMonitorSearchCheck({ check, state, evidence: {
      result: state === 'PENDING' ? 'RETRY_WAIT' : 'FAILED', retryable,
      attempts: Number(check.attempt_count),
    }, errorClass: error?.code ?? error?.name ?? 'UNKNOWN' }, context, { pool });
  }
  return true;
}
