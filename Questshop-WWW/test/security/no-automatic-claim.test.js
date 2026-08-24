import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(item));
    else if (entry.name.endsWith('.js')) output.push(item);
  }
  return output;
}

test('new source graph exposes no automatic claim API', async () => {
  const violations = [];
  for (const file of await files(new URL('../../src', import.meta.url).pathname)) {
    const source = await readFile(file, 'utf8');
    if (/claimQuest|claimQuestRequest|claimRetryPolicy/.test(source)) violations.push(file);
  }
  assert.deepEqual(violations, []);
});
