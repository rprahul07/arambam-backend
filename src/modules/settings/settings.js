import { Router } from 'express';
import { z } from 'zod';
import { queryAll, queryOne } from '../../database/index.js';
import { EMAIL_TEMPLATE_KEYS, SETTINGS_KEYS } from '../../config/constants.js';
import { toEmailTemplate, toOrganisation, toRegistrationForm } from '../../serializers/index.js';
import asyncHandler from '../../utils/asyncHandler.js';
import ApiError from '../../utils/ApiError.js';
import { ok } from '../../utils/response.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import { authenticate, adminOnly } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { recordQuietly } from '../../services/activity.service.js';

/**
 * Organisation profile and email templates — the administrator settings screen.
 *
 * The organisation block is public: it is the address in the footer, the phone
 * number on the contact page and the letterhead on a receipt. The templates
 * are not.
 */

const router = Router();

/** An external link, or nothing at all. */
const link = z.union([z.literal(''), z.string().trim().url('That does not look like a link')]);

const organisationSchema = z.object({
  name: z.string().trim().min(1, 'The organisation needs a name').max(120),
  tagline: z.string().trim().max(200).default(''),
  addressLine1: z.string().trim().max(200).default(''),
  addressLine2: z.string().trim().max(200).default(''),
  city: z.string().trim().max(80).default(''),
  state: z.string().trim().max(80).default(''),
  pincode: z.string().trim().max(12).default(''),
  email: z.union([z.literal(''), z.string().email('That does not look like an email address')]).default(''),
  phone: z.string().trim().max(40).default(''),
  website: z.string().trim().max(120).default(''),

  /* The Trust's QR, shown to anyone paying for a membership and to anyone
     paying for an event the facilitator has not supplied their own QR for.
     Changing it here changes it everywhere, immediately — which is why only
     an administrator may. */
  paymentUpiId: z.string().trim().max(120).default(''),
  paymentQrUrl: z.string().trim().max(500).default(''),
  paymentInstructions: z.string().trim().max(1000).default(''),

  /* Where and when. The map link and the note beside it are separate fields
     because the pin lands on the building, not on the floor. */
  mapsUrl: link.default(''),
  directionsNote: z.string().trim().max(120).default(''),
  officeDays: z.string().trim().max(30).default(''),
  officeHours: z.string().trim().max(25).default(''),
  holidayNote: z.string().trim().max(40).default(''),
  /* Quoted publicly in several places, so it is a promise, not a hope. */
  responseTime: z.string().trim().max(120).default(''),

  registrationNumber: z.string().trim().max(120).default(''),
  foundedYear: z.coerce.number().int().min(1900).max(2100).optional(),

  instagramUrl: link.default(''),
  facebookUrl: link.default(''),
  whatsappUrl: link.default(''),
  youtubeUrl: link.default(''),
});

/**
 * Subject lines and the on/off switch are the administrator's. The bodies are
 * not editable from the interface — the settings screen says as much — so they
 * are not accepted here either.
 */
