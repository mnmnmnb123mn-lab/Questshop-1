import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { decodeSecretBundle } from './secret-bundle.js';

function loadSecretBundle() {
  const values = decodeSecretBundle(process.env.QUESTSHOP_SECRET_BUNDLE);
  if (!values) return;
  for (const [key, value] of Object.entries(values)) {
    // Explicit deployment variables take precedence. The bundle is intended
    // for stateless hosts, never as an implicit secret-rotation mechanism.
    if (process.env[key] == null) process.env[key] = value;
  }
}

try {
  loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

loadSecretBundle();

export { loadSecretBundle };
