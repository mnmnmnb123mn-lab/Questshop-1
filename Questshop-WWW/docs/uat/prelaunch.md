# Pre-launch acceptance

Use `evidence-template.md` to record every result against one deployed build. Never record raw tokens, database URLs,
keyrings or a full voucher URL in UAT evidence.

## Preconditions

- [ ] `PRELAUNCH=true`; customer routes are restricted to Owner/Admin for this round.
- [ ] inwcloud runs Node 22.x and the intended branch/commit is deployed; no `GIT_SHA` Environment Variable is required.
- [ ] inwcloud Root Directory is explicitly `Questshop-WWW`; the root GitHub Actions workflow passed for this build.
- [ ] `questshop_migrator` and `questshop_runtime` are different effective roles.
- [ ] Production DB URLs use `sslmode=verify-full`; Runtime has no DDL and protected append-only tables deny update/delete.
- [ ] Bot has Discord `Administrator`.
- [ ] Owner has manually configured backoffice channel privacy; no automated human-visibility guard is assumed.
- [ ] Receiver, Monitor and keyring health are valid; record versions/IDs only.
- [ ] `npm run check`, `npm run lint`, PostgreSQL-backed coverage/tests, load test, `npm audit --audit-level=high` and Docker build passed for this build.

## Quest Auto storefront UAT

- [ ] `/quest-auto` creates/updates exactly one durable storefront anchor.
- [ ] Embed title is **Discord Quest Auto**.
- [ ] Description shows Discord Orbs and Discord Token guidance and the two expected buttons remain usable.
- [ ] The approved `quest-auto-thumbnail.gif` animates as the upper-right Embed thumbnail on desktop and mobile.
- [ ] The approved `quest-auto-demo.gif` animates **inside the Rich Embed** in Discord desktop.
- [ ] The same GIF animates inside the embed in Discord mobile.
- [ ] No standalone MP4/video block appears above the storefront.
- [ ] No customer-visible `Questshop Surface • QUEST_AUTO` footer remains.
- [ ] Deployed source asset corresponds to size `9,190,692` bytes and SHA-256
      `c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1`.
- [ ] With equal GAME/VIDEO pricing, storefront shows one amount (for example `5 บาท`).
- [ ] Change one category price so GAME/VIDEO differ; the same storefront message updates to a min-max range
      (for example `5-7 บาท`) within the Maintenance reconciliation window, currently approximately 60 seconds.
- [ ] Change the price back/equalize categories and verify the same message collapses back to one amount.
- [ ] Restart runtime and confirm no duplicate Quest Auto panel or duplicate media attachments appear.
- [ ] Remove/corrupt either expected media attachment in the test Guild and verify reconciliation repairs the same message.
- [ ] Confirm legacy Quest Auto messages with the old technical footer can be migrated without creating a duplicate anchor.
- [ ] Delete the Quest Auto message in the test Guild, rerun/reconcile, and verify exactly one replacement becomes authoritative.
- [ ] Simulate/fix Discord 403 without letting the bot modify channel permission overwrites automatically.

## Quest new announcement UAT

Use a newly discovered real Quest after deploying the exact candidate SHA. Compare the public announcement with the
same Quest payload/evidence; do not infer values from another bot or a screenshot alone.

