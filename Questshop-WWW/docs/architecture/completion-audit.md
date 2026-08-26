# Completion audit — Questshop

This document is the source/test evidence ledger. It does not replace live Discord, TrueMoney, Quest, Aiven or Owner UAT.
Current completion label is **implemented-but-unverified**.

## Owner decisions currently in force

1. One production Discord Guild, all-in-one Node.js runtime, PostgreSQL 16+ durable source of truth.
2. Money uses integer satang; Confirm reserves per Item; verified success captures; definite failure releases;
   ambiguous results remain Reserved for Manual Review.
3. No Automatic Claim. Completed Quest work ends at `READY_TO_CLAIM` with customer-side claim URL.
4. Monitor accounts always Scan + Test. Monitor-discovered Quest stays private until one test passes or audited Admin
   **ส่งเลย**; customer-discovered Quest may be admitted only for that authenticated Quest account and public output
   must not identify the customer.
5. Admin authorization is `OWNER_ID` or current Discord `Administrator` permission at each interaction.
6. Owner manages backoffice channel privacy. Runtime does not perform human-visibility/privacy preflight or permission
   drift auto-repair. `LOG_PAYMENTS` may contain a full voucher link.
7. Production DB Runtime/Migrator roles remain separate and TLS uses `sslmode=verify-full`.
8. Aiven-managed backup is the default provider boundary; Questshop does not claim a local restore drill in this mode.

## Later Owner storefront decision — Quest Auto

`QUEST_AUTO` is one durable Discord storefront message with fixed title **Discord Quest Auto**, approved Thai copy,
buttons **เริ่มทำเควส** / **เติมเงิน**, dynamic price summary, an animated GIF thumbnail and one exact Owner-approved GIF rendered
inside the embed.
The customer-facing Quest Auto embed does not display the technical `Questshop Surface • QUEST_AUTO` footer.

### Price contract

Source: `src/domain/pricing/resolver.js`, `src/domain/admin/config-service.js`, `src/workers/worker-manager.js`,
`src/discord/renderers/surfaces.js`, `src/discord/surfaces/setup.js`.

- All four supported active `TYPE` task prices must exist before the storefront claims a configured price.
- Equal prices collapse to one value such as `5 บาท`.
- Differing GAME/VIDEO values render a min-max range such as `5-7 บาท`.
- Incomplete supported configuration renders `ค่าบริการยังไม่พร้อม`.
- Surface reconciliation compares the current Discord presentation against the expected price text even if runtime
  config version did not change.
- A successful Admin category-price transaction emits `QUEST_CATEGORY_PRICE_CHANGED` only after commit. The running
  worker manager immediately queues the normal durable surface reconciliation, so the existing `QUEST_AUTO` message is
  edited in the background without waiting for the next Maintenance interval.
- Maintenance still reconciles approximately every 60 seconds as a repair fallback if an immediate Discord refresh
  fails or is missed during runtime shutdown/restart.

Automated evidence:

- `test/integration/pricing-promotion-contract.test.js`
- `test/unit/price-surface-refresh.test.js`
- `test/unit/quest-auto-surface.test.js`
- `test/unit/surface-anchor.test.js`
- `test/integration/outbox-dlq.test.js`

### Media contract

Source asset:

```text
src/discord/assets/quest-auto-demo.gif
Size     9,190,692 bytes
SHA-256  c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1

src/discord/assets/quest-auto-thumbnail.gif
Size     822,513 bytes
SHA-256  2d1e0e2c09138ac53384ac6272f4c8a9eedff28e2fe227ee06e26f7ef37a6542
```

Runtime verifies exact size, signature and SHA-256 before upload. The Rich Embed references the animated GIF as its
upper-right thumbnail and the demo GIF as its lower image, so the customer sees the animation inside the embed instead of a standalone
MP4/video block. Stale or legacy attachments are cleared and replaced on the same durable anchor. An already-correct
asset pair is preserved to avoid duplicate uploads.

