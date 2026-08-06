import { ZodError } from 'zod';
import ApiError from '../utils/ApiError.js';

/**
 * Schema validation at the edge.
 *
 * Handlers below this line receive values that have already been parsed,
 * coerced and stripped of anything not declared — so no controller has to ask
 * whether a field is a string, and no unexpected key can reach an UPDATE.
 */
const run = (schema, value) => schema.parse(value);

export const validateBody = (schema) => (req, res, next) => {
  try {
    req.body = run(schema, req.body ?? {});
    next();
  } catch (error) {
    next(error instanceof ZodError ? error : ApiError.badRequest('Invalid request body'));
  }
};

export const validateQuery = (schema) => (req, res, next) => {
  try {
    // `req.query` is a null-prototype object on Express 5; copy before parsing.
    req.validatedQuery = run(schema, { ...req.query });
    next();
  } catch (error) {
    next(error instanceof ZodError ? error : ApiError.badRequest('Invalid query string'));
  }
};

export const validateParams = (schema) => (req, res, next) => {
  try {
    req.params = run(schema, { ...req.params });
    next();
  } catch (error) {
    next(error instanceof ZodError ? error : ApiError.badRequest('Invalid path parameter'));
  }
};

export default { validateBody, validateQuery, validateParams };
