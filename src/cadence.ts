// Conversion cadence — the trial→paid drip. Called hourly from scheduled() (index.ts).
//
// For every ACTIVE trial entitlement we compute which single stage is due right now
// (by time elapsed since grant / time remaining until expiry), and DM that stage's
// message once (deduped per (entitlement, stage) via cadence_log) with a one-tap
// "💎 Keep my access" button that opens the paid tier menu (the 'buy' callback).
//
// Winback (after the user is actually removed on expiry) is sent from the sweep, since
// that's where the kick happens — see sweep.ts.

import { InlineKeyboard } from 'grammy';
import { type Env, type CadenceStage, nowSec, asLang } from './config';
import { getActiveTrialEntitlements, getUser, wasCadenceSent, logCadence } from './db';
import { sendDM } from './services/access';
import { t } from './i18n';

const H = 3600;
const D = 86400;

/**
 * The single cadence stage due for a trial right now, or null. Evaluated most-urgent
 * first so each stage fires once at its threshold as the trial counts down. 'winback'
 * is NOT here — it's an expiry event handled by the sweep.
 */
export function dueStage(grantedAt: number, expiresAt: number, now: number): CadenceStage | null {
  const elapsed = now - grantedAt;
  const remaining = expiresAt - now;
  if (remaining <= 1 * D) return 'lastday';
  if (remaining <= 3 * D) return 'warn3d';
  if (remaining <= 15 * D) return 'mid';
  if (elapsed >= 7 * D) return 'day7';
  if (elapsed >= 20 * H) return 'welcome';
  return null;
}

/** DM every active trial its due cadence stage (once each). Defensive per-row. */
export async function runCadence(env: Env): Promise<void> {
  const now = nowSec();
  const trials = await getActiveTrialEntitlements(env);

  for (const ent of trials) {
    try {
      if (ent.expires_at == null) continue;
      const stage = dueStage(ent.granted_at, ent.expires_at, now);
      if (!stage) continue;
      if (await wasCadenceSent(env, ent.id, stage)) continue;

      const lang = asLang((await getUser(env, ent.telegram_id))?.lang);
      const kb = new InlineKeyboard().text(t(lang, 'cadence_keep_btn'), 'buy');
      await sendDM(env, ent.telegram_id, t(lang, `cadence_${stage}`), kb);
      await logCadence(env, ent.telegram_id, ent.id, stage);
    } catch (e) {
      // One bad row must never abort the batch (dead DM, blocked bot, etc.).
      console.error('cadence', ent.id, e);
    }
  }
}
