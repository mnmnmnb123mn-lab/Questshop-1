# Changelog

## Current migration status

- SQLite migration remains **migration-in-progress**. This source has not passed same-SHA live UAT and must not be described as production-ready.
- Money settlement fails closed through `SUCCESS`, `DEFINITE_FAILURE` and `AMBIGUOUS`: unknown TrueMoney outcomes create financial review; Quest capture requires verified completion; pre-completed and definite-failure Items release their reservation with append-only settlement evidence.
- Added server-side interaction sessions, SQLite Admin controls for gates/prices/receiver/promotions/Monitor/Wallet/reviews, stable nonce recovery with desired-version fencing, safe 404-only surface replacement, SQLite prelaunch closeout and relative-import verification.
- Provider outcomes are now persisted with their payment attempt before settlement; recovered `REDEEMED` payments credit only through the existing idempotent path.
- Promotion and Monitor updates use aggregate versions; bonus usage is persisted per customer and Bangkok day. Customer mutation limits also survive restart in SQLite.
- Removed unreachable PostgreSQL renderer, pricing, promotion, keyring and rate-limit paths rather than retaining a second persistence implementation.

- Added durable customer Quest discovery cases with automatic Monitor visibility checks before tests, one backoffice card per Quest, safe retry, and informational announcements decoupled from customer checkout.

These notes describe the current source worktree. There is no production release/tag evidence; only the `[Unreleased]`
section below is normative when its statements conflict with older migration notes.

## [Unreleased]

### SQLite migration (source-only)

- Replaced the runtime persistence contract with one Node `node:sqlite` database at `/data/questshop.db`.
  The new source uses WAL, `synchronous=FULL`, foreign keys, atomic migrations, owner-only file permissions,
  append-only wallet/admin audit tables, online backups and single-instance locking.
- Replaced PostgreSQL/Aiven workers, roles, TLS, S3 backup and Outbox dependencies with SQLite Jobs and Notifications.
  Customer Top-up acknowledgement, editable DM status, Payment Log and Quest History now use the SQLite projection path.
- This remains **migration-in-progress**. No live database, Discord, TrueMoney or Quest action was performed.

### Current operational baseline

- Runtime: Node.js `>=22.22.0 <23`, Discord single-Guild, SQLite at `/data/questshop.db`.
- inwcloud command: `npm ci --omit=dev && npm run deploy && npm start`.
- `LOG_PAYMENTS` may render a full voucher link by Owner policy. Backoffice human visibility is Owner-managed;
  runtime neither performs a privacy preflight nor changes Discord permissions.
- No Automatic Claim; successful Quest work ends at `READY_TO_CLAIM` with customer-side claim URL.
- After all required automated checks pass on one committed SHA, the release state is **implemented-but-unverified**
  until same-SHA live UAT passes.

### Added

- `LOG_QUEST_OPERATIONS`, `LOG_ADMIN` and `LOG_SYSTEM` now attach the verified shared
  `backoffice-log-banner.webp` beneath every event card. `LOG_SYSTEM` and system-authored Admin Audit cards use the
  verified animated Questshop GIF thumbnail; operational cards use safe Quest artwork or global Discord avatars.
- Durable `LOG_SYSTEM` incident stabilization: recurring code/scope pairs reopen and edit one message, operational
  alerts require consecutive evidence, and Discord connectivity failures are grouped across affected surfaces.
- Historical Outbox projection backlog repair with transition evidence. A deployment keeps any active lease, retains
  only the newest queued projection refresh and normalizes its version so an old backlog cannot hold `delivered_version` behind.
- Payment Logs now begin at `PAYMENT_QUEUED`, so a provider-worker delay remains visible and later outcomes update the
  same durable message rather than appearing as a separate record.
- Payment Logs render the payer's Discord profile as the upper-right thumbnail and attach the supplied
  `payment-log-banner.webp` as one verified lower embed image on every current-state update.
- Backoffice renderers now carry durable Trace/correlation context. Admin Audit before/after snapshots are allowlisted
  for Discord and recursively redact credential-shaped fields before append-only persistence.

- Customer-only top-up status DMs for `MANUAL_REVIEW` and an Owner's terminal `REJECTED` decision, so a delayed
  interaction does not leave the customer without a result.

