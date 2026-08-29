import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

async function filesUnder(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(path);
  }
  return files;
}

function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit', env: process.env,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`test process terminated by ${signal}`));
      else if (code !== 0) reject(new Error(`test process exited with code ${code}`));
      else resolveRun();
    });
  });
}

const coverage = process.argv.includes('--coverage');
const roots = process.argv.slice(2).filter((argument) => argument !== '--coverage').map((root) => resolve(root));
const selectedRoots = roots.length ? roots : [resolve('test')];
// `npm test` is the full source suite.  Selecting only the new SQLite tests
// hid broken imports in the rest of the repository during the migration.
const defaultRoots = [resolve('test')];
const files = (await Promise.all((roots.length ? selectedRoots : defaultRoots).map(filesUnder))).flat().sort();
if (!files.length) throw new Error('No test files found');
if (coverage) {
  await mkdir(resolve('coverage'), { recursive: true });
  // Reporter destinations are paired in declaration order by Node.
  await run(['--test', '--test-concurrency=1', '--experimental-test-coverage',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=lcov', '--test-reporter-destination=coverage/lcov.info', ...files]);
} else {
  for (const file of files) await run(['--test', '--test-concurrency=1', file]);
}
