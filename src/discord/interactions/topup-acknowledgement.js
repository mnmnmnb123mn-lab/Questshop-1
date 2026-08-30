import { safeError } from '../../shared/redaction.js';
function acceptedPayload(topup, duplicate) {
  const stamp = `<t:${Math.floor(Number(topup.created_at) / 1000)}:F>`;
  return {
    content: [
      duplicate ? '📨 พบรายการเติมเงินเดิม' : '📨 รับรายการเติมเงินแล้ว', '',
      duplicate ? 'ระบบจะใช้รายการเดิมต่อให้ คุณไม่ต้องส่งซองเดิมซ้ำ' : 'ระบบบันทึกรายการแล้ว กำลังตรวจสอบซองกับ TrueMoney',
      'ระบบจะแจ้งความคืบหน้าทางข้อความส่วนตัว (DM)', '',
      `Top-up ID: \`${topup.id}\``,
      `สถานะ: ${topup.status === 'CREDITED' ? 'เติมเครดิตสำเร็จ' : 'รอตรวจสอบ'}`,
      `ส่งรายการเมื่อ: ${stamp}`, '', 'โปรดเปิดรับข้อความส่วนตัวจากสมาชิกเซิร์ฟเวอร์',
    ].join('\n'),
    embeds: [], components: [], allowedMentions: { parse: [] },
  };
}

// The interaction must acknowledge durable acceptance before settlement is
// even started.  Keeping this small boundary injectable lets the test suite
// prove a slow provider can never hold the customer's ephemeral reply open.
export async function acknowledgeTopupAndStartSettlement({ interaction, result, runtime }, {
  settle = runtime.workers?.processTopupNow?.bind(runtime.workers),
} = {}) {
  const reply = await interaction.editReply(acceptedPayload(result.topup, result.idempotent));
  if (result.idempotent || !settle) return reply;
  void settle(result.topup.id).catch((error) => runtime.logger?.warn?.({
    error: safeError(error), topupId: result.topup.id,
  }, 'Immediate Top-up settlement deferred to payment worker'));
  return reply;
}

export { acceptedPayload as renderTopupAcceptedAcknowledgement };
