# Questshop requirement traceability

This matrix separates implemented source controls from evidence that requires a controlled live environment.
Current status remains **implemented-but-unverified**.

| Requirement group | Primary implementation | Automated evidence | Live evidence still required |
|---|---|---|---|
| Node 22 ESM and setup | `src/config`, setup/deploy scripts, bootstrap | env/setup/startup tests | intended inwcloud checkout + restart |
| PostgreSQL TLS, roles, time | pools, migrations, role sync/validator | TLS + PostgreSQL 16 role tests | Aiven CA/role provisioning |
| State machines, CAS, correlation | domain `states.js`, transitions, sessions | state/concurrency/crash tests | production trace sampling |
| Wallet / immutable ledger | wallet domain, reservations, retention | debit/settlement/refund/checkpoint tests | Owner compensation sign-off |
| TrueMoney / voucher identity | TrueMoney adapter, payment service/worker | URL/schema/HMAC/fallback-settlement/ambiguity/replay/crash tests | real low-value + ambiguous UAT |
| Pricing / promotion | pricing resolver, Admin config service | exact-satang + category/promotion tests | Owner Admin pricing UAT |
| Quest Auto dynamic price / UI recovery | `configuredQuestPriceRange`, price-change event, surface renderer/reconcile | equal/range/incomplete/stale-price, stale embed/button and immediate-refresh tests | visible live price and component refresh |
| Quest Auto embedded GIF | `src/discord/assets/quest-auto-demo.gif`, `quest-auto-media.js` | exact size/GIF/hash + stale attachment/embed tests | desktop/mobile in-embed animation |
| Quest new reward/lifetime/media | normalizer, catalog revision merge, expiry/outbox guards, `quest-new.js` | Orb/tier/media/current-revision/expired-filter tests | real Quest reward/time/artwork + historical-scan fidelity |
| Quest History presentation | `projections.js`, `quest-history-media.js`, `quest-history-banner.png` | linked Quest URL, profile thumbnail, exact banner, safe fallback tests | Discord desktop/mobile card layout and attachment rendering |
| Catalog / Monitor gate | catalog, discovery/test workers, contract pinning | Monitor-gate + expiry-stop + retest + fingerprint tests | real metadata drift / Monitor UAT |
| Checkout / account lock | checkout domain + router | quote/session/account uniqueness tests | mobile checkout UAT |
| Fair queue / Runner | runner domain, leases, executors | fairness/fencing/retry/atomic settlement tests | real Video/Desktop Quest |
| Quest API recovery/rate limits | API client + shared coordinator | timeout/403/429/size/retry tests | real Discord REST behavior |
| Outbox / Discord delivery | outbox domain/workers, transport | expiry suppression + coalescing/fencing/403/404/429/DLQ tests | live Discord fault/expiry UAT |
| Customer/Admin surfaces | commands/router/renderers/surfaces | route/session/payload/setup tests | Guild layout + mobile UI |
| Admin / Manual Review | Admin/review services | auth/review/adjustment tests | Owner workflow UAT |
| Backoffice privacy policy | startup/surface/outbox policy | no runtime human-visibility guard; Administrator startup test | Owner channel configuration |
| First-install payments / over-limit redemption | startup readiness, payment policy and payment worker | receiver-readiness, payment-hardening and payment-containment PostgreSQL tests | add active receiver; verify a redeemed over-limit voucher credits fully and locks intake through Bangkok midnight |
| Runner/review expiry recovery | Quest API client, Runner service, test gate and review service | expired Quest client/review PostgreSQL tests | verify a real deadline race keeps ambiguous work Reserved and never reseeds an expired Monitor test |
| Health / alerts | health server, worker manager, alerts | `/statusz`, invariant/SLO tests | external alert delivery |
| Aiven backup policy | env/deployment policy | Aiven-managed skip/audit tests | Aiven Console recovery evidence |
| Deployment / rollback / CI | Dockerfile, workflow, deploy scripts | check/lint/coverage/load/audit/Docker | same-build UAT + rollback |
| Release acceptance | UAT docs + closeout | source gates only | all UAT rows on one SHA |

## Quest Auto trace detail

### Customer-facing renderer

