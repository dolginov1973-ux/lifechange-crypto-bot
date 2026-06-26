// Utility commands. /id echoes the current chat id + caller id — used during setup to
// grab VIP_CHAT_ID / ADMIN_CHAT_ID (negative for supergroups) without a third-party bot.
// Harmless: a user only ever sees their own chat's id.

import { type Bot } from 'grammy';
import { type MyContext } from '../bot';

export function registerUtil(bot: Bot<MyContext>): void {
  bot.command('id', async (ctx) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    await ctx.reply(
      `chat_id: <code>${chatId}</code>\nyour user_id: <code>${userId}</code>`,
      { parse_mode: 'HTML' },
    );
  });
}
