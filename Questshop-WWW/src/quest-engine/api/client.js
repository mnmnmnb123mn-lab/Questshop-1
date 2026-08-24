import { setTimeout as delay } from 'node:timers/promises';
import { QuestshopError } from '../../shared/errors.js';
import { secureJitter } from '../../shared/random.js';
import { extractQuestArray, QuestCompatibilityError } from '../schema/compatibility.js';
import { normalizeQuestPayload } from '../schema/normalizer.js';
import { discordRateLimitCoordinator } from '../rate-limits/coordinator.js';
import { fixedDiscordTransport } from './discord-transport.js';
import { FATAL_FORBIDDEN_PATHS, QUEST_ENDPOINT, QUEST_LIST_PATHS } from './endpoints.js';

export { QUEST_API_VERSION } from './endpoints.js';
const DEFAULT_TIMEOUT_MS = 15_000;
const INTERACTIVE_TIMEOUT_MS = 6_000;
const BACKGROUND_SAFE_READ_ATTEMPTS = 5;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class DiscordApiError extends Error {
  constructor(status, path, data) {
    super(`Discord API ${status} at ${path}`);
    this.name = 'DiscordApiError';
    this.status = status;
    this.path = path;
    this.data = data;
    this.fatalAuth = status === 401 || (status === 403 && FATAL_FORBIDDEN_PATHS.has(path));
  }
}

export class DiscordApiTransportError extends Error {
  constructor(path, cause) {
    super(`Unable to read Discord API response at ${path}`, { cause });
    this.name = 'DiscordApiTransportError';
    this.path = path;
  }
}

export class DiscordApiTimeoutError extends DiscordApiTransportError {
  constructor(path, { possiblySent = false } = {}) {
    super(path, new Error('Discord Quest API request timed out'));
    this.name = 'DiscordApiTimeoutError';
    this.code = 'QUEST_API_TIMEOUT';
    this.retryable = true;
    this.possiblySent = possiblySent;
  }
}

export function isCaptchaChallenge(data) {
  return Boolean(data?.captcha_sitekey || data?.captcha_service || data?.captcha_rqtoken
    || data?.captcha_rqdata || data?.captcha_key);
}

function headers(token, path, profile) {
  const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/${profile.clientVersion} Chrome/${profile.chromeVersion} Electron/${profile.electronVersion} Safari/537.36`;
  const superProperties = Buffer.from(JSON.stringify({
    os: 'Windows', browser: 'Discord Client', release_channel: 'stable',
    client_version: profile.clientVersion, os_version: '10.0.22631', os_arch: 'x64',
    app_arch: 'x64', system_locale: profile.locale, browser_user_agent: userAgent,
    browser_version: profile.chromeVersion, client_build_number: profile.buildNumber,
    native_build_number: profile.nativeBuildNumber, client_event_source: null, design_id: 0,
  })).toString('base64');
  const chromeMajor = String(profile.chromeVersion).split('.')[0];
  return {
    authorization: token,
    'content-type': 'application/json',
    'user-agent': userAgent,
    'x-super-properties': superProperties,
    'x-discord-locale': profile.locale,
    'x-discord-timezone': 'Asia/Bangkok',
    accept: '*/*',
    'accept-language': `${profile.locale},en;q=0.9`,
    // The fixed native HTTPS transport intentionally does not auto-decompress
    // responses, so ask Discord for a bounded identity response.
    'accept-encoding': 'identity',
    'x-debug-options': 'bugReporterEnabled',
    origin: 'https://discord.com',
    referer: path.startsWith('/quests/') ? 'https://discord.com/quest-home' : 'https://discord.com/channels/@me',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'sec-ch-ua': `"Chromium";v="${chromeMajor}", "Not)A;Brand";v="8"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
}

