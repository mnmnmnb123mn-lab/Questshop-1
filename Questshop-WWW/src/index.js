import './config/load-runtime-environment.js';
import { closeHealthServer, createHealthState, startHealthServer } from './bootstrap/health-server.js';

let runtime;
let stopping;
let shutdownModule;
const startupAbort = new AbortController();
const health = createHealthState();
const requestedPort = /^\d+$/.test(process.env.PORT ?? '') ? Number(process.env.PORT) : 3000;
const port = requestedPort >= 1 && requestedPort <= 65535 ? requestedPort : 3000;
let server;
const stop = async (signal, options = {}) => {
  if (!runtime) {
    // Startup checks the signal between every durable phase and will perform
    // the same cleanup path as any other startup failure.
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
  server = await startHealthServer({ port, statusToken: process.env.STATUS_TOKEN ?? 'unconfigured', state: health });
  const { startup } = await import('./bootstrap/startup.js');
  runtime = await startup({ health, server,
    onRuntimePrepared: (prepared) => { runtime = prepared; },
    onRuntimeLeaseLost: (error) => stop('RUNTIME_LEASE_LOST', { leaseLost: true, error }),
    signal: startupAbort.signal });
} catch (error) {
  health.status = 'NOT_READY';
  health.lastError = error;
  health.live = false;
  await closeHealthServer(server).catch(() => null);
  process.exitCode = 1;
}
