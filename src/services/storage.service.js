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
    logger.info(
      `Uploads go to Supabase Storage — "${env.supabase.bucket}" for public images, ` +
        `"${env.supabase.privateBucket}" for member photographs and payment proofs`,
    );
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
 * Folders, so the buckets stay legible a year from now. The caller names one
 * of these; nothing derived from a request ever reaches the path.
 */
export const FOLDER = {
  EVENT: 'event-covers',
  MEMBER: 'member-photos',
  QR: 'payment-qr',
  PROOF: 'payment-proofs',
};

/**
 * Which of those are nobody else's business.
 *
 * An event poster and a payment QR are meant to be seen — they are on the
 * public site and shown to anyone about to pay. A member's photograph and a
 * screenshot of somebody's banking app are not. Those two live in a private
 * bucket and are reachable only through `/media`, which checks who is asking
 * before it hands out a link that expires.
 */
const PRIVATE_FOLDERS = new Set([FOLDER.MEMBER, FOLDER.PROOF]);

export const isPrivateFolder = (folder) => PRIVATE_FOLDERS.has(folder);

const bucketFor = (folder) =>
  isPrivateFolder(folder) ? env.supabase.privateBucket : env.supabase.bucket;

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
  const bucket = bucketFor(folder);

  const { data, error } = await client.storage.from(bucket).upload(objectPath, body, {
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

  /* A private object has no URL to give out. What is stored is the path, and
     the serializers turn that into a `/media/...` link which authorises the
     caller before signing anything. */
  if (isPrivateFolder(folder)) return data.path;

  const { data: published } = client.storage.from(bucket).getPublicUrl(data.path);
  if (!published?.publicUrl) {
    throw ApiError.unavailable('The image was stored but could not be published', undefined, 'STORAGE_URL_MISSING');
  }
  return published.publicUrl;
}

/**
 * The two ways a private object is written down.
 *
 * In the database it is a bare object path, because there is no URL that would
 * work — the bucket serves nothing to the public. Everywhere a client can see
 * it, it is a link to `/media`, which authorises the caller and then signs.
 *
 * Both directions live here so they cannot drift apart. `toObjectPath` is what
 * makes it safe for a client to send back the same value it was given: the
 * link is turned back into a path before anything is stored.
 */
export const mediaUrl = (objectPath) => `${env.serverUrl}${env.apiPrefix}/media/${objectPath}`;

export function toObjectPath(value) {
  if (!value) return value;

  const marker = `${env.apiPrefix}/media/`;
  const index = value.indexOf(marker);
  if (index === -1) return value;

  const path = value.slice(index + marker.length).split(/[?#]/)[0];
  const [folder] = path.split('/');
  /* Only folders this service owns, so a crafted link cannot name its way
     into somewhere else. */
  return isPrivateFolder(folder) ? path : value;
}

/**
 * A short-lived link to one private object.
 *
 * Only ever called after the caller has been shown to be entitled to it, by
 * the `/media` route. This function itself authorises nothing.
 */
export async function signedUrl(objectPath) {
  if (!client) return null;

  const { data, error } = await client.storage
    .from(env.supabase.privateBucket)
    .createSignedUrl(objectPath, env.supabase.signedUrlSeconds);

  if (error) {
    logger.warn(`Could not sign ${objectPath}: ${error.message}`);
    return null;
  }
  return data?.signedUrl ?? null;
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
export async function remove(stored) {
  if (!client || !stored) return false;

  /* Two shapes arrive here: a public URL, and the bare path kept for a
     private object. */
  let bucket = env.supabase.bucket;
  let objectPath = null;

  const marker = `/storage/v1/object/public/${env.supabase.bucket}/`;
  const index = stored.indexOf(marker);
  if (index !== -1) {
    objectPath = decodeURIComponent(stored.slice(index + marker.length));
  } else if (!stored.startsWith('http')) {
    objectPath = stored;
    bucket = env.supabase.privateBucket;
  }

  if (!objectPath) return false;

  const { error } = await client.storage.from(bucket).remove([objectPath]);
  if (error) {
    logger.warn(`Could not remove ${objectPath}: ${error.message}`);
    return false;
  }
  return true;
}

export default { store, remove, signedUrl, mediaUrl, toObjectPath, isRemote, isPrivateFolder, FOLDER };
