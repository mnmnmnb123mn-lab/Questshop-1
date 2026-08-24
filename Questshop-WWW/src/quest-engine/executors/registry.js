import { defineQuestExecutor } from './contract.js';
import { desktopExecutor } from './desktop.js';
import { videoExecutor } from './video.js';

const unsupportedEvents = new Set([
  'STREAM_ON_DESKTOP', 'ACHIEVEMENT_IN_GAME', 'ACHIEVEMENT_IN_ACTIVITY',
  'PLAY_ACTIVITY', 'PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION', 'progress',
]);

const unsupportedExecutor = defineQuestExecutor({
  id: 'unsupported', supportsAutomaticProgress: false, mutation: null,
  matches: (quest) => unsupportedEvents.has(typeof quest === 'string' ? quest : quest?.eventName)
    || quest?.autoSupported === false,
  validate: () => ({ ok: false, issues: ['UNSUPPORTED_EVENT'] }),
  estimateDuration: () => null,
  execute: () => { throw new Error('Unsupported Quest cannot execute'); },
  verify: () => false,
  describeUnsupportedReason: (quest) => quest?.compatibilityIssues?.[0]?.code ?? 'UNSUPPORTED_EVENT',
});

const unknownExecutor = defineQuestExecutor({
  id: 'unknown', supportsAutomaticProgress: false, mutation: null,
  matches: () => false,
  validate: () => ({ ok: false, issues: ['UNKNOWN_EVENT'] }),
  estimateDuration: () => null,
  execute: () => { throw new Error('Unknown Quest cannot execute'); },
  verify: () => false,
  describeUnsupportedReason: () => 'UNKNOWN_EVENT',
});

export const QUEST_EXECUTORS = Object.freeze([videoExecutor, desktopExecutor, unsupportedExecutor]);

export function selectQuestExecutor(value) {
  const quest = typeof value === 'string' ? { eventName: value } : value;
  if (quest?.autoSupported === false) return unsupportedExecutor;
  return QUEST_EXECUTORS.find((executor) => executor.matches(quest)) ?? unknownExecutor;
}

export function listExecutorCapabilities() {
  return QUEST_EXECUTORS.map(({ id, supportsAutomaticProgress, mutation }) => ({
    id, supportsAutomaticProgress, mutation,
  }));
}

