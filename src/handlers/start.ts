// /start + language-picker + main-menu flow.
// registerStart(bot) wires the /start command and the lang:<code> callback onto
// the shared bot. Trial/buy callbacks are owned by other handlers.

import { Bot, InlineKeyboard } from 'grammy';
import { type MyContext } from '../bot';
import { asLang, LANGS } from '../config';
import { getUser, upsertUser } from '../db';
import { t } from '../i18n';

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

export function registerStart(bot: Bot<MyContext>): void {
  // /start: greet + language picker if no stored lang, else jump to the main menu.
  bot.command('start', async (ctx) => {
    const fromId = ctx.from?.id;
    if (fromId === undefined) return;

    const user = await getUser(ctx.env, fromId);

    if (!user?.lang) {
      await ctx.reply(t('en', 'start_welcome'));
      await ctx.reply(t('en', 'language_picker'), { reply_markup: languageKeyboard() });
      return;
    }

    await ctx.reply(t(user.lang, 'main_menu_header'), {
      reply_markup: mainMenuKeyboard(user.lang),
    });
  });

  // lang:<code> — store the chosen language, then show the main menu.
  bot.callbackQuery(/^lang:(\w{2})$/, async (ctx) => {
    const fromId = ctx.from?.id;
    if (fromId === undefined) return;

    const code = asLang(ctx.match?.[1]);
    await upsertUser(ctx.env, fromId, code);
    await ctx.answerCallbackQuery();

    await ctx.reply(t(code, 'language_set'));
    await ctx.reply(t(code, 'main_menu_header'), {
      reply_markup: mainMenuKeyboard(code),
    });
  });
}
