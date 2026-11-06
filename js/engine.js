// Scoring engine — port of engine.py. Points formula + simulation + plays + pros/cons.
import { fmtTime } from './parse.js?v=10';

// seconds slower than a mile track; quarters get 1/4 of this
const TRACK_OFFSET = { 1: 0.0, 0.875: 0.4, 0.625: 1.0, 0.5: 2.0 };

// Points → win chance: p ∝ exp(score / TEMP). 35 keeps the lines in step with real morning lines
// (favorites mostly 8-5 to 3-1, nothing shorter than even money on a normal card).
export const TEMP = 35;

export const DEFAULT_WEIGHTS = {
  speed: 20,      // avg Trackmaster speed rating, clean last 5
  speed_best: 4,  // best SR in last 5
  mark: 10,       // avg mile/variant-adjusted final time
  close: 12,      // avg adjusted last quarter
  early: 8,       // first-quarter position + estimated opening-quarter time
  form: 16,       // avg finish last 3 starts
  class: 8,       // class ratings faced + circuit tier + same-track purse move
  year: 8,        // current-year win / top-3 %
  driver: 7,      // driver UDR
  trainer: 3,     // trainer win %
  post: 7,        // the track's real post-position win index (front page / program post rating)
  late: 4,        // avg spots gained 3/4 -> finish
  season_mark: 3, // current-year mark, mile-adjusted (lifetime mark if none this year)
  trend: 10,      // speed figures rising or falling over the last 3–4 starts
  hot: 5,         // driver & trainer last 30 days vs the year
  conn: 5,        // driver/trainer team, record at this track, new-barn move
  offtrack: 6,    // off-track record + sire off-track (only when the track is set to Off)
};
// Weighted points are rescaled to this total so adding factors (or turning some up) doesn't
// change how spread out the win chances are — only which horses get the credit.
const BASE_SUM = 108;

// Everything a user can turn up or down. Multiplier 1 = normal.
export const FACTORS = [
  { key: 'speed', group: 'weight', label: 'Speed figures', help: 'Average Trackmaster speed rating in clean recent starts' },
  { key: 'speed_best', group: 'weight', label: 'Best speed figure', help: 'Top speed rating in the last 5' },
  { key: 'mark', group: 'weight', label: 'Average mile time', help: 'Average adjusted final time, last 5 clean starts' },
  { key: 'season_mark', group: 'weight', label: 'Season / lifetime mark', help: 'This year\'s best mile, mile-adjusted' },
  { key: 'early', group: 'weight', label: 'Opening speed (first ¼)', help: 'Position and estimated time at the first quarter' },
  { key: 'close', group: 'weight', label: 'Closing speed (last ¼)', help: 'Horse\'s own last-quarter time' },
  { key: 'late', group: 'weight', label: 'Late move (¾→finish)', help: 'Spots gained or lost after the 3/4 call' },
  { key: 'form', group: 'weight', label: 'Recent form', help: 'Average finish over the last 3 starts' },
  { key: 'class', group: 'weight', label: 'Class / shippers', help: 'Class ratings faced, circuit, purse moves' },
  { key: 'year', group: 'weight', label: 'This-year record', help: 'Win % and top-3 % this year' },
  { key: 'driver', group: 'weight', label: 'Driver', help: 'Driver UDR' },
  { key: 'trainer', group: 'weight', label: 'Trainer', help: 'Trainer win %' },
  { key: 'post', group: 'weight', label: 'Post position', help: 'The track\'s real win rate from each post (bigger on half-mile tracks, where post matters most)' },
  { key: 'trend', group: 'weight', label: 'Speed trend', help: 'Speed figures rising or falling over the last 3–4 starts' },
  { key: 'hot', group: 'weight', label: 'Hot / cold driver & trainer', help: 'Last 30 days vs the year (Platinum programs)' },
  { key: 'conn', group: 'weight', label: 'Connections & course', help: 'Driver/trainer team record, record at this track, first starts for a new barn' },
  { key: 'offtrack', group: 'weight', label: 'Off-track ability', help: 'Only counts when today\'s track is set to Off: off-track record and sire off-track stats' },
  { key: 'pace', group: 'adj', label: 'Pace setup', help: 'Lone speed bonus, speed-duel penalty, closer boost in a hot pace' },
  { key: 'driver_change', group: 'adj', label: 'Driver change', help: 'Upgrade bonus / downgrade penalty vs last start' },
  { key: 'tough_trip', group: 'adj', label: 'Tough-trip credit', help: 'Bonus for parked or first-over trips that still finished close' },
  { key: 'breaks', group: 'pen', label: 'Break penalty', help: 'Breaking stride in recent starts — trotters count 10 starts back and are hit harder' },
  { key: 'layoff', group: 'pen', label: 'Layoff / stale-form penalty', help: 'Penalty for time off and old form lines' },
];
export const POST_SCALE = { 0.5: 4, 0.625: 2.5, 0.875: 1.5, 1: 1 };
export const DEFAULT_MULT = Object.fromEntries(FACTORS.map((f) => [f.key, 1]));

export const PRESETS = {
  normal: { label: 'Normal', mult: {} },
  closers: { label: 'Favor closers', mult: { close: 2, late: 2, early: 0.5, pace: 1.5 } },
  speed: { label: 'Favor early speed', mult: { early: 2, pace: 2, close: 0.5, late: 0.5 } },
  form_class: { label: 'Form & class', mult: { form: 1.75, class: 1.75, speed: 0.75, mark: 0.75 } },
  times: { label: 'Times only', mult: { driver: 0, trainer: 0, year: 0.5, post: 0, driver_change: 0 } },
};

export const WEIGHT_LABELS = {
  speed: 'Speed figures', speed_best: 'Best speed figure', mark: 'Average mile time', close: 'Closing quarter',
  early: 'Opening speed', form: 'Recent form', class: 'Class / shippers', year: 'This year record',
  driver: 'Driver', trainer: 'Trainer', post: 'Post position', late: 'Late move (¾→fin)', season_mark: 'Season mark',
  trend: 'Speed trend', hot: 'Hot/cold driver & trainer', conn: 'Connections & course', offtrack: 'Off-track ability (when Off)',
};

export const ADJ = {
  lone_speed: 4, speed_duel: -2, closer_setup: 2, driver_up: 2, driver_up_big: 3,
  driver_down: -2, tough_trip: 2, tough_trip_cap: 4,
};

// rough circuit tiers (1 = toughest); unknown tracks default to 3
const TRACK_TIER = {
  M: 1, YR: 1, Wbsb: 1, Moh: 1, Lex: 1, Mohk: 1,
  PcD: 2, Phl: 2, Mea: 2, HoP: 2, DD: 2, ScD: 2, PRc: 2, Har: 2, MVR: 2, DTN: 3, Dtn: 3, Dela: 3, Lex: 1, Nfld: 3, Aces: 3, Bang: 4, Gosh: 4, Brtn: 4, Nrthv: 3,
  Nfld: 3, Stga: 3, VD: 3, TgDn: 3, Btva: 3, MR: 3, RcR: 3, GeoD: 3, OakGr: 3, Fhld: 3,
  Frybg: 4, Cumb: 4, Farm: 4, Skow: 4, Bang: 4, Scar: 4, Wind: 4, Oxfd: 4, Fair: 4, Topsh: 4, Union: 4, Northam: 4,
  Wdstk: 4, Hstng: 4, Fwvl: 4, Cntrv: 4, Allgn: 4, Elmra: 4, Grtz: 4, Mayfd: 4, Meadv: 4, Spr: 4, Caro: 4, Chfld: 4,
};
const TRACK_NAME = {
  M: 'the Meadowlands', YR: 'Yonkers', Wbsb: 'Mohawk', Lex: 'the Red Mile', PcD: 'Pocono', Phl: 'Philly',
  Mea: 'the Meadows', HoP: 'Hoosier', DD: 'Dover', ScD: 'Scioto', Nfld: 'Northfield', Stga: 'Saratoga',
  VD: 'Vernon', TgDn: 'Tioga', Btva: 'Batavia', MR: 'Monticello', RcR: 'Rosecroft', GeoD: 'Georgian', OakGr: 'Oak Grove',
  PRc: 'Plainridge', Aces: 'Running Aces', Har: 'Harrington', MVR: 'Miami Valley', DTN: 'Dayton', Dtn: 'Dayton', Dela: 'Delaware (OH)', Cosh: 'Coshocton', Wostr: 'Wooster', Wseon: 'Wauseon', Knton: 'Kenton', Bang: 'Bangor',
  Frybg: 'Fryeburg Fair', Cumb: 'Cumberland Fair', Farm: 'Farmington Fair', Skow: 'Skowhegan Fair', Scar: 'Scarborough',
  Wind: 'Windsor Fair', Oxfd: 'Oxford Fair', Topsh: 'Topsham Fair', Union: 'Union Fair', Gosh: 'Goshen', Brtn: 'a fair track',
  Wdstk: 'Woodstock', Hstng: 'Hastings', Fhld: 'Freehold', Lex: 'the Red Mile', Mohk: 'Mohawk', Fwvl: 'Fowlerville', Nrthv: 'Northville',
};

