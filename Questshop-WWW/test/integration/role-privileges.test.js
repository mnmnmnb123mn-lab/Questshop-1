import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrations.js';
import { validateRuntimeRole } from '../../src/db/role-contract.js';
import { createIsolatedTestPool } from '../fixtures/postgres.js';

let adminPool;
let migratorPool;
let roles;
let adminRole;

function identifier(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}

function roleName(prefix) {
  return 'questshop_' + prefix + '_' + randomBytes(6).toString('hex');
}

function sqlLiteral(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}

function createMigratorPool(connectionString, role, password) {
  const url = new URL(connectionString);
  url.username = role;
  url.password = password;
  return new pg.Pool({ connectionString: url.toString(), max: 1 });
}

async function queryAsMigrator(text, values = []) {
  const client = await migratorPool.connect();
  try {
    return await client.query(text, values);
  } finally {
    client.release();
  }
}

async function publicFunctionExecute(signature) {
  return (await adminPool.query("SELECT EXISTS("
    + " SELECT 1 FROM pg_proc p "
    + " CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) privilege "
    + " WHERE p.oid = to_regprocedure($1) AND privilege.grantee = 0 "
    + " AND privilege.privilege_type = 'EXECUTE'"
    + " ) AS value", [signature])).rows[0].value;
}

async function publicTablePrivilege(table, privilege) {
  return (await adminPool.query("SELECT EXISTS("
    + " SELECT 1 FROM pg_class c "
    + " CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl "
    + " WHERE c.oid = $1::regclass AND acl.grantee = 0 AND acl.privilege_type = $2"
    + " ) AS value", [table, privilege])).rows[0].value;
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  adminPool = await createIsolatedTestPool({ max: 3, applyMigrations: false });
  adminRole = (await adminPool.query('SELECT current_user AS role')).rows[0].role;
  roles = {
    migrator: roleName('migrator'),
    migratorPassword: randomBytes(24).toString('hex'),
    runtime: roleName('runtime'),
    inherited: roleName('inherited'),
    schemaProbe: roleName('schema_probe'),
  };
  await adminPool.query('CREATE ROLE ' + identifier(roles.migrator)
    + ' LOGIN PASSWORD ' + sqlLiteral(roles.migratorPassword));
  for (const role of [roles.runtime, roles.inherited, roles.schemaProbe]) {
    await adminPool.query('CREATE ROLE ' + identifier(role));
  }
  await adminPool.query('GRANT USAGE, CREATE ON SCHEMA public TO ' + identifier(roles.migrator));
  await adminPool.query('GRANT USAGE ON SCHEMA public TO ' + identifier(roles.runtime));
  await adminPool.query('CREATE FUNCTION provider_extension_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$');
  migratorPool = createMigratorPool(process.env.TEST_DATABASE_URL, roles.migrator, roles.migratorPassword);
  const first = await runMigrations({ pool: migratorPool, gitSha: 'role-contract-test', runtimeRole: roles.runtime });
  assert.equal(first.privilegeSynchronization.status, 'PASS');
});

after(async () => {
  await migratorPool?.end();
  if (adminPool && roles) {
    await adminPool.query('REVOKE ' + identifier(roles.inherited) + ' FROM ' + identifier(roles.runtime)).catch(() => null);
    await adminPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public').catch(() => null);
    for (const role of [roles.migrator, roles.runtime, roles.inherited, roles.schemaProbe]) {
      await adminPool.query('DROP OWNED BY ' + identifier(role) + '; DROP ROLE ' + identifier(role)).catch(() => null);
    }
  }
  await adminPool?.end();
});

