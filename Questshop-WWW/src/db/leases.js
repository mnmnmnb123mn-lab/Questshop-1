import { FencingLostError } from '../shared/errors.js';
import { withTransaction } from './transaction.js';

export async function acquireLease({
  resourceType,
  resourceId,
  holder,
  ttlSeconds,
}, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const result = await client.query(`
      INSERT INTO runtime_leases(
        resource_type, resource_id, lease_owner, fencing_token,
        lease_expires_at, heartbeat_at
      ) VALUES ($1, $2, $3, 1, clock_timestamp() + make_interval(secs => $4), clock_timestamp())
      ON CONFLICT (resource_type, resource_id) DO UPDATE SET
        lease_owner = EXCLUDED.lease_owner,
        fencing_token = runtime_leases.fencing_token + 1,
        lease_expires_at = EXCLUDED.lease_expires_at,
        heartbeat_at = EXCLUDED.heartbeat_at
      WHERE runtime_leases.lease_expires_at <= clock_timestamp()
         OR runtime_leases.lease_owner = EXCLUDED.lease_owner
      RETURNING *
    `, [resourceType, resourceId, holder, ttlSeconds]);
    return result.rows[0] ?? null;
  });
}

export async function renewLease({
  resourceType,
  resourceId,
  holder,
  fencingToken,
  ttlSeconds,
}, options = {}) {
  const result = await withTransaction({ ...options, isolation: 'READ COMMITTED' }, (client) => (
    client.query(`
      UPDATE runtime_leases
      SET lease_expires_at = clock_timestamp() + make_interval(secs => $5),
          heartbeat_at = clock_timestamp()
      WHERE resource_type = $1 AND resource_id = $2
        AND lease_owner = $3 AND fencing_token = $4
        AND lease_expires_at > clock_timestamp()
      RETURNING *
    `, [resourceType, resourceId, holder, fencingToken, ttlSeconds])
  ));
  if (!result.rows[0]) throw new FencingLostError(`${resourceType}:${resourceId}`);
  return result.rows[0];
}

export async function releaseLease({ resourceType, resourceId, holder, fencingToken }, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, (client) => client.query(`
    DELETE FROM runtime_leases
    WHERE resource_type = $1 AND resource_id = $2
      AND lease_owner = $3 AND fencing_token = $4
  `, [resourceType, resourceId, holder, fencingToken]));
}

