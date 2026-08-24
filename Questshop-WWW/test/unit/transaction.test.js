import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withTransaction } from '../../src/db/transaction.js';

const execFileAsync = promisify(execFile);

test('broken rollback destroys and releases a client exactly once', async () => {
  const releases = [];
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === 'ROLLBACK') throw new Error('socket closed');
      if (sql.startsWith('SELECT transaction_timestamp')) return { rows: [{ transaction_time: new Date() }] };
      return { rows: [] };
    },
    release(destroy) { releases.push(destroy); },
  };
  const pool = { connect: async () => client };
  await assert.rejects(() => withTransaction({ pool, maxAttempts: 1 }, async () => {
    throw Object.assign(new Error('business failure'), { code: 'BUSINESS_FAILURE' });
  }), (error) => error.code === 'BUSINESS_FAILURE');
  assert.deepEqual(releases, [true]);
  assert.equal(queries.filter((query) => query === 'ROLLBACK').length, 1);
});

test('serialization failure retries the complete transaction', async () => {
  let connections = 0;
  let callbacks = 0;
  const pool = { connect: async () => {
    connections += 1;
    return {
      async query(sql) {
        if (sql.startsWith('SELECT transaction_timestamp')) return { rows: [{ transaction_time: new Date() }] };
        if (sql === 'COMMIT' && connections === 1) throw Object.assign(new Error('serialization'), { code: '40001' });
        return { rows: [] };
      },
      release() {},
    };
  } };
  const result = await withTransaction({ pool, maxAttempts: 2 }, async () => {
    callbacks += 1;
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(connections, 2);
  assert.equal(callbacks, 2);
});

test('retry delay keeps a standalone process alive until the transaction settles', async () => {
  const source = `
    import { withTransaction } from './src/db/transaction.js';
    let connections = 0;
    const pool = { connect: async () => ({
      query: async (sql) => {
        if (sql.startsWith('SELECT transaction_timestamp')) return { rows: [{ transaction_time: new Date() }] };
        if (sql === 'COMMIT' && connections++ === 0) throw Object.assign(new Error('retry'), { code: '40001' });
        return { rows: [] };
      }, release() {},
    }) };
    const result = await withTransaction({ pool, maxAttempts: 2 }, async () => 'settled');
    process.stdout.write(result);
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: process.cwd(), timeout: 5_000,
  });
  assert.equal(stdout, 'settled');
});
