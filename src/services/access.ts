// VIP access service: raw Bot API helper + entitlement/grant orchestration.
// Workers runtime only (global fetch, no node:*). Functions are small and defensive
// so a single dead DM or a failed kick never aborts a flow or the expiry sweep.

import { type Env, tierDurationDays, nowSec, asLang } from '../config';
import { grantEntitlement, redeemUid } from '../db';
import { t } from '../i18n';

/**
 * Central raw Bot API helper. POSTs JSON to the Telegram Bot API and parses the
 * response. Throws `Error(`${method}: ${description}`)` when the API returns ok:false.
 */
export async function callTelegram(
  env: Env,
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = (await res.json()) as { ok?: boolean; description?: string; result?: any };
  if (!data.ok) {
    throw new Error(`${method}: ${data.description ?? `http_${res.status}`}`);
  }
  return data.result;
}

/**
 * Send an HTML DM. Swallows the common "bot was blocked" / "chat not found" errors
 * (logs them) so a dead DM never breaks the calling flow. Other errors are logged too.
 */
export async function sendDM(
  env: Env,
  chatId: number | string,
  text: string,
  replyMarkup?: unknown,
): Promise<void> {
  const params: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyMarkup !== undefined) params.reply_markup = replyMarkup;

  try {
    await callTelegram(env, 'sendMessage', params);
  } catch (err) {
    // A blocked bot, deactivated user, or "chat not found" must never throw.
    console.error(`sendDM to ${chatId} failed:`, String(err));
  }
}

/**
 * Create a personal, single-use-ish join-request invite link for the VIP chat.
 * With creates_join_request we must NOT set member_limit (Bot API rejects the combo).
 */
export async function createPersonalInvite(
  env: Env,
  source: string,
  telegramId: number,
): Promise<string> {
  const result = await callTelegram(env, 'createChatInviteLink', {
    chat_id: env.VIP_CHAT_ID,
    creates_join_request: true,
    name: `${source}-${telegramId}`.slice(0, 32),
  });
  return result.invite_link as string;
}

/** Approve a pending join request into the VIP chat. */
export async function approveJoin(env: Env, userId: number): Promise<void> {
  await callTelegram(env, 'approveChatJoinRequest', {
    chat_id: env.VIP_CHAT_ID,
    user_id: userId,
  });
}

/** Decline a pending join request into the VIP chat. */
export async function declineJoin(env: Env, userId: number): Promise<void> {
  await callTelegram(env, 'declineChatJoinRequest', {
    chat_id: env.VIP_CHAT_ID,
    user_id: userId,
  });
}

/**
 * Remove a user from the VIP chat on expiry. Plain kick (ban then immediate unban)
 * so they can rejoin on renewal. Each step is isolated in try/catch so one failure
 * doesn't abort a batch sweep.
 */
export async function kickFromVip(
  env: Env,
  telegramId: number,
  inviteLink?: string | null,
): Promise<void> {
  if (inviteLink) {
    try {
      await callTelegram(env, 'revokeChatInviteLink', {
        chat_id: env.VIP_CHAT_ID,
        invite_link: inviteLink,
      });
    } catch (err) {
      // Already-revoked / not-found links are fine to ignore.
      console.error(`revokeChatInviteLink for ${telegramId} failed:`, String(err));
    }
  }

  try {
    // No until_date -> a plain kick, not a timed ban.
    await callTelegram(env, 'banChatMember', {
      chat_id: env.VIP_CHAT_ID,
      user_id: telegramId,
    });
  } catch (err) {
    console.error(`banChatMember for ${telegramId} failed:`, String(err));
  }

  try {
    // only_if_banned so we don't accidentally lift an unrelated ban; lets them rejoin.
    await callTelegram(env, 'unbanChatMember', {
      chat_id: env.VIP_CHAT_ID,
      user_id: telegramId,
      only_if_banned: true,
    });
  } catch (err) {
    console.error(`unbanChatMember for ${telegramId} failed:`, String(err));
  }
}

/**
 * Grant a referral trial: 30-day entitlement, personal invite, mark the UID redeemed,
 * and DM the localized welcome. The invite link is safe to interpolate (no HTML).
 */
export async function grantTrialAccess(
  env: Env,
  telegramId: number,
  uid: string,
  lang: string,
): Promise<void> {
  const expires = nowSec() + tierDurationDays('trial30')! * 86400;
  const link = await createPersonalInvite(env, 'trial', telegramId);

  await grantEntitlement(env, {
    telegram_id: telegramId,
    source: 'trial',
    tier: 'trial30',
    expires_at: expires,
    bitunix_uid: uid,
    invite_link: link,
  });
  await redeemUid(env, uid, telegramId);

  await sendDM(env, telegramId, t(asLang(lang), 'trial_approved_welcome', { invite: link }));
}

/**
 * Grant a paid subscription after payment confirmation. Lifetime -> no expiry.
 * Creates a personal invite and DMs the localized confirmation.
 */
export async function grantPaidAccess(
  env: Env,
  telegramId: number,
  tier: 'monthly' | 'quarterly' | 'lifetime',
  lang: string,
): Promise<void> {
  const dur = tierDurationDays(tier);
  const expires = dur === null ? null : nowSec() + dur * 86400;
  const link = await createPersonalInvite(env, 'paid', telegramId);

  await grantEntitlement(env, {
    telegram_id: telegramId,
    source: 'paid',
    tier,
    expires_at: expires,
    invite_link: link,
  });

  await sendDM(env, telegramId, t(asLang(lang), 'paid_payment_confirmed', { invite: link }));
}
