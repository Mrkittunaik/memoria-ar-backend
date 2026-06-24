const mongoose = require('mongoose');

const MemorySchema = new mongoose.Schema({
  title: {
    type:      String,
    required:  [true, 'Title is required'],
    trim:      true,
    maxlength: [100, 'Title must be 100 characters or fewer'],
  },
  description: {
    type:      String,
    trim:      true,
    maxlength: [500, 'Description must be 500 characters or fewer'],
    default:   null,
  },
  photoUrl:      { type: String, required: true },
  photoPublicId: { type: String, required: true },
  videoUrl:      { type: String, required: true },
  videoPublicId: { type: String, required: true },
  photoWidth:    { type: Number, default: null },
  photoHeight:   { type: Number, default: null },
  videoDuration: { type: Number, default: null },
  videoSize:     { type: Number, default: null },
  // ── Video overlay position on the photo ──────────────────────────────
  // x/y/width/height are stored as PERCENTAGES (0-100) of the photo's own
  // width/height, so the same rect scales correctly to any screen size.
  // ratio is the preset chosen in the editor — kept for re-opening the
  // editor with the right preset selected; the actual box geometry is
  // always read from x/y/width/height.
  videoRect: {
    ratio:  { type: String, enum: ['9:16', '1:1', '4:5'], default: '9:16' },
    x:      { type: Number, default: 50 },  // % from left, center-anchored
    y:      { type: Number, default: 50 },  // % from top, center-anchored
    width:  { type: Number, default: 45 },  // % of photo width
    height: { type: Number, default: 80 },  // % of photo height
  },
  status: {
    type:    String,
    enum:    ['processing', 'active', 'failed'],
    default: 'active',
  },
  scanCount:     { type: Number, default: 0 },
  lastScannedAt: { type: Date,   default: null },
  createdAt:     { type: Date,   default: Date.now },
  updatedAt:     { type: Date,   default: Date.now },
});

// Indexes for common query patterns
MemorySchema.index({ status: 1 });
MemorySchema.index({ createdAt: 1 });

// Auto-update updatedAt on every save
MemorySchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Strip __v from JSON output
MemorySchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Memory', MemorySchema);
