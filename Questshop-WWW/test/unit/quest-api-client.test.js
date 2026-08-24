import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createQuestApiClient,
  DiscordApiError,
  DiscordApiTimeoutError,
  QUEST_API_VERSION,
} from '../../src/quest-engine/api/client.js';

const TEST_CHROME_VERSION = ['120', '0', '0', '0'].join('.');
const profile = Object.freeze({ clientVersion: '1.0.0', chromeVersion: TEST_CHROME_VERSION,
  electronVersion: '28.0.0', buildNumber: 1, nativeBuildNumber: 1, locale: 'en-US' });

function response(body, status, responseHeaders = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => responseHeaders[String(name).toLowerCase()] ?? null },
    text: async () => body,
  };
}

function coordinator(overrides = {}) {
  return {
    schedule: async ({ execute }) => execute(), blockGlobally() {}, blockRoute() {}, blockAccount() {}, ...overrides,
  };
}

function api({ transport = async () => response('{}', 200), ...options } = {}) {
  return createQuestApiClient({ token: 'test-token', profile, coordinator: coordinator(), transport, ...options });
}

function causedBy(error, message) {
  for (let current = error; current; current = current.cause) {
    if (current.message === message) return true;
  }
  return false;
}

function rawQuest(id, expiresAt) {
  return {
    id,
    config: {
      starts_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: expiresAt,
      application: { id: `app-${id}` },
      messages: { quest_name: `Quest ${id}` },
      task_config_v2: { tasks: { video: { event_name: 'WATCH_VIDEO', target: 60 } } },
    },
    user_status: { enrolled_at: new Date().toISOString(), progress: { video: { value: 0 } } },
  };
}

test('Quest client pins the proven v9 API profile and falls back to application heartbeat after non-CAPTCHA 400', async () => {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    return calls.length === 1 ? response(JSON.stringify({ message: 'bad stream' }), 400) : response('{}', 200);
  };
  await api({ transport }).sendHeartbeat({ id: 'quest-1', applicationId: 'app-1' }, false, false);
  assert.equal(QUEST_API_VERSION, 9);
  assert.equal(calls[0].path, '/quests/quest-1/heartbeat');
  assert.deepEqual(calls.map((call) => JSON.parse(call.body)), [
    { stream_key: 'call:quest-1:1', terminal: false },
    { application_id: 'app-1', terminal: false },
  ]);
});

test('Quest client does not bypass CAPTCHA with application heartbeat fallback', async () => {
  let calls = 0;
  await assert.rejects(api({ transport: async () => {
    calls += 1;
    return response(JSON.stringify({ captcha_sitekey: 'challenge' }), 400);
  } }).sendHeartbeat({ id: 'quest-1', applicationId: 'app-1' }, false, false), DiscordApiError);
  assert.equal(calls, 1);
});

test('Quest client aborts a hung request with a bounded timeout', async () => {
  const transport = async ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  await assert.rejects(api({ timeoutMs: 5, transport }).enroll('quest-1'), (error) => {
    assert.ok(error instanceof DiscordApiTimeoutError);
    assert.equal(error.possiblySent, true);
    return true;
  });
});

test('Quest client keeps its deadline while an accepted response body stalls', async () => {
  const transport = async ({ signal }) => response(new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }), 200);
  await assert.rejects(api({ timeoutMs: 5, transport }).enroll('quest-1'), (error) => {
    assert.ok(error instanceof DiscordApiTimeoutError);
    assert.equal(error.possiblySent, true);
    return true;
  });
});

test('Quest client marks a mutation timeout before dispatch as safe to retry', async () => {
  const failingCoordinator = coordinator({ schedule: async () => { throw new Error('queue unavailable'); } });
  await assert.rejects(createQuestApiClient({ token: 'test-token', profile, coordinator: failingCoordinator }).enroll('quest-1'), (error) => {
    assert.equal(error.possiblySent, false);
    return true;
  });
});

test('Quest client rejects an injected Quest identifier before transport is called', () => {
  let calls = 0;
  const client = api({ transport: async () => { calls += 1; return response('{}', 200); } });
  assert.throws(() => client.enroll('../users/@me'), /Quest id is invalid/);
  assert.throws(() => client.enroll('quest-1?redirect=https://example.invalid'), /Quest id is invalid/);
  assert.equal(calls, 0);
});

test('only identity/list 403 is fatal authentication evidence', () => {
  assert.equal(new DiscordApiError(403, '/users/@me', {}).fatalAuth, true);
  assert.equal(new DiscordApiError(403, '/quests/id/heartbeat', {}).fatalAuth, false);
});

