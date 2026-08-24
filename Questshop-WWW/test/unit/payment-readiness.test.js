import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePaymentReadiness } from '../../src/bootstrap/startup.js';

function fakePool({ topup = false, autoCredit = false, receiver = false } = {}) {
  return {
    query: async (sql) => {
      if (sql.includes('FROM feature_gates')) return { rows: [
        { gate: 'TOPUP_ACCEPTING', enabled: topup },
        { gate: 'AUTO_CREDIT_ENABLED', enabled: autoCredit },
      ], rowCount: 2 };
      if (sql.includes('FROM receiver_versions')) {
        return { rows: receiver ? [{ id: 'receiver' }] : [], rowCount: receiver ? 1 : 0 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('payment readiness keeps the backoffice available when a new store has no receiver', async () => {
  const health = { checks: {} };
  const result = await validatePaymentReadiness(fakePool({ topup: true }), health);
  assert.deepEqual(result, { paymentEnabled: true, hasReceiver: false, ready: false });
  assert.equal(health.checks.payments, 'MISSING_RECEIVER');
});

test('payment readiness permits maintenance startup when payment gates are disabled', async () => {
  const health = { checks: {} };
  const result = await validatePaymentReadiness(fakePool(), health);
  assert.deepEqual(result, { paymentEnabled: false, hasReceiver: false, ready: true });
  assert.equal(health.checks.payments, 'DISABLED');
});

test('payment readiness records OK when an active receiver exists', async () => {
  const health = { checks: {} };
  const result = await validatePaymentReadiness(fakePool({ topup: true, autoCredit: true, receiver: true }), health);
  assert.deepEqual(result, { paymentEnabled: true, hasReceiver: true, ready: true });
  assert.equal(health.checks.payments, 'OK');
});
