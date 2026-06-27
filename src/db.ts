// Typed D1 data-access helpers. All async, all parameterized.
// Unix-SECONDS ints everywhere. Imported by every feature module by exact name.

import {
  type Env,
  type GeoBand,
  type Tier,
  type EntitlementSource,
  type EntitlementStatus,
  type SubmissionStatus,
  type Processor,
  type PaymentStatus,
  type CadenceStage,
  nowSec,
} from './config';

// ---------------------------------------------------------------------------
// Row types (1:1 with schema.sql)
// ---------------------------------------------------------------------------

export interface UserRow {
  telegram_id: number;
  lang: string;
  geo_band: GeoBand | null;
  created_at: number;
  last_seen_at: number | null;
}

export interface EntitlementRow {
  id: number;
  telegram_id: number;
  source: EntitlementSource;
  tier: string | null;
  granted_at: number;
  expires_at: number | null;
  status: EntitlementStatus;
  bitunix_uid: string | null;
  invite_link: string | null;
}

export interface TrialSubmissionRow {
  id: number;
  telegram_id: number;
  bitunix_uid: string;
  screenshot_file_id: string | null;
  status: SubmissionStatus;
  lang: string | null;
  created_at: number;
  decided_at: number | null;
  admin_id: number | null;
}

export interface PaymentRow {
  invoice_id: string;
  telegram_id: number;
  processor: Processor;
  tier: string;
  amount_usdt: number;
  status: PaymentStatus;
  created_at: number;
  paid_at: number | null;
}

export interface PricingRow {
  geo_band: GeoBand;
  tier: string;
  amount_usdt: number;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function getUser(env: Env, telegram_id: number): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE telegram_id = ?')
    .bind(telegram_id)
    .first<UserRow>();
}

/**
 * Insert the user if new (sets created_at + geo_band from lang), or just bump
 * lang + last_seen_at if they already exist. Geo band derives from lang on insert.
 */
export async function upsertUser(env: Env, telegram_id: number, lang: string): Promise<void> {
  const now = nowSec();
  const band = langToBandLocal(lang);
  await env.DB.prepare(
    `INSERT INTO users (telegram_id, lang, geo_band, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET
       lang = excluded.lang,
       last_seen_at = excluded.last_seen_at`,
  )
    .bind(telegram_id, lang, band, now, now)
    .run();
}

export async function setUserLang(env: Env, telegram_id: number, lang: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE users SET lang = ?, geo_band = ?, last_seen_at = ? WHERE telegram_id = ?',
  )
    .bind(lang, langToBandLocal(lang), nowSec(), telegram_id)
    .run();
}

// Local copy to avoid an import cycle with config's langToBand at module-eval time.
function langToBandLocal(lang: string): GeoBand {
  return lang === 'pt' || lang === 'tr' ? 'mid' : 'low';
}

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

/** The single active, non-expired entitlement for a user (lifetime = expires_at NULL). */
export async function getActiveEntitlement(
  env: Env,
  telegram_id: number,
): Promise<EntitlementRow | null> {
  const now = nowSec();
  return env.DB.prepare(
    `SELECT * FROM entitlements
     WHERE telegram_id = ? AND status = 'active'
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY id DESC LIMIT 1`,
  )
    .bind(telegram_id, now)
    .first<EntitlementRow>();
}

export interface GrantEntitlementInput {
  telegram_id: number;
  source: EntitlementSource;
  tier: Tier;
  expires_at: number | null; // null = lifetime
  bitunix_uid?: string | null;
  invite_link?: string | null;
}

/** Insert a new active entitlement; returns its id. */
export async function grantEntitlement(env: Env, input: GrantEntitlementInput): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO entitlements
       (telegram_id, source, tier, granted_at, expires_at, status, bitunix_uid, invite_link)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(
      input.telegram_id,
      input.source,
      input.tier,
      nowSec(),
      input.expires_at,
      input.bitunix_uid ?? null,
      input.invite_link ?? null,
    )
    .run();
  return Number(res.meta.last_row_id);
}

