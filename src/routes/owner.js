'use strict';
const { get, post } = require('../router');
const DB = require('../db');
const A = require('../auth');
const H = require('../http');
const C = require('../context');
const Mail = require('../mail');
const M = require('../money');
const V = require('../views/app');
const { q, tx } = DB;

const OWNER = 'owner';

function flashFrom(ctx) {
  const ok = ctx.url.searchParams.get('ok'), e = ctx.url.searchParams.get('e');
  const MSG = {
    pw: ['ok', 'Password changed.'], saved: ['ok', 'Saved.'],
    paid: ['ok', 'Payout recorded.'], approved: ['ok', 'Partner approved — send them their sign-in.'],
    uploaded: ['ok', 'Files uploaded.'],
    mailsent: ['ok', 'Test email sent — check that inbox.'],
    mailoff: ['bad', 'Email is off. Add RESEND_API_KEY in Render, then redeploy.'],
    mailfrom: ['bad', 'Set the \u201cSend emails from\u201d address first.'],
    wrong: ['bad', 'That current password is not right.'],
    short: ['bad', 'Password needs at least 8 characters.'],
    email: ['bad', 'That email is already in use.'],
    haslead: ['bad', 'That partner has leads attached. Pause them instead so the history stays intact.'],
    big: ['bad', 'One of those files was over 10MB.'],
    type: ['bad', 'Only images, PDFs and MP4s can be uploaded.'],
  };
  const m = MSG[ok || e];
  if (m) return require('../views/layout').flash(m[0], m[1]);
  const mailerr = ctx.url.searchParams.get('mailerr');
  if (mailerr) return require('../views/layout').flash('bad', 'Email failed: ' + mailerr);
  const bad = ctx.url.searchParams.get('codeerr');
  return bad ? require('../views/layout').flash('bad', bad) : '';
}

/* ------------------------------------------------------------- overview */

get('/owner', ctx => {
  ctx.flash = flashFrom(ctx);
  const leads = C.attachPartners(q.all('SELECT * FROM leads ORDER BY created_at DESC'));
  const open = leads.filter(l => ['new', 'contacted', 'booked'].includes(l.status));
  const held = leads.filter(l => M.isHeld(l));
  const done = leads.filter(l => l.status === 'completed' || l.status === 'settled');
  const settled = leads.filter(l => l.status === 'settled');
  const s = ctx.settings;

  V_send(ctx, V.ownerOverview(ctx, {
    newCount: leads.filter(l => l.status === 'new').length,
    openCount: open.length,
    doneCount: done.length,
    revenue: settled.reduce((a, l) => a + (Number(l.job_total) || 0), 0),
    heldCount: held.length,
    heldAmt: held.reduce((a, l) => a + M.projected(l, l._partner, s), 0),
    owed: leads.reduce((a, l) => a + (M.isOwed(l) ? Number(l.commission || 0) : 0), 0),
    activePartners: q.get("SELECT COUNT(*) n FROM users WHERE role='partner' AND status='active'").n,
    applications: q.all('SELECT * FROM applications ORDER BY created_at DESC'),
    appCount: q.get('SELECT COUNT(*) n FROM applications').n,
    needsTotal: done.filter(l => !l.job_total),
    recent: leads.slice(0, 6),
  }));
}, OWNER);

function V_send(ctx, html) { H.html(ctx.res, html); }

/* ---------------------------------------------------------------- leads */

