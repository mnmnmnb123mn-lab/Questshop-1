import { getRuntimePool } from '../db/pools.js';
import { DEFAULT_FEATURE_GATES } from './feature-gates.js';
import { paymentPolicyFromConfigValues } from '../domain/payments/policy.js';

const PAYMENT_POLICY_KEYS = Object.freeze([
  'topupAutoCreditMinCents',
  'topupAutoCreditMaxCents',
  'topupDailyLimitCents',
]);

export function sanitizeRuntimeConfigValues(payload = {}) {
  const values = { ...payload };
  // Human backoffice access is derived from Discord's Administrator
  // permission at each interaction boundary. Retire the old role-based
  // setting from every config snapshot the application reads or writes.
  delete values.adminRoleId;

  // Payment limits are runtime policy rather than source-code constants. Only
  // normalize keys that were explicitly persisted so old snapshots continue
  // to inherit safe defaults. `null` intentionally disables the upper/daily cap.
  if (PAYMENT_POLICY_KEYS.some((key) => Object.hasOwn(values, key))) {
    const policy = paymentPolicyFromConfigValues(values);
    if (Object.hasOwn(values, 'topupAutoCreditMinCents')) {
      values.topupAutoCreditMinCents = policy.autoCreditMinCents.toString();
    }
    if (Object.hasOwn(values, 'topupAutoCreditMaxCents')) {
      values.topupAutoCreditMaxCents = policy.autoCreditMaxCents?.toString() ?? null;
    }
    if (Object.hasOwn(values, 'topupDailyLimitCents')) {
      values.topupDailyLimitCents = policy.dailyRedeemedLimitCents?.toString() ?? null;
    }
  }
  return values;
}

export async function loadRuntimeConfig(pool = getRuntimePool()) {
  const [gates, config, surfaces] = await Promise.all([
    pool.query('SELECT gate, enabled, version, reason FROM feature_gates'),
    pool.query('SELECT * FROM config_versions ORDER BY version DESC LIMIT 1'),
    pool.query('SELECT * FROM surfaces'),
  ]);
  return Object.freeze({
    version: Number(config.rows[0]?.version ?? 1),
    values: sanitizeRuntimeConfigValues(config.rows[0]?.payload),
    gates: Object.freeze({
      ...DEFAULT_FEATURE_GATES,
      ...Object.fromEntries(gates.rows.map((row) => [row.gate, row.enabled])),
    }),
    surfaces: Object.freeze(Object.fromEntries(surfaces.rows.map((row) => [row.surface_key, row]))),
  });
}

export async function setFeatureGate(client, { gate, enabled, reason, actor, context }) {
  const result = await client.query(`
    UPDATE feature_gates SET enabled = $2, reason = $3, actor_type = $4,
      actor_id = $5, trace_id = $6, version = version + 1,
      updated_at = transaction_timestamp()
    WHERE gate = $1 RETURNING *
  `, [gate, enabled, reason, actor.type, actor.id, context.traceId]);
  if (!result.rows[0]) throw new TypeError(`Unknown feature gate: ${gate}`);
  return result.rows[0];
}
