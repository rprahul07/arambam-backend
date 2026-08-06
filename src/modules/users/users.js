import { Router } from 'express';
import { z } from 'zod';
import { query, queryAll, queryOne, withTransaction } from '../../database/index.js';
import {
  ACCOUNT_STATUS_VALUES,
  MEMBERSHIP_STATUS,
  ROLES,
  ROLE_VALUES,
} from '../../config/constants.js';
import { toUser } from '../../serializers/index.js';
import asyncHandler from '../../utils/asyncHandler.js';
import ApiError from '../../utils/ApiError.js';
import { ok, paginated } from '../../utils/response.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import { authenticate, adminOnly } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { recordQuietly } from '../../services/activity.service.js';

/**
 * Accounts and roles — the "Users & roles" screen.
 *
 * Two rules stop an administrator locking everyone out by accident: nobody may
 * change their own role or status, and the last active administrator cannot be
 * demoted or deactivated.
 */

const router = Router();

const idParam = z.object({ id: z.string().uuid('Unknown user') });
const roleSchema = z.object({ role: z.enum(ROLE_VALUES) });
const statusSchema = z.object({ status: z.enum(ACCOUNT_STATUS_VALUES) });

const listSchema = z.object({
  q: z.string().trim().max(120).optional(),
  role: z.enum(ROLE_VALUES).optional(),
  status: z.enum(ACCOUNT_STATUS_VALUES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

async function assertNotLastAdministrator(userId) {
  const row = await queryOne(
    `SELECT COUNT(*)::int AS n FROM users WHERE role = $1 AND status = 'active' AND id <> $2`,
    [ROLES.ADMIN, userId],
  );
  if (row.n === 0) {
    throw ApiError.conflict(
      'This is the last active administrator — promote someone else first',
      undefined,
      'LAST_ADMINISTRATOR',
    );
  }
}

router.use(authenticate, adminOnly);

/** GET /users */
router.get(
  '/',
  validateQuery(listSchema),
  asyncHandler(async (req, res) => {
    const filters = req.validatedQuery;
    const where = [];
    const params = [];
    const bind = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (filters.q) {
      const q = bind(filters.q);
      where.push(
        `(u.name ILIKE '%' || ${q} || '%' OR u.email ILIKE '%' || ${q} || '%' OR u.phone ILIKE '%' || ${q} || '%')`,
      );
    }
    if (filters.role) where.push(`u.role = ${bind(filters.role)}`);
    if (filters.status) where.push(`u.status = ${bind(filters.status)}`);

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (filters.page - 1) * filters.pageSize;

    const rows = await queryAll(
      `SELECT u.*, COUNT(*) OVER ()::int AS total_count,
              COALESCE(
                (SELECT json_agg(e.id) FROM events e WHERE e.organizer_id = u.id),
                '[]'::json
              ) AS assigned_event_ids
       FROM users u
       ${clause}
       ORDER BY u.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.pageSize, offset],
    );

    const total = rows[0]?.total_count ?? 0;
    return paginated(
      res,
      rows.map((row) =>
        toUser(row, {
          assignedEventIds: row.role === ROLES.ORGANIZER ? row.assigned_event_ids : undefined,
        }),
      ),
      {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        pageCount: Math.max(1, Math.ceil(total / filters.pageSize)),
      },
    );
  }),
);

/** PATCH /users/:id/role */
router.patch(
  '/:id/role',
  writeLimiter,
  validateParams(idParam),
  validateBody(roleSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;

    if (id === req.user.id) {
      throw ApiError.forbidden('You cannot change your own role', undefined, 'SELF_ROLE_CHANGE');
    }

    const target = await queryOne(`SELECT * FROM users WHERE id = $1`, [id]);
    if (!target) throw ApiError.notFound('That account no longer exists');
    if (target.role === role) return ok(res, toUser(target), 'Role unchanged');

    if (target.role === ROLES.ADMIN) await assertNotLastAdministrator(id);

    // A member's profile is what makes them a member; promoting them out of
    // the role would leave a membership nobody can act on.
    if (target.role === ROLES.MEMBER && role !== ROLES.MEMBER) {
      const member = await queryOne(
        `SELECT id, status FROM members WHERE user_id = $1`,
        [id],
      );
      if (member && member.status === MEMBERSHIP_STATUS.ACTIVE) {
        throw ApiError.conflict(
          'This account holds an active membership — suspend it before changing the role',
          undefined,
          'ACTIVE_MEMBERSHIP',
        );
      }
    }

    const row = await queryOne(`UPDATE users SET role = $1 WHERE id = $2 RETURNING *`, [role, id]);

    recordQuietly({
      actorId: req.user.id,
      subjectType: 'user',
      subjectId: id,
      action: 'change_role',
      description: `${row.name}: ${target.role} → ${role}`,
    });

    return ok(res, toUser(row), `${row.name} is now ${role === ROLES.ADMIN ? 'an' : 'a'} ${role}`);
  }),
);

/** PATCH /users/:id/status */
router.patch(
  '/:id/status',
  writeLimiter,
  validateParams(idParam),
  validateBody(statusSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (id === req.user.id) {
      throw ApiError.forbidden('You cannot deactivate your own account', undefined, 'SELF_STATUS_CHANGE');
    }

    const target = await queryOne(`SELECT * FROM users WHERE id = $1`, [id]);
    if (!target) throw ApiError.notFound('That account no longer exists');
    if (status === 'inactive' && target.role === ROLES.ADMIN) await assertNotLastAdministrator(id);

    const row = await withTransaction(async (tx) => {
      const updated = await tx.queryOne(`UPDATE users SET status = $1 WHERE id = $2 RETURNING *`, [
        status,
        id,
      ]);

      if (status === 'inactive') {
        // Deactivating has to end the sessions too, or the account keeps
        // working until its access token happens to expire.
        await tx.query(
          `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
          [id],
        );
        await tx.query(
          `UPDATE members SET status = $1 WHERE user_id = $2 AND status <> $1`,
          [MEMBERSHIP_STATUS.SUSPENDED, id],
        );
      } else {
        await tx.query(
          `UPDATE members SET status = $1 WHERE user_id = $2 AND status = $3`,
          [MEMBERSHIP_STATUS.PENDING, id, MEMBERSHIP_STATUS.SUSPENDED],
        );
      }

      return updated;
    });

    recordQuietly({
      actorId: req.user.id,
      subjectType: 'user',
      subjectId: id,
      action: `status:${status}`,
      description: `${row.name} set to ${status}`,
    });

    return ok(res, toUser(row), status === 'active' ? 'Account activated' : 'Account deactivated');
  }),
);

export default router;
