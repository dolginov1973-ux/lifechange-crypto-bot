// /start + language-picker + main-menu flow.
// registerStart(bot) wires the /start command and the lang:<code> callback onto
// the shared bot. Trial/buy callbacks are owned by other handlers.

import { Bot, InlineKeyboard } from 'grammy';
import { type MyContext } from '../bot';
import { asLang, LANGS, PUBLIC_CHANNELS } from '../config';
import { getUser, upsertUser, recordAcquisition, getAcquisitionSource } from '../db';
import { t } from '../i18n';

/** True if a user came from a paid ad (deep-link source ad_*). Such traffic is warmed via the
 *  free public channel FIRST, not pushed straight into the VIP trial/buy. */
const isAdSource = (src: string | null): boolean => !!src && src.startsWith('ad_');

/** Human-readable label per supported language code (for the picker buttons). */
const LANG_LABELS: Record<string, string> = {
  en: 'English',
  hi: 'हिन्दी',
  pt: 'Português',
  vi: 'Tiếng Việt',
  es: 'Español',
  tr: 'Türkçe',
  id: 'Bahasa Indonesia',
};

/** Build the language picker keyboard (callback_data 'lang:<code>', 2 per row). */
function languageKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  LANGS.forEach((code, i) => {
    kb.text(LANG_LABELS[code] ?? code, `lang:${code}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

/** Build the main menu keyboard (trial + buy callbacks owned by other handlers). */
function mainMenuKeyboard(lang: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, 'main_menu_trial_btn'), 'trial')
    .row()
    .text(t(lang, 'main_menu_buy_btn'), 'buy');
}

/** Education-first menu for AD traffic: free public channel (warm-up) as the primary CTA, with
 *  the VIP trial/buy kept as secondary options below. */
function eduMenuKeyboard(lang: string): InlineKeyboard {
  return new InlineKeyboard()
    .url(t(lang, 'edu_join_channel_btn'), PUBLIC_CHANNELS[asLang(lang)])
    .row()
    .text(t(lang, 'main_menu_trial_btn'), 'trial')
    .row()
    .text(t(lang, 'main_menu_buy_btn'), 'buy');
}

/** Show the right post-onboarding menu: ad traffic → education/channel-first, organic → VIP menu. */
async function sendMenu(ctx: MyContext, lang: string, ad: boolean): Promise<void> {
  if (ad) {
    await ctx.reply(t(lang, 'edu_menu_header'), { reply_markup: eduMenuKeyboard(lang) });
  } else {
    await ctx.reply(t(lang, 'main_menu_header'), { reply_markup: mainMenuKeyboard(lang) });
  }
}

export function registerStart(bot: Bot<MyContext>): void {
  // /start: greet + language picker if no stored lang, else jump to the main menu.
  bot.command('start', async (ctx) => {
    const fromId = ctx.from?.id;
    if (fromId === undefined) return;

    // Deep-link attribution: t.me/<bot>?start=<source> arrives as ctx.match. Record first-touch
    // source for paid-ad ROI (cost-per-start per placement). First source wins.
    const payload = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (payload) await recordAcquisition(ctx.env, fromId, payload);

    // Ad traffic (?start=ad_...) sees an EDUCATION-FIRST welcome so the bot's first screen reads
    // "analytics/education", not "VIP signals" — required to pass Telegram Ad moderation, which
    // reviews the ad destination. Organic /start keeps the normal welcome.
    const fromAd = payload.startsWith('ad_');

    const user = await getUser(ctx.env, fromId);

    if (!user?.lang) {
      await ctx.reply(t('en', fromAd ? 'start_welcome_edu' : 'start_welcome'));
      await ctx.reply(t('en', 'language_picker'), { reply_markup: languageKeyboard() });
      return;
    }

    // Returning user: ad-origin users (this click OR first-touch source) get the channel-first
    // menu; organic users get the VIP menu.
    const ad = fromAd || isAdSource(await getAcquisitionSource(ctx.env, fromId));
    await sendMenu(ctx, user.lang, ad);
  });

  // lang:<code> — store the chosen language, then show the right menu (ad → channel-first).
  bot.callbackQuery(/^lang:(\w{2})$/, async (ctx) => {
    const fromId = ctx.from?.id;
    if (fromId === undefined) return;

    const code = asLang(ctx.match?.[1]);
    await upsertUser(ctx.env, fromId, code);
    await ctx.answerCallbackQuery();

    await ctx.reply(t(code, 'language_set'));
    const ad = isAdSource(await getAcquisitionSource(ctx.env, fromId));
    await sendMenu(ctx, code, ad);
  });
}
