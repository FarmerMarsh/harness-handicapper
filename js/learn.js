// Learning from your results (v14).
// Every graded race keeps what the model knew before the race (each horse's factor scores) and the
// official order. From those, this fits multipliers on top of the track normal, in layers:
//   all tracks → track size → each track → trotters / pacers
// Each layer starts from the one above it and is pulled back toward it (shrinkage), so with few races
// nothing moves, and the more results go in the further the weights can move. It also tunes how spread
// out our lines are (temperature) so a horse we call 20% wins about 20% of the time.
// Every fit is checked on races it didn't see (5 groups of cards); if it doesn't beat normal weights
// there, normal weights stay in use.
import { DEFAULT_WEIGHTS, BASE_SUM, TEMP, FACTORS } from './engine.js?v=29';

const WKEYS = Object.keys(DEFAULT_WEIGHTS);
export const LEARN_KEYS = FACTORS.map((f) => f.key).filter((k) => k !== 'offtrack');
const KEYS = [...new Set([...WKEYS, ...LEARN_KEYS])];
const KI = Object.fromEntries(KEYS.map((k, i) => [k, i]));
const NK = KEYS.length;
const LAM = 12;          // pull toward the layer above (per unit of ln(multiplier)²)
const LAM_T = 30;        // pull on the line-spread setting
const STEPS = [0.7, 0.85, 1 / 0.85, 1 / 0.7];
const LO = 0.25, HI = 4;

const ones = () => new Float64Array(NK).fill(1);
const toArr = (o) => { const a = ones(); for (const [k, v] of Object.entries(o || {})) if (k in KI) a[KI[k]] = v; return a; };
const toObj = (a, minDev = 0.005) => { const o = {}; KEYS.forEach((k, i) => { if (Math.abs(Math.log(a[i])) > minDev) o[k] = +a[i].toFixed(3); }); return o; };
const mul = (a, b) => { const o = new Float64Array(NK); for (let i = 0; i < NK; i++) o[i] = a[i] * b[i]; return o; };

// rows: [{ feat: [[pgm, f]], fin: [pgm, pgm, pgm], track, size, gait, card }]
// Each horse becomes three linear pieces so a score is (num / den) × BASE_SUM + adj − thin, all linear in the multipliers.
export function compile(rows) {
  const out = [];
  for (const r of rows) {
    const H = [];
    for (const [pgm, f] of r.feat) {
      if (!f || !f.c) continue;
      const b = f.b || {};
      const wb = new Float64Array(NK), cw = new Float64Array(NK), ak = new Float64Array(NK);
      for (const k of WKEYS) {
        if (k === 'offtrack' && !f.off) continue;
        const i = KI[k];
        wb[i] = DEFAULT_WEIGHTS[k] * (b[k] ?? 1);
        cw[i] = wb[i] * (f.c[k] ?? 0.5);
      }
      for (const [g, v] of Object.entries(f.a || {})) if (g in KI && v) ak[KI[g]] += v * (b[g] ?? 1);
      const p = f.p || {};
      ak[KI.breaks] -= (p.breaks || 0) * (b.breaks ?? 1);
      ak[KI.layoff] -= (p.layoff || 0) * (b.layoff ?? 1);
      H.push({ pgm, wb, cw, ak, thin: p.thin || 0 });
    }
    const fin = [];
    for (const pg of r.fin || []) { const i = H.findIndex((h) => h.pgm === pg); if (i < 0 || fin.includes(i)) break; fin.push(i); }
    if (H.length >= 2 && fin.length) out.push({ H, fin: fin.slice(0, 3), track: r.track, size: r.size, gait: r.gait === 'TROT' ? 'TROT' : 'PACE', card: r.card });
  }
  return out;
}

function parts(h, m) {
  let num = 0, den = 0, adj = -h.thin;
  for (let i = 0; i < NK; i++) { const x = m[i]; num += h.cw[i] * x; den += h.wb[i] * x; adj += h.ak[i] * x; }
  return [num, den, adj];
}
const scoreOf = (num, den, adj) => (den > 0 ? (num * BASE_SUM) / den : 0) + adj;
// Plackett–Luce log-likelihood of the finishers we know (win, place, show), from scores
function llFromScores(s, fin, invT) {
  let ll = 0;
  const used = new Uint8Array(s.length);
  for (const j of fin) {
    let mx = -Infinity;
    for (let i = 0; i < s.length; i++) if (!used[i] && s[i] > mx) mx = s[i];
    let z = 0;
    for (let i = 0; i < s.length; i++) if (!used[i]) z += Math.exp((s[i] - mx) * invT);
    ll += (s[j] - mx) * invT - Math.log(z);
    used[j] = 1;
  }
  return ll;
}
function rowLL(r, m, invT) {
  return llFromScores(r.H.map((h) => { const [a, b, c] = parts(h, m); return scoreOf(a, b, c); }), r.fin, invT);
}
const pen = (L, lam) => { let p = 0; for (let i = 0; i < NK; i++) { const x = Math.log(L[i]); p += x * x; } return lam * p; };

