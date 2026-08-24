import { selectQuestExecutor } from '../executors/registry.js';
import { ENGINE_VERSION, EXECUTOR_VERSION, QUEST_CONTRACT_VERSION } from '../../config/versions.js';
import {
  assertQuestObject,
  questCompatibilityIssue,
  QuestCompatibilityError,
} from './compatibility.js';
import { questContractHash } from './contract.js';

const QUEST_CDN_BASE = 'https://cdn.discordapp.com/assets/quests';
const VIDEO_MEDIA_EXTENSION = /\.(?:mp4|webm|mov|m4v)(?:$|[?#])/i;

function taskEntries(taskConfig) {
  const tasks = taskConfig?.tasks;
  return tasks && typeof tasks === 'object' && !Array.isArray(tasks) ? Object.entries(tasks) : [];
}

function eventType(key, definition) {
  return definition?.event_name ?? definition?.type ?? key;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function readProgress(status, task, target) {
  const progress = status?.progress;
  if (progress && typeof progress === 'object' && !Array.isArray(progress)) {
    const value = progress[task.key] ?? progress[task.type];
    return finite(value?.value ?? value);
  }
  if (typeof progress === 'number' || typeof progress === 'string') {
    return (finite(progress) / 100) * target;
  }
  return finite(status?.stream_progress_seconds);
}

function chooseTask(entries, status, options) {
  const normalized = entries.map(([key, definition]) => ({
    key, definition, type: eventType(key, definition),
  }));
  const supported = normalized.filter((task) => selectQuestExecutor(task.type).supportsAutomaticProgress);
  const preferred = supported.find((task) => task.key === options.preferredProgressKey)
    ?? supported.find((task) => task.type === options.preferredEventName);
  if (preferred) return { task: preferred, entries: normalized };
  const progress = status?.progress;
  if (progress && typeof progress === 'object') {
    const matching = supported.find((task) => progress[task.key] != null || progress[task.type] != null);
    if (matching) return { task: matching, entries: normalized };
  }
  return {
    task: supported[0] ?? normalized[0] ?? {
      key: 'UNKNOWN_SCHEMA', type: 'UNKNOWN_SCHEMA', definition: { target: 0 },
    },
    entries: normalized,
  };
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function questRewards(config) {
  const configured = Array.isArray(config.rewards_config?.rewards) ? config.rewards_config.rewards : [];
  const claimed = Array.isArray(config.rewards) ? config.rewards : [];
  return configured.length ? configured : claimed;
}

function orbReward(config) {
  const rewards = questRewards(config);
  const typed = rewards.filter((reward) => Number(reward?.type) === 4)
    .map((reward) => nonNegativeInteger(reward?.orb_quantity)).filter((value) => value != null);
  const untyped = rewards.filter((reward) => reward?.type == null)
    .map((reward) => nonNegativeInteger(reward?.orb_quantity)).filter((value) => value != null);
  const values = typed.length ? typed : untyped;
  const fallback = nonNegativeInteger(config.reward?.orbs) ?? nonNegativeInteger(config.orb_quantity);
  if (!values.length) {
    return fallback == null
      ? { orbs: null, orbReward: null }
      : { orbs: fallback, orbReward: { mode: 'SINGLE', minOrbs: fallback, maxOrbs: fallback, values: [fallback] } };
  }

  const assignmentMethod = Number(config.rewards_config?.assignment_method);
  if (assignmentMethod === 1) {
    const total = values.reduce((sum, amount) => sum + amount, 0);
    return { orbs: total, orbReward: { mode: 'ALL', minOrbs: total, maxOrbs: total, values } };
  }

  const unique = [...new Set(values)].sort((left, right) => left - right);
  const minOrbs = unique[0];
  const maxOrbs = unique[unique.length - 1];
  if (assignmentMethod === 2) {
    return {
      orbs: unique.length === 1 ? minOrbs : null,
      orbReward: { mode: 'TIERED', minOrbs, maxOrbs, values: unique },
    };
  }
  return {
    orbs: unique.length === 1 ? minOrbs : null,
    orbReward: { mode: unique.length === 1 ? 'SINGLE' : 'MULTIPLE', minOrbs, maxOrbs, values: unique },
  };
}

function safeStaticHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || VIDEO_MEDIA_EXTENSION.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function questAssetUrl(id, value, theme = null) {
  const direct = safeStaticHttpsUrl(value);
  if (direct) return direct;
  if (typeof value !== 'string' || !value.trim() || VIDEO_MEDIA_EXTENSION.test(value)) return null;
  const assetName = value.trim().split('/').filter(Boolean).map(encodeURIComponent).join('/');
  if (!assetName) return null;
  const themed = theme ? `/${theme}` : '';
  return `${QUEST_CDN_BASE}/${encodeURIComponent(id)}${themed}/${assetName}`;
}

function applicationIcon(config) {
  const direct = safeStaticHttpsUrl(config.application?.icon_url);
  if (direct) return direct;
  const applicationId = config.application?.id;
  const icon = config.application?.icon;
  if (applicationId == null || typeof icon !== 'string' || !icon.trim()) return null;
  return `https://cdn.discordapp.com/app-icons/${encodeURIComponent(String(applicationId))}/${encodeURIComponent(icon.trim())}.png`;
}

function videoThumbnail(id, config, taskDefinition) {
  const taskAssets = taskDefinition?.assets ?? {};
  const legacyAssets = config.video_assets ?? config.videoAssets ?? {};
  const candidates = [
    taskAssets?.video?.thumbnail,
    taskAssets?.video_low_res?.thumbnail,
    taskAssets?.video_hls?.thumbnail,
    taskAssets?.thumbnail,
    legacyAssets?.video?.thumbnail,
    legacyAssets?.video_low_res?.thumbnail,
    legacyAssets?.video_hls?.thumbnail,
  ];
  return candidates.map((value) => questAssetUrl(id, value)).find(Boolean) ?? null;
}

function questMedia(id, config, taskDefinition) {
  const assets = config.assets ?? {};
  const rewardAsset = questRewards(config).map((reward) => reward?.asset).find(Boolean);
  const stillVideoThumbnail = videoThumbnail(id, config, taskDefinition);
  const heroCandidates = [
    questAssetUrl(id, assets.hero),
    questAssetUrl(id, assets.quest_bar_hero),
    stillVideoThumbnail,
    questAssetUrl(id, assets.game_tile),
  ].filter(Boolean);
  const artworkUrl = heroCandidates[0] ?? null;
  const thumbnailCandidates = [
    questAssetUrl(id, assets.game_tile),
    questAssetUrl(id, assets.logotype),
    questAssetUrl(id, assets.game_tile_dark, 'dark'),
    questAssetUrl(id, assets.game_tile_light, 'light'),
    questAssetUrl(id, assets.logotype_dark, 'dark'),
    questAssetUrl(id, assets.logotype_light, 'light'),
    applicationIcon(config),
    questAssetUrl(id, rewardAsset),
    stillVideoThumbnail,
  ].filter((url) => url && url !== artworkUrl);
  return { artworkUrl, thumbnailUrl: thumbnailCandidates[0] ?? null };
}

function questUrl(id, config) {
  const supplied = config.share_link ?? config.quest_url;
  if (typeof supplied === 'string') {
    try {
      const url = new URL(supplied);
      if (url.protocol === 'https:' && ['discord.com', 'www.discord.com'].includes(url.hostname)) {
        return url.toString();
      }
    } catch {
      // Use the deterministic Discord Quest URL below.
    }
  }
  return `https://discord.com/quests/${encodeURIComponent(id)}`;
}

function compatibilityIssues({ entries, target, taskConfig }) {
  const issues = [];
  if (!entries.length) issues.push(questCompatibilityIssue('TASK_DEFINITIONS_MISSING', 'Task definitions are missing'));
  if (target <= 0) issues.push(questCompatibilityIssue('TASK_TARGET_INVALID', 'Task target is invalid'));
  const joinOperator = taskConfig?.join_operator ?? 'or';
  if (joinOperator === 'and' && entries.length > 1) {
    issues.push(questCompatibilityIssue('MULTI_TASK_AND', 'Multi-task AND is unsupported'));
  }
  return { issues, joinOperator };
}

function normalizeProgress(status, task, target) {
  const progressSecs = readProgress(status, task, target);
  return {
    progressSecs,
    progress: target > 0 ? Math.min(100, (progressSecs / target) * 100) : 0,
  };
}

function questVersions(options) {
  return options.versions ?? {
    engineVersion: ENGINE_VERSION,
    executorVersion: EXECUTOR_VERSION,
    contractVersion: QUEST_CONTRACT_VERSION,
  };
}

export function normalizeQuest(raw, options = {}) {
  assertQuestObject(raw);
  const id = String(raw.id);
  const config = raw.config ?? {};
  const status = raw.user_status ?? {};
  const taskConfig = config.task_config_v2 ?? config.task_config;
  const configuredTasks = taskEntries(taskConfig);
  const { task, entries } = chooseTask(configuredTasks, status, options);
  const target = finite(task.definition?.target);
  const { issues, joinOperator } = compatibilityIssues({ entries, target, taskConfig });
  const { progress, progressSecs } = normalizeProgress(status, task, target);
  const executor = selectQuestExecutor({ eventName: task.type, autoSupported: issues.length === 0 });
  const startsAt = config.starts_at ?? null;
  const expiresAt = config.expires_at ?? null;
  const url = questUrl(id, config);
  const media = questMedia(id, config, task.definition);
  const reward = orbReward(config);
  const normalized = {
    id,
    name: config.messages?.quest_name ?? config.messages?.quest_title ?? id,
    applicationId: config.application?.id == null ? null : String(config.application.id),
    startsAt,
    expiresAt,
    eventName: task.type,
    progress,
    secondsNeeded: target,
    progressSecs,
    progressKey: task.key,
    autoSupported: issues.length === 0 && executor.supportsAutomaticProgress,
    executorId: executor.id,
    enrolledAt: status.enrolled_at ?? null,
    enrolled: Boolean(status.enrolled_at),
    completedAt: status.completed_at ?? null,
    completed: Boolean(status.completed_at),
    claimed: Boolean(status.claimed_at) || status.orb_quantity_claimed != null,
    orbs: reward.orbs,
    orbReward: reward.orbReward,
    artworkUrl: media.artworkUrl,
    thumbnailUrl: media.thumbnailUrl,
    url,
    schemaIssues: issues.map((issue) => issue.message),
    compatibilityIssues: issues,
    coreComplete: Boolean(id && task.type && target > 0 && startsAt && expiresAt && url),
    joinOperator,
  };
  const contract = questContractHash(normalized, questVersions(options));
  return { ...normalized, contractHash: contract.hash, contractCanonical: contract.canonical,
    contractComplete: contract.complete && issues.length === 0 && executor.supportsAutomaticProgress };
}

export function normalizeQuestPayload(payload, enrollmentBlockedUntil = null) {
  if (!Array.isArray(payload)) {
    throw new QuestCompatibilityError('Quest payload must be an array', {
      code: 'QUEST_PAYLOAD_NOT_ARRAY',
    });
  }
  return payload.map((quest) => ({ ...normalizeQuest(quest), enrollmentBlockedUntil }));
}
