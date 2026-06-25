// Paid USDT subscription flow.
// buy CTA -> resolve geo_band from user.lang -> getPricesForBand -> paid_tier_menu
// with monthly/quarterly/lifetime labels ({price}). On tier pick -> createInvoice ->
// recordPayment(pending) -> paid_invoice_created ({pay_url}). The /pay-webhook route
// (handlers/pay-webhook.ts) finalizes the grant.

import { Bot, InlineKeyboard } from 'grammy';
import { type MyContext } from '../bot';
import { asLang, langToBand, type PaidTier } from '../config';
import { getUser, getPrice, getPricesForBand, recordPayment } from '../db';
import { createInvoice } from '../services/cryptopay';
import { t } from '../i18n';

const TIER_ORDER: readonly PaidTier[] = ['monthly', 'quarterly', 'lifetime'];

export function registerPaid(bot: Bot<MyContext>): void {
  // --- buy CTA: render the tier menu -------------------------------------
  bot.callbackQuery('buy', async (ctx) => {
    await ctx.answerCallbackQuery();

    const env = ctx.env;
    const tgId = ctx.from.id;
    const lang = (await getUser(env, tgId))?.lang ?? asLang(ctx.from.language_code);
    const band = langToBand(lang);

    const prices = await getPricesForBand(env, band);
    const priceByTier = new Map<string, number>();
    for (const row of prices) priceByTier.set(row.tier, row.amount_usdt);

    const keyboard = new InlineKeyboard();
    for (const tier of TIER_ORDER) {
      const amount = priceByTier.get(tier);
      if (amount == null) continue;
      keyboard.text(t(lang, `paid_tier_${tier}`, { price: amount }), `pay:${tier}`).row();
    }

    await ctx.reply(t(lang, 'paid_tier_menu_header'), { reply_markup: keyboard });
  });

  // --- tier pick: create invoice + record pending payment ----------------
  bot.callbackQuery(/^pay:(monthly|quarterly|lifetime)$/, async (ctx) => {
    await ctx.answerCallbackQuery();

    const env = ctx.env;
    const tgId = ctx.from.id;
    const lang = (await getUser(env, tgId))?.lang ?? asLang(ctx.from.language_code);
    const tier = ctx.match![1] as PaidTier;
    const band = langToBand(lang);

    const amount = await getPrice(env, band, tier);
    if (amount == null) {
      await ctx.reply(t(lang, 'error_try_again'));
      return;
    }

    try {
      const inv = await createInvoice(env, tgId, tier, amount);
      await recordPayment(env, {
        invoice_id: inv.invoiceId,
        telegram_id: tgId,
        processor: 'cryptopay',
        tier,
        amount_usdt: amount,
        status: 'pending',
      });

      const keyboard = new InlineKeyboard().url('Pay', inv.payUrl);
      await ctx.reply(t(lang, 'paid_invoice_created', { price: amount, pay_url: inv.payUrl }), {
        reply_markup: keyboard,
      });
    } catch (err) {
      console.error('paid createInvoice/recordPayment failed:', String(err));
      await ctx.reply(t(lang, 'error_try_again'));
    }
  });
}
