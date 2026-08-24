import { randomInt } from 'node:crypto';

/**
 * Returns a bounded, cryptographically strong jitter value.  Jitter does not
 * decide any business outcome, but using the platform CSPRNG keeps retry and
 * scheduling paths free of predictable pseudo-randomness.
 */
export function secureJitter(maxExclusive) {
  const bound = Math.max(1, Math.ceil(Number(maxExclusive) || 0));
  return randomInt(0, bound);
}
