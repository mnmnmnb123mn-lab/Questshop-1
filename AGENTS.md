# AGENTS.md — Questshop engineering contract

This contract applies from the repository root downward unless a nearer `AGENTS.md` overrides it.
Current explicit Owner instructions take precedence, except an agent must surface conflicts with money integrity,
credential safety, destructive scope or live-production authority before acting.

## 1. Evidence and authority

Questshop is a one-Guild Discord storefront for automated Discord Quest progress using Node.js 22,
`discord.js` and SQLite through Node.js `node:sqlite`.

Keep these evidence levels separate:

1. source implementation and tests;
2. GitHub/static-analysis checks;
3. deployment health on an exact Git SHA;
4. Discord, TrueMoney, Quest Engine and Owner UAT in the live environment.

Until every applicable item in `docs/uat/prelaunch.md` passes on one exact SHA, the strongest completion label is
**implemented-but-unverified**. Never claim production-ready, live-provider success, deployment success, restore
success or command-registration success without direct evidence.

Do not deploy, alter inwcloud/Aiven/Discord live settings, register live commands, enable live gates, mutate real money
or Quest data, merge a PR, force-push, delete a branch or rewrite published history unless the Owner explicitly asks.

Primary references:

1. current explicit Owner instructions;
2. `docs/architecture/completion-audit.md`;
3. `docs/architecture/traceability.md` and `docs/architecture/definition-of-done.md`;
4. `docs/state-machines/contracts.md` and domain `states.js`;
5. `README.md`, `SECURITY.md` and runbooks.

## 2. Owner product decisions

- One production Discord Guild, all-in-one runtime, one persistent SQLite database at `/data/questshop.db`; no Redis/ORM/web dashboard/multi-Guild in v1.
- Node.js `>=22.22.0 <23`, JavaScript ESM, `discord.js` and `node:sqlite` remain the runtime contract.
- Money uses integer satang only. Wallet credit never expires and cannot be withdrawn/transferred.
- Confirm reserves per Item; verified success captures; definite failure releases; ambiguity remains Reserved for Manual Review.
- Ledger, Admin audit and release evidence are append-only; corrections are compensating transactions.
- **No Automatic Claim**. Completed work ends at `READY_TO_CLAIM` with a URL button.
- Customer Token ownership is intentionally not checked. One Quest Account ID has no more than one active job globally.
- Customer credentials are session/order scoped and never become Monitor credentials.
- Monitor accounts always Scan + Test. Monitor-discovered Quest stays private until one test passes or audited Admin **ส่งเลย**.
- Customer-discovered Quest may be admitted for that authenticated Quest account; public `quest-new` must not identify the customer.
- `quest-new` shows no Quest ID, test state or internal sale state.
- Final Order DM has one **รับรางวัลทั้งหมด** link to the first successful Quest and one history link.
- Owner manages backoffice privacy. Runtime does **not** perform human-visibility/privacy preflight or permission-drift auto-repair.
- `LOG_PAYMENTS` may contain the full TrueMoney voucher link by Owner policy.
- Bot Administrator is validated at startup; Admin access is re-evaluated from current Discord `Administrator` permission on every interaction.

### Quest Auto storefront decision

`QUEST_AUTO` is one durable Discord message with:

- fixed title **Discord Quest Auto**;
- Owner-approved Thai copy mentioning Discord Orbs and Discord Token;
- buttons **เริ่มทำเควส** and **เติมเงิน**;
- dynamic active price summary derived from all four supported `TYPE` rules;
- one exact bundled Owner-approved GIF at `src/discord/assets/quest-auto-demo.gif` rendered **inside the embed** via `attachment://quest-auto-demo.gif`;
- one Owner-approved animated GIF at `src/discord/assets/quest-auto-thumbnail.gif` rendered as the embed thumbnail;
- no customer-visible `Questshop Surface • QUEST_AUTO` technical footer.

Price presentation:

- equal supported prices → one value, e.g. `5 บาท`;
- differing prices → min-max range, e.g. `5-7 บาท`;
- incomplete supported price configuration → `ค่าบริการยังไม่พร้อม`.

Media source contract:

```text
Filename quest-auto-demo.gif
Size     9,190,692 bytes
SHA-256  c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1

Filename quest-auto-thumbnail.gif
Size     822,513 bytes
SHA-256  2d1e0e2c09138ac53384ac6272f4c8a9eedff28e2fe227ee06e26f7ef37a6542
```

