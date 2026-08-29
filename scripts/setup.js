import { randomBytes } from 'node:crypto';

// Setup is non-destructive. It prints a template and never overwrites an
// Owner-managed secret or database.
const secret = randomBytes(32).toString('base64url');
console.log([
  '# Questshop SQLite configuration',
  'SQLITE_PATH=/data/questshop.db',
  `QUESTSHOP_SECRET_KEY=${secret}`,
  'GIT_SHA=<40-character-git-sha>',
  'PRELAUNCH=true',
].join('\n'));