export const trackKey = (t) => (t || '').replace(/[½ÁÂ1]+$/, '');
const tier = (t) => TRACK_TIER[trackKey(t)] ?? 3;
const offset = (size) => TRACK_OFFSET[size] ?? 1.0;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function pdate(s) {
  const m = (s || '').match(/^(\d\d)([A-Z][a-z]{2})(\d\d)$/);
  if (!m || !(m[2] in MON)) return null;
  return Date.UTC(2000 + +m[3], MON[m[2]], +m[1]);
}
const days = (a, b) => Math.round((a - b) / 86400000);

// Python-style round half to even (keeps parity with the Python prototype)
function pyRound(x, nd = 0) {
  const f = 10 ** nd, v = x * f, r = Math.round(v);
  return (Math.abs(v % 1) === 0.5 ? (r % 2 === 0 ? r : r - 1) : r) / f;
}

export function cardDate(card) {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const m = (card.date || '').match(/([A-Za-z]+) (\d+), (\d{4})/);
  if (m && MONTHS.includes(m[1])) return Date.UTC(+m[3], MONTHS.indexOf(m[1]), +m[2]);
  const d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

function isClean(p) {
  return !(p.scratched || p.qua || p.brk || p.dnf || p.parked3w || (p.parked_calls || 0) >= 3 || p.horse_time == null);
}
const pct = (n, d) => (d ? (100 * n) / d : null);

function horseMetrics(h, race, today, year) {
  const m = {};
  const starts = h.pp.filter((p) => !p.scratched);
  const real = starts.filter((p) => !p.qua);
  const last5 = starts.slice(0, 5);
  const cleanAll = last5.filter(isClean);
  const recent = cleanAll.filter((p) => pdate(p.date) != null && days(today, pdate(p.date)) <= 120);
  const clean = recent.length ? recent : cleanAll;
  m.stale = cleanAll.length > 0 && recent.length === 0;
  m.clean_n = cleanAll.length;
  m.brk_l5 = last5.filter((p) => p.brk).length;
  m.thrown = last5.length - clean.length;
  const adj = (p, k, frac = 1) => {
    if (p[k] == null) return null;
    const v = Math.max(-1.6, Math.min(1.6, 0.2 * (p.var || 0)));
    return p[k] - (offset(p.size) + v) * frac;
  };
  const times = clean.map((p) => adj(p, 'horse_time'));
  m.avg_mark = times.length ? mean(times) : null;
  m.best_time = times.length ? Math.min(...times) : null;
  const cq = clean.filter((p) => p.last_q).map((p) => adj(p, 'last_q', 0.25));
  m.close_q = cq.length ? mean(cq) : null;
  m.close_best = cq.length ? Math.min(...cq) : null;
  const oq = clean.filter((p) => p.open_q).map((p) => adj(p, 'open_q', 0.25));
  m.open_q = oq.length ? mean(oq) : null;
  const op = clean.filter((p) => p.open_pos).map((p) => p.open_pos);
  m.open_pos = op.length ? mean(op) : null;
  const lm = clean.filter((p) => p.calls[2] && p.calls[4] && p.calls[2].pos && p.calls[4].pos)
    .map((p) => [p.calls[2].pos, p.calls[4].pos]);
  m.late_pairs = lm;
  m.late_gain = lm.length ? mean(lm.map(([a, b]) => a - b)) : null;
  const srs = clean.filter((p) => p.sr).map((p) => p.sr);
  m.sr_avg = srs.length ? mean(srs) : null;
  const srall = last5.filter((p) => p.sr && !p.qua).map((p) => p.sr);
  m.sr_best = srall.length ? Math.max(...srall) : null;
  const fins = real.slice(0, 3).map((p) => p.finish || p.field || 8);
  m.avg_fin3 = fins.length ? mean(fins) : null;
  m.fins3 = fins;
  m.won_last = !!(real.length && real[0].finish === 1);
  const lastAny = starts.length ? pdate(starts[0].date) : null;
  const lastReal = real.length ? pdate(real[0].date) : null;
  m.days_any = lastAny != null ? days(today, lastAny) : null;
  m.days_real = lastReal != null ? days(today, lastReal) : null;
  m.qual_since = !!(starts.length && starts[0].qua && real.length);
  m.last_purse = real.length && real[0].purse ? real[0].purse : null;
  m.class_ratio = m.last_purse && race.purse ? race.purse / m.last_purse : null;
  m.last_track = real.length ? real[0].track : '';
  const crs = real.slice(0, 3).filter((p) => p.cr).map((p) => p.cr);
  m.cr_avg3 = crs.length ? mean(crs) : null;
  m.cr_diff = m.cr_avg3 != null && race.cr ? m.cr_avg3 - race.cr : null;
  const todayTrk = race.track_code || 'PcD';
  m.ship = real.length > 0 && trackKey(m.last_track) !== todayTrk;
  m.tier_diff = m.ship ? tier(todayTrk) - tier(m.last_track) : 0;
  const pr = !m.ship && m.class_ratio ? -(m.class_ratio - 1) * 10 : 0;
  m.class_val = m.cr_diff == null && !m.class_ratio ? null : (m.cr_diff || 0) + 2.5 * m.tier_diff + pr;
  m.tough = last5.filter((p) => !(p.qua || p.brk || p.dnf || p.scratched) &&
    (p.parked3w || (p.parked_calls || 0) >= 3) && p.finish && (p.finish <= 3 || (p.beaten ?? 99) <= 3));
  m.last_driver = real.length ? real[0].driver : '';
  const life = h.stats.Life || {}, yr = h.stats[String(year)] || {};
  for (const [key, st] of [['life', life], ['yr', yr]]) {
    const s = st.starts || 0;
    m[`${key}_starts`] = s;
    m[`${key}_wins`] = st.wins || 0;
    m[`${key}_win`] = pct(st.wins || 0, s);
    m[`${key}_top3`] = pct((st.wins || 0) + (st.places || 0) + (st.shows || 0), s);
    m[`${key}_mark`] = st.mark ?? null;
    m[`${key}_mark_trk`] = st.mark_track || '';
    m[`${key}_mark_adj`] = st.mark ? st.mark - offset(st.mark_size ?? 0.625) : null;
  }
  const ys = 0.4 * (m.yr_win || 0) + 0.6 * (m.yr_top3 || 0);
  const ls = 0.4 * (m.life_win || 0) + 0.6 * (m.life_top3 || 0);
  if (m.yr_starts >= 8) m.year_score = ys;
  else if (m.life_starts) { const w = m.yr_starts / 8; m.year_score = w * ys + (1 - w) * ls; }
  else m.year_score = null;
  // small samples (USTA programs print current-meet stats) are pulled toward an average driver / barn
  const toward = (v, n, avg, k = 40) => (v == null ? null : n != null && n < k ? (v * n + avg * (k - n)) / k : v);
  m.driver_udr = toward(h.drv_udr ?? null, h.drv_st, 0.200);
  m.trainer_w = toward(h.trn_w ?? null, h.trn_st, 12);
  m.post_rating = h.post_rating ?? null;
  // speed trend: least-squares slope of speed figures over the last 4 real starts without a break (oldest → newest)
  const tr = real.filter((p) => p.sr && !p.brk && !p.dnf).slice(0, 4).map((p) => p.sr).reverse();
  m.sr_seq = tr;
  if (tr.length >= 3) {
    const n = tr.length, mx = (n - 1) / 2, my = mean(tr);
    let num = 0, den = 0;
    tr.forEach((y, x) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; });
    m.sr_trend = num / den;
  } else m.sr_trend = null;
  // trotters: breaks over the last 10 lines (qualifiers count — manners are manners)
  const l10 = starts.slice(0, 10);
  m.brk_l10 = l10.filter((p) => p.brk).length;
  m.brk_last = !!(starts[0] && starts[0].brk);
  m.lines_n = l10.length;
  // hot / cold: last 30 days vs last 365 (Platinum)
  const shrink = (d, n, k) => (d == null ? null : d * (n / (n + k)));
  m.drv_hot = h.drv30 && h.drv30.st >= 10 && h.drv30.r != null && h.drv_udr != null ? h.drv30.r - h.drv_udr : null;
  m.trn_hot = h.trn30 && h.trn30.st >= 4 && h.trn30.r != null && h.trn_utr != null ? h.trn30.r - h.trn_utr : null;
  m.drv30_st = h.drv30?.st ?? null; m.trn30_st = h.trn30?.st ?? null;
  m.hot_val = m.drv_hot == null && m.trn_hot == null ? null
    : (shrink(m.drv_hot, m.drv30_st || 0, 40) || 0) + 0.8 * (shrink(m.trn_hot, m.trn30_st || 0, 10) || 0);
  // connections & course
  m.conn_bits = []; let cv = 0, cn = 0;
  if (h.drtr && h.drtr.st >= 3 && h.drtr.w != null && h.drv_w != null) {
    const sh = (h.drtr.w * h.drtr.st + h.drv_w * 8) / (h.drtr.st + 8);
    cv += (sh - h.drv_w) / 100; cn++;
    m.combo = { st: h.drtr.st, w: h.drtr.w };
    m.conn_bits.push(`Dr/Tr ${h.drtr.st} starts, ${h.drtr.w}% wins`);
  }
  const trk = h.stats.Track;
  if (trk && trk.starts >= 3 && m.life_top3 != null) {
    const t3 = (100 * (trk.wins + trk.places + trk.shows)) / trk.starts;
    cv += ((t3 - m.life_top3) / 100) * (trk.starts / (trk.starts + 5)); cn++;
    m.course = { ...trk, t3 };
    m.conn_bits.push(`Here: ${trk.starts} starts ${trk.wins}-${trk.places}-${trk.shows}`);
  }
  if (h.new_trainer && h.new_trainer.starts_since <= 1 && h.trn_utr != null) {
    const d = h.trn_utr - h.new_trainer.prev_utr;
    cv += 1.5 * d; cn++;
    m.new_barn = { ...h.new_trainer, d };
    m.conn_bits.push(`${h.new_trainer.starts_since === 0 ? '1st' : '2nd'} start for new barn (was ${h.new_trainer.prev.split(' ').slice(-1)[0]}, UTR ${h.new_trainer.prev_utr.toFixed(3)} → ${h.trn_utr.toFixed(3)})`);
  }
  m.conn_val = cn ? cv : null;
  // off-track ability (only used when the track is Off)
  const off = h.stats.Off;
  m.off_rec = off && off.starts ? off : null;
  if (off && off.starts >= 2 && m.life_top3 != null) {
    const t3 = (100 * (off.wins + off.places + off.shows)) / off.starts;
    m.off_val = ((t3 - m.life_top3) / 100) * (off.starts / (off.starts + 4)) + (h.sire_off && h.sire_off.st >= 50 ? (h.sire_off.w - 13) / 200 : 0);
    m.off_t3 = t3;
  } else m.off_val = h.sire_off && h.sire_off.st >= 50 ? (h.sire_off.w - 13) / 200 : null;
  return m;
}