The runtime verifies each asset's size, signature and SHA-256 before upload. Both are attached to the message only so the
embed can reference the animated GIF as its upper-right thumbnail and the demo GIF as its lower image; the demo GIF must not be presented as
a separate MP4/video block above the storefront. Surface reconciliation edits/recovers the same durable message when
price text, title/description, expected attachments, embed image/thumbnail or the legacy visible technical footer drifts.
Quest Auto recovery uses the stable surface nonce first and retains the old footer lookup only as a migration fallback.

The current Maintenance cadence is approximately 60 seconds, so Admin price changes are automatic eventual storefront
updates, not a synchronous same-click guarantee. Do not reintroduce the standalone MP4 storefront layout or invent a
generic video subsystem.

When intentionally changing the bundled GIF in a future release, version/change the expected filename or add an
explicit attachment migration so Discord cannot keep an older remote attachment under the same filename.

## 3. Architecture and state ownership

- Discord handlers validate untrusted input, acknowledge exactly once, reauthorize at each side effect and call a domain service.
- Domain services own transactions, state transitions, idempotency, audit and outbox writes.
- Every aggregate transition uses its transition map, `state_version`, compare-and-swap and correlation evidence.
- Financial operations use short SQLite `BEGIN IMMEDIATE` transactions with idempotency; one process owns the database.
- Never hold a database transaction over Discord, TrueMoney, Quest API, S3 or other external I/O.
- External mutations require durable intent/checkpoint before send and fresh verification afterward.
- Jobs and Notifications use a durable lease token/version and restart recovery; stale deliveries cannot overwrite a newer desired version.
- UTC epoch milliseconds govern money-adjacent timestamps, deadlines and retention.
- Background Discord messages use Outbox/DLQ except durable surface maintenance paths already defined by the project.
- Persistent components use opaque versioned IDs plus server-side actor/guild/channel/message/operation/expiry checks.

## 4. Database and migrations

- Never edit an applied migration; the current SQLite `0001` remains a Draft until its first deployment.
- Production uses `SQLITE_PATH=/data/questshop.db`, WAL, `synchronous=FULL`, `foreign_keys=ON`, a `0600` database file and a `0700` directory.
- Every migration creates and verifies an online backup, then uses `BEGIN IMMEDIATE → schema verification → user_version → COMMIT`.
- Runtime has no `UPDATE/DELETE` on protected append-only tables; SQLite triggers enforce this.
- Never destroy/recreate a non-disposable SQLite database. Load tests use a temporary directory only.

## 5. Credentials and money safety

- Reserved balance changes only through Reserve/Capture/Release paths.
- Voucher identity uses versioned HMAC and unique constraints.
- `REDEEMED` and `CREDITED` are distinct and recovery must credit exactly once.
- Provider/schema/receiver/amount/currency uncertainty fails closed without credit.
- After a request may have been sent, verify or use Manual Review; never blind retry.
- Never print, log, fixture, commit or paste Bot/User token, cookie, session, voucher secret/link, DB URL/password,
  S3 secret, raw keyring or decrypted receiver value.
- The narrow exception is the Owner-approved full voucher link in the `LOG_PAYMENTS` projection only.
- Setup-generated persistent secrets must never be silently regenerated on restart/redeploy.

## 6. Discord UX

- Customer Token, Wallet, selection, quote, top-up and errors are Ephemeral.
- Use Thai customer copy; do not expose raw domain enums.
- History edits only on meaningful state/progress/claim-URL changes.
- One announcement/history/surface owns one message and edits/reconciles it instead of spamming.
- Allowed mentions deny-by-default.
- Setup is Owner-only; rerunning setup updates/moves the durable anchor and must not create active duplicates.

## 7. Development and documentation workflow

Before editing, read relevant source/tests/docs and preserve unrelated work. Never stage secrets, dumps, backups,
ZIPs or user-owned files.

Minimum source checks:

```bash
npm run check
npm run lint
npm test
git diff --check
```

Risk-appropriate release evidence additionally needs:

```bash
npm run test:coverage
npm run load:test
npm audit --audit-level=high
docker build ...
```

When behavior/configuration/security/operations change, keep `[Unreleased]` in `CHANGELOG.md` plus `README.md`,
`SECURITY.md`, runbooks, traceability, UAT and deployment docs synchronized. Documentation must distinguish source/test
evidence from live evidence and Owner-accepted risk from enforced controls.

## 8. Git/publication

- Do not force-push, reset, delete branches or rewrite history without explicit scoped approval.
- Commit only intended files.
- Bind deployment/UAT evidence to the exact 40-character `GIT_SHA`.
