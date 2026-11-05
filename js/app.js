import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { parseProgram, fmtTime } from './parse.js';
import {
  scoreRace, cardDate, cardDriverTable, DEFAULT_WEIGHTS, WEIGHT_LABELS, ADJ, FACTORS, DEFAULT_MULT, PRESETS,
  multiRaceBets, legSuggestion, linearScore, legsHit, legsText,
} from './engine.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

// ---------------- storage ----------------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const CARDS_KEY = 'hh:cards';            // { key: { track, date, savedAt, card } }
const STATE_PREFIX = 'hh:state:';
const stateKey = (k) => STATE_PREFIX + k;   // { scratches, notes, results, snaps, picks }
const MULT_KEY = 'hh:mult';
const PREF_KEY = 'hh:prefs';

const S = {
  key: null, base: null, card: null, st: null,
  mult: { ...DEFAULT_MULT, ...LS.get(MULT_KEY, {}) },
  tuneOpen: false, dirty: false, shared: null, pasted: null, suggestion: null,
  prefs: { sort: 'pgm', view: 'auto', pickStyle: 'balanced', shareName: '', ...LS.get(PREF_KEY, {}) },
  driverTable: [], today: null, year: null, bets: [],
};

// ---------------- helpers ----------------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const money = (x) => '$' + Number(x).toLocaleString('en-US');
const dollars = (x) => '$' + Number(x || 0).toFixed(2);
const pct0 = (x) => (x == null ? '—' : `${Math.round(x)}%`);
const pctP = (p, d = 0) => `${(p * 100).toFixed(d)}%`;
const ord = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
const KEEP = new Set(['MR', 'MS', 'DR', 'ST']);
function tc(name) {
  return (name || '').split(/\s+/).map((tok) => {
    const core = tok.replace(/[^A-Za-z]/g, '');
    if (core && !/[AEIOUY]/i.test(core) && !KEEP.has(core.toUpperCase())) return tok.toUpperCase();
    if (['II', 'III', 'IV'].includes(core.toUpperCase())) return tok.toUpperCase();
    return tok.toLowerCase().replace(/[a-z]/, (c) => c.toUpperCase());
  }).join(' ');
}
function oddsStr(x) {
  if (x == null || !isFinite(x)) return '—';
  if (x < 1) {
    for (const [a, b] of [[1, 9], [1, 5], [2, 5], [1, 2], [3, 5], [4, 5], [1, 1]]) if (x <= a / b + 0.05) return `${a}-${b}`;
  }
  if (x >= 99) return '99-1+';
  return x < 10 ? `${x.toFixed(1)}-1` : `${Math.round(x)}-1`;
}
const baseLabel = (b) => (b == null ? '' : b === 0.5 ? '50¢' : b >= 1 ? `$${b.toFixed(0)}` : `${Math.round(b * 100)}¢`);
const trk = (t) => esc((t || '').replace('Á', '⅝').replace('Â', '⅞'));
const kind = (t) => (t.type.startsWith('KEY') ? 'key' : t.type.startsWith('BOX') ? 'box' : 'pass');
const raceOf = (n) => S.card && S.card.races.find((r) => r.number === n);
const horseOf = (r, pgm) => r.horses.find((h) => h.pgm === pgm);
const curRace = () => +(location.hash.match(/race\/(\d+)/) || [])[1];

// ---------------- weights ----------------
const multText = (x) => (x === 0 ? 'Off' : x === 1 ? 'Normal' : `${+x.toFixed(2)}×`);
function customList(mult = S.mult) {
  return FACTORS.filter((f) => (mult[f.key] ?? 1) !== 1).map((f) => [f.label, mult[f.key]]);
}
function presetName(mult = S.mult) {
  for (const [k, p] of Object.entries(PRESETS)) {
    const m = { ...DEFAULT_MULT, ...p.mult };
    if (FACTORS.every((f) => (mult[f.key] ?? 1) === m[f.key])) return k;
  }
  return null;
}
function weightsText(mult = S.mult) {
  const pk = presetName(mult);
  if (pk === 'normal') return 'Normal weights';
  if (pk) return `Preset: ${PRESETS[pk].label}`;
  return 'Custom weights: ' + customList(mult).map(([l, x]) => `${l} ${multText(x)}`).join(', ');
}
function weightsBadge() {
  const pk = presetName();
  if (pk === 'normal') return `<a class="pill" href="#/settings">Weights: Normal</a>`;
  if (pk) return `<a class="pill key" href="#/settings">Weights: ${esc(PRESETS[pk].label)}</a>`;
  const c = customList();
  return `<a class="pill key" href="#/settings" title="${esc(c.map(([l, x]) => `${l} ${multText(x)}`).join(', '))}">Custom weights: ${esc(c.slice(0, 2).map(([l, x]) => `${l} ${multText(x)}`).join(', '))}${c.length > 2 ? ` +${c.length - 2} more` : ''}</a>`;
}
function tuneHtml(compact = false) {
  const pk = presetName();
  const group = (g, title) => `<h3>${title}</h3><div class="weights">${FACTORS.filter((f) => f.group === g).map((f) => {
    const x = S.mult[f.key] ?? 1;
    return `<div class="w"><label for="m-${f.key}">${esc(f.label)}</label><output id="mo-${f.key}" class="${x > 1 ? 'up' : x < 1 ? 'down' : ''}">${multText(x)}</output>
      <input type="range" id="m-${f.key}" min="0" max="3" step="0.25" value="${x}" data-m="${f.key}" aria-describedby="mh-${f.key}">
      <div class="wh" id="mh-${f.key}">${esc(f.help)}</div></div>`;
  }).join('')}</div>`;
  return `<div class="panel tune">
    <div class="presets"><span class="note">Start from:</span>${Object.entries(PRESETS).map(([k, p]) => `<button class="btn small ${pk === k ? 'primary' : ''}" data-preset="${k}">${esc(p.label)}</button>`).join('')}
      <button class="btn small" data-act="share">Share my settings</button></div>
    ${group('weight', 'Ranking factors')}${group('adj', 'Race-shape bonuses')}${group('pen', 'Penalties')}
    <p class="note">Normal = the standard model. 2× counts a factor twice as much, 0.5× half as much, Off ignores it. Your settings stay in this browser${compact ? ' and apply to every race' : ''}.</p>
  </div>`;
}

function setStatus(msg, err = false) {
  const el = $('#status');
  el.textContent = msg || '';
  el.classList.toggle('err', !!err);
}

// ---------------- loading ----------------
async function loadFile(file) {
  if (!file) return;
  setStatus('Reading program…');
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    setStatus(`Reading ${doc.numPages} pages…`);
    const card = await parseProgram(doc);
    if (!card.races.length || !card.races.some((r) => r.horses.length)) {
      setStatus("Couldn't find Trackmaster race pages in that PDF. Try the program PDF from the track or trackmaster.com.", true);
      return;
    }
    const key = `${card.track || 'Track'}|${card.date || file.name}`;
    const cards = LS.get(CARDS_KEY, {});
    cards[key] = { track: card.track, date: card.date, savedAt: Date.now(), card };
    const keys = Object.keys(cards).sort((a, b) => cards[b].savedAt - cards[a].savedAt);
    for (const k of keys.slice(8)) delete cards[k];
    if (!LS.set(CARDS_KEY, cards)) { delete cards[key]; }
    openCard(key, card);
    setStatus('');
    location.hash = '#/';
    render();
  } catch (e) {
    console.error(e);
    setStatus('Something went wrong reading that file: ' + (e.message || e), true);
  }
}

function openCard(key, card) {
  S.key = key;
  S.base = JSON.stringify(card);
  S.st = { scratches: {}, notes: {}, results: {}, snaps: {}, picks: {}, ...LS.get(stateKey(key), {}) };
  S.st.picks = S.st.picks || {};
  rescoreAll();
}

function rescoreAll() {
  S.card = JSON.parse(S.base);
  S.today = cardDate(S.card);
  S.year = new Date(S.today).getUTCFullYear();
  S.driverTable = cardDriverTable(S.card);
  for (const r of S.card.races) scoreOne(r);
  S.bets = multiRaceBets(S.card).filter((b) => b.races.every((n) => raceOf(n)));
}
function scoreOne(r) {
  scoreRace(r, { today: S.today, year: S.year, mult: S.mult, driverTable: S.driverTable, scratched: S.st.scratches[r.number] || [] });
}
const saveState = () => LS.set(stateKey(S.key), S.st);

