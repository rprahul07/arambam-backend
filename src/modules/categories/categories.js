import { Router } from 'express';
import { z } from 'zod';
import { query, queryAll, queryOne } from '../../database/index.js';
import { toCategory } from '../../serializers/index.js';
import asyncHandler from '../../utils/asyncHandler.js';
import ApiError from '../../utils/ApiError.js';
import { ok, created, noContent } from '../../utils/response.js';
import { slugify } from '../../utils/codes.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import { authenticate, adminOnly } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { recordQuietly } from '../../services/activity.service.js';

/**
 * Event categories — the colour coding behind the calendar and the chips.
 *
 * Small enough that route, validation and handler read better together than
 * spread across four files; anything with real domain logic gets its own
 * module directory.
 */

const router = Router();

const categorySchema = z.object({
  /** Optional client-supplied UUID — see `events.validation.js`. */
  id: z.string().uuid('Invalid id').optional(),
  name: z.string().trim().min(2, 'Give the category a name').max(80),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and hyphens')
    .max(80)
    .optional(),
  description: z.string().trim().max(500).default(''),
  color: z.string().trim().min(1).max(80).default('var(--color-lilac-500)'),
  active: z.boolean().default(true),
});

const updateSchema = categorySchema.partial();
const idParam = z.object({ id: z.string().uuid('Unknown category') });

/** GET /event-categories */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await queryAll(`SELECT * FROM event_categories ORDER BY name`);
    return ok(res, rows.map(toCategory));
  }),
);

/** POST /event-categories */
router.post(
  '/',
  authenticate,
  adminOnly,
  writeLimiter,
  validateBody(categorySchema),
  asyncHandler(async (req, res) => {
    const { name, description, color, active } = req.body;
    const row = await queryOne(
      `INSERT INTO event_categories (id, name, slug, description, color, active)
       VALUES (COALESCE($6::uuid, gen_random_uuid()),$1,$2,$3,$4,$5) RETURNING *`,
      [name, req.body.slug || slugify(name), description, color, active, req.body.id ?? null],
    );

    recordQuietly({
      actorId: req.user.id,
      subjectType: 'event_category',
      subjectId: row.id,
      action: 'create',
      description: `Created the "${row.name}" category`,
    });

    return created(res, toCategory(row), 'Category created');
  }),
);

/** PATCH /event-categories/:id */
router.patch(
  '/:id',
  authenticate,
  adminOnly,
  writeLimiter,
  validateParams(idParam),
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const COLUMNS = { name: 'name', slug: 'slug', description: 'description', color: 'color', active: 'active' };
    const sets = [];
    const params = [];

    for (const [field, column] of Object.entries(COLUMNS)) {
      if (req.body[field] === undefined) continue;
      params.push(req.body[field]);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) throw ApiError.badRequest('Nothing to update');

    params.push(req.params.id);
    const row = await queryOne(
      `UPDATE event_categories SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (!row) throw ApiError.notFound('That category no longer exists');

    recordQuietly({
      actorId: req.user.id,
      subjectType: 'event_category',
      subjectId: row.id,
      action: 'update',
      description: `Updated the "${row.name}" category`,
    });

    return ok(res, toCategory(row), 'Category updated');
  }),
);

/**
 * DELETE /event-categories/:id
 *
 * Refused while events still point at it — an event without a category has no
 * colour on the calendar and no chip on its card. Deactivating is the way to
 * retire one, which is why `active` exists.
 */
router.delete(
  '/:id',
  authenticate,
  adminOnly,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const inUse = await queryOne(`SELECT COUNT(*)::int AS n FROM events WHERE category_id = $1`, [
      req.params.id,
    ]);
    if (inUse.n > 0) {
      throw ApiError.conflict(
        `${inUse.n} events use this category — deactivate it instead`,
        undefined,
        'CATEGORY_IN_USE',
      );
    }

    const { rowCount } = await query(`DELETE FROM event_categories WHERE id = $1`, [req.params.id]);
    if (!rowCount) throw ApiError.notFound('That category no longer exists');

    recordQuietly({
      actorId: req.user.id,
      subjectType: 'event_category',
      subjectId: req.params.id,
      action: 'delete',
      description: 'Deleted a category',
    });

    return noContent(res);
  }),
);

export default router;
