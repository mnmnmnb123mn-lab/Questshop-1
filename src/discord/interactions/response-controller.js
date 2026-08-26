import { MessageFlags } from 'discord.js';
import { QuestshopError } from '../../shared/errors.js';
import { normalizeDiscordPayload } from '../payload.js';
import { parseCustomId } from '../components/custom-id.js';

export const ACKNOWLEDGEMENT = Object.freeze({
  NONE: 'NONE',
  REPLY: 'reply',
  DEFER_REPLY: 'deferReply',
  UPDATE: 'update',
  DEFER_UPDATE: 'deferUpdate',
  MODAL: 'showModal',
});

const INITIAL_METHODS = Object.freeze([
  ACKNOWLEDGEMENT.REPLY,
  ACKNOWLEDGEMENT.DEFER_REPLY,
  ACKNOWLEDGEMENT.UPDATE,
  ACKNOWLEDGEMENT.DEFER_UPDATE,
  ACKNOWLEDGEMENT.MODAL,
]);

export function acknowledgementOf(interaction) {
  return interaction.__questshopAcknowledgement ?? ACKNOWLEDGEMENT.NONE;
}

function normalizeInitialArguments(method, args) {
  // ModalBuilder is not a message payload. Spreading/normalizing it strips
  // the builder prototype and moves custom_id/title under `data`, so
  // discord.js can no longer serialize the modal. Preserve it exactly.
  if (method === ACKNOWLEDGEMENT.MODAL) return args;
  return args.map((value, index) => {
    if (index !== 0 || !value || typeof value !== 'object') return value;
    const needsPayloadBoundary = ['content', 'embeds', 'components', 'nonce', 'allowedMentions']
      .some((key) => Object.hasOwn(value, key));
    const normalizedOptions = needsPayloadBoundary ? normalizeDiscordPayload(value) : { ...value };
    if (normalizedOptions.ephemeral !== true) return normalizedOptions;
    normalizedOptions.flags = normalizedOptions.flags ?? MessageFlags.Ephemeral;
    delete normalizedOptions.ephemeral;
    return normalizedOptions;
  });
}

function installOutputBoundary(interaction, method, onMessage) {
  if (typeof interaction[method] !== 'function') return;
  const original = interaction[method].bind(interaction);
  interaction[method] = async (...args) => {
    const normalized = normalizeInitialArguments(method, args);
    const result = await original(...normalized);
    await onMessage({ method, payload: normalized[0], result });
    return result;
  };
}

export function installResponseController(interaction, { onAcknowledged = () => {}, onMessage = async () => {} } = {}) {
  for (const method of INITIAL_METHODS) {
    if (typeof interaction[method] !== 'function') continue;
    const original = interaction[method].bind(interaction);
    interaction[method] = async (...args) => {
      const current = acknowledgementOf(interaction);
      if (current !== ACKNOWLEDGEMENT.NONE) {
        if (current === method) return null;
        // token_submit is pre-acknowledged with a real ephemeral progress
        // message so Discord never shows the indefinite "thinking" state.
        // Its legacy handler still calls deferReply(); treat only that exact
        // transition as a harmless no-op while keeping all other double-acks
        // fail-closed.
        if (interaction.__questshopProgressAcknowledged
          && current === ACKNOWLEDGEMENT.REPLY && method === ACKNOWLEDGEMENT.DEFER_REPLY) return null;
        throw new QuestshopError('INTERACTION_ALREADY_ACKNOWLEDGED', 'Interaction ถูกตอบรับแล้ว');
      }
      const normalized = normalizeInitialArguments(method, args);
      const result = await original(...normalized);
      interaction.__questshopAcknowledgement = method;
      onAcknowledged(method);
      return result;
    };
  }
  // Acknowledgement methods above intentionally do not notify `onMessage`:
  // defer methods do not create a component-bearing message yet.  Every
  // actual reply/edit/follow-up goes through this single transport boundary.
  for (const method of ['editReply', 'followUp']) installOutputBoundary(interaction, method, onMessage);
}

export async function acknowledgeByContract(interaction, response) {
  if (response === 'UPDATE') return interaction.deferUpdate();
  if (response === 'REPLY') {
    if (parseCustomId(interaction.customId)?.route === 'token_submit') {
      interaction.__questshopProgressAcknowledged = true;
      return interaction.reply({
        content: 'กำลังตรวจบัญชีและค้นหา Quest ที่ยังใช้งานได้…',
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  return null;
}

export function ephemeralResponse(payload = {}) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}
