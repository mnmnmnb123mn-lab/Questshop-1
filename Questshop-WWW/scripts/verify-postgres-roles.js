import '../src/config/load-local-environment.js';
import { loadEnvironment } from '../src/config/env.js';
import { getDirectPool, getRuntimePool, closeDirectPool, closePools } from '../src/db/pools.js';
import { validateRuntimeRole } from '../src/db/role-contract.js';

const env = loadEnvironment();
const runtime = getRuntimePool(env);
const direct = getDirectPool(env);
try {
  const runtimeContract = await validateRuntimeRole(runtime, { enforce: true });
  const migration = (await direct.query(`SELECT current_user AS role,
    has_schema_privilege(current_user,'public','CREATE') AS can_create_schema_objects,
    has_database_privilege(current_user,current_database(),'CONNECT') AS can_connect`)).rows[0];
  if (!migration.can_create_schema_objects) {
    throw new Error('Migration role cannot CREATE schema objects');
  }
  console.log(JSON.stringify({ ok: true, runtimeRole: runtimeContract.role,
    migrationRole: migration.role, runtimeViolations: runtimeContract.violations }));
} finally {
  await closeDirectPool();
  await closePools();
}
