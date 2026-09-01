'use strict';
const { esc, fdate, payLink } = require('../http');
const { shell, flash, tile, pill, bytes } = require('./layout');
const M = require('../money');

const L = M.STATUS_LABELS;
const OWNER_TABS = [['/owner', 'Overview'], ['/owner/leads', 'Leads'], ['/owner/partners', 'Partners'],
                    ['/owner/payouts', 'Payouts'], ['/owner/assets', 'Materials'], ['/owner/settings', 'Settings']];
const PARTNER_TABS = [['/partner', 'Home'], ['/partner/new', 'Send a lead'], ['/partner/leads', 'My leads'],
                      ['/partner/earnings', 'Earnings'], ['/partner/assets', 'Materials']];

function frame(ctx, active, body, tabs) {
  return shell({
    title: ctx.settings.business_name + ' · Referrals',
    business: ctx.settings.business_name,
    who: ctx.user.role === 'owner' ? 'Owner' : ctx.user.code,
    tabs: tabs || (ctx.user.role === 'owner' ? OWNER_TABS : PARTNER_TABS),
    active, body, flash: ctx.flash || '',
  });
}

function estLabel(lead, partner, s) {
  if (!lead.partner_id) return 'direct';
  if (lead.status === 'lost') return '—';
  if (lead.status === 'settled') return M.money0(lead.commission || 0);
  if (lead.status === 'completed') return M.money0(M.projected(lead, partner, s)) + ' held';
  const v = M.projected(lead, partner, s);
  if (!v && !lead.job_total) return 'quote';
  return M.money0(v) + ' est.';
}

function leadRow(lead, s) {
  const amt = estLabel(lead, lead._partner, s);
  return `<a class="item" href="/owner/leads/${esc(lead.id)}">
    <div class="grow"><div class="ttl">${esc(lead.customer || 'Unnamed')} <span class="muted small">· ${esc(lead.service || '—')}</span></div>
      <div class="sub">${esc(lead._partner ? lead._partner.name : 'Direct')} · ${fdate(lead.created_at)}${lead.vehicle ? ' · ' + esc(lead.vehicle) : ''}</div></div>
    <div style="text-align:right;display:flex;flex-direction:column;gap:4px;align-items:flex-end">
      ${pill(lead.status, L)}<span class="amt muted">${esc(amt)}${lead.payout_id ? ' paid' : ''}</span></div></a>`;
}

/* ============================================================== OWNER */

function ownerOverview(ctx, d) {
  const s = ctx.settings;
  let h = `<div class="tiles">
    ${tile('Needs a call', d.newCount, d.newCount ? 'new leads waiting' : 'all caught up')}
    ${tile('In the pipeline', d.openCount, 'leads not closed yet')}
    ${tile('Jobs from partners', d.doneCount, M.money0(d.revenue) + ' collected')}
    ${tile('Waiting on payment', d.heldCount, M.money0(d.heldAmt) + ' commission on hold')}
    ${tile('Commission owed', M.money0(d.owed), 'customer paid · ready to send', true)}
    ${tile('Active partners', d.activePartners, d.appCount ? d.appCount + ' waiting to be approved' : 'referring for you')}
  </div>`;

  if (d.applications.length) {
    h += `<div class="sec"><h2>New applications</h2></div><div class="card list">` +
      d.applications.map(a => `<a class="item" href="/owner/partners#app-${esc(a.id)}">
        <div class="grow"><div class="ttl">${esc(a.name)}</div>
        <div class="sub">${esc(a.phone || a.email || '')} · applied ${fdate(a.created_at)}</div></div>
        <span class="pill st-new"><span class="dot"></span>Review</span></a>`).join('') + `</div>`;
  }
  if (d.needsTotal.length) {
    h += `<div class="sec"><h2>Missing job totals</h2><span class="eyebrow">${d.needsTotal.length}</span></div>
      <div class="card list">${d.needsTotal.map(l => leadRow(l, s)).join('')}</div>`;
  }
  h += `<div class="sec"><h2>Latest leads</h2><a class="btn sm ghost" href="/owner/leads">See all</a></div>
    <div class="card list">${d.recent.length ? d.recent.map(l => leadRow(l, s)).join('')
      : '<div class="empty">No leads yet. Once a partner sends one it lands here.</div>'}</div>`;
  return frame(ctx, '/owner', h);
}

function ownerLeads(ctx, d) {
  const s = ctx.settings;
  const chips = [['all', 'All', d.counts.all]].concat(M.STATUS_ORDER.map(k => [k, L[k], d.counts[k] || 0]));
  let h = `<div class="row" style="gap:6px;overflow-x:auto;padding-bottom:2px">` +
    chips.map(c => `<a class="btn sm ${d.filter === c[0] ? 'pri' : 'ghost'}" href="/owner/leads?status=${esc(c[0])}${d.partnerId ? '&partner=' + esc(d.partnerId) : ''}">${esc(c[1])} <span class="num">${c[2]}</span></a>`).join('') + `</div>`;
  if (d.partners.length > 1) {
    h += `<form method="get" action="/owner/leads" style="margin-top:10px">
      <input type="hidden" name="status" value="${esc(d.filter)}">
      <label class="f" style="margin:0"><span>Partner</span><select name="partner" onchange="this.form.submit()">
        <option value="">All partners</option>
        ${d.partners.map(p => `<option value="${esc(p.id)}"${d.partnerId === p.id ? ' selected' : ''}>${esc(p.name)} (${esc(p.code)})</option>`).join('')}
      </select></label></form>`;
  }
  h += `<div class="sec"><h2>${d.list.length} lead${d.list.length === 1 ? '' : 's'}</h2>
    <a class="btn sm" href="/owner/leads/new">Log a lead</a></div>
    <div class="card list">${d.list.length ? d.list.map(l => leadRow(l, s)).join('') : '<div class="empty">Nothing here yet.</div>'}</div>`;
  return frame(ctx, '/owner/leads', h);
}

