import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers';
import { normalizeVoucherUrl, redeemVoucher } from '../../src/adapters/truemoney/voucher.js';

const voucherCode = 'A'.repeat(32);

function providerSuccess({ amount = '12.50', transactionId = 'provider-123' } = {}) {
  return {
    status: { code: 'SUCCESS' },
    data: {
      my_ticket: { amount_baht: amount, transaction_id: transactionId },
      owner_profile: { full_name: 'Voucher Sender', mobile: '0812345678' },
      voucher: { member: 1, available: 1 },
    },
  };
}

function successfulRequest(payload, { statusCode = 200, responseEvent = 'end' } = {}) {
  return (_options, callback) => {
    const request = new EventEmitter();
    request.destroy = (error) => setImmediate(() => request.emit('error', error));
    request.end = () => {
      request.emit('finish');
      const response = new EventEmitter();
      response.statusCode = statusCode;
      callback(response);
      setImmediate(() => {
        if (responseEvent === 'end') {
          response.emit('data', Buffer.from(JSON.stringify(payload)));
          response.emit('end');
        } else if (responseEvent === 'aborted') {
          response.emit('aborted');
        } else {
          response.emit('error', new Error('response stream failed'));
        }
      });
    };
    return request;
  };
}

function failingRequest({ afterFinish }) {
  return () => {
    const request = new EventEmitter();
    request.destroy = (error) => setImmediate(() => request.emit('error', error));
    request.end = () => {
      if (afterFinish) request.emit('finish');
      setImmediate(() => request.emit('error', new Error('transport unavailable')));
    };
    return request;
  };
}

test('TrueMoney voucher URL accepts only canonical HTTPS campaign links', () => {
  assert.deepEqual(normalizeVoucherUrl(`https://gift.truemoney.com/campaign/?v=${voucherCode}`), {
    code: voucherCode,
    url: `https://gift.truemoney.com/campaign/?v=${voucherCode}`,
  });
  assert.throws(() => normalizeVoucherUrl(`http://gift.truemoney.com/campaign/?v=${voucherCode}`),
    (error) => error.code === 'INVALID_VOUCHER_URL');
  assert.throws(() => normalizeVoucherUrl(`https://example.invalid/campaign/?v=${voucherCode}`),
    (error) => error.code === 'INVALID_VOUCHER_URL');
  assert.throws(() => normalizeVoucherUrl(`https://gift.truemoney.com/campaign/?v=${voucherCode}&extra=x`),
    (error) => ['INVALID_VOUCHER_URL', 'INVALID_VOUCHER_CODE'].includes(error.code));
});

test('pinned TrueMoney success schema produces a verified exact-cent redemption', async () => {
  let possiblySent = 0;
  const result = await redeemVoucher({ code: voucherCode, receiverPhone: '0912345678',
    onPossiblySent: () => { possiblySent += 1; }, requestFactory: successfulRequest(providerSuccess()) });
  assert.equal(possiblySent, 1);
  assert.deepEqual(result, {
    outcome: 'REDEEMED', amountCents: 1_250n, currency: 'THB', senderName: 'Voucher Sender',
    senderPhone: '0812345678', providerCode: 'SUCCESS', httpStatus: 200,
    receiverConfirmation: 'REQUEST_BOUND_SUCCESS', providerTransactionId: 'provider-123',
  });
});

test('incompatible provider schema is rejected before any financial result is returned', async () => {
  const incompatible = providerSuccess({ amount: '12.50' });
  incompatible.data.my_ticket.amount_baht = 12.5;
  await assert.rejects(() => redeemVoucher({ code: voucherCode, receiverPhone: '0912345678',
    requestFactory: successfulRequest(incompatible) }), (error) => error.code === 'PROVIDER_SCHEMA_INCOMPATIBLE');
});

test('SUCCESS requires a successful HTTP status and consistent single-recipient evidence', async () => {
  await assert.rejects(() => redeemVoucher({ code: voucherCode, receiverPhone: '0912345678',
    requestFactory: successfulRequest(providerSuccess(), { statusCode: 500 }) }),
  (error) => error.code === 'PROVIDER_HTTP_INCONSISTENT' && error.category === 'AMBIGUOUS');

  const contradictory = providerSuccess();
  contradictory.data.voucher = { member: 2, available: 1 };
  await assert.rejects(() => redeemVoucher({ code: voucherCode, receiverPhone: '0912345678',
    requestFactory: successfulRequest(contradictory) }),
  (error) => error.code === 'PROVIDER_CONFIRMATION_INCOMPLETE' && error.category === 'PROVIDER_SCHEMA');
});

test('SUCCESS rejects zero amounts and unsafe numeric transaction ids', async () => {
  await assert.rejects(() => redeemVoucher({ code: voucherCode, receiverPhone: '0912345678',
    requestFactory: successfulRequest(providerSuccess({ amount: '0.00' })) }),
  (error) => error.code === 'PROVIDER_AMOUNT_INVALID');

  await assert.rejects(() => redeemVoucher({ code: voucherCode, receiverPhone: '0912345678',
    requestFactory: successfulRequest(providerSuccess({ transactionId: Number.MAX_SAFE_INTEGER + 10 })) }),
  (error) => error.code === 'PROVIDER_TRANSACTION_ID_UNSAFE' && error.category === 'PROVIDER_SCHEMA');
});

test('response stream abort after dispatch is always ambiguous', async () => {
  await assert.rejects(() => redeemVoucher({ code: voucherCode, receiverPhone: '0912345678',
    requestFactory: successfulRequest(providerSuccess(), { responseEvent: 'aborted' }) }),
  (error) => error.code === 'PROVIDER_RESULT_AMBIGUOUS' && error.category === 'AMBIGUOUS');
});

test('transport error after request.finish is ambiguous, whereas a proven unsent request is retryable', async () => {
  await assert.rejects(() => redeemVoucher({ code: voucherCode, receiverPhone: '0912345678',
    requestFactory: failingRequest({ afterFinish: true }) }), (error) => error.code === 'PROVIDER_RESULT_AMBIGUOUS'
      && error.retryable === false);
  await assert.rejects(() => redeemVoucher({ code: voucherCode, receiverPhone: '0912345678',
    requestFactory: failingRequest({ afterFinish: false }) }), (error) => error.code === 'PROVIDER_NOT_SENT'
      && error.retryable === true);
});
