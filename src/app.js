import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';

import env from './config/env.js';
import routes from './modules/index.js';
import { notFound, errorHandler } from './middleware/error.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { handleWebhook } from './modules/payments/payments.webhook.js';
import { checkConnection } from './database/index.js';
import { UPLOAD_DIR } from './middleware/upload.js';
import logger from './utils/logger.js';

const app = express();

// Behind a managed host the client address arrives in X-Forwarded-For, and
// rate limiting is only meaningful if that is trusted.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.set('etag', false);

/* --------------------------------------------------------------- security */

app.use(
  helmet({
    // Uploads are served to the SPA on a different origin.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // The API answers JSON, never HTML, so a CSP here protects nothing that
    // the SPA's own policy does not already cover.
    contentSecurityPolicy: false,
  }),
);

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header means a server-to-server call or a health probe.
      if (!origin || env.corsOrigins.includes('*') || env.corsOrigins.includes(origin.replace(/\/$/, ''))) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} is not permitted by CORS`));
    },
    credentials: true, // the refresh cookie depends on this
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['Content-Disposition'],
    maxAge: 86_400,
  }),
);

app.use(compression());
app.use(cookieParser());
app.use(
  morgan(env.isProd ? 'combined' : 'dev', {
    skip: (req) => req.path === '/health' || env.isTest,
  }),
);

/* ---------------------------------------------------------------- webhook */
// Mounted before the JSON parser so the raw bytes survive for the HMAC check.

app.post(
  `${env.apiPrefix}/payments/webhook`,
  express.raw({ type: '*/*', limit: '1mb' }),
  (req, res, next) => {
    req.rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    try {
      req.body = req.rawBody ? JSON.parse(req.rawBody) : {};
    } catch {
      return res.status(400).json({ success: false, message: 'The webhook body is not valid JSON' });
    }
    return next();
  },
  handleWebhook,
);

/* ----------------------------------------------------------- body parsing */

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

/* -------------------------------------------------------- static uploads */

app.use(
  '/uploads',
  express.static(UPLOAD_DIR, {
    maxAge: '7d',
    fallthrough: true,
    index: false,
    dotfiles: 'deny',
    // Stored images are only ever served, never run.
    setHeaders: (res) => res.setHeader('Content-Disposition', 'inline'),
  }),
);

/* ------------------------------------------------------------- diagnostics */

app.get('/health', (req, res) =>
  res.json({ success: true, status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() }),
);

app.get('/health/db', async (req, res) => {
  try {
    const now = await checkConnection();
    res.json({ success: true, status: 'ok', driver: env.db.driver, serverTime: now });
  } catch (error) {
    logger.error('Database health check failed:', error.message);
    res.status(503).json({ success: false, status: 'error', driver: env.db.driver, message: error.message });
  }
});

app.get('/', (req, res) =>
  res.json({
    success: true,
    message: `${env.appName} — Event & Membership Management API`,
    version: '2.0.0',
    api: env.apiPrefix,
    health: '/health',
  }),
);

/* --------------------------------------------------------------------- API */

app.use(env.apiPrefix, globalLimiter, routes);

app.use(notFound);
app.use(errorHandler);

export default app;
