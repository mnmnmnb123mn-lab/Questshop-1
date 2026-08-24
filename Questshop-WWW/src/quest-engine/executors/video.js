import { defineQuestExecutor } from './contract.js';

const EVENTS = new Set(['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']);
const STEP_SECONDS = 10;

export function nextVideoTimestamp(current, target, enrolledAtMs, now = Date.now()) {
  const allowance = Number.isFinite(enrolledAtMs)
    ? Math.floor((now - enrolledAtMs) / 1000) + STEP_SECONDS
    : current + 1;
  return Math.min(target, current + STEP_SECONDS, allowance);
}

async function waitForAllowedTimestamp(context, current, target, enrolledAtMs, allowanceWaits) {
  const timestamp = nextVideoTimestamp(current, target, enrolledAtMs, context.now());
  if (timestamp > current) return { timestamp, allowanceWaits: 0 };
  const waits = allowanceWaits + 1;
  if (waits >= 120) throw new Error('video timestamp allowance exceeded 2 minutes');
  await context.sleep(1000, context.signal);
  return { timestamp: null, allowanceWaits: waits };
}

async function sendAndRefreshProgress(context, fresh, timestamp) {
  await context.mutate('VIDEO_PROGRESS', { timestamp }, () => (
    context.api.sendVideoProgress(fresh.id, timestamp, context.signal)
  ));
  await context.sleep(1000, context.signal);
  const updated = await context.fetchFreshQuest(fresh.id, context.signal);
  await context.onServerProgress(updated);
  return updated;
}

async function execute(context) {
  let fresh = context.quest;
  let current = Number(fresh.progressSecs ?? 0);
  const target = Number(fresh.secondsNeeded);
  const enrolledAtMs = Date.parse(fresh.enrolledAt);
  let unchanged = 0;
  let allowanceWaits = 0;
  while (!fresh.completed && current < target) {
    if (context.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const allowed = await waitForAllowedTimestamp(context, current, target, enrolledAtMs, allowanceWaits);
    allowanceWaits = allowed.allowanceWaits;
    if (allowed.timestamp == null) continue;
    fresh = await sendAndRefreshProgress(context, fresh, allowed.timestamp);
    unchanged = fresh.progressSecs > current || fresh.completed ? 0 : unchanged + 1;
    if (unchanged >= 8) throw new Error('Discord did not confirm video progress after 8 checks');
    current = Math.max(current, Number(fresh.progressSecs ?? 0));
    if (!fresh.completed && current < target) await context.sleep(9000, context.signal);
  }
  return fresh;
}

export const videoExecutor = defineQuestExecutor({
  id: 'video',
  supportsAutomaticProgress: true,
  mutation: 'VIDEO_PROGRESS',
  matches: (quest) => EVENTS.has(typeof quest === 'string' ? quest : quest?.eventName),
  validate(quest) {
    const issues = [];
    if (!quest?.id) issues.push('missing id');
    if (Number(quest?.secondsNeeded) <= 0) issues.push('invalid target');
    return { ok: issues.length === 0, issues };
  },
  estimateDuration(quest) {
    return Math.max(0, Number(quest?.secondsNeeded ?? 0) - Number(quest?.progressSecs ?? 0)) * 1000;
  },
  execute,
  verify: (_context, result) => Boolean(result?.completed),
  describeUnsupportedReason: () => null,
});
