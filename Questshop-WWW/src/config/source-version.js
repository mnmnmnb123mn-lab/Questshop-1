import { execFileSync } from 'node:child_process';

const SHA = /^[0-9a-f]{40}$/i;

export function inspectSourceSha({ cwd = process.cwd(), execute = execFileSync } = {}) {
  try {
    const value = String(execute('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    return SHA.test(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function verifyConfiguredSourceSha(env, options = {}) {
  const sourceSha = inspectSourceSha(options);
  const configuredSha = SHA.test(String(env?.GIT_SHA ?? '')) ? String(env.GIT_SHA).toLowerCase() : null;
  if (sourceSha && configuredSha && sourceSha !== configuredSha) {
    throw new Error(`GIT_SHA does not match checked-out source (${sourceSha})`);
  }
  return Object.freeze({ sourceSha, verified: sourceSha !== null && (!configuredSha || sourceSha === configuredSha) });
}
