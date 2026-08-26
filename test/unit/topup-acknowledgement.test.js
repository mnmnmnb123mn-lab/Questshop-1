import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgeTopupAndStartSettlement } from '../../src/discord/interactions/topup-acknowledgement.js';

function receivedTopup(status = 'PAYMENT_QUEUED') {
  return { idempotent: false, topup: { id: '019fc886-ffcd-70e3-bd14-fb61772e8402', status,
    created_at: '2030-01-01T00:00:00.000Z' } };
}

test('durable Top-up acknowledgement returns before a slow targeted settlement finishes', async () => {
  const events = [];
  let releaseSettlement;
  const slowSettlement = new Promise((resolve) => { releaseSettlement = resolve; });
  const interaction = { editReply: async (body) => {
    events.push('reply');
    assert.match(body.embeds[0].data.title, /รับรายการเติมเงินแล้ว/);
    return { id: 'ephemeral-reply' };
  } };
  const reply = await acknowledgeTopupAndStartSettlement({ interaction, result: receivedTopup(), runtime: {
    env: {}, pool: {}, abortController: new AbortController(), logger: { warn: () => events.push('warn') },
  } }, { processPaymentFunction: async (input) => {
    events.push('settlement-started');
    assert.equal(input.topupId, '019fc886-ffcd-70e3-bd14-fb61772e8402');
    await slowSettlement;
  } });
  assert.deepEqual(events, ['reply', 'settlement-started']);
  assert.deepEqual(reply, { id: 'ephemeral-reply' });
  releaseSettlement();
  await Promise.resolve();
  assert.deepEqual(events, ['reply', 'settlement-started']);
});

test('a terminal duplicate only acknowledges the existing Top-up and does not settle again', async () => {
  let started = 0;
  await acknowledgeTopupAndStartSettlement({ interaction: { editReply: async () => ({ id: 'reply' }) },
    result: { ...receivedTopup('CREDITED'), idempotent: true }, runtime: { env: {}, pool: {} } }, {
    processPaymentFunction: async () => { started += 1; },
  });
  assert.equal(started, 0);
});

test('a failed immediate trigger is safely logged and never rejects the acknowledgement', async () => {
  const warnings = [];
  const reply = await acknowledgeTopupAndStartSettlement({ interaction: { editReply: async () => ({ id: 'reply' }) },
    result: receivedTopup(), runtime: { env: {}, pool: {}, logger: { warn: (entry) => warnings.push(entry) } } }, {
    processPaymentFunction: async () => { throw new Error('provider response included secret-looking data'); },
  });
  assert.deepEqual(reply, { id: 'reply' });
  await Promise.resolve();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].topupId, '019fc886-ffcd-70e3-bd14-fb61772e8402');
});
