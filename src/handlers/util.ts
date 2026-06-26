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

  // When the bot is added to a channel/group as admin, DM the person who added it the
  // chat id. Private CHANNELS can't run /id inside, so this is how you grab VIP_CHAT_ID:
  // just add the bot as admin to your VIP channel and it sends you the id.
  bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    if (status !== 'administrator' && status !== 'member' && status !== 'creator') return;
    const chat = ctx.myChatMember.chat;
    const adderId = ctx.myChatMember.from?.id;
    if (!adderId) return;
    try {
      await ctx.api.sendMessage(
        adderId,
        `Added to "${chat.title ?? chat.id}" (${chat.type}).\nchat_id: ${chat.id}\n\nSend this id to set VIP_CHAT_ID.`,
      );
    } catch {
      // The adder hasn't started a DM with the bot — nothing we can do; ignore.
    }
  });
}
