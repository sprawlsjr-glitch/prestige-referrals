'use strict';
const { get, post } = require('../router');
const { q } = require('../db');
const A = require('../auth');
const H = require('../http');
const C = require('../context');
const Layout = require('../views/layout');
const Pub = require('../views/public');

get('/', ctx => {
  if (ctx.user) return H.redirect(ctx.res, ctx.user.role === 'owner' ? '/owner' : '/partner');
  if (!C.ownerExists()) return H.redirect(ctx.res, '/setup');
  H.html(ctx.res, Pub.landing(ctx.settings, ctx.url.searchParams.get('e')));
});

get('/healthz', ctx => H.send(ctx.res, 200, 'ok', { 'Content-Type': 'text/plain' }));

/* ----------------------------------------------------------------- setup */

get('/setup', ctx => {
  if (C.ownerExists()) return H.redirect(ctx.res, '/login');
  H.html(ctx.res, Layout.page({
    title: 'Set up',
    body: `<div class="gate"><div class="card pad">
      <h3 style="font-size:17px;margin-bottom:10px">Create the owner account</h3>
      <form method="post" action="/setup">
        <label class="f"><span>Your name</span><input type="text" name="name" required></label>
        <label class="f"><span>Email</span><input type="email" name="email" required></label>
        <label class="f"><span>Password</span><input type="password" name="password" required minlength="8"></label>
        <button class="btn pri full">Create account</button></form>
      <p class="hint" style="margin-top:10px">This screen disappears once an owner exists.</p></div></div>`,
  }));
});

post('/setup', async ctx => {
  if (C.ownerExists()) return H.redirect(ctx.res, '/login');
  const { fields } = await H.parseForm(ctx.req);
  const email = H.clean(fields.email, 200).toLowerCase();
  const pw = String(fields.password || '');
  if (!email || pw.length < 8) return H.redirect(ctx.res, '/setup');
  const id = A.newId('u');
  q.run('INSERT INTO users (id,role,email,password_hash,name,created_at) VALUES (?,?,?,?,?,?)',
    id, 'owner', email, A.hashPassword(pw), H.clean(fields.name, 120) || 'Owner', new Date().toISOString());
  H.redirect(ctx.res, '/owner', { 'Set-Cookie': C.setCookieFor(id) });
});

/* ---------------------------------------------------------------- invite
   The link the owner sends a new partner. They pick their own password
   here; nobody ever has to send a password in a text message. */

function invitePage(ctx, token, name, err) {
  return Layout.page({
    title: 'Set your password',
    body: `<div class="gate"><div class="card pad">
      <h3 style="font-size:17px;margin-bottom:2px">Welcome${name ? ', ' + H.esc(String(name).split(' ')[0]) : ''}</h3>
      <p class="small muted" style="margin:0 0 12px">Pick a password and you're in.</p>
      ${err ? Layout.flash('bad', err) : ''}
      <form method="post" action="/invite/${H.esc(token)}">
        <label class="f"><span>Choose a password</span>
          <input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
        <button class="btn pri full">Set my password</button></form>
      <p class="hint" style="margin-top:10px">This link works once, and only for you.</p></div></div>`,
  });
}

function inviteExpired() {
  return Layout.page({
    title: 'Link expired',
    body: `<div class="gate"><div class="card pad">
      <h3 style="font-size:17px">That link has expired</h3>
      <p class="small muted">Invite links last ${A.INVITE_DAYS} days and work once. Ask the shop to send you a fresh one.</p>
      <a class="btn full" href="/login" style="margin-top:10px">Go to sign in</a></div></div>`,
  });
}

get('/invite/:token', (ctx, params) => {
  const u = A.userForInvite(params.token);
  if (!u) return H.html(ctx.res, inviteExpired(), 410);
  H.html(ctx.res, invitePage(ctx, params.token, u.name, ''));
});

post('/invite/:token', async (ctx, params) => {
  const u = A.userForInvite(params.token);
  if (!u) return H.html(ctx.res, inviteExpired(), 410);
  const { fields } = await H.parseForm(ctx.req);
  const pw = String(fields.password || '');
  if (pw.length < 8) {
    return H.html(ctx.res, invitePage(ctx, params.token, u.name, 'Password needs at least 8 characters.'), 400);
  }
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', A.hashPassword(pw), u.id);
  A.useInvite(params.token);
  A.destroyAllSessions(u.id);
  H.redirect(ctx.res, '/partner', { 'Set-Cookie': C.setCookieFor(u.id) });
});

/* ----------------------------------------------------------------- login */

get('/login', ctx => {
  if (ctx.user) return H.redirect(ctx.res, ctx.user.role === 'owner' ? '/owner' : '/partner');
  if (!C.ownerExists()) return H.redirect(ctx.res, '/setup');
  H.html(ctx.res, Pub.login(ctx.settings, ctx.url.searchParams.get('e')));
});

