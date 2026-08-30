import { DEFAULT_FEATURE_GATES, assertFeatureGate } from './feature-gates.js';
import { nowMs, withImmediateTransaction } from '../db/sqlite.js';
import { configuredPriceRange } from '../domain/sqlite/pricing.js';

const CONFIG_KEY = 'runtime_config';
const GATES_KEY = 'feature_gates';
const SURFACES_KEY = 'discord_surfaces';

function readSetting(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM settings WHERE key=?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

function putSetting(db, key, value, actor = 'SYSTEM', timestamp = nowMs()) {
  db.prepare(`INSERT INTO settings(key,value_json,updated_at,updated_by) VALUES(?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
    .run(key, JSON.stringify(value), timestamp, actor);
}

export function sanitizeRuntimeConfigValues(payload = {}) {
  const values = { ...(payload && typeof payload === 'object' ? payload : {}) };
  delete values.adminRoleId;
  return values;
}

export function loadRuntimeConfig(db) {
  const values = sanitizeRuntimeConfigValues(readSetting(db, CONFIG_KEY, {}));
  return Object.freeze({
    version: Number(readSetting(db, 'runtime_config_version', 1)),
    values,
    priceRange: configuredPriceRange(values),
    gates: Object.freeze({ ...DEFAULT_FEATURE_GATES, ...readSetting(db, GATES_KEY, {}) }),
    surfaces: Object.freeze(readSetting(db, SURFACES_KEY, {})),
  });
}

export function setFeatureGate(db, { gate, enabled, reason, actor = { id: 'SYSTEM' } }) {
  assertFeatureGate(gate);
  return withImmediateTransaction(db, () => {
    const gates = { ...DEFAULT_FEATURE_GATES, ...readSetting(db, GATES_KEY, {}) };
    gates[gate] = enabled === true;
    putSetting(db, GATES_KEY, gates, actor.id);
    const values = readSetting(db, 'gate_reasons', {});
    values[gate] = { reason: String(reason ?? ''), updatedAt: nowMs(), actorId: actor.id };
    putSetting(db, 'gate_reasons', values, actor.id);
    return { gate, enabled: gates[gate], reason: values[gate].reason };
  });
}

export function saveRuntimeConfig(db, values, actor = 'SYSTEM') {
  return withImmediateTransaction(db, () => {
    const version = Number(readSetting(db, 'runtime_config_version', 1)) + 1;
    putSetting(db, CONFIG_KEY, sanitizeRuntimeConfigValues(values), actor);
    putSetting(db, 'runtime_config_version', version, actor);
    return { version, values: sanitizeRuntimeConfigValues(values) };
  });
}

export function saveSurface(db, surfaceKey, surface, actor = 'SYSTEM') {
  return withImmediateTransaction(db, () => saveSurfaceInTransaction(db, surfaceKey, surface, actor));
}

export function saveSurfaceInTransaction(db, surfaceKey, surface, actor = 'SYSTEM') {
  const surfaces = readSetting(db, SURFACES_KEY, {});
  surfaces[surfaceKey] = surface;
  putSetting(db, SURFACES_KEY, surfaces, actor);
  return surfaces[surfaceKey];
}
