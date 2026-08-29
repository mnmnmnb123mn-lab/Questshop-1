import { questTypeLabel, saleStateLabel } from './labels.js';

const labels = (entries, fallback = 'ระบบยังระบุสถานะไม่ได้') => (value) => entries[value] ?? fallback;

export const analysisStateLabel = labels({
  DETECTED: 'พบข้อมูล Quest แล้ว', METADATA_RETRY: 'กำลังดึงข้อมูล Quest อีกครั้ง',
  ANALYZED: 'ตรวจข้อมูล Quest แล้ว', SUPPORTED: 'Quest นี้รองรับ', UNSUPPORTED: 'Quest นี้ยังไม่รองรับ',
  MANUAL_REVIEW: 'รอผู้ดูแลตรวจข้อมูล', EXPIRED: 'Quest หมดอายุแล้ว',
});
export const announcementStateLabel = labels({
  PENDING: 'รอประกาศ', NOT_ANNOUNCED: 'รอประกาศ', ANNOUNCED: 'ประกาศแล้ว', SKIPPED: 'ไม่ต้องประกาศ', FAILED: 'ประกาศไม่สำเร็จ',
});
export const questTestStateLabel = labels({
  TEST_QUEUED: 'รอทดสอบ', TESTING: 'กำลังทดสอบ', TEST_PASSED: 'ทดสอบผ่าน', TEST_FAILED: 'ทดสอบไม่ผ่าน',
  MANUAL_REVIEW: 'รอผู้ดูแลตรวจผลทดสอบ', RETEST_REQUIRED: 'รอทดสอบอีกครั้ง',
});
export const checkoutStateLabel = labels({ ACTIVE: 'กำลังเลือก Quest', CONFIRMED: 'สร้าง Order แล้ว', EXPIRED: 'หมดเวลาเลือก', PENDING_BIND: 'กำลังเตรียม Checkout', CANCELLED: 'ยกเลิกแล้ว', TERMINAL: 'จบรายการแล้ว' });
export const discoveryStateLabel = labels({ PENDING: 'รอผู้ดูแลตัดสินใจ', TEST_REQUESTED: 'ส่งไปทดสอบแล้ว', PUBLISHED: 'ประกาศแล้ว' });
export const runnerStateLabel = labels({
  QUEUED: 'รอเริ่มงาน', LEASED: 'กำลังรับงาน', RUNNING: 'กำลังทำ Quest', WAITING_RATE_LIMIT: 'พักรอตามข้อจำกัด Discord',
  WAITING_RETRY: 'กำลังรอลองใหม่', VERIFYING: 'กำลังตรวจสอบผล', SETTLING: 'กำลังสรุปงาน',
  MANUAL_REVIEW: 'รอผู้ดูแลตรวจ', COMPLETED: 'ทำ Quest สำเร็จ', FAILED: 'ทำ Quest ไม่สำเร็จ',
});
export const scopeLabel = labels({
  DISCORD: 'Discord', TRUEMONEY: 'การรับเงิน TrueMoney', WALLET_LEDGER: 'เครดิตและบัญชีรายการ',
  OUTBOX: 'คิวส่งข้อความ', RUNNER: 'งานอัตโนมัติ', RUNTIME: 'ระบบที่กำลังทำงาน', DATABASE: 'ฐานข้อมูล',
  CRYPTO: 'การปกป้องข้อมูลลับ', OPERATIONS: 'ระบบปฏิบัติการ', ADMIN_PANEL: 'แผงผู้ดูแล',
  QUEST_AUTO: 'หน้า Quest อัตโนมัติ', QUEST_NEW: 'หน้าประกาศ Quest ใหม่', QUEST_HISTORY: 'หน้าประวัติ Quest',
  LOG_PAYMENTS: 'บันทึกการเติมเงิน', LOG_QUEST_OPERATIONS: 'บันทึกการทำ Quest',
  LOG_ADMIN: 'บันทึกการทำงานของผู้ดูแล', LOG_SYSTEM: 'บันทึกเหตุขัดข้องของระบบ',
}, 'ส่วนของระบบที่ระบุไว้ในรหัสอ้างอิง');

