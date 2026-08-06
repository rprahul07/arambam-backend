import pg from 'pg';
import env from '../../config/env.js';
import logger from '../../utils/logger.js';

const { Pool, types } = pg;

// NUMERIC arrives as a string by default. Every money column in this schema is
// rupees with two decimals, far inside the IEEE-754 safe range, and the front
// end types them as `number` — so parse them here rather than in each mapper.
types.setTypeParser(1700, (value) => (value === null ? null : Number.parseFloat(value)));
// BIGINT, which only ever appears here as a COUNT aggregate.
types.setTypeParser(20, (value) => (value === null ? null : Number.parseInt(value, 10)));
// DATE as the plain `yyyy-MM-dd` string the front end stores in `startDate`
// and `Event.date`; letting it become a Date would shift it by the timezone.
types.setTypeParser(1082, (value) => value);

let pool = null;

const wrap = (client) => ({
  query: (text, params = []) => client.query(text, params),
  queryOne: async (text, params = []) => (await client.query(text, params)).rows[0] ?? null,
  queryAll: async (text, params = []) => (await client.query(text, params)).rows,
});

export default {
  async connect() {
    if (pool) return;
    pool = new Pool({
      connectionString: env.db.url,
      max: env.db.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      ssl: env.db.ssl ? { rejectUnauthorized: false } : false,
    });
    pool.on('error', (error) => logger.error('Idle Postgres client error:', error.message));
    const client = await pool.connect();
    client.release();
  },

  query(text, params = []) {
    return pool.query(text, params);
  },

  async withTransaction(handler) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await handler(wrap(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.error('Rollback failed:', rollbackError.message);
      }
      throw error;
    } finally {
      client.release();
    }
  },

  async exec(sql) {
    const client = await pool.connect();
    try {
      await client.query(sql);
    } finally {
      client.release();
    }
  },

  async close() {
    await pool?.end();
    pool = null;
  },
};
