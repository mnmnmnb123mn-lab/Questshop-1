# State-machine contracts

Canonical transition maps live in each domain `states.js`; SQL `CHECK` constraints define the durable value set.
Discord handlers never update business state directly. Every aggregate transition uses compare-and-swap, increments
`state_version` and records trace/causation/actor evidence.

## Top-up

```text
RECEIVED → VALIDATING → PAYMENT_QUEUED → PROCESSING
```

Success separates `REDEEMED` from `CREDITED`. A request that may have reached TrueMoney is never blindly retried.
Uncertain results enter Owner-only Manual Review.

## Order Item / Runner

Successful Quest work ends at `READY_TO_CLAIM`; there is no Automatic Claim transition.
Definite failures/external-completion paths release Wallet reservations when policy proves release is safe.
Ambiguous completion/provenance remains Reserved for Manual Review.

Runner rate limits are explicit: leased/running work may enter `WAITING_RATE_LIMIT` with provider Retry-After,
then recovery returns it through `QUEUED`. Ordinary transient failures use `WAITING_RETRY` with bounded backoff.

## Outbox

```text
PENDING → LEASED → DELIVERED | RETRY_WAIT | DEAD_LETTER
```

Financial and Audit DLQ records cannot be discarded.

## Discord durable surfaces

Persistent Discord surfaces are not financial/domain state machines, but they have a durable `surfaces` record and
state/version contract around one authoritative Guild/Channel/Message pointer.

For `QUEST_AUTO`:

- setup/reconciliation edits the current anchor when it exists;
- only a confirmed missing Discord message permits replacement/recreation;
- Discord permission/network/rate-limit failures preserve the authoritative pointer and incident evidence;
- a stale title/description/price/GIF attachment/embed image or a legacy visible technical footer is presentation drift,
  not a Wallet/Order/Payment transition;
- the approved `quest-auto-demo.gif` is rendered inside the Rich Embed through `attachment://quest-auto-demo.gif`;
- the customer-facing embed has no `Questshop Surface • QUEST_AUTO` footer; stable nonce lookup is the primary
  invisible-anchor recovery path and footer lookup is migration fallback only;
- repairing Quest Auto presentation must not write financial aggregates;
- the same durable message should remain active when price text or media is refreshed.

Current presentation healing is triggered by setup/restart and the normal Maintenance reconciliation path,
approximately once every 60 seconds.
