'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

/* Everything mutable can be relocated with VAULT_DATA_DIR. That keeps the
 * checkout clean, lets the vault's state live on another drive, and makes it
 * possible to run a second instance (a fresh install, a staging copy) without
 * touching the first one's projects. */
const BASE_DIR = process.env.VAULT_DATA_DIR
  ? path.resolve(process.env.VAULT_DATA_DIR)
  : ROOT;
const DATA_DIR = path.join(BASE_DIR, 'data');
const CACHE_DIR = path.join(BASE_DIR, 'cache');
const THUMB_DIR = path.join(CACHE_DIR, 'thumbs');
const STORAGE_DIR = path.join(BASE_DIR, 'storage');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const SHARES_FILE = path.join(DATA_DIR, 'shares.json');
const STARS_FILE = path.join(DATA_DIR, 'stars.json');

for (const d of [DATA_DIR, CACHE_DIR, THUMB_DIR, STORAGE_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

function hashPasscode(passcode, salt) {
  return crypto.scryptSync(String(passcode), salt, 32).toString('hex');
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/* Readable but not guessable: no 0/O/1/l, grouped so it can be read aloud. */
function generatePasscode() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const pick = (n) => Array.from(crypto.randomBytes(n))
    .map((b) => alphabet[b % alphabet.length]).join('');
  return pick(4) + '-' + pick(4);
}

function defaultConfig() {
  const salt = crypto.randomBytes(16).toString('hex');
  // Generated per install rather than shipped as a constant, so a fresh copy
  // of this repo is never protected by a passcode that is public knowledge.
  const passcode = generatePasscode();
  return {
    vaultName: 'SourceBox',
    salt,
    ownerPasscodeHash: hashPasscode(passcode, salt),
    passcodeIsDefault: true,
    generatedPasscode: passcode,   // cleared the moment the owner sets their own
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    projects: [],
  };
}

let _config = readJSON(CONFIG_FILE, null);
if (!_config) {
  _config = defaultConfig();
  writeJSON(CONFIG_FILE, _config);
}

function getConfig() {
  return _config;
}

function saveConfig(next) {
  _config = next;
  writeJSON(CONFIG_FILE, _config);
  return _config;
}

function setOwnerPasscode(passcode) {
  const cfg = getConfig();
  cfg.ownerPasscodeHash = hashPasscode(passcode, cfg.salt);
  cfg.passcodeIsDefault = false;
  delete cfg.generatedPasscode;
  return saveConfig(cfg);
}

function checkOwnerPasscode(passcode) {
  const cfg = getConfig();
  const a = Buffer.from(hashPasscode(passcode, cfg.salt), 'hex');
  const b = Buffer.from(cfg.ownerPasscodeHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  ROOT, DATA_DIR, CACHE_DIR, THUMB_DIR, STORAGE_DIR, generatePasscode,
  CONFIG_FILE, INDEX_FILE, SHARES_FILE, STARS_FILE,
  readJSON, writeJSON, hashPasscode,
  getConfig, saveConfig, setOwnerPasscode, checkOwnerPasscode,
};
