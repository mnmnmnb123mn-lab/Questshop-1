import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LabelBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import {
  ACKNOWLEDGEMENT, acknowledgementOf, acknowledgeByContract, installResponseController,
} from '../../src/discord/interactions/response-controller.js';

test('response controller converts deprecated ephemeral options and owns one acknowledgement', async () => {
  const calls = [];
  const interaction = {
    deferReply: async (options) => { calls.push(['deferReply', options]); },
    reply: async (options) => { calls.push(['reply', options]); },
  };
  installResponseController(interaction);
  await interaction.deferReply({ ephemeral: true });
  assert.deepEqual(calls, [['deferReply', { flags: MessageFlags.Ephemeral }]]);
  assert.equal(acknowledgementOf(interaction), ACKNOWLEDGEMENT.DEFER_REPLY);
  assert.equal(await interaction.deferReply({ ephemeral: true }), null);
  await assert.rejects(() => interaction.reply({ content: 'late' }),
    (error) => error.code === 'INTERACTION_ALREADY_ACKNOWLEDGED');
});

test('Token submit sends an immediate ephemeral progress reply and legacy defer becomes a no-op', async () => {
  const calls = [];
  const interaction = {
    customId: 'qs:v1:token_submit:00000000-0000-0000-0000-000000000000',
    reply: async (options) => { calls.push(['reply', options]); },
    deferReply: async (options) => { calls.push(['deferReply', options]); },
  };
  installResponseController(interaction);
  await acknowledgeByContract(interaction, 'REPLY');
  assert.equal(acknowledgementOf(interaction), ACKNOWLEDGEMENT.REPLY);
  assert.deepEqual(calls, [['reply', {
    content: 'กำลังตรวจบัญชีและค้นหา Quest ที่ยังใช้งานได้…',
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  }]]);
  assert.equal(await interaction.deferReply({ ephemeral: true }), null);
  assert.equal(calls.length, 1);
});

test('response controller preserves a real ModalBuilder as a terminal acknowledgement', async () => {
  let received;
  const input = new TextInputBuilder().setCustomId('amount').setStyle(TextInputStyle.Short).setRequired(true);
  const modal = new ModalBuilder()
    .setCustomId('qs:v1:test:00000000-0000-0000-0000-000000000000')
    .setTitle('ตั้งราคา')
    .addLabelComponents(new LabelBuilder().setLabel('ราคาใหม่').setTextInputComponent(input));
  const interaction = { showModal: async (value) => {
    received = value;
    return value.toJSON();
  } };
  installResponseController(interaction);
  await interaction.showModal(modal);
  assert.equal(received, modal);
  assert.equal(received.toJSON().custom_id, 'qs:v1:test:00000000-0000-0000-0000-000000000000');
  assert.equal(received.toJSON().components[0].type, 18);
  assert.equal(acknowledgementOf(interaction), ACKNOWLEDGEMENT.MODAL);
});

test('response controller normalizes rendered replies and reports the actual message once', async () => {
  const messages = [];
  const interaction = {
    deferReply: async () => {},
    editReply: async (payload) => ({ id: 'ephemeral-reply', payload }),
  };
  installResponseController(interaction, { onMessage: async (event) => messages.push(event) });
  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply({ content: '@everyone '.repeat(500), allowedMentions: { parse: ['everyone'] } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].result.id, 'ephemeral-reply');
  assert.ok(messages[0].payload.content.length <= 2_000);
  assert.deepEqual(messages[0].payload.allowedMentions.parse, []);
  assert.match(messages[0].payload.content, /@\u200beveryone/);
});
