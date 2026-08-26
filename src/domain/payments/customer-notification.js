import { enqueueProjection } from '../outbox/service.js';

// One durable customer-facing DM is owned by each Top-up. Every meaningful
// transition advances this same projection, so Discord edits the existing card
// instead of sending a stream of payment messages.
export async function enqueueCustomerTopupStatus(client, topup, context) {
  return enqueueProjection(client, {
    projectionType: 'TOPUP_STATUS_DM',
    aggregateType: 'TOPUP',
    aggregateId: topup.id,
    aggregateVersion: topup.state_version,
    surfaceKey: `DM:${topup.discord_user_id}`,
    topic: 'TOPUP_STATUS_DM',
    context,
  });
}
