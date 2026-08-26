import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('runtime entrypoint uses the scoped environment loader and startup never runs migrations', async () => {
  const [entrypoint, startup] = await Promise.all([
    readFile(new URL('../../src/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/bootstrap/startup.js', import.meta.url), 'utf8'),
  ]);
  assert.match(entrypoint, /load-runtime-environment/);
  assert.doesNotMatch(entrypoint, /load-local-environment/);
  assert.doesNotMatch(startup, /runMigrations|migrateWithBackup|getDirectPool|DATABASE_DIRECT_URL/);
  assert.match(startup, /validateSchemaCompatibility/);
});
