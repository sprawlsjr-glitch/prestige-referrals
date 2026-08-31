'use strict';
process.env.DB_FILE = ':memory:';
const assert = require('node:assert');
const http = require('node:http');
const { boot, createServer } = require('../src/server');
const { q } = require('../src/db');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

/* ------------------------------------------------------------ tiny client */

function makeClient(port) {
  const jar = new Map();
  function cookieHeader() {
    return [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
  }
  function absorb(res) {
    const sc = res.headers['set-cookie'] || [];
    for (const c of sc) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (v === '' || /Max-Age=0/i.test(c)) jar.delete(k); else jar.set(k, v);
    }
  }
  function req(method, path, body, opts) {
    const o = opts || {};
    return new Promise((resolve, reject) => {
      const headers = Object.assign({ Host: '127.0.0.1:' + port }, o.headers || {});
      const cookies = cookieHeader();
      if (cookies && !o.noCookies) headers.Cookie = cookies;
      let payload = null;
      if (body != null) {
        if (Buffer.isBuffer(body)) { payload = body; }
        else { payload = Buffer.from(new URLSearchParams(body).toString());
               headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
        headers['Content-Length'] = payload.length;
        if (!headers.Origin && !o.noOrigin) headers.Origin = 'http://127.0.0.1:' + port;
      }
      const r = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          absorb(res);
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: buf.toString('utf8'), buf });
        });
      });
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
  }
  return {
    get: (p, o) => req('GET', p, null, o),
    post: (p, b, o) => req('POST', p, b, o),
    jar,
  };
}

