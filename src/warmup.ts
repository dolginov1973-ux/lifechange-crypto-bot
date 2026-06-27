// Dormant-user warm-up — re-engage people who /start'd the bot but never acted
// (no trial submission, no payment). Called hourly from scheduled() (index.ts).
//
// Up to 3 escalating DMs (warm1/warm2/warm3) over the first week, pushing the PAID
// sub first (no Bitunix setup needed) with the free trial as the fallback. Each DM
// carries two buttons — 💎 Subscribe ('buy') and 🎟 Free trial ('trial') — so one tap
// drops them straight into either flow. Deduped per (telegram_id, stage) via warmup_log.
// We only touch users created in the last ~9 days (and ≥6h old) so the first run never
// blasts the entire historical ghost list, and we stop after warm3.

import { InlineKeyboard } from 'grammy';
import { type Env, nowSec, asLang } from './config';
import { getDormantUsers, wasWarmupSent, logWarmup } from './db';
import { sendDM } from './services/access';
import { t } from './i18n';

const H = 3600;
const D = 86400;

type WarmStage = 'warm1' | 'warm2' | 'warm3';

/** The single warm-up stage due for a dormant user by age since /start, or null. */
export function warmStage(createdAt: number, now: number): WarmStage | null {
  const age = now - createdAt;
  if (age >= 7 * D) return 'warm3';
  if (age >= 3 * D) return 'warm2';
  if (age >= 6 * H) return 'warm1';
  return null;
}

/** DM every dormant user their due warm-up stage (once each). Defensive per-row. */
export async function runWarmup(env: Env): Promise<void> {
  const now = nowSec();
  const dormant = await getDormantUsers(env, now - 6 * H, now - 9 * D);

  for (const u of dormant) {
    try {
      const stage = warmStage(u.created_at, now);
      if (!stage) continue;
      if (await wasWarmupSent(env, u.telegram_id, stage)) continue;

      const lang = asLang(u.lang);
      const kb = new InlineKeyboard()
        .text(t(lang, 'main_menu_buy_btn'), 'buy')
        .row()
        .text(t(lang, 'main_menu_trial_btn'), 'trial');
      await sendDM(env, u.telegram_id, t(lang, stage), kb);
      await logWarmup(env, u.telegram_id, stage);
    } catch (e) {
      console.error('warmup', u.telegram_id, e);
    }
  }
}
