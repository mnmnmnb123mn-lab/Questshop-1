# Financial traceability

Top-up trace: customer → voucher HMAC → `topups` → `payment_attempts` → `wallet_transactions` → Payment Log/DM →
Manual Review/Admin Audit when required.

Order trace: customer → `orders`/`order_items` → Wallet Reserve → Job → Capture, Release or Review → Quest History/
Operations Log.

One Wallet transaction and one Admin audit record are append-only. Payment and Order traces use reference IDs rather
than forcing an unrelated Top-up and Order to share one trace ID.
