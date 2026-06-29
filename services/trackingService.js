/**
 * trackingService
 * ───────────────
 * Two responsibilities:
 *
 * 1. COMPILE — when a new memory is uploaded, compile its photo into a
 *    .mind binary on the server (via headless Chromium + MindAR) and
 *    store it on Cloudinary. This replaces on-device compile entirely.
 *
 * 2. MERGE — after every individual compile, rebuild one single merged
 *    .mind file that contains ALL ready targets combined. The scanner
 *    fetches this one file and passes it straight to MindARThree.
 *    One HTTP request, CDN-cached, loads in under a second regardless
 *    of how many memories exist.
 *
 * HOW THE MERGE WORKS
 * MindAR's Compiler.mergeTargets() takes an array of Uint8Arrays (each
 * one a compiled .mind binary) and returns a single combined Uint8Array.
 * We run this inside the same headless page used for compiling so we
 * don't need a separate Node environment for it.
 *
 * CLOUDINARY LAYOUT
 *   memoria/tracking/<memoryId>   — individual .mind per memory (raw)
 *   memoria/tracking/merged       — combined .mind for all ready memories (raw)
 *
 * The merged file is overwritten atomically every time a new compile
 * finishes. The old version stays on CDN until Cloudinary propagates the
 * new one — typically under 5 seconds.
 */

const { cloudinary } = require('../config/cloudinary');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// Single browser instance reused across all compile/merge calls.
let _browser = null;

async function _getBrowser() {
  if (_browser) return _browser;

  // puppeteer-core + @sparticuz/chromium ship a self-contained, statically
  // linked Chromium binary built specifically for restricted Linux
  // environments (Render, Lambda, etc). It needs no apt-get system
  // libraries and no separate Chrome download step at build time — the
  // binary is already inside the npm package.
  const puppeteer = require('puppeteer-core');
  const chromium = require('@sparticuz/chromium');

  const executablePath = await chromium.executablePath();

  _browser = await puppeteer.launch({
    headless: chromium.headless,
    executablePath,
    args: [
      ...chromium.args,
      '--disable-gpu',
      // WebGL is required by MindAR's Compiler which uses OffscreenCanvas/WebGL
      // internally. 'enable-webgl' is not a flag — the correct flag is:
      '--enable-unsafe-webgl',
      '--use-gl=swiftshader',         // software WebGL renderer — no GPU needed
      '--enable-features=Vulkan',
    ],
  });
  _browser.on('disconnected', () => { _browser = null; _page = null; });
  return _browser;
}

// Reusable page with MindAR already loaded — avoids reloading the CDN
// script on every compile. Created once on first use, reused after that.
let _page = null;

async function _getMindARPage() {
  const browser = await _getBrowser();

  // If the page was closed (crash, navigation) recreate it
  if (_page) {
    try {
      if (!_page.isClosed()) return _page;
    } catch (_) {
      // isClosed() can throw if the browser itself crashed — fall through
    }
    _page = null;
  }

  _page = await browser.newPage();
  _page.on('console', msg => {
    if (msg.type() === 'error') console.error('[Puppeteer]', msg.text());
  });
  // Suppress crashes from being unhandled (page.crash fires on renderer OOM)
  _page.on('crash', () => { console.error('[Puppeteer] Page crashed — will recreate on next call'); _page = null; });

  // Pin to a specific MindAR version so a CDN update can't silently break
  // the compile API. 1.2.5 is the last stable release tested against this codebase.
  await _page.setContent(`<!DOCTYPE html><html><body>
    <script src="https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image.prod.js"></script>
  </body></html>`);

  await _page.waitForFunction(() => window.MINDAR?.IMAGE?.Compiler, { timeout: 30_000 });
  console.log('[Tracking] MindAR page ready');
  return _page;
}

/**
 * Fetch imageUrl and return it as a base64 data URI so the headless page
 * can load it without CORS issues (null origin in puppeteer).
 */
