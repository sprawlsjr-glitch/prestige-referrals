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

  /* ------------------------------------------------- inviting a new partner */
  section('A new partner gets a sign-in link');
  {
    r = await anon.post('/apply', { name: 'Nia Bell', email: 'nia@partner.test',
                                    phone: '770-555-0123', why: 'I know a lot of car people' });
    ok('anyone can apply', r.status === 200 || r.status === 302);
    const app = q.get("SELECT * FROM applications WHERE email = 'nia@partner.test'");
    ok('the application reaches the shop', !!app);

    r = await owner.post('/owner/applications/' + app.id + '/approve', {});
    const loc = r.headers.location || '';
    ok('approving hands the owner a link to send, not a password', /[?&]invite=/.test(loc), loc);
    const token = decodeURIComponent((loc.match(/[?&]invite=([^&]+)/) || [])[1] || '');
    const nia = q.get("SELECT * FROM users WHERE email = 'nia@partner.test'");
    ok('the partner account exists', !!nia && nia.role === 'partner');
    ok('they have a referral code already', !!nia.code);

    r = await owner.get('/owner/partners/' + nia.id + '?invite=' + encodeURIComponent(token));
    ok('the owner sees the link ready to send', r.body.includes('/invite/' + token));
    ok('with a way to text it', r.body.includes('sms:'));
    ok('and a way to email it', r.body.includes('mailto:'));

    ok('the raw link is never stored', !q.get('SELECT 1 AS x FROM invites WHERE token_hash = ?', token));

    const invitee = makeClient(port);
    r = await invitee.get('/invite/' + token);
    ok('the partner can open the link', r.status === 200 && r.body.includes('Set my password'));
    r = await invitee.post('/invite/' + token, { password: 'short' });
    ok('a too-short password is refused', r.status === 400);
    r = await invitee.post('/invite/' + token, { password: 'niapassword1' });
    ok('setting a password signs them straight in', r.status === 302 && r.headers.location === '/partner');
    r = await invitee.get('/partner');
    ok('and they land in their own portal', r.status === 200 && r.body.includes(nia.code));

    r = await anon.get('/invite/' + token);
    ok('the link stops working once used', r.status === 410);
    r = await anon.get('/invite/' + token + 'x');
    ok('a made-up link is refused', r.status === 410);

    const fresh = makeClient(port);
    r = await fresh.post('/login', { email: 'nia@partner.test', password: 'niapassword1' });
    ok('the password they chose is the one that works', r.status === 302);

    r = await owner.post('/owner/partners/' + nia.id + '/invite', {});
    const second = decodeURIComponent((String(r.headers.location).match(/[?&]invite=([^&]+)/) || [])[1] || '');
    ok('the owner can send a fresh link any time', !!second && second !== token);
    q.run("UPDATE invites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ?", nia.id);
    r = await anon.get('/invite/' + second);
    ok('an expired link is refused', r.status === 410);

    r = await partner.get('/owner/partners/' + nia.id + '/invite');
    ok('a partner cannot mint links for anyone', r.status === 302 || r.status === 404);
  }

  /* ------------------------------------------------ sending the link by email */
  section('Sending the sign-in link by email');
  {
    const Mail = require('../src/mail');
    const sent = [];

    // With no key configured, nothing is sent and nothing breaks.
    delete process.env.RESEND_API_KEY;
    ok('email is off until a key is configured', Mail.enabled() === false);

    // Switch it on and capture the request instead of hitting the network.
    process.env.RESEND_API_KEY = 're_test_key';
    Mail.__setRequest(async (url, init) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
    });
    ok('email switches on with a key', Mail.enabled() === true);

    await owner.post('/owner/settings', {
      business_name: 'Prestige Mobile Cleaning',
      mail_from: 'Prestige <partners@prestigecleaning.us>',
      mail_reply_to: 'mel@prestigecleaning.us',
    });

    r = await anon.post('/apply', { name: 'Omar Vance', email: 'omar@partner.test', phone: '770-555-0166' });
    const app2 = q.get("SELECT * FROM applications WHERE email = 'omar@partner.test'");
    r = await owner.post('/owner/applications/' + app2.id + '/approve', {});
    ok('approving now sends the email by itself', /[?&]mail=sent/.test(r.headers.location || ''), r.headers.location);
    ok('exactly one email went out', sent.length === 1, String(sent.length));

    const msg = sent[0];
    ok('it goes to Resend', msg.url === Mail.ENDPOINT);
    ok('the key travels in the header, never the body',
       /^Bearer re_test_key$/.test(msg.headers.Authorization) && !JSON.stringify(msg.body).includes('re_test_key'));
    ok('addressed to the new partner', msg.body.to[0] === 'omar@partner.test');
    ok('from the address the owner set', msg.body.from === 'Prestige <partners@prestigecleaning.us>');
    ok('replies come back to the owner', msg.body.reply_to === 'mel@prestigecleaning.us');

    const token2 = decodeURIComponent((String(r.headers.location).match(/[?&]invite=([^&]+)/) || [])[1] || '');
    ok('the email carries the working link', msg.body.text.includes('/invite/' + token2));
    ok('and says it expires', /expires in \d+ days/.test(msg.body.text));

    const omar = makeClient(port);
    r = await omar.get('/invite/' + token2);
    ok('the link in the email actually works', r.status === 200);

    // A provider outage must not cost the owner the link.
    Mail.__setRequest(async () => ({ ok: false, status: 422, json: async () => ({ message: 'domain not verified' }) }));
    const nia2 = q.get("SELECT id FROM users WHERE email = 'nia@partner.test'");
    r = await owner.post('/owner/partners/' + nia2.id + '/invite', {});
    ok('a failed send still hands over the link', /[?&]invite=/.test(r.headers.location || ''));
    ok('and says plainly why it failed', /mail=domain%20not%20verified|mail=domain\+not\+verified/.test(r.headers.location || ''),
       r.headers.location);
    const shown = await owner.get(String(r.headers.location).replace(/^[^?]*/, '/owner/partners/' + nia2.id));
    ok('the owner is told, and can still copy it', shown.body.includes('domain not verified') && shown.body.includes('/invite/'));

    // The test-send button.
    Mail.__setRequest(async (url, init) => { sent.push({ body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({}) }; });
    r = await owner.post('/owner/settings/test-email', { to: 'mel@prestigecleaning.us' });
    ok('a test email can be sent before any partner sees it', /ok=mailsent/.test(r.headers.location || ''));

    Mail.__setRequest(null);
    delete process.env.RESEND_API_KEY;
    ok('turning the key off returns to sending links by hand', Mail.enabled() === false);
  }

  /* ------------------------------------------------- what each package pays */
  section('The earnings chart on the partner home');
  {
    const DBM = require('../src/db');
    const A3 = require('../src/auth');

    ok('the menu matches the website', ['Silver', 'Silver Plus', 'Gold', 'Gold Plus',
        'Platinum', 'Platinum Plus', 'Diamond', 'Diamond Plus', 'Interior Only', 'Exterior Only',
        'Wash and Wax (Exterior Only)', 'Wash and Wax (Exterior Only) Plus',
        'Wash and Wax', 'Wash and Wax Plus', 'Buff Polish Wax (Exterior Only)',
        'Buff Polish Wax (Exterior Only) Plus', 'Buff Polish Wax', 'Buff Polish Wax Plus',
        'Add-On Service']
      .every(n => !!q.get('SELECT id FROM services WHERE name = ? AND archived = 0', n)));

    DBM.syncServices(A3.newId);
    const count = q.get('SELECT COUNT(*) n FROM services').n;
    DBM.syncServices(A3.newId);
    ok('syncing twice changes nothing', q.get('SELECT COUNT(*) n FROM services').n === count);

    r = await partner.get('/partner');
    const priced = q.all('SELECT name, price FROM services WHERE archived = 0 AND price > 0');
    ok('every priced package is on the chart',
       priced.every(sv => r.body.includes('>' + sv.name.replace(/&/g, '&amp;') + '<')),
       priced.filter(sv => !r.body.includes('>' + sv.name.replace(/&/g, '&amp;') + '<')).map(sv => sv.name).join(','));

    ok('the top package shows the right cut', r.body.includes('$68') && r.body.includes('$680 job'));
    ok('the cheapest shows the right cut', r.body.includes('$8') && r.body.includes('$80 job'));
    ok('Silver reads $20 on a $200 job', /Silver<\/div>\s*<div class="amt">\$20</.test(r.body));
    ok('it says which rate it used', r.body.includes('at your 10%'));

    const widths = (r.body.match(/class="fill" style="width:(\d+)%/g) || [])
      .map(m => Number(m.match(/(\d+)%/)[1]));
    ok('every bar fits its track', widths.length === priced.length && widths.every(w => w > 0 && w <= 100),
       widths.length + ' bars');
    ok('the biggest earner fills the track', Math.max.apply(null, widths) === 100);

    ok('services quoted job by job are named, not drawn as $0 bars',
       r.body.includes('Quoted job by job') && r.body.includes('Ceramic Coating')
       && !/Ceramic Coating<\/div>\s*<div class="amt">\$0</.test(r.body));

    // A partner on their own rate must not be shown the house 10%.
    const me = q.get('SELECT id FROM users WHERE role = ? AND code IS NOT NULL', 'partner');
    q.run("UPDATE users SET rate_mode = 'percent', rate_value = 15 WHERE id = ?", partnerId);
    r = await partner.get('/partner');
    ok('a custom rate shows their number, not the default', r.body.includes('at your 15%'));
    ok('and their amounts follow it', /Silver<\/div>\s*<div class="amt">\$30</.test(r.body));

    q.run("UPDATE users SET rate_mode = 'flat', rate_value = 25 WHERE id = ?", partnerId);
    r = await partner.get('/partner');
    ok('a flat-rate partner is not told a percentage',
       !r.body.includes('at your') && r.body.includes('same on every package'));

    q.run('UPDATE users SET rate_mode = NULL, rate_value = NULL WHERE id = ?', partnerId);
  }

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
  section('Upgrading whatever shape the live database is in');
  {
    const crypto2 = require('node:crypto');
    const DBM = require('../src/db');
    const MIG = DBM.MIGRATIONS;
    const SHIPPED = require('./shipped-migrations.json');
    const { DatabaseSync } = require('node:sqlite');

    ok('the first release\u2019s migrations are never edited',
       SHIPPED.length === MIG.length && SHIPPED.every((h, i) =>
         crypto2.createHash('sha256').update(MIG[i]).digest('hex').slice(0, 16) === h));

    /* A deploy that crashes half way still records the migrations that ran, so
       the ledger can hold numbers that mean nothing in this release. Rather
       than guess which, prove the upgrade survives EVERY shape it could be in:
       any ledger length, table there or missing, column there or missing. */
    const shapes = [];
    for (const ledger of [MIG.length, MIG.length + 1, MIG.length + 2, MIG.length + 3]) {
      for (const seeded of ['missing', 'no-sha', 'with-sha']) {
        for (const history of [true, false]) shapes.push({ ledger, seeded, history });
      }
    }

    let broken = null;
    for (const shape of shapes) {
      const d = new DatabaseSync(':memory:');
      d.exec('CREATE TABLE _migrations (n INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (let i = 0; i < MIG.length; i++) d.exec(MIG[i]);
      for (let i = 0; i < shape.ledger; i++) {
        d.prepare('INSERT INTO _migrations (n, applied_at) VALUES (?,?)').run(i, new Date().toISOString());
      }
      if (shape.seeded !== 'missing') {
        d.exec('CREATE TABLE seeded_assets (filename TEXT PRIMARY KEY, seeded_at TEXT NOT NULL' +
               (shape.seeded === 'with-sha' ? ", sha TEXT NOT NULL DEFAULT ''" : '') + ')');
      }
      if (shape.history) {
        d.exec('CREATE TABLE code_history (code TEXT PRIMARY KEY COLLATE NOCASE, user_id TEXT NOT NULL, retired_at TEXT NOT NULL)');
      }
      d.close();

      // now boot the real thing against it
      const file = require('node:path').join(require('node:os').tmpdir(),
        'shape-' + Math.random().toString(36).slice(2) + '.db');
      try {
        const src = new DatabaseSync(':memory:');   // rebuild on disk for the real open()
        src.close();
        const disk = new DatabaseSync(file);
        disk.exec('CREATE TABLE _migrations (n INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
        for (let i = 0; i < MIG.length; i++) disk.exec(MIG[i]);
        for (let i = 0; i < shape.ledger; i++) {
          disk.prepare('INSERT INTO _migrations (n, applied_at) VALUES (?,?)').run(i, new Date().toISOString());
        }
        if (shape.seeded !== 'missing') {
          disk.exec('CREATE TABLE seeded_assets (filename TEXT PRIMARY KEY, seeded_at TEXT NOT NULL' +
                    (shape.seeded === 'with-sha' ? ", sha TEXT NOT NULL DEFAULT ''" : '') + ')');
        }
        if (shape.history) {
          disk.exec('CREATE TABLE code_history (code TEXT PRIMARY KEY COLLATE NOCASE, user_id TEXT NOT NULL, retired_at TEXT NOT NULL)');
        }
        disk.close();

        const child = require('node:child_process').spawnSync(process.execPath,
          ['-e', "const D=require('" + require('node:path').resolve('src/db.js').replace(/\\/g, '/') +
                 "');const A=require('" + require('node:path').resolve('src/auth.js').replace(/\\/g, '/') +
                 "');D.open(process.argv[1]);D.seedServices(A.newId);D.seedAssets(A.newId);" +
                 "if(!D.q.get(\"SELECT name FROM sqlite_master WHERE name='code_history'\"))throw new Error('no code_history');" +
                 "D.q.get('SELECT sha FROM seeded_assets LIMIT 1');", file],
          { encoding: 'utf8' });
        if (child.status !== 0) broken = { shape, err: (child.stderr || '').split('\n').find(l => /Error/.test(l)) };
      } catch (e) { broken = { shape, err: e.message }; }
      try { require('node:fs').unlinkSync(file); } catch (e) {}
      if (broken) break;
    }
    ok('every shape the live database could be in boots and repairs itself',
       broken === null, broken && JSON.stringify(broken.shape) + ' → ' + broken.err);
  }

  /* ------------------------------------ a redesigned graphic replaces itself */
  section('Shipped graphics update themselves');
  {
    const A2 = require('../src/auth');
    const before = q.get("SELECT id, bytes, data FROM assets WHERE filename = '01-post-driveway.png'");
    ok('a shipped graphic is in Materials', !!before);

    // Pretend the file on disk changed since the last boot.
    q.run("UPDATE seeded_assets SET sha = 'stale' WHERE filename = '01-post-driveway.png'");
    q.run("UPDATE assets SET data = ?, bytes = ? WHERE id = ?", Buffer.from('old bytes'), 9, before.id);
    require('../src/db').seedAssets(A2.newId);
    const after = q.get("SELECT id, bytes FROM assets WHERE filename = '01-post-driveway.png'");
    ok('a redesigned file replaces the copy partners see', after.bytes === before.bytes, String(after.bytes));
    ok('and it keeps the same asset, not a duplicate', after.id === before.id);
    ok('no second copy appeared',
       q.get("SELECT COUNT(*) n FROM assets WHERE filename = '01-post-driveway.png'").n === 1);

    // If the owner threw one away, a redesign must not resurrect it.
    const victim = q.get("SELECT id FROM assets WHERE filename = '02-post-packages.png'");
    q.run('DELETE FROM assets WHERE id = ?', victim.id);
    q.run("UPDATE seeded_assets SET sha = 'stale' WHERE filename = '02-post-packages.png'");
    require('../src/db').seedAssets(A2.newId);
    ok('a graphic the owner deleted stays deleted',
       !q.get("SELECT id FROM assets WHERE filename = '02-post-packages.png'"));
    require('../src/db').seedAssets(A2.newId);
    ok('and it does not come back on the next boot either',
       !q.get("SELECT id FROM assets WHERE filename = '02-post-packages.png'"));

    // put it back so the checks further down still see the full set
    q.run("DELETE FROM seeded_assets WHERE filename = '02-post-packages.png'");
    require('../src/db').seedAssets(A2.newId);
    ok('clearing the record lets a deleted graphic be offered again',
       !!q.get("SELECT id FROM assets WHERE filename = '02-post-packages.png'"));
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
