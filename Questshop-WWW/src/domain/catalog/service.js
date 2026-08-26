import { v7 as uuidv7 } from 'uuid';
import { withTransaction } from '../../db/transaction.js';
import { ENGINE_VERSION, EXECUTOR_VERSION, QUEST_CONTRACT_VERSION } from '../../config/versions.js';
import { resolvePrice } from '../pricing/resolver.js';
import { enqueueProjection } from '../outbox/service.js';
import { assertTransition, recordTransition } from '../shared/transition.js';
import { evaluateExpiryAdmission } from './expiry.js';
import { createMonitorTestBatch, hasCurrentTestPass } from './test-gate.js';
import { ANALYSIS_TRANSITIONS, SALE_TRANSITIONS } from './states.js';
import { questContractHash } from '../../quest-engine/schema/contract.js';

async function transitionAnalysis(client, quest, next, context) {
  if (quest.analysis_state === next) return quest;
  assertTransition(ANALYSIS_TRANSITIONS, quest.analysis_state, next);
  const updated = (await client.query(`
    UPDATE quests SET analysis_state = $2, analysis_version = analysis_version + 1,
      updated_at = transaction_timestamp(),
      first_analysis_at = COALESCE(first_analysis_at, transaction_timestamp())
    WHERE quest_id = $1 AND analysis_version = $3 RETURNING *
  `, [quest.quest_id, next, quest.analysis_version])).rows[0];
  if (!updated) throw new Error(`Quest analysis state changed concurrently: ${quest.quest_id}`);
  await recordTransition(client, {
    aggregateType: 'QUEST_ANALYSIS', aggregateId: quest.quest_id,
    fromState: quest.analysis_state, toState: next, stateVersion: updated.analysis_version, context,
  });
  return updated;
}

async function reconcileSale(client, quest, normalized, context, runnerConcurrency) {
  const price = await resolvePrice(client, { questId: quest.quest_id, taskType: quest.task_type });
  const expiry = await evaluateExpiryAdmission(client, { quest, runnerConcurrency });
  const testPassed = await hasCurrentTestPass(client, quest);
  const canSell = quest.analysis_state === 'SUPPORTED'
    && normalized.coreComplete && normalized.contractComplete && Boolean(price) && expiry.eligible && testPassed;
  let next = quest.sale_state;
  const expired = (await client.query(
    'SELECT $1::timestamptz <= clock_timestamp() AS value',
    [quest.expires_at],
  )).rows[0].value;
  if (expired) next = 'EXPIRED';
  else if (canSell && ['CLOSED', 'PAUSED'].includes(quest.sale_state)) next = 'OPEN';
  else if (!canSell && quest.sale_state === 'OPEN') next = 'PAUSED';
  if (next === quest.sale_state) return { quest, price, expiry };
  assertTransition(SALE_TRANSITIONS, quest.sale_state, next);
  const updated = (await client.query(`
    UPDATE quests SET sale_state = $2, sale_version = sale_version + 1,
      updated_at = transaction_timestamp()
    WHERE quest_id = $1 AND sale_version = $3 RETURNING *
  `, [quest.quest_id, next, quest.sale_version])).rows[0];
  if (!updated) throw new Error(`Quest sale state changed concurrently: ${quest.quest_id}`);
  await recordTransition(client, {
    aggregateType: 'QUEST_SALE', aggregateId: quest.quest_id,
    fromState: quest.sale_state, toState: next, stateVersion: updated.sale_version,
    reasonCode: expiry.reason, context,
  });
  return { quest: updated, price, expiry, testPassed };
}

function requiresRetest(previousQuest, normalized) {
  if (!previousQuest) return false;
  return previousQuest.current_contract_hash !== normalized.contractHash;
}

async function loadCurrentMetadataRevision(client, quest) {
  if (!quest || Number(quest.current_metadata_revision) <= 0) return null;
  return (await client.query(`SELECT normalized FROM quest_metadata_revisions
    WHERE quest_id=$1 AND revision=$2`, [quest.quest_id, quest.current_metadata_revision])).rows[0]?.normalized ?? null;
}