// coordinate search on a log scale for one layer's multipliers, with cached partial sums so each trial is cheap
function fitGroup(rows, parents, L0, invT, lam = LAM) {
  if (!rows.length) return L0;
  const L = Float64Array.from(L0);
  const cache = rows.map((r, ri) => { const m = mul(parents[ri], L); return r.H.map((h) => parts(h, m)); });
  const total = (i, d) => {   // log-likelihood if multiplier i changes by d (in L units)
    let t = 0;
    for (let ri = 0; ri < rows.length; ri++) {
      const r = rows[ri], c = cache[ri], dd = d ? parents[ri][i] * d : 0;
      const s = new Array(r.H.length);
      for (let hi = 0; hi < r.H.length; hi++) { const h = r.H[hi], [n0, d0, a0] = c[hi]; s[hi] = scoreOf(n0 + h.cw[i] * dd, d0 + h.wb[i] * dd, a0 + h.ak[i] * dd); }
      t += llFromScores(s, r.fin, invT);
    }
    return t;
  };
  let best = total(0, 0) - pen(L, lam);
  const learn = LEARN_KEYS.map((k) => KI[k]);
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (const i of learn) {
      let bestV = null;
      for (const st of STEPS) {
        const v = Math.min(HI, Math.max(LO, L[i] * st));
        if (v === L[i]) continue;
        const old = L[i]; L[i] = v; const pv = pen(L, lam); L[i] = old;
        const val = total(i, v - old) - pv;
        if (val > best + 1e-9) { best = val; bestV = v; }
      }
      if (bestV != null) {
        const d = bestV - L[i];
        for (let ri = 0; ri < rows.length; ri++) { const dd = parents[ri][i] * d; rows[ri].H.forEach((h, hi) => { const c = cache[ri][hi]; c[0] += h.cw[i] * dd; c[1] += h.wb[i] * dd; c[2] += h.ak[i] * dd; }); }
        L[i] = bestV; moved = true;
      }
    }
    if (!moved) break;
  }
  return L;
}

function fitAll(rows) {
  const invT0 = 1 / TEMP;
  const P1 = rows.map(() => ones());
  const G = fitGroup(rows, P1, ones(), invT0);
  const S = {}, T = {}, A = {};
  const pG = rows.map(() => G);
  for (const sz of [...new Set(rows.map((r) => r.size).filter((x) => x != null))]) {
    const idx = rows.map((r, i) => (r.size === sz ? i : -1)).filter((i) => i >= 0);
    S[sz] = fitGroup(idx.map((i) => rows[i]), idx.map((i) => pG[i]), ones(), invT0);
  }
  const pS = rows.map((r) => (S[r.size] ? mul(G, S[r.size]) : G));
  for (const tr of [...new Set(rows.map((r) => r.track).filter(Boolean))]) {
    const idx = rows.map((r, i) => (r.track === tr ? i : -1)).filter((i) => i >= 0);
    T[tr] = fitGroup(idx.map((i) => rows[i]), idx.map((i) => pS[i]), ones(), invT0);
  }
  const pT = rows.map((r, i) => (T[r.track] ? mul(pS[i], T[r.track]) : pS[i]));
  for (const g of ['PACE', 'TROT']) {
    const idx = rows.map((r, i) => (r.gait === g ? i : -1)).filter((i) => i >= 0);
    A[g] = fitGroup(idx.map((i) => rows[i]), idx.map((i) => pT[i]), ones(), invT0);
  }
  const full = rows.map((r, i) => (A[r.gait] ? mul(pT[i], A[r.gait]) : pT[i]));
  // line spread
  let bt = 1, bv = -Infinity;
  for (let t = 0.7; t <= 1.401; t += 0.05) {
    let v = 0;
    for (let i = 0; i < rows.length; i++) v += rowLL(rows[i], full[i], 1 / (TEMP * t));
    v -= LAM_T * Math.log(t) ** 2;
    if (v > bv) { bv = v; bt = t; }
  }
  return { G, S, T, A, temp: +bt.toFixed(2) };
}
const multFor = (m, r) => { let x = m.G; if (m.S[r.size]) x = mul(x, m.S[r.size]); if (m.T[r.track]) x = mul(x, m.T[r.track]); if (m.A[r.gait]) x = mul(x, m.A[r.gait]); return x; };

