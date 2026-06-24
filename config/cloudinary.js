const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

/**
 * Upload a buffer to Cloudinary.
 * @param {Buffer} buffer       - File buffer from Multer
 * @param {string} folder       - Cloudinary folder (e.g. 'memoria/photos')
 * @param {string} resourceType - 'image' | 'video' | 'raw'
 * @param {object} options      - Additional Cloudinary upload options
 * @returns {Promise<object>}   - { url, publicId, format, bytes, width, height }
 */
async function uploadToCloudinary(buffer, folder, resourceType = 'image', options = {}) {
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder,
      resource_type: resourceType,
      ...options,
    };

    const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
      if (error) return reject(error);
      resolve({
        url:      result.secure_url,
        publicId: result.public_id,
        format:   result.format,
        bytes:    result.bytes,
        width:    result.width  || null,
        height:   result.height || null,
      });
    });

    stream.end(buffer);
  });
}

module.exports = { cloudinary, uploadToCloudinary };
