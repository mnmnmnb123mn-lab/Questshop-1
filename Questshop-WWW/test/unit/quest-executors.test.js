import test from 'node:test';
import assert from 'node:assert/strict';
import { executeQuestExecutor } from '../../src/quest-engine/executors/contract.js';
import { desktopExecutor } from '../../src/quest-engine/executors/desktop.js';
import { videoExecutor } from '../../src/quest-engine/executors/video.js';
import { selectQuestExecutor } from '../../src/quest-engine/executors/registry.js';

function verifiedMutator(calls) {
  return async (kind, payload, perform) => {
    calls.push({ kind, payload });
    await perform();
  };
}

test('video executor follows the proven 10-second progression contract and verifies completion', async () => {
  const mutationCalls = [];
  const providerCalls = [];
  const progress = [
    { progressSecs: 10, completed: false },
    { progressSecs: 20, completed: false },
    { progressSecs: 25, completed: true, completedAt: '2026-01-01T00:00:25.000Z' },
  ];
  const quest = { id: 'video-quest', eventName: 'WATCH_VIDEO', secondsNeeded: 25,
    progressSecs: 0, enrolledAt: '2026-01-01T00:00:00.000Z', completed: false };
  const result = await executeQuestExecutor(videoExecutor, {
    quest,
    signal: new AbortController().signal,
    mutate: verifiedMutator(mutationCalls),
    api: { sendVideoProgress: async (id, timestamp) => providerCalls.push({ id, timestamp }) },
    fetchFreshQuest: async () => ({ ...quest, ...progress.shift() }),
    onServerProgress: async () => {},
    sleep: async () => {},
    now: () => Date.parse('2026-01-01T00:02:00.000Z'),
  });
  assert.equal(result.verified, true);
  assert.equal(result.executionResult.completed, true);
  assert.deepEqual(mutationCalls.map((call) => call.kind),
    ['VIDEO_PROGRESS', 'VIDEO_PROGRESS', 'VIDEO_PROGRESS']);
  assert.deepEqual(providerCalls.map((call) => call.timestamp), [10, 20, 25]);
});

test('video executor fails closed after eight fresh reads show no progress', async () => {
  const quest = { id: 'stalled-video', eventName: 'WATCH_VIDEO_ON_MOBILE', secondsNeeded: 60,
    progressSecs: 0, enrolledAt: '2026-01-01T00:00:00.000Z', completed: false };
  await assert.rejects(executeQuestExecutor(videoExecutor, {
    quest,
    signal: new AbortController().signal,
    mutate: verifiedMutator([]),
    api: { sendVideoProgress: async () => {} },
    fetchFreshQuest: async () => ({ ...quest }),
    onServerProgress: async () => {},
    sleep: async () => {},
    now: () => Date.parse('2026-01-01T00:02:00.000Z'),
  }), /did not confirm video progress after 8 checks/);
});

test('desktop executor falls back to application payload and verifies fresh completion', async () => {
  const mutationCalls = [];
  const heartbeatCalls = [];
  const quest = { id: 'desktop-quest', eventName: 'PLAY_ON_DESKTOP_V2', applicationId: 'app-1',
    secondsNeeded: 60, progressSecs: 0, completed: false };
  const progress = [
    { progressSecs: 0, completed: false },
    { progressSecs: 30, completed: false },
    { progressSecs: 60, completed: true, completedAt: '2026-01-01T00:01:00.000Z' },
  ];
  const result = await executeQuestExecutor(desktopExecutor, {
    quest,
    signal: new AbortController().signal,
    mutate: verifiedMutator(mutationCalls),
    api: { sendHeartbeat: async (_quest, terminal, useApplicationPayload) => {
      heartbeatCalls.push({ terminal, useApplicationPayload });
    } },
    fetchFreshQuest: async () => ({ ...quest, ...progress.shift() }),
    onServerProgress: async () => {},
    sleep: async () => {},
  });
  assert.equal(result.verified, true);
  assert.deepEqual(mutationCalls.map((call) => call.kind), ['HEARTBEAT', 'HEARTBEAT', 'HEARTBEAT']);
  assert.deepEqual(heartbeatCalls, [
    { terminal: false, useApplicationPayload: false },
    { terminal: false, useApplicationPayload: true },
    { terminal: false, useApplicationPayload: true },
  ]);
});

test('desktop executor sends a terminal heartbeat when target progress exists but completion is not confirmed', async () => {
  const heartbeatCalls = [];
  const quest = { id: 'desktop-terminal', eventName: 'PLAY_ON_DESKTOP', applicationId: 'app-2',
    secondsNeeded: 60, progressSecs: 60, completed: false };
  const result = await executeQuestExecutor(desktopExecutor, {
    quest,
    signal: new AbortController().signal,
    mutate: verifiedMutator([]),
    api: { sendHeartbeat: async (_quest, terminal, useApplicationPayload) => {
      heartbeatCalls.push({ terminal, useApplicationPayload });
    } },
    fetchFreshQuest: async () => ({ ...quest, completed: true,
      completedAt: '2026-01-01T00:01:00.000Z' }),
    onServerProgress: async () => {},
    sleep: async () => {},
  });
  assert.equal(result.verified, true);
  assert.deepEqual(heartbeatCalls, [{ terminal: true, useApplicationPayload: false }]);
});

test('executor registry admits only the four proven event names', () => {
  assert.equal(selectQuestExecutor('WATCH_VIDEO').id, 'video');
  assert.equal(selectQuestExecutor('WATCH_VIDEO_ON_MOBILE').id, 'video');
  assert.equal(selectQuestExecutor('PLAY_ON_DESKTOP').id, 'desktop');
  assert.equal(selectQuestExecutor('PLAY_ON_DESKTOP_V2').id, 'desktop');
  assert.equal(selectQuestExecutor('WATCH_VIDEO_V2').supportsAutomaticProgress, false);
  assert.equal(selectQuestExecutor('PLAY_ON_DESKTOP_V3').supportsAutomaticProgress, false);
});
