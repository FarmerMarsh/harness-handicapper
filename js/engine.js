// Scoring engine — port of engine.py. Points formula + simulation + plays + pros/cons.
import { fmtTime } from './parse.js';

// seconds slower than a mile track; quarters get 1/4 of this
const TRACK_OFFSET = { 1: 0.0, 0.875: 0.4, 0.625: 1.0, 0.5: 2.0 };

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
  post: 2,        // Trackmaster post rating
  late: 4,        // avg spots gained 3/4 -> finish
  season_mark: 3, // current-year mark, mile-adjusted (lifetime mark if none this year)
};

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
  { key: 'post', group: 'weight', label: 'Post position', help: 'Trackmaster post rating' },
  { key: 'pace', group: 'adj', label: 'Pace setup', help: 'Lone speed bonus, speed-duel penalty, closer boost in a hot pace' },
  { key: 'driver_change', group: 'adj', label: 'Driver change', help: 'Upgrade bonus / downgrade penalty vs last start' },
  { key: 'tough_trip', group: 'adj', label: 'Tough-trip credit', help: 'Bonus for parked or first-over trips that still finished close' },
  { key: 'breaks', group: 'pen', label: 'Break penalty', help: 'Penalty for breaking stride in the last 5' },
  { key: 'layoff', group: 'pen', label: 'Layoff / stale-form penalty', help: 'Penalty for time off and old form lines' },
];
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
};

export const ADJ = {
  lone_speed: 4, speed_duel: -2, closer_setup: 2, driver_up: 2, driver_up_big: 3,
  driver_down: -2, tough_trip: 2, tough_trip_cap: 4,
};

// rough circuit tiers (1 = toughest); unknown tracks default to 3
const TRACK_TIER = {
  M: 1, YR: 1, Wbsb: 1, Moh: 1, Lex: 1, Mohk: 1,
  PcD: 2, Phl: 2, Mea: 2, HoP: 2, DD: 2, ScD: 2, PRc: 2,
  Nfld: 3, Stga: 3, VD: 3, TgDn: 3, Btva: 3, MR: 3, RcR: 3, GeoD: 3, OakGr: 3, Fhld: 3,
  Wdstk: 4, Hstng: 4, Fwvl: 4, Cntrv: 4, Allgn: 4, Elmra: 4, Grtz: 4, Mayfd: 4, Meadv: 4, Spr: 4, Caro: 4, Chfld: 4,
};
const TRACK_NAME = {
  M: 'the Meadowlands', YR: 'Yonkers', Wbsb: 'Mohawk', Lex: 'the Red Mile', PcD: 'Pocono', Phl: 'Philly',
  Mea: 'the Meadows', HoP: 'Hoosier', DD: 'Dover', ScD: 'Scioto', Nfld: 'Northfield', Stga: 'Saratoga',
  VD: 'Vernon', TgDn: 'Tioga', Btva: 'Batavia', MR: 'Monticello', RcR: 'Rosecroft', GeoD: 'Georgian', OakGr: 'Oak Grove',
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
  m.driver_udr = h.drv_udr ?? null;
  m.trainer_w = h.trn_w ?? null;
  m.post_rating = h.post_rating ?? null;
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
  const lam = ranked.map((h) => h.score / 22.0);
  const posCount = Array.from({ length: k }, () => new Array(k).fill(0));
  const c = { key234: 0, key23: 0, box3: 0, box4: 0, straight: 0, exKey: 0, exBox3: 0, exBox2: 0, sfKey: 0, sfBox4: 0 };
  const near = new Array(k).fill(0);
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
    }
  }
  const res = { n };
  res.pos_prob = posCount.map((row) => row.slice(0, Math.min(k, 6)).map((x) => x / n));
  res.top5_prob = posCount.map((row) => row.slice(0, 5).reduce((a, b) => a + b, 0) / n);
  res.top3_prob = posCount.map((row) => row.slice(0, 3).reduce((a, b) => a + b, 0) / n);
  res.key_1_over_234 = c.key234 / n; res.key_1_over_23 = c.key23 / n;
  res.box3 = c.box3 / n; res.box4 = c.box4 / n; res.straight = c.straight / n;
  res.ex_key_1_over_23 = c.exKey / n; res.ex_box3 = c.exBox3 / n; res.ex_box2 = c.exBox2 / n;
  res.sf_key_1_over_2345 = k >= 5 ? c.sfKey / n : 0; res.sf_box4 = k >= 5 ? c.sfBox4 / n : 0;
  const nr = [];
  for (let i = 1; i < Math.min(5, k); i++) nr.push(near[i] / n);
  res.undercard_near = nr.length ? nr.reduce((a, b) => a + b, 0) / nr.length : 0;
  return res;
}