- Persistent Quest Auto storefront copy with fixed title **Discord Quest Auto**, Discord Orbs / Discord Token guidance,
  and the existing **เริ่มทำเควส** / **เติมเงิน** controls.
- Dynamic storefront price resolver for the four supported Quest task types. Equal active prices render one amount;
  differing GAME/VIDEO prices render a min-max range; incomplete configuration renders a not-ready price message.
- Immediate post-commit Quest price-change event plus a background surface-refresh listener. This edits the durable
  `QUEST_AUTO` storefront as soon as an Admin category-price transaction commits, while retaining Maintenance as repair fallback.
- Multi-layer expired-Quest guards across Monitor discovery, Monitor test batching, Outbox enqueue and first-time Discord
  delivery. Historical Quest can remain durable evidence without consuming Monitor test attempts or creating stale `QUEST_NEW` spam.
- Integration coverage for first-run expired Quest filtering, Maintenance notification suppression, delivery-time expiry
  races and stopping an active test batch without cycling to another Monitor Token.
- Owner-approved `src/discord/assets/quest-auto-demo.gif` generated from the supplied Quest demo video and rendered
  inside the Quest Auto embed through `attachment://quest-auto-demo.gif`.
- Owner-approved animated `src/discord/assets/quest-auto-thumbnail.gif` displayed in the upper-right of the Quest
  Auto embed, with bundled GIF integrity verification and surface drift repair.
- Runtime GIF integrity verification using exact file size `9,190,692` bytes, GIF signature and SHA-256
  `c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1`.
- Surface regression coverage for stale price detection, stale/legacy attachment replacement, invisible nonce-based
  Quest Auto anchor recovery, removal of the legacy visible technical footer, and exact GIF verification.
- Pricing integration coverage proving storefront price-range source changes when the GAME category price changes and
  that the immediate refresh event is emitted only after the committed price is visible.
- Unit coverage proving a committed category-price event immediately schedules the existing surface reconciliation path.
- Quest-new reward normalization for Discord virtual-currency `orb_quantity`, including truthful min-max display for
  multi-value tiered rewards instead of claiming one tier applies to everyone.
- Quest-new static media fallback using Quest Hero/Game Tile/Logotype/application/reward assets and selected-task still
  video thumbnails, while excluding playable video URLs.
- Regression coverage proving current metadata-revision authority: partial payloads may inherit prior presentation
  metadata, while a later complete payload can remove an old image/reward without stale resurrection.
- TrueMoney settlement containment: automatic redemption stops when automatic credit settlement is disabled, financial
  invariant failures close top-up intake immediately, and circuit recovery restores intake only after a successful probe.
- Durable payment recovery for `REDEEMED` rows, including Owner-only escalation for stuck settlement, payment-queue and
  redeemed-stuck incidents, and idempotent credit recovery without another provider call.
- Payment-attempt forensic lineage using `parent_attempt_id`, normalized `error_class` / `error_code`, and regression
  coverage for retry ancestry.
- Durable Admin decision flow for Quest first discovered during customer checkout. These Quest remain private by default,
  while the authenticated customer account may still receive checkout admission; `LOG_QUEST_OPERATIONS` offers
  **ส่งประกาศ** (audited test-gate override) or **ทดสอบก่อน**.
- Customer-discovery operational records now survive temporary checkout-session retention, retaining account/discovery
  evidence and the Administrator decision without retaining the customer Token.

### Changed

- Customer voucher submission now starts a targeted post-commit settlement attempt immediately instead of waiting for
  the next payment-worker tick and waits only about eight seconds in the same ephemeral window. The target lease cannot
  claim another customer's queued voucher; unresolved work remains durable and follows up through the existing Worker/DM path.

- `GIT_SHA` is required for Production and must contain the exact 40-character candidate revision.

- TrueMoney success handling now accepts a verified `HTTP 2xx` / `SUCCESS` settlement without a provider transaction
  ID when the exact positive THB amount and one intended receiver are confirmed. Voucher HMAC plus Top-up ID is the
  internal settlement identity, while the nullable provider transaction column remains truthful. Error envelopes with
  `data: null` or omitted `data` now map proven voucher outcomes safely; diagnostics retain only HTTP/content metadata,
  body hash/length, top-level keys and a safe provider code, never the response body or PII.
