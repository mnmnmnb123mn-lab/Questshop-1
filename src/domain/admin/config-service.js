import { v7 as uuidv7 } from 'uuid';
import { withTransaction } from '../../db/transaction.js';
import { appendAdminAudit } from './audit.js';
import { assertFeatureGate } from '../../config/feature-gates.js';
import { createHash } from 'node:crypto';
import { appendReleaseEvidence } from './release-evidence.js';
import {
  assertQuestPriceCategory,
  taskTypesForQuestPriceCategory,
} from '../pricing/categories.js';
import { sanitizeRuntimeConfigValues } from '../../config/runtime-config.js';
import { APPLICATION_EVENTS, applicationEvents } from '../../shared/application-events.js';

export async function updateFeatureGate({ gate, enabled, reason, expectedVersion, release = null }, context, options = {}) {
  assertFeatureGate(gate);
  if (!reason?.trim()) throw new TypeError('feature gate reason is required');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const before = (await client.query('SELECT * FROM feature_gates WHERE gate=$1 FOR UPDATE', [gate])).rows[0];
    if (!before || Number(before.version) !== Number(expectedVersion)) throw new Error('STALE_CONFIG');
    const after = (await client.query(`UPDATE feature_gates SET enabled=$2,reason=$3,actor_type=$4,
      actor_id=$5,trace_id=$6,version=version+1,updated_at=transaction_timestamp()
      WHERE gate=$1 AND version=$7 RETURNING *`, [gate, enabled, reason, context.actorType,
      context.actorId, context.traceId, expectedVersion])).rows[0];
    await appendAdminAudit(client, { action: 'FEATURE_GATE_CHANGE', targetType: 'FEATURE_GATE',
      targetId: gate, actorId: context.actorId, before, after, reason, context });
    if (release?.prelaunch) {
      await appendReleaseEvidence(client, {
        evidenceType: 'PRELAUNCH_GATE', subjectType: 'FEATURE_GATE', subjectId: `${gate}:v${after.version}`,
        release, evidence: { enabled, reason, beforeVersion: before.version, afterVersion: after.version },
      }, context);
    }
    return after;
  });
}

/**
 * Questshop deliberately exposes two prices, not the low-level rule engine.
 * Each edit creates immutable TYPE-rule snapshots for every executor in the
 * selected customer-facing category, then retires the old snapshots.
 */
export async function setQuestCategoryPrice({ category, amountCents, expectedVersions = null }, context, options = {}) {
  const normalizedCategory = assertQuestPriceCategory(category);
  const amount = BigInt(amountCents);
  if (amount <= 0n) throw new TypeError('invalid Quest category price');
  const taskTypes = taskTypesForQuestPriceCategory(normalizedCategory);
  if (!expectedVersions || taskTypes.some((taskType) => expectedVersions[taskType] == null)) {
    throw new TypeError('current Quest category price version is required');
  }
  const result = await withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const before = (await client.query(`SELECT * FROM price_rules
      WHERE rule_type='TYPE' AND task_type = ANY($1::text[]) AND enabled=true
      FOR UPDATE`, [taskTypes])).rows;
    if (before.length !== taskTypes.length
      || before.some((rule) => String(expectedVersions[rule.task_type]) !== String(rule.state_version))) {
      throw new Error('STALE_CONFIG');
    }
    await client.query(`UPDATE price_rules SET enabled=false,state_version=state_version+1
      WHERE rule_type='TYPE' AND task_type=ANY($1::text[]) AND enabled=true`, [taskTypes]);
    const configVersion = Number((await client.query(
      'SELECT COALESCE(max(version),1)::bigint AS value FROM config_versions',
    )).rows[0].value);
    const rows = [];
    for (const taskType of taskTypes) {
      const row = (await client.query(`INSERT INTO price_rules(id,rule_type,task_type,amount_cents,
        priority,enabled,starts_at,ends_at,config_version,actor_id,trace_id)
        VALUES($1,'TYPE',$2,$3,0,true,NULL,NULL,$4,$5,$6) RETURNING *`,
      [uuidv7(), taskType, amount, configVersion, context.actorId, context.traceId])).rows[0];
      rows.push(row);
    }
    await appendAdminAudit(client, {
      action: 'QUEST_CATEGORY_PRICE_CHANGED', targetType: 'QUEST_PRICE_CATEGORY', targetId: normalizedCategory,
      actorId: context.actorId,
      before: before.map((rule) => ({ taskType: rule.task_type, amountCents: rule.amount_cents, stateVersion: rule.state_version })),
      after: rows.map((rule) => ({ taskType: rule.task_type, amountCents: rule.amount_cents, stateVersion: rule.state_version })),
      reason: `Quest ${normalizedCategory} price changed`, context,
    });
    return { category: normalizedCategory, amountCents: amount, rules: rows, previousRules: before };
  });
  applicationEvents.emit(APPLICATION_EVENTS.QUEST_CATEGORY_PRICE_CHANGED, {
    category: result.category,
    amountCents: result.amountCents,
    traceId: context.traceId,
  });
  return result;
}

function validatePromotionTiers(tiers) {
  if (!Array.isArray(tiers) || !tiers.length) throw new TypeError('invalid promotion tiers');
  const seen = new Set();
  return tiers.map((tier) => {
    const minimumAmountCents = BigInt(tier.minimumAmountCents);
    const basisPoints = Number(tier.basisPoints);
    if (minimumAmountCents < 0n || !Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000
      || seen.has(String(minimumAmountCents))) throw new TypeError('invalid promotion tiers');
    seen.add(String(minimumAmountCents));
    return { minimumAmountCents, basisPoints };
  });
}

