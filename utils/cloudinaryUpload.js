const { cloudinary } = require('../config/cloudinary');

function uploadToCloudinary(buffer, folder, resourceType = 'image', options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType, ...options },
      (error, result) => { if (error) return reject(error); resolve(result); }
    );
    stream.end(buffer);
  });
}

async function uploadPhoto(buffer) {
  return uploadToCloudinary(buffer, 'memoria/photos', 'image', {
    // eager=false: skip synchronous transform, deliver on first request instead
    transformation: [
      { width: 1200, crop: 'limit', quality: 'auto:low', fetch_format: 'auto', strip_profile: true },
    ],
    // Return immediately after upload — transformation happens async on CDN
    eager_async: true,
  });
}

async function uploadVideo(buffer) {
  return uploadToCloudinary(buffer, 'memoria/videos', 'video', {
    // Cap at 720p, aggressive quality, strip audio metadata, use h264 for widest compat
    transformation: [
      {
        width: 1280, height: 720, crop: 'limit',
        quality: 'auto:low',
        fetch_format: 'mp4',
        video_codec: 'h264',
        audio_codec: 'aac',
        bit_rate: '800k',
        strip_profile: true,
      },
    ],
    eager_async: true,
    // Chunk large uploads — Cloudinary processes 20MB chunks in parallel
    chunk_size: 20_000_000,
  });
}

async function deleteFromCloudinary(publicId, resourceType = 'image') {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.error(`[Cloudinary] Failed to delete ${publicId}: ${err.message}`);
  }
}

module.exports = { uploadPhoto, uploadVideo, deleteFromCloudinary };
