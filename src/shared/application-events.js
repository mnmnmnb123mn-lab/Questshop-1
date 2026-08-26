import { EventEmitter } from 'node:events';

export const APPLICATION_EVENTS = Object.freeze({
  QUEST_CATEGORY_PRICE_CHANGED: 'quest-category-price-changed',
});

export const applicationEvents = new EventEmitter();
