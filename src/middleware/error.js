import { ZodError } from 'zod';
import ApiError from '../utils/ApiError.js';
import env from '../config/env.js';
import logger from '../utils/logger.js';

/** Anything that fell through the router. */
export const notFound = (req, res, next) =>
  next(ApiError.notFound(`No endpoint matches ${req.method} ${req.originalUrl}`));

/** Postgres error codes that mean something specific to a caller. */
const PG_CODES = {
  '23505': (error) => ApiError.conflict(uniqueMessage(error), undefined, 'DUPLICATE'),
  '23503': () => ApiError.badRequest('That refers to something which does not exist'),
  '23514': (error) => ApiError.unprocessable(checkMessage(error)),
  '22P02': () => ApiError.badRequest('One of the supplied values is not in the expected format'),
  '23502': () => ApiError.badRequest('A required value is missing'),
  '22021': () => ApiError.badRequest('One of the supplied values contains characters that cannot be stored'),
  '22001': () => ApiError.badRequest('One of the supplied values is longer than the field allows'),
  '22003': () => ApiError.badRequest('One of the supplied numbers is out of range'),
  '22007': () => ApiError.badRequest('One of the supplied dates is not in the expected format'),
  '22008': () => ApiError.badRequest('One of the supplied dates is out of range'),
};

const uniqueMessage = (error) => {
  const constraint = error.constraint || '';
  if (constraint.includes('users_email')) return 'That email address already has an account';
  if (constraint.includes('registrations_one_live_seat')) return 'You already hold a seat on this event';
  if (constraint.includes('events_slug') || constraint.includes('events_pkey')) {
    return 'An event with that title already exists';
  }
  if (constraint.includes('membership_plans_name')) return 'A plan with that name already exists';
  if (constraint.includes('event_categories')) return 'A category with that name already exists';
  return 'That already exists';
};

const checkMessage = (error) => {
  const constraint = error.constraint || '';
  if (constraint.includes('members_guardian_required')) {
    return 'Members under 18 need a guardian name and phone number';
  }
  if (constraint.includes('events_registration_window')) {
    return 'Registration must close after it opens';
  }
  if (constraint.includes('events_free_is_free')) {
    return 'A free event cannot carry a price';
  }
  if (constraint.includes('subscriptions_dates')) return 'The end date must fall after the start date';
  return 'One of the supplied values is not allowed';
};

/** Turns a Zod issue list into `{ field: message }`, which is what forms want. */
const zodDetails = (error) => {
  const details = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!details[key]) details[key] = issue.message;
  }
  return details;
};

/**
 * The single exit point for every failure. A caller always receives
 * `{ success: false, message, ... }`; the stack and the driver's own wording
 * stay in the log, where they belong.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies this by arity
export const errorHandler = (error, req, res, next) => {
  let failure = error;

  if (failure instanceof ZodError) {
    failure = ApiError.unprocessable('Please correct the highlighted fields', zodDetails(failure));
  } else if (failure?.code && PG_CODES[failure.code]) {
    failure = PG_CODES[failure.code](failure);
  } else if (failure?.type === 'entity.parse.failed') {
    failure = ApiError.badRequest('The request body is not valid JSON');
  } else if (failure?.type === 'entity.too.large') {
    failure = ApiError.badRequest('That request is too large');
  } else if (failure?.name === 'MulterError') {
    failure = ApiError.badRequest(
      failure.code === 'LIMIT_FILE_SIZE' ? 'That file is too large' : 'That upload was rejected',
    );
  } else if (typeof failure?.message === 'string' && failure.message.includes('not permitted by CORS')) {
    failure = ApiError.forbidden('This origin is not permitted to call the API');
  }

  if (!(failure instanceof ApiError)) {
    logger.error(`Unhandled ${req.method} ${req.originalUrl}:`, error?.stack || error);
    failure = new ApiError(500, 'Something went wrong at our end. Please try again.');
  } else if (failure.status >= 500) {
    logger.error(`${req.method} ${req.originalUrl}:`, error?.stack || error);
  } else {
    logger.debug(`${req.method} ${req.originalUrl} → ${failure.status}: ${failure.message}`);
  }

  const body = { success: false, message: failure.message };
  if (failure.code) body.code = failure.code;
  if (failure.details) body.errors = failure.details;
  if (!env.isProd && failure.status >= 500) body.stack = error?.stack;

  res.status(failure.status).json(body);
};

export default { notFound, errorHandler };
