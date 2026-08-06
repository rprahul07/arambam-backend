import { Router } from 'express';
import { z } from 'zod';
import { queryAll, queryOne, withTransaction } from '../../database/index.js';
import {
  PAYMENT_METHOD_VALUES,
  PAYMENT_PURPOSE,
  ROLES,
  SUBSCRIPTION_KIND_VALUES,
} from '../../config/constants.js';
import { toPayment, toSubscription } from '../../serializers/index.js';
import asyncHandler from '../../utils/asyncHandler.js';
import ApiError from '../../utils/ApiError.js';
import { ok, created } from '../../utils/response.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import { authenticate, adminOnly } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { createOrder } from '../../services/gateway.service.js';
import { recordQuietly } from '../../services/activity.service.js';

/**
 * Memberships.
 *
 * The only rule with any subtlety is when a subscription starts. A renewal
 * begins where the current one ends, so a member who renews early keeps the
 * days they have already paid for; anything else begins today. Nothing is
 * active until its payment settles.
 */

const router = Router();

const purchaseSchema = z.object({
  memberId: z.string().uuid().optional(),
  planId: z.string().uuid('Choose a plan'),
  kind: z.enum(SUBSCRIPTION_KIND_VALUES).default('new'),
  method: z.enum(PAYMENT_METHOD_VALUES).default('upi'),
  /** Optional client-supplied UUIDs — see `events.validation.js`. */
  id: z.string().uuid('Invalid id').optional(),
  paymentId: z.string().uuid('Invalid id').optional(),
});

const listSchema = z.object({
  memberId: z.string().uuid().optional(),
  status: z.enum(['active', 'expired', 'cancelled', 'pending']).optional(),
});

const idParam = z.object({ id: z.string().uuid('Unknown subscription') });

