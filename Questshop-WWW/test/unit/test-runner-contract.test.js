import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

function runTestRunner(environment) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/test-files.js', 'test/unit'], {
      cwd: process.cwd(), env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

test('CI refuses to silently skip PostgreSQL-backed tests when TEST_DATABASE_URL is absent', async () => {
  const result = await runTestRunner({ CI: 'true', TEST_DATABASE_URL: '' });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /TEST_DATABASE_URL is required in CI/);
});