function ownerLeadDetail(ctx, lead, partner, services) {
  const s = ctx.settings;
  const locked = lead.status === 'settled' && lead.commission != null;
  const svc = services.find(x => x.name === lead.service);
  const shown = locked ? Number(lead.commission)
    : M.computeCommission(Object.assign({}, lead, { job_total: lead.job_total != null ? lead.job_total : (svc ? svc.price : 0) }), partner, s);
  const tel = String(lead.phone || '').replace(/[^0-9+]/g, '');

  const kv = (k, v) => `<div class="row" style="justify-content:space-between;gap:14px;padding:3px 0">
    <span class="muted">${esc(k)}</span><span style="text-align:right">${esc(v)}</span></div>`;

  const body = `<p><a class="small" href="/owner/leads">← All leads</a></p>
  <div class="sec" style="margin-top:6px"><h2>${esc(lead.customer)}</h2></div>
  <div class="row" style="margin-bottom:12px">${pill(lead.status, L)}
    ${lead.payout_id ? '<span class="pill st-paid"><span class="dot"></span>Paid out</span>' : ''}</div>
  <div class="card pad small" style="margin-bottom:14px">
    ${kv('Partner', partner ? partner.name + ' (' + partner.code + ')' : 'Direct booking')}
    ${kv('Phone', lead.phone || '—')}${kv('Vehicle', lead.vehicle || '—')}
    ${kv('Location', lead.address || '—')}${kv('Service', lead.service || '—')}
    ${kv('Sent', fdate(lead.created_at))}
    ${kv('Came in via', lead.source === 'booking' ? (partner ? 'Booking page · ' + partner.code : 'Booking page · direct')
        : lead.source === 'partner' ? 'Submitted by ' + (partner ? partner.name : 'partner') : 'Logged by hand')}
    ${lead.notes ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line)"><div class="eyebrow">Notes</div>${esc(lead.notes)}</div>` : ''}
  </div>
  ${tel ? `<div class="btnrow" style="margin-bottom:14px"><a class="btn" href="tel:${esc(tel)}">Call</a><a class="btn" href="sms:${esc(tel)}">Text</a></div>` : ''}

  <form method="post" action="/owner/leads/${esc(lead.id)}">
    <label class="f"><span>Job total charged ($)</span>
      <input type="number" step="1" min="0" name="job_total" value="${lead.job_total != null ? esc(lead.job_total) : (svc ? esc(svc.price) : '')}"></label>
    <div class="card pad" style="background:var(--brassbg);border-color:var(--brassline);margin-bottom:12px">
      <div class="eyebrow">Commission${locked ? ' \u00b7 locked in' : (lead.partner_id ? ' \u00b7 held until the customer pays' : ' \u00b7 direct booking')}</div>
      <div style="font-family:Archivo;font-weight:700;font-size:22px;color:var(--brass)">${M.money0(shown)}</div>
    </div>
    <div class="eyebrow" style="margin-bottom:6px">Move it along \u00b7 commission unlocks at "Customer paid"</div>
    <div class="btnrow" style="margin-bottom:12px">
      ${M.STATUS_ORDER.map(st => `<button class="btn sm ${lead.status === st ? 'pri' : ''}" name="status" value="${esc(st)}">${esc(L[st])}</button>`).join('')}
    </div>
    <p class="hint" style="margin:-4px 0 12px">Whatever is in the total box above is saved with the move.</p>
    <button class="btn pri" name="status" value="">Save total only</button>
  </form>
  <form method="post" action="/owner/leads/${esc(lead.id)}/delete" style="margin-top:10px"
        onsubmit="return confirm('Delete this lead permanently?')">
    <button class="btn ghost danger sm">Delete lead</button></form>`;
  return frame(ctx, '/owner/leads', body);
}

function ownerNewLead(ctx, partners, services) {
  const body = `<p><a class="small" href="/owner/leads">← All leads</a></p>
  <div class="sec" style="margin-top:6px"><h2>Log a lead</h2></div>
  <div class="card pad"><form method="post" action="/owner/leads/new">
    <label class="f"><span>Which partner sent it?</span><select name="partner_id">
      <option value="">Direct — nobody referred it</option>
      ${partners.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.code)})</option>`).join('')}
    </select></label>
    <label class="f"><span>Customer name</span><input type="text" name="customer" required></label>
    <div class="grid2"><label class="f"><span>Phone</span><input type="tel" name="phone"></label>
      <label class="f"><span>Vehicle</span><input type="text" name="vehicle"></label></div>
    <label class="f"><span>Service</span><select name="service">
      ${services.map(x => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join('')}</select></label>
    <label class="f"><span>Notes</span><textarea name="notes"></textarea></label>
    <button class="btn pri full">Add lead</button>
  </form></div>`;
  return frame(ctx, '/owner/leads', body);
}

function ownerPartners(ctx, rows, applications) {
  let h = '';
  if (applications.length) {
    h += `<div class="sec"><h2>Applications</h2><span class="eyebrow">${applications.length} waiting</span></div>
      <div class="card list">` + applications.map(a => `
      <div class="item" id="app-${esc(a.id)}"><div class="grow">
        <div class="ttl">${esc(a.name)}</div>
        <div class="sub">${esc(a.phone || '')}${a.email ? ' · ' + esc(a.email) : ''} · ${fdate(a.created_at)}</div>
        ${a.why ? `<div class="sub" style="margin-top:5px">${esc(a.why)}</div>` : ''}
      </div>
      <div class="btnrow">
        <form method="post" action="/owner/applications/${esc(a.id)}/approve" class="inline"><button class="btn sm pri">Approve</button></form>
        <form method="post" action="/owner/applications/${esc(a.id)}/decline" class="inline"><button class="btn sm ghost danger">Decline</button></form>
      </div></div>`).join('') + `</div>`;
  }
  h += `<div class="sec"><h2>Partners</h2><a class="btn sm pri" href="/owner/partners/new">Add partner</a></div>`;
  if (!rows.length) return frame(ctx, '/owner/partners', h + `<div class="card"><div class="empty">No partners yet. Add one, or share the apply link.</div></div>`);
  h += `<div class="card scrollx"><table class="tbl"><thead><tr>
    <th>Partner</th><th>Code</th><th class="rt">Leads</th><th class="rt">Paid jobs</th><th class="rt">Owed</th><th class="rt">Paid</th></tr></thead><tbody>` +
    rows.map(r => `<tr>
      <td><a href="/owner/partners/${esc(r.id)}" style="font-weight:600;text-decoration:none">${esc(r.name)}</a>
        ${r.status === 'paused' ? ' <span class="pill st-lost"><span class="dot"></span>Paused</span>' : ''}
        <div class="tiny muted">${esc(r.email)}</div></td>
      <td class="mono">${esc(r.code)}</td>
      <td class="rt num">${r.leads}</td><td class="rt num">${r.settled}</td>
      <td class="rt amt">${M.money0(r.owed)}</td><td class="rt amt muted">${M.money0(r.paid)}</td></tr>`).join('') +
    `</tbody></table></div>`;
  return frame(ctx, '/owner/partners', h);
}