- [ ] Title remains **🎉 พบ Quest ใหม่: ...** and contains no customer/account/Token identity.
- [ ] **ประเภท** matches the selected supported task event.
- [ ] **เป้าหมาย** matches the selected task target from the Quest payload.
- [ ] **รางวัล** matches Discord virtual-currency `orb_quantity`; an unrelated reward `quantity` is never shown as Orbs.
- [ ] If a real `ALL` Orb reward has multiple Orb entries, the displayed exact amount equals their sum.
- [ ] If a real multi-value `TIERED` Orb reward is available, the announcement shows its min-max Orb range rather than one tier as universal.
- [ ] **ค่าบริการ** matches the latest enabled TYPE rule for the Quest task type.
- [ ] **ดู Quest ได้ที่นี่** opens the intended Discord Quest URL.
- [ ] **เริ่ม Quest** matches Discord `starts_at`, not scanner discovery time.
- [ ] **หมดอายุ** matches Discord `expires_at`.
- [ ] Customer copy contains no **ตรวจพบ**, **อัปเดต**, or mutable `updated_at` embed timestamp.
- [ ] When Discord provides a usable `hero`/`quest_bar_hero`, the large embed image is the real Quest static artwork.
- [ ] When a selected video task provides a still thumbnail under its task assets, the still image may be used but no MP4/WebM/video URL is embedded as artwork.
- [ ] When Discord provides a distinct game tile/logotype/application/reward static asset, the embed may show it as the small thumbnail.
- [ ] One identical URL is never duplicated as both the large image and thumbnail.
- [ ] A Quest with no usable static media remains without invented artwork.
- [ ] After a complete newer payload removes a previous thumbnail, re-rendering does not resurrect that thumbnail from an older metadata revision.
- [ ] A genuinely partial payload may retain prior durable presentation metadata until a complete payload becomes authoritative again.
- [ ] Generic projection rendering and Outbox delivery produce the same renovated Quest announcement contract.

## Financial proof

- [ ] Real low-value TrueMoney success: `REDEEMED → CREDITED` exactly once.
- [ ] Real low-value TrueMoney success without a provider transaction ID (if Provider omits it): `REDEEMED → CREDITED`
      exactly once; the stored transaction ID stays `NULL` and the Payment Log identifies the encrypted voucher +
      Top-up ID settlement reference without exposing a raw response.
- [ ] Submit the same voucher twice: one durable Top-up owner, no double credit.
- [ ] Used and expired vouchers return their mapped terminal Thai reason when the provider code is present; an unknown
      HTTP 400 remains `MANUAL_REVIEW` with no blind retry.
- [ ] Provider timeout after possible send: `AMBIGUOUS`, no blind retry.
- [ ] Owner resolves ambiguous payment with audit.
- [ ] Owner Manual Review with no provider transaction ID is available only when the recorded 2xx/SUCCESS, exact THB
      amount and intended receiver evidence are complete; it still requires two matching Owner confirmations.
- [ ] A dispatch-checkpoint failure sends no provider request and remains retryable; every timeout, socket abort or
      incomplete response after dispatch becomes `AMBIGUOUS → MANUAL_REVIEW`, without a second redemption attempt.
- [ ] `LOG_PAYMENTS` contains only the approved full voucher-link exception and receiver last four digits; it contains
      no full receiver phone, voucher sender name or sender phone.
- [ ] A submitted voucher appears in `LOG_PAYMENTS` while `PAYMENT_QUEUED`, then the same message changes for credit,
      rejection, Manual Review and reversal. After encrypted-payload retention, a deleted message recovers only as a
      masked card; the existing Discord message remains Owner-managed evidence.
- [ ] `LOG_PAYMENTS` keeps the payer profile as its upper-right thumbnail and shows the approved
      `payment-log-banner.webp` once as the lower embed image after every create or edit; no duplicate attachment remains.
- [ ] After the interaction wait window, a `MANUAL_REVIEW` or Owner `REJECTED` result reaches the customer as a DM.
- [ ] Multi-Quest order captures successful Items and releases definite failures without losing cents.
- [ ] Worker crash/restart around settlement produces no duplicate Ledger mutation.

Use masked voucher identity only. Full voucher links belong only in the validated `LOG_PAYMENTS` surface.

## Discord / Quest proof

- [ ] Mobile checkout over 25 Quest options: pagination, selection and quote work.
- [ ] Wrong-user, forged and expired components fail closed without side effects.
- [ ] Real supported Video Quest verifies progress and ends at manual claim URL only.
- [ ] Real supported Desktop Quest verifies progress and ends at manual claim URL only.
- [ ] Monitor-discovered Quest remains private until current-contract test pass or audited **ส่งเลย**.
- [ ] Customer-discovered public announcement does not identify the customer or raw Token.
- [ ] Quest History keeps the profile thumbnail, links `Quest — progress%` to the matching Quest URL, and shows the
      approved `quest-history-banner.png` below every status card without duplicate attachments.
