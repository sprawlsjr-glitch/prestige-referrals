'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// DATA_DIR is the Render persistent disk mount. Falls back to ./data for local runs.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

let db;

function open(file) {
  const target = file || path.join(DATA_DIR, 'prestige.db');
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate();
  return db;
}

function handle() {
  if (!db) throw new Error('db not open');
  return db;
}

/* ---------------------------------------------------------------- schema */

const MIGRATIONS = [
  `CREATE TABLE settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,

  `CREATE TABLE users (
     id            TEXT PRIMARY KEY,
     role          TEXT NOT NULL CHECK (role IN ('owner','partner')),
     email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
     password_hash TEXT NOT NULL,
     name          TEXT NOT NULL,
     phone         TEXT NOT NULL DEFAULT '',
     code          TEXT UNIQUE COLLATE NOCASE,
     pay_handle    TEXT NOT NULL DEFAULT '',
     rate_mode     TEXT,
     rate_value    REAL,
     status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
     created_at    TEXT NOT NULL,
     last_login_at TEXT
   );`,

  `CREATE TABLE services (
     id       TEXT PRIMARY KEY,
     name     TEXT NOT NULL,
     price    REAL NOT NULL DEFAULT 0,
     payout   REAL NOT NULL DEFAULT 0,
     sort     INTEGER NOT NULL DEFAULT 0,
     archived INTEGER NOT NULL DEFAULT 0
   );`,

  `CREATE TABLE leads (
     id           TEXT PRIMARY KEY,
     partner_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
     customer     TEXT NOT NULL,
     phone        TEXT NOT NULL DEFAULT '',
     email        TEXT NOT NULL DEFAULT '',
     vehicle      TEXT NOT NULL DEFAULT '',
     address      TEXT NOT NULL DEFAULT '',
     service      TEXT NOT NULL DEFAULT '',
     notes        TEXT NOT NULL DEFAULT '',
     source       TEXT NOT NULL DEFAULT 'manual',
     status       TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','contacted','booked','completed','settled','lost')),
     job_total    REAL,
     commission   REAL,
     completed_at TEXT,
     settled_at   TEXT,
     payout_id    TEXT REFERENCES payouts(id) ON DELETE SET NULL,
     created_at   TEXT NOT NULL
   );`,

  `CREATE TABLE payouts (
     id         TEXT PRIMARY KEY,
     partner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     amount     REAL NOT NULL,
     method     TEXT NOT NULL DEFAULT '',
     paid_on    TEXT NOT NULL,
     note       TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL
   );`,

  `CREATE TABLE applications (
     id         TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     phone      TEXT NOT NULL DEFAULT '',
     email      TEXT NOT NULL DEFAULT '',
     why        TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL
   );`,

  `CREATE TABLE assets (
     id           TEXT PRIMARY KEY,
     filename     TEXT NOT NULL,
     title        TEXT NOT NULL DEFAULT '',
     kind         TEXT NOT NULL DEFAULT 'other',
     content_type TEXT NOT NULL,
     bytes        INTEGER NOT NULL,
     data         BLOB NOT NULL,
     sort         INTEGER NOT NULL DEFAULT 0,
     created_at   TEXT NOT NULL
   );`,

  `CREATE TABLE sessions (
     id         TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL
   );`,

  `CREATE INDEX idx_leads_partner ON leads(partner_id);`,
  `CREATE INDEX idx_leads_status  ON leads(status);`,
  `CREATE INDEX idx_leads_created ON leads(created_at DESC);`,
  `CREATE INDEX idx_sessions_user ON sessions(user_id);`,
  /* IF NOT EXISTS on both: an earlier release created seeded_assets outside
     the migration list, so a database from that release already has it. */
  `CREATE TABLE IF NOT EXISTS seeded_assets (
     filename  TEXT PRIMARY KEY,
     seeded_at TEXT NOT NULL
   );`,

  `CREATE TABLE IF NOT EXISTS code_history (
     code       TEXT PRIMARY KEY COLLATE NOCASE,
     user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     retired_at TEXT NOT NULL
   );`,

  /* Append-only from here. A migration's INDEX is its identity — every
     database records which numbers it has run, so inserting one in the
     middle silently skips it on machines that are already past that
     number. New migrations go at the bottom, always. */
  `ALTER TABLE seeded_assets ADD COLUMN sha TEXT NOT NULL DEFAULT '';`,
];
function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT n FROM _migrations').all().map(r => r.n));
  for (let i = 0; i < MIGRATIONS.length; i++) {
    if (done.has(i)) continue;
    db.exec(MIGRATIONS[i]);
    db.prepare('INSERT INTO _migrations (n, applied_at) VALUES (?, ?)').run(i, new Date().toISOString());
  }
}

/* ------------------------------------------------------------- utilities */

const q = {
  all(sql, ...p) { return handle().prepare(sql).all(...p); },
  get(sql, ...p) { return handle().prepare(sql).get(...p); },
  run(sql, ...p) { return handle().prepare(sql).run(...p); },
};

function tx(fn) {
  const h = handle();
  h.exec('BEGIN');
  try { const out = fn(); h.exec('COMMIT'); return out; }
  catch (e) { try { h.exec('ROLLBACK'); } catch (_) {} throw e; }
}

/* -------------------------------------------------------------- settings */

const SETTING_DEFAULTS = {
  business_name: 'Prestige Mobile Cleaning',
  tagline: 'Dedicated To Quality Service!',
  phone: '678-274-9817',
  service_area: 'Atlanta and surrounding areas — Sandy Springs, Marietta, Duluth, Alpharetta, Decatur, Norcross and more',
  website: 'https://prestigecleaning.us',
  booking_url: 'https://book.squareup.com/appointments/9gify54wzq9slr/location/3K97MYGAT88K4/services',
  toolkit_url: '',
  payout_note: 'Paid weekly on Fridays via Cash App or Zelle.',
  hold_note: 'You get paid after the customer pays — job finished and settled up.',
  rate_mode: 'percent',
  rate_flat: '25',
  rate_percent: '10',
};

function getSettings() {
  const out = Object.assign({}, SETTING_DEFAULTS);
  for (const row of q.all('SELECT key, value FROM settings')) out[row.key] = row.value;
  return out;
}

function setSetting(key, value) {
  q.run(
    'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key, String(value == null ? '' : value)
  );
}

/* ----------------------------------------------------------------- seeds */

const DEFAULT_SERVICES = [
  ['Silver Detail', 200, 20],
  ['Gold Detail', 280, 28],
  ['Platinum Detail', 360, 36],
  ['Diamond Detail', 600, 60],
  ['Plus Upgrade (any tier)', 80, 8],
  ['Add-On Service', 80, 8],
  ['Ceramic Coating', 0, 75],
  ['Paint Correction', 0, 50],
  ['Pressure Washing', 0, 25],
  ['Bi-Weekly Subscription', 0, 40],
  ['Weekly Subscription', 0, 60],
];

function seedServices(newId) {
  if (q.get('SELECT COUNT(*) AS n FROM services').n > 0) return;
  DEFAULT_SERVICES.forEach((s, i) => {
    q.run('INSERT INTO services (id,name,price,payout,sort) VALUES (?,?,?,?,?)', newId('sv'), s[0], s[1], s[2], i);
  });
}

/* ---------------------------------------------------------------------
   Marketing creatives that ship with the app. Listed explicitly rather
   than scanning the folder, so a stray file next to them never ends up
   in front of partners. Seeded once, by filename — an owner can delete
   any of them from Materials and it stays deleted. */
const BUNDLED_ASSETS = [
  ['01-post-driveway.png',       'Interior before & after — feed post'],
  ['02-post-packages.png',       'The price menu — feed post'],
  ['03-post-addons.png',         'Add-ons, $80 each — feed post'],
  ['04-post-customers.png',      'Real customers — feed post'],
  ['05-story-headlight.png',     'Headlight restoration — story'],
  ['06-story-how-it-works.png',  'How it works — story'],
];

const ASSET_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4',
};

function seedAssets(newId) {
  // seeded_assets remembers what has been offered and what it looked like:
  // an owner's delete sticks, but a redesigned file replaces the old one.
  const dir = path.join(__dirname, '..', 'bundled');
  const now = new Date().toISOString();
  let sort = q.get('SELECT COALESCE(MAX(sort),0) m FROM assets').m;

  for (const [name, title] of BUNDLED_ASSETS) {
    const ct = ASSET_TYPES[path.extname(name).toLowerCase()];
    if (!ct) continue;
    let data;
    try { data = fs.readFileSync(path.join(dir, name)); } catch (e) { continue; }
    if (!data.length) continue;

    const sha = crypto.createHash('sha256').update(data).digest('hex');
    const seen = q.get('SELECT filename, sha FROM seeded_assets WHERE filename = ?', name);
    const kind = ct.startsWith('image/') ? 'image' : ct === 'application/pdf' ? 'pdf' : 'video';

    if (!seen) {
      sort += 1;
      q.run(`INSERT INTO assets (id,filename,title,kind,content_type,bytes,data,sort,created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
        newId('as'), name, title, kind, ct, data.length, data, sort, now);
      q.run('INSERT INTO seeded_assets (filename,seeded_at,sha) VALUES (?,?,?)', name, now, sha);
      continue;
    }

    if (seen.sha === sha) continue;              // unchanged since last boot

    // Changed. Refresh it in place — but only if the owner still has it.
    // If they deleted it, leave it deleted and just remember the new hash.
    const live = q.get('SELECT id FROM assets WHERE filename = ?', name);
    if (live) {
      q.run('UPDATE assets SET title = ?, kind = ?, content_type = ?, bytes = ?, data = ? WHERE id = ?',
        title, kind, ct, data.length, data, live.id);
    }
    q.run('UPDATE seeded_assets SET sha = ?, seeded_at = ? WHERE filename = ?', sha, now, name);
  }
}

module.exports = { open, handle, q, tx, migrate, MIGRATIONS, getSettings, setSetting, seedServices, seedAssets, SETTING_DEFAULTS, DATA_DIR };
