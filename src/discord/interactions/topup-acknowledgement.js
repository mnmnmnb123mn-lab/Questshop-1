import { v7 as uuidv7 } from 'uuid';
import { safeError } from '../../shared/redaction.js';
import { processPayment } from '../../workers/payment-worker.js';
import { renderTopupAccepted } from '../renderers/checkout.js';

function needsSettlement(result) {
  return !result.idempotent || ['PAYMENT_QUEUED', 'RETRY_WAIT'].includes(result.topup.status);
}

// The interaction must acknowledge durable acceptance before settlement is
// even started.  Keeping this small boundary injectable lets the test suite
// prove a slow provider can never hold the customer's ephemeral reply open.
export async function acknowledgeTopupAndStartSettlement({ interaction, result, runtime }, {
  processPaymentFunction = processPayment,
} = {}) {
  const reply = await interaction.editReply(renderTopupAccepted(result));
  if (!needsSettlement(result)) return reply;
  void processPaymentFunction({
    holder: uuidv7(),
    env: runtime.env,
    signal: runtime.abortController?.signal,
    autoCredit: true,
    topupId: result.topup.id,
    pool: runtime.pool,
  }).catch((error) => runtime.logger?.warn?.({
    error: safeError(error), topupId: result.topup.id,
  }, 'Immediate Top-up settlement deferred to payment worker'));
  return reply;
}
