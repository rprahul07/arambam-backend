import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import ApiError from '../../utils/ApiError.js';
import { created } from '../../utils/response.js';
import { authenticate, staffOnly } from '../../middleware/auth.js';
import fs from 'node:fs';
import { looksLikeDeclaredImage, uploadImage } from '../../middleware/upload.js';
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

  /* The bytes have to match the format the upload claims to be.
   *
   * `fileFilter` can only see the declared content type, which is whatever the
   * client chose to say — a text file announced as `image/png` sailed through
   * and was kept in the public bucket under a `.png` name. Checked here
   * instead, where the file actually exists.
   *
   * Remote storage keeps it in memory; local storage has already written it to
   * disk, so that copy is read back and removed if it turns out to be a lie. */
  const head = req.file.buffer
    ? req.file.buffer.subarray(0, 16)
    : await fs.promises.readFile(req.file.path).then((b) => b.subarray(0, 16)).catch(() => null);

  if (!looksLikeDeclaredImage(head, req.file.mimetype)) {
    if (req.file.path) await fs.promises.unlink(req.file.path).catch(() => undefined);
    throw ApiError.badRequest('That file is not a JPEG, PNG, WebP or GIF image');
  }

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
