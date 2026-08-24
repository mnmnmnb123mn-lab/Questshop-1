import { createHmac, timingSafeEqual } from 'node:crypto';
import { withTransaction } from '../db/transaction.js';

const RINGS = Object.freeze([
  ['DATA_ENCRYPTION', 'DATA_ENCRYPTION_KEYS_JSON'],
  ['VOUCHER_HMAC', 'VOUCHER_HMAC_KEYS_JSON'],
  ['BACKUP_ENCRYPTION', 'BACKUP_ENCRYPTION_KEYS_JSON'],
]);

function sentinelDigest(name, version, encodedKey) {
  const key = Buffer.from(encodedKey, 'base64');
  return createHmac('sha256', key).update(`questshop:key-sentinel:v1:${name}:${version}`).digest('hex');
}

function sameDigest(left, right) {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function hasDurableSecurityData(pool) {
  const result = await pool.query(`SELECT EXISTS(
    SELECT 1 FROM topups UNION ALL SELECT 1 FROM checkout_credentials UNION ALL
    SELECT 1 FROM order_credentials UNION ALL SELECT 1 FROM monitor_credentials UNION ALL
    SELECT 1 FROM receiver_versions UNION ALL SELECT 1 FROM backup_runs
  ) AS value`);
  return result.rows[0]?.value === true;
}

function expectedSentinels(env) {
  return RINGS.flatMap(([name, field]) => {
    const ring = env[field];
    return ring ? Object.entries(ring.keys).map(([version, key]) => ({
      name, version: Number(version), digest: sentinelDigest(name, version, key),
    })) : [];
  });
}

function sentinelKey(item) {
  return `${item.name}:${item.version}`;
}

function assertSentinelSetMatches(existing, expected) {
  const expectedByKey = new Map(expected.map((item) => [sentinelKey(item), item]));
  const existingByKey = new Map(existing.map((item) => [sentinelKey({
    name: item.keyring_name, version: Number(item.key_version),
  }), item]));
  const missing = [...expectedByKey.keys()].filter((key) => !existingByKey.has(key));
  const unexpected = [...existingByKey.keys()].filter((key) => !expectedByKey.has(key));
  if (missing.length || unexpected.length) {
    throw Object.assign(new Error('Configured crypto key versions do not exactly match durable sentinel records'), {
      code: 'KEY_SENTINEL_SET_MISMATCH', missing, unexpected,
    });
  }
  for (const [key, item] of expectedByKey) {
    const stored = existingByKey.get(key);
    if (!sameDigest(stored.verification_digest, item.digest)) {
      throw Object.assign(new Error(`Configured ${item.name} key ${item.version} does not match durable key material`), {
        code: 'KEY_SENTINEL_MISMATCH', keyring: item.name, version: item.version,
      });
    }
  }
}

function assertExistingSentinelsMatch(existing, expected) {
  const expectedByKey = new Map(expected.map((item) => [sentinelKey(item), item]));
  const unexpected = [];
  for (const stored of existing) {
    const key = sentinelKey({ name: stored.keyring_name, version: Number(stored.key_version) });
    const item = expectedByKey.get(key);
    if (!item) {
      unexpected.push(key);
      continue;
    }
    if (!sameDigest(stored.verification_digest, item.digest)) {
      throw Object.assign(new Error(`Configured ${item.name} key ${item.version} does not match durable key material`), {
        code: 'KEY_SENTINEL_MISMATCH', keyring: item.name, version: item.version,
      });
    }
  }
  if (unexpected.length) {
    throw Object.assign(new Error('Configured keyring removed a durable sentinel version'), {
      code: 'KEY_SENTINEL_SET_MISMATCH', unexpected,
    });
  }
}

async function insertSentinels(client, expected) {
  for (const item of expected) {
    await client.query(`INSERT INTO crypto_key_sentinels(keyring_name,key_version,verification_digest)
      VALUES($1,$2,$3)`, [item.name, item.version, item.digest]);
  }
}

export async function validateOrInitializeKeyringSentinels(pool, env) {
  const expected = expectedSentinels(env);
  return withTransaction({ pool, isolation: 'SERIALIZABLE' }, async (client) => {
    // Locking the relation prevents two fresh runtimes from both deciding that
    // they own first-run initialization. All records are then committed as one
    // durable set or not at all.
    await client.query('LOCK TABLE crypto_key_sentinels IN EXCLUSIVE MODE');
    const existing = (await client.query('SELECT keyring_name,key_version,verification_digest FROM crypto_key_sentinels'))
      .rows;
    if (!existing.length) {
      if (await hasDurableSecurityData(client)) {
        throw Object.assign(new Error('Crypto key sentinel bootstrap requires explicit owner adoption'), {
          code: 'KEY_SENTINEL_BOOTSTRAP_REQUIRED',
        });
      }
      await insertSentinels(client, expected);
      return { initialized: true, count: expected.length };
    }
    assertSentinelSetMatches(existing, expected);
    return { initialized: false, count: existing.length };
  });
}

export async function validateKeyringSentinels(pool, env) {
  const expected = expectedSentinels(env);
  return withTransaction({ pool, isolation: 'READ COMMITTED' }, async (client) => {
    const existing = (await client.query('SELECT keyring_name,key_version,verification_digest FROM crypto_key_sentinels'))
      .rows;
    if (!existing.length) {
      throw Object.assign(new Error('Crypto key sentinels have not been initialized'), { code: 'KEY_SENTINEL_MISSING' });
    }
    assertSentinelSetMatches(existing, expected);
    return { count: existing.length };
  });
}

// Owner-only recovery for a database created before sentinel support. It is
// deliberately separate from startup: invoking it is an explicit statement
// that the configured keyrings were verified against the existing durable
// data. It cannot silently add a new key during normal runtime startup.
export async function adoptKeyringSentinels(pool, env) {
  const expected = expectedSentinels(env);
  return withTransaction({ pool, isolation: 'SERIALIZABLE' }, async (client) => {
    await client.query('LOCK TABLE crypto_key_sentinels IN EXCLUSIVE MODE');
    const existing = (await client.query('SELECT keyring_name,key_version,verification_digest FROM crypto_key_sentinels'))
      .rows;
    if (existing.length) {
      // Explicit Owner adoption is also the only supported way to append a
      // new verified key version. Existing sentinels must still match exactly;
      // this permits rotation but never implicit replacement or deletion.
      assertExistingSentinelsMatch(existing, expected);
      const existingKeys = new Set(existing.map((item) => sentinelKey({
        name: item.keyring_name, version: Number(item.key_version),
      })));
      const additions = expected.filter((item) => !existingKeys.has(sentinelKey(item)));
      await insertSentinels(client, additions);
      return { adopted: additions.length > 0, count: existing.length + additions.length };
    }
    await insertSentinels(client, expected);
    return { adopted: true, count: expected.length };
  });
}
