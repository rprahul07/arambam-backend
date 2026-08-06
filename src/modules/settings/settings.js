import { Router } from 'express';
import { z } from 'zod';
import { queryAll, queryOne } from '../../database/index.js';
import { EMAIL_TEMPLATE_KEYS, SETTINGS_KEYS } from '../../config/constants.js';
import { toEmailTemplate, toOrganisation } from '../../serializers/index.js';
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

/** GET /settings/organisation — public: this is the footer and contact page. */
router.get(
  '/organisation',
  asyncHandler(async (req, res) => {
    const row = await queryOne(`SELECT value FROM settings WHERE key = $1`, [SETTINGS_KEYS.ORGANISATION]);
    return ok(res, toOrganisation(row?.value ?? {}));
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

export default router;
