const express  = require('express');
const multer   = require('multer');
const router   = express.Router();

const Memory   = require('../models/Memory');
const { validateUpload, validatePosition } = require('../middleware/validate');
const { uploadPhoto, uploadVideo, deleteFromCloudinary } = require('../utils/cloudinaryUpload');
const { successResponse, errorResponse } = require('../utils/responseHelper');
const { validatePhoto, validateVideo } = require('../services/validationService');
const { analyzeImage } = require('../services/imageAnalysisService');
const { evaluateQuality } = require('../services/qualityService');
const { generateTrackingData, deleteTrackingFile } = require('../services/trackingService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ── Cache ─────────────────────────────────────────────────────────────────────
// Single short-lived cache entry for the targets manifest.
// Busted immediately whenever a memory is created, updated, or deleted,
// and when the merged .mind rebuild completes.
let targetsCache = { data: null, cachedAt: 0 };
const CACHE_TTL_MS = 30_000;
function invalidateTargetsCache() { targetsCache = { data: null, cachedAt: 0 }; }

// ── POST /api/memories/upload ─────────────────────────────────────────────────
router.post(
  '/upload',
  upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'video', maxCount: 1 },
  ]),
  validateUpload,
  async (req, res, next) => {
    const startTime = Date.now();
    console.log(`[Upload] Starting — title: "${req.body.title}"`);

    let photoResult = null;
    let videoResult = null;

    try {
      const photoFile = req.files?.photo?.[0];
      const videoFile = req.files?.video?.[0];

      if (!photoFile && !videoFile) return errorResponse(res, 'Both a photo and a video file are required', 400);
      if (!photoFile) return errorResponse(res, 'A photo file is required', 400);
      if (!videoFile) return errorResponse(res, 'A video file is required', 400);

      // Step 1 — format / size / dimension checks
      const [photoCheck, videoCheck] = await Promise.all([
        validatePhoto(photoFile.buffer, photoFile),
        Promise.resolve(validateVideo(videoFile)),
      ]);
      const intakeErrors = [...photoCheck.errors, ...videoCheck.errors];
      if (intakeErrors.length > 0) {
        console.log(`[Upload] Rejected at intake — ${intakeErrors.join('; ')}`);
        return errorResponse(res, 'Upload rejected', 400, intakeErrors);
      }

      // Step 2 — blur / brightness / contrast analysis
      console.log('[Upload] Analyzing image quality…');
      const metrics = await analyzeImage(photoFile.buffer);
      const quality = evaluateQuality(metrics, {
        width: metrics.originalWidth,
        height: metrics.originalHeight,
      });
      console.log(`[Upload] Quality: ${quality.label} (${quality.rating}★) [${metrics.elapsedMs}ms]`);
      if (!quality.passed) {
        console.log(`[Upload] Rejected — ${quality.reasons.join('; ')}`);
        return errorResponse(res, 'Photo quality is too low for reliable AR tracking', 422, quality.reasons);
      }

      // Step 3 — upload photo + video to Cloudinary
      console.log(`[Upload] Uploading to Cloudinary…`);
      [photoResult, videoResult] = await Promise.all([
        uploadPhoto(photoFile.buffer),
        uploadVideo(videoFile.buffer),
      ]);

      // Parse optional client fields
      let videoRect;
      if (req.body.videoRect) {
        try { videoRect = JSON.parse(req.body.videoRect); } catch (_) {}
      }
      let detectedBorder = null;
      if (req.body.detectedBorder) {
        try { detectedBorder = JSON.parse(req.body.detectedBorder); } catch (_) {}
      }
      const videoWidth  = req.body.videoWidth  ? parseInt(req.body.videoWidth,  10) : null;
      const videoHeight = req.body.videoHeight ? parseInt(req.body.videoHeight, 10) : null;

      // Step 4 — save memory record
      const memory = new Memory({
        title:         req.body.title.trim(),
        description:   req.body.description?.trim() || null,
        photoUrl:      photoResult.secure_url,
        photoPublicId: photoResult.public_id,
        videoUrl:      videoResult.secure_url,
        videoPublicId: videoResult.public_id,
        photoWidth:    photoResult.width  || null,
        photoHeight:   photoResult.height || null,
        videoWidth,
        videoHeight,
        videoDuration: videoResult.duration || null,
        videoSize:     videoFile.size,
        ...(videoRect      ? { videoRect }      : {}),
        ...(detectedBorder ? { detectedBorder } : {}),
        status:           'active',
        processingStatus: 'ready',
        quality: {
          passed:     quality.passed,
          rating:     quality.rating,
          label:      quality.label,
          reasons:    quality.reasons,
          warnings:   quality.warnings,
          sharpness:  quality.metrics.sharpness,
          brightness: quality.metrics.brightness,
          contrast:   quality.metrics.contrast,
          analyzedAt: new Date(),
        },
        tracking: { status: 'not_generated' },
      });

      await memory.save();
      invalidateTargetsCache();

      console.log(`[Upload] Saved in ${Date.now() - startTime}ms — id: ${memory._id}`);

      // Step 5 — respond immediately, compile + merge in background
      res.status(201).json({ success: true, data: memory.toJSON(), message: 'Memory created successfully' });

      // Fire-and-forget: compile this image, upload individual .mind,
      // rebuild merged .mind. Cache is busted again once merge completes.
      generateTrackingData(String(memory._id), photoResult.secure_url, Memory)
        .then(() => invalidateTargetsCache())
        .catch(() => {});

    } catch (err) {
      if (photoResult?.public_id) await deleteFromCloudinary(photoResult.public_id, 'image').catch(() => {});
      if (videoResult?.public_id) await deleteFromCloudinary(videoResult.public_id, 'video').catch(() => {});
      next(err);
    }
  }
);