function norm(vals, higherBetter = true, missing = 0.25) {
  const xs = vals.filter((v) => v != null);
  if (!xs.length) return vals.map(() => missing);
  const lo = Math.min(...xs), hi = Math.max(...xs);
  return vals.map((v) => {
    if (v == null) return missing;
    if (hi === lo) return 0.6;
    const t = (v - lo) / (hi - lo);
    return higherBetter ? t : 1 - t;
  });
}

function driverKey(name) {
  const n = name.replace('(P)', '').replace(/\./g, ' ').trim();
  let last, first;
  if (n.includes(',')) {
    const i = n.indexOf(',');
    last = n.slice(0, i).trim(); first = n.slice(i + 1).trim();
  } else {
    const parts = n.split(/\s+/).filter((x) => !['jr', 'sr', 'iii', 'ii'].includes(x.toLowerCase()));
    if (parts.length === 1) return [parts[0].toLowerCase(), ''];
    first = parts[0]; last = parts[parts.length - 1];
    if (!/^[A-Za-z]+$/.test(last)) last = parts[parts.length - 2];
  }
  last = last ? last.split(/\s+/)[0] : '';
  return [last.toLowerCase(), first ? first[0].toLowerCase() : ''];
}

function sameDriver(a, b) {
  const [la, fa] = driverKey(a), [lb, fb] = driverKey(b);
  if (!la || !lb) return false;
  const lm = la.startsWith(lb) || lb.startsWith(la);
  return lm && (!fa || !fb || fa === fb);
}

export function cardDriverTable(card) {
  const tbl = [];
  for (const r of card.races) for (const h of r.horses) if (h.driver && h.drv_udr != null) tbl.push([h.driver, h.drv_udr]);
  return tbl;
}
function lookupUdr(tbl, name) {
  for (const [n, u] of tbl) if (sameDriver(n, name)) return [n, u];
  return [null, null];
}

// --- simulation: Plackett–Luce via the Gumbel trick, seeded so results are repeatable ---
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simulate(ranked, n = 40000, seed = 7) {
  const rnd = mulberry32(seed);
  const k = ranked.length;
  const lam = ranked.map((h) => h.score / TEMP);
  const posCount = Array.from({ length: k }, () => new Array(k).fill(0));
  const c = { key234: 0, key23: 0, box3: 0, box4: 0, straight: 0, exKey: 0, exBox3: 0, exBox2: 0, sfKey: 0, sfBox4: 0, sfKey3: 0 };
  const near = new Array(k).fill(0);
  const tri = new Uint32Array(4096);   // exact 1-2-3 orders, index a*256+b*16+c (ranked indices)
  const g = new Float64Array(k);
  const idx = Array.from({ length: k }, (_, i) => i);
  for (let s = 0; s < n; s++) {
    for (let i = 0; i < k; i++) {
      let u = rnd(); if (u <= 0) u = 1e-12;
      g[i] = lam[i] - Math.log(-Math.log(u));
    }
    const order = idx.slice().sort((a, b) => g[b] - g[a]);
    for (let j = 0; j < k; j++) {
      const i = order[j];
      posCount[i][j]++;
      if (i >= 1 && i <= 4 && Math.abs(j - i) <= 1) near[i]++;
    }
    const [o1, o2, o3, o4] = order;
    if (k >= 3 && k <= 16) tri[o1 * 256 + o2 * 16 + o3]++;
    const in123 = (x) => x >= 1 && x <= 3;
    if (o1 === 0 && in123(o2) && in123(o3)) c.key234++;
    if (o1 === 0 && (o2 === 1 || o2 === 2) && (o3 === 1 || o3 === 2)) c.key23++;
    if (o1 < 3 && o2 < 3 && o3 < 3) c.box3++;
    if (o1 < 4 && o2 < 4 && o3 < 4) c.box4++;
    if (o1 === 0 && o2 === 1 && o3 === 2) c.straight++;
    if (o1 === 0 && (o2 === 1 || o2 === 2)) c.exKey++;
    if (o1 < 3 && o2 < 3) c.exBox3++;
    if (o1 < 2 && o2 < 2) c.exBox2++;
    if (k >= 5) {
      const in1to4 = (x) => x >= 1 && x <= 4;
      if (o1 === 0 && in1to4(o2) && in1to4(o3) && in1to4(o4)) c.sfKey++;
      if (o1 < 4 && o2 < 4 && o3 < 4 && o4 < 4) c.sfBox4++;
      if (o1 === 0 && in123(o2) && in123(o3) && in123(o4)) c.sfKey3++;
    }
  }
  const res = { n };
  res.pos_prob = posCount.map((row) => row.slice(0, Math.min(k, 6)).map((x) => x / n));
  res.top5_prob = posCount.map((row) => row.slice(0, 5).reduce((a, b) => a + b, 0) / n);
  res.top3_prob = posCount.map((row) => row.slice(0, 3).reduce((a, b) => a + b, 0) / n);
  res.key_1_over_234 = c.key234 / n; res.key_1_over_23 = c.key23 / n;
  res.box3 = c.box3 / n; res.box4 = c.box4 / n; res.straight = c.straight / n;
  res.ex_key_1_over_23 = c.exKey / n; res.ex_box3 = c.exBox3 / n; res.ex_box2 = c.exBox2 / n;
  res.sf_key_1_over_2345 = k >= 5 ? c.sfKey / n : 0; res.sf_box4 = k >= 5 ? c.sfBox4 / n : 0; res.sf_key_1_over_234 = k >= 5 ? (c.sfKey3 || 0) / n : 0;
  const nr = [];
  for (let i = 1; i < Math.min(5, k); i++) nr.push(near[i] / n);
  res.undercard_near = nr.length ? nr.reduce((a, b) => a + b, 0) / nr.length : 0;
  res.tri = (a, b, c) => tri[a * 256 + b * 16 + c] / n;
  return res;
}

