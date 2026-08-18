import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import ApiError from '../../utils/ApiError.js';
import { created } from '../../utils/response.js';
import { authenticate, staffOnly } from '../../middleware/auth.js';
import { uploadImage, publicUrl } from '../../middleware/upload.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { uploadToSupabase } from '../../services/storage.service.js';

const router = Router();

async function handleUpload(req, res, folderName) {
  if (!req.file) throw ApiError.badRequest('Choose an image to upload');
  
  // Try Supabase Storage first, fallback to local URL
  const supabaseUrl = await uploadToSupabase(req.file, folderName);
  const finalUrl = supabaseUrl || publicUrl(req.file);

  return created(
    res,
    { url: finalUrl, bytes: req.file.size, mimeType: req.file.mimetype },
    'Image uploaded successfully',
  );
}

/** POST /uploads/event-cover */
router.post(
  '/event-cover',
  authenticate,
  staffOnly,
  writeLimiter,
  ...uploadImage('event'),
  asyncHandler(async (req, res) => {
    return handleUpload(req, res, 'event-covers');
  }),
);

/** POST /uploads/qr-code */
router.post(
  '/qr-code',
  authenticate,
  staffOnly,
  writeLimiter,
  ...uploadImage('qr'),
  asyncHandler(async (req, res) => {
    return handleUpload(req, res, 'qr-codes');
  }),
);

/** POST /uploads/payment-proof */
router.post(
  '/payment-proof',
  authenticate,
  writeLimiter,
  ...uploadImage('proof'),
  asyncHandler(async (req, res) => {
    return handleUpload(req, res, 'payment-proofs');
  }),
);

export default router;
