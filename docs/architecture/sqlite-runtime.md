# SQLite runtime contract

Questshop runs exactly one Node.js 22.22 process against `/data/questshop.db` using `node:sqlite`.

- SQLite uses `foreign_keys=ON`, WAL, `synchronous=FULL`, `secure_delete=ON` and a 5-second busy timeout.
- Database directories are `0700`; the database is `0600`; Runtime uses an exclusive `.runtime.lock` file.
- Migrations create a verified online backup, run inside `BEGIN IMMEDIATE`, verify required tables, then set `user_version`.
- `wallet_transactions` and `admin_audit` are append-only. Top-up/Order state and Wallet mutation commit together.
- Jobs/Notifications persist restart recovery. External Discord, TrueMoney and Quest calls happen outside SQLite transactions.
- Keep 7 daily and 3 pre-migration backups. Restore only while Runtime is stopped, discard stale WAL/SHM files and run full integrity checks first.

The implementation is source-complete only after automated checks. It remains **implemented-but-unverified** until
the same Git SHA passes persistent-volume, restart, restore and live-provider UAT.
