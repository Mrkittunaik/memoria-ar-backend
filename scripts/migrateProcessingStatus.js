/**
 * One-time migration: backfill `processingStatus` for memories created
 * before this field existed.
 *
 * Without this, old documents would silently read back as
 * processingStatus: 'processing' (the schema default) even though they
 * were already live and scanning fine — which is misleading.
 *
 * This script sets processingStatus: 'ready' for any existing memory
 * whose `status` is 'active' (i.e. it was already serving in the
 * scanner), and 'failed' for any whose `status` is 'failed'. It leaves
 * memories already in 'processing' status untouched.
 *
 * No quality metrics are backfilled — there's no way to retroactively
 * measure sharpness/brightness/contrast without the original photo
 * buffer, and inventing numbers would defeat the purpose of this whole
 * pipeline. Old memories will simply show quality: null fields, which
 * the frontend should treat as "not measured" rather than "failed".
 *
 * Run once, manually:
 *   node scripts/migrateProcessingStatus.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Memory = require('../models/Memory');

async function migrate() {
  await connectDB();
  // give the connectDB retry loop a moment if it's still connecting
  await new Promise((resolve) => {
    if (mongoose.connection.readyState === 1) return resolve();
    mongoose.connection.once('connected', resolve);
  });

  const toReady = await Memory.updateMany(
    { status: 'active', processingStatus: { $exists: false } },
    { $set: { processingStatus: 'ready' } }
  );
  console.log(`[Migration] Marked ${toReady.modifiedCount} active memories as processingStatus: ready`);

  const toFailed = await Memory.updateMany(
    { status: 'failed', processingStatus: { $exists: false } },
    { $set: { processingStatus: 'failed' } }
  );
  console.log(`[Migration] Marked ${toFailed.modifiedCount} failed memories as processingStatus: failed`);

  console.log('[Migration] Done.');
  await mongoose.connection.close();
  process.exit(0);
}

migrate().catch((err) => {
  console.error('[Migration] Failed:', err);
  process.exit(1);
});
