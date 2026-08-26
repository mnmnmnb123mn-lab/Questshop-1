import https from 'node:https';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseBahtToCents } from '../../shared/money.js';
import { QuestshopError } from '../../shared/errors.js';

const VOUCHER_CODE = /^[A-Za-z0-9]{16,128}$/;
const MAX_RESPONSE_BYTES = 256 * 1024;
const PROVIDER_HOST = 'gift.truemoney.com';

// TrueMoney uses a different envelope when a voucher cannot be redeemed.  In
// particular, real error responses may have `data: null` or omit it entirely.
// Validate the status first, then apply the stricter success contract only to
// a response that claims SUCCESS.
const statusEnvelopeSchema = z.object({
  status: z.object({
    code: z.string().min(1).max(100),
  }),
}).passthrough();

const successResponseSchema = statusEnvelopeSchema.extend({
  data: z.object({
    my_ticket: z.object({
      amount_baht: z.string().regex(/^(0|[1-9]\d*)(?:\.\d{1,2})?$/),
      transaction_id: z.union([z.string(), z.number()]).nullable().optional(),
    }).optional(),
    owner_profile: z.object({
      full_name: z.string().optional(),
      mobile: z.string().optional(),
    }).optional(),
    voucher: z.object({
      member: z.number().int().optional(),
      available: z.number().int().optional(),
    }).optional(),
  }).passthrough(),
}).passthrough();

export function normalizeVoucherUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) {
    throw new QuestshopError('INVALID_VOUCHER_URL', 'รูปแบบลิงก์ซองไม่ถูกต้อง');
  }
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new QuestshopError('INVALID_VOUCHER_URL', 'รูปแบบลิงก์ซองไม่ถูกต้อง');
  }
  if (url.protocol !== 'https:' || url.hostname !== PROVIDER_HOST || !['/campaign', '/campaign/'].includes(url.pathname)) {
    throw new QuestshopError('INVALID_VOUCHER_URL', 'รองรับเฉพาะลิงก์ซอง TrueMoney ที่ถูกต้อง');
  }
  const params = [...url.searchParams.keys()];
  const code = url.searchParams.get('v');
  if (params.length !== 1 || params[0] !== 'v' || !VOUCHER_CODE.test(code ?? '')) {
    throw new QuestshopError('INVALID_VOUCHER_CODE', 'ไม่พบรหัสซองที่ถูกต้อง');
  }
  return { code, url: `https://${PROVIDER_HOST}/campaign/?v=${code}` };
}

function singleRecipientConfirmed(data) {
  const member = data?.voucher?.member;
  const available = data?.voucher?.available;
  // `member` is the stronger recipient-count signal when the provider returns
  // it. `available` remains a backwards-compatible fallback for payloads that
  // omit member; do not require both fields to have identical post-redeem semantics.
  if (member != null) return member === 1;
  return available === 1;
}

function successfulHttpStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function providerSchemaError(code, message, options = {}) {
  return new QuestshopError(code, message, { category: 'PROVIDER_SCHEMA', ...options });
}

function ambiguousProviderError(code, message, options = {}) {
  return new QuestshopError(code, message, { category: 'AMBIGUOUS', ...options });
}

function normalizeProviderTransactionId(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw providerSchemaError('PROVIDER_TRANSACTION_ID_UNSAFE', 'TrueMoney returned an unsafe numeric transaction id');
    }
    return String(value);
  }
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 200) {
    throw providerSchemaError('PROVIDER_TRANSACTION_ID_INVALID', 'TrueMoney returned an invalid transaction id');
  }
  return normalized;
}

function mapProviderFailure(parsed, httpStatus) {
  const code = parsed?.status?.code ?? 'SCHEMA_INCOMPATIBLE';
  const terminal = {
    VOUCHER_OUT_OF_STOCK: 'ALREADY_REDEEMED',
    VOUCHER_EXPIRED: 'EXPIRED',
    VOUCHER_NOT_FOUND: 'INVALID',
    CANNOT_GET_OWN_VOUCHER: 'INVALID',
  }[code];
  if (terminal) return { outcome: terminal, providerCode: code, httpStatus };
  if (code === 'RATE_LIMIT') return { outcome: 'RETRY_WAIT', providerCode: code, httpStatus };
  return { outcome: 'AMBIGUOUS', providerCode: code, httpStatus };
}

function safeHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function safeContentType(headers) {
  const value = Array.isArray(headers?.['content-type']) ? headers['content-type'][0] : headers?.['content-type'];
  const mediaType = typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType) ? mediaType : null;
}

function safeTopLevelKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => /^[A-Za-z0-9_]{1,64}$/.test(key)).slice(0, 12);
}

function safeProviderCode(value) {
  return typeof value === 'string' && /^[A-Z0-9_]{1,100}$/.test(value) ? value : null;
}

function providerDiagnostics(response, body, raw = null) {
  return {
    httpStatus: safeHttpStatus(response.statusCode),
    contentType: safeContentType(response.headers),
    bodyLength: body.length,
    bodySha256: createHash('sha256').update(body).digest('hex'),
    topLevelKeys: safeTopLevelKeys(raw),
    providerCode: safeProviderCode(raw?.status?.code),
  };
}

export async function redeemVoucher({
  code,
  receiverPhone,
  signal,
  onDispatchCheckpoint,
  // Kept temporarily for adapter callers that have not yet migrated. The
  // callback is now a pre-dispatch durable checkpoint, not a `finish` hook.
  onPossiblySent,
  requestFactory = https.request,
}) {
  if (!VOUCHER_CODE.test(code)) throw new TypeError('invalid voucher code');
  if (!/^0\d{9}$/.test(receiverPhone)) throw new TypeError('invalid receiver phone');
  const body = Buffer.from(JSON.stringify({ mobile: receiverPhone, voucher_hash: code }));
  const checkpoint = onDispatchCheckpoint ?? onPossiblySent ?? (() => {});
  return new Promise((resolve, reject) => {
    let settled = false;
    let dispatchStarted = false;
    let request;
    const failRequest = (cause) => {
      if (settled) return;
      settled = true;
      reject(new QuestshopError(
        dispatchStarted ? 'PROVIDER_RESULT_AMBIGUOUS' : 'PROVIDER_NOT_SENT',
        dispatchStarted ? 'TrueMoney result is ambiguous after request dispatch' : 'TrueMoney request was not sent',
        { category: dispatchStarted ? 'AMBIGUOUS' : 'NETWORK', retryable: !dispatchStarted, cause },
      ));
    };
    try {
      request = requestFactory({
      protocol: 'https:',
      hostname: PROVIDER_HOST,
      port: 443,
      path: `/campaign/vouchers/${encodeURIComponent(code)}/redeem`,
      method: 'POST',
      timeout: 15_000,
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        origin: `https://${PROVIDER_HOST}`,
        referer: `https://${PROVIDER_HOST}/campaign/?v=${code}`,
        'user-agent': 'Questshop/1.0',
      },
    }, (response) => {
      const chunks = [];
      let length = 0;
      const failResponseStream = (cause) => {
        if (settled) return;
        settled = true;
        reject(ambiguousProviderError('PROVIDER_RESULT_AMBIGUOUS',
          'TrueMoney response ended before a trustworthy result was available', { cause }));
      };
      response.once('aborted', () => failResponseStream(new Error('provider response aborted')));
      response.once('error', failResponseStream);
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) {
          request.destroy(new QuestshopError('PROVIDER_RESPONSE_TOO_LARGE', 'TrueMoney response exceeded limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', async () => {
        if (settled) return;
        settled = true;
        const httpOk = successfulHttpStatus(response.statusCode);
        const responseBody = Buffer.concat(chunks);
        let raw;
        try {
          raw = JSON.parse(responseBody.toString('utf8'));
        } catch (cause) {
          const diagnostics = providerDiagnostics(response, responseBody);
          reject(httpOk
            ? providerSchemaError('PROVIDER_SCHEMA_INCOMPATIBLE', 'TrueMoney response is not valid JSON', {
              cause, details: diagnostics,
            })
            : ambiguousProviderError('PROVIDER_HTTP_AMBIGUOUS',
              `TrueMoney returned HTTP ${response.statusCode ?? 'unknown'} with an unreadable body`, {
                cause, details: diagnostics,
              }));
          return;
        }
        const diagnostics = providerDiagnostics(response, responseBody, raw);
        const envelope = statusEnvelopeSchema.safeParse(raw);
        if (!envelope.success) {
          reject(httpOk
            ? providerSchemaError('PROVIDER_SCHEMA_INCOMPATIBLE', 'TrueMoney response schema changed', {
              details: diagnostics,
            })
            : ambiguousProviderError('PROVIDER_HTTP_AMBIGUOUS',
              `TrueMoney returned HTTP ${response.statusCode ?? 'unknown'} with an incompatible body`, {
                details: diagnostics,
              }));
          return;
        }
        if (envelope.data.status.code !== 'SUCCESS') {
          resolve({ ...mapProviderFailure(envelope.data, response.statusCode), providerEvidence: diagnostics });
          return;
        }
        if (!httpOk) {
          reject(ambiguousProviderError('PROVIDER_HTTP_INCONSISTENT',
            `TrueMoney reported SUCCESS with HTTP ${response.statusCode ?? 'unknown'}`, {
              details: { httpStatus: response.statusCode ?? null },
            }));
          return;
        }
        const parsed = successResponseSchema.safeParse(raw);
        if (!parsed.success) {
          reject(providerSchemaError('PROVIDER_SCHEMA_INCOMPATIBLE', 'TrueMoney success response schema changed', {
            details: diagnostics,
          }));
          return;
        }
        if (!parsed.data.data?.my_ticket || !singleRecipientConfirmed(parsed.data.data)) {
          reject(providerSchemaError('PROVIDER_CONFIRMATION_INCOMPLETE',
            'Amount or single-recipient confirmation is missing or contradictory', { details: diagnostics }));
          return;
        }
        let amountCents;
        let providerTransactionId;
        try {
          amountCents = parseBahtToCents(parsed.data.data.my_ticket.amount_baht);
          if (amountCents <= 0) throw new TypeError('amount must be positive');
          providerTransactionId = normalizeProviderTransactionId(parsed.data.data.my_ticket.transaction_id);
        } catch (cause) {
          if (cause instanceof QuestshopError) {
            reject(cause);
            return;
          }
          reject(providerSchemaError('PROVIDER_AMOUNT_INVALID', 'TrueMoney returned an invalid amount', { cause, details: diagnostics }));
          return;
        }
        resolve({
          outcome: 'REDEEMED',
          amountCents,
          currency: 'THB',
          senderName: parsed.data.data.owner_profile?.full_name ?? null,
          senderPhone: parsed.data.data.owner_profile?.mobile ?? null,
          providerCode: 'SUCCESS',
          httpStatus: response.statusCode,
          receiverConfirmation: 'REQUEST_BOUND_SUCCESS',
          providerTransactionId,
          providerEvidence: {
            ...diagnostics,
            receiverConfirmation: 'REQUEST_BOUND_SUCCESS',
            settlementIdentity: providerTransactionId ? 'PROVIDER_TRANSACTION_ID' : 'VOUCHER_HMAC',
            providerTransactionIdPresent: providerTransactionId != null,
          },
        });
      });
      });
    } catch (cause) {
      failRequest(cause);
      return;
    }
    request.once('timeout', () => request.destroy(new Error('provider timeout')));
    request.once('error', failRequest);
    if (signal) {
      const abort = () => request.destroy(new DOMException('Aborted', 'AbortError'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    // `request.end()` is the dispatch boundary. Persist the intent before it
    // runs; any later socket/timeout/response failure is deliberately
    // ambiguous and must never trigger an automatic second redemption.
    Promise.resolve().then(checkpoint).then(() => {
      if (settled) return;
      dispatchStarted = true;
      try {
        request.end(body);
      } catch (cause) {
        failRequest(cause);
      }
    }).catch((cause) => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new QuestshopError('PAYMENT_INTENT_CHECKPOINT_FAILED',
        'ไม่สามารถบันทึก Payment intent ก่อนส่งคำขอ TrueMoney', {
          category: 'NETWORK', retryable: true, cause,
        }));
    });
  });
}
