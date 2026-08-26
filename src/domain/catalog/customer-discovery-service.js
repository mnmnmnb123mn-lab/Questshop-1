import { withTransaction } from '../../db/transaction.js';
import { QuestshopError } from '../../shared/errors.js';
import {
  queueCustomerDiscoveryAnnouncement,
  retryCustomerDiscoveryCase,
} from './customer-discovery-case-service.js';

// This loader remains for Discord messages produced before Discovery Cases.
// Legacy buttons are deliberately aliases to the Case workflow below: an
// announcement is informational and can never open public sale or bypass a
// Monitor test gate.
export async function loadCustomerQuestDiscovery(client, discoveryId, { messageId = null } = {}) {
  const discovery = (await client.query(`SELECT d.*,p.message_id,p.surface_key
    FROM customer_quest_discoveries d
    LEFT JOIN message_projections p ON p.projection_type='CUSTOMER_QUEST_DISCOVERY'
      AND p.aggregate_id=d.id::text AND p.surface_key='LOG_QUEST_OPERATIONS'
    WHERE d.id=$1`, [discoveryId])).rows[0];
  if (!discovery || (messageId && discovery.message_id !== messageId)) return null;
  return discovery;
}

async function loadCaseIdForLegacyDiscovery(discoveryId, options) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, async (client) => {
    const discovery = (await client.query(`SELECT d.*,c.id AS case_id
      FROM customer_quest_discoveries d
      LEFT JOIN customer_quest_discovery_cases c ON c.quest_id=d.quest_id
      WHERE d.id=$1`, [discoveryId])).rows[0];
    if (!discovery) throw new QuestshopError('CUSTOMER_DISCOVERY_NOT_FOUND', 'ไม่พบรายการ Quest ที่พบจากลูกค้า');
    if (!discovery.case_id) throw new QuestshopError('CUSTOMER_DISCOVERY_CASE_NOT_FOUND',
      'รายการเก่านี้ยังไม่มี Case ใหม่ กรุณารอการตรวจครั้งถัดไป');
    return discovery;
  });
}

export async function publishCustomerDiscoveredQuest({ discoveryId }, context, options = {}) {
  const discovery = await loadCaseIdForLegacyDiscovery(discoveryId, options);
  const result = await queueCustomerDiscoveryAnnouncement({ caseId: discovery.case_id }, context, options);
  return { discovery, caseRow: result.caseRow, idempotent: result.idempotent };
}

export async function requestCustomerDiscoveryTest({ discoveryId }, context, options = {}) {
  const discovery = await loadCaseIdForLegacyDiscovery(discoveryId, options);
  const result = await retryCustomerDiscoveryCase({ caseId: discovery.case_id }, context, options);
  return { discovery, batchId: result.batchId, idempotent: result.reused };
}
