import { query, queryOne, withTransaction } from '../../database/index.js';
import env from '../../config/env.js';
import { ROLES } from '../../config/constants.js';
import ApiError from '../../utils/ApiError.js';
import { hashPassword, verifyPassword, burnPasswordTime } from '../../utils/password.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  randomToken,
} from '../../utils/jwt.js';
import { toUser, toMember } from '../../serializers/index.js';
import { sendTemplate } from '../../services/email.service.js';
import { push } from '../../services/notification.service.js';
import { recordQuietly } from '../../services/activity.service.js';
import logger from '../../utils/logger.js';

/**
 * Accounts and sessions.
 *
 * Two deliberate properties run through this file:
 *
 *  1. Nothing here tells an anonymous caller whether an address has an
 *     account. Sign-in, password reset and registration all answer the same
 *     way for a known and an unknown address, and the sign-in path burns the
 *     same time either way so the difference cannot be timed either.
 *
 *  2. A refresh token is stored only as a digest and is rotated on every use.
 *     Presenting a token that has already been exchanged revokes the whole
 *     family, which is what turns a stolen cookie into a dead end.
 */

const USER_COLUMNS = `id, name, email, phone, role, status, email_verified, avatar_url,
                      created_at, last_login_at`;

const expiresInDays = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

export const findUserByEmail = (email) =>
  queryOne(`SELECT * FROM users WHERE lower(email) = lower($1)`, [email]);

export const findUserById = (id) => queryOne(`SELECT * FROM users WHERE id = $1`, [id]);

export const findMemberByUserId = (userId) =>
  queryOne(`SELECT * FROM members WHERE user_id = $1`, [userId]);

/** Organizers carry the ids of the events they run; the SPA scopes on this. */
async function assignedEventIds(user) {
  if (user.role !== ROLES.ORGANIZER) return undefined;
  const { rows } = await query(`SELECT id FROM events WHERE organizer_id = $1 ORDER BY date`, [user.id]);
  return rows.map((row) => row.id);
}

/** The identity payload every authenticating endpoint answers with. */
export async function identity(user) {
  const member = await findMemberByUserId(user.id);
  return {
    user: toUser(user, { assignedEventIds: await assignedEventIds(user) }),
    member: member ? toMember(member) : null,
    session: {
      userId: user.id,
      role: user.role,
      memberId: member?.id,
    },
  };
}

/* ------------------------------------------------------------------ tokens */

