# Owner media originals

โฟลเดอร์นี้เก็บไฟล์ต้นฉบับที่ Owner ส่งให้ เพื่อให้ตรวจย้อนกลับและเปลี่ยน Runtime asset ในอนาคตได้โดยไม่วางไฟล์
ชื่อชั่วคราวไว้ที่ root ของ repository.

ไฟล์ในโฟลเดอร์นี้เป็นหลักฐานต้นฉบับเท่านั้น Runtime ต้องอ่านไฟล์ที่ตั้งชื่อตามหน้าที่ใน
`src/discord/assets/` ผ่าน integrity loader ที่เกี่ยวข้อง ห้ามเปลี่ยนไฟล์ Runtime โดยอ้างไฟล์ต้นฉบับโดยตรง.

| ไฟล์ต้นฉบับ | รูปแบบ/ขนาด | SHA-256 | Runtime copy |
|---|---:|---|---|
| `admin-log-banner.webp` | WebP 1536×26, 2,078 bytes | `48663851e31757bff486654f26bafc04440be13af12a6768ce91ff040b5814d9` | `src/discord/assets/admin-log-banner.webp` |
| `backoffice-log-banner.webp` | WebP 1536×26, 852 bytes | `3b129f3cfb9d84a79b71cd95d3ffce017a96beed1b7c2ccc60e65f2d844b8e32` | `src/discord/assets/backoffice-log-banner.webp` |
| `payment-history-banner.png` | PNG RGB 461×8, 1,059 bytes | `42060510a8b296c6cccf8512ec376d18991665c6cdb63e6b912e2f148b08ccdb` | `src/discord/assets/payment-log-banner.png`, `src/discord/assets/quest-history-banner.png` |
| `questshop-animated-logo.gif` | GIF89a 498×498, 822,513 bytes | `2d1e0e2c09138ac53384ac6272f4c8a9eedff28e2fe227ee06e26f7ef37a6542` | `src/discord/assets/quest-auto-thumbnail.gif`, `src/discord/assets/log-system-thumbnail.gif` |

เมื่อตั้งใจเปลี่ยนภาพ ให้เก็บต้นฉบับใหม่ด้วยชื่อที่อธิบายหน้าที่ อัปเดต Runtime copy, integrity constants, tests,
changelog และ UAT พร้อมกัน. หาก Discord เคยรับ Attachment ชื่อเดิมแล้ว ควรเปลี่ยนชื่อ Runtime attachment เพื่อบังคับ
การแทนไฟล์เก่าอย่างชัดเจน.
