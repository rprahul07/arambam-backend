import { queryOne } from '../database/index.js';
import { verifyAccessToken } from '../utils/jwt.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ROLES } from '../config/constants.js';

/**
 * Authentication and authorisation.
 *
 * The route guards in the SPA decide what gets *rendered*. These decide what
 * may actually happen: every protected endpoint re-checks the role here, so
 * editing the address bar produces a 403 from the API rather than a different
 * screen.
 */

const extractToken = (req) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (req.cookies?.accessToken) return req.cookies.accessToken;
  return null;
};

const IDENTITY_SQL = `
  SELECT u.id, u.email, u.name, u.role, u.status, u.email_verified, u.phone,
         u.avatar_url, u.created_at, u.last_login_at,
         m.id AS member_id, m.member_id AS member_code, m.status AS member_status
  FROM users u
  LEFT JOIN members m ON m.user_id = u.id
  WHERE u.id = $1
`;

/**
 * Verifies the token and reloads the account on every request. Reading the
 * live row is what makes a deactivation or a role change take effect at once
 * instead of whenever the token happens to expire.
 */
export const authenticate = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) throw ApiError.unauthorized('Sign in to continue');

  const payload = verifyAccessToken(token);
  const user = await queryOne(IDENTITY_SQL, [payload.sub]);

  if (!user) throw ApiError.unauthorized('That account no longer exists');
  if (user.status !== 'active') {
    throw ApiError.forbidden(
      'This account has been deactivated. Contact the Aarambam office to have it reopened.',
      undefined,
      'ACCOUNT_INACTIVE',
    );
  }

  req.user = user;
  next();
});

/** Populates `req.user` when a valid token is present, but never rejects. */
export const optionalAuth = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const payload = verifyAccessToken(token);
    const user = await queryOne(IDENTITY_SQL, [payload.sub]);
    if (user && user.status === 'active') req.user = user;
  } catch {
    // On a public endpoint an expired or forged token is simply anonymous.
  }
  return next();
});

/** Restricts a route to the listed roles. */
export const authorize =
  (...roles) =>
  (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized('Sign in to continue'));
    if (roles.length && !roles.includes(req.user.role)) {
      return next(ApiError.forbidden('Your role does not permit this action'));
    }
    return next();
  };

export const adminOnly = authorize(ROLES.ADMIN);
export const staffOnly = authorize(ROLES.ADMIN, ROLES.ORGANIZER);

/** Blocks anything that should wait until the address has been confirmed. */
export const requireVerifiedEmail = (req, res, next) => {
  if (!req.user) return next(ApiError.unauthorized('Sign in to continue'));
  if (!req.user.email_verified) {
    return next(
      new ApiError(403, 'Confirm your email address to continue', undefined, 'EMAIL_NOT_VERIFIED'),
    );
  }
  return next();
};

/** Requires the caller to have a member profile, and exposes its id. */
export const requireMember = (req, res, next) => {
  if (!req.user) return next(ApiError.unauthorized('Sign in to continue'));
  if (!req.user.member_id) {
    return next(
      new ApiError(403, 'Complete your member profile first', undefined, 'MEMBER_PROFILE_REQUIRED'),
    );
  }
  return next();
};

export const isAdmin = (user) => user?.role === ROLES.ADMIN;
export const isStaff = (user) => user?.role === ROLES.ADMIN || user?.role === ROLES.ORGANIZER;

export default {
  authenticate,
  optionalAuth,
  authorize,
  adminOnly,
  staffOnly,
  requireVerifiedEmail,
  requireMember,
  isAdmin,
  isStaff,
};
