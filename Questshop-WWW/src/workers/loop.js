import { setTimeout as delay } from 'node:timers/promises';

export async function runWorkerLoop({ name, signal, idleMs = 500, health, logger, runOnce,
  onIteration = async () => {}, heartbeatMs = 15_000 }) {
  const now = () => new Date().toISOString();
  health.workers[name] = {
    state: 'STARTING', startedAt: now(), lastHeartbeatAt: now(), lastCompletedAt: null,
    inFlight: false, inFlightSince: null, failures: 0,
  };
  while (!signal.aborted) {
    const started = performance.now();
    health.workers[name] = {
      ...health.workers[name], state: 'RUNNING', inFlight: true, inFlightSince: now(), lastHeartbeatAt: now(),
    };
    const heartbeat = setInterval(() => {
      if (!health.workers[name]) return;
      health.workers[name] = { ...health.workers[name], lastHeartbeatAt: now() };
    }, heartbeatMs);
    heartbeat.unref?.();
    try {
      const worked = await runOnce();
      health.workers[name] = {
        ...health.workers[name], state: 'RUNNING', inFlight: false, inFlightSince: null,
        lastHeartbeatAt: now(), lastCompletedAt: now(),
      };
      if (worked) await onIteration({ name, worked, durationMs: Math.round(performance.now() - started) })
        .catch(() => {});
      if (!worked) await delay(idleMs, undefined, { signal, ref: false });
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') break;
      health.workers[name] = {
        ...health.workers[name], failures: health.workers[name].failures + 1, state: 'DEGRADED',
        inFlight: false, inFlightSince: null, lastHeartbeatAt: now(), lastCompletedAt: now(),
      };
      logger.error({ error, worker: name }, 'worker iteration failed');
      await onIteration({ name, error, durationMs: Math.round(performance.now() - started) }).catch(() => {});
      await delay(Math.min(5_000, 250 * (2 ** Math.min(4, health.workers[name].failures))), undefined, { signal, ref: false }).catch(() => {});
    } finally {
      clearInterval(heartbeat);
    }
  }
  health.workers[name] = { ...health.workers[name], state: 'STOPPED', inFlight: false, inFlightSince: null };
}
