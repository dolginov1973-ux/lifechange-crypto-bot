-- Lifechange Crypto VIP bot — D1 (SQLite) schema. Spec §6.
-- Apply with: wrangler d1 execute DB --file schema.sql  (npm run db:init)
-- All timestamps are unix SECONDS (INTEGER).

PRAGMA foreign_keys = ON;

-- One row per Telegram user who ever /start'd.
CREATE TABLE IF NOT EXISTS users (
  telegram_id   INTEGER PRIMARY KEY,
  lang          TEXT NOT NULL DEFAULT 'en',   -- en/hi/pt/vi/es/tr/id
  geo_band      TEXT,                          -- 'low' | 'mid' (derived from lang, admin-overridable)
  created_at    INTEGER NOT NULL,              -- unix ts (seconds)
  last_seen_at  INTEGER
);

-- Acquisition attribution: first-touch source per user, captured from the /start deep-link
-- payload (t.me/<bot>?start=<source>). One row per user, first source wins (ON CONFLICT DO
-- NOTHING). Lets us measure cost-per-start per paid ad placement. Separate from users so it
-- needs no migration and never overwrites organic users.
CREATE TABLE IF NOT EXISTS acquisition (
  telegram_id   INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,                 -- ad/channel tag, e.g. 'ad_cryptoph'
  created_at    INTEGER NOT NULL
);

-- Source of truth for VIP access. One ACTIVE row per user at a time.
CREATE TABLE IF NOT EXISTS entitlements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id   INTEGER NOT NULL REFERENCES users(telegram_id),
  source        TEXT NOT NULL,                 -- 'trial' | 'paid'
  tier          TEXT,                          -- 'monthly'|'quarterly'|'lifetime'|'trial30'
  granted_at    INTEGER NOT NULL,
  expires_at    INTEGER,                       -- unix ts; NULL = lifetime
  status        TEXT NOT NULL DEFAULT 'active',-- 'active'|'expired'|'revoked'
  bitunix_uid   TEXT,                          -- the UID that unlocked it (trial)
  invite_link   TEXT                           -- their personal join-request link
);

-- Permanent ledger: one trial per UID, forever.
CREATE TABLE IF NOT EXISTS redeemed_uids (
  bitunix_uid   TEXT PRIMARY KEY,
  telegram_id   INTEGER NOT NULL,
  redeemed_at   INTEGER NOT NULL
);

-- Trial verification queue (manual / fallback approve).
CREATE TABLE IF NOT EXISTS trial_submissions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id        INTEGER NOT NULL,
  bitunix_uid        TEXT NOT NULL,
  screenshot_file_id TEXT,                      -- Telegram file_id (optional with auto-verify)
  status             TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'approved'|'rejected'|'need_proof'
  lang               TEXT,
  created_at         INTEGER NOT NULL,
  decided_at         INTEGER,
  admin_id           INTEGER
);

-- Paid payments ledger (idempotency keyed on invoice_id).
CREATE TABLE IF NOT EXISTS payments (
  invoice_id    TEXT PRIMARY KEY,              -- processor invoice id (or txid for static)
  telegram_id   INTEGER NOT NULL,
  processor     TEXT NOT NULL,                 -- 'cryptopay'|'nowpayments'|'static_trc20'
  tier          TEXT NOT NULL,
  amount_usdt   REAL NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'paid'|'failed'
  created_at    INTEGER NOT NULL,
  paid_at       INTEGER
);

-- Tunable pricing (no redeploy to change a geo price).
CREATE TABLE IF NOT EXISTS pricing (
  geo_band      TEXT NOT NULL,                 -- 'low'|'mid'
  tier          TEXT NOT NULL,                 -- 'monthly'|'quarterly'|'lifetime'
  amount_usdt   REAL NOT NULL,
  PRIMARY KEY (geo_band, tier)
);

-- Conversion-cadence dedupe (don't double-send a stage).
CREATE TABLE IF NOT EXISTS cadence_log (
  telegram_id    INTEGER NOT NULL,
  entitlement_id INTEGER NOT NULL,
  stage          TEXT NOT NULL,                -- 'welcome'|'day7'|'mid'|'warn3d'|'lastday'|'winback'
  sent_at        INTEGER NOT NULL,
  PRIMARY KEY (entitlement_id, stage)
);

-- Dormant-user warm-up dedupe: people who /start'd but never acted (no trial, no pay).
CREATE TABLE IF NOT EXISTS warmup_log (
  telegram_id INTEGER NOT NULL,
  stage       TEXT NOT NULL,                   -- 'warm1'|'warm2'|'warm3'
  sent_at     INTEGER NOT NULL,
  PRIMARY KEY (telegram_id, stage)
);

-- Indexes (spec §6).
CREATE INDEX IF NOT EXISTS idx_entitlements_sweep    ON entitlements(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_entitlements_user     ON entitlements(telegram_id, status);
CREATE INDEX IF NOT EXISTS idx_trial_submissions_st  ON trial_submissions(status);

-- Seed pricing (locked numbers, spec §4). USDT.
-- LOW = India/Nigeria/Vietnam/Indonesia/Philippines ; MID = Brazil/Turkey.
INSERT OR REPLACE INTO pricing (geo_band, tier, amount_usdt) VALUES
  ('low', 'monthly',    19),
  ('low', 'quarterly',  45),
  ('low', 'lifetime',  199),
  ('mid', 'monthly',    29),
  ('mid', 'quarterly',  69),
  ('mid', 'lifetime',  249);
