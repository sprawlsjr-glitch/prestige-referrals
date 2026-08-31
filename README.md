# Prestige Referrals

The referral program for Prestige Mobile Cleaning: partners send leads, the shop
works them, commission is tracked, and payouts get recorded.

Built to run on one small Render service with **no npm dependencies at all** —
just Node 22's standard library and its built-in SQLite. Nothing to install means
nothing to break on deploy.

## What it does

**Customers** open a partner's booking link (`/r/MELVIN98`), fill in their details
with the referral code already filled in, and get handed off to Square Appointments
to pick a time. That's what makes attribution reliable: the code is captured
*before* a booking exists, so it can't be lost afterwards.

**Partners** get their own sign-in, their booking link, a lead form, their earnings
split into *held* and *ready*, and downloadable marketing materials.

**The owner** gets a dashboard, the lead pipeline, partner management, payouts with
one-tap Cash App / Venmo links, service and rate settings, a materials uploader,
and a one-click database backup.

## The one rule that shapes everything

A partner earns nothing until **the customer has paid**.

A lead moves `new → contacted → booked → job done → customer paid`. At *job done*
the work is delivered but the money isn't in, so the commission is only ever
*projected* — visible, never owed. It locks at *customer paid* and becomes
immutable, which means changing your rates later never rewrites a debt you
already owe. `test/run.js` asserts exactly that.

## Deploying to Render

1. Push this folder to a GitHub repo.
2. In Render: **New → Blueprint**, point it at the repo. `render.yaml` sets up the
   web service and the 1GB persistent disk.
3. Deploy. Roughly **$7.25/month** — $7 for the service, $0.25 for the disk.
4. Open the URL and visit `/setup` to create your owner account. That screen
   closes itself permanently once an owner exists.
5. In **Settings**, confirm your Square booking link and paste your toolkit link.

To use a custom domain like `refer.prestigecleaning.us`, add it under the service's
**Settings → Custom Domains** and create the CNAME Render gives you.

### Running it locally

```bash
node --no-warnings src/server.js      # http://localhost:3000
npm test                              # 82 assertions, no network needed
```

## Backups — read this bit

The whole database is one file on the Render disk. That disk survives deploys and
restarts, but it is a **single copy**: Render does not back it up for you the way
it does a managed Postgres.

So: **Settings → Download a backup**, and keep the file somewhere else. Do it
before any big change and every so often besides. Restoring is copying that file
back onto the disk as `prestige.db`.

If the program grows past a few thousand leads or you want automatic backups,
moving to Render Postgres (+$6/month) is the upgrade — `src/db.js` is the only
file that talks to the database.

## Layout

```
src/
  server.js        http server, error handling, route guards
  router.js        route table
  context.js       per-request settings, helpers
  db.js            schema, migrations, settings   ← the only SQL in the app
  auth.js          scrypt passwords, sessions, referral codes, rate limiting
  money.js         commission rules and the held-until-paid gate
  http.js          form + multipart parsing, escaping, payment deep links
  routes/          public.js · owner.js · partner.js
  views/           layout.js · public.js · app.js · logo.js
test/run.js        end-to-end tests over real HTTP
```

## Security notes, honestly

- Passwords are scrypt-hashed; comparison is constant-time.
- Sessions are httpOnly, SameSite=Lax, Secure in production, 30 days, and stored
  server-side so they can be revoked. Changing a password kills every other session.
- Cross-origin POSTs are refused outright.
- Every owner and partner route is guarded server-side, and partners can only ever
  read their own leads and money — `test/run.js` checks this directly.
- Login attempts are rate-limited per IP, in memory.
- Uploads are restricted to images, PDFs and MP4s, 10MB each.

Not built in yet: self-service password reset (the owner resets a partner's
password and sends them the new one), and email or SMS notifications.

## Payment links

The Cash App and Venmo "open with the amount filled in" links are **conventions,
not published APIs** — neither company documents them. They work today and are
widely used, but they could change without notice. The UI always shows the amount
and recording the payout is a separate, deliberate step, so if a prefill ever
breaks you type the amount by hand and nothing else is affected.
