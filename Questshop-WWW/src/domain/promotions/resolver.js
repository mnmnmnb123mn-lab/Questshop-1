import { percentageBonusHalfUp } from '../../shared/money.js';

export async function resolvePromotionBonus(client, {
  promotionId,
  discordUserId,
  principalCents,
  bangkokDay,
}) {
  if (!promotionId) return { bonusCents: 0n, tierId: null, eligible: false };
  const promotion = (await client.query(`
    SELECT * FROM promotions WHERE id = $1 FOR UPDATE
  `, [promotionId])).rows[0];
  if (!promotion) return { bonusCents: 0n, tierId: null, eligible: false };

  const usage = (await client.query(`
    SELECT count(*)::integer AS uses,
      COALESCE(sum(bonus_cents) FILTER (WHERE bangkok_day = $3), 0)::bigint AS daily_bonus
    FROM promotion_usages
    WHERE promotion_id = $1 AND discord_user_id = $2
  `, [promotionId, discordUserId, bangkokDay])).rows[0];
  if (promotion.max_uses_per_user != null && usage.uses >= promotion.max_uses_per_user) {
    return { bonusCents: 0n, tierId: null, eligible: false, reason: 'USER_LIMIT' };
  }
  const tier = (await client.query(`
    SELECT * FROM promotion_tiers
    WHERE promotion_id = $1 AND minimum_amount_cents <= $2
    ORDER BY minimum_amount_cents DESC LIMIT 1
  `, [promotionId, principalCents])).rows[0];
  if (!tier) return { bonusCents: 0n, tierId: null, eligible: false, reason: 'NO_TIER' };
  let bonusCents = percentageBonusHalfUp(principalCents, tier.basis_points);
  if (promotion.max_bonus_per_day_cents != null) {
    const remaining = BigInt(promotion.max_bonus_per_day_cents) - BigInt(usage.daily_bonus);
    if (remaining <= 0n) return { bonusCents: 0n, tierId: tier.id, eligible: false, reason: 'DAILY_CAP' };
    if (bonusCents > remaining) bonusCents = remaining;
  }
  return { bonusCents, tierId: tier.id, eligible: true };
}
