import { defineQuestExecutor } from './contract.js';

const EVENTS = new Set(['PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2']);

async function execute(context) {
  let fresh = context.quest;
  let current = Number(fresh.progressSecs ?? 0);
  const target = Number(fresh.secondsNeeded);
  let unchanged = 0;
  let useApplicationPayload = false;
  while (!fresh.completed && current < target) {
    if (context.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await context.mutate('HEARTBEAT', {
      terminal: false,
      applicationId: fresh.applicationId,
      useApplicationPayload,
    }, () => context.api.sendHeartbeat(fresh, false, useApplicationPayload, context.signal));
    await context.sleep(1000, context.signal);
    fresh = await context.fetchFreshQuest(fresh.id, context.signal);
    await context.onServerProgress(fresh);
    if (fresh.progressSecs > current || fresh.completed) unchanged = 0;
    else {
      unchanged += 1;
      useApplicationPayload ||= Boolean(fresh.applicationId);
    }
    if (unchanged >= 5) throw new Error('Discord did not confirm desktop progress after 5 heartbeats');
    current = Math.max(current, Number(fresh.progressSecs ?? 0));
    if (!fresh.completed && current < target) await context.sleep(29_000, context.signal);
  }
  if (!fresh.completed) {
    await context.mutate('HEARTBEAT', { terminal: true }, () => (
      context.api.sendHeartbeat(fresh, true, useApplicationPayload, context.signal)
    ));
    await context.sleep(1000, context.signal);
    fresh = await context.fetchFreshQuest(fresh.id, context.signal);
  }
  return fresh;
}

export const desktopExecutor = defineQuestExecutor({
  id: 'desktop',
  supportsAutomaticProgress: true,
  mutation: 'HEARTBEAT',
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
