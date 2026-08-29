# Questshop runbook

## Normal deploy

Run `npm ci --omit=dev && npm run deploy && npm start` with `/data` mounted persistently. A Production deployment needs
an exact `GIT_SHA` and a permanent `QUESTSHOP_SECRET_KEY`.

## Backup and restore

Run `npm run backup` for a verified SQLite online backup. Keep the bot stopped before a restore. Set
`QUESTSHOP_RESTORE_ACKNOWLEDGE=true` and `SQLITE_RESTORE_SOURCE` to a verified backup, run `npm run restore:drill`,
then start the bot only after integrity and foreign-key checks pass.

Never remove the runtime lock file while another bot process may still be running.
