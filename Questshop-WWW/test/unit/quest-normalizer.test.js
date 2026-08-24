import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuest } from '../../src/quest-engine/schema/normalizer.js';
import { selectQuestExecutor } from '../../src/quest-engine/executors/registry.js';

function payload(task) {
  return {
    id: 'quest-normalizer',
    config: {
      starts_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-12-31T00:00:00.000Z',
      application: { id: 'app-normalizer' }, messages: { quest_name: 'Normalizer Quest' },
      task_config_v2: { tasks: { opaque_key: task } },
    },
    user_status: { enrolled_at: '2026-01-01T00:00:00.000Z', progress: { opaque_key: { value: 20 } } },
  };
}

test('normalizer reads an opaque task key through its declared event_name', () => {
  const quest = normalizeQuest(payload({ event_name: 'WATCH_VIDEO_ON_MOBILE', target: '60' }));
  assert.equal(quest.eventName, 'WATCH_VIDEO_ON_MOBILE');
  assert.equal(quest.executorId, 'video');
  assert.equal(quest.progressSecs, 20);
  assert.equal(quest.autoSupported, true);
  assert.match(quest.contractHash, /^[a-f0-9]{64}$/);
  assert.equal(quest.contractComplete, true);
});

test('normalizer reads Discord Orbs from virtual-currency reward objects', () => {
  const raw = payload({ event_name: 'WATCH_VIDEO', target: 60 });
  raw.config.rewards_config = {
    assignment_method: 1,
    rewards: [
      { type: 4, orb_quantity: 750 },
      { type: 5, quantity: 3 },
    ],
  };
  const quest = normalizeQuest(raw);
  assert.equal(quest.orbs, 750);
  assert.deepEqual(quest.orbReward, {
    mode: 'ALL', minOrbs: 750, maxOrbs: 750, values: [750],
  });
});

test('normalizer preserves tiered Discord Orbs as a range instead of inventing one exact reward', () => {
  const raw = payload({ event_name: 'WATCH_VIDEO', target: 60 });
  raw.config.rewards_config = {
    assignment_method: 2,
    rewards: [
      { type: 4, orb_quantity: 250 },
      { type: 4, orb_quantity: 750 },
    ],
  };
  const quest = normalizeQuest(raw);
  assert.equal(quest.orbs, null);
  assert.deepEqual(quest.orbReward, {
    mode: 'TIERED', minOrbs: 250, maxOrbs: 750, values: [250, 750],
  });
});

test('normalizer never mistakes non-Orb reward quantity for Discord Orbs', () => {
  const raw = payload({ event_name: 'WATCH_VIDEO', target: 60 });
  raw.config.rewards_config = { assignment_method: 1, rewards: [{ type: 5, quantity: 7 }] };
  const quest = normalizeQuest(raw);
  assert.equal(quest.orbs, null);
  assert.equal(quest.orbReward, null);
});

test('normalizer resolves Quest CDN images and ignores video assets for announcement media', () => {
  const raw = payload({ event_name: 'PLAY_ON_DESKTOP', target: 900 });
  raw.config.assets = {
    hero: 'hero.jpg',
    hero_video: 'hero.mp4',
    quest_bar_hero: 'questbar.jpg',
    game_tile: 'gametile.png',
    logotype: 'wordmark.png',
  };
  const quest = normalizeQuest(raw);
  assert.equal(quest.artworkUrl,
    'https://cdn.discordapp.com/assets/quests/quest-normalizer/hero.jpg');
  assert.equal(quest.thumbnailUrl,
    'https://cdn.discordapp.com/assets/quests/quest-normalizer/gametile.png');
  assert.doesNotMatch(quest.artworkUrl, /\.mp4/);
  assert.doesNotMatch(quest.thumbnailUrl, /\.mp4/);
});

test('normalizer reads the still thumbnail from the selected task assets without embedding video', () => {
  const raw = payload({
    event_name: 'WATCH_VIDEO', target: 60,
    assets: {
      video: {
        url: 'https://cdn.discordapp.com/assets/quests/quest-normalizer/video.mp4',
        thumbnail: 'https://cdn.discordapp.com/assets/quests/quest-normalizer/video-thumb.jpg',
      },
    },
  });
  const quest = normalizeQuest(raw);
  assert.equal(quest.artworkUrl,
    'https://cdn.discordapp.com/assets/quests/quest-normalizer/video-thumb.jpg');
  assert.equal(quest.thumbnailUrl, null);
  assert.doesNotMatch(quest.artworkUrl, /\.mp4/);
});

test('normalizer keeps legacy top-level video thumbnail compatibility as a fallback', () => {
  const raw = payload({ event_name: 'WATCH_VIDEO', target: 60 });
  raw.config.video_assets = {
    video: { thumbnail: 'https://cdn.discordapp.com/assets/quests/quest-normalizer/legacy-thumb.jpg' },
  };
  const quest = normalizeQuest(raw);
  assert.equal(quest.artworkUrl,
    'https://cdn.discordapp.com/assets/quests/quest-normalizer/legacy-thumb.jpg');
});

test('contract fingerprint changes when the executable progress contract changes', () => {
  const base = normalizeQuest(payload({ event_name: 'WATCH_VIDEO', target: 60 }));
  const changed = normalizeQuest(payload({ event_name: 'WATCH_VIDEO', target: 90 }));
  assert.notEqual(base.contractHash, changed.contractHash);
  assert.notDeepEqual(base.contractCanonical, changed.contractCanonical);
});

test('executor contract accepts only proven event names and rejects guessed variants', () => {
  assert.equal(selectQuestExecutor('WATCH_VIDEO').id, 'video');
  assert.equal(selectQuestExecutor('PLAY_ON_DESKTOP_V2').id, 'desktop');
  assert.equal(selectQuestExecutor('WATCH_VIDEO_V2').supportsAutomaticProgress, false);
  assert.equal(selectQuestExecutor('PLAY_ON_DESKTOP_V3').supportsAutomaticProgress, false);
});

test('normalizer refuses multi-task AND instead of guessing a partial Quest contract', () => {
  const raw = payload({ event_name: 'WATCH_VIDEO', target: 60 });
  raw.config.task_config_v2 = {
    join_operator: 'and',
    tasks: {
      video: { event_name: 'WATCH_VIDEO', target: 60 },
      desktop: { event_name: 'PLAY_ON_DESKTOP', target: 60 },
    },
  };
  const quest = normalizeQuest(raw);
  assert.equal(quest.autoSupported, false);
  assert.equal(quest.compatibilityIssues[0].code, 'MULTI_TASK_AND');
});
