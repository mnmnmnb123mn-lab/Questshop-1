import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSensitiveSurfacePrivacy } from '../../src/discord/surfaces/setup.js';

test('surface setup does not infer human visibility policy from Discord permissions', () => {
  assert.equal(assertSensitiveSurfacePrivacy(null, 'QUEST_AUTO'), true);
  assert.equal(assertSensitiveSurfacePrivacy(null, 'LOG_PAYMENTS'), true);
  assert.equal(assertSensitiveSurfacePrivacy({
    guild: { roles: { everyone: { id: 'guild' }, cache: new Map() } },
    permissionsFor: () => ({ has: () => true }),
  }, 'LOG_PAYMENTS'), true);
});

test('LOG_PAYMENTS visibility remains an explicit Owner deployment responsibility', () => {
  const intentionallyBroadChannel = {
    guild: { roles: { everyone: { id: 'guild' }, cache: new Map() } },
    client: { user: { id: 'bot-user' }, questshop: { env: { OWNER_ID: 'owner-user' } } },
    permissionOverwrites: { cache: new Map() },
    permissionsFor: () => ({ has: () => true }),
  };
  assert.doesNotThrow(() => assertSensitiveSurfacePrivacy(intentionallyBroadChannel, 'LOG_PAYMENTS'));
});
