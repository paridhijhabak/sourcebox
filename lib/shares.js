'use strict';
const crypto = require('crypto');
const { SHARES_FILE, readJSON, writeJSON, hashPasscode } = require('./config');

function load() {
  return readJSON(SHARES_FILE, {});
}

function save(all) {
  writeJSON(SHARES_FILE, all);
}

function newToken() {
  return crypto.randomBytes(9).toString('base64url');
}

function create({ label, projectId, folderPath, passcode, expiresInDays, allowDownload }) {
  const all = load();
  let token = newToken();
  while (all[token]) token = newToken();

  const salt = crypto.randomBytes(16).toString('hex');
  const share = {
    token,
    label: label || 'Shared folder',
    projectId,
    folderPath: folderPath || '',
    salt,
    passcodeHash: passcode ? hashPasscode(passcode, salt) : null,
    expiresAt: expiresInDays ? Date.now() + Number(expiresInDays) * 86400000 : null,
    allowDownload: allowDownload !== false,
    createdAt: Date.now(),
    views: 0,
    lastViewedAt: null,
  };
  all[token] = share;
  save(all);
  return share;
}

function get(token) {
  return load()[token] || null;
}

function isExpired(share) {
  return !!(share.expiresAt && Date.now() > share.expiresAt);
}

function verify(share, passcode) {
  if (!share.passcodeHash) return true;
  if (!passcode) return false;
  const a = Buffer.from(hashPasscode(passcode, share.salt), 'hex');
  const b = Buffer.from(share.passcodeHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function touch(token) {
  const all = load();
  if (!all[token]) return;
  all[token].views = (all[token].views || 0) + 1;
  all[token].lastViewedAt = Date.now();
  save(all);
}

function update(token, patch) {
  const all = load();
  if (!all[token]) return null;
  const share = all[token];
  if (patch.label !== undefined) share.label = patch.label;
  if (patch.allowDownload !== undefined) share.allowDownload = !!patch.allowDownload;
  if (patch.expiresInDays !== undefined) {
    share.expiresAt = patch.expiresInDays ? Date.now() + Number(patch.expiresInDays) * 86400000 : null;
  }
  if (patch.passcode !== undefined) {
    share.passcodeHash = patch.passcode ? hashPasscode(patch.passcode, share.salt) : null;
  }
  save(all);
  return share;
}

function revoke(token) {
  const all = load();
  delete all[token];
  save(all);
}

function list() {
  return Object.values(load()).sort((a, b) => b.createdAt - a.createdAt);
}

// What the visitor of a share link is allowed to see. Never leak the hash.
function publicView(share) {
  return {
    token: share.token,
    label: share.label,
    folderPath: share.folderPath,
    allowDownload: share.allowDownload,
    hasPasscode: !!share.passcodeHash,
    expiresAt: share.expiresAt,
  };
}

module.exports = { create, get, verify, touch, revoke, list, update, isExpired, publicView };