`src/discord/renderers/surfaces.js`

- title is fixed to **Discord Quest Auto**;
- approved description mentions Discord Orbs and Discord Token;
- `questAutoPriceRangeLabel()` renders one price or a min-max range;
- incomplete supported price configuration renders a not-ready price line;
- animated embed thumbnail is `attachment://quest-auto-thumbnail.gif`;
- embed image is `attachment://quest-auto-demo.gif`;
- no customer-visible `Questshop Surface • QUEST_AUTO` footer is rendered.

### Pricing source

`src/domain/pricing/resolver.js`

- reads only active `TYPE` rules for the four supported task types;
- returns `{ minCents, maxCents }` only when all four task types are represented;
- uses integer satang / `BIGINT`, never float pricing.

### Immediate price refresh and durable reconciliation

`src/domain/admin/config-service.js` + `src/shared/application-events.js` + `src/workers/worker-manager.js` +
`src/discord/surfaces/setup.js`

- a category-price change emits `QUEST_CATEGORY_PRICE_CHANGED` only after the SERIALIZABLE price transaction commits;
- the worker manager immediately schedules `reconcileSurfaceAnchors()` in a serialized background chain, so an Admin
  confirmation does not wait for Discord delivery and rapid price edits do not race each other;
- the reconciliation edits the same durable `QUEST_AUTO` anchor and still uses the existing nonce/missing-message rules;
- the surface compares expected title/description, expected GIF attachments, embed image/thumbnail and absence of
  the legacy visible footer, so the newly committed min-max price is detected without a runtime config-version change;
- confirmed missing Discord message may be recreated; permission/network failures preserve the pointer and incident evidence;
- a failed immediate refresh is logged and the normal Maintenance reconciliation, approximately every 60 seconds,
  remains the repair fallback.

### Exact bundled media

`src/discord/surfaces/quest-auto-media.js` + `src/discord/assets/quest-auto-demo.gif` +
`src/discord/assets/quest-auto-thumbnail.gif`

```text
Size     9,190,692 bytes
SHA-256  c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1

Thumbnail size     822,513 bytes
Thumbnail SHA-256  2d1e0e2c09138ac53384ac6272f4c8a9eedff28e2fe227ee06e26f7ef37a6542
```

Runtime verifies exact size, GIF signature and SHA-256 before upload. The attachment exists to back the Rich Embed image;
it is not intended as a standalone MP4/video block. Future intentional media replacement should version/change the
filename or include an explicit attachment migration.

## Quest new announcement trace detail

### Reward normalization

`src/quest-engine/schema/normalizer.js`

- uses `orb_quantity` from Discord virtual-currency reward entries (`type = 4`);
- sums Orb entries for `assignment_method = 1` (`ALL`);
- preserves min/max for `assignment_method = 2` (`TIERED`) and does not collapse different tiers into a false exact value;
- never treats an unrelated reward `quantity` as Discord Orbs;
- keeps legacy untyped `orb_quantity` compatibility without accepting explicitly non-Orb reward types.

### Lifetime, expiry filtering and media normalization

`src/quest-engine/schema/normalizer.js` + `src/domain/catalog/service.js` + `src/domain/catalog/test-gate.js` +
`src/domain/outbox/service.js` + `src/workers/outbox-worker.js`

- stores Discord Quest `starts_at` and `expires_at` as the customer-visible lifetime source;
- Monitor discovery reconciles expiry before creating a test batch, so an already-expired Quest can remain in durable
  history but consumes no Monitor test attempt and creates no public `QUEST_NEW` projection;
- customer checkout discovery may admit the Quest only for the authenticated account, independently from notification
  or Monitor visibility. Its durable Case starts a search across Test Monitors; only visible accounts are tested, while
  no visibility result is reported honestly and may be retried. A passed test queues an informational `QUEST_NEW`;
- active test batches re-check the Quest deadline before choosing another Monitor, and an expired batch closes without
  cycling credentials or generating an exhausted-monitor alert;
- the common Outbox enqueue boundary refuses `QUEST_NEW` for an expired Quest regardless of whether the caller is
  discovery, Maintenance, Admin or another future path;
