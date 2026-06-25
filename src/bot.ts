// grammY Bot factory + shared Context type.
// Session-less: every handler reaches Cloudflare bindings via ctx.env.
// Feature engineers implement the register* functions in ./handlers/* to these
// exact signatures: register<Name>(bot: Bot<MyContext>): void.

import { Bot, Context, webhookCallback } from 'grammy';
import { type Env } from './config';

/**
 * Shared bot context. We attach the Worker `env` to every context so handlers
 * can read secrets/vars and the D1 binding without a session store.
 */
export interface MyContext extends Context {
  env: Env;
}

// ---------------------------------------------------------------------------
// Handler registration contracts (feature engineers implement these).
// Each module default-less-exports a register function with THIS signature.
//   handlers/start.ts  -> registerStart
//   handlers/trial.ts  -> registerTrial
//   handlers/paid.ts   -> registerPaid
//   handlers/admin.ts  -> registerAdmin
//   handlers/join.ts   -> registerJoin
// ---------------------------------------------------------------------------
import { registerStart } from './handlers/start';
import { registerTrial } from './handlers/trial';
import { registerPaid } from './handlers/paid';
import { registerAdmin } from './handlers/admin';
import { registerJoin } from './handlers/join';

export type RegisterFn = (bot: Bot<MyContext>) => void;

/**
 * Build a fully-configured bot for the given Worker env.
 * grammY is used in webhook mode (see createWebhookHandler); we do not call bot.start().
 */
export function createBot(env: Env): Bot<MyContext> {
  const bot = new Bot<MyContext>(env.BOT_TOKEN);

  // Make env available on every context before any handler runs.
  bot.use(async (ctx, next) => {
    ctx.env = env;
    await next();
  });

  // Register feature handlers. Order: start (language/menu) first, then flows,
  // then join-request gate, then admin (private chat) last.
  registerStart(bot);
  registerTrial(bot);
  registerPaid(bot);
  registerJoin(bot);
  registerAdmin(bot);

  // Last-resort error boundary so a thrown handler never 500s the webhook
  // (Telegram would otherwise retry the same update forever).
  bot.catch((err) => {
    console.error('bot handler error:', err.error);
  });

  return bot;
}

/**
 * Returns a fetch handler for the Telegram webhook POST body.
 * WEBHOOK_SECRET is checked at the route level in index.ts (secret-token header).
 */
export function createWebhookHandler(env: Env): (req: Request) => Promise<Response> {
  const bot = createBot(env);
  return webhookCallback(bot, 'cloudflare-mod');
}
