const CUSTOMER = 'CUSTOMER';
const ADMIN = 'ADMIN';

function contract(access, interaction, gates = [], response = 'REPLY') {
  return Object.freeze({ access, interaction, response, gates: Object.freeze(gates) });
}

const customer = (interaction, gates = [], response = 'REPLY') => contract(CUSTOMER, interaction, gates, response);
const admin = (interaction, response = 'REPLY') => contract(ADMIN, interaction, [], response);

// This is the executable contract for every persistent component emitted by
// the SQLite router. An unknown custom id is never routed merely because it
// has a syntactically valid UUID.
export const ROUTE_CONTRACTS = Object.freeze({
  start: customer('BUTTON', ['ORDER_ACCEPTING'], 'MODAL'),
  topup: customer('BUTTON', ['TOPUP_ACCEPTING'], 'MODAL'),
  voucher_submit: customer('MODAL_SUBMIT', ['TOPUP_ACCEPTING']),
  token_submit: customer('MODAL_SUBMIT', ['ORDER_ACCEPTING']),
  checkout_open: customer('BUTTON', ['ORDER_ACCEPTING']),
  checkout_page_previous: customer('BUTTON', ['ORDER_ACCEPTING'], 'UPDATE'),
  checkout_page_next: customer('BUTTON', ['ORDER_ACCEPTING'], 'UPDATE'),
  checkout_select: customer('STRING_SELECT', ['ORDER_ACCEPTING'], 'UPDATE'),
  checkout_confirm: customer('BUTTON', ['ORDER_ACCEPTING'], 'UPDATE'),

  admin: admin('STRING_SELECT'),
  admin_gate_toggle: admin('BUTTON', 'UPDATE'),
  admin_price_edit: admin('BUTTON', 'MODAL'),
  admin_price_submit: admin('MODAL_SUBMIT'),
  admin_receiver_edit: admin('BUTTON', 'MODAL'),
  admin_receiver_submit: admin('MODAL_SUBMIT'),
  admin_monitor_add: admin('BUTTON', 'MODAL'),
  admin_monitor_submit: admin('MODAL_SUBMIT'),
  admin_monitor_scan: admin('BUTTON', 'UPDATE'),
  admin_wallet_adjust: admin('BUTTON', 'MODAL'),
  admin_wallet_submit: admin('MODAL_SUBMIT'),
  admin_promotion_edit: admin('BUTTON', 'MODAL'),
  admin_promotion_submit: admin('MODAL_SUBMIT'),
  admin_review_select: admin('STRING_SELECT'),
  admin_review_decide: admin('BUTTON', 'MODAL'),
  admin_review_submit: admin('MODAL_SUBMIT'),
  admin_dlq_select: admin('STRING_SELECT'),
  admin_dlq_retry: admin('BUTTON', 'UPDATE'),
  customer_quest_case_retry: admin('BUTTON'),
  customer_quest_announce: admin('BUTTON'),
});

export { ADMIN, CUSTOMER };

export function routeContract(route) {
  return ROUTE_CONTRACTS[route] ?? null;
}

export function assertRouteContractCoverage(handlers) {
  const handlerRoutes = Object.keys(handlers);
  const missing = handlerRoutes.filter((route) => !ROUTE_CONTRACTS[route]);
  const orphaned = Object.keys(ROUTE_CONTRACTS).filter((route) => !handlers[route]);
  if (missing.length || orphaned.length) {
    throw new Error(`Route contract mismatch: missing=${missing.join(',')} orphaned=${orphaned.join(',')}`);
  }
}
