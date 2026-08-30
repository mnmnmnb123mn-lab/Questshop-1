# Questshop

Questshop คือบอท Discord สำหรับรับทำ Discord Quest อัตโนมัติใน Guild เดียว โดยใช้ Node.js 22,
`discord.js` และ SQLite ผ่าน `node:sqlite` เป็น durable source of truth. ฐานข้อมูลอยู่ที่
`/data/questshop.db` และ Production รันได้เพียงหนึ่ง Process. ลูกค้าเติมเครดิตด้วย TrueMoney Gift,
ส่ง Discord Token แบบ Ephemeral, เลือก Quest, ยืนยัน Order และติดตามผลจนถึง `READY_TO_CLAIM`.
ระบบ **ไม่มี Automatic Claim**; ลูกค้ากดรับรางวัลเองเสมอ.

## Runtime และการติดตั้ง

```text
Node.js 22.22 → node:sqlite → /data/questshop.db → one runtime process
```

กำหนดอย่างน้อย `SQLITE_PATH=/data/questshop.db`, `QUESTSHOP_SECRET_KEY` แบบถาวร และ `GIT_SHA`
40 ตัวอักษรใน Production แล้วใช้คำสั่งเดิม:

```bash
npm ci --omit=dev && npm run deploy && npm start
```

`deploy` ตรวจ config, สร้าง Pre-migration SQLite backup, ใช้ Migration แบบ atomic และค่อย Register
Discord commands. ไม่ต้องตั้งค่า Aiven, PostgreSQL role, TLS หรือ database URL.

> [!IMPORTANT]
> สถานะ release ปัจจุบันคือ **migration-in-progress** จนกว่า source/test migration จะครบ และ Discord, TrueMoney, Quest,
> inwcloud และ Owner UAT จะผ่านบน build เดียวกันตาม [Pre-launch UAT](docs/uat/prelaunch.md).

> [!WARNING]
> Quest Engine ใช้ Discord user token / self-bot behavior ซึ่งอาจขัดเงื่อนไขของ Discord และทำให้บัญชี
> ถูกจำกัดหรือปิดได้ เจ้าของระบบต้องยอมรับและทบทวนความเสี่ยงนี้ก่อนใช้งานจริง.

## หน้าร้าน Quest Auto ปัจจุบัน

`/quest-auto` ติดตั้ง Surface ถาวรหนึ่งข้อความ และการเรียกซ้ำจะ update/move ข้อความเดิมแทนการสร้าง panel ซ้อน.
หน้าร้านใช้หัวข้อ **Discord Quest Auto** พร้อมปุ่ม **เริ่มทำเควส** และ **เติมเงิน**.

ข้อความหลัก:

```text
ทำ Quest เพื่อสะสม Discord Orbs ด้วยระบบอัตโนมัติ
ค่าบริการ <ราคาปัจจุบัน> บาท / เควสสำเร็จ
ใช้ Discord Token เพื่อให้ระบบเข้าไปทำ Quest ให้โดยอัตโนมัติ
เลือก Quest ที่ต้องการ แล้วติดตามสถานะได้จนสำเร็จ
```

ราคาหน้าร้านไม่ hardcode 5 บาท. Runtime อ่าน price map ปัจจุบันจาก SQLite settings ของ Quest ทั้ง 4 task types:

- ถ้า GAME/VIDEO เท่ากัน เช่น 500 สตางค์ทั้งหมด → แสดง `5 บาท`
- ถ้าต่างกัน เช่น 500–700 สตางค์ → แสดง `5-7 บาท`
- ถ้าราคา supported TYPE ไม่ครบ → แสดง `ค่าบริการยังไม่พร้อม`

เมื่อผู้ดูแลบันทึก config ใหม่ Surface จะถูก reconcile แบบ eventual; ไม่รับประกันว่า Embed เปลี่ยนทันทีใน click เดียว.

### Thumbnail และ GIF หน้าร้านภายใน Embed

