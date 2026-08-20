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
 *   node scripts/apply-organisation.js            # show what would change
 *   node scripts/apply-organisation.js --write    # apply it
 */
import db from '../src/database/index.js';
import { ORGANISATION } from '../src/database/seed/catalog.js';

/* An administrator's, not ours. */
const PRESERVE = ['paymentUpiId', 'paymentQrUrl', 'paymentInstructions'];

const write = process.argv.includes('--write');

await db.connect();

try {
  const row = await db.queryOne(`SELECT value FROM settings WHERE key = 'organisation'`);
  const current = (typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value) ?? {};

  const next = { ...current, ...ORGANISATION };
  for (const key of PRESERVE) {
    if (current[key]) next[key] = current[key];
  }

  const changed = Object.keys(next).filter(
    (key) => JSON.stringify(current[key]) !== JSON.stringify(next[key]),
  );

  if (changed.length === 0) {
    process.stdout.write('The organisation details are already correct. Nothing to do.\n');
  } else {
    process.stdout.write(`${changed.length} field(s) would change:\n\n`);
    for (const key of changed) {
      process.stdout.write(`  ${key}\n`);
      process.stdout.write(`    was : ${JSON.stringify(current[key] ?? null)}\n`);
      process.stdout.write(`    now : ${JSON.stringify(next[key])}\n`);
    }
    process.stdout.write('\n');

    if (!write) {
      process.stdout.write('Nothing written. Re-run with --write to apply.\n');
    } else {
      await db.query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ('organisation', $1::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(next)],
      );
      process.stdout.write('Applied.\n');
    }
  }

  for (const key of PRESERVE) {
    if (current[key]) process.stdout.write(`Kept the administrator's ${key}.\n`);
  }
} finally {
  await db.close().catch(() => undefined);
}