function retryAfterMs(response, data) {
  const seconds = Number(data?.retry_after ?? response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 1000;
}

async function recordRateLimit(coordinator, token, path, response, data) {
  if (response.status !== 429) return;
  const wait = retryAfterMs(response, data);
  if (data?.global || String(response.headers.get('x-ratelimit-global')).toLowerCase() === 'true') {
    await coordinator.blockGlobally(wait);
    return;
  }
  await coordinator.blockRoute?.(path, wait);
  await coordinator.blockAccount?.(token, wait);
}

async function parseResponse(response, path) {
  try {
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      throw new DiscordApiTransportError(path, new Error('Discord response exceeds size limit'));
    }
    const text = response.status === 204 ? '' : await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new DiscordApiTransportError(path, new Error('Discord response exceeds size limit'));
    }
    try { return text ? JSON.parse(text) : null; } catch { return text; }
  } catch (error) {
    throw new DiscordApiTransportError(path, error);
  }
}

function requestSignal(callerSignal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const signals = [controller.signal];
  if (callerSignal) signals.push(callerSignal);
  return {
    signal: AbortSignal.any(signals),
    timedOut: () => controller.signal.aborted && !callerSignal?.aborted,
    dispose: () => clearTimeout(timer),
  };
}

async function waitForSafeRetry({ response, data, safeRead, attempt, maxAttempts, coordinator, signal }) {
  if (!safeRead || attempt + 1 >= maxAttempts) return false;
  if (response.status === 429) {
    const wait = retryAfterMs(response, data);
    if (data?.global || String(response.headers.get('x-ratelimit-global')).toLowerCase() === 'true') await coordinator.blockGlobally(wait);
    await delay(wait, undefined, { signal });
    return true;
  }
  if (response.status < 500) return false;
  await delay(secureJitter(Math.min(30_000, 500 * (2 ** attempt))), undefined, { signal });
  return true;
}

async function waitForTransportRetry({ error, safeRead, attempt, maxAttempts, signal }) {
  if (error?.name === 'AbortError' || !safeRead || attempt + 1 >= maxAttempts) return false;
  await delay(secureJitter(Math.min(30_000, 500 * (2 ** attempt))), undefined, { signal });
  return true;
}

async function dispatchQuestRequest({ bounded, coordinator, method, options, path, profile, safeRead, token, transport }) {
  let dispatched = false;
  try {
    const response = await coordinator.schedule({
      token, path, method, signal: bounded.signal,
      execute: () => {
        dispatched = true;
        return transport({
          path,
          method,
          body: options.body,
          signal: bounded.signal,
          headers: { ...headers(token, path, profile), ...options.headers },
          maxResponseBytes: MAX_RESPONSE_BYTES,
        });
      },
    });
    return { dispatched, response };
  } catch (error) {
    if (bounded.timedOut()) throw new DiscordApiTimeoutError(path, { possiblySent: dispatched });
    throw markMutationTransportUncertainty(error, { safeRead, dispatched });
  }
}

async function interpretQuestResponse({ coordinator, path, response, token }) {
  const data = await parseResponse(response, path);
  if (response.ok) return { complete: true, value: data ?? { ok: true, status: response.status } };
  await recordRateLimit(coordinator, token, path, response, data);
  return { data, response };
}

function markMutationTransportUncertainty(error, { safeRead, dispatched }) {
  // A rejected fetch or unreadable response after calling fetch gives no proof
  // that Discord did not receive a mutation.  The Runner uses this marker to
  // read fresh state before it can ever send the mutation again.
  if (!safeRead && dispatched && error && typeof error === 'object'
    && !(error instanceof DiscordApiError)) error.possiblySent = true;
  else if (!safeRead && error && typeof error === 'object' && !(error instanceof DiscordApiError)) {
    error.possiblySent ??= false;
  }
  return error;
}

async function makeQuestRequestAttempt({ coordinator, method, options, path, profile, safeRead, timeoutMs, token, transport }) {
  let dispatched = false;
  const bounded = requestSignal(options.signal, timeoutMs);
  try {
    const dispatchedRequest = await dispatchQuestRequest({
      bounded, coordinator, method, options, path, profile, safeRead, token, transport,
    });
    dispatched = dispatchedRequest.dispatched;
    const result = await interpretQuestResponse({ coordinator, path, response: dispatchedRequest.response, token });
    return result.complete ? { kind: 'SUCCESS', value: result.value } : { kind: 'RESPONSE_ERROR', result };
  } catch (error) {
    return { kind: 'TRANSPORT_ERROR', error, dispatched, timedOut: bounded.timedOut() };
  } finally {
    bounded.dispose();
  }
}

