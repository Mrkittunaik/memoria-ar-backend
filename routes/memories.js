const express  = require('express');
const multer   = require('multer');
const router   = express.Router();

const Memory   = require('../models/Memory');
const { validateUpload, validatePosition } = require('../middleware/validate');
const { uploadPhoto, uploadVideo, deleteFromCloudinary } = require('../utils/cloudinaryUpload');
const { successResponse, errorResponse } = require('../utils/responseHelper');

// ── Multer — memory storage (buffers sent to Cloudinary, never touch disk) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB hard cap (video upper bound)
  },
});

// ── In-memory targets cache (30-second TTL) ──────────────────────────────────
let targetsCache = { data: null, cachedAt: 0 };
const CACHE_TTL_MS = 30_000;

function invalidateTargetsCache() {
  targetsCache = { data: null, cachedAt: 0 };
}

// ── POST /api/memories/upload ────────────────────────────────────────────────
router.post(
  '/upload',
  upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'video', maxCount: 1 },
  ]),
  validateUpload,
  async (req, res, next) => {
    const startTime = Date.now();
    console.log(`[Upload] Starting upload — title: "${req.body.title}"`);

    let photoResult = null;
    let videoResult = null;

    try {
      const photoFile = req.files?.photo?.[0];
      const videoFile = req.files?.video?.[0];

      // ── Validate both files exist ────────────────────────────────────────
      if (!photoFile && !videoFile) {
        return errorResponse(res, 'Both a photo and a video file are required', 400);
      }
      if (!photoFile) {
        return errorResponse(res, 'A photo file is required', 400);
      }
      if (!videoFile) {
        return errorResponse(res, 'A video file is required', 400);
      }

      // ── Validate photo file size (separate limit: 20 MB) ─────────────────
      const PHOTO_MAX = 20 * 1024 * 1024;
      if (photoFile.size > PHOTO_MAX) {
        return errorResponse(res, 'Photo must be under 20 MB', 413);
      }

      // ── Validate MIME types ──────────────────────────────────────────────
      if (!photoFile.mimetype.startsWith('image/')) {
        return errorResponse(res, 'Photo file must be an image (JPEG, PNG, WebP, etc.)', 400);
      }
      if (!videoFile.mimetype.startsWith('video/')) {
        return errorResponse(res, 'Video file must be a video (MP4, MOV, WebM, etc.)', 400);
      }

      // ── Upload photo + video to Cloudinary in parallel ───────────────────
      console.log(`[Upload] Starting parallel upload — photo: ${(photoFile.size/1024).toFixed(0)} KB, video: ${(videoFile.size/1024/1024).toFixed(1)} MB`);
      [photoResult, videoResult] = await Promise.all([
        uploadPhoto(photoFile.buffer),
        uploadVideo(videoFile.buffer),
      ]);
      console.log(`[Upload] Both uploaded — photo: ${photoResult.secure_url}, video: ${videoResult.secure_url}`);

      // ── Parse optional videoRect (position editor on upload screen) ─────
      // Falls back to schema defaults (centered 9:16) if not provided.
      let videoRect;
      if (req.body.videoRect) {
        try { videoRect = JSON.parse(req.body.videoRect); } catch (_) { videoRect = undefined; }
      }

      // ── Persist to MongoDB ───────────────────────────────────────────────
      const memory = new Memory({
        title:         req.body.title.trim(),
        description:   req.body.description?.trim() || null,
        photoUrl:      photoResult.secure_url,
        photoPublicId: photoResult.public_id,
        videoUrl:      videoResult.secure_url,
        videoPublicId: videoResult.public_id,
        photoWidth:    photoResult.width  || null,
        photoHeight:   photoResult.height || null,
        videoDuration: videoResult.duration || null,
        videoSize:     videoFile.size,
        ...(videoRect ? { videoRect } : {}),
        status:        'active',
      });

      await memory.save();

      // Bust the targets cache so the scanner picks up this new memory immediately
      invalidateTargetsCache();

      const elapsed = Date.now() - startTime;
      console.log(`[Upload] Complete in ${elapsed}ms — id: ${memory._id}`);

      return successResponse(res, memory.toJSON(), 'Memory created successfully', 201);

    } catch (err) {
      // Clean up any Cloudinary assets that were already uploaded to avoid orphans
      if (photoResult?.public_id) {
        await deleteFromCloudinary(photoResult.public_id, 'image');
      }
      if (videoResult?.public_id) {
        await deleteFromCloudinary(videoResult.public_id, 'video');
      }
      next(err);
    }
  }
);

// ── GET /api/memories/targets — scanner calls this on startup ────────────────
router.get('/targets', async (req, res, next) => {
  try {
    const now = Date.now();

    // Return cached result if still fresh
    if (targetsCache.data && now - targetsCache.cachedAt < CACHE_TTL_MS) {
      return res.status(200).json(targetsCache.data);
    }

    const memories = await Memory.find({ status: 'active' })
      .sort({ createdAt: 1 })
      .select('title photoUrl videoUrl photoWidth photoHeight videoRect')
      .lean();

    const targets = memories.map((m) => ({
      id:          m._id,
      title:       m.title,
      photoUrl:    m.photoUrl,
      videoUrl:    m.videoUrl,
      photoWidth:  m.photoWidth,
      photoHeight: m.photoHeight,
      videoRect:   m.videoRect,
    }));

    const responseBody = {
      success: true,
      data: {
        totalTargets: targets.length,
        targets,
      },
    };

    // Cache the result
    targetsCache = { data: responseBody, cachedAt: now };

    return res.status(200).json(responseBody);

  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/memories/:id/position — fast metadata-only save ──────────────
// Updates ONLY the video overlay position/ratio on an existing memory.
// No file re-upload, no Cloudinary round-trip — just a DB write, so this
// is near-instant even on a slow connection.
router.patch('/:id/position', validatePosition, async (req, res, next) => {
  try {
    const memory = await Memory.findById(req.params.id);
    if (!memory) {
      return errorResponse(res, 'Memory not found', 404);
    }

    memory.videoRect = req.body.videoRect;
    await memory.save();

    invalidateTargetsCache();

    return successResponse(res, memory.toJSON(), 'Position updated');
  } catch (err) {
    next(err);
  }
});

// ── GET /api/memories — all memories, newest first ───────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const memories = await Memory.find()
      .sort({ createdAt: -1 })
      .lean();

    return successResponse(res, memories, 'Memories retrieved');
  } catch (err) {
    next(err);
  }
});

// ── GET /api/memories/:id — single memory ────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const memory = await Memory.findById(req.params.id).lean();
    if (!memory) {
      return errorResponse(res, 'Memory not found', 404);
    }
    return successResponse(res, memory, 'Memory retrieved');
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/memories/:id ─────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const memory = await Memory.findById(req.params.id);
    if (!memory) {
      return errorResponse(res, 'Memory not found', 404);
    }

    // Delete media from Cloudinary in parallel
    await Promise.all([
      deleteFromCloudinary(memory.photoPublicId, 'image'),
      deleteFromCloudinary(memory.videoPublicId, 'video'),
    ]);

    await Memory.deleteOne({ _id: memory._id });
    invalidateTargetsCache();

    return successResponse(res, null, 'Memory deleted successfully');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
