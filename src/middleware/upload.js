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

/**
 * What each format actually begins with.
 *
 * The declared content type is the *client's* word for what it is sending, and
 * a client can say anything. A text file announced as `image/png` passed the
 * filter and was stored in the public bucket — so anything at all could be put
 * there, under a name ending `.png`, by an account with staff access. The
 * bytes are checked against the format they claim to be before the file is
 * kept.
 */
const SIGNATURES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) =>
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  'image/gif': (b) => b.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/) !== null,
  /* RIFF....WEBP */
  'image/webp': (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/** True when the first bytes match the format the upload claims to be. */
export function looksLikeDeclaredImage(buffer, mimeType) {
  const check = SIGNATURES[mimeType];
  if (!check) return false;
  if (!buffer || buffer.length < 12) return false;
  return check(buffer);
}

const upload = multer({
  storage: isRemote() ? multer.memoryStorage() : diskStorage,
  limits: { fileSize: env.uploads.maxBytes, files: 1 },
  fileFilter(req, file, cb) {
    /* The declared type, checked first because it decides the extension and
       the storage path. The bytes are checked afterwards, once there are
       some — a filter runs before the file has been read. */
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

export default { uploadImage, UPLOAD_DIR, looksLikeDeclaredImage };
