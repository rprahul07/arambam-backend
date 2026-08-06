import { Router } from 'express';
import { z } from 'zod';
import { query, queryAll, queryOne } from '../../database/index.js';
import { toNotification } from '../../serializers/index.js';
import asyncHandler from '../../utils/asyncHandler.js';
import ApiError from '../../utils/ApiError.js';
import { ok, noContent } from '../../utils/response.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';

/**
 * The notification centre behind the bell.
 *
 * A notification belongs to exactly one account and is only ever read or
 * changed by that account — there is no administrator override here, because
 * there is nothing an administrator would need one for.
 */

const router = Router();

const idParam = z.object({ id: z.string().uuid('Unknown notification') });

const listSchema = z.object({
  unreadOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const readSchema = z.object({ read: z.boolean().default(true) });

router.use(authenticate);

/** GET /notifications */
router.get(
  '/',
  validateQuery(listSchema),
  asyncHandler(async (req, res) => {
    const { unreadOnly, limit } = req.validatedQuery;
    const rows = await queryAll(
      `SELECT * FROM notifications
       WHERE user_id = $1 ${unreadOnly ? 'AND read = false' : ''}
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.user.id, limit],
    );
    return ok(res, rows.map(toNotification));
  }),
);

/** GET /notifications/unread-count */
router.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read = false`,
      [req.user.id],
    );
    return ok(res, { count: row.count });
  }),
);

/** PATCH /notifications/:id/read */
router.patch(
  '/:id/read',
  validateParams(idParam),
  validateBody(readSchema),
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      `UPDATE notifications
       SET read = $1, read_at = CASE WHEN $1 THEN now() ELSE NULL END
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [req.body.read, req.params.id, req.user.id],
    );
    if (!row) throw ApiError.notFound('That notification no longer exists');
    return ok(res, toNotification(row), req.body.read ? 'Marked as read' : 'Marked as unread');
  }),
);

/** POST /notifications/read-all */
router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const { rowCount } = await query(
      `UPDATE notifications SET read = true, read_at = now() WHERE user_id = $1 AND read = false`,
      [req.user.id],
    );
    return ok(res, { updated: rowCount }, 'All notifications marked as read');
  }),
);

/** DELETE /notifications/:id */
router.delete(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const { rowCount } = await query(`DELETE FROM notifications WHERE id = $1 AND user_id = $2`, [
      req.params.id,
      req.user.id,
    ]);
    if (!rowCount) throw ApiError.notFound('That notification no longer exists');
    return noContent(res);
  }),
);

export default router;
