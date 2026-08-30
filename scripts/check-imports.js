import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(target);
    return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
  }));
  return nested.flat();
}

const candidates = (await Promise.all(['src', 'scripts', 'test'].map((root) => files(root)))).flat();
const missing = [];
for (const file of candidates) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    try { await access(path.resolve(path.dirname(file), specifier)); } catch { missing.push(`${file} -> ${specifier}`); }
  }
}
if (missing.length) throw new Error(`Unresolved relative imports:\n${missing.join('\n')}`);
console.log(JSON.stringify({ ok: true, checked: candidates.length }));
