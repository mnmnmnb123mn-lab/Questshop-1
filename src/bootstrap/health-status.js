const COMPONENT_DEGRADED_STATES = new Set([
  'DEGRADED', 'FAILED', 'INVALID', 'MISSING_RECEIVER', 'NOT_READY',
]);

function hasDegradedComponent(checks = {}) {
  return Object.values(checks).some((value) => COMPONENT_DEGRADED_STATES.has(value));
}

/**
 * Recomputes the externally visible status from readiness checks and the
 * latest operational snapshot. The current status is deliberately not an
 * input, so a transient database error cannot remain sticky forever.
 */
export function recomputeHealthStatus({ health, operationalStatus = health.operationalStatus ?? 'HEALTHY' }) {
  if (operationalStatus === 'INCIDENT') return 'INCIDENT';
  if (!health.ready) return 'NOT_READY';
  if (hasDegradedComponent(health.checks)) return 'DEGRADED';
  if (operationalStatus === 'DEGRADED') return 'DEGRADED';
  if (operationalStatus === 'MAINTENANCE') return 'MAINTENANCE';
  return 'HEALTHY';
}

