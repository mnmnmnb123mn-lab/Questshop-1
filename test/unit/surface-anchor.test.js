import assert from 'node:assert/strict';
import test from 'node:test';
import { SURFACE_COMMANDS } from '../../src/discord/commands/definitions.js';
import { renderQuestAuto } from '../../src/discord/renderers/surfaces.js';
import {
  fetchSurfaceMessageFresh, questAutoSurfaceMatches, surfaceNonce, updateOrCreateSurfaceAnchor,
} from '../../src/discord/surfaces/setup.js';
import { normalizeDiscordPayload } from '../../src/discord/payload.js';
import {
  QUEST_AUTO_MEDIA_ATTACHMENT_URL, QUEST_AUTO_MEDIA_FILENAME, QUEST_AUTO_MEDIA_SIZE, loadQuestAutoMedia,
  QUEST_AUTO_THUMBNAIL_ATTACHMENT_URL, QUEST_AUTO_THUMBNAIL_FILENAME, QUEST_AUTO_THUMBNAIL_SIZE,
  loadQuestAutoThumbnail,
} from '../../src/discord/surfaces/quest-auto-media.js';

function createChannel({ listedMessages = [], sentMessage = { id: 'new-anchor' } } = {}) {
  const fetches = [];
  const sent = [];
  return {
    fetches,
    sent,
    client: { user: { id: 'bot' } },
    messages: {
      fetch: async (input) => {
        fetches.push(input);
        return input?.limit ? listedMessages : null;
      },
    },
    send: async (body) => {
      sent.push(body);
      return sentMessage;
    },
  };
}

function priceRangePool(minCents = 500, maxCents = 500) {
  return {
    query: async (sql) => {
      if (sql.includes('min(amount_cents)::bigint AS min_cents')) {
        return { rows: [{ min_cents: String(minCents), max_cents: String(maxCents), task_type_count: 4 }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function questAutoMessage(expected) {
  const attachmentUrl = 'https://cdn.example/quest-auto-demo.gif';
  const thumbnailUrl = 'https://cdn.example/quest-auto-thumbnail.gif';
  return {
    content: '',
    attachments: new Map([
      ['gif', { name: QUEST_AUTO_MEDIA_FILENAME, size: QUEST_AUTO_MEDIA_SIZE, url: attachmentUrl }],
      ['thumbnail', {
        name: QUEST_AUTO_THUMBNAIL_FILENAME, size: QUEST_AUTO_THUMBNAIL_SIZE, url: thumbnailUrl,
      }],
    ]),
    embeds: [{
      ...cloneJson(expected.embeds[0]), image: { url: attachmentUrl }, thumbnail: { url: thumbnailUrl },
    }],
    components: cloneJson(expected.components),
  };
}

test('Quest Auto uses the Owner-approved storefront copy and one price when categories match', () => {
  const body = renderQuestAuto({ priceRange: { minCents: 500n, maxCents: 500n } });
  assert.equal(body.embeds[0].data.title, 'Discord Quest Auto');
  assert.equal(body.embeds[0].data.description, [
    'ทำ Quest เพื่อสะสม **Discord Orbs** ด้วยระบบอัตโนมัติ',
    '**ค่าบริการ 5 บาท / เควสสำเร็จ**',
    'ใช้ **Discord Token** เพื่อให้ระบบเข้าไปทำ Quest ให้โดยอัตโนมัติ',
    'เลือก Quest ที่ต้องการ แล้วติดตามสถานะได้จนสำเร็จ',
  ].join('\n'));
  assert.equal(body.embeds[0].data.image.url, QUEST_AUTO_MEDIA_ATTACHMENT_URL);
  assert.equal(body.embeds[0].data.thumbnail.url, QUEST_AUTO_THUMBNAIL_ATTACHMENT_URL);
  assert.equal(body.embeds[0].data.footer, undefined);
});

test('Quest Auto collapses different Admin prices into a minimum-maximum range', () => {
  const body = renderQuestAuto({ priceRange: { minCents: 500n, maxCents: 700n } });
  assert.match(body.embeds[0].data.description, /\*\*ค่าบริการ 5-7 บาท \/ เควสสำเร็จ\*\*/);
});

test('surface setup fetches its stored anchor from Discord instead of using a stale cache entry', async () => {
  const channel = createChannel();
  await fetchSurfaceMessageFresh(channel, 'old-anchor');
  assert.deepEqual(channel.fetches, [{ message: 'old-anchor', force: true, cache: false }]);
});

test('every setup surface uses a stable Discord nonce no longer than 25 characters', () => {
  for (const surfaceKey of Object.values(SURFACE_COMMANDS)) {
    const first = surfaceNonce(surfaceKey);
    assert.equal(first, surfaceNonce(surfaceKey));
    assert.ok(first.length <= 25, `${surfaceKey} produced a ${first.length}-character nonce`);
  }
  assert.equal(surfaceNonce('LOG_QUEST_OPERATIONS').length, 25);
});

test('surface setup does not treat permission or network failures as a deleted message', async () => {
  const channel = createChannel();
  channel.messages.fetch = async () => {
    throw Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 });
  };
  await assert.rejects(() => fetchSurfaceMessageFresh(channel, 'old-anchor'), { code: 50013 });
  assert.equal(channel.sent.length, 0);
});

test('surface setup recreates an anchor when its stored Discord message was deleted', async () => {
  const stale = {
    id: 'old-anchor',
    edit: async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 }); },
  };
  const channel = createChannel();
  const result = await updateOrCreateSurfaceAnchor(channel, 'ADMIN_PANEL', { values: {} }, stale);
  assert.equal(result.message.id, 'new-anchor');
  assert.equal(result.recreated, true);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].nonce, 'surface-admin_panel');
});

