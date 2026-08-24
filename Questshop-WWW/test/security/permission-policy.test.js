import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('runtime has no generic Permission Drift detector or repair route', async () => {
  const sources = [
    await readFile(new URL('../../src/bootstrap/startup.js', import.meta.url), 'utf8'),
    await readFile(new URL('../../src/workers/maintenance-worker.js', import.meta.url), 'utf8'),
    await readFile(new URL('../../src/workers/outbox-worker.js', import.meta.url), 'utf8'),
    await readFile(new URL('../../src/discord/interactions/router.js', import.meta.url), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(sources, /checkPermissionDrift|repairPermissionDrift|PERMISSION_DRIFT/);
  assert.doesNotMatch(sources, /perm_repair/);
});

test('startup requires Administrator while LOG_PAYMENTS human visibility stays Owner-managed', async () => {
  const startup = await readFile(new URL('../../src/bootstrap/startup.js', import.meta.url), 'utf8');
  const setup = await readFile(new URL('../../src/discord/surfaces/setup.js', import.meta.url), 'utf8');
  const outbox = await readFile(new URL('../../src/workers/outbox-worker.js', import.meta.url), 'utf8');
  assert.match(startup, /Administrator/);
  assert.match(setup, /Owner-managed Discord permission policy/);
  assert.doesNotMatch(setup, /PermissionFlagsBits/);
  assert.doesNotMatch(setup, /ต้องซ่อนจาก @everyone|เปิดให้ยศ .* มองเห็น/);
  assert.doesNotMatch(outbox, /checkPermissionDrift|repairPermissionDrift|PERMISSION_DRIFT/);
  assert.doesNotMatch(setup, /SURFACE_PERMISSION_MISSING|checkPermissionDrift|repairPermissionDrift/);
});