function undercardConf(sim) {
  const u = sim.undercard_near;
  for (const [stars, cut] of [[1, 0.433], [2, 0.458], [3, 0.48], [4, 0.53]]) if (u < cut) return stars;
  return 5;
}

function confidence(ranked) {
  if (ranked.length < 2) return 3;
  const s = ranked.map((h) => h.score);
  const gap1 = s[0] - s[1];
  const gap3 = s[0] - s[Math.min(2, s.length - 1)];
  const top = ranked[0].m;
  let pts = gap1 / 6.0 + gap3 / 15.0;
  if (top.clean_n >= 4) pts += 0.5;
  pts -= Math.min(2, top.brk_l5);
  if (top.clean_n <= 2) pts -= 1;
  if (top.avg_fin3 != null && top.avg_fin3 > 4) pts -= 1;
  if (top.stale) pts -= 1;
  const c = 1 + pyRound(Math.min(4, Math.max(0, pts)));
  return Math.max(1, Math.min(5, c));
}

// "50 CENT", "20 CENT", "$1", "$2", "$.50", "$1.00", "$.10" … → dollars
const BASE_RE = '(\\d+ CENT|\\$\\d*\\.\\d+|\\$\\d+(?:\\.\\d+)?)';
function baseValue(t) {
  if (!t) return null;
  const c = t.match(/^(\d+) CENT$/);
  if (c) return +c[1] / 100;
  const v = parseFloat(t.replace('$', ''));
  return isFinite(v) && v > 0 ? v : null;
}
export function wagerBase(race, name) {
  const w = race.wagers || '';
  if (!w.includes(name)) return null;
  const m = w.match(new RegExp(BASE_RE + '\\s*-?\\s*' + name));
  return (m && baseValue(m[1])) || 1.0;
}

// Key when the top pick stands alone: 4/5+ confidence with a clear edge on the second choice,
// or a big enough edge on his own.
const keyWinner = (race) => {
  const rk = race.ranked;
  if (rk.length < 2) return false;
  const p1 = rk[0].win_prob, ratio = p1 / rk[1].win_prob;
  return (race.confidence >= 4 && p1 >= 0.22 && ratio >= 1.35) || (race.confidence >= 3 && p1 >= 0.26 && ratio >= 1.45);
};

// number of distinct tickets a set of legs covers (each finisher must be a different horse)
export function countCombos(legs) {
  let n = 0;
  const walk = (i, used) => {
    if (i === legs.length) { n++; return; }
    for (const x of legs[i]) if (!used.includes(x)) walk(i + 1, [...used, x]);
  };
  walk(0, []);
  return n;
}
export function legsHit(legs, fin) {
  if (!legs || fin.length < legs.length) return null;
  return legs.every((leg, i) => leg.includes(fin[i]));
}
export function legsText(legs) {
  const same = legs.every((l) => l.length === legs[0].length && l.every((x) => legs[0].includes(x)));
  if (same && legs[0].length > 1) return legs[0].join('-') + ' box';
  if (legs.every((l) => l.length === 1)) return legs.map((l) => l[0]).join('-');
  return legs.map((l) => l.join(',')).join(' / ');
}

function trifectaCall(race) {
  const rk = race.ranked, s = race.sim, base = wagerBase(race, 'TRIFECTA') ?? 1.0;
  const pg = (i) => rk[i].pgm;
  if (rk.length < 3) return { type: 'N/A', text: 'field too small', combos: 0, cost: 0, hit: 0, base, legs: null, strength: '' };
  const pc = (i) => Math.round((rk[i] ? rk[i].win_prob : 0) * 100);
  const caution = race.confidence <= 2 && race.undercard <= 2;
  if (keyWinner(race) && rk.length >= 4) {
    const under = [pg(1), pg(2), pg(3)];
    const legs = [[pg(0)], under, under];
    return { type: 'KEY', text: `#${pg(0)} over ${under.map((x) => '#' + x).join(', ')}`, legs, combos: 6, cost: 6 * base, hit: s.key_1_over_234, base, caution,
      strength: `Winner ${pc(0)}% vs ${pc(1)}% / ${pc(2)}% for the next two — he stands alone, so use him on top only.` };
  }
  const top = [pg(0), pg(1), pg(2)];
  return { type: 'BOX', text: top.map((x) => '#' + x).join('-'), legs: [top, top, top], combos: 6, cost: 6 * base, hit: s.box3, base, caution,
    strength: `Top three ${pc(0)}% / ${pc(1)}% / ${pc(2)}% — too close to trust one on top, so box them.` };
}

function exactaCall(race) {
  const rk = race.ranked, s = race.sim, base = wagerBase(race, 'EXACTA');
  const pg = (i) => rk[i].pgm;
  if (base == null || rk.length < 3) return { type: 'N/A', text: 'not offered', combos: 0, cost: 0, hit: 0, base, legs: null };
  if (race.trifecta.type === 'KEY') return { type: 'KEY', text: `#${pg(0)} over #${pg(1)}, #${pg(2)}`, legs: [[pg(0)], [pg(1), pg(2)]], combos: 2, cost: 2 * base, hit: s.ex_key_1_over_23, base };
  const t = [pg(0), pg(1)];   // Marshall: exacta box is always two horses
  return { type: 'BOX', text: t.map((x) => '#' + x).join('-'), legs: [t, t], combos: 2, cost: 2 * base, hit: s.ex_box2, base };
}

function superfectaCall(race) {
  const rk = race.ranked, s = race.sim, base = wagerBase(race, 'SUPERFECTA');
  const pg = (i) => rk[i].pgm;
  if (base == null || rk.length < 5) return { type: 'N/A', text: 'not offered', combos: 0, cost: 0, hit: 0, base, legs: null };
  // Marshall (Nov 6): superfecta only when we're strong enough to key, and keep it cheap —
  // top pick over the next three (6 combos), never a 24-combo box.
  if (race.trifecta.type === 'KEY' && race.undercard >= 3) {
    const u = [pg(1), pg(2), pg(3)];
    return { type: 'KEY', text: `#${pg(0)} over ${u.map((x) => '#' + x).join(', ')}`, legs: [[pg(0)], u, u, u], combos: 6, cost: 6 * base, hit: s.sf_key_1_over_234, base };
  }
  return { type: 'PASS', text: 'pass', combos: 0, cost: 0, hit: s.sf_key_1_over_234, base, legs: null, why: race.trifecta.type === 'KEY' ? 'undercard too loose for a cheap key' : 'only played when the trifecta is a key' };
}

// Morning-line probabilities, normalized so they add to 100% across the starters.
function marketProbs(ranked) {
  const raw = ranked.map((h) => (h.ml_dec != null && h.ml_dec >= 0 ? 1 / (h.ml_dec + 1) : null));
  const known = raw.filter((x) => x != null);
  if (known.length < Math.max(2, ranked.length - 1)) return null;
  const fill = known.length < raw.length ? Math.min(...known) * 0.6 : 0;
  const tot = raw.reduce((a, x) => a + (x ?? fill), 0);
  return { probs: raw.map((x) => (x ?? fill) / tot), overround: tot };
}

// Standard morning-line odds ladder (odds-to-1)
const LADDER = [[1, 9], [1, 5], [2, 5], [1, 2], [3, 5], [4, 5], [1, 1], [6, 5], [7, 5], [3, 2], [8, 5], [9, 5], [2, 1], [5, 2], [3, 1],
  [7, 2], [4, 1], [9, 2], [5, 1], [6, 1], [7, 1], [8, 1], [10, 1], [12, 1], [15, 1], [20, 1], [30, 1], [50, 1], [99, 1]];
export function toLine(dec) {
  let best = LADDER[0], bd = Infinity;
  for (const [a, b] of LADDER) { const d = Math.abs(Math.log((a / b) + 1) - Math.log(dec + 1)); if (d < bd) { bd = d; best = [a, b]; } }
  return { dec: best[0] / best[1], text: `${best[0]}-${best[1]}` };
}

