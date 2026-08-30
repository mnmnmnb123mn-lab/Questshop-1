# Completion audit

Current status: **migration-in-progress**.

The SQLite core has automated source evidence, but the migration is not a
candidate build until every Discord/Admin workflow listed in the migration
plan is implemented and tested. Source evidence must then be regenerated on
the candidate commit:

- Node 22.22 syntax/lint;
- SQLite migration, transaction, backup and restore tests without skips;
- coverage at least 70% for lines, branches and functions;
- load test, dependency audit, Docker build and diff check.

Live evidence remains required: persistent `/data`, single-instance restart, redeploy, backup restore, Discord commands
and embeds on desktop/mobile, DM-disabled retry, real low-value TrueMoney handling and monitored Quest workflow.
Do not describe source-only results as production ready.

Current implementation note: financial ambiguity, verified Quest settlement, idempotent review resolution, SQLite Admin
sessions, nonce-based notification recovery with desired-version fencing, 404-only surface replacement, announcement
metadata and SQLite operations scripts have source/test changes in the worktree. Candidate-commit Node 22 evidence,
load/audit/Docker checks and same-SHA UAT remain release blockers.

Recent source work also persists external payment outcomes before settlement, fences Admin promotion/Monitor edits by
aggregate version, limits customer mutations in SQLite, and removes confirmed-unreachable PostgreSQL runtime paths.
These are source/test controls only; they do not constitute live-provider or production evidence.
