import { v7 as uuidv7 } from 'uuid';
import { withTransaction } from '../../db/transaction.js';
import { enqueueProjection } from '../outbox/service.js';
import { recordTransition } from '../shared/transition.js';

async function enqueueIncidentProjection(client, incident, context) {
  const logSystemActive = (await client.query(`SELECT 1 FROM surfaces
    WHERE surface_key='LOG_SYSTEM' AND state='ACTIVE'`)).rowCount > 0;
  if (!logSystemActive) return null;
  return enqueueProjection(client, {
    projectionType: 'SYSTEM_INCIDENT', aggregateType: 'INCIDENT', aggregateId: incident.id,
    aggregateVersion: incident.state_version, surfaceKey: 'LOG_SYSTEM', context,
  });
}

async function recordIncidentTransition(client, before, after, context) {
  if (before.state === after.state) return;
  await recordTransition(client, {
    aggregateType: 'INCIDENT', aggregateId: after.id, fromState: before.state, toState: after.state,
    stateVersion: after.state_version, reasonCode: `INCIDENT_${after.state}`, context,
  });
}

async function reconcileWithClient(client, { code, scope, active, severity, evidence }, context) {
    const current = (await client.query(`SELECT * FROM incidents
      WHERE incident_code=$1 AND scope=$2
      ORDER BY (state<>'RESOLVED') DESC,updated_at DESC,id DESC LIMIT 1 FOR UPDATE`, [code, scope])).rows[0] ?? null;
    if (!active) {
      if (!current || current.state === 'RESOLVED') return { incident: current, changed: false };
      const resolved = (await client.query(`UPDATE incidents SET state='RESOLVED',state_version=state_version+1,
        resolved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND state_version=$2 RETURNING *`,
      [current.id, current.state_version])).rows[0];
      if (!resolved) return { incident: null, changed: false };
      await recordIncidentTransition(client, current, resolved, context);
      await enqueueIncidentProjection(client, resolved, context);
      return { incident: resolved, changed: true };
    }
    if (!current) {
      const created = (await client.query(`INSERT INTO incidents(
        id,incident_code,scope,state,severity,evidence,trace_id,state_version
      ) VALUES($1,$2,$3,'OPEN',$4,$5,$6,1)
      ON CONFLICT (incident_code,scope) WHERE state<>'RESOLVED' DO UPDATE SET
        severity=EXCLUDED.severity,evidence=EXCLUDED.evidence,trace_id=EXCLUDED.trace_id,
        state_version=incidents.state_version+1,updated_at=clock_timestamp()
      RETURNING *`,
      [uuidv7(), code, scope, severity, evidence, context.traceId])).rows[0];
      await enqueueIncidentProjection(client, created, context);
      return { incident: created, changed: true };
    }
    if (current.state === 'RESOLVED') {
      const reopened = (await client.query(`UPDATE incidents SET state='OPEN',severity=$2,evidence=$3,
        trace_id=$4,state_version=state_version+1,resolved_at=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND state_version=$5 RETURNING *`,
      [current.id, severity, evidence, context.traceId, current.state_version])).rows[0] ?? null;
      if (!reopened) return { incident: current, changed: false };
      await recordIncidentTransition(client, current, reopened, context);
      await enqueueIncidentProjection(client, reopened, context);
      return { incident: reopened, changed: true };
    }
    const updated = (await client.query(`UPDATE incidents SET severity=$2,evidence=$3,state_version=state_version+1,
      updated_at=clock_timestamp() WHERE id=$1 AND state_version=$4
        AND (severity IS DISTINCT FROM $2 OR evidence IS DISTINCT FROM $3) RETURNING *`,
    [current.id, severity, evidence, current.state_version])).rows[0] ?? null;
    if (!updated) return { incident: current, changed: false };
    await enqueueIncidentProjection(client, updated, context);
    return { incident: updated, changed: true };
}

export async function reconcileIncident(input, context, options = {}) {
  if (options.client) return reconcileWithClient(options.client, input, context);
  return withTransaction({ ...options, isolation: 'SERIALIZABLE', maxAttempts: 3 },
    (client) => reconcileWithClient(client, input, context));
}
