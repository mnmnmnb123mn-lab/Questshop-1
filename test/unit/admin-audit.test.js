import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeAuditState } from '../../src/domain/admin/audit.js';

test('admin audit state serializes arrays and bigint values as valid JSONB input', () => {
  const value = [{ amountCents: 500n, stateVersion: 2n }, { amountCents: 750n }];
  assert.deepEqual(JSON.parse(serializeAuditState(value)), [
    { amountCents: '500', stateVersion: '2' }, { amountCents: '750' },
  ]);
  assert.equal(serializeAuditState(null), null);
});
