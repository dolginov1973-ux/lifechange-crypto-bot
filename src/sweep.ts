// Hourly expiry sweep: remove users whose VIP entitlement has lapsed.
// Contract: runSweep(env): Promise<void>.
//
// For each due (active, past-expiry) entitlement:
//   - Renewal race guard: if the user now has a DIFFERENT active, still-valid
//     entitlement (e.g. they renewed), do NOT kick them — just expire this stale row.
//   - Otherwise plain-kick them from the VIP chat (ban -> unban, see kickFromVip) and
//     revoke the leaked personal invite link.
//   - Always mark this row expired.
//
// Each entitlement is processed in its own try/catch so one failure never aborts the
// batch. expireEntitlement / kickFromVip are idempotent, so re-running is safe.

import { type Env, nowSec } from './config';
import { getActiveEntitlement, getDueExpiries, expireEntitlement } from './db';
import { kickFromVip } from './services/access';

export async function runSweep(env: Env): Promise<void> {
  const now = nowSec();
  const due = await getDueExpiries(env, now);

  for (const ent of due) {
    try {
      // Renewal race: a fresh, still-valid entitlement on a different row means the
      // user is legitimately still in — don't kick, just retire this stale row.
      const active = await getActiveEntitlement(env, ent.telegram_id);
      const stillEntitled = active != null && active.id !== ent.id;

      if (!stillEntitled) {
        await kickFromVip(env, ent.telegram_id, ent.invite_link);
      }

      await expireEntitlement(env, ent.id);
    } catch (e) {
      // Isolate per-row failures so the rest of the batch still drains.
      console.error('sweep', ent.id, e);
    }
    // TODO(v1): conversion cadence — DM lapsed users an expired/win-back message here.
  }
}
