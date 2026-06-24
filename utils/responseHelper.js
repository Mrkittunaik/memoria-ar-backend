/**
 * Send a standardised success response.
 *
 * @param {object} res        - Express response object
 * @param {*}      data       - Payload to send
 * @param {string} message    - Human-readable success message
 * @param {number} statusCode - HTTP status (default 200)
 */
function successResponse(res, data = null, message = 'Success', statusCode = 200) {
  return res.status(statusCode).json({
    success:   true,
    message,
    data,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Send a standardised error response.
 *
 * @param {object} res        - Express response object
 * @param {string} message    - Human-readable error message
 * @param {number} statusCode - HTTP status (default 500)
 * @param {Array}  errors     - Optional array of field-level validation errors
 */
function errorResponse(res, message = 'An error occurred', statusCode = 500, errors = null) {
  const body = {
    success:   false,
    message,
    timestamp: new Date().toISOString(),
  };
  if (errors) body.errors = errors;
  return res.status(statusCode).json(body);
}

module.exports = { successResponse, errorResponse };
