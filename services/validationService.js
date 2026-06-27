/**
 * validationService
 * ──────────────────
 * Cheap, fail-fast checks that run BEFORE any Cloudinary upload or image
 * analysis happens. Single responsibility: reject obviously bad input
 * early so we never burn an upload + analysis pass on a doomed file.
 *
 * Deeper quality checks (blur/brightness/contrast) live in
 * imageAnalysisService + qualityService and run after this passes.
 */
const sharp = require('sharp');

const SUPPORTED_PHOTO_FORMATS = ['jpeg', 'jpg', 'png', 'webp'];
const SUPPORTED_VIDEO_MIME_PREFIX = 'video/';

const MIN_PHOTO_DIMENSION = 400;   // px, either side
const MAX_PHOTO_DIMENSION = 8000;  // px, either side — guards against decompression-bomb style files
const MIN_ASPECT_RATIO = 0.4;      // width/height — guards against absurdly thin slivers
const MAX_ASPECT_RATIO = 2.5;

const MAX_PHOTO_BYTES = 20 * 1024 * 1024;  // 20 MB (matches existing route limit)
const MAX_VIDEO_BYTES = 500 * 1024 * 1024; // 500 MB (matches existing multer limit)

/**
 * Validate the raw photo buffer before it goes anywhere near Cloudinary.
 * Checks real image structure (via sharp), not just the client-supplied
 * mimetype string — a renamed .exe with a fake Content-Type will fail
 * sharp's metadata read and be rejected here.
 *
 * @param {Buffer} buffer
 * @param {object} file - multer file object (for size / declared mimetype)
 * @returns {Promise<{ valid: boolean, errors: string[], metadata: object|null }>}
 */
async function validatePhoto(buffer, file) {
  const errors = [];

  if (!file.mimetype.startsWith('image/')) {
    errors.push('Photo must be an image file (JPEG, PNG, or WebP)');
  }
  if (file.size > MAX_PHOTO_BYTES) {
    errors.push(`Photo must be under ${MAX_PHOTO_BYTES / 1024 / 1024} MB`);
  }

  let metadata = null;
  try {
    metadata = await sharp(buffer).metadata();
  } catch (_) {
    errors.push('Photo file is corrupted or not a valid image');
    return { valid: false, errors, metadata: null };
  }

  if (!SUPPORTED_PHOTO_FORMATS.includes(metadata.format)) {
    errors.push(`Unsupported image format "${metadata.format}" — use JPEG, PNG, or WebP`);
  }

  const { width, height } = metadata;
  if (!width || !height) {
    errors.push('Could not read photo dimensions');
  } else {
    if (width < MIN_PHOTO_DIMENSION || height < MIN_PHOTO_DIMENSION) {
      errors.push(`Photo resolution too low (${width}×${height}) — minimum ${MIN_PHOTO_DIMENSION}×${MIN_PHOTO_DIMENSION}px`);
    }
    if (width > MAX_PHOTO_DIMENSION || height > MAX_PHOTO_DIMENSION) {
      errors.push(`Photo resolution too high (${width}×${height}) — maximum ${MAX_PHOTO_DIMENSION}×${MAX_PHOTO_DIMENSION}px`);
    }
    const aspect = width / height;
    if (aspect < MIN_ASPECT_RATIO || aspect > MAX_ASPECT_RATIO) {
      errors.push(`Photo aspect ratio (${aspect.toFixed(2)}) is too extreme — must be between ${MIN_ASPECT_RATIO} and ${MAX_ASPECT_RATIO}`);
    }
  }

  return { valid: errors.length === 0, errors, metadata };
}

/**
 * Validate the raw video file. Kept lightweight (no ffprobe dependency) —
 * just mimetype + size, matching what the route already enforced inline.
 *
 * @param {object} file - multer file object
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateVideo(file) {
  const errors = [];
  if (!file.mimetype.startsWith(SUPPORTED_VIDEO_MIME_PREFIX)) {
    errors.push('Video must be a video file (MP4, MOV, WebM…)');
  }
  if (file.size > MAX_VIDEO_BYTES) {
    errors.push(`Video must be under ${MAX_VIDEO_BYTES / 1024 / 1024} MB`);
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  validatePhoto,
  validateVideo,
  SUPPORTED_PHOTO_FORMATS,
  MIN_PHOTO_DIMENSION,
  MAX_PHOTO_DIMENSION,
  MAX_PHOTO_BYTES,
  MAX_VIDEO_BYTES,
};