function ownerPartnerNew(ctx, err) {
  const body = `<p><a class="small" href="/owner/partners">← Partners</a></p>
  <div class="sec" style="margin-top:6px"><h2>Add a partner</h2></div>${flash('bad', err)}
  <div class="card pad"><form method="post" action="/owner/partners/new">
    <label class="f"><span>Name</span><input type="text" name="name" required></label>
    <div class="grid2">
      <label class="f"><span>Email (their sign-in)</span><input type="email" name="email" required></label>
      <label class="f"><span>Phone</span><input type="tel" name="phone"></label></div>
    <label class="f"><span>Pay them at (optional)</span><input type="text" name="pay_handle" placeholder="$cashtag or @venmo-username"></label>
    <label class="f"><span>Temporary password</span><input type="text" name="password" required minlength="8" value="">
      <div class="hint">At least 8 characters. Text it to them — they can change it once they're in.</div></label>
    <button class="btn pri full">Add partner</button>
  </form></div>`;
  return frame(ctx, '/owner/partners', body);
}

/* The owner sends this themselves — from their own phone or mail app, so it
   arrives from a number the partner recognises. */
function inviteCard(ctx, p, token, mailState) {
  const base = ctx.settings.base_url || '';
  const url = base + '/invite/' + token;
  const shop = ctx.settings.business_name || 'Prestige Mobile Cleaning';
  const first = String(p.name || '').split(' ')[0];
  const msg = 'Hey ' + first + " — you're set up as a referral partner for " + shop + '. '
            + 'Open this link to pick your password and get your code: ' + url;
  const sms = 'sms:' + String(p.phone || '').replace(/[^0-9+]/g, '') + '?&body=' + encodeURIComponent(msg);
  const mail = 'mailto:' + encodeURIComponent(p.email || '')
             + '?subject=' + encodeURIComponent('Your ' + shop + ' partner sign-in')
             + '&body=' + encodeURIComponent(msg);
  const MAILNOTE = {
    sent: ['ok', 'Emailed to ' + (p.email || '') + '. Send the link yourself too if you want it to land faster.'],
    off: ['', ''],
    no_email: ['bad', 'No email on file for them, so nothing was sent.'],
    no_sender: ['bad', 'Email is on, but no “send from” address is set in Settings.'],
  };
  const note = MAILNOTE[mailState] || (mailState ? ['bad', 'Email failed: ' + mailState] : ['', '']);
  return `<div class="card pad" style="margin-bottom:14px;border-color:var(--blueline)">
    ${note[0] ? flash(note[0], note[1]) : ''}
    <div class="eyebrow" style="margin-bottom:6px">Send this to ${esc(p.name)}</div>
    <div class="mono small" id="invlink" style="word-break:break-all;background:var(--surface2);
         border-radius:8px;padding:9px 10px;margin-bottom:10px">${esc(url)}</div>
    <div class="btnrow">
      <button class="btn pri" type="button" id="invcopy">Copy link</button>
      ${p.phone ? `<a class="btn" href="${esc(sms)}">Text it</a>` : ''}
      ${p.email ? `<a class="btn" href="${esc(mail)}">Email it</a>` : ''}
    </div>
    <p class="tiny muted" style="margin:10px 0 0">Good for ${14} days, works once. Making a new link cancels this one.</p>
    <script>
      (function(){
        var b=document.getElementById('invcopy');
        if(!b) return;
        b.addEventListener('click',function(){
          var t=document.getElementById('invlink').textContent;
          var done=function(ok){ b.textContent = ok ? 'Copied' : 'Select it and copy';
            setTimeout(function(){ b.textContent='Copy link'; },1800); };
          if(navigator.clipboard&&navigator.clipboard.writeText){
            navigator.clipboard.writeText(t).then(function(){done(true);},function(){done(false);});
          } else { done(false); }
        });
      })();
    <\/script>
  </div>`;
}