test('separate effective Migrator role applies object sync without schema grant option', async (t) => {
  if (!adminPool) return t.skip('TEST_DATABASE_URL not set');
  const identity = (await queryAsMigrator("SELECT current_user AS current_role, session_user AS session_role, "
    + "(SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'public') AS schema_owner")).rows[0];
  assert.deepEqual(identity, { current_role: roles.migrator, session_role: roles.migrator, schema_owner: adminRole });
  const canDelegateSchemaCreate = (await adminPool.query("SELECT COALESCE(bool_or(privilege.is_grantable), false) AS value "
    + "FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) privilege "
    + "WHERE n.nspname = 'public' AND privilege.grantee = $1::regrole "
    + "AND privilege.privilege_type = 'CREATE'", [roles.migrator])).rows[0].value;
  assert.equal(canDelegateSchemaCreate, false);
  const owners = (await adminPool.query("SELECT c.relname, pg_get_userbyid(c.relowner) AS owner "
    + " FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
    + " WHERE n.nspname = 'public' AND c.relname IN ("
    + "'wallet_transactions', 'admin_audit_logs', 'release_evidence', 'schema_migrations', 'crypto_key_sentinels'"
    + " )")).rows;
  assert.equal(owners.length, 5);
  assert.ok(owners.every((row) => row.owner === roles.migrator));
  const result = await runMigrations({ pool: migratorPool, gitSha: 'role-contract-test', runtimeRole: roles.runtime });
  assert.equal(result.applied, 0);
  assert.equal(result.privilegeSynchronization.status, 'PASS');
});

test('applied-zero synchronization removes stale default ACLs and rolls back as one transaction', async (t) => {
  if (!adminPool) return t.skip('TEST_DATABASE_URL not set');
  await adminPool.query('ALTER DEFAULT PRIVILEGES FOR ROLE ' + identifier(roles.migrator)
    + ' IN SCHEMA public GRANT INSERT, UPDATE ON TABLES TO ' + identifier(roles.runtime));
  await adminPool.query('ALTER DEFAULT PRIVILEGES FOR ROLE ' + identifier(roles.migrator)
    + ' IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC');
  await adminPool.query('ALTER DEFAULT PRIVILEGES FOR ROLE ' + identifier(roles.migrator)
    + ' IN SCHEMA public GRANT UPDATE ON SEQUENCES TO ' + identifier(roles.runtime));
  await adminPool.query('ALTER DEFAULT PRIVILEGES FOR ROLE ' + identifier(roles.migrator)
    + ' GRANT EXECUTE ON FUNCTIONS TO PUBLIC');
  await adminPool.query('ALTER TABLE wallet_transactions OWNER TO ' + identifier(adminRole));
  await assert.rejects(
    () => runMigrations({ pool: migratorPool, gitSha: 'role-contract-test', runtimeRole: roles.runtime }),
    /Migrator does not own required table wallet_transactions/,
  );
  await queryAsMigrator('CREATE TABLE default_acl_rollback_probe(id serial PRIMARY KEY)');
  await queryAsMigrator('CREATE FUNCTION questshop_default_acl_rollback_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$');
  const failedAcl = (await adminPool.query("SELECT "
    + " has_table_privilege($1, 'default_acl_rollback_probe', 'INSERT') AS can_insert, "
    + " has_table_privilege($1, 'default_acl_rollback_probe', 'UPDATE') AS can_update, "
    + " has_sequence_privilege($1, pg_get_serial_sequence('default_acl_rollback_probe', 'id'), 'UPDATE') AS can_update_sequence",
  [roles.runtime])).rows[0];
  assert.deepEqual(failedAcl, { can_insert: true, can_update: true, can_update_sequence: true });
  assert.equal(await publicTablePrivilege('default_acl_rollback_probe', 'SELECT'), true);
  assert.equal(await publicFunctionExecute('public.questshop_default_acl_rollback_probe()'), true);
  await queryAsMigrator('DROP FUNCTION questshop_default_acl_rollback_probe()');
  await adminPool.query('DROP TABLE default_acl_rollback_probe');
  await adminPool.query('ALTER TABLE wallet_transactions OWNER TO ' + identifier(roles.migrator));
  const repaired = await runMigrations({ pool: migratorPool, gitSha: 'role-contract-test', runtimeRole: roles.runtime });
  assert.equal(repaired.applied, 0);
  assert.equal(repaired.privilegeSynchronization.status, 'PASS');
  await queryAsMigrator('CREATE TABLE default_acl_repaired_probe(id serial PRIMARY KEY)');
  await queryAsMigrator('CREATE FUNCTION questshop_default_acl_repaired_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$');
  const repairedAcl = (await adminPool.query("SELECT "
    + " has_table_privilege($1, 'default_acl_repaired_probe', 'SELECT') AS can_select, "
    + " has_table_privilege($1, 'default_acl_repaired_probe', 'INSERT') AS can_insert, "
    + " has_table_privilege($1, 'default_acl_repaired_probe', 'UPDATE') AS can_update, "
    + " has_sequence_privilege($1, pg_get_serial_sequence('default_acl_repaired_probe', 'id'), 'UPDATE') AS can_update_sequence",
  [roles.runtime])).rows[0];
  assert.deepEqual(repairedAcl, { can_select: true, can_insert: false, can_update: false, can_update_sequence: false });
  assert.equal(await publicTablePrivilege('default_acl_repaired_probe', 'SELECT'), false);
  assert.equal(await publicFunctionExecute('public.questshop_default_acl_repaired_probe()'), false);
  await queryAsMigrator('DROP FUNCTION questshop_default_acl_repaired_probe()');
  await adminPool.query('DROP TABLE default_acl_repaired_probe');
});

