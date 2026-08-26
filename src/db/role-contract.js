import { assertRuntimeRole, inspectRuntimeObjectPrivileges, runtimePrivilegeViolations } from './role-privileges.js';

export async function validateRuntimeRole(client, { enforce = true, runtimeRole = null } = {}) {
  const effectiveRole = runtimeRole ?? (await client.query('SELECT current_user AS role')).rows[0].role;
  assertRuntimeRole(effectiveRole);
  const snapshot = await inspectRuntimeObjectPrivileges(client, { runtimeRole: effectiveRole });
  const violations = runtimePrivilegeViolations(snapshot);
  if (enforce && violations.length) {
    throw Object.assign(new Error(`PostgreSQL runtime role contract failed: ${violations.join('; ')}`), {
      code: 'POSTGRES_RUNTIME_ROLE_CONTRACT_FAILED', violations,
    });
  }
  return { role: effectiveRole, ...snapshot.schema, violations, snapshot };
}
