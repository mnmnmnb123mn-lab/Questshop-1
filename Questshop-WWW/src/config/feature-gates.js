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

export const DEFAULT_FEATURE_GATES = Object.freeze(
  // A new Questshop installation is usable as soon as its Owner installs the
  // relevant Discord surfaces. Gates remain an internal circuit breaker for
  // incidents; they are not a storefront configuration task.
  Object.fromEntries(FEATURE_GATES.map((gate) => [gate, true])),
);

export function assertFeatureGate(gate) {
  if (!FEATURE_GATES.includes(gate)) throw new Error(`Unknown feature gate: ${gate}`);
  return gate;
}