Quest Auto ใช้ GIF ที่แปลงจากวิดีโอเดโมที่ Owner ให้มาและเก็บไว้ตรงนี้:

```text
src/discord/assets/quest-auto-demo.gif
```

Source contract:

```text
Size    9,190,692 bytes
SHA-256 c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1
```

รูปอัญมณีเคลื่อนไหวขวาบนเก็บเป็น GIF:

```text
src/discord/assets/quest-auto-thumbnail.gif
Size    822,513 bytes
SHA-256 2d1e0e2c09138ac53384ac6272f4c8a9eedff28e2fe227ee06e26f7ef37a6542
```

ก่อนส่งเข้า Discord บอทตรวจ size, signature และ SHA-256 ของทั้งสองไฟล์ จากนั้น Rich Embed อ้าง GIF เคลื่อนไหว
เป็น Thumbnail ขวาบนผ่าน `attachment://quest-auto-thumbnail.gif` และอ้าง GIF เดโมด้านล่างผ่าน
`attachment://quest-auto-demo.gif` ทำให้ภาพเคลื่อนไหวอยู่ **ภายในกรอบ Embed** แทนการแสดง MP4 แยกด้านบน.

ถ้าข้อความเดิมยังมี MP4/attachment รุ่นเก่าหรือไม่มี Thumbnail ระบบจะ clear attachment เก่าแล้วแทนด้วย GIF ทั้งคู่
บน **ข้อความเดิม**.
Quest Auto ยังเอา footer เทคนิค `Questshop Surface • QUEST_AUTO` ออกจากหน้าที่ลูกค้าเห็น และใช้ stable
Discord nonce เป็นตัวช่วยกู้ anchor; footer แบบเก่ายังคงเป็น migration fallback สำหรับข้อความรุ่นก่อนเท่านั้น.

ถ้าอนาคตเปลี่ยน bytes ของ GIF อย่างตั้งใจ ควรเปลี่ยน filename/version ด้วยเพื่อให้ Discord-side drift detection
บังคับแทน attachment เดิมได้ชัดเจน.

ไฟล์ภาพต้นฉบับที่ Owner ส่งให้จัดเก็บแยกไว้ใน `assets/owner-originals/` พร้อมชื่อที่สื่อความหมาย, SHA-256 และ
ตารางจับคู่กับไฟล์ Runtime. โค้ดใช้งานเฉพาะไฟล์ใน `src/discord/assets/` ผ่าน integrity loader ไม่อ่านไฟล์ต้นฉบับ
โดยตรง.

## กฎธุรกิจหลัก

```text
Confirm Order
→ Available ลด / Reserved เพิ่มต่อ Order Item
→ Verified success: Capture ราคา snapshot
→ Definite failure / safe external completion: Release คืน Wallet
→ Ambiguous completion: Reserved คงอยู่ + Manual Review
```

- เงินใช้ integer satang (`INTEGER`) เท่านั้น
- Wallet ห้ามติดลบ; ไม่มีถอน/โอน; Refund เป็น Wallet credit
- Ledger, Admin audit และ settlement evidence เป็น append-only ตาม contract
- TrueMoney หลัง request อาจส่งสำเร็จแล้วห้าม blind retry
- Adapter ภายนอกคืนเพียง `SUCCESS`, `DEFINITE_FAILURE` หรือ `AMBIGUOUS` พร้อม evidence ที่ปลอดภัย;
  `SUCCESS` เท่านั้นที่ทำ `REDEEMED → CREDITED`, ส่วน `AMBIGUOUS` เข้า review และ `DEFINITE_FAILURE` จบโดยไม่ credit
- Manual Review จบได้ครั้งเดียวเป็น `RESOLVED_SUCCESS` หรือ `RESOLVED_FAILURE` พร้อม actor/reason/time/evidence;
  การกด resolver ซ้ำไม่สร้าง Wallet movement ซ้ำ
