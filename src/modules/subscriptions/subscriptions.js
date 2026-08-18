import { Router } from 'express';
import { z } from 'zod';
import { query, queryAll, queryOne, withTransaction } from '../../database/index.js';
import env from '../../config/env.js';
import {
  PAYMENT_METHOD_VALUES,
  PAYMENT_PURPOSE,
  ROLES,
  SUBSCRIPTION_KIND,
  SUBSCRIPTION_KIND_VALUES,
  SUBSCRIPTION_STATUS,
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
 * Four kinds of purchase, and the difference between them is entirely in when
 * the term starts and what it costs:
 *
 *   new        no membership in force — starts today, full price
 *   renewal    same plan again        — starts when the current term ends,
 *                                       full price, so paid days are never lost
 *   upgrade    a dearer plan          — takes effect today, keeps the existing
 *                                       end date, charged the difference only
 *   downgrade  a cheaper plan         — starts when the current term ends,
 *                                       full price; the member keeps every day
 *                                       already paid for at the dearer rate
 *
 * All four are decided here from the member's own record rather than taken
 * from the request, because the price and the dates follow from the kind and
 * neither may be chosen by the caller.
 */

const router = Router();

const purchaseSchema = z.object({
  memberId: z.string().optional(),
  planId: z.string().min(1, 'Choose a plan'),
  /**
   * Accepted so the client can show the right wording while it waits, but not
   * trusted: the server decides the kind, and with it the dates and the price.
   */
  kind: z.enum(SUBSCRIPTION_KIND_VALUES).optional(),
  method: z.enum(PAYMENT_METHOD_VALUES).default('upi'),
  /** Optional client-supplied IDs. */
  id: z.string().optional(),
  paymentId: z.string().optional(),
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
/** Midnight UTC today, so date arithmetic never turns on the time of day. */
const today = () => asDate(new Date().toISOString());
const addDays = (date, days) => new Date(date.getTime() + days * 86_400_000);

const money = (amount) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);

const day = (value) =>
  asDate(value).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/**
 * Works out what this purchase actually is.
 *
 * `inForce` is the membership covering today; `queued` is one already paid for
 * and waiting behind it. A member may hold one of each and no more — the
 * partial unique indexes on `subscriptions` enforce the same thing, so two
 * simultaneous requests cannot slip a stack past this check.
 */
function resolvePurchase({ plan, inForce, inForcePlan }) {
  const now = today();

  if (!inForce || !inForcePlan || asDate(inForce.end_date) < now) {
    return {
      kind: SUBSCRIPTION_KIND.NEW,
      start: now,
      end: addMonths(now, plan.duration_months),
      amount: Number(plan.price),
    };
  }

  // The day after the current term is the first day the next one can cover.
  const continues = addDays(asDate(inForce.end_date), 1);

  if (plan.id === inForce.plan_id) {
    return {
      kind: SUBSCRIPTION_KIND.RENEWAL,
      start: continues,
      end: addMonths(continues, plan.duration_months),
      amount: Number(plan.price),
    };
  }

  if (Number(plan.price) > Number(inForcePlan.price)) {
    // Charged the difference and inheriting the end date, which is what the
    // membership screen has always promised. The member is not asked to pay
    // twice for days they already hold.
    return {
      kind: SUBSCRIPTION_KIND.UPGRADE,
      start: now,
      end: asDate(inForce.end_date),
      amount: Number(plan.price) - Number(inForcePlan.price),
      supersedes: inForce.id,
    };
  }

  return {
    kind: SUBSCRIPTION_KIND.DOWNGRADE,
    start: continues,
    end: addMonths(continues, plan.duration_months),
    amount: Number(plan.price),
  };
}

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

    let plan = await queryOne(`SELECT * FROM membership_plans WHERE id::text = $1`, [req.body.planId]);
    if (!plan && req.body.planId.startsWith('plan-')) {
      const nameMap = { 'plan-basic': 'Basic', 'plan-standard': 'Standard', 'plan-premium': 'Premium', 'plan-student': 'Student' };
      const name = nameMap[req.body.planId];
      if (name) {
        plan = await queryOne(`SELECT * FROM membership_plans WHERE name ILIKE $1`, [`%${name}%`]);
      }
    }
    if (!plan) throw ApiError.notFound('That plan no longer exists');
    if (!plan.active && !isAdmin) {
      throw ApiError.badRequest('That plan is no longer on sale', { planId: 'Not available' });
    }

    /**
     * A purchase already under way.
     *
     * Refusing outright was a dead end: a member who closed the payment window
     * could not buy anything at all until a sweep cleared it twenty minutes
     * later, and the message told them to "finish or cancel it" without
     * offering either. So:
     *
     *   · the same plan again — hand back the purchase they already started,
     *     so pressing the button twice resumes rather than fails. The same
     *     rule the seat booking follows.
     *   · a different plan — the untouched one is stood down and the new one
     *     opened. Nothing is lost: no money has moved against a payment that
     *     is still merely pending.
     *   · money already claimed against it — refused, because that one is
     *     real and an administrator is looking at it.
     */
    const inProgress = await queryOne(
      `SELECT s.id, s.plan_id, s.kind, p.id AS payment_id, p.status AS payment_status
       FROM subscriptions s
       JOIN payments p ON p.id = s.payment_id
       WHERE s.member_id = $1
         AND s.status = 'pending'
         AND p.status IN ('pending', 'awaiting_verification')
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [memberId],
    );

    if (inProgress?.payment_status === 'awaiting_verification') {
      throw ApiError.conflict(
        'Your last membership payment is being checked. We will confirm it shortly — there is nothing more to do.',
        undefined,
        'PURCHASE_AWAITING_VERIFICATION',
      );
    }

    if (inProgress && inProgress.plan_id === req.body.planId) {
      const [subscription, payment] = await Promise.all([
        queryOne(`SELECT * FROM subscriptions WHERE id = $1`, [inProgress.id]),
        queryOne(`SELECT * FROM payments WHERE id = $1`, [inProgress.payment_id]),
      ]);
      return created(
        res,
        { subscription: toSubscription(subscription), payment: toPayment(payment) },
        'Picking up where you left off — complete the payment to confirm it',
      );
    }

    if (inProgress) {
      await withTransaction(async (tx) => {
        await tx.query(
          `UPDATE payments SET status = 'cancelled',
                               failure_reason = 'Replaced by a later choice of plan'
           WHERE id = $1 AND status = 'pending'`,
          [inProgress.payment_id],
        );
        await tx.query(
          `UPDATE subscriptions SET status = 'cancelled' WHERE id = $1 AND status = 'pending'`,
          [inProgress.id],
        );
      });
    }

    /* The membership covering today, and anything already queued behind it.
       Read from the subscriptions themselves rather than from
       `current_subscription_id`, which only ever names the one in force. */
    const inForce = await queryOne(
      `SELECT * FROM subscriptions
       WHERE member_id = $1 AND status = $2 AND end_date >= CURRENT_DATE
       ORDER BY end_date DESC LIMIT 1`,
      [memberId, SUBSCRIPTION_STATUS.ACTIVE],
    );

    const queued = await queryOne(
      `SELECT s.*, p.name AS plan_name FROM subscriptions s
       JOIN membership_plans p ON p.id = s.plan_id
       WHERE s.member_id = $1 AND s.status = $2
       ORDER BY s.start_date ASC LIMIT 1`,
      [memberId, SUBSCRIPTION_STATUS.SCHEDULED],
    );

    // One membership in force and one waiting is the most anyone may hold.
    // Without this a member could buy the same plan repeatedly and stack
    // years of membership by accident.
    if (queued) {
      throw ApiError.conflict(
        `You already have a ${queued.plan_name} membership queued to begin on ${day(queued.start_date)}. ` +
          'Ask the office to cancel it before buying another.',
        undefined,
        'SUBSCRIPTION_ALREADY_QUEUED',
      );
    }

    const inForcePlan = inForce
      ? await queryOne(`SELECT * FROM membership_plans WHERE id = $1`, [inForce.plan_id])
      : null;

    const purchase = resolvePurchase({ plan, inForce, inForcePlan });

    // An upgrade only makes sense while there is a term left to upgrade.
    if (purchase.kind === SUBSCRIPTION_KIND.UPGRADE && purchase.amount <= 0) {
      throw ApiError.badRequest('There is nothing to pay for that change', { planId: 'Already covered' });
    }

    const { start, amount } = purchase;
    const description =
      purchase.kind === SUBSCRIPTION_KIND.UPGRADE
        ? `${plan.name} membership — upgrade from ${inForcePlan.name}`
        : purchase.kind === SUBSCRIPTION_KIND.DOWNGRADE
          ? `${plan.name} membership — change from ${inForcePlan.name}, from ${day(toDay(start))}`
          : purchase.kind === SUBSCRIPTION_KIND.RENEWAL
            ? `${plan.name} membership — renewal from ${day(toDay(start))}`
            : `${plan.name} membership — ${plan.duration_months} months`;

    const order = await createOrder({
      amount,
      receipt: `sub-${memberId.slice(0, 8)}-${Date.now().toString(36)}`,
      notes: { memberId, planId: plan.id, kind: purchase.kind },
      method: req.body.method,
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
          toDay(purchase.end),
          amount,
          purchase.kind,
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
      description: `${member.full_name} started a ${plan.name} ${purchase.kind}`,
      meta: { amount, kind: purchase.kind, startDate: toDay(start) },
    });

    const startsLater = start > today();

    return created(
      res,
      { subscription: toSubscription(result.subscription), payment: toPayment(result.payment) },
      startsLater
        ? `Pay ${money(amount)} to confirm — this membership begins on ${day(toDay(start))}, ` +
            'when your current one ends'
        : `Pay ${money(amount)} to activate this membership`,
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

      // Cancelling a queued membership leaves the one in force alone — only
      // the membership actually covering today decides the member's standing.
      if (subscription.status !== SUBSCRIPTION_STATUS.SCHEDULED) {
        await tx.query(
          `UPDATE members SET status = 'expired', current_subscription_id = NULL
           WHERE id = $1 AND current_subscription_id = $2`,
          [subscription.member_id, subscription.id],
        );
      }
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

/**
 * Closes membership purchases that were opened and never finished.
 *
 * A seat hold expires on its own; a membership purchase had nothing of the
 * kind, so closing the payment dialog left a pending payment on the account
 * for good. That is what kept "a payment is still being confirmed" on the
 * member's dashboard, and what made the next purchase attempt fail with
 * PURCHASE_IN_PROGRESS until somebody cancelled it by hand.
 */
export async function releaseAbandonedPurchases() {
  const rows = await queryAll(
    `UPDATE payments
     SET status = 'cancelled',
         failure_reason = 'The payment was not completed in time'
     WHERE purpose = $1
       AND status = 'pending'
       AND subscription_id IS NOT NULL
       AND created_at < now() - ($2 || ' minutes')::interval
     RETURNING id, subscription_id`,
    [PAYMENT_PURPOSE.MEMBERSHIP, String(env.payment.holdMinutes)],
  );

  const subscriptionIds = rows.map((row) => row.subscription_id).filter(Boolean);
  if (subscriptionIds.length) {
    await query(
      `UPDATE subscriptions SET status = 'cancelled'
       WHERE id = ANY($1) AND status = 'pending'`,
      [subscriptionIds],
    );
  }

  return rows.length;
}

export default router;