function ownerPartnerDetail(ctx, p, d, tempPassword, inviteToken, mailState) {
  const link = ctx.settings.base_url ? ctx.settings.base_url + '/r/' + p.code : '/r/' + p.code;
  const body = `<p><a class="small" href="/owner/partners">← Partners</a></p>
  <div class="sec" style="margin-top:6px"><h2>${esc(p.name)}</h2></div>
  ${tempPassword ? flash('ok', 'New password set: ' + tempPassword + ' — send it to them now, it is not shown again.') : ''}
  ${inviteToken ? inviteCard(ctx, p, inviteToken, mailState) : ''}
  <div class="codebox" style="margin-bottom:14px"><div style="flex:1">
    <div class="eyebrow">Referral code</div><div class="codeval">${esc(p.code)}</div>
    <div class="tiny muted" style="margin-top:6px">Their booking link: <span class="mono">${esc(link)}</span></div>
  </div></div>
  <div class="tiles" style="margin-bottom:14px">
    ${tile('Leads', d.leads, 'sent in')}
    ${tile('Owed', M.money0(d.owed), 'customer paid', true)}
    ${tile('Paid', M.money0(d.paid), 'all-time')}
  </div>
  <div class="card pad" style="margin-bottom:14px">
    <div class="eyebrow" style="margin-bottom:6px">Their sign-in</div>
    <p class="small muted" style="margin:0 0 10px">The app doesn\u2019t send email or texts. Make a link and send it
    yourself — they pick their own password, so you never have to send one.</p>
    <form method="post" action="/owner/partners/${esc(p.id)}/invite">
      <button class="btn pri full">${inviteToken ? 'Make a new link' : 'Make a sign-in link'}</button></form>
  </div>
  <div class="card pad"><form method="post" action="/owner/partners/${esc(p.id)}">
    <label class="f"><span>Name</span><input type="text" name="name" value="${esc(p.name)}"></label>
    <div class="grid2">
      <label class="f"><span>Email</span><input type="email" name="email" value="${esc(p.email)}"></label>
      <label class="f"><span>Phone</span><input type="tel" name="phone" value="${esc(p.phone || '')}"></label></div>
    <label class="f"><span>Referral code</span><input type="text" name="code" value="${esc(p.code || '')}" maxlength="20"
      autocapitalize="characters" autocomplete="off" spellcheck="false" style="text-transform:uppercase;letter-spacing:.06em"></label>
    ${d.oldCodes && d.oldCodes.length ? `<p class="tiny muted" style="margin:-6px 0 12px">Old codes that still reach them: <span class="mono">${d.oldCodes.map(esc).join(' · ')}</span></p>` : ''}
    <label class="f"><span>Pay them at</span><input type="text" name="pay_handle" value="${esc(p.pay_handle || '')}" placeholder="$cashtag or @venmo-username"></label>
    <div class="grid2">
      <label class="f"><span>Custom rate</span><select name="rate_mode">
        <option value="">Use the program default</option>
        <option value="flat"${p.rate_mode === 'flat' ? ' selected' : ''}>Flat amount</option>
        <option value="percent"${p.rate_mode === 'percent' ? ' selected' : ''}>Percentage</option>
      </select></label>
      <label class="f"><span>Amount (dollars or percent)</span><input type="number" step="0.5" min="0" name="rate_value" value="${p.rate_value != null ? esc(p.rate_value) : ''}"></label></div>
    <label class="f"><span>Status</span><select name="status">
      <option value="active"${p.status !== 'paused' ? ' selected' : ''}>Active</option>
      <option value="paused"${p.status === 'paused' ? ' selected' : ''}>Paused</option></select></label>
    <button class="btn pri">Save</button>
  </form></div>
  <div class="btnrow" style="margin-top:12px">
    <form method="post" action="/owner/partners/${esc(p.id)}/password" class="inline"><button class="btn">Reset password</button></form>
    <form method="post" action="/owner/partners/${esc(p.id)}/delete" class="inline"
      onsubmit="return confirm('Remove this partner? Only works if they have no leads.')">
      <button class="btn ghost danger">Remove</button></form>
  </div>`;
  return frame(ctx, '/owner/partners', body);
}

function ownerPayouts(ctx, owedList, history, heldCount) {
  const total = owedList.reduce((a, x) => a + x.owed, 0);
  let h = `<div class="tiles">
    ${tile('Owed right now', M.money0(total), owedList.length + ' partner' + (owedList.length === 1 ? '' : 's'), true)}
    ${tile('Paid all-time', M.money0(history.reduce((a, p) => a + Number(p.amount), 0)), history.length + ' payout' + (history.length === 1 ? '' : 's'))}
  </div><div class="sec"><h2>Ready to pay</h2></div>`;
  if (!owedList.length) {
    h += `<div class="card"><div class="empty">Nothing owed yet. ` +
      (heldCount ? `${heldCount} job${heldCount === 1 ? '' : 's'} finished but not yet paid for by the customer — commission unlocks when you mark them <strong>Customer paid</strong>.`
                 : `Commission lands here once a job is done <em>and</em> the customer has paid.`) + `</div></div>`;
  } else {
    h += `<div class="card list">` + owedList.map(x => `<a class="item" href="/owner/payouts/${esc(x.partner.id)}">
      <div class="grow"><div class="ttl">${esc(x.partner.name)}</div>
        <div class="sub">${x.jobs} paid job${x.jobs === 1 ? '' : 's'} · ${esc(x.partner.code)}</div></div>
      <span class="amt" style="color:var(--brass);font-size:16px">${M.money0(x.owed)}</span></a>`).join('') + `</div>`;
  }
  h += `<div class="sec"><h2>Payout history</h2></div>`;
  if (!history.length) return frame(ctx, '/owner/payouts', h + `<div class="card"><div class="empty">No payouts recorded yet.</div></div>`);
  h += `<div class="card scrollx"><table class="tbl"><thead><tr><th>Date</th><th>Partner</th><th>Method</th><th class="rt">Jobs</th><th class="rt">Amount</th></tr></thead><tbody>` +
    history.map(p => `<tr><td class="num">${fdate(p.paid_on)}</td><td>${esc(p.partner_name || '—')}</td>
      <td>${esc(p.method || '—')}</td><td class="rt num">${p.jobs}</td><td class="rt amt">${M.money0(p.amount)}</td></tr>`).join('') +
    `</tbody></table></div>`;
  return frame(ctx, '/owner/payouts', h);
}

