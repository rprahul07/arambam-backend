import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..', '..');

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (value, fallback = []) =>
  value
    ? String(value)
        .split(',')
        .map((item) => item.trim().replace(/\/$/, ''))
        .filter(Boolean)
    : fallback;

const nodeEnv = process.env.NODE_ENV || 'development';

/**
 * Which storage engine backs the API.
 *
 *   pglite    — an embedded PostgreSQL 16 (WASM). Zero configuration, stores
 *               to ./.data, and speaks exactly the same SQL as production.
 *   postgres  — a real PostgreSQL/Supabase server via DATABASE_URL.
 *
 * The default is `postgres` when DATABASE_URL is present and `pglite`
 * otherwise, so a fresh clone boots and serves the front end immediately.
 */
const resolveDriver = () => {
  const explicit = (process.env.DATABASE_DRIVER || '').toLowerCase();
  if (explicit === 'postgres' || explicit === 'pglite') return explicit;
  return process.env.DATABASE_URL ? 'postgres' : 'pglite';
};

export const env = {
  nodeEnv,
  isProd: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: int(process.env.PORT, 5000),
  apiPrefix: process.env.API_PREFIX || '/api/v1',
  appName: process.env.APP_NAME || 'Aarambam',
  clientUrl: (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, ''),
  serverUrl: (process.env.SERVER_URL || 'http://localhost:5000').replace(/\/$/, ''),
  corsOrigins: list(process.env.CORS_ORIGINS, [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
  ]),

  db: {
    driver: resolveDriver(),
    url: process.env.DATABASE_URL,
    ssl: bool(process.env.DATABASE_SSL, true),
    poolMax: int(process.env.DB_POOL_MAX, 10),
    /** Directory PGlite persists to. `:memory:` keeps everything in RAM. */
    dataDir: process.env.PGLITE_DATA_DIR || path.join(ROOT_DIR, '.data', 'pglite'),
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me',
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '30m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    /** Days the refresh cookie survives. Must match refreshExpiresIn. */
    refreshDays: int(process.env.JWT_REFRESH_DAYS, 7),
  },

  security: {
    bcryptRounds: int(process.env.BCRYPT_SALT_ROUNDS, 10),
    emailVerifyTtlHours: int(process.env.EMAIL_VERIFY_TOKEN_TTL_HOURS, 24),
    passwordResetTtlMinutes: int(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES, 60),
    /** Cookie `SameSite`. `lax` works when the SPA is same-site or proxied. */
    cookieSameSite: process.env.COOKIE_SAME_SITE || (nodeEnv === 'production' ? 'none' : 'lax'),
    cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  },

  mail: {
    host: process.env.SMTP_HOST,
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    fromName: process.env.MAIL_FROM_NAME || process.env.APP_NAME || 'Aarambam',
    fromAddress: process.env.MAIL_FROM_ADDRESS || 'hello@aarambam.org',
    /** When true (or when SMTP is unset) emails are written to the log only. */
    previewOnly: bool(process.env.MAIL_PREVIEW_ONLY, !process.env.SMTP_HOST),
  },

  payment: {
    /**
     * `simulated` performs the whole flow locally and is what the shipped
     * front end drives from its payment dialog. `razorpay` requires a real
     * signature before anything is marked successful.
     */
    provider: (process.env.PAYMENT_PROVIDER || 'simulated').toLowerCase(),
    currency: process.env.PAYMENT_CURRENCY || 'INR',
    holdMinutes: int(process.env.PAYMENT_HOLD_MINUTES, 20),
    razorpay: {
      keyId: process.env.RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    },
  },

  uploads: {
    dir: process.env.UPLOAD_DIR || path.join(ROOT_DIR, 'uploads'),
    maxBytes: int(process.env.UPLOAD_MAX_BYTES, 5 * 1024 * 1024),
  },

  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
    bucket: process.env.SUPABASE_STORAGE_BUCKET || 'aarambam-assets',
    /* A second, private bucket for images that are nobody else's business:
       member photographs and the screenshots people send as proof of payment.
       Served only through an authorised redirect — see `media.js`. */
    privateBucket: process.env.SUPABASE_PRIVATE_BUCKET || 'aarambam-private',
    /* How long a signed link stays good. Long enough to load a page and
       glance at it, short enough that a copied link is not a lasting key. */
    signedUrlSeconds: Number(process.env.SUPABASE_SIGNED_URL_SECONDS || 300),
  },

  /**
   * The three one-click role buttons on the sign-in screen. Enabled by default
   * for demonstration builds; turn off with DEMO_LOGIN_ENABLED=false.
   */
  demoLoginEnabled: bool(process.env.DEMO_LOGIN_ENABLED, nodeEnv !== 'production'),
  /** Password every seeded account shares, so the demo can be driven by hand. */
  seedPassword: process.env.SEED_PASSWORD || 'Aarambam@2026',

  jobs: {
    enabled: bool(process.env.ENABLE_CRON, true),
    renewalReminderDays: int(process.env.RENEWAL_REMINDER_DAYS, 30),
    eventReminderHours: int(process.env.EVENT_REMINDER_HOURS, 24),
  },

  rateLimit: {
    windowMinutes: int(process.env.RATE_LIMIT_WINDOW_MINUTES, 15),
    max: int(process.env.RATE_LIMIT_MAX, 1000),
    authMax: int(process.env.AUTH_RATE_LIMIT_MAX, 30),
    writeMax: int(process.env.WRITE_RATE_LIMIT_MAX, 300),
  },
};

/**
 * Fails fast on configuration the process cannot run without, and returns
 * warnings for optional integrations so the API still boots before the client
 * supplies gateway or SMTP credentials.
 */
export function assertEnv() {
  const missing = [];
  if (env.db.driver === 'postgres' && !env.db.url) missing.push('DATABASE_URL');

  if (env.isProd) {
    if (env.jwt.accessSecret.startsWith('dev-')) missing.push('JWT_ACCESS_SECRET');
    if (env.jwt.refreshSecret.startsWith('dev-')) missing.push('JWT_REFRESH_SECRET');
  }

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const warnings = [];
  if (env.db.driver === 'pglite') {
    warnings.push(
      `Using the embedded PGlite database at ${env.db.dataDir}. Set DATABASE_URL for PostgreSQL/Supabase.`,
    );
  }
  if (env.mail.previewOnly) warnings.push('SMTP is not configured — emails are written to the log only.');
  if (env.payment.provider === 'simulated') {
    warnings.push('Payment provider is `simulated` — settlements are accepted without a gateway signature.');
  }
  if (env.payment.provider === 'razorpay' && !env.payment.razorpay.keySecret) {
    warnings.push('Razorpay keys are missing — payment settlement will return 503.');
  }
  if (env.isProd && env.demoLoginEnabled) {
    warnings.push('DEMO_LOGIN_ENABLED is on in production — one-click role sign-in is exposed.');
  }
  return warnings;
}

export default env;
