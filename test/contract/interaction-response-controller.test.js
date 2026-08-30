import assert from 'node:assert/strict';
import test from 'node:test';
import { ACKNOWLEDGEMENT, acknowledgementOf, installResponseController } from '../../src/discord/interactions/response-controller.js';

test('interaction response controller permits one initial acknowledgement and rejects a second', async () => {
  const calls = [];
  const interaction = {
    reply: async (payload) => { calls.push(['reply', payload]); return { id: 'reply' }; },
    update: async (payload) => { calls.push(['update', payload]); return { id: 'update' }; },
  };
  installResponseController(interaction);
  await interaction.reply({ content: 'หนึ่งครั้ง', ephemeral: true });
  assert.equal(acknowledgementOf(interaction), ACKNOWLEDGEMENT.REPLY);
  await assert.rejects(() => interaction.update({ content: 'ซ้ำ' }), (error) => error.code === 'INTERACTION_ALREADY_ACKNOWLEDGED');
  assert.equal(calls.length, 1);
});
