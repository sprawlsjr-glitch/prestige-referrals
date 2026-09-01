'use strict';
const DB = require('./db');
const A = require('./auth');
const Mail = require('./mail');
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

/* ------------------------------------------------------- referral codes
   A partner can rename their own code. Old codes keep working forever:
   they move to code_history, so links already texted out and graphics
   already printed never go dead. Attribution is by user id, so renaming
   never touches a lead that already exists. */

const RESERVED = new Set([
  'ADMIN', 'OWNER', 'PARTNER', 'PRESTIGE', 'BOOK', 'BOOKING', 'LOGIN',
  'LOGOUT', 'SETUP', 'ASSET', 'ASSETS', 'SETTINGS', 'NULL', 'UNDEFINED',
]);

const CODE_MIN = 3;
const CODE_MAX = 20;

/** Letters and digits only, uppercased — keeps the /r/CODE link clean. */
function normalizeCode(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_MAX);
}

/** Any partner reachable by this code — current or retired. */
function partnerByCode(raw) {
  const code = normalizeCode(raw);
  if (!code) return null;
  const now = q.get("SELECT * FROM users WHERE code = ? AND role = 'partner'", code);
  if (now) return now;
  const old = q.get('SELECT user_id FROM code_history WHERE code = ?', code);
  return old ? q.get("SELECT * FROM users WHERE id = ? AND role = 'partner'", old.user_id) : null;
}

/** { code } when it can be used by userId, { error } with a human reason. */
function checkCode(raw, userId) {
  const code = normalizeCode(raw);
  if (code.length < CODE_MIN) return { error: 'Codes need at least ' + CODE_MIN + ' letters or numbers.' };
  if (/^[0-9]+$/.test(code)) return { error: 'Use at least one letter so it is not mistaken for a phone number.' };
  if (RESERVED.has(code)) return { error: '“' + code + '” is reserved. Pick another one.' };
  if (q.get('SELECT id FROM users WHERE code = ? AND id <> ?', code, userId)) {
    return { error: 'Another partner already uses “' + code + '”.' };
  }
  if (q.get('SELECT code FROM code_history WHERE code = ? AND user_id <> ?', code, userId)) {
    return { error: '“' + code + '” used to belong to another partner, so it stays with them.' };
  }
  return { code };
}

/** Renames a partner's code, retiring the old one so it still resolves. */
function setPartnerCode(user, raw) {
  const v = checkCode(raw, user.id);
  if (v.error) return v;
  const current = normalizeCode(user.code);
  if (v.code === current) return { code: v.code, unchanged: true };
  DB.tx(() => {
    // Taking back one of their own retired codes: it stops being retired.
    q.run('DELETE FROM code_history WHERE code = ? AND user_id = ?', v.code, user.id);
    if (current) {
      q.run(`INSERT INTO code_history (code,user_id,retired_at) VALUES (?,?,?)
             ON CONFLICT(code) DO UPDATE SET user_id=excluded.user_id, retired_at=excluded.retired_at`,
        current, user.id, new Date().toISOString());
    }
    q.run('UPDATE users SET code = ? WHERE id = ?', v.code, user.id);
  });
  return { code: v.code, previous: current };
}

/** Retired codes for a partner, newest first — shown so they know they still work. */
function retiredCodes(userId) {
  return q.all('SELECT code FROM code_history WHERE user_id = ? ORDER BY retired_at DESC', userId)
    .map(r => r.code);
}

/* ------------------------------------------------------ partner invites
   One place that knows what an invite link says, so the email and the
   text message the owner sends are word for word the same. */

function inviteMessage(settings, partner, token) {
  const url = (settings.base_url || '') + '/invite/' + token;
  const shop = settings.business_name || 'Prestige Mobile Cleaning';
  const first = String(partner.name || '').split(' ')[0];
  return {
    url,
    subject: 'Your ' + shop + ' partner sign-in',
    text: 'Hey ' + first + " — you're set up as a referral partner for " + shop + '.\n\n'
        + 'Open this link to pick your password and get your referral code:\n' + url + '\n\n'
        + 'The link works once and expires in ' + A.INVITE_DAYS + ' days. '
        + 'Questions: ' + (settings.phone || '') ,
  };
}

/** Emails the invite when email is switched on. Returns what happened so the
    owner is told the truth either way — the link is shown regardless. */
async function emailInvite(settings, partner, token) {
  if (!Mail.enabled()) return { sent: false, reason: 'off' };
  if (!partner.email) return { sent: false, reason: 'no_email' };
  if (!settings.mail_from) return { sent: false, reason: 'no_sender' };
  const m = inviteMessage(settings, partner, token);
  const res = await Mail.send({
    from: settings.mail_from,
    replyTo: settings.mail_reply_to || '',
    to: partner.email,
    subject: m.subject,
    text: m.text,
  });
  return res.ok ? { sent: true } : { sent: false, reason: res.error };
}

module.exports = { PORT, SECURE, settingsFor, servicesList, partnerOf, attachPartners, ownerExists, setCookieFor,
  normalizeCode, partnerByCode, checkCode, setPartnerCode, retiredCodes,
  inviteMessage, emailInvite };
