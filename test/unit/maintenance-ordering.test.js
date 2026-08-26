import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('sellable Quest maintenance prioritizes active sale states before its bounded limit', async () => {
  const source = await readFile(new URL('../../src/workers/maintenance-worker.js', import.meta.url), 'utf8');
  assert.match(source, /ORDER BY CASE sale_state WHEN 'OPEN' THEN 0 WHEN 'PAUSED' THEN 1 ELSE 2 END,\s*expires_at NULLS LAST,updated_at,quest_id LIMIT 100/);
});
