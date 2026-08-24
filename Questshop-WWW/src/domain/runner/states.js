export const RUNNER_JOB_TRANSITIONS = Object.freeze({
  QUEUED: ['LEASED', 'FAILED', 'MANUAL_REVIEW'],
  LEASED: ['RUNNING', 'QUEUED', 'WAITING_RATE_LIMIT', 'FAILED', 'MANUAL_REVIEW'],
  RUNNING: ['WAITING_RATE_LIMIT', 'WAITING_RETRY', 'VERIFYING', 'FAILED', 'MANUAL_REVIEW'],
  WAITING_RATE_LIMIT: ['QUEUED', 'RUNNING', 'FAILED', 'MANUAL_REVIEW'],
  WAITING_RETRY: ['QUEUED', 'RUNNING', 'FAILED', 'MANUAL_REVIEW'],
  VERIFYING: ['SETTLING', 'WAITING_RETRY', 'FAILED', 'MANUAL_REVIEW'],
  SETTLING: ['COMPLETED', 'FAILED', 'MANUAL_REVIEW'],
  MANUAL_REVIEW: ['QUEUED', 'SETTLING', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
});

export function progressBucket(actual, completed = false) {
  if (completed) return 100;
  const bounded = Math.max(0, Math.min(99.999, Number(actual) || 0));
  return Math.floor(bounded / 25) * 25;
}
