import assert from 'node:assert/strict';
import test from 'node:test';
import { recomputeHealthStatus } from '../../src/bootstrap/health-status.js';

function health(overrides = {}) {
  return { ready: true, checks: {}, ...overrides };
}

test('health recomputation recovers from a transient degraded component', () => {
  const state = health({ checks: { database: 'DEGRADED' } });
  assert.equal(recomputeHealthStatus({ health: state, operationalStatus: 'DEGRADED' }), 'DEGRADED');
  state.checks.database = 'OK';
  assert.equal(recomputeHealthStatus({ health: state, operationalStatus: 'HEALTHY' }), 'HEALTHY');
});

test('health precedence preserves incidents and readiness failures', () => {
  assert.equal(recomputeHealthStatus({ health: health({ ready: false }), operationalStatus: 'INCIDENT' }), 'INCIDENT');
  assert.equal(recomputeHealthStatus({ health: health({ ready: false }), operationalStatus: 'HEALTHY' }), 'NOT_READY');
});

test('missing receiver remains degraded after an alert pass reports healthy operations', () => {
  const state = health({ checks: { payments: 'MISSING_RECEIVER' } });
  assert.equal(recomputeHealthStatus({ health: state, operationalStatus: 'HEALTHY' }), 'DEGRADED');
});

test('maintenance is visible only when the runtime is ready and components are healthy', () => {
  assert.equal(recomputeHealthStatus({ health: health(), operationalStatus: 'MAINTENANCE' }), 'MAINTENANCE');
  assert.equal(recomputeHealthStatus({ health: health({ checks: { runtimeRole: 'DEGRADED' } }), operationalStatus: 'MAINTENANCE' }), 'DEGRADED');
});