- [ ] Discord 404/429/5xx behavior preserves surface/outbox contracts.

## Backoffice log readability proof

- [ ] In `LOG_QUEST_OPERATIONS`, complete one Checkout from account check through selection, Quote, Order and expiry.
      Verify one message per Checkout shows current selected Quest (up to ten names), current Order when created, no Token,
      and a final `สรุป:` line.
- [ ] Verify Discovery, Quest test failure and Quest-run cards explain the current status in Thai and retain Quest,
      Order, item/job and tracking references only in `ข้อมูลอ้างอิง`.
- [ ] In `LOG_ADMIN`, perform one safe test mutation and verify actor, changed allowlisted values and reason are readable;
      no token, cookie, credential, ciphertext, nonce or auth tag appears.
- [ ] In `LOG_SYSTEM`, simulate one temporary Discord failure and one operator-action incident. Verify one updated card
      per incident/scope, Thai explanation, green resolved state, no raw JSON, and advice only where an operator must act.
- [ ] Verify every `LOG_QUEST_OPERATIONS`, `LOG_ADMIN` and `LOG_SYSTEM` event card shows `backoffice-log-banner.webp`
      once below the Embed on desktop and mobile, including a missing-aggregate fallback card.
- [ ] Verify Checkout/Discovery/Runner/Admin-user cards show the applicable global Discord profile or safe Quest artwork
      at upper-right when available; failed profile lookup must still deliver the card.
- [ ] Verify every `LOG_SYSTEM` card and a `LOG_ADMIN` card authored by `SYSTEM` animate
      `log-system-thumbnail.gif` at upper-right and contain exactly two attachments (GIF plus banner), without duplicates after edits or retries.

## Aiven / operations proof

- [ ] Simulate a Discord DNS/connection outage across multiple Surfaces and confirm one `DISCORD_CONNECTIVITY`
      message is updated without growing a backlog of obsolete `LOG_SYSTEM` projection events.
- [ ] Reopen and resolve one operational Incident repeatedly; confirm the same Discord message changes state, uses a
      green resolved appearance, and reports concise Thai diagnostics rather than raw JSON.
- [ ] Confirm Outbox SLO reports dispatch-attempt duration while `OUTBOX_STUCK` reports queue age/backlog separately.
- [ ] Confirm `PANEL_LATENCY_SLO` identifies route P95 and `ERROR_RATE_HIGH` identifies route/error-class aggregates
      without customer input, raw JSON or duplicate Incident messages.
- [ ] Verify `LOG_QUEST_OPERATIONS` and `LOG_ADMIN` show the current aggregate/audit message with Trace, safe IDs and
      Thai status text; no Token, cookie, credential, ciphertext, nonce or auth tag may appear.
- [ ] Aiven Console provider backup status and Free-plan recovery limitation are recorded.
- [ ] Runtime restart recovers leases, queue, Runner, Payment, Outbox and Review state.
- [ ] `/livez`, `/readyz` and authenticated `/statusz` behave as documented.
- [ ] External/Owner alert delivery is observed.
- [ ] Rollback rehearsal records app rollback or forward-fix decision without editing applied migrations.

## Closeout

- [ ] Run `CONFIRM_PRELAUNCH_CLOSEOUT=I_UNDERSTAND_COMPENSATING_TRANSACTIONS npm run prelaunch:closeout`.
- [ ] Record resulting release-evidence ID and confirm financial/Admin audit evidence was not deleted.
- [ ] Owner sets `PRELAUNCH=false` only after closeout and all required live rows pass/receive an approved forward-fix.

## Final decision

Status becomes `done` only when automated evidence and every applicable live boundary above pass on the same deployed build.
Otherwise it remains **implemented-but-unverified**.
