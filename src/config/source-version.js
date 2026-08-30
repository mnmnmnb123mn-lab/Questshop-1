import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SHA = /^[0-9a-f]{40}$/i;

export function inspectSourceSha({ cwd = process.cwd(), execute = execFileSync } = {}) {
  try {
    const value = String(execute('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    return SHA.test(value) ? value.toLowerCase() : null;
  } catch { /* Docker deliberately excludes .git; use its immutable build stamp. */ }
  try {
    const stamped = String(readFileSync(path.join(cwd, '.source-sha'), 'utf8')).trim();
    return SHA.test(stamped) ? stamped.toLowerCase() : null;
  } catch { return null; }
}

export function verifyConfiguredSourceSha(env, options = {}) {
  const sourceSha = inspectSourceSha(options);
  const configuredSha = SHA.test(String(env?.GIT_SHA ?? '')) ? String(env.GIT_SHA).toLowerCase() : null;
  if (sourceSha && configuredSha && sourceSha !== configuredSha) {
    throw new Error(`GIT_SHA does not match checked-out source (${sourceSha})`);
  }
  if (env?.NODE_ENV === 'production' && (!configuredSha || !sourceSha)) {
    throw new Error('Production requires a matching 40-character GIT_SHA embedded in the build');
  }
  return Object.freeze({ sourceSha, verified: sourceSha !== null && (!configuredSha || sourceSha === configuredSha) });
}
