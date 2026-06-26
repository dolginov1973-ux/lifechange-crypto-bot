// Shared configuration + types. Imported by every feature module.
// Keep these exports STABLE — feature engineers import them by exact name.

/**
 * Cloudflare Worker bindings.
 * SECRETS (wrangler secret put ...): BOT_TOKEN, BITUNIX_PARTNER_TOKEN, CRYPTOPAY_TOKEN, WEBHOOK_SECRET.
 * VARS (wrangler.toml [vars]): the rest. All non-DB bindings arrive as strings.
 */
export interface Env {
  // D1 binding (wrangler.toml binding = "DB")
  DB: D1Database;

  // --- secrets ---
  BOT_TOKEN: string;
  BITUNIX_PARTNER_TOKEN: string;
  CRYPTOPAY_TOKEN: string;
  WEBHOOK_SECRET: string;
  // External Node relay base URL (e.g. https://lc-bitunix-relay.vercel.app). The Worker
  // can't reach Bitunix directly (CF->CF 403); verifyUid calls <RELAY_URL>/api/verify.
  RELAY_URL: string;
  RELAY_SECRET: string; // shared secret sent to the relay as the x-relay-secret header

  // --- vars ---
  OUR_REF_CODE: string;
  OUR_PARTNER_UID: string;
  MIN_BALANCE_USDT: string; // parse with Number()
  VIP_CHAT_ID: string;      // negative supergroup id, parse with Number()
  ADMIN_CHAT_ID: string;    // private admin-review chat id
  BOT_USERNAME: string;
  REFERRAL_LINK: string;
  // Custom domain the Worker is reachable at (e.g. lcbot.modernbroke.com). Used by the
  // one-time GET /setup route to register the Telegram webhook from Cloudflare's side
  // (so it works even where api.telegram.org is blocked on the operator's own network).
  WEBHOOK_DOMAIN: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Referral-gated free trial length in days. */
export const TRIAL_DAYS = 30 as const;

/** Supported languages (also the 7 free-channel languages). */
export const LANGS = ['en', 'hi', 'pt', 'vi', 'es', 'tr', 'id'] as const;
export type Lang = (typeof LANGS)[number];

/** Geo pricing bands. */
export type GeoBand = 'low' | 'mid';

/** Paid subscription tiers (entitlement.tier also allows 'trial30'). */
export type PaidTier = 'monthly' | 'quarterly' | 'lifetime';
export type Tier = PaidTier | 'trial30';

/** Entitlement source + lifecycle. */
export type EntitlementSource = 'trial' | 'paid';
export type EntitlementStatus = 'active' | 'expired' | 'revoked';

/** Trial submission lifecycle. */
export type SubmissionStatus = 'pending' | 'approved' | 'rejected' | 'need_proof';

/** Payment processors + lifecycle. */
export type Processor = 'cryptopay' | 'nowpayments' | 'static_trc20';
export type PaymentStatus = 'pending' | 'paid' | 'failed';

/** Conversion cadence stages. */
export type CadenceStage = 'welcome' | 'mid' | 'warn3d' | 'lastday' | 'winback';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the geo pricing band from the user's chosen language.
 * pt -> mid (Brazil), tr -> mid (Turkey); everything else defaults to low.
 * Admin may override the stored users.geo_band afterwards.
 */
export function langToBand(lang: string): GeoBand {
  switch (lang) {
    case 'pt': // Brazil
    case 'tr': // Turkey
      return 'mid';
    case 'hi': // India
    case 'id': // Indonesia
    case 'vi': // Vietnam
    case 'es': // Spanish-reading (default low)
    case 'en': // master / Nigeria / Philippines (default low)
    default:
      return 'low';
  }
}

/**
 * Duration of a tier in days. `lifetime` -> null (no expiry). `trial30` -> TRIAL_DAYS.
 * Returns null for lifetime (never expires).
 */
export function tierDurationDays(tier: Tier): number | null {
  switch (tier) {
    case 'monthly':
      return 30;
    case 'quarterly':
      return 90;
    case 'lifetime':
      return null;
    case 'trial30':
      return TRIAL_DAYS;
    default:
      return null;
  }
}

/** Narrow an arbitrary string to a supported Lang, defaulting to 'en'. */
export function asLang(value: string | null | undefined): Lang {
  return (LANGS as readonly string[]).includes(value ?? '') ? (value as Lang) : 'en';
}

/** Current unix time in SECONDS (the unit used across D1 + this codebase). */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
