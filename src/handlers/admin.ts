// Admin review queue (private ADMIN_CHAT_ID).
// - postAdminCard: one inline-keyboard card per pending submission (called from
//   handlers/trial.ts on a needs_manual result).
// - alertAdmin: plain DM to the admin chat (e.g. expired partner token).
// - registerAdmin: idempotent approve/reject/needproof button callbacks + /queue.

import { Bot, InlineKeyboard } from 'grammy';
import { type MyContext } from '../bot';
import { type Env, asLang } from '../config';
import {
  type TrialSubmissionRow,
  getTrialSubmission,
  setSubmissionStatus,
  getPendingSubmissions,
  countPendingSubmissions,
  resetUserData,
  getAcquisitionCounts,
} from '../db';
import { sendDM, callTelegram, grantTrialAccess, kickFromVip } from '../services/access';
import { t } from '../i18n';

/**
 * Post one review card for a pending submission into the admin chat.
 * Admin-facing copy is rendered in English.
 */
export async function postAdminCard(env: Env, sub: TrialSubmissionRow): Promise<void> {
  const text = t('en', 'admin_card_title', {
    id: sub.id,
    uid: sub.bitunix_uid,
    lang: sub.lang ?? '?',
    tg: sub.telegram_id,
    verdict: 'manual',
  });

  const reply_markup = new InlineKeyboard()
    .text(t('en', 'admin_btn_approve'), `adm:approve:${sub.id}`)
    .text(t('en', 'admin_btn_reject'), `adm:reject:${sub.id}`)
    .text(t('en', 'admin_btn_needproof'), `adm:needproof:${sub.id}`);

  await callTelegram(env, 'sendMessage', {
    chat_id: env.ADMIN_CHAT_ID,
    text,
    parse_mode: 'HTML',
    reply_markup,
  });
}

/** Send a plain operational alert to the admin chat. */
export async function alertAdmin(env: Env, text: string): Promise<void> {
  await sendDM(env, env.ADMIN_CHAT_ID, text);
}

export function registerAdmin(bot: Bot<MyContext>): void {
  // Approve / reject / need-proof buttons. Idempotent via setSubmissionStatus.
  bot.callbackQuery(/^adm:(approve|reject|needproof):(\d+)$/, async (ctx) => {
    const action = ctx.match?.[1] as 'approve' | 'reject' | 'needproof';
    const id = Number(ctx.match?.[2]);
    const adminId = ctx.from?.id ?? 0;

    const status =
      action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'need_proof';

    const ok = await setSubmissionStatus(ctx.env, id, status, adminId);
    if (!ok) {
      await ctx.answerCallbackQuery(t('en', 'admin_action_already_done', { id }));
      return;
    }

    const sub = await getTrialSubmission(ctx.env, id);
    if (!sub) {
      await ctx.answerCallbackQuery();
      return;
    }

    if (action === 'approve') {
      await grantTrialAccess(ctx.env, sub.telegram_id, sub.bitunix_uid, sub.lang ?? 'en');
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t('en', 'admin_action_approved', { id }));
    } else if (action === 'reject') {
      await sendDM(ctx.env, sub.telegram_id, t(asLang(sub.lang), 'trial_rejected', { min_balance: ctx.env.MIN_BALANCE_USDT }));
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t('en', 'admin_action_rejected', { id }));
    } else {
      await sendDM(ctx.env, sub.telegram_id, t(asLang(sub.lang), 'trial_need_proof'));
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t('en', 'admin_action_needproof', { id }));
    }
  });

  // /queue — list pending submissions (admin chat only).
  bot.command('queue', async (ctx) => {
    if (ctx.chat?.id !== Number(ctx.env.ADMIN_CHAT_ID)) return;

    const n = await countPendingSubmissions(ctx.env);
    if (n === 0) {
      await ctx.reply(t('en', 'admin_queue_empty'));
      return;
    }

    const pending = await getPendingSubmissions(ctx.env, 10);
    const lines = pending.map((sub) =>
      t('en', 'admin_queue_item', {
        id: sub.id,
        tg: sub.telegram_id,
        uid: sub.bitunix_uid,
        lang: sub.lang ?? '?',
        age: `${sub.created_at}`,
      }),
    );

    await ctx.reply(`${t('en', 'admin_queue_header', { count: n })}\n${lines.join('\n')}`);
  });

  // /sources — acquisition attribution report (admin chat only). Counts /start's per deep-link
  // source so we can compute cost-per-start for each paid ad placement. Untagged organic /start's
  // simply don't appear here.
  bot.command('sources', async (ctx) => {
    if (ctx.chat?.id !== Number(ctx.env.ADMIN_CHAT_ID)) return;
    const rows = await getAcquisitionCounts(ctx.env);
    if (!rows.length) {
      await ctx.reply('No tagged acquisition sources yet. Use deep links: t.me/<bot>?start=ad_<tag>');
      return;
    }
    const total = rows.reduce((s, r) => s + r.n, 0);
    const lines = rows.map((r) => `${String(r.n).padStart(5)}  ${r.source}`);
    await ctx.reply(`📊 Acquisition by source (tagged /start's)\n\n${lines.join('\n')}\n\nTotal tagged: ${total}`);
  });

  // /reset [telegram_id] — admin testing tool. Revokes a user's active entitlements,
  // frees every UID they redeemed, and kicks them from the VIP channel, so that account
  // can run the trial again from scratch. No arg = reset YOUR own account. Admin chat only.
  bot.command('reset', async (ctx) => {
    if (ctx.chat?.id !== Number(ctx.env.ADMIN_CHAT_ID)) return;

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const targetId = /^\d{4,}$/.test(arg) ? Number(arg) : arg === '' ? (ctx.from?.id ?? 0) : 0;
    if (!targetId) {
      await ctx.reply(
        'Usage: /reset <telegram_id> — or /reset alone to reset YOUR own account.\n' +
          'Revokes VIP access, frees the redeemed UID(s), and kicks that account from the ' +
          'VIP channel so it can run the trial again. Tip: send /id from an account to get its id.',
      );
      return;
    }

    const { entitlements, uids, links } = await resetUserData(ctx.env, targetId);
    for (const link of links) {
      try {
        await callTelegram(ctx.env, 'revokeChatInviteLink', {
          chat_id: ctx.env.VIP_CHAT_ID,
          invite_link: link,
        });
      } catch {
        // already revoked / not found — fine
      }
    }
    await kickFromVip(ctx.env, targetId);

    await ctx.reply(
      `✅ Reset ${targetId}: revoked ${entitlements} entitlement(s), freed ${uids} UID(s), ` +
        `kicked from VIP. That account can /start a fresh trial now.`,
    );
  });
}