test('background safe reads honor global and account route rate-limit cooldowns before retrying', async () => {
  const blocked = [];
  const limitedCoordinator = coordinator({
    blockGlobally: async (wait) => { blocked.push(['global', wait]); },
    blockRoute: async (path, wait) => { blocked.push(['route', path, wait]); },
    blockAccount: async (token, wait) => { blocked.push(['account', token, wait]); },
  });
  let attempts = 0;
  const client = createQuestApiClient({ token: 'test-token', profile, coordinator: limitedCoordinator,
    transport: async () => {
      attempts += 1;
      return attempts === 1
        ? response(JSON.stringify({ retry_after: 0, global: true }), 429, { 'x-ratelimit-global': 'true' })
        : response(JSON.stringify({ id: 'account-1' }), 200);
    } });
  assert.deepEqual(await client.fetchCurrentUser(new AbortController().signal), { id: 'account-1' });
  assert.equal(attempts, 2);
  assert.deepEqual(blocked, [['global', 0], ['global', 0]]);
});

test('interactive safe read returns a customer rate-limit error without retry delay', async () => {
  let attempts = 0;
  const client = api({ transport: async () => {
    attempts += 1;
    return response(JSON.stringify({ retry_after: 30 }), 429);
  } });
  await assert.rejects(client.fetchCurrentUser(), (error) => {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.match(error.message, /Discord/);
    return true;
  });
  assert.equal(attempts, 1);
});

test('interactive identity authentication failure becomes TOKEN_INVALID', async () => {
  const client = api({ transport: async () => response('{}', 401) });
  await assert.rejects(client.fetchCurrentUser(), (error) => {
    assert.equal(error.code, 'TOKEN_INVALID');
    return true;
  });
});

test('Quest list drops already-expired entries before checkout/catalog work', async () => {
  const expired = rawQuest('expired', new Date(Date.now() - 60_000).toISOString());
  const active = rawQuest('active', new Date(Date.now() + 60 * 60 * 1000).toISOString());
  const client = api({ transport: async () => response(JSON.stringify([expired, active]), 200) });
  const quests = await client.fetchQuests();
  assert.deepEqual(quests.map((quest) => quest.id), ['active']);
});

test('Runner can request expired Quest rows for post-mutation verification', async () => {
  const expired = rawQuest('expired', new Date(Date.now() - 60_000).toISOString());
  const active = rawQuest('active', new Date(Date.now() + 60 * 60 * 1000).toISOString());
  const client = api({ transport: async () => response(JSON.stringify([expired, active]), 200) });
  const quests = await client.fetchQuests(undefined, { includeExpired: true });
  assert.deepEqual(quests.map((quest) => quest.id), ['expired', 'active']);
});

test('safe reads record non-global 429 route and account cooldowns', async () => {
  const blocked = [];
  const limitedCoordinator = coordinator({
    blockRoute: async (path, wait) => { blocked.push(['route', path, wait]); },
    blockAccount: async (token, wait) => { blocked.push(['account', token, wait]); },
  });
  const client = createQuestApiClient({ token: 'test-token', profile, coordinator: limitedCoordinator,
    transport: async () => response(JSON.stringify({ retry_after: 0 }), 429) });
  await assert.rejects(client.enroll('quest-1'), DiscordApiError);
  assert.deepEqual(blocked, [
    ['route', '/quests/quest-1/enroll', 0],
    ['account', 'test-token', 0],
  ]);
});

test('background safe read retries a transient transport failure and an HTTP 5xx response', async () => {
  let calls = 0;
  const client = api({ transport: async () => {
    calls += 1;
    if (calls === 1) throw new Error('temporary network failure');
    if (calls === 2) return response('{}', 503);
    return response(JSON.stringify({ id: 'account-1' }), 200);
  } });
  assert.deepEqual(await client.fetchCurrentUser(new AbortController().signal), { id: 'account-1' });
  assert.equal(calls, 3);
});

test('response size guards reject oversized declared and streamed bodies', async () => {
  const declared = api({ transport: async () => response('{}', 200, { 'content-length': String(2 * 1024 * 1024) }) });
  await assert.rejects(declared.fetchCurrentUser(), (error) => causedBy(error, 'Discord response exceeds size limit'));
  const streamed = api({ transport: async () => response('x'.repeat(2 * 1024 * 1024), 200) });
  await assert.rejects(streamed.fetchCurrentUser(), (error) => causedBy(error, 'Discord response exceeds size limit'));
});