test('effective PUBLIC and inherited privileges fail the runtime validator', async (t) => {
  if (!adminPool) return t.skip('TEST_DATABASE_URL not set');
  await adminPool.query('GRANT DELETE ON wallet_transactions TO PUBLIC');
  const publicContract = await validateRuntimeRole(adminPool, { enforce: false, runtimeRole: roles.runtime });
  assert.match(publicContract.violations.join('; '), /wallet_transactions DELETE effective privilege/);
  await adminPool.query('REVOKE DELETE ON wallet_transactions FROM PUBLIC');

  await queryAsMigrator('CREATE FUNCTION questshop_inherited_privilege_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$');
  await adminPool.query('GRANT EXECUTE ON FUNCTION questshop_inherited_privilege_probe() TO ' + identifier(roles.inherited));
  await adminPool.query('GRANT ' + identifier(roles.inherited) + ' TO ' + identifier(roles.runtime));
  const inheritedContract = await validateRuntimeRole(adminPool, { enforce: false, runtimeRole: roles.runtime });
  assert.match(inheritedContract.violations.join('; '), /questshop_inherited_privilege_probe.*EXECUTE/);
  await adminPool.query('REVOKE ' + identifier(roles.inherited) + ' FROM ' + identifier(roles.runtime));
  await queryAsMigrator('DROP FUNCTION questshop_inherited_privilege_probe()');
  const cleanContract = await validateRuntimeRole(adminPool, { enforce: false, runtimeRole: roles.runtime });
  assert.deepEqual(cleanContract.violations, []);
});

test('current Questshop functions deny PUBLIC while provider functions remain untouched', async (t) => {
  if (!adminPool) return t.skip('TEST_DATABASE_URL not set');
  for (const signature of [
    'public.questshop_prune_wallet_ledger(timestamp with time zone,integer)',
    'public.questshop_prune_operational_details(timestamp with time zone,timestamp with time zone,integer)',
  ]) {
    assert.equal(await publicFunctionExecute(signature), false);
  }
  // The surrounding test suite can change the admin role's default ACLs. The
  // contract is that synchronization never changes provider-owned functions,
  // whatever their pre-existing PUBLIC policy happens to be.
  const providerPublicExecuteBefore = await publicFunctionExecute('public.provider_extension_probe()');
  const result = await runMigrations({ pool: migratorPool, gitSha: 'role-contract-test', runtimeRole: roles.runtime });
  assert.equal(result.privilegeSynchronization.status, 'PASS');
  assert.equal(await publicFunctionExecute('public.provider_extension_probe()'), providerPublicExecuteBefore);
});

test('missing or differently owned retention functions fail closed before privilege sync commits', async (t) => {
  if (!adminPool) return t.skip('TEST_DATABASE_URL not set');
  await adminPool.query('ALTER FUNCTION public.questshop_prune_wallet_ledger(timestamp with time zone,integer) OWNER TO '
    + identifier(adminRole));
  await assert.rejects(
    () => runMigrations({ pool: migratorPool, gitSha: 'role-contract-test', runtimeRole: roles.runtime }),
    /retention function is missing or has a different owner/i,
  );
  await adminPool.query('ALTER FUNCTION public.questshop_prune_wallet_ledger(timestamp with time zone,integer) OWNER TO '
    + identifier(roles.migrator));
  const repaired = await runMigrations({ pool: migratorPool, gitSha: 'role-contract-test', runtimeRole: roles.runtime });
  assert.equal(repaired.privilegeSynchronization.status, 'PASS');
});
