import { z } from 'zod';
import { ROLE_VALUES } from '../../config/constants.js';
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

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name as it appears on your ID').max(120),
  email,
  phone,
  password,
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
