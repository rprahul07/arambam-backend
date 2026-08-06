import { query } from '../database/index.js';
import { toNotification } from '../serializers/index.js';
import logger from '../utils/logger.js';

/**
 * The in-app notification centre behind the bell in the header.
 *
 * `push` accepts an optional transaction client so a notification is written
 * in the same transaction as the thing it announces — a confirmed seat and the
 * "seat confirmed" notice either both exist or neither does.
 */
export async function push({ client, userId, type, title, body = '', href = null }) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `INSERT INTO notifications (user_id, type, title, body, href)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [userId, type, title, body, href],
  );
  return toNotification(rows[0]);
}

/** Fire-and-forget variant for paths where a failed notice must not bubble. */
export const pushQuietly = (args) =>
  push(args).catch((error) => logger.error('Notification failed:', error.message));

/** One insert for many recipients — used when an event is cancelled. */
export async function pushMany({ client, recipients }) {
  if (!recipients.length) return 0;
  const run = client ? client.query.bind(client) : query;

  const values = [];
  const params = [];
  recipients.forEach((item, index) => {
    const base = index * 5;
    values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`);
    params.push(item.userId, item.type, item.title, item.body ?? '', item.href ?? null);
  });

  const { rowCount } = await run(
    `INSERT INTO notifications (user_id, type, title, body, href) VALUES ${values.join(',')}`,
    params,
  );
  return rowCount;
}

export default { push, pushQuietly, pushMany };
