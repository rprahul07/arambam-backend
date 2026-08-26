#!/usr/bin/env node
/**
 * Replaces the membership plans in an existing database with the real ones.
 *
 * Same reason as `apply-organisation.js`: the seed only runs on a fresh
 * install, so a database created before the organisation told us their actual
 * plans is still charging the four figures we invented.
 *
 * A plan that has ever been subscribed to is retired rather than deleted —
 * `subscriptions.plan_id` points at it, and a member's history should still say
 * what they paid for. Retiring means `active = false`: it stops being
 * purchasable and stays readable.
 *
 *   node scripts/apply-plans.js            # show what would change
 *   node scripts/apply-plans.js --write    # apply it
 */
import db from '../src/database/index.js';
import env from '../src/config/env.js';
import { MEMBERSHIP_PLANS } from '../src/database/seed/plans.js';

const write = process.argv.includes('--write');
const line = (t = '') => process.stdout.write(`${t}\n`);
const money = (n) => `Rs ${Number(n).toLocaleString('en-IN')}`;

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const REST = `${env.supabase.url}/rest/v1`;
const headers = (extra = {}) => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

let overHttps = false;

const readPlans = async () => {
  if (!overHttps) {
    return db.queryAll(`SELECT id, name, price, active FROM membership_plans ORDER BY sort_order`);
  }
  const res = await fetch(`${REST}/membership_plans?select=id,name,price,active&order=sort_order`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`read plans: ${res.status} ${await res.text()}`);
  return res.json();
};

const countUses = async (planId) => {
  if (!overHttps) {
    const r = await db.queryOne(`SELECT count(*)::int AS n FROM subscriptions WHERE plan_id = $1`, [planId]);
    return r?.n ?? 0;
  }
  const res = await fetch(`${REST}/subscriptions?select=id&plan_id=eq.${planId}`, {
    headers: headers({ Prefer: 'count=exact', Range: '0-0' }),
  });
  return Number((res.headers.get('content-range') ?? '/0').split('/')[1]) || 0;
};

try {
  await db.connect();
  line('Connected to the database directly.');
} catch (error) {
  if (!SERVICE_KEY || !env.supabase.url) {
    process.stderr.write(`Could not reach the database (${error.message}) and have no HTTPS fallback.\n`);
    process.exit(1);
  }
  overHttps = true;
  line(`Could not reach the database on its own port (${error.message}).`);
  line('Using Supabase over HTTPS instead — same data, port 443.');
}
line();

try {
  const existing = await readPlans();
  const wanted = new Set(MEMBERSHIP_PLANS.map((p) => p.name.toLowerCase()));

  line('Currently in the database:');
  const disposals = [];
  for (const plan of existing) {
    const uses = await countUses(plan.id);
    const keep = wanted.has(String(plan.name).toLowerCase());
    const action = keep ? 'replaced in place' : uses > 0 ? `retired (${uses} subscription(s))` : 'deleted';
    if (!keep) disposals.push({ ...plan, uses });
    line(`  ${String(plan.name).padEnd(12)} ${money(plan.price).padEnd(12)} -> ${action}`);
  }

  line();
  line('Will become:');
  for (const p of MEMBERSHIP_PLANS) {
    line(`  ${p.name.padEnd(12)} ${money(p.price).padEnd(12)} ${p.durationMonths} months` +
         `${p.recommended ? '   (recommended)' : ''}`);
    line(`      ${p.description}`);
  }
  line();

  if (!write) {
    line('Nothing written. Re-run with --write to apply.');
  } else {
    for (const plan of disposals) {
      if (plan.uses > 0) {
        if (overHttps) {
          await fetch(`${REST}/membership_plans?id=eq.${plan.id}`, {
            method: 'PATCH', headers: headers({ Prefer: 'return=minimal' }),
            body: JSON.stringify({ active: false }),
          });
        } else {
          await db.query(`UPDATE membership_plans SET active = false, updated_at = now() WHERE id = $1`, [plan.id]);
        }
        line(`  retired ${plan.name}`);
      } else {
        if (overHttps) {
          await fetch(`${REST}/membership_plans?id=eq.${plan.id}`, {
            method: 'DELETE', headers: headers({ Prefer: 'return=minimal' }),
          });
        } else {
          await db.query(`DELETE FROM membership_plans WHERE id = $1`, [plan.id]);
        }
        line(`  deleted ${plan.name}`);
      }
    }

    for (const p of MEMBERSHIP_PLANS) {
      const row = {
        name: p.name,
        description: p.description,
        price: p.price,
        duration_months: p.durationMonths,
        benefits: p.benefits,
        active: p.active,
        recommended: p.recommended,
        sort_order: p.sortOrder,
      };
      const match = existing.find((e) => String(e.name).toLowerCase() === p.name.toLowerCase());

      if (overHttps) {
        const url = match
          ? `${REST}/membership_plans?id=eq.${match.id}`
          : `${REST}/membership_plans`;
        const res = await fetch(url, {
          method: match ? 'PATCH' : 'POST',
          headers: headers({ Prefer: 'return=minimal' }),
          body: JSON.stringify(match ? row : [row]),
        });
        if (!res.ok) throw new Error(`${p.name}: ${res.status} ${await res.text()}`);
      } else if (match) {
        await db.query(
          `UPDATE membership_plans SET name=$1, description=$2, price=$3, duration_months=$4,
             benefits=$5::jsonb, active=$6, recommended=$7, sort_order=$8, updated_at=now()
           WHERE id=$9`,
          [p.name, p.description, p.price, p.durationMonths, JSON.stringify(p.benefits),
           p.active, p.recommended, p.sortOrder, match.id],
        );
      } else {
        await db.query(
          `INSERT INTO membership_plans
             (name, description, price, duration_months, benefits, active, recommended, sort_order)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
          [p.name, p.description, p.price, p.durationMonths, JSON.stringify(p.benefits),
           p.active, p.recommended, p.sortOrder],
        );
      }
      line(`  ${match ? 'updated' : 'added  '} ${p.name}`);
    }

    line();
    line('Now on offer:');
    for (const plan of await readPlans()) {
      if (plan.active === false) continue;
      line(`  ${String(plan.name).padEnd(12)} ${money(plan.price)}`);
    }
  }
} finally {
  if (!overHttps) await db.close().catch(() => undefined);
}
