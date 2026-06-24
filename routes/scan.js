const express = require('express');
const router  = express.Router();

const Memory  = require('../models/Memory');
const ScanLog = require('../models/ScanLog');
const { validateScanLog }                = require('../middleware/validate');
const { successResponse, errorResponse } = require('../utils/responseHelper');

// ── POST /api/scan/log ────────────────────────────────────────────────────────
router.post('/log', validateScanLog, async (req, res, next) => {
  try {
    const { memoryId, sessionId, deviceType, userAgent } = req.body;

    const memory = await Memory.findById(memoryId);
    if (!memory) {
      return errorResponse(res, 'Memory not found', 404);
    }

    const log = new ScanLog({
      memoryId,
      sessionId:  sessionId  || null,
      deviceType: deviceType || null,
      userAgent:  userAgent  || req.headers['user-agent'] || null,
    });

    // Increment counters and persist log + memory in parallel
    memory.scanCount    = (memory.scanCount || 0) + 1;
    memory.lastScannedAt = new Date();

    await Promise.all([log.save(), memory.save()]);

    return successResponse(res, { logged: true, totalScans: memory.scanCount }, 'Scan logged');
  } catch (err) {
    next(err);
  }
});

// ── GET /api/scan/stats ───────────────────────────────────────────────────────
router.get('/stats', async (req, res, next) => {
  try {
    const now   = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const week  = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000); // last 7 days

    // ── Aggregation: scans per memory over the last 7 days ──────────────────
    const perMemory = await ScanLog.aggregate([
      { $match: { detectedAt: { $gte: week } } },
      {
        $group: {
          _id:   '$memoryId',
          scans: { $sum: 1 },
          lastScan: { $max: '$detectedAt' },
        },
      },
      {
        $lookup: {
          from:         'memories',
          localField:   '_id',
          foreignField: '_id',
          as:           'memory',
        },
      },
      { $unwind: { path: '$memory', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id:      0,
          memoryId: '$_id',
          title:    '$memory.title',
          scans:    1,
          lastScan: 1,
        },
      },
      { $sort: { scans: -1 } },
    ]);

    // ── Total counts ─────────────────────────────────────────────────────────
    const [todayCount, weekCount, allTimeCount] = await Promise.all([
      ScanLog.countDocuments({ detectedAt: { $gte: today } }),
      ScanLog.countDocuments({ detectedAt: { $gte: week  } }),
      ScanLog.countDocuments(),
    ]);

    return successResponse(res, {
      totals: {
        today:   todayCount,
        week:    weekCount,
        allTime: allTimeCount,
      },
      perMemory,
    }, 'Scan stats retrieved');

  } catch (err) {
    next(err);
  }
});

module.exports = router;