// A Monitor can see a partial Quest payload while another active account sees
// the complete contract. Merge only absent fields from durable data; never
// invent values. A complete, newly observed payload stays authoritative so
// removed artwork/reward metadata does not leak forward from an older revision.
function mergeDiscoveryMetadata(previousQuest, normalized, previousMetadata = null) {
  if (!previousQuest || normalized.coreComplete) return normalized;
  const merged = {
    ...normalized,
    name: normalized.name || previousQuest.name,
    eventName: normalized.eventName === 'UNKNOWN_SCHEMA' ? previousQuest.task_type : normalized.eventName,
    secondsNeeded: Number(normalized.secondsNeeded) > 0 ? normalized.secondsNeeded : previousQuest.task_target,
    startsAt: normalized.startsAt ?? previousQuest.starts_at,
    expiresAt: normalized.expiresAt ?? previousQuest.expires_at,
    url: normalized.url ?? previousQuest.url,
    artworkUrl: normalized.artworkUrl ?? previousQuest.artwork_url,
    thumbnailUrl: normalized.thumbnailUrl ?? previousMetadata?.thumbnailUrl ?? null,
    orbs: normalized.orbs ?? previousQuest.orbs,
    orbReward: normalized.orbReward ?? previousMetadata?.orbReward ?? null,
    executorId: normalized.eventName === 'UNKNOWN_SCHEMA' ? previousQuest.executor_id : normalized.executorId,
  };
  merged.coreComplete = Boolean(merged.id && merged.eventName && Number(merged.secondsNeeded) > 0
    && merged.startsAt && merged.expiresAt && merged.url);
  // A partial payload may borrow cosmetic/absent metadata, but explicit new
  // incompatibility evidence must never be hidden by a previously supported
  // contract.
  if (merged.coreComplete && previousQuest.analysis_state === 'SUPPORTED'
    && !normalized.compatibilityIssues?.length && normalized.contractHash) {
    merged.autoSupported = true;
  }
  const contract = questContractHash(merged, {
    engineVersion: ENGINE_VERSION,
    executorVersion: EXECUTOR_VERSION,
    contractVersion: QUEST_CONTRACT_VERSION,
  });
  return { ...merged, contractHash: contract.hash, contractCanonical: contract.canonical,
    contractComplete: contract.complete && Boolean(merged.autoSupported) };
}

async function upsertQuest(client, normalized) {
  return (await client.query(`
      INSERT INTO quests(
        quest_id, analysis_state, name, task_type, task_target, url, artwork_url,
        orbs, starts_at, expires_at, executor_id, engine_version,
        executor_version, contract_version,current_contract_hash
      ) VALUES ($1,'DETECTED',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (quest_id) DO UPDATE SET
        name = EXCLUDED.name, task_type = EXCLUDED.task_type,
        task_target = EXCLUDED.task_target, url = EXCLUDED.url,
        artwork_url = EXCLUDED.artwork_url, orbs = EXCLUDED.orbs,
        starts_at = EXCLUDED.starts_at, expires_at = EXCLUDED.expires_at,
        executor_id = EXCLUDED.executor_id, engine_version = EXCLUDED.engine_version,
        executor_version = EXCLUDED.executor_version, contract_version = EXCLUDED.contract_version,
        current_contract_hash = EXCLUDED.current_contract_hash,
        updated_at = transaction_timestamp()
      RETURNING *
    `, [
      normalized.id, normalized.name, normalized.eventName, normalized.secondsNeeded,
      normalized.url, normalized.artworkUrl, normalized.orbs, normalized.startsAt,
      normalized.expiresAt, normalized.executorId, ENGINE_VERSION, EXECUTOR_VERSION,
      QUEST_CONTRACT_VERSION, normalized.contractHash,
    ])).rows[0];
}

