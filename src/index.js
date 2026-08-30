import './config/load-runtime-environment.js';
import { closeHealthServer, createHealthState, startHealthServer } from './bootstrap/health-server.js';

/** Start the production runtime. Exporting this boundary keeps importing the
 * entrypoint side-effect free for source verification; normal `npm start`
 * still invokes it immediately below. */
export async function runApplication({ environment = process.env } = {}) {
  let runtime;
  let stopping;
  let shutdownModule;
  const startupAbort = new AbortController();
  const health = createHealthState();
  const requestedPort = /^\d+$/.test(environment.PORT ?? '') ? Number(environment.PORT) : 3000;
  const port = requestedPort >= 1 && requestedPort <= 65535 ? requestedPort : 3000;
  let server;
  const stop = async (signal, options = {}) => {
    if (!runtime) {
      startupAbort.abort(signal);
      health.ready = false;
      health.status = 'NOT_READY';
      return;
    }
    if (options.leaseLost) process.exitCode = 1;
    stopping ??= (async () => {
      shutdownModule ??= await import('./bootstrap/shutdown.js');
      await shutdownModule.shutdown(runtime, signal, options);
    })().catch(() => { process.exitCode = 1; });
    await stopping;
    if (options.leaseLost) process.exit(1);
  };
  process.once('SIGTERM', () => { void stop('SIGTERM'); });
  process.once('SIGINT', () => { void stop('SIGINT'); });
  try {
    server = await startHealthServer({ port, statusToken: environment.STATUS_TOKEN ?? 'unconfigured', state: health });
    const { startup } = await import('./bootstrap/startup.js');
    runtime = await startup({ health, server,
      onRuntimePrepared: (prepared) => { runtime = prepared; },
      onRuntimeLeaseLost: (error) => stop('RUNTIME_LEASE_LOST', { leaseLost: true, error }),
      signal: startupAbort.signal });
    return { runtime, health, stop };
  } catch (error) {
    health.status = 'NOT_READY';
    health.lastError = error;
    health.live = false;
    await closeHealthServer(server).catch(() => null);
    process.exitCode = 1;
    return { runtime: null, health, stop, error };
  }
}

if (process.env.QUESTSHOP_DISABLE_AUTOSTART !== 'true') await runApplication();
