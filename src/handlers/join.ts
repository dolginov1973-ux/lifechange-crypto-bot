// chat_join_request access gate for the VIP chat.
// Contract: registerJoin(bot).
// On chat_join_request scoped to VIP_CHAT_ID: approve iff the user has an active
// entitlement, otherwise decline. On approval, send the localized welcome DM via the
// 24h user_chat_id window — this reaches users who requested via a personal invite link
// even if they never opened a private chat / pressed /start.

import { type Bot } from 'grammy';
import { type MyContext } from '../bot';
import { asLang } from '../config';
import { getUser, getActiveEntitlement } from '../db';
import { approveJoin, declineJoin, sendDM } from '../services/access';
import { t } from '../i18n';

export function registerJoin(bot: Bot<MyContext>): void {
  bot.on('chat_join_request', async (ctx) => {
    const req = ctx.chatJoinRequest;

    // Only gate the configured VIP chat; ignore join requests for any other chat.
    if (String(req.chat.id) !== String(ctx.env.VIP_CHAT_ID)) return;

    const userId = req.from.id;
    const ent = await getActiveEntitlement(ctx.env, userId);

    if (ent) {
      await approveJoin(ctx.env, userId);

      // Welcome DM via the 24h user_chat_id window. Best-effort: a dead/closed DM
      // window must never undo the approval, so swallow everything here.
      try {
        const u = await getUser(ctx.env, userId);
        const lang = asLang(u?.lang);
        await sendDM(
          ctx.env,
          req.user_chat_id,
          t(lang, 'vip_welcome_dm', { disclaimer: t(lang, 'disclaimer') }),
        );
      } catch {
        // no-op: welcome DM is non-critical
      }
    } else {
      await declineJoin(ctx.env, userId);
    }
  });
}
