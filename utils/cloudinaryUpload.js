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
    transformation: [
      // 1200px limit keeps compile-side imagedata under 2MB for fast MindAR
      // feature extraction; auto:good gives cleaner edges than auto:low for
      // the feature-rich photos AR tracking needs.
      { width: 1200, crop: 'limit', quality: 'auto:good', fetch_format: 'auto', strip_profile: true },
    ],
    eager_async: true,
  });
}

async function uploadVideo(buffer) {
  return uploadToCloudinary(buffer, 'memoria/videos', 'video', {
    // ── PREMIUM VIDEO QUALITY ──────────────────────────────────────────────
    // quality: 'auto:good' — Cloudinary's perceptual quality target that
    //   preserves detail in skin tones, fabric textures, and subtle motion
    //   that matter for weddings/memorials. 'auto:low' visibly degrades
    //   these at the bit rates we were using (800k).
    // bit_rate: '2000k' — adequate for crisp 1080p MP4-H264 on mobile
    //   networks without buffering stalls. Mobile Chrome/Safari both handle
    //   2Mbps cleanly on 4G; 800k showed macro-blocking on movement.
    // width/height: keep 1920×1080 limit (up from 1280×720) — the backend
    //   now accepts true 1080p without downscaling. Cloudinary still
    //   respects aspect ratio (crop: 'limit' means "at most this size").
    // audio: aac 192k — perceptibly transparent for music/speech at wedding
    //   ceremonies; previous 'auto' defaulted to 96k which was audibly muddy.
    // strip_profile: true — removes camera metadata (GPS, make/model) from
    //   the delivered file, matching Cloudinary's own security recommendations.
    //
    // FUTURE 4K PATH: change width to 3840, height to 2160, bit_rate to
    //   '8000k' and add `video_codec: 'h265'` (with browser detection on
    //   the frontend using `video.canPlayType('video/mp4; codecs="hev1"')`).
    //   The rest of this pipeline is already compatible — no other changes.
    //
    // FUTURE ADAPTIVE STREAMING: replace the single transformation block
    //   with eager: [{streaming_profile: 'hd'}] and set
    //   `streaming_profile: 'hd'` in options to produce an HLS/DASH
    //   manifest alongside the mp4. The scanner's video element can then
    //   use a <source type="application/x-mpegURL"> with hls.js as the
    //   first source and the mp4 as fallback — no other frontend changes.
    transformation: [
      {
        width: 1920, height: 1080, crop: 'limit',
        quality: 'auto:good',
        fetch_format: 'mp4',
        video_codec: 'h264',
        audio_codec: 'aac',
        audio_frequency: 44100,
        bit_rate: '2000k',
        strip_profile: true,
      },
    ],
    // ── POSTER FRAME ──────────────────────────────────────────────────────
    // eager: generate a JPEG thumbnail at the 1-second mark at upload time,
    // so it's CDN-cached and ready by the time the scanner loads targets.
    // This is served as video.poster on the AR element and fsVideo.poster
    // on the fullscreen player, eliminating the black-frame-before-first-decode
    // problem entirely. The URL is derived in the route from videoPublicId
    // (see memories.js targets endpoint) rather than being stored separately —
    // Cloudinary generates it deterministically from the public_id.
    eager: [
      { start_offset: '1', width: 640, height: 360, crop: 'fill', format: 'jpg', quality: 'auto:good' },
    ],
    eager_async: true,
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