- Payment review keeps its two Owner confirmations. A blank provider transaction ID is accepted only when the stored
  `HTTP 2xx` / amount / receiver-confirmation / voucher-HMAC evidence is complete, and the confirmed amount must match
  the provider amount. Payment Log and customer DM now use Thai status/reason copy and state-specific colors.

- `LOG_QUEST_OPERATIONS`, `LOG_ADMIN` and `LOG_SYSTEM` now render a readable Thai event card: what happened,
  current impact/status, a safe reason, an `ข้อมูลอ้างอิง` section, and a final `สรุป:` line.  Raw enums, JSON and
  credential-shaped values are not main-card content.
- Checkout audit projections now refresh the same `LOG_QUEST_OPERATIONS` message after selection, quote creation,
  Order confirmation and expiry; the card includes up to ten selected Quest names and the current Order reference.
- Quest-run cards now include the related Order, Quest, item and job references, while System cards translate every
  incident code emitted by source and show operator guidance only for events that need human action.
- Outbox delivery SLO now measures one delivery attempt instead of queue age. Pending/retry projection updates are
  versioned and coalesced before delivery, preventing a Discord outage from amplifying its own incident backlog.
- System incident embeds use Thai summaries, meaningful severity/resolution colors and compact diagnostics; technical
  surface footers are no longer visible on durable anchors outside legacy marker recovery.
- Panel/Error incidents now identify only the slowest route and error-class aggregates, never interaction input.
- Payment, Quest-operation and Admin Log cards use Thai status summaries, safe identifiers and trace references instead
  of raw evidence blobs. Full voucher-link recovery follows the Owner-approved Discord-only policy after encrypted
  payload retention expires.

- TrueMoney payment intent is durably checkpointed before `request.end()` begins dispatch. Any later transport,
  timeout or incomplete-response failure is contained as ambiguous/manual review rather than retried automatically.
- The GitHub Actions workflow now runs from the repository root with its own cache, artifact and Docker context.

- Quest History cards now keep the account profile thumbnail, link the `Quest — progress%` line to the matching
  Discord Quest URL, and render the bundled `quest-history-banner.png` image below every status card. Internal Account
  ID and Support code are no longer customer-facing; the Order and credit/service details remain visible.
- `QUEST_AUTO` no longer hardcodes `5 บาท`; it reads active supported `TYPE` price rules from SQLite.
- Quest Auto media now appears **inside the embed** as an animated GIF instead of a standalone MP4/video attachment
  block above the storefront.
- Quest Auto no longer exposes `Questshop Surface • QUEST_AUTO` to customers. Recovery uses the stable surface nonce,
  with the old footer lookup retained only as a migration fallback for older messages.
- Quest Auto surface reconciliation detects presentation drift independently of runtime config version and edits the
  existing durable message when content, title/description, color, fields, button routes/labels/styles/emojis,
  price text, expected GIF attachments, embed image/thumbnail or legacy footer is stale.
- Missing or legacy Quest Auto attachments are cleared and replaced with the bundled GIF and thumbnail on the same surface.
- Admin GAME/VIDEO price changes now trigger immediate background reconciliation after the database commit instead of
  waiting for the next ~60-second Maintenance pass. Maintenance remains the fallback if immediate Discord delivery fails.
- Monitor discovery now reconciles `expires_at` before creating a test batch. Already-expired Quest is marked `EXPIRED`,
  kept as history/operations evidence, and never consumes a Monitor Token or public announcement slot.
- A Quest that expires while a Monitor test batch is active stops that batch without switching to another Monitor or
  raising a misleading exhausted-monitor failure alert; retry controls do not restart an already-expired Quest.
- `QUEST_NEW` is expiry-gated again at Outbox enqueue and before first Discord send. Notifications that expire during
  retry/backoff are durably suppressed without pinging a role or marking the Quest as `ANNOUNCED`.
- Quest-new customer announcements now show Discord Quest **เริ่ม Quest** (`starts_at`) and **หมดอายุ** (`expires_at`)
  instead of scanner **ตรวจพบ** / mutable **อัปเดต** timestamps.
- Customer checkout discovery no longer automatically creates public `QUEST_NEW`; public delivery now requires a passed
  Monitor test or the explicit audited Admin publication decision.
