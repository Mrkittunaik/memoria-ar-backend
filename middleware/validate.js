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

  // videoRect arrives as a JSON string inside multipart form-data (set by the
  // position editor on the upload screen). Optional — falls back to schema
  // defaults (centered 9:16) if the user never touched the editor.
  body('videoRect')
    .optional({ checkFalsy: true })
    .custom((value) => {
      let parsed;
      try { parsed = JSON.parse(value); } catch (_) {
        throw new Error('videoRect must be valid JSON');
      }
      validateRectShape(parsed);
      return true;
    }),

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

/**
 * Shared shape check for a videoRect payload — used by both the upload
 * form (JSON string field) and the dedicated position PATCH endpoint
 * (JSON body). Throws on the first problem found.
 */
function validateRectShape(rect) {
  if (typeof rect !== 'object' || rect === null) {
    throw new Error('videoRect must be an object');
  }
  const { ratio, x, y, width, height } = rect;

  if (!['9:16', '1:1', '4:5'].includes(ratio)) {
    throw new Error('videoRect.ratio must be one of 9:16, 1:1, 4:5');
  }
  for (const [key, val] of Object.entries({ x, y, width, height })) {
    if (typeof val !== 'number' || Number.isNaN(val)) {
      throw new Error(`videoRect.${key} must be a number`);
    }
    if (val < 0 || val > 100) {
      throw new Error(`videoRect.${key} must be between 0 and 100`);
    }
  }
}

/**
 * Validates the body of PATCH /api/memories/:id/position — a fast,
 * metadata-only save with no file re-upload.
 */
const validatePosition = [
  param('id')
    .isMongoId()
    .withMessage('Invalid memory id'),

  body('videoRect')
    .exists()
    .withMessage('videoRect is required')
    .custom((value) => {
      validateRectShape(value);
      return true;
    }),

  handleValidationErrors,
];

module.exports = { validateUpload, validateScanLog, validatePosition };
