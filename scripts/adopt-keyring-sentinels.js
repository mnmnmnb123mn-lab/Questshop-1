import '../src/config/load-local-environment.js';
import { loadEnvironment } from '../src/config/env.js';
import { getDirectPool, closeDirectPool } from '../src/db/pools.js';
import { adoptKeyringSentinels } from '../src/bootstrap/keyring-sentinels.js';

// This operation binds the currently configured keyrings to an existing
// database. It must never be run casually: an incorrect keyring makes old
// encrypted data unrecoverable. The explicit phrase protects against a
// startup script or a copied deployment command doing it by accident.
if (process.env.QUESTSHOP_KEYRING_ADOPTION !== 'VERIFY_KEYS_AND_ADOPT') {
  throw new Error('Refusing keyring adoption. Set QUESTSHOP_KEYRING_ADOPTION=VERIFY_KEYS_AND_ADOPT after verifying every durable keyring.');
}

const env = loadEnvironment();
const pool = getDirectPool(env);
try {
  const result = await adoptKeyringSentinels(pool, env);
  // The result contains no key material or digest.
  console.log(JSON.stringify({ ok: true, adopted: result.adopted, sentinelCount: result.count }));
} finally {
  await closeDirectPool();
}