/**
 * Editing the visible promotion produces a fresh immutable version. Existing
 * top-ups continue to reference the older version and retain their evidence.
 */
export async function replaceManualPromotion({ tiers, maxUsesPerUser = null, maxBonusPerDayCents = null }, context, options = {}) {
  const normalizedTiers = validatePromotionTiers(tiers);
  if (maxUsesPerUser != null && (!Number.isInteger(Number(maxUsesPerUser)) || Number(maxUsesPerUser) <= 0)) {
    throw new TypeError('invalid promotion user limit');
  }
  if (maxBonusPerDayCents != null && BigInt(maxBonusPerDayCents) < 0n) throw new TypeError('invalid promotion daily cap');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const active = (await client.query("SELECT * FROM promotions WHERE state='ACTIVE' FOR UPDATE")).rows;
    for (const prior of active) {
      await client.query(`UPDATE promotions SET state='DISABLED',state_version=state_version+1
        WHERE id=$1 AND state_version=$2`, [prior.id, prior.state_version]);
    }
    const version = Number((await client.query(
      'SELECT COALESCE(max(version),0)::bigint+1 AS value FROM promotions',
    )).rows[0].value);
    const row = (await client.query(`INSERT INTO promotions(id,version,name,state,starts_at,ends_at,
      manual_controlled,max_uses_per_user,max_bonus_per_day_cents,actor_id,trace_id)
      VALUES($1,$2,$3,'ACTIVE',NULL,NULL,true,$4,$5,$6,$7) RETURNING *`,
    [uuidv7(), version, `โบนัสเติมเงิน รุ่น ${version}`, maxUsesPerUser, maxBonusPerDayCents,
      context.actorId, context.traceId])).rows[0];
    for (const tier of normalizedTiers) await client.query(`INSERT INTO promotion_tiers(
      id,promotion_id,minimum_amount_cents,basis_points) VALUES($1,$2,$3,$4)`,
    [uuidv7(), row.id, tier.minimumAmountCents, tier.basisPoints]);
    await appendAdminAudit(client, {
      action: 'PROMOTION_VERSION_REPLACED', targetType: 'PROMOTION', targetId: row.id,
      actorId: context.actorId,
      before: active.map((promotion) => ({ id: promotion.id, version: promotion.version, state: promotion.state })),
      after: { id: row.id, version: row.version, tiers: normalizedTiers, maxUsesPerUser, maxBonusPerDayCents },
      reason: 'promotion terms changed', context,
    });
    return { promotion: row, tiers: normalizedTiers };
  });
}

export async function setManualPromotionEnabled({ enabled, expectedVersion }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const current = (await client.query(`SELECT * FROM promotions WHERE manual_controlled=true
      ORDER BY version DESC LIMIT 1 FOR UPDATE`)).rows[0];
    if (!current) throw new Error('PROMOTION_NOT_FOUND');
    if (String(current.state_version) !== String(expectedVersion)) throw new Error('STALE_CONFIG');
    if (enabled && current.state !== 'ACTIVE') {
      await client.query("UPDATE promotions SET state='DISABLED',state_version=state_version+1 WHERE state='ACTIVE' AND id<>$1", [current.id]);
    }
    const state = enabled ? 'ACTIVE' : 'DISABLED';
    const updated = (await client.query(`UPDATE promotions SET state=$2,state_version=state_version+1
      WHERE id=$1 AND state_version=$3 RETURNING *`, [current.id, state, current.state_version])).rows[0];
    if (!updated) throw new Error('STALE_CONFIG');
    await appendAdminAudit(client, {
      action: enabled ? 'PROMOTION_ENABLED' : 'PROMOTION_DISABLED', targetType: 'PROMOTION', targetId: current.id,
      actorId: context.actorId, before: current, after: updated,
      reason: enabled ? 'promotion enabled' : 'promotion disabled', context,
    });
    return updated;
  });
}

export async function updateRuntimeConfig({ patch, expectedVersion, reason }, context, options = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !reason?.trim()) throw new TypeError('invalid config update');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const before = (await client.query('SELECT * FROM config_versions ORDER BY version DESC LIMIT 1 FOR UPDATE')).rows[0] ?? null;
    // Runtime exposes version 1 before the first persisted customization so
    // sessions have a stable non-zero config version. Accept that baseline,
    // then persist the first snapshot as version 1.
    const visibleVersion = Number(before?.version ?? 1);
    if (visibleVersion !== Number(expectedVersion)) throw new Error('STALE_CONFIG');
    const payload = sanitizeRuntimeConfigValues({ ...before?.payload, ...patch });
    const nextVersion = Number(before?.version ?? 0) + 1;
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const row = (await client.query(`INSERT INTO config_versions(id,version,payload,payload_hash,
      actor_type,actor_id,trace_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [uuidv7(), nextVersion, payload, hash, context.actorType, context.actorId, context.traceId])).rows[0];
    await appendAdminAudit(client, { action: 'RUNTIME_CONFIG_CHANGE', targetType: 'CONFIG',
      targetId: nextVersion, actorId: context.actorId, before: before?.payload ?? {}, after: payload,
      reason, context });
    return row;
  });
}
