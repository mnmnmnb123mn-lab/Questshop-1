const APPEND_ONLY_TABLES = new Set(['wallet_transactions', 'admin_audit_logs', 'release_evidence']);
const READ_ONLY_TABLES = new Set(['schema_migrations', 'crypto_key_sentinels']);

export const ALLOWED_RUNTIME_FUNCTIONS = Object.freeze([
  'public.questshop_prune_wallet_ledger(timestamp with time zone,integer)',
  'public.questshop_prune_operational_details(timestamp with time zone,timestamp with time zone,integer)',
]);

const ALLOWED_FUNCTION_OIDS_SQL = `p.oid = ANY (ARRAY[
  to_regprocedure('public.questshop_prune_wallet_ledger(timestamp with time zone,integer)'),
  to_regprocedure('public.questshop_prune_operational_details(timestamp with time zone,timestamp with time zone,integer)')
])`;

const PRIVILEGE_SYNCHRONIZATION_SQL = String.raw`
DO $questshop_privileges$
DECLARE
  runtime_role name := current_setting('questshop.runtime_role', true)::name;
  migrator_oid oid := current_user::regrole;
  object record;
  required_function regprocedure;
  required_functions regprocedure[] := ARRAY[
    to_regprocedure('public.questshop_prune_wallet_ledger(timestamp with time zone,integer)'),
    to_regprocedure('public.questshop_prune_operational_details(timestamp with time zone,timestamp with time zone,integer)')
  ];
BEGIN
  IF runtime_role IS NULL OR runtime_role = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RUNTIME_ROLE_REQUIRED';
  END IF;

  -- Default ACLs belong to the Migrator. Revoke first so an old deployment
  -- cannot leave Runtime with INSERT/UPDATE/DELETE or function EXECUTE.
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC';
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I', runtime_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO %I', runtime_role);
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC';
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I', runtime_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', runtime_role);
  EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
  EXECUTE format('ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM %I', runtime_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I', runtime_role);

  FOR object IN
    SELECT required_name
    FROM unnest(ARRAY['wallet_transactions', 'admin_audit_logs', 'release_evidence',
      'schema_migrations', 'crypto_key_sentinels']) AS required_name
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND c.relname = object.required_name AND c.relowner = migrator_oid
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid AND d.deptype = 'e')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = format('PRIVILEGE_OBJECT_OWNER_MISMATCH: Migrator does not own required table %s', object.required_name);
    END IF;
  END LOOP;

  FOR object IN
    SELECT c.relname,
      CASE
        WHEN c.relname = ANY (ARRAY['wallet_transactions', 'admin_audit_logs', 'release_evidence']) THEN 'SELECT, INSERT'
        WHEN c.relname = ANY (ARRAY['schema_migrations', 'crypto_key_sentinels']) THEN 'SELECT'
        ELSE 'SELECT, INSERT, UPDATE, DELETE'
      END AS runtime_privileges
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relowner = migrator_oid
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
        AND d.objid = c.oid AND d.deptype = 'e')
    ORDER BY c.relname
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC', object.relname);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I', object.relname, runtime_role);
    EXECUTE format('GRANT %s ON TABLE public.%I TO %I', object.runtime_privileges, object.relname, runtime_role);
  END LOOP;

  FOR object IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S' AND c.relowner = migrator_oid
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
        AND d.objid = c.oid AND d.deptype = 'e')
    ORDER BY c.relname
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM PUBLIC', object.relname);
    EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM %I', object.relname, runtime_role);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I', object.relname, runtime_role);
  END LOOP;

  FOREACH required_function IN ARRAY required_functions LOOP
    IF required_function IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.oid = required_function AND p.proowner = migrator_oid
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'PRIVILEGE_FUNCTION_CONTRACT_MISMATCH: required Questshop retention function is missing or has a different owner/signature';
    END IF;
  END LOOP;

  FOR object IN
    SELECT p.oid, n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS identity_arguments,
      p.oid = ANY (required_functions) AS is_allowed
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'questshop\_%' ESCAPE '\' AND p.proowner = migrator_oid
    ORDER BY p.proname, p.oid
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM PUBLIC',
      object.nspname, object.proname, object.identity_arguments);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM %I',
      object.nspname, object.proname, object.identity_arguments, runtime_role);
    IF object.is_allowed THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(%s) TO %I',
        object.nspname, object.proname, object.identity_arguments, runtime_role);
    END IF;
  END LOOP;
END
$questshop_privileges$`;

const PRIVILEGE_SUMMARY_SQL = String.raw`SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relowner = current_user::regrole
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
        AND d.objid = c.oid AND d.deptype = 'e')) AS tables,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S' AND c.relowner = current_user::regrole
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
        AND d.objid = c.oid AND d.deptype = 'e')) AS sequences,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'questshop\_%' ESCAPE '\'
      AND p.proowner = current_user::regrole) AS functions`;

export function assertRuntimeRole(runtimeRole, migratorRole = null) {
  if (typeof runtimeRole !== 'string' || runtimeRole.trim() === '') {
    throw Object.assign(new Error('DATABASE_POOL_URL must name a non-empty runtime role for privilege synchronization'), {
      code: 'RUNTIME_ROLE_REQUIRED',
    });
  }
  if (migratorRole && runtimeRole === migratorRole) {
    throw Object.assign(new Error('Runtime role must differ from PostgreSQL current_user used for migrations'), {
      code: 'RUNTIME_MIGRATOR_ROLE_CONFLICT',
    });
  }
  return runtimeRole;
}