Quest Auto recovery prefers the stable surface nonce so the technical footer can remain hidden. Legacy footer lookup is
retained only as a migration fallback for older storefront messages.

The reconciliation contract compares the complete customer-visible structure: empty message content, one Embed with the
approved title/copy/color and no legacy fields, one Action Row containing only the **เริ่มทำเควส** / **เติมเงิน** button
contracts, and the expected GIF attachments with embed image/thumbnail. Opaque component UUIDs may rotate; their routes and visible semantics
must remain exact. Drift edits the existing anchor instead of creating a second storefront.

Important future-change rule: Discord-side drift detection identifies the expected GIF by filename. If the GIF bytes
intentionally change later, version/change the filename or add an explicit attachment migration.

Live boundary: real Discord desktop/mobile GIF rendering inside the embed, removal of the old visible technical footer,
visible price refresh immediately after Admin confirmation plus Maintenance fallback repair, restart/setup repair and no
duplicate panel must still be verified on one deployed build.

## Quest announcement contract

Source: `src/quest-engine/schema/normalizer.js`, `src/domain/catalog/service.js`,
`src/domain/catalog/test-gate.js`, `src/domain/outbox/service.js`, `src/workers/outbox-worker.js`,
`src/discord/renderers/quest-new.js`, `src/discord/renderers/projections.js`.

- Customer-facing Quest announcements display Quest **start** (`starts_at`) and **expiry** (`expires_at`) times. They do
  not expose the scanner detection time or the mutable PostgreSQL `updated_at` value as customer copy.
- A customer-discovered Quest remains private even when that customer's authenticated account may buy it. The durable
  `CUSTOMER_QUEST_DISCOVERY` backoffice projection presents **ส่งประกาศ** and **ทดสอบก่อน** to an Administrator;
  only the former creates public `QUEST_NEW` through an audited test-gate override. Its checkout-session foreign key is
  cleared, not cascaded, during retention so the operational decision evidence remains available.
- A Quest whose `expires_at` is already past remains valid catalog/history evidence but is terminal for active delivery:
  Monitor discovery marks it `EXPIRED` before creating a test batch, does not consume a Monitor Token, and does not
  enqueue `QUEST_NEW`.
- `QUEST_NEW` enqueue independently rejects an already-expired Quest. A first-time announcement that was queued while
  valid but expires during Outbox retry/backoff is suppressed before Discord channel fetch/send and is not marked
  `ANNOUNCED`. This is the final race-condition guard against historical notification floods.
- If a Monitor test batch becomes stale at the Quest deadline, the batch closes without switching to another Monitor or
  creating a misleading exhausted-monitor alert. Admin retry checks that deadline before any requeue and resolves an
  expired review without creating a new test run.
- Discord Orb rewards are read from virtual-currency reward entries (`type = 4`, `orb_quantity`). `ALL` reward sets sum
  their Orb entries. `TIERED` reward sets with different values are represented as a range instead of pretending one
  exact amount applies to every tier. Non-Orb `quantity` values are never re-labelled as Orbs.
- The selected task's static video thumbnail is considered before legacy top-level video metadata. Video file URLs are
  never embedded as the Quest artwork.
- Large artwork prefers Quest `hero`, then `quest_bar_hero`, then a still video thumbnail, then `game_tile`.
- The small thumbnail prefers game tile/logotype/theme variants, application icon, reward artwork, then a still video
  thumbnail. Identical large/small URLs are not duplicated in one embed.
- Complete newly observed metadata is authoritative. Older presentation metadata may be inherited only while processing
  a partial Quest payload. The renderer reads thumbnail/reward presentation metadata from the exact
  `current_metadata_revision`, so a removed image cannot silently reappear from an older revision.
- `QUEST_NEW` has one rendering implementation: the generic projection registry and Outbox delivery both route to
  `renderQuestNewProjection()`.

Automated evidence:

