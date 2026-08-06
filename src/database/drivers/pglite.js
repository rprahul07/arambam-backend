import fs from 'node:fs';
import path from 'node:path';
import { PGlite, types } from '@electric-sql/pglite';
import env from '../../config/env.js';

/**
 * PostgreSQL 16 running in-process (WASM), persisted to `env.db.dataDir`.
 *
 * It exists so the API — and therefore the front end — runs with no external
 * services. The SQL, the type mapping and the transaction semantics are the
 * same ones the `postgres` driver gives you against Supabase, which is what
 * makes it safe to develop against and then deploy unchanged.
 */

/** Match the `pg` driver's parsers exactly, so mappers never branch. */
const parsers = {
  [types.NUMERIC]: (value) => (value === null ? null : Number.parseFloat(value)),
  [types.INT8]: (value) => (value === null ? null : Number.parseInt(value, 10)),
  [types.DATE]: (value) => value,
};

let db = null;
/** PGlite is single-connection: transactions must not interleave. */
let queue = Promise.resolve();

const serialise = (work) => {
  const next = queue.then(work, work);
  // Keep the chain alive even when a caller's work rejects.
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
};

const wrap = (tx) => ({
  query: (text, params = []) => tx.query(text, params),
  queryOne: async (text, params = []) => (await tx.query(text, params)).rows[0] ?? null,
  queryAll: async (text, params = []) => (await tx.query(text, params)).rows,
});

export default {
  async connect() {
    if (db) return;
    const inMemory = env.db.dataDir === ':memory:';
    if (!inMemory) fs.mkdirSync(path.dirname(env.db.dataDir), { recursive: true });
    db = await PGlite.create({
      dataDir: inMemory ? undefined : env.db.dataDir,
      parsers,
    });
    await db.query('SELECT 1');
  },

  query(text, params = []) {
    return serialise(() => db.query(text, params));
  },

  withTransaction(handler) {
    return serialise(() => db.transaction((tx) => handler(wrap(tx))));
  },

  exec(sql) {
    return serialise(() => db.exec(sql));
  },

  async close() {
    await queue.catch(() => undefined);
    await db?.close();
    db = null;
  },
};