// ── GET /api/memories/targets ─────────────────────────────────────────────────
// Returns a single merged .mind URL that the scanner loads directly.
// One HTTP request regardless of how many memories exist.
// Also returns per-target metadata (videoUrl, videoRect, posterUrl etc.)
// so the scanner knows which video to play when each target index fires.
router.get('/targets', async (req, res, next) => {
  try {
    const now = Date.now();
    if (targetsCache.data && now - targetsCache.cachedAt < CACHE_TTL_MS) {
      return res.status(200).json(targetsCache.data);
    }

    // Only include memories whose individual .mind compile is done.
    // The order MUST match the order they were merged — createdAt ascending,
    // same sort used in rebuildMergedMind. MindAR target index 0 = first
    // memory in this list, index 1 = second, and so on.
    const memories = await Memory.find({
      status: 'active',
      'tracking.status': 'ready',
    })
      .sort({ createdAt: 1 })
      .select('title videoUrl videoPublicId photoWidth photoHeight videoWidth videoHeight videoRect detectedBorder')
      .lean();

    if (memories.length === 0) {
      const body = { success: true, data: { totalTargets: 0, mergedMindUrl: null, targets: [] } };
      return res.status(200).json(body);
    }

    // Derive the merged .mind URL deterministically from the Cloudinary cloud name.
    // We stored it at public_id 'memoria/tracking/merged' with resource_type 'raw'.
    // Cloudinary raw URL pattern: https://res.cloudinary.com/<cloud>/raw/upload/<public_id>
    // We read cloud name from any existing videoUrl to avoid storing it separately.
    const sampleUrl = memories[0].videoUrl;
    const cloudName = sampleUrl.match(/res\.cloudinary\.com\/([^/]+)\//)?.[1];
    const mergedMindUrl = cloudName
      ? `https://res.cloudinary.com/${cloudName}/raw/upload/memoria/tracking/merged`
      : null;

    const targets = memories.map((m) => {
      let posterUrl = null;
      if (m.videoPublicId && cloudName) {
        posterUrl = `https://res.cloudinary.com/${cloudName}/video/upload/so_1,w_640,h_360,c_fill,f_jpg,q_auto:good/${m.videoPublicId}.jpg`;
      }
      return {
        id:             m._id,
        title:          m.title,
        videoUrl:       m.videoUrl,
        posterUrl,
        photoWidth:     m.photoWidth,
        photoHeight:    m.photoHeight,
        videoWidth:     m.videoWidth,
        videoHeight:    m.videoHeight,
        videoRect:      m.videoRect,
        detectedBorder: m.detectedBorder,
      };
    });

    const responseBody = {
      success: true,
      data: {
        totalTargets: targets.length,
        mergedMindUrl,   // scanner passes this directly to MindARThree
        targets,         // per-target metadata for video playback
      },
    };
    targetsCache = { data: responseBody, cachedAt: now };
    return res.status(200).json(responseBody);
  } catch (err) { next(err); }
});

// ── GET /api/memories/:id ─────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const memory = await Memory.findById(req.params.id)
      .select('title description videoUrl videoPublicId videoRect photoWidth photoHeight videoWidth videoHeight detectedBorder status processingStatus quality')
      .lean();
    if (!memory) return errorResponse(res, 'Memory not found', 404);
    const cloudName = memory.videoUrl?.match(/res\.cloudinary\.com\/([^/]+)\//)?.[1];
    const posterUrl = (cloudName && memory.videoPublicId)
      ? `https://res.cloudinary.com/${cloudName}/video/upload/so_1,w_640,h_360,c_fill,f_jpg,q_auto:good/${memory.videoPublicId}.jpg`
      : null;
    return successResponse(res, { ...memory, posterUrl }, 'Memory retrieved');
  } catch (err) { next(err); }
});

// ── PATCH /api/memories/:id/position ─────────────────────────────────────────
router.patch('/:id/position', validatePosition, async (req, res, next) => {
  try {
    const memory = await Memory.findById(req.params.id);
    if (!memory) return errorResponse(res, 'Memory not found', 404);
    memory.videoRect = req.body.videoRect;
    await memory.save();
    invalidateTargetsCache();
    return successResponse(res, memory.toJSON(), 'Position updated');
  } catch (err) { next(err); }
});

// ── GET /api/memories ─────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    // Select only fields the dashboard card grid actually uses.
    // Omitting photoPublicId, videoPublicId, raw buffer fields etc. keeps
    // the list payload small — at 100 memories, returning every field
    // balloons the response ~3× unnecessarily.
    const memories = await Memory.find()
      .sort({ createdAt: -1 })
      .select('title description photoUrl videoUrl photoWidth photoHeight videoWidth videoHeight processingStatus quality tracking scanCount createdAt videoRect detectedBorder')
      .lean();
    return successResponse(res, memories, 'Memories retrieved');
  } catch (err) { next(err); }
});

// ── DELETE /api/memories/:id ──────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const memory = await Memory.findById(req.params.id);
    if (!memory) return errorResponse(res, 'Memory not found', 404);

    await Promise.all([
      deleteFromCloudinary(memory.photoPublicId, 'image'),
      deleteFromCloudinary(memory.videoPublicId, 'video'),
      // Pass Memory so deleteTrackingFile can rebuild the merged .mind
      // after removing this target's individual file
      deleteTrackingFile(memory.tracking?.mindPublicId, Memory),
    ]);

    await Memory.deleteOne({ _id: memory._id });
    invalidateTargetsCache();
    return successResponse(res, null, 'Memory deleted successfully');
  } catch (err) { next(err); }
});

module.exports = router;
