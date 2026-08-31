'use strict';

const MAX_BODY = 12 * 1024 * 1024; // 12MB — covers a batch of marketing images

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseForm(req) {
  const ctype = String(req.headers['content-type'] || '');
  const raw = await readBody(req);
  if (ctype.startsWith('multipart/form-data')) return parseMultipart(raw, ctype);
  const fields = {};
  for (const [k, v] of new URLSearchParams(raw.toString('utf8'))) fields[k] = v;
  return { fields, files: [] };
}

/** Minimal multipart/form-data parser — enough for file uploads from a browser form. */
function parseMultipart(buf, ctype) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
  if (!m) return { fields: {}, files: [] };
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const fields = {}, files = [];

  let pos = buf.indexOf(boundary);
  if (pos < 0) return { fields, files };
  pos += boundary.length;

  while (pos < buf.length) {
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break;      // trailing "--"
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;   // CRLF after boundary

    const headEnd = buf.indexOf('\r\n\r\n', pos, 'utf8');
    if (headEnd < 0) break;
    const head = buf.toString('utf8', pos, headEnd);
    const bodyStart = headEnd + 4;

    let next = buf.indexOf(boundary, bodyStart);
    if (next < 0) next = buf.length;
    let bodyEnd = next;
    if (buf[bodyEnd - 2] === 0x0d && buf[bodyEnd - 1] === 0x0a) bodyEnd -= 2; // strip CRLF

    const nameM = /name="([^"]*)"/i.exec(head);
    const fileM = /filename="([^"]*)"/i.exec(head);
    const typeM = /content-type:\s*([^\r\n;]+)/i.exec(head);
    const name = nameM ? nameM[1] : '';

    if (fileM && fileM[1]) {
      files.push({
        field: name,
        filename: fileM[1].replace(/[\\/]/g, '_').slice(0, 180),
        contentType: (typeM ? typeM[1].trim() : 'application/octet-stream').toLowerCase(),
        data: buf.subarray(bodyStart, bodyEnd),
      });
    } else if (name) {
      fields[name] = buf.toString('utf8', bodyStart, bodyEnd);
    }
    pos = next + boundary.length;
  }
  return { fields, files };
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function send(res, status, body, headers) {
  const h = Object.assign({}, SECURITY_HEADERS, headers || {});
  res.writeHead(status, h);
  res.end(body);
}

function html(res, body, status, headers) {
  send(res, status || 200, body, Object.assign(
    { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
}

function redirect(res, to, headers) {
  send(res, 302, '', Object.assign({ Location: to, 'Cache-Control': 'no-store' }, headers || {}));
}

function notFound(res, body) {
  html(res, body || '<h1>Not found</h1>', 404);
}

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function fdate(s) {
  if (!s) return '—';
  const p = String(s).slice(0, 10).split('-');
  if (p.length < 3) return s;
  return (+p[1]) + '/' + (+p[2]) + '/' + p[0].slice(2);
}

function clean(v, max = 400) {
  // strip control characters only; leave ordinary text alone
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Payment deep links. Neither company documents these, so they're built
 *  defensively: the UI always shows the amount so a broken prefill is survivable. */
function payLink(handle, amount, note) {
  const h = String(handle || '').trim();
  if (!h) return null;
  const amt = (Math.round((Number(amount) || 0) * 100) / 100).toFixed(2);
  if (h[0] === '$') {
    const tag = h.slice(1).replace(/[^A-Za-z0-9_]/g, '');
    return tag ? { app: 'Cash App', url: 'https://cash.app/$' + tag + '/' + amt } : null;
  }
  const u = h.replace(/^@/, '').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!u) return null;
  return {
    app: 'Venmo',
    url: 'https://venmo.com/?txn=pay&audience=private&recipients=' + encodeURIComponent(u) +
         '&amount=' + amt + '&note=' + encodeURIComponent(note || ''),
  };
}

module.exports = { esc, readBody, parseForm, parseMultipart, send, html, redirect, notFound, today, fdate, clean, num, payLink, MAX_BODY };
