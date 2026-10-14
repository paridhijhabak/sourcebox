'use strict';
/* The owner's colour choices.
 *
 * Three decisions are offered, not thirty: the accent, the folder, and the
 * page. Everything else a theme needs — the tint behind a selected row, the
 * text colour that has to sit on top of the accent, the four shades that make
 * a folder look like a folder — is derived from those three, because picking
 * them by hand is how palettes end up unreadable.
 *
 * Stored on the server rather than in the browser so the vault looks the same
 * from the laptop and from the phone on the LAN.
 */
const { getConfig, saveConfig } = require('./config');

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The shipped look. `null` means "leave the stylesheet's own value alone". */
const DEFAULTS = { accent: null, folder: null, bg: null };

function read() {
  const t = getConfig().theme;
  if (!t || typeof t !== 'object') return Object.assign({}, DEFAULTS);
  return {
    accent: HEX.test(t.accent || '') ? t.accent.toLowerCase() : null,
    folder: HEX.test(t.folder || '') ? t.folder.toLowerCase() : null,
    bg: HEX.test(t.bg || '') ? t.bg.toLowerCase() : null,
  };
}

/**
 * Accepts a partial patch. A key set to null or an empty string resets that
 * one choice back to the stylesheet default.
 */
function write(patch) {
  const next = read();
  for (const key of ['accent', 'folder', 'bg']) {
    if (!(key in (patch || {}))) continue;
    const value = patch[key];
    if (value === null || value === '') { next[key] = null; continue; }
    if (!HEX.test(String(value))) {
      const err = new Error('"' + key + '" ek #rrggbb colour hona chahiye');
      err.status = 400;
      throw err;
    }
    next[key] = String(value).toLowerCase();
  }
  const cfg = getConfig();
  cfg.theme = next;
  saveConfig(cfg);
  return next;
}

module.exports = { read, write, DEFAULTS };
