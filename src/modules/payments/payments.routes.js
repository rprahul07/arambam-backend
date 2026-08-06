import { Router } from 'express';
import { z } from 'zod';
import * as service from './payments.service.js';
import { queryOne } from '../../database/index.js';
import { PAYMENT_PURPOSE_VALUES, PAYMENT_STATUS_VALUES, ROLES } from '../../config/constants.js';
import { toPayment } from '../../serializers/index.js';
import asyncHandler from '../../utils/asyncHandler.js';
import ApiError from '../../utils/ApiError.js';
import { ok, paginated } from '../../utils/response.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';

const router = Router();

const idParam = z.object({ id: z.string().uuid('Unknown payment') });

const settleSchema = z.object({
  /**
   * What the gateway reported. With a live gateway this is only believed for
   * `successful` once the signature verifies — see `gateway.service.js`.
   */
  outcome: z.enum(PAYMENT_STATUS_VALUES),
  gatewayPaymentId: z.string().trim().max(120).optional(),
  signature: z.string().trim().max(256).optional(),
});

const listSchema = z.object({
  memberId: z.string().uuid().optional(),
  status: z.enum(PAYMENT_STATUS_VALUES).optional(),
  purpose: z.enum(PAYMENT_PURPOSE_VALUES).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

/**
 * GET   /payments             The ledger — a member's own, or everything (administrator)
 * GET   /payments/:id         One transaction
 * POST  /payments/:id/settle  Apply the verified gateway outcome
 */

router.use(authenticate);

router.get(
  '/',
  validateQuery(listSchema),
  asyncHandler(async (req, res) => {
    const { rows, meta } = await service.list(req.validatedQuery, req.user);
    return paginated(res, rows, meta);
  }),
);

router.get(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const payment = await service.findById(req.params.id);
    if (!payment) throw ApiError.notFound('That payment no longer exists');
    if (req.user.role !== ROLES.ADMIN && payment.member_id !== req.user.member_id) {
      throw ApiError.forbidden('That is not your payment');
    }
    return ok(res, toPayment(payment));
  }),
);

router.post(
  '/:id/settle',
  writeLimiter,
  validateParams(idParam),
  validateBody(settleSchema),
  asyncHandler(async (req, res) => {
    const payment = await service.findById(req.params.id);
    if (!payment) throw ApiError.notFound('That payment no longer exists');

    // A payment belongs to the member who opened it. Nobody else may close it.
    if (req.user.role !== ROLES.ADMIN && payment.member_id !== req.user.member_id) {
      throw ApiError.forbidden('That is not your payment');
    }

    const { payment: settled, alreadySettled } = await service.settle(
      { paymentId: req.params.id, ...req.body },
      req.user,
    );

    return ok(
      res,
      settled,
      alreadySettled
        ? 'That payment had already been settled'
        : settled.status === 'successful'
          ? 'Payment confirmed'
          : 'Payment was not completed — nothing has been charged',
    );
  }),
);

/** GET /payments/:id/receipt — the data a receipt is printed from. */
router.get(
  '/:id/receipt',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const payment = await service.findById(req.params.id);
    if (!payment) throw ApiError.notFound('That payment no longer exists');
    if (req.user.role !== ROLES.ADMIN && payment.member_id !== req.user.member_id) {
      throw ApiError.forbidden('That is not your payment');
    }
    if (payment.status !== 'successful') {
      throw ApiError.badRequest('A receipt is only issued for a successful payment');
    }

    const [member, organisation] = await Promise.all([
      queryOne(`SELECT full_name, member_id, email, phone FROM members WHERE id = $1`, [payment.member_id]),
      queryOne(`SELECT value FROM settings WHERE key = 'organisation'`),
    ]);

    return ok(res, {
      payment: toPayment(payment),
      member: {
        fullName: member?.full_name ?? payment.payer_name,
        memberId: member?.member_id ?? '',
        email: member?.email ?? '',
        phone: member?.phone ?? '',
      },
      organisation: organisation?.value ?? {},
    });
  }),
);

export default router;
