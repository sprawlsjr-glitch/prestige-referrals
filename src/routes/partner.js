'use strict';
const { get, post } = require('../router');
const { q } = require('../db');
const A = require('../auth');
const H = require('../http');
const C = require('../context');
const M = require('../money');
const V = require('../views/app');
const Layout = require('../views/layout');
const Creatives = require('../creatives');

const PARTNER = 'partner';

function flashFrom(ctx) {
  const ok = ctx.url.searchParams.get('ok'), e = ctx.url.searchParams.get('e');
  const MSG = {
    pw: ['ok', 'Password changed.'],
    saved: ['ok', 'Saved.'],
    sent: ['ok', "Sent to the shop — they'll reach out to the customer."],
    wrong: ['bad', 'That current password is not right.'],
    short: ['bad', 'Password needs at least 8 characters.'],
    code: ['ok', 'Code updated. Your old code still works.'],
  };
  const m = MSG[ok || e];
  if (m) return Layout.flash(m[0], m[1]);
  const bad = ctx.url.searchParams.get('codeerr');
  return bad ? Layout.flash('bad', bad) : '';
}

function myLeads(userId) {
  return q.all('SELECT * FROM leads WHERE partner_id = ? ORDER BY created_at DESC', userId);
}

get('/partner', ctx => {
  ctx.flash = flashFrom(ctx);
  const s = ctx.settings, me = ctx.user;
  const leads = myLeads(me.id);
  const held = leads.filter(l => l.status === 'completed');
  const open = leads.filter(l => ['new', 'contacted', 'booked'].includes(l.status));
  H.html(ctx.res, V.partnerHome(ctx, {
    owed: M.owedFor(me.id),
    paid: M.paidFor(me.id),
    held: held.reduce((a, l) => a + M.projected(l, me, s), 0),
    heldCount: held.length,
    pipeline: open.reduce((a, l) => a + M.projected(l, me, s), 0),
    openCount: open.length,
    settledCount: leads.filter(l => l.status === 'settled').length,
    recent: leads.slice(0, 4),
    oldCodes: C.retiredCodes(me.id),
    services: C.servicesList(),
    quoted: C.servicesList().filter(sv => !Number(sv.price)).map(sv => sv.name),
  }));
}, PARTNER);

get('/partner/new', ctx => {
  H.html(ctx.res, V.partnerNewLead(ctx, C.servicesList(), ctx.url.searchParams.get('e')));
}, PARTNER);

post('/partner/new', async ctx => {
  const { fields } = await H.parseForm(ctx.req);
  const customer = H.clean(fields.customer, 120), phone = H.clean(fields.phone, 40);
  if (!customer || !phone) {
    return H.html(ctx.res, V.partnerNewLead(ctx, C.servicesList(),
      'We need the customer’s name and a phone number.'), 400);
  }
  const notes = [H.clean(fields.notes, 1000), fields.best_time ? 'Best time: ' + H.clean(fields.best_time, 120) : '']
    .filter(Boolean).join(' · ');
  q.run(`INSERT INTO leads (id,partner_id,customer,phone,vehicle,address,service,notes,source,status,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    A.newId('ld'), ctx.user.id, customer, phone,
    H.clean(fields.vehicle, 160), H.clean(fields.address, 200), H.clean(fields.service, 120),
    notes, 'partner', 'new', new Date().toISOString());
  H.redirect(ctx.res, '/partner/leads?ok=sent');
}, PARTNER);

get('/partner/leads', ctx => {
  ctx.flash = flashFrom(ctx);
  H.html(ctx.res, V.partnerLeads(ctx, myLeads(ctx.user.id)));
}, PARTNER);

get('/partner/earnings', ctx => {
  ctx.flash = flashFrom(ctx);
  const me = ctx.user, s = ctx.settings;
  const leads = myLeads(me.id);
  const heldLeads = leads.filter(l => l.status === 'completed');
  H.html(ctx.res, V.partnerEarnings(ctx, {
    owed: M.owedFor(me.id),
    paid: M.paidFor(me.id),
    owedLeads: leads.filter(l => M.isOwed(l)),
    heldLeads,
    heldAmt: heldLeads.reduce((a, l) => a + M.projected(l, me, s), 0),
    payouts: q.all(`SELECT po.*, (SELECT COUNT(*) FROM leads WHERE payout_id = po.id) AS jobs
                    FROM payouts po WHERE po.partner_id = ? ORDER BY po.paid_on DESC`, me.id),
  }));
}, PARTNER);

post('/partner/code', async ctx => {
  const { fields } = await H.parseForm(ctx.req);
  const r = C.setPartnerCode(ctx.user, fields.code);
  if (r.error) return H.redirect(ctx.res, '/partner?codeerr=' + encodeURIComponent(r.error));
  H.redirect(ctx.res, '/partner?ok=code');
}, PARTNER);

post('/partner/account', async ctx => {
  const { fields } = await H.parseForm(ctx.req);
  q.run('UPDATE users SET pay_handle = ? WHERE id = ?', H.clean(fields.pay_handle, 80), ctx.user.id);
  H.redirect(ctx.res, '/partner/earnings?ok=saved');
}, PARTNER);

get('/partner/assets', ctx => {
  H.html(ctx.res, V.partnerAssets(ctx,
    q.all('SELECT id,filename,title,kind,content_type,bytes FROM assets ORDER BY sort, created_at DESC'),
    Creatives.PLATES));
}, PARTNER);
