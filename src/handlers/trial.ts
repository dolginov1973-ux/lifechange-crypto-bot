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

import { type Bot, InlineKeyboard } from 'grammy';
import { type MyContext } from '../bot';
import { type Env, asLang } from '../config';
import {
  getUser,
  getActiveEntitlement,
  getActiveEntitlementByUid,
  isUidRedeemed,
  revokeEntitlement,
  createTrialSubmission,
  getTrialSubmission,
} from '../db';
import { verifyUid } from '../services/bitunix';
import { grantTrialAccess, relinkAccess, kickFromVip, sendDM } from '../services/access';
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

  // --- Relink: move a UID's single VIP slot to this requester --------------
  // Shown when someone submits a UID that already holds live access. Kicks the
  // previous holder, revokes their link + entitlement, and re-issues to the
  // requester carrying the SAME expiry (no trial reset). One UID = one member.
  bot.callbackQuery(/^relink:(\d{5,})$/, async (ctx) => {
    const uid = ctx.match?.[1] ?? '';
    const requester = ctx.from.id;
    const lang = await userLang(ctx.env, requester, ctx.from.language_code);

    const active = await getActiveEntitlementByUid(ctx.env, uid);
    if (!active) {
      // Expired between tapping the button and now — nothing left to move.
      await ctx.answerCallbackQuery();
      await ctx.reply(t(lang, 'trial_uid_already_used'));
      return;
    }

    // Block only a requester who is already a VIP via a DIFFERENT entitlement — that
    // would be grabbing a second slot. A current holder re-issuing their OWN UID
    // (requesterEnt is this same row) is allowed: the "I lost my link" case.
    const requesterEnt = await getActiveEntitlement(ctx.env, requester);
    if (requesterEnt != null && requesterEnt.id !== active.id) {
      await ctx.answerCallbackQuery();
      await ctx.reply(t(lang, 'trial_already_active'));
      return;
    }

    await ctx.answerCallbackQuery();

    const prevHolder = active.telegram_id;

    // Remove the previous holder from the VIP channel + kill their old link, then
    // revoke their entitlement so the DB / expiry sweep stays consistent.
    await kickFromVip(ctx.env, prevHolder, active.invite_link);
    await revokeEntitlement(ctx.env, active.id);

    // Tell the displaced member — only if it's a different person.
    if (prevHolder !== requester) {
      const prevLang = (await getUser(ctx.env, prevHolder))?.lang ?? 'en';
      await sendDM(ctx.env, prevHolder, t(prevLang, 'vip_access_transferred'));
    }

    // Re-issue to the requester (clones source/tier/expiry — no reset).
    await relinkAccess(ctx.env, requester, active, lang);
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
    const lang = await userLang(ctx.env, tgId, ctx.from.language_code);
    const uid = text;

    // A UID that was already redeemed. If it STILL holds a live VIP slot, offer to
    // (re)issue the link to THIS requester — which removes whoever currently holds it
    // (one UID = one member). This runs BEFORE the "already a VIP" guard so a current
    // holder who lost their link and re-sends their own UID gets the relink offer
    // instead of silence. If the access already expired, the UID is simply spent.
    if (await isUidRedeemed(ctx.env, uid)) {
      const active = await getActiveEntitlementByUid(ctx.env, uid);
      if (active) {
        await ctx.reply(t(lang, 'trial_uid_already_member'), {
          reply_markup: new InlineKeyboard().text(
            t(lang, 'btn_get_new_link'),
            `relink:${uid}`,
          ),
        });
      } else {
        await ctx.reply(t(lang, 'trial_uid_already_used'));
      }
      return;
    }

    // UID not redeemed yet. If they already have access (via a different UID / paid),
    // this isn't a new trial — pass it on so other handlers can run.
    if ((await getActiveEntitlement(ctx.env, tgId)) != null) {
      await next();
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
