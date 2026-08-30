# Questshop runbook

## Normal deploy

Run `npm ci --omit=dev && npm run deploy && npm start` with `/data` mounted persistently. A Production deployment needs
an exact `GIT_SHA` and a permanent `QUESTSHOP_SECRET_KEY`.

## Backup and restore

Run `npm run backup` for a verified SQLite online backup. Keep the bot stopped before a restore. Set
`QUESTSHOP_RESTORE_ACKNOWLEDGE=true` and `SQLITE_RESTORE_SOURCE` to a verified backup, run `npm run restore:drill`,
then start the bot only after integrity and foreign-key checks pass.

Never remove the runtime lock file while another bot process may still be running.

## Candidate closeout

Run `npm run setup:preflight`, `npm run check:imports`, `npm run verify:keys` and
`CONFIRM_PRELAUNCH_CLOSEOUT=I_UNDERSTAND_COMPENSATING_TRANSACTIONS npm run prelaunch:closeout` only with the Runtime
stopped whenever the operation touches the production SQLite file. These scripts take the same single-instance lock;
do not bypass a lock error. A passing local/source check is **implemented-but-unverified** at most until the exact
40-character `GIT_SHA` completes every row in `docs/uat/prelaunch.md`.
