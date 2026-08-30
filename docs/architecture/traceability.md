# Financial traceability

Top-up trace: customer → stable voucher identity HMAC + versioned proof HMAC → `topups` → `payment_attempts` →
`wallet_transactions` → Payment Log/DM → Manual Review/Admin Audit when required. Provider outcomes, correlation IDs
and safe evidence are append-only settlement inputs; raw voucher data remains encrypted and is not a trace field.

Order trace: customer → `orders`/`order_items` → Wallet Reserve → Job lease/checkpoint → Capture, Release or Review
→ `settlement_evidence` → Quest History/Operations Log. Active Quest-account exclusivity is held by the nonterminal
Order and released only after its Items have terminally settled.

One Wallet transaction, one settlement-evidence record and one Admin audit record are append-only. Payment and Order
traces use reference IDs rather than forcing an unrelated Top-up and Order to share one trace ID. Discord Notifications
and Surfaces add a logical nonce alongside their mutable Discord message ID so crash recovery can preserve one message.