- Voucher เก็บ proof HMAC ตาม version และ identity HMAC คงที่ที่ unique ข้าม version เพื่อกันนำซองเดิมมายื่นซ้ำหลังหมุน version
- ผล `HTTP 2xx` + `SUCCESS` ที่ยืนยันยอด THB เป็นบวกและผู้รับหนึ่งคน จะเพิ่มเครดิตได้แม้ TrueMoney
  ไม่ส่งเลขธุรกรรม: ระบบใช้ voucher HMAC กับ Top-up ID เป็นหลักฐานภายในและบันทึกเลขธุรกรรมเป็น `NULL`
  ตามความจริง หากหลักฐานข้อใดไม่ครบจะส่ง Owner ตรวจสอบแทน
- หลังลูกค้าส่งลิงก์ซอง ระบบจะบันทึก Top-up ให้เสร็จก่อน แล้วตอบรับทันทีพร้อม Top-up ID โดยไม่รอ TrueMoney
  จากนั้นเริ่มตรวจ **เฉพาะรายการนั้น** เบื้องหลังทันทีและส่ง DM การ์ดเดียวที่แก้ข้อความเดิมตามทุกสถานะ
  ตั้งแต่กำลังตรวจจนถึงสำเร็จ ไม่สำเร็จ หรือรอ Owner ตรวจ ลูกค้าต้องเปิดรับ DM จากสมาชิกเซิร์ฟเวอร์;
  หาก DM ส่งไม่ได้ Outbox จะลองส่งใหม่ตามรอบ 1, 5, 15, 60, 300 และ 900 วินาที ก่อนบันทึก Financial DLQ
  โดยไม่กระทบเครดิต การเร่งนี้ยังใช้ lease,
  dispatch checkpoint, การยืนยัน TrueMoney และ Wallet credit ชุดเดียวกับ Worker จึงไม่ข้ามการกันเครดิตซ้ำ
- หนึ่ง Quest account มี active job ได้ไม่เกินหนึ่งงานทั่วระบบ
- Monitor ทุกบัญชีทำ Scan + Test; Monitor-discovered Quest ยัง private จน test ผ่านหรือ Admin ใช้ audited **ส่งเลย**
- customer-discovered Quest อาจถูกเสนอเฉพาะ account นั้นตาม policy โดยไม่ขึ้นกับประกาศหรือการพบใน Monitor.
  ระบบสร้าง Case ใน `LOG_QUEST_OPERATIONS`, เก็บลิงก์ Quest และค้นทุกบัญชี Monitor แบบ read-only อัตโนมัติ;
  พบแล้วจึงทดสอบ, ไม่พบจะแสดง **ตรวจและทดสอบอีกครั้ง** หรือ audited **ส่งประกาศ**. `quest-new` เป็นข่าวและห้ามระบุตัวลูกค้า

## Discord และสิทธิ์หลังบ้าน

Owner ใช้ `OWNER_ID`; Admin คนอื่นต้องมี Discord `Administrator` ณ เวลาที่กดแต่ละ interaction.
บอทตรวจ Administrator ตอน startup แต่ **ไม่** ทำ runtime permission-drift auto-repair.

ตาม Owner policy บอทไม่ตรวจ human visibility/privacy ของห้องหลังบ้าน. `LOG_PAYMENTS` อาจมี full TrueMoney voucher link;
Owner ต้องตั้ง channel visibility เอง. Discord 403 ถูกบันทึกเป็น incident แต่บอทไม่เปลี่ยน permission ให้เอง.
payload ซองที่เข้ารหัสจะถูกเก็บตาม retention 7 วัน: ลิงก์เต็มในข้อความ `LOG_PAYMENTS` เดิมยังอยู่ตามนโยบาย Owner
แต่หากข้อความนั้นสูญหายหลังครบอายุ ระบบจะกู้ได้เพียงการ์ดแบบปกปิดเท่านั้น.

