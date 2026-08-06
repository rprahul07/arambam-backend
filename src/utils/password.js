import bcrypt from 'bcryptjs';
import env from '../config/env.js';

/** Mirrors the strength rule the front end enforces on the register form. */
export const PASSWORD_RULE =
  'Use at least 8 characters with a capital letter, a number and a symbol';

export const isStrongPassword = (value) =>
  typeof value === 'string' &&
  value.length >= 8 &&
  /[A-Z]/.test(value) &&
  /\d/.test(value) &&
  /[^A-Za-z0-9]/.test(value);

export const hashPassword = (plain) => bcrypt.hash(plain, env.security.bcryptRounds);

export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash || '');

/**
 * Burns roughly the same time as a real comparison so that a request for an
 * address with no account cannot be told apart from a wrong password.
 */
const DECOY = bcrypt.hashSync('timing-equaliser', env.security.bcryptRounds);
export const burnPasswordTime = () => bcrypt.compare('timing-equaliser', DECOY);

export default { hashPassword, verifyPassword, isStrongPassword, burnPasswordTime, PASSWORD_RULE };
