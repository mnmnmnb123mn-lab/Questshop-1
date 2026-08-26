export function decodeSecretBundle(raw) {
  if (!raw) return null;
  let values;
  try {
    values = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('QUESTSHOP_SECRET_BUNDLE must be a base64url JSON object');
  }
  if (!values || Array.isArray(values) || typeof values !== 'object') {
    throw new Error('QUESTSHOP_SECRET_BUNDLE must decode to an object');
  }
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string') {
      throw new Error('QUESTSHOP_SECRET_BUNDLE contains an invalid environment entry');
    }
  }
  return values;
}
