-- Permission Drift monitoring/repair was removed from the product policy.
-- Keep the historical state literals for migration compatibility, but do not
-- leave a surface stranded in the retired DRIFTED state after upgrade.
UPDATE surfaces
SET state = 'ACTIVE',
    state_version = state_version + 1,
    updated_at = clock_timestamp()
WHERE state = 'DRIFTED';

UPDATE incidents
SET state = 'RESOLVED',
    severity = 'WARNING',
    evidence = evidence || jsonb_build_object(
      'resolved_reason', 'PERMISSION_DRIFT_FEATURE_REMOVED',
      'resolved_at', clock_timestamp()
    ),
    updated_at = clock_timestamp()
WHERE incident_code = 'PERMISSION_DRIFT' AND state <> 'RESOLVED';