// ---------------- grading ----------------
function playOf(t) {
  return { type: t.type, text: t.text, combos: t.combos, cost: t.cost, legs: t.legs || null };
}
function snapshot(r) {
  return {
    v: 2,
    order: r.ranked.map((h) => h.pgm), conf: r.confidence, under: r.undercard,
    plays: { exacta: playOf(r.exacta), trifecta: playOf(r.trifecta), superfecta: playOf(r.superfecta) },
    longshots: (r.longshots || []).map((l) => ({ legs: l.legs, text: l.text, cost: l.cost })),
    value: { good: [...(r.value?.good || [])], bad: [...(r.value?.bad || [])] },
    feat: r.ranked.map((h) => [h.pgm, h.feat]),
  };
}
// grading for snapshots saved before tickets carried legs
function oldPlayHit(kindName, play, top, fin) {
  const t = play.type;
  if (t === 'PASS' || t === 'N/A') return null;
  const sub = (a, b) => a.every((x) => b.includes(x));
  if (kindName === 'exacta') {
    if (fin.length < 2) return null;
    return t === 'KEY' ? fin[0] === top[0] && top.slice(1, 3).includes(fin[1]) : sub(fin.slice(0, 2), top.slice(0, 3));
  }
  if (kindName === 'trifecta') {
    if (fin.length < 3) return null;
    if (t === 'KEY') return fin[0] === top[0] && sub(fin.slice(1, 3), top.slice(1, 4));
    return sub(fin.slice(0, 3), top.slice(0, t === 'BOX 4' ? 4 : 3));
  }
  if (fin.length < 4) return null;
  if (t === 'KEY') return fin[0] === top[0] && sub(fin.slice(1, 4), top.slice(1, 5));
  return sub(fin.slice(0, 4), top.slice(0, 4));
}
function gradeRace(snap, fin) {
  const o = snap.order;
  const row = { conf: snap.conf, under: snap.under, win: fin[0] === o[0], itm: fin.slice(0, 3).includes(o[0]) };
  for (const k of ['exacta', 'trifecta', 'superfecta']) {
    const pl = snap.plays[k];
    row[k] = pl.type === 'PASS' || pl.type === 'N/A' ? null : pl.legs ? legsHit(pl.legs, fin) : oldPlayHit(k, pl, o, fin);
    row[k + '_cost'] = row[k] == null ? 0 : pl.cost;
  }
  row.ls = (snap.longshots || []).map((l) => legsHit(l.legs, fin)).filter((x) => x != null);
  row.ls_cost = (snap.longshots || []).reduce((a, l) => a + (l.cost || 0), 0);
  const v = snap.value || { good: [], bad: [] };
  row.good = v.good.length; row.good_w = v.good.filter((p) => p === fin[0]).length; row.good_itm = v.good.filter((p) => fin.slice(0, 3).includes(p)).length;
  row.bad = v.bad.length; row.bad_w = v.bad.filter((p) => p === fin[0]).length; row.bad_itm = v.bad.filter((p) => fin.slice(0, 3).includes(p)).length;
  return row;
}
function gradedRows(st) {
  const rows = [];
  for (const [rn, fin] of Object.entries(st.results || {})) {
    const f = (fin || []).filter((x) => x);
    if (f.length >= 1 && st.snaps && st.snaps[rn]) rows.push({ race: +rn, ...gradeRace(st.snaps[rn], f) });
  }
  return rows.sort((a, b) => a.race - b.race);
}
function allStates() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STATE_PREFIX)) out.push([k.slice(STATE_PREFIX.length), LS.get(k, null)]);
    }
  } catch { /* storage blocked */ }
  return out.filter(([, st]) => st);
}

// ---------------- best / worst highlights ----------------
const HL = {
  life: [(m) => m.life_mark_adj, -1], yr: [(m) => m.yr_mark_adj, -1], avg: [(m) => m.avg_mark, -1],
  open: [(m) => m.open_q, -1], close: [(m) => m.close_q, -1], late: [(m) => m.late_gain, 1], fin: [(m) => m.avg_fin3, -1],
  lw: [(m) => (m.life_starts >= 5 ? m.life_win : null), 1], lt: [(m) => (m.life_starts >= 5 ? m.life_top3 : null), 1],
  yw: [(m) => (m.yr_starts >= 3 ? m.yr_win : null), 1], yt: [(m) => (m.yr_starts >= 3 ? m.yr_top3 : null), 1],
  cls: [(m) => m.cr_avg3, 1],
};
function highlights(r) {
  const out = {};
  const act = (r.active || []).filter((h) => h.m);
  for (const [key, [f, dir]] of Object.entries(HL)) {
    const vals = act.map((h) => [h.pgm, f(h.m)]).filter(([, v]) => v != null && isFinite(v)).map(([p, v]) => [p, Math.round(v * 100) / 100]);
    if (vals.length < 3) continue;
    const nums = vals.map(([, v]) => v);
    const hi = Math.max(...nums), lo = Math.min(...nums);
    if (hi === lo) continue;
    const best = dir > 0 ? hi : lo, worst = dir > 0 ? lo : hi;
    out[key] = { best: new Set(vals.filter(([, v]) => v === best).map(([p]) => p)), worst: new Set(vals.filter(([, v]) => v === worst).map(([p]) => p)) };
  }
  return out;
}
const hlClass = (hl, key, pgm) => (!hl || !hl[key] ? '' : hl[key].best.has(pgm) ? 'best' : hl[key].worst.has(pgm) ? 'worst' : '');
const hv = (cls, html) => (cls ? `<span class="hv ${cls}">${html}</span>` : html);

// ---------------- render: card ----------------
function racePlaysHtml(r) {
  const t = r.trifecta;
  const bits = [`<span class="pill ${kind(t)}">TRI ${t.type === 'N/A' ? 'n/a' : esc(t.type.toLowerCase() + ' ' + t.text)}</span>`];
  for (const p of r.value.good.slice(0, 2)) bits.push(`<span class="pill value">Value #${p} (${esc(horseOf(r, p).ml)})</span>`);
  for (const p of r.value.bad.slice(0, 1)) bits.push(`<span class="pill badv">Bad value #${p} (${esc(horseOf(r, p).ml)})</span>`);
  if (r.longshots.length) bits.push(`<span class="pill">${r.longshots.length} longshot tri${r.longshots.length > 1 ? 's' : ''}</span>`);
  return bits.join('');
}

