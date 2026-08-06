import { Router } from 'express';
import * as controller from './events.controller.js';
import * as schema from './events.validation.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import { authenticate, optionalAuth, staffOnly, adminOnly } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';

const router = Router();

/**
 * GET    /events                 Public listing, filtered and paged
 * GET    /events/:idOrSlug       One event with its live seat count
 * POST   /events                 Create               (administrator, organiser)
 * PATCH  /events/:id             Edit                 (administrator, own organiser)
 * PATCH  /events/:id/lifecycle   Publish / cancel / complete
 * DELETE /events/:id             Remove an event that has no registrations (administrator)
 */

router.get('/', optionalAuth, validateQuery(schema.listEventsSchema), controller.list);
router.get('/:idOrSlug', optionalAuth, validateParams(schema.idOrSlugParam), controller.detail);

router.post(
  '/',
  authenticate,
  staffOnly,
  writeLimiter,
  validateBody(schema.createEventSchema),
  controller.create,
);

router.patch(
  '/:id',
  authenticate,
  staffOnly,
  writeLimiter,
  validateParams(schema.idParam),
  validateBody(schema.updateEventSchema),
  controller.update,
);

router.patch(
  '/:id/lifecycle',
  authenticate,
  staffOnly,
  writeLimiter,
  validateParams(schema.idParam),
  validateBody(schema.lifecycleSchema),
  controller.setLifecycle,
);

router.delete('/:id', authenticate, adminOnly, validateParams(schema.idParam), controller.remove);

export default router;
