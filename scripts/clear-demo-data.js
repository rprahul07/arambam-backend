#!/usr/bin/env node
/**
 * Clears the demonstration data, leaving a site that is set up but empty.
 *
 * What goes: every event, registration, payment, subscription and notification,
 * and every member except the accounts used to sign in. This is the seeded
 * material that makes the site look busy — useful while building, wrong to
 * hand over.
 *
 * What stays, deliberately:
 *
 *   settings          the organisation's address, phone, hours, QR — the thing
 *                     that was just corrected, and not demonstration data.
 *   membership_plans  what a member can buy.
 *   event_categories  what an event can be filed under.
 *   email_templates   the wording of what gets sent.
 *   users / members   only the accounts listed in KEEP below.
 *
 * Nothing is dropped and nothing is re-seeded, so the schema and the settings
 * come through untouched.
 *
 *   node scripts/clear-demo-data.js            # count what would go
 *   node scripts/clear-demo-data.js --write    # do it
 */
import db from '../src/database/index.js';
import env from '../src/config/env.js';

/** The sign-in accounts, one per level. Everything else is demonstration. */
const KEEP = [
  'revathi@aarambam.org', // administrator
  'aravind@aarambam.org', // facilitator
  'divya.bharathi@gmail.com', // member
];

/**
 * Emptied completely, in an order that respects the foreign keys: a child
 * table is always cleared before the table it points at.
 */
const EMPTY = [
  'refresh_tokens', // signs everyone out, which is wanted at handover
  'notifications',
  'email_log',
  'activity_log',
  'payments',
  'registrations',
  'subscriptions',
  'events',
];

/** Left alone entirely. Listed so the intent is visible, not just the absence. */
const UNTOUCHED = ['settings', 'membership_plans', 'event_categories', 'email_templates'];

const write = process.argv.includes('--write');
const line = (t = '') => process.stdout.write(`${t}\n`);

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const rest = (table) => `${env.supabase.url}/rest/v1/${table}`;
const restHeaders = (extra = {}) => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

let overHttps = false;

async function countRows(table, filter) {
  if (!overHttps) {
    const where = filter ? ` WHERE ${filter.sql}` : '';
    const row = await db.queryOne(`SELECT count(*)::int AS n FROM ${table}${where}`, filter?.params ?? []);
    return row?.n ?? 0;
  }
  const res = await fetch(`${rest(table)}?select=*${filter ? `&${filter.rest}` : ''}`, {
    headers: restHeaders({ Prefer: 'count=exact', Range: '0-0' }),
  });
  if (!res.ok) throw new Error(`count ${table}: ${res.status} ${await res.text()}`);
  return Number((res.headers.get('content-range') ?? '/0').split('/')[1]) || 0;
}

async function deleteRows(table, filter) {
  if (!overHttps) {
    const where = filter ? ` WHERE ${filter.sql}` : '';
    await db.query(`DELETE FROM ${table}${where}`, filter?.params ?? []);
    return;
  }
  /* PostgREST refuses an unfiltered delete, which is a good habit; `id` is
     never null, so this says "all of them" without saying it dangerously. */
  const scope = filter ? filter.rest : 'id=not.is.null';
  const res = await fetch(`${rest(table)}?${scope}`, {
    method: 'DELETE',
    headers: restHeaders({ Prefer: 'return=minimal' }),
  });
  if (!res.ok) throw new Error(`delete ${table}: ${res.status} ${await res.text()}`);
}

/* Non-core accounts, expressed for both routes. */
const quoted = KEEP.map((e) => `'${e}'`).join(',');
const strangerUsers = {
  sql: `email NOT IN (${quoted})`,
  rest: `email=not.in.(${KEEP.join(',')})`,
};
const strangerMembers = {
  sql: `email NOT IN (${quoted})`,
  rest: `email=not.in.(${KEEP.join(',')})`,
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
  line(`${write ? 'Clearing' : 'Would clear'}:`);
  const plan = [];
  for (const table of EMPTY) plan.push([table, await countRows(table), null]);
  plan.push(['members', await countRows('members', strangerMembers), strangerMembers]);
  plan.push(['users', await countRows('users', strangerUsers), strangerUsers]);

  let total = 0;
  for (const [table, n] of plan) {
    total += n;
    line(`  ${table.padEnd(18)} ${String(n).padStart(6)} row(s)`);
  }
  line(`  ${''.padEnd(18)} ${String(total).padStart(6)} in total`);
  line();

  line('Keeping:');
  for (const table of UNTOUCHED) {
    line(`  ${table.padEnd(18)} ${String(await countRows(table)).padStart(6)} row(s), untouched`);
  }
  for (const email of KEEP) line(`  ${''.padEnd(18)} ${email}`);
  line();

  if (!write) {
    line('Nothing deleted. Re-run with --write to apply.');
  } else {
    for (const [table, n, filter] of plan) {
      if (n === 0) continue;
      await deleteRows(table, filter);
      line(`  cleared ${table}`);
    }
    line();
    line('Done. Remaining accounts:');
    const res = overHttps
      ? await (await fetch(`${rest('users')}?select=role,email&order=role`, { headers: restHeaders() })).json()
      : await db.queryAll(`SELECT role, email FROM users ORDER BY role, email`);
    for (const u of res) line(`  ${String(u.role).padEnd(14)} ${u.email}`);
  }
} finally {
  if (!overHttps) await db.close().catch(() => undefined);
}
