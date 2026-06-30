const mongoose = require('mongoose');

/**
 * MergeState
 * ──────────
 * Singleton document tracking the state of the merged "Final" .mind file.
 *
 * Why this exists: rebuilding the merged file means recompiling EVERY
 * ready memory's photo from scratch (this MindAR build has no incremental
 * merge API — confirmed absent). That's fine for a handful of photos, but
 * gets slow as the library grows. We don't want to pay that cost on every
 * single page load or every single upload.
 *
 * Instead: track the last successful rebuild time + which memory IDs were
 * included. The dashboard only triggers a rebuild if enough time has
 * passed (MIN_REBUILD_INTERVAL_MS) OR new memories exist that aren't in
 * the current Final yet. Individual .mind files (already fast, already
 * working) cover any memory not yet folded into Final in the meantime —
 * the gap is "next rebuild cycle", not instant, but bounded and predictable.
 */
const MergeStateSchema = new mongoose.Schema({
  // Always exactly one document — singleton pattern via fixed _id
  _id: { type: String, default: 'merge_state' },

  lastBuiltAt:     { type: Date,   default: null },
  includedIds:     { type: [String], default: [] }, // memory IDs baked into current Final
  mergedMindUrl:   { type: String, default: null },
  building:        { type: Boolean, default: false }, // simple lock to avoid concurrent rebuilds
  buildStartedAt:  { type: Date,   default: null },
});

module.exports = mongoose.model('MergeState', MergeStateSchema);
