const { errorResponse } = require('../utils/responseHelper');

/**
 * Global Express error handler.
 * Must be mounted last (after all routes) with exactly 4 arguments.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const timestamp = new Date().toISOString();
  console.error(`[Error] ${timestamp} — ${err.name}: ${err.message}`);

  // Never leak stack traces in production
  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }

  // ── Mongoose validation error ─────────────────────────────────────────────
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map((e) => ({
      field:   e.path,
      message: e.message,
    }));
    return errorResponse(res, 'Validation failed', 400, errors);
  }

  // ── Mongoose duplicate key (unique index violation) ───────────────────────
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return errorResponse(res, `Duplicate value for ${field}`, 409);
  }

  // ── Mongoose cast error (e.g. bad ObjectId) ───────────────────────────────
  if (err.name === 'CastError') {
    return errorResponse(res, `Invalid value for ${err.path}`, 400);
  }

  // ── Multer file-size exceeded ─────────────────────────────────────────────
  if (err.code === 'LIMIT_FILE_SIZE') {
    // The human-readable limit is set as a custom property on the error
    // by the route (err.humanLimit). Fallback to a generic message.
    return errorResponse(res, err.humanLimit || 'File is too large', 413);
  }

  // ── Multer unexpected field ───────────────────────────────────────────────
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return errorResponse(res, `Unexpected file field: ${err.field}`, 400);
  }

  // ── Fallthrough — internal server error ───────────────────────────────────
  return errorResponse(res, 'Internal server error', 500);
}

module.exports = errorHandler;
