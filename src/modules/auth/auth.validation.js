import { z } from 'zod';
import {
  GENDER_VALUES,
  GUARDIAN_RELATION_VALUES,
  PAN_PATTERN,
  MINOR_AGE,
  ROLE_VALUES,
} from '../../config/constants.js';
import { PASSWORD_RULE } from '../../utils/password.js';

/**
 * These schemas are the server-side twin of the Zod schemas on the front end's
 * auth forms. The messages are the same sentences, so a rule enforced here and
 * a rule enforced in the browser read identically to the person filling in the
 * form.
 */

export const email = z
  .string({ required_error: 'Enter your email address' })
  .trim()
  .min(1, 'Enter your email address')
  .max(254)
  .email('That does not look like an email address')
  .toLowerCase();

export const password = z
  .string({ required_error: 'Enter a password' })
  .min(8, 'Use at least 8 characters')
  .max(128, 'That password is too long')
  .regex(/[A-Z]/, 'Include at least one capital letter')
  .regex(/\d/, 'Include at least one number')
  .regex(/[^A-Za-z0-9]/, 'Include at least one symbol');

export const phone = z
  .string()
  .trim()
  .regex(/^[+\d][\d\s-]{7,15}$/, 'Enter a valid Indian mobile number');

/**
 * Joining, in one submission.
 *
 * The account and the registration form are asked for together because they
 * are one act: somebody joining Aarambam fills in the form the organisation
 * has always used, and the email and password are how they get back in
 * afterwards. Splitting it into "make an account, confirm your email, then
 * fill in a profile" left people with an account and no membership, and a
 * verification link standing between them and a form they had already decided
 * to fill in.
 *
 * The fields below are the printed form's questions, in its order. The address
 * is one field, as it is on paper. `GENDER_VALUES` and the rest are imported
 * rather than restated so this cannot drift from what the database accepts.
 */
export const registerSchema = z
  .object({
    /* --- the account --- */
    email,
    phone,
    password,

    /* --- the form --- */
    fullName: z.string().trim().min(2, 'Enter your name as it appears on your ID').max(120),
    age: z.coerce.number().int().min(1, 'Enter an age').max(120),
    gender: z.enum(GENDER_VALUES, { errorMap: () => ({ message: 'Select one' }) }),
    address: z.string().trim().min(4, 'Enter the address').max(200),
    /**
     * Asked separately from the address box, because they are the columns the
     * office actually sorts and filters by.
     *
     * The paper form has one address line and this followed it, so `city`,
     * `district` and `state` were never filled in at sign-up — while the
     * member's own profile screen went on marking them required, and the
     * administrator's member list showed an empty City for nearly everybody.
     * A field that is mandatory in one place and unasked in another is not a
     * form, it is a trap.
     *
     * Optional *here* and required on the form, which is deliberate and is
     * about deployment order rather than about the rule. The browser bundle
     * and the API ship separately: make the API insist on a field the
     * currently-published bundle does not send yet and sign-up stops working
     * for everybody until the front end catches up. The form asks for all
     * three and will not submit without them; the API accepts an older client
     * rather than turning it away.
     */
    city: z.string().trim().max(80).default(''),
    district: z.string().trim().max(80).default(''),
    state: z.string().trim().max(80).default(''),
    whatsappNumber: phone,
    whatsappGroupConsent: z.boolean().default(false),

    guardianName: z.string().trim().max(120).optional(),
    guardianRelation: z.enum(GUARDIAN_RELATION_VALUES).optional(),
    guardianPhone: z
      .string()
      .trim()
      .regex(/^[+\d][\d\s-]{7,15}$/, 'Enter a valid phone number')
      .optional(),
    /* Optional, and the only identity document the form asks for. */
    panNumber: z
      .string()
      .trim()
      .toUpperCase()
      .refine((v) => v === '' || PAN_PATTERN.test(v), 'A PAN looks like ABCDE1234F')
      .transform((v) => (v === '' ? undefined : v))
      .optional(),

    hasMedicalConditions: z.boolean().default(false),
    medicalNotes: z.string().trim().max(1000).optional(),

    mediaConsent: z.boolean().default(false),
    declarationAccepted: z.literal(true, {
      errorMap: () => ({ message: 'The declaration must be accepted to join' }),
    }),
  })
  .superRefine((value, ctx) => {
    /* The paper form makes the guardian block mandatory under 18, and so does
       the database. Refused here as well, so the answer names the field rather
       than arriving as a constraint the person never saw. */
    if (value.age >= MINOR_AGE) return;
    if (!value.guardianName || value.guardianName.length < 2) {
      ctx.addIssue({ code: 'custom', path: ['guardianName'], message: 'Required for a member under 18' });
    }
    if (!value.guardianRelation) {
      ctx.addIssue({ code: 'custom', path: ['guardianRelation'], message: 'Select the relationship' });
    }
    if (!value.guardianPhone) {
      ctx.addIssue({ code: 'custom', path: ['guardianPhone'], message: 'Required for a member under 18' });
    }
  });

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password').max(128),
  remember: z.boolean().optional().default(true),
});

export const emailOnlySchema = z.object({ email });

export const verifyEmailSchema = z
  .object({
    token: z.string().trim().min(10).max(200).optional(),
    email: email.optional(),
  })
  .refine((value) => value.token || value.email, {
    message: 'A verification token or email address is required',
    path: ['token'],
  });

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(10, 'This reset link is not valid').max(200),
  password,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(128),
  password,
});

export const changeEmailSchema = z.object({ email });

export const demoLoginSchema = z.object({
  role: z.enum(ROLE_VALUES, { errorMap: () => ({ message: 'Choose a valid role' }) }),
});

export { PASSWORD_RULE };
