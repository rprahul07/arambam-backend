import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import env from '../config/env.js';
import ApiError from './ApiError.js';

/**
 * Access tokens are short-lived bearer tokens the SPA keeps in memory.
 * Refresh tokens are long-lived, stored hashed in the database and delivered
 * in an httpOnly cookie, so a stolen access token expires quickly and a
 * refresh token can be revoked server-side.
 */

export const signAccessToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role, email: user.email }, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpiresIn,
    issuer: env.appName,
  });

export const signRefreshToken = (user, tokenId) =>
  jwt.sign({ sub: user.id, jti: tokenId }, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshExpiresIn,
    issuer: env.appName,
  });

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, env.jwt.accessSecret, { issuer: env.appName });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw ApiError.unauthorized('Your session has expired', undefined, 'TOKEN_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid authentication token', undefined, 'TOKEN_INVALID');
  }
}

export function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, env.jwt.refreshSecret, { issuer: env.appName });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw ApiError.unauthorized('Your session has expired', undefined, 'SESSION_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid session', undefined, 'SESSION_INVALID');
  }
}

/** Refresh tokens are only ever stored as a digest — a leaked table is inert. */
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** A single-use, high-entropy token for email verification and password reset. */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

export default {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
  randomToken,
};