test('surface setup preserves non-missing Discord failures instead of creating a duplicate anchor', async () => {
  const unavailable = {
    id: 'old-anchor',
    edit: async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 }); },
  };
  const channel = createChannel();
  await assert.rejects(() => updateOrCreateSurfaceAnchor(channel, 'ADMIN_PANEL', { values: {} }, unavailable), {
    code: 50013,
  });
  assert.equal(channel.sent.length, 0);
});

test('surface setup finds its marker beyond the old 25-message scan without creating a duplicate', async () => {
  const marker = { id: 'older-anchor', author: { id: 'bot' }, embeds: [{ footer: { text: 'Questshop Surface • ADMIN_PANEL' } }],
    edit: async () => marker };
  const listedMessages = Array.from({ length: 40 }, (_, index) => ({ id: `message-${index}`, author: { id: 'other' }, embeds: [] }));
  listedMessages[30] = marker;
  const channel = createChannel({ listedMessages });
  const result = await updateOrCreateSurfaceAnchor(channel, 'ADMIN_PANEL', { values: {} });
  assert.equal(result.message.id, 'older-anchor');
  assert.equal(channel.sent.length, 0);
});

test('Quest Auto recovers its invisible anchor by stable nonce instead of a visible footer', async () => {
  const marker = {
    id: 'quest-auto-anchor',
    nonce: surfaceNonce('QUEST_AUTO'),
    author: { id: 'bot' },
    attachments: new Map([
      ['gif', {
        name: QUEST_AUTO_MEDIA_FILENAME, size: QUEST_AUTO_MEDIA_SIZE,
        url: 'https://cdn.example/quest-auto-demo.gif',
      }],
      ['thumbnail', {
        name: QUEST_AUTO_THUMBNAIL_FILENAME, size: QUEST_AUTO_THUMBNAIL_SIZE,
        url: 'https://cdn.example/quest-auto-thumbnail.gif',
      }],
    ]),
    embeds: [{
      title: 'Discord Quest Auto',
      image: { url: 'https://cdn.example/quest-auto-demo.gif' },
      thumbnail: { url: 'https://cdn.example/quest-auto-thumbnail.gif' },
    }],
    edit: async () => marker,
  };
  const channel = createChannel({ listedMessages: [marker] });
  const result = await updateOrCreateSurfaceAnchor(channel, 'QUEST_AUTO', { values: {} }, null,
    { pool: priceRangePool(500, 500) });
  assert.equal(result.message.id, 'quest-auto-anchor');
  assert.equal(channel.sent.length, 0);
});

