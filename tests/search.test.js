'use strict';
/* Search quality, run directly against the engine the browser loads.
 * The corpus is the fixture project, so this is reproducible anywhere. */
const path = require('path');
const fixture = require('./fixture');

global.window = {};
require(path.join(__dirname, '..', 'public', 'search.js'));
const VS = global.window.VaultSearch;

// Mirror what the client indexes: a record per file, previews excluded.
fixture.build();
const files = fixture.FILES
  .map(([rel]) => rel)
  .filter((rel) => !/(^|\/)previews\//i.test(rel))
  .map((rel) => {
    const n = rel.split('/').pop();
    return {
      p: rel,
      n,
      d: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
      e: (n.split('.').pop() || '').toLowerCase(),
      k: guessKind(n),
      s: 1024,
      m: Date.now(),
    };
  });

function guessKind(name) {
  const e = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp'].includes(e)) return 'image';
  if (e === 'svg') return 'vector';
  if (e === 'pdf') return 'pdf';
  if (['ai', 'psd', 'eps'].includes(e)) return 'design';
  if (['mp4', 'mov'].includes(e)) return 'video';
  return 'doc';
}

console.log('\nsearching over ' + files.length + ' fixture files\n');

/* Each case: the query someone would actually type, and a pattern the top
 * hit must satisfy. This is what stops a synonym edit quietly regressing. */
const CASES = [
  ['red wala logo', /primary_logo_red/],
  ['mujhe kala logo chahiye', /black|dark/i],
  ['white logo', /white|reverse/i],
  ['insta post', /^IG_post/],
  ['instagram reel', /IG_reel/],
  ['insta post hindi', /hindi/i],
  ['instgram', /IG_/],
  ['logoo', /logo/i],
  ['app icon', /app_icon/],
  ['favicon', /favicon/],
  ['visiting card', /visiting_card/],
  ['id card', /id_card/],
  ['letterhead', /letterhead/],
  ['lifafa', /envelope/],
  ['tshirt print file', /tshirt_print/],
  ['t shirt', /tshirt/],
  ['whatsapp status', /WA_status/],
  ['youtube banner', /YT_channel_banner/],
  ['yt thumbnail', /YT_thumbnail/],
  ['linkedin', /^LI_/],
  ['twitter post', /^X_post/],
  ['facebook cover', /FB_cover/],
  ['brand guidelines', /brand_guidelines/],
  ['colour palette', /colour_palette/],
  ['editable source file', /\.ai$/],
  ['door sticker', /door_sticker/],
  ['nameplate', /nameplate/],
  ['notepad', /notepad/],
  ['logo explorations', /logo_option|concept/],
  ['sare pdf', /\.pdf$/],
  ['sabhi vector', /\.svg$/],
  ['mockup', /mockup/],
];

let pass = 0, fail = 0;
for (const [query, expect] of CASES) {
  const hits = VS.search(files, query);
  const top = hits[0];
  const good = top && expect.test(top.file.n);
  const label = (query + '                          ').slice(0, 26);
  if (good) {
    pass++;
    console.log('  PASS  ' + label + top.file.n);
  } else {
    fail++;
    const dym = hits.length ? '' : '   did-you-mean: ' + VS.didYouMean(files, query, 3).join(', ');
    console.log('  FAIL  ' + label + (top ? top.file.n : '(nothing)') +
                '   expected ' + expect + dym);
  }
}

const t = Date.now();
for (let i = 0; i < 200; i++) VS.search(files, 'red wala logo png');
console.log('\n  200 searches: ' + (Date.now() - t) + 'ms');

fixture.destroy();
console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' : 'ALL ') + CASES.length + ' search cases\n');
process.exit(fail ? 1 : 0);
