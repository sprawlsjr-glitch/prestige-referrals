'use strict';
const crypto = require('node:crypto');
const { q } = require('./db');

const SESSION_DAYS = 30;
const COOKIE = 'pmc_session';

/* ------------------------------------------------------------------ ids */

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(9).toString('base64url');
}

/* ------------------------------------------------------------- passwords */
// scrypt from node:crypto — no dependency, and the comparison is constant-time.

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(plain), salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$16384$8$1$' + salt.toString('base64') + '$' + key.toString('base64');
}

function verifyPassword(plain, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    const actual = crypto.scryptSync(String(plain), salt, expected.length, { N, r, p });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (e) { return false; }
}

/* -------------------------------------------------------------- sessions */

function createSession(userId) {
  const id = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 864e5);
  q.run('INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)',
    id, userId, now.toISOString(), exp.toISOString());
  return { id, expires: exp };
}

function userForSession(sessionId) {
  if (!sessionId) return null;
  const row = q.get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`,
    sessionId, new Date().toISOString()
  );
  return row || null;
}

function destroySession(sessionId) {
  if (sessionId) q.run('DELETE FROM sessions WHERE id = ?', sessionId);
}

function destroyAllSessions(userId) {
  q.run('DELETE FROM sessions WHERE user_id = ?', userId);
}

function purgeExpiredSessions() {
  q.run('DELETE FROM sessions WHERE expires_at <= ?', new Date().toISOString());
}

/* --------------------------------------------------------------- cookies */

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(id, expires, secure) {
  const bits = [
    COOKIE + '=' + encodeURIComponent(id),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=' + expires.toUTCString(),
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

function clearCookie(secure) {
  const bits = [COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/* ----------------------------------------------------------------- codes */

function slugFirstWord(name) {
  const w = String(name || 'crew').trim().split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return (w || 'CREW').slice(0, 10);
}

function makeCode(name) {
  const base = slugFirstWord(name);
  for (let i = 0; i < 80; i++) {
    const c = base + String(Math.floor(Math.random() * 90) + 10);
    if (!q.get('SELECT id FROM users WHERE code = ?', c)) return c;
  }
  return base + Date.now().toString(36).slice(-4).toUpperCase();
}

/* ------------------------------------------------------------ rate limit */
// Small in-memory guard so a stolen link can't be brute-forced.

const attempts = new Map();

function tooManyAttempts(key, limit = 8, windowMs = 15 * 60e3) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.start > windowMs) { attempts.set(key, { start: now, n: 1 }); return false; }
  rec.n += 1;
  return rec.n > limit;
}

function clearAttempts(key) { attempts.delete(key); }

/* ------------------------------------------------------------- invites
   A partner is invited with a one-time link instead of a password, so a
   password is never texted or emailed to anyone. Only the hash is stored:
   the link itself exists once, in the message the owner sends. */

const INVITE_DAYS = 14;

function inviteHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createInvite(userId) {
  const token = crypto.randomBytes(24).toString('base64url');
  const now = new Date();
  const exp = new Date(now.getTime() + INVITE_DAYS * 864e5);
  q.run('DELETE FROM invites WHERE user_id = ? AND used_at IS NULL', userId);
  q.run('INSERT INTO invites (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)',
    inviteHash(token), userId, now.toISOString(), exp.toISOString());
  return { token, expires: exp };
}

/** The partner an unused, unexpired invite belongs to — or null. */
function userForInvite(token) {
  if (!token) return null;
  const row = q.get('SELECT * FROM invites WHERE token_hash = ?', inviteHash(token));
  if (!row || row.used_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return q.get("SELECT * FROM users WHERE id = ? AND role = 'partner'", row.user_id);
}

function useInvite(token) {
  q.run('UPDATE invites SET used_at = ? WHERE token_hash = ?', new Date().toISOString(), inviteHash(token));
}

module.exports = {
  COOKIE, newId, hashPassword, verifyPassword,
  createSession, userForSession, destroySession, destroyAllSessions, purgeExpiredSessions,
  parseCookies, sessionCookie, clearCookie,
  makeCode, tooManyAttempts, clearAttempts,
  createInvite, userForInvite, useInvite, INVITE_DAYS,
};
