import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import ApiError from '../../utils/ApiError.js';
import { created } from '../../utils/response.js';
import { authenticate, staffOnly } from '../../middleware/auth.js';
import { uploadImage } from '../../middleware/upload.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import {
  store,
  mediaUrl,
  assetUrl,
  isLocalAsset,
  isPrivateFolder,
  FOLDER,
} from '../../services/storage.service.js';

const router = Router();

async function handleUpload(req, res, folder) {
  if (!req.file) throw ApiError.badRequest('Choose an image to upload');

  const stored = await store(req.file, folder);

  /* A private object is stored as a path; what the client gets is the link
     that authorises before it serves. Sending it straight back on the next
     request is fine — `toObjectPath` turns it into a path again on write. */
  const url = isLocalAsset(stored)
    ? assetUrl(stored)
    : isPrivateFolder(folder)
      ? mediaUrl(stored)
      : stored;

  return created(
    res,
    { url, bytes: req.file.size, mimeType: req.file.mimetype },
    'Image uploaded',
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
    return handleUpload(req, res, FOLDER.EVENT);
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
    return handleUpload(req, res, FOLDER.QR);
  }),
);

/** POST /uploads/payment-proof */
router.post(
  '/payment-proof',
  authenticate,
  writeLimiter,
  ...uploadImage('proof'),
  asyncHandler(async (req, res) => {
    return handleUpload(req, res, FOLDER.PROOF);
  }),
);

export default router;
