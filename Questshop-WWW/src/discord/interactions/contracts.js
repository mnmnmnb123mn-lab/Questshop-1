const CUSTOMER = 'CUSTOMER';
const ADMIN = 'ADMIN';
const OWNER = 'OWNER';

function contract(access, interaction, gates = [], response = 'REPLY') {
  return Object.freeze({ access, interaction, response, gates: Object.freeze(gates) });
}

const customer = (interaction, gates = [], response = 'REPLY') => contract(CUSTOMER, interaction, gates, response);
const admin = (interaction, response = 'REPLY') => contract(ADMIN, interaction, [], response);
const owner = (interaction, response = 'REPLY') => contract(OWNER, interaction, [], response);

// This is deliberately exhaustive. A new component route must choose its
// audience and acknowledgement shape before it can be dispatched.
export const ROUTE_CONTRACTS = Object.freeze({
  start: customer('BUTTON', ['ORDER_ACCEPTING']),
  token_open: customer('BUTTON', ['ORDER_ACCEPTING'], 'MODAL'),
  topup: customer('BUTTON', ['TOPUP_ACCEPTING']),
  payment_method: customer('STRING_SELECT', ['TOPUP_ACCEPTING'], 'MODAL'),
  voucher_submit: customer('MODAL_SUBMIT', ['TOPUP_ACCEPTING']),
  token_submit: customer('MODAL_SUBMIT', ['ORDER_ACCEPTING']),
  quest_prev: customer('BUTTON', [], 'UPDATE'), quest_next: customer('BUTTON', [], 'UPDATE'),
  quest_select: customer('STRING_SELECT', [], 'UPDATE'), quest_all: customer('BUTTON', [], 'UPDATE'),
  quest_quote: customer('BUTTON', [], 'UPDATE'), quest_back: customer('BUTTON', [], 'UPDATE'),
  quest_confirm: customer('BUTTON', ['ORDER_ACCEPTING'], 'UPDATE'),

  admin: admin('STRING_SELECT'), admin_nav: admin('STRING_SELECT', 'UPDATE'),
  wallet_adjust: admin('BUTTON'), wallet_user_pick: admin('USER_SELECT', 'MODAL'),
  wallet_user_search: admin('BUTTON', 'MODAL'), wallet_user_search_submit: admin('MODAL_SUBMIT'),
  wallet_adjust_from_search: admin('BUTTON', 'MODAL'), wallet_adjust_submit: admin('MODAL_SUBMIT'),
  wallet_adjust_confirm: admin('BUTTON', 'UPDATE'), refund_prepare: admin('BUTTON'),
  refund_item_pick: admin('STRING_SELECT', 'MODAL'), refund_prepare_submit: admin('MODAL_SUBMIT'),
  refund_confirm: admin('BUTTON', 'UPDATE'), payment_review_pick: admin('STRING_SELECT'),
  adminorder_pick: admin('STRING_SELECT'), orders_page: admin('BUTTON', 'UPDATE'),
  adminorder_review: admin('BUTTON', 'MODAL'), adminorder_review_submit: admin('MODAL_SUBMIT'),
  price_category_pick: admin('STRING_SELECT', 'MODAL'), price_category_submit: admin('MODAL_SUBMIT'),
  price_category_confirm: admin('BUTTON', 'UPDATE'), promo_set: admin('BUTTON', 'MODAL'),
  promo_set_submit: admin('MODAL_SUBMIT'), promo_set_confirm: admin('BUTTON', 'UPDATE'),
  promo_toggle: admin('BUTTON'), promo_toggle_confirm: admin('BUTTON', 'UPDATE'),
  dlq_pick: admin('STRING_SELECT'), dlq_replay: admin('BUTTON', 'MODAL'),
  dlq_replay_submit: admin('MODAL_SUBMIT'), config_concurrency: admin('BUTTON', 'MODAL'),
  config_concurrency_submit: admin('MODAL_SUBMIT'), test_fail_send: admin('BUTTON'),
  test_fail_retry: admin('BUTTON'), customer_quest_publish: admin('BUTTON'),
  customer_quest_test: admin('BUTTON'),

  topup_review_credit: owner('BUTTON', 'MODAL'), topup_review_reject: owner('BUTTON', 'MODAL'),
  topup_review_decision_submit: owner('MODAL_SUBMIT'), receiver_activate: owner('BUTTON', 'MODAL'),
  receiver_activate_submit: owner('MODAL_SUBMIT'), receiver_activate_confirm: owner('BUTTON', 'UPDATE'),
  monitor_add: owner('BUTTON', 'MODAL'), monitor_add_submit: owner('MODAL_SUBMIT'),
  monitor_check_all: owner('BUTTON'), monitor_list: owner('BUTTON', 'UPDATE'), monitor_select: owner('STRING_SELECT', 'UPDATE'),
  monitor_check_one: owner('BUTTON'), monitor_rotate: owner('BUTTON', 'MODAL'),
  monitor_rotate_submit: owner('MODAL_SUBMIT'), monitor_enable: owner('BUTTON'),
  monitor_disable: owner('BUTTON'), monitor_toggle: owner('BUTTON'),
  dlq_discard: owner('BUTTON', 'MODAL'), dlq_discard_submit: owner('MODAL_SUBMIT'),
  config_quest_role: owner('BUTTON', 'MODAL'), config_quest_role_submit: owner('MODAL_SUBMIT'),
  breaker_prepare: owner('BUTTON', 'MODAL'), breaker_submit: owner('MODAL_SUBMIT'),
});

export { ADMIN, CUSTOMER, OWNER };

export function routeContract(route) {
  if (ROUTE_CONTRACTS[route]) return ROUTE_CONTRACTS[route];
  if (route?.startsWith('admin_refresh_')) return contract(ADMIN, 'BUTTON', [], 'UPDATE');
  return null;
}

export function assertRouteContractCoverage(handlers) {
  const missing = Object.keys(handlers).filter((route) => !ROUTE_CONTRACTS[route]);
  const orphaned = Object.keys(ROUTE_CONTRACTS).filter((route) => !handlers[route]);
  if (missing.length || orphaned.length) {
    throw new Error(`Route contract mismatch: missing=${missing.join(',')} orphaned=${orphaned.join(',')}`);
  }
}
