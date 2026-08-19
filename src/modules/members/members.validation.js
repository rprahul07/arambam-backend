import { z } from 'zod';
import { toObjectPath } from '../../services/storage.service.js';
import {
  GENDER_VALUES,
  GUARDIAN_RELATION_VALUES,
  ID_PROOF_VALUES,
  MEMBERSHIP_STATUS_VALUES,
  MINOR_AGE,
} from '../../config/constants.js';

/**
 * The member profile, as the bilingual registration form (v0.2) defines it.
 * Field names and rules match `NewMemberInput` and `Member` on the front end.
 */

const phone = z
  .string()
  .trim()
  .regex(/^[+\d][\d\s-]{7,15}$/, 'Enter a valid phone number');

const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === '' ? undefined : value));

const profile = {
  fullName: z.string().trim().min(2, 'Enter the full name').max(120),
  email: z.string().trim().toLowerCase().email('That does not look like an email address').max(254),
  phone,
  whatsappNumber: phone,
  age: z.coerce.number().int().min(1, 'Enter an age').max(120),
  gender: z.enum(GENDER_VALUES),
  dateOfBirth: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in the form 1996-04-12')
    .optional(),
  /* Sent back as the `/media` link the upload returned; stored as the object
     path it stands for, which is what the private bucket knows it by. */
  photoUrl: z.string().trim().url().max(500).transform(toObjectPath).optional(),

  addressLine1: z.string().trim().min(1, 'Enter the address').max(200),
  addressLine2: optionalText(200),
  city: z.string().trim().min(1, 'Enter the city').max(80),
  district: z.string().trim().min(1, 'Enter the district').max(80),
  state: z.string().trim().min(1, 'Enter the state').max(80),
  pincode: z.string().trim().regex(/^\d{6}$/, 'A pincode is six digits'),

  guardianName: optionalText(120),
  guardianRelation: z.enum(GUARDIAN_RELATION_VALUES).optional(),
  guardianPhone: phone.optional(),

  idProofType: z.enum(ID_PROOF_VALUES),
  idProofNumber: z.string().trim().min(4, 'Enter the ID number').max(40),

  hasMedicalConditions: z.boolean().default(false),
  medicalNotes: optionalText(1000),

  whatsappGroupConsent: z.boolean().default(false),
  mediaConsent: z.boolean().default(false),
};

/** The form makes the guardian block mandatory under 18; so does the server. */
const withGuardianRule = (schema) =>
  schema.superRefine((value, ctx) => {
    if (value.age === undefined || value.age >= MINOR_AGE) return;
    if (!value.guardianName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guardianName'],
        message: 'Members under 18 need a guardian',
      });
    }
    if (!value.guardianPhone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guardianPhone'],
        message: 'Enter the guardian’s phone number',
      });
    }
  });

export const createMemberSchema = withGuardianRule(
  z.object({
    ...profile,
    /** Optional client-supplied UUID — see `events.validation.js`. */
    id: z.string().uuid('Invalid id').optional(),
    /** Optional starting plan; the membership is still Pending until paid. */
    planId: z
      .string()
      .uuid()
      .optional()
      .or(z.literal('').transform(() => undefined)),
  }),
);

export const updateMemberSchema = withGuardianRule(
  z.object({
    ...Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, value.optional()])),
    declarationAccepted: z.boolean().optional(),
  }),
);

export const statusSchema = z.object({
  status: z.enum(MEMBERSHIP_STATUS_VALUES),
  reason: optionalText(300),
});

export const listMembersSchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(MEMBERSHIP_STATUS_VALUES).optional(),
  planId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export const idParam = z.object({ id: z.string().uuid('Unknown member') });
