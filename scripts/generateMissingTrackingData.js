/**
 * generateMissingTrackingData.js
 * ──────────────────────────────
 * One-time migration script. Run this after deploying to backfill .mind
 * files for all existing memories that predate this architecture change.
 *
 * Usage:
 *   node scripts/generateMissingTrackingData.js
 *
 * Runs sequentially to avoid hammering Cloudinary. Safe to re-run —
 * already-ready memories are skipped. Rebuilds the merged .mind file
 * once at the end so the scanner immediately sees all backfilled targets.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const connectDB = require('../config/db');
const Memory = require('../models/Memory');
const { generateTrackingData, rebuildMergedMind } = require('../services/trackingService');

async function run() {
  await connectDB();
  await new Promise(resolve => setTimeout(resolve, 1500)); // wait for mongoose

  const memories = await Memory.find({
    status: 'active',
    'tracking.status': { $ne: 'ready' },
    photoUrl: { $exists: true, $ne: null },
  }).select('_id photoUrl title tracking').lean();

  console.log(`[Migration] Found ${memories.length} memories needing tracking data`);

  let successCount = 0;
  for (const m of memories) {
    console.log(`[Migration] Processing: ${m.title} (${m._id})`);
    try {
      // generateTrackingData calls rebuildMergedMind internally after each
      // compile, but during bulk migration we skip that to save time — we
      // do one final rebuild at the end instead.
      await generateTrackingData(String(m._id), m.photoUrl, Memory);
      successCount++;
      console.log(`[Migration] Done: ${m._id} (${successCount}/${memories.length})`);
    } catch (err) {
      console.error(`[Migration] Failed: ${m._id} — ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Final rebuild of the merged .mind with everything that succeeded
  console.log('[Migration] Rebuilding merged .mind file…');
  await rebuildMergedMind(Memory);
  console.log('[Migration] Complete — scanner is ready');
  process.exit(0);
}

run().catch(err => {
  console.error('[Migration] Fatal:', err);
  process.exit(1);
});
