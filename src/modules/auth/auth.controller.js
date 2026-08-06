import env from '../../config/env.js';
import asyncHandler from '../../utils/asyncHandler.js';
import { ok, created } from '../../utils/response.js';
import ApiError from '../../utils/ApiError.js';
import * as service from './auth.service.js';

/**
 * The refresh token lives in an httpOnly cookie: JavaScript in the page cannot
 * read it, so an XSS bug cannot walk off with a long-lived session. The access
 * token is returned in the body and kept in memory by the SPA.
 */
const REFRESH_COOKIE = 'refreshToken';

const cookieOptions = () => ({
  httpOnly: true,
  secure: env.isProd || env.security.cookieSameSite === 'none',
  sameSite: env.security.cookieSameSite,
  domain: env.security.cookieDomain,
  path: '/',
  maxAge: env.jwt.refreshDays * 24 * 60 * 60 * 1000,
});

const setRefreshCookie = (res, token) => res.cookie(REFRESH_COOKIE, token, cookieOptions());
const clearRefreshCookie = (res) =>
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });

const context = (req) => ({ userAgent: req.headers['user-agent'], ip: req.ip });

/** POST /auth/register */
export const register = asyncHandler(async (req, res) => {
  const { user, verifyToken } = await service.register(req.body, context(req));
  return created(
    res,
    {
      email: user.email,
      name: user.name,
      requiresVerification: true,
      // Only when mail is preview-only on a non-production deployment; see
      // `canRevealLinks` in the service.
      verificationLink: service.canRevealLinks()
        ? `${env.clientUrl}/verify-email?token=${verifyToken}&email=${encodeURIComponent(user.email)}`
        : undefined,
    },
    'Account created. Confirm your email address to activate it.',
  );
});

/** POST /auth/login */
export const login = asyncHandler(async (req, res) => {
  const { user, accessToken, refreshToken } = await service.login(req.body, context(req));
  setRefreshCookie(res, refreshToken);
  const payload = await service.identity(user);
  return ok(res, { ...payload, accessToken }, `Welcome back, ${user.name.split(' ')[0]}`);
});

/** POST /auth/demo-login — the three role buttons on the sign-in screen. */
export const demoLogin = asyncHandler(async (req, res) => {
  const { user, accessToken, refreshToken } = await service.demoLogin(req.body.role, context(req));
  setRefreshCookie(res, refreshToken);
  const payload = await service.identity(user);
  return ok(res, { ...payload, accessToken }, `Signed in as ${user.role}`);
});

/** POST /auth/refresh */
export const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;
  if (!token) throw ApiError.unauthorized('No session to refresh', undefined, 'NO_SESSION');

  const { user, accessToken, refreshToken } = await service.rotateSession(token, context(req));
  setRefreshCookie(res, refreshToken);
  const payload = await service.identity(user);
  return ok(res, { ...payload, accessToken }, 'Session refreshed');
});

/** POST /auth/logout */
export const logout = asyncHandler(async (req, res) => {
  await service.revokeSession(req.cookies?.[REFRESH_COOKIE]);
  clearRefreshCookie(res);
  return ok(res, null, 'Signed out');
});

/** GET /auth/me */
export const me = asyncHandler(async (req, res) => {
  const user = await service.findUserById(req.user.id);
  return ok(res, await service.identity(user));
});

/** POST /auth/verify-email */
export const verifyEmail = asyncHandler(async (req, res) => {
  const { token, email } = req.body;

  // Without a token this is the "resend" path the front end offers on the
  // same screen; it always answers the same way.
  if (!token) {
    await service.resendVerification(email);
    return ok(res, { sent: true }, 'If that address needs confirming, a new link is on its way.');
  }

  const user = await service.verifyEmail(token);
  return ok(res, { email: user.email, verified: true }, 'Email confirmed. Your account is active.');
});

/** POST /auth/resend-verification */
export const resendVerification = asyncHandler(async (req, res) => {
  await service.resendVerification(req.body.email);
  return ok(res, { sent: true }, `Verification email sent again to ${req.body.email}.`);
});

/** POST /auth/forgot-password */
export const forgotPassword = asyncHandler(async (req, res) => {
  const resetLink = await service.requestPasswordReset(req.body.email);
  // The message is deliberately identical whether or not the address exists.
  return ok(
    res,
    { sent: true, resetLink: resetLink ?? undefined },
    'If that address belongs to an Aarambam account, a password reset link is on its way.',
  );
});

/** POST /auth/reset-password */
export const resetPassword = asyncHandler(async (req, res) => {
  await service.resetPassword(req.body);
  return ok(res, { reset: true }, 'Password updated. You can sign in with your new password.');
});

/** POST /auth/change-password */
export const changePassword = asyncHandler(async (req, res) => {
  await service.changePassword(req.user.id, req.body);
  clearRefreshCookie(res);
  return ok(res, { changed: true }, 'Password changed. You have been signed out of your other devices.');
});

/** POST /auth/change-email */
export const changeEmail = asyncHandler(async (req, res) => {
  await service.requestEmailChange(req.user.id, req.body.email);
  return ok(
    res,
    { pendingEmail: req.body.email },
    `Open the link we sent to ${req.body.email} to finish.`,
  );
});

export default {
  register,
  login,
  demoLogin,
  refresh,
  logout,
  me,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
  changePassword,
  changeEmail,
};