// Our line: the numbers' win chances written as a morning line (same track take as this race's ML),
// so it reads like the program: 10-1 on the ML vs 5-1 on our line = good value.
function valueCall(race) {
  const rk = race.ranked;
  const mk = marketProbs(rk);
  const OR = mk ? Math.max(1.0, mk.overround) : 1.2;
  for (const h of rk) {
    const ln = toLine(1 / (h.win_prob * OR) - 1);
    h.line_dec = ln.dec; h.line = ln.text;
    h.ml_prob = null; h.value = null; h.value_ratio = null;
  }
  if (!mk) return { good: [], bad: [] };
  rk.forEach((h, i) => { h.ml_prob = mk.probs[i]; });
  const has = (h) => h.ml_dec != null;
  // good: ML at least 1.75× our line and 2+ points longer (e.g. ML 10-1, our line 5-1)
  const good = rk.filter((h) => has(h) && h.ml_dec >= 1.75 * h.line_dec && h.ml_dec - h.line_dec >= 2)
    .map((h) => ((h.value_ratio = h.ml_dec / h.line_dec), h)).sort((a, b) => b.value_ratio - a.value_ratio).slice(0, 3);
  // bad: our line at least 2× the ML and 2+ points longer, on horses 8-1 or shorter (e.g. ML 5-1, our line 10-1) — 2× since Nov 6
  const bad = rk.filter((h) => has(h) && h.ml_dec <= 8 && h.line_dec >= 2 * h.ml_dec && h.line_dec - h.ml_dec >= 2)
    .map((h) => ((h.value_ratio = h.line_dec / h.ml_dec), h)).sort((a, b) => b.value_ratio - a.value_ratio).slice(0, 2);
  for (const h of good) h.value = 'good';
  for (const h of bad) h.value = 'bad';
  return { good: good.map((h) => h.pgm), bad: bad.map((h) => h.pgm) };
}

function longshotCall(race) {
  const rk = race.ranked, s = race.sim, k = rk.length;
  const base = wagerBase(race, 'TRIFECTA') ?? 1.0;
  if (k < 4 || rk[0].ml_prob == null) return [];
  const q = rk.map((h) => h.ml_prob);
  const hv = (a, b, c) => q[a] * (q[b] / (1 - q[a])) * (q[c] / (1 - q[a] - q[b]));
  const idx = rk.map((h, i) => i);
  // longshot pool: good-value horses, else live prices the numbers like better than the morning line
  let pool = idx.filter((i) => rk[i].value === 'good');
  if (!pool.length) pool = idx.filter((i) => rk[i].ml_dec >= 6 && rk[i].ml_dec >= 1.4 * rk[i].line_dec && rk[i].win_prob >= 0.05);
  if (!pool.length) pool = idx.filter((i) => i > 0 && rk[i].ml_dec >= 4 && rk[i].ml_dec >= 1.15 * rk[i].line_dec && rk[i].win_prob >= 0.08)
    .sort((x, y) => (rk[y].ml_dec / rk[y].line_dec) - (rk[x].ml_dec / rk[x].line_dec)).slice(0, 1);
  if (!pool.length) return [];
  const inPool = (i) => pool.includes(i);
  const mainLegs = race.trifecta.legs ? race.trifecta.legs.map((l) => l.map((p) => rk.findIndex((h) => h.pgm === p))) : null;
  const inMain = (a, b, c) => !!mainLegs && mainLegs[0].includes(a) && mainLegs[1].includes(b) && mainLegs[2].includes(c);
  const used = new Set();
  const out = [];
  const key3 = (a, b, c) => `${a}.${b}.${c}`;
  const addTicket = (idxLegs, label, kindName) => {
    let p = 0, m = 0, combos = 0;
    const walk = (i, u) => {
      if (i === 3) { p += s.tri(u[0], u[1], u[2]); m += hv(u[0], u[1], u[2]); combos++; used.add(key3(...u)); return; }
      for (const x of idxLegs[i]) if (!u.includes(x)) walk(i + 1, [...u, x]);
    };
    walk(0, []);
    const legs = idxLegs.map((l) => l.map((i) => rk[i].pgm));
    out.push({ legs, text: legsText(legs), combos, cost: combos * base, base, hit: p, market: m, overlay: m ? p / m : null, label, kind: kindName,
      value: [...new Set(idxLegs.flat())].filter(inPool).map((i) => rk[i].pgm) });
  };
  // 1) keyed ticket around the best value horse
  const v = pool[0];
  const [a, b] = idx.filter((i) => i !== v).slice(0, 2);
  if (rk[v].win_prob >= 0.10) addTicket([[v], [a, b], [a, b]], `#${rk[v].pgm} on top`, 'top');
  else addTicket([[a, b], [a, b], [v]], `#${rk[v].pgm} to run third`, 'third');
  // 2-3) best-overlay straight tickets that use a value horse and would pay well
  const cands = [];
  for (let x = 0; x < k; x++) for (let y = 0; y < k; y++) for (let z = 0; z < k; z++) {
    if (x === y || y === z || x === z) continue;
    if (!(inPool(x) || inPool(y) || inPool(z))) continue;
    if (inMain(x, y, z)) continue;
    const p = s.tri(x, y, z);
    if (p < 0.008) continue;
    const m = hv(x, y, z);
    if (1 / m < 50) continue;
    cands.push({ x, y, z, p, ov: p / m });
  }
  cands.sort((m1, m2) => m2.ov - m1.ov);
  const spots = new Set();
  for (const t of cands) {
    if (out.length >= 3) break;
    if (used.has(key3(t.x, t.y, t.z))) continue;
    const spot = [t.x, t.y, t.z].findIndex(inPool);       // vary where the value horse finishes
    if (spots.has(spot) && cands.some((c) => !used.has(key3(c.x, c.y, c.z)) && !spots.has([c.x, c.y, c.z].findIndex(inPool)) && c.ov >= t.ov * 0.75)) continue;
    spots.add(spot);
    addTicket([[t.x], [t.y], [t.z]], 'straight', 'straight');
  }
  // a second value horse gets its own keyed ticket if there's room
  if (out.length < 3 && pool.length > 1) {
    const v2 = pool[1]; const [c, d] = idx.filter((i) => i !== v2).slice(0, 2);
    addTicket(rk[v2].win_prob >= 0.10 ? [[v2], [c, d], [c, d]] : [[c, d], [c, d], [v2]], rk[v2].win_prob >= 0.10 ? `#${rk[v2].pgm} on top` : `#${rk[v2].pgm} to run third`, rk[v2].win_prob >= 0.10 ? 'top' : 'third');
  }
  return out.slice(0, 3);
}

// Multi-race wagers listed in the program header, e.g. "50 CENT PICK 4 (1-2-3-4)".
export function multiRaceBets(card) {
  const out = [];
  const re = new RegExp('(?:' + BASE_RE + '\\s+)?((?:1ST HALF\\s+)?(?:DAILY|LATE|EARLY)\\s+DOUBLE|PICK\\s*[3-6])\\s*(?:\\([^)]*GUARANTEE[^)]*\\)\\s*)?\\(([\\d\\s-]+)\\)', 'g');
  for (const r of card.races) {
    let m;
    while ((m = re.exec(r.wagers || ''))) {
      const races = m[3].split('-').map((x) => parseInt(x, 10)).filter((x) => x > 0);
      if (races.length < 2) continue;
      let name = m[2].replace(/1ST HALF\s+/, '').replace(/\s+/g, ' ').trim();
      name = name.replace(/^PICK\s*(\d)$/, 'Pick $1').replace(/(\w+) DOUBLE/, (x, a) => a[0] + a.slice(1).toLowerCase() + ' Double');
      // when the program doesn't print a base: $1 for doubles and Pick 3, 50¢ for Pick 4/5/6
      const base = baseValue(m[1]) ?? (/Pick [456]/.test(name) ? 0.5 : 1);
      const id = `${name}-${races.join('-')}`;
      if (!out.some((x) => x.id === id)) out.push({ id, name, races, base });
    }
  }
  return out.sort((a, b) => a.races[0] - b.races[0] || a.races.length - b.races.length);
}

