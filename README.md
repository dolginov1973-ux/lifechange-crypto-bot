# Lifechange Crypto — VIP Bot

Monetization layer for the Lifechange Crypto signals business: referral-gated 30-day
trials + paid USDT subscriptions → one global VIP **supergroup**, with timed access,
a conversion DM cadence, and an hourly auto-expiry sweep.

**Stack:** Cloudflare Workers + TypeScript · grammY (webhook) · Cloudflare D1 (SQLite) ·
Workers Cron Triggers (hourly sweep) · wrangler.

> Separate from `lifechange-crypto-publisher` (the zero-dep free-channel publisher).
> They share only the Telegram **bot token**; only this Worker sets a webhook.

---

## Layout

```
schema.sql              D1 schema + indexes + seed pricing
wrangler.toml           Worker config, D1 binding, hourly cron, vars (secrets documented)
src/
  config.ts             Env interface + constants + helpers (langToBand, tierDurationDays, nowSec)
  db.ts                 typed D1 helpers (all async/parameterized, unix seconds)
  bot.ts                grammY Bot factory + MyContext + webhook handler
  index.ts              Worker entry: fetch routes + scheduled() sweep
  i18n/
    index.ts            t(lang, key, vars?) with {var} interpolation + en fallback
    en.json             master English string set (canonical key registry)
  services/
    bitunix.ts          verifyUid(env, uid) — referral auto-verify (graceful fallback)
  handlers/             (feature engineers) start.ts trial.ts paid.ts admin.ts join.ts pay-webhook.ts
  sweep.ts              (feature engineer) runSweep(env)
```

---

## Setup & deploy

### 0. Install

```bash
npm install
```

### 1. Cloudflare auth + D1

```bash
wrangler login
wrangler d1 create lifechange-crypto-bot
# → copy the printed database_id into wrangler.toml [[d1_databases]].database_id
npm run db:init          # applies schema.sql (tables, indexes, seed pricing)
```

### 2. Secrets (never commit these)

```bash
wrangler secret put BOT_TOKEN             # Telegram bot token from @BotFather
wrangler secret put BITUNIX_PARTNER_TOKEN # partners.bitunix.com session token (refreshable)
wrangler secret put CRYPTOPAY_TOKEN       # CryptoBot Crypto Pay app token   # TODO(owner): provision
wrangler secret put WEBHOOK_SECRET        # random string; guards /bot + is the Telegram secret_token
```

For local `wrangler dev`, mirror them in a gitignored `.dev.vars`:

```
BOT_TOKEN=...
BITUNIX_PARTNER_TOKEN=...
CRYPTOPAY_TOKEN=...
WEBHOOK_SECRET=...
```

### 3. Vars

Set in `wrangler.toml [vars]` (or per-env): `OUR_REF_CODE`, `OUR_PARTNER_UID`,
`MIN_BALANCE_USDT` (50), `VIP_CHAT_ID`, `ADMIN_CHAT_ID`, `BOT_USERNAME`, `REFERRAL_LINK`.

### 4. Custom domain + webhook

`*.workers.dev` certs are **incompatible** with Telegram webhooks — attach a free
custom domain in Cloudflare, then set the route in `wrangler.toml` and deploy:

```bash
npm run deploy
```

Point Telegram at it (pass `secret_token` = your `WEBHOOK_SECRET`):

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-domain>/bot" \
  -d "secret_token=<WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message","callback_query","chat_join_request"]'
```

### 5. VIP supergroup (owner provisioning)

- **TODO(owner):** convert "Group 2" to a **supergroup**.
- Add the bot as **admin** with `can_invite_users` + `can_restrict_members`.
- Turn **ON** "Approve new members" (join requests are the access gate).
- Put the supergroup id (negative, e.g. `-100…`) into `VIP_CHAT_ID`.
- Create a private admin-review group, add the bot, put its id into `ADMIN_CHAT_ID`.

### 6. Crypto Pay (owner provisioning)

- **TODO(owner):** in `@CryptoBot` → Crypto Pay → **Create App** → copy the app token
  into the `CRYPTOPAY_TOKEN` secret.
- Set the app's webhook (paid-invoice callback) to `https://<your-domain>/pay-webhook`.
- Run one small live invoice before locking prices to confirm fee/spread and that
  external on-chain USDT-TRC20 is accepted.

---

## Owner-provisioning TODO summary

| Item | Where |
|---|---|
| D1 `database_id` | `wrangler.toml` |
| Real `CRYPTOPAY_TOKEN` | `wrangler secret put` |
| `VIP_CHAT_ID` / `ADMIN_CHAT_ID` | supergroup + admin group ids |
| `OUR_REF_CODE` / `OUR_PARTNER_UID` / `REFERRAL_LINK` | Bitunix partner account |
| Custom domain + route | Cloudflare + `wrangler.toml [[routes]]` |
| Convert Group 2 → supergroup, bot admin, approval ON | Telegram |

---

## Compliance floor (every user-facing string)

No income/profit promises · no fixed/fabricated win-rate % · never call Bitunix
"licensed/regulated" · risk disclaimer on every offer + the welcome DM · strictly
educational framing · no "AI/GPT/neural net" mentions. Exchange terms (funding,
leverage, SL, entry, TP) stay English; disclaimers are fully localized.
