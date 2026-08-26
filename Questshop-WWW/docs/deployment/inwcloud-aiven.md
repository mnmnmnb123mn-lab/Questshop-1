# Deploy Questshop on inwcloud + Aiven PostgreSQL

This guide applies to the exact branch/commit selected for deployment. Passing deployment does not make the system
production-ready; live TrueMoney, Quest, Discord and Owner UAT still require evidence on the same deployed build.

## Requirements

- inwcloud project connected to the repository/branch
- Node.js 22.x LTS
- Aiven PostgreSQL 16+
- Discord bot in the target Guild with `Administrator`
- separate PostgreSQL roles:
  - `questshop_migrator`: `USAGE, CREATE` on `public`
  - `questshop_runtime`: `USAGE` on `public`, no `CREATE`

Aiven/Admin owns role creation, `CONNECT`, membership and schema grants. Questshop synchronizes only object privileges
owned by the effective Migrator after migration.

## 1. Select source

Select the intended branch/commit in inwcloud. `GIT_SHA` is no longer an Environment Variable that must be entered;
when Git metadata exists the runtime may show it for diagnostics, otherwise it uses the internal value `untracked`.

## 2. Runtime command

Configure inwcloud:

```text
Language: Node.js
Version: 22.x LTS
Run mode: Custom Command
Root Directory: Questshop-WWW
```

Use:

```bash
npm ci --omit=dev && npm run deploy && npm start
```

`npm run deploy` performs:

```text
setup:verify → migrate → register
```

Run migration every deploy even when `applied: 0`, because object privilege synchronization and validation still run.
Do not run this command from the repository root: its `package.json` is inside `Questshop-WWW`.

## 3. Environment Variables

| Variable | Value / purpose |
|---|---|
| `NODE_ENV` | `production` |
| `DISCORD_BOT_TOKEN` | Bot secret |
| `DISCORD_CLIENT_ID` | Application ID |
| `DISCORD_GUILD_ID` | target Guild ID |
| `OWNER_ID` | Owner Discord user ID |
| `DATABASE_POOL_URL` | `questshop_runtime`, `sslmode=verify-full` |
| `DATABASE_DIRECT_URL` | `questshop_migrator`, `sslmode=verify-full` |
| `DATABASE_SSL_CA_BASE64` | Aiven CA PEM encoded as Base64 when required |
| `STATUS_TOKEN` | `/statusz` Bearer token, at least 32 chars |
| `DATA_ENCRYPTION_KEYS_JSON` | persistent Data keyring |
| `VOUCHER_HMAC_KEYS_JSON` | persistent Voucher HMAC keyring |
| `BACKUP_MODE` | `AIVEN_MANAGED` |
| `PRELAUNCH` | `true` during UAT |
| `TIMEZONE` | `Asia/Bangkok` |
| `RUNNER_CONCURRENCY` | default `2` |
| `RUNNER_CONCURRENCY_HARD_MAX` | max `5` |
| `PORT` | default `3000` |

Never put secret values in repository files, Custom Command, logs, screenshots or tickets.

## 4. Aiven TLS

Both database URLs keep `sslmode=verify-full`.
When the Aiven chain needs its private CA, store the complete PEM as Base64 in `DATABASE_SSL_CA_BASE64`.
Questshop decodes CA in-process and supplies it to `pg` with `rejectUnauthorized: true`.

Do **not** use the old workaround:

```bash
# do not add
export NODE_EXTRA_CA_CERTS=/tmp/aiven-ca.pem
```

Do not write a temporary CA file in the inwcloud startup command for the current source.

## 5. Quest Auto bundled media deployment

The repository must contain the exact source asset:

```text
src/discord/assets/quest-auto-demo.gif
Size     9,190,692 bytes
SHA-256  c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1

src/discord/assets/quest-auto-thumbnail.gif
Size     822,513 bytes
SHA-256  2d1e0e2c09138ac53384ac6272f4c8a9eedff28e2fe227ee06e26f7ef37a6542
```

No build-time conversion or Base64 reconstruction is used. Runtime reads both assets directly from `src`, verifies
size + signature + SHA-256 and attaches them when the persistent `QUEST_AUTO` message does not already contain the
expected asset pair.

The Rich Embed references `attachment://quest-auto-thumbnail.gif` as its animated upper-right thumbnail and
`attachment://quest-auto-demo.gif` as its lower image. The old standalone MP4/video block is not part of the layout.

If startup/runtime reports a bundled Quest Auto integrity failure, do not bypass the check. Confirm the deployed
checkout contains both exact Git-tracked assets and that inwcloud did not fetch an older revision.

