import { Router } from 'express';
import * as controller from './auth.controller.js';
import * as schema from './auth.validation.js';
import { validateBody } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { authLimiter, emailLimiter } from '../../middleware/rateLimit.js';

const router = Router();

/**
 * POST /auth/register          Create an account and send the verification link
 * POST /auth/login             Exchange credentials for a session
 * POST /auth/demo-login        One-click role sign-in (demonstration builds)
 * POST /auth/refresh           Rotate the session
 * POST /auth/logout            Revoke this session
 * GET  /auth/me                The signed-in identity
 * POST /auth/verify-email      Confirm an address, or ask for a new link
 * POST /auth/resend-verification
 * POST /auth/forgot-password   Begin a password reset
 * POST /auth/reset-password    Finish a password reset
 * POST /auth/change-password   Change it while signed in
 * POST /auth/change-email      Begin an email change
 */

router.post('/register', emailLimiter, validateBody(schema.registerSchema), controller.register);
router.post('/login', authLimiter, validateBody(schema.loginSchema), controller.login);
router.post('/demo-login', validateBody(schema.demoLoginSchema), controller.demoLogin);
router.post('/refresh', controller.refresh);
router.post('/logout', controller.logout);

router.get('/me', authenticate, controller.me);

router.post('/verify-email', validateBody(schema.verifyEmailSchema), controller.verifyEmail);
router.post(
  '/resend-verification',
  emailLimiter,
  validateBody(schema.emailOnlySchema),
  controller.resendVerification,
);

router.post(
  '/forgot-password',
  emailLimiter,
  validateBody(schema.emailOnlySchema),
  controller.forgotPassword,
);
router.post('/reset-password', authLimiter, validateBody(schema.resetPasswordSchema), controller.resetPassword);

router.post(
  '/change-password',
  authenticate,
  validateBody(schema.changePasswordSchema),
  controller.changePassword,
);
router.post(
  '/change-email',
  authenticate,
  emailLimiter,
  validateBody(schema.changeEmailSchema),
  controller.changeEmail,
);

export default router;
