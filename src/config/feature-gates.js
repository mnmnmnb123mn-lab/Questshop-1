export const FEATURE_GATES = Object.freeze([
  'STORE_OPEN',
  'CUSTOMER_INTERACTIONS_ENABLED',
  'TOPUP_ACCEPTING',
  'AUTO_CREDIT_ENABLED',
  'QUEST_SCANNER_ENABLED',
  'QUEST_BACKGROUND_TESTING_ENABLED',
  'QUEST_ANNOUNCEMENT_ENABLED',
  'ORDER_ACCEPTING',
  'RUNNER_DISPATCH_ENABLED',
  'NOTIFICATIONS_ENABLED',
  'RETENTION_JOBS_ENABLED',
]);

export const DEFAULT_FEATURE_GATES = Object.freeze({
  // A brand-new database must never accept money or run a customer token until
  // an Owner deliberately enables the relevant path during prelaunch/UAT.
  STORE_OPEN: false,
  CUSTOMER_INTERACTIONS_ENABLED: false,
  TOPUP_ACCEPTING: false,
  AUTO_CREDIT_ENABLED: false,
  QUEST_SCANNER_ENABLED: false,
  QUEST_BACKGROUND_TESTING_ENABLED: false,
  QUEST_ANNOUNCEMENT_ENABLED: false,
  ORDER_ACCEPTING: false,
  RUNNER_DISPATCH_ENABLED: false,
  // These are safe to leave available: they only deliver durable status or
  // remove already-expired encrypted payloads.
  NOTIFICATIONS_ENABLED: true,
  RETENTION_JOBS_ENABLED: true,
});

export function assertFeatureGate(gate) {
  if (!FEATURE_GATES.includes(gate)) throw new Error(`Unknown feature gate: ${gate}`);
  return gate;
}
