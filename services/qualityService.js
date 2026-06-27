/**
 * qualityService
 * ───────────────
 * Converts raw measured metrics (from imageAnalysisService) into a
 * quality verdict: a 1-5 star rating, a pass/reject decision, and
 * human-readable reasons for any issues found.
 *
 * Thresholds were calibrated empirically against synthetic test images
 * spanning sharp/blurred/dark/bright/low-contrast variants (see dev notes).
 * They are deliberately generous — the goal is to reject photos that
 * clearly cannot be scanned, not to be a harsh art critic. A soft "Fair"
 * tier in between is reported as a warning, not a hard rejection, since
 * AR tracking tolerance ultimately also depends on factors this service
 * doesn't model (texture detail, repetition, etc.).
 *
 * IMPORTANT: This service does NOT compute or claim "tracking confidence"
 * or "feature point count" — those require an actual MindAR compile step,
 * which is not implemented here. The output below is restricted to what
 * can honestly be measured from pixel statistics: sharpness, exposure,
 * and contrast.
 */

const THRESHOLDS = {
  sharpness: { reject: 8, fair: 25, good: 60 },     // Laplacian variance
  brightness: {
    rejectLow: 40, fairLow: 90,                      // too dark
    rejectHigh: 250, fairHigh: 235,                  // too bright / blown out
  },
  contrast: { reject: 10, fair: 16, good: 22 },      // std deviation
};

/**
 * @param {object} metrics - output of imageAnalysisService.analyzeImage
 * @param {object} dims - { width, height } original photo dimensions
 * @returns {{
 *   passed: boolean,
 *   rating: number,          // 1-5 stars
 *   label: string,           // 'Excellent' | 'Good' | 'Fair' | 'Poor'
 *   reasons: string[],       // populated when passed === false, or as warnings
 *   warnings: string[],
 *   metrics: object,         // the raw measured numbers, rounded for storage
 * }}
 */
function evaluateQuality(metrics, dims = {}) {
  const { sharpness, brightness, contrast } = metrics;
  const reasons = [];
  const warnings = [];

  // ── Hard rejects ──────────────────────────────────────────────────────
  if (sharpness < THRESHOLDS.sharpness.reject) {
    reasons.push('Image is too blurry — details aren\'t sharp enough to be recognized reliably. Try retaking the photo with a steady hand and good focus.');
  }
  if (brightness < THRESHOLDS.brightness.rejectLow) {
    reasons.push('Image is too dark — important details are lost in shadow. Try retaking it in better lighting.');
  }
  if (brightness > THRESHOLDS.brightness.rejectHigh) {
    reasons.push('Image is overexposed — details are washed out by too much light or flash glare. Try retaking it with softer or more even lighting.');
  }
  if (contrast < THRESHOLDS.contrast.reject) {
    reasons.push('Image is too flat/low-contrast to distinguish distinct features. Try a clearer, less hazy photo.');
  }

  const passed = reasons.length === 0;

  // ── Soft warnings (only relevant if it passed) ──────────────────────────
  if (passed) {
    if (sharpness < THRESHOLDS.sharpness.fair) {
      warnings.push('Image sharpness is on the lower side — tracking may be slightly slower to lock on.');
    }
    if (brightness < THRESHOLDS.brightness.fairLow || brightness > THRESHOLDS.brightness.fairHigh) {
      warnings.push('Image exposure is a little uneven — a more evenly lit photo would track more reliably.');
    }
    if (contrast < THRESHOLDS.contrast.fair) {
      warnings.push('Image contrast is on the lower side — adding more lighting contrast could improve tracking.');
    }
  }

  // ── Star rating (1-5) ────────────────────────────────────────────────
  // Computed from the same metrics regardless of pass/fail so the client
  // always gets an informative score — but capped at 2 stars whenever the
  // photo failed a hard threshold, so the rating never contradicts the
  // pass/reject decision (e.g. an overexposed reject can't show 4 stars
  // just because its sharpness happened to be fine).
  const sharpScore = clampScore(sharpness, THRESHOLDS.sharpness.reject, THRESHOLDS.sharpness.good);
  const brightScore = brightnessScore(brightness);
  const contrastScore = clampScore(contrast, THRESHOLDS.contrast.reject, THRESHOLDS.contrast.good);
  const composite = (sharpScore * 0.5) + (brightScore * 0.25) + (contrastScore * 0.25);
  let rating = Math.max(1, Math.min(5, Math.round(composite * 5)));
  if (!passed) rating = Math.min(rating, 2);

  const label = passed
    ? (rating >= 5 ? 'Excellent' : rating >= 4 ? 'Good' : 'Fair')
    : 'Poor';

  return {
    passed,
    rating,
    label,
    reasons,
    warnings,
    metrics: {
      sharpness: round2(sharpness),
      brightness: round2(brightness),
      contrast: round2(contrast),
      width: dims.width ?? null,
      height: dims.height ?? null,
    },
  };
}

function clampScore(value, lo, hi) {
  if (value <= lo) return 0;
  if (value >= hi) return 1;
  return (value - lo) / (hi - lo);
}

// Brightness is "good" in a middle band, not a one-directional scale —
// score peaks in the healthy range and falls off toward either extreme.
function brightnessScore(brightness) {
  const idealLow = 110;
  const idealHigh = 215;
  if (brightness >= idealLow && brightness <= idealHigh) return 1;
  if (brightness < idealLow) {
    return clampScore(brightness, THRESHOLDS.brightness.rejectLow, idealLow);
  }
  return clampScore(brightness, THRESHOLDS.brightness.rejectHigh, idealHigh);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { evaluateQuality, THRESHOLDS };
