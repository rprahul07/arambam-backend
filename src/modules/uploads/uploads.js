import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import ApiError from '../../utils/ApiError.js';
import { created } from '../../utils/response.js';
import { authenticate, staffOnly } from '../../middleware/auth.js';
import { uploadImage, publicUrl } from '../../middleware/upload.js';
import { writeLimiter } from '../../middleware/rateLimit.js';

/**
 * POST /uploads/event-cover
 *
 * Stores an image and hands back its public URL, which the caller then saves
 * onto the event. Keeping the two steps apart means a half-finished event form
 * never leaves an orphaned reference on a record.
 */

const router = Router();

router.post(
  '/event-cover',
  authenticate,
  staffOnly,
  writeLimiter,
  ...uploadImage('event'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Choose an image to upload');
    return created(
      res,
      { url: publicUrl(req.file), bytes: req.file.size, mimeType: req.file.mimetype },
      'Image uploaded',
    );
  }),
);

export default router;
