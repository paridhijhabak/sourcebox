'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { THUMB_DIR } = require('./config');

let sharp = null;
try {
  sharp = require('sharp');
  sharp.cache({ files: 0 });
} catch (err) {
  console.warn('[thumbs] sharp unavailable, falling back to originals:', err.message);
}

const RASTERISABLE = new Set(['image', 'vector']);

function keyFor(absPath, mtimeMs, width) {
  const h = crypto.createHash('sha1').update(`${absPath}|${mtimeMs}|${width}`).digest('hex');
  return `${h}.webp`;
}

function cachePath(key) {
  return path.join(THUMB_DIR, key);
}

/**
 * Returns { file } for a cached/generated thumbnail, { raw } to stream the
 * original, or { needsClient: true } when only the browser can rasterise it
 * (PDF/AI via pdf.js, video via a canvas frame grab).
 */
async function thumbnail({ absPath, kind, width = 480 }) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return { missing: true };
  }

  const key = keyFor(absPath, stat.mtimeMs, width);
  const cached = cachePath(key);
  if (fs.existsSync(cached)) return { file: cached, key };

  if (!sharp || !RASTERISABLE.has(kind)) {
    return { needsClient: true, key };
  }

  try {
    const pipeline = sharp(absPath, { limitInputPixels: 40000 * 40000, unlimited: true })
      .rotate()
      .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78, effort: 3 });
    await pipeline.toFile(cached);
    return { file: cached, key };
  } catch (err) {
    // SVGs with exotic features and CMYK TIFFs land here.
    if (kind === 'vector') return { raw: absPath, key };
    return { needsClient: true, key };
  }
}

/** Store a thumbnail the browser rendered for us so the next visitor gets it instantly. */
async function storeClientThumb(key, buffer) {
  if (!/^[a-f0-9]{40}\.webp$/.test(key)) throw new Error('bad thumbnail key');
  const target = cachePath(key);
  if (sharp) {
    await sharp(buffer).resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78, effort: 3 }).toFile(target);
  } else {
    fs.writeFileSync(target, buffer);
  }
  return target;
}

function clearCache() {
  let n = 0;
  for (const f of fs.readdirSync(THUMB_DIR)) {
    if (f.endsWith('.webp')) { fs.unlinkSync(path.join(THUMB_DIR, f)); n++; }
  }
  return n;
}

module.exports = { thumbnail, storeClientThumb, keyFor, clearCache, hasSharp: !!sharp };