export const routeLabel = (value) => ({
  PANEL_REQUEST: 'แผง Discord', CUSTOMER_INTERACTION: 'การกดใช้งานของลูกค้า',
  INTERACTION_ACK: 'การตอบรับปุ่ม Discord', OUTBOX_DELIVERY: 'การส่งข้อความ Discord',
  TOPUP_CREDIT: 'การเพิ่มเครดิตจากซอง', admin_panel: 'แผงผู้ดูแล', quest_auto: 'หน้า Quest อัตโนมัติ',
}[value] ?? (value ? 'คำขอของระบบ' : 'ไม่ระบุเส้นทาง'));

const reasons = Object.freeze({
  TEST_CONTRACT_UNSUPPORTED: 'รูปแบบ Quest นี้ยังไม่รองรับการทดสอบ', TEST_CONTRACT_CHANGED: 'รูปแบบ Quest เปลี่ยนระหว่างทดสอบ',
  MONITOR_QUEST_ALREADY_COMPLETED: 'บัญชีทดสอบทำ Quest นี้เสร็จอยู่แล้ว', TEST_MONITOR_UNAVAILABLE: 'ไม่มีบัญชีทดสอบที่พร้อมใช้งาน',
  TEST_EXPIRY_ADMISSION_FAILED: 'เวลา Quest เหลือไม่พอสำหรับการทดสอบ', TEST_WORKER_CRASH: 'งานทดสอบหยุดทำงานกะทันหัน',
  QUEST_CONTRACT_FAILURE: 'รูปแบบ Quest ใช้งานไม่ได้กับงานอัตโนมัติ', RUNNER_VERSION_INCOMPATIBLE: 'รุ่นของงานอัตโนมัติไม่ตรงกัน',
  TOKEN_INVALID: 'ข้อมูลเข้าสู่บัญชี Discord ใช้งานต่อไม่ได้', VERIFICATION_FAILED: 'ระบบยืนยันผล Quest ไม่สำเร็จ',
  EXECUTOR_FAILED: 'งานอัตโนมัติทำ Quest ไม่สำเร็จ', QUEST_EXPIRED: 'Quest หมดอายุก่อนเริ่มงาน',
  AMBIGUOUS_PROVIDER_RESULT: 'TrueMoney ตอบผลรายการไม่ชัดเจน', OWNER_REJECTED: 'ผู้ดูแลปฏิเสธรายการ',
  PAYMENT_QUEUE_STUCK: 'คิวตรวจสอบการเติมเงินค้างนานกว่าปกติ', FINANCIAL_INVARIANT: 'ยอดเครดิตและรายการบัญชีไม่สอดคล้องกัน',
});
export function reasonLabel(value) {
  if (value == null || value === '') return 'ไม่ระบุ';
  const text = String(value);
  return reasons[text] ?? (/^[A-Z0-9_]+$/.test(text) ? 'ระบบยังระบุสาเหตุไม่ได้' : text);
}
export function adminReasonLabel(value) {
  if (value == null || value === '') return 'ไม่ระบุ';
  return reasons[String(value)] ?? String(value);
}

