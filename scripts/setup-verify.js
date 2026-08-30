import '../src/config/load-local-environment.js';
import { access, constants, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvironment } from '../src/config/env.js';
import { verifyConfiguredSourceSha } from '../src/config/source-version.js';

const env = loadEnvironment();
const source = verifyConfiguredSourceSha(env);
const directory = path.dirname(env.SQLITE_PATH);
await mkdir(directory, { recursive: true, mode: 0o700 });
await access(directory, constants.R_OK | constants.W_OK);
if (env.NODE_ENV === 'production' && !env.SQLITE_PATH.startsWith('/data/')) {
  throw new Error('Production SQLITE_PATH must be under /data');
}
console.log(JSON.stringify({ ok: true, nodeEnv: env.NODE_ENV, guildIdConfigured: Boolean(env.DISCORD_GUILD_ID),
  sqlitePath: env.SQLITE_PATH, dataDirectoryWritable: true, sourceSha: source.sourceSha,
  sourceShaVerified: source.verified, secretConfigured: true }));