function renderCard() {
  const c = S.card;
  const best = [...c.races].filter((r) => r.ranked.length > 1).sort((a, b) =>
    (b.confidence - a.confidence) || ((b.ranked[0].score - b.ranked[1].score) - (a.ranked[0].score - a.ranked[1].score))).slice(0, 3);
  const nScr = Object.values(S.st.scratches).reduce((a, b) => a + b.length, 0);
  return `
  <div class="cardhead">
    <div><h1>${esc(c.track)}</h1><div class="sub">${esc(c.date)} · ${c.races.length} races${nScr ? ` · ${nScr} scratched` : ''} · ${weightsBadge()}</div></div>
    <div class="row"><button class="btn small primary" data-act="pdf">Download PDF</button><button class="btn small" data-act="print">Print</button>
      ${S.bets.length ? '<a class="btn small" href="#/picks">Pick 3/4/5 tickets</a>' : ''}<a class="btn small" href="#/results">Enter results</a><button class="btn small" data-act="new">Load another program</button></div>
  </div>
  <div class="bestbets"><b>Best bets:</b> ${best.map((r) => `<a href="#/race/${r.number}"><b>R${r.number}</b> #${r.ranked[0].pgm} ${esc(tc(r.ranked[0].name))}</a> (${r.confidence}/5)`).join(' &nbsp;·&nbsp; ')}</div>
  <div class="races">
    ${c.races.map((r) => {
      const rk = r.ranked;
      if (!rk.length) return '';
      return `<a class="racecard ${r.confidence >= 5 ? 'top' : ''}" href="#/race/${r.number}">
        <div class="rc-head"><div class="rc-num">${r.number}</div>
          <div class="rc-meta"><b>${esc(r.post_time)}</b> · ${esc(tc(r.gait))} · ${money(r.purse)}<br>${rk.length} starters</div>
          <div class="rc-conf"><span class="stars">${stars(r.confidence)}</span> <b>${r.confidence}/5</b><br><span class="stars u">${stars(r.undercard)}</span> <span class="muted">undercard</span></div>
        </div>
        <div class="rc-pick"><b>#${rk[0].pgm} ${esc(tc(rk[0].name))}</b> <span class="muted">(${esc(rk[0].ml)}) · ${Math.round(rk[0].win_prob * 100)}%</span></div>
        <div class="rc-under">Then ${rk.slice(1, 5).map((h) => `#${h.pgm} ${esc(tc(h.name))}`).join(', ')}</div>
        <div class="rc-plays">${racePlaysHtml(r)}</div>
      </a>`;
    }).join('')}
  </div>`;
}

// ---------------- render: race ----------------
function whyHtml(r) {
  const h = r.ranked[0], h2 = r.ranked[1];
  if (!h || !h2) return '';
  const pros = h.pros.slice(0, 2).map((p) => p[0]).join('; ') || 'best overall profile';
  const risk = h.cons.length ? h.cons[0][0] : 'no major red flags';
  const gap = h.score - h2.score;
  const edge = gap >= 10 ? 'clear edge' : gap < 4 ? 'narrow edge' : 'solid edge';
  const e = r.pace.early;
  const pace = e.length === 1 ? `lone speed #${e[0]}` : e.length >= 3 ? `hot — ${e.map((x) => '#' + x).join(', ')} all want the lead`
    : e.length === 2 ? `two early horses (${e.map((x) => '#' + x).join(', ')})` : 'no true early speed';
  return `<b>Why #${h.pgm} ${esc(tc(h.name))}:</b> ${esc(pros)}. <b>Risk:</b> ${esc(risk)}. <b>Edge over #${h2.pgm}:</b> ${edge} (${gap.toFixed(1)} pts). <b>Pace:</b> ${esc(pace)}.`;
}

const pcList = (items, cls) => `<ul class="${cls}">${items.length ? items.map(([t, imp]) => `<li class="${imp >= 3 ? 'b' : ''}">${esc(t)}</li>`).join('') : '<li class="faint none">—</li>'}</ul>`;

function statCells(h, hl) {
  const m = h.m, p = h.pgm, c = (k) => hlClass(hl, k, p);
  const lateTxt = m.late_gain == null ? '—' : (Math.abs(m.late_gain) < 0.05 ? '0.0' : (m.late_gain > 0 ? '+' : '') + m.late_gain.toFixed(1));
  const lp = m.late_pairs.length ? `last ${m.late_pairs[0][0]}→${m.late_pairs[0][1]}` : '';
  const yy = `'${String(S.year).slice(2)}`;
  const wt = (w, t3, kw, kt) => (w == null ? '—' : `${hv(c(kw), pct0(w))}/${hv(c(kt), pct0(t3))}`);
  return [
    ['Life mark', m.life_mark ? hv(c('life'), fmtTime(m.life_mark)) : '—', trk(m.life_mark_trk)],
    [`${yy} mark`, m.yr_mark ? hv(c('yr'), fmtTime(m.yr_mark)) : '—', trk(m.yr_mark_trk)],
    ['Avg mark*', m.avg_mark ? hv(c('avg'), fmtTime(m.avg_mark)) : '—', `${m.clean_n} clean`],
    ['Open ¼*', m.open_q ? hv(c('open'), m.open_q.toFixed(1)) : '—', m.open_pos ? `avg pos ${m.open_pos.toFixed(1)}` : ''],
    ['Close ¼*', m.close_q ? hv(c('close'), m.close_q.toFixed(1)) : '—', m.close_best ? `best ${m.close_best.toFixed(1)}` : ''],
    ['¾→Fin', m.late_gain == null ? '—' : hv(c('late'), lateTxt), lp],
    ['Avg fin L3', m.avg_fin3 ? hv(c('fin'), m.avg_fin3.toFixed(1)) : '—', m.fins3.join('-')],
    ['Life W/T3', wt(m.life_win, m.life_top3, 'lw', 'lt'), `${m.life_starts} starts`],
    [`${yy} W/T3`, wt(m.yr_win, m.yr_top3, 'yw', 'yt'), `${m.yr_starts} starts`],
    ['Class', m.cr_avg3 != null ? hv(c('cls'), Math.round(m.cr_avg3)) : '—', m.cr_avg3 != null ? 'avg CR faced' : ''],
  ];
}

function extraLine(h) {
  const m = h.m, x = [];
  if (h.claim) x.push(`clm ${h.claim}`);
  if (h.equip_note) x.push(h.equip_note.charAt(0) + h.equip_note.slice(1).toLowerCase().replace('lasix', 'Lasix'));
  if (m && m.thrown) x.push(`${m.thrown} of L5 thrown out`);
  if (m && m.ship) x.push(`last raced at ${(m.last_track || '').replace(/[ÁÂ½1]$/, '')}`);
  return x.join(' · ');
}
const valueTag = (h) => (h.value === 'good' ? '<span class="pill value">Good value</span>' : h.value === 'bad' ? '<span class="pill badv">Bad value</span>' : '');

function horseCard(h, r, scr, hl) {
  const cls = scr ? 'scr' : h.rank === 1 ? 'r1' : h.rank <= 3 ? 'r23' : '';
  const proj = scr ? '<span class="pill pass">SCR</span>' : `<div class="h-proj">${h.rank}<small> · ${Math.round(h.win_prob * 100)}%</small></div>`;
  return `<article class="horse ${cls}">
    <div class="h-top">
      <button class="scrbtn ${scr ? 'on' : ''}" data-scr="${h.pgm}" aria-pressed="${scr}">${scr ? 'Scratched' : 'Scratch'}</button>
      <div class="h-pgm">${h.pgm}</div>
      <div style="min-width:0"><div class="h-name">${esc(tc(h.name))} ${scr ? '' : valueTag(h)}</div>
        <div class="h-sub">${esc(tc(h.driver))}${h.drv_w != null ? ` (${h.drv_w}%)` : ''} · ${esc(tc(h.trainer))}${h.trn_w != null ? ` (${h.trn_w}%)` : ''}</div>
        <div class="h-extra">${esc(extraLine(h))}</div></div>
      <div class="h-right">${proj}<div class="h-ml">ML ${esc(h.ml)}${!scr && h.fair_odds != null ? ` · fair ${oddsStr(h.fair_odds)}` : ''}</div></div>
    </div>
    ${scr || !h.m ? '' : `<div class="h-stats">${statCells(h, hl).map(([k, v, s]) => `<div class="st"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}</div>
    <div class="pc">${pcList(h.pros, 'pro')}${pcList(h.cons, 'con')}</div>`}
  </article>`;
}

function horseTable(r, sorted, scrSet, forPrint = false) {
  const hl = highlights(r);
  const yy = String(S.year).slice(2);
  const head = ['Scr', '#', 'Horse / Driver · Trainer', 'ML', 'Proj', 'Life mark', `'${yy} mark`, 'Avg mark*', 'Open ¼*', 'Close ¼*', '¾→Fin', 'Avg fin L3', 'Life W/T3', `'${yy} W/T3`, 'Pros', 'Cons'];
  const rows = sorted.map((h) => {
    const scr = scrSet.has(h.pgm);
    const cls = scr ? 'scr' : h.rank === 1 ? 'r1' : h.rank <= 3 ? 'r23' : '';
    const cells = !scr && h.m ? statCells(h, hl) : null;
    const c = (i) => (cells ? `${cells[i][1]}<span class="s">${cells[i][2]}</span>` : '—');
    const scrCell = forPrint ? `<span class="scrbox"></span>` : `<button class="scrbtn ${scr ? 'on' : ''}" data-scr="${h.pgm}" aria-pressed="${scr}">${scr ? 'SCR' : '✕'}</button>`;
    const vt = scr ? '' : h.value === 'good' ? '<span class="s gv">good value</span>' : h.value === 'bad' ? '<span class="s bv">bad value</span>' : '';
    return `<tr class="${cls}">
      <td>${scrCell}</td><td><b style="font-size:1.15em">${h.pgm}</b></td>
      <td class="l"><span class="h-name"><b>${esc(tc(h.name))}</b></span><span class="s">${esc(tc(h.driver))} · ${esc(tc(h.trainer))}</span><span class="s faint">${esc(extraLine(h))}</span></td>
      <td>${esc(h.ml)}${vt}</td>
      <td>${scr ? 'SCR' : `<b>${h.rank}</b><span class="s">${Math.round(h.win_prob * 100)}%</span>`}</td>
      ${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `<td>${c(i)}</td>`).join('')}
      <td class="pcol">${!scr && h.pros ? pcList(h.pros, 'pro') : ''}</td><td class="pcol">${!scr && h.cons ? pcList(h.cons, 'con') : ''}</td>
    </tr>`;
  }).join('');
  return `<div class="htable-wrap"><table class="ht"><thead><tr>${head.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function sortedHorses(r) {
  const scr = new Set(S.st.scratches[r.number] || []);
  const act = r.horses.filter((h) => !scr.has(h.pgm));
  const out = S.prefs.sort === 'proj' ? [...act].sort((a, b) => a.rank - b.rank) : [...act].sort((a, b) => a.pgm - b.pgm);
  return [...out, ...r.horses.filter((h) => scr.has(h.pgm)).sort((a, b) => a.pgm - b.pgm)];
}

function bannerHtml(r) {
  return `<div class="banner">
    <div class="num"><small>RACE</small><span>${r.number}</span></div>
    <div class="info"><div class="title">${esc(tc(r.gait))} · 1 Mile · ${money(r.purse)}</div>
      <div class="meta">Post ${esc(r.post_time)} · Class rating ${r.cr ?? '—'} · ${r.ranked.length} starters</div>
      <div class="cond">${esc(r.conditions)}</div></div>
    <div class="conf"><div><span class="lbl">WINNER</span></div><div><span class="stars">${stars(r.confidence)}</span><b>${r.confidence}/5</b></div>
      <div><span class="lbl">UNDERCARD 2ND–5TH</span></div><div><span class="stars u">${stars(r.undercard)}</span><b>${r.undercard}/5</b></div></div>
  </div>`;
}
function projHtml(r) {
  const labels = ['WIN', '2ND', '3RD', '4TH', '5TH'];
  return `<div class="proj">${r.ranked.slice(0, 5).map((h, i) => `<div class="p ${i === 0 ? 'win' : i < 3 ? 't3' : ''}">
      <div class="lbl">${labels[i]}</div><div class="nm">#${h.pgm} ${esc(tc(h.name))}</div>
      <div class="od">ML ${esc(h.ml)} · model ${Math.round(h.win_prob * 100)}% (fair ${oddsStr(h.fair_odds)})${h.value === 'good' ? ' · <b class="gv">GOOD VALUE</b>' : h.value === 'bad' ? ' · <b class="bv">BAD VALUE</b>' : ''}</div></div>`).join('')}</div>`;
}

function triTile(r) {
  const t = r.trifecta, ex = r.exacta, su = r.superfecta;
  const one = (x) => (x.type === 'N/A' ? 'not offered' : x.type === 'PASS' ? 'pass' : `${esc(tc(x.type))} ${esc(x.text)} <span class="faint">(${dollars(x.cost)})</span>`);
  if (t.type === 'N/A') return `<div class="bet"><div class="lbl">TRIFECTA</div><div class="call faint">Field too small</div></div>`;
  return `<div class="bet ${kind(t)} main"><div class="lbl">TRIFECTA — ${t.type === 'KEY' ? 'KEY IT' : 'BOX IT'}</div>
    <div class="call">${t.type === 'KEY' ? 'Key' : 'Box'} ${esc(t.text)}</div>
    <div class="det">${esc(t.strength)}</div>
    <div class="det">${t.combos} combos · ${dollars(t.cost)} at ${baseLabel(t.base)} · model hit ~${Math.round(t.hit * 100)}%${t.caution ? ' · <b class="no">low-confidence race — go light</b>' : ''}</div>
    <div class="exsup"><b>Exacta</b> ${one(ex)} &nbsp;·&nbsp; <b>Super</b> ${one(su)}</div></div>`;
}
function valueTile(r) {
  const line = (p, good) => {
    const h = horseOf(r, p);
    return `<li class="${good ? 'g' : 'r'}"><b>#${h.pgm} ${esc(tc(h.name))}</b> ML ${esc(h.ml)} <span class="faint">(${ord(h.ml_rank)} choice)</span> · numbers rank him <b>${ord(h.rank)}</b> · fair ${oddsStr(h.fair_odds)}</li>`;
  };
  const g = r.value.good, b = r.value.bad;
  return `<div class="bet valuebox"><div class="lbl">VALUE vs MORNING LINE</div>
    ${g.length || b.length ? `<ul>${g.map((p) => line(p, true)).join('')}${b.map((p) => line(p, false)).join('')}</ul>
      <div class="det"><span class="gv">Good</span> = longer odds than the numbers say · <span class="bv">Bad</span> = shorter odds than the numbers say</div>`
    : '<div class="det">No big gaps between the numbers and the morning line in this race.</div>'}</div>`;
}
function longTile(r) {
  const L = r.longshots;
  return `<div class="bet longbox"><div class="lbl">LONGSHOT TRIFECTAS</div>
    ${L.length ? `<ul>${L.map((l) => `<li><b>${esc(l.text)}</b> <span class="faint">${l.combos} combo${l.combos > 1 ? 's' : ''} · ${dollars(l.cost)}</span><br><span class="det">${esc(l.label === 'straight' ? 'straight' : l.label)} · model ${pctP(l.hit, 1)} vs ML ${pctP(l.market, l.market < 0.01 ? 2 : 1)}</span></li>`).join('')}</ul>`
    : '<div class="det">No overpriced horses to build longshot tickets around.</div>'}</div>`;
}
function betsHtml(r) {
  return `<div class="bets">${triTile(r)}${valueTile(r)}${longTile(r)}</div>`;
}

function renderRace(n) {
  const r = raceOf(n);
  if (!r) return `<p>Race not found. <a href="#/">Back to the card</a></p>`;
  const scrSet = new Set(S.st.scratches[n] || []);
  const res = S.st.results[n] || [];
  const opts = (sel) => `<option value="">—</option>` + r.horses.filter((h) => !scrSet.has(h.pgm)).map((h) => `<option ${+sel === h.pgm ? 'selected' : ''}>${h.pgm}</option>`).join('');
  const snap = S.st.snaps[n];
  let graded = '';
  if (snap && res.filter(Boolean).length) {
    const g = gradeRace(snap, res.filter(Boolean).map(Number));
    const mark = (v) => (v == null ? '<span class="faint">no play</span>' : v ? '<span class="ok">hit</span>' : '<span class="no">miss</span>');
    const ls = g.ls.length ? ` · Longshots <span class="${g.ls.some(Boolean) ? 'ok' : 'no'}">${g.ls.filter(Boolean).length}/${g.ls.length} hit</span>` : '';
    graded = `<div class="graded">Pick #${snap.order[0]}: ${g.win ? '<span class="ok">won</span>' : g.itm ? '<span class="ok">in the money</span>' : '<span class="no">out</span>'} · Exacta ${mark(g.exacta)} · Trifecta ${mark(g.trifecta)} · Superfecta ${mark(g.superfecta)}${ls}</div>`;
  }
  return `
  <div class="racenav"><a class="btn small" href="#/">← Card</a>
    <div class="tabs">${S.card.races.map((x) => `<a href="#/race/${x.number}" class="${x.number === n ? 'on' : ''}">${x.number}</a>`).join('')}</div></div>
  <div id="raceTop">${raceTopHtml(r)}</div>
  <div class="tunebar"><button class="btn small ${S.tuneOpen ? 'primary' : ''}" data-act="tune" aria-expanded="${S.tuneOpen}">${S.tuneOpen ? 'Hide weights' : 'Tune weights'}</button><span id="wbadge">${weightsBadge()}</span></div>
  ${S.tuneOpen ? tuneHtml(true) : ''}
  <div id="raceBody">${raceBodyHtml(r)}</div>
  <div class="notes">
    <div class="panel"><h3>Notes — Race ${n}</h3><textarea data-notes="${n}" placeholder="Your notes for this race…">${esc(S.st.notes[n] || '')}</textarea></div>
    <div class="panel"><h3>Official order</h3><div class="order">
      ${['1st', '2nd', '3rd', '4th'].map((lbl, i) => `<label>${lbl}<select data-res="${n}" data-pos="${i}">${opts(res[i])}</select></label>`).join('')}
      </div>${graded || '<div class="graded note">Enter the result after the race to grade the picks and plays — or <a href="#/results">paste the whole card\'s results</a>.</div>'}</div>
  </div>
  <div class="racenav" style="margin-top:14px">${n > 1 ? `<a class="btn" href="#/race/${n - 1}">← Race ${n - 1}</a>` : '<span></span>'}${raceOf(n + 1) ? `<a class="btn primary" href="#/race/${n + 1}">Race ${n + 1} →</a>` : ''}</div>`;
}

function raceTopHtml(r) {
  return `${bannerHtml(r)}${projHtml(r)}${betsHtml(r)}<div class="why">${whyHtml(r)}</div>`;
}
function raceBodyHtml(r) {
  const sorted = sortedHorses(r);
  const scrSet = new Set(S.st.scratches[r.number] || []);
  const hl = highlights(r);
  const v = S.prefs.view;
  return `<div class="toolbar">
    <div class="seg" role="group" aria-label="Sort horses"><button data-sort="pgm" class="${S.prefs.sort === 'pgm' ? 'on' : ''}">Program #</button><button data-sort="proj" class="${S.prefs.sort === 'proj' ? 'on' : ''}">Projected</button></div>
    <span class="legend"><span class="hv best">best</span> <span class="hv worst">worst</span> in this race</span>
    <div class="seg" role="group" aria-label="Layout"><button data-view="auto" class="${v === 'auto' ? 'on' : ''}">Auto</button><button data-view="cards" class="${v === 'cards' ? 'on' : ''}">Cards</button><button data-view="table" class="${v === 'table' ? 'on' : ''}">Table</button></div>
  </div>
  <div class="horses hview-cards ${v === 'auto' ? 'auto' : v === 'cards' ? 'force' : 'hide'}">${sorted.map((h) => horseCard(h, r, scrSet.has(h.pgm), hl)).join('')}</div>
  <div class="hview-table ${v === 'auto' ? 'auto' : v === 'table' ? 'force' : 'hide'}">${horseTable(r, sorted, scrSet)}</div>`;
}

// ---------------- multi-race tickets ----------------
const STYLES = { tight: 'Tight', balanced: 'Balanced', wide: 'Wide' };
function ticketFor(b) {
  const ps = S.st.picks[b.id] || {};
  const style = S.prefs.pickStyle;
  const legs = b.races.map((n) => {
    const r = raceOf(n);
    const scr = new Set(S.st.scratches[n] || []);
    let sel = (ps.legs && ps.legs[n]) || null;
    const custom = !!sel;
    sel = (sel || legSuggestion(r, style)).filter((p) => !scr.has(p) && r.horses.some((h) => h.pgm === p));
    if (!sel.length) sel = legSuggestion(r, style);
    const cover = sel.reduce((a, p) => a + (r.ranked.find((h) => h.pgm === p)?.win_prob || 0), 0);
    return { n, r, sel, custom, cover };
  });
  const combos = legs.reduce((a, l) => a * l.sel.length, 1);
  const base = ps.base ?? b.base;
  const hit = legs.reduce((a, l) => a * l.cover, 1);
  const fins = legs.map((l) => (S.st.results[l.n] || [])[0]);
  const graded = fins.every(Boolean) ? legs.every((l, i) => l.sel.includes(+fins[i])) : null;
  return { b, legs, combos, base, cost: combos * base, hit, graded };
}
function ticketLine(t) {
  return t.legs.map((l) => l.sel.join(',')).join(' / ');
}
function renderPicks() {
  if (!S.bets.length) return `<div class="cardhead"><div><h1>Pick 3/4/5 tickets</h1><div class="sub">This program doesn't list any multi-race wagers.</div></div></div>`;
  const style = S.prefs.pickStyle;
  return `<div class="cardhead"><div><h1>Multi-race tickets</h1><div class="sub">${esc(S.card.track)} · ${esc(S.card.date)} · Singles in the strong races, more horses in the weak ones. Tap a horse to add or drop it.</div></div>
    <div class="seg" role="group" aria-label="Ticket style">${Object.entries(STYLES).map(([k, l]) => `<button data-pstyle="${k}" class="${style === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
  ${S.bets.map((b) => {
    const t = ticketFor(b);
    return `<div class="panel ticket">
      <div class="t-head"><h3>${esc(b.name)} · Races ${b.races[0]}–${b.races[b.races.length - 1]}</h3>
        <div class="t-sum"><b>${ticketLine(t)}</b><br>${t.combos} combo${t.combos > 1 ? 's' : ''} × <select data-pbase="${b.id}">${[0.1, 0.2, 0.5, 1, 2].map((x) => `<option value="${x}" ${x === t.base ? 'selected' : ''}>${baseLabel(x)}</option>`).join('')}</select> = <b>${dollars(t.cost)}</b> · model hit ~${pctP(t.hit, t.hit < 0.1 ? 1 : 0)}
        ${t.graded == null ? '' : t.graded ? ' · <span class="ok">HIT</span>' : ' · <span class="no">missed</span>'}</div></div>
      ${t.legs.map((l) => `<div class="leg"><div class="leg-h"><a href="#/race/${l.n}"><b>R${l.n}</b></a> <span class="stars">${stars(l.r.confidence)}</span> <span class="muted">${l.sel.length === 1 ? 'single' : l.sel.length + ' horses'} · covers ${Math.round(l.cover * 100)}%${l.custom ? ' · edited' : ''}</span></div>
        <div class="chips">${l.r.ranked.map((h) => `<button class="chip ${l.sel.includes(h.pgm) ? 'on' : ''} ${h.value === 'good' ? 'gvc' : ''}" data-pick="${b.id}|${l.n}|${h.pgm}" aria-pressed="${l.sel.includes(h.pgm)}">#${h.pgm} <small>${Math.round(h.win_prob * 100)}%</small></button>`).join('')}</div></div>`).join('')}
      <div class="row" style="margin-top:8px"><button class="btn small" data-preset-ticket="${b.id}">Back to suggested</button></div>
    </div>`;
  }).join('')}
  <p class="note">Chips are in projected order with each horse's model win %. Green-outlined chips are good-value horses. Covers = the model's combined win chance for the horses you're using in that leg.</p>`;
}

// ---------------- results paste-in ----------------
function normName(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function parseResults(text, card) {
  const out = {};
  const clean = text.replace(/\r/g, '');
  const valid = (n, arr) => {
    const r = card.races.find((x) => x.number === n);
    if (!r) return null;
    const pg = new Set(r.horses.map((h) => h.pgm));
    const a = arr.map((x) => parseInt(x, 10)).filter((x) => pg.has(x));
    const uniq = a.filter((x, i) => a.indexOf(x) === i);
    return uniq.length >= 2 ? uniq.slice(0, 4) : null;
  };
  // quick lines: "1: 3-8-7-2"
  for (const m of clean.matchAll(/^\s*(?:r(?:ace)?\s*#?\s*)?(\d{1,2})\s*[:.)=]\s*(\d{1,2}(?:\s*[-\/, ]\s*\d{1,2}){1,4})\s*$/gim)) {
    const v = valid(+m[1], m[2].split(/[^\d]+/));
    if (v) out[+m[1]] = { order: v, how: 'typed order' };
  }
  // race blocks
  const marks = [...clean.matchAll(/(?:^|\n|\s)(?:race|r)\s*#?\s*(\d{1,2})\b|(?:^|\n)\s*(\d{1,2})(?:st|nd|rd|th)\s+race\b/gi)];
  for (let i = 0; i < marks.length; i++) {
    const n = +(marks[i][1] || marks[i][2]);
    if (out[n] && out[n].how === 'typed order') continue;
    const block = clean.slice(marks[i].index, i + 1 < marks.length ? marks[i + 1].index : clean.length);
    const r = card.races.find((x) => x.number === n);
    if (!r) continue;
    let got = null;
    const ofm = block.match(/(?:order of finish|official order|finish order|finish)\s*[:\-]?\s*(\d{1,2}(?:\s*[-\/,]\s*\d{1,2}){1,4})/i);
    if (ofm) got = { order: valid(n, ofm[1].split(/[^\d]+/)), how: 'order of finish' };
    if (!got || !got.order) {
      let bestExotic = null;
      for (const m of block.matchAll(/(high\s*5|pentafecta|superfecta|trifecta|exacta)[^\n\d$]*?(\d{1,2}(?:\s*[-\/]\s*\d{1,2}){1,4})/gi)) {
        const v = valid(n, m[2].split(/[^\d]+/));
        if (v && (!bestExotic || v.length > bestExotic.order.length)) bestExotic = { order: v, how: `${m[1].toLowerCase()} payoff` };
      }
      if (bestExotic) got = bestExotic;
    }
    if (!got || !got.order) {
      const rows = [...block.matchAll(/^\s*(\d{1,2})(?:st|nd|rd|th)?[\s.\t]+(\d{1,2})[\s\t]+[A-Za-z]/gm)].map((m) => [+m[1], +m[2]]).filter(([pos]) => pos >= 1 && pos <= 10).sort((a, b) => a[0] - b[0]);
      if (rows.length >= 2 && rows[0][0] === 1) got = { order: valid(n, rows.map(([, p]) => p)), how: 'finish lines' };
    }
    if (!got || !got.order) {
      const nb = normName(block);
      const found = r.horses.map((h) => [h.pgm, nb.indexOf(normName(h.name))]).filter(([, i2]) => i2 >= 0).sort((a, b) => a[1] - b[1]);
      if (found.length >= 3) got = { order: found.slice(0, 4).map(([p]) => p), how: 'horse names (in the order listed)' };
    }
    if (got && got.order) out[n] = got;
  }
  return out;
}
function renderResults() {
  const p = S.pasted;
  return `<div class="cardhead"><div><h1>Enter results</h1><div class="sub">${esc(S.card.track)} · ${esc(S.card.date)} · Paste results from the track's site, USTA, a chart or a text, then check and apply.</div></div></div>
  <div class="panel"><h3>Paste results</h3>
    <textarea id="pasteBox" placeholder="Paste anything with the results, e.g. the results page text — or type one race per line like:&#10;1: 3-8-7-2&#10;2: 4-3-5-1">${esc(p ? p.text : '')}</textarea>
    <div class="row" style="margin-top:8px"><button class="btn primary" data-act="parse-results">Read results</button><span class="note">Picks up "order of finish", trifecta / superfecta payoff lines, finish lines or horse names in finishing order.</span></div>
  </div>
  ${p ? `<div class="panel" style="margin-top:12px"><h3>Check before applying</h3>
    ${Object.keys(p.found).length ? `<table class="rec"><thead><tr><th>Use</th><th>Race</th><th>Order found</th><th>Read from</th><th>Already entered</th></tr></thead><tbody>
      ${S.card.races.filter((r) => p.found[r.number]).map((r) => { const f = p.found[r.number]; const cur = (S.st.results[r.number] || []).filter(Boolean);
        return `<tr><td><input type="checkbox" data-pr="${r.number}" checked aria-label="Use race ${r.number}"></td><td><b>${r.number}</b></td>
        <td>${f.order.map((x) => `#${x} ${esc(tc(horseOf(r, x)?.name || ''))}`).join(' → ')}</td><td class="muted">${esc(f.how)}</td><td class="muted">${cur.length ? cur.join('-') : '—'}</td></tr>`; }).join('')}
      </tbody></table><div class="row" style="margin-top:8px"><button class="btn primary" data-act="apply-results">Apply checked results</button></div>`
    : '<p class="note">Couldn\'t find any finishing orders in that text. Try including the race numbers, or type them as "1: 3-8-7-2".</p>'}</div>` : ''}`;
}
function applyResult(n, order) {
  const r = raceOf(n);
  if (!r) return;
  S.st.results[n] = [0, 1, 2, 3].map((i) => order[i] ?? null);
  S.st.snaps[n] = snapshot(r);
}

// ---------------- render: record ----------------
function summarize(rows) {
  const by = {};
  for (let c = 5; c >= 1; c--) {
    const g = rows.filter((x) => x.conf === c);
    if (g.length) by[c] = { n: g.length, w: g.filter((x) => x.win).length, itm: g.filter((x) => x.itm).length };
  }
  const plays = {};
  for (const k of ['exacta', 'trifecta', 'superfecta']) {
    const g = rows.filter((x) => x[k] != null);
    plays[k] = { n: g.length, hit: g.filter((x) => x[k]).length, cost: g.reduce((a, x) => a + x[k + '_cost'], 0) };
  }
  plays.longshots = { n: rows.reduce((a, x) => a + x.ls.length, 0), hit: rows.reduce((a, x) => a + x.ls.filter(Boolean).length, 0), cost: rows.reduce((a, x) => a + (x.ls.length ? x.ls_cost : 0), 0) };
  const val = {
    good: { n: rows.reduce((a, x) => a + (x.good || 0), 0), w: rows.reduce((a, x) => a + (x.good_w || 0), 0), itm: rows.reduce((a, x) => a + (x.good_itm || 0), 0) },
    bad: { n: rows.reduce((a, x) => a + (x.bad || 0), 0), w: rows.reduce((a, x) => a + (x.bad_w || 0), 0), itm: rows.reduce((a, x) => a + (x.bad_itm || 0), 0) },
  };
  return { by, plays, val, n: rows.length, w: rows.filter((x) => x.win).length };
}
function recordTables(sum) {
  const conf = Object.entries(sum.by).sort((a, b) => b[0] - a[0]).map(([c, v]) => `<tr><td><span class="stars">${stars(+c)}</span> ${c}/5</td><td>${v.w}/${v.n}</td><td>${Math.round((100 * v.w) / v.n)}%</td><td>${v.itm}/${v.n}</td></tr>`).join('');
  const label = { exacta: 'Exacta', trifecta: 'Trifecta', superfecta: 'Superfecta', longshots: 'Longshot tris' };
  const plays = Object.entries(sum.plays).map(([k, v]) => `<tr><td>${label[k]}</td><td>${v.hit}/${v.n}</td><td>${v.n ? Math.round((100 * v.hit) / v.n) + '%' : '—'}</td><td>${dollars(v.cost)}</td></tr>`).join('');
  const vr = (lbl, v, cls) => `<tr><td><span class="${cls}">${lbl}</span></td><td>${v.n}</td><td>${v.w} (${v.n ? Math.round((100 * v.w) / v.n) : 0}%)</td><td>${v.itm} (${v.n ? Math.round((100 * v.itm) / v.n) : 0}%)</td></tr>`;
  return `<div class="grid2">
    <div class="panel"><h3>Winners by confidence</h3><table class="rec"><thead><tr><th>Confidence</th><th>Won</th><th>Win %</th><th>In the money</th></tr></thead><tbody>${conf || '<tr><td colspan="4" class="muted">No graded races yet</td></tr>'}</tbody></table></div>
    <div class="panel"><h3>Plays</h3><table class="rec"><thead><tr><th>Bet</th><th>Hit</th><th>Hit %</th><th>Wagered</th></tr></thead><tbody>${plays}</tbody></table>
      <p class="note">Wagered is at the program's base amount. Payouts aren't tracked.</p></div>
    <div class="panel"><h3>Value horses</h3><table class="rec"><thead><tr><th>Flag</th><th>Horses</th><th>Won</th><th>In the money</th></tr></thead><tbody>${vr('Good value', sum.val.good, 'gv')}${vr('Bad value', sum.val.bad, 'bv')}</tbody></table>
      <p class="note">If good-value horses win more than their morning lines suggest, the value calls are working.</p></div></div>`;
}
function renderRecord() {
  const cur = S.key ? gradedRows(S.st) : [];
  const cards = LS.get(CARDS_KEY, {});
  const all = [], per = [];
  for (const [k, st] of allStates()) {
    const rows = gradedRows(st);
    if (rows.length) { all.push(...rows); per.push([cards[k] || { track: k.split('|')[0], date: k.split('|')[1] || '' }, rows, st]); }
  }
  const tickets = S.key ? S.bets.map(ticketFor).filter((t) => t.graded != null) : [];
  return `
  <div class="cardhead"><div><h1>Record</h1><div class="sub">Graded from the official orders you enter. Kept in this browser.</div></div>
    <div class="row">${S.key ? '<a class="btn small primary" href="#/results">Enter results</a>' : ''}<button class="btn small" data-act="export">Export record</button><label class="btn small">Import<input type="file" accept=".json,application/json" data-act="import" hidden></label></div></div>
  ${S.key ? `<h2 class="section">${esc(S.card.track)} · ${esc(S.card.date)} — ${cur.length} graded</h2>${recordTables(summarize(cur))}
    ${tickets.length ? `<div class="panel" style="margin-top:12px"><h3>Multi-race tickets</h3><table class="rec"><thead><tr><th>Ticket</th><th>Used</th><th>Cost</th><th>Result</th></tr></thead><tbody>${tickets.map((t) => `<tr><td>${esc(t.b.name)} R${t.b.races[0]}–${t.b.races[t.b.races.length - 1]}</td><td>${ticketLine(t)}</td><td>${dollars(t.cost)}</td><td>${t.graded ? '<span class="ok">hit</span>' : '<span class="no">miss</span>'}</td></tr>`).join('')}</tbody></table></div>` : ''}` : ''}
  <h2 class="section">All cards — ${all.length} graded races</h2>${recordTables(summarize(all))}
  ${per.length ? `<div class="panel" style="margin-top:12px"><h3>Cards</h3><table class="rec"><thead><tr><th>Card</th><th>Graded</th><th>Winners</th></tr></thead><tbody>${per.map(([v, rows]) => `<tr><td>${esc(v.track)} · ${esc(v.date)}</td><td>${rows.length}</td><td>${rows.filter((x) => x.win).length}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

// ---------------- weight suggestions ----------------
const MIN_RACES = 30, GOOD_RACES = 100;
function trainingRows() {
  const rows = [];
  for (const [, st] of allStates()) {
    for (const [rn, fin] of Object.entries(st.results || {})) {
      const snap = st.snaps && st.snaps[rn];
      const w = (fin || []).find(Boolean);
      if (!snap || !snap.feat || !w || !snap.feat.some(([p]) => p === w)) continue;
      rows.push({ feat: snap.feat, win: w });
    }
  }
  return rows;
}
function evalMult(rows, mult) {
  let ll = 0, hits = 0;
  for (const r of rows) {
    let best = -Infinity, bestP = null, sw = 0;
    const sc = r.feat.map(([p, f]) => { const s = linearScore(f, mult) / 22; if (s > best) { best = s; bestP = p; } if (p === r.win) sw = s; return s; });
    const lse = best + Math.log(sc.reduce((a, s) => a + Math.exp(s - best), 0));
    ll += sw - lse;
    if (bestP === r.win) hits++;
  }
  return { ll: ll / rows.length, hits };
}
function fitMult(rows, start) {
  const grid = [0, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
  const pen = (mm) => 0.008 * FACTORS.reduce((a, f) => a + ((mm[f.key] ?? 1) - 1) ** 2, 0);
  let m = { ...start };
  let best = evalMult(rows, m).ll - pen(m);
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const f of FACTORS) {
      for (const g of grid) {
        if (g === m[f.key]) continue;
        const trial = { ...m, [f.key]: g };
        const v = evalMult(rows, trial).ll - pen(trial);
        if (v > best + 1e-9) { best = v; m = trial; moved = true; }
      }
    }
    if (!moved) break;
  }
  return m;
}
function runSuggestion() {
  const rows = trainingRows();
  if (rows.length < MIN_RACES) return { n: rows.length };
  const folds = 5;
  let hitsSug = 0, hitsCur = 0, hitsNorm = 0, llSug = 0, llCur = 0;
  for (let f = 0; f < folds; f++) {
    const train = rows.filter((_, i) => i % folds !== f), test = rows.filter((_, i) => i % folds === f);
    const mf = fitMult(train, DEFAULT_MULT);
    const es = evalMult(test, mf), ec = evalMult(test, S.mult);
    hitsSug += es.hits; hitsCur += ec.hits; hitsNorm += evalMult(test, DEFAULT_MULT).hits;
    llSug += es.ll * test.length; llCur += ec.ll * test.length;
  }
  const final = fitMult(rows, DEFAULT_MULT);
  return { n: rows.length, final, hitsSug, hitsCur, hitsNorm, llGain: (llSug - llCur) / rows.length, ran: Date.now() };
}
function suggestionHtml() {
  const n = trainingRows().length;
  const s = S.suggestion;
  if (n < MIN_RACES) {
    return `<div class="panel"><h3>Suggested weights from your record</h3>
      <div class="meter"><span style="width:${Math.min(100, (100 * n) / GOOD_RACES)}%"></span></div>
      <p class="note">${n} graded race${n === 1 ? '' : 's'} so far. After ${MIN_RACES} the site starts testing which weight mix would have picked the most winners; ${GOOD_RACES}+ gives a much more trustworthy read. Enter results on the race pages or <a href="#/results">paste them in</a>.</p></div>`;
  }
  let body = `<p class="note">${n} graded races available${n < GOOD_RACES ? ` — an early read; ${GOOD_RACES}+ is more reliable` : ''}.</p><div class="row"><button class="btn primary" data-act="suggest">${s ? 'Run again' : 'Find my best weights'}</button></div>`;
  if (s && s.final) {
    const diff = customList(s.final);
    // only recommend when it picks clearly more winners on unseen races AND rates the real winners higher overall
    const better = s.hitsSug >= s.hitsCur + Math.max(3, Math.round(s.n * 0.05)) && s.llGain > 0.01;
    body += `<div class="suggest">
      <p><b>Tested on races it hadn't seen:</b> suggested mix picked <b>${s.hitsSug}</b> winners of ${s.n} · your current weights <b>${s.hitsCur}</b> · normal <b>${s.hitsNorm}</b>.</p>
      <p>${diff.length ? 'Suggested: ' + diff.map(([l, x]) => `<span class="pill ${x > 1 ? 'value' : 'badv'}">${esc(l)} ${multText(x)}</span>`).join(' ') : 'Suggested: normal weights.'}</p>
      ${better ? '<button class="btn primary" data-act="apply-suggest">Use suggested weights</button>' : '<p class="note">The suggested mix didn\'t clearly beat your current weights on races it hadn\'t seen, so no change is recommended yet.</p>'}</div>`;
  }
  return `<div class="panel"><h3>Suggested weights from your record</h3>${body}</div>`;
}

// ---------------- render: settings ----------------
function methodHtml() {
  const wt = Object.entries(DEFAULT_WEIGHTS).map(([k, v]) => `${WEIGHT_LABELS[k].toLowerCase()} ${v}`).join(', ');
  return `<div class="panel method"><h3>How the numbers are built</h3>
  <p><b>Mile-adjusted times (*)</b>: every time is converted to a mile-track equivalent (half-mile −2.0s, ⅝ −1.0s, ⅞ −0.4s; quarters get ¼ of that), then corrected for the program's track variant (0.2s per point, capped at ±1.6s), which also covers off tracks.</p>
  <p><b>Avg mark</b>: average final time over the last 5 starts, throwing out breaks, parked-out trips (3-wide at any call or first-over at 3+ calls), qualifiers and DNFs — only races from the last 120 days when there are any.</p>
  <p><b>Open ¼</b>: estimated time at the first quarter (leader's quarter + 0.2s per length behind) and average position there. <b>Close ¼</b>: the horse's own last quarter. <b>¾→Fin</b>: average spots gained or lost from the 3/4 call to the wire. <b>Avg fin L3</b>: average finish over the last 3 real starts.</p>
  <p><b>Green / red</b>: the best and worst number in the race for each column (marks compared mile-adjusted; win % needs 5+ lifetime or 3+ this-year starts).</p>
  <p><b>Class</b>: average class rating of the last 3 races versus today's, plus a circuit adjustment for shippers (Yonkers, the Meadowlands and Mohawk tougher; Vernon, Tioga, fairs softer).</p>
  <p><b>Added points</b>: lone speed +${ADJ.lone_speed}, closer with a hot pace +${ADJ.closer_setup}, driver upgrade +${ADJ.driver_up}/+${ADJ.driver_up_big}, tough trip that still finished close +${ADJ.tough_trip} each (max +${ADJ.tough_trip_cap}); speed duel ${ADJ.speed_duel}, driver downgrade ${ADJ.driver_down}. Penalties for breaks, layoffs, stale form and thin data.</p>
  <p><b>Winner confidence</b> blends the top pick's points margin with data quality. <b>Undercard</b> rates how often the projected 2nd–5th finish within one spot of projection in 40,000 simulated races.</p>
  <p><b>Trifecta call</b>: KEY the top pick over the next three when he stands alone (4/5+ confidence and 30%+ to win, or 28%+ and at least 1.8× the second choice); otherwise BOX the top three. Exacta follows the same call; superfecta keys over four when the undercard is 3/5+, boxes four when it's 4/5+, else passes.</p>
  <p><b>Value</b>: <span class="gv">good value</span> = the numbers rate a horse at least 2 spots better than the morning line does, at 4/1 or higher. <span class="bv">Bad value</span> = one of the morning line's top 3 choices the numbers rate at least 2 spots worse. <b>Longshot trifectas</b> are built around the good-value horses: the tickets the model gives a real chance that the morning line prices much lower (model % vs ML %).</p>
  <p><b>Multi-race tickets</b> single a horse when he's 5/5 and 35%+ (or clears the style's coverage alone) and otherwise add horses in projected order until the leg covers 45% (tight), 60% (balanced) or 75% (wide) of the model's win chance.</p>
  <p><b>Opening speed</b> combines average position at the first quarter with the estimated opening-quarter time. <b>Season / lifetime mark</b> uses this year's mark, mile-adjusted (the lifetime mark, slightly discounted, if there's none this year).</p>
  <p><b>Default weights</b>: ${wt}. Your settings multiply these (2× doubles a weight, Off sets it to zero); the race-shape bonuses and penalties scale the same way. <b>Bold</b> pros and cons are the race-deciding ones.</p></div>`;
}
function renderSettings() {
  return `<div class="cardhead"><div><h1>Settings</h1><div class="sub">Put more or less weight on what you trust. Every race re-ranks with your settings, and they stay in this browser — a friend's phone keeps their own. ${weightsBadge()}</div></div>
    <div class="row"><button class="btn small" data-act="reset-weights">Back to normal</button></div></div>
  ${tuneHtml()}
  <div class="panel" style="margin-top:12px"><h3>Share your settings</h3>
    <div class="row"><label class="note" for="shareName">Your name (optional, shown to whoever opens the link)</label></div>
    <div class="row"><input id="shareName" class="txt" maxlength="24" value="${esc(S.prefs.shareName)}" placeholder="e.g. Marshall"><button class="btn primary" data-act="share">Copy share link</button></div>
    <p class="note" id="shareOut">Friends who open the link get asked whether to use your weights. Their own settings stay put unless they say yes.</p></div>
  <div style="margin-top:12px">${suggestionHtml()}</div>
  <div style="margin-top:12px">${methodHtml()}</div>`;
}

// ---------------- share links ----------------
function shareUrl() {
  const w = Object.entries(S.mult).filter(([, v]) => v !== 1).map(([k, v]) => `${k}:${v}`).join(',');
  const q = new URLSearchParams();
  q.set('w', w || 'normal');
  if (S.prefs.shareName) q.set('n', S.prefs.shareName);
  return `${location.origin}${location.pathname}?${q.toString()}`;
}
async function shareSettings() {
  const url = shareUrl();
  const title = `${S.prefs.shareName ? S.prefs.shareName + "'s" : 'My'} Harness Handicapper weights`;
  try {
    if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) { await navigator.share({ title, text: weightsText(), url }); return; }
  } catch { /* user closed the share sheet */ }
  let ok = false;
  try { await navigator.clipboard.writeText(url); ok = true; } catch { /* clipboard blocked */ }
  const el = $('#shareOut');
  if (el) el.innerHTML = `${ok ? 'Copied! ' : ''}<a href="${esc(url)}">${esc(url)}</a>`;
  else alert((ok ? 'Link copied:\n' : 'Share this link:\n') + url);
}
function readSharedFromUrl() {
  const q = new URLSearchParams(location.search);
  const w = q.get('w');
  if (!w) return;
  const mult = { ...DEFAULT_MULT };
  if (w !== 'normal') {
    for (const part of w.split(',')) {
      const [k, v] = part.split(':');
      const x = parseFloat(v);
      if (k in DEFAULT_MULT && isFinite(x)) mult[k] = Math.max(0, Math.min(3, Math.round(x * 4) / 4));
    }
  }
  S.shared = { mult, name: (q.get('n') || '').slice(0, 24) };
}
function clearSharedUrl() {
  S.shared = null;
  try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* ignore */ }
}
function sharedBanner() {
  if (!S.shared) return '';
  const who = S.shared.name ? `${esc(S.shared.name)}'s` : 'Shared';
  return `<div class="sharebar"><div><b>${who} weights:</b> ${esc(weightsText(S.shared.mult))}</div>
    <div class="row"><button class="btn small primary" data-act="use-shared">Use these</button><button class="btn small" data-act="dismiss-shared">Keep mine</button></div></div>`;
}

// ---------------- print / PDF ----------------
function buildPrint() {
  const c = S.card;
  const costs = { exacta: 0, trifecta: 0, superfecta: 0, longshots: 0 };
  for (const r of c.races) {
    for (const k of ['exacta', 'trifecta', 'superfecta']) costs[k] += r[k].cost || 0;
    costs.longshots += r.longshots.reduce((a, l) => a + l.cost, 0);
  }
  const tickets = S.bets.map(ticketFor);
  const tktCost = tickets.reduce((a, t) => a + t.cost, 0);
  const best = [...c.races].filter((r) => r.ranked.length > 1).sort((a, b) => (b.confidence - a.confidence) || ((b.ranked[0].score - b.ranked[1].score) - (a.ranked[0].score - a.ranked[1].score))).slice(0, 3);
  const nScr = Object.values(S.st.scratches).reduce((a, b) => a + b.length, 0);
  const play = (t) => (t.type === 'PASS' || t.type === 'N/A' ? `<span class="faint">${t.type === 'PASS' ? 'pass' : 'n/a'}</span>` : `${esc(tc(t.type))} ${esc(t.text)}`);
  const vlist = (r, k) => r.value[k].map((p) => `#${p} (${esc(horseOf(r, p).ml)})`).join(', ') || '<span class="faint">—</span>';
  const summary = `<section class="pp cover"><h1>Card summary — ${esc(c.track)} <span class="muted" style="font-size:11pt">${esc(c.date)}</span></h1>
    <p style="margin:4px 0 0"><b>Best bets:</b> ${best.map((r) => `R${r.number} #${r.ranked[0].pgm} ${esc(tc(r.ranked[0].name))} (${r.confidence}/5)`).join(' · ')}</p>
    <p style="margin:2px 0 0"><b>All plays:</b> trifecta ${dollars(costs.trifecta)} · exacta ${dollars(costs.exacta)} · superfecta ${dollars(costs.superfecta)} · longshot tris ${dollars(costs.longshots)}${tickets.length ? ` · multi-race ${dollars(tktCost)}` : ''}</p>
    <p class="muted" style="margin:2px 0 0">${esc(weightsText())}${nScr ? ` · ${nScr} scratch${nScr > 1 ? 'es' : ''} applied` : ''}</p>
    <table><thead><tr><th>Race</th><th>Post</th><th>Win / Under</th><th>Projected 1-2-3</th><th>Trifecta</th><th>Exacta · Super</th><th>Good value</th><th>Bad value</th><th>Top longshot tri</th></tr></thead><tbody>
    ${c.races.map((r) => { const rk = r.ranked;
      return `<tr class="${r.confidence >= 5 ? 'hi' : ''}"><td><b>${r.number}</b></td><td>${esc(r.post_time)}</td>
      <td><span class="stars">${stars(r.confidence)}</span> ${r.confidence}/5<br><span class="stars u">${stars(r.undercard)}</span> ${r.undercard}/5</td>
      <td><b>#${rk[0].pgm} ${esc(tc(rk[0].name))}</b><br>#${rk[1].pgm} ${esc(tc(rk[1].name))}${rk[2] ? `, #${rk[2].pgm} ${esc(tc(rk[2].name))}` : ''}</td>
      <td>${play(r.trifecta)}</td><td>${play(r.exacta)}<br>${play(r.superfecta)}</td>
      <td class="gv">${vlist(r, 'good')}</td><td class="bv">${vlist(r, 'bad')}</td>
      <td>${r.longshots[0] ? esc(r.longshots[0].text) : '<span class="faint">—</span>'}</td></tr>`; }).join('')}
    </tbody></table>
    ${tickets.length ? `<h2 style="font-size:10pt;margin:8px 0 2px">Multi-race tickets (${STYLES[S.prefs.pickStyle].toLowerCase()})</h2><table><tbody>${tickets.map((t) => `<tr><td><b>${esc(t.b.name)}</b> R${t.b.races[0]}–${t.b.races[t.b.races.length - 1]}</td><td>${ticketLine(t)}</td><td>${t.combos} × ${baseLabel(t.base)} = <b>${dollars(t.cost)}</b></td><td>model hit ~${pctP(t.hit, t.hit < 0.1 ? 1 : 0)}</td></tr>`).join('')}</tbody></table>` : ''}
    <p class="muted" style="margin-top:6px">Model estimates from the program — check scratches and changes before you bet.</p></section>`;
  const races = c.races.map((r) => {
    const scrSet = new Set(S.st.scratches[r.number] || []);
    const sorted = [...r.horses].sort((a, b) => a.pgm - b.pgm);
    const res = S.st.results[r.number] || [];
    return `<section class="pp">${bannerHtml(r)}${projHtml(r)}${betsHtml(r)}<div class="why">${whyHtml(r)}</div>
      ${horseTable(r, sorted, scrSet, true)}
      <div class="pnotes"><span class="ord">OFFICIAL ORDER ${['1st', '2nd', '3rd', '4th'].map((l, i) => `${l}<span>${res[i] || ''}</span>`).join('')}</span>NOTES — RACE ${r.number} <span class="faint">· green = best in race, red = worst</span><br>${esc(S.st.notes[r.number] || '')}</div></section>`;
  }).join('');
  const root = $('#print');
  root.innerHTML = races + summary;
  const maxH = 7.8 * 96;
  for (const pg of root.querySelectorAll('.pp')) {
    pg.style.zoom = '';
    const h = pg.scrollHeight;
    if (h > maxH) pg.style.zoom = String(Math.max(0.55, (maxH / h) * 0.99));
  }
}

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(el);
  });
}
async function downloadPdf() {
  if (!S.key || S._pdfBusy) return;
  S._pdfBusy = true;
  const ov = document.createElement('div');
  ov.className = 'overlay'; ov.innerHTML = '<div class="overlay-box"><b>Building your PDF…</b><div id="pdfProg" class="note">Getting ready</div></div>';
  document.body.appendChild(ov);
  const root = $('#print');
  try {
    if (S.dirty) { rescoreAll(); S.dirty = false; }
    await Promise.all([loadScript('vendor/html2canvas.min.js'), loadScript('vendor/jspdf.umd.min.js')]);
    buildPrint();
    root.classList.add('capture');
    const pages = [...root.querySelectorAll('.pp')];
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'in', format: 'letter', compress: true });
    const W = 11, H = 8.5, M = 0.3;
    for (let i = 0; i < pages.length; i++) {
      $('#pdfProg').textContent = `Page ${i + 1} of ${pages.length}`;
      const pg = pages[i];
      pg.style.zoom = '';
      const canvas = await window.html2canvas(pg, { scale: 1.7, backgroundColor: '#ffffff', logging: false, windowWidth: pg.scrollWidth });
      const img = canvas.toDataURL('image/jpeg', 0.8);
      const ratio = canvas.width / canvas.height;
      let w = W - 2 * M, h = w / ratio;
      if (h > H - 2 * M) { h = H - 2 * M; w = h * ratio; }
      if (i) doc.addPage('letter', 'landscape');
      doc.addImage(img, 'JPEG', (W - w) / 2, M, w, h, undefined, 'FAST');
      canvas.width = canvas.height = 0;
    }
    const name = `${(S.card.track || 'card').replace(/\W+/g, '-')}-${(S.card.date || '').replace(/^\w+, /, '').replace(/\W+/g, '-')}.pdf`.replace(/-+/g, '-');
    doc.save(name);
  } catch (e) {
    console.error(e);
    alert('Could not build the PDF: ' + (e.message || e) + '. You can still use Print → Save as PDF.');
  } finally {
    root.classList.remove('capture');
    ov.remove();
    S._pdfBusy = false;
  }
}

// ---------------- router ----------------
function render() {
  const hash = location.hash || '#/';
  const upload = $('#upload'), view = $('#view'), nav = $('#topnav');
  nav.hidden = !S.key;
  for (const a of nav.querySelectorAll('a')) a.classList.remove('on');
  const picksLink = nav.querySelector('[data-nav="picks"]');
  if (picksLink) picksLink.hidden = !S.bets.length;
  const route = hash.replace(/^#\/?/, '');
  const show = (html, navKey) => {
    upload.hidden = true; view.hidden = false;
    view.innerHTML = sharedBanner() + html;
    if (navKey) nav.querySelector(`[data-nav="${navKey}"]`)?.classList.add('on');
  };
  if (route === 'settings') return show(renderSettings(), 'settings');
  if (route === 'record') return show(renderRecord(), 'record');
  if (!S.key) {
    upload.hidden = false; view.hidden = !S.shared; view.innerHTML = sharedBanner();
    renderRecent(); return;
  }
  if (route === 'picks') return show(renderPicks(), 'picks');
  if (route === 'results') return show(renderResults(), 'record');
  const m = route.match(/^race\/(\d+)/);
  if (m) return show(renderRace(+m[1]));
  show(renderCard(), 'card');
}

function renderRecent() {
  const cards = LS.get(CARDS_KEY, {});
  const keys = Object.keys(cards).filter((k) => cards[k].card && cards[k].card.races && cards[k].card.races.length).sort((a, b) => cards[b].savedAt - cards[a].savedAt);
  $('#recent').innerHTML = keys.length ? `<div class="note">Recent programs on this device</div>` +
    keys.map((k) => `<button class="btn" data-open="${esc(k)}">${esc(cards[k].track)} · ${esc(cards[k].date)}</button>`).join('') : '';
}

// ---------------- events ----------------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-scr],[data-sort],[data-view],[data-act],[data-open],[data-preset],[data-pick],[data-pstyle],[data-preset-ticket]');
  if (!t) return;
  const act = t.dataset.act;
  if (t.dataset.scr) {
    const n = curRace();
    const pgm = +t.dataset.scr;
    const list = new Set(S.st.scratches[n] || []);
    if (list.has(pgm)) list.delete(pgm); else list.add(pgm);
    const r = raceOf(n);
    if (r.horses.length - list.size < 2) { alert('A race needs at least two starters.'); return; }
    S.st.scratches[n] = [...list];
    scoreOne(r);
    if ((S.st.results[n] || []).some(Boolean)) S.st.snaps[n] = snapshot(r);
    saveState(); render();
  } else if (t.dataset.sort) { S.prefs.sort = t.dataset.sort; LS.set(PREF_KEY, S.prefs); render(); }
  else if (t.dataset.view) { S.prefs.view = t.dataset.view; LS.set(PREF_KEY, S.prefs); render(); }
  else if (t.dataset.pstyle) { S.prefs.pickStyle = t.dataset.pstyle; LS.set(PREF_KEY, S.prefs); render(); }
  else if (t.dataset.pick) {
    const [id, ns, ps] = t.dataset.pick.split('|');
    const b = S.bets.find((x) => x.id === id);
    const tk = ticketFor(b);
    const leg = tk.legs.find((l) => l.n === +ns);
    let sel = [...leg.sel];
    const p = +ps;
    if (sel.includes(p)) { if (sel.length === 1) return; sel = sel.filter((x) => x !== p); } else sel.push(p);
    const st = S.st.picks[id] = S.st.picks[id] || {};
    st.legs = st.legs || {};
    st.legs[ns] = sel;
    saveState(); render();
  } else if (t.dataset.presetTicket) {
    const st = S.st.picks[t.dataset.presetTicket];
    if (st) delete st.legs;
    saveState(); render();
  } else if (t.dataset.open) {
    const cards = LS.get(CARDS_KEY, {});
    const v = cards[t.dataset.open];
    if (v) { openCard(t.dataset.open, v.card); location.hash = '#/'; render(); }
  } else if (act === 'new') {
    S.key = null; location.hash = '#/'; render(); $('#file').value = ''; $('#file').click();
  } else if (act === 'reset-weights') {
    applyMult({ ...DEFAULT_MULT });
  } else if (t.dataset.preset) {
    applyMult({ ...DEFAULT_MULT, ...PRESETS[t.dataset.preset].mult });
  } else if (act === 'tune') {
    S.tuneOpen = !S.tuneOpen; render();
  } else if (act === 'pdf') {
    downloadPdf();
  } else if (act === 'print') {
    buildPrint(); window.print();
  } else if (act === 'share') {
    const nm = $('#shareName');
    if (nm) { S.prefs.shareName = nm.value.trim().slice(0, 24); LS.set(PREF_KEY, S.prefs); }
    shareSettings();
  } else if (act === 'use-shared') {
    const m = S.shared.mult; clearSharedUrl(); applyMult(m);
  } else if (act === 'dismiss-shared') {
    clearSharedUrl(); render();
  } else if (act === 'suggest') {
    t.disabled = true; t.textContent = 'Testing weight mixes…';
    setTimeout(() => { S.suggestion = runSuggestion(); render(); }, 30);
  } else if (act === 'apply-suggest') {
    if (S.suggestion && S.suggestion.final) applyMult({ ...S.suggestion.final });
  } else if (act === 'parse-results') {
    const text = $('#pasteBox').value;
    S.pasted = { text, found: parseResults(text, S.card) };
    render();
  } else if (act === 'apply-results') {
    const boxes = [...document.querySelectorAll('[data-pr]')];
    let nApplied = 0;
    for (const b of boxes) if (b.checked) { applyResult(+b.dataset.pr, S.pasted.found[+b.dataset.pr].order); nApplied++; }
    saveState(); S.pasted = null; location.hash = '#/record'; render();
    if (nApplied) setTimeout(() => alert(`Applied results for ${nApplied} race${nApplied > 1 ? 's' : ''}.`), 50);
  } else if (act === 'export') {
    const cards = LS.get(CARDS_KEY, {});
    const out = { exported: new Date().toISOString(), cards: {} };
    for (const [k, st] of allStates()) out.cards[k] = { track: cards[k]?.track || k.split('|')[0], date: cards[k]?.date || k.split('|')[1] || '', state: st };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
    a.download = 'harness-record.json'; a.click();
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'file') return loadFile(t.files[0]);
  if (t.dataset.res) {
    const n = +t.dataset.res;
    const arr = [...(S.st.results[n] || [null, null, null, null])];
    arr[+t.dataset.pos] = t.value ? +t.value : null;
    S.st.results[n] = arr;
    if (arr.some(Boolean)) S.st.snaps[n] = snapshot(raceOf(n)); else delete S.st.snaps[n];
    saveState(); render();
  }
  if (t.dataset.pbase) {
    const st = S.st.picks[t.dataset.pbase] = S.st.picks[t.dataset.pbase] || {};
    st.base = +t.value; saveState(); render();
  }
  if (t.dataset.act === 'import' && t.files[0]) {
    try {
      const data = JSON.parse(await t.files[0].text());
      for (const [k, v] of Object.entries(data.cards || {})) {
        const cur = LS.get(stateKey(k), null);
        LS.set(stateKey(k), cur ? { ...v.state, ...cur, results: { ...v.state.results, ...cur.results }, snaps: { ...v.state.snaps, ...cur.snaps } } : v.state);
      }
      if (S.key) S.st = { ...S.st, ...LS.get(stateKey(S.key), {}) };
      render();
    } catch { alert("That file isn't a Harness Handicapper record."); }
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.notes) { S.st.notes[t.dataset.notes] = t.value; saveState(); }
  if (t.dataset.m) {
    const k = t.dataset.m, x = +t.value;
    S.mult[k] = x;
    const o = $('#mo-' + k);
    o.textContent = multText(x); o.className = x > 1 ? 'up' : x < 1 ? 'down' : '';
    saveMult();
    document.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('primary', b.dataset.preset === presetName()));
    clearTimeout(S._wt);
    S._wt = setTimeout(() => {
      if (!S.key) return;
      const r = curRace() && raceOf(curRace());
      if (r) { scoreOne(r); $('#raceTop').innerHTML = raceTopHtml(r); $('#raceBody').innerHTML = raceBodyHtml(r); $('#wbadge').innerHTML = weightsBadge(); }
      S.dirty = true;
    }, 120);
  }
});

const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

$('#printBtn').addEventListener('click', () => downloadPdf());
window.addEventListener('beforeprint', () => { if (S.key) buildPrint(); });
window.addEventListener('hashchange', () => { if (S.dirty && S.key) { rescoreAll(); S.dirty = false; } render(); window.scrollTo(0, 0); });

function saveMult() {
  LS.set(MULT_KEY, Object.fromEntries(Object.entries(S.mult).filter(([, v]) => v !== 1)));
}
function applyMult(m) {
  S.mult = { ...DEFAULT_MULT, ...m }; saveMult();
  if (S.key) { rescoreAll(); S.dirty = false; }
  render();
}

// reopen the most recent card on this device
(function init() {
  readSharedFromUrl();
  const cards = LS.get(CARDS_KEY, {});
  const keys = Object.keys(cards).filter((k) => cards[k].card && cards[k].card.races && cards[k].card.races.length).sort((a, b) => cards[b].savedAt - cards[a].savedAt);
  if (keys.length && (Date.now() - cards[keys[0]].savedAt) < 36 * 3600 * 1000) openCard(keys[0], cards[keys[0]].card);
  render();
})();