// Build a multi-race ticket under a budget: start with the top pick in every leg, then keep adding the
// horse that raises the hit chance most per extra dollar until the next one won't fit.
const PICK_MIN_HIT = { 2: 0.14, 3: 0.08, 4: 0.05, 5: 0.03, 6: 0.02 };
export function buildMultiTicket(races, base, budget, fixed = {}) {
  const legs = races.map((r) => {
    const cand = r.ranked.filter((h) => h.win_prob > 0);
    const fx = fixed[r.number] && fixed[r.number].filter((p) => cand.some((h) => h.pgm === p));
    return { r, cand, sel: fx && fx.length ? cand.filter((h) => fx.includes(h.pgm)) : [cand[0]], locked: !!(fx && fx.length) };
  });
  const cover = (l) => l.sel.reduce((a, h) => a + h.win_prob, 0);
  const combos = () => legs.reduce((a, l) => a * l.sel.length, 1);
  for (;;) {
    let best = null, bestScore = 0;
    const c = combos();
    for (const l of legs) {
      if (l.locked) continue;
      const nxt = l.cand.find((h) => !l.sel.includes(h));
      if (!nxt || cover(l) >= 0.85) continue;
      const newCost = (c / l.sel.length) * (l.sel.length + 1) * base;
      if (newCost > budget + 1e-9) continue;
      const gain = Math.log((cover(l) + nxt.win_prob) / cover(l));
      const costUp = Math.log((l.sel.length + 1) / l.sel.length);
      const sc = gain / costUp;
      if (sc > bestScore) { bestScore = sc; best = [l, nxt]; }
    }
    if (!best || bestScore < 0.12) break;
    best[0].sel.push(best[1]);
  }
  const hit = legs.reduce((a, l) => a * cover(l), 1);
  const mkt = legs.every((l) => l.sel.every((h) => h.ml_prob != null)) ? legs.reduce((a, l) => a * l.sel.reduce((x, h) => x + h.ml_prob, 0), 1) : null;
  const valueLegs = legs.filter((l) => l.sel.length <= 2 && l.sel.some((h) => h.value === 'good')).map((l) => l.r.number);
  const n = races.length;
  const minHit = PICK_MIN_HIT[n] ?? 0.03;
  const overlay = mkt ? hit / mkt : null;
  const cost = combos() * base;
  let verdict = 'PASS', why;
  if (!valueLegs.length) why = 'no good-value horse to build it around';
  else if (hit < minHit) why = `too spread out to cover well for $${budget} (${(hit * 100).toFixed(1)}% hit chance)`;
  else if (overlay != null && overlay < 1.3) why = 'the morning line already rates these horses about the same';
  else { verdict = 'PLAY'; why = `built around value in race${valueLegs.length > 1 ? 's' : ''} ${valueLegs.join(', ')}`; }
  return { legs: legs.map((l) => ({ n: l.r.number, sel: l.sel.map((h) => h.pgm), cover: cover(l), locked: l.locked })),
    combos: combos(), cost, hit, mkt, overlay, valueLegs, verdict, why, minHit };
}

export const FEATURE_VERSION = 1;
// Score from stored features with any set of multipliers (used to test weight mixes against results).
export function linearScore(f, mult) {
  const M = { ...DEFAULT_MULT, ...(mult || {}) };
  let s = 0, ws = 0;
  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    if (k === 'offtrack' && !f.off) continue;
    const w = DEFAULT_WEIGHTS[k] * (M[k] ?? 1);
    ws += w;
    s += w * (f.c[k] ?? 0.5);
  }
  if (ws > 0) s *= BASE_SUM / ws;
  for (const [g, v] of Object.entries(f.a)) s += v * (M[g] ?? 1);
  s -= f.p.breaks * M.breaks + f.p.layoff * M.layoff + f.p.thin;
  return s;
}

function postIndex(race, h) {
  const ps = race.post_stats, post = h.post_no ?? h.pgm;
  if (ps && ps.fast && ps.fast.win && post >= 1 && post <= ps.fast.win.length) {
    const i = post - 1;
    const src = race.cond === 'off' && ps.off && ps.off.starts && ps.off.starts[i] > 50 ? ps.off : ps.fast;
    if (!src.starts || src.starts[i] > 50) {
      let v = src.win[i];
      if (ps.last30 && ps.last30.starts && ps.last30.starts[i] > 50 && race.cond !== 'off') v = 0.75 * v + 0.25 * ps.last30.win[i];
      return v;
    }
  }
  return h.post_rating ?? null;
}

export function scoreRace(race, { today, year, mult, driverTable, scratched = [], sim = true, cond = 'fast' }) {
  race.cond = cond;
  const M = { ...DEFAULT_MULT, ...(mult || {}) };
  const W = Object.fromEntries(Object.entries(DEFAULT_WEIGHTS).map(([k, v]) => [k, v * (M[k] ?? 1)]));
  const grp = (key) => (key === 'lone_speed' || key === 'speed_duel' || key === 'closer_setup' ? 'pace'
    : key.startsWith('driver_') ? 'driver_change' : 'tough_trip');
  let cur = null;
  const A = (key, v) => { const g = grp(key); cur.adjRaw[g] = (cur.adjRaw[g] || 0) + v; return v * (M[g] ?? 1); };
  const hs = race.horses.filter((h) => !scratched.includes(h.pgm));
  if (!race.track_code) {
    const cnt = {};
    for (const h of race.horses) for (const p of h.pp.slice(0, 2)) if (p.track) { const k = trackKey(p.track); cnt[k] = (cnt[k] || 0) + 1; }
    let best = '', bc = 0;
    for (const [k, v] of Object.entries(cnt)) if (v > bc) { best = k; bc = v; }
    race.track_code = best;
  }
  if (race.track_size == null) {
    const sz = {};
    for (const h of race.horses) for (const p of h.pp.slice(0, 5)) if (p.track && trackKey(p.track) === race.track_code) sz[p.size] = (sz[p.size] || 0) + 1;
    const top = Object.entries(sz).sort((a, b) => b[1] - a[1])[0];
    race.track_size = top ? +top[0] : null;
  }
  race.post_scale = POST_SCALE[race.track_size] ?? 2;   // used for wording only — the real post index already carries the size effect
  if (cond !== 'off') W.offtrack = 0;
  const wsum = Object.values(W).reduce((a, b) => a + b, 0);
  const wnorm = wsum > 0 ? BASE_SUM / wsum : 1;
  for (const h of hs) h.m = horseMetrics(h, race, today, year);
  const early = hs.filter((h) => h.m.open_pos != null && h.m.open_pos <= 2.5 && h.m.clean_n >= 2 && !h.m.stale);
  race.pace = { early: early.map((h) => h.pgm) };
  const closers = hs.filter((h) => h.m.close_q != null).sort((a, b) => a.m.close_q - b.m.close_q).slice(0, 3);
  for (const h of hs) {
    const m = h.m; m.adj = []; m.adjRaw = {}; cur = m;
    if (early.length === 1 && early.includes(h)) m.adj.push(['lone_speed', A('lone_speed', ADJ.lone_speed)]);
    if (early.length >= 3 && early.includes(h)) m.adj.push(['speed_duel', A('speed_duel', ADJ.speed_duel)]);
    if (early.length >= 3 && closers.includes(h) && (m.open_pos || 0) >= 4.5) m.adj.push(['closer_setup', A('closer_setup', ADJ.closer_setup)]);
    m.drv_change = null;
    if (m.last_driver && h.driver && !sameDriver(h.driver, m.last_driver)) {
      const [, pu] = lookupUdr(driverTable || [], m.last_driver);
      const tu = m.driver_udr;
      m.drv_change = { prev: m.last_driver, prev_udr: pu };
      if (tu != null && pu != null) {
        const d = tu - pu;
        if (d >= 0.10) m.adj.push(['driver_up_big', A('driver_up_big', ADJ.driver_up_big)]);
        else if (d >= 0.05) m.adj.push(['driver_up', A('driver_up', ADJ.driver_up)]);
        else if (d <= -0.05) m.adj.push(['driver_down', A('driver_down', ADJ.driver_down)]);
        m.drv_change.delta = d;
      } else if (tu != null && tu >= 0.30) {
        m.adj.push(['driver_up', A('driver_up', ADJ.driver_up)]);
        m.drv_change.delta = null;
      }
    }
    if (m.tough.length) m.adj.push(['tough_trip', A('tough_trip', Math.min(ADJ.tough_trip_cap, ADJ.tough_trip * m.tough.length))]);
  }
  const col = (k) => hs.map((h) => h.m[k]);
  const comp = {
    speed: norm(col('sr_avg')), speed_best: norm(col('sr_best')), mark: norm(col('avg_mark'), false),
    close: norm(col('close_q'), false), form: norm(col('avg_fin3'), false),
    early: (() => { const a = norm(col('open_pos'), false), b = norm(col('open_q'), false); return a.map((x, i) => 0.5 * x + 0.5 * b[i]); })(),
    season_mark: norm(hs.map((h) => h.m.yr_mark_adj ?? (h.m.life_mark_adj != null ? h.m.life_mark_adj + 1.0 : null)), false),
    class: norm(col('class_val'), true, 0.4), late: norm(col('late_gain'), true, 0.4), year: norm(col('year_score')),
    driver: norm(col('driver_udr')), trainer: norm(col('trainer_w')),
    post: hs.map((h) => { const v = postIndex(race, h); h.m.post_idx = v; return v == null ? 0.5 : Math.max(0, Math.min(1, 0.5 + v / 130)); }),
    trend: norm(col('sr_trend'), true, 0.45), hot: norm(col('hot_val'), true, 0.5), conn: norm(col('conn_val'), true, 0.5),
    offtrack: norm(col('off_val'), true, 0.45),
  };
  hs.forEach((h, i) => {
    const m = h.m;
    let s = 0;
    for (const k of Object.keys(W)) s += W[k] * (comp[k] ? comp[k][i] : 0);
    s *= wnorm;
    const trot = race.gait === 'TROT';
    const brk = trot ? Math.min(16, 5 * m.brk_l5 + 2 * (m.brk_l10 - m.brk_l5) + (m.brk_last ? 3 : 0)) : Math.min(10, 4 * m.brk_l5);
    let lay = 0;
    if (m.days_real != null && m.days_real > 180) lay += m.qual_since ? 6 : 10;
    else if (m.days_real != null && m.days_real > 45) lay += m.qual_since ? 3 : 6;
    if (m.stale) lay += 3;
    const thin = m.clean_n <= 1 ? 4 : 0;
    const pen = brk * M.breaks + lay * M.layoff + thin;
    h.feat = { c: Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((k) => [k, comp[k] ? +comp[k][i].toFixed(4) : 0])),
      a: { ...m.adjRaw }, p: { breaks: brk, layoff: lay, thin }, off: cond === 'off' };
    const bonus = m.adj.reduce((a, [, v]) => a + v, 0);
    h.score = pyRound(s - pen + bonus, 1);
    h.bonus = bonus; h.penalty = pen;
    h.comp = Object.fromEntries(Object.keys(W).map((k) => [k, comp[k] ? comp[k][i] : 0]));
  });
  const ranked = [...hs].sort((a, b) => b.score - a.score);
  const ex = ranked.map((h) => Math.exp(h.score / TEMP));
  const tot = ex.reduce((a, b) => a + b, 0);
  ranked.forEach((h, i) => { h.win_prob = ex[i] / tot; h.fair_odds = 1 / h.win_prob - 1; h.rank = i + 1; });
  race.ranked = ranked;
  race.active = hs;
  race.confidence = confidence(ranked);
  if (!sim) return race;
  race.sim = simulate(ranked);
  race.undercard = undercardConf(race.sim);
  race.trifecta = trifectaCall(race);
  race.exacta = exactaCall(race);
  race.superfecta = superfectaCall(race);
  race.value = valueCall(race);
  race.longshots = longshotCall(race);
  for (const h of hs) [h.pros, h.cons] = prosCons(h, hs, race, year);
  return race;
}

