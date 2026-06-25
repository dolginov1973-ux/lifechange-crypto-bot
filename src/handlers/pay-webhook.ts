// Crypto Pay `invoice_paid` webhook.
// 1. Verify HMAC signature (header 'crypto-pay-api-signature'). Mismatch -> 401.
// 2. Parse the paid-invoice payload. Idempotency: markPaymentPaid returns false if the
//    invoice was already settled -> 200 no-op.
// 3. On the first paid transition: grant paid access (entitlement + personal invite + DM).
// Always return 200 except on bad signature, so Crypto Pay does not retry-storm us.

import { type Env } from '../config';
import { getUser, markPaymentPaid } from '../db';
import {
  verifyWebhookSignature,
  parsePaidWebhook,
} from '../services/cryptopay';
import { grantPaidAccess } from '../services/access';

export async function handlePayWebhook(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  try {
    const rawBody = await req.text();
    const sig = req.headers.get('crypto-pay-api-signature');

    if (!(await verifyWebhookSignature(env, rawBody, sig))) {
      return new Response('bad signature', { status: 401 });
    }

    const body = JSON.parse(rawBody);
    const parsed = await parsePaidWebhook(body);
    if (!parsed) return new Response('ignored', { status: 200 });

    const first = await markPaymentPaid(env, parsed.invoiceId);
    if (first) {
      const u = await getUser(env, parsed.telegramId);
      const lang = u?.lang ?? 'en';
      await grantPaidAccess(env, parsed.telegramId, parsed.tier, lang);
    }

    return new Response('ok', { status: 200 });
  } catch (e) {
    // Always ack internal errors to avoid Crypto Pay retry storms; bad-sig is the
    // only non-200 path above.
    console.error('pay-webhook', e);
    return new Response('ok', { status: 200 });
  }
}
