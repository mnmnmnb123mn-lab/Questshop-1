import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvironmentText } from '../src/config/setup-environment.js';

const output = process.env.QUESTSHOP_SECRET_BUNDLE_FILE;
if (!output) throw new Error('Set QUESTSHOP_SECRET_BUNDLE_FILE to an owner-only destination path');
const scope = process.env.QUESTSHOP_SECRET_BUNDLE_SCOPE ?? 'runtime';
if (!['runtime', 'deployment'].includes(scope)) {
  throw new Error('QUESTSHOP_SECRET_BUNDLE_SCOPE must be runtime or deployment');
}
const source = fileURLToPath(new URL('../.env', import.meta.url));
const values = parseEnvironmentText(await readFile(source, 'utf8'));
delete values.QUESTSHOP_SECRET_BUNDLE;
if (scope === 'runtime') {
  delete values.DATABASE_DIRECT_URL;
  delete values.DATABASE_RESTORE_URL;
}
const encoded = Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
const target = path.resolve(output);
const temporary = `${target}.${process.pid}.tmp`;
try {
  await writeFile(temporary, encoded + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, target);
  await chmod(target, 0o600);
} catch (error) {
  await unlink(temporary).catch(() => null);
  throw error;
}
console.log(JSON.stringify({ ok: true, path: target, permission: '0600', scope }));
