/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * middleware instead of hanging the request. Every controller in this codebase
 * is wrapped — that is what makes the absence of local try/catch safe.
 */
export const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

export default asyncHandler;
