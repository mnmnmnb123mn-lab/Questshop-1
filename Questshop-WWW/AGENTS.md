# AGENTS.md — Questshop engineering contract

This contract applies from the repository root downward unless a nearer `AGENTS.md` overrides it.
Current explicit Owner instructions take precedence, except an agent must surface conflicts with money integrity,
credential safety, destructive scope or live-production authority before acting.

## 1. Evidence and authority

Questshop is a one-Guild Discord storefront for automated Discord Quest progress using Node.js 22,
`discord.js`, `pg` and PostgreSQL 16+.

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

- One production Discord Guild, all-in-one runtime, PostgreSQL 16+ durable state; no Redis/ORM/web dashboard/multi-Guild in v1.
- Node.js `>=22.22.0 <23`, JavaScript ESM, `discord.js` and `pg` remain the runtime contract.
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

- fixed title **Discord Quest • Auto**;
- Owner-approved Thai copy mentioning Discord Orbs and Discord Token;
- buttons **เริ่มทำเควส** and **เติมเงิน**;
- dynamic active price summary derived from all four supported `TYPE` rules;
- one exact bundled Owner-approved GIF at `src/discord/assets/quest-auto-demo.gif` rendered **inside the embed** via `attachment://quest-auto-demo.gif`;
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
```

The runtime verifies size, GIF signature and SHA-256 before upload. The GIF is attached to the message only so the embed
can reference it; it must not be presented as a separate MP4/video block above the storefront. Surface reconciliation
edits/recovers the same durable message when price text, title/description, expected GIF attachment, embed image or the
legacy visible technical footer drifts. Quest Auto recovery uses the stable surface nonce first and retains the old
footer lookup only as a migration fallback for older messages.

The current Maintenance cadence is approximately 60 seconds, so Admin price changes are automatic eventual storefront
updates, not a synchronous same-click guarantee. Do not reintroduce the standalone MP4 storefront layout or invent a
generic video subsystem.

When intentionally changing the bundled GIF in a future release, version/change the expected filename or add an
explicit attachment migration so Discord cannot keep an older remote attachment under the same filename.

## 3. Architecture and state ownership

- Discord handlers validate untrusted input, acknowledge exactly once, reauthorize at each side effect and call a domain service.
- Domain services own transactions, state transitions, idempotency, audit and outbox writes.
- Every aggregate transition uses its transition map, `state_version`, compare-and-swap and correlation evidence.
- Financial operations use PostgreSQL `SERIALIZABLE` with bounded whole-transaction retry.
- Never hold a database transaction over Discord, TrueMoney, Quest API, S3 or other external I/O.
- External mutations require durable intent/checkpoint before send and fresh verification afterward.
- Worker commits require lease owner, fencing token and state version; lost ownership stops the stale worker.
- PostgreSQL time governs money, lease, expiry, deadlines and retention.
- Background Discord messages use Outbox/DLQ except durable surface maintenance paths already defined by the project.
- Persistent components use opaque versioned IDs plus server-side actor/guild/channel/message/operation/expiry checks.

## 4. Database and migrations

- Never edit an applied migration; add the next zero-padded migration.
- Production URLs require `sslmode=verify-full`.
- `DATABASE_DIRECT_URL` = `questshop_migrator` during deploy; `DATABASE_POOL_URL` = `questshop_runtime` during runtime.
- Aiven/Admin owns role creation, membership, `CONNECT` and schema grants.
- Runtime has no DDL and no `UPDATE/DELETE` on protected append-only tables.
- Object privilege synchronization runs after every migration loop, including `applied: 0`.
- Never destroy/recreate a non-disposable database. Load tests require a database name containing `questshop_loadtest`.

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
TEST_DATABASE_URL=<disposable-postgresql-16-url> QUESTSHOP_ALLOW_TEST_DATABASE_RESET=true npm test
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
