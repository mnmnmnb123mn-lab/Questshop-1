import { request as httpsRequest } from 'node:https';
import { discordQuestRequestPath } from './endpoints.js';

const DISCORD_HOSTNAME = 'discord.com';
const DISCORD_PORT = 443;
const DISCORD_PROTOCOL = 'https:';
const FIXED_DISCORD_ORIGIN = 'https://discord.com:443';
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'connection', 'content-length', 'expect', 'host', 'proxy-authorization', 'proxy-connection',
  'transfer-encoding', 'upgrade',
]);

function responseHeaders(headers = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return Object.freeze({ get: (name) => normalized.get(String(name).toLowerCase()) ?? null });
}

function responseTooLarge(maxResponseBytes) {
  const error = new Error('Discord response exceeds size limit');
  error.code = 'RESPONSE_TOO_LARGE';
  error.maxResponseBytes = maxResponseBytes;
  return error;
}

function readResponse(response, maxResponseBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    response.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxResponseBytes) {
        response.destroy(responseTooLarge(maxResponseBytes));
        return;
      }
      chunks.push(chunk);
    });
    response.once('aborted', () => reject(new Error('Discord response was aborted')));
    response.once('error', reject);
    response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function requestHeaders(headers, body) {
  const safeHeaders = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const normalizedName = String(name).toLowerCase();
    if (!FORBIDDEN_REQUEST_HEADERS.has(normalizedName)) safeHeaders[normalizedName] = value;
  }
  if (body != null) {
    safeHeaders['content-length'] = String(Buffer.byteLength(body));
  }
  return safeHeaders;
}

function requestOptions({ body, headers, method, path, signal }) {
  const safeHeaders = requestHeaders(headers, body);
  return {
    protocol: DISCORD_PROTOCOL,
    hostname: DISCORD_HOSTNAME,
    port: DISCORD_PORT,
    path: discordQuestRequestPath(path),
    method,
    headers: safeHeaders,
    signal,
  };
}

function sendRequest(requestImpl, options, body, maxResponseBytes) {
  return new Promise((resolve, reject) => {
    const request = requestImpl(options, (response) => {
      const text = readResponse(response, maxResponseBytes);
      resolve(Object.freeze({
        status: response.statusCode ?? 0,
        ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: responseHeaders(response.headers),
        text: async () => text,
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

function fixedHttpsRequest(options, onResponse) {
  // Keep the HTTP-client URL argument literal. The separately validated path
  // in options cannot alter this origin and native HTTPS does not follow 3xx.
  return httpsRequest(FIXED_DISCORD_ORIGIN, options, onResponse);
}

// The request sink uses a literal Discord origin.  Node's native HTTPS client
// follows no redirects, so a malicious Location header cannot change hosts.
export function createFixedDiscordTransport({ requestImpl = fixedHttpsRequest } = {}) {
  return async function fixedDiscordTransport({ body, headers, method, path, signal,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES }) {
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
      throw new TypeError('maxResponseBytes must be a positive safe integer');
    }
    return sendRequest(requestImpl, requestOptions({ body, headers, method, path, signal }), body, maxResponseBytes);
  };
}

export const fixedDiscordTransport = createFixedDiscordTransport();
