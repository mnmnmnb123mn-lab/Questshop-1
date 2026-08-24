# PostgreSQL role contract

Production Runtime and Migration URLs require TLS `sslmode=verify-full`. Questshop validates the source URL policy,
then removes libpq SSL query parameters only from the copy passed to `pg`; explicit CA data remains in the `pg` SSL
object with `rejectUnauthorized: true`.

## Aiven/Admin bootstrap — outside Questshop

Provider administrator owns role creation, `CONNECT`, role membership and schema privileges:

- `questshop_migrator`: `USAGE, CREATE` on `public`, used only by direct migration/deployment connection.
- `questshop_runtime`: `USAGE` on `public`, never `CREATE`, used by the pooled runtime connection.
- backup/restore roles are required only for the optional `BACKUP_MODE=LOCAL_S3` compatibility path.

Questshop never creates roles, changes membership or expands schema authority from runtime code.

## Migration-time object synchronization

After every migration loop, including `applied: 0`, deployment opens one object-privilege transaction.
The effective Migrator role must differ from the Runtime role derived from `DATABASE_POOL_URL`.

For Migrator-owned objects in `public`:

- revoke stale Runtime/`PUBLIC` defaults first;
- future tables: Runtime `SELECT` plus the project-defined DML policy;
- future sequences: Runtime `USAGE, SELECT`;
- protected append-only tables (`wallet_transactions`, `admin_audit_logs`, `release_evidence`): Runtime only
  `SELECT, INSERT`;
- `schema_migrations` and `crypto_key_sentinels`: Runtime read-only;
- future functions: remove `PUBLIC EXECUTE`;
- Runtime execute allowlist is limited to Questshop retention functions.

The read-only Runtime validator uses PostgreSQL effective-privilege checks so direct, inherited and `PUBLIC` grants all
count. Forbidden effective privilege is a provisioning violation and fails closed.

## Quest Auto pricing impact

The dynamic Quest Auto storefront adds **no new database role or write privilege**.
`configuredQuestPriceRange()` performs a read-only aggregate over active `price_rules` rows for the four supported
`TYPE` task types. Runtime already requires `SELECT` on `price_rules` for normal pricing/checkout behavior.

The storefront reconciliation path may read:

- `price_rules` to derive `{ minCents, maxCents }`;
- `surfaces` to locate/update durable Discord surface pointers through existing application paths;
- incident/audit tables through their existing domain services when reconciliation fails or succeeds.

It does not mutate Wallet/Ledger/payment/order state when refreshing title, price text or media.
No migration is required for the Quest Auto price/media change.

## Deployment validation

A compliant production deployment must prove:

1. Direct and Runtime URLs use different effective roles.
2. Both URLs retain `sslmode=verify-full` policy.
3. Runtime has `USAGE` but no `CREATE` on `public`.
4. Protected append-only tables deny Runtime update/delete even through inherited/`PUBLIC` grants.
5. Object synchronization passes after migration, including when `applied: 0`.
6. `price_rules` remains readable by Runtime so checkout and Quest Auto can resolve customer pricing.

These are source/test contracts until live Aiven provisioning is verified on the exact deployed Git SHA.
