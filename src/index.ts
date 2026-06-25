// Cloudflare Worker entry. Routes:
//   POST /bot          -> Telegram webhook (grammY), guarded by WEBHOOK_SECRET header
//   POST /pay-webhook  -> CryptoBot Crypto Pay invoice_paid (HMAC verified inside handler)
//   GET  /health       -> "ok"
// scheduled() -> hourly expiry sweep.

import { type Env } from './config';
import { createWebhookHandler } from './bot';

// Feature modules below are implemented by feature engineers to THESE signatures.
// It's fine that they don't exist yet — the import paths are the contract.
//
//   src/handlers/pay-webhook.ts
//     export function handlePayWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response>
//   src/sweep.ts
//     export function runSweep(env: Env): Promise<void>
import { handlePayWebhook } from './handlers/pay-webhook';
import { runSweep } from './sweep';

// Telegram sets this header on every webhook call when you pass `secret_token` to
// setWebhook. We compare it to WEBHOOK_SECRET to reject forged requests.
const TG_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    // --- health check ---
    if (req.method === 'GET' && pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    // --- Telegram webhook ---
    if (req.method === 'POST' && pathname === '/bot') {
      const provided = req.headers.get(TG_SECRET_HEADER);
      if (!provided || provided !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const handle = createWebhookHandler(env);
      return handle(req);
    }

    // --- payment webhook (signature verified inside the handler) ---
    if (req.method === 'POST' && pathname === '/pay-webhook') {
      return handlePayWebhook(req, env, ctx);
    }

    return new Response('not found', { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Don't let the cron invocation finish before the sweep does.
    ctx.waitUntil(runSweep(env));
  },
};
