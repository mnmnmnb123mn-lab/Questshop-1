import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchDiscordMessage, findDiscordMessageByNonce } from '../../src/discord/transport.js';
import { publishProjection } from '../../src/workers/outbox-worker.js';

test('Discord transport treats only confirmed 404 as a missing message', async () => {
  const channel = { messages: { fetch: async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); } } };
  assert.equal(await fetchDiscordMessage(channel, 'gone'), null);
  channel.messages.fetch = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 }); };
  await assert.rejects(() => fetchDiscordMessage(channel, 'forbidden'), { code: 50013 });
});

test('nonce reconciliation returns an accepted message after an unknown create result', async () => {
  const accepted = { id: 'accepted', nonce: 'nonce' };
  let fetches = 0;
  const channel = {
    messages: { fetch: async (input) => {
      if (input?.message) return null;
      fetches += 1;
      return fetches >= 2 ? [accepted] : [];
    } },
    send: async () => { throw Object.assign(new Error('socket reset after send'), { code: 'ECONNRESET' }); },
  };
  const message = await publishProjection(channel, { nonce: 'nonce', message_id: null }, { content: 'body' });
  assert.equal(message.id, 'accepted');
});

test('outbox sends the normalized payload rather than raw projection content', async () => {
  let delivered;
  const channel = {
    messages: { fetch: async (input) => (input?.message ? null : []) },
    send: async (payload) => {
      delivered = payload;
      return { id: 'created' };
    },
  };
  await publishProjection(channel, { nonce: 'nonce', message_id: null }, { content: '@everyone' });
  assert.equal(delivered.content, '@\u200beveryone');
  assert.deepEqual(delivered.allowedMentions, { parse: [] });
  assert.equal(delivered.enforceNonce, true);
});

test('outbox edit replaces old attachments with the renderer attachment set', async () => {
  let edited;
  const message = { edit: async (payload) => { edited = payload; return { id: 'existing' }; } };
  const channel = { messages: { fetch: async (input) => input?.message === 'existing' ? message : [] } };
  const files = [{ attachment: Buffer.from('banner'), name: 'backoffice-log-banner.webp' }];
  await publishProjection(channel, { nonce: 'nonce', message_id: 'existing' }, {
    embeds: [], attachments: [], files,
  });
  assert.deepEqual(edited.attachments, []);
  assert.deepEqual(edited.files, files);
});

test('nonce scan preserves transient failures instead of claiming no message exists', async () => {
  const channel = { messages: { fetch: async () => { throw Object.assign(new Error('unavailable'), { status: 503 }); } } };
  await assert.rejects(() => findDiscordMessageByNonce(channel, 'nonce'));
});