Payment Log แสดงสถานะภาษาไทย, HTTP status ที่ปลอดภัย และวิธีอ้างอิงรายการโดยไม่แสดง response body, ชื่อหรือ
เบอร์ผู้ส่งจาก Provider. กรณีไม่มีเลขธุรกรรมแต่หลักฐานรับเงินครบจะแสดงว่าอ้างอิงด้วย “รหัสซองที่เข้ารหัสและ
Top-up ID”; Owner ยืนยัน Manual Review แบบนี้ได้สองครั้งและต้องใช้ยอดที่ตรงกับผล TrueMoney เท่านั้น.

`LOG_QUEST_OPERATIONS`, `LOG_ADMIN` และ `LOG_SYSTEM` แสดงคำอธิบายภาษาไทยก่อนข้อมูลเทคนิคเสมอ:
การ์ดบอกสิ่งที่เกิดขึ้น สถานะหรือผลกระทบ เหตุผลที่อ่านง่าย และปิดท้ายด้วย `ข้อมูลอ้างอิง` กับ `สรุป:`
เพื่อให้ผู้ดูแลค้นต่อในฐานข้อมูลได้โดยไม่ต้องอ่านข้อความดิบใน Discord.
`LOG_QUEST_OPERATIONS` และ `LOG_SYSTEM` ใช้แถบ `backoffice-log-banner.webp` ด้านล่าง ส่วน `LOG_ADMIN`
ใช้ `admin-log-banner.webp`; รูปขวาบนใช้ Quest artwork หรือ global Discord profileเมื่อมีข้อมูล และ `LOG_SYSTEM`
ใช้โลโก้ GIF ที่ตรวจ integrity แล้ว.

หากยังไม่ได้ตั้งค่าเบอร์รับเงิน ระบบจะไม่เดาผล TrueMoney: Top-up จะถูกส่งเข้า Manual Review โดยไม่เพิ่มเครดิตอัตโนมัติ.

## Environment Variables หลัก

| Variable | หน้าที่ |
|---|---|
| `NODE_ENV` | production ใช้ `production` |
| `DISCORD_BOT_TOKEN` | Bot secret |
| `DISCORD_CLIENT_ID` | Discord Application ID |
| `DISCORD_GUILD_ID` | Production Guild ID |
| `OWNER_ID` | Discord User ID ของ Owner |
| `SQLITE_PATH` | ไฟล์ฐานข้อมูลถาวร เช่น `/data/questshop.db` |
| `QUESTSHOP_SECRET_KEY` | Secret ถาวรอย่างน้อย 32 ตัวอักษร ใช้ตรวจ verifier/เข้ารหัส/HMAC |
| `VOUCHER_HMAC_ACTIVE_VERSION` | version ของ voucher proof HMAC (เริ่มต้น `v1`; เปลี่ยนเฉพาะ migration ที่ตรวจสอบแล้ว) |
| `GIT_SHA` | Git commit SHA 40 ตัวใน Production |
| `STATUS_TOKEN` | Bearer token ของ `/statusz`, อย่างน้อย 32 ตัวอักษร |
| `PRELAUNCH` | UAT ใช้ `true` |
| `TIMEZONE` | `Asia/Bangkok` |
| `RUNNER_CONCURRENCY` | ค่าเริ่มต้น `1` |
| `RUNNER_CONCURRENCY_HARD_MAX` | เพดานสูงสุด `1` (กำหนดได้ไม่เกิน `5`) |
| `PORT` | health server, ค่าเริ่มต้น `3000` |

ห้าม commit `.env` หรือ paste Bot/User token, database file, `QUESTSHOP_SECRET_KEY`, cookie, voucher secret หรือ private key
ลง GitHub, Discord, ticket, log หรือ screenshot.

## Deploy บน inwcloud

Runtime: **Node.js 22.x LTS**

Custom Command:

```bash
npm ci --omit=dev && npm run deploy && npm start
```

`npm run deploy` = `setup:verify → SQLite backup/migrate → register`.
ต้อง mount `/data` เป็น persistent volume เดียว และห้ามรัน process บอทซ้ำบนไฟล์เดียวกัน.

