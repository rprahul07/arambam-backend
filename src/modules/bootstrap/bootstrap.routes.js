import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { ok } from '../../utils/response.js';
import { optionalAuth } from '../../middleware/auth.js';
import { snapshot } from './bootstrap.service.js';

const router = Router();

/**
 * GET /bootstrap
 *
 * The whole application state the interface renders from, cut to the caller's
 * role. Anonymous callers get the public site's data; a member gets their own
 * records plus counters; staff get what their job needs.
 */
router.get(
  '/',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const data = await snapshot(req.user ?? null);
    // The payload is per-account and changes on every write.
    res.set('Cache-Control', 'private, no-store');
    return ok(res, data);
  }),
);

export default router;
