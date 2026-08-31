'use strict';
const { esc } = require('../http');
const { page, flash, LOGO } = require('./layout');

function head(s, subtitle, customer) {
  return `<div class="gatehead"><img class="mark" src="${LOGO}" alt="">
    <h1>${esc(s.business_name)}</h1>
    <p>${esc(subtitle)}</p>
    ${s.tagline && !customer ? `<div class="tag">${esc(s.tagline)}</div>` : ''}
    ${s.tagline && customer ? `<div class="tag">${esc(s.tagline)}</div>` : ''}
  </div>`;
}

function foot(s, customer) {
  const social = `<div class="social">
    <a href="tel:${esc(String(s.phone).replace(/[^0-9+]/g, ''))}">${esc(s.phone)}</a>
    <a href="https://www.instagram.com/prestigemobilecleaning" target="_blank" rel="noopener">Instagram</a>
    <a href="https://www.facebook.com/prestigemobilecleaning" target="_blank" rel="noopener">Facebook</a>
    ${s.website ? `<a href="${esc(s.website)}" target="_blank" rel="noopener">${esc(String(s.website).replace(/^https?:\/\//, ''))}</a>` : ''}
  </div>`;
  const trust = `<div class="trust"><span><b>4.9</b> Google · 89 reviews</span><span><b>5.0</b> Yelp · 26 reviews</span></div>`;
  return trust + social + (customer ? '' :
    `<p class="tiny muted" style="text-align:center;margin-top:14px">Partner and owner areas are password protected.</p>`);
}

/* ------------------------------------------------------------- landing */

function landing(s, msg) {
  return page({
    title: s.business_name + ' · Referrals',
    body: `<div class="gate">${head(s, 'Referral Program')}${flash('bad', msg)}
      <div class="pick">
        <a class="card pickbtn book" href="/book"><div class="grow">
          <div class="ttl">Book a detail</div><div class="sub">We come to you — packages from $200</div>
        </div><span class="chip gold">Start</span></a>
        <div class="divider"><span>or sign in</span></div>
        <a class="card pickbtn" href="/login"><div class="grow">
          <div class="ttl">Partner sign in</div><div class="sub">Send a lead, check what you've earned</div>
        </div><span class="chip">Sign in</span></a>
        <a class="card pickbtn" href="/apply"><div class="grow">
          <div class="ttl">I want to join</div><div class="sub">Apply to start earning on referrals</div>
        </div><span class="chip">Apply</span></a>
      </div>${foot(s)}</div>`,
  });
}

/* ---------------------------------------------------------------- login */

function login(s, err, email) {
  return page({
    title: 'Sign in · ' + s.business_name,
    body: `<div class="gate">${head(s, 'Referral Program')}${flash('bad', err)}
      <div class="card pad">
        <h3 style="font-size:16px;margin-bottom:12px">Sign in</h3>
        <form method="post" action="/login">
          <label class="f"><span>Email</span><input type="email" name="email" autocomplete="username" value="${esc(email || '')}" required></label>
          <label class="f"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
          <button class="btn pri full">Sign in</button>
        </form>
        <p class="hint" style="text-align:center;margin-top:12px">
          Forgot your password? Text ${esc(s.phone)} and we'll reset it.</p>
      </div>
      <p style="text-align:center;margin-top:16px"><a class="small" href="/">Back</a></p>
    </div>`,
  });
}

/* -------------------------------------------------------------- booking */

function bookForm(s, services, opts) {
  const o = opts || {};
  const svc = services.map(x =>
    `<option value="${esc(x.name)}"${o.service === x.name ? ' selected' : ''}>${esc(x.name)}${x.price ? ' — $' + x.price : ' — quote'}</option>`).join('');
  const referred = o.partnerName
    ? `<div class="banner ok" style="margin-bottom:14px"><strong>${esc(o.partnerName)}</strong> sent you — their code is filled in below.</div>`
    : '';
  return page({
    title: 'Book a detail · ' + s.business_name,
    body: `<div class="gate">${head(s, 'Mobile detailing — we come to you', true)}
      ${flash('bad', o.err)}
      <div class="card pad">${referred}
        <h3 style="font-size:17px;margin-bottom:4px">Tell us about the vehicle</h3>
        <p class="small muted" style="margin:0 0 14px">Takes 30 seconds. Next step you'll pick your day and time.</p>
        <form method="post" action="/book">
          <label class="f"><span>Referral code (if someone sent you)</span>
            <input type="text" name="code" value="${esc(o.code || '')}" autocapitalize="characters" autocomplete="off" placeholder="e.g. MELVIN98">
            <div class="hint">Leave blank if you found us on your own.</div></label>
          <label class="f"><span>Your name</span><input type="text" name="customer" value="${esc(o.customer || '')}" required></label>
          <label class="f"><span>Phone</span><input type="tel" name="phone" value="${esc(o.phone || '')}" required></label>
          <label class="f"><span>Vehicle</span><input type="text" name="vehicle" value="${esc(o.vehicle || '')}" placeholder="2019 Tahoe, black — or boat, RV, motorcycle"></label>
          <label class="f"><span>Where is it parked?</span><input type="text" name="address" value="${esc(o.address || '')}" placeholder="Sandy Springs, Marietta, Duluth — neighborhood is fine"></label>
          <label class="f"><span>What are you after?</span><select name="service">${svc}<option value="Not sure yet">Not sure yet — recommend something</option></select></label>
          <label class="f"><span>Anything we should know?</span><textarea name="notes" placeholder="Dog hair in the back seat, needs it done before Saturday...">${esc(o.notes || '')}</textarea></label>
          <button class="btn pri full">Continue to pick a time</button>
        </form>
        <p class="hint" style="text-align:center;margin-top:10px">Or just call us at ${esc(s.phone)}.</p>
      </div>
      <p class="tiny muted" style="text-align:center;margin-top:14px">We cover ${esc(s.service_area)}.</p>
      ${foot(s, true)}</div>`,
  });
}

function booked(s, firstName, partnerFirst) {
  return page({
    title: 'Almost done · ' + s.business_name,
    body: `<div class="gate">${head(s, 'Mobile detailing — we come to you', true)}
      <div class="card pad">
        <h3 style="font-size:18px;margin-bottom:6px">Got it${firstName ? ', ' + esc(firstName) : ''}</h3>
        <p class="small muted" style="margin:0 0 4px">We have your details${partnerFirst ? ' and we know ' + esc(partnerFirst) + ' sent you' : ''}. Last step is picking a day and time.</p>
        ${s.booking_url
          ? `<a class="btn pri full" style="margin-top:14px" href="${esc(s.booking_url)}" target="_blank" rel="noopener">Pick your time</a>`
          : `<p class="small" style="margin-top:12px">Call or text ${esc(s.phone)} and we'll get you scheduled.</p>`}
        <p class="hint" style="text-align:center;margin-top:10px">Questions? Call or text ${esc(s.phone)}.</p>
      </div>${foot(s, true)}</div>`,
  });
}

/* ---------------------------------------------------------------- apply */

function applyForm(s, err, f) {
  const v = f || {};
  return page({
    title: 'Apply · ' + s.business_name,
    body: `<div class="gate">${head(s, 'Referral Program')}${flash('bad', err)}
      <div class="card pad">
        <h3 style="font-size:16px;margin-bottom:4px">Apply to refer</h3>
        <p class="small muted" style="margin:0 0 12px">Send us cars, trucks, boats, RVs — anything with a surface. You get paid on every job that closes.</p>
        <form method="post" action="/apply">
          <label class="f"><span>Your name</span><input type="text" name="name" value="${esc(v.name || '')}" required></label>
          <label class="f"><span>Phone</span><input type="tel" name="phone" value="${esc(v.phone || '')}" required></label>
          <label class="f"><span>Email</span><input type="email" name="email" value="${esc(v.email || '')}" required>
            <div class="hint">This becomes your sign-in once you're approved.</div></label>
          <label class="f"><span>Who do you know that needs detailing?</span><textarea name="why" placeholder="My car club, coworkers at the dealership, the barber shop in Norcross...">${esc(v.why || '')}</textarea></label>
          <button class="btn pri full">Send application</button>
        </form>
      </div>
      <p style="text-align:center;margin-top:16px"><a class="small" href="/">Back</a></p>
    </div>`,
  });
}

function applied(s) {
  return page({
    title: 'Application sent · ' + s.business_name,
    body: `<div class="gate">${head(s, 'Referral Program')}
      <div class="card pad"><h3 style="font-size:16px">Application sent</h3>
      <p class="small muted">We'll review it and text you a sign-in once you're approved. Keep this link — it's where you'll log in.</p>
      <a class="btn full" href="/" style="margin-top:10px">Done</a></div></div>`,
  });
}

module.exports = { landing, login, bookForm, booked, applyForm, applied };
