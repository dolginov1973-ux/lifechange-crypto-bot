// Bitunix referral auto-verify against the partner dashboard backend.
// CONFIRMED working server-side (HTTP 200 from a datacenter IP) with the browser-like
// headers below — they pass Cloudflare/WAF. On ANY error/expiry we fall back to
// 'needs_manual' (never auto-reject) so the caller can queue an admin card.

import { type Env } from '../config';

/** Result of a UID verification attempt. */
export type VerifyResult =
  | { status: 'verified'; balance: number; raw: BitunixUserInfo }
  | { status: 'not_ours'; balance?: number; raw: BitunixUserInfo }
  | { status: 'no_deposit'; balance?: number; raw: BitunixUserInfo }
  | { status: 'below_min'; balance: number; raw: BitunixUserInfo }
  | { status: 'needs_manual'; reason: string; raw?: unknown };

/**
 * Shape of `result` in the partner endpoint response. Fields we rely on:
 * - invitationCode  : the referral code the user registered under (must equal OUR_REF_CODE)
 * - parentUid       : the partner UID who referred them (must equal OUR_PARTNER_UID)
 * - firstDepositTime: ms timestamp of first deposit; null/absent => never deposited
 * - allAmount       : CURRENT total balance (USDT, string) — we gate on >= MIN_BALANCE_USDT
 * - firstTradeTime, kycLevel, uid: informational.
 */
export interface BitunixUserInfo {
  uid?: string | number;
  invitationCode?: string;
  parentUid?: string | number;
  firstDepositTime?: number | string | null;
  firstTradeTime?: number | string | null;
  allAmount?: string | number | null;
  kycLevel?: number | string;
  [k: string]: unknown;
}

interface BitunixEnvelope {
  code?: string;
  msg?: string;
  result?: BitunixUserInfo | null;
}

// Chrome 147 on Windows — must match the WAF-passing fingerprint.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

/** Reject after `ms` so a hung transport can never stall the update handler. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('transport_timeout')), ms)),
  ]);
}

/**
 * Fetch the Bitunix partner JSON through the external Node relay. The relay holds its
 * own token + (optional) proxy and reaches Bitunix from a datacenter IP, returning
 * { via, status, body }. We surface { status, body } so the parser below is unchanged.
 */
async function fetchViaRelay(env: Env, uid: string): Promise<{ status: number; body: string }> {
  const base = env.RELAY_URL.replace(/\/+$/, '');
  const url = `${base}/api/verify?uid=${encodeURIComponent(uid)}`;
  const res = await fetch(url, { headers: { 'x-relay-secret': env.RELAY_SECRET } });
  if (!res.ok) throw new Error(`relay_http_${res.status}`);
  const j = (await res.json()) as { status?: number; body?: string; error?: string };
  if (j.error) throw new Error(`relay_error:${j.error}`);
  return { status: Number(j.status ?? 0), body: String(j.body ?? '') };
}

/**
 * Verify a Bitunix UID against our referral. Returns a discriminated result.
 * Graceful fallback: status != 200, non-JSON body, code != "0", or no result
 * -> { status: 'needs_manual', reason } (the caller alerts admin + queues a card).
 */
export async function verifyUid(env: Env, uid: string): Promise<VerifyResult> {
  const ts = Date.now();
  const path = `/partner/user/info/${encodeURIComponent(uid)}?_t=${ts}`;
  const headers: Record<string, string> = {
    token: env.BITUNIX_PARTNER_TOKEN,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US',
    referer: 'https://partners.bitunix.com/',
    'user-agent': CHROME_UA,
    'sec-ch-ua': '"Chromium";v="147", "Google Chrome";v="147", "Not?A_Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };

  // A DIRECT Cloudflare Worker fetch to partners.bitunix.com is WAF-blocked (403), and the
  // raw-socket proxy tunnel fails the TLS handshake in Workers. So when RELAY_URL is set we
  // go through the external Node relay (preferred). Otherwise we attempt a direct fetch (which
  // will 403 → needs_manual). Either path has a hard timeout so the handler can never hang.
  let status: number;
  let bodyText: string;
  try {
    if (env.RELAY_URL) {
      const r = await withTimeout(fetchViaRelay(env, uid), 9000);
      status = r.status;
      bodyText = r.body;
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(`https://partners.bitunix.com${path}`, {
          method: 'GET',
          signal: controller.signal,
          headers,
        });
        status = res.status;
        bodyText = await res.text();
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    return { status: 'needs_manual', reason: `fetch_error:${String(err)}` };
  }

  if (status !== 200) {
    return { status: 'needs_manual', reason: `http_${status}` };
  }

  let body: BitunixEnvelope;
  try {
    body = JSON.parse(bodyText) as BitunixEnvelope;
  } catch {
    return { status: 'needs_manual', reason: 'body_not_json_token_expired_or_error' };
  }

  if (body.code !== '0' || !body.result) {
    return { status: 'needs_manual', reason: 'token_expired_or_error' };
  }

  const r = body.result;

  // Is this account actually under OUR referral?
  const matchesCode =
    r.invitationCode != null && r.invitationCode === env.OUR_REF_CODE;
  const matchesParent =
    r.parentUid != null && String(r.parentUid) === String(env.OUR_PARTNER_UID);
  const isOurs = matchesCode || matchesParent;

  if (!isOurs) {
    return { status: 'not_ours', raw: r };
  }

  // Did they ever deposit?
  const deposited = r.firstDepositTime != null;
  if (!deposited) {
    return { status: 'no_deposit', raw: r };
  }

  // Does CURRENT balance meet the minimum?
  const balance = parseFloat(String(r.allAmount ?? '0')) || 0;
  const min = Number(env.MIN_BALANCE_USDT);
  if (balance < min) {
    return { status: 'below_min', balance, raw: r };
  }

  return { status: 'verified', balance, raw: r };
}