async function recordMetadataRevision(client, quest, normalized, source, redactedRaw, context) {
  const revision = Number(quest.current_metadata_revision) + 1;
  await client.query(`
      INSERT INTO quest_metadata_revisions(
        id, quest_id, revision, normalized, redacted_raw, source,
        core_complete, schema_issues, contract_hash, contract_complete, trace_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [
    uuidv7(), quest.quest_id, revision, normalized, redactedRaw ?? normalized,
    source, normalized.coreComplete, normalized.compatibilityIssues, normalized.contractHash,
    normalized.contractComplete, context.traceId,
  ]);
  const updatedQuest = (await client.query(`
      UPDATE quests SET current_metadata_revision = $2 WHERE quest_id = $1 RETURNING *
    `, [quest.quest_id, revision])).rows[0];
  return { quest: updatedQuest, revision };
}

async function analyzeQuest(client, quest, normalized, context) {
  if (quest.analysis_state === 'DETECTED' || quest.analysis_state === 'METADATA_RETRY') {
    if (!normalized.coreComplete) return transitionAnalysis(client, quest, 'METADATA_RETRY', context);
    const analyzed = await transitionAnalysis(client, quest, 'ANALYZED', context);
    return transitionAnalysis(client, analyzed, normalized.autoSupported ? 'SUPPORTED' : 'UNSUPPORTED', context);
  }
  if (quest.analysis_state === 'UNSUPPORTED' && normalized.coreComplete && normalized.autoSupported) {
    return transitionAnalysis(client, quest, 'SUPPORTED', context);
  }
  return quest;
}

export async function pauseQuestForRetest(client, quest, context) {
  if (quest.sale_state !== 'OPEN') return quest;
  assertTransition(SALE_TRANSITIONS, quest.sale_state, 'PAUSED');
  const paused = (await client.query(`UPDATE quests SET sale_state='PAUSED',sale_version=sale_version+1,
    updated_at=transaction_timestamp() WHERE quest_id=$1 AND sale_state='OPEN'
      AND sale_version=$2 RETURNING *`, [quest.quest_id, quest.sale_version])).rows[0];
  if (!paused) throw new Error(`Quest sale state changed during retest pause: ${quest.quest_id}`);
  await recordTransition(client, { aggregateType: 'QUEST_SALE', aggregateId: quest.quest_id,
    fromState: 'OPEN', toState: 'PAUSED', stateVersion: paused.sale_version,
    reasonCode: 'RETEST_REQUIRED', context });
  return paused;
}

async function queueDiscoveryProjections(client, quest, revision, context) {
  // Expired Quest records remain durable catalog/history evidence, but they
  // must never become a customer-facing QUEST_NEW notification. Monitor
  // discovery still writes the operational projection for diagnostics.
  // A customer discovery is intentionally private until an Admin explicitly
  // publishes it or a Monitor test opens public sale.  The checkout account
  // can still receive customer-account admission; public discovery and public
  // sale are separate decisions.
  const shouldPublish = quest.sale_state !== 'EXPIRED'
    && (quest.announcement_state === 'ANNOUNCED' || quest.sale_state === 'OPEN');
  const announcementNotBefore = quest.announcement_state === 'ANNOUNCED'
    ? (await client.query("SELECT clock_timestamp()+interval '30 seconds' AS value")).rows[0].value
    : null;
  if (shouldPublish) await enqueueProjection(client, {
    projectionType: 'QUEST_NEW', aggregateType: 'QUEST', aggregateId: quest.quest_id,
    aggregateVersion: revision, surfaceKey: 'QUEST_NEW', notBefore: announcementNotBefore, context,
  });
  await enqueueProjection(client, {
    projectionType: 'QUEST_OPERATION', aggregateType: 'QUEST', aggregateId: quest.quest_id,
    aggregateVersion: revision, surfaceKey: 'LOG_QUEST_OPERATIONS', context,
  });
}

export async function ingestDiscovery({
  normalized,
  source,
  redactedRaw = null,
  runnerConcurrency = 2,
  skipMonitorTest = false,
}, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const previousQuest = (await client.query('SELECT * FROM quests WHERE quest_id=$1 FOR UPDATE',
      [normalized.id])).rows[0] ?? null;
    const previousMetadata = await loadCurrentMetadataRevision(client, previousQuest);
    const merged = mergeDiscoveryMetadata(previousQuest, normalized, previousMetadata);
    const needsRetest = requiresRetest(previousQuest, merged);
    let quest = await upsertQuest(client, merged);
    const metadata = await recordMetadataRevision(client, quest, merged, source, redactedRaw, context);
    quest = await analyzeQuest(client, metadata.quest, merged, context);

    // Expiry is reconciled before any Monitor test batch is created. This is
    // intentionally earlier than the test gate so first-run scans can ingest
    // Discord's historical Quest list without burning Monitor tokens/rate
    // limit on Quest records that are already impossible to run.
    const sale = await reconcileSale(client, quest, merged, context, runnerConcurrency);
    quest = sale.quest;
    // Checkout discovery may be offered to that checked account and announced
    // after analysis, but it must not consume a Monitor credential or open
    // public sale before the scanner has independently verified it.
    if (!skipMonitorTest && quest.analysis_state === 'SUPPORTED' && source === 'MONITOR' && quest.sale_state !== 'EXPIRED') {
      await createMonitorTestBatch(client, { quest, context, force: needsRetest });
    }
    quest = needsRetest ? await pauseQuestForRetest(client, quest, context) : quest;
    await queueDiscoveryProjections(client, quest, metadata.revision, context);
    return { quest, price: sale.price, expiry: sale.expiry, revision: metadata.revision };
  });
}

function coreMetadataPresent(quest) {
  return Boolean(quest?.name && quest.task_type && Number(quest.task_target) > 0
    && quest.url && quest.starts_at && quest.expires_at && quest.executor_id
    && quest.current_contract_hash);
}

export async function resolveSaleEligibility({
  questId,
  progressActual = 0,
  runnerConcurrency = 2,
  allowCustomerAccount = false,
}, _context, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, async (client) => {
    const quest = (await client.query('SELECT * FROM quests WHERE quest_id = $1', [questId])).rows[0];
    if (!quest) return { eligible: false, reason: 'QUEST_NOT_FOUND' };
    const publicSale = quest.sale_state === 'OPEN' && quest.analysis_state === 'SUPPORTED'
      && await hasCurrentTestPass(client, quest);
    const customerAccountSale = allowCustomerAccount && quest.analysis_state === 'SUPPORTED'
      && !['PAUSED', 'EXPIRED'].includes(quest.sale_state)
      && coreMetadataPresent(quest);
    if (!publicSale && !customerAccountSale) {
      return { eligible: false, reason: 'QUEST_NOT_FOR_SALE', quest };
    }
    const price = await resolvePrice(client, { questId, taskType: quest.task_type });
    if (!price) return { eligible: false, reason: 'PRICE_MISSING', quest };
    const expiry = await evaluateExpiryAdmission(client, {
      quest: { ...quest, progress_actual: progressActual }, runnerConcurrency,
    });
    return { eligible: expiry.eligible, reason: expiry.reason, quest, price, expiry,
      admissionScope: publicSale ? 'PUBLIC' : 'CUSTOMER_ACCOUNT' };
  });
}
