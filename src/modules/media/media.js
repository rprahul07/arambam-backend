import { Router } from 'express';
import { queryOne } from '../../database/index.js';
import { ROLES } from '../../config/constants.js';
import { authenticate } from '../../middleware/auth.js';
import asyncHandler from '../../utils/asyncHandler.js';
import ApiError from '../../utils/ApiError.js';
import env from '../../config/env.js';
import { ok } from '../../utils/response.js';
import { signedUrl, isRemote, FOLDER } from '../../services/storage.service.js';

/**
 * The only way to see a private image.
 *
 * Member photographs and payment screenshots live in a bucket that serves
 * nothing to the public. They are reached through here instead, and here asks
 * two questions before handing anything over: does this object belong to
 * something real, and is the person asking entitled to see it.
 *
 * The answer is a link that expires in a few minutes. So a URL copied out of a
 * browser's history, or pasted into a chat, stops working — which is the whole
 * point. An unguessable public URL is a password that never changes and can
 * never be withdrawn.
 *
 * It answers in two ways, because the caller needs both. Asked for JSON it
 * returns the signed link, which is what the front end does: an `img` tag
 * cannot carry the bearer token, so the page fetches the link first and then
 * points the tag at it. Asked for anything else it redirects, which is what
 * makes the URL work when opened directly in a tab.
 */
const router = Router();

/** Object names are ours: a timestamp, random hex, and a known extension. */
const NAME = /^[a-z0-9]+-[0-9a-f]{24}\.(jpg|png|webp|gif)$/;

/**
 * Who may see a member's photograph.
 *
 * The member, and staff. Not other members: the register is not a directory
 * to be browsed, and some of the faces in it belong to children.
 */
async function maySeeMemberPhoto(actor, objectPath) {
  const owner = await queryOne(`SELECT user_id FROM members WHERE photo_url = $1`, [objectPath]);
  if (!owner) return false;
  if (actor.role === ROLES.ADMIN || actor.role === ROLES.ORGANIZER) return true;
  return owner.user_id === actor.id;
}

/**
 * Who may see a payment screenshot.
 *
 * The person who sent it, an administrator, and — for an event payment only —
 * the organiser whose event it is, because they are the one being asked to
 * confirm it. Deliberately the same rule as confirming the payment itself, so
 * seeing the evidence and acting on it never come apart.
 */
async function maySeePaymentProof(actor, objectPath) {
  const payment = await queryOne(
    `SELECT member_id, registration_id FROM payments WHERE claim_proof_url = $1`,
    [objectPath],
  );
  if (!payment) return false;
  if (actor.role === ROLES.ADMIN) return true;
  /* `actor.member_id` is the members row id, which is what payments carry. */
  if (actor.member_id && payment.member_id === actor.member_id) return true;

  if (actor.role === ROLES.ORGANIZER && payment.registration_id) {
    const owns = await queryOne(
      `SELECT 1 FROM registrations r
       JOIN events e ON e.id = r.event_id
       WHERE r.id = $1 AND e.organizer_id = $2`,
      [payment.registration_id, actor.id],
    );
    return Boolean(owns);
  }
  return false;
}

const GUARD = {
  [FOLDER.MEMBER]: maySeeMemberPhoto,
  [FOLDER.PROOF]: maySeePaymentProof,
};

router.get(
  '/:folder/:name',
  authenticate,
  asyncHandler(async (req, res) => {
    const { folder, name } = req.params;

    const guard = GUARD[folder];
    if (!guard || !NAME.test(name)) throw ApiError.notFound('No such image');

    const objectPath = `${folder}/${name}`;

    /* Deliberately the same answer for "does not exist" and "not yours".
       Telling the two apart would let anyone with a URL learn whether a
       payment screenshot exists, which is most of what the URL was hiding. */
    if (!(await guard(req.user, objectPath))) throw ApiError.notFound('No such image');

    /* Local development keeps files on disk under the static mount. */
    const link = isRemote()
      ? await signedUrl(objectPath)
      : `${env.serverUrl}/uploads/${objectPath}`;

    if (!link) throw ApiError.unavailable('That image could not be opened just now');

    /* Never stored by a proxy or by the browser: the link is short-lived and
       the answer depends on who asked. */
    res.set('Cache-Control', 'private, no-store');

    if (req.accepts(['html', 'json']) === 'json') {
      return ok(res, { url: link, expiresIn: env.supabase.signedUrlSeconds }, 'Link issued');
    }
    return res.redirect(302, link);
  }),
);

export default router;
