import { Router } from 'express';
import { z } from 'zod';
import { query, queryAll, queryOne } from '../../database/index.js';
import { toPlan } from '../../serializers/index.js';
import asyncHandler from '../../utils/asyncHandler.js';
import ApiError from '../../utils/ApiError.js';
import { ok, created, noContent } from '../../utils/response.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import { authenticate, adminOnly } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { recordQuietly } from '../../services/activity.service.js';

/** Membership plans — the tiers on the pricing page and in the renewal flow. */

const router = Router();

const planSchema = z.object({
  /** Optional client-supplied UUID — see `events.validation.js`. */
  id: z.string().uuid('Invalid id').optional(),
  name: z.string().trim().min(2, 'Give the plan a name').max(80),
  description: z.string().trim().max(1000).default(''),
  price: z.coerce.number().min(0, 'A price cannot be negative').max(1_000_000),
  durationMonths: z.coerce.number().int().min(1, 'A plan must last at least a month').max(120),
  benefits: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
  active: z.boolean().default(true),
  recommended: z.boolean().default(false),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});

const updateSchema = planSchema.partial();
const idParam = z.object({ id: z.string().uuid('Unknown plan') });

/** Only one tier may carry the "recommended" flag on the pricing page. */
async function clearOtherRecommendations(exceptId) {
  await query(`UPDATE membership_plans SET recommended = false WHERE id <> $1 AND recommended = true`, [
    exceptId,
  ]);
}

/** GET /plans */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await queryAll(`SELECT * FROM membership_plans ORDER BY sort_order, name`);
    return ok(res, rows.map(toPlan));
  }),
);

/** POST /plans */
router.post(
  '/',
  authenticate,
  adminOnly,
  writeLimiter,
  validateBody(planSchema),
  asyncHandler(async (req, res) => {
    const p = req.body;
    const row = await queryOne(
      `INSERT INTO membership_plans (id, name, description, price, duration_months, benefits, active, recommended, sort_order)
       VALUES (COALESCE($9::uuid, gen_random_uuid()),$1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING *`,
      [
        p.name,
        p.description,
        p.price,
        p.durationMonths,
        JSON.stringify(p.benefits),
        p.active,
        p.recommended,
        p.sortOrder,
        p.id ?? null,
      ],
    );
    if (p.recommended) await clearOtherRecommendations(row.id);

    recordQuietly({
      actorId: req.user.id,
      subjectType: 'membership_plan',
      subjectId: row.id,
      action: 'create',
      description: `Created the "${row.name}" plan`,
    });

    return created(res, toPlan(row), 'Plan created');
  }),
);

/** PATCH /plans/:id */
router.patch(
  '/:id',
  authenticate,
  adminOnly,
  writeLimiter,
  validateParams(idParam),
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const COLUMNS = {
      name: 'name',
      description: 'description',
      price: 'price',
      durationMonths: 'duration_months',
      active: 'active',
      recommended: 'recommended',
      sortOrder: 'sort_order',
    };

    const sets = [];
    const params = [];
    for (const [field, column] of Object.entries(COLUMNS)) {
      if (req.body[field] === undefined) continue;
      params.push(req.body[field]);
      sets.push(`${column} = $${params.length}`);
    }
    if (req.body.benefits !== undefined) {
      params.push(JSON.stringify(req.body.benefits));
      sets.push(`benefits = $${params.length}::jsonb`);
    }
    if (!sets.length) throw ApiError.badRequest('Nothing to update');

    params.push(req.params.id);
    const row = await queryOne(
      `UPDATE membership_plans SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (!row) throw ApiError.notFound('That plan no longer exists');
    if (req.body.recommended) await clearOtherRecommendations(row.id);

    recordQuietly({
      actorId: req.user.id,
      subjectType: 'membership_plan',
      subjectId: row.id,
      action: 'update',
      description: `Updated the "${row.name}" plan`,
    });

    return ok(res, toPlan(row), 'Plan updated');
  }),
);

/**
 * DELETE /plans/:id
 *
 * Refused once anyone has ever subscribed: the subscription history has to
 * keep naming the plan that was bought. Retiring a tier means `active: false`,
 * which is how the Student plan in the seed data is handled.
 */
router.delete(
  '/:id',
  authenticate,
  adminOnly,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const inUse = await queryOne(`SELECT COUNT(*)::int AS n FROM subscriptions WHERE plan_id = $1`, [
      req.params.id,
    ]);
    if (inUse.n > 0) {
      throw ApiError.conflict(
        `${inUse.n} subscriptions reference this plan — deactivate it instead`,
        undefined,
        'PLAN_IN_USE',
      );
    }

    const { rowCount } = await query(`DELETE FROM membership_plans WHERE id = $1`, [req.params.id]);
    if (!rowCount) throw ApiError.notFound('That plan no longer exists');

    recordQuietly({
      actorId: req.user.id,
      subjectType: 'membership_plan',
      subjectId: req.params.id,
      action: 'delete',
      description: 'Deleted a membership plan',
    });

    return noContent(res);
  }),
);

export default router;
