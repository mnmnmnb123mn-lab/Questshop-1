/**
 * External mutations are deliberately reduced to three business outcomes.
 * Adapter-specific status codes remain evidence; callers must never infer a
 * successful settlement merely because a request did not throw.
 */
export const EXTERNAL_OUTCOME = Object.freeze({
  SUCCESS: 'SUCCESS',
  DEFINITE_FAILURE: 'DEFINITE_FAILURE',
  AMBIGUOUS: 'AMBIGUOUS',
});

export function externalOutcome({ outcome, providerReference = null, reason = null, evidence = {} } = {}) {
  if (!Object.values(EXTERNAL_OUTCOME).includes(outcome)) throw new TypeError('Invalid external outcome');
  return Object.freeze({ outcome, providerReference, reason, evidence: evidence && typeof evidence === 'object' ? evidence : {} });
}
