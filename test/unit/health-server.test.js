import test from 'node:test';
import assert from 'node:assert/strict';
import { closeHealthServer, createHealthState, startHealthServer } from '../../src/bootstrap/health-server.js';

test('status endpoint requires the exact bearer token without exposing operational detail', async (t) => {
  const statusToken = Buffer.alloc(32, 5).toString('hex');
  const state = createHealthState();
  state.ready = true;
  state.status = 'HEALTHY';
  state.overview = { queue: 3 };
  const server = await startHealthServer({ port: 0, statusToken, state });
  t.after(() => closeHealthServer(server));
  const base = `http://127.0.0.1:${server.address().port}`;

  const denied = await fetch(`${base}/statusz`, { headers: { authorization: 'Bearer wrong-token' } });
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { ok: false });

  const missing = await fetch(`${base}/statusz`);
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { ok: false });

  const allowed = await fetch(`${base}/statusz`, {
    headers: { authorization: `Bearer ${statusToken}` },
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual((await allowed.json()).overview, { queue: 3 });
});