The 9.19 MB asset is included by the normal `COPY src ./src` Docker/build/deploy source path; no extra media service is
required.

## 6. Quest Auto dynamic price and anchor behavior

The storefront price is read from active supported `TYPE` price rules:

- equal prices → one value such as `5 บาท`
- different GAME/VIDEO prices → range such as `5-7 บาท`
- incomplete supported pricing → `ค่าบริการยังไม่พร้อม`

The persistent message is edited automatically through surface reconciliation. The Maintenance worker currently runs
approximately every 60 seconds, so visible price/media healing is eventual within the maintenance cycle rather than an
instant same-click guarantee.

Quest Auto no longer renders the customer-visible `Questshop Surface • QUEST_AUTO` footer. Recovery uses the stable
surface nonce first; legacy footer lookup remains only to migrate older messages.

## 7. Health endpoints

| Path | Authorization | Expected |
|---|---|---|
| `/livez` | none | `200` while process is alive |
| `/readyz` | none | `200` when runtime is ready, otherwise `503` |
| `/statusz` | `Bearer STATUS_TOKEN` | bounded worker/gate/incident detail |

Map the inwcloud Domain to `PORT` if external health access is needed.

## 8. Expected deploy log order

```text
setup:verify
→ {"ok":true,...}

migrate
→ privilegeSynchronization: { status: 'PASS', ... }
→ preMigrationBackup: 'AIVEN_MANAGED'

register
→ Registered 8 guild commands

start
→ Questshop ready
```

`Questshop ready` confirms process/runtime readiness only; it does not prove TrueMoney or Quest execution.

## 9. Surface installation

After runtime is ready, Owner installs/moves the eight surfaces:

```text
/quest-auto
/quest-new
/quest-history
/admin-panel
/log-payments
/log-quest-operations
/log-admin
/log-system
```

Re-running setup updates/moves the durable surface instead of intentionally creating a second active panel.
`QUEST_AUTO` setup also heals missing/legacy media, old visible technical footer and current price text.

## 10. Common failures

| Error / symptom | Action |
|---|---|
| `DATABASE_DIRECT_URL ... undefined` | add the separate Migrator URL |
| `POSTGRES_RUNTIME_ROLE_CONTRACT_FAILED` | fix Aiven role/bootstrap grants; do not broaden Runtime permissions |
| Bot Administrator error | grant Discord `Administrator`, then restart |
| TLS/CA error | verify both URLs use `verify-full` and CA Base64 is complete |
| Quest Auto media integrity failure | verify exact `quest-auto-demo.gif` size/hash in deployed checkout |
| Quest Auto still shows old price | allow one Maintenance cycle; confirm active `TYPE` rules are complete and surface is ACTIVE |
| Quest Auto still shows standalone video | confirm the new GIF commit is deployed; rerun `/quest-auto` or restart/reconcile |
| Quest Auto still shows technical footer | allow reconciliation or rerun `/quest-auto`; stable nonce recovery does not require the footer |
| Discord 403 | Owner fixes channel permission manually; bot does not auto-repair overwrites |

## 11. Backup / rollback

`BACKUP_MODE=AIVEN_MANAGED` means Aiven owns backup/recovery. Questshop does not run `pg_dump`, `pg_restore` or S3
backup in this mode and does not claim a local restore drill.

Rollback:

- if schema remains compatible, select the prior app commit and deploy again;
- there are no automatic down migrations;
- if schema cannot support the older app, forward-fix instead of editing applied migrations;
- production DB recovery is an Aiven disaster-recovery action followed by Ledger/state reconciliation.

## 12. Owner responsibility for backoffice channels

Owner policy intentionally removes human-visibility/privacy preflight and runtime permission-drift auto-repair.
`LOG_PAYMENTS` may contain a full voucher link. Owner must configure channel viewers/roles correctly.
Discord 403 is recorded as an incident but bot does not change permission overwrites.

## 13. Post-deploy checklist

1. `/livez` and `/readyz` are healthy.
2. Source SHA evidence matches the intended commit when Git metadata is available.
3. Eight surfaces are installed.
4. `PRELAUNCH=true` during UAT.
5. `QUEST_AUTO` shows **Discord Quest Auto**, expected price text and `quest-auto-demo.gif` animated inside the embed,
   with no standalone MP4 block and no `Questshop Surface • QUEST_AUTO` footer.
6. Change one Admin Quest price and verify the **same message** refreshes within the Maintenance window.
7. Restart once and confirm no duplicate Quest Auto panel or duplicate media attachments.
8. Continue the full checklist in `docs/uat/prelaunch.md` on the same SHA.
