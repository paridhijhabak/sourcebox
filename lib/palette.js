'use strict';
/* Dominant colours for an image.
 *
 * The whole value of this panel is that the hex it shows can be pasted into
 * real work, so the one rule here is: every hex reported must be a byte-exact
 * pixel value that is actually in the file. Two things break that rule and are
 * therefore not done anywhere below:
 *
 *   - Resizing. Any downscale interpolates, which invents colours that sit
 *     between the real ones. Pixels are read at native resolution instead.
 *   - Averaging. Taking the mean of a cluster produces a colour that may not
 *     exist either. Clusters are used only to rank; the value reported is the
 *     single most common exact pixel inside the cluster.
 *
 * When an image has no flat colour at all — a photograph, a gradient — no
 * honest answer exists, so nothing is shown rather than a plausible guess.
 */

let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  // thumbs.js already warns about this on boot; do not warn twice.
}

const OPTS = { limitInputPixels: 40000 * 40000, unlimited: true };

/* Every pixel gets counted or the image is not reported on at all.
 *
 * Sampling was tried and thrown out: a grid of tiles reads the middle of an
 * image more heavily than its edges, which put the favicon's red at 90% when
 * it is really 86%, and — worse — lifted a photograph's colours over the
 * MIN_SHARE gate so a panel appeared that should not have. A share that is
 * quietly wrong is the same problem as a hex that is quietly wrong.
 *
 * So: read it whole, or say nothing. 12 MP is about 48 MB of raw bytes, and
 * covers logos, exports and screen artwork. What it excludes is huge print
 * mockups and photographs, which have no flat colour to report anyway. */
const MAX_PIXELS = 12000000;

// Below this the pixel is too see-through for its colour to be the one anybody
// perceives, and reporting it would be misleading.
const MIN_ALPHA = 250;

// Colours within this RGB distance are the same flat fill plus its
// anti-aliased edge. Used for grouping only, never for the value reported.
const CLUSTER = 42;

// A colour has to really be there. Under this share the image is a photograph
// or a gradient and there is no flat colour to report.
const MIN_SHARE = 0.4;

const MAX_COLORS = 6;

const hex = (r, g, b) =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

function rgbOf(key) {
  return { r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255 };
}

function distance(a, b) {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

/** Raw sRGB bytes for a sharp pipeline, alpha always present. */
async function rawOf(pipeline) {
  return pipeline
    // A CMYK print asset would otherwise hand back ink values, which are not
    // the numbers anyone wants to paste into a screen design.
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

/** Exact pixel-value counts, read at native resolution. */
async function countColours(absPath) {
  const meta = await sharp(absPath, OPTS).metadata();
  const w = meta.width;
  const h = meta.height;
  if (!w || !h) throw new Error('Image has no readable size');

  const counts = new Map();
  let opaque = 0;

  const tally = ({ data, info }) => {
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i + 3] < MIN_ALPHA) continue;
      opaque++;
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  };

  if (w * h > MAX_PIXELS) {
    return { tooLarge: true, width: w, height: h };
  }

  tally(await rawOf(sharp(absPath, OPTS)));
  return { counts, opaque, width: w, height: h };
}

/**
 * Returns { ok, width, height, colors: [{ hex, share }] }.
 *
 * `share` is the percentage of opaque pixels that are exactly that value — not
 * approximately, not a cluster average. An empty `colors` means the image has
 * no flat colour worth naming.
 */
async function extract(absPath) {
  if (!sharp) return { ok: false, err: 'Colour reading needs sharp, which is not installed' };

  let read;
  try {
    read = await countColours(absPath);
  } catch (err) {
    return { ok: false, err: err.message };
  }

  const { counts, opaque, width, height } = read;
  // Dimensions are still worth returning even when the colours are not.
  if (read.tooLarge || !opaque) return { ok: true, width, height, colors: [] };

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => Object.assign(rgbOf(key), { n }));

  // Walk from the most common colour down. Each pick swallows its own
  // anti-aliasing so the list does not fill up with six shades of one red,
  // but the hex kept is the picked pixel's own value, untouched.
  const picked = [];
  for (const c of ranked) {
    if (picked.length >= MAX_COLORS) break;
    if (picked.some((p) => distance(p, c) < CLUSTER)) continue;
    const share = (c.n / opaque) * 100;
    if (share < MIN_SHARE) break;   // ranked desc, so nothing after this qualifies
    picked.push(Object.assign({ share }, c));
  }

  return {
    ok: true,
    width,
    height,
    colors: picked.map((c) => ({
      hex: hex(c.r, c.g, c.b),
      share: share1(c.share),
    })),
  };
}

/** One decimal below 10%, whole numbers above: 0.4% and 81% both read right. */
function share1(value) {
  return value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
}

module.exports = { extract, hasSharp: !!sharp };
