# Questshop production evidence record

Copy this file for each pre-launch round. It records evidence; it does not replace database audit trails.
Never record raw tokens, voucher URLs, database URLs, cookies, passwords or encryption/HMAC keys.

## Release identity

| Field | Value |
|---|---|
| Build/Deployment ID (ถ้ามี) | |
| App version | |
| Engine / executor / contract versions | |
| Schema version | |
| Environment | `PRELAUNCH` |
| Started at (UTC) | |
| Owner conducting UAT | |
| Guild ID | |

Stop the round if the app, migration or configuration is deployed again during the round.

## Preconditions

- [ ] `PRELAUNCH=true`.
- [ ] Direct/Runtime Aiven URLs use distinct roles and `sslmode=verify-full`.
- [ ] Runtime has no schema DDL and protected append-only tables deny update/delete.
- [ ] Bot has Discord `Administrator`.
- [ ] Owner manually verified backoffice channel viewers/roles; no automated privacy guard is claimed.
- [ ] Receiver, Monitor and keyring health are valid; record version/ID only.
- [ ] check/lint/PostgreSQL-backed coverage/load/audit/Docker gates passed for this SHA.

## Quest Auto evidence

Expected source contract:

```text
Title    Discord Quest Auto
GIF      src/discord/assets/quest-auto-demo.gif
Embed    attachment://quest-auto-demo.gif
Size     9,190,692 bytes
SHA-256  c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1
GIF      src/discord/assets/quest-auto-thumbnail.gif
Thumb    attachment://quest-auto-thumbnail.gif
Size     822,513 bytes
SHA-256  2d1e0e2c09138ac53384ac6272f4c8a9eedff28e2fe227ee06e26f7ef37a6542
Footer   none visible to customer
```

| Case | Discord Message ID / evidence | Expected outcome | Observed outcome | Owner approval |
|---|---|---|---|---|
| `/quest-auto` install/update | | one durable active anchor | | |
| Thumbnail rendering | | animated GIF appears upper-right on desktop/mobile | | |
| Desktop GIF rendering | | `quest-auto-demo.gif` animates inside Rich Embed | | |
| Mobile GIF rendering | | same GIF animates inside Rich Embed | | |
| Standalone media regression | | no MP4/video block appears above storefront | | |
| Technical footer regression | | no `Questshop Surface • QUEST_AUTO` visible footer | | |
| Equal GAME/VIDEO price | | one amount, e.g. `5 บาท` | | |
| Different GAME/VIDEO price | | min-max range, e.g. `5-7 บาท` | | |
| Price refresh timing | | same message updates within ~60s Maintenance window | | |
| Restart | | no duplicate anchor/media attachments | | |
| Legacy/missing media | | same anchor restores both expected assets | | |
| Legacy footer migration | | old footer anchor migrates without duplicate panel | | |
| Deleted anchor | | exactly one replacement becomes authoritative | | |
| Discord 403 | | incident/pointer preserved; no permission auto-repair | | |

Record only message/channel IDs and timestamps, never a Discord user token.

## Financial proof

| Case | Top-up / Order / Trace ID | Expected outcome | Observed outcome | Owner approval |
|---|---|---|---|---|
| Real low-value TrueMoney success | | `REDEEMED → CREDITED` exactly once | | |
| Real success without provider transaction ID | | one credit; stored provider ID remains `NULL`; masked fallback reference | | |
| Same voucher submitted twice | | one durable Top-up owner | | |
| Used / expired voucher | | mapped Thai terminal reason, no credit | | |
| Provider timeout after possible send | | `AMBIGUOUS`, no blind retry | | |
| Owner resolves ambiguous payment | | Credit or Reject with audit | | |
| Five Quest items: 3 success / 2 failure | | 3 Capture + 2 Release | | |
| Worker crash / restart around settlement | | no duplicate Ledger mutation | | |

Use masked voucher identity only. Complete voucher link belongs only in the validated `LOG_PAYMENTS` surface.

## Discord and Quest proof

| Case | Evidence IDs | Expected outcome | Observed outcome | Approved by |
|---|---|---|---|---|
| Mobile checkout >25 options | | pagination/selection/quote works | | |
| Forged/wrong-user/expired component | | denied without side effect | | |
| Real Video Quest | | verify then manual claim URL only | | |
| Real Desktop Quest | | verify then manual claim URL only | | |
| Monitor-discovered Quest | | private until current-contract pass/override | | |
| customer `quest-new` | | public output hides customer source | | |
| Discord 404/429/5xx | | scoped retry/reconcile behavior | | |

For Quest runs, record Order Item ID, Job ID and shortened support code only.

## Aiven / operations proof

| Case | Backup / Incident / Trace ID | Expected outcome | Observed outcome | Owner approval |
|---|---|---|---|---|
| Aiven provider-managed backup | | Console status + plan limitation recorded | | |
| Runtime restart recovery | | leases/queue/payment/outbox/reviews recover | | |
| Health endpoints | | `/livez`, `/readyz`, authorized `/statusz` correct | | |
| Alert delivery | | Owner receives financial/infrastructure alert | | |
| Rollback rehearsal | | compatible app rollback or forward-fix decision | | |

## Closeout

- [ ] Run `CONFIRM_PRELAUNCH_CLOSEOUT=I_UNDERSTAND_COMPENSATING_TRANSACTIONS npm run prelaunch:closeout`.
- [ ] Record resulting `PRELAUNCH_CLOSEOUT` release-evidence ID.
- [ ] Confirm no financial/Admin audit evidence was deleted.
- [ ] Owner sets `PRELAUNCH=false` only after required rows are approved.

## Final decision

- [ ] Every applicable row passed or has an approved compensating/forward-fix record.
- [ ] Owner accepts residual risks.
- [ ] Status is `done` only for this deployed build; otherwise **implemented-but-unverified**.