const adminActions = Object.freeze({
  WALLET_CREDIT: 'เพิ่มเครดิตลูกค้า', WALLET_DEBIT: 'หักเครดิตลูกค้า', FEATURE_GATE_CHANGE: 'เปลี่ยนการเปิดใช้งานระบบ',
  QUEST_CATEGORY_PRICE_CHANGED: 'เปลี่ยนราคา Quest', PROMOTION_VERSION_REPLACED: 'แก้ไขโปรโมชั่น',
  PROMOTION_ENABLED: 'เปิดใช้โปรโมชั่น', PROMOTION_DISABLED: 'ปิดใช้โปรโมชั่น', RUNTIME_CONFIG_CHANGE: 'เปลี่ยนการตั้งค่าระบบ',
  ADD_MONITOR: 'เพิ่มบัญชีทดสอบ', ROTATE_MONITOR_CREDENTIAL: 'เปลี่ยนข้อมูลเข้าสู่บัญชีทดสอบ',
  MONITOR_STATE_CHANGE: 'เปลี่ยนสถานะบัญชีทดสอบ', MONITOR_HEALTH_CHECK: 'ตรวจบัญชีทดสอบ',
  QUEST_TEST_FORCE_PUBLISH: 'เปิดขาย Quest โดยไม่รอผลทดสอบ', ORDER_ITEM_REVIEW_OPENED: 'ส่งรายการ Quest ให้ผู้ดูแลตรวจ',
  CIRCUIT_BREAKER_CHANGE: 'เปลี่ยนการป้องกันงานอัตโนมัติ', ACTIVATE_RECEIVER: 'เปลี่ยนเบอร์รับเงิน',
  CUSTOMER_DISCOVERY_FORCE_PUBLISH: 'ประกาศ Quest ที่ลูกค้าพบ', CUSTOMER_DISCOVERY_TEST_REQUESTED: 'ส่ง Quest ที่ลูกค้าพบไปทดสอบ',
  DLQ_REPLAY: 'ส่งงานค้างให้ลองใหม่', DLQ_DISCARD: 'ปิดงานค้าง', TOPUP_DAILY_LOCK_CLEARED: 'ปลดล็อกการเติมเงินรายวัน',
  TOPUP_DAILY_LOCK_CREATED: 'ล็อกการเติมเงินรายวัน', TOPUP_DAILY_LOCK_EXPIRED: 'ล้างล็อกการเติมเงินที่หมดอายุ',
  MANUAL_REVIEW_ASSIGNED: 'มอบหมายรายการให้ผู้ดูแลตรวจ', MANUAL_REVIEW_EVIDENCE_ADDED: 'เพิ่มหลักฐานการตรวจ',
  MANUAL_REVIEW_RESOLVED: 'ปิดรายการตรวจสอบ', TOPUP_REVERSED: 'ย้อนรายการเติมเงิน',
  TOPUP_MANUAL_CREDIT_CONFIRMATION_PREPARED: 'เตรียมยืนยันเพิ่มเครดิตด้วยผู้ดูแล', TOPUP_REVERSAL_REVIEW_OPENED: 'ส่งรายการย้อนเงินให้ตรวจ',
  ORDER_ITEM_REFUND: 'คืนเครดิต Quest', SURFACE_SETUP: 'ตั้งค่าหน้า Discord', SURFACE_RECONCILED: 'ซ่อมข้อความหน้า Discord',
});
export const adminActionLabel = labels(adminActions, 'ผู้ดูแลดำเนินการกับระบบ');
export const adminTargetLabel = labels({
  WALLET: 'เครดิตลูกค้า', TOPUP: 'รายการเติมเงิน', FEATURE_GATE: 'การเปิดใช้งานระบบ', QUEST_PRICE_CATEGORY: 'ราคา Quest',
  PROMOTION: 'โปรโมชั่น', MONITOR: 'บัญชีทดสอบ', QUEST: 'Quest', ORDER_ITEM: 'รายการใน Order',
  CIRCUIT_BREAKER: 'การป้องกันงานอัตโนมัติ', RECEIVER: 'เบอร์รับเงิน', DLQ: 'งานค้าง', DISCORD_USER: 'ผู้ใช้ Discord',
  MANUAL_REVIEW: 'รายการตรวจสอบ', CONFIG: 'การตั้งค่าระบบ', SURFACE: 'หน้า Discord',
}, 'รายการในระบบ');

