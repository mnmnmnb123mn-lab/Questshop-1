import { QUEST_PRICE_CATEGORIES, questPriceCategoryForTaskType } from './categories.js';

const QUEST_TASK_TYPES = Object.freeze(Object.values(QUEST_PRICE_CATEGORIES).flat());

export async function resolvePrice(client, { taskType }) {
  if (!questPriceCategoryForTaskType(taskType)) return null;
  const result = await client.query(`
    SELECT * FROM price_rules
    WHERE enabled = true
      AND rule_type = 'TYPE'
      AND task_type = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [taskType]);
  return result.rows[0] ?? null;
}

export async function configuredQuestPriceRange(client) {
  const result = await client.query(`
    SELECT min(amount_cents)::bigint AS min_cents,
      max(amount_cents)::bigint AS max_cents,
      count(DISTINCT task_type)::integer AS task_type_count
    FROM price_rules
    WHERE enabled = true
      AND rule_type = 'TYPE'
      AND task_type = ANY($1::text[])
  `, [QUEST_TASK_TYPES]);
  const row = result.rows[0];
  if (row?.min_cents == null || row?.max_cents == null
    || Number(row.task_type_count) !== QUEST_TASK_TYPES.length) return null;
  return { minCents: BigInt(row.min_cents), maxCents: BigInt(row.max_cents) };
}

export async function minimumSellablePrice(client) {
  const result = await client.query(`
    SELECT min(resolved.amount_cents)::bigint AS amount_cents
    FROM quests q
    CROSS JOIN LATERAL (
      SELECT p.amount_cents
      FROM price_rules p
      WHERE p.enabled = true
        AND p.rule_type='TYPE' AND p.task_type=q.task_type
      ORDER BY p.created_at DESC LIMIT 1
    ) resolved
    WHERE q.sale_state = 'OPEN' AND q.expires_at > clock_timestamp()
      AND q.task_type IN ('PLAY_ON_DESKTOP','PLAY_ON_DESKTOP_V2','WATCH_VIDEO','WATCH_VIDEO_ON_MOBILE')
  `);
  return result.rows[0]?.amount_cents ?? null;
}

export async function minimumConfiguredPrice(client) {
  const result = await client.query(`SELECT min(amount_cents)::bigint AS amount_cents
    FROM price_rules WHERE enabled=true AND rule_type='TYPE'
      AND task_type IN ('PLAY_ON_DESKTOP','PLAY_ON_DESKTOP_V2','WATCH_VIDEO','WATCH_VIDEO_ON_MOBILE')`);
  return result.rows[0]?.amount_cents ?? null;
}
