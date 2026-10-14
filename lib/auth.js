'use strict';
const crypto = require('crypto');
const { getConfig } = require('./config');
const users = require('./users');

const COOKIE = 'av_session';
const MAX_AGE_MS = 30 * 86400000;

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', getConfig().sessionSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(value) {
  if (typeof value !== 'string' || !value.includes('.')) return null;
  const [body, mac] = value.split('.');
  const expected = crypto.createHmac('sha256', getConfig().sessionSecret).update(body).digest('base64url');
  const a = Buffer.from(mac || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function middleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const payload = unsign(cookies[COOKIE]) || {};
  // A session can be held either by an account or by the bare owner passcode.
  // An account whose user was since deleted stops counting immediately.
  const user = payload.u ? users.byId(payload.u) : null;
  req.session = {
    owner: !!payload.o || !!user,
    user: users.publicView(user),
    shares: Array.isArray(payload.s) ? payload.s : [],
  };
  res.setSession = (next2) => {
    const value = sign({
      o: next2.owner ? 1 : 0,
      u: next2.userId || undefined,
      s: next2.shares || [],
      exp: Date.now() + MAX_AGE_MS,
    });
    // Not marking Secure: this also has to work over plain http on the LAN.
    res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_MS / 1000}`);
    const signedIn = next2.userId ? users.byId(next2.userId) : null;
    req.session = {
      owner: !!next2.owner || !!signedIn,
      user: users.publicView(signedIn),
      shares: next2.shares || [],
    };
  };
  res.clearSession = () => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    req.session = { owner: false, user: null, shares: [] };
  };
  next();
}

function requireOwner(req, res, next) {
  if (!req.session.owner) return res.status(401).json({ error: 'Sign in required' });
  next();
}

/** For actions only the vault's owner may take, never a member account. */
function requireVaultOwner(req, res, next) {
  if (!req.session.owner) return res.status(401).json({ error: 'Sign in required' });
  if (req.session.user && req.session.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only the vault owner can do that' });
  }
  next();
}

module.exports = { middleware, requireOwner, requireVaultOwner, COOKIE };
