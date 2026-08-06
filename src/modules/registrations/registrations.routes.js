import { Router } from 'express';
import * as service from './registrations.service.js';
import * as schema from './registrations.validation.js';
import asyncHandler from '../../utils/asyncHandler.js';
import ApiError from '../../utils/ApiError.js';
import { ok, created, paginated } from '../../utils/response.js';
import { toRegistration } from '../../serializers/index.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import { authenticate, staffOnly } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { ROLES } from '../../config/constants.js';
import { findById } from './registrations.service.js';

const router = Router();

/**
 * GET   /registrations              List, scoped to what the caller may see
 * GET   /registrations/:id          One booking
 * POST  /registrations              Take a seat (and open its payment if paid)
 * PATCH /registrations/:id/cancel   Release a seat
 * PATCH /registrations/:id/attendance  Mark present or absent (staff)
 * POST  /registrations/check-in     Resolve a scanned QR or a typed code (staff)
 */

router.use(authenticate);

router.get(
  '/',
  validateQuery(schema.listSchema),
  asyncHandler(async (req, res) => {
    const { rows, meta } = await service.list(req.validatedQuery, req.user);
    return paginated(res, rows, meta);
  }),
);

router.post(
  '/',
  writeLimiter,
  validateBody(schema.createRegistrationSchema),
  asyncHandler(async (req, res) => {
    // A member books themselves. Only staff may name someone else.
    const isStaff = req.user.role === ROLES.ADMIN || req.user.role === ROLES.ORGANIZER;
    const memberId = isStaff && req.body.memberId ? req.body.memberId : req.user.member_id;

    if (!memberId) {
      throw new ApiError(
        403,
        'Complete your member profile before registering for events',
        undefined,
        'MEMBER_PROFILE_REQUIRED',
      );
    }
    if (!isStaff && req.body.memberId && req.body.memberId !== req.user.member_id) {
      throw ApiError.forbidden('You can only register yourself');
    }

    const result = await service.begin({ ...req.body, memberId }, req.user);
    return created(
      res,
      result,
      result.payment ? 'Seat held — complete the payment to confirm it' : 'Your seat is confirmed',
    );
  }),
);

router.post(
  '/check-in',
  staffOnly,
  validateBody(schema.checkInSchema),
  asyncHandler(async (req, res) => ok(res, await service.checkInByCode(req.body, req.user))),
);

router.get(
  '/:id',
  validateParams(schema.idParam),
  asyncHandler(async (req, res) => {
    const registration = await findById(req.params.id);
    if (!registration) throw ApiError.notFound('That registration no longer exists');

    const mine = req.user.member_id && registration.member_id === req.user.member_id;
    if (!mine && req.user.role === ROLES.MEMBER) throw ApiError.forbidden('That is not your registration');

    return ok(res, toRegistration(registration));
  }),
);

router.patch(
  '/:id/cancel',
  writeLimiter,
  validateParams(schema.idParam),
  validateBody(schema.cancelSchema),
  asyncHandler(async (req, res) =>
    ok(res, await service.cancel(req.params.id, req.body.reason, req.user), 'Seat released'),
  ),
);

router.patch(
  '/:id/attendance',
  staffOnly,
  writeLimiter,
  validateParams(schema.idParam),
  validateBody(schema.attendanceSchema),
  asyncHandler(async (req, res) =>
    ok(res, await service.setAttendance(req.params.id, req.body.attendance, req.user), 'Attendance recorded'),
  ),
);

export default router;