async function resolveResponseError({ attempt, maxAttempts, path, result, safeRead, signal, coordinator }) {
  if (await waitForSafeRetry({ ...result, safeRead, attempt, maxAttempts, coordinator, signal })) return true;
  throw new DiscordApiError(result.response.status, path, result.data);
}

async function resolveTransportError({ attempt, error, maxAttempts, path, safeRead, signal, dispatched, timedOut }) {
  if (error instanceof DiscordApiTimeoutError) throw error;
  if (timedOut) throw new DiscordApiTimeoutError(path, { possiblySent: dispatched });
  if (error instanceof DiscordApiError || error?.name === 'AbortError') throw error;
  if (await waitForTransportRetry({ error, safeRead, attempt, maxAttempts, signal })) return true;
  throw markMutationTransportUncertainty(error, { safeRead, dispatched });
}

function safeReadPolicy(signal, configuredTimeoutMs) {
  if (signal) return { maxAttempts: BACKGROUND_SAFE_READ_ATTEMPTS, timeoutMs: configuredTimeoutMs };
  return { maxAttempts: 1, timeoutMs: Math.min(configuredTimeoutMs, INTERACTIVE_TIMEOUT_MS) };
}

function customerReadError(error, signal) {
  if (signal || error instanceof QuestshopError || error?.name === 'AbortError') return error;
  if (error instanceof DiscordApiError) {
    if (error.fatalAuth || error.status === 401 || error.status === 403) {
      return new QuestshopError('TOKEN_INVALID', 'Discord Token ใช้ไม่ได้หรือหมดอายุ กรุณาตรวจสอบ Token แล้วลองใหม่', {
        category: 'CUSTOMER_INPUT', cause: error,
      });
    }
    if (error.status === 429) {
      return new QuestshopError('RATE_LIMITED', 'Discord จำกัดการตรวจบัญชีชั่วคราว กรุณารอสักครู่แล้วลองใหม่', {
        category: 'EXTERNAL', retryable: true, cause: error,
      });
    }
    if (error.status >= 500) {
      return new QuestshopError('RUNTIME_NOT_ACTIVE', 'Discord Quest ยังไม่พร้อมตอบตอนนี้ กรุณาลองใหม่อีกครั้ง', {
        category: 'EXTERNAL', retryable: true, cause: error,
      });
    }
  }
  if (error instanceof DiscordApiTimeoutError || error instanceof DiscordApiTransportError
    || error instanceof QuestCompatibilityError) {
    return new QuestshopError('RUNTIME_NOT_ACTIVE', 'Discord Quest ตอบช้าหรือไม่พร้อมชั่วคราว กรุณาลองใหม่อีกครั้ง', {
      category: 'EXTERNAL', retryable: true, cause: error,
    });
  }
  return error;
}

