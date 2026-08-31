'use strict';
const { q, getSettings } = require('./db');

/* Commission rules, in one place.
 *
 * The rule that matters: a partner earns nothing until the CUSTOMER has paid.
 * A lead at 'completed' is work delivered but money not collected — the
 * commission is projected, never owed. It locks at 'settled' and is
 * immutable from then on, so changing rates later never rewrites a debt.
 */

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function money(n) {
  return '$' + round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function money0(n) {
  const v = round2(n);
  return '$' + (v % 1 === 0 ? v.toLocaleString('en-US')
                            : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

function rateFor(partner, settings) {
  if (partner && partner.rate_mode && partner.rate_value != null) {
    return { mode: partner.rate_mode, flat: partner.rate_value, percent: partner.rate_value };
  }
  return {
    mode: settings.rate_mode,
    flat: Number(settings.rate_flat) || 0,
    percent: Number(settings.rate_percent) || 0,
  };
}

function serviceByName(name) {
  if (!name) return null;
  return q.get('SELECT * FROM services WHERE name = ? AND archived = 0', name) || null;
}

/** What this lead is worth right now, given a job total. */
function computeCommission(lead, partner, settings) {
  if (!lead.partner_id) return 0;               // direct booking — nobody referred it
  const r = rateFor(partner, settings);
  const total = Number(lead.job_total) || 0;
  if (r.mode === 'flat') return round2(r.flat);
  if (r.mode === 'percent') return round2(total * (Number(r.percent) || 0) / 100);
  if (r.mode === 'service') {
    const s = serviceByName(lead.service);
    return round2(s ? s.payout : 0);
  }
  return 0;
}

/** Display value: locked amount once settled, otherwise a best estimate. */
function projected(lead, partner, settings) {
  if (lead.commission != null) return Number(lead.commission);
  if (!lead.partner_id) return 0;
  const r = rateFor(partner, settings);
  if (r.mode === 'percent' && !lead.job_total) {
    const s = serviceByName(lead.service);
    return round2((s ? s.price : 0) * (Number(r.percent) || 0) / 100);
  }
  return computeCommission(lead, partner, settings);
}

const STATUS_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  booked: 'Booked',
  completed: 'Job done',
  settled: 'Customer paid',
  lost: 'Not a fit',
};

const STATUS_ORDER = ['new', 'contacted', 'booked', 'completed', 'settled', 'lost'];

function isOwed(lead) { return lead.status === 'settled' && !lead.payout_id; }
function isHeld(lead) { return lead.status === 'completed' && !!lead.partner_id; }

/** Apply a status change, keeping commission and dates consistent. */
function applyStatus(lead, status, partner, settings, today) {
  const next = Object.assign({}, lead, { status });
  const svc = serviceByName(next.service);

  if (status === 'completed') {
    if (next.job_total == null) next.job_total = svc ? svc.price : 0;
    next.completed_at = next.completed_at || today;
    next.settled_at = null;
    if (!next.payout_id) next.commission = null;          // earned, not owed
  } else if (status === 'settled') {
    if (next.job_total == null) next.job_total = svc ? svc.price : 0;
    next.completed_at = next.completed_at || today;
    next.settled_at = next.settled_at || today;
    next.commission = computeCommission(next, partner, settings);   // locks here
  } else if (status === 'lost') {
    next.commission = 0; next.completed_at = null; next.settled_at = null;
  } else {
    if (!next.payout_id) { next.commission = null; next.completed_at = null; next.settled_at = null; }
  }
  return next;
}

function owedFor(partnerId) {
  const r = q.get(
    `SELECT COALESCE(SUM(commission),0) AS s FROM leads
      WHERE partner_id = ? AND status = 'settled' AND payout_id IS NULL`, partnerId);
  return round2(r.s);
}

function paidFor(partnerId) {
  const r = q.get(
    `SELECT COALESCE(SUM(amount),0) AS s FROM payouts WHERE partner_id = ?`, partnerId);
  return round2(r.s);
}

module.exports = {
  round2, money, money0, rateFor, serviceByName,
  computeCommission, projected, applyStatus,
  STATUS_LABELS, STATUS_ORDER, isOwed, isHeld, owedFor, paidFor,
};
