#!/usr/bin/env node
/**
 * Deletes the invented membership plans outright, instead of retiring them.
 *
 * `apply-plans.js` retires a plan that has ever been subscribed to, on the
 * principle that a member's history should still say what they paid for. That
 * principle holds for a real member. It does not hold here: the only rows
 * pointing at the old plans belong to the seeded demonstration member, and the
 * organisation has asked for their plans and nothing else. Keeping four
 * placeholder tiers alive purely to explain a fake subscription is the tail
 * wagging the dog.
 *
 * So this removes the blockage first and the plans second:
 *
 *   1. members.current_subscription_id  -> NULL   (the FK does this for us)
 *   2. the subscriptions on those plans -> deleted
 *   3. their payments                   -> deleted
 *   4. the plans themselves             -> deleted
 *
 * The payment goes with the subscription rather than being unlinked from it.
 * That is not a preference: `payments_single_target` requires a membership
 * payment to name a subscription, so a payment left behind would be nulled by
 * the foreign key and then rejected by the check. A receipt for a membership
 * that no longer exists is not worth keeping in any case.
 *
 * Whatever is named in `MEMBERSHIP_PLANS` is what the organisation gave us and
 * is never touched, so this stays correct if the plans change again.
 *
 *   node scripts/remove-stale-plans.js            # show what would go
 *   node scripts/remove-stale-plans.js --write    # do it
 */
import db from '../src/database/index.js';
import env from '../src/config/env.js';
import { MEMBERSHIP_PLANS } from '../src/database/seed/plans.js';

const write = process.argv.includes('--write');
const line = (t = '') => process.stdout.write(`${t}\n`);
const money = (n) => `Rs ${Number(n).toLocaleString('en-IN')}`;

await db.connect();
/* Which database this is about to change matters more than usual here, because
   the driver is chosen by the .env that happens to be next to the process. */
line(env.db.driver === 'postgres'
  ? `Target: ${String(env.db.url).replace(/:\/\/[^@]*@/, '://***@')}`
  : `Target: embedded pglite at ${env.db.dataDir}`);
line();

try {
  const keep = MEMBERSHIP_PLANS.map((p) => p.name.toLowerCase());
  const stale = await db.queryAll(
    `SELECT id, name, price, active FROM membership_plans
      WHERE lower(name) <> ALL($1::text[]) ORDER BY sort_order`,
    [keep],
  );

  if (stale.length === 0) {
    line('Nothing to remove — every plan in the database is one the organisation gave us.');
    process.exit(0);
  }

  let subTotal = 0;
  let payTotal = 0;

  for (const plan of stale) {
    line(`${plan.name} — ${money(plan.price)}${plan.active ? '' : ' (already retired)'}`);

    const subs = await db.queryAll(
      `SELECT s.id, s.status, s.kind, s.amount, s.start_date, s.end_date,
              m.member_id, m.full_name, (m.current_subscription_id = s.id) AS is_current
         FROM subscriptions s LEFT JOIN members m ON m.id = s.member_id
        WHERE s.plan_id = $1 ORDER BY s.start_date`,
      [plan.id],
    );
    subTotal += subs.length;

    if (subs.length === 0) line('    no subscriptions — deletes cleanly');
    for (const s of subs) {
      line(`    subscription  ${s.member_id ?? '?'} ${s.full_name ?? ''} — ${s.status}, ${s.kind},` +
           ` ${money(s.amount)}, ${s.start_date} to ${s.end_date}` +
           `${s.is_current ? '   << their membership in force' : ''}`);
      const pays = await db.queryAll(
        `SELECT id, reference, receipt_no, amount, status FROM payments WHERE subscription_id = $1`,
        [s.id],
      );
      payTotal += pays.length;
      for (const p of pays) {
        line(`      payment     ${p.reference} ${money(p.amount)} ${p.status}` +
             `${p.receipt_no ? ` receipt ${p.receipt_no}` : ''}   -> deleted`);
      }
    }
    line();
  }

  line(`${stale.length} plan(s), ${subTotal} subscription(s), ${payTotal} payment(s) to delete.`);

  if (!write) {
    line();
    line('Nothing written. Re-run with --write to apply.');
    process.exit(0);
  }

  /* One transaction: a half-done removal would leave a plan whose subscriptions
     are gone but which is still on sale, which is worse than either end state. */
  line();
  await db.withTransaction(async (tx) => {
    for (const plan of stale) {
      const subs = await tx.queryAll(`SELECT id FROM subscriptions WHERE plan_id = $1`, [plan.id]);
      for (const s of subs) {
        /* The payment has to go first, and it has to go rather than be
           unlinked. `payments.subscription_id` is ON DELETE SET NULL, but
           `payments_single_target` insists a membership payment *has* a
           subscription — so leaving the payment behind would have the FK null
           the column and the CHECK reject it, and the whole transaction would
           roll back. A receipt for a membership that no longer exists is not
           worth keeping anyway. */
        await tx.query(`DELETE FROM payments WHERE subscription_id = $1`, [s.id]);
        /* `members.current_subscription_id` is also ON DELETE SET NULL and has
           no such CHECK behind it, so it clears itself as the row goes. */
        await tx.query(`DELETE FROM subscriptions WHERE id = $1`, [s.id]);
      }
      await tx.query(`DELETE FROM membership_plans WHERE id = $1`, [plan.id]);
      line(`  deleted ${plan.name}${subs.length ? ` (and ${subs.length} subscription(s))` : ''}`);
    }
  });

  line();
  line('On offer now:');
  for (const p of await db.queryAll(
    `SELECT name, price, active FROM membership_plans ORDER BY sort_order`)) {
    line(`  ${String(p.name).padEnd(12)} ${money(p.price).padEnd(12)}${p.active ? '' : '  (retired)'}`);
  }
} finally {
  await db.close().catch(() => undefined);
}
