import app from './app.js';
import env, { assertEnv } from './config/env.js';
import db from './database/index.js';
import { startJobs, stopJobs } from './jobs/scheduler.js';
import logger from './utils/logger.js';

/**
 * Process lifecycle: connect, listen, and shut down without dropping requests
 * that are already in flight.
 */

let server = null;
let shuttingDown = false;

async function start() {
  for (const warning of assertEnv()) logger.warn(warning);

  await db.connect();

  server = app.listen(env.port, () => {
    logger.info(`${env.appName} API listening on ${env.serverUrl} (${env.nodeEnv})`);
    logger.info(`API root:  ${env.serverUrl}${env.apiPrefix}`);
    logger.info(`Allowing:  ${env.corsOrigins.join(', ')}`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(`Port ${env.port} is already in use.`);
      process.exit(1);
    }
    throw error;
  });

  startJobs();
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — shutting down`);

  stopJobs();

  const forced = setTimeout(() => {
    logger.error('Shutdown took too long — exiting');
    process.exit(1);
  }, 10_000);
  forced.unref();

  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await db.close().catch((error) => logger.error('Closing the database failed:', error.message));

  clearTimeout(forced);
  logger.info('Stopped cleanly');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  shutdown('uncaughtException');
});

start().catch((error) => {
  logger.error('The API failed to start:', error.message);
  process.exit(1);
});