export async function synchronizeRuntimeObjectPrivileges(client, { runtimeRole }) {
  const migratorRole = (await client.query('SELECT current_user AS role')).rows[0].role;
  assertRuntimeRole(runtimeRole, migratorRole);
  await client.query("SELECT set_config('questshop.runtime_role', $1, true)", [runtimeRole]);
  await client.query(PRIVILEGE_SYNCHRONIZATION_SQL);
  const summary = (await client.query(PRIVILEGE_SUMMARY_SQL)).rows[0];
  return { migratorRole, tables: Number(summary.tables), sequences: Number(summary.sequences), functions: Number(summary.functions) };
}

export async function inspectRuntimeObjectPrivileges(client, { runtimeRole }) {
  assertRuntimeRole(runtimeRole);
  const schema = await client.query(`SELECT has_schema_privilege($1,'public','USAGE') AS can_use_schema,
      has_schema_privilege($1,'public','CREATE') AS can_create_schema_objects`, [runtimeRole]);
  const tables = await client.query(`SELECT c.oid, c.relname, pg_get_userbyid(c.relowner) AS owner,
      has_table_privilege($1,c.oid,'SELECT') AS can_select,
      has_table_privilege($1,c.oid,'INSERT') AS can_insert,
      has_table_privilege($1,c.oid,'UPDATE') AS can_update,
      has_table_privilege($1,c.oid,'DELETE') AS can_delete,
      has_table_privilege($1,c.oid,'TRUNCATE') AS can_truncate,
      has_table_privilege($1,c.oid,'REFERENCES') AS can_reference,
      has_table_privilege($1,c.oid,'TRIGGER') AS can_trigger
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
          AND d.objid=c.oid AND d.deptype='e') ORDER BY c.relname`, [runtimeRole]);
  const sequences = await client.query(`SELECT c.oid, c.relname, pg_get_userbyid(c.relowner) AS owner,
      has_sequence_privilege($1,c.oid,'USAGE') AS can_use,
      has_sequence_privilege($1,c.oid,'SELECT') AS can_select,
      has_sequence_privilege($1,c.oid,'UPDATE') AS can_update
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='S'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
          AND d.objid=c.oid AND d.deptype='e') ORDER BY c.relname`, [runtimeRole]);
  const functions = await client.query(String.raw`SELECT p.oid, p.proname,
      format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))::text AS identity,
      pg_get_userbyid(p.proowner) AS owner,
      ${ALLOWED_FUNCTION_OIDS_SQL} AS is_allowed,
      has_function_privilege($1,p.oid,'EXECUTE') AS can_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'questshop\_%' ESCAPE '\'
      ORDER BY p.proname,p.oid`, [runtimeRole]);
  const ownership = await client.query(String.raw`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','S')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
            AND d.objid=c.oid AND d.deptype='e')
          AND pg_get_userbyid(c.relowner)=$1) AS owns_relation,
      EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname LIKE 'questshop\_%' ESCAPE '\'
          AND pg_get_userbyid(p.proowner)=$1) AS owns_function`, [runtimeRole]);
  return { runtimeRole, schema: schema.rows[0], tables: tables.rows, sequences: sequences.rows,
    functions: functions.rows, ownership: ownership.rows[0] };
}

function tablePrivileges(name) {
  if (APPEND_ONLY_TABLES.has(name)) return ['SELECT', 'INSERT'];
  if (READ_ONLY_TABLES.has(name)) return ['SELECT'];
  return ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
}

function addSchemaViolations(snapshot, violations) {
  if (!snapshot.schema.can_use_schema) violations.push('runtime role cannot use public schema');
  if (snapshot.schema.can_create_schema_objects) violations.push('runtime role can CREATE in public schema');
  if (snapshot.ownership.owns_relation || snapshot.ownership.owns_function) {
    violations.push('runtime role owns Questshop application objects');
  }
}

function addTableViolations(tables, violations) {
  for (const table of tables) {
    const expected = new Set(tablePrivileges(table.relname));
    const checks = { SELECT: table.can_select, INSERT: table.can_insert, UPDATE: table.can_update, DELETE: table.can_delete };
    for (const [privilege, granted] of Object.entries(checks)) {
      if (expected.has(privilege) !== granted) violations.push(`table ${table.relname} ${privilege} effective privilege violates policy`);
    }
    if (table.can_truncate || table.can_reference || table.can_trigger) {
      violations.push(`table ${table.relname} has forbidden effective structural privilege`);
    }
  }
}

function addSequenceViolations(sequences, violations) {
  for (const sequence of sequences) {
    if (!sequence.can_use || !sequence.can_select || sequence.can_update) {
      violations.push(`sequence ${sequence.relname} effective privilege violates policy`);
    }
  }
}

function addFunctionViolations(functions, violations) {
  for (const fn of functions) {
    if (fn.is_allowed !== fn.can_execute) {
      violations.push(`function ${fn.identity} effective EXECUTE privilege violates policy`);
    }
  }
  if (functions.filter((fn) => fn.is_allowed).length !== ALLOWED_RUNTIME_FUNCTIONS.length) {
    violations.push('one or more required Questshop retention functions are missing');
  }
}

export function runtimePrivilegeViolations(snapshot) {
  const violations = [];
  addSchemaViolations(snapshot, violations);
  addTableViolations(snapshot.tables, violations);
  addSequenceViolations(snapshot.sequences, violations);
  addFunctionViolations(snapshot.functions, violations);
  return violations;
}