async function _imageToDataUri(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status} — ${imageUrl}`);
  const buf = await res.buffer();
  const mime = res.headers.get('content-type') || 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * Compile one image into a .mind binary inside the shared headless page.
 * Returns a Node Buffer containing the .mind data.
 */
async function _compileSingle(imageUrl) {
  const dataUri = await _imageToDataUri(imageUrl);
  const page = await _getMindARPage();

  const base64Mind = await page.evaluate(async (dataUri) => {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Image load failed in headless page'));
      el.src = dataUri;
    });

    const compiler = new window.MINDAR.IMAGE.Compiler();
    await compiler.compileImageTargets([img], () => {});
    const buffer = compiler.exportData();

    // Transfer back as base64 — CDP evaluate() can't send raw ArrayBuffers
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }, dataUri);

  return Buffer.from(base64Mind, 'base64');
}

/**
 * Merge an array of .mind Buffers into one combined .mind Buffer using
 * MindAR's Compiler.mergeTargets(), running inside the shared headless page.
 */
async function _mergeMinds(buffers) {
  const page = await _getMindARPage();

  // Send each buffer as base64, merge inside the page, return result as base64
  const base64List = buffers.map(b => b.toString('base64'));

  const base64Merged = await page.evaluate(async (base64List) => {
    const dataList = base64List.map(b64 => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    });

    const merged = window.MINDAR.IMAGE.Compiler.mergeTargets(dataList);

    const bytes = new Uint8Array(merged.buffer || merged);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }, base64List);

  return Buffer.from(base64Merged, 'base64');
}

/**
 * Upload a .mind buffer to Cloudinary as a raw asset.
 * publicId is the Cloudinary identifier (no extension needed for raw).
 */
async function _uploadRaw(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id:     publicId,
        resource_type: 'raw',
        overwrite:     true,
      },
      (err, result) => {
        if (err) return reject(err);
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

/**
 * Rebuild the single merged .mind file from all currently-ready memories.
 * Called after every successful individual compile so the merged file is
 * always up to date.
 *
 * If only one memory is ready, the merged file is just that one memory's
 * .mind file (mergeTargets with a single entry is a no-op passthrough).
 *
 * @param {object} Memory - Mongoose model passed in to avoid circular require
 * @returns {Promise<string|null>} - the new merged .mind CDN URL, or null on failure
 */
async function rebuildMergedMind(Memory) {
  console.log('[Tracking] Rebuilding merged .mind file…');

  const memories = await Memory.find({
    status: 'active',
    'tracking.status': 'ready',
    'tracking.mindFileUrl': { $exists: true, $ne: null },
  })
    .sort({ createdAt: 1 })
    .select('_id tracking.mindFileUrl')
    .lean();

  if (memories.length === 0) {
    console.log('[Tracking] No ready memories — skipping merged rebuild');
    return null;
  }

  // Download all individual .mind files in parallel
  const buffers = await Promise.all(
    memories.map(async (m) => {
      const res = await fetch(m.tracking.mindFileUrl);
      if (!res.ok) throw new Error(`Failed to fetch .mind for ${m._id}: ${res.status}`);
      return res.buffer();
    })
  );

  const mergedBuffer = await _mergeMinds(buffers);
  console.log(`[Tracking] Merged ${memories.length} targets → ${mergedBuffer.length} bytes`);

  const { url } = await _uploadRaw(mergedBuffer, 'memoria/tracking/merged');
  console.log(`[Tracking] Merged .mind uploaded → ${url}`);

  return url;
}

/**
 * Full pipeline for a single new upload:
 *   1. Compile the image into a .mind binary
 *   2. Upload it as the memory's individual .mind file
 *   3. Rebuild the global merged .mind file
 *   4. Update the Memory document with tracking.status = 'ready'
 *
 * Runs in the background — the HTTP upload response is already sent before
 * this is called. Updates the Memory document when done.
 *
 * @param {string} memoryId
 * @param {string} imageUrl
 * @param {object} Memory - Mongoose model
 */
async function generateTrackingData(memoryId, imageUrl, Memory) {
  const startMs = Date.now();
  console.log(`[Tracking] Starting compile for memory ${memoryId}`);

  try {
    await Memory.findByIdAndUpdate(memoryId, {
      'tracking.status': 'generating',
      updatedAt: new Date(),
    });

    // Step 1 — compile this image
    const mindBuffer = await _compileSingle(imageUrl);
    console.log(`[Tracking] Compiled ${mindBuffer.length} bytes in ${Date.now() - startMs}ms`);

    // Step 2 — upload individual .mind file
    const { url, publicId } = await _uploadRaw(mindBuffer, `memoria/tracking/${memoryId}`);
    console.log(`[Tracking] Individual .mind uploaded → ${url}`);

    // Step 3 — mark this memory ready before rebuilding merged,
    // so it's included in the merge
    await Memory.findByIdAndUpdate(memoryId, {
      'tracking.status':       'ready',
      'tracking.mindFileUrl':  url,
      'tracking.mindPublicId': publicId,
      'tracking.generatedAt':  new Date(),
      updatedAt: new Date(),
    });

    // Step 4 — rebuild the single merged .mind file for all ready memories
    await rebuildMergedMind(Memory);

    console.log(`[Tracking] Full pipeline complete for ${memoryId} in ${Date.now() - startMs}ms`);
  } catch (err) {
    console.error(`[Tracking] Failed for ${memoryId}: ${err.message}`);
    await Memory.findByIdAndUpdate(memoryId, {
      'tracking.status':       'failed',
      'tracking.errorMessage': err.message,
      updatedAt: new Date(),
    }).catch(() => {});
  }
}

/**
 * Delete a memory's individual .mind file from Cloudinary.
 * Called when a memory is deleted — also triggers a merged rebuild so the
 * deleted target is removed from the scanner immediately.
 *
 * @param {string} mindPublicId
 * @param {object} Memory - pass in so we can rebuild after delete
 */
async function deleteTrackingFile(mindPublicId, Memory) {
  if (!mindPublicId) return;
  try {
    await cloudinary.uploader.destroy(mindPublicId, { resource_type: 'raw' });
    console.log(`[Tracking] Deleted individual .mind ${mindPublicId}`);
  } catch (err) {
    console.error(`[Tracking] Failed to delete .mind ${mindPublicId}: ${err.message}`);
  }

  // Rebuild merged so the deleted target disappears from the scanner
  if (Memory) {
    await rebuildMergedMind(Memory).catch(err => {
      console.error(`[Tracking] Merged rebuild after delete failed: ${err.message}`);
    });
  }
}

module.exports = { generateTrackingData, deleteTrackingFile, rebuildMergedMind };
