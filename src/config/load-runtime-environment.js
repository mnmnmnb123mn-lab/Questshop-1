import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { decodeSecretBundle } from './secret-bundle.js';
import { runtimeEnvironmentValues } from './runtime-environment-values.js';

function applyRuntimeValues(values) {
  for (const [key, value] of Object.entries(runtimeEnvironmentValues(values) ?? {})) {
    if (process.env[key] == null) process.env[key] = value;
  }
}

try {
  applyRuntimeValues(parseEnv(readFileSync(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8')));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const bundle = process.env.QUESTSHOP_SECRET_BUNDLE;
applyRuntimeValues(decodeSecretBundle(bundle));
// Do not retain the encoded bundle after the runtime allowlist is applied.
delete process.env.QUESTSHOP_SECRET_BUNDLE;
