import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(entryPath);
  }
  return files;
}

test('every runtime source module can resolve without starting the application', async () => {
  process.env.QUESTSHOP_DISABLE_AUTOSTART = 'true';
  const files = await sourceFiles(resolve('src'));
  for (const file of files.sort()) await import(pathToFileURL(file).href);
  assert.equal(files.length, 77);
  assert.ok(files.every((file) => relative(process.cwd(), file).startsWith('src/')));
});
