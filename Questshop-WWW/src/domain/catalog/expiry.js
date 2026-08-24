const SAFETY_BUFFER_MS = 30 * 60 * 1000;
const STATIC_OVERHEAD_MS = 5 * 60 * 1000;

export async function runtimeEstimateMs(client, quest) {
  const samples = await client.query(`
    SELECT count(*)::integer AS count,
      percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::bigint AS p95
    FROM runtime_samples
    WHERE task_type = $1 AND successful = true
      AND created_at >= clock_timestamp() - interval '30 days'
  `, [quest.task_type]);
  if (samples.rows[0].count >= 20) return Number(samples.rows[0].p95);
  const remainingSeconds = Math.max(
    0,
    Number(quest.task_target ?? 0) * (1 - Number(quest.progress_actual ?? 0) / 100),
  );
  return remainingSeconds * 1000 + STATIC_OVERHEAD_MS;
}

export async function estimatedQueueWaitMs(client, runnerConcurrency = 2) {
  const result = await client.query(`
    SELECT COALESCE(sum(
      GREATEST(0, COALESCE(q.task_target, 0) * (1 - i.progress_actual / 100)) * 1000
      + $1
    ), 0)::bigint AS queued_ms
    FROM runner_jobs j
    JOIN order_items i ON i.id = j.order_item_id
    JOIN quests q ON q.quest_id = i.quest_id
    WHERE j.state IN ('QUEUED', 'LEASED', 'RUNNING', 'WAITING_RATE_LIMIT', 'WAITING_RETRY')
  `, [STATIC_OVERHEAD_MS]);
  return Math.ceil(Number(result.rows[0].queued_ms) / Math.max(1, runnerConcurrency));
}

export async function evaluateExpiryAdmission(client, {
  quest,
  runnerConcurrency = 2,
  now = null,
}) {
  const startsAt = Date.parse(quest.starts_at ?? quest.startsAt);
  const expiresAt = Date.parse(quest.expires_at ?? quest.expiresAt);
  const databaseNow = now ?? (await client.query(
    'SELECT clock_timestamp() AS value',
  )).rows[0].value;
  const current = Date.parse(databaseNow);
  // New catalog/checkout admission requires starts_at. Older prelaunch jobs
  // may legitimately lack it, so do not strand an already-reserved N-1 job.
  if (Number.isFinite(startsAt) && startsAt > current) {
    // remainingMs is always time remaining before expiry. Returning null here
    // lets generic consumers accidentally classify this as expired.
    return { eligible: false, reason: 'QUEST_NOT_STARTED',
      remainingMs: Number.isFinite(expiresAt) ? expiresAt - current : null,
      availableAt: new Date(startsAt).toISOString() };
  }
  if (!Number.isFinite(expiresAt)) return { eligible: false, reason: 'EXPIRY_MISSING' };
  const [runtimeMs, queueWaitMs] = await Promise.all([
    runtimeEstimateMs(client, quest),
    estimatedQueueWaitMs(client, runnerConcurrency),
  ]);
  const requiredMs = runtimeMs + queueWaitMs + SAFETY_BUFFER_MS;
  return {
    eligible: expiresAt - current > requiredMs,
    reason: expiresAt - current > requiredMs ? null : 'INSUFFICIENT_TIME',
    remainingMs: expiresAt - current,
    runtimeMs,
    queueWaitMs,
    requiredMs,
  };
}
