'use strict';
const http = require('node:http');

const DB = require('./db');
const A = require('./auth');
const H = require('./http');
const C = require('./context');
const Router = require('./router');
const Layout = require('./views/layout');

const { q } = DB;

// Route tables register themselves on import.
require('./routes/public');
require('./routes/owner');
require('./routes/partner');

function boot() {
  DB.open(process.env.DB_FILE);
  DB.seedServices(A.newId);
  DB.syncServices(A.newId);
  DB.seedAssets(A.newId);
  A.purgeExpiredSessions();

  if (!C.ownerExists() && process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD) {
    q.run('INSERT INTO users (id,role,email,password_hash,name,created_at) VALUES (?,?,?,?,?,?)',
      A.newId('u'), 'owner', String(process.env.OWNER_EMAIL).trim().toLowerCase(),
      A.hashPassword(process.env.OWNER_PASSWORD), process.env.OWNER_NAME || 'Owner',
      new Date().toISOString());
    console.log('Created owner account for', process.env.OWNER_EMAIL);
  }
}

/** A POST from another origin is refused outright — with SameSite=Lax cookies
 *  that closes the CSRF gap without a token round-trip on every form. */
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://placeholder');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'POST' && !sameOrigin(req)) return H.html(res, 'Bad origin', 403);
  if (req.method !== 'GET' && req.method !== 'POST') return H.html(res, 'Method not allowed', 405);

  const hit = Router.match(req.method, path);
  if (!hit) {
    return H.notFound(res, Layout.page({
      title: 'Not found',
      body: `<div class="gate"><div class="card pad"><h3 style="font-size:17px">Not found</h3>
        <p class="small muted">That page doesn't exist.</p>
        <a class="btn full" href="/" style="margin-top:10px">Go home</a></div></div>`,
    }));
  }

  const user = A.userForSession(A.parseCookies(req.headers.cookie)[A.COOKIE]);
  const g = hit.route.guard;
  if (g === 'owner' && (!user || user.role !== 'owner')) return H.redirect(res, '/login');
  if (g === 'partner' && (!user || user.role !== 'partner')) return H.redirect(res, '/login');
  if (g === 'any' && !user) return H.redirect(res, '/login');

  const ctx = { req, res, url, user, settings: C.settingsFor(req), flash: '' };
  return hit.route.handler(ctx, hit.params);
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (err && err.code === 'TOO_LARGE') {
        if (!res.headersSent) H.html(res, 'That upload was too large.', 413);
        return res.end();
      }
      console.error('request failed:', req.method, req.url, err && err.stack || err);
      if (!res.headersSent) {
        H.html(res, Layout.page({
          title: 'Something went wrong',
          body: `<div class="gate"><div class="card pad"><h3 style="font-size:17px">Something went wrong</h3>
            <p class="small muted">Try again in a moment. If it keeps happening, call the shop.</p></div></div>`,
        }), 500);
      } else { res.end(); }
    });
  });
}

module.exports = { boot, handle, createServer };

if (require.main === module) {
  boot();
  createServer().listen(C.PORT, () => {
    console.log('Prestige Referrals listening on :' + C.PORT);
  });
}
