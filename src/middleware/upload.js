import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import { isRemote } from '../services/storage.service.js';

/**
 * Image uploads — member photographs, event covers, payment QR codes and
 * payment screenshots.
 *
 * This layer only accepts the file and checks it is an image of a size we
 * allow. Where it is then kept is `storage.service.js`'s decision.
 *
 * The client's own filename is never used for anything, so a name like
 * `../../etc/passwd` or `x.png.php` has nowhere to go — the stored name is
 * generated and the extension comes from the verified content type.
 */

export const UPLOAD_DIR = env.uploads.dir;

const ALLOWED = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

const ensure = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

ensure(UPLOAD_DIR);

/**
 * Where the bytes land while the request is in flight.
 *
 * When uploads go to Supabase there is no reason to touch the disk at all —
 * the file would be written only to be read back and deleted. Five megabytes
 * is the ceiling, so holding one in memory costs nothing. The disk is used
 * only when this machine is also the place the file will live.
 */
const diskStorage = multer.diskStorage({
  destination(req, file, cb) {
    const map = { member: 'members', event: 'events', qr: 'qr', proof: 'proofs' };
    const kind = map[req.uploadKind] || 'events';
    cb(null, ensure(path.join(UPLOAD_DIR, kind)));
  },
  filename(req, file, cb) {
    cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}${ALLOWED.get(file.mimetype)}`);
  },
});

const upload = multer({
  storage: isRemote() ? multer.memoryStorage() : diskStorage,
  limits: { fileSize: env.uploads.maxBytes, files: 1 },
  fileFilter(req, file, cb) {
    if (!ALLOWED.has(file.mimetype)) {
      return cb(ApiError.badRequest('Upload a JPEG, PNG, WebP or GIF image'));
    }
    return cb(null, true);
  },
});

/** `kind` selects the sub-directory and is never taken from the request. */
export const uploadImage = (kind) => [
  (req, res, next) => {
    req.uploadKind = kind;
    next();
  },
  upload.single('file'),
];

export default { uploadImage, UPLOAD_DIR };
