import { questPriceCategoryForTaskType } from '../pricing/categories.js';

const SUPPORTED_TASKS = Object.freeze([
  'PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2', 'WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE',
]);

function asPositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * Settings deliberately hold only the current price map.  Order items hold a
 * price snapshot, so later price changes never alter money already reserved.
 * Accept the two owner-config shapes used by prior releases while keeping the
 * persisted runtime contract small.
 */
export function priceForQuest(configValues = {}, taskType) {
  const type = String(taskType ?? '').toUpperCase();
  if (!SUPPORTED_TASKS.includes(type) || !questPriceCategoryForTaskType(type)) return null;
  const source = configValues.priceRules ?? configValues.prices ?? {};
  const direct = source[type] ?? source[type.toLowerCase()];
  const category = questPriceCategoryForTaskType(type);
  const candidate = direct?.amountCents ?? direct ?? source[category]?.amountCents ?? source[category];
  return asPositiveInteger(candidate);
}

export function configuredPriceRange(configValues = {}) {
  const prices = SUPPORTED_TASKS.map((taskType) => priceForQuest(configValues, taskType));
  if (prices.some((price) => price == null)) return null;
  return { minCents: Math.min(...prices), maxCents: Math.max(...prices) };
}

export function supportedTaskTypes() { return [...SUPPORTED_TASKS]; }
