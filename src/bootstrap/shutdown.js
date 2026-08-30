import { closeHealthServer } from './health-server.js';
import { closeSqliteDatabase } from '../db/sqlite.js';

export async function shutdown(runtime, reason = 'shutdown') {
  if (runtime.shutdownPromise) return runtime.shutdownPromise;
  runtime.shutdownPromise = (async () => {
    runtime.acceptingInteractions = false;
    runtime.health.ready = false;
    runtime.health.status = 'NOT_READY';
    runtime.abortController.abort(reason);
    await runtime.workers?.stop?.();
    await runtime.client?.destroy?.();
    closeSqliteDatabase(runtime.db);
    await runtime.instanceLock?.release?.();
    runtime.health.live = false;
    await closeHealthServer(runtime.server);
  })();
  return runtime.shutdownPromise;
}
