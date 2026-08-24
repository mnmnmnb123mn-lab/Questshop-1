# Module definition of done

Each module is complete only when the listed code contract, migration/index, authorization boundary,
idempotency/concurrency behavior, observability, feature gate, tests, rollback path and runbook exist.

| Module | Done criteria |
|---|---|
| Foundation | validated environment; separate direct/pooled roles; migration checksum and compatibility; runtime lease; health-first startup; 25-second shutdown |
| Wallet | integer satang; row lock; serializable retry; append-only hash chain; reservation states; compensation and checkpoint retention |
| Payment | voucher allowlist/HMAC; receiver/promotion snapshot; intent phase; no blind retry after possible send; exact-once credit; Owner-only ambiguity |
| Catalog | three independent axes; immutable metadata revisions; SHA-256 execution-contract fingerprint; test/override evidence valid only for the current fingerprint; dynamic price; executor support; expiry admission; customer discovery is logged privately with the customer and Quest-account identity but never a raw Token |
| Checkout | actor/guild/channel-bound session; encrypted token; pagination; quote hash/version; signed 30-second external preflight; current-contract revalidation; account uniqueness; bulk item reserve |
| Queue/Runner | fair scheduling; lazy materialization; atomic terminal item/job settlement; Runner revalidates the pinned execution contract; every initial/controlled mutation has its own durable checkpoint; a possibly-sent mutation is freshly verified and proven completed work captures (not releases) its reservation; missing completion provenance remains reserved for Review; lease/fencing; bounded retry; capture/release; no claim API |
| Outbox | transactionally enqueued projection; latest-state rendering; heartbeat and fencing for event/projection leases; nonce reconciliation; Discord error contract; durable attempts; replay-linked DLQ |
| Discord UI | persistent setup/update/move; Ephemeral secrets; allowed-mention allowlist; terminal controls disabled; Thai/mobile-safe content; `QUEST_AUTO` keeps one durable anchor, fixed Owner-approved title/copy, exact bundled `quest-auto-demo.gif` rendered inside the embed, no visible technical footer, dynamic configured price/range, stale-price/media reconciliation and no active duplicate panel |
| Admin | Owner/Admin split; preview and confirmation for money/repair/receiver; reason/correlation/audit; no token read path |
| Operations | surface setup permission preconditions; incidents and feature containment; metrics/SLO evaluator; Aiven backup policy disclosure; retention/key rotation; Maintenance heals stale `QUEST_AUTO` presentation without changing financial state |

## Quest Auto acceptance details

The storefront is source-complete only when all of these automated contracts pass:

- `renderQuestAuto()` renders **Discord Quest • Auto**, the approved Discord Orbs / Discord Token copy and
  `attachment://quest-auto-demo.gif` as the embed image.
- Active supported `TYPE` price rules are complete before a price is shown. Equal prices collapse to one amount;
  different GAME/VIDEO prices render a minimum-to-maximum range; incomplete configuration renders
  `ค่าบริการยังไม่พร้อม`.
- `src/discord/assets/quest-auto-demo.gif` is the exact approved GIF: `9,190,692` bytes and SHA-256
  `c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1`.
- A missing/legacy attachment is replaced on the existing surface, while an already-correct GIF is preserved to avoid
  duplicate uploads.
- The customer-facing Quest Auto embed has no `Questshop Surface • QUEST_AUTO` footer. Stable nonce recovery is used
  for the invisible anchor, with the old footer lookup only as a migration fallback.
- A stale displayed price is detected independently of runtime config version and repaired by the normal surface
  reconciliation path. The current Maintenance worker cadence is approximately 60 seconds, so this is automatic
  eventual refresh rather than a synchronous guarantee at the exact Admin button click.
- Restart/setup/reconciliation still preserve the one-anchor rule and only recreate on a confirmed missing Discord
  message.

Live acceptance remains separate: the Owner must verify actual Discord desktop/mobile GIF animation inside the embed,
the visible price change, button behavior, absence of the old technical footer and absence of duplicate panels on one
exact Git SHA.

The evidence command set is `npm run check`, `npm run lint`, PostgreSQL-backed `npm test`, `npm audit`,
Docker build and the fake-adapter load test. Live Discord, TrueMoney, S3 and managed-database evidence is tracked
separately in `traceability.md` and `uat/prelaunch.md`.