function multipart(fields, files) {
  const b = '----pmcTEST' + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files || []) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`));
    parts.push(f.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(parts), ctype: 'multipart/form-data; boundary=' + b };
}

/* -------------------------------------------------------------------- run */

(async () => {
  boot();
  const server = createServer();
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const owner = makeClient(port);
  const partner = makeClient(port);
  const other = makeClient(port);
  const anon = makeClient(port);

  /* ---------------------------------------------------------------- setup */
  section('Setup & auth');
  let r = await anon.get('/');
  ok('first visit redirects to setup', r.status === 302 && r.headers.location === '/setup', r.status + ' ' + r.headers.location);

  r = await owner.post('/setup', { name: 'Melvin Sprawls', email: 'Owner@Prestige.US', password: 'longenough1' });
  ok('owner created and signed in', r.status === 302 && r.headers.location === '/owner');

  r = await anon.get('/setup');
  ok('setup closes once an owner exists', r.status === 302 && r.headers.location === '/login');

  r = await owner.get('/owner');
  ok('owner reaches the dashboard', r.status === 200 && r.body.includes('Needs a call'));

  const bad = makeClient(port);
  r = await bad.post('/login', { email: 'owner@prestige.us', password: 'wrongwrong' });
  ok('wrong password is refused', r.status === 401 && /don&#39;t match|don't match/.test(r.body));

  r = await bad.post('/login', { email: 'OWNER@prestige.us', password: 'longenough1' });
  ok('email is case-insensitive at login', r.status === 302 && r.headers.location === '/owner');

  /* -------------------------------------------------------------- partner */
  section('Partners');
  r = await owner.post('/owner/partners/new', {
    name: 'Melvin Sprawls', email: 'mel@partner.test', phone: '6787729746',
    pay_handle: '$melvin', password: 'partnerpass1',
  });
  ok('partner created', r.status === 302 && /\/owner\/partners\/u_/.test(r.headers.location), r.headers.location);
  const partnerId = r.headers.location.split('/').pop();
  const P = q.get('SELECT * FROM users WHERE id = ?', partnerId);
  ok('partner got a referral code', !!P.code && /^MELVIN\d\d$/.test(P.code), P.code);
  ok('password is hashed, not stored', !P.password_hash.includes('partnerpass1') && P.password_hash.startsWith('scrypt$'));

  r = await owner.post('/owner/partners/new', {
    name: 'Tasha Reed', email: 'tasha@partner.test', password: 'partnerpass2',
  });
  const otherId = r.headers.location.split('/').pop();
  const O = q.get('SELECT * FROM users WHERE id = ?', otherId);

  r = await owner.post('/owner/partners/new', { name: 'Dupe', email: 'mel@partner.test', password: 'partnerpass3' });
  ok('duplicate email refused', /e=email/.test(r.headers.location || ''), r.headers.location);

  /* -------------------------------------------------------------- booking */
  section('Customer booking & attribution');
  r = await anon.get('/r/' + P.code);
  ok('partner booking link prefills the code', r.status === 200 && r.body.includes('value="' + P.code + '"'));
  ok('booking link names the referrer', r.body.includes('Melvin Sprawls</strong> sent you'));

  r = await anon.get('/r/NOPE99');
  ok('unknown partner link falls back to the plain form', r.status === 302 && r.headers.location === '/book');

  r = await anon.post('/book', {
    code: P.code.toLowerCase(), customer: 'Dana Whitfield', phone: '770-555-0142',
    vehicle: '2019 Tahoe', address: 'Sandy Springs', service: 'Diamond Detail', notes: 'Dog hair',
  });
  ok('booking succeeds with a lowercase code', r.status === 200 && r.body.includes('Got it, Dana'));
  ok('confirmation names the referrer', r.body.includes('Melvin sent you'));
  const lead = q.get('SELECT * FROM leads WHERE customer = ?', 'Dana Whitfield');
  ok('lead attributed to the partner', lead.partner_id === partnerId);
  ok('lead tagged as a booking-page lead', lead.source === 'booking');

  r = await anon.post('/book', { code: 'BOGUS12', customer: 'X', phone: '1' });
  ok('unknown code is rejected, not silently dropped', r.status === 400 && r.body.includes('recognize the code'));

  r = await anon.post('/book', { customer: 'No Phone' });
  ok('missing phone is refused', r.status === 400 && r.body.includes('name and a phone'));

  r = await anon.post('/book', { customer: 'Walk In', phone: '770-555-0000', service: 'Silver Detail' });
  ok('code-free booking is accepted', r.status === 200);
  const direct = q.get('SELECT * FROM leads WHERE customer = ?', 'Walk In');
  ok('code-free booking is unattributed', direct.partner_id === null);

  /* ------------------------------------------------------ the payment gate */
  section('Commission is held until the customer pays');
  r = await owner.post('/owner/leads/' + lead.id + '', { status: 'completed', job_total: '600' });
  let L = q.get('SELECT * FROM leads WHERE id = ?', lead.id);
  ok('job done records the total', Number(L.job_total) === 600);
  ok('job done does NOT create a commission', L.commission === null, 'got ' + L.commission);

  r = await owner.get('/owner/payouts');
  ok('payouts shows nothing owed yet', r.body.includes('Nothing owed yet'));
  ok('payouts explains what unlocks it', r.body.includes('Customer paid'));

  r = await owner.post('/owner/leads/' + lead.id + '', { status: 'settled', job_total: '600' });
  L = q.get('SELECT * FROM leads WHERE id = ?', lead.id);
  ok('customer paid locks the commission at 10%', Number(L.commission) === 60, 'got ' + L.commission);
  ok('settled date recorded', !!L.settled_at);

  r = await owner.post('/owner/leads/' + direct.id + '', { status: 'settled', job_total: '300' });
  const D = q.get('SELECT * FROM leads WHERE id = ?', direct.id);
  ok('direct booking earns nobody a commission', Number(D.commission) === 0, 'got ' + D.commission);

  // rate change must not rewrite a locked debt
  await owner.post('/owner/settings/rates', { rate_mode: 'percent', rate_flat: '25', rate_percent: '25' });
  L = q.get('SELECT * FROM leads WHERE id = ?', lead.id);
  ok('raising the rate does not rewrite a locked commission', Number(L.commission) === 60, 'got ' + L.commission);
  await owner.post('/owner/settings/rates', { rate_mode: 'percent', rate_flat: '25', rate_percent: '10' });

  {
    const t = q.get('SELECT * FROM leads WHERE customer = ?', 'Walk In');
    await owner.post('/owner/leads/' + t.id, { status: 'completed', job_total: '415' });
    const after = q.get('SELECT * FROM leads WHERE id = ?', t.id);
    ok('a total typed while moving stage is the total that saves', Number(after.job_total) === 415, 'got ' + after.job_total);
    await owner.post('/owner/leads/' + t.id, { status: 'settled', job_total: '415' });
  }

  /* -------------------------------------------------------------- payouts */
  section('Payouts');
  r = await owner.get('/owner/payouts');
  ok('owed now shows on payouts', r.body.includes('$60'));
  r = await owner.get('/owner/payouts/' + partnerId);
  ok('pay screen offers a Cash App link with the amount', r.body.includes('cash.app/$melvin/60.00'), 'link missing');

  r = await owner.post('/owner/payouts/' + partnerId, { method: 'Cash App', paid_on: '2026-08-31' });
  ok('payout recorded', r.status === 302 && /ok=paid/.test(r.headers.location));
  L = q.get('SELECT * FROM leads WHERE id = ?', lead.id);
  ok('lead marked as paid out', !!L.payout_id);
  const po = q.get('SELECT * FROM payouts WHERE partner_id = ?', partnerId);
  ok('payout amount is right', Number(po.amount) === 60, 'got ' + po.amount);

  r = await owner.post('/owner/payouts/' + partnerId, { method: 'Cash App' });
  const poCount = q.get('SELECT COUNT(*) n FROM payouts WHERE partner_id = ?', partnerId).n;
  ok('paying twice does not double-pay', poCount === 1, 'payouts: ' + poCount);

  /* ------------------------------------------------------- partner portal */
  section('Partner portal');
  r = await partner.post('/login', { email: 'mel@partner.test', password: 'partnerpass1' });
  ok('partner signs in', r.status === 302 && r.headers.location === '/partner');

  // a second job, finished but unpaid, so held vs ready can be told apart
  await anon.post('/book', { code: P.code, customer: 'Ray Okafor', phone: '770-555-0199', service: 'Gold Detail' });
  const ray = q.get('SELECT * FROM leads WHERE customer = ?', 'Ray Okafor');
  await owner.post('/owner/leads/' + ray.id + '', { status: 'completed', job_total: '280' });

  r = await partner.get('/partner/earnings');
  ok('partner sees the held section', /customer hasn.t paid yet/i.test(r.body));
  ok('partner sees the held amount', r.body.includes('$28 held'));
  ok('partner sees payout history', r.body.includes('$60'));

  r = await partner.get('/partner');
  ok('partner home shows their booking link', r.body.includes('/r/' + P.code));

  r = await partner.post('/partner/new', { customer: 'Priya Nandan', phone: '770-555-0111', service: 'Silver Detail', best_time: 'Mornings' });
  ok('partner can submit a lead', r.status === 302 && /ok=sent/.test(r.headers.location));
  const priya = q.get('SELECT * FROM leads WHERE customer = ?', 'Priya Nandan');
  ok('partner-submitted lead is attributed to them', priya.partner_id === partnerId);
  ok('best time folded into notes', /Best time: Mornings/.test(priya.notes));

  /* ------------------------------------------------------ renaming a code */
  section('Partners can rename their code');
  const oldCode = P.code;

  r = await partner.post('/partner/code', { code: 'ab' });
  ok('too-short code refused', /codeerr=/.test(r.headers.location || ''));
  r = await partner.post('/partner/code', { code: '12345' });
  ok('digits-only code refused', /codeerr=/.test(r.headers.location || ''));
  r = await partner.post('/partner/code', { code: 'ADMIN' });
  ok('reserved code refused', /codeerr=/.test(r.headers.location || ''));

  r = await partner.post('/partner/code', { code: '  mel-detail 22 ' });
  ok('code renamed', r.status === 302 && /ok=code/.test(r.headers.location), r.headers.location);
  const renamed = q.get('SELECT * FROM users WHERE id = ?', partnerId);
  ok('punctuation and spaces stripped, uppercased', renamed.code === 'MELDETAIL22', renamed.code);

  r = await anon.get('/r/' + renamed.code);
  ok('new link works', r.status === 200 && r.body.includes('value="' + renamed.code + '"'));
  r = await anon.get('/r/' + oldCode);
  ok('old link still works', r.status === 200);

  const before = q.get('SELECT COUNT(*) n FROM leads WHERE partner_id = ?', partnerId).n;
  r = await anon.post('/book', { code: oldCode, customer: 'Late Flyer', phone: '770-555-0177' });
  const late = q.get('SELECT * FROM leads WHERE customer = ?', 'Late Flyer');
  ok('a booking on the retired code still pays the same partner', late && late.partner_id === partnerId);
  ok('earlier leads stayed attached through the rename',
     q.get('SELECT COUNT(*) n FROM leads WHERE partner_id = ?', partnerId).n === before + 1);

  r = await owner.post('/owner/partners/' + partnerId, { name: renamed.name, email: renamed.email, code: 'MELDETAIL22' });
  ok('owner saving the same code is a no-op', /ok=saved/.test(r.headers.location || ''));

  const second = q.get("SELECT id FROM users WHERE role='partner' AND id <> ?", partnerId);
  if (second) {
    r = await owner.post('/owner/partners/' + second.id, { code: oldCode, name: 'x', email: 'second@partner.test' });
    ok('a retired code cannot be handed to someone else', /codeerr=/.test(r.headers.location || ''));
  }

  r = await partner.post('/partner/code', { code: oldCode });
  ok('a partner can take their own old code back', /ok=code/.test(r.headers.location || ''));
  ok('and it is theirs again', q.get('SELECT code FROM users WHERE id = ?', partnerId).code === oldCode);
  ok('the code they just left keeps working',
     !!q.get('SELECT code FROM code_history WHERE code = ? AND user_id = ?', 'MELDETAIL22', partnerId));

  /* ------------------------------------------------------------- security */
  section('Access control');
  r = await partner.get('/owner');
  ok('partner cannot open the owner dashboard', r.status === 302 && r.headers.location === '/login');
  r = await partner.get('/owner/partners');
  ok('partner cannot list partners', r.status === 302);
  r = await partner.post('/owner/payouts/' + partnerId, { method: 'Cash App' });
  ok('partner cannot pay themselves', r.status === 302 && r.headers.location === '/login');

  r = await anon.get('/partner');
  ok('signed-out visitor cannot open the portal', r.status === 302 && r.headers.location === '/login');
  r = await anon.get('/owner/leads');
  ok('signed-out visitor cannot read leads', r.status === 302 && r.headers.location === '/login');

  await other.post('/login', { email: 'tasha@partner.test', password: 'partnerpass2' });
  r = await other.get('/partner/leads');
  ok('a partner sees none of another partner\'s leads',
    !r.body.includes('Dana Whitfield') && !r.body.includes('Ray Okafor'));
  r = await other.get('/partner/earnings');
  ok('a partner sees none of another partner\'s money', !r.body.includes('$60'));

  r = await owner.post('/login', { email: 'x', password: 'y' }, { headers: { Origin: 'https://evil.example' } });
  ok('cross-origin POST is refused', r.status === 403);

  /* --------------------------------------------------------------- assets */
  section('Marketing materials');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  let mp = multipart({ title: 'Instagram post' }, [{ field: 'files', filename: 'post.png', type: 'image/png', data: png }]);
  r = await owner.post('/owner/assets', mp.body, { headers: { 'Content-Type': mp.ctype } });
  ok('owner can upload a graphic', r.status === 302 && /ok=uploaded/.test(r.headers.location), r.headers.location);
  const asset = q.get("SELECT * FROM assets WHERE filename = 'post.png'");
  ok('asset stored with its bytes intact', asset && asset.bytes === png.length && Buffer.from(asset.data).equals(png));

  mp = multipart({}, [{ field: 'files', filename: 'x.exe', type: 'application/x-msdownload', data: Buffer.from('MZ') }]);
  r = await owner.post('/owner/assets', mp.body, { headers: { 'Content-Type': mp.ctype } });
  ok('executable upload refused', /e=type/.test(r.headers.location || ''));

  r = await partner.get('/partner/assets');
  ok('partner sees the materials', r.body.includes('Instagram post'));
  r = await partner.get('/asset/' + asset.id + '?dl=1');
  ok('partner can download it', r.status === 200 && r.buf.equals(png));
  ok('download sends an attachment header', /attachment/.test(r.headers['content-disposition'] || ''));
  r = await anon.get('/asset/' + asset.id);
  ok('signed-out visitor cannot download materials', r.status === 302);

  /* ------------------------------------------- the code goes on the image */
  /* --------------------------------------------- upgrading a live database */
  section('Upgrading a database from the previous release');
  {
    // Exactly what production looked like before this release: seeded_assets
    // was created outside the migration list, so the row that records it is
    // missing. Re-running migrations must not blow up on it.
    const { DatabaseSync } = require('node:sqlite');
    const older = new DatabaseSync(':memory:');
    const MIG = require('../src/db').MIGRATIONS;
    older.exec('CREATE TABLE _migrations (n INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (let i = 0; i < MIG.length; i++) {
      if (/seeded_assets|code_history/.test(MIG[i])) continue;   // the new ones
      older.exec(MIG[i]);
      older.prepare('INSERT INTO _migrations (n, applied_at) VALUES (?,?)').run(i, new Date().toISOString());
    }
    older.exec('CREATE TABLE seeded_assets (filename TEXT PRIMARY KEY, seeded_at TEXT NOT NULL)');

    let upgradeError = null;
    try {
      const done = new Set(older.prepare('SELECT n FROM _migrations').all().map(r => r.n));
      for (let i = 0; i < MIG.length; i++) {
        if (done.has(i)) continue;
        older.exec(MIG[i]);
        older.prepare('INSERT INTO _migrations (n, applied_at) VALUES (?,?)').run(i, new Date().toISOString());
      }
    } catch (e) { upgradeError = e; }

    ok('a database carrying seeded_assets from the old release still upgrades',
       upgradeError === null, upgradeError && upgradeError.message);
    ok('the upgrade adds the table the new release needs',
       !!older.prepare("SELECT name FROM sqlite_master WHERE name='code_history'").get());
    older.close();
  }

  section('Graphics carry the partner\u2019s own code');
  const CREATIVES = require('../src/creatives');
  const bundled = q.all("SELECT filename FROM assets WHERE filename LIKE '0%'").map(a => a.filename);
  ok('every graphic that ships with the app has a code plate',
     bundled.length === 6 && bundled.every(f => !!CREATIVES.plateFor(f)), bundled.join(','));
  ok('a plate sits inside the image it belongs to', Object.values(CREATIVES.PLATES).every(c =>
     c.plate.x >= 0 && c.plate.y >= 0 && c.plate.x + c.plate.w <= c.w && c.plate.y + c.plate.h <= c.h));

  r = await partner.get('/partner/assets');
  const myCode = q.get('SELECT code FROM users WHERE id = ?', partnerId).code;
  ok('each shipped graphic is marked for stamping', (r.body.match(/<div class="asset" data-plate=/g) || []).length === 6,
     String((r.body.match(/data-plate/g) || []).length));
  ok('the stamping runs in the partner\u2019s browser, not on the server', r.body.includes('getContext'));
  ok('the download is named with their code', r.body.includes('-' + myCode + '.png'));
  ok('the page tells them whose code is on it', r.body.includes(myCode));
  ok('an uploaded file with no plate keeps a plain download',
     /Download<\/a>/.test(r.body) && r.body.includes('Download with my code'));

  /* ------------------------------------------------------------ passwords */
  section('Passwords');
  r = await partner.post('/account/password', { current: 'nope', next: 'brandnewpass1' });
  ok('wrong current password refused', /e=wrong/.test(r.headers.location || ''));
  r = await partner.post('/account/password', { current: 'partnerpass1', next: 'short' });
  ok('short password refused', /e=short/.test(r.headers.location || ''));
  r = await partner.post('/account/password', { current: 'partnerpass1', next: 'brandnewpass1' });
  ok('password changed', /ok=pw/.test(r.headers.location || ''));
  const stale = makeClient(port);
  await stale.post('/login', { email: 'mel@partner.test', password: 'partnerpass1' });
  r = await stale.get('/partner');
  ok('old password no longer works', r.status === 302 && r.headers.location === '/login');
  r = await partner.get('/partner');
  ok('changing password keeps you signed in on this device', r.status === 200);

  /* ------------------------------------------------------------ rendering */
  section('Pages render');
  for (const [label, path, client] of [
    ['landing', '/', anon], ['book', '/book', anon], ['apply', '/apply', anon], ['login', '/login', anon],
    ['owner overview', '/owner', owner], ['owner leads', '/owner/leads', owner],
    ['owner partners', '/owner/partners', owner], ['owner payouts', '/owner/payouts', owner],
    ['owner settings', '/owner/settings', owner], ['owner materials', '/owner/assets', owner],
    ['partner home', '/partner', partner], ['partner new lead', '/partner/new', partner],
    ['partner leads', '/partner/leads', partner], ['partner earnings', '/partner/earnings', partner],
    ['partner materials', '/partner/assets', partner],
  ]) {
    const res = await client.get(path);
    ok(label + ' renders', res.status === 200 && res.body.includes('</html>'), 'status ' + res.status);
  }
  section('Backup');
  r = await owner.get('/owner/backup');
  ok('owner can download a full backup',
     r.status === 200 && r.buf.length > 1000 && r.buf.subarray(0,15).toString() === 'SQLite format 3',
     'len ' + r.buf.length);
  r = await partner.get('/owner/backup');
  ok('partner cannot download the backup', r.status === 302);

  section('Pages render (cont.)');
  r = await anon.get('/nope/nope');
  ok('unknown page 404s cleanly', r.status === 404 && r.body.includes('Not found'));
  r = await anon.get('/healthz');
  ok('health check responds', r.status === 200 && r.body === 'ok');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
