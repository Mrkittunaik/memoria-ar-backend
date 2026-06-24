const { cloudinary } = require('../config/cloudinary');

/**
 * Upload a buffer to Cloudinary via upload_stream.
 *
 * @param {Buffer} buffer       - Raw file bytes (from multer memoryStorage)
 * @param {string} folder       - Destination folder on Cloudinary
 * @param {string} resourceType - 'image' | 'video' | 'raw'
 * @param {object} options      - Extra Cloudinary upload_stream options
 * @returns {Promise<object>}   - Full Cloudinary upload result
 */
function uploadToCloudinary(buffer, folder, resourceType = 'image', options = {}) {
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder,
      resource_type: resourceType,
      ...options,
    };

    const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });

    stream.end(buffer);
  });
}

/**
 * Upload a photo buffer with quality/format optimisation and metadata stripping.
 * Max width capped at 1200px; aspect ratio preserved automatically.
 */
async function uploadPhoto(buffer) {
  return uploadToCloudinary(buffer, 'memoria/photos', 'image', {
    transformation: [
      { quality: 'auto', fetch_format: 'auto', width: 1200, crop: 'limit', strip_profile: true },
    ],
  });
}

/**
 * Upload a video buffer with auto quality.
 */
async function uploadVideo(buffer) {
  return uploadToCloudinary(buffer, 'memoria/videos', 'video', {
    transformation: [
      { quality: 'auto', fetch_format: 'auto' },
    ],
  });
}

/**
 * Delete a Cloudinary asset by public_id.
 * Swallows errors — used in cleanup paths so a failed delete doesn't mask the real error.
 */
async function deleteFromCloudinary(publicId, resourceType = 'image') {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.error(`[Cloudinary] Failed to delete ${publicId}: ${err.message}`);
  }
}

module.exports = { uploadPhoto, uploadVideo, deleteFromCloudinary };
