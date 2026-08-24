-- Permission Drift monitoring was removed from the product policy.  The
-- one-time setup command still validates minimum access, but surfaces no
-- longer persist an expected-permission snapshot for runtime comparison.
ALTER TABLE surfaces DROP COLUMN IF EXISTS expected_permissions;
