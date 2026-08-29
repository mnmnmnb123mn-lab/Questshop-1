import { DEFAULT_FEATURE_GATES } from '../../config/feature-gates.js';
import { QuestshopError } from '../../shared/errors.js';

function parse(value, fallback) {
  try { return { ...fallback, ...JSON.parse(value ?? '{}') }; } catch { return { ...fallback }; }
}

export function currentFeatureGates(db) {
  const row = db.prepare("SELECT value_json FROM settings WHERE key='feature_gates'").get();
  return Object.freeze(parse(row?.value_json, DEFAULT_FEATURE_GATES));
}

export function gateEnabled(db, gate) {
  return currentFeatureGates(db)[gate] === true;
}

export function assertGate(db, gate) {
  if (!gateEnabled(db, gate)) throw new QuestshopError('FEATURE_DISABLED', 'ส่วนนี้ยังไม่เปิดให้ใช้งาน กรุณาติดต่อผู้ดูแล');
}

export function assertCustomerAccess(db, env, interaction, requiredGate) {
  assertGate(db, 'STORE_OPEN');
  assertGate(db, 'CUSTOMER_INTERACTIONS_ENABLED');
  assertGate(db, requiredGate);
  if (env.PRELAUNCH && interaction.user.id !== env.OWNER_ID && !interaction.memberPermissions?.has?.('Administrator')) {
    throw new QuestshopError('PRELAUNCH_RESTRICTED', 'ระบบกำลังทดสอบก่อนเปิดใช้งาน');
  }
}
