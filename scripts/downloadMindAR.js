#!/usr/bin/env node
/**
 * Download the MindAR image-tracking browser script from CDN and cache it to
 * disk so the server never needs to fetch it at runtime.
 *
 * Run once at build time (via npm run build in package.json).
 * The output file is committed alongside the app so Render deploys include it.
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const MINDAR_VERSION = '1.2.5';
const OUT_PATH = path.join(__dirname, '..', 'vendor', 'mindar-image.prod.js');
const URLS = [
  `https://cdn.jsdelivr.net/npm/mind-ar@${MINDAR_VERSION}/dist/mindar-image.prod.js`,
  `https://unpkg.com/mind-ar@${MINDAR_VERSION}/dist/mindar-image.prod.js`,
];

function download(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject).on('timeout', () => reject(new Error(`Timeout fetching ${url}`)));
  });
}

(async () => {
  // Already exists and looks valid — skip download
  try {
    if (fs.existsSync(OUT_PATH)) {
      const stat = fs.statSync(OUT_PATH);
      if (stat.size > 100_000) {
        console.log(`[downloadMindAR] Already cached at ${OUT_PATH} (${stat.size} bytes) — skipping.`);
        process.exit(0);
      }
    }
  } catch (_) {}

  let lastErr;
  for (const url of URLS) {
    try {
      console.log(`[downloadMindAR] Downloading from ${url}…`);
      const text = await download(url);
      if (text.length < 100_000) throw new Error(`File too small (${text.length} chars) — likely an error page`);
      fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
      fs.writeFileSync(OUT_PATH, text, 'utf8');
      console.log(`[downloadMindAR] Saved ${text.length} chars to ${OUT_PATH}`);
      process.exit(0);
    } catch (err) {
      console.error(`[downloadMindAR] Failed from ${url}: ${err.message}`);
      lastErr = err;
    }
  }
  console.error(`[downloadMindAR] All sources failed: ${lastErr?.message}`);
  process.exit(1);
})();