- `QUEST_NEW` now has one customer-facing renderer source: generic projection rendering and Outbox delivery both route
  to `renderQuestNewProjection()`.
- Quest presentation metadata is read from the exact current durable revision; an older non-null thumbnail is no longer
  selected merely because the current complete revision removed it.
- Documentation is synchronized across engineering contracts, traceability and UAT evidence so Quest Auto and Quest-new
  source behavior and live boundaries use the same wording.
- Discord response controller preserves `ModalBuilder` instances and persistent interaction sessions bind to their
  rendered message before controls become usable.
- Backoffice authorization uses `OWNER_ID` or current Discord `Administrator` permission at every interaction instead
  of a configured Admin Role ID.
- Surface setup/reconciliation recreate only on confirmed missing-message errors; permission/network/rate-limit errors
  preserve the authoritative pointer and incident evidence.
- PostgreSQL role/TLS configuration is no longer a runtime dependency.
- TrueMoney submit now creates the customer Wallet up front, hides durable top-up identity from other users, permits only
  one pending top-up per customer and re-checks the Bangkok daily lock before a queued voucher can be claimed.
- TrueMoney success now requires successful HTTP status, positive amount, consistent single-recipient evidence and a
  safe transaction identifier. Response aborts and inconsistent transport/provider evidence remain ambiguous.
- Owner manual credit requires a matching second confirmation within five minutes, and duplicate provider transaction
  identifiers return a business-safe conflict instead of a generic database failure.
- Startup remains available for first installation without a TrueMoney receiver: payment health is `MISSING_RECEIVER`,
  voucher intake remains unavailable until an active receiver exists, and the Owner can finish setup in the Admin panel.
- A successfully redeemed voucher above the configured automatic-credit maximum is credited in full, creates an
  operational warning and locks further top-ups until the Bangkok-day boundary; it is never silently held as money owed.
- Runner verification may request expired Quest rows after execution so deadline outcomes are not misclassified as a
  missing Quest. A missing post-mutation Quest now remains an ambiguous provenance case instead of an automatic release.
- A Quest Manual Review retry checks expiry before requeueing and resolves an expired review without creating a test run.
- Maintenance commits runner, monitor, payment, lock and notification recovery in bounded independent transactions;
  24-hour reminders record evidence without changing an Admin review into an Owner-only review.
- SQLite worker/database degradation contributes to readiness and system incident state.
- Quest Auto reconciliation now requires the exact approved GIF filename, byte size and matching remote attachment URL
  before preserving an existing Discord upload.

### Removed

- Automatic Quest reward claim / claim retry paths.
- Runtime-wide Permission Drift detector, human-visibility/privacy preflight and automatic Discord permission repair.
- Legacy generic branding overrides for the fixed Quest Auto title/description.
- Legacy Base64/re-encoded Quest Auto demo derivative and standalone MP4 storefront presentation.
- The legacy duplicated Quest-new renderer that could still format `ตรวจพบ` / `อัปเดต` independently of Outbox delivery.

### Security

- `LOG_PAYMENTS` no longer decrypts or displays the receiver's full phone number, voucher sender name or sender phone;
  it retains only the receiver last four digits and the Owner-approved full voucher-link exception.

- Quest Auto media bytes fail closed on size/GIF-signature/hash mismatch before upload.
- Money remains integer satang; Wallet/Ledger settlement paths retain serializable/idempotent/fencing protections.
- Logger/Discord boundaries retain secret redaction and deny-by-default mentions; TrueMoney voucher URLs are redacted
  from structured application logs.
- Full TrueMoney voucher-link rendering remains the narrow `LOG_PAYMENTS` exception; channel visibility is an
  Owner-managed operational responsibility.
- Quest reward parsing ignores explicitly non-Orb reward quantities instead of mislabelling them as Discord Orbs.

### Automated evidence

Every candidate build must freshly pass syntax/check, unresolved-import check, lint, SQLite coverage, fake-adapter
load test, `npm audit --audit-level=high`, diff check and Docker build. Record the exact passing SHA with UAT; a
previous green SHA is not evidence for a newer candidate.

These are source/CI results only. Discord GIF rendering, Quest reward/start/expiry/artwork fidelity, first-run historical
Quest filtering, visible price refresh, TrueMoney, live Quest execution, SQLite/inwcloud restart and Owner UAT remain
live evidence boundaries.