function ownerPayScreen(ctx, p, leads, today) {
  const total = M.round2(leads.reduce((a, l) => a + Number(l.commission || 0), 0));
  const note = ctx.settings.business_name + ' referral commission — ' + leads.length + ' job' + (leads.length === 1 ? '' : 's');
  const link = payLink(p.pay_handle, total, note);
  const methods = ['Cash App', 'Venmo', 'Zelle', 'Cash', 'Check', 'Other'];
  const def = link ? link.app : 'Cash App';

  const body = `<p><a class="small" href="/owner/payouts">← Payouts</a></p>
  <div class="sec" style="margin-top:6px"><h2>Pay ${esc(p.name)}</h2></div>
  <div class="card pad" style="background:var(--brassbg);border-color:var(--brassline);margin-bottom:14px">
    <div class="eyebrow">Total owed</div>
    <div style="font-family:Archivo;font-weight:700;font-size:28px;color:var(--brass)">${M.money0(total)}</div>
    <div class="tiny muted">${leads.length} job${leads.length === 1 ? '' : 's'} the customer has paid for</div>
  </div>
  <div class="card list" style="margin-bottom:14px">${leads.map(l => `<div class="item">
    <div class="grow"><div class="ttl">${esc(l.customer)}</div>
      <div class="sub">${esc(l.service)} · ${M.money0(l.job_total || 0)} job · settled ${fdate(l.settled_at)}</div></div>
    <span class="amt">${M.money0(l.commission || 0)}</span></div>`).join('')}</div>
  ${link
    ? `<a class="btn pri full" style="margin-bottom:8px" href="${esc(link.url)}" target="_blank" rel="noopener">Open ${esc(link.app)} — ${M.money0(total)}</a>
       <p class="hint" style="margin:-2px 0 14px">Goes to <span class="mono">${esc(p.pay_handle)}</span> with the amount filled in — you still confirm the send inside ${esc(link.app)}. Then record it below.</p>`
    : `<div class="card pad small" style="margin-bottom:14px"><div class="eyebrow" style="margin-bottom:5px">One-tap pay</div>
       Add a $cashtag or @venmo-username on ${esc(String(p.name).split(' ')[0])}'s profile and a pay button shows up here.
       <div style="margin-top:9px"><a class="btn sm" href="/owner/partners/${esc(p.id)}">Add their handle</a></div></div>`}
  <form method="post" action="/owner/payouts/${esc(p.id)}">
    <div class="grid2">
      <label class="f"><span>Method</span><select name="method">${methods.map(m => `<option${m === def ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
      <label class="f"><span>Date paid</span><input type="date" name="paid_on" value="${esc(today)}"></label>
    </div>
    <button class="btn ${link ? '' : 'pri '}full"${leads.length ? '' : ' disabled'}>${link ? 'I sent it — record ' + M.money0(total) : 'Record ' + M.money0(total) + ' payout'}</button>
  </form>`;
  return frame(ctx, '/owner/payouts', body);
}

function ownerSettings(ctx, services) {
  const s = ctx.settings;
  const f = (name, label, val, hint, type) => `<label class="f"><span>${esc(label)}</span>
    <input type="${type || 'text'}" name="${esc(name)}" value="${esc(val == null ? '' : val)}">
    ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</label>`;

  const body = `<div class="sec"><h2>Your business</h2></div>
  <div class="card pad"><form method="post" action="/owner/settings">
    ${f('business_name', 'Business name', s.business_name)}
    ${f('tagline', 'Tagline', s.tagline)}
    ${f('phone', 'Phone', s.phone, '', 'tel')}
    ${f('service_area', 'Service area', s.service_area)}
    ${f('website', 'Website', s.website)}
    ${f('booking_url', 'Booking link (where customers pick a time)', s.booking_url, 'Your Square Appointments page. Customers land here once their details are captured.')}
    ${f('toolkit_url', 'Toolkit link (partner scripts)', s.toolkit_url)}
    ${f('payout_note', 'How and when you pay', s.payout_note)}
    <button class="btn pri">Save business info</button>
  </form></div>

  <div class="sec"><h2>Email</h2></div>
  <div class="card pad">
    ${s.mail_on
      ? `<p class="small muted" style="margin-top:0">Email is <b>on</b>. New partners get their sign-in link automatically
         the moment you approve them — you can still text it as well.</p>`
      : `<p class="small muted" style="margin-top:0">Email is <b>off</b>, so you send sign-in links yourself.
         To switch it on, add a <span class="mono">RESEND_API_KEY</span> in your Render dashboard under
         Environment, then redeploy. Nothing else changes.</p>`}
    <form method="post" action="/owner/settings">
      ${f('mail_from', 'Send emails from', s.mail_from, 'e.g. Prestige Mobile Cleaning <partners@prestigecleaning.us> — the domain has to be verified with Resend.')}
      ${f('mail_reply_to', 'Replies go to', s.mail_reply_to, 'Optional. Your normal inbox.')}
      <button class="btn pri">Save email settings</button>
    </form>
    ${s.mail_on ? `<form method="post" action="/owner/settings/test-email" style="margin-top:12px">
      <label class="f"><span>Send a test to</span><input type="email" name="to" value="${esc(ctx.user.email || '')}"></label>
      <button class="btn full">Send a test email</button></form>` : ''}
  </div>

  <div class="sec"><h2>Commission</h2></div>
  <div class="card pad"><form method="post" action="/owner/settings/rates">
    <label class="f"><span>How partners get paid</span><select name="rate_mode">
      ${[['flat', 'Flat amount per paid job'], ['percent', 'Percentage of the job total'], ['service', 'Set per service']]
        .map(m => `<option value="${m[0]}"${s.rate_mode === m[0] ? ' selected' : ''}>${esc(m[1])}</option>`).join('')}
    </select></label>
    <div class="grid2">
      ${f('rate_flat', 'Flat amount ($)', s.rate_flat, '', 'number')}
      ${f('rate_percent', 'Percentage (%)', s.rate_percent, '', 'number')}
    </div>
    <button class="btn pri">Save commission</button>
    <p class="hint" style="margin-top:10px">Commission locks in the moment you mark a customer as paid, so changing rates never rewrites what you already owe.</p>
  </form></div>

  <div class="sec"><h2>Services &amp; prices</h2></div>
  <div class="card scrollx"><form method="post" action="/owner/settings/services" id="svcform">
    <table class="tbl wide"><thead><tr><th>Service</th><th class="rt">Price</th><th class="rt">Payout</th><th></th></tr></thead><tbody>
    ${services.map(v => `<tr>
      <td><input type="text" name="name_${esc(v.id)}" value="${esc(v.name)}"></td>
      <td class="rt"><input type="number" step="1" min="0" name="price_${esc(v.id)}" value="${esc(v.price)}" style="max-width:110px;text-align:right"></td>
      <td class="rt"><input type="number" step="1" min="0" name="payout_${esc(v.id)}" value="${esc(v.payout)}" style="max-width:110px;text-align:right"></td>
      <td><label class="small" style="white-space:nowrap"><input type="checkbox" name="del_${esc(v.id)}" style="width:auto"> remove</label></td></tr>`).join('')}
    <tr><td><input type="text" name="new_name" placeholder="New service"></td>
      <td class="rt"><input type="number" step="1" min="0" name="new_price" placeholder="0" style="max-width:110px;text-align:right"></td>
      <td class="rt"><input type="number" step="1" min="0" name="new_payout" placeholder="0" style="max-width:110px;text-align:right"></td>
      <td></td></tr>
    </tbody></table></form></div>
  <div class="btnrow" style="margin-top:10px"><button class="btn pri" form="svcform">Save services</button></div>

  <div class="sec"><h2>Your password</h2></div>
  <div class="card pad"><form method="post" action="/account/password">
    <div class="grid2">
      <label class="f"><span>Current password</span><input type="password" name="current" required></label>
      <label class="f"><span>New password</span><input type="password" name="next" required minlength="8"></label>
    </div><button class="btn pri">Change password</button>
  </form></div>

  <div class="sec"><h2>Backup</h2></div>
  <div class="card pad"><p class="small muted" style="margin-top:0">Everything — partners, leads, payouts, materials — in one file.
    Grab one before any big change, and every so often besides.</p>
    <a class="btn" href="/owner/backup">Download a backup</a></div>`;
  return frame(ctx, '/owner/settings', body);
}

function ownerAssets(ctx, list) {
  const body = `<div class="sec"><h2>Marketing materials</h2><span class="eyebrow">${list.length} file${list.length === 1 ? '' : 's'}</span></div>
  <p class="small muted" style="margin-top:-6px">Everything here shows up in every partner's portal, ready to download.</p>
  <div class="card pad" style="margin-bottom:16px">
    <form method="post" action="/owner/assets" enctype="multipart/form-data">
      <label class="f"><span>Add files</span><input type="file" name="files" multiple accept="image/*,application/pdf,video/mp4"></label>
      <label class="f"><span>Label (optional)</span><input type="text" name="title" placeholder="e.g. Instagram post — packages"></label>
      <button class="btn pri">Upload</button>
      <div class="hint">Images, PDFs and MP4s. Up to 10MB each.</div>
    </form>
  </div>
  ${list.length ? `<div class="assetgrid">${list.map(a => `<div class="asset">
      ${String(a.content_type).startsWith('image/') ? `<img src="/asset/${esc(a.id)}" alt="${esc(a.title || a.filename)}" loading="lazy">` : ''}
      <div class="meta"><div class="nm">${esc(a.title || a.filename)}</div>
        <div class="sz">${esc(bytes(a.bytes))} · ${esc(String(a.content_type).split('/')[1] || '')}</div>
        <div class="btnrow">
          <a class="btn sm" href="/asset/${esc(a.id)}?dl=1">Download</a>
          <form method="post" action="/owner/assets/${esc(a.id)}/delete" class="inline" onsubmit="return confirm('Delete this file?')">
            <button class="btn sm ghost danger">Delete</button></form>
        </div></div></div>`).join('')}</div>`
    : `<div class="card"><div class="empty">No materials yet. Upload the graphics you want partners posting.</div></div>`}`;
  return frame(ctx, '/owner/assets', body);
}

/* ============================================================ PARTNER */

function partnerHome(ctx, d) {
  const s = ctx.settings, p = ctx.user;
  const link = (s.base_url || '') + '/r/' + p.code;
  const r = M.rateFor(p, s);
  const rateText = r.mode === 'flat' ? M.money0(r.flat) + ' per paid job'
    : r.mode === 'percent' ? r.percent + '% of every job total'
    : 'set per service';

  let h = `<div class="sec" style="margin-top:4px"><h2>Hey ${esc(String(p.name).split(' ')[0])}</h2></div>
  <div class="codebox"><div style="flex:1">
    <div class="eyebrow">Your code</div><div class="codeval">${esc(p.code)}</div></div></div>
  <div class="card pad" style="margin-top:10px">
    <details${d.oldCodes.length ? '' : ''}>
      <summary class="small" style="cursor:pointer;font-weight:600">Change my code</summary>
      <form method="post" action="/partner/code" style="margin-top:10px">
        <label class="f"><span>Make it yours</span>
          <input type="text" name="code" value="${esc(p.code)}" maxlength="20"
                 autocapitalize="characters" autocomplete="off" spellcheck="false"
                 style="text-transform:uppercase;letter-spacing:.06em"></label>
        <p class="tiny muted" style="margin:0 0 10px">Letters and numbers, 3–20 characters. Pick something people
        can hear over the phone and spell back to you.</p>
        <button class="btn pri">Save my code</button>
      </form>
      <p class="tiny muted" style="margin:12px 0 0">Changing it never affects leads you already sent, and
      your old code keeps working — anything you already posted or handed out still pays you.</p>
    </details>${d.oldCodes.length ? `
    <p class="tiny muted" style="margin:10px 0 0">Still working: <span class="mono">${d.oldCodes.map(esc).join(' · ')}</span></p>` : ''}
  </div>
  <div class="card pad" style="margin-top:10px">
    <div class="eyebrow" style="margin-bottom:5px">Your booking link</div>
    <div class="mono small" style="word-break:break-all;margin-bottom:10px">${esc(link)}</div>
    <p class="small muted" style="margin:0">Anyone who books through this link is tied to you automatically — the code is already filled in.</p>
  </div>
  <div class="tiles" style="margin-top:12px">
    ${tile('Ready for you', M.money0(d.owed), 'customer paid · waiting on the shop', true)}
    ${tile('On hold', M.money0(d.held), d.heldCount + ' job' + (d.heldCount === 1 ? '' : 's') + ' awaiting payment')}
    ${tile('In progress', M.money0(d.pipeline), d.openCount + ' lead' + (d.openCount === 1 ? '' : 's') + ' still open')}
    ${tile('Paid to you', M.money0(d.paid), d.settledCount + ' closed job' + (d.settledCount === 1 ? '' : 's'))}
  </div>
  <div class="sec"><h2>Send a lead</h2></div>
  <div class="card pad"><p class="small muted" style="margin-top:0">Two ways to earn: put someone in yourself, or share your link and let them book.</p>
    <div class="btnrow"><a class="btn pri" href="/partner/new">Add a lead</a>
      <a class="btn" href="/partner/assets">Get the graphics</a></div></div>`;

  if (s.toolkit_url) {
    h += `<div class="sec"><h2>Your toolkit</h2></div>
    <div class="card pad"><p class="small muted" style="margin-top:0">Scripts you can copy, captions, and answers for when someone pushes back.</p>
      <a class="btn pri full" href="${esc(s.toolkit_url)}" target="_blank" rel="noopener">Open the toolkit</a></div>`;
  }

  h += `<div class="sec"><h2>What you earn</h2></div>
  <div class="card pad"><p style="margin:0 0 6px"><strong>${esc(rateText)}</strong></p>
    <p class="small muted" style="margin:0">${esc(s.hold_note)} ${esc(s.payout_note)}</p></div>`;

  if (d.recent.length) {
    h += `<div class="sec"><h2>Recent</h2><a class="btn sm ghost" href="/partner/leads">See all</a></div>
      <div class="card list">${d.recent.map(l => partnerLeadRow(l, p, s)).join('')}</div>`;
  }
  return frame(ctx, '/partner', h);
}

function partnerLeadRow(l, p, s) {
  const amt = estLabel(l, p, s);
  return `<div class="item"><div class="grow"><div class="ttl">${esc(l.customer)}</div>
    <div class="sub">${esc(l.service || '—')} · sent ${fdate(l.created_at)}</div></div>
    <div style="text-align:right;display:flex;flex-direction:column;gap:4px;align-items:flex-end">
      ${l.payout_id ? '<span class="pill st-paid"><span class="dot"></span>Paid</span>' : pill(l.status, L)}
      <span class="amt muted">${esc(amt)}</span></div></div>`;
}

function partnerNewLead(ctx, services, err) {
  const s = ctx.settings;
  const body = `<div class="sec" style="margin-top:4px"><h2>Send a lead</h2></div>${flash('bad', err)}
  <div class="card pad">
    <p class="small muted" style="margin-top:0">The more you fill in, the faster we can close it — and the faster you get paid.</p>
    <p class="tiny muted" style="margin:-4px 0 12px">We cover ${esc(s.service_area)}.</p>
    <form method="post" action="/partner/new">
      <label class="f"><span>Customer name</span><input type="text" name="customer" required></label>
      <div class="grid2">
        <label class="f"><span>Phone</span><input type="tel" name="phone" required></label>
        <label class="f"><span>Best time to reach them</span><input type="text" name="best_time" placeholder="Weekday mornings"></label></div>
      <label class="f"><span>Vehicle</span><input type="text" name="vehicle" placeholder="2019 Tahoe, black — or boat, RV, motorcycle"></label>
      <label class="f"><span>Where is it parked?</span><input type="text" name="address" placeholder="Sandy Springs, Marietta, Duluth"></label>
      <label class="f"><span>Service they want</span><select name="service">
        ${services.map(x => `<option value="${esc(x.name)}">${esc(x.name)}${x.price ? ' — $' + x.price : ''}</option>`).join('')}
        <option value="Not sure yet">Not sure yet</option></select></label>
      <label class="f"><span>Anything else</span><textarea name="notes"></textarea></label>
      <button class="btn pri full">Send to the shop</button>
    </form></div>`;
  return frame(ctx, '/partner/new', body);
}

function partnerLeads(ctx, list) {
  const s = ctx.settings, p = ctx.user;
  const body = `<div class="sec" style="margin-top:4px"><h2>${list.length} lead${list.length === 1 ? '' : 's'}</h2>
    <a class="btn sm pri" href="/partner/new">Add a lead</a></div>
    <div class="card list">${list.length ? list.map(l => partnerLeadRow(l, p, s)).join('')
      : '<div class="empty">Nothing sent yet. Your first lead goes here.</div>'}</div>`;
  return frame(ctx, '/partner/leads', body);
}

function partnerEarnings(ctx, d) {
  const s = ctx.settings;
  let h = `<div class="tiles" style="margin-top:4px">
    ${tile('Ready for you', M.money0(d.owed), d.owedLeads.length + ' job' + (d.owedLeads.length === 1 ? '' : 's') + ' paid for', true)}
    ${tile('Paid to date', M.money0(d.paid), d.payouts.length + ' payout' + (d.payouts.length === 1 ? '' : 's'))}
  </div>`;
  if (d.heldLeads.length) {
    h += `<div class="sec"><h2>Job done, customer hasn't paid yet</h2></div>
    <div class="card list">${d.heldLeads.map(l => `<div class="item">
      <div class="grow"><div class="ttl">${esc(l.customer)}</div>
        <div class="sub">${esc(l.service)} · finished ${fdate(l.completed_at)}</div></div>
      <span class="amt muted">${M.money0(M.projected(l, ctx.user, s))} held</span></div>`).join('')}</div>
    <p class="hint" style="margin-top:8px">${M.money0(d.heldAmt)} unlocks as soon as the customer settles up.</p>`;
  }
  h += `<div class="sec"><h2>Earned, ready to be paid</h2></div>
  <div class="card list">${d.owedLeads.length ? d.owedLeads.map(l => `<div class="item">
      <div class="grow"><div class="ttl">${esc(l.customer)}</div>
        <div class="sub">${esc(l.service)} · customer paid ${fdate(l.settled_at)}</div></div>
      <span class="amt">${M.money0(l.commission || 0)}</span></div>`).join('')
    : `<div class="empty">Nothing pending. ${esc(s.payout_note)}</div>`}</div>
  <div class="sec"><h2>Payout history</h2></div>
  <div class="card list">${d.payouts.length ? d.payouts.map(p => `<div class="item">
      <div class="grow"><div class="ttl">${M.money0(p.amount)}</div>
        <div class="sub">${esc(p.method || '—')} · ${p.jobs} job${p.jobs === 1 ? '' : 's'}</div></div>
      <span class="amt muted num">${fdate(p.paid_on)}</span></div>`).join('')
    : '<div class="empty">No payouts yet.</div>'}</div>

  <div class="sec"><h2>Where your money goes</h2></div>
  <div class="card pad"><form method="post" action="/partner/account">
    <label class="f"><span>Cash App $cashtag or Venmo @username</span>
      <input type="text" name="pay_handle" value="${esc(ctx.user.pay_handle || '')}" placeholder="$yourcashtag"></label>
    <button class="btn pri sm">Save</button></form></div>

  <div class="sec"><h2>Your password</h2></div>
  <div class="card pad"><form method="post" action="/account/password">
    <div class="grid2">
      <label class="f"><span>Current password</span><input type="password" name="current" required></label>
      <label class="f"><span>New password</span><input type="password" name="next" required minlength="8"></label>
    </div><button class="btn pri sm">Change password</button></form></div>`;
  return frame(ctx, '/partner/earnings', h);
}

function partnerAssets(ctx, list, plates) {
  const code = String(ctx.user.code || '');
  const personal = list.filter(a => plates[a.filename]).length;
  const body = `<div class="sec" style="margin-top:4px"><h2>Marketing materials</h2></div>
  <p class="small muted" style="margin-top:-6px">${personal
      ? 'Your code <b>' + esc(code) + '</b> is printed onto these when you download them — nobody else\u2019s.'
      : 'Download these and post them. Your code is <b>' + esc(code) + '</b> — put it in the caption.'}</p>
  ${list.length ? `<div class="assetgrid" style="margin-top:14px">${list.map(a => {
    const img = String(a.content_type).startsWith('image/');
    const spec = plates[a.filename];
    return `<div class="asset"${spec ? ` data-plate="${esc(JSON.stringify(spec.plate))}"` : ''}>
      ${img ? `<img src="/asset/${esc(a.id)}" alt="${esc(a.title || a.filename)}"${spec ? ' crossorigin="anonymous"' : ' loading="lazy"'}>` : ''}
      <div class="meta"><div class="nm">${esc(a.title || a.filename)}</div>
        <div class="sz">${esc(bytes(a.bytes))}</div>
        <a class="btn sm full${spec ? ' pri stamp' : ''}" href="/asset/${esc(a.id)}?dl=1"
           ${spec ? `download="${esc(String(a.filename).replace(/\.png$/i, ''))}-${esc(code)}.png"` : ''}>${
          spec ? 'Download with my code' : 'Download'}</a></div></div>`;
  }).join('')}</div>`
    : `<div class="card" style="margin-top:14px"><div class="empty">Nothing here yet — the shop hasn\u2019t uploaded materials.</div></div>`}
  ${personal ? `<p class="tiny muted" style="margin-top:12px">If a download ever comes through without the code on it,
  press and hold the picture above and save it from there — it is already stamped.</p>` : ''}
  <script>${STAMP_JS.replace('__CODE__', JSON.stringify(code))}<\/script>`;
  return frame(ctx, '/partner/assets', body);
}

/* Paints the partner's code into the blank plate, in their own browser, and
   hands the stamped PNG to the download. No image library on the server. */
const STAMP_JS = `
(function(){
  var CODE = __CODE__;
  var FAMILY = '"Arial Narrow","Helvetica Neue Condensed Bold","Liberation Sans Narrow",Arial,sans-serif';

  function stamp(img, plate){
    var c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    var g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    var k = c.width / 1080;
    var x = plate.x * k, y = plate.y * k, w = plate.w * k, h = plate.h * k;
    try { g.letterSpacing = '0.03em'; } catch (e) {}
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#ffffff';
    var size = h;
    while (size > 8) {
      g.font = '700 ' + size + 'px ' + FAMILY;
      if (g.measureText(CODE).width <= w) break;
      size -= 1;
    }
    g.font = '700 ' + size + 'px ' + FAMILY;
    g.fillText(CODE, x + w / 2, y + h / 2);
    return c;
  }

  function ready(el, fn){
    var img = el.querySelector('img');
    if (!img) return;
    if (img.complete && img.naturalWidth) return fn(img);
    img.addEventListener('load', function(){ fn(img); }, { once: true });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.asset[data-plate]'), function(el){
    var plate;
    try { plate = JSON.parse(el.getAttribute('data-plate')); } catch (e) { return; }
    ready(el, function(img){
      var canvas;
      try { canvas = stamp(img, plate); } catch (e) { return; }
      // Show the stamped version, so what they see is what they get.
      try {
        img.src = canvas.toDataURL('image/png');
      } catch (e) {}
      var link = el.querySelector('a.stamp');
      if (!link || !canvas.toBlob) return;
      link.addEventListener('click', function(ev){
        if (link.dataset.armed === '1') { link.dataset.armed = ''; return; }
        ev.preventDefault();
        canvas.toBlob(function(blob){
          if (!blob) { link.dataset.armed = '1'; link.click(); return; }
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = link.getAttribute('download') || 'prestige.png';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
        }, 'image/png');
      });
    });
  });
})();
`;


module.exports = {
  ownerOverview, ownerLeads, ownerLeadDetail, ownerNewLead,
  ownerPartners, ownerPartnerNew, ownerPartnerDetail,
  ownerPayouts, ownerPayScreen, ownerSettings, ownerAssets,
  partnerHome, partnerNewLead, partnerLeads, partnerEarnings, partnerAssets,
  estLabel,
};
