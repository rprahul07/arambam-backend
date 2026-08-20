#!/usr/bin/env node
/**
 * Puts the real organisation details into an existing database.
 *
 * The seed in `database/seed/catalog.js` already holds them, but a seed only
 * runs on a fresh install. A database created before those corrections arrived
 * keeps whatever it was seeded with — which is why the live site still shows a
 * Chennai address and a phone number nobody answers.
 *
 * This merges rather than replaces. Payment details — the UPI ID, the QR, the
 * instructions — are set by an administrator against a real bank account and
 * are never overwritten from a file.
 *
 * Two ways in, tried in order:
 *
 *   Postgres — the ordinary connection, when the database is reachable.
 *
 *   HTTPS — Supabase's REST interface, when it is not. Plenty of networks
 *     allow only ports 80 and 443 out, which blocks 5432 and 6543 and makes a
 *     perfectly healthy database look down. This path needs the service-role
 *     key and travels over the same port as any web page.
 *
 *   node scripts/apply-organisation.js            # show what would change
 *   node scripts/apply-organisation.js --write    # apply it
 */
import db from '../src/database/index.js';
import env from '../src/config/env.js';
import { ORGANISATION } from '../src/database/seed/catalog.js';

/* An administrator's, not ours. */
const PRESERVE = ['paymentUpiId', 'paymentQrUrl', 'paymentInstructions'];

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const REST = `${env.supabase.url}/rest/v1/settings`;
const REST_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function readOverHttps() {
  const res = await fetch(`${REST}?key=eq.organisation&select=value`, { headers: REST_HEADERS });
  if (!res.ok) throw new Error(`REST read failed: ${res.status} ${await res.text()}`);
  const [row] = await res.json();
  return row?.value ?? {};
}

async function writeOverHttps(value) {
  const res = await fetch(`${REST}?key=eq.organisation`, {
    method: 'PATCH',
    headers: { ...REST_HEADERS, Prefer: 'return=representation' },
    body: JSON.stringify({ value, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`REST write failed: ${res.status} ${await res.text()}`);
}

const write = process.argv.includes('--write');
const line = (text = '') => process.stdout.write(`${text}\n`);

/* Whichever route works. The database is preferred; HTTPS is the fallback for
   a network that will not carry a Postgres connection. */
let overHttps = false;
try {
  await db.connect();
  line('Connected to the database directly.');
  line();
} catch (error) {
  if (!SERVICE_KEY || !env.supabase.url) {
    process.stderr.write(
      `Could not reach the database (${error.message}), and there is no ` +
        `SUPABASE_SERVICE_ROLE_KEY to fall back to HTTPS with.\n`,
    );
    process.exit(1);
  }
  overHttps = true;
  line(`Could not reach the database on its own port (${error.message}).`);
  line('Using Supabase over HTTPS instead — same data, port 443.');
  line();
}

try {
  let current;
  if (overHttps) {
    current = await readOverHttps();
  } else {
    const row = await db.queryOne(`SELECT value FROM settings WHERE key = 'organisation'`);
    current = (typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value) ?? {};
  }

  const next = { ...current, ...ORGANISATION };
  for (const key of PRESERVE) {
    if (current[key]) next[key] = current[key];
  }

  const changed = Object.keys(next).filter(
    (key) => JSON.stringify(current[key]) !== JSON.stringify(next[key]),
  );

  if (changed.length === 0) {
    line('The organisation details are already correct. Nothing to do.');
  } else {
    line(`${changed.length} field(s) would change:`);
    line();
    for (const key of changed) {
      line(`  ${key}`);
      line(`    was : ${JSON.stringify(current[key] ?? null)}`);
      line(`    now : ${JSON.stringify(next[key])}`);
    }
    line();

    if (!write) {
      line('Nothing written. Re-run with --write to apply.');
    } else if (overHttps) {
      await writeOverHttps(next);
      line('Applied over HTTPS.');
    } else {
      await db.query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ('organisation', $1::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(next)],
      );
      line('Applied.');
    }
  }

  for (const key of PRESERVE) {
    if (current[key]) line(`Kept the administrator's ${key}.`);
  }
} finally {
  if (!overHttps) await db.close().catch(() => undefined);
}
