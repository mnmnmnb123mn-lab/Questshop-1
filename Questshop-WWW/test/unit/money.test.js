import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBahtToCents, percentageBonusHalfUp, sumCents } from '../../src/shared/money.js';

test('money remains integer cents and rounds half up', () => {
  assert.equal(parseBahtToCents('10.05'), 1005n);
  assert.equal(percentageBonusHalfUp(1005n, 1_000), 101n);
  assert.equal(sumCents([100n, 5n]), 105n);
});
