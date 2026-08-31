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
  '/:id/attendance',
  staffOnly,
  writeLimiter,
  validateParams(schema.idParam),
  validateBody(schema.attendanceSchema),
  asyncHandler(async (req, res) =>
    ok(res, await service.setAttendance(req.params.id, req.body.attendance, req.user), 'Attendance recorded'),
  ),
);

/**
 * Cancelling a seat — staff only.
 *
 * The organisation has no cancellation policy, so a member cannot release
 * their own place: they are told to be certain before booking, and the route
 * that let them undo it is gone. An administrator correcting a duplicate or a
 * booking made in error is a different act, and still has to be possible —
 * removing it outright would leave a wrong row on the register with no way to
 * put it right.
 */
router.patch(
  '/:id/cancel',
  staffOnly,
  writeLimiter,
  validateParams(schema.idParam),
  validateBody(schema.cancelSchema),
  asyncHandler(async (req, res) =>
    ok(res, await service.cancel(req.params.id, req.body.reason, req.user), 'Seat released'),
  ),
);

/**
 * Marks one day of a multi-day event.
 *
 * Separate from `/attendance` because they answer different questions:
 * `/attendance` sets the single flag on the registration, which is what the
 * old one-day model needed, while this records that somebody was in the room
 * on a particular date. Scanning a ticket lands here.
 */
router.post(
  '/:id/attendance/mark',
  staffOnly,
  writeLimiter,
  validateParams(schema.idParam),
  validateBody(schema.markAttendanceSchema),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await service.markAttendance(
        { registrationId: req.params.id, sessionDate: req.body.sessionDate },
        req.user,
      ),
      'Attendance recorded',
    ),
  ),
);

/** Every event's attendance at a glance — the administrator's register list. */
router.get(
  '/attendance/overview',
  staffOnly,
  asyncHandler(async (req, res) => ok(res, await service.attendanceOverview(req.user))),
);

/** The register for one event: who was present, on which day. */
router.get(
  '/event/:id/attendance',
  staffOnly,
  validateParams(schema.idParam),
  asyncHandler(async (req, res) => ok(res, await service.attendanceForEvent(req.params.id, req.user))),
);

export default router;
