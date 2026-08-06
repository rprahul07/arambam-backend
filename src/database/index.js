import env from '../config/env.js';
import logger from '../utils/logger.js';

/**
 * One data-access surface, two engines.
 *
 *   postgres — `pg` against PostgreSQL / Supabase (production).
 *   pglite   — PostgreSQL 16 compiled to WASM, embedded in this process and
 *              persisted to disk (zero-configuration development).
 *
 * Both speak the same SQL and return rows with the same JavaScript types, so
 * nothing above this file knows or cares which one is running. Every query in
 * the codebase goes through `query`/`queryOne`/`withTransaction` with bound
 * parameters — string interpolation into SQL never happens.
 */

let driver = null;

async function loadDriver() {
  if (driver) return driver;
  driver =
    env.db.driver === 'postgres'
      ? await import('./drivers/postgres.js').then((m) => m.default)
      : await import('./drivers/pglite.js').then((m) => m.default);
  return driver;
}

/** Boots the engine. Safe to call more than once. */
export async function connect() {
  const impl = await loadDriver();
  await impl.connect();
  logger.info(`Database ready (${env.db.driver})`);
  return impl;
}

/** Runs one parameterised statement. */
export async function query(text, params = []) {
  const impl = await loadDriver();
  return impl.query(text, params);
}

/** Runs a statement and returns its first row, or `null`. */
export async function queryOne(text, params = []) {
  const { rows } = await query(text, params);
  return rows[0] ?? null;
}

/** Runs a statement and returns its rows. */
export async function queryAll(text, params = []) {
  const { rows } = await query(text, params);
  return rows;
}

/**
 * Runs `handler` inside a transaction with a dedicated connection.
 * Commits on resolve, rolls back on throw, always releases.
 *
 * The handler receives a client exposing the same `query`/`queryOne`/`queryAll`
 * helpers, so service code reads identically inside and outside a transaction.
 */
export async function withTransaction(handler) {
  const impl = await loadDriver();
  return impl.withTransaction(handler);
}

/** Executes a multi-statement script (migrations only). */
export async function exec(sql) {
  const impl = await loadDriver();
  return impl.exec(sql);
}

export async function checkConnection() {
  const row = await queryOne('SELECT now() AS now');
  return row.now;
}

export async function close() {
  if (!driver) return;
  await driver.close();
  driver = null;
}

export default { connect, query, queryOne, queryAll, withTransaction, exec, checkConnection, close };
