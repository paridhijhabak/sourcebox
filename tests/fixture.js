'use strict';
/* Builds a small but realistic brand-asset tree so the test suite depends on
 * nothing but this repo. Same shapes a real design project has: logo
 * variations, per-platform social exports, stationery PDFs, source files.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '.fixture');
const PROJECT_DIR = path.join(ROOT, 'DemoBrand');

function svg(w, h, fill, label) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
    '<rect width="' + w + '" height="' + h + '" fill="' + fill + '"/>' +
    '<text x="12" y="' + Math.round(h / 2) + '" font-family="sans-serif" font-size="14" fill="#fff">' +
    label + '</text></svg>';
}

/* A 1x1 PNG is enough for indexing, but thumbnails need real pixels, so this
 * writes a small solid-colour PNG with correct CRCs. */
function png(width, height, rgb) {
  const zlib = require('zlib');
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array(width).fill(Buffer.from(rgb)))]);
  const raw = Buffer.concat(Array(height).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Minimal single-page PDF with a filled rectangle, real xref offsets. */
function pdf(label) {
  const content = '1 0 0 RG 0.92 0.13 0.15 rg 60 500 300 200 re f BT /F1 24 Tf 60 460 Td (' +
    label.replace(/[()\\]/g, '') + ') Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
  });
  const xref = out.length;
  out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n';
  out += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(out, 'latin1');
}

const FILES = [
  // Logo variations, the thing people search for most.
  ['logos/primary_logo_red.svg', svg(320, 90, '#eb2127', 'DemoBrand')],
  ['logos/primary_logo_black.png', png(160, 60, [17, 17, 17])],
  ['logos/primary_logo_white_reverse.png', png(160, 60, [245, 245, 245])],
  ['logos/logo_hindi.svg', svg(320, 90, '#b82029', 'Hindi')],
  ['logos/logomark_only.svg', svg(120, 120, '#141110', 'Mark')],
  ['logos/app_icon_512.png', png(96, 96, [235, 33, 39])],
  ['logos/favicon_32.png', png(32, 32, [20, 17, 16])],
  ['logos/explorations/logo_option_01.png', png(140, 50, [90, 90, 90])],
  ['logos/explorations/logo_option_02.png', png(140, 50, [120, 90, 60])],
  ['logos/explorations/logo_option_03.png', png(140, 50, [60, 90, 120])],
  ['logos/explorations/concept_notes.md', Buffer.from('# Concept notes\nThree directions.\n')],

  // Per-platform social exports, including a regional set.
  ['social/01_Instagram/IG_post_square_headline.svg', svg(200, 200, '#eb2127', 'IG square')],
  ['social/01_Instagram/IG_post_portrait_breaking.svg', svg(160, 200, '#141110', 'IG portrait')],
  ['social/01_Instagram/IG_reel_cover.svg', svg(120, 210, '#b82029', 'IG reel')],
  ['social/01_Instagram/IG_story_quote.svg', svg(120, 210, '#3d3735', 'IG story')],
  ['social/02_Facebook/FB_cover_banner.svg', svg(320, 120, '#1b1716', 'FB cover')],
  ['social/02_Facebook/FB_post_square.svg', svg(200, 200, '#2a2422', 'FB post')],
  ['social/03_LinkedIn/LI_document_cover.svg', svg(200, 200, '#141110', 'LI doc')],
  ['social/03_LinkedIn/LI_post_landscape.svg', svg(280, 160, '#211c1a', 'LI post')],
  ['social/04_X_Twitter/X_post_landscape_stat.svg', svg(280, 160, '#000000', 'X post')],
  ['social/05_YouTube/YT_channel_banner.svg', svg(360, 90, '#eb2127', 'YT banner')],
  ['social/05_YouTube/YT_thumbnail_interview.png', png(160, 90, [200, 40, 40])],
  ['social/06_WhatsApp/WA_status_quote.svg', svg(120, 210, '#4ba36b', 'WA status')],
  ['social/07_Regional_Hindi/IG_post_square_hindi.svg', svg(200, 200, '#fcd404', 'IG hindi')],
  ['social/07_Regional_Hindi/FB_post_square_hindi.svg', svg(200, 200, '#dcd7cc', 'FB hindi')],
  ['social/01_Instagram/previews/IG_reel_cover_preview.png', png(60, 105, [180, 33, 39])],

  // Stationery and print, mostly PDFs.
  ['stationery/visiting_card_front.pdf', pdf('Visiting card front')],
  ['stationery/visiting_card_back.pdf', pdf('Visiting card back')],
  ['stationery/id_card.pdf', pdf('ID card')],
  ['stationery/letterhead.pdf', pdf('Letterhead')],
  ['stationery/envelope.pdf', pdf('Envelope')],
  ['stationery/notepad.pdf', pdf('Notepad')],
  ['stationery/door_sticker.png', png(120, 120, [235, 33, 39])],
  ['stationery/metal_nameplate.png', png(180, 60, [120, 120, 120])],

  // Apparel and merchandise.
  ['apparel/tshirt_print_size.pdf', pdf('T-shirt print size')],
  ['apparel/tshirt_mockup_black.png', png(140, 140, [25, 25, 25])],
  ['apparel/tshirt_mockup_red.png', png(140, 140, [200, 30, 36])],

  // Editable source files, which have no browser preview.
  ['source/primary_logo.ai', Buffer.from('%PDF-1.4\nfake illustrator source\n')],
  ['source/stationery_pack.ai', Buffer.from('%PDF-1.4\nfake illustrator source\n')],

  // Docs.
  ['docs/brand_guidelines.pdf', pdf('Brand guidelines')],
  ['docs/colour_palette.md', Buffer.from('# Palette\n- Red #eb2127\n- Cream #dcd7cc\n')],
  ['README.md', Buffer.from('# DemoBrand\nFixture project for the vault test suite.\n')],
];

function build() {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true, maxRetries: 3 });
  for (const [rel, body] of FILES) {
    const target = path.join(PROJECT_DIR, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return PROJECT_DIR;
}

function destroy() {
  try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows lock */ }
}

module.exports = { build, destroy, PROJECT_DIR, ROOT, FILES, png, svg, pdf };

if (require.main === module) {
  console.log('fixture built at ' + build() + ' (' + FILES.length + ' files)');
}