/** Mark an entitlement expired (idempotent — only flips active rows). */
export async function expireEntitlement(env: Env, id: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE entitlements SET status = 'expired' WHERE id = ? AND status = 'active'`,
  )
    .bind(id)
    .run();
}

/**
 * The single active, non-expired entitlement bound to a Bitunix UID (whoever holds it).
 * Used by relink to find the current member occupying a UID's one slot.
 */
export async function getActiveEntitlementByUid(
  env: Env,
  uid: string,
): Promise<EntitlementRow | null> {
  const now = nowSec();
  return env.DB.prepare(
    `SELECT * FROM entitlements
     WHERE bitunix_uid = ? AND status = 'active'
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY id DESC LIMIT 1`,
  )
    .bind(uid, now)
    .first<EntitlementRow>();
}

/** Mark an entitlement revoked (relink takeover). Idempotent — only flips active rows. */
export async function revokeEntitlement(env: Env, id: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE entitlements SET status = 'revoked' WHERE id = ? AND status = 'active'`,
  )
    .bind(id)
    .run();
}

// ---------------------------------------------------------------------------
// Redeemed UIDs (one trial per UID, forever)
// ---------------------------------------------------------------------------

export async function isUidRedeemed(env: Env, uid: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 AS x FROM redeemed_uids WHERE bitunix_uid = ?')
    .bind(uid)
    .first<{ x: number }>();
  return row != null;
}

/** Permanently record a UID as redeemed. INSERT OR IGNORE keeps it idempotent. */
export async function redeemUid(env: Env, uid: string, telegram_id: number): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO redeemed_uids (bitunix_uid, telegram_id, redeemed_at)
     VALUES (?, ?, ?)`,
  )
    .bind(uid, telegram_id, nowSec())
    .run();
}

/** Re-point a redeemed UID at its new current holder (relink takeover). */
export async function setRedeemedUidHolder(
  env: Env,
  uid: string,
  telegram_id: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE redeemed_uids SET telegram_id = ?, redeemed_at = ? WHERE bitunix_uid = ?`,
  )
    .bind(telegram_id, nowSec(), uid)
    .run();
}

/**
 * Admin reset (testing): revoke a user's active entitlements and free every UID they
 * redeemed, so that telegram_id can run the trial again from scratch. Returns counts +
 * the invite links to revoke. Does NOT touch Telegram — caller kicks/revokes links.
 */
export async function resetUserData(
  env: Env,
  telegram_id: number,
): Promise<{ entitlements: number; uids: number; links: string[] }> {
  const rows = await env.DB.prepare(
    `SELECT invite_link FROM entitlements WHERE telegram_id = ? AND invite_link IS NOT NULL`,
  )
    .bind(telegram_id)
    .all<{ invite_link: string }>();
  const links = (rows.results ?? []).map((r) => r.invite_link).filter(Boolean);

  const ent = await env.DB.prepare(
    `UPDATE entitlements SET status = 'revoked' WHERE telegram_id = ? AND status = 'active'`,
  )
    .bind(telegram_id)
    .run();
  const uid = await env.DB.prepare(`DELETE FROM redeemed_uids WHERE telegram_id = ?`)
    .bind(telegram_id)
    .run();

  return {
    entitlements: Number(ent.meta.changes ?? 0),
    uids: Number(uid.meta.changes ?? 0),
    links,
  };
}

// ---------------------------------------------------------------------------
// Trial submissions (review queue / fallback)
// ---------------------------------------------------------------------------

export interface CreateTrialSubmissionInput {
  telegram_id: number;
  uid: string;
  screenshot_file_id?: string | null;
  lang: string;
}

/** Create a pending submission; returns its id. */
export async function createTrialSubmission(
  env: Env,
  input: CreateTrialSubmissionInput,
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO trial_submissions
       (telegram_id, bitunix_uid, screenshot_file_id, status, lang, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(input.telegram_id, input.uid, input.screenshot_file_id ?? null, input.lang, nowSec())
    .run();
  return Number(res.meta.last_row_id);
}

export async function getTrialSubmission(
  env: Env,
  id: number,
): Promise<TrialSubmissionRow | null> {
  return env.DB.prepare('SELECT * FROM trial_submissions WHERE id = ?')
    .bind(id)
    .first<TrialSubmissionRow>();
}

/**
 * Transition a submission. Idempotent guard for buttons: only updates a row that
 * is still 'pending' or 'need_proof'. Returns true if a row was actually changed.
 */
export async function setSubmissionStatus(
  env: Env,
  id: number,
  status: SubmissionStatus,
  admin_id: number,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE trial_submissions
       SET status = ?, admin_id = ?, decided_at = ?
     WHERE id = ? AND status IN ('pending', 'need_proof')`,
  )
    .bind(status, admin_id, nowSec(), id)
    .run();
  return Number(res.meta.changes ?? 0) > 0;
}

export async function getPendingSubmissions(
  env: Env,
  limit: number,
): Promise<TrialSubmissionRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM trial_submissions
     WHERE status IN ('pending', 'need_proof')
     ORDER BY created_at ASC LIMIT ?`,
  )
    .bind(limit)
    .all<TrialSubmissionRow>();
  return res.results ?? [];
}