หลัง deploy ควรเห็น:

```text
setup:verify  → ok
migrate       → SQLite backup/migration/integrity: PASS
register      → Registered 8 guild commands
start         → Questshop SQLite runtime ready
```

`Questshop ready` เป็นเพียง runtime readiness ไม่ใช่หลักฐาน TrueMoney/Quest live success.

## Slash commands สำหรับ Surface

```text
/quest-auto
/quest-new
/quest-history
/admin-panel
/log-payments
/log-quest-operations
/log-admin
/log-system
```

หน้าประวัติ Quest คงรูปโปรไฟล์บัญชีไว้ขวาบน แสดง Order และสถานะเครดิตแบบย่อ โดยบรรทัด `ชื่อ Quest — ความคืบหน้า%`
กดเปิด Quest ที่ตรงรายการได้ และมีแถบสี `quest-history-banner.png` แนบอยู่ด้านล่างของทุกการ์ด

## Health endpoints

| Path | Auth | ความหมาย |
|---|---|---|
| `/livez` | ไม่ต้อง | process ยังตอบได้ |
| `/readyz` | ไม่ต้อง | runtime พร้อมรับงานหรือไม่ |
| `/statusz` | Bearer `STATUS_TOKEN` | worker/gate/incident summary แบบจำกัด |

## Source verification

ก่อนส่ง PR/release evidence ให้รันอย่างน้อย:

```bash
npm run check
npm run check:imports
npm run lint
npm test
git diff --check
```

Full gate:

```bash
npm run test:coverage
npm run load:test
npm audit --audit-level=high
git diff --check
docker build --build-arg GIT_SHA=<exact-40-character-sha> -t questshop:local .
```

tests ใช้ SQLite file ชั่วคราวเท่านั้น; ห้ามชี้ `SQLITE_PATH` ของ test หรือ load test ไป `/data/questshop.db`.

Credential encryption writes `CREDENTIAL_ENCRYPTION_ACTIVE_VERSION` and reads
only `CREDENTIAL_ENCRYPTION_ALLOWED_VERSIONS`. Use
`npm run credentials:reencrypt` for an offline locked rotation, then
`npm run verify:keys` before retiring a version; it checks both the live
database and local SQLite backups. Same-volume backups support operational
recovery only and are not disaster recovery.

The Docker gate is passed only by a real build whose `/app/.source-sha` equals
the exact candidate SHA. A missing local Docker daemon is recorded as
`NOT_RUN_LOCAL: DOCKER_DAEMON_UNAVAILABLE`; GitHub Actions supplies the build
evidence without pushing or deploying an image.

## เอกสารอ้างอิง

- [System architecture](docs/architecture/system.md)
- [Completion audit](docs/architecture/completion-audit.md)
- [Requirement traceability](docs/architecture/traceability.md)
- [Definition of Done](docs/architecture/definition-of-done.md)
- [Deploy on inwcloud](docs/deployment/inwcloud-sqlite.md)
- [State-machine contracts](docs/state-machines/contracts.md)
- [Emergency runbooks](docs/runbooks/README.md)
- [Pre-launch UAT](docs/uat/prelaunch.md)
- [Evidence template](docs/uat/evidence-template.md)
- [Security policy](SECURITY.md)
- [Engineering contract](AGENTS.md)

## Live boundaries ที่ยังต้องพิสูจน์

- Discord desktop/mobile rendering ของ `quest-auto-demo.gif` **ภายใน Embed**, panel persistence, removal of the old
  technical footer และ price refresh จริง
- TrueMoney success / ambiguous-after-send / schema drift
- Video/Desktop Quest execution กับ Discord account จริง
- inwcloud `/data` persistence, single-instance restart และ health endpoint
- Owner pre-launch closeout, rollback rehearsal และ external alert delivery

ห้ามเรียกโปรเจกต์นี้ว่า production-ready ก่อนหลักฐานเหล่านี้ผ่านบน build เดียวกัน.