/** Adds whole months, clamping to the last day of a shorter month. */
function addMonths(date, months) {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

const asDate = (value) => new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
const toDay = (date) => date.toISOString().slice(0, 10);

router.use(authenticate);

/** GET /subscriptions */
router.get(
  '/',
  validateQuery(listSchema),
  asyncHandler(async (req, res) => {
    const filters = req.validatedQuery;
    const memberId = req.user.role === ROLES.ADMIN ? filters.memberId : req.user.member_id;
    if (!memberId && req.user.role !== ROLES.ADMIN) return ok(res, []);

    const where = [];
    const params = [];
    if (memberId) {
      params.push(memberId);
      where.push(`member_id = $${params.length}`);
    }
    if (filters.status) {
      params.push(filters.status);
      where.push(`status = $${params.length}`);
    }

    const rows = await queryAll(
      `SELECT * FROM subscriptions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC`,
      params,
    );
    return ok(res, rows.map(toSubscription));
  }),
);

/**
 * POST /subscriptions
 *
 * Opens a membership purchase and the payment that has to settle before it
 * counts. Returns both, which is what the membership screen's payment dialog
 * needs to drive the rest of the flow.
 */
router.post(
  '/',
  writeLimiter,
  validateBody(purchaseSchema),
  asyncHandler(async (req, res) => {
    const isAdmin = req.user.role === ROLES.ADMIN;
    const memberId = isAdmin && req.body.memberId ? req.body.memberId : req.user.member_id;

    if (!memberId) {
      throw new ApiError(
        403,
        'Complete your member profile before choosing a plan',
        undefined,
        'MEMBER_PROFILE_REQUIRED',
      );
    }
    if (!isAdmin && req.body.memberId && req.body.memberId !== req.user.member_id) {
      throw ApiError.forbidden('You can only buy a membership for yourself');
    }

    const member = await queryOne(`SELECT * FROM members WHERE id = $1`, [memberId]);
    if (!member) throw ApiError.notFound('That member no longer exists');

    const plan = await queryOne(`SELECT * FROM membership_plans WHERE id = $1`, [req.body.planId]);
    if (!plan) throw ApiError.notFound('That plan no longer exists');
    if (!plan.active && !isAdmin) {
      throw ApiError.badRequest('That plan is no longer on sale', { planId: 'Not available' });
    }

    const pending = await queryOne(
      `SELECT s.id FROM subscriptions s
       JOIN payments p ON p.id = s.payment_id
       WHERE s.member_id = $1 AND s.status = 'pending' AND p.status = 'pending'`,
      [memberId],
    );
    if (pending) {
      throw ApiError.conflict(
        'A membership payment is already in progress. Finish or cancel it first.',
        undefined,
        'PURCHASE_IN_PROGRESS',
      );
    }

    // A renewal continues from where the current membership ends.
    const current = member.current_subscription_id
      ? await queryOne(`SELECT * FROM subscriptions WHERE id = $1`, [member.current_subscription_id])
      : null;

    const now = new Date();
    const start =
      req.body.kind === 'renewal' && current && asDate(current.end_date) > now
        ? asDate(current.end_date)
        : now;

    const amount = Number(plan.price);
    const durationLabel =
      req.body.kind === 'renewal'
        ? 'renewal'
        : req.body.kind === 'upgrade'
          ? 'upgrade'
          : `${plan.duration_months} months`;
    const description = `${plan.name} membership — ${durationLabel}`;

    const order = await createOrder({
      amount,
      receipt: `sub-${memberId.slice(0, 8)}-${Date.now().toString(36)}`,
      notes: { memberId, planId: plan.id, kind: req.body.kind },
    });

    const result = await withTransaction(async (tx) => {
      const subscription = await tx.queryOne(
        `INSERT INTO subscriptions (id, member_id, plan_id, start_date, end_date, amount, status, kind)
         VALUES (COALESCE($7::uuid, gen_random_uuid()),$1,$2,$3,$4,$5,'pending',$6)
         RETURNING *`,
        [
          memberId,
          plan.id,
          toDay(start),
          toDay(addMonths(start, plan.duration_months)),
          amount,
          req.body.kind,
          req.body.id ?? null,
        ],
      );

      const payment = await tx.queryOne(
        `INSERT INTO payments (id, reference, member_id, payer_name, purpose, subscription_id,
                               description, amount, method, status, gateway, gateway_order_id)
         VALUES (COALESCE($11::uuid, gen_random_uuid()),
                 $1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)
         RETURNING *`,
        [
          order.reference,
          memberId,
          member.full_name,
          PAYMENT_PURPOSE.MEMBERSHIP,
          subscription.id,
          description,
          amount,
          req.body.method,
          order.gateway,
          order.orderId,
          req.body.paymentId ?? null,
        ],
      );

      const linked = await tx.queryOne(
        `UPDATE subscriptions SET payment_id = $1 WHERE id = $2 RETURNING *`,
        [payment.id, subscription.id],
      );

      return { subscription: linked, payment };
    });

    recordQuietly({
      actorId: req.user.id,
      subjectType: 'subscription',
      subjectId: result.subscription.id,
      action: 'create',
      description: `${member.full_name} started a ${plan.name} ${req.body.kind}`,
      meta: { amount },
    });

    return created(
      res,
      { subscription: toSubscription(result.subscription), payment: toPayment(result.payment) },
      'Membership reserved — complete the payment to activate it',
    );
  }),
);

/**
 * PATCH /subscriptions/:id/cancel
 *
 * Ends a membership early. Administrators only: a member cancelling their own
 * paid membership is a refund conversation, not a button.
 */
router.patch(
  '/:id/cancel',
  adminOnly,
  writeLimiter,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const subscription = await queryOne(`SELECT * FROM subscriptions WHERE id = $1`, [req.params.id]);
    if (!subscription) throw ApiError.notFound('That subscription no longer exists');
    if (subscription.status === 'cancelled') throw ApiError.conflict('That subscription is already cancelled');

    const row = await withTransaction(async (tx) => {
      const updated = await tx.queryOne(
        `UPDATE subscriptions SET status = 'cancelled' WHERE id = $1 RETURNING *`,
        [req.params.id],
      );
      await tx.query(
        `UPDATE members SET status = 'expired', current_subscription_id = NULL
         WHERE id = $1 AND current_subscription_id = $2`,
        [subscription.member_id, subscription.id],
      );
      return updated;
    });

    recordQuietly({
      actorId: req.user.id,
      subjectType: 'subscription',
      subjectId: req.params.id,
      action: 'cancel',
      description: 'Subscription cancelled',
    });

    return ok(res, toSubscription(row), 'Subscription cancelled');
  }),
);

export default router;
