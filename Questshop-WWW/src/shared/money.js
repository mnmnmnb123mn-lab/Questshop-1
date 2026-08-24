const DECIMAL_MONEY = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;

export function parseBahtToCents(value) {
  const text = String(value).trim();
  const match = DECIMAL_MONEY.exec(text);
  if (!match) throw new TypeError('invalid THB decimal amount');
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0'));
  const cents = whole * 100n + fraction;
  if (cents > 9_000_000_000_000_000n) throw new RangeError('money amount is too large');
  return cents;
}

export function formatCents(cents) {
  const amount = BigInt(cents);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

export function percentageBonusHalfUp(principalCents, basisPoints) {
  const principal = BigInt(principalCents);
  const bps = BigInt(basisPoints);
  if (principal < 0n || bps < 0n) throw new RangeError('bonus inputs must be non-negative');
  return (principal * bps + 5_000n) / 10_000n;
}

export function sumCents(values) {
  return values.reduce((total, value) => total + BigInt(value), 0n);
}

