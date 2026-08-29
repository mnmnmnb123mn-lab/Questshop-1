import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSqliteDatabase, closeSqliteDatabase } from '../src/db/sqlite.js';
import { migrateSqlite } from '../src/db/sqlite-migrations.js';
import { appendWalletTransaction } from '../src/domain/sqlite/wallet.js';

const directory = await mkdtemp(path.join(tmpdir(), 'questshop-loadtest-'));
const databasePath = path.join(directory, 'questshop.db');
const secret = 'load-test-secret-key-which-is-at-least-32-characters';
const started = performance.now();
let db;
try {
  db = await openSqliteDatabase({ databasePath, secret });
  await migrateSqlite({ db, directory: path.resolve('migrations/sqlite'), secret, backup: async () => {} });
  for (let index = 0; index < 500; index += 1) {
    appendWalletTransaction(db, { discordUserId: `load-user-${index}`, transactionType: 'TOPUP', availableDeltaCents: 10_000,
      referenceType: 'LOAD_TEST', referenceId: String(index), idempotencyKey: `load:${index}`, traceId: randomUUID() });
  }
  const wallets = db.prepare('SELECT count(*) AS count FROM wallets WHERE available_cents=10000 AND reserved_cents=0').get().count;
  if (Number(wallets) !== 500) throw new Error('SQLite load-test wallet invariant failed');
  console.log(JSON.stringify({ ok: true, wallets, elapsedMs: Math.round(performance.now() - started) }));
} finally {
  closeSqliteDatabase(db);
  await rm(directory, { recursive: true, force: true });
}