test('Quest Auto bundled GIF and thumbnail are the exact uploaded assets', async () => {
  const media = await loadQuestAutoMedia();
  const thumbnail = await loadQuestAutoThumbnail();
  assert.ok(Buffer.isBuffer(media));
  assert.ok(Buffer.isBuffer(thumbnail));
  assert.equal(media.length, 9_190_692);
  assert.equal(thumbnail.length, QUEST_AUTO_THUMBNAIL_SIZE);
  assert.equal(media.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.equal(thumbnail.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.equal([...thumbnail].filter((_, index) => thumbnail[index] === 0x21
    && thumbnail[index + 1] === 0xf9 && thumbnail[index + 2] === 0x04).length, 56);
});

test('Quest Auto replaces a legacy PNG thumbnail with the uploaded GIF assets', async () => {
  const edits = [];
  const existing = {
    id: 'quest-auto',
    attachments: new Map([
      ['demo', {
        name: QUEST_AUTO_MEDIA_FILENAME, size: QUEST_AUTO_MEDIA_SIZE,
        url: 'https://cdn.example/quest-auto-demo.gif',
      }],
      ['legacy-thumbnail', {
        name: 'quest-auto-thumbnail.png', size: 1_447_045,
        url: 'https://cdn.example/quest-auto-thumbnail.png',
      }],
    ]),
    edit: async (body) => {
      edits.push(body);
      return existing;
    },
  };
  const channel = createChannel();
  await updateOrCreateSurfaceAnchor(channel, 'QUEST_AUTO', { values: {} }, existing,
    { pool: priceRangePool(500, 700) });
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].attachments, []);
  assert.equal(edits[0].files?.[0]?.name, QUEST_AUTO_MEDIA_FILENAME);
  assert.equal(edits[0].files?.[1]?.name, QUEST_AUTO_THUMBNAIL_FILENAME);
  assert.ok(Buffer.isBuffer(edits[0].files[0].attachment));
  assert.ok(Buffer.isBuffer(edits[0].files[1].attachment));
  assert.equal(edits[0].files[0].attachment.length, 9_190_692);
  assert.equal(edits[0].files[1].attachment.length, QUEST_AUTO_THUMBNAIL_SIZE);
  assert.equal(edits[0].files[0].attachment.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.equal(edits[0].embeds[0].image.url, QUEST_AUTO_MEDIA_ATTACHMENT_URL);
  assert.equal(edits[0].embeds[0].thumbnail.url, QUEST_AUTO_THUMBNAIL_ATTACHMENT_URL);
  assert.equal(edits[0].embeds[0].footer, undefined);
  assert.match(edits[0].embeds[0].description, /ค่าบริการ 5-7 บาท/);
});

test('Quest Auto keeps its existing uploaded media instead of uploading duplicates on refresh', async () => {
  let editedBody;
  const existing = {
    id: 'quest-auto',
    attachments: new Map([
      ['gif', {
        name: QUEST_AUTO_MEDIA_FILENAME, size: QUEST_AUTO_MEDIA_SIZE,
        url: 'https://cdn.example/quest-auto-demo.gif',
      }],
      ['thumbnail', {
        name: QUEST_AUTO_THUMBNAIL_FILENAME, size: QUEST_AUTO_THUMBNAIL_SIZE,
        url: 'https://cdn.example/quest-auto-thumbnail.gif',
      }],
    ]),
    edit: async (body) => {
      editedBody = body;
      return existing;
    },
  };
  await updateOrCreateSurfaceAnchor(createChannel(), 'QUEST_AUTO', { values: {} }, existing,
    { pool: priceRangePool(500, 500) });
  assert.equal(editedBody.files, undefined);
  assert.equal(editedBody.attachments, undefined);
  assert.equal(editedBody.embeds[0].image.url, QUEST_AUTO_MEDIA_ATTACHMENT_URL);
  assert.equal(editedBody.embeds[0].thumbnail.url, QUEST_AUTO_THUMBNAIL_ATTACHMENT_URL);
});

test('Quest Auto reconciliation detects stale price and rejects the old visible technical footer', () => {
  const expected = normalizeDiscordPayload(renderQuestAuto({ priceRange: { minCents: 500n, maxCents: 700n } }));
  const message = questAutoMessage(expected);
  message.embeds[0].description = expected.embeds[0].description.replace('5-7', '5');
  assert.equal(questAutoSurfaceMatches(message, expected), false);
  message.embeds[0].description = expected.embeds[0].description;
  assert.equal(questAutoSurfaceMatches(message, expected), true);
  message.embeds[0].footer = { text: 'Questshop Surface • QUEST_AUTO' };
  assert.equal(questAutoSurfaceMatches(message, expected), false);
});

test('Quest Auto reconciliation rejects stale embed and button structures', () => {
  const expected = normalizeDiscordPayload(renderQuestAuto({ priceRange: { minCents: 500n, maxCents: 500n } }));
  assert.equal(questAutoSurfaceMatches(questAutoMessage(expected), expected), true);

  const mutations = [
    (message) => { message.content = 'ข้อความเก่าที่ยังค้างอยู่'; },
    (message) => { message.components = []; },
    (message) => { message.components[0].components.pop(); },
    (message) => { message.components[0].components.push(cloneJson(message.components[0].components[0])); },
    (message) => { message.components[0].components[0].label = 'ปุ่มเก่า'; },
    (message) => { message.components[0].components[0].style = 4; },
    (message) => { message.components[0].components[0].emoji = { name: '❌' }; },
    (message) => { message.components[0].components[1].custom_id = message.components[0].components[0].custom_id; },
    (message) => { message.embeds[0].color = 0; },
    (message) => { message.embeds[0].fields = [{ name: 'ข้อมูลเก่า', value: 'ยังค้างอยู่' }]; },
    (message) => { message.embeds[0].thumbnail = { url: 'https://cdn.example/old.png' }; },
    (message) => { message.embeds.push({ title: 'Embed เก่า' }); },
  ];
  for (const mutate of mutations) {
    const message = questAutoMessage(expected);
    mutate(message);
    assert.equal(questAutoSurfaceMatches(message, expected), false);
  }
});

test('rate limiting and transient fetch failures never become a missing-message recreate', async () => {
  for (const error of [
    Object.assign(new Error('rate limit'), { status: 429 }),
    Object.assign(new Error('gateway error'), { status: 503 }),
    Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
  ]) {
    const channel = createChannel();
    channel.messages.fetch = async () => { throw error; };
    await assert.rejects(() => fetchSurfaceMessageFresh(channel, 'old-anchor'));
    assert.equal(channel.sent.length, 0);
  }
});

test('Discord payload boundary strips unsafe mentions and bounds textual output', () => {
  const body = normalizeDiscordPayload({ content: '@everyone '.repeat(500), allowedMentions: { parse: ['everyone'] } });
  assert.ok(body.content.length <= 2_000);
  assert.match(body.content, /@\u200beveryone/);
  assert.deepEqual(body.allowedMentions.parse, []);
});

test('Discord payload boundary preserves only explicitly allowlisted role mentions without control-character placeholders', () => {
  const roleId = '123456789012345678';
  const body = normalizeDiscordPayload({
    content: `<@&${roleId}> @everyone <@&987654321098765432>`,
    allowedMentions: { roles: [roleId] },
  });
  assert.equal(body.content, `<@&${roleId}> @\u200beveryone <@\u200b&987654321098765432>`);
  assert.doesNotMatch(body.content, /[\u0000-\u001f]/);
});

test('Discord payload boundary also bounds embeds and drops an unsafe link component', () => {
  const body = normalizeDiscordPayload({
    embeds: [{ title: '@here '.repeat(100), description: 'x'.repeat(5_000),
      fields: Array.from({ length: 30 }, () => ({ name: 'n'.repeat(300), value: 'v'.repeat(1_200) })) }],
    components: [{ type: 1, components: [
      { type: 2, style: 5, label: 'bad', url: 'javascript:alert(1)' },
      { type: 2, style: 1, label: 'safe', custom_id: 'x'.repeat(120) },
    ] }],
  });
  const [embed] = body.embeds;
  assert.ok(embed.title.length <= 256);
  assert.ok(embed.description.length <= 4_096);
  assert.ok(embed.fields.length <= 25);
  assert.ok(embed.fields.every((field) => field.name.length <= 256 && field.value.length <= 1_024));
  assert.ok(body.components[0].components.every((component) => component.url !== 'javascript:alert(1)'));
  assert.equal(body.components[0].components[0].custom_id.length, 100);
});
