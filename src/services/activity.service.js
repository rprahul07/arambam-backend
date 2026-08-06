import { query } from '../database/index.js';
import logger from '../utils/logger.js';

/**
 * An append-only trail of who changed what. Every administrative mutation
 * writes one row, so a suspended membership or a cancelled event can always be
 * traced back to the account that did it.
 */
export function record({ client, actorId = null, subjectType, subjectId = null, action, description = '', meta = {} }) {
  const run = client ? client.query.bind(client) : query;
  return run(
    `INSERT INTO activity_log (actor_id, subject_type, subject_id, action, description, meta)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [actorId, subjectType, subjectId, action, description, JSON.stringify(meta)],
  );
}

/** Auditing must never be the reason a user-facing action fails. */
export const recordQuietly = (args) =>
  record(args).catch((error) => logger.error('Activity log write failed:', error.message));

export default { record, recordQuietly };
