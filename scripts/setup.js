import { readFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import {
  completeSetupValues,
  parseEnvironmentText,
  writeEnvironmentFile,
} from '../src/config/setup-environment.js';

const target = new URL('../.env', import.meta.url);

async function readExistingEnvironment() {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function createPrompter() {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) stdout.write(chunk, encoding);
      callback();
    },
  });
  const readline = createInterface({ input: stdin, output, terminal: true });
  return {
    async ask(label, { secret = false } = {}) {
      if (!stdin.isTTY) {
        throw new Error('Missing ' + label
          + '; run npm run setup in an interactive terminal or provide it as an environment variable');
      }
      if (!secret) return (await readline.question(label + ': ')).trim();
      stdout.write(label + ': ');
      muted = true;
      try {
        return (await readline.question('')).trim();
      } finally {
        muted = false;
        stdout.write('\n');
      }
    },
    close() {
      readline.close();
    },
  };
}

const prompts = Object.freeze({
  DISCORD_BOT_TOKEN: ['Discord Bot Token', true],
  DISCORD_CLIENT_ID: ['Discord Application ID', false],
  DISCORD_GUILD_ID: ['Discord Server ID', false],
  OWNER_ID: ['Discord User ID ของเจ้าของร้าน', false],
  DATABASE_POOL_URL: ['PostgreSQL Runtime/Pooled URL', true],
  DATABASE_DIRECT_URL: ['PostgreSQL Migration/Direct URL', true],
  DATABASE_SSL_CA_BASE64: ['PostgreSQL CA: พาธไฟล์ .pem หรือ Base64', false],
});

async function collectMissing(original, prompter) {
  const fileValues = parseEnvironmentText(original);
  let result = await completeSetupValues({ fileValues });
  for (const key of result.missing) {
    const [label, secret] = prompts[key];
    fileValues[key] = await prompter.ask(label, { secret });
  }
  result = await completeSetupValues({ fileValues });
  return result;
}

const prompter = createPrompter();
try {
  const original = await readExistingEnvironment();
  const result = await collectMissing(original, prompter);
  if (result.missing.length) throw new Error('Setup is missing: ' + result.missing.join(', '));
  const written = await writeEnvironmentFile(target, original, result.generated);
  const backupState = result.validated.BACKUP_MODE === 'AIVEN_MANAGED'
    ? 'Aiven ดูแลอัตโนมัติ (ไม่มี pg_dump/S3 ใน inwcloud)'
    : 'สำรองด้วย S3 ภายใน Questshop';
  stdout.write([
    '',
    'Questshop setup สำเร็จ',
    'ไฟล์: ' + written.path,
    'สิทธิ์ไฟล์: 0600',
    'Secret: สร้าง/เก็บถาวรแล้ว และจะไม่สร้างทับเมื่อรัน setup ซ้ำ',
    'Backup: ' + backupState,
    '',
    'ขั้นต่อไป: npm run migrate && npm run register && npm start',
    '',
  ].join('\n'));
} finally {
  prompter.close();
}
