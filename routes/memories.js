const express  = require('express');
const multer   = require('multer');
const router   = express.Router();

const Memory   = require('../models/Memory');
const MergeState = require('../models/MergeState');
const { validateUpload, validatePosition } = require('../middleware/validate');
const { uploadPhoto, uploadVideo, deleteFromCloudinary } = require('../utils/cloudinaryUpload');
const { successResponse, errorResponse } = require('../utils/responseHelper');
const { validatePhoto, validateVideo } = require('../services/validationService');
const { analyzeImage } = require('../services/imageAnalysisService');
const { evaluateQuality } = require('../services/qualityService');
const { deleteTrackingFile, rebuildMergedMind, generateTrackingData } = require('../services/trackingService');
const { cloudinary } = require('../config/cloudinary');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ── Cache ─────────────────────────────────────────────────────────────────────
let targetsCache = { data: null, cachedAt: 0 };
const CACHE_TTL_MS = 30_000;
function invalidateTargetsCache() { targetsCache = { data: null, cachedAt: 0 }; }

// ── Upload .mind buffer to Cloudinary as raw ──────────────────────────────────
async function uploadMindFile(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { public_id: publicId, resource_type: 'raw', overwrite: true },
      (err, result) => {
        if (err) return reject(err);
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

// ── POST /api/memories/upload ─────────────────────────────────────────────────
// Now accepts an optional `mindFile` field — the compiled .mind binary produced
// by MindAR's Compiler running in the browser. If present, we skip server-side
// Puppeteer compile entirely, upload the .mind directly to Cloudinary, and mark
// tracking as ready immediately. The merged .mind is rebuilt synchronously
// before the response so the scanner sees this target on the very next load.
router.post(
  '/upload',
  upload.fields([
    { name: 'photo',    maxCount: 1 },
    { name: 'video',    maxCount: 1 },
    { name: 'mindFile', maxCount: 1 }, // compiled .mind binary from browser
  ]),
  validateUpload,
  async (req, res, next) => {
    const startTime = Date.now();
    console.log(`[Upload] Starting — title: "${req.body.title}"`);

    let photoResult = null;
    let videoResult = null;

    try {
      const photoFile    = req.files?.photo?.[0];
      const videoFile    = req.files?.video?.[0];
      const mindFileData = req.files?.mindFile?.[0];

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

      // Step 3 — upload photo + video to Cloudinary in parallel
      console.log('[Upload] Uploading to Cloudinary…');
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

      // Step 5 — handle .mind file
      if (mindFileData && mindFileData.buffer && mindFileData.buffer.length > 0) {
        // Frontend compiled the .mind — upload it directly and rebuild merged
        console.log(`[Upload] .mind file received from client (${mindFileData.buffer.length} bytes) — uploading…`);
        try {
          const { url, publicId: mindPublicId } = await uploadMindFile(
            mindFileData.buffer,
            `memoria/tracking/${memory._id}`
          );
          await Memory.findByIdAndUpdate(memory._id, {
            'tracking.status':       'ready',
            'tracking.mindFileUrl':  url,
            'tracking.mindPublicId': mindPublicId,
            'tracking.generatedAt':  new Date(),
            updatedAt: new Date(),
          });
          console.log(`[Upload] .mind uploaded → ${url}`);

          // NOTE: merged .mind rebuild no longer happens server-side here.
          // Chromium on this Render instance doesn't have enough memory to
          // reliably run the compile (causes "Promise was collected" crashes).
          // The frontend now compiles the merged file in-browser right after
          // this upload finishes, then POSTs it to /api/memories/merged-mind.
          invalidateTargetsCache();
          console.log(`[Upload] Individual .mind ready — total time ${Date.now() - startTime}ms`);

          const updated = await Memory.findById(memory._id).lean();
          return res.status(201).json({ success: true, data: updated, message: 'Memory created successfully' });
        } catch (mindErr) {
          // .mind upload failed — still return success for the memory itself,
          // but mark tracking failed so the dashboard shows the right badge.
          console.error(`[Upload] .mind upload failed: ${mindErr.message}`);
          await Memory.findByIdAndUpdate(memory._id, {
            'tracking.status': 'failed',
            'tracking.errorMessage': mindErr.message,
          }).catch(() => {});
          return res.status(201).json({ success: true, data: memory.toJSON(), message: 'Memory created — tracking upload failed, please retry.' });
        }
      } else {
        // No .mind file sent from client — kick off server-side Puppeteer
        // compile in the background. We respond to the client immediately;
        // generateTrackingData updates the Memory doc (generating → ready
        // or failed) once it finishes, independent of this request.
        console.log('[Upload] No .mind file received — starting server-side compile in background');
        generateTrackingData(String(memory._id), memory.photoUrl, Memory)
          .then(() => invalidateTargetsCache())
          .catch(err => console.error(`[Upload] Background compile error for ${memory._id}: ${err.message}`));
        return res.status(201).json({ success: true, data: memory.toJSON(), message: 'Memory created successfully' });
      }

    } catch (err) {
      if (photoResult?.public_id) await deleteFromCloudinary(photoResult.public_id, 'image').catch(() => {});
      if (videoResult?.public_id) await deleteFromCloudinary(videoResult.public_id, 'video').catch(() => {});
      next(err);
    }
  }
);

// Minimum time between merge rebuilds — keeps a busy upload period from
// triggering a full recompile after every single photo. New uploads stay
// instantly scannable on their own (individual .mind, already fast);
// they just wait up to this long to be folded into the merged Final file.
const MIN_REBUILD_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
// If a claimed build doesn't finish within this window, treat the lock as
// stale (crashed tab, closed browser, etc.) and let another client retry.
const BUILD_LOCK_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

// ── GET /api/memories/merge-status ──────────────────────────────────────────
// Tells the caller whether a merge rebuild is actually needed right now,
// using time + included-IDs comparison instead of rebuilding on every
// page load. Returns shouldRebuild + photos to compile if true.
router.get('/merge-status', async (req, res, next) => {
  try {
    const readyMemories = await Memory.find({
      status: 'active',
      'tracking.status': 'ready',
      'tracking.mindFileUrl': { $exists: true, $ne: null },
    })
      .sort({ createdAt: 1 })
      .select('_id photoUrl')
      .lean();

    const readyIds = readyMemories.map(m => String(m._id));

    let state = await MergeState.findById('merge_state');
    if (!state) state = await MergeState.create({ _id: 'merge_state' });

    // Stale lock recovery — if a previous build claim never finished
    if (state.building && state.buildStartedAt &&
        (Date.now() - state.buildStartedAt.getTime() > BUILD_LOCK_TIMEOUT_MS)) {
      state.building = false;
      state.buildStartedAt = null;
      await state.save();
    }

    if (state.building) {
      return res.status(200).json({ success: true, data: { shouldRebuild: false, reason: 'build_in_progress' } });
    }

    const idsChanged = readyIds.length !== state.includedIds.length ||
      readyIds.some(id => !state.includedIds.includes(id));

    const timeSinceLastBuild = state.lastBuiltAt ? Date.now() - state.lastBuiltAt.getTime() : Infinity;
    const enoughTimePassed = timeSinceLastBuild >= MIN_REBUILD_INTERVAL_MS;

    // Always allow the very first build (no lastBuiltAt yet) regardless of timer
    const shouldRebuild = readyMemories.length > 0 && idsChanged && (enoughTimePassed || !state.lastBuiltAt);

    return res.status(200).json({
      success: true,
      data: {
        shouldRebuild,
        photos: shouldRebuild ? readyMemories.map(m => ({ id: String(m._id), photoUrl: m.photoUrl })) : [],
        mergedMindUrl: state.mergedMindUrl,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/memories/merge-claim ──────────────────────────────────────────
// A client calls this right before starting a rebuild, to claim the lock
// so two browser tabs don't both compile at once. Returns claimed: true/false.
router.post('/merge-claim', async (req, res, next) => {
  try {
    const state = await MergeState.findOneAndUpdate(
      { _id: 'merge_state', building: { $ne: true } },
      { building: true, buildStartedAt: new Date() },
      { new: true, upsert: false }
    );
    return res.status(200).json({ success: true, data: { claimed: !!state } });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/memories/merged-mind ──────────────────────────────────────────
// Accepts a .mind file the BROWSER already compiled and stores it on
// Cloudinary, then updates MergeState (releases the build lock, records
// which memory IDs are now included in Final, timestamps the build).
// No Chromium involved — replaces the old server-side rebuildMergedMind()
// Puppeteer path, which crashed under memory pressure on this instance.
router.post(
  '/merged-mind',
  upload.fields([{ name: 'mindFile', maxCount: 1 }]),
  async (req, res, next) => {
    try {
      const mindFileData = req.files?.mindFile?.[0];
      if (!mindFileData || !mindFileData.buffer?.length) {
        return errorResponse(res, 'mindFile is required', 400);
      }
      let includedIds = [];
      try { includedIds = JSON.parse(req.body.includedIds || '[]'); } catch (_) {}

      console.log(`[Merge] Received client-compiled merged .mind (${mindFileData.buffer.length} bytes, ${includedIds.length} targets) — uploading…`);
      const { url } = await uploadMindFile(mindFileData.buffer, 'memoria/tracking/merged');

      await MergeState.findByIdAndUpdate(
        'merge_state',
        {
          lastBuiltAt:   new Date(),
          includedIds,
          mergedMindUrl: url,
          building:      false,
          buildStartedAt: null,
        },
        { upsert: true }
      );

      invalidateTargetsCache();
      console.log(`[Merge] Merged .mind uploaded → ${url}`);
      return res.status(200).json({ success: true, data: { mergedMindUrl: url } });
    } catch (err) {
      // Release the lock on failure too, so a crashed compile doesn't block forever
      await MergeState.findByIdAndUpdate('merge_state', { building: false, buildStartedAt: null }).catch(() => {});
      next(err);
    }
  }
);

// ── GET /api/memories/photos-for-merge ──────────────────────────────────────
// Kept for backward compatibility / manual triggers. Prefer /merge-status,
// which includes the timing logic above.
router.get('/photos-for-merge', async (req, res, next) => {
  try {
    const memories = await Memory.find({
      status: 'active',
      'tracking.status': 'ready',
      'tracking.mindFileUrl': { $exists: true, $ne: null },
    })
      .sort({ createdAt: 1 })
      .select('_id photoUrl')
      .lean();

    return res.status(200).json({
      success: true,
      data: memories.map(m => ({ id: String(m._id), photoUrl: m.photoUrl })),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/memories/targets ─────────────────────────────────────────────────
router.get('/targets', async (req, res, next) => {
  try {
    const now = Date.now();
    if (targetsCache.data && now - targetsCache.cachedAt < CACHE_TTL_MS) {
      return res.status(200).json(targetsCache.data);
    }

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
      data: { totalTargets: targets.length, mergedMindUrl, targets },
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
    const memories = await Memory.find()
      .sort({ createdAt: -1 })
      .select('title description photoUrl videoUrl photoWidth photoHeight videoWidth videoHeight processingStatus quality tracking scanCount createdAt videoRect detectedBorder')
      .lean();
    return successResponse(res, memories, 'Memories retrieved');
  } catch (err) { next(err); }
});

// ── POST /api/memories/:id/retry-tracking ──────────────────────────────────────
// Re-runs the server-side .mind compile for one memory. Useful for manually
// forcing a retry — though generateTrackingData now retries automatically on
// its own, so this is mainly for memories that exhausted all auto-retries.
router.post('/:id/retry-tracking', async (req, res, next) => {
  try {
    const memory = await Memory.findById(req.params.id);
    if (!memory) return errorResponse(res, 'Memory not found', 404);
    if (memory.tracking?.status === 'generating') {
      return errorResponse(res, 'A compile is already in progress for this memory', 409);
    }

    console.log(`[Upload] Retry tracking requested for ${memory._id}`);
    generateTrackingData(String(memory._id), memory.photoUrl, Memory)
      .then(() => invalidateTargetsCache())
      .catch(err => console.error(`[Upload] Retry compile error for ${memory._id}: ${err.message}`));

    return res.status(202).json({ success: true, message: 'Tracking compile started' });
  } catch (err) { next(err); }
});

// ── PUT /api/memories/:id/media ─────────────────────────────────────────────────
// Replace the photo and/or video for an existing memory. If a new photo is
// uploaded, the old .mind tracking data is stale (it was compiled from the
// old photo), so we automatically kick off a fresh compile in the background
// — same self-healing retry logic as a brand new upload. Replacing only the
// video does NOT require a recompile, since the .mind file is derived purely
// from the photo, not the video.
router.put(
  '/:id/media',
  upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'video', maxCount: 1 },
  ]),
  async (req, res, next) => {
    let newPhotoResult = null;
    let newVideoResult = null;

    try {
      const memory = await Memory.findById(req.params.id);
      if (!memory) return errorResponse(res, 'Memory not found', 404);

      const photoFile = req.files?.photo?.[0];
      const videoFile = req.files?.video?.[0];

      if (!photoFile && !videoFile) {
        return errorResponse(res, 'Provide a new photo and/or video to update', 400);
      }

      let photoChanged = false;
      const oldPhotoPublicId = memory.photoPublicId;
      const oldVideoPublicId = memory.videoPublicId;
      const oldMindPublicId  = memory.tracking?.mindPublicId;

      // Validate + upload whichever files were provided
      if (photoFile) {
        const photoCheck = await validatePhoto(photoFile.buffer, photoFile);
        if (photoCheck.errors.length > 0) {
          return errorResponse(res, 'Upload rejected', 400, photoCheck.errors);
        }
        const metrics = await analyzeImage(photoFile.buffer);
        const quality = evaluateQuality(metrics, { width: metrics.originalWidth, height: metrics.originalHeight });
        if (!quality.passed) {
          return errorResponse(res, 'Photo quality is too low for reliable AR tracking', 422, quality.reasons);
        }

        newPhotoResult = await uploadPhoto(photoFile.buffer);
        memory.photoUrl      = newPhotoResult.secure_url;
        memory.photoPublicId = newPhotoResult.public_id;
        memory.photoWidth    = newPhotoResult.width  || null;
        memory.photoHeight   = newPhotoResult.height || null;
        memory.quality = {
          passed: quality.passed, rating: quality.rating, label: quality.label,
          reasons: quality.reasons, warnings: quality.warnings,
          sharpness: quality.metrics.sharpness, brightness: quality.metrics.brightness,
          contrast: quality.metrics.contrast, analyzedAt: new Date(),
        };
        photoChanged = true;
      }

      if (videoFile) {
        const videoCheck = validateVideo(videoFile);
        if (videoCheck.errors.length > 0) {
          return errorResponse(res, 'Upload rejected', 400, videoCheck.errors);
        }
        newVideoResult = await uploadVideo(videoFile.buffer);
        memory.videoUrl      = newVideoResult.secure_url;
        memory.videoPublicId = newVideoResult.public_id;
        memory.videoWidth    = newVideoResult.width    || memory.videoWidth;
        memory.videoHeight   = newVideoResult.height   || memory.videoHeight;
        memory.videoDuration = newVideoResult.duration || memory.videoDuration;
        memory.videoSize     = videoFile.size;
      }

      if (photoChanged) {
        // Old .mind data is now stale — reset tracking so the dashboard
        // shows "compiling…" rather than a misleadingly stale "ready" badge.
        memory.tracking = { status: 'not_generated' };
      }

      await memory.save();
      invalidateTargetsCache();

      // Delete the old Cloudinary assets now that the new ones are saved
      if (photoFile && oldPhotoPublicId) await deleteFromCloudinary(oldPhotoPublicId, 'image').catch(() => {});
      if (videoFile && oldVideoPublicId) await deleteFromCloudinary(oldVideoPublicId, 'video').catch(() => {});

      if (photoChanged) {
        if (oldMindPublicId) await deleteTrackingFile(oldMindPublicId, Memory).catch(() => {});
        console.log(`[Upload] Photo replaced for ${memory._id} — starting recompile in background`);
        generateTrackingData(String(memory._id), memory.photoUrl, Memory)
          .then(() => invalidateTargetsCache())
          .catch(err => console.error(`[Upload] Recompile error for ${memory._id}: ${err.message}`));
      }

      return res.status(200).json({
        success: true,
        data: memory.toJSON(),
        message: photoChanged
          ? 'Media updated — AR tracking is recompiling in the background'
          : 'Media updated successfully',
      });

    } catch (err) {
      if (newPhotoResult?.public_id) await deleteFromCloudinary(newPhotoResult.public_id, 'image').catch(() => {});
      if (newVideoResult?.public_id) await deleteFromCloudinary(newVideoResult.public_id, 'video').catch(() => {});
      next(err);
    }
  }
);

// ── DELETE /api/memories/:id ──────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const memory = await Memory.findById(req.params.id);
    if (!memory) return errorResponse(res, 'Memory not found', 404);

    await Promise.all([
      deleteFromCloudinary(memory.photoPublicId, 'image'),
      deleteFromCloudinary(memory.videoPublicId, 'video'),
      deleteTrackingFile(memory.tracking?.mindPublicId, Memory),
    ]);

    await Memory.deleteOne({ _id: memory._id });
    invalidateTargetsCache();
    return successResponse(res, null, 'Memory deleted successfully');
  } catch (err) { next(err); }
});

module.exports = router;
