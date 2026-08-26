export const APP_VERSION = '0.1.0';
export const ENGINE_VERSION = '1.0.0';
export const EXECUTOR_VERSION = '1.0.0';
export const QUEST_CONTRACT_VERSION = '1.0.0';
export const RUNNER_STATE_SCHEMA_VERSION = 1;
// The worker keeps the current and immediately previous engine contracts live so
// an application rollout can drain N-1 jobs. Remove an N-1 tuple only after the
// database proves that no active item/job/test still pins it.
export const RUNNER_VERSION_COMPATIBILITY = Object.freeze([
  Object.freeze({ engine: '1.0.0', executor: '1.0.0', contract: '1.0.0', stateSchema: 1 }),
  Object.freeze({ engine: '0.9.0', executor: '0.9.0', contract: '0.9.0', stateSchema: 1 }),
  // Initial fixtures and pre-release jobs used the short version before v1 was cut.
  Object.freeze({ engine: '1', executor: '1', contract: '1', stateSchema: 1 }),
]);

export function isRunnerVersionCompatible(value) {
  return RUNNER_VERSION_COMPATIBILITY.some((supported) => supported.engine === value.engine_version
    && supported.executor === value.executor_version
    && supported.contract === value.contract_version
    && supported.stateSchema === Number(value.runner_state_schema_version ?? 1));
}
// Runtime code depends on every migration through the current expand schema.
// Deployment applies migrations before starting the all-in-one process, so a
// partially migrated database must fail readiness instead of failing later in
// a payment/runner worker.
export const MIN_COMPATIBLE_SCHEMA_VERSION = 33;
export const MAX_COMPATIBLE_SCHEMA_VERSION = 33;
