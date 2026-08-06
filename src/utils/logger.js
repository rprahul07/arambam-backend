import env from '../config/env.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[(process.env.LOG_LEVEL || (env.isProd ? 'info' : 'debug')).toLowerCase()] ?? 2;

const stamp = () => new Date().toISOString();

const emit = (level, stream, args) => {
  if (LEVELS[level] > threshold) return;
  stream(`${stamp()} [${level.toUpperCase()}]`, ...args);
};

export const logger = {
  error: (...args) => emit('error', console.error, args),
  warn: (...args) => emit('warn', console.warn, args),
  info: (...args) => emit('info', console.log, args),
  debug: (...args) => emit('debug', console.log, args),
};

export default logger;
