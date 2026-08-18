import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';

/**
 * Image uploads — member photographs and event cover images.
 *
 * Files land under `uploads/<kind>/` with a generated name. The client's own
 * filename is never used for anything on disk, so a name like
 * `../../etc/passwd` or `x.png.php` has nowhere to go.
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

const storage = multer.diskStorage({
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
  storage,
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

/** The public URL for a stored file, absolute so the SPA can use it directly. */
export const publicUrl = (file) => {
  const kind = path.basename(path.dirname(file.path));
  return `${env.serverUrl}/uploads/${kind}/${file.filename}`;
};

export default { uploadImage, publicUrl, UPLOAD_DIR };
