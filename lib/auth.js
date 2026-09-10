'use strict';
const crypto = require('crypto');
const { getConfig } = require('./config');

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
  req.session = { owner: !!payload.o, shares: Array.isArray(payload.s) ? payload.s : [] };
  res.setSession = (next2) => {
    const value = sign({ o: next2.owner ? 1 : 0, s: next2.shares || [], exp: Date.now() + MAX_AGE_MS });
    // Not marking Secure: this also has to work over plain http on the LAN.
    res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_MS / 1000}`);
    req.session = { owner: !!next2.owner, shares: next2.shares || [] };
  };
  res.clearSession = () => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    req.session = { owner: false, shares: [] };
  };
  next();
}

function requireOwner(req, res, next) {
  if (!req.session.owner) return res.status(401).json({ error: 'Owner passcode required' });
  next();
}

module.exports = { middleware, requireOwner, COOKIE };
