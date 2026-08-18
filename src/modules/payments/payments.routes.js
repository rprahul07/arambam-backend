import { Router } from 'express';
import { z } from 'zod';
import * as service from './payments.service.js';
import * as offline from './offline.service.js';
import { queryOne } from '../../database/index.js';
import { PAYMENT_PURPOSE_VALUES, PAYMENT_STATUS_VALUES, ROLES } from '../../config/constants.js';
import { toPayment } from '../../serializers/index.js';
import asyncHandler from '../../utils/asyncHandler.js';
import ApiError from '../../utils/ApiError.js';
import { ok, paginated } from '../../utils/response.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import { authenticate, adminOnly } from '../../middleware/auth.js';
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

const claimSchema = z.object({
  /* A UTR is 12–22 characters depending on the rail; an SBI Collect reference
     is its own shape. Kept permissive in form and strict in uniqueness. */
  reference: z
    .string()
    .trim()
    .min(6, 'Enter the reference exactly as your bank shows it')
    .max(64, 'That reference is longer than any bank issues'),
  note: z.string().trim().max(500).optional(),
  proofUrl: z.string().trim().url().max(500).optional(),
});

const verifySchema = z
  .object({
    approved: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.approved || Boolean(v.reason), {
    path: ['reason'],
    message: 'Say why the payment could not be verified — the payer is told',
  });

/**
 * GET   /payments                    The ledger — a member's own, or everything (administrator)
 * GET   /payments/:id                One transaction
 * POST  /payments/:id/settle         Apply the verified gateway outcome
 * POST  /payments/:id/claim          "I have paid" — quotes the bank reference
 * GET   /payments/awaiting-verification  The administrator's queue
 * POST  /payments/:id/verify         The administrator's decision on a claim
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

/**
 * GET /payments/awaiting-verification — the administrator's queue.
 *
 * Declared ahead of `/:id`, which would otherwise match the word
 * "awaiting-verification" and reject it as a malformed identifier.
 */
router.get(
  '/awaiting-verification',
  adminOnly,
  asyncHandler(async (req, res) => ok(res, await offline.pending())),
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

/* ------------------------------------------- payments made outside the system */

/**
 * POST /payments/:id/claim
 *
 * The payer stating they have paid, and quoting the reference their bank gave
 * them. This confirms nothing on its own.
 */
router.post(
  '/:id/claim',
  writeLimiter,
  validateParams(idParam),
  validateBody(claimSchema),
  asyncHandler(async (req, res) => {
    const payment = await offline.claim({ paymentId: req.params.id, ...req.body }, req.user);
    return ok(
      res,
      payment,
      'Thank you — your reference has been recorded. We will confirm once it is checked against the account.',
    );
  }),
);

/**
 * POST /payments/:id/verify
 *
 * The administrator's decision, taken with the bank statement in front of
 * them. Only this route can turn money paid outside the system into a
 * confirmed seat or an active membership.
 */
router.post(
  '/:id/verify',
  adminOnly,
  writeLimiter,
  validateParams(idParam),
  validateBody(verifySchema),
  asyncHandler(async (req, res) => {
    const result = await offline.verify(
      { paymentId: req.params.id, approved: req.body.approved, reason: req.body.reason },
      req.user,
    );
    return ok(
      res,
      result.payment,
      req.body.approved ? 'Payment verified and the booking confirmed' : 'Payment rejected and the hold released',
    );
  }),
);

export default router;