function rankOf(h, hs, key, higherBetter = true) {
  const vals = hs.map((x) => x.m[key]).filter((v) => v != null);
  const v = h.m[key];
  if (v == null || !vals.length) return [null, vals.length];
  return [vals.filter((x) => (higherBetter ? x > v : x < v)).length + 1, vals.length];
}

function lengths(x) {
  if (x == null) return '';
  const w = Math.trunc(x), f = x - w;
  const fr = { 0.25: '¼', 0.5: '½', 0.75: '¾' }[Math.round(f * 4) / 4] || '';
  if (x < 0.2) return x <= 0.05 ? 'a nose' : 'a head';
  return w || fr ? `${w || ''}${fr}` : String(x);
}

export function shortName(n) {
  const parts = n.replace(/\./g, '').split(/\s+/).filter((p) => !['jr', 'sr', 'iii', '(p)'].includes(p.toLowerCase()));
  return parts.length >= 2 ? `${parts[0][0]}. ${parts[parts.length - 1]}` : n;
}

const f0 = (x) => pyRound(x).toFixed(0);
const money = (x) => '$' + x.toLocaleString('en-US');

function prosCons(h, hs, race, year) {
  const m = h.m, pros = [], cons = [];
  const P = (t, imp) => pros.push([t, imp]);
  const C = (t, imp) => cons.push([t, imp]);
  let [r, k] = rankOf(h, hs, 'sr_avg');
  if (r === 1) P(`Top speed figures in field (avg SR ${f0(m.sr_avg)})`, 3);
  else if (r === 2) P(`2nd-best speed figures (avg SR ${f0(m.sr_avg)})`, 2);
  else if (r && r >= k - 1 && k >= 4) C(`Speed figures near the bottom (avg SR ${f0(m.sr_avg)})`, 2);
  [r, k] = rankOf(h, hs, 'avg_mark', false);
  if (r === 1) P(`Fastest avg mile in field (${fmtTime(m.avg_mark)} adj)`, 3);
  [r, k] = rankOf(h, hs, 'close_q', false);
  if (r === 1) P(`Best closer: last 1/4 avg ${m.close_q.toFixed(1)} (best ${m.close_best.toFixed(1)})`, 3);
  else if (r === 2) P(`Strong closer: last 1/4 avg ${m.close_q.toFixed(1)}`, 2);
  else if (r && r === k && k >= 4) C(`Weakest finisher: last 1/4 avg ${m.close_q.toFixed(1)}`, 3);
  if (m.open_pos != null) {
    if (m.open_pos <= 2.0) P(`Gate speed: avg ${m.open_pos.toFixed(1)} at the 1/4 (opens in ${m.open_q.toFixed(1)})`, m.open_pos <= 1.5 ? 3 : 2);
    else if (m.open_pos >= 6) C(`Opens slow: avg ${m.open_pos.toFixed(1)} at the 1/4 (opens in ${m.open_q.toFixed(1)})`, 2);
  }
  const fins = m.fins3.join('-');
  if (m.won_last) P(`Won last start (last 3: ${fins})`, 3);
  else if (m.avg_fin3 != null && m.avg_fin3 <= 2.5) P(`Sharp form: ${fins} last 3`, 2);
  else if (m.fins3.includes(1)) P(`Recent win (last 3: ${fins})`, 2);
  else if (m.fins3.length >= 3 && Math.max(...m.fins3) <= 4) P(`Consistent: top 4 in each of last 3 (${fins})`, 2);
  else if (m.avg_fin3 != null && m.avg_fin3 >= 6) C(`Poor recent form: ${fins} last 3`, 2);
  else if (m.avg_fin3 != null && m.avg_fin3 >= 4 && !m.fins3.includes(1)) C(`No win in last 3 (${fins})`, 1);
  const cr = m.class_ratio;
  if (m.ship) {
    const nm = TRACK_NAME[trackKey(m.last_track)] || trackKey(m.last_track);
    if (m.tier_diff > 0) P(`Ships in from a tougher circuit (${nm})`, 2);
    else if (m.tier_diff < 0) C(`Ships in from a weaker circuit (${nm})`, m.tier_diff === -1 ? 2 : 3);
  } else if (cr != null) {
    if (cr <= 0.85) P(`Class drop: ${money(m.last_purse)} → ${money(race.purse)}`, cr <= 0.7 ? 3 : 2);
    else if (cr >= 1.18) C(`Class rise: ${money(m.last_purse)} → ${money(race.purse)}`, cr >= 1.5 ? 3 : 2);
  }
  const cd = m.cr_diff;
  if (cd != null) {
    if (cd >= 3) P(`Has faced tougher: avg class rating ${f0(m.cr_avg3)} vs ${race.cr} today`, cd >= 6 ? 3 : 2);
    else if (cd <= -4) C(`Faced softer: avg class rating ${f0(m.cr_avg3)} vs ${race.cr} today`, cd <= -8 ? 3 : 2);
  }
  const tags = Object.fromEntries(m.adj);
  if ('lone_speed' in tags) P('Lone speed: only true early horse in the field', 3);
  if ('speed_duel' in tags) C(`Speed duel likely with ${race.pace.early.filter((x) => x !== h.pgm).map((x) => '#' + x).join(', ')}`, 2);
  if ('closer_setup' in tags) P('Hot pace up front sets up his late kick', 2);
  const dc = m.drv_change;
  if (dc) {
    const prev = dc.prev.split(',')[0];
    const d = dc.delta;
    if (d != null && d >= 0.05) P(`Driver upgrade: ${shortName(h.driver)} (UDR ${m.driver_udr.toFixed(3)}) for ${prev} (${dc.prev_udr.toFixed(3)})`, d >= 0.10 ? 3 : 2);
    else if (d != null && d <= -0.05) C(`Driver downgrade: ${shortName(h.driver)} (${m.driver_udr.toFixed(3)}) for ${prev} (${dc.prev_udr.toFixed(3)})`, 2);
    else if (d == null && 'driver_up' in tags) P(`Picks up top driver ${shortName(h.driver)} (UDR ${m.driver_udr.toFixed(3)}, was ${prev})`, 2);
  }
  if (m.tough.length) {
    const t = m.tough[0];
    const how = t.finish === 1 ? 'won' : `finished ${t.finish}` + (t.beaten ? `, beaten ${lengths(t.beaten)}` : '');
    P(`Tough-trip credit: parked/first-over ${t.date.slice(0, 5)} and still ${how}`, t.finish === 1 ? 3 : 2);
  }
  if (race.gait === 'TROT') {
    if (m.brk_l10 >= 2) C(`Breaker: broke in ${m.brk_l10} of last ${m.lines_n}${m.brk_last ? ', including last start' : ''}`, 3);
    else if (m.brk_l10 === 1) C(`Broke stride in 1 of last ${m.lines_n}${m.brk_last ? ' (last start)' : ''}`, m.brk_last ? 3 : 2);
    else if (m.lines_n >= 6) P(`Clean-gaited: no breaks in last ${m.lines_n}`, 2);
  } else if (m.brk_l5 >= 2) C(`Broke in ${m.brk_l5} of last 5`, 3);
  else if (m.brk_l5 === 1) C('Broke stride in 1 of last 5', 1);
  // speed trend
  if (m.sr_trend != null) {
    const seq = m.sr_seq.join(' → ');
    if (m.sr_trend >= 2.5) P(`Improving: speed figures ${seq}`, m.sr_trend >= 4 ? 3 : 2);
    else if (m.sr_trend <= -2.5) C(`Declining: speed figures ${seq}`, m.sr_trend <= -4 ? 3 : 2);
  }
  // hot / cold connections (last 30 days vs the year)
  if (m.drv_hot != null && m.drv30_st >= 15) {
    if (m.drv_hot >= 0.06) P(`Hot driver: UDR ${h.drv30.r.toFixed(3)} last 30 days (year ${h.drv_udr.toFixed(3)})`, m.drv_hot >= 0.1 ? 3 : 2);
    else if (m.drv_hot <= -0.06) C(`Cold driver: UDR ${h.drv30.r.toFixed(3)} last 30 days (year ${h.drv_udr.toFixed(3)})`, m.drv_hot <= -0.1 ? 3 : 2);
  }
  if (m.trn_hot != null && m.trn30_st >= 6) {
    if (m.trn_hot >= 0.08) P(`Hot barn: UTR ${h.trn30.r.toFixed(3)} last 30 days (year ${h.trn_utr.toFixed(3)})`, m.trn_hot >= 0.15 ? 3 : 2);
    else if (m.trn_hot <= -0.08) C(`Cold barn: UTR ${h.trn30.r.toFixed(3)} last 30 days (year ${h.trn_utr.toFixed(3)})`, m.trn_hot <= -0.15 ? 3 : 2);
  }
  // connections & course
  if (m.combo && m.combo.st >= 5) {
    if (m.combo.w >= 25 && m.combo.w >= (h.drv_w || 0) + 8) P(`Driver/trainer team wins ${m.combo.w}% together (${m.combo.st} starts)`, 2);
    else if (m.combo.st >= 10 && m.combo.w <= 5) C(`Driver/trainer team ${m.combo.w}% together (${m.combo.st} starts)`, 1);
  }
  if (m.course && m.course.starts >= 4) {
    if (m.course.t3 >= 50 && m.course.t3 >= (m.life_top3 || 0) + 10) P(`Likes this track: ${m.course.starts} starts ${m.course.wins}-${m.course.places}-${m.course.shows} here`, 2);
    else if (m.course.starts >= 6 && m.course.t3 <= 20) C(`Poor record here: ${m.course.starts} starts ${m.course.wins}-${m.course.places}-${m.course.shows}`, 2);
  }
  if (m.new_barn) {
    const nb = m.new_barn, which = nb.starts_since === 0 ? 'First' : 'Second';
    if (nb.d >= 0.05) P(`${which} start for a better barn (UTR ${nb.prev_utr.toFixed(3)} → ${h.trn_utr.toFixed(3)})`, nb.d >= 0.1 ? 3 : 2);
    else if (nb.d <= -0.05) C(`${which} start for a weaker barn (UTR ${nb.prev_utr.toFixed(3)} → ${h.trn_utr.toFixed(3)})`, 2);
  }
  // off-track ability, only when the track is off
  if (race.cond === 'off' && m.off_rec) {
    const o = m.off_rec;
    if (o.starts >= 3 && m.off_t3 >= 50) P(`Handles off tracks: ${o.starts} starts ${o.wins}-${o.places}-${o.shows}`, 3);
    else if (o.starts >= 3 && m.off_t3 <= 15) C(`Struggles on off tracks: ${o.starts} starts ${o.wins}-${o.places}-${o.shows}`, 3);
    if (h.sire_off && h.sire_off.st >= 100 && h.sire_off.w >= 17) P(`Sire's foals win ${h.sire_off.w}% on off tracks`, 1);
  }
  if (m.days_real != null && m.days_real > 45) C(`Off ${m.days_real} days since last race${m.qual_since ? ' (qualified since)' : ''}`, m.qual_since ? 2 : 3);
  if (m.clean_n <= 1) C(`Only ${m.clean_n} clean line(s) in last 5 — little to go on`, 2);
  const ys = m.yr_starts, yw = m.yr_wins;
  if (ys >= 10 && (m.yr_win || 0) < 6) C(`${yw} win${yw !== 1 ? 's' : ''} from ${ys} starts in ${year}`, 2);
  else if (ys >= 6 && (m.yr_win || 0) >= 25) P(`${yw} wins from ${ys} starts in ${year} (${f0(m.yr_win)}%)`, 2);
  const upgraded = !!(m.drv_change && m.adj.some(([k]) => k.startsWith('driver_up')));
  if (m.driver_udr != null) {
    if (m.driver_udr >= 0.300 && !upgraded) P(`Top driver ${h.driver} (UDR ${m.driver_udr.toFixed(3)})`, 2);
    else if (m.driver_udr < 0.160) C(`Low-percentage driver (UDR ${m.driver_udr.toFixed(3)})`, 1);
  }
  if (h.trn_w != null && m.trn_hot == null && (h.trn_st == null || h.trn_st >= 15)) {
    const st = h.trn_st != null ? ` (${h.trn_st} starts)` : '';
    if (h.trn_w >= 20) P(`Strong barn: trainer wins ${h.trn_w}%${st}`, 1);
    else if (h.trn_w <= 5) C(`Weak barn: trainer wins ${h.trn_w}%${st}`, 1);
  }
  const prt = m.post_idx != null ? Math.round(m.post_idx) : null;
  if (prt != null) {
    const pn = h.post_no ?? h.pgm;
    const trkTxt = race.track_size === 0.5 ? ' on a half-mile track' : race.track_size === 0.625 ? ' on a ⅝ track' : '';
    const src = race.post_stats ? (race.post_stats.generic ? `typical ${race.post_stats.generic} post index` : 'track win index') : 'rating';
    if (prt >= 20) P(`Good post: PP${pn} (${src} +${prt})${trkTxt}`, prt >= 40 ? 3 : 2);
    else if (prt <= -20) C(`Tough post: PP${pn} (${src} ${prt})${trkTxt}`, prt <= -40 ? 3 : 2);
  }
  const lg = m.late_gain;
  if (lg != null && m.late_pairs.length >= 2) {
    [r] = rankOf(h, hs, 'late_gain');
    if (lg >= 1.5) P(`Gains late: +${lg.toFixed(1)} spots from 3/4 to finish`, r === 1 && lg >= 2 ? 3 : 2);
    else if (lg <= -1.5) C(`Fades late: ${lg.toFixed(1)} spots from 3/4 to finish`, lg <= -2.5 ? 3 : 2);
  }
  if (h.equip_note) P(h.equip_note.charAt(0) + h.equip_note.slice(1).toLowerCase().replace('lasix', 'Lasix'), 1);
  pros.sort((a, b) => b[1] - a[1]); cons.sort((a, b) => b[1] - a[1]);
  return [pros.slice(0, 4), cons.slice(0, 4)];
}

export function scoreCard(card, opts = {}) {
  const today = cardDate(card);
  const year = new Date(today).getUTCFullYear();
  const driverTable = cardDriverTable(card);
  for (const r of card.races) {
    scoreRace(r, { today, year, mult: opts.mult, driverTable, scratched: (opts.scratches || {})[r.number] || [], cond: opts.cond || 'fast' });
  }
  return card;
}
