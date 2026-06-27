// CryptoBot "Crypto Pay" API client + webhook signature verification.
// Workers runtime only: global fetch + crypto.subtle (NO node:crypto).
// Docs: https://help.crypt.bot/crypto-pay-api

import { type Env } from '../config';

const PAID_TIERS = ['monthly', 'quarterly', 'lifetime'] as const;
type PaidTier = (typeof PAID_TIERS)[number];

interface CreateInvoiceEnvelope {
  ok?: boolean;
  error?: unknown;
  result?: {
    invoice_id: number | string;
    bot_invoice_url?: string;
    pay_url?: string;
    mini_app_invoice_url?: string;
  };
}

/**
 * Create a USDT invoice for a VIP tier. Returns the invoice id + a pay URL.
 * `payload` encodes `${telegramId}|${tier}` so the webhook can route the grant.
 */
export async function createInvoice(
  env: Env,
  telegramId: number,
  tier: PaidTier,
  amount: number,
): Promise<{ invoiceId: string; payUrl: string }> {
  const apiBase = env.CRYPTOPAY_API_BASE || 'https://pay.crypt.bot';
  const res = await fetch(`${apiBase}/api/createInvoice`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Crypto-Pay-API-Token': env.CRYPTOPAY_TOKEN,
    },
    body: JSON.stringify({
      asset: 'USDT',
      amount: String(amount),
      description: `Lifechange Crypto VIP — ${tier}`,
      payload: `${telegramId}|${tier}`,
      expires_in: 1800,
      allow_comments: false,
    }),
  });

  const data = (await res.json()) as CreateInvoiceEnvelope;
  if (!data.ok || !data.result) {
    throw new Error(`createInvoice: ${JSON.stringify(data.error ?? `http_${res.status}`)}`);
  }

  const r = data.result;
  const payUrl = r.bot_invoice_url ?? r.pay_url ?? r.mini_app_invoice_url;
  if (!payUrl) {
    throw new Error('createInvoice: no pay url in response');
  }

  return { invoiceId: String(r.invoice_id), payUrl };
}

/**
 * Verify a Crypto Pay webhook signature.
 * Per docs: secret = SHA256(token) raw bytes; signature = HMAC_SHA256(secret, rawBody) hex.
 * The header value is `crypto-pay-api-signature`. Returns false on any mismatch / null sig.
 */
export async function verifyWebhookSignature(
  env: Env,
  rawBody: string,
  signature: string | null,
): Promise<boolean> {
  if (signature == null) return false;

  const enc = new TextEncoder();

  // secret = SHA-256 of the API token (raw bytes), used as the HMAC key.
  const keyBytes = await crypto.subtle.digest('SHA-256', enc.encode(env.CRYPTOPAY_TOKEN));
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sigBytes = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const hmacHex = toHex(new Uint8Array(sigBytes));

  return timingSafeEqualHex(hmacHex, signature);
}

/**
 * Parse a Crypto Pay `invoice_paid` webhook body. Returns null unless this is a
 * genuine paid-invoice update with a valid `${telegramId}|${tier}` payload.
 */
export async function parsePaidWebhook(
  body: any,
): Promise<{ invoiceId: string; telegramId: number; tier: PaidTier } | null> {
  if (!body || body.update_type !== 'invoice_paid') return null;

  const payload = body.payload;
  if (!payload || payload.status !== 'paid') return null;

  const inner = typeof payload.payload === 'string' ? payload.payload : '';
  const [tgStr, tierStr] = inner.split('|');

  const telegramId = Number(tgStr);
  if (!Number.isFinite(telegramId) || telegramId === 0) return null;

  if (!isPaidTier(tierStr)) return null;

  return {
    invoiceId: String(payload.invoice_id),
    telegramId,
    tier: tierStr,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPaidTier(value: unknown): value is PaidTier {
  return typeof value === 'string' && (PAID_TIERS as readonly string[]).includes(value);
}

/** Lowercase hex encoding of raw bytes. */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/** Constant-time comparison of two hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
