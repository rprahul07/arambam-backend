/**
 * The only error type the API throws deliberately. Anything else reaching the
 * error handler is treated as a bug and answered with a 500 that reveals
 * nothing about the internals.
 */
export default class ApiError extends Error {
  /**
   * @param {number} status   HTTP status code.
   * @param {string} message  Message safe to show a user.
   * @param {object} [details] Field-level detail, e.g. `{ email: 'Already used' }`.
   * @param {string} [code]   Stable machine-readable code for the client.
   */
  constructor(status, message, details, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.code = code;
    this.expected = true;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message = 'The request could not be processed', details, code) {
    return new ApiError(400, message, details, code);
  }

  static unauthorized(message = 'Authentication required', details, code = 'UNAUTHENTICATED') {
    return new ApiError(401, message, details, code);
  }

  static forbidden(message = 'You do not have permission to do that', details, code = 'FORBIDDEN') {
    return new ApiError(403, message, details, code);
  }

  static notFound(message = 'Not found', details, code = 'NOT_FOUND') {
    return new ApiError(404, message, details, code);
  }

  static conflict(message = 'That conflicts with something that already exists', details, code = 'CONFLICT') {
    return new ApiError(409, message, details, code);
  }

  static unprocessable(message = 'Validation failed', details, code = 'VALIDATION_FAILED') {
    return new ApiError(422, message, details, code);
  }

  static tooMany(message = 'Too many requests — try again shortly', details, code = 'RATE_LIMITED') {
    return new ApiError(429, message, details, code);
  }

  static unavailable(message = 'That service is not available', details, code = 'SERVICE_UNAVAILABLE') {
    return new ApiError(503, message, details, code);
  }
}