function questNotExpired(quest, now = Date.now()) {
  if (!quest?.expiresAt) return true;
  const expiresAt = Date.parse(quest.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt > now;
}

export function createQuestApiClient({ token, profile, coordinator = discordRateLimitCoordinator,
  timeoutMs = DEFAULT_TIMEOUT_MS, transport = fixedDiscordTransport }) {
  async function request(path, options = {}, { safeRead = false, maxAttempts = safeRead ? 5 : 1 } = {}) {
    const method = String(options.method ?? 'GET').toUpperCase();
    const requestTimeoutMs = options.timeoutMs ?? timeoutMs;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const outcome = await makeQuestRequestAttempt({
        coordinator, method, options, path, profile, safeRead, timeoutMs: requestTimeoutMs, token, transport,
      });
      if (outcome.kind === 'SUCCESS') return outcome.value;
      const retry = outcome.kind === 'RESPONSE_ERROR'
        ? await resolveResponseError({ attempt, maxAttempts, path, result: outcome.result, safeRead,
          signal: options.signal, coordinator })
        : await resolveTransportError({ attempt, error: outcome.error, maxAttempts, path, safeRead,
          signal: options.signal, dispatched: outcome.dispatched, timedOut: outcome.timedOut });
      if (retry) continue;
    }
    throw new Error(`${method} ${path} retry budget exhausted`);
  }

  async function fetchQuestPayload(signal) {
    let empty = null;
    let lastError;
    const policy = safeReadPolicy(signal, timeoutMs);
    for (const path of QUEST_LIST_PATHS) {
      try {
        const candidate = await request(path, { signal, timeoutMs: policy.timeoutMs },
          { safeRead: true, maxAttempts: policy.maxAttempts });
        const payload = {
          path,
          quests: extractQuestArray(candidate, path),
          enrollmentBlockedUntil: candidate?.quest_enrollment_blocked_until ?? null,
        };
        if (payload.quests.length) return payload;
        empty ??= payload;
      } catch (error) {
        if (error?.name === 'AbortError' || [401, 403].includes(error?.status)) throw error;
        lastError = error;
      }
    }
    if (empty) return empty;
    throw new QuestCompatibilityError(`Quest endpoints unavailable: ${lastError?.message ?? 'unknown'}`);
  }

  async function fetchQuests(signal, { includeExpired = false } = {}) {
    try {
      const payload = await fetchQuestPayload(signal);
      // Checkout/catalog do not need Discord's historical Quest rows. Runner
      // verification does: it must be able to prove a deadline outcome after
      // a mutation instead of mistaking an expired Quest for a missing one.
      const now = Date.now();
      const quests = normalizeQuestPayload(payload.quests, payload.enrollmentBlockedUntil);
      return includeExpired ? quests : quests.filter((quest) => questNotExpired(quest, now));
    } catch (error) {
      throw customerReadError(error, signal);
    }
  }

  async function fetchCurrentUser(signal) {
    const policy = safeReadPolicy(signal, timeoutMs);
    try {
      return await request(QUEST_ENDPOINT.me(), { signal, timeoutMs: policy.timeoutMs },
        { safeRead: true, maxAttempts: policy.maxAttempts });
    } catch (error) {
      throw customerReadError(error, signal);
    }
  }

  return Object.freeze({
    fetchCurrentUser,
    fetchQuests,
    enroll: (questId, signal) => request(QUEST_ENDPOINT.enroll(questId), {
      method: 'POST', body: JSON.stringify({ location: 11, is_targeted: false, metadata_raw: null }), signal,
    }),
    sendVideoProgress: (questId, timestamp, signal) => request(QUEST_ENDPOINT.videoProgress(questId), {
      method: 'POST', body: JSON.stringify({ timestamp: Math.floor(timestamp) }), signal,
    }),
    async sendHeartbeat(quest, terminal, useApplicationPayload, signal) {
      const path = QUEST_ENDPOINT.heartbeat(quest.id);
      const applicationPayload = () => request(path, {
        method: 'POST', body: JSON.stringify({ application_id: quest.applicationId, terminal: Boolean(terminal) }), signal,
      });
      if (useApplicationPayload) return applicationPayload();
      try {
        return await request(path, {
          method: 'POST', body: JSON.stringify({ stream_key: `call:${quest.id}:1`, terminal: Boolean(terminal) }), signal,
        });
      } catch (error) {
        if (error?.status !== 400 || !quest?.applicationId || isCaptchaChallenge(error.data)) throw error;
        return applicationPayload();
      }
    },
  });
}

export function profileFromEnv(env) {
  return Object.freeze({
    clientVersion: env.DISCORD_CLIENT_VERSION,
    chromeVersion: env.DISCORD_CHROME_VERSION,
    electronVersion: env.DISCORD_ELECTRON_VERSION,
    buildNumber: env.DISCORD_BUILD_NUMBER,
    nativeBuildNumber: env.DISCORD_NATIVE_BUILD_NUMBER,
    locale: env.DISCORD_LOCALE,
  });
}