- first-time `QUEST_NEW` delivery re-checks expiry before Discord channel fetch/send. A queued notification that expires
  during retry/backoff is recorded as suppressed, leaves `message_id` empty and does not mark the Quest `ANNOUNCED`;
- static media resolution prefers `hero`, `quest_bar_hero`, selected-task video thumbnail, then `game_tile` for the large image;
- the small image prefers game tile/logotype/theme variants, application icon, reward artwork, then a still video thumbnail;
- playable video URLs are excluded from announcement media;
- a complete newly observed payload is authoritative; previous image/reward presentation metadata is inherited only for a partial payload.

Automated expiry evidence: `test/integration/expired-quest-filter.test.js` covers discovery, Maintenance enqueue,
Outbox delivery-race suppression and Monitor-batch stop behavior.

### Customer-facing Quest renderer

`src/discord/renderers/quest-new.js` + `src/discord/renderers/projections.js`

- displays **เริ่ม Quest** from `starts_at` and **หมดอายุ** from `expires_at`;
- omits scanner **ตรวจพบ**, **อัปเดต**, and the mutable embed footer timestamp;
- shows exact Orbs when exact, or an Orb range for a multi-value tiered reward;
- reads presentation metadata only from `quests.current_metadata_revision`, preventing an older removed thumbnail from reappearing;
- supports at most one large embed image plus one distinct thumbnail and invents no artwork when Discord provides none;
- generic projection rendering and Outbox delivery use the same `renderQuestNewProjection()` implementation.

## Backoffice log and trace contract

- `LOG_PAYMENTS` follows `TOPUP → payment_attempts → wallet_transactions → manual_reviews/admin_audit_logs` using
  Top-up ID, Wallet transaction ID and Trace. It begins at `PAYMENT_QUEUED` and edits the same projection through its
  outcome. The full voucher URL is an Owner-approved Discord-only record after the encrypted payload reaches its
  seven-day retention boundary; a lost Discord message cannot be reconstructed with the URL after that point.
  Immediately after a customer commits a new voucher, the interaction acknowledges only that durable acceptance and
  starts settlement for the exact Top-up in the background; it never waits for a same-window result or acquires an
  older Top-up. `TOPUP_STATUS_DM` owns one customer DM projection per Top-up and edits it through queued, processing,
  retry, terminal, review and reversal states. กรณีลูกค้าปิด DM ระบบลองส่งใหม่ 6 รอบตาม backoff ก่อนเข้า
  Financial DLQ; the regular payment Worker remains the recovery path.
  A `SUCCESS` response without a provider transaction ID uses the encrypted voucher identity plus Top-up ID only after
  HTTP 2xx, exact positive THB amount and intended-single-receiver evidence all agree; it never invents a provider ID.
- `LOG_QUEST_OPERATIONS` follows `interaction_sessions → orders/order_items → runner_jobs/runner_attempts →
  reservations/refunds`. Credit from one Top-up can fund more than one Order, so these two chains use references and
  wallet transactions rather than a fabricated one-to-one shared Trace.
- `LOG_ADMIN` is append-only and rendered from allowlisted before/after fields. Credential-shaped values are redacted
  before persistence; Trace and correlation code remain the lookup key for full PostgreSQL evidence.
- `LOG_SYSTEM` stores only aggregate route/error-class diagnostics. Outbox backlog repair records every coalesced
  queued event in `state_transitions` and never closes an active lease.
- The three operational rooms use the same display contract: plain Thai explanation first, safe current status and
  impact second, then durable identifiers in `ข้อมูลอ้างอิง`, ending with `สรุป:`.  Technical enum values and raw
  evidence remain database lookup material rather than main Discord-card copy.
- Backoffice event cards clear prior attachments before each edit and attach one verified common banner. System Incident
  and system-authored Admin Audit cards also attach the verified animated Questshop logo as their thumbnail; dynamic
  avatar/artwork lookup failure never prevents the durable Log delivery.

## Completion labels

- `implemented-but-unverified`: source and automated evidence pass, but one or more live boundaries are missing.
- `done`: all automated and applicable live boundaries pass on the same deployed build.
- `production-ready`: must not be used before the full live checklist and Owner acceptance are complete.