const incidents = Object.freeze({
  DISCORD_CONNECTIVITY: ['เชื่อมต่อ Discord ไม่ได้', 'ข้อความบางส่วนอาจส่งช้า', 'ระบบกำลังลองเชื่อมต่อใหม่เอง'],
  DISCORD_SURFACE_FORBIDDEN: ['ไม่มีสิทธิ์ส่งข้อความในห้อง Discord', 'หน้าที่ระบุอาจอัปเดตไม่ได้', 'ผู้ดูแลควรตรวจสิทธิ์ของบอตในห้องนี้'],
  DISCORD_SURFACE_RECONCILE_FAILED: ['ซ่อมข้อความหน้า Discord ไม่สำเร็จ', 'หน้าที่ระบุอาจไม่แสดงข้อมูลล่าสุด', 'ผู้ดูแลควรตรวจห้องหรือข้อความที่ตั้งค่าไว้'],
  OUTBOX_STUCK: ['คิวส่งข้อความ Discord ค้าง', 'ข้อความหลังบ้านอาจอัปเดตช้า', 'ระบบกำลังส่งซ้ำเอง'],
  PAYMENT_QUEUE_STUCK: ['คิวตรวจสอบการเติมเงินค้าง', 'ลูกค้าอาจรอเครดิตนานกว่าปกติ', 'ผู้ดูแลควรตรวจรายการเติมเงินและ TrueMoney'],
  TOPUP_REDEEMED_STUCK: ['รับเงินจากซองแล้วแต่เพิ่มเครดิตค้าง', 'ยอดเครดิตลูกค้าอาจยังไม่อัปเดต', 'ผู้ดูแลควรตรวจรายการก่อนเพิ่มเครดิตซ้ำ'],
  FINANCIAL_INVARIANT: ['ยอดเครดิตและบัญชีรายการไม่ตรงกัน', 'การเงินอาจได้รับผลกระทบ', 'ผู้ดูแลต้องตรวจและยืนยันยอดก่อนเปิดรับรายการต่อ'],
  PAYMENT_AMBIGUOUS: ['ผลการรับเงิน TrueMoney ไม่ชัดเจน', 'ยังไม่ควรเพิ่มเครดิตอัตโนมัติ', 'ผู้ดูแลต้องตรวจรายการกับผู้ให้บริการ'],
  FINANCIAL_DLQ: ['มีงานการเงินส่งไม่สำเร็จ', 'รายการสำคัญอาจยังไม่ถูกประมวลผล', 'ผู้ดูแลควรตรวจงานค้างก่อนส่งซ้ำ'],
  DUPLICATE_CREDIT: ['พบความเสี่ยงเพิ่มเครดิตซ้ำ', 'ยอดเครดิตลูกค้าอาจคลาดเคลื่อน', 'ผู้ดูแลต้องตรวจรายการก่อนดำเนินการต่อ'],
  PANEL_LATENCY_SLO: ['แผง Discord ตอบช้ากว่าปกติ', 'การกดใช้งานอาจรอนาน', 'ระบบกำลังเก็บข้อมูลเพื่อหาจุดที่ช้า'],
  OUTBOX_LATENCY_SLO: ['การส่งข้อความ Discord ช้ากว่าปกติ', 'ข้อความอาจมาถึงช้า', 'ระบบกำลังลองส่งตามคิว'],
  TOPUP_LATENCY_SLO: ['การเพิ่มเครดิตใช้เวลานานกว่าปกติ', 'ลูกค้าอาจรอเครดิตนาน', 'ระบบกำลังดำเนินการต่อ'],
  TOPUP_LATENCY_P99_SLO: ['มีบางรายการเติมเงินช้ามาก', 'บางลูกค้าอาจรอเครดิตนานผิดปกติ', 'ผู้ดูแลควรตรวจรายการที่ค้าง'],
  ERROR_RATE_HIGH: ['คำขอของระบบล้มเหลวมากกว่าปกติ', 'บางการใช้งานอาจไม่สำเร็จ', 'ระบบกำลังบันทึกจุดที่ล้มเหลวเพื่อให้ตรวจต่อ'],
  WORKER_HEARTBEAT_MISSING: ['งานเบื้องหลังบางตัวไม่ตอบกลับ', 'งานที่เกี่ยวข้องอาจหยุดรอ', 'ระบบกำลังตรวจการทำงานใหม่'],
  QUEUE_STUCK: ['คิวงานอัตโนมัติค้าง', 'Quest ของลูกค้าอาจเริ่มช้า', 'ผู้ดูแลควรตรวจคิวงาน'],
  RUNNER_QUEUE_STATE_MISMATCH: ['สถานะงานอัตโนมัติไม่ตรงกับคิว', 'Quest บางรายการอาจหยุดรอ', 'ผู้ดูแลควรตรวจรายการที่ระบุ'],
  RUNNER_VERSION_INCOMPATIBLE: ['รุ่นงานอัตโนมัติไม่ตรงกัน', 'ระบบหยุดส่งงานใหม่เพื่อความปลอดภัย', 'ผู้ดูแลต้องตรวจรุ่นที่ใช้งาน'],
  QUEST_CONTRACT_FAILURE: ['รูปแบบ Quest ใช้งานไม่ได้', 'Quest ที่เกี่ยวข้องอาจทำต่อไม่ได้', 'ผู้ดูแลควรหยุดขายหรือตรวจรูปแบบ Quest'],
  SECRET_DECRYPT_FAILED: ['เปิดข้อมูลลับที่เข้ารหัสไม่ได้', 'งานที่ต้องใช้ข้อมูลนั้นจะทำต่อไม่ได้', 'ผู้ดูแลต้องตรวจคีย์เข้ารหัสอย่างเร่งด่วน'],
  BACKUP_CORRUPTION: ['ไฟล์สำรองข้อมูลมีปัญหา', 'การกู้ข้อมูลอาจใช้ไม่ได้', 'ผู้ดูแลต้องตรวจไฟล์สำรองและสร้างชุดใหม่'],
  BACKUP_FAILED: ['สำรองข้อมูลไม่สำเร็จ', 'ข้อมูลใหม่อาจยังไม่มีสำเนาสำรอง', 'ผู้ดูแลควรตรวจระบบสำรองข้อมูล'],
  BACKUP_STALE: ['ข้อมูลสำรองเก่ากว่าปกติ', 'ความพร้อมกู้คืนข้อมูลลดลง', 'ผู้ดูแลควรตรวจรอบสำรองข้อมูล'],
  RESTORE_DRILL_FAILED: ['ทดสอบกู้ข้อมูลไม่สำเร็จ', 'ยังยืนยันการกู้คืนไม่ได้', 'ผู้ดูแลต้องตรวจขั้นตอนกู้ข้อมูล'],
  RESTORE_DRILL_STALE: ['ไม่ได้ทดสอบกู้ข้อมูลมานาน', 'ยังไม่ยืนยันว่ากู้ข้อมูลได้จริง', 'ผู้ดูแลควรกำหนดรอบทดสอบ'],
  MEMORY_PRESSURE: ['หน่วยความจำของระบบสูง', 'ระบบอาจตอบช้าหรือหยุดทำงาน', 'ผู้ดูแลควรตรวจทรัพยากรเครื่อง'],
  ADMIN_RETRY_RESEEDED: ['ตั้งรอบลองใหม่สำหรับงานผู้ดูแล', 'งานเดิมจะถูกดำเนินการอีกครั้ง', null],
  BACKUP_RETENTION_DELETE_FAILED: ['ลบไฟล์สำรองที่หมดอายุไม่สำเร็จ', 'พื้นที่เก็บข้อมูลอาจเพิ่มขึ้น', 'ผู้ดูแลควรตรวจพื้นที่เก็บข้อมูล'],
  BACKUP_RETENTION_FAILED: ['ดูแลอายุไฟล์สำรองไม่สำเร็จ', 'ไฟล์สำรองอาจเกินอายุที่กำหนด', 'ผู้ดูแลควรตรวจระบบสำรองข้อมูล'],
  BACKUP_TOOL_UNAVAILABLE: ['เครื่องมือสำรองข้อมูลไม่พร้อมใช้', 'ยังสำรองข้อมูลรอบนี้ไม่ได้', 'ผู้ดูแลควรตรวจเครื่องมือสำรองข้อมูล'],
  DISCORD_404: ['ไม่พบห้องหรือข้อความ Discord', 'หน้าที่ระบุอาจอัปเดตไม่ได้', 'ผู้ดูแลควรตรวจการตั้งค่าหน้า Discord'],
  DISCORD_ADMINISTRATOR_REQUIRED: ['บอต Discord มีสิทธิ์ไม่พอ', 'บางการตั้งค่าจะทำงานไม่ได้', 'ผู้ดูแลควรตรวจสิทธิ์บอต'],
  EVENT_LOOP_LAG: ['ระบบประมวลผลช้ากว่าปกติ', 'งานหลายส่วนอาจตอบช้า', 'ผู้ดูแลควรตรวจทรัพยากรเครื่อง'],
  INTERACTION_ACK_SLO: ['Discord ตอบรับการกดปุ่มช้า', 'ลูกค้าอาจเห็นการกดปุ่มล่าช้า', 'ระบบกำลังติดตามความเร็วการตอบรับ'],
  KEYRING_VERSION_MISSING: ['ไม่พบคีย์เข้ารหัสที่ต้องใช้', 'ข้อมูลลับที่เกี่ยวข้องเปิดไม่ได้', 'ผู้ดูแลต้องตรวจคีย์เข้ารหัส'],
  KEY_SENTINEL_BOOTSTRAP_REQUIRED: ['ยังไม่ได้ตั้งค่าตรวจคีย์เข้ารหัส', 'ยังยืนยันความถูกต้องของคีย์ไม่ได้', 'ผู้ดูแลต้องตั้งค่าคีย์ก่อนใช้งาน'],
  KEY_SENTINEL_MISMATCH: ['คีย์เข้ารหัสไม่ตรงกับข้อมูลที่บันทึก', 'ข้อมูลลับอาจเปิดไม่ได้', 'ผู้ดูแลต้องหยุดตรวจสอบคีย์ทันที'],
  KEY_SENTINEL_MISSING: ['ไม่พบข้อมูลตรวจคีย์เข้ารหัส', 'ยังยืนยันคีย์ที่ใช้อยู่ไม่ได้', 'ผู้ดูแลต้องตรวจการตั้งค่าคีย์'],
  KEY_SENTINEL_SET_MISMATCH: ['ชุดคีย์เข้ารหัสไม่ตรงกัน', 'ข้อมูลลับอาจเปิดไม่ได้', 'ผู้ดูแลต้องตรวจชุดคีย์ทั้งหมด'],
  MONITOR_QUARANTINED: ['บัญชีทดสอบถูกพักใช้งาน', 'การทดสอบ Quest อาจช้าลง', 'ผู้ดูแลควรตรวจบัญชีทดสอบ'],
  MONITOR_QUEST_ALREADY_COMPLETED: ['บัญชีทดสอบทำ Quest นี้เสร็จแล้ว', 'ผลทดสอบนี้ใช้ยืนยันไม่ได้', 'ระบบจะใช้บัญชีทดสอบอื่น'],
  PROVIDER_SCHEMA_CHANGED: ['รูปแบบข้อมูลจาก TrueMoney เปลี่ยน', 'ระบบอาจอ่านผลเติมเงินไม่ได้', 'ผู้ดูแลควรตรวจการเชื่อมต่อ TrueMoney'],
  SCHEDULER_LAG: ['การจัดคิวงานอัตโนมัติช้า', 'Quest ใหม่อาจเริ่มช้า', 'ระบบกำลังจัดคิวต่อ'],
  SURFACE_UNAVAILABLE: ['หน้า Discord ไม่พร้อมใช้งาน', 'ข้อมูลบนหน้านั้นอาจไม่อัปเดต', 'ผู้ดูแลควรตรวจห้อง Discord'],
  TEST_COMPLETION_NOT_VERIFIED: ['ยังยืนยันผลทดสอบ Quest ไม่ได้', 'Quest ยังไม่พร้อมเปิดขาย', 'ผู้ดูแลควรตรวจผลทดสอบ'],
  TEST_CONTRACT_CHANGED: ['รูปแบบ Quest เปลี่ยนระหว่างทดสอบ', 'ผลทดสอบเดิมใช้ต่อไม่ได้', 'ระบบจะรอข้อมูลใหม่'],
  TEST_CONTRACT_UNSUPPORTED: ['รูปแบบ Quest ยังไม่รองรับ', 'Quest นี้ยังทำอัตโนมัติไม่ได้', 'ผู้ดูแลควรหยุดขาย Quest นี้'],
  TEST_EXPIRY_ADMISSION_FAILED: ['เวลา Quest ไม่พอสำหรับทดสอบ', 'Quest นี้ยังไม่พร้อมเปิดขาย', null],
  TEST_MONITOR_UNAVAILABLE: ['ไม่มีบัญชีทดสอบพร้อมใช้', 'การทดสอบ Quest ต้องรอ', 'ผู้ดูแลควรตรวจบัญชีทดสอบ'],
  TEST_MUTATION_NOT_VERIFIED: ['ยังยืนยันการเปลี่ยนแปลง Quest ไม่ได้', 'Quest นี้ยังไม่พร้อมเปิดขาย', 'ผู้ดูแลควรตรวจผลทดสอบ'],
  TEST_QUEST_EXPIRED: ['Quest หมดอายุระหว่างทดสอบ', 'Quest นี้ไม่สามารถเปิดขายได้', null],
  TEST_QUEST_MISSING: ['ไม่พบ Quest ระหว่างทดสอบ', 'Quest นี้ไม่สามารถเปิดขายได้', 'ผู้ดูแลควรตรวจข้อมูล Quest'],
  TEST_WORKER_CRASH: ['งานทดสอบ Quest หยุดทำงาน', 'ผลทดสอบยังไม่สมบูรณ์', 'ระบบจะลองทำใหม่ตามคิว'],
  TOPUP_AMOUNT_OVER_AUTOCREDIT_LIMIT: ['ยอดเติมเงินเกินวงเงินอัตโนมัติ', 'รายการนี้รอผู้ดูแลยืนยัน', 'ผู้ดูแลควรตรวจรายการก่อนเพิ่มเครดิต'],
  QUEST_ENTRY_INVALID: ['ข้อมูล Quest ไม่ครบหรือไม่ถูกต้อง', 'Quest นี้ยังประมวลผลต่อไม่ได้', 'ผู้ดูแลควรตรวจข้อมูล Quest'],
  QUEST_PAYLOAD_NOT_ARRAY: ['ข้อมูลรายการ Quest มีรูปแบบไม่ถูกต้อง', 'ระบบยังอ่านรายการ Quest ไม่ได้', 'ผู้ดูแลควรตรวจการเชื่อมต่อ Discord'],
  SCHEMA_MIGRATION_CHECKSUM_MISMATCH: ['โครงสร้างฐานข้อมูลไม่ตรงกับชุดติดตั้ง', 'ระบบอาจใช้ข้อมูลผิดรุ่น', 'ผู้ดูแลต้องหยุดตรวจชุดติดตั้งก่อนใช้งาน'],
  STARTUP_ABORTED: ['ระบบเริ่มทำงานไม่สำเร็จ', 'บริการอาจยังไม่พร้อมใช้งาน', 'ผู้ดูแลควรตรวจบันทึกการเริ่มระบบ'],
});
export function incidentDefinition(code) {
  const [title, impact, guidance] = incidents[code] ?? ['ระบบพบเหตุที่ยังระบุรายละเอียดไม่ได้', 'อาจมีผลต่อส่วนที่ระบุด้านล่าง', null];
  return { title, impact, guidance };
}

export { questTypeLabel, saleStateLabel };
