'use strict';
/* Accounts for the vault: email + password, stored on this machine in
 * data/users.json. Nothing here talks to a network — an "account" is a local
 * credential, the same way the owner passcode is, just one per person so a
 * small team can each have their own sign-in instead of sharing one secret.
 *
 * The first account created owns the vault. After that, creating another one
 * needs the owner passcode, so a vault reachable over the LAN or a tunnel
 * can't have strangers sign themselves up into it.
 */
const crypto = require('crypto');
const path = require('path');
const { DATA_DIR, readJSON, writeJSON } = require('./config');

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MIN_PASSWORD = 8;

let _users = readJSON(USERS_FILE, null);
if (!Array.isArray(_users)) _users = [];

function save() {
  writeJSON(USERS_FILE, _users);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/* Deliberately loose: this is a local sign-in, not a mailing list. We only
 * need enough shape to keep two people's accounts apart. */
function looksLikeEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function count() {
  return _users.length;
}

function byId(id) {
  return _users.find((u) => u.id === id) || null;
}

function byEmail(email) {
  const key = normalizeEmail(email);
  return _users.find((u) => u.email === key) || null;
}

function publicView(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
  };
}

function list() {
  return _users.map(publicView);
}

function create({ name, email, password }) {
  const cleanEmail = normalizeEmail(email);
  const cleanName = String(name || '').trim().slice(0, 60);
  if (!cleanName) throw fail(400, 'Enter your name');
  if (!looksLikeEmail(cleanEmail)) throw fail(400, 'Enter a valid email address');
  if (String(password || '').length < MIN_PASSWORD) {
    throw fail(400, `Password must be at least ${MIN_PASSWORD} characters`);
  }
  if (byEmail(cleanEmail)) throw fail(409, 'An account with that email already exists');

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomBytes(9).toString('hex'),
    name: cleanName,
    email: cleanEmail,
    salt,
    passwordHash: hashPassword(password, salt),
    // Whoever gets there first owns the vault; everyone after is a member.
    role: _users.length === 0 ? 'owner' : 'member',
    createdAt: Date.now(),
    lastLoginAt: null,
  };
  _users.push(user);
  save();
  return user;
}

function verify(email, password) {
  const user = byEmail(email);
  if (!user) {
    // Spend the same work on a miss, so a wrong email and a wrong password
    // can't be told apart by how long the answer takes.
    crypto.scryptSync(String(password || ''), 'no-such-user', 32);
    return null;
  }
  const a = Buffer.from(hashPassword(password || '', user.salt), 'hex');
  const b = Buffer.from(user.passwordHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return user;
}

function touchLogin(id) {
  const user = byId(id);
  if (!user) return null;
  user.lastLoginAt = Date.now();
  save();
  return user;
}

function setPassword(id, password) {
  const user = byId(id);
  if (!user) throw fail(404, 'No such account');
  if (String(password || '').length < MIN_PASSWORD) {
    throw fail(400, `Password must be at least ${MIN_PASSWORD} characters`);
  }
  user.salt = crypto.randomBytes(16).toString('hex');
  user.passwordHash = hashPassword(password, user.salt);
  save();
  return user;
}

function remove(id) {
  const i = _users.findIndex((u) => u.id === id);
  if (i < 0) return false;
  _users.splice(i, 1);
  save();
  return true;
}

module.exports = {
  USERS_FILE, MIN_PASSWORD,
  count, list, byId, byEmail, create, verify, touchLogin, setPassword, remove,
  publicView, normalizeEmail,
};
