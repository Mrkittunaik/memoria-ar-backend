const { body, param, validationResult } = require('express-validator');
const { errorResponse } = require('../utils/responseHelper');

function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return errorResponse(res, 'Validation failed', 400, errors.array());
  }
  next();
}

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

const validateScanLog = [
  body('memoryId')
    .exists({ checkFalsy: true })
    .withMessage('memoryId is required')
    .isMongoId()
    .withMessage('memoryId must be a valid MongoDB ObjectId'),
  handleValidationErrors,
];

// Allowed ratio values — 'auto' means the system fitted automatically,
// 'free' means user dragged without a ratio lock, 'video' means locked
// to the video's native aspect. All others are named presets.
const VALID_RATIOS = ['9:16', '1:1', '4:5', '16:9', '3:4', 'auto', 'video', 'free', 'custom'];

function validateRectShape(rect) {
  if (typeof rect !== 'object' || rect === null) {
    throw new Error('videoRect must be an object');
  }
  const { ratio, x, y, width, height } = rect;

  // ratio is optional in the shape — if present must be a known string
  if (ratio !== undefined && ratio !== null) {
    if (typeof ratio !== 'string' || !VALID_RATIOS.includes(ratio)) {
      throw new Error(`videoRect.ratio must be one of: ${VALID_RATIOS.join(', ')}`);
    }
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
