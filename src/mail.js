'use strict';

/* Outbound email through Resend's HTTP API. No package to install — Node's
   own fetch does the work, so the zero-dependency build survives.

   The API key lives in RESEND_API_KEY (an environment variable, never the
   repo). With no key the app simply doesn't send, and every screen falls
   back to the owner sending the link themselves. */

const ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10000;

let request = (url, init) => fetch(url, init);      // swapped out in tests

function enabled() {
  return !!String(process.env.RESEND_API_KEY || '').trim();
}

/** A plain-text body rendered as simple, readable HTML. */
function asHtml(text) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linked = esc(text).replace(/(https?:\/\/[^\s<]+)/g,
    '<a href="$1" style="color:#13629A">$1</a>');
  return '<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#0B1030">'
       + linked.split('\n\n').map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('')
       + '</div>';
}

/**
 * Sends one email. Never throws: returns { ok } or { ok:false, error } so a
 * failed send can be shown to the owner instead of taking a page down.
 */
async function send({ from, replyTo, to, subject, text }) {
  if (!enabled()) return { ok: false, error: 'no_key' };
  if (!to) return { ok: false, error: 'no_recipient' };
  if (!from) return { ok: false, error: 'no_sender' };

  const body = { from, to: [to], subject, text, html: asHtml(text) };
  if (replyTo) body.reply_to = replyTo;

  try {
    const res = await request(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + String(process.env.RESEND_API_KEY).trim(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch (e) { /* body not JSON */ }
    return { ok: false, error: detail || ('http_' + res.status) };
  } catch (e) {
    return { ok: false, error: e && e.name === 'TimeoutError' ? 'timed_out' : String(e && e.message || e) };
  }
}

/** Test seam — lets the suite prove the wiring without touching the network. */
function __setRequest(fn) { request = fn || ((url, init) => fetch(url, init)); }

module.exports = { enabled, send, asHtml, __setRequest, ENDPOINT };
