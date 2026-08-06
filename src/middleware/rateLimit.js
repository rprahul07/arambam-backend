import rateLimit from 'express-rate-limit';
import env from '../config/env.js';

const minutes = (n) => n * 60 * 1000;

const shape = (message) => ({
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message, code: 'RATE_LIMITED' },
});

/** Blanket ceiling, generous enough that ordinary browsing never trips it. */
export const globalLimiter = rateLimit({
  windowMs: minutes(env.rateLimit.windowMinutes),
  max: env.rateLimit.max,
  skip: (req) => req.method === 'OPTIONS',
  ...shape('Too many requests — please slow down and try again shortly.'),
});

/**
 * Credential endpoints, keyed by IP *and* by the address being tried, so one
 * noisy network cannot lock out an account and one attacker cannot spray a
 * password across many accounts from a single address.
 */
export const authLimiter = rateLimit({
  windowMs: minutes(env.rateLimit.windowMinutes),
  max: env.rateLimit.authMax,
  keyGenerator: (req) => `${req.ip}:${String(req.body?.email || '').toLowerCase()}`,
  skipSuccessfulRequests: true,
  ...shape('Too many attempts. Wait a few minutes before trying again.'),
});

/** Anything that sends an email, which is the expensive thing to abuse. */
export const emailLimiter = rateLimit({
  windowMs: minutes(10),
  max: 5,
  keyGenerator: (req) => `${req.ip}:${String(req.body?.email || '').toLowerCase()}`,
  ...shape('You have asked for that a few times already. Try again in a few minutes.'),
});

/** Writes, so a scripted client cannot flood the database. */
export const writeLimiter = rateLimit({
  windowMs: minutes(env.rateLimit.windowMinutes),
  max: env.rateLimit.writeMax,
  ...shape('Too many changes at once — please try again shortly.'),
});

export default { globalLimiter, authLimiter, emailLimiter, writeLimiter };
