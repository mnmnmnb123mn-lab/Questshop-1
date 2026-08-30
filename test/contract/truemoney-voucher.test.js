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

function successfulRequest(payload, { statusCode = 200, responseEvent = 'end', rawBody = null } = {}) {
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
          response.emit('data', Buffer.from(rawBody ?? JSON.stringify(payload)));
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
  let checkpointed = 0;
  const result = await redeemVoucher({ code: voucherCode, receiverPhone: '0912345678',
    onDispatchCheckpoint: () => { checkpointed += 1; }, requestFactory: successfulRequest(providerSuccess()) });
  assert.equal(checkpointed, 1);
  const { providerEvidence, ...settlement } = result;
  assert.deepEqual(settlement, {
    outcome: 'SUCCESS', providerReference: 'provider-123', reason: 'SUCCESS', amountCents: 1_250n, currency: 'THB', senderName: 'Voucher Sender',
    senderPhone: '0812345678', providerCode: 'SUCCESS', httpStatus: 200,
    receiverConfirmation: 'REQUEST_BOUND_SUCCESS', providerTransactionId: 'provider-123',
  });
  assert.equal(providerEvidence.settlementIdentity, 'PROVIDER_TRANSACTION_ID');
  assert.equal(providerEvidence.providerTransactionIdPresent, true);
  assert.equal(providerEvidence.bodySha256.length, 64);
});

test('SUCCESS without a provider transaction ID is still a verified settlement', async () => {
  const result = await redeemVoucher({ code: voucherCode, receiverPhone: '0912345678',
    requestFactory: successfulRequest(providerSuccess({ transactionId: null })) });
  assert.equal(result.outcome, 'SUCCESS');
  assert.equal(result.amountCents, 1_250n);
  assert.equal(result.providerTransactionId, null);
  assert.equal(result.providerEvidence.settlementIdentity, 'VOUCHER_HMAC');
  assert.equal(result.providerEvidence.providerTransactionIdPresent, false);
});

test('error envelopes with null or missing data use the provider code safely', async () => {
  const expired = await redeemVoucher({ code: voucherCode, receiverPhone: '0912345678', requestFactory: successfulRequest({
    status: { code: 'VOUCHER_EXPIRED' }, data: null,
  }, { statusCode: 400 }) });
  assert.equal(expired.outcome, 'DEFINITE_FAILURE');
  assert.equal(expired.reason, 'EXPIRED');
  assert.equal(expired.evidence.providerCode, 'VOUCHER_EXPIRED');
  assert.equal(expired.evidence.httpStatus, 400);

  const used = await redeemVoucher({ code: voucherCode, receiverPhone: '0912345678', requestFactory: successfulRequest({
    status: { code: 'VOUCHER_OUT_OF_STOCK' }, extra: { ignored: true },
  }, { statusCode: 400 }) });
  assert.equal(used.outcome, 'DEFINITE_FAILURE');
  assert.equal(used.reason, 'ALREADY_REDEEMED');
  assert.equal(used.evidence.providerCode, 'VOUCHER_OUT_OF_STOCK');

  const unknown = await redeemVoucher({ code: voucherCode, receiverPhone: '0912345678', requestFactory: successfulRequest({
    status: { code: 'UNRECOGNIZED_PROVIDER_RESULT' }, data: null,
  }, { statusCode: 400 }) });
  assert.equal(unknown.outcome, 'AMBIGUOUS');
  assert.equal(unknown.evidence.httpStatus, 400);
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

test('ambiguous HTTP responses retain their safe status for payment diagnostics', async () => {
  await assert.rejects(() => redeemVoucher({ code: voucherCode, receiverPhone: '0912345678',
    requestFactory: successfulRequest(null, { statusCode: 403, rawBody: '<html>forbidden</html>' }) }),
  (error) => error.code === 'PROVIDER_HTTP_AMBIGUOUS' && error.details?.httpStatus === 403);
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

test('any transport error after request.end is ambiguous even when finish has not fired', async () => {
  await assert.rejects(() => redeemVoucher({ code: voucherCode, receiverPhone: '0912345678',
    requestFactory: failingRequest({ afterFinish: true }) }), (error) => error.code === 'PROVIDER_RESULT_AMBIGUOUS'
      && error.retryable === false);
  await assert.rejects(() => redeemVoucher({ code: voucherCode, receiverPhone: '0912345678',
    requestFactory: failingRequest({ afterFinish: false }) }), (error) => error.code === 'PROVIDER_RESULT_AMBIGUOUS'
      && error.retryable === false && error.category === 'AMBIGUOUS');
});

test('durable dispatch checkpoint completes before request.end and blocks dispatch on failure', async () => {
  const calls = [];
  const requestFactory = () => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => {
      calls.push('end');
      setImmediate(() => request.emit('error', new Error('stop after ordering check')));
    };
    return request;
  };
  await assert.rejects(
    () => redeemVoucher({ code: voucherCode, receiverPhone: '0912345678',
      onDispatchCheckpoint: () => calls.push('checkpoint'), requestFactory }),
    (error) => error.code === 'PROVIDER_RESULT_AMBIGUOUS',
  );
  assert.deepEqual(calls, ['checkpoint', 'end']);

  let ended = false;
  await assert.rejects(() => redeemVoucher({ code: voucherCode, receiverPhone: '0912345678',
    onDispatchCheckpoint: () => { throw new Error('database unavailable'); },
    requestFactory: () => {
      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = () => { ended = true; };
      return request;
    },
  }), (error) => error.code === 'PAYMENT_INTENT_CHECKPOINT_FAILED' && error.retryable === true);
  assert.equal(ended, false);
});
