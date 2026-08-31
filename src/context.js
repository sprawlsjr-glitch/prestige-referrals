'use strict';
const DB = require('./db');
const A = require('./auth');
const { q } = DB;

const PORT = Number(process.env.PORT) || 3000;
const SECURE = process.env.NODE_ENV === 'production';

function settingsFor(req) {
  const s = DB.getSettings();
  if (!s.base_url) {
    const proto = String(req.headers['x-forwarded-proto'] || (SECURE ? 'https' : 'http')).split(',')[0];
    s.base_url = proto + '://' + (req.headers.host || 'localhost:' + PORT);
  }
  return s;
}

function servicesList() {
  return q.all('SELECT * FROM services WHERE archived = 0 ORDER BY sort, name');
}

function partnerOf(lead) {
  return lead && lead.partner_id ? q.get('SELECT * FROM users WHERE id = ?', lead.partner_id) : null;
}

/** Hydrates leads with their partner in one pass, so views never query. */
function attachPartners(leads) {
  const cache = new Map();
  for (const l of leads) {
    if (!l.partner_id) { l._partner = null; continue; }
    if (!cache.has(l.partner_id)) cache.set(l.partner_id, q.get('SELECT * FROM users WHERE id = ?', l.partner_id));
    l._partner = cache.get(l.partner_id);
  }
  return leads;
}

function ownerExists() { return !!q.get("SELECT id FROM users WHERE role = 'owner' LIMIT 1"); }

function setCookieFor(userId) {
  const sess = A.createSession(userId);
  return A.sessionCookie(sess.id, sess.expires, SECURE);
}

module.exports = { PORT, SECURE, settingsFor, servicesList, partnerOf, attachPartners, ownerExists, setCookieFor };
