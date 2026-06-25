// Referral-gated AUTO-VERIFY trial — the core feature.
// Flow: trial CTA -> trial_intro (referral_link, min_balance) + trial_ask_uid ->
// user sends a numeric UID -> isUidRedeemed gate -> verifyUid(env,uid):
//   verified                      -> grantTrialAccess (DMs welcome + invite itself)
//   not_ours/no_deposit/below_min -> trial_rejected
//   needs_manual                  -> createTrialSubmission + admin card; on a
//                                    token/transport reason also alert admin to
//                                    refresh BITUNIX_PARTNER_TOKEN; trial_needs_manual.
//
// STATE NOTE: there is no session/conversation store, so we treat a bare numeric
// message (when the user has no active entitlement) as a UID submission. Non-numeric
// text is ignored so other handlers can process it.

import { type Bot } from 'grammy';
import { type MyContext } from '../bot';
import { type Env, asLang } from '../config';
import { getUser, getActiveEntitlement, isUidRedeemed, createTrialSubmission, getTrialSubmission } from '../db';
import { verifyUid } from '../services/bitunix';
import { grantTrialAccess } from '../services/access';
import { postAdminCard, alertAdmin } from './admin';
import { t } from '../i18n';

/** A Bitunix UID is digits only, 5+ long. */
const UID_RE = /^\d{5,}$/;

/** Reasons from verifyUid that point at a token/transport problem (vs. a clean miss). */
const TOKEN_TROUBLE_RE = /token_expired|http_|fetch_error|not_json/;

/** Resolve the user's preferred language: stored lang, else Telegram client locale. */
async function userLang(env: Env, telegramId: number, clientCode?: string): Promise<string> {
  const stored = (await getUser(env, telegramId))?.lang;
  return stored ?? asLang(clientCode);
}

export function registerTrial(bot: Bot<MyContext>): void {
  // --- Trial CTA -----------------------------------------------------------
  bot.callbackQuery('trial', async (ctx) => {
    const tgId = ctx.from.id;
    const lang = await userLang(ctx.env, tgId, ctx.from.language_code);

    // Already a VIP? Don't restart the trial flow.
    if ((await getActiveEntitlement(ctx.env, tgId)) != null) {
      await ctx.answerCallbackQuery();
      await ctx.reply(t(lang, 'trial_already_active'));
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.reply(
      t(lang, 'trial_intro', {
        referral_link: ctx.env.REFERRAL_LINK,
        min_balance: ctx.env.MIN_BALANCE_USDT,
      }),
    );
    await ctx.reply(t(lang, 'trial_ask_uid'));
  });

  // --- UID submission (numeric-message heuristic) --------------------------
  // TODO(feature: trial): replace this numeric-heuristic with a proper grammY
  // conversation/session once a session store is added — so we only treat text as
  // a UID when the user is actually in the "awaiting UID" step.
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text.trim();

    // Not a UID-shaped message -> let other handlers run.
    if (!UID_RE.test(text)) {
      await next();
      return;
    }

    const tgId = ctx.from.id;

    // If they already have access, this isn't a trial submission — pass it on.
    if ((await getActiveEntitlement(ctx.env, tgId)) != null) {
      await next();
      return;
    }

    const lang = await userLang(ctx.env, tgId, ctx.from.language_code);
    const uid = text;

    // One trial per UID, forever.
    if (await isUidRedeemed(ctx.env, uid)) {
      await ctx.reply(t(lang, 'trial_uid_already_used'));
      return;
    }

    await ctx.reply(t(lang, 'trial_checking'));

    const r = await verifyUid(ctx.env, uid);
    switch (r.status) {
      case 'verified':
        // grantTrialAccess records the entitlement, redeems the UID, and DMs the
        // localized welcome + personal invite link itself.
        await grantTrialAccess(ctx.env, tgId, uid, lang);
        return;

      case 'not_ours':
      case 'no_deposit':
      case 'below_min':
        await ctx.reply(t(lang, 'trial_rejected', { min_balance: ctx.env.MIN_BALANCE_USDT }));
        return;

      case 'needs_manual': {
        const id = await createTrialSubmission(ctx.env, { telegram_id: tgId, uid, lang });
        const sub = await getTrialSubmission(ctx.env, id);
        if (sub) await postAdminCard(ctx.env, sub);
        if (TOKEN_TROUBLE_RE.test(r.reason)) {
          await alertAdmin(ctx.env, t('en', 'admin_token_expired_alert', { reason: r.reason }));
        }
        await ctx.reply(t(lang, 'trial_needs_manual'));
        return;
      }
    }
  });
}
