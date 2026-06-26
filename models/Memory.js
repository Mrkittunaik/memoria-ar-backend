const mongoose = require('mongoose');

const VALID_RATIOS = ['9:16', '1:1', '4:5', '16:9', '3:4', 'auto', 'video', 'free', 'custom'];

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
  videoWidth:    { type: Number, default: null },
  videoHeight:   { type: Number, default: null },
  videoDuration: { type: Number, default: null },
  videoSize:     { type: Number, default: null },

  // Video overlay position — x/y/width/height as % of photo dimensions.
  // ratio kept for editor UI state; geometry is always from x/y/width/height.
  videoRect: {
    ratio:  { type: String, enum: VALID_RATIOS, default: 'auto' },
    x:      { type: Number, default: 50 },
    y:      { type: Number, default: 50 },
    width:  { type: Number, default: 90 },
    height: { type: Number, default: 90 },
  },

  // Border detection result stored so scanner can use it
  detectedBorder: {
    xPct:  { type: Number, default: null },
    yPct:  { type: Number, default: null },
    wPct:  { type: Number, default: null },
    hPct:  { type: Number, default: null },
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

MemorySchema.index({ status: 1 });
MemorySchema.index({ createdAt: 1 });

MemorySchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

MemorySchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Memory', MemorySchema);
