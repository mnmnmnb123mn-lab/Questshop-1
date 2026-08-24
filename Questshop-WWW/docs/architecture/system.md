# System architecture

Discord interactions acknowledge first and call domain services. Domain services own state transitions,
transactions, idempotency, wallet locks and outbox writes. External providers are never called while a
database transaction is open. Workers acquire durable jobs with PostgreSQL leases and fencing tokens.

Money is integer satang (`BIGINT`). Confirmation moves available credit to per-item reservations. Verified
completion captures the full item snapshot price; definite failure releases it; ambiguity retains it for review.
Orders are aggregates calculated from item state. One account can have one active order globally.

## Persistent Discord storefront

`QUEST_AUTO` is a durable Discord surface, not a normal transient message. The renderer owns the fixed storefront
heading **Discord Quest • Auto**, the Owner-approved Thai description, the **เริ่มทำเควส** / **เติมเงิน** buttons,
and the current customer-facing price summary.

The price line is derived read-only from the active `TYPE` price rules for all four supported Quest task types.
When all configured prices are equal, the storefront renders one value such as `5 บาท`; when GAME and VIDEO differ,
it renders the minimum-to-maximum range such as `5-7 บาท`. If any supported TYPE price is missing, the storefront
fails closed to `ค่าบริการยังไม่พร้อม` instead of inventing a price.

The persistent storefront carries one fixed Owner-approved GIF at `src/discord/assets/quest-auto-demo.gif`.
Before upload the runtime verifies exact size `9,190,692` bytes, a valid GIF signature, and SHA-256
`c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1`.
The GIF is attached to the Discord message and the Rich Embed references `attachment://quest-auto-demo.gif`, so the
animation appears inside the embed instead of as a standalone MP4/video block. The media is bundled source, not a
generic video subsystem or external URL dependency.

Quest Auto intentionally has no customer-visible `Questshop Surface • QUEST_AUTO` footer. Recovery prefers the stable
surface nonce; legacy footer lookup remains only as a migration fallback for older messages.

Surface reconciliation compares the stored anchor against the expected title/description, expected GIF attachment,
embed image and absence of the legacy visible footer. A stale price, missing/legacy media, deleted anchor or
config-version drift is repaired by editing/recovering the same durable surface. Reconciliation runs through the
normal Maintenance worker, currently on an approximately 60-second cadence, and setup/restart can also heal the
surface. It must not spam a second active Quest Auto panel.

If the GIF bytes are intentionally changed in a future release, change the expected media filename/version as well or
explicitly clear the existing attachment during migration/UAT; Discord-side drift detection identifies the existing
attachment by filename, while local source integrity is enforced by size/hash.

PostgreSQL time controls money boundaries, expiry, lease ownership and retention. Application monotonic time
is used only for latency. Runtime supports schema/engine N and N-1; breaking state migrations require drain.
