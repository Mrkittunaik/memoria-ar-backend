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

// Multer — memory storage, 500 MB hard cap
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// In-memory targets cache (30s TTL)
let targetsCache = { data: null, cachedAt: 0 };
const CACHE_TTL_MS = 30_000;
function invalidateTargetsCache() { targetsCache = { data: null, cachedAt: 0 }; }

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
    console.log(`[Upload] Starting — title: "${req.body.title}"`);

    let photoResult = null;
    let videoResult = null;

    try {
      const photoFile = req.files?.photo?.[0];
      const videoFile = req.files?.video?.[0];

      if (!photoFile && !videoFile) return errorResponse(res, 'Both a photo and a video file are required', 400);
      if (!photoFile) return errorResponse(res, 'A photo file is required', 400);
      if (!videoFile) return errorResponse(res, 'A video file is required', 400);

      // ── Step 1: cheap, fail-fast format/size/dimension checks ──────────
      // Runs before any Cloudinary upload — a malformed file never leaves
      // this process.
      const [photoCheck, videoCheck] = await Promise.all([
        validatePhoto(photoFile.buffer, photoFile),
        Promise.resolve(validateVideo(videoFile)),
      ]);

      const intakeErrors = [...photoCheck.errors, ...videoCheck.errors];
      if (intakeErrors.length > 0) {
        console.log(`[Upload] Rejected at intake — ${intakeErrors.join('; ')}`);
        return errorResponse(res, 'Upload rejected', 400, intakeErrors);
      }

      // ── Step 2: real image-quality analysis (blur / brightness / contrast) ─
      // Still pre-Cloudinary — a photo that fails quality never gets uploaded.
      console.log('[Upload] Analyzing image quality…');
      const metrics = await analyzeImage(photoFile.buffer);
      const quality = evaluateQuality(metrics, {
        width: metrics.originalWidth,
        height: metrics.originalHeight,
      });
      console.log(`[Upload] Quality: ${quality.label} (${quality.rating}★) — sharpness=${metrics.sharpness.toFixed(1)} brightness=${metrics.brightness.toFixed(1)} contrast=${metrics.contrast.toFixed(1)} [${metrics.elapsedMs}ms]`);

      if (!quality.passed) {
        console.log(`[Upload] Rejected — quality check failed: ${quality.reasons.join('; ')}`);
        return errorResponse(res, 'Photo quality is too low for reliable AR tracking', 422, quality.reasons);
      }

      console.log(`[Upload] Uploading — photo: ${(photoFile.size/1024).toFixed(0)}KB, video: ${(videoFile.size/1024/1024).toFixed(1)}MB`);
      [photoResult, videoResult] = await Promise.all([
        uploadPhoto(photoFile.buffer),
        uploadVideo(videoFile.buffer),
      ]);
      console.log(`[Upload] Cloudinary done — photo: ${photoResult.secure_url}`);

      // Parse videoRect (from smart crop editor)
      let videoRect;
      if (req.body.videoRect) {
        try { videoRect = JSON.parse(req.body.videoRect); } catch (_) { videoRect = undefined; }
      }

      // Parse detectedBorder if sent from client
      let detectedBorder = null;
      if (req.body.detectedBorder) {
        try { detectedBorder = JSON.parse(req.body.detectedBorder); } catch (_) {}
      }

      // Parse video dimensions if sent from client
      const videoWidth  = req.body.videoWidth  ? parseInt(req.body.videoWidth,  10) : null;
      const videoHeight = req.body.videoHeight ? parseInt(req.body.videoHeight, 10) : null;

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
        ...(videoRect ? { videoRect } : {}),
        ...(detectedBorder ? { detectedBorder } : {}),
        status:            'active',
        processingStatus:  'ready',
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
      });

      await memory.save();
      invalidateTargetsCache();

      const elapsed = Date.now() - startTime;
      console.log(`[Upload] Complete in ${elapsed}ms — id: ${memory._id}`);
      return successResponse(res, memory.toJSON(), 'Memory created successfully', 201);

    } catch (err) {
      if (photoResult?.public_id) await deleteFromCloudinary(photoResult.public_id, 'image').catch(() => {});
      if (videoResult?.public_id) await deleteFromCloudinary(videoResult.public_id, 'video').catch(() => {});
      next(err);
    }
  }
);

// ── GET /api/memories/targets ────────────────────────────────────────────────
router.get('/targets', async (req, res, next) => {
  try {
    const now = Date.now();
    if (targetsCache.data && now - targetsCache.cachedAt < CACHE_TTL_MS) {
      return res.status(200).json(targetsCache.data);
    }
    const memories = await Memory.find({ status: 'active' })
      .sort({ createdAt: 1 })
      .select('title photoUrl videoUrl videoPublicId photoWidth photoHeight videoWidth videoHeight videoRect detectedBorder')
      .lean();

    const targets = memories.map((m) => {
      // Derive poster thumbnail URL from Cloudinary videoPublicId on the fly —
      // no extra DB field needed. The eager transform uploaded at video
      // creation time generates this exact URL deterministically.
      // Format: .../upload/so_1,w_640,h_360,c_fill,f_jpg,q_auto:good/<publicId>.jpg
      // If videoPublicId is missing (legacy entries), posterUrl is null and
      // the frontend falls back gracefully to no-poster behaviour.
      let posterUrl = null;
      if (m.videoPublicId) {
        const cloudName = m.videoUrl.match(/res\.cloudinary\.com\/([^/]+)\//)?.[1];
        if (cloudName) {
          posterUrl = `https://res.cloudinary.com/${cloudName}/video/upload/so_1,w_640,h_360,c_fill,f_jpg,q_auto:good/${m.videoPublicId}.jpg`;
        }
      }

      return {
        id:             m._id,
        title:          m.title,
        photoUrl:       m.photoUrl,
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

    const responseBody = { success: true, data: { totalTargets: targets.length, targets } };
    targetsCache = { data: responseBody, cachedAt: now };
    return res.status(200).json(responseBody);
  } catch (err) { next(err); }
});

// ── PATCH /api/memories/:id/position ────────────────────────────────────────
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

// ── GET /api/memories ────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const memories = await Memory.find().sort({ createdAt: -1 }).lean();
    return successResponse(res, memories, 'Memories retrieved');
  } catch (err) { next(err); }
});

// ── GET /api/memories/:id ────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const memory = await Memory.findById(req.params.id).lean();
    if (!memory) return errorResponse(res, 'Memory not found', 404);
    return successResponse(res, memory, 'Memory retrieved');
  } catch (err) { next(err); }
});

// ── DELETE /api/memories/:id ─────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const memory = await Memory.findById(req.params.id);
    if (!memory) return errorResponse(res, 'Memory not found', 404);
    await Promise.all([
      deleteFromCloudinary(memory.photoPublicId, 'image'),
      deleteFromCloudinary(memory.videoPublicId, 'video'),
    ]);
    await Memory.deleteOne({ _id: memory._id });
    invalidateTargetsCache();
    return successResponse(res, null, 'Memory deleted successfully');
  } catch (err) { next(err); }
});

module.exports = router;