post('/login', async ctx => {
  const { fields } = await H.parseForm(ctx.req);
  const email = H.clean(fields.email, 200).toLowerCase();
  const ip = ctx.req.socket.remoteAddress || 'x';
  if (A.tooManyAttempts('login:' + ip)) {
    return H.html(ctx.res, Pub.login(ctx.settings, 'Too many attempts. Wait a few minutes and try again.', email), 429);
  }
  const u = q.get('SELECT * FROM users WHERE email = ?', email);
  if (!u || !A.verifyPassword(fields.password || '', u.password_hash)) {
    return H.html(ctx.res, Pub.login(ctx.settings, "That email and password don't match.", email), 401);
  }
  if (u.role === 'partner' && u.status === 'paused') {
    return H.html(ctx.res, Pub.login(ctx.settings, 'That account is paused. Reach out to the shop.', email), 403);
  }
  A.clearAttempts('login:' + ip);
  q.run('UPDATE users SET last_login_at = ? WHERE id = ?', new Date().toISOString(), u.id);
  H.redirect(ctx.res, u.role === 'owner' ? '/owner' : '/partner', { 'Set-Cookie': C.setCookieFor(u.id) });
});

post('/logout', ctx => {
  A.destroySession(A.parseCookies(ctx.req.headers.cookie)[A.COOKIE]);
  H.redirect(ctx.res, '/', { 'Set-Cookie': A.clearCookie(C.SECURE) });
});

/* --------------------------------------------------------------- booking */

get('/book', ctx => {
  H.html(ctx.res, Pub.bookForm(ctx.settings, C.servicesList(), {
    code: H.clean(ctx.url.searchParams.get('code'), 40).toUpperCase(),
    err: ctx.url.searchParams.get('e') || '',
  }));
});

// Per-partner booking link. This is what makes attribution airtight:
// the code is filled in before the customer touches anything.
get('/r/:code', (ctx, params) => {
  const p = C.partnerByCode(params.code);
  if (p && p.status === 'paused') return H.redirect(ctx.res, '/book');
  if (!p) return H.redirect(ctx.res, '/book');
  H.html(ctx.res, Pub.bookForm(ctx.settings, C.servicesList(), { code: p.code, partnerName: p.name }));
});

post('/book', async ctx => {
  const { fields } = await H.parseForm(ctx.req);
  const s = ctx.settings;
  const codeIn = H.clean(fields.code, 40).toUpperCase();
  const customer = H.clean(fields.customer, 120);
  const phone = H.clean(fields.phone, 40);

  const back = err => H.html(ctx.res, Pub.bookForm(s, C.servicesList(), {
    err, code: codeIn, customer, phone,
    vehicle: H.clean(fields.vehicle, 160), address: H.clean(fields.address, 200),
    service: H.clean(fields.service, 120), notes: H.clean(fields.notes, 1000),
  }), 400);

  if (!customer || !phone) return back('We need a name and a phone number so we can confirm the appointment.');

  let partner = null;
  if (codeIn) {
    partner = C.partnerByCode(codeIn);
    if (!partner) return back('We don\u2019t recognize the code \u201c' + codeIn + '\u201d. Check the spelling, or leave it blank and continue.');
    if (partner.status === 'paused') partner = null;
  }

  q.run(`INSERT INTO leads (id,partner_id,customer,phone,vehicle,address,service,notes,source,status,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    A.newId('ld'), partner ? partner.id : null, customer, phone,
    H.clean(fields.vehicle, 160), H.clean(fields.address, 200),
    H.clean(fields.service, 120), H.clean(fields.notes, 1000),
    'booking', 'new', new Date().toISOString());

  H.html(ctx.res, Pub.booked(s, customer.split(/\s+/)[0], partner ? String(partner.name).split(' ')[0] : ''));
});

/* ----------------------------------------------------------------- apply */

get('/apply', ctx => H.html(ctx.res, Pub.applyForm(ctx.settings, ctx.url.searchParams.get('e'))));

post('/apply', async ctx => {
  const { fields } = await H.parseForm(ctx.req);
  const name = H.clean(fields.name, 120);
  const email = H.clean(fields.email, 200).toLowerCase();
  if (!name || !email) {
    return H.html(ctx.res, Pub.applyForm(ctx.settings, 'We need at least a name and an email.', fields), 400);
  }
  q.run('INSERT INTO applications (id,name,phone,email,why,created_at) VALUES (?,?,?,?,?,?)',
    A.newId('ap'), name, H.clean(fields.phone, 40), email, H.clean(fields.why, 1000), new Date().toISOString());
  H.html(ctx.res, Pub.applied(ctx.settings));
});

/* ------------------------------------------------------ shared, signed-in */

get('/asset/:id', (ctx, params) => {
  const a = q.get('SELECT * FROM assets WHERE id = ?', params.id);
  if (!a) return H.notFound(ctx.res);
  H.send(ctx.res, 200, Buffer.from(a.data), {
    'Content-Type': a.content_type,
    'Content-Length': String(a.bytes),
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': (ctx.url.searchParams.get('dl') ? 'attachment' : 'inline') +
      '; filename="' + String(a.filename).replace(/["\\]/g, '') + '"',
  });
}, 'any');

post('/account/password', async ctx => {
  const { fields } = await H.parseForm(ctx.req);
  const next = String(fields.next || '');
  const home = ctx.user.role === 'owner' ? '/owner/settings' : '/partner/earnings';
  if (!A.verifyPassword(fields.current || '', ctx.user.password_hash)) return H.redirect(ctx.res, home + '?e=wrong');
  if (next.length < 8) return H.redirect(ctx.res, home + '?e=short');
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', A.hashPassword(next), ctx.user.id);
  A.destroyAllSessions(ctx.user.id);           // sign every other device out
  H.redirect(ctx.res, home + '?ok=pw', { 'Set-Cookie': C.setCookieFor(ctx.user.id) });
}, 'any');
