# Security Policy

Questshop handles Discord credentials, Quest account tokens, TrueMoney voucher information, Wallet credit,
PostgreSQL credentials, receiver information and encryption/HMAC key material. Treat the repository as financially
and credential-sensitive even while it remains pre-launch.

> [!IMPORTANT]
> Source/test evidence is not a live-security certificate. Current status remains **implemented-but-unverified** until
> the live checklist passes on one exact Git SHA.

## Supported versions

| Version | Security support |
|---|---|
| `[Unreleased]` / development `0.1.x` | Maintained while the Owner actively maintains this repository |
| Older snapshots/forks/unpinned deployments | No support guarantee |

## Reporting a vulnerability

Use GitHub Private Vulnerability Reporting / Security Advisory when available, otherwise contact the Owner privately.
Do not publish real secrets, exploit details, provider credentials or customer data in Issues, PRs, screenshots or
Discord channels.

A useful report contains the affected Git SHA, smallest safe reproduction, expected/actual result, affected route or
worker, non-secret IDs/support code and whether an external mutation may have occurred.

## Data that must not be disclosed

Never commit/log/paste:

- Discord Bot token or Discord user token;
- cookie, session, OAuth, interaction or webhook token;
- `DATABASE_POOL_URL`, `DATABASE_DIRECT_URL`, database password or TLS private material;
- `STATUS_TOKEN`, Data encryption keyring, Voucher HMAC keyring or raw key JSON;
- S3 access/secret keys, decrypted dumps or decrypted receiver values;
- raw TrueMoney provider payloads containing PII/credentials.

If a secret leaks, rotate/revoke it at the provider first. Deleting a file from the latest commit does not remove it
from Git history, logs, artifacts or backups.

## Owner-accepted Payment Log exposure

The Owner deliberately removed runtime human-visibility/privacy checks for backoffice surfaces. `LOG_PAYMENTS` may
render a **full voucher link**. This is an accepted Owner-managed exposure risk, not an automated protection.
The exception is narrow: the full voucher link belongs only in the Payment Log projection and must not spread into
customer responses, generic Admin UI, logs or other projections.

## Quest Auto media and storefront integrity

The persistent `QUEST_AUTO` storefront uses one fixed bundled GIF:

```text
src/discord/assets/quest-auto-demo.gif
Size     9,190,692 bytes
SHA-256  c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1
```

Before upload, runtime checks the exact byte length, GIF signature and SHA-256 digest. A mismatch fails the media load
rather than silently sending a different file.

The GIF is attached to the Discord message so the Rich Embed can reference `attachment://quest-auto-demo.gif`; the
intended customer presentation is the animated image **inside the embed**, not a standalone MP4/video block. Quest Auto
also removes the visible `Questshop Surface • QUEST_AUTO` technical footer. Durable recovery prefers the stable message
nonce and retains legacy footer lookup only to migrate older anchors.

Discord-side reconciliation requires the expected GIF attachment filename and an embed image. If the Owner intentionally
replaces the GIF bytes in a future release, version/change the filename or provide an explicit attachment migration so
a previously uploaded Discord attachment cannot be mistaken for the new source asset.

`QUEST_AUTO` price text is derived from active supported `TYPE` rules; incomplete configuration renders a not-ready
message rather than guessing a customer price. Surface reconciliation repairs stale presentation on the existing
anchor; this presentation repair does not mutate Wallet, Ledger, Order or payment state.

## Security invariants

### Money and payment

- Money is integer satang; floating point is forbidden for authoritative amounts.
- Financial transactions use PostgreSQL `SERIALIZABLE`, row locks, bounded whole-transaction retry and idempotency.
- Wallet cannot become negative. Reserved balance changes only through Reserve/Capture/Release.
- Ledger/Admin audit/release evidence are append-only; corrections use compensating entries.
- `REDEEMED` and `CREDITED` are separate and recovery credits exactly once.
- Ambiguous payment is Manual Review; a possibly-sent request is never blind-retried.
- Invalid provider schema/receiver/currency/amount fails closed without credit.
- Financial/Audit DLQ may be replayed but cannot be discarded.

