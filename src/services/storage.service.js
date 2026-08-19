import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

/**
 * Where uploaded images live.
 *
 * Two places, chosen by configuration rather than by circumstance:
 *
 *   Supabase Storage — when SUPABASE_URL and a service-role key are set. This
 *     is what production uses, because the container's own filesystem does not
 *     survive a restart and member photographs must.
 *
 *   the local disk — when they are not. A laptop with nothing else running
 *     still uploads, still serves the file back, and still exercises the whole
 *     path.
 *
 * What it deliberately does *not* do is fall back from the first to the second.
 * A failed upload used to return a local URL, which on a container host is a
 * link to a file that will exist until the next deploy and then quietly 404 —
 * a member photograph that looks saved and is not. Refusing is worse for one
 * upload and far better for the record.
 */

/** The extension is taken from the verified type, never from the client. */
const EXTENSION = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

/**
 * Anonymous keys are refused on purpose. Writing with one only succeeds if the
 * bucket accepts writes from anybody, which is not a configuration to make
 * easy to arrive at by accident.
 */
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

let client = null;
if (env.supabase.url && serviceKey) {
  try {
    client = createClient(env.supabase.url, serviceKey, {
      auth: { persistSession: false },
    });
    logger.info(`Uploads go to Supabase Storage (bucket "${env.supabase.bucket}")`);
  } catch (error) {
    logger.error('Could not reach Supabase Storage:', error.message);
  }
} else if (env.supabase.url && env.supabase.key) {
  logger.warn(
    'SUPABASE_URL is set but SUPABASE_SERVICE_ROLE_KEY is not. Uploads will use the local disk — ' +
      'an anonymous key is not accepted for writing.',
  );
}

/** True when uploads leave this machine. */
export const isRemote = () => client !== null;

/**
 * Folders, so the bucket stays legible a year from now. The caller names one
 * of these; nothing derived from a request ever reaches the path.
 */
export const FOLDER = {
  EVENT: 'event-covers',
  MEMBER: 'member-photos',
  QR: 'payment-qr',
  PROOF: 'payment-proofs',
};

/**
 * Stores one uploaded image and returns the URL to show it at.
 *
 * @param {{ buffer?: Buffer, path?: string, mimetype: string, size: number }} file
 * @param {string} folder one of FOLDER
 */
export async function store(file, folder) {
  const extension = EXTENSION.get(file.mimetype);
  if (!extension) throw ApiError.badRequest('Upload a JPEG, PNG, WebP or GIF image');

  /* Unguessable, and not derived from anything the client sent. A payment
     screenshot is somebody's bank app; the URL should not be enumerable. */
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(12).toString('hex')}${extension}`;
  const objectPath = `${folder}/${name}`;

  if (!client) {
    /* Local disk. multer has already written the file; the URL points at the
       static mount in app.js. */
    return `${env.serverUrl}/uploads/${folder}/${file.filename ?? name}`;
  }

  const body = file.buffer ?? (await fs.readFile(file.path));

  const { data, error } = await client.storage.from(env.supabase.bucket).upload(objectPath, body, {
    contentType: file.mimetype,
    /* Never overwrite. The name is random, so a collision means something is
       wrong rather than something is being replaced. */
    upsert: false,
    cacheControl: '31536000',
  });

  /* The temporary file has served its purpose either way. Leaving it behind
     fills the disk one upload at a time. */
  if (file.path) await fs.unlink(file.path).catch(() => undefined);

  if (error) {
    logger.error('Supabase Storage upload failed:', error.message);
    throw ApiError.unavailable(
      'The image could not be saved just now. Please try again in a moment.',
      undefined,
      'STORAGE_UNAVAILABLE',
    );
  }

  const { data: published } = client.storage.from(env.supabase.bucket).getPublicUrl(data.path);
  if (!published?.publicUrl) {
    throw ApiError.unavailable('The image was stored but could not be published', undefined, 'STORAGE_URL_MISSING');
  }
  return published.publicUrl;
}

/**
 * Removes an image this service stored.
 *
 * Called when one replaces another — a member changing their photograph, an
 * event getting a new cover. Without it the bucket only ever grows, and the
 * free tier is a gigabyte.
 *
 * Failure is logged and swallowed: an orphaned object costs a fraction of a
 * penny, and refusing to save a new photograph because the old one would not
 * delete serves nobody.
 */
export async function remove(url) {
  if (!client || !url) return false;

  const marker = `/storage/v1/object/public/${env.supabase.bucket}/`;
  const index = url.indexOf(marker);
  if (index === -1) return false;

  const objectPath = decodeURIComponent(url.slice(index + marker.length));
  const { error } = await client.storage.from(env.supabase.bucket).remove([objectPath]);
  if (error) {
    logger.warn(`Could not remove ${objectPath}: ${error.message}`);
    return false;
  }
  return true;
}

export default { store, remove, isRemote, FOLDER };
