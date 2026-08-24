export const QUEST_PRICE_CATEGORIES = Object.freeze({
  GAME: Object.freeze(['PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2']),
  VIDEO: Object.freeze(['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']),
});

export const DEFAULT_QUEST_PRICE_CENTS = 500n;

const CATEGORY_BY_TASK_TYPE = new Map(
  Object.entries(QUEST_PRICE_CATEGORIES).flatMap(([category, taskTypes]) => (
    taskTypes.map((taskType) => [taskType, category])
  )),
);

export function assertQuestPriceCategory(category) {
  const normalized = String(category ?? '').trim().toUpperCase();
  if (!Object.hasOwn(QUEST_PRICE_CATEGORIES, normalized)) {
    throw new TypeError('invalid Quest price category');
  }
  return normalized;
}

export function questPriceCategoryForTaskType(taskType) {
  return CATEGORY_BY_TASK_TYPE.get(String(taskType ?? '').trim().toUpperCase()) ?? null;
}

export function taskTypesForQuestPriceCategory(category) {
  return QUEST_PRICE_CATEGORIES[assertQuestPriceCategory(category)];
}