const templateSchema = z
  .object({
    subject: z.string().trim().min(1, 'A subject line is required').max(300).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => value.subject !== undefined || value.enabled !== undefined, {
    message: 'Nothing to update',
  });

const templateKeyParam = z.object({ key: z.enum(EMAIL_TEMPLATE_KEYS) });

/**
 * The registration form's wording.
 *
 * Only text is accepted. The set of fields, which of them are required and
 * what counts as a valid Aadhaar number are decided in code, so nothing here
 * can change what the form will accept — an administrator rewording a label
 * must never be able to loosen a rule. Anything not named below is dropped by
 * the serializer, which merges what is saved over the supplied defaults.
 */
const localised = (max) =>
  z.object({
    en: z.string().trim().max(max).default(''),
    ta: z.string().trim().max(max).default(''),
  });

const registrationFormSchema = z.object({
  title: localised(200).optional(),
  intro: localised(600).optional(),
  sections: z.record(localised(200)).optional(),
  fields: z
    .record(z.object({ label: localised(300).optional(), hint: localised(600).optional() }))
    .optional(),
  choices: z
    .record(
      z.array(
        z.object({
          /* Carried through so the serializer can match on it. The stored
             value is never taken from the request — see the serializer. */
          value: z.string().trim().min(1).max(60),
          label: localised(200),
        }),
      ),
    )
    .optional(),
  notices: z.record(localised(3000)).optional(),
});

/** GET /settings/organisation — public: this is the footer and contact page. */
router.get(
  '/organisation',
  asyncHandler(async (req, res) => {
    const row = await queryOne(`SELECT value FROM settings WHERE key = $1`, [SETTINGS_KEYS.ORGANISATION]);
    return ok(res, toOrganisation(row?.value ?? {}));
  }),
);

/**
 * GET /settings/registration-form — the wording of the member registration
 * form, in both languages.
 *
 * Unauthenticated on purpose: this is the printed form's text, it is shown to
 * somebody who has not finished joining yet, and there is nothing in it that
 * is not already on a piece of paper handed across a table.
 */
router.get(
  '/registration-form',
  asyncHandler(async (req, res) => {
    const row = await queryOne(`SELECT value FROM settings WHERE key = $1`, [
      SETTINGS_KEYS.REGISTRATION_FORM,
    ]);
    return ok(res, toRegistrationForm(row?.value ?? {}));
  }),
);

router.use(authenticate, adminOnly);

/** PATCH /settings/organisation */
router.patch(
  '/organisation',
  writeLimiter,
  validateBody(organisationSchema.partial()),
  asyncHandler(async (req, res) => {
    const existing = await queryOne(`SELECT value FROM settings WHERE key = $1`, [
      SETTINGS_KEYS.ORGANISATION,
    ]);
    const merged = organisationSchema.parse({ ...(existing?.value ?? {}), ...req.body });

    const row = await queryOne(
      `INSERT INTO settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING value`,
      [SETTINGS_KEYS.ORGANISATION, JSON.stringify(merged), req.user.id],
    );

    recordQuietly({
      actorId: req.user.id,
      subjectType: 'settings',
      action: 'update_organisation',
      description: 'Updated the organisation profile',
    });

    return ok(res, toOrganisation(row.value), 'Organisation details saved');
  }),
);

/** GET /settings/email-templates */
router.get(
  '/email-templates',
  asyncHandler(async (req, res) => {
    const rows = await queryAll(`SELECT * FROM email_templates ORDER BY sort_order, key`);
    return ok(res, rows.map(toEmailTemplate));
  }),
);

/** PATCH /settings/email-templates/:key */
router.patch(
  '/email-templates/:key',
  writeLimiter,
  validateParams(templateKeyParam),
  validateBody(templateSchema),
  asyncHandler(async (req, res) => {
    const sets = [];
    const params = [];
    if (req.body.subject !== undefined) {
      params.push(req.body.subject);
      sets.push(`subject = $${params.length}`);
    }
    if (req.body.enabled !== undefined) {
      params.push(req.body.enabled);
      sets.push(`enabled = $${params.length}`);
    }

    params.push(req.params.key);
    const row = await queryOne(
      `UPDATE email_templates SET ${sets.join(', ')} WHERE key = $${params.length} RETURNING *`,
      params,
    );
    if (!row) throw ApiError.notFound('That template is not configured');

    recordQuietly({
      actorId: req.user.id,
      subjectType: 'settings',
      action: 'update_email_template',
      description: `Updated the "${row.name}" template`,
      meta: { key: row.key, enabled: row.enabled },
    });

    return ok(res, toEmailTemplate(row), 'Template saved');
  }),
);

/**
 * PUT /settings/registration-form
 *
 * Whole-document, not a patch: the administrator's screen holds every string
 * at once, so sending the lot is what it actually did, and a partial merge
 * would make "I deleted that hint" indistinguishable from "I did not touch
 * that hint".
 */
router.put(
  '/registration-form',
  writeLimiter,
  validateBody(registrationFormSchema),
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      `INSERT INTO settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING value`,
      [SETTINGS_KEYS.REGISTRATION_FORM, JSON.stringify(req.body), req.user.id],
    );

    recordQuietly({
      actorId: req.user.id,
      subjectType: 'settings',
      action: 'update_registration_form',
      description: 'Updated the member registration form wording',
    });

    return ok(res, toRegistrationForm(row.value), 'Registration form saved');
  }),
);

export default router;