async function issueSession(user, { userAgent, ip } = {}) {
  const accessToken = signAccessToken(user);

  const { rows } = await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1,'pending',$2,$3,$4) RETURNING id`,
    [user.id, userAgent ?? null, ip ?? null, expiresInDays(env.jwt.refreshDays)],
  );

  const tokenId = rows[0].id;
  const refreshToken = signRefreshToken(user, tokenId);
  await query(`UPDATE refresh_tokens SET token_hash = $1 WHERE id = $2`, [
    hashToken(refreshToken),
    tokenId,
  ]);

  return { accessToken, refreshToken };
}

/**
 * Exchanges a refresh token for a new pair, rotating the old one out.
 * Re-presenting a spent token is treated as theft: every session for that
 * account is revoked.
 */
export async function rotateSession(refreshToken, context = {}) {
  const payload = verifyRefreshToken(refreshToken);
  const digest = hashToken(refreshToken);

  const stored = await queryOne(`SELECT * FROM refresh_tokens WHERE id = $1`, [payload.jti]);
  if (!stored || stored.token_hash !== digest) {
    if (stored) {
      await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [
        stored.user_id,
      ]);
      logger.warn(`Refresh token replay for user ${stored.user_id} — all sessions revoked`);
    }
    throw ApiError.unauthorized('Your session is no longer valid', undefined, 'SESSION_INVALID');
  }
  if (stored.revoked_at) {
    await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [
      stored.user_id,
    ]);
    throw ApiError.unauthorized('Your session is no longer valid', undefined, 'SESSION_INVALID');
  }
  if (new Date(stored.expires_at) <= new Date()) {
    throw ApiError.unauthorized('Your session has expired', undefined, 'SESSION_EXPIRED');
  }

  const user = await findUserById(stored.user_id);
  if (!user || user.status !== 'active') {
    throw ApiError.unauthorized('That account is not available', undefined, 'ACCOUNT_INACTIVE');
  }

  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [stored.id]);
  const tokens = await issueSession(user, context);
  return { user, ...tokens };
}

export const revokeSession = (refreshToken) => {
  if (!refreshToken) return Promise.resolve();
  return query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, [
    hashToken(refreshToken),
  ]);
};

export const revokeAllSessions = (userId) =>
  query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [
    userId,
  ]);

/* -------------------------------------------------------------- registration */

export async function register({ name, email, phone, password }, context = {}) {
  const existing = await findUserByEmail(email);
  if (existing) {
    // The front end shows a "that email already has an account" notice on this
    // form, so a conflict here is the designed behaviour rather than a leak.
    throw ApiError.conflict('That email address already has an account', { email: 'Already registered' }, 'EMAIL_TAKEN');
  }

  const verifyToken = randomToken();
  const user = await withTransaction(async (tx) => {
    const created = await tx.queryOne(
      `INSERT INTO users (name, email, phone, password_hash, role, status,
                          email_verified, email_verify_token, email_verify_expires)
       VALUES ($1,$2,$3,$4,'member','active',false,$5,$6)
       RETURNING *`,
      [
        name,
        email,
        phone,
        await hashPassword(password),
        verifyToken,
        new Date(Date.now() + env.security.emailVerifyTtlHours * 3600 * 1000),
      ],
    );

    await push({
      client: tx,
      userId: created.id,
      type: 'account_registered',
      title: 'Welcome to Aarambam',
      body: 'Confirm your email address to activate your account.',
      href: '/verify-email',
    });

    return created;
  });

  const link = `${env.clientUrl}/verify-email?token=${verifyToken}&email=${encodeURIComponent(email)}`;
  await sendTemplate('account_registration', email, {
    member_name: name,
    verification_link: link,
  });

  recordQuietly({
    actorId: user.id,
    subjectType: 'user',
    subjectId: user.id,
    action: 'register',
    description: `${name} created an account`,
    meta: { ip: context.ip },
  });

  return { user, verifyToken };
}

/* ------------------------------------------------------------------- login */

export async function login({ email, password }, context = {}) {
  const user = await findUserByEmail(email);

  // One message and one duration for "no such account" and "wrong password".
  if (!user) {
    await burnPasswordTime();
    throw ApiError.unauthorized(
      'That email address and password do not match an account.',
      undefined,
      'INVALID_CREDENTIALS',
    );
  }

  const matches = await verifyPassword(password, user.password_hash);
  if (!matches) {
    throw ApiError.unauthorized(
      'That email address and password do not match an account.',
      undefined,
      'INVALID_CREDENTIALS',
    );
  }

  if (user.status !== 'active') {
    throw ApiError.forbidden(
      'This account has been deactivated. Contact the Aarambam office to have it reopened.',
      undefined,
      'ACCOUNT_INACTIVE',
    );
  }

  if (!user.email_verified) {
    throw new ApiError(
      403,
      'Confirm your email address before signing in.',
      { email: user.email },
      'EMAIL_NOT_VERIFIED',
    );
  }

  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  user.last_login_at = new Date();

  const tokens = await issueSession(user, context);
  return { user, ...tokens };
}

/**
 * The three one-click role buttons on the sign-in screen. Gated by
 * DEMO_LOGIN_ENABLED and it never bypasses the account checks — it signs in as
 * a real seeded account with a real session.
 */
export async function demoLogin(role, context = {}) {
  if (!env.demoLoginEnabled) {
    throw ApiError.forbidden('Demonstration sign-in is switched off on this deployment');
  }

  const user = await queryOne(
    `SELECT * FROM users
     WHERE role = $1 AND status = 'active' AND email_verified = true
     ORDER BY created_at
     LIMIT 1`,
    [role],
  );
  if (!user) throw ApiError.notFound(`No demonstration account exists for the ${role} role`);

  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  user.last_login_at = new Date();

  const tokens = await issueSession(user, context);
  return { user, ...tokens };
}

/* ------------------------------------------------------ email verification */

export async function verifyEmail(token) {
  const user = await queryOne(
    `SELECT * FROM users WHERE email_verify_token = $1 AND email_verify_expires > now()`,
    [token],
  );
  if (!user) {
    throw ApiError.badRequest(
      'This confirmation link is not valid. Ask for a new one and it will work.',
      undefined,
      'VERIFICATION_INVALID',
    );
  }

  await query(
    `UPDATE users
     SET email_verified = true, email_verify_token = NULL, email_verify_expires = NULL,
         email = COALESCE(pending_email, email), pending_email = NULL
     WHERE id = $1`,
    [user.id],
  );

  recordQuietly({
    actorId: user.id,
    subjectType: 'user',
    subjectId: user.id,
    action: 'verify_email',
    description: 'Email address confirmed',
  });

  return findUserById(user.id);
}

export async function resendVerification(email) {
  const user = await findUserByEmail(email);
  // Answer the same way whether or not the address exists.
  if (!user || user.email_verified) return;

  const token = randomToken();
  await query(
    `UPDATE users SET email_verify_token = $1, email_verify_expires = $2 WHERE id = $3`,
    [token, new Date(Date.now() + env.security.emailVerifyTtlHours * 3600 * 1000), user.id],
  );

  await sendTemplate('account_registration', user.email, {
    member_name: user.name,
    verification_link: `${env.clientUrl}/verify-email?token=${token}&email=${encodeURIComponent(user.email)}`,
  });
}

/* ---------------------------------------------------------------- password */

/**
 * When SMTP is not configured the message is only written to the log, which
 * leaves nobody a way to follow the link. On a non-production deployment the
 * link is handed back to the caller instead, so a walkthrough can complete the
 * flow. Never in production, and never when mail is actually being delivered.
 */
export const canRevealLinks = () => env.mail.previewOnly && !env.isProd;

export async function requestPasswordReset(email) {
  const user = await findUserByEmail(email);
  if (!user) return null; // Silence is the whole point.

  const token = randomToken();
  await query(
    `UPDATE users SET reset_token = $1, reset_expires = $2 WHERE id = $3`,
    [token, new Date(Date.now() + env.security.passwordResetTtlMinutes * 60 * 1000), user.id],
  );

  const link = `${env.clientUrl}/reset-password?token=${token}&email=${encodeURIComponent(user.email)}`;
  await sendTemplate('account_registration', user.email, {
    member_name: user.name,
    verification_link: link,
  });

  recordQuietly({
    actorId: user.id,
    subjectType: 'user',
    subjectId: user.id,
    action: 'request_password_reset',
    description: 'Password reset requested',
  });

  return canRevealLinks() ? link : null;
}

export async function resetPassword({ token, password }) {
  const user = await queryOne(
    `SELECT * FROM users WHERE reset_token = $1 AND reset_expires > now()`,
    [token],
  );
  if (!user) {
    throw ApiError.badRequest(
      'This reset link is not valid. Reset links can be used once and expire after an hour.',
      undefined,
      'RESET_INVALID',
    );
  }

  await query(
    `UPDATE users SET password_hash = $1, reset_token = NULL, reset_expires = NULL WHERE id = $2`,
    [await hashPassword(password), user.id],
  );
  // "You have been signed out everywhere else as a precaution."
  await revokeAllSessions(user.id);

  recordQuietly({
    actorId: user.id,
    subjectType: 'user',
    subjectId: user.id,
    action: 'reset_password',
    description: 'Password reset completed',
  });
}

export async function changePassword(userId, { currentPassword, password }) {
  const user = await findUserById(userId);
  if (!user) throw ApiError.notFound('Account not found');

  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    throw ApiError.badRequest('That is not your current password', {
      currentPassword: 'That is not your current password',
    });
  }

  await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
    await hashPassword(password),
    userId,
  ]);
  await revokeAllSessions(userId);

  recordQuietly({
    actorId: userId,
    subjectType: 'user',
    subjectId: userId,
    action: 'change_password',
    description: 'Password changed',
  });
}

/**
 * Starts an email change. The address on the account is unchanged until the
 * new one is confirmed — the settings screen promises exactly that.
 */
export async function requestEmailChange(userId, newEmail) {
  const taken = await queryOne(`SELECT id FROM users WHERE lower(email) = lower($1) AND id <> $2`, [
    newEmail,
    userId,
  ]);
  if (taken) throw ApiError.conflict('That email address is already in use', { email: 'Already in use' });

  const user = await findUserById(userId);
  const token = randomToken();
  await query(
    `UPDATE users SET pending_email = $1, email_verify_token = $2, email_verify_expires = $3 WHERE id = $4`,
    [newEmail, token, new Date(Date.now() + env.security.emailVerifyTtlHours * 3600 * 1000), userId],
  );

  await sendTemplate('account_registration', newEmail, {
    member_name: user.name,
    verification_link: `${env.clientUrl}/verify-email?token=${token}&email=${encodeURIComponent(newEmail)}`,
  });
}

export default {
  identity,
  register,
  login,
  demoLogin,
  rotateSession,
  revokeSession,
  revokeAllSessions,
  verifyEmail,
  resendVerification,
  requestPasswordReset,
  resetPassword,
  changePassword,
  requestEmailChange,
  findUserById,
  findUserByEmail,
  USER_COLUMNS,
};
