import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { safeError } from '../shared/redaction.js';

export function createHealthState() {
  return {
    live: true,
    ready: false,
    status: 'NOT_READY',
    startedAt: new Date().toISOString(),
    checks: {},
    workers: {},
    overview: {},
    lastError: null,
    operationalStatus: 'HEALTHY',
  };
}

function writeJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function authorizationDigest(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest();
}

function hasStatusAccess(authorization, statusToken) {
  // Hash both candidates to a fixed-size value so even malformed/missing
  // headers follow the same comparison primitive as a valid Bearer token.
  return timingSafeEqual(
    authorizationDigest(authorization),
    authorizationDigest(`Bearer ${statusToken}`),
  );
}

export async function startHealthServer({ port, statusToken, state }) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method !== 'GET') return writeJson(response, 405, { ok: false });
    if (url.pathname === '/livez') return writeJson(response, state.live ? 200 : 503, { ok: state.live });
    if (url.pathname === '/readyz') {
      return writeJson(response, state.ready ? 200 : 503, {
        ok: state.ready,
        status: state.status,
      });
    }
    if (url.pathname === '/statusz') {
      if (!hasStatusAccess(request.headers.authorization, statusToken)) {
        return writeJson(response, 401, { ok: false });
      }
      return writeJson(response, 200, {
        ok: state.ready,
        status: state.status,
        startedAt: state.startedAt,
        checks: state.checks,
        workers: state.workers,
        overview: state.overview,
        lastError: state.lastError ? safeError(state.lastError) : null,
      });
    }
    return writeJson(response, 404, { ok: false });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  return server;
}

export async function closeHealthServer(server) {
  if (!server?.listening) return;
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