get('/owner/leads', ctx => {
  ctx.flash = flashFrom(ctx);
  const status = ctx.url.searchParams.get('status') || 'all';
  const partnerId = ctx.url.searchParams.get('partner') || '';
  let sql = 'SELECT * FROM leads', where = [], args = [];
  if (status !== 'all' && M.STATUS_ORDER.includes(status)) { where.push('status = ?'); args.push(status); }
  if (partnerId) { where.push('partner_id = ?'); args.push(partnerId); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY created_at DESC';

  const counts = { all: q.get('SELECT COUNT(*) n FROM leads').n };
  for (const row of q.all('SELECT status, COUNT(*) n FROM leads GROUP BY status')) counts[row.status] = row.n;

  V_send(ctx, V.ownerLeads(ctx, {
    list: C.attachPartners(q.all(sql, ...args)),
    counts, filter: status, partnerId,
    partners: q.all("SELECT id,name,code FROM users WHERE role='partner' ORDER BY name"),
  }));
}, OWNER);

get('/owner/leads/new', ctx => {
  V_send(ctx, V.ownerNewLead(ctx, q.all("SELECT id,name,code FROM users WHERE role='partner' AND status='active' ORDER BY name"), C.servicesList()));
}, OWNER);

post('/owner/leads/new', async ctx => {
  const { fields } = await H.parseForm(ctx.req);
  const customer = H.clean(fields.customer, 120);
  if (!customer) return H.redirect(ctx.res, '/owner/leads/new');
  q.run(`INSERT INTO leads (id,partner_id,customer,phone,vehicle,service,notes,source,status,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
    A.newId('ld'), H.clean(fields.partner_id, 60) || null, customer,
    H.clean(fields.phone, 40), H.clean(fields.vehicle, 160), H.clean(fields.service, 120),
    H.clean(fields.notes, 1000), 'manual', 'new', new Date().toISOString());
  H.redirect(ctx.res, '/owner/leads');
}, OWNER);

get('/owner/leads/:id', (ctx, p) => {
  const lead = q.get('SELECT * FROM leads WHERE id = ?', p.id);
  if (!lead) return H.notFound(ctx.res);
  V_send(ctx, V.ownerLeadDetail(ctx, lead, C.partnerOf(lead), C.servicesList()));
}, OWNER);

post('/owner/leads/:id', async (ctx, p) => {
  const { fields } = await H.parseForm(ctx.req);
  const lead = q.get('SELECT * FROM leads WHERE id = ?', p.id);
  if (!lead) return H.notFound(ctx.res);

  // One form drives both the total and the stage, so the number the owner just
  // typed is always the number that gets saved with the move.
  const jt = H.num(fields.job_total);
  if (jt != null) lead.job_total = jt;

  const status = String(fields.status || '');
  if (status && M.STATUS_ORDER.includes(status)) {
    const next = M.applyStatus(lead, status, C.partnerOf(lead), ctx.settings, H.today());
    q.run('UPDATE leads SET status=?, job_total=?, commission=?, completed_at=?, settled_at=? WHERE id=?',
      next.status, next.job_total, next.commission, next.completed_at, next.settled_at, p.id);
  } else {
    let commission = lead.commission;
    if (lead.status === 'settled' && !lead.payout_id) {
      commission = M.computeCommission(lead, C.partnerOf(lead), ctx.settings);
    }
    q.run('UPDATE leads SET job_total=?, commission=? WHERE id=?', lead.job_total, commission, p.id);
  }
  H.redirect(ctx.res, '/owner/leads/' + p.id + '?ok=saved');
}, OWNER);

post('/owner/leads/:id/delete', (ctx, p) => {
  q.run('DELETE FROM leads WHERE id = ?', p.id);
  H.redirect(ctx.res, '/owner/leads');
}, OWNER);

/* -------------------------------------------------------------- partners */

get('/owner/partners', ctx => {
  ctx.flash = flashFrom(ctx);
  const rows = q.all("SELECT * FROM users WHERE role='partner' ORDER BY name").map(p => ({
    id: p.id, name: p.name, email: p.email, code: p.code, status: p.status,
    leads: q.get('SELECT COUNT(*) n FROM leads WHERE partner_id = ?', p.id).n,
    settled: q.get("SELECT COUNT(*) n FROM leads WHERE partner_id = ? AND status='settled'", p.id).n,
    owed: M.owedFor(p.id), paid: M.paidFor(p.id),
  }));
  V_send(ctx, V.ownerPartners(ctx, rows, q.all('SELECT * FROM applications ORDER BY created_at DESC')));
}, OWNER);

get('/owner/partners/new', ctx => {
  V_send(ctx, V.ownerPartnerNew(ctx, ctx.url.searchParams.get('e') === 'email' ? 'That email is already in use.' : ''));
}, OWNER);

function createPartner(name, email, phone, payHandle, password) {
  const id = A.newId('u');
  q.run(`INSERT INTO users (id,role,email,password_hash,name,phone,code,pay_handle,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
    id, 'partner', email, A.hashPassword(password), name, phone,
    A.makeCode(name), payHandle, new Date().toISOString());
  return id;
}

post('/owner/partners/new', async ctx => {
  const { fields } = await H.parseForm(ctx.req);
  const name = H.clean(fields.name, 120), email = H.clean(fields.email, 200).toLowerCase();
  const pw = String(fields.password || '');
  if (!name || !email || pw.length < 8) return H.redirect(ctx.res, '/owner/partners/new');
  if (q.get('SELECT id FROM users WHERE email = ?', email)) return H.redirect(ctx.res, '/owner/partners/new?e=email');
  const id = createPartner(name, email, H.clean(fields.phone, 40), H.clean(fields.pay_handle, 80), pw);
  H.redirect(ctx.res, '/owner/partners/' + id);
}, OWNER);

get('/owner/partners/:id', (ctx, p) => {
  ctx.flash = flashFrom(ctx);
  const u = q.get("SELECT * FROM users WHERE id = ? AND role='partner'", p.id);
  if (!u) return H.notFound(ctx.res);
  V_send(ctx, V.ownerPartnerDetail(ctx, u, {
    leads: q.get('SELECT COUNT(*) n FROM leads WHERE partner_id = ?', u.id).n,
    owed: M.owedFor(u.id), paid: M.paidFor(u.id),
    oldCodes: C.retiredCodes(u.id),
  }, ctx.url.searchParams.get('pw') || '', ctx.url.searchParams.get('invite') || '',
     ctx.url.searchParams.get('mail') || ''));
}, OWNER);

post('/owner/partners/:id', async (ctx, p) => {
  const { fields } = await H.parseForm(ctx.req);
  const u = q.get("SELECT * FROM users WHERE id = ? AND role='partner'", p.id);
  if (!u) return H.notFound(ctx.res);
  const email = H.clean(fields.email, 200).toLowerCase() || u.email;
  const clash = q.get('SELECT id FROM users WHERE email = ? AND id <> ?', email, u.id);
  if (clash) return H.redirect(ctx.res, '/owner/partners/' + u.id + '?e=email');
  if (fields.code != null && C.normalizeCode(fields.code) !== C.normalizeCode(u.code)) {
    const r = C.setPartnerCode(u, fields.code);
    if (r.error) return H.redirect(ctx.res, '/owner/partners/' + u.id + '?codeerr=' + encodeURIComponent(r.error));
  }
  const mode = ['flat', 'percent'].includes(fields.rate_mode) ? fields.rate_mode : null;
  const val = mode ? H.num(fields.rate_value) : null;
  q.run(`UPDATE users SET name=?, email=?, phone=?, pay_handle=?, rate_mode=?, rate_value=?, status=? WHERE id=?`,
    H.clean(fields.name, 120) || u.name, email, H.clean(fields.phone, 40),
    H.clean(fields.pay_handle, 80), (val == null ? null : mode), val,
    fields.status === 'paused' ? 'paused' : 'active', u.id);
  H.redirect(ctx.res, '/owner/partners/' + u.id + '?ok=saved');
}, OWNER);

post('/owner/partners/:id/invite', async (ctx, p) => {
  const u = q.get("SELECT * FROM users WHERE id = ? AND role='partner'", p.id);
  if (!u) return H.notFound(ctx.res);
  const inv = A.createInvite(u.id);
  const mailed = await C.emailInvite(ctx.settings, u, inv.token);
  H.redirect(ctx.res, '/owner/partners/' + u.id + '?invite=' + encodeURIComponent(inv.token)
    + '&mail=' + encodeURIComponent(mailed.sent ? 'sent' : (mailed.reason || 'off')));
}, OWNER);

post('/owner/partners/:id/password', (ctx, p) => {
  const u = q.get("SELECT * FROM users WHERE id = ? AND role='partner'", p.id);
  if (!u) return H.notFound(ctx.res);
  const pw = 'PMC-' + require('node:crypto').randomBytes(4).toString('hex');
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', A.hashPassword(pw), u.id);
  A.destroyAllSessions(u.id);
  H.redirect(ctx.res, '/owner/partners/' + u.id + '?pw=' + encodeURIComponent(pw));
}, OWNER);

post('/owner/partners/:id/delete', (ctx, p) => {
  const n = q.get('SELECT COUNT(*) n FROM leads WHERE partner_id = ?', p.id).n;
  if (n > 0) return H.redirect(ctx.res, '/owner/partners/' + p.id + '?e=haslead');
  q.run("DELETE FROM users WHERE id = ? AND role='partner'", p.id);
  H.redirect(ctx.res, '/owner/partners');
}, OWNER);

post('/owner/applications/:id/approve', async (ctx, p) => {
  const a = q.get('SELECT * FROM applications WHERE id = ?', p.id);
  if (!a) return H.redirect(ctx.res, '/owner/partners');
  if (q.get('SELECT id FROM users WHERE email = ?', a.email)) return H.redirect(ctx.res, '/owner/partners?e=email');
  const pw = 'PMC-' + require('node:crypto').randomBytes(4).toString('hex');
  const id = tx(() => {
    const uid = createPartner(a.name, a.email, a.phone, '', pw);
    q.run('DELETE FROM applications WHERE id = ?', p.id);
    return uid;
  });
  const inv = A.createInvite(id);
  const who = q.get('SELECT * FROM users WHERE id = ?', id);
  const mailed = await C.emailInvite(ctx.settings, who, inv.token);
  H.redirect(ctx.res, '/owner/partners/' + id + '?invite=' + encodeURIComponent(inv.token)
    + '&mail=' + encodeURIComponent(mailed.sent ? 'sent' : (mailed.reason || 'off')));
}, OWNER);

post('/owner/applications/:id/decline', (ctx, p) => {
  q.run('DELETE FROM applications WHERE id = ?', p.id);
  H.redirect(ctx.res, '/owner/partners');
}, OWNER);

/* --------------------------------------------------------------- payouts */

get('/owner/payouts', ctx => {
  ctx.flash = flashFrom(ctx);
  const partners = q.all("SELECT * FROM users WHERE role='partner' ORDER BY name");
  const owedList = partners.map(p => ({
    partner: p, owed: M.owedFor(p.id),
    jobs: q.get("SELECT COUNT(*) n FROM leads WHERE partner_id=? AND status='settled' AND payout_id IS NULL", p.id).n,
  })).filter(x => x.owed > 0.004);
  const history = q.all(`SELECT po.*, u.name AS partner_name,
      (SELECT COUNT(*) FROM leads WHERE payout_id = po.id) AS jobs
      FROM payouts po JOIN users u ON u.id = po.partner_id ORDER BY po.paid_on DESC, po.created_at DESC`);
  const heldCount = q.get("SELECT COUNT(*) n FROM leads WHERE status='completed' AND partner_id IS NOT NULL").n;
  V_send(ctx, V.ownerPayouts(ctx, owedList, history, heldCount));
}, OWNER);

get('/owner/payouts/:id', (ctx, p) => {
  const u = q.get("SELECT * FROM users WHERE id = ? AND role='partner'", p.id);
  if (!u) return H.notFound(ctx.res);
  const leads = q.all("SELECT * FROM leads WHERE partner_id=? AND status='settled' AND payout_id IS NULL ORDER BY settled_at", u.id);
  V_send(ctx, V.ownerPayScreen(ctx, u, leads, H.today()));
}, OWNER);

post('/owner/payouts/:id', async (ctx, p) => {
  const { fields } = await H.parseForm(ctx.req);
  const u = q.get("SELECT * FROM users WHERE id = ? AND role='partner'", p.id);
  if (!u) return H.notFound(ctx.res);
  tx(() => {
    const leads = q.all("SELECT * FROM leads WHERE partner_id=? AND status='settled' AND payout_id IS NULL", u.id);
    if (!leads.length) return;
    const amount = M.round2(leads.reduce((a, l) => a + Number(l.commission || 0), 0));
    const pid = A.newId('po');
    q.run('INSERT INTO payouts (id,partner_id,amount,method,paid_on,created_at) VALUES (?,?,?,?,?,?)',
      pid, u.id, amount, H.clean(fields.method, 40) || 'Other',
      H.clean(fields.paid_on, 20) || H.today(), new Date().toISOString());
    for (const l of leads) q.run('UPDATE leads SET payout_id = ? WHERE id = ?', pid, l.id);
  });
  H.redirect(ctx.res, '/owner/payouts?ok=paid');
}, OWNER);

/* -------------------------------------------------------------- settings */

get('/owner/settings', ctx => {
  ctx.settings.mail_on = Mail.enabled();
  ctx.flash = flashFrom(ctx);
  V_send(ctx, V.ownerSettings(ctx, C.servicesList()));
}, OWNER);

post('/owner/settings', async ctx => {
  const { fields } = await H.parseForm(ctx.req);
  for (const k of ['business_name', 'tagline', 'phone', 'service_area', 'website', 'booking_url', 'toolkit_url', 'payout_note', 'mail_from', 'mail_reply_to']) {
    if (k in fields) DB.setSetting(k, H.clean(fields[k], 600));
  }
  H.redirect(ctx.res, '/owner/settings?ok=saved');
}, OWNER);

post('/owner/settings/test-email', async ctx => {
  const { fields } = await H.parseForm(ctx.req);
  const to = H.clean(fields.to, 200) || ctx.user.email;
  if (!Mail.enabled()) return H.redirect(ctx.res, '/owner/settings?e=mailoff');
  if (!ctx.settings.mail_from) return H.redirect(ctx.res, '/owner/settings?e=mailfrom');
  const res = await Mail.send({
    from: ctx.settings.mail_from,
    replyTo: ctx.settings.mail_reply_to || '',
    to,
    subject: 'Test from ' + (ctx.settings.business_name || 'your referral program'),
    text: 'This is a test. If it reached you, partner sign-in links will too.',
  });
  H.redirect(ctx.res, '/owner/settings?' + (res.ok
    ? 'ok=mailsent' : 'mailerr=' + encodeURIComponent(res.error || 'failed')));
}, OWNER);

post('/owner/settings/rates', async ctx => {
  const { fields } = await H.parseForm(ctx.req);
  if (['flat', 'percent', 'service'].includes(fields.rate_mode)) DB.setSetting('rate_mode', fields.rate_mode);
  const flat = H.num(fields.rate_flat), pct = H.num(fields.rate_percent);
  if (flat != null) DB.setSetting('rate_flat', flat);
  if (pct != null) DB.setSetting('rate_percent', pct);
  H.redirect(ctx.res, '/owner/settings?ok=saved');
}, OWNER);

post('/owner/settings/services', async ctx => {
  const { fields } = await H.parseForm(ctx.req);
  tx(() => {
    for (const s of q.all('SELECT * FROM services WHERE archived = 0')) {
      if (fields['del_' + s.id]) { q.run('UPDATE services SET archived = 1 WHERE id = ?', s.id); continue; }
      const name = H.clean(fields['name_' + s.id], 120);
      if (!name) continue;
      q.run('UPDATE services SET name=?, price=?, payout=? WHERE id=?',
        name, H.num(fields['price_' + s.id]) || 0, H.num(fields['payout_' + s.id]) || 0, s.id);
    }
    const nn = H.clean(fields.new_name, 120);
    if (nn) {
      const max = q.get('SELECT COALESCE(MAX(sort),0) m FROM services').m;
      q.run('INSERT INTO services (id,name,price,payout,sort) VALUES (?,?,?,?,?)',
        A.newId('sv'), nn, H.num(fields.new_price) || 0, H.num(fields.new_payout) || 0, max + 1);
    }
  });
  H.redirect(ctx.res, '/owner/settings?ok=saved');
}, OWNER);

/* ---------------------------------------------------------------- assets */

const ALLOWED = /^(image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml)|application\/pdf|video\/mp4)$/;
const MAX_ASSET = 10 * 1024 * 1024;

get('/owner/assets', ctx => {
  ctx.flash = flashFrom(ctx);
  V_send(ctx, V.ownerAssets(ctx, q.all('SELECT id,filename,title,kind,content_type,bytes,sort FROM assets ORDER BY sort, created_at DESC')));
}, OWNER);

post('/owner/assets', async ctx => {
  const { fields, files } = await H.parseForm(ctx.req);
  if (!files.length) return H.redirect(ctx.res, '/owner/assets');
  const title = H.clean(fields.title, 160);
  for (const f of files) {
    if (!f.data || !f.data.length) continue;
    if (f.data.length > MAX_ASSET) return H.redirect(ctx.res, '/owner/assets?e=big');
    if (!ALLOWED.test(f.contentType)) return H.redirect(ctx.res, '/owner/assets?e=type');
  }
  const max = q.get('SELECT COALESCE(MAX(sort),0) m FROM assets').m;
  let i = 1;
  for (const f of files) {
    if (!f.data || !f.data.length) continue;
    q.run(`INSERT INTO assets (id,filename,title,kind,content_type,bytes,data,sort,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
      A.newId('as'), f.filename, files.length === 1 ? title : (title ? title + ' ' + i : ''),
      f.contentType.startsWith('image/') ? 'image' : f.contentType === 'application/pdf' ? 'pdf' : 'video',
      f.contentType, f.data.length, f.data, max + i, new Date().toISOString());
    i++;
  }
  H.redirect(ctx.res, '/owner/assets?ok=uploaded');
}, OWNER);

post('/owner/assets/:id/delete', (ctx, p) => {
  q.run('DELETE FROM assets WHERE id = ?', p.id);
  H.redirect(ctx.res, '/owner/assets');
}, OWNER);

/* ---------------------------------------------------------------- backup */
// SQLite on one disk means a bad day is one disk away. This hands the owner a
// consistent copy of the whole database on demand — no console, no CLI.

get('/owner/backup', async ctx => {
  const sqlite = require('node:sqlite');
  const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
  const tmp = path.join(os.tmpdir(), 'pmc-backup-' + Date.now() + '.db');
  try {
    await sqlite.backup(DB.handle(), tmp);
    const buf = fs.readFileSync(tmp);
    H.send(ctx.res, 200, buf, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(buf.length),
      'Content-Disposition': 'attachment; filename="prestige-backup-' + H.today() + '.db"',
      'Cache-Control': 'no-store',
    });
  } finally {
    try { require('node:fs').unlinkSync(tmp); } catch (e) {}
  }
}, OWNER);