function winProbs(r, m, invT) {
  const s = r.H.map((h) => { const [a, b, c] = parts(h, m); return scoreOf(a, b, c) * invT; }), mx = Math.max(...s);
  const e = s.map((x) => Math.exp(x - mx)), z = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / z);
}

const BUCKETS = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.45, 1.01];
export function learnAll(rawRows) {
  const rows = compile(rawRows);
  const n = rows.length, nPos = rows.reduce((a, r) => a + r.fin.length, 0);
  const res = { v: 1, raw: rawRows.length, n, nPos, at: Date.now(), counts: { size: {}, track: {}, gait: {} } };
  for (const r of rows) { res.counts.size[r.size] = (res.counts.size[r.size] || 0) + 1; res.counts.track[r.track] = (res.counts.track[r.track] || 0) + 1; res.counts.gait[r.gait] = (res.counts.gait[r.gait] || 0) + 1; }
  if (n < 5) { res.ok = false; res.status = 'waiting'; return res; }
  // check on races it didn't see: 5 groups of whole cards
  const cards = [...new Set(rows.map((r) => r.card))];
  const fold = (r) => cards.indexOf(r.card) % 5;
  const cv = { n: 0, hitsL: 0, hitsN: 0, llL: 0, llN: 0, calib: BUCKETS.slice(0, -1).map((lo, i) => ({ lo, hi: BUCKETS[i + 1], n: 0, pred: 0, wins: 0 })) };
  const one = ones();
  if (cards.length >= 3) {
    for (let f = 0; f < Math.min(5, cards.length); f++) {
      const train = rows.filter((r) => fold(r) !== f), test = rows.filter((r) => fold(r) === f);
      if (!train.length || !test.length) continue;
      const m = fitAll(train), invT = 1 / (TEMP * m.temp);
      for (const r of test) {
        const ml = multFor(m, r);
        cv.n++;
        cv.llL += rowLL(r, ml, invT); cv.llN += rowLL(r, one, 1 / TEMP);
        const pl = winProbs(r, ml, invT), pn = winProbs(r, one, 1 / TEMP);
        const top = (p) => p.indexOf(Math.max(...p));
        if (top(pl) === r.fin[0]) cv.hitsL++;
        if (top(pn) === r.fin[0]) cv.hitsN++;
        pl.forEach((p, i) => { const b = cv.calib.find((c) => p >= c.lo && p < c.hi); if (b) { b.n++; b.pred += p; if (i === r.fin[0]) b.wins++; } });
      }
    }
  }
  const m = fitAll(rows);
  res.model = { G: toObj(m.G), S: Object.fromEntries(Object.entries(m.S).map(([k, v]) => [k, toObj(v)])), T: Object.fromEntries(Object.entries(m.T).map(([k, v]) => [k, toObj(v)])),
    A: Object.fromEntries(Object.entries(m.A).map(([k, v]) => [k, toObj(v)])), temp: m.temp };
  res.cv = cv;
  // use it only if, on races it hadn't seen, it rated the real finishers at least as well as normal weights
  res.ok = cv.n === 0 ? false : cv.llL >= cv.llN - 0.5;
  res.status = cv.n === 0 ? 'need 3 cards' : res.ok ? 'on' : 'holding';
  return res;
}

// multipliers to apply to one race: all tracks × size × track × gait
export function learnedMult(model, { size, track, gait }) {
  if (!model) return {};
  const out = { ...model.G };
  const apply = (o) => { for (const [k, v] of Object.entries(o || {})) out[k] = (out[k] ?? 1) * v; };
  apply(model.S[size]); apply(model.T[track]); apply(model.A[gait === 'TROT' ? 'TROT' : 'PACE']);
  for (const k of Object.keys(out)) out[k] = Math.min(HI, Math.max(LO, out[k]));   // all layers together stay within ¼×–4×
  return out;
}
