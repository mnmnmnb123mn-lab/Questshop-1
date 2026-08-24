import test from 'node:test';
import assert from 'node:assert/strict';
import { progressBucket, RUNNER_JOB_TRANSITIONS } from '../../src/domain/runner/states.js';

test('progress is coalesced to required buckets', () => {
  assert.deepEqual([0, 24.9, 25, 47.3, 75, 99.9].map((value) => progressBucket(value)), [0, 0, 25, 25, 75, 75]);
  assert.equal(progressBucket(1, true), 100);
});

test('runner terminal states have no transitions', () => {
  assert.deepEqual(RUNNER_JOB_TRANSITIONS.COMPLETED, []);
  assert.deepEqual(RUNNER_JOB_TRANSITIONS.FAILED, []);
});

test('rate-limit recovery is explicit for leased and running jobs', () => {
  assert.ok(RUNNER_JOB_TRANSITIONS.LEASED.includes('WAITING_RATE_LIMIT'));
  assert.ok(RUNNER_JOB_TRANSITIONS.RUNNING.includes('WAITING_RATE_LIMIT'));
  assert.ok(RUNNER_JOB_TRANSITIONS.WAITING_RATE_LIMIT.includes('QUEUED'));
});

test('queued runner jobs can be moved to manual review without bypassing the graph', () => {
  assert.ok(RUNNER_JOB_TRANSITIONS.QUEUED.includes('MANUAL_REVIEW'));
});