/** Count submissions awaiting a decision (for /queue). */
export async function countPendingSubmissions(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM trial_submissions WHERE status IN ('pending', 'need_proof')`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export interface RecordPaymentInput {
  invoice_id: string;
  telegram_id: number;
  processor: Processor;
  tier: string;
  amount_usdt: number;
  status?: PaymentStatus; // default 'pending'
}

/** Insert a payment row (idempotent on invoice_id via INSERT OR IGNORE). */
export async function recordPayment(env: Env, input: RecordPaymentInput): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO payments
       (invoice_id, telegram_id, processor, tier, amount_usdt, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.invoice_id,
      input.telegram_id,
      input.processor,
      input.tier,
      input.amount_usdt,
      input.status ?? 'pending',
      nowSec(),
    )
    .run();
}

export async function getPayment(env: Env, invoice_id: string): Promise<PaymentRow | null> {
  return env.DB.prepare('SELECT * FROM payments WHERE invoice_id = ?')
    .bind(invoice_id)
    .first<PaymentRow>();
}

/**
 * Flip a payment to 'paid'. Idempotent: only updates rows not already paid.
 * Returns true if THIS call performed the transition (use to gate one-time grant).
 */
export async function markPaymentPaid(env: Env, invoice_id: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE payments SET status = 'paid', paid_at = ? WHERE invoice_id = ? AND status != 'paid'`,
  )
    .bind(nowSec(), invoice_id)
    .run();
  return Number(res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** Price (USDT) for a band+tier, or null if not seeded. */
export async function getPrice(
  env: Env,
  geo_band: GeoBand,
  tier: string,
): Promise<number | null> {
  const row = await env.DB.prepare(
    'SELECT amount_usdt FROM pricing WHERE geo_band = ? AND tier = ?',
  )
    .bind(geo_band, tier)
    .first<{ amount_usdt: number }>();
  return row?.amount_usdt ?? null;
}

/** All prices for a band (for rendering the tier menu). */
export async function getPricesForBand(env: Env, geo_band: GeoBand): Promise<PricingRow[]> {
  const res = await env.DB.prepare('SELECT * FROM pricing WHERE geo_band = ?')
    .bind(geo_band)
    .all<PricingRow>();
  return res.results ?? [];
}

// ---------------------------------------------------------------------------
// Expiry sweep
// ---------------------------------------------------------------------------

/** Active entitlements whose expiry has passed as of `now` (lifetime rows excluded). */
export async function getDueExpiries(env: Env, now: number): Promise<EntitlementRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM entitlements
     WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?`,
  )
    .bind(now)
    .all<EntitlementRow>();
  return res.results ?? [];
}

/** Active, still-valid TRIAL entitlements — the audience for the conversion cadence. */
export async function getActiveTrialEntitlements(env: Env): Promise<EntitlementRow[]> {
  const now = nowSec();
  const res = await env.DB.prepare(
    `SELECT * FROM entitlements
     WHERE status = 'active' AND source = 'trial'
       AND expires_at IS NOT NULL AND expires_at > ?`,
  )
    .bind(now)
    .all<EntitlementRow>();
  return res.results ?? [];
}

// ---------------------------------------------------------------------------
// Cadence log (dedupe conversion DMs)
// ---------------------------------------------------------------------------

export async function wasCadenceSent(
  env: Env,
  entitlement_id: number,
  stage: CadenceStage,
): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 AS x FROM cadence_log WHERE entitlement_id = ? AND stage = ?',
  )
    .bind(entitlement_id, stage)
    .first<{ x: number }>();
  return row != null;
}

/** Record that a cadence stage was sent. INSERT OR IGNORE = safe to retry. */
export async function logCadence(
  env: Env,
  telegram_id: number,
  entitlement_id: number,
  stage: CadenceStage,
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO cadence_log (telegram_id, entitlement_id, stage, sent_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(telegram_id, entitlement_id, stage, nowSec())
    .run();
}
