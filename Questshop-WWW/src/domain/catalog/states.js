export const ANALYSIS_TRANSITIONS = Object.freeze({
  DETECTED: ['METADATA_RETRY', 'ANALYZED'],
  METADATA_RETRY: ['ANALYZED', 'MANUAL_REVIEW'],
  ANALYZED: ['SUPPORTED', 'UNSUPPORTED', 'MANUAL_REVIEW'],
  UNSUPPORTED: ['SUPPORTED', 'EXPIRED'],
  MANUAL_REVIEW: ['METADATA_RETRY', 'SUPPORTED', 'UNSUPPORTED', 'EXPIRED'],
  SUPPORTED: ['EXPIRED'],
  EXPIRED: [],
});

export const SALE_TRANSITIONS = Object.freeze({
  CLOSED: ['OPEN', 'PAUSED', 'EXPIRED'],
  OPEN: ['PAUSED', 'EXPIRED'],
  PAUSED: ['OPEN', 'EXPIRED'],
  EXPIRED: [],
});

export const TEST_TRANSITIONS = Object.freeze({
  TEST_QUEUED: ['TESTING', 'TEST_FAILED'],
  // A test that has not performed a Quest mutation may be deferred until its
  // start window / expiry admission is safe.  It is intentionally distinct
  // from retrying a failed mutation.
  TESTING: ['TEST_QUEUED', 'TEST_PASSED', 'TEST_FAILED', 'MANUAL_REVIEW'],
  TEST_PASSED: ['RETEST_REQUIRED'],
  TEST_FAILED: ['RETEST_REQUIRED', 'TEST_QUEUED'],
  MANUAL_REVIEW: ['TEST_QUEUED'],
  RETEST_REQUIRED: ['TEST_QUEUED'],
});
