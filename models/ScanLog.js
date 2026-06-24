const mongoose = require('mongoose');

const ScanLogSchema = new mongoose.Schema({
  memoryId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Memory',
    required: true,
  },
  sessionId:  { type: String, default: null },
  deviceType: { type: String, default: null }, // mobile | tablet | desktop
  userAgent:  { type: String, default: null },
  detectedAt: { type: Date,   default: Date.now },
});

ScanLogSchema.index({ memoryId:   1 });
ScanLogSchema.index({ detectedAt: 1 });

module.exports = mongoose.model('ScanLog', ScanLogSchema);
