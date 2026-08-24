import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { reconcileSurfaceAnchors } from '../../src/discord/surfaces/setup.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

test('payment-log human permission changes never quarantine the durable surface', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  await pool.query(`INSERT INTO surfaces(surface_key,guild_id,channel_id,message_id,state,last_validated_at)
    VALUES('LOG_PAYMENTS','guild','payments','message','ACTIVE',clock_timestamp())`);
  const message = {
    id: 'message', author: { id: 'bot' }, embeds: [{ footer: { text: 'Questshop Surface • LOG_PAYMENTS' } }],
    attachments: [], edit: async function edit() { return this; },
  };
  const channel = {
    id: 'payments', guild: { roles: { everyone: { id: 'guild' }, cache: new Map() } },
    client: { user: { id: 'bot' }, questshop: { env: { OWNER_ID: 'owner' } } },
    permissionOverwrites: { cache: new Map() },
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => message },
    isTextBased: () => true, isDMBased: () => false,
  };
  const guild = { channels: { fetch: async () => channel } };
  const client = { guilds: { fetch: async () => guild } };
  const context = createContext({ actorType: 'SYSTEM', actorId: 'maintenance', guildId: 'guild',
    idempotencyKey: 'payment-surface-owner-managed' });

  const results = await reconcileSurfaceAnchors({ client, pool, env: { DISCORD_GUILD_ID: 'guild' },
    config: { version: 1, values: {} } }, context);
  assert.notEqual(results[0].reason, 'SURFACE_CHANNEL_INVALID');
  assert.equal((await pool.query("SELECT state FROM surfaces WHERE surface_key='LOG_PAYMENTS'")).rows[0].state, 'ACTIVE');
});
