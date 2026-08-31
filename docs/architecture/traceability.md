# Financial traceability

Top-up trace: customer → stable voucher identity HMAC + versioned proof HMAC → `topups` → `payment_attempts` →
`wallet_transactions` → Payment Log/DM → Manual Review/Admin Audit when required. Provider outcomes, correlation IDs
and safe evidence are append-only settlement inputs; raw voucher data remains encrypted and is not a trace field.

Each provider attempt has its own immutable intent/evidence identity and optional parent. Financial review decisions
add two append-only confirmation records containing only canonical sanitized evidence/hash, never a raw voucher or
credential. The first confirmation and actual Wallet settlement are distinct traces; the second confirmation is the
single atomic boundary for Top-up, Wallet and Admin Audit.

Order trace: customer → `orders`/`order_items` → Wallet Reserve → Job lease/checkpoint → Capture, Release or Review
→ `settlement_evidence` → Quest History/Operations Log. Active Quest-account exclusivity is held by the nonterminal
Order and released only after its Items have terminally settled.

One Wallet transaction, one settlement-evidence record and one Admin audit record are append-only. Payment and Order
traces use reference IDs rather than forcing an unrelated Top-up and Order to share one trace ID. Discord Notifications
and Surfaces add a logical nonce alongside their mutable Discord message ID so crash recovery can preserve one message.

Operational Job retention does not erase `external_operation_evidence`. A retained evidence row includes job type,
operation key and operation/attempt identity, allowing recovery and audit after the mutable Job has aged out.
Retention writes a durable `retention_last_cleanup` counter after all isolated purge groups succeed; an individual
maintenance failure emits a `RETENTION_CLEANUP_FAILED` incident without deleting financial evidence.
