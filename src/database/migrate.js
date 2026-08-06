import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import db from './index.js';
import env from '../config/env.js';
import logger from '../utils/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Dropped in dependency order so `--reset` works without CASCADE surprises. */
const TABLES = [
  'activity_log',
  'email_log',
  'settings',
  'email_templates',
  'notifications',
  'payments',
  'registrations',
  'events',
  'event_categories',
  'subscriptions',
  'membership_plans',
  'members',
  'refresh_tokens',
  'users',
];

const SEQUENCES = ['member_number_seq', 'registration_ref_seq', 'receipt_no_seq'];

export async function reset() {
  logger.warn('Dropping every table — all data will be lost');
  await db.exec('DROP VIEW IF EXISTS event_seat_counts CASCADE;');
  for (const table of TABLES) {
    await db.exec(`DROP TABLE IF EXISTS ${table} CASCADE;`);
  }
  for (const sequence of SEQUENCES) {
    await db.exec(`DROP SEQUENCE IF EXISTS ${sequence} CASCADE;`);
  }
}

export async function migrate() {
  const sql = await fs.readFile(path.join(here, 'schema.sql'), 'utf8');
  await db.exec(sql);
  logger.info('Schema applied');
}

/** Entry point for `npm run db:migrate [-- --reset]`. */
async function main() {
  await db.connect();
  if (process.argv.includes('--reset')) await reset();
  await migrate();
  await db.close();
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then(() => {
      logger.info(`Migration complete (${env.db.driver})`);
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Migration failed:', error.message);
      process.exit(1);
    });
}

export default { migrate, reset };