- `test/unit/quest-normalizer.test.js`
- `test/unit/quest-new-renderer.test.js`
- `test/integration/expired-quest-filter.test.js`
- catalog/Monitor integration tests exercising durable metadata revisions and discovery reconciliation.

Live boundary: at least one real current Discord Quest must confirm Orb value, start/expiry timestamps and available
static Quest artwork on desktop/mobile. A first-run Monitor scan with historical Quest rows must notify only Quest that
are still live; an announcement queued before expiry must not first appear after the deadline. If a real tiered Quest is
available, verify the displayed range against its payload. Missing assets must remain missing rather than being invented.

## Requirement matrix

| Area | Primary implementation | Automated evidence | Live boundary |
|---|---|---|---|
| Runtime / build identity | config, bootstrap, Node 22 | env/setup/startup tests | intended inwcloud build + restart |
| PostgreSQL TLS / roles | pools, migrations, role sync/validator | PostgreSQL 16 role/TLS tests | Aiven role + CA verification |
| Wallet / Ledger | wallet services, reservations, append-only tables | concurrency/settlement/refund tests | Owner compensation sign-off |
| TrueMoney | adapter, payment worker/service | canonical URL/schema/ambiguity/crash tests | real low-value + ambiguous UAT |
| Pricing / promotions | pricing resolver, Admin config service | category + promotion integration tests | Owner Admin pricing UAT |
| Quest Auto storefront | renderer, surface setup/reconcile, exact GIF | price/media/surface tests | in-embed animation + visible refresh |
| Quest new announcement | normalizer, catalog metadata, expiry/outbox guards, Quest renderer | Orb/media/current-revision/expired-filter tests | real Quest reward/time/artwork + historical-scan UAT |
| Catalog / Monitor | catalog, discovery/test workers | Monitor gate, expiry stop, contract-pinning tests | live metadata drift + Monitor UAT |
| Checkout | checkout domain + router | session/quote/account-lock tests | mobile Discord UAT |
| Runner | runner service, executors, leases/fencing | crash/retry/atomic settlement tests | live supported Quest execution |
| Outbox / Discord delivery | outbox services/workers, transport | expiry suppression, 403/404/429, coalescing, DLQ tests | real Discord failure/expiry UAT |
| Admin / Review | Admin router + domain services | authorization/session/review tests | Owner/Admin workflow UAT |
| Health / alerts | health server, worker manager, alerts | status/auth/SLO tests | external alert delivery |
| Aiven backup policy | env/deployment policy | Aiven-managed skip/audit tests | Aiven Console recovery evidence |
| Deployment / rollback | Docker, CI, deploy scripts | coverage/load/audit/Docker | same-build UAT + rollback rehearsal |
| UAT / release | prelaunch scripts/docs | source gates only | all rows in UAT evidence template |

## Automated evidence status

Every candidate build must pass the same repository gate before its automated evidence is current:

- `npm run check`
- `npm run lint`
- PostgreSQL-backed `npm run test:coverage`
- LCOV artifact upload
- fake-adapter `npm run load:test`
- `npm audit --audit-level=high`
- Docker build

The passing workflow run or deployment ID may be recorded in release/UAT evidence when available. A previous green build
never substitutes for the candidate being deployed. These results prove source contracts only; they do not prove provider/live behavior.

## Explicit non-claims

Do not represent these as completed without controlled live evidence:

1. production Discord login/registration, mobile layout, GIF-in-embed animation and live persistent-surface recovery;
2. real Quest announcement Orb/start/expiry/artwork fidelity, including first-run historical-Quest filtering, against a
   current live Quest payload;
3. real TrueMoney redemption and post-send ambiguous resolution;
4. real supported Video/Desktop Quest execution;
5. managed PostgreSQL TLS/least-privilege provisioning and recovery operation;
6. same-build Owner closeout, rollback rehearsal and alert delivery.

## Release state

`done` requires every applicable automated and live boundary to pass on the same deployed build.
Until then the correct label is **implemented-but-unverified**, never production-ready.