### Credentials and cryptography

- Customer token lifecycle: receive → validate → encrypt → scoped use → delete after terminal work.
- Monitor credentials remain encrypted and have no Admin plaintext-read route.
- AES-256-GCM uses random nonce, versioned keyrings and context-specific AAD.
- Voucher identity uses versioned HMAC + uniqueness constraints.
- Setup creates persistent Status/Data/Voucher secrets once; restart/redeploy never silently replaces them.
- Central logger redaction must be used for structured fields, strings and serialized errors.

### PostgreSQL and deployment

- Production DB URLs require `sslmode=verify-full`; explicit CA uses `rejectUnauthorized: true`.
- `questshop_migrator` and `questshop_runtime` are separate roles.
- Runtime has no schema DDL and no effective `UPDATE/DELETE` on protected append-only tables.
- Deployment synchronization fails closed on effective privilege violations.
- Runtime validates read-only; it does not repair role membership or schema grants.

### Discord, workers and external mutations

- Ephemeral is not authorization; side effects reauthorize actor/guild/channel/message and durable state.
- Component IDs are opaque/versioned and server-session bound.
- Allowed mentions deny-by-default.
- External calls never execute inside a DB transaction.
- Each external mutation has durable intent/checkpoint and fresh post-send verification.
- Worker commits require lease owner, fencing token and state version; stale owners stop.
- Runtime permission-drift auto-repair is intentionally absent; Discord 403 creates/preserves an incident for manual
  Owner repair.

## Secure deployment practice

- inwcloud runs Node 22.x; all secrets stay in Environment Variables/secret storage.
- `DATABASE_POOL_URL` is Runtime; `DATABASE_DIRECT_URL` is separate Migrator.
- Set `GIT_SHA` to the exact full 40-character source revision.
- Use `BACKUP_MODE=AIVEN_MANAGED` for the current Aiven path unless a fully provisioned Local S3 design is intentional.
- Current command: `npm ci --omit=dev && npm run deploy && npm start`.
- Do not use the old `/tmp/aiven-ca.pem` / `NODE_EXTRA_CA_CERTS` workaround.
- A successful `Questshop ready` proves startup readiness only, not live TrueMoney/Quest success.

## Priority review areas

Report immediately if you find:

- secret/token/database URL/full voucher link outside the accepted Payment Log path;
- forged/stale session authorization or Admin bypass;
- negative Wallet, duplicate credit, double Capture/Release or editable audit evidence;
- post-send blind retry or voucher replay/HMAC bypass;
- queue/lease/fencing/restart-recovery bypass;
- SQL injection, migration checksum bypass, Runtime DDL or TLS disablement;
- unsafe Discord mention/URL rendering or duplicate persistent surfaces;
- `QUEST_AUTO` media integrity bypass, incorrect customer price presentation, GIF embed loss, visible legacy footer or
  stale-media replacement failure;
- `/statusz` authorization bypass or sensitive operational leakage.

## Known and accepted risks

- Discord user-token/self-bot behavior can violate Discord terms and affect accounts.
- Direct TrueMoney integration has no guaranteed provider contract.
- Buyer ownership of a submitted Quest account is intentionally not checked.
- Customer-discovered Quest can be considered for that account before Monitor general-sale approval.
- No separate staging environment; pre-launch uses the production Guild/database with `PRELAUNCH=true`.
- Aiven-managed backup/recovery is a provider boundary; Questshop does not claim a local restore drill in this mode.
- Owner-selected `LOG_PAYMENTS` visibility can expose full voucher links because automated viewer checks are absent.

## Incident response

```text
Detect → Contain → Preserve evidence → Recover → Verify → Reopen → Post-incident review
```

Preserve Ledger/attempt/lease/fencing/provider evidence, use incident-specific recovery, never hide mismatches by
editing historical money records, and record exact Git SHA plus correlation IDs without raw secrets.
See `docs/runbooks/README.md` for incident-specific actions.
