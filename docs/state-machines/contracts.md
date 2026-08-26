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

After `PAYMENT_QUEUED` commits, the customer interaction acknowledges only the durable Top-up ID and starts a targeted
background settlement. `TOPUP_STATUS_DM` is one Outbox projection per Top-up and is refreshed for each meaningful
payment transition; Discord delivery failure never changes payment or Wallet state. กรณี DM ถูกปิดจะ retry ตาม
backoff 6 รอบก่อนเข้า Financial DLQ.

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
- a stale title/description/price/media attachment/embed image or thumbnail, or a legacy visible technical footer is presentation drift,
  not a Wallet/Order/Payment transition;
- the approved `quest-auto-demo.gif` is rendered inside the Rich Embed through `attachment://quest-auto-demo.gif`;
- the approved animated `quest-auto-thumbnail.gif` is rendered in the upper-right through
  `attachment://quest-auto-thumbnail.gif`;
- the customer-facing embed has no `Questshop Surface • QUEST_AUTO` footer; stable nonce lookup is the primary
  invisible-anchor recovery path and footer lookup is migration fallback only;
- repairing Quest Auto presentation must not write financial aggregates;
- the same durable message should remain active when price text or media is refreshed.

Current presentation healing is triggered by setup/restart and the normal Maintenance reconciliation path,
approximately once every 60 seconds.
## Customer-discovered Quest verification

- Quest ที่ดึงจาก Token ของลูกค้าใช้สำหรับ Checkout ของบัญชีนั้นโดยตรง หลังตรวจข้อมูล ราคา Contract และเวลาคงเหลือ; สถานะประกาศหรือการพบใน Monitor ไม่ใช่เงื่อนไขบล็อก Checkout
- เมื่อ Quest ยังไม่เคยพบจาก Monitor ระบบสร้าง Customer Discovery Case หนึ่งรายการต่อ Quest, เก็บลิงก์ Quest และค้นทุกบัญชี Monitor ที่มีสิทธิ์ `TEST` แบบ read-only อัตโนมัติ
- ระบบจะเริ่ม Test mutation เฉพาะ Monitor ที่พบ Quest และยังทำ Quest ได้; `ไม่พบ Quest` เป็นผลการค้นหา ไม่ใช่ Test/Contract failure
- หาก Quest หายไปหลังเริ่ม Test ใน Monitor ใด ระบบบันทึกว่าไม่พบ Quest ในบัญชีนั้นและข้ามไป Monitor ที่พบ Quest รายถัดไปทันที โดยไม่ลอง Mutation ซ้ำในบัญชีเดิม
- การ์ดหลังบ้านเดียวกันแสดงผลค้นหา ผลทดสอบ และสถานะประกาศ ผู้ดูแลกด **ตรวจและทดสอบอีกครั้ง** ได้หลังผลไม่สำเร็จ หรือกด **ส่งประกาศ** จากข้อมูลลูกค้าได้โดยมี Audit
- `QUEST_NEW` มีไว้แจ้งข่าวเท่านั้น และไม่เปลี่ยนสิทธิ์ Checkout หรือ Order ของลูกค้า
- เมื่อปิด `QUEST_BACKGROUND_TESTING_ENABLED` Case จะแจ้งว่ารอระบบทดสอบเปิด โดยไม่กระทบ Checkout; Case เก่าที่ migration สร้างจากหลักฐานเดิมแสดงว่า “ยังไม่ได้ตรวจ” จนกว่าจะเริ่มรอบใหม่
