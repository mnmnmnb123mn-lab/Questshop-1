const QUEST_TYPES = Object.freeze({
  WATCH_VIDEO: 'ดูวิดีโอ',
  WATCH_VIDEO_ON_MOBILE: 'ดูวิดีโอบนมือถือ',
  PLAY_ON_DESKTOP: 'เล่นเกมบนคอมพิวเตอร์',
  PLAY_ON_DESKTOP_V2: 'เล่นเกมบนคอมพิวเตอร์',
});

const ORDER_STATES = Object.freeze({
  SELECTED: 'กำลังเตรียมรายการ',
  RESERVED: 'จองเครดิตแล้ว',
  QUEUED: 'รอคิว',
  LEASED: 'กำลังรับงาน',
  RUNNING: 'กำลังทำ Quest',
  WAITING_RATE_LIMIT: 'พักรอตามข้อจำกัดของระบบ',
  WAITING_RETRY: 'กำลังรอลองใหม่',
  VERIFYING: 'กำลังตรวจสอบผล',
  SETTLING: 'กำลังสรุปรายการ',
  READY_TO_CLAIM: 'เสร็จสมบูรณ์',
  MANUAL_REVIEW: 'รอแอดมินตรวจสอบ',
  EXPIRED_RELEASED: 'คืนเครดิตแล้ว — Quest หมดอายุก่อนเริ่ม',
  EXTERNAL_COMPLETED_RELEASED: 'คืนเครดิตแล้ว — บัญชีทำ Quest เสร็จจากที่อื่น',
  STOPPED_RELEASED: 'คืนเครดิตแล้ว — งานถูกหยุด',
  FAILED_RELEASED: 'คืนเครดิตแล้ว — ทำ Quest ไม่สำเร็จ',
});

const RESERVATION_STATES = Object.freeze({
  RESERVED: 'จองเครดิตอยู่',
  CAPTURED: 'ชำระค่าบริการแล้ว',
  RELEASED: 'คืนเครดิตแล้ว',
});

const SALE_STATES = Object.freeze({
  OPEN: 'พร้อมรับทำ',
  CLOSED: 'ยังไม่เปิดรับทั่วไป',
  PAUSED: 'พักรับชั่วคราว',
  EXPIRED: 'สิ้นสุดแล้ว',
});

const TOPUP_STATES = Object.freeze({
  RECEIVED: 'รับรายการแล้ว',
  VALIDATING: 'กำลังตรวจสอบลิงก์ซอง',
  PAYMENT_QUEUED: 'กำลังรอตรวจสอบซอง',
  PROCESSING: 'กำลังรับเงินจากซอง',
  RETRY_WAIT: 'ระบบกำลังลองตรวจสอบใหม่',
  REDEEMED: 'รับเงินจากซองแล้ว กำลังเพิ่มเครดิต',
  CREDITED: 'เติมเครดิตสำเร็จ',
  AMBIGUOUS: 'ต้องตรวจสอบผลการรับเงิน',
  MANUAL_REVIEW: 'เจ้าของร้านกำลังตรวจสอบ',
  INVALID: 'ลิงก์หรือซองไม่ถูกต้อง',
  EXPIRED: 'ซองหมดอายุแล้ว',
  ALREADY_REDEEMED: 'ซองนี้ถูกใช้ไปแล้ว',
  REJECTED: 'รายการถูกปฏิเสธ',
  FAILED: 'เติมเงินไม่สำเร็จ',
  REVERSED: 'รายการเติมเงินถูกย้อนกลับ',
});

const FEATURE_GATES = Object.freeze({
  STORE_OPEN: 'เปิดร้าน',
  CUSTOMER_INTERACTIONS_ENABLED: 'ให้ลูกค้าใช้งานแผงร้าน',
  TOPUP_ACCEPTING: 'รับรายการเติมเงิน',
  AUTO_CREDIT_ENABLED: 'เพิ่มเครดิตอัตโนมัติ',
  QUEST_SCANNER_ENABLED: 'ตรวจหา Quest ใหม่',
  QUEST_BACKGROUND_TESTING_ENABLED: 'ทดสอบ Quest อัตโนมัติ',
  QUEST_ANNOUNCEMENT_ENABLED: 'ประกาศ Quest ใหม่',
  ORDER_ACCEPTING: 'รับออเดอร์ Quest',
  RUNNER_DISPATCH_ENABLED: 'ส่งงานให้ระบบทำ Quest',
  NOTIFICATIONS_ENABLED: 'ส่งข้อความแจ้งเตือน',
  RETENTION_JOBS_ENABLED: 'ล้างข้อมูลตามอายุ',
});

const TERMINAL_REASONS = Object.freeze({
  EXECUTOR_FAILED: 'ระบบทำ Quest ไม่สำเร็จ',
  QUEST_EXPIRED: 'Quest หมดอายุก่อนเริ่มงาน',
  INSUFFICIENT_TIME: 'เวลาเหลือไม่พอสำหรับเริ่มงาน',
  EXTERNAL_COMPLETED: 'บัญชีทำ Quest นี้เสร็จจากที่อื่นแล้ว',
  ADMIN_STOPPED: 'แอดมินหยุดงานและคืนเครดิตแล้ว',
  TOKEN_INVALID: 'Token ของบัญชีใช้ทำงานต่อไม่ได้',
  VERIFICATION_FAILED: 'ระบบยืนยันผลสำเร็จไม่ได้',
  UNSUPPORTED_CONTRACT: 'รูปแบบ Quest เปลี่ยนและระบบยังไม่รองรับ',
});

function label(map, value, fallback = 'ไม่ระบุ') {
  return map[value] ?? fallback;
}

export const questTypeLabel = (value) => label(QUEST_TYPES, value, 'Quest ประเภทอื่น');
export const orderStateLabel = (value) => label(ORDER_STATES, value, 'กำลังดำเนินการ');
export const reservationStateLabel = (value) => label(RESERVATION_STATES, value, 'กำลังตรวจสอบยอด');
export const saleStateLabel = (value) => label(SALE_STATES, value, 'ยังไม่เปิดรับทั่วไป');
export const topupStateLabel = (value) => label(TOPUP_STATES, value, 'กำลังตรวจสอบรายการ');
export const featureGateLabel = (value) => label(FEATURE_GATES, value, value);
export const terminalReasonLabel = (value) => label(TERMINAL_REASONS, value, 'ระบบไม่สามารถทำ Quest นี้ต่อได้');

export function questTargetLabel(taskType, target) {
  const seconds = Math.max(0, Number(target ?? 0));
  if (!Number.isFinite(seconds) || seconds <= 0) return 'ไม่ระบุ';
  const minutes = Math.ceil(seconds / 60);
  if (taskType?.startsWith('PLAY_ON_DESKTOP')) return `เล่นประมาณ ${minutes} นาที`;
  if (taskType?.startsWith('WATCH_VIDEO')) return `ดูประมาณ ${minutes} นาที`;
  return `${minutes} นาที`;
}

export function orderStateIcon(state) {
  if (state === 'READY_TO_CLAIM') return '✅';
  if (state?.endsWith('_RELEASED')) return '↩️';
  if (state === 'MANUAL_REVIEW') return '🟠';
  return '⌛';
}