function undercardConf(sim) {
  const u = sim.undercard_near;
  for (const [stars, cut] of [[1, 0.49], [2, 0.52], [3, 0.56], [4, 0.62]]) if (u < cut) return stars;
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

export function wagerBase(race, name) {
  const w = race.wagers || '';
  if (!w.includes(name)) return null;
  const m = w.match(new RegExp('(50 CENT|20 CENT|10 CENT|\\$1|\\$2)\\s*-?\\s*' + name));
  return m ? { '50 CENT': 0.5, '20 CENT': 0.2, '10 CENT': 0.1, '$1': 1.0, '$2': 2.0 }[m[1]] : 1.0;
}

const isKeyRace = (race) => race.confidence >= 4 && race.ranked[0].win_prob >= 0.30;

function trifectaCall(race) {
  const rk = race.ranked, s = race.sim, base = wagerBase(race, 'TRIFECTA') ?? 1.0;
  const p = (i) => `#${rk[i].pgm}`;
  if (rk.length < 4) return { type: 'PASS', text: 'field too small', combos: 0, cost: 0, hit: 0, base, why: 'too few starters' };
  if (isKeyRace(race)) return { type: 'KEY', text: `${p(0)} over ${p(1)}, ${p(2)}, ${p(3)}`, combos: 6, cost: 6 * base, hit: s.key_1_over_234, base, why: 'winner stands out — use him on top only' };
  if (race.undercard >= 3) return { type: 'BOX', text: `${p(0)}-${p(1)}-${p(2)}`, combos: 6, cost: 6 * base, hit: s.box3, base, why: 'top three are tight as a group, winner is not a lock' };
  if (s.box4 >= 0.33) return { type: 'BOX 4', text: `${p(0)}-${p(1)}-${p(2)}-${p(3)}`, combos: 24, cost: 24 * base, hit: s.box4, base, why: 'no standout and a loose top three — spread wider' };
  return { type: 'PASS', text: 'no trifecta play', combos: 0, cost: 0, hit: s.box4, base, why: 'too wide open to bet the trifecta with confidence' };
}

function exactaCall(race) {
  const rk = race.ranked, s = race.sim, base = wagerBase(race, 'EXACTA');
  const p = (i) => `#${rk[i].pgm}`;
  if (base == null || rk.length < 3) return { type: 'N/A', text: 'not offered', combos: 0, cost: 0, hit: 0, base };
  if (isKeyRace(race)) return { type: 'KEY', text: `${p(0)} over ${p(1)}, ${p(2)}`, combos: 2, cost: 2 * base, hit: s.ex_key_1_over_23, base };
  if (s.ex_box3 >= 0.40 || ['BOX', 'BOX 4'].includes(race.trifecta.type)) return { type: 'BOX', text: `${p(0)}-${p(1)}-${p(2)}`, combos: 6, cost: 6 * base, hit: s.ex_box3, base };
  return { type: 'PASS', text: 'no exacta play', combos: 0, cost: 0, hit: s.ex_box3, base, why: 'no standout and the top three are loose' };
}

function superfectaCall(race) {
  const rk = race.ranked, s = race.sim, base = wagerBase(race, 'SUPERFECTA');
  const p = (i) => `#${rk[i].pgm}`;
  if (base == null || rk.length < 5) return { type: 'N/A', text: 'not offered', combos: 0, cost: 0, hit: 0, base };
  if (isKeyRace(race) && race.undercard >= 3) return { type: 'KEY', text: `${p(0)} over ${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}`, combos: 24, cost: 24 * base, hit: s.sf_key_1_over_2345, base };
  if (race.undercard >= 4) return { type: 'BOX', text: `${p(0)}-${p(1)}-${p(2)}-${p(3)}`, combos: 24, cost: 24 * base, hit: s.sf_box4, base };
  return { type: 'PASS', text: 'no superfecta play', combos: 0, cost: 0, hit: s.sf_box4, base, why: 'undercard too loose to cover 4 deep' };
}

export function scoreRace(race, { today, year, mult, driverTable, scratched = [] }) {
  const M = { ...DEFAULT_MULT, ...(mult || {}) };
  const W = Object.fromEntries(Object.entries(DEFAULT_WEIGHTS).map(([k, v]) => [k, v * (M[k] ?? 1)]));
  const A = (key, v) => v * (key === 'lone_speed' || key === 'speed_duel' || key === 'closer_setup' ? M.pace
    : key.startsWith('driver_') ? M.driver_change : key === 'tough_trip' ? M.tough_trip : 1);
  const hs = race.horses.filter((h) => !scratched.includes(h.pgm));
  if (!race.track_code) {
    const cnt = {};
    for (const h of race.horses) for (const p of h.pp.slice(0, 2)) if (p.track) { const k = trackKey(p.track); cnt[k] = (cnt[k] || 0) + 1; }
    let best = '', bc = 0;
    for (const [k, v] of Object.entries(cnt)) if (v > bc) { best = k; bc = v; }
    race.track_code = best;
  }
  for (const h of hs) h.m = horseMetrics(h, race, today, year);
  const early = hs.filter((h) => h.m.open_pos != null && h.m.open_pos <= 2.5 && h.m.clean_n >= 2 && !h.m.stale);
  race.pace = { early: early.map((h) => h.pgm) };
  const closers = hs.filter((h) => h.m.close_q != null).sort((a, b) => a.m.close_q - b.m.close_q).slice(0, 3);
  for (const h of hs) {
    const m = h.m; m.adj = [];
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
    driver: norm(col('driver_udr')), trainer: norm(col('trainer_w')), post: norm(col('post_rating'), true, 0.5),
  };
  hs.forEach((h, i) => {
    const m = h.m;
    let s = 0;
    for (const k of Object.keys(W)) s += W[k] * (comp[k] ? comp[k][i] : 0);
    let pen = Math.min(10, 4 * m.brk_l5) * M.breaks;
    let lay = 0;
    if (m.days_real != null && m.days_real > 180) lay += m.qual_since ? 6 : 10;
    else if (m.days_real != null && m.days_real > 45) lay += m.qual_since ? 3 : 6;
    if (m.stale) lay += 3;
    pen += lay * M.layoff;
    if (m.clean_n <= 1) pen += 4;
    const bonus = m.adj.reduce((a, [, v]) => a + v, 0);
    h.score = pyRound(s - pen + bonus, 1);
    h.bonus = bonus; h.penalty = pen;
    h.comp = Object.fromEntries(Object.keys(W).map((k) => [k, comp[k] ? comp[k][i] : 0]));
  });
  const ranked = [...hs].sort((a, b) => b.score - a.score);
  const ex = ranked.map((h) => Math.exp(h.score / 22.0));
  const tot = ex.reduce((a, b) => a + b, 0);
  ranked.forEach((h, i) => { h.win_prob = ex[i] / tot; h.fair_odds = 1 / h.win_prob - 1; h.rank = i + 1; });
  race.ranked = ranked;
  race.active = hs;
  race.sim = simulate(ranked);
  race.undercard = undercardConf(race.sim);
  race.confidence = confidence(ranked);
  race.trifecta = trifectaCall(race);
  race.exacta = exactaCall(race);
  race.superfecta = superfectaCall(race);
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
  if (m.brk_l5 >= 2) C(`Broke in ${m.brk_l5} of last 5`, 3);
  else if (m.brk_l5 === 1) C('Broke stride in 1 of last 5', 1);
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
  if (m.trainer_w != null) {
    if (m.trainer_w >= 20) P(`Hot barn: trainer wins ${m.trainer_w}%`, 1);
    else if (m.trainer_w <= 5) C(`Cold barn: trainer wins ${m.trainer_w}%`, 1);
  }
  const prt = m.post_rating;
  if (prt != null) {
    if (prt >= 20) P(`Good post (PP${h.pgm} rating +${prt})`, 1);
    else if (prt <= -20) C(`Tough post (PP${h.pgm} rating ${prt})`, prt <= -30 ? 2 : 1);
  }
  const lg = m.late_gain;
  if (lg != null && m.late_pairs.length >= 2) {
    [r] = rankOf(h, hs, 'late_gain');
    if (lg >= 1.5) P(`Gains late: +${lg.toFixed(1)} spots from 3/4 to finish`, r === 1 && lg >= 2 ? 3 : 2);
    else if (lg <= -1.5) C(`Fades late: ${lg.toFixed(1)} spots from 3/4 to finish`, lg <= -2.5 ? 3 : 2);
  }
  if (h.equip_note) P(h.equip_note.charAt(0) + h.equip_note.slice(1).toLowerCase().replace('lasix', 'Lasix'), 1);
  pros.sort((a, b) => b[1] - a[1]); cons.sort((a, b) => b[1] - a[1]);
  return [pros.slice(0, 3), cons.slice(0, 3)];
}

export function scoreCard(card, opts = {}) {
  const today = cardDate(card);
  const year = new Date(today).getUTCFullYear();
  const driverTable = cardDriverTable(card);
  for (const r of card.races) {
    scoreRace(r, { today, year, mult: opts.mult, driverTable, scratched: (opts.scratches || {})[r.number] || [] });
  }
  return card;
}
