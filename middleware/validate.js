const { body, param, validationResult } = require('express-validator');
const { errorResponse } = require('../utils/responseHelper');

/**
 * Run accumulated express-validator checks and short-circuit with 400 if any fail.
 */
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return errorResponse(res, 'Validation failed', 400, errors.array());
  }
  next();
}

/**
 * Validates the upload form fields (title, optional description).
 * File presence/type is validated separately in the route itself.
 */
const validateUpload = [
  body('title')
    .exists({ checkFalsy: true })
    .withMessage('Title is required')
    .isString()
    .withMessage('Title must be a string')
    .trim()
    .isLength({ max: 100 })
    .withMessage('Title must be 100 characters or fewer'),

  body('description')
    .optional({ checkFalsy: true })
    .isString()
    .withMessage('Description must be a string')
    .trim()
    .isLength({ max: 500 })
    .withMessage('Description must be 500 characters or fewer'),

  handleValidationErrors,
];

/**
 * Validates that memoryId in the request body is a valid MongoDB ObjectId.
 */
const validateScanLog = [
  body('memoryId')
    .exists({ checkFalsy: true })
    .withMessage('memoryId is required')
    .isMongoId()
    .withMessage('memoryId must be a valid MongoDB ObjectId'),

  handleValidationErrors,
];

module.exports = { validateUpload, validateScanLog };
