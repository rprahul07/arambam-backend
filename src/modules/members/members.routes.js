import { Router } from 'express';
import * as service from './members.service.js';
import * as schema from './members.validation.js';
import asyncHandler from '../../utils/asyncHandler.js';
import { ok, created, paginated, noContent } from '../../utils/response.js';
import {
  toMember,
  toPayment,
  toRegistration,
  toSubscription,
} from '../../serializers/index.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import { authenticate, adminOnly, staffOnly } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { uploadImage, publicUrl } from '../../middleware/upload.js';
import ApiError from '../../utils/ApiError.js';

const router = Router();

/**
 * GET    /members             The register            (administrator, organiser)
 * GET    /members/:id         One member with their history
 * POST   /members             Add a member and their account (administrator)
 * PATCH  /members/:id         Edit a profile          (administrator, or the member)
 * PATCH  /members/:id/status  Activate / suspend      (administrator)
 * POST   /members/:id/photo   Upload a photograph
 * DELETE /members/:id         Remove the person entirely (administrator)
 */

router.use(authenticate);

router.get('/', staffOnly, validateQuery(schema.listMembersSchema), asyncHandler(async (req, res) => {
  const { rows, meta } = await service.list(req.validatedQuery);
  return paginated(res, rows, meta);
}));

router.get(
  '/:id',
  validateParams(schema.idParam),
  asyncHandler(async (req, res) => {
    const found = await service.detail(req.params.id);
    service.assertMayAccess(req.user, found.member);
    return ok(res, {
      member: toMember(found.member),
      subscriptions: found.subscriptions.map(toSubscription),
      payments: found.payments.map(toPayment),
      registrations: found.registrations.map(toRegistration),
    });
  }),
);

router.post(
  '/',
  adminOnly,
  writeLimiter,
  validateBody(schema.createMemberSchema),
  asyncHandler(async (req, res) =>
    created(res, await service.create(req.body, req.user), 'Member created'),
  ),
);

router.patch(
  '/:id',
  writeLimiter,
  validateParams(schema.idParam),
  validateBody(schema.updateMemberSchema),
  asyncHandler(async (req, res) =>
    ok(res, await service.update(req.params.id, req.body, req.user), 'Profile updated'),
  ),
);

router.patch(
  '/:id/status',
  adminOnly,
  writeLimiter,
  validateParams(schema.idParam),
  validateBody(schema.statusSchema),
  asyncHandler(async (req, res) =>
    ok(res, await service.setStatus(req.params.id, req.body, req.user), 'Membership status updated'),
  ),
);

router.post(
  '/:id/photo',
  writeLimiter,
  validateParams(schema.idParam),
  ...uploadImage('member'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Choose an image to upload');
    const member = await service.findById(req.params.id);
    if (!member) throw ApiError.notFound('That member no longer exists');

    const updated = await service.update(req.params.id, { photoUrl: publicUrl(req.file) }, req.user);
    return ok(res, updated, 'Photograph updated');
  }),
);

router.delete(
  '/:id',
  adminOnly,
  validateParams(schema.idParam),
  asyncHandler(async (req, res) => {
    await service.remove(req.params.id, req.user);
    return noContent(res);
  }),
);

export default router;
