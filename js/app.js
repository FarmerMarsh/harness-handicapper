import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { parseProgram, fmtTime } from './parse.js?v=33';
import {
  scoreRace, cardDate, cardDriverTable, DEFAULT_WEIGHTS, WEIGHT_LABELS, ADJ, FACTORS, DEFAULT_MULT, PRESETS,
  multiRaceBets, buildMultiTicket, linearScore, legsHit, legsText, TEMP,
  SIZE_MULT, SIZE_LABEL, GAIT_MULT, PLAYS_MULT, COLD_MULT, TRACK_INFO, GENERIC_POST, isCold, TREND_RAW,
} from './engine.js?v=33';
import { learnAll, learnedMult } from './learn.js?v=33';
import { pushToPool, pullPool, poolRowToLearnRow, poolKeyFor, normKey, ymd, firstRun, poolStatus as poolStatusRaw } from './sync.js?v=33';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

// ---------------- storage ----------------
// Everything lives in IndexedDB (hundreds of MB available) with an in-memory copy so reads stay instant.
// Falls back to localStorage if IndexedDB is blocked. In the desktop app this folder sits next to the .exe.
const MEM = new Map();
let IDB = null;
const clone = (v) => (v == null || typeof v !== 'object' ? v : structuredClone(v));
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('harness-handicapper', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function idbAll(db) {
  return new Promise((res, rej) => {
    const out = new Map(), rq = db.transaction('kv').objectStore('kv').openCursor();
    rq.onsuccess = () => { const c = rq.result; if (c) { out.set(c.key, c.value); c.continue(); } else res(out); };
    rq.onerror = () => rej(rq.error);
  });
}
function idbWrite(k, v) {
  if (!IDB) { try { if (v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* full */ } return; }
  try { const st = IDB.transaction('kv', 'readwrite').objectStore('kv'); if (v === undefined) st.delete(k); else st.put(v, k); } catch (e) { console.error(e); }
}
async function storageInit() {
  try {
    IDB = await idbOpen();
    for (const [k, v] of await idbAll(IDB)) MEM.set(k, v);
    if (!MEM.has('hh:migrated')) {   // one-time move from the old localStorage
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('hh:') && !MEM.has(k)) { try { const v = JSON.parse(localStorage.getItem(k)); MEM.set(k, v); idbWrite(k, v); } catch { /* skip */ } }
      }
      MEM.set('hh:migrated', 1); idbWrite('hh:migrated', 1);
    }
  } catch {
    IDB = null;
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('hh:')) MEM.set(k, JSON.parse(localStorage.getItem(k))); } } catch { /* blocked */ }
  }
  migrateCards();
}
const LS = {
  get(k, d) { return MEM.has(k) ? clone(MEM.get(k)) : d; },
  set(k, v) { const c = clone(v); MEM.set(k, c); idbWrite(k, c); return true; },
  del(k) { MEM.delete(k); idbWrite(k, undefined); },
  keys(prefix) { return [...MEM.keys()].filter((k) => k.startsWith(prefix)); },
};
const CARDS_KEY = 'hh:cards';            // { key: { track, date, iso, savedAt, races } } — program bodies at hh:card:<key>
const CARD_PREFIX = 'hh:card:';
// old format kept the whole program inside hh:cards
function migrateCards() {
  const cards = LS.get(CARDS_KEY, {});
  let changed = false;
  for (const [k, v] of Object.entries(cards)) {
    if (v && v.card) { LS.set(CARD_PREFIX + k, v.card); cards[k] = { track: v.track, date: v.date, iso: cardDate(v.card), savedAt: v.savedAt, races: v.card.races.length }; changed = true; }
  }
  if (changed) LS.set(CARDS_KEY, cards);
}
const getCard = (k) => LS.get(CARD_PREFIX + k, null);
const STATE_PREFIX = 'hh:state:';
const stateKey = (k) => STATE_PREFIX + k;   // { scratches, notes, results, snaps, picks }
const MULT_KEY = 'hh:mult';
const PREF_KEY = 'hh:prefs';

// dark mode (v22, Marshall): Light / Dark / Auto, default Auto. 'Auto' follows the device's
// prefers-color-scheme and keeps listening so it flips live if that changes mid-session.
let _themeMQ = null;
function applyTheme() {
  const mode = S.prefs.theme || 'auto';
  const eff = mode === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
  document.documentElement.dataset.theme = eff;
  if (mode === 'auto' && !_themeMQ) {
    try {
      _themeMQ = matchMedia('(prefers-color-scheme: dark)');
      _themeMQ.addEventListener('change', () => { if ((S.prefs.theme || 'auto') === 'auto') applyTheme(); });
    } catch { /* matchMedia unsupported — Auto just behaves like Light */ }
  }
}

const S = {
  key: null, base: null, card: null, st: null,
  mult: { ...DEFAULT_MULT, ...LS.get(MULT_KEY, {}) },
  tuneOpen: false, hOpen: {}, dirty: false, shared: null, pasted: null, suggestion: null, lastRoute: {},
  prefs: { sort: 'pgm', view: 'auto', pickBudget: 5, shareName: '', emailTo: '', ...LS.get(PREF_KEY, {}) },
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
  return weightsBadgeUser() + learnBadge();
}
function learnBadge() {
  const L = S.learned;
  if (!L || !L.n) return '';
  const on = L.ok && S.prefs.learnUse !== false;
  return ` <a class="pill ${on ? 'value' : ''}" href="#/settings" title="${on ? 'Weights adjusted from your results' : 'Learning — not applied yet'}">${on ? `Learned from ${L.n} races` : `Learning: ${L.n} races`}</a>`;
}
function weightsBadgeUser() {
  const pk = presetName();
  if (pk === 'normal') return `<a class="pill" href="#/settings">Weights: Normal</a>`;
  if (pk) return `<a class="pill key" href="#/settings">Weights: ${esc(PRESETS[pk].label)}</a>`;
  const c = customList();
  return `<a class="pill key" href="#/settings" title="${esc(c.map(([l, x]) => `${l} ${multText(x)}`).join(', '))}">Custom weights: ${esc(c.slice(0, 2).map(([l, x]) => `${l} ${multText(x)}`).join(', '))}${c.length > 2 ? ` +${c.length - 2} more` : ''}</a>`;
}
// Six main sliders; each moves a group of factors. Advanced shows every factor.
const GROUPS = [
  { id: 'speed', label: 'Speed', keys: ['speed', 'trend', 'sizefit'], help: 'Speed ratings and adjusted mile times (last 4 clean), speed trend, track-size fit' },
  { id: 'pace', label: 'Pace style', pace: true, help: 'Slide toward closers or toward early speed — on top of what the track size already does' },
  { id: 'form', label: 'Form', keys: ['form', 'beaten', 'year', 'fresh'], help: 'Last 3 finishes, beaten lengths, this-year record, days since last start' },
  { id: 'class', label: 'Class', keys: ['class', 'odds'], help: 'Class faced, circuit and purse moves, last-start odds' },
  { id: 'conn', label: 'Driver / trainer', keys: ['driver', 'trainer', 'hot', 'conn', 'driver_change'], help: 'Driver UDR, trainer win %, hot/cold, team and barn moves, driver changes' },
  { id: 'post', label: 'Post & trip', keys: ['post', 'tough_trip'], help: 'Post-position win rate at this track, credit for tough trips' },
];
const PACE_STEP = 1.4;
const PACE_UP = ['early', 'pace'], PACE_DN = ['close', 'late'];
function paceValue(m = S.mult) {
  const u = PACE_UP.map((k) => m[k] ?? 1), d = PACE_DN.map((k) => m[k] ?? 1);
  if (u.some((x) => Math.abs(x - u[0]) > 1e-6) || d.some((x) => Math.abs(x - d[0]) > 1e-6) || !(u[0] > 0) || Math.abs(u[0] * d[0] - 1) > 0.02) return null;
  return Math.round((Math.log(u[0]) / Math.log(PACE_STEP)) * 2) / 2;
}
const paceText = (v) => (v == null ? 'Mixed' : v === 0 ? 'Track normal' : v > 0 ? `Speed +${v}` : `Closers +${-v}`);
function groupValue(g, m = S.mult) {
  const xs = g.keys.map((k) => m[k] ?? 1);
  return xs.every((x) => x === xs[0]) ? xs[0] : null;
}
function setGroup(id, x) {
  const g = GROUPS.find((q) => q.id === id);
  if (g.pace) { const f = PACE_STEP ** x; for (const k of PACE_UP) S.mult[k] = +f.toFixed(3); for (const k of PACE_DN) S.mult[k] = +(1 / f).toFixed(3); }
  else for (const k of g.keys) S.mult[k] = x;
}
function baseHtml() {
  if (!S.card) return '<p class="note">Load a program to see how Normal adjusts for its track.</p>';
  const r0 = S.card.races[0] || {};
  const sz = r0.track_size, on = S.prefs.baseAuto !== false;
  const fmt = (o) => Object.entries(o || {}).map(([k, v]) => `${k === 'pace' ? 'pace setup' : k === 'tough_trip' ? 'tough trip' : k === 'early' ? 'early speed' : k === 'close' ? 'closing ¼' : k === 'late' ? 'late move' : k} ×${v}`).join(', ');
  const trots = S.card.races.filter((r) => r.gait === 'TROT').map((r) => r.number);
  const plays = r0.plays;
  const parts = [`<b>${esc(SIZE_LABEL[sz] || 'unknown size')}</b>${SIZE_MULT[sz] ? `: ${fmt(SIZE_MULT[sz])}` : ''}`];
  if (trots.length) parts.push(`<b>trotters</b> (R${trots.join(', R')}): ${fmt(GAIT_MULT.TROT)}`);
  if (plays) parts.push(`<b>${plays === 'speed' ? 'plays fast' : 'plays fair to closers'}</b>: ${fmt(PLAYS_MULT[plays])}`);
  if (S.prefs.season !== false && S.today && isCold(S.today)) parts.push(`<b>cold-weather</b>: ${fmt(COLD_MULT)}`);
  return `<div class="basebox"><div><b>Track normal for ${esc(S.card.track)}</b> <a class="note" href="#/tracks">Track book →</a></div>
    <p class="note">${on ? parts.join(' · ') : 'Off — every track uses the same Normal.'}</p>
    <label class="row note"><input type="checkbox" data-act="toggle-base" ${on ? 'checked' : ''}> Normal adjusts for track size, trotters vs pacers and how the track plays</label>
    <label class="row note"><input type="checkbox" data-act="toggle-season" ${S.prefs.season !== false ? 'checked' : ''}> Cold-weather adjust (Dec–Mar: a little less early speed, a little more closing)</label>
    <p class="note" id="tuneDiff">${diffText()}</p></div>`;
}
function tuneHtml(compact = false) {
  const pk = presetName();
  const row = (id, label, help, val, min, max, step, txt, data) => `<div class="w"><label for="m-${id}">${esc(label)}</label><output id="mo-${id}" class="${val == null ? '' : (data === 'g-pace' ? val > 0 : val > 1) ? 'up' : (data === 'g-pace' ? val < 0 : val < 1) ? 'down' : ''}">${txt}</output>
      <input type="range" id="m-${id}" min="${min}" max="${max}" step="${step}" value="${val ?? (data === 'g-pace' ? 0 : 1)}" ${data.startsWith('g-') ? `data-g="${data.slice(2)}"` : `data-m="${id}"`}>
      <div class="wh">${esc(help)}</div></div>`;
  const main = GROUPS.map((g) => {
    if (g.pace) { const v = paceValue(); return row('g-pace', g.label + ' (closers ← → speed)', g.help, v, -2, 2, 0.5, paceText(v), 'g-pace'); }
    const v = groupValue(g); return row('g-' + g.id, g.label, g.help, v, 0, 3, 0.25, v == null ? 'Mixed' : multText(v), 'g-' + g.id);
  }).join('');
  const group = (g, title) => `<h3>${title}</h3><div class="weights">${FACTORS.filter((f) => f.group === g).map((f) => { const x = S.mult[f.key] ?? 1; return row(f.key, f.label, f.help, x, 0, 3, 0.25, multText(x), f.key); }).join('')}</div>`;
  return `<div class="panel tune">
    <div class="presets"><span class="note">Start from:</span>${Object.entries(PRESETS).map(([k, p]) => `<button class="btn small ${pk === k ? 'primary' : ''}" data-preset="${k}">${esc(p.label)}</button>`).join('')}
      <button class="btn small" data-act="share">Share my settings</button></div>
    ${baseHtml()}
    <h3>Main weights</h3><div class="weights">${main}</div>
    <details class="adv" ${S.advOpen ? 'open' : ''}><summary data-act="adv">Advanced — every factor</summary>
      ${group('weight', 'Ranking factors')}${group('adj', 'Race-shape bonuses')}${group('pen', 'Penalties')}</details>
    <p class="note">Normal = the track normal above. 2× counts a factor twice as much, 0.5× half as much, Off ignores it. Your settings multiply on top of the track normal and stay in this browser${compact ? ' and apply to every race' : ''}.</p>
  </div>`;
}
// how many top picks your weights change vs the plain track normal
function normalTops() {
  const ck = `${S.key}|${S.learned ? S.learned.at : 0}|${S.prefs.learnUse !== false}|${S.st.cond || 'fast'}|${JSON.stringify(S.st.scratches)}|${S.prefs.baseAuto !== false}|${S.prefs.season !== false}`;
  if (S._nt && S._nt.k === ck) return S._nt.v;
  const raw = JSON.parse(S.base), v = {};
  for (const r of raw.races) {
    if (!r.horses.length) continue;
    scoreRace(r, { ...scoreOpts(r), mult: learnedFor(r).mult, sim: false });   // track normal + learning, without your sliders
    v[r.number] = r.ranked.length ? r.ranked[0].pgm : null;
  }
  S._nt = { k: ck, v };
  return v;
}
function diffText() {
  if (!S.card) return '';
  const nt = normalTops(), races = S.card.races.filter((r) => r.ranked && r.ranked.length);
  const d = races.filter((r) => nt[r.number] != null && nt[r.number] !== r.ranked[0].pgm);
  return d.length ? `Your weights change the top pick in <b>${d.length}</b> of ${races.length} races vs the track normal${S.learned && S.learned.ok && S.prefs.learnUse !== false ? ' + learning' : ''} (R${d.map((r) => r.number).join(', R')}).` : `Your weights pick the same winners as the track normal in all ${races.length} races.`;
}
function syncTune() {
  for (const f of FACTORS) { const i = $('#m-' + f.key), o = $('#mo-' + f.key), x = S.mult[f.key] ?? 1; if (i) i.value = x; if (o) { o.textContent = multText(x); o.className = x > 1 ? 'up' : x < 1 ? 'down' : ''; } }
  for (const g of GROUPS) {
    const i = $('#m-g-' + g.id), o = $('#mo-g-' + g.id); if (!i) continue;
    if (g.pace) { const v = paceValue(); i.value = v ?? 0; o.textContent = paceText(v); o.className = v > 0 ? 'up' : v < 0 ? 'down' : ''; }
    else { const v = groupValue(g); i.value = v ?? 1; o.textContent = v == null ? 'Mixed' : multText(v); o.className = v > 1 ? 'up' : v < 1 && v != null ? 'down' : ''; }
  }
  document.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('primary', b.dataset.preset === presetName()));
  const wb = $('#wbadge2'); if (wb) wb.innerHTML = weightsBadge();
}

function setStatus(msg, err = false) {
  const el = $('#status');
  el.textContent = msg || '';
  el.classList.toggle('err', !!err);
}

// ---------------- loading ----------------
async function parseOne(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const card = await parseProgram(doc);
  if (!card.races.length || !card.races.some((r) => r.horses.length)) return null;
  return card;
}
function saveCard(card, fname) {
  const key = `${card.track || 'Track'}|${card.date || fname}`;
  const cards = LS.get(CARDS_KEY, {});
  cards[key] = { track: card.track, date: card.date, iso: cardDate(card), savedAt: Date.now(), races: card.races.length };
  LS.set(CARD_PREFIX + key, card);
  LS.set(CARDS_KEY, cards);
  return key;
}
// programs are only kept a few days — every new program carries each horse's recent lines. Results stay forever.
function pruneCards() {
  const keep = S.prefs.keepDays ?? 3;
  const cards = LS.get(CARDS_KEY, {});
  const newest = Math.max(...Object.values(cards).map((c) => Date.parse(c.iso || 0) || 0), Date.now() - 864e5 * 0);
  for (const [k, c] of Object.entries(cards)) {
    const d = Date.parse(c.iso || 0) || 0;
    const loaded = c.savedAt || 0;
    if (d && newest - d > keep * 864e5 && Date.now() - loaded > keep * 864e5 && k !== S.key) { delete cards[k]; LS.del(CARD_PREFIX + k); }
  }
  LS.set(CARDS_KEY, cards);
}
async function loadFiles(files) {
  files = [...(files || [])].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!files.length) return;
  const opened = [], failed = [];
  for (let i = 0; i < files.length; i++) {
    setStatus(`Reading ${files.length > 1 ? `program ${i + 1} of ${files.length}` : 'program'}…`);
    showBusy(`Reading ${files[i].name}${files.length > 1 ? ` (${i + 1} of ${files.length})` : ''}…`);
    try {
      const card = await parseOne(files[i]);
      if (!card) { failed.push(files[i].name); continue; }
      opened.push(saveCard(card, files[i].name));
    } catch (e) { console.error(e); failed.push(files[i].name); }
  }
  showBusy('');
  pruneCards();
  if (failed.length) setStatus(`Couldn't find race pages in ${failed.join(', ')}. It reads the standard USTA program (Dayton, Scioto, Northfield…), Woodbine / Standardbred Canada programs (Mohawk, Georgian, Flamboro…) and Trackmaster programs.`, true);
  else setStatus('');
  if (opened.length) { switchTo(opened[0], '#/'); }
}
const loadFile = (f) => loadFiles(f ? [f] : []);
function showBusy(msg) {
  let el = $('#busy');
  if (!el) { el = document.createElement('div'); el.id = 'busy'; el.className = 'busy'; document.body.appendChild(el); }
  el.textContent = msg; el.hidden = !msg;
}
// switch programs, coming back to the same page (race 5 → race 5) when it exists
function switchTo(key, hash) {
  const card = getCard(key);
  if (!card) return;
  if (S.key) S.lastRoute[S.key] = location.hash || '#/';
  openCard(key, card);
  scheduleLearning(800);   // v22: refresh the pool for this track (post-index + cross-night Trends), even with 0 local results yet
  const m = (hash || '').match(/race\/(\d+)/);
  let to = hash ?? S.lastRoute[key] ?? '#/';
  if (m && !card.races.some((r) => r.number === +m[1])) to = '#/';
  if (location.hash === to) render(); else location.hash = to;
}
// programs for the same day as the open one, by track
function dayCards() {
  if (!S.key) return [];
  const cards = LS.get(CARDS_KEY, {}), mine = cards[S.key];
  if (!mine) return [[S.key, { track: S.card.track }]];
  return Object.entries(cards).filter(([, c]) => c.date === mine.date).sort((a, b) => (a[1].savedAt || 0) - (b[1].savedAt || 0));
}
function daybarHtml() {
  if (!S.key) return '';
  const cards = LS.get(CARDS_KEY, {});
  const today = dayCards();
  const others = Object.entries(cards).filter(([k]) => !today.some(([t]) => t === k)).sort((a, b) => (Date.parse(b[1].iso || 0) || 0) - (Date.parse(a[1].iso || 0) || 0));
  const shortTrack = (t) => (t || '').replace(/\s+(Raceway|Downs|Park|Racetrack|Racing|& Casino|Casino)\b.*$/i, '');
  return `<div class="daybar-in"><span class="note">${esc((cards[S.key] || {}).date || S.card.date || '')}</span>
    <div class="dtabs" role="tablist">${today.map(([k, c]) => `<button role="tab" aria-selected="${k === S.key}" class="${k === S.key ? 'on' : ''}" data-switch="${esc(k)}">${esc(shortTrack(c.track))}</button>`).join('')}</div>
    <label class="btn small add">+ Add program<input type="file" accept="application/pdf,.pdf" multiple data-act="addfiles" hidden></label>
    ${others.length ? `<select class="other" data-other aria-label="Other saved programs"><option value="">Other days…</option>${others.map(([k, c]) => `<option value="${esc(k)}">${esc(c.track)} · ${esc(c.date)}</option>`).join('')}</select>` : ''}</div>`;
}

function openCard(key, card) {
  S.key = key;
  LS.set('hh:open', key);
  S.base = JSON.stringify(card);
  S.st = { scratches: {}, notes: {}, results: {}, snaps: {}, picks: {}, played: {}, drivers: {}, live: {}, liveOpen: {}, ...LS.get(stateKey(key), {}) };
  S.st.picks = S.st.picks || {};
  rescoreAll();
}

function rescoreAll() {
  S.card = JSON.parse(S.base);
  S.today = cardDate(S.card);
  S.year = new Date(S.today).getUTCFullYear();
  S.driverTable = cardDriverTable(S.card);
  S.book = bookFor(S.card.track);
  for (const r of S.card.races) scoreOne(r);
  if (!S._noted || S._noted !== S.key) {
    S._noted = S.key; const had = S.book && S.book.size != null; noteTrack(S.card); S.book = bookFor(S.card.track);
    if (!had && S.learned && S.learned.ok) for (const r of S.card.races) scoreOne(r);   // size now known for the size layer
  }
  S.bets = multiRaceBets(S.card).filter((b) => b.races.every((n) => raceOf(n)));
}
const PROFILE_KEY = 'hh:profiles';   // { trackName: { mult, n, hits, made } }
// A track's profile is used when you switch profiles on, or automatically once the track has
// 100+ graded races AND the learned weights picked more winners than normal weights on races they hadn't seen.
const AUTO_PROFILE = 100;
function activeProfile() {
  if (!S.card) return null;
  const p = LS.get(PROFILE_KEY, {})[S.card.track];
  if (!p || !p.mult) return null;
  if (S.prefs.useProfiles) return p;
  return p.n >= AUTO_PROFILE && p.better ? p : null;
}
function gradedCount(track) {
  let n = 0;
  for (const [key, st] of allStates()) {
    if (key.split('|')[0] !== track) continue;
    for (const [rn, fin] of Object.entries(st.results || {})) if ((fin || []).some(Boolean) && st.snaps && st.snaps[rn] && st.snaps[rn].feat) n++;
  }
  return n;
}
function learnTrack(track) {
  const r = runSuggestion(track);
  const profs = LS.get(PROFILE_KEY, {});
  if (r.final) {
    const better = r.hitsSug >= r.hitsNorm + Math.max(3, Math.round(r.n * 0.05));
    profs[track] = { mult: Object.fromEntries(Object.entries(r.final).filter(([, v]) => v !== 1)), n: r.n, hits: r.hitsSug, base: r.hitsNorm, better, made: Date.now() };
    LS.set(PROFILE_KEY, profs);
  }
  return r;
}
// after results are entered: re-learn a track with 100+ races every 10 new races
function autoLearn(track) {
  const n = gradedCount(track), p = LS.get(PROFILE_KEY, {})[track];
  if (n < AUTO_PROFILE || (p && n < p.n + 10)) return;
  setTimeout(() => { learnTrack(track); if (S.key) rescoreAll(); render(); }, 60);
}
function effMult() { return S.mult; }
// what learning adds for this race (all tracks × size × track × gait), plus tonight's lean if you applied one
function learnedFor(r) {
  const L = S.learned;
  if (!L || !L.ok || !L.model || S.prefs.learnUse === false || !S.card) return { mult: {}, temp: 1 };
  const size = r.track_size ?? (S.book && S.book.size);
  return { mult: learnedMult(L.model, { size, track: S.card.track, gait: r.gait }), temp: L.model.temp || 1 };
}
const PACE_UP_K = ['early', 'pace'], PACE_DN_K = ['close', 'late'];
function scoreOpts(r) {
  const l = learnedFor(r), m = { ...S.mult };
  for (const [k, v] of Object.entries(l.mult)) m[k] = (m[k] ?? 1) * v;
  const lean = S.st.tonight || 0;
  if (lean) { const f = 1.4 ** lean; for (const k of PACE_UP_K) m[k] = (m[k] ?? 1) * f; for (const k of PACE_DN_K) m[k] = (m[k] ?? 1) / f; }
  return { today: S.today, year: S.year, mult: m, driverTable: S.driverTable, scratched: S.st.scratches[r.number] || [], cond: S.st.cond || 'fast',
    book: S.book, base: S.prefs.baseAuto !== false, season: S.prefs.season !== false, temp: l.temp,
    blend: (S.prefs.mlBlend ?? 35) / 100, live: (S.st.live || {})[r.number] || null,
    // v22 (#52): the first live-odds reading entered for each horse, kept alongside the current one so the
    // engine can flag real drift between them. Off entirely when the pref is off, or nothing's been typed twice.
    liveOpen: S.prefs.liveDrift === false ? null : (S.st.liveOpen || {})[r.number] || null, drivers: driverOverrides(r.number) };
}

// ---------------- learning from results ----------------
const LEARN_KEY = 'hh:learned';
// every graded race: the model's view before the race + the official order
function learnRows() {
  const rows = [];
  for (const [key, st] of allStates()) {
    const track = key.split('|')[0];
    const book = LS.get(TRACKS_KEY, {})[track] || {};
    for (const [rn, fin] of Object.entries(st.results || {})) {
      const snap = st.snaps && st.snaps[rn];
      const order = [];
      for (const x of fin || []) { if (!x) break; order.push(x); }
      if (!snap || !snap.feat || !order.length || !snap.feat.some(([p]) => p === order[0])) continue;
      const meta = snap.meta || {};
      const trot = snap.feat.some(([, f]) => f && f.b && f.b.form > 1.05);
      const dateStr = ymd(meta.date ?? cardDate({ date: key.split('|')[1] }));
      rows.push({ feat: snap.feat, fin: order.slice(0, 3), track: meta.track || track, size: meta.size ?? book.size ?? (TRACK_INFO[book.code] || {}).size ?? null,
        gait: meta.gait || (trot ? 'TROT' : 'PACE'), card: key, key: dateStr ? poolKeyFor(normKey(meta.track || track), dateStr, +rn) : null });
    }
  }
  return rows;
}
let LW = null;
function learnWorker() {
  if (LW !== null) return LW;
  try { LW = new Worker(new URL('./learnworker.js?v=33', import.meta.url), { type: 'module' }); } catch { LW = false; }
  return LW;
}
// re-learn a moment after results change (debounced so live entry doesn't thrash)
function scheduleLearning(delay = 2500) {
  if (S.prefs.learnFreeze) return;
  clearTimeout(S._lt);
  S._lt = setTimeout(runLearning, delay);
}
async function runLearning() {
  const local = learnRows();
  // merge in the shared pool (every result anyone's entered, anywhere) — best-effort, never blocks on a slow/offline pool
  let raw = [], poolRows = [];
  try { raw = await pullPool(); poolRows = raw.map(poolRowToLearnRow).filter(Boolean); } catch { raw = []; poolRows = []; }
  S._poolRaw = raw;   // v22 (#50/#51): kept raw (not just the learn-shaped rows) for post-index + cross-night Trends
  const poolKeys = new Set(poolRows.map((r) => r.key));
  const rows = [...poolRows, ...local.filter((r) => !r.key || !poolKeys.has(r.key))];
  S.poolRows = poolRows.length;
  // v22: nothing to (re)learn globally, but pooled post-index/Trends data for the open track may still have
  // changed — one render covers it. Exactly one render() per call either way, so a scroll-synced bar
  // (mini confidence bar, floating header) never gets reset twice by the same pool refresh.
  if (!rows.length) { if (S.key) rescoreAll(); render(); return; }
  S.learning = true; renderLearnStatus();
  const done = (res) => {
    S.learning = false;
    if (!res) { renderLearnStatus(); return; }
    const prevOk = S.learned && S.learned.ok;
    S.learned = res; LS.set(LEARN_KEY, res);
    if (S.key) rescoreAll();   // v22: always refresh — pooled post-index/Trends can change even when res.ok/prevOk don't
    render();
  };
  const w = learnWorker();
  if (w) {
    w.onmessage = (e) => done(e.data.ok ? e.data.result : (console.error(e.data.error), null));
    w.onerror = (e) => { console.error(e); LW = false; setTimeout(() => done(learnAll(rows)), 20); };
    w.postMessage({ rows });
  } else setTimeout(() => done(learnAll(rows)), 20);
}
function renderLearnStatus() {
  const el = $('#learnStatus');
  if (el) el.innerHTML = learnStatusText();
}
function poolStatusLine() {
  const n = S.poolRows || 0;
  if (poolStatusRaw === 'ok') return n ? `Shared pool: synced — ${n} race${n === 1 ? '' : 's'} from the pool went into this.` : 'Shared pool: synced (nothing in the pool yet).';
  if (poolStatusRaw === 'error') return "Shared pool: couldn't reach it just now — using this browser's own results only; it'll pick back up next time it can reach the pool.";
  return 'Shared pool: not checked yet.';
}
function learnStatusText() {
  const L = S.learned;
  if (S.learning) return 'Learning from your results…';
  if (!L || !L.n) return `No graded races yet — enter official orders on the race pages or paste them in. <span class="note">${poolStatusLine()}</span>`;
  const when = new Date(L.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `${L.n} graded races (${L.nPos} finish positions) · updated ${when}${S.prefs.learnFreeze ? ' · <b>frozen</b>' : ''} <span class="note">· ${poolStatusLine()}</span>`;
}
const KLABEL = Object.fromEntries(FACTORS.map((f) => [f.key, f.label]));
function learnChanges(o, min = 0.09) {
  return Object.entries(o || {}).filter(([, v]) => Math.abs(Math.log(v)) >= min).sort((a, b) => Math.abs(Math.log(b[1])) - Math.abs(Math.log(a[1])))
    .map(([k, v]) => `<span class="pill ${v > 1 ? 'value' : 'badv'}">${esc(KLABEL[k] || k)} ${multText(+v.toFixed(2))}</span>`);
}
function learningHtml() {
  const L = S.learned, on = S.prefs.learnUse !== false;
  let body = `<p class="note" id="learnStatus">${learnStatusText()}</p>`;
  if (L && L.n) {
    const cv = L.cv || {};
    const stat = !L.ok ? (cv.n ? '<b>Holding</b> — on races it hadn\'t seen, the learned weights didn\'t beat normal yet, so normal weights stay in use.' : 'Needs results from at least 3 programs before it can test itself.')
      : on ? '<b class="gv">In use</b> — every race is scored with what your results have taught it.' : 'Learned but switched off.';
    body += `<p>${stat}</p>`;
    if (cv.n) {
      body += `<p class="note">Tested on races it hadn't seen (whole programs held out): learned weights picked <b>${cv.hitsL}</b> winners of ${cv.n}, normal weights <b>${cv.hitsN}</b>. Rating of the real finishers: ${cv.llL >= cv.llN ? '<span class="gv">better</span>' : '<span class="bv">worse</span>'} (${((cv.llL - cv.llN) / cv.n).toFixed(3)} per race).</p>`;
      const rows = cv.calib.filter((b) => b.n >= 5).map((b) => `<tr><td>${Math.round(b.lo * 100)}–${Math.round(Math.min(1, b.hi) * 100)}%</td><td>${b.n}</td><td>${Math.round((100 * b.pred) / b.n)}%</td><td><b>${Math.round((100 * b.wins) / b.n)}%</b></td></tr>`).join('');
      if (rows) body += `<details><summary class="note">Are our lines honest? (horses we gave X% — how often they won)</summary><table class="rec"><thead><tr><th>We said</th><th>Horses</th><th>Avg</th><th>Won</th></tr></thead><tbody>${rows}</tbody></table></details>`;
    }
    if (L.model) {
      const M = L.model, parts = [];
      const g = learnChanges(M.G); if (g.length) parts.push(`<p><b>All tracks:</b> ${g.join(' ')}</p>`);
      for (const [sz, o] of Object.entries(M.S || {})) { const c = learnChanges(o); if (c.length) parts.push(`<p><b>${esc(SIZE_LABEL[sz] || sz)} tracks</b> (${L.counts.size[sz] || 0}): ${c.join(' ')}</p>`); }
      for (const [tr, o] of Object.entries(M.T || {})) { const c = learnChanges(o); if (c.length) parts.push(`<p><b>${esc(tr)}</b> (${L.counts.track[tr] || 0}): ${c.join(' ')}</p>`); }
      for (const [ga, o] of Object.entries(M.A || {})) { const c = learnChanges(o); if (c.length) parts.push(`<p><b>${ga === 'TROT' ? 'Trotters' : 'Pacers'}</b> (${L.counts.gait[ga] || 0}): ${c.join(' ')}</p>`); }
      if (M.temp && Math.abs(M.temp - 1) >= 0.05) parts.push(`<p><b>Lines:</b> ${M.temp > 1 ? 'spread a little tighter (favourites were winning less than we said)' : 'spread a little wider (favourites were winning more than we said)'} — ×${M.temp}</p>`);
      body += parts.length ? `<h4>What it has learned</h4>${parts.join('')}` : '<p class="note">Nothing has moved yet — with few races every layer stays close to normal on purpose. It moves further as more results go in.</p>';
    }
  }
  body += `<div class="row" style="margin-top:8px">
    <label class="row note"><input type="checkbox" data-act="learn-use" ${on ? 'checked' : ''}> Use learned weights</label>
    <label class="row note"><input type="checkbox" data-act="learn-freeze" ${S.prefs.learnFreeze ? 'checked' : ''}> Freeze (stop updating)</label>
    <button class="btn small" data-act="learn-now">Re-learn now</button></div>`;
  return `<div class="panel learnp"><h3>Learning from your results</h3>
    <p class="note">Every result you enter is kept with what the model knew before the race, and shared into a pool every device/browser using the site adds to and learns from — the more results everyone enters, the better the model gets for everyone. It learns in layers — all tracks → track size → each track → trotters / pacers — each starting from the one above and pulled back toward it, so a handful of races barely moves anything and hundreds can move a lot. It also checks whether a horse we call 20% really wins about 20%. Learned weights sit on top of the track normal; your own sliders sit on top of that.</p>
    ${body}</div>`;
}

// ---------------- tonight: how the card is playing so far ----------------
function tonightInfo() {
  if (!S.key) return null;
  let n = 0, early = 0, close = 0, inside = 0;
  const posts = [];
  for (const [rn, fin] of Object.entries(S.st.results || {})) {
    const snap = S.st.snaps && S.st.snaps[rn], w = (fin || [])[0];
    if (!snap || !snap.feat || !w || !snap.feat.some(([p]) => p === w)) continue;
    n++;
    const rank = (k) => { const v = snap.feat.map(([p, f]) => [p, (f && f.c && f.c[k]) ?? 0.5]).sort((a, b) => b[1] - a[1]); return v.findIndex(([p]) => p === w) + 1; };
    if (rank('early') <= 3) early++;
    if (rank('close') <= 3) close++;
    if (w <= 3) inside++;
    posts.push(w);
  }
  if (n < 3) return { n };
  let lean = 0, why = '';
  if (early / n >= 0.7 && early - close >= 2) { lean = n >= 5 ? 1 : 0.5; why = 'Speed is holding'; }
  else if (close / n >= 0.7 && close - early >= 2) { lean = n >= 5 ? -1 : -0.5; why = 'Closers are getting there'; }
  return { n, early, close, inside, posts, lean, why };
}
function tonightHtml() {
  const t = tonightInfo();
  if (!t || t.n < 3) return '';
  const cur = S.st.tonight || 0;
  const facts = `${t.n} races in: ${t.early} winners had top-3 early speed, ${t.close} were top-3 closers; winning posts ${t.posts.join(', ')}.`;
  if (cur) return `<div class="tonight on"><b>Tonight:</b> leaning ${cur > 0 ? 'toward speed' : 'toward closers'} (${cur > 0 ? '+' : ''}${cur}) for the rest of this card. <span class="note">${facts}</span> <button class="btn small" data-tonight="0">Remove</button></div>`;
  if (!t.lean) return `<div class="tonight"><b>Tonight so far:</b> no clear lean. <span class="note">${facts}</span></div>`;
  return `<div class="tonight"><b>Tonight: ${t.why}.</b> <span class="note">${facts} Small samples fool you — this is a light tilt.</span> <button class="btn small primary" data-tonight="${t.lean}">Lean ${t.lean > 0 ? 'toward speed' : 'toward closers'} for the rest of tonight</button></div>`;
}
// ---------------- trends: what tonight's graded races are actually showing ----------------
function gradedRaces() {
  const out = [];
  for (const [rn, fin] of Object.entries(S.st.results || {})) {
    const snap = S.st.snaps && S.st.snaps[rn], w = (fin || [])[0];
    if (!snap || !snap.feat || !w || !snap.feat.some(([p]) => p === w)) continue;
    out.push({ rn: +rn, snap, fin, w });
  }
  out.sort((a, b) => a.rn - b.rn);
  return out;
}
function postNoMap(snap) {
  return snap.pn ? new Map(snap.pn) : new Map((snap.order || []).map((p) => [p, p]));
}
// v25 (Marshall): same top-3 idea already used for early/closing speed, generalized to every
// scored factor — which other stats do tonight's winners also tend to rank top-3 in, for their race.
const TREND_FACTOR_KEYS = FACTORS.filter((f) => f.group === 'weight').map((f) => f.key);
function trendsInfo() {
  if (!S.key) return null;
  const races = gradedRaces();
  if (races.length < 3) return { n: races.length };
  let early = 0, close = 0, both = 0, topWon = 0, top3 = 0;
  const postRows = new Map();   // post -> { starts, wins, idxSum, idxN }
  const gaitRows = {};          // gait -> { n, early, close }
  const factorHits = Object.fromEntries(TREND_FACTOR_KEYS.map((k) => [k, 0]));
  // v27 (Marshall): the range of each factor's raw value actually seen among tonight's winners —
  // "no winner has opened slower than X", generalized to every scored factor.
  const rawRange = Object.fromEntries(Object.keys(TREND_RAW).map((k) => [k, { lo: null, hi: null, n: 0 }]));
  for (const g of races) {
    const { snap, w } = g;
    const rank = (k) => { const v = snap.feat.map(([p, f]) => [p, (f && f.c && f.c[k]) ?? 0.5]).sort((a, b) => b[1] - a[1]); return v.findIndex(([p]) => p === w) + 1; };
    const isEarly = rank('early') <= 3, isClose = rank('close') <= 3;
    if (isEarly) early++;
    if (isClose) close++;
    if (isEarly && isClose) both++;
    if (snap.order && snap.order[0] === w) topWon++;
    if (snap.order && snap.order.slice(0, 3).includes(w)) top3++;
    for (const k of TREND_FACTOR_KEYS) if (rank(k) <= 3) factorHits[k]++;
    const winFeat = (snap.feat.find(([p]) => p === w) || [])[1];
    if (winFeat && winFeat.raw) {
      for (const k of Object.keys(TREND_RAW)) {
        const v = winFeat.raw[k];
        if (v == null) continue;
        const r = rawRange[k];
        r.n++; r.lo = r.lo == null ? v : Math.min(r.lo, v); r.hi = r.hi == null ? v : Math.max(r.hi, v);
      }
    }
    const gait = (snap.meta && snap.meta.gait) || '?';
    const gr = gaitRows[gait] || (gaitRows[gait] = { n: 0, early: 0, close: 0 });
    gr.n++; if (isEarly) gr.early++; if (isClose) gr.close++;
    const pn = postNoMap(snap);
    for (const [pgm, feat] of snap.feat) {
      const p = pn.get(pgm) ?? pgm;
      const row = postRows.get(p) || { starts: 0, wins: 0, idxSum: 0, idxN: 0 };
      row.starts++;
      if (pgm === w) row.wins++;
      if (feat && feat.c && feat.c.post != null) { row.idxSum += feat.c.post; row.idxN++; }
      postRows.set(p, row);
    }
  }
  const n = races.length;
  let lean = 0, why = '';
  if (early / n >= 0.7 && early - close >= 2) { lean = n >= 5 ? 1 : 0.5; why = 'Speed is holding'; }
  else if (close / n >= 0.7 && close - early >= 2) { lean = n >= 5 ? -1 : -0.5; why = 'Closers are getting there'; }
  const totalStarts = [...postRows.values()].reduce((a, r) => a + r.starts, 0);
  const avgWin = totalStarts ? n / totalStarts : null;   // baseline win rate across every starter graded so far
  const posts = [...postRows.entries()]
    .map(([post, r]) => {
      // comp.post (0..1, centered 0.5) is 0.5 + idx/130 where idx is a % deviation from the track's average post win rate (see postIndex() in engine.js) —
      // convert the night's average composite back into that same deviation, then project it onto tonight's own average win rate so it lands on the
      // same win% scale as the "Wins" column, instead of comparing a relative index against an absolute percentage.
      const idx = r.idxN ? (r.idxSum / r.idxN - 0.5) * 130 : null;
      const modelPct = idx != null && avgWin != null ? Math.max(0, avgWin * (1 + idx / 100)) : null;
      return { post, ...r, modelPct };
    })
    .filter((p) => p.post >= 1 && p.post <= 20)
    .sort((a, b) => a.post - b.post);
  // rank the other factors by how often tonight's winners also placed top-3 in them (early/close excluded — already their own row)
  const factorRows = TREND_FACTOR_KEYS.filter((k) => k !== 'early' && k !== 'close')
    .map((k) => ({ key: k, label: WEIGHT_LABELS[k] || k, hits: factorHits[k], n }))
    .sort((a, b) => b.hits / b.n - a.hits / a.n || a.label.localeCompare(b.label));
  // v27: the raw lowest/highest value seen among tonight's winners for every scored factor (needs 3+ winners
  // with that raw value recorded — older snapshots from before v27 won't have .raw, so n can lag behind the card's n).
  const rangeRows = Object.keys(TREND_RAW)
    .map((k) => ({ key: k, label: WEIGHT_LABELS[k] || k, unit: TREND_RAW[k].unit, ...rawRange[k] }))
    .filter((r) => r.n >= 3)
    .sort((a, b) => a.label.localeCompare(b.label));
  return { n, early, close, both, lean, why, topWon, top3, posts, gaitRows, factorRows, rangeRows };
}
// v22 (#51): the same pace/post picture as trendsInfo(), but pooled across every graded race at this
// track from every night anyone's used the site — not just tonight's card. Needs a real sample before
// it's worth showing; under TRACK_TREND_MIN races it stays quiet rather than drawing conclusions from noise.
const TRACK_TREND_MIN = 10;
function trackTrendsInfo(name) {
  const rows = trackPoolMerge(name);
  const n = rows.length;
  if (n < TRACK_TREND_MIN) return { n };
  let early = 0, close = 0;
  const postRows = new Map();
  for (const r of rows) {
    const rank = (k) => { const v = r.feat.map(([p, f]) => [p, (f && f.c && f.c[k]) ?? 0.5]).sort((a, b) => b[1] - a[1]); return v.findIndex(([p]) => p === r.win) + 1; };
    if (rank('early') <= 3) early++;
    if (rank('close') <= 3) close++;
    const pn = r.pn ? new Map(r.pn) : null;
    for (const e of r.feat) {
      const pgm = e[0], p = pn ? (pn.get(pgm) ?? pgm) : entryPost(e);
      if (!(p >= 1)) continue;
      const row = postRows.get(p) || { starts: 0, wins: 0, idxSum: 0, idxN: 0 };
      row.starts++;
      if (pgm === r.win) row.wins++;
      if (e[1] && e[1].c && e[1].c.post != null) { row.idxSum += e[1].c.post; row.idxN++; }
      postRows.set(p, row);
    }
  }
  const totalStarts = [...postRows.values()].reduce((a, r) => a + r.starts, 0);
  const avgWin = totalStarts ? n / totalStarts : null;
  const posts = [...postRows.entries()].map(([post, r]) => {
    const idx = r.idxN ? (r.idxSum / r.idxN - 0.5) * 130 : null;
    const modelPct = idx != null && avgWin != null ? Math.max(0, avgWin * (1 + idx / 100)) : null;
    return { post, ...r, modelPct };
  }).filter((p) => p.post >= 1 && p.post <= 20).sort((a, b) => a.post - b.post);
  const { hits } = evalMult(rows, {});   // today's default weights vs. the field, same proxy the weight-suggestion tool uses
  return { n, early, close, posts, hits };
}
function trackTrendsHtml(name, pct) {
  const tt = trackTrendsInfo(name);
  if (tt.n < TRACK_TREND_MIN) return '';
  const postHtml = `<table class="rec"><thead><tr><th>Post</th><th>Starts</th><th>Wins</th><th>Win%</th><th>Model expected</th></tr></thead><tbody>
    ${tt.posts.map((p) => {
      const actualPct = p.starts ? (100 * p.wins) / p.starts : null;
      const modelPct = p.modelPct != null ? 100 * p.modelPct : null;
      const hot = p.starts >= 4 && actualPct != null && modelPct != null && actualPct - modelPct >= 12;
      const cold = p.starts >= 4 && actualPct != null && modelPct != null && modelPct - actualPct >= 12;
      return `<tr${hot ? ' style="background:var(--row-hot)"' : cold ? ' style="background:var(--row-cold)"' : ''}><td>${p.post}</td><td>${p.starts}</td><td>${p.wins}</td><td>${actualPct != null ? Math.round(actualPct) + '%' : '—'}</td><td>${modelPct != null ? Math.round(modelPct) + '%' : '—'}</td></tr>`;
    }).join('')}
  </tbody></table>`;
  return `<div class="panel" style="margin-top:12px"><h3>Across every pooled night at ${esc(name)}</h3>
    <p class="note">${tt.n} graded races total — the shared pool plus this browser's own results, not just tonight. Needs 4+ starts at a post before calling it hot or cold.</p>
    <div class="row note" style="gap:16px;flex-wrap:wrap">
      <span><b>${tt.early}/${tt.n}</b> winners (${pct(tt.early, tt.n)}) top-3 early speed</span>
      <span><b>${tt.close}/${tt.n}</b> winners (${pct(tt.close, tt.n)}) top-3 closers</span>
      <span>today's default model has picked the winner <b>${tt.hits}/${tt.n}</b> (${pct(tt.hits, tt.n)})</span>
    </div>${postHtml}</div>`;
}
function renderTrends() {
  const t = trendsInfo();
  const head = `<div class="cardhead"><div><h1>Trends</h1><div class="sub">${esc(S.card.track)} · ${esc(S.card.date)} · How tonight's graded races are actually running — fills in as you enter more results.</div></div></div>`;
  const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '—');
  const poolBlock = trackTrendsHtml(S.card.track, pct);
  if (!t || t.n < 3) return `${head}<div class="panel"><p class="note">Enter a few official results (${t ? t.n : 0} graded so far — need at least 3) and tonight's pace, post and pick trends will show up here.</p></div>${poolBlock}`;
  const paceRow = `<div class="row note" style="gap:16px;flex-wrap:wrap">
    <span><b>${t.early}/${t.n}</b> winners (${pct(t.early, t.n)}) were top-3 on early speed</span>
    <span><b>${t.close}/${t.n}</b> winners (${pct(t.close, t.n)}) were top-3 closers</span>
    <span><b>${t.both}/${t.n}</b> winners (${pct(t.both, t.n)}) were top-3 on <b>both</b></span>
  </div>`;
  const leanP = t.why
    ? `<p class="note" style="margin-top:6px"><b>${esc(t.why)}.</b> ${t.n < 5 ? "Still a small sample — light tilt only." : "Worth leaning on for the rest of the card."}</p>`
    : `<p class="note" style="margin-top:6px">No clear speed-vs-closer lean yet.</p>`;
  const gaits = Object.entries(t.gaitRows);
  const gaitHtml = gaits.length > 1 ? `<table class="rec" style="margin-top:8px"><thead><tr><th>Gait</th><th>Races</th><th>Early top-3</th><th>Close top-3</th></tr></thead><tbody>
    ${gaits.map(([g, r]) => `<tr><td>${esc(g === 'TROT' ? 'Trot' : g === 'PACE' ? 'Pace' : g)}</td><td>${r.n}</td><td>${pct(r.early, r.n)}</td><td>${pct(r.close, r.n)}</td></tr>`).join('')}
  </tbody></table>` : '';
  const postHtml = `<table class="rec"><thead><tr><th>Post</th><th>Starts</th><th>Wins</th><th>Win%</th><th>Model expected</th></tr></thead><tbody>
    ${t.posts.map((p) => {
      const actualPct = p.starts ? (100 * p.wins) / p.starts : null;
      const modelPct = p.modelPct != null ? 100 * p.modelPct : null;
      const hot = p.starts >= 3 && actualPct != null && modelPct != null && actualPct - modelPct >= 12;
      const cold = p.starts >= 3 && actualPct != null && modelPct != null && modelPct - actualPct >= 12;
      return `<tr${hot ? ' style="background:var(--row-hot)"' : cold ? ' style="background:var(--row-cold)"' : ''}><td>${p.post}</td><td>${p.starts}</td><td>${p.wins}</td><td>${actualPct != null ? Math.round(actualPct) + '%' : '—'}</td><td>${modelPct != null ? Math.round(modelPct) + '%' : '—'}</td></tr>`;
    }).join('')}
  </tbody></table>`;
  const pickP = `<p class="note">Our top pick has won <b>${t.topWon}/${t.n}</b> (${pct(t.topWon, t.n)}) and landed in the top 3 of <b>${t.top3}/${t.n}</b> (${pct(t.top3, t.n)}) graded races so far tonight.</p>`;
  // v25 (Marshall): beyond early/closing, what else do tonight's winners have in common — ranked by how
  // often the winner also placed top-3 in that stat for their own race.
  const factorHtml = `<table class="rec" style="margin-top:8px"><thead><tr><th>Stat</th><th>Winner also top-3</th></tr></thead><tbody>
    ${t.factorRows.map((f) => `<tr><td>${esc(f.label)}</td><td><b>${f.hits}/${f.n}</b> (${pct(f.hits, f.n)})</td></tr>`).join('')}
  </tbody></table>`;
  // v27 (Marshall): "no winner has opened slower than X" generalized to every scored factor — the actual
  // lowest/highest raw value seen among tonight's winners, not a rank-based hit-rate like the table above.
  const fmtRaw = (v, unit) => v == null ? '—' : unit === 'win%' ? `${Math.round(v)}%` : unit === 'days' ? `${Math.round(v)}` : unit === 'UDR' || unit === 'score' ? v.toFixed(3) : `${Math.round(v * 10) / 10}`;
  const rangeHtml = t.rangeRows.length ? `<table class="rec" style="margin-top:8px"><thead><tr><th>Stat</th><th>Lowest (winner)</th><th>Highest (winner)</th><th>Unit</th><th>n</th></tr></thead><tbody>
    ${t.rangeRows.map((r) => `<tr><td>${esc(r.label)}</td><td>${fmtRaw(r.lo, r.unit)}</td><td>${fmtRaw(r.hi, r.unit)}</td><td class="muted">${esc(r.unit)}</td><td>${r.n}</td></tr>`).join('')}
  </tbody></table>` : `<p class="note">Needs 3+ graded races entered since this update before a range shows up here.</p>`;
  return `${head}
  <div class="panel"><h3>Pace tonight</h3>${paceRow}${leanP}${gaitHtml}</div>
  <div class="panel" style="margin-top:12px"><h3>What else winners have in common</h3><p class="note">Every scored stat, ranked by how often tonight's winner also placed top-3 in it for their race — not just early/closing speed. Small sample tonight, so take the order loosely until it fills in.</p>${factorHtml}</div>
  <div class="panel" style="margin-top:12px"><h3>Winners' performance range</h3><p class="note">The actual lowest and highest value tonight's winners have shown in each stat — e.g. "no winner has opened slower than X." Needs 3+ winners with that stat recorded; the n column can lag the card's graded-race count for stats that aren't always available (e.g. a horse with no recent off-track line).</p>${rangeHtml}</div>
  <div class="panel" style="margin-top:12px"><h3>Posts tonight</h3><p class="note">Every horse that started, not just winners. "Model expected" is the usual post edge for this track/size; green rows are running hotter than that, pink rows colder. Under 3 starts isn't marked either way.</p>${postHtml}</div>
  <div class="panel" style="margin-top:12px"><h3>How our picks are doing</h3>${pickP}</div>${poolBlock}
  <p class="note" id="poolStatus" style="margin-top:10px">${poolStatusLine()}</p>`;
}
// ---------------- floating header for the horse table ----------------
// A true CSS `position: sticky` th can't be used on table.ht: its wrapper also needs native
// horizontal scrolling on narrower desktop widths, and giving an ancestor `overflow-x: auto`
// makes it the scroll container sticky positions against, which breaks the intended
// viewport-relative stickiness. So instead we float a measured clone of the header over the
// page once the real header scrolls above the fixed topbar+daybar, kept in horizontal sync.
const FLOATHEAD_OFFSET = 134; // .topbar (55px) + .daybar (45px) + .minibar (34px, when showing — see miniBarSync)
function floatHeadSync() {
  if (!S._floatHeadBar) {
    const bar = document.createElement('div');
    bar.className = 'floathead';
    document.body.appendChild(bar);
    S._floatHeadBar = bar;
    const onScroll = () => floatHeadSync();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    document.addEventListener('scroll', (e) => { if (e.target && e.target.classList && e.target.classList.contains('htable-wrap')) floatHeadSync(); }, true);
  }
  const bar = S._floatHeadBar;
  const wrap = document.querySelector('.hview-table.auto .htable-wrap, .hview-table.force .htable-wrap');
  const table = wrap && wrap.querySelector('table.ht');
  const thead = table && table.querySelector('thead');
  if (!wrap || !table || !thead || wrap.offsetParent === null) { bar.classList.remove('show'); return; }
  const theadTop = thead.getBoundingClientRect().top, tableBottom = table.getBoundingClientRect().bottom;
  if (theadTop < FLOATHEAD_OFFSET && tableBottom > FLOATHEAD_OFFSET + thead.offsetHeight) {
    const srcKey = `${S.key}|${curRace()}`;
    if (bar.dataset.src !== srcKey) {
      const realThs = [...thead.querySelectorAll('th')];
      bar.innerHTML = '';
      const tbl = document.createElement('table'); tbl.className = 'ht';
      const thd = document.createElement('thead'); const row = document.createElement('tr');
      for (const th of realThs) { const c = document.createElement('th'); c.textContent = th.textContent; row.appendChild(c); }
      thd.appendChild(row); tbl.appendChild(thd); bar.appendChild(tbl);
      bar.dataset.src = srcKey;
      const floatThs = row.querySelectorAll('th');
      realThs.forEach((th, i) => { floatThs[i].style.width = th.getBoundingClientRect().width + 'px'; });
    }
    const wrapRect = wrap.getBoundingClientRect();
    bar.style.left = wrapRect.left + 'px'; bar.style.width = wrapRect.width + 'px';
    bar.scrollLeft = wrap.scrollLeft;
    bar.classList.add('show');
  } else bar.classList.remove('show');
}

// v22: a small sticky bar (race #, winner stars, top pick) while scrolling down a race page past its
// banner — desktop/tablet only (<720px already has the bottom .pinbar from v18, so this would duplicate it).
function miniBarSync() {
  if (!S._miniBar) {
    const bar = document.createElement('div');
    bar.className = 'minibar';
    document.body.appendChild(bar);
    S._miniBar = bar;
    const onScroll = () => miniBarSync();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
  }
  const bar = S._miniBar;
  const banner = document.querySelector('#raceTop .banner');
  const r = banner && raceOf(curRace());
  if (!banner || !r || !r.ranked.length || window.innerWidth < 720) { bar.classList.remove('show'); return; }
  if (banner.getBoundingClientRect().bottom < 0) {
    const srcKey = `${S.key}|${r.number}`;
    if (bar.dataset.src !== srcKey) {
      const h = r.ranked[0];
      bar.innerHTML = `<b>R${r.number}</b> <span class="stars">${stars(r.confidence)}</span> <span class="mb-pick"><b>#${h.pgm}</b> ${esc(tc(h.name))}</span> <span class="mb-pct">${Math.round(h.win_prob * 100)}%</span>`;
      bar.dataset.src = srcKey;
    }
    bar.classList.add('show');
  } else bar.classList.remove('show');
}
function scoreOne(r) { scoreRace(r, scoreOpts(r)); }
// every driver on tonight's card with his printed stats — for late driver changes
function cardDrivers() {
  if (S._drvKey === S.key && S._drv) return S._drv;
  const map = new Map();
  for (const r of S.card.races) for (const h of r.horses) {
    const o = h._d0 || h; if (!o.driver) continue;
    const k = normName(o.driver);
    if (!map.has(k) || (map.get(k).udr == null && o.drv_udr != null)) map.set(k, { name: o.driver, udr: o.drv_udr ?? null, st: o.drv_st ?? null, w: o.drv_w ?? null, drv30: o.drv30 ?? null });
  }
  S._drvKey = S.key; S._drv = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  return S._drv;
}
function driverOverrides(n) {
  const d = (S.st.drivers || {})[n];
  if (!d || !Object.keys(d).length) return null;
  const all = cardDrivers(), out = {};
  for (const [pgm, name] of Object.entries(d)) out[pgm] = all.find((x) => x.name === name) || { name };
  return out;
}

// ---------------- track book: what we know and learn about each track ----------------
const TRACKS_KEY = 'hh:tracks';   // { trackName: { code, size, plays, post_tm, cards: { date: races } } }
// v22 (#50/#51): every graded race at this track — the shared pool (everyone, every night) plus this browser's
// own local results not yet reflected there, deduped by race key so a race pushed to the pool isn't double-counted
// from the local copy too. Falls back to local-only automatically whenever the pool is empty/unreachable.
function trackPoolMerge(name) {
  const trackKey = normKey(name);
  const pool = (S._poolRaw || []).filter((r) => r.track_key === trackKey && r.entries && r.finish && r.finish.length && r.entries.some((e) => e[0] === r.finish[0]));
  const poolKeys = new Set(pool.map((r) => poolKeyFor(r.track_key, r.race_date, r.race_no)));
  const local = trainingRows(name).filter((r) => !r.key || !poolKeys.has(r.key));
  return [...pool.map((r) => ({ feat: r.entries, win: r.finish[0] })), ...local.map((r) => ({ feat: r.feat, win: r.win, pn: r.pn }))];
}
// wins by post, and whether winners had early or late speed — pool ∪ local (see trackPoolMerge)
function trackLearn(name) {
  const rows = trackPoolMerge(name);
  const wins = [], starts = [];
  let n = 0, early3 = 0, close3 = 0;
  for (const r of rows) {
    n++;
    const pn = r.pn ? new Map(r.pn) : null;
    for (const e of r.feat) {
      const pgm = e[0], p = pn ? (pn.get(pgm) ?? pgm) : entryPost(e);
      if (p >= 1) { starts[p - 1] = (starts[p - 1] || 0) + 1; if (pgm === r.win) wins[p - 1] = (wins[p - 1] || 0) + 1; }
    }
    const rankBy = (k) => { const vals = r.feat.map(([p, f]) => [p, (f && f.c && f.c[k]) ?? 0.5]).sort((a, b) => b[1] - a[1]); return vals.findIndex(([p]) => p === r.win) + 1; };
    if (rankBy('early') <= 3) early3++;
    if (rankBy('close') <= 3) close3++;
  }
  const len = Math.max(wins.length, starts.length);
  for (let i = 0; i < len; i++) { wins[i] = wins[i] || 0; starts[i] = starts[i] || 0; }
  const e = n ? early3 / n : null, c = n ? close3 / n : null;
  let suggest = null;
  if (n >= 30) suggest = e - c >= 0.15 ? 'speed' : c - e >= 0.05 ? 'closers' : 'size';
  return { n, res_post: { wins, starts }, early3: e, close3: c, suggest };
}
function bookFor(name) {
  const b = LS.get(TRACKS_KEY, {})[name] || {};
  return { ...b, ...trackLearn(name) };
}
// remember the track when a program loads: size, code, and the program's own post table if it prints one
function noteTrack(card) {
  const books = LS.get(TRACKS_KEY, {}), name = card.track;
  if (!name) return;
  const r0 = card.races.find((r) => r.track_code) || {};
  const b = books[name] || { plays: 'auto', cards: {} };
  b.code = r0.track_code || b.code; b.size = r0.track_size ?? b.size;
  b.cards = b.cards || {}; b.cards[card.date || '?'] = card.races.length;
  b.has_rating = card.races.some((r) => r.horses.some((h) => h.post_rating != null));
  const ps = card.post_stats;
  if (ps && !ps.generic && ps.fast && ps.fast.win && (!b.post_tm || !b.post_tm.date || new Date(card.date) >= new Date(b.post_tm.date))) b.post_tm = { ...ps, date: card.date };
  books[name] = b;
  LS.set(TRACKS_KEY, books);
}
const saveState = () => { LS.set(stateKey(S.key), S.st); scheduleBackup(); };
function buildExport() {
  const cards = LS.get(CARDS_KEY, {});
  const out = { exported: new Date().toISOString(), cards: {}, tracks: LS.get(TRACKS_KEY, {}), profiles: LS.get(PROFILE_KEY, {}) };
  for (const [k, st] of allStates()) out.cards[k] = { track: cards[k]?.track || k.split('|')[0], date: cards[k]?.date || k.split('|')[1] || '', state: st };
  return new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
}
// Windows app: keep a backup of the whole record in the data folder, refreshed a few seconds after any change
function scheduleBackup() {
  if (!(window.__TAURI__ && window.__TAURI__.core)) return;
  clearTimeout(S._bk);
  S._bk = setTimeout(() => { deskSave(buildExport(), 'harness-record-backup.json', 'export').catch(() => {}); }, 8000);
}

// ---------------- grading ----------------
function playOf(t) {
  return { type: t.type, text: t.text, combos: t.combos, cost: t.cost, legs: t.legs || null };
}
function snapshot(r) {
  return {
    v: 2,
    order: r.ranked.map((h) => h.pgm), conf: r.confidence, under: r.undercard,
    plays: { exacta: playOf(r.exacta), trifecta: playOf(r.trifecta), superfecta: playOf(r.superfecta) },
    longshots: (r.longshots || []).map((l) => ({ legs: l.legs, text: l.text, cost: l.cost, kind: l.kind, bet: l.bet })),
    value: { good: [...(r.value?.good || [])], bad: [...(r.value?.bad || [])] },
    vdet: r.ranked.filter((h) => h.value).map((h) => [h.pgm, h.value, h.ml_prob ?? null, h.win_prob, h.ml, h.line]),
    feat: r.ranked.map((h) => [h.pgm, h.feat]),
    pn: r.ranked.map((h) => [h.pgm, h.m.post_no ?? h.pgm]),
    wp: r.ranked.map((h) => [h.pgm, +h.win_prob.toFixed(4)]),
    top: { ml: r.ranked[0].ml_dec ?? null, p: r.ranked[0].win_prob, own: r.ranked[0].own_rank === 1 },
    meta: { track: S.card ? S.card.track : null, size: r.track_size ?? null, gait: r.gait || '', code: r.track_code || null, date: S.today || null },
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
function gradeRace(snap, fin, played = null) {
  const o = snap.order;
  const row = { conf: snap.conf, under: snap.under, win: fin[0] === o[0], itm: fin.slice(0, 3).includes(o[0]) };
  for (const k of ['exacta', 'trifecta', 'superfecta']) {
    const pl = snap.plays[k];
    row[k] = pl.type === 'PASS' || pl.type === 'N/A' ? null : pl.legs ? legsHit(pl.legs, fin) : oldPlayHit(k, pl, o, fin);
    row[k + '_cost'] = row[k] == null ? 0 : pl.cost;
  }
  row.pl = { exacta: !!(played && played.exacta), trifecta: !!(played && played.trifecta), superfecta: !!(played && played.superfecta) };
  const lsKind = (l) => l.kind || (/on top/.test(l.text) || /^\d+ \//.test(l.text) ? 'top' : /\/ \d+$/.test(l.text) ? 'third' : 'straight');
  row.lsT = (snap.longshots || []).map((l) => {
    const kd = lsKind(l), hit = legsHit(l.legs, fin);
    return { kind: kd, text: l.text, cost: l.cost || 0, hit, pl: !!(played && (played.ls || []).includes(`${l.bet || 'tri'}:${l.text}`)) };
  }).filter((x) => x.hit != null);
  row.ls = row.lsT.map((x) => x.hit);
  row.ls_cost = row.lsT.reduce((a, x) => a + x.cost, 0);
  const v = snap.value || { good: [], bad: [] };
  row.good = v.good.length; row.good_w = v.good.filter((p) => p === fin[0]).length; row.good_itm = v.good.filter((p) => fin.slice(0, 3).includes(p)).length;
  row.bad = v.bad.length; row.bad_w = v.bad.filter((p) => p === fin[0]).length; row.bad_itm = v.bad.filter((p) => fin.slice(0, 3).includes(p)).length;
  const exp = (k) => (snap.vdet || []).filter((d) => d[1] === k && d[2] != null).reduce((a, d) => a + d[2], 0);
  row.good_mlexp = exp('good'); row.bad_mlexp = exp('bad');
  row.top = snap.top || null;
  row.cal = (snap.wp || []).map(([pg, pr]) => [pr, pg === fin[0]]);
  row.gv = (snap.vdet || []).filter((d) => d[1] === 'good').map((d) => { const [a, b] = String(d[4] || '').split('/').map(Number); return { ml: b ? a / b : null, w: d[0] === fin[0], itm: fin.slice(0, 3).includes(d[0]) }; });
  return row;
}
function gradedRows(st) {
  const rows = [];
  for (const [rn, fin] of Object.entries(st.results || {})) {
    const f = (fin || []).filter((x) => x);
    if (f.length >= 1 && st.snaps && st.snaps[rn]) rows.push({ race: +rn, ...gradeRace(st.snaps[rn], f, (st.played || {})[rn]) });
  }
  return rows.sort((a, b) => a.race - b.race);
}
function allStates() {
  return LS.keys(STATE_PREFIX).map((k) => [k.slice(STATE_PREFIX.length), MEM.get(k)]).filter(([, st]) => st);
}

// ---------------- best / worst highlights ----------------
const HL = {
  life: [(m) => m.life_mark_adj, -1], yr: [(m) => m.yr_mark_adj, -1], avg: [(m) => m.avg_mark, -1],
  open: [(m) => m.open_q, -1], close: [(m) => m.close_q, -1], late: [(m) => m.late_gain, 1], fin: [(m) => m.avg_fin3, -1],
  // v31 (Marshall), fixed same version: colored by fresh_disp, the 7–21-day sweet-spot score computed from
  // days_real (days since the last REAL start) — not raw days, and NOT fresh_val (that one is based on
  // days_any, which counts a recent qualifier as freshness and was wrongly banding long-real-layoff horses
  // green if they'd qualified recently). The displayed text is still the raw real-start day count.
  fresh: [(m) => m.fresh_disp, 1],
  lw: [(m) => (m.life_starts >= 5 ? m.life_win : null), 1], lt: [(m) => (m.life_starts >= 5 ? m.life_top3 : null), 1],
  yw: [(m) => (m.yr_starts >= 3 ? m.yr_win : null), 1], yt: [(m) => (m.yr_starts >= 3 ? m.yr_top3 : null), 1],
  cls: [(m) => m.cr_avg3, 1],
  // v31 (Marshall): same 15+ start reliability bar the existing "Strong/Weak barn" pro/con already uses — a trainer
  // with too few recorded starts (and a known count) doesn't get colored at all, rather than banding an unreliable %.
  trn: [(m, h) => ((h.trn_st == null || h.trn_st >= 15) ? h.trn_w : null), 1],
  tmp: [(m, h) => h.tm?.power, 1], tms: [(m, h) => h.tm?.speed, 1], tmc: [(m, h) => h.tm?.pace, 1], tmk: [(m, h) => h.tm?.class, 1],
};
function highlights(r) {
  const out = {};
  const act = (r.active || []).filter((h) => h.m);
  for (const [key, [f, dir]] of Object.entries(HL)) {
    const vals = act.map((h) => [h.pgm, f(h.m, h)]).filter(([, v]) => v != null && isFinite(v)).map(([p, v]) => [p, Math.round(v * 100) / 100]);
    if (vals.length < 3) continue;
    const nums = vals.map(([, v]) => v);
    if (Math.max(...nums) === Math.min(...nums)) continue;
    // Marshall (Nov 17, v24): best = bright green, 2nd-3rd = yellow, 4th-6th = neutral, 7th+ = red. Ties share a band.
    const m = new Map();
    for (const [p, v] of vals) {
      const ahead = nums.filter((x) => (dir > 0 ? x > v : x < v)).length;
      m.set(p, ahead === 0 ? 'best' : ahead <= 2 ? 'mid' : ahead <= 5 ? '' : 'worst');
    }
    out[key] = m;
  }
  return out;
}
const hlClass = (hl, key, pgm) => (!hl || !hl[key] ? '' : hl[key].get(pgm) || '');
const hv = (cls, html) => (cls ? `<span class="hv ${cls}">${html}</span>` : html);

// ---------------- render: card ----------------
function racePlaysHtml(r) {
  const t = r.trifecta;
  const bits = [`<span class="pill ${kind(t)}">TRI ${t.type === 'N/A' ? 'n/a' : esc(t.type.toLowerCase() + ' ' + t.text)}${t.conf ? ` · ${t.conf}/5` : ''}</span>`];
  if (r.exacta.conf) bits.push(`<span class="pill ${kind(t)}">EX ${esc(r.exacta.type.toLowerCase() + ' ' + r.exacta.text)} · ${r.exacta.conf}/5</span>`);
  for (const p of r.value.good.slice(0, 2)) bits.push(`<span class="pill value">Value #${p} (${esc(horseOf(r, p).ml)})</span>`);
  for (const p of r.value.bad.slice(0, 1)) bits.push(`<span class="pill badv">Bad value #${p} (${esc(horseOf(r, p).ml)})</span>`);
  if (r.longshots.length) bits.push(`<span class="pill">${r.longshots.length} longshot${r.longshots.length > 1 ? 's' : ''}</span>`);
  return bits.join('');
}

function renderCard() {
  const c = S.card;
  const best = [...c.races].filter((r) => r.ranked.length > 1).sort((a, b) =>
    (b.confidence - a.confidence) || ((b.ranked[0].pick - b.ranked[1].pick) - (a.ranked[0].pick - a.ranked[1].pick))).slice(0, 3);
  const nScr = Object.values(S.st.scratches).reduce((a, b) => a + b.length, 0);
  return `
  <div class="cardhead">
    <div><h1>${esc(c.track)}</h1><div class="sub">${esc(c.date)} · ${c.races.length} races${nScr ? ` · ${nScr} scratched` : ''} · ${weightsBadge()}</div></div>
    <div class="row"><button class="btn small" data-act="pdf">Download PDF</button><button class="btn small" data-act="print">Print</button>
      ${S.bets.length ? '<a class="btn small" href="#/picks">Pick 3/4/5 tickets</a>' : ''}<a class="btn small primary" href="#/results">Enter results</a></div>
  </div>
  <div class="condbar"><span class="note">Track today:</span><div class="seg" role="group" aria-label="Track condition">
    <button data-cond="fast" class="${(S.st.cond || 'fast') === 'fast' ? 'on' : ''}">Fast</button><button data-cond="off" class="${S.st.cond === 'off' ? 'on' : ''}">Off (good / sloppy / muddy)</button></div>
    <span class="note">${S.st.cond === 'off' ? 'Off-track records, sire off-track stats and the off-track post stats now count.' : 'Switch to Off if the track comes up wet — it re-ranks every race.'}</span></div>
  ${tonightHtml()}
  ${summaryCard()}
  ${crossTrackRollup()}
  <div class="races">
    ${c.races.map((r) => {
      const rk = r.ranked;
      if (!rk.length) return '';
      return `<a class="racecard ${r.confidence >= 5 ? 'top' : ''}" href="#/race/${r.number}">
        <div class="rc-head"><div class="rc-num">${r.number}</div>
          <div class="rc-meta">${r.post_time ? `<b>${esc(r.post_time)}</b> · ` : ''}${esc(tc(r.gait))} · ${money(r.purse)}<br>${rk.length} starters</div>
          <div class="rc-conf"><span class="stars">${stars(r.confidence)}</span> <b>${r.confidence}/5</b><br><span class="stars u">${stars(r.undercard)}</span> <span class="muted">undercard</span></div>
        </div>
        <div class="rc-pick"><b>#${rk[0].pgm} ${esc(tc(rk[0].name))}</b> <span class="muted">(${esc(rk[0].ml)}) · ${Math.round(rk[0].win_prob * 100)}%</span></div>
        <div class="rc-under">Then ${rk.slice(1, 5).map((h) => `#${h.pgm} ${esc(tc(h.name))}`).join(', ')}</div>
        <div class="rc-plays">${racePlaysHtml(r)}</div>
      </a>`;
    }).join('')}
  </div>`;
}

function summaryCard() {
  const H = cardHighlights();
  const box = (title, inner) => `<div class="sbox"><h3>${title}</h3>${inner}</div>`;
  const lnk = (n, html) => `<a href="#/race/${n}">${html}</a>`;
  const ol = (items) => (items.length ? `<ol>${items.join('')}</ol>` : '<p class="note">None on this card.</p>');
  const P = H.plan;
  const byRace = {};
  for (const x of P.inn) (byRace[x.rn] = byRace[x.rn] || []).push(x);
  const planBox = `<div class="sbox plan"><h3>Card plan — ${dollars(P.spent)} of ${dollars(P.budget)}
      <span class="seg small" role="group" aria-label="Card budget">${[25, 50, 75, 100].map((v) => `<button data-cbudget="${v}" class="${P.budget === v ? 'on' : ''}">$${v}</button>`).join('')}</span></h3>
    <p class="note">${P.inn.length} bets: ${planText(P)}${P.out.length ? ` · ${P.out.length} more left out to stay on budget (everything would be ${dollars(P.all)})` : ''}</p>
    <details class="slip" ${S.prefs.slipOpen ? 'open' : ''}><summary>Bet slip, race by race</summary>
      <table class="rec sliptab"><tbody>${Object.entries(byRace).map(([rn, xs]) => `<tr><td>${lnk(+rn, `<b>Race ${rn}</b>`)}</td><td>${xs.map((x) => `<span class="sl"><b>${esc(x.label.replace(/^R\d+ /, ''))}</b> ${esc(x.text)} <span class="muted">${dollars(x.cost)}</span></span>`).join('')}</td><td class="r"><b>${dollars(xs.reduce((a, x) => a + x.cost, 0))}</b></td></tr>`).join('')}</tbody></table>
      <div class="row" style="margin-top:8px"><button class="btn small" data-act="plan-played">Mark these as played</button><span class="note" id="planMsg">Ticks every bet on the slip so the Record can show what you really played.</span></div>
      ${P.out.length ? `<p class="note faint">Left out: ${P.out.map((x) => `${esc(x.label)} ${dollars(x.cost)}`).join(' · ')}</p>` : ''}</details></div>`;
  return `<section class="panel summary" aria-label="Card summary"><div class="sum-head"><h2>Summary</h2><span class="note">${esc(weightsText(effMult()))}</span></div>${planBox}<div class="sgrid">
    ${box('Best bets', ol(H.best.map((r) => { const h = r.ranked[0]; return `<li>${lnk(r.number, `<b>R${r.number} #${h.pgm} ${esc(tc(h.name))}</b>`)} <span class="muted">ML ${esc(h.ml)} · line ${esc(h.line)} · ${r.confidence}/5</span></li>`; })))}
    ${box('Best trifectas', ol(H.tris.map((r) => `<li>${lnk(r.number, `<b>R${r.number} ${esc(tc(r.trifecta.type))} ${esc(r.trifecta.text)}</b>`)} <span class="muted">${r.trifecta.conf}/5 · ${dollars(r.trifecta.cost)} · ~${Math.round(r.trifecta.hit * 100)}%</span></li>`)))}
    ${box('Best exactas', ol(H.exs.map((r) => `<li>${lnk(r.number, `<b>R${r.number} ${esc(tc(r.exacta.type))} ${esc(r.exacta.text)}</b>`)} <span class="muted">${r.exacta.conf}/5 · ${dollars(r.exacta.cost)} · ~${Math.round(r.exacta.hit * 100)}%</span></li>`)))}
    ${box('Superfectas', ol(H.sups.map((r) => `<li>${lnk(r.number, `<b>R${r.number} ${esc(tc(r.superfecta.type))} ${esc(r.superfecta.text)}</b>`)} <span class="muted">${dollars(r.superfecta.cost)} · ~${Math.round(r.superfecta.hit * 100)}%</span></li>`)))}
    ${box('<span class="gv">Good value</span> <span class="muted">ML → our line</span>', ol(H.good.slice(0, 6).map(({ r, h }) => `<li>${lnk(r.number, `<b>R${r.number} #${h.pgm} ${esc(tc(h.name))}</b>`)} ${esc(h.ml.replace('/', '-'))} → <b>${esc(h.line)}</b></li>`)))}
    ${box('<span class="bv">Bad value</span> <span class="muted">bet against</span>', ol(H.bad.slice(0, 6).map(({ r, h }) => `<li>${lnk(r.number, `<b>R${r.number} #${h.pgm} ${esc(tc(h.name))}</b>`)} ${esc(h.ml.replace('/', '-'))} → <b>${esc(h.line)}</b></li>`)))}
    ${box('Longshots', ol(H.longs.slice(0, 6).map(({ r, l }) => `<li>${lnk(r.number, `<b>R${r.number} ${l.bet === 'ex' ? 'Ex' : 'Tri'} ${esc(l.text)}</b>`)} <span class="muted">${dollars(l.cost)} · ${esc(l.label)}</span></li>`)))}
    ${box('Pick 3 / 4 / 5 &amp; doubles', H.plans.length ? `<ul class="plain">${H.plans.map(({ b, t, alt }) => `<li>${t.verdict === 'PLAY' ? '<b class="gv">PLAY</b>' : '<span class="muted">PASS</span>'} <a href="#/picks">${esc(b.name)} R${b.races[0]}–${b.races[b.races.length - 1]}</a>${t.verdict === 'PLAY' ? ` ${ticketLine(t)} = <b>${dollars(t.cost)}</b>` : alt ? ` <span class="muted">· plays at $10</span>` : ''}</li>`).join('')}</ul>` : '<p class="note">No multi-race wagers on this card.</p>')}
  </div></section>`;
}

// v22: when 2+ programs are loaded for tonight (the switcher bar), roll each one's best bets into one
// view instead of clicking through each program's own Summary. Scores each other program by briefly
// swapping it into the live S.* state (reusing cardHighlights()) and restoring exactly what was there.
function crossTrackRollup() {
  const today = dayCards();
  if (today.length < 2) return '';
  const save = { key: S.key, card: S.card, st: S.st, base: S.base, today: S.today, year: S.year,
    driverTable: S.driverTable, book: S.book, bets: S.bets, noted: S._noted };
  const rows = [];
  for (const [key] of today) {
    try {
      if (key !== save.key) openCard(key, getCard(key));
      const H = cardHighlights();
      rows.push({ key, track: S.card.track, best: H.best.slice(0, 2), long: H.longs[0] || null });
    } catch { /* a program that fails to re-score here just drops out of the rollup */ }
  }
  S.key = save.key; S.card = save.card; S.st = save.st; S.base = save.base; S.today = save.today; S.year = save.year;
  S.driverTable = save.driverTable; S.book = save.book; S.bets = save.bets; S._noted = save.noted;
  LS.set('hh:open', save.key);   // openCard() above persisted whichever key it last touched — put it back
  if (rows.length < 2) return '';
  const go = (key, n, html) => `<a href="#/race/${n}" data-switch="${esc(key)}" data-gohash="#/race/${n}">${html}</a>`;
  return `<section class="panel summary" aria-label="Across tonight's tracks" style="margin-top:12px">
    <div class="sum-head"><h2>Across tonight's tracks</h2><span class="note">${rows.length} programs loaded</span></div>
    <div class="sgrid">${rows.map((x) => `<div class="sbox"><h3>${esc(x.track)}</h3>${x.best.length
      ? `<ol>${x.best.map((r) => { const h = r.ranked[0]; return `<li>${go(x.key, r.number, `<b>R${r.number} #${h.pgm} ${esc(tc(h.name))}</b>`)} <span class="muted">ML ${esc(h.ml)} · ${r.confidence}/5</span></li>`; }).join('')}</ol>`
      : '<p class="note">No races scored yet.</p>'}
      ${x.long ? `<p class="note">Top longshot: ${go(x.key, x.long.r.number, `R${x.long.r.number} ${x.long.l.bet === 'ex' ? 'Ex' : 'Tri'} ${esc(x.long.l.text)}`)}</p>` : ''}</div>`).join('')}
    </div></section>`;
}

// ---------------- render: race ----------------
// one short, concrete reason the top pick is rated above a given rival
function reasonOver(h, riv) {
  if (!riv) return '';
  if (riv.cons && riv.cons.length) return riv.cons[0][0];
  const hm = h.m, rm = riv.m;
  if (hm && rm && hm.avg_fin3 != null && rm.avg_fin3 != null && hm.avg_fin3 < rm.avg_fin3 - 0.3) return `sharper recent form (avg fin ${hm.avg_fin3.toFixed(1)} vs ${rm.avg_fin3.toFixed(1)})`;
  if (hm && rm && hm.life_win != null && rm.life_win != null && hm.life_win > rm.life_win + 0.04) return `wins more often lifetime (${pctP(hm.life_win, 0)} vs ${pctP(rm.life_win, 0)})`;
  return `${(h.pick - riv.pick).toFixed(1)} pts back on our line`;
}
function whyHtml(r) {
  const h = r.ranked[0], h2 = r.ranked[1], h3 = r.ranked[2];
  if (!h || !h2) return '';
  const pros = h.pros.slice(0, 2).map((p) => p[0]).join('; ') || 'best overall profile';
  const risk = h.cons.length ? h.cons[0][0] : 'no major red flags';
  const gap = h.pick - h2.pick;
  const edge = gap >= 10 ? 'clear edge' : gap < 4 ? 'narrow edge' : 'solid edge';
  const t = r.trip;
  const pace = t ? `${t.text.charAt(0).toLowerCase() + t.text.slice(1)}${t.leader != null ? ` (leader #${t.leader}${t.pocket != null ? `, pocket #${t.pocket}` : ''}${t.firstOver != null ? `, first-over #${t.firstOver}` : ''})` : ''}` : 'not enough lines to project the trip';
  const moved = h.own_rank > 1 ? ` <b>Public:</b> our numbers alone had #${r.ranked.find((x) => x.own_rank === 1).pgm} on top — the ${r.live ? 'live odds' : 'morning line'} tipped it to #${h.pgm}.` : '';
  const over3 = h3 ? ` <b>Over #${h3.pgm}:</b> ${esc(reasonOver(h, h3))}.` : '';
  return `<b>Why #${h.pgm} ${esc(tc(h.name))}:</b> ${esc(pros)}. <b>Risk:</b> ${esc(risk)}. <b>Edge over #${h2.pgm}:</b> ${edge} (${gap.toFixed(1)} pts) — ${esc(reasonOver(h, h2))}.${over3} <b>Pace:</b> ${esc(pace)}.${moved}`;
}

const pcList = (items, cls) => `<ul class="${cls}">${items.length ? items.map(([t, imp, cat]) => `<li class="${imp >= 3 ? 'b' : imp === 2 ? 'm' : ''}">${cat ? `<span class="cat">${esc(cat)}</span>` : ''}${esc(t)}</li>`).join('') : '<li class="faint none">—</li>'}</ul>`;

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
    ['Days off', m.days_real != null ? hv(c('fresh'), `${m.days_real}d`) : '—', 'ideal 7–21d'],
    ['Life W/T3', wt(m.life_win, m.life_top3, 'lw', 'lt'), `${m.life_starts} starts`],
    [`${yy} W/T3`, wt(m.yr_win, m.yr_top3, 'yw', 'yt'), `${m.yr_starts} starts`],
    ['Class', m.cr_avg3 != null ? hv(c('cls'), Math.round(m.cr_avg3)) : '—', m.cr_avg3 != null ? 'avg CR faced' : ''],
  ];
}

// TrackMaster's own Power / Speed / Pace / Class ratings (Platinum programs) — shown, not scored
function tmLine(h, hl) {
  const t = h.tm;
  if (!t || [t.power, t.speed, t.pace, t.class].every((x) => x == null)) return '';
  const c = (k) => hlClass(hl, k, h.pgm);
  const one = (lbl, v, k) => (v == null ? '' : `${lbl} ${hv(c(k), Number.isInteger(v) ? v : v.toFixed(1))}`);
  return `<span class="tmr">TM ${[one('Power', t.power, 'tmp'), one('Speed', t.speed, 'tms'), one('Pace', t.pace, 'tmc'), one('Class', t.class, 'tmk')].filter(Boolean).join(' · ')}</span>`;
}

// connections & course on one line: driver/trainer team, record here, new barn
function connLine(h, cls = 'h-extra') {
  const b = h.m && h.m.conn_bits;
  if (!b || !b.length) return '';
  const tag = cls === 's' ? 'span' : 'div';
  return `<${tag} class="${cls} conn">${esc(b.join(' · '))}</${tag}>`;
}

function extraLine(h) {
  const m = h.m, x = [];
  if (h.claim) x.push(`clm ${h.claim}`);
  if (h.equip_note) x.push(h.equip_note.charAt(0) + h.equip_note.slice(1).toLowerCase().replace('lasix', 'Lasix'));
  if (m && m.thrown) x.push(`${m.thrown} of L4 thrown out`);
  if (m && m.ship) x.push(`last raced at ${(m.last_track || '').replace(/[ÁÂ½1]$/, '')}`);
  return x.join(' · ');
}
const valueTag = (h) => (h.value === 'good' ? '<span class="pill value">Good value</span>' : h.value === 'bad' ? '<span class="pill badv">Bad value</span>' : '');

function horseCard(h, r, scr, hl) {
  const cls = scr ? 'scr' : h.rank === 1 ? 'r1' : h.rank <= 3 ? 'r23' : '';
  const proj = scr ? '<span class="pill pass">SCR</span>' : `<div class="h-proj">${h.rank}<small> · ${Math.round(h.win_prob * 100)}%</small></div>`;
  const hk = `${r.number}:${h.pgm}`;
  const open = scr ? false : S.hOpen[hk] ?? (S.prefs.expand === true || (S.prefs.expand == null && window.innerWidth >= 720));
  const one = scr || !h.pros ? '' : `<div class="h-line">${h.pros[0] ? `<span class="pro">+ ${esc(h.pros[0][0])}</span>` : ''}${h.cons[0] ? `<span class="con">− ${esc(h.cons[0][0])}</span>` : ''}</div>`;
  return `<details class="horse ${cls}" data-h="${hk}" ${open ? 'open' : ''}>
    <summary><div class="h-top">
      <button class="scrbtn ${scr ? 'on' : ''}" data-scr="${h.pgm}" aria-pressed="${scr}">${scr ? 'Scratched' : 'Scratch'}</button>
      <div class="h-pgm">${h.pgm}</div>
      <div style="min-width:0"><div class="h-name">${esc(tc(h.name))} ${scr ? '' : valueTag(h)}</div>
        <div class="h-sub">${esc(tc(h.driver))}${h.drv_w != null ? ` (${h.drv_w}%)` : ''} · ${esc(tc(h.trainer))}${h.trn_w != null ? ` (${hv(hlClass(hl, 'trn', h.pgm), `${h.trn_w}%`)})` : ''}</div>
        <div class="h-extra">${esc(extraLine(h))}</div>${scr ? '' : `<div class="h-extra">${tmLine(h, hl)}</div>${connLine(h)}`}</div>
      <div class="h-right">${proj}<div class="h-ml">ML ${esc(h.ml)}${!scr && h.line ? ` · line ${esc(h.line)}` : ''}</div></div>
    </div>${one}</summary>
    ${scr || !h.m ? '' : `<div class="h-stats">${statCells(h, hl).map(([k, v, s]) => `<div class="st"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}</div>
    <div class="pc">${pcList(h.pros, 'pro')}${pcList(h.cons, 'con')}</div>`}
  </details>`;
}

function horseTable(r, sorted, scrSet, forPrint = false) {
  const hl = highlights(r);
  const yy = String(S.year).slice(2);
  const head = ['Scr', '#', 'Horse / Driver · Trainer', 'ML', 'Proj', 'Life mark', `'${yy} mark`, 'Avg mark*', 'Open ¼*', 'Close ¼*', '¾→Fin', 'Avg fin L3', 'Days off', 'Life W/T3', `'${yy} W/T3`, 'Pros', 'Cons'];
  const rows = sorted.map((h) => {
    const scr = scrSet.has(h.pgm);
    const cls = scr ? 'scr' : h.rank === 1 ? 'r1' : h.rank <= 3 ? 'r23' : '';
    const cells = !scr && h.m ? statCells(h, hl) : null;
    const c = (i) => (cells ? `${cells[i][1]}<span class="s">${cells[i][2]}</span>` : '—');
    const scrCell = forPrint ? `<span class="scrbox"></span>` : `<button class="scrbtn ${scr ? 'on' : ''}" data-scr="${h.pgm}" aria-pressed="${scr}">${scr ? 'SCR' : '✕'}</button>`;
    const vt = scr ? '' : h.value === 'good' ? '<span class="s gv">good value</span>' : h.value === 'bad' ? '<span class="s bv">bad value</span>' : '';
    return `<tr class="${cls}">
      <td>${scrCell}</td><td><b style="font-size:1.15em">${h.pgm}</b></td>
      <td class="l"><span class="h-name"><b>${esc(tc(h.name))}</b></span><span class="s">${esc(tc(h.driver))} · ${esc(tc(h.trainer))}${h.trn_w != null ? ` (${hv(hlClass(hl, 'trn', h.pgm), `${h.trn_w}%`)})` : ''}</span><span class="s faint">${esc(extraLine(h))}</span>${scr ? '' : `<span class="s">${tmLine(h, hl)}</span>${connLine(h, 's')}`}</td>
      <td>${esc(h.ml)}${vt}</td>
      <td>${scr ? 'SCR' : `<b>${h.rank}</b><span class="s">${Math.round(h.win_prob * 100)}%</span>`}</td>
      ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `<td>${c(i)}</td>`).join('')}
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
    <div class="info"><div class="title">${esc(tc(r.gait))} · ${esc(tc(r.distance || '1 Mile'))} · ${money(r.purse)}</div>
      <div class="meta">${[r.post_time ? `Post ${esc(r.post_time)}` : '', r.cr != null ? `Class rating ${r.cr}` : '', `${r.ranked.length} starters`].filter(Boolean).join(' · ')}</div>
      <div class="cond">${esc(r.conditions)}</div>${r.prog_notes && r.prog_notes.length ? `<div class="cond progn"><b>Program:</b> ${esc(r.prog_notes.join(' · '))}</div>` : ''}</div>
    <div class="conf"><div><span class="lbl">WINNER</span></div><div><span class="stars">${stars(r.confidence)}</span><b>${r.confidence}/5</b></div>
      <div><span class="lbl">UNDERCARD 2ND–5TH</span></div><div><span class="stars u">${stars(r.undercard)}</span><b>${r.undercard}/5</b></div></div>
  </div>`;
}
function projHtml(r) {
  const labels = ['WIN', '2ND', '3RD', '4TH', '5TH'];
  return `<div class="proj">${r.ranked.slice(0, 5).map((h, i) => `<div class="p ${i === 0 ? 'win' : i < 3 ? 't3' : ''}">
      <div class="lbl">${labels[i]}</div><div class="nm">#${h.pgm} ${esc(tc(h.name))}</div>
      <div class="od">ML ${esc(h.ml)}${h.live_dec != null ? ` · <b>live ${esc(oddsStr(h.live_dec))}</b>` : ''} · our line ${esc(h.line)} · ${Math.round(h.win_prob * 100)}%${h.value === 'good' ? ' · <b class="gv">GOOD VALUE</b>' : h.value === 'bad' ? ' · <b class="bv">BAD VALUE</b>' : ''}</div></div>`).join('')}</div>`;
}

function triTile(r) {
  const t = r.trifecta, ex = r.exacta, su = r.superfecta;
  if (t.type === 'N/A') return `<div class="bet"><div class="lbl">EXACTA &amp; TRIFECTA</div><div class="call faint">Field too small</div></div>`;
  const st = (x) => (x.conf ? `<span class="stars sm">${stars(x.conf)}</span> <b>${x.conf}/5</b>` : '');
  const pd = (S.st.played || {})[r.number] || {};
  const chk = (k) => `<label class="plchk"><input type="checkbox" data-played="${k}" data-n="${r.number}" ${pd[k] ? 'checked' : ''}> played</label>`;
  const line = (name, x) => `<div class="playrow"><div class="pl-h"><span class="lbl">${name} — ${x.type === 'KEY' ? 'KEY' : 'BOX'}</span><span class="pl-c">${st(x)} ${chk(name.toLowerCase())}</span></div>
    <div class="call">${x.type === 'KEY' ? 'Key' : 'Box'} ${esc(x.text)}</div>
    <div class="det">${x.combos} combos · ${dollars(x.cost)} at ${baseLabel(x.base)} · model hit ~${Math.round(x.hit * 100)}%</div></div>`;
  return `<div class="bet ${kind(t)} main">
    ${ex.type === 'N/A' ? '' : line('EXACTA', ex)}
    ${line('TRIFECTA', t)}
    <div class="det">${esc(t.strength)}${t.caution ? ' <b class="no">Low-confidence race — go light.</b>' : ''}</div>
    ${su.type === 'KEY' ? `<div class="exsup"><b>Super</b> Key ${esc(su.text)} <span class="faint">(${dollars(su.cost)})</span> ${chk('superfecta')}</div>` : ''}</div>`;
}
function valueTile(r) {
  const line = (p, good) => {
    const h = horseOf(r, p);
    return `<li class="${good ? 'g' : 'r'}"><b>#${h.pgm} ${esc(tc(h.name))}</b> ${r.live && h.live_dec != null ? 'live' : 'ML'} <b>${esc(r.live && h.live_dec != null ? oddsStr(h.live_dec) : h.ml.replace('/', '-'))}</b> · our line <b>${esc(h.line)}</b> <span class="faint">· ranked ${ord(h.rank)}</span></li>`;
  };
  const g = r.value.good, b = r.value.bad;
  return `<div class="bet valuebox"><div class="lbl">VALUE vs ${r.live ? 'LIVE ODDS' : 'MORNING LINE'}</div>
    ${g.length || b.length ? `<ul>${g.map((p) => line(p, true)).join('')}${b.map((p) => line(p, false)).join('')}</ul>
      <div class="det"><span class="gv">Good</span> = morning line much longer than our line · <span class="bv">Bad</span> = morning line much shorter than our line</div>`
    : '<div class="det">No big gaps between the numbers and the morning line in this race.</div>'}</div>`;
}
function longTile(r) {
  const L = r.longshots;
  const list = (bet, name) => {
    const x = L.filter((l) => (l.bet || 'tri') === bet);
    const pls = ((S.st.played || {})[r.number] || {}).ls || [];
    return x.length ? `<div class="lsgrp"><span class="lbl2">${name}</span><ul>${x.map((l) => `<li><label class="plchk"><input type="checkbox" data-played="ls" data-n="${r.number}" data-key="${esc((l.bet || 'tri') + ':' + l.text)}" ${pls.includes((l.bet || 'tri') + ':' + l.text) ? 'checked' : ''} aria-label="played"></label> <b>${esc(l.text)}</b> <span class="faint">${dollars(l.cost)}</span> <span class="det">· model ${pctP(l.hit, 1)} vs ${r.live ? 'odds' : 'ML'} ${pctP(l.market, l.market < 0.01 ? 2 : 1)} · ${esc(l.label)}</span></li>`).join('')}</ul></div>` : '';
  };
  return `<div class="bet longbox"><div class="lbl">LONGSHOTS — STRAIGHT TICKETS</div>
    ${L.length ? list('ex', 'Exactas') + list('tri', 'Trifectas') : '<div class="det">No live price horses to build longshot tickets around — nothing forced.</div>'}</div>`;
}
function betsHtml(r) {
  return `<div class="bets">${triTile(r)}${valueTile(r)}${longTile(r)}</div>`;
}

// shared by the race-page "Official order" selects and the all-races-at-once results grid
function resultOpts(r, scrSet, sel) {
  return `<option value="">—</option>` + r.horses.filter((h) => !scrSet.has(h.pgm)).map((h) => `<option ${+sel === h.pgm ? 'selected' : ''}>${h.pgm}</option>`).join('');
}
function renderRace(n) {
  const r = raceOf(n);
  if (!r) return `<p>Race not found. <a href="#/">Back to the card</a></p>`;
  const scrSet = new Set(S.st.scratches[n] || []);
  const res = S.st.results[n] || [];
  const opts = (sel) => resultOpts(r, scrSet, sel);
  const snap = S.st.snaps[n];
  let graded = '';
  if (snap && res.filter(Boolean).length) {
    const g = gradeRace(snap, res.filter(Boolean).map(Number));
    const mark = (v) => (v == null ? '<span class="faint">no play</span>' : v ? '<span class="ok">hit</span>' : '<span class="no">miss</span>');
    const ls = g.ls.length ? ` · Longshots <span class="${g.ls.some(Boolean) ? 'ok' : 'no'}">${g.ls.filter(Boolean).length}/${g.ls.length} hit</span>` : '';
    // v25 (Marshall): a KEY'd top pick has to win outright to count — 2nd/3rd is a miss, not partial "in the
    // money" credit. A BOX'd top pick still gets "in the money" short of an outright win. Matches the quick grid.
    const keyed = snap.plays.trifecta && snap.plays.trifecta.type === 'KEY';
    const pickStatus = g.win ? '<span class="ok">won</span>' : keyed ? '<span class="no">miss</span>' : g.itm ? '<span class="ok">in the money</span>' : '<span class="no">out</span>';
    graded = `<div class="graded">Pick #${snap.order[0]}: ${pickStatus} · Exacta ${mark(g.exacta)} · Trifecta ${mark(g.trifecta)} · Superfecta ${mark(g.superfecta)}${ls}</div>`;
  }
  return `
  <div class="racenav"><a class="btn small" href="#/">← Card</a>
    <div class="tabs">${S.card.races.map((x) => `<a href="#/race/${x.number}" class="${x.number === n ? 'on' : ''}">${x.number}</a>`).join('')}</div></div>
  ${tonightHtml()}
  <div id="raceTop">${raceTopHtml(r)}</div>
  <div class="tunebar"><button class="btn small ${S.tuneOpen ? 'primary' : ''}" data-act="tune" aria-expanded="${S.tuneOpen}">${S.tuneOpen ? 'Hide weights' : 'Tune weights'}</button><span id="wbadge">${weightsBadge()}</span>${r.base_parts && r.base_parts.length ? `<span class="note">Normal here: ${esc(r.base_parts.join(' · '))}</span>` : ''}</div>
  ${S.tuneOpen ? tuneHtml(true) : ''}
  <div id="raceBody">${raceBodyHtml(r)}</div>
  <div class="notes">
    <div class="panel"><h3>Notes — Race ${n}</h3><textarea data-notes="${n}" placeholder="Your notes for this race…">${esc(S.st.notes[n] || '')}</textarea></div>
    <div class="panel"><h3>Official order</h3><div class="order">
      ${['1st', '2nd', '3rd', '4th'].map((lbl, i) => `<label>${lbl}<select data-res="${n}" data-pos="${i}">${opts(res[i])}</select></label>`).join('')}
      </div>${graded || '<div class="graded note">Enter the result after the race to grade the picks and plays — or <a href="#/results">paste the whole card\'s results</a>.</div>'}</div>
  </div>
  <div class="lategrid">${drvHtml(r, scrSet)}${liveHtml(r, scrSet)}</div>
  <div class="racenav" style="margin-top:14px">${n > 1 ? `<a class="btn" href="#/race/${n - 1}">← Race ${n - 1}</a>` : '<span></span>'}${raceOf(n + 1) ? `<a class="btn primary" href="#/race/${n + 1}">Race ${n + 1} →</a>` : ''}</div>`;
}

function tripHtml(r) {
  const t = r.trip;
  if (!t) return '';
  const nm = (p) => { const h = horseOf(r, p); return h ? `<b>#${p}</b> ${esc(tc(h.name))}` : ''; };
  const cell = (lbl, p, hint) => (p == null ? '' : `<div class="tp"><span class="lbl">${lbl}</span><span class="who">${nm(p)}</span><span class="hint">${hint}</span></div>`);
  return `<div class="trip ${t.shape}"><div class="trip-h"><span class="lbl">WHO GETS THE TRIP</span><span class="shape">${esc(t.text)}</span></div>
    <div class="trip-g">${cell('LEADER', t.leader, t.shape === 'soft' ? 'best guess for the front' : 'projected on the front')}${cell('POCKET', t.pocket, 'sits second, saves ground')}${cell('FIRST-OVER', t.firstOver, 'contender who has to move first')}${cell('CLOSER WITH COVER', t.cover, 'best late kick behind the movers')}</div></div>`;
}
function drvHtml(r, scrSet) {
  const d = (S.st.drivers || {})[r.number] || {};
  const any = Object.keys(d).length > 0, all = cardDrivers();
  return `<details class="live" ${any ? 'open' : ''}><summary>Driver changes${any ? ` — ${Object.keys(d).length} in use` : ''}</summary>
    <p class="note">If the track announces a late driver change, pick the new driver and the race re-ranks with his numbers. The list is every driver on tonight's card.</p>
    <div class="livegrid wide">${r.horses.filter((h) => !scrSet.has(h.pgm)).map((h) => { const orig = (h._d0 || h).driver || ''; return `<label><span>#${h.pgm} <i>${esc(tc(orig))}</i></span><select data-drv="${r.number}" data-pgm="${h.pgm}"><option value="">as printed</option>${all.filter((x) => x.name !== orig).map((x) => `<option value="${esc(x.name)}" ${d[h.pgm] === x.name ? 'selected' : ''}>${esc(tc(x.name))}</option>`).join('')}</select></label>`; }).join('')}</div></details>`;
}
function liveHtml(r, scrSet) {
  const lv = (S.st.live || {})[r.number] || {};
  const any = Object.keys(lv).length > 0;
  return `<details class="live" ${any ? 'open' : ''}><summary>Live odds (optional)${any ? ' — in use for this race' : ''}</summary>
    <p class="note">Near post time, type the tote-board odds (5-2, 7/2 or just 9). The pick then leans on the live odds instead of the morning line, and the value box compares live odds to our line. Leave blank to keep the morning line.</p>
    <div class="livegrid">${r.horses.filter((h) => !scrSet.has(h.pgm)).map((h) => `<label><span>#${h.pgm} <i>${esc(h.ml || '')}</i></span><input data-live="${r.number}" data-pgm="${h.pgm}" inputmode="text" autocomplete="off" value="${lv[h.pgm] != null ? esc(oddsStr(lv[h.pgm])) : ''}" placeholder="—"></label>`).join('')}</div>
    ${any ? `<button class="btn small" data-act="live-clear" data-n="${r.number}">Clear live odds</button>` : ''}</details>`;
}
function parseOdds(t) {
  t = String(t || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!t) return null;
  if (t === 'even' || t === 'evn' || t === 'e') return 1;
  const m = t.match(/^(\d+(?:\.\d+)?)(?:[-\/:](\d+(?:\.\d+)?))?$/);
  if (!m) return null;
  const v = m[2] ? +m[1] / +m[2] : +m[1];
  return Number.isFinite(v) && v >= 0 && v < 1000 ? v : null;
}
function raceTopHtml(r) {
  const rk = r.ranked, t = r.trifecta, ex = r.exacta;
  const pin = rk.length >= 3 ? `<div class="pinbar"><b>R${r.number}</b> <span class="pk">${rk.slice(0, 4).map((h, i) => (i === 0 ? `<b>#${h.pgm}</b> ${Math.round(h.win_prob * 100)}%` : `#${h.pgm}`)).join(' · ')}</span><span class="pt">${ex.legs ? `Ex ${esc(tc(ex.type))} ${esc(ex.text)}` : ''}${t.legs ? ` · Tri ${esc(tc(t.type))} ${esc(t.text)}` : ''}</span></div>` : '';
  return `${bannerHtml(r)}${projHtml(r)}${betsHtml(r)}${tripHtml(r)}<div class="why">${whyHtml(r)}</div>${pin}`;
}
function raceBodyHtml(r) {
  const sorted = sortedHorses(r);
  const scrSet = new Set(S.st.scratches[r.number] || []);
  const hl = highlights(r);
  const v = S.prefs.view;
  return `<div class="toolbar">
    <div class="seg" role="group" aria-label="Sort horses"><button data-sort="pgm" class="${S.prefs.sort === 'pgm' ? 'on' : ''}">Program #</button><button data-sort="proj" class="${S.prefs.sort === 'proj' ? 'on' : ''}">Projected</button></div>
    <button class="btn small hexp" data-act="hexp">${S.prefs.expand === true ? 'Collapse all' : 'Expand all'}</button><span class="legend"><span class="hv best">best</span> <span class="hv mid">2nd-3rd</span> <span class="hv">4th-6th</span> <span class="hv worst">7th+</span> in each column</span>
    <div class="seg" role="group" aria-label="Layout"><button data-view="auto" class="${v === 'auto' ? 'on' : ''}">Auto</button><button data-view="cards" class="${v === 'cards' ? 'on' : ''}">Cards</button><button data-view="table" class="${v === 'table' ? 'on' : ''}">Table</button></div>
  </div>
  <div class="horses hview-cards ${v === 'auto' ? 'auto' : v === 'cards' ? 'force' : 'hide'}">${sorted.map((h) => horseCard(h, r, scrSet.has(h.pgm), hl)).join('')}</div>
  <div class="hview-table ${v === 'auto' ? 'auto' : v === 'table' ? 'force' : 'hide'}">${horseTable(r, sorted, scrSet)}</div>`;
}

// ---------------- multi-race tickets ----------------
const HARD_CAP = 10;
const budgetNow = () => (S.prefs.pickBudget === 10 ? 10 : 5);
function ticketFor(b, budget = budgetNow()) {
  const ps = S.st.picks[b.id] || {};
  const races = b.races.map((n) => raceOf(n));
  const fixed = {};
  for (const r of races) {
    const scr = new Set(S.st.scratches[r.number] || []);
    const sel = ps.legs && ps.legs[r.number] && ps.legs[r.number].filter((p) => !scr.has(p));
    if (sel && sel.length) fixed[r.number] = sel;
  }
  const base = ps.base ?? b.base;
  const t = buildMultiTicket(races, base, budget, fixed);
  const legs = t.legs.map((l) => ({ ...l, r: raceOf(l.n), custom: !!fixed[l.n] }));
  const fins = legs.map((l) => (S.st.results[l.n] || [])[0]);
  const graded = fins.every(Boolean) ? legs.every((l, i) => l.sel.includes(+fins[i])) : null;
  const edited = Object.keys(fixed).length > 0;
  return { ...t, b, legs, base, budget, graded, edited, over: t.cost > HARD_CAP + 1e-9, played: !!ps.played };
}
// The suggestion for the card: the $5 ticket, or the $10 version when only the bigger one is worth playing.
function pickPlan(b) {
  const t5 = ticketFor(b, 5);
  if (t5.edited) return { t: ticketFor(b, budgetNow()), alt: null };
  if (budgetNow() === 10) return { t: ticketFor(b, 10), alt: null };
  if (t5.verdict === 'PLAY') return { t: t5, alt: null };
  const t10 = ticketFor(b, 10);
  return { t: t5, alt: t10.verdict === 'PLAY' && t10.cost > t5.cost ? t10 : null };
}
function ticketLine(t) {
  return t.legs.map((l) => l.sel.join(',')).join(' / ');
}
function verdictPill(t) {
  return t.verdict === 'PLAY' ? '<span class="pill value">PLAY</span>' : '<span class="pill pass">PASS</span>';
}
function renderPicks() {
  if (!S.bets.length) return `<div class="cardhead"><div><h1>Pick 3/4/5 tickets</h1><div class="sub">This program doesn't list any multi-race wagers.</div></div></div>`;
  const bud = budgetNow();
  return `<div class="cardhead"><div><h1>Multi-race tickets</h1><div class="sub">${esc(S.card.track)} · ${esc(S.card.date)} · Built to stay at or under your budget. Only marked <b>PLAY</b> when there's a good-value horse to build around and a real chance to hit. Tap a horse to lock in your own leg.</div></div>
    <div class="seg" role="group" aria-label="Budget"><button data-pbudget="5" class="${bud === 5 ? 'on' : ''}">$5 target</button><button data-pbudget="10" class="${bud === 10 ? 'on' : ''}">Up to $10</button></div></div>
  ${S.bets.map((b) => {
    const { t, alt } = pickPlan(b);
    return `<div class="panel ticket ${t.verdict === 'PLAY' ? 'play' : ''}">
      <div class="t-head"><h3>${verdictPill(t)} ${esc(b.name)} · Races ${b.races[0]}–${b.races[b.races.length - 1]}</h3>
        <div class="t-sum"><b>${ticketLine(t)}</b><br>${t.combos} combo${t.combos > 1 ? 's' : ''} × <select data-pbase="${b.id}" aria-label="Base bet">${[0.1, 0.2, 0.5, 1, 2].map((x) => `<option value="${x}" ${x === t.base ? 'selected' : ''}>${baseLabel(x)}</option>`).join('')}</select> = <b class="${t.over ? 'no' : ''}">${dollars(t.cost)}</b> · model hit ~${pctP(t.hit, t.hit < 0.1 ? 1 : 0)}
        ${t.graded == null ? '' : t.graded ? ' · <span class="ok">HIT</span>' : ' · <span class="no">missed</span>'}</div></div>
      <div class="why-line">${t.verdict === 'PLAY' ? 'Play' : 'Pass'}: ${esc(t.why)}.${t.over ? ' <b class="no">Over your $10 limit — drop a horse.</b>' : ''}</div>
      <div class="row tpay"><label class="plchk"><input type="checkbox" data-tplayed="${b.id}" ${t.played ? 'checked' : ''}> played</label></div>
      ${alt ? `<div class="alt">At $10 it's a play: <b>${ticketLine(alt)}</b> — ${alt.combos} combos = ${dollars(alt.cost)}, model hit ~${pctP(alt.hit, 1)} (${esc(alt.why)}).</div>` : ''}
      ${t.legs.map((l) => `<div class="leg"><div class="leg-h"><a href="#/race/${l.n}"><b>R${l.n}</b></a> <span class="stars">${stars(l.r.confidence)}</span> <span class="muted">${l.sel.length === 1 ? 'single' : l.sel.length + ' horses'} · covers ${Math.round(l.cover * 100)}%${l.custom ? ' · locked by you' : ''}</span></div>
        <div class="chips">${l.r.ranked.map((h) => `<button class="chip ${l.sel.includes(h.pgm) ? 'on' : ''} ${h.value === 'good' ? 'gvc' : ''}" data-pick="${b.id}|${l.n}|${h.pgm}" aria-pressed="${l.sel.includes(h.pgm)}">#${h.pgm} <small>${Math.round(h.win_prob * 100)}% · ${esc(h.ml)}</small></button>`).join('')}</div></div>`).join('')}
      ${t.edited ? `<div class="row" style="margin-top:8px"><button class="btn small" data-preset-ticket="${b.id}">Back to suggested</button></div>` : ''}
    </div>`;
  }).join('')}
  <p class="note">Chips are in projected order with model win % and morning line. Green-outlined = good value. Covers = the model's combined win chance for the horses in that leg. Legs you lock stay as you set them; the rest fill in within the budget.</p>`;
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
  const marks = [...clean.matchAll(/(?:^|\n|\s)(?:race|r)\s*#?\s*[:.]?\s*(\d{1,2})\b|(?:^|\n)\s*(\d{1,2})(?:st|nd|rd|th)\s+race\b/gi)];
  for (let i = 0; i < marks.length; i++) {
    const n = +(marks[i][1] || marks[i][2]);
    if (out[n] && out[n].how === 'typed order') continue;
    const block = clean.slice(marks[i].index, i + 1 < marks.length ? marks[i + 1].index : clean.length);
    const r = card.races.find((x) => x.number === n);
    if (!r) continue;
    let got = null;
    const ofm = block.match(/(?:order of finish|official order|finish order|finish)\s*[:\-]?\s*(\d{1,2}(?:\s*[-\/,]\s*\d{1,2}){1,4})/i);
    if (ofm) got = { order: valid(n, ofm[1].split(/[^\d]+/)), how: 'order of finish' };
    // a results-chart table: "PRG  Runner  Win  Place  Show", one row per finisher, in order
    if (!got || !got.order) {
      const rows = [];
      for (const line of block.split('\n')) {
        const t = line.trim();
        if (!t || /exotics|pick\s*(three|four|five|six|3|4|5|6)/i.test(t)) { if (rows.length) break; else continue; }
        const row = t.match(/^(\d{1,2})\s+[A-Za-z][A-Za-z0-9'.\- ]{1,30}?\s*(?:\$?\s*[\d,]+\.\d{2}\s*){0,4}$/);
        if (row) rows.push(+row[1]);
      }
      if (rows.length >= 2) got = { order: valid(n, rows), how: 'results chart (win/place/show)' };
    }
    if (!got || !got.order) {
      let bestExotic = null;
      for (const m of block.matchAll(/(high\s*5|pent(?:afecta)?(?:\/str\s*fl)?|superfecta|trifecta|exacta)[^\n\d$]*?(\d{1,2}(?:\s*[-\/]\s*\d{1,2}){1,4})/gi)) {
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
const SIZEW = { three: 3, 3: 3, four: 4, 4: 4, five: 5, 5: 5, six: 6, 6: 6 };
// v24: every race's 1st-4th dropdowns on one screen, so you never have to open a race page or scroll to grade a card.
function quickResultsGrid() {
  const rows = S.card.races.map((r) => {
    const n = r.number;
    const scrSet = new Set(S.st.scratches[n] || []);
    const res = S.st.results[n] || [];
    const snap = S.st.snaps[n];
    let status = '<span class="faint">—</span>', tix = '<span class="faint">—</span>';
    if (snap && res.filter(Boolean).length) {
      const g = gradeRace(snap, res.filter(Boolean).map(Number));
      // v25 (Marshall): a KEY'd top pick has to win outright to count — finishing 2nd or 3rd is a miss, not
      // partial "in the money" credit. A BOX'd top pick still gets "in the money" short of an outright win.
      const keyed = snap.plays.trifecta && snap.plays.trifecta.type === 'KEY';
      status = g.win ? '<span class="ok">won</span>'
        : keyed ? '<span class="no">miss</span>'
        : g.itm ? '<span class="ok">in the money</span>'
        : '<span class="no">out</span>';
      // Exacta/trifecta hit already means "KEY'd horse won outright" / "BOX'd horses landed in any order" —
      // legsHit() enforces that distinction, this just surfaces it as a quick green/red read.
      const pill = (hit) => (hit == null ? '<span class="faint">—</span>' : hit ? '<span class="ok">hit</span>' : '<span class="no">miss</span>');
      tix = `${pill(g.exacta)} / ${pill(g.trifecta)}`;
    }
    return `<tr><td><a href="#/race/${n}"><b>${n}</b></a></td><td class="muted">${esc(r.post_time || '')}<br>${esc(tc(r.gait))}</td>
      ${['1st', '2nd', '3rd', '4th'].map((lbl, i) => `<td><select data-res="${n}" data-pos="${i}" aria-label="Race ${n} ${lbl}">${resultOpts(r, scrSet, res[i])}</select></td>`).join('')}
      <td>${status}</td><td>${tix}</td></tr>`;
  }).join('');
  return `<div class="panel"><h3>All races</h3><p class="note">Pick the finishing order for each race — grades instantly, no need to open the race page. "Ex / Tri" is hit/miss on the ticket we actually called (KEY needs that horse to win outright; BOX just needs the boxed horses to land, any order).</p>
    <div class="htable-wrap"><table class="rec quickres"><thead><tr><th>Race</th><th>Post</th><th>1st</th><th>2nd</th><th>3rd</th><th>4th</th><th>Result</th><th>Ex / Tri</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
function renderResults() {
  const p = S.pasted;
  return `<div class="cardhead"><div><h1>Enter results</h1><div class="sub">${esc(S.card.track)} · ${esc(S.card.date)} · Pick finishing order below, or paste a results chart.</div></div></div>
  ${quickResultsGrid()}
  <div class="panel" style="margin-top:12px"><h3>Paste results</h3>
    <textarea id="pasteBox" placeholder="Paste anything with the results, e.g. the results page text — or type one race per line like:&#10;1: 3-8-7-2&#10;2: 4-3-5-1">${esc(p ? p.text : '')}</textarea>
    <div class="row" style="margin-top:8px"><button class="btn primary" data-act="parse-results">Read results</button><span class="note">Picks up "order of finish", finish lines or horse names in finishing order.</span></div>
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
  syncGradedRace(n);
}
// push one graded race's model-view + official finish to the shared pool (see js/sync.js). Fire-and-forget: never
// blocks the save, and failures are silent — the race stays graded locally exactly as it always has.
function poolRowFor(n, snap) {
  const meta = snap.meta || {};
  const dateStr = ymd(meta.date ?? S.today);
  const trackKey = normKey(meta.track || (S.card && S.card.track) || '');
  if (!trackKey || !dateStr || !snap.feat || !S.st.results[n]) return null;
  // v22 (#50/#51): each horse's post number rides along as a 3rd array element so the pool can validate/replace
  // the typical post-index table and build cross-night Trends — no schema change, `entries` is already jsonb,
  // and anything reading these rows as plain [pgm, feat] pairs (poolRowToLearnRow, the learner) is unaffected.
  const pn = new Map(snap.pn || []);
  const entries = snap.feat.map(([pgm, f]) => [pgm, f, pn.get(pgm) ?? pgm]);
  return { track_key: trackKey, race_date: dateStr, race_no: n, gait: meta.gait || null, track_size: meta.size ?? null, entries, finish: firstRun(S.st.results[n]) };
}
// post number for one pool/local entry: new rows carry it as a 3rd element, older rows fall back to program number
const entryPost = (e) => (e.length > 2 && e[2] != null ? e[2] : e[0]);
function syncGradedRace(n) {
  const snap = S.st.snaps && S.st.snaps[n];
  if (!snap) return;
  const row = poolRowFor(n, snap);
  if (!row || !row.finish.length) return;
  pushToPool(row).then(renderPoolStatusEl);
}
function renderPoolStatusEl() {
  const el = $('#poolStatus'); if (el) el.textContent = poolStatusLine();
  renderLearnStatus();
}

// ---------------- render: record ----------------
function summarize(rows, onlyPlayed = false) {
  const by = {};
  for (let c = 5; c >= 1; c--) {
    const g = rows.filter((x) => x.conf === c);
    if (g.length) by[c] = { n: g.length, w: g.filter((x) => x.win).length, itm: g.filter((x) => x.itm).length };
  }
  const tot = (list, hitOf, costOf) => ({ n: list.length, hit: list.filter(hitOf).length, cost: list.reduce((a, x) => a + costOf(x), 0) });
  const plays = {};
  for (const k of ['exacta', 'trifecta', 'superfecta']) {
    const g = rows.filter((x) => x[k] != null && (!onlyPlayed || (x.pl && x.pl[k])));
    plays[k] = tot(g, (x) => x[k], (x) => x[k + '_cost']);
  }
  const winbet = tot(rows, (x) => x.win, () => 2);
  const ls = {};
  for (const kind of ['exacta', 'top', 'third', 'straight']) {
    const t = rows.flatMap((x) => (x.lsT || []).filter((y) => y.kind === kind && (!onlyPlayed || y.pl)));
    ls[kind] = tot(t, (y) => y.hit, (y) => y.cost);
  }
  const CB = [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 1.01]];
  const cal = CB.map(([lo, hi]) => { const g = rows.flatMap((x) => x.cal || []).filter(([pr]) => pr >= lo && pr < hi); return { lo, hi, n: g.length, exp: g.reduce((a, [pr]) => a + pr, 0), w: g.filter(([, w]) => w).length }; });
  const sum = (k) => rows.reduce((a, x) => a + (x[k] || 0), 0);
  const val = {
    good: { n: sum('good'), w: sum('good_w'), itm: sum('good_itm'), mlexp: sum('good_mlexp') },
    bad: { n: sum('bad'), w: sum('bad_w'), itm: sum('bad_itm'), mlexp: sum('bad_mlexp') },
  };
  const band = (ml) => (ml == null ? null : ml < 2 ? 0 : ml < 4 ? 1 : ml < 8 ? 2 : 3);
  const bands = BANDS.map(() => ({ n: 0, w: 0, itm: 0, exp: 0, gn: 0, gw: 0, gitm: 0 }));
  for (const x of rows) {
    const b = x.top ? band(x.top.ml) : null;
    if (b != null) { const B = bands[b]; B.n++; B.w += x.win ? 1 : 0; B.itm += x.itm ? 1 : 0; B.exp += x.top.p || 0; }
    for (const g of x.gv || []) { const gb = band(g.ml); if (gb != null) { bands[gb].gn++; bands[gb].gw += g.w ? 1 : 0; bands[gb].gitm += g.itm ? 1 : 0; } }
  }
  return { by, plays, ls, val, bands, winbet, cal, onlyPlayed, n: rows.length, w: rows.filter((x) => x.win).length };
}
const BANDS = ['Under 2-1', '2-1 to 7-2', '4-1 to 7-1', '8-1 and up'];
const LS_LABEL = { exacta: 'Longshot exactas', top: 'Value horse on top (older cards)', third: 'Value horse to run 3rd (older cards)', straight: 'Longshot trifectas' };
function recordTables(sum, rows) {
  const conf = Object.entries(sum.by).sort((a, b) => b[0] - a[0]).map(([c, v]) => `<tr><td><span class="stars">${stars(+c)}</span> ${c}/5</td><td>${v.w}/${v.n}</td><td>${Math.round((100 * v.w) / v.n)}%</td><td>${v.itm}/${v.n}</td></tr>`).join('');
  const label = { exacta: 'Exacta', trifecta: 'Trifecta', superfecta: 'Superfecta' };
  const prow = (name, v, cls = '') => `<tr class="${cls}"><td>${name}</td><td>${v.hit}/${v.n}</td><td>${v.n ? Math.round((100 * v.hit) / v.n) + '%' : '—'}</td><td>${dollars(v.cost)}</td></tr>`;
  const add = (a, v) => ({ n: a.n + v.n, hit: a.hit + v.hit, cost: a.cost + v.cost });
  const zero = { n: 0, hit: 0, cost: 0 };
  const mainAll = Object.values(sum.plays).reduce(add, zero);
  const plays = Object.entries(sum.plays).map(([k, v]) => prow(label[k], v)).join('') + prow('All main plays', mainAll, 'tot');
  const lsAll = Object.values(sum.ls).reduce(add, zero);
  const lsRows = Object.entries(sum.ls).filter(([k, v]) => v.n || k === 'exacta' || k === 'straight').map(([k, v]) => prow(LS_LABEL[k], v)).join('') + prow('All longshots', lsAll, 'tot');
  const vr = (lbl, v, cls) => `<tr><td><span class="${cls}">${lbl}</span></td><td>${v.n}</td><td>${v.w}</td><td>${v.mlexp ? v.mlexp.toFixed(1) : '—'}</td><td>${v.itm} (${v.n ? Math.round((100 * v.itm) / v.n) : 0}%)</td></tr>`;
  const tix = (rows || []).flatMap((x) => (x.lsT || []).filter((y) => !sum.onlyPlayed || y.pl).map((y) => ({ race: x.race, ...y })));
  const th = '<thead><tr><th>Bet</th><th>Hit</th><th>Hit %</th><th>Wagered</th></tr></thead>';
  const calAny = sum.cal.some((c) => c.n);
  return `<div class="grid2">
    <div class="panel"><h3>Winners by confidence</h3><table class="rec"><thead><tr><th>Confidence</th><th>Won</th><th>Win %</th><th>In the money</th></tr></thead><tbody>${conf || '<tr><td colspan="4" class="muted">No graded races yet</td></tr>'}</tbody></table>
      <table class="rec" style="margin-top:8px">${th}<tbody>${prow('Top pick, $2 to win', sum.winbet)}</tbody></table></div>
    <div class="panel"><h3>Main plays${sum.onlyPlayed ? ' — played' : ''}</h3><table class="rec">${th}<tbody>${plays}</tbody></table>
      <p class="note">Wagered is at the program's base amount.</p></div>
    <div class="panel"><h3>Longshots${sum.onlyPlayed ? ' — played' : ''}</h3><table class="rec">${th}<tbody>${lsRows}</tbody></table>
      ${tix.length ? `<details><summary class="note">Every graded longshot ticket (${tix.length})</summary><table class="rec small"><tbody>${tix.map((y) => `<tr><td>R${y.race}</td><td><b>${esc(y.text)}</b></td><td class="muted">${LS_LABEL[y.kind]}</td><td>${dollars(y.cost)}</td><td>${y.hit ? '<span class="ok">hit</span>' : '<span class="no">miss</span>'}</td></tr>`).join('')}</tbody></table></details>` : ''}</div>
    <div class="panel"><h3>Value horses</h3><table class="rec"><thead><tr><th>Flag</th><th>Horses</th><th>Won</th><th>ML says</th><th>In the money</th></tr></thead><tbody>${vr('Good value', sum.val.good, 'gv')}${vr('Bad value', sum.val.bad, 'bv')}</tbody></table>
      <p class="note"><b>ML says</b> = how many wins the morning line expects from those horses. Good value is working when <b>Won</b> beats it; bad value is working when <b>Won</b> falls short of it.</p></div>
    <div class="panel"><h3>By morning-line price</h3><table class="rec"><thead><tr><th>ML price</th><th>Top picks won</th><th>We expected</th><th>Good-value horses won</th><th>…in the money</th></tr></thead><tbody>${sum.bands.map((b, i) => `<tr><td style="white-space:nowrap">${BANDS[i]}</td><td>${b.n ? `${b.w}/${b.n} (${Math.round((100 * b.w) / b.n)}%)` : '—'}</td><td>${b.n ? b.exp.toFixed(1) : '—'}</td><td>${b.gn ? `${b.gw}/${b.gn}` : '—'}</td><td>${b.gn ? `${b.gitm}/${b.gn}` : '—'}</td></tr>`).join('')}</tbody></table>
      <p class="note">If top picks at 4-1 and up win more than <b>We expected</b>, lean into prices; if they fall short, stick to the shorter ones. Tracked from Version 17 on.</p></div>
    <div class="panel"><h3>Are the win chances honest?</h3><table class="rec"><thead><tr><th>We said</th><th>Horses</th><th>Should win</th><th>Did win</th></tr></thead><tbody>${calAny ? sum.cal.map((c) => `<tr><td>${Math.round(c.lo * 100)}${c.hi > 1 ? '%+' : `–${Math.round(c.hi * 100)}%`}</td><td>${c.n}</td><td>${c.n ? c.exp.toFixed(1) : '—'}</td><td>${c.n ? c.w : '—'}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">Fills in as you grade races (Version 18 on)</td></tr>'}</tbody></table>
      <p class="note">Every horse in every graded race, grouped by the win chance we gave it. <b>Did win</b> should track <b>Should win</b>; if the 30%+ row keeps falling short, the keys are too confident.</p></div></div>`;
}
function recordChart(per) {
  const pts = per.map(([v, rows]) => ({ lbl: `${(v.track || '').split(' ')[0]} ${String(v.date || '').replace(/^\w+,\s*/, '').replace(/,\s*\d{4}$/, '')}`, n: rows.length, w: rows.filter((x) => x.win).length, t: Date.parse(String(v.date || '').replace(/^\w+,\s*/, '')) || 0 }))
    .sort((a, b) => a.t - b.t).slice(-16);
  if (pts.length < 2) return '';
  const W = 720, H = 190, pad = 34, bw = Math.min(46, (W - 2 * pad) / pts.length - 8);
  const y = (v) => H - 44 - v * (H - 70);
  const bars = pts.map((p, i) => { const x = pad + (i + 0.5) * ((W - 2 * pad) / pts.length), r = p.n ? p.w / p.n : 0;
    return `<rect x="${(x - bw / 2).toFixed(1)}" y="${y(r).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - 44 - y(r)).toFixed(1)}" rx="3" fill="#5a7bb0"><title>${esc(p.lbl)}: ${p.w} of ${p.n}</title></rect>
      <text x="${x.toFixed(1)}" y="${(y(r) - 4).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#1b2230">${p.w}/${p.n}</text>
      <text x="${x.toFixed(1)}" y="${H - 28}" text-anchor="middle" font-size="9.5" fill="#5b6577">${esc(p.lbl.split(' ')[0].slice(0, 9))}</text><text x="${x.toFixed(1)}" y="${H - 16}" text-anchor="middle" font-size="9.5" fill="#8a93a3">${esc(p.lbl.split(' ').slice(1).join(' '))}</text>`; }).join('');
  const grid = [0.25, 0.5].map((g) => `<line x1="${pad}" x2="${W - pad}" y1="${y(g)}" y2="${y(g)}" stroke="#d9dee7" stroke-dasharray="3 3"/><text x="${pad - 4}" y="${y(g) + 3}" text-anchor="end" font-size="10" fill="#8a93a3">${g * 100}%</text>`).join('');
  return `<div class="panel" style="margin-top:12px"><h3>Top picks that won, card by card</h3><svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;height:auto" role="img" aria-label="Top-pick winners by card">${grid}<line x1="${pad}" x2="${W - pad}" y1="${H - 44}" y2="${H - 44}" stroke="#8a93a3"/>${bars}</svg></div>`;
}
function renderRecord() {
  const cur = S.key ? gradedRows(S.st) : [];
  const cards = LS.get(CARDS_KEY, {});
  const all = [], per = [];
  for (const [k, st] of allStates()) {
    const rows = gradedRows(st);
    if (rows.length) { all.push(...rows); per.push([cards[k] || { track: k.split('|')[0], date: k.split('|')[1] || '' }, rows, st]); }
  }
  const tab = S.key && S.prefs.recTab !== 'all' ? 'card' : 'all';
  const op = !!S.prefs.recPlayed;
  const tickets = S.key ? S.bets.map((b) => pickPlan(b).t).filter((t) => t.graded != null && (!op || t.played)) : [];
  const rows = tab === 'card' ? cur : all;
  return `
  <div class="cardhead"><div><h1>Record</h1><div class="sub">Graded from the official orders you enter. Kept in this browser.</div></div>
    <div class="row">${S.key ? '<a class="btn small primary" href="#/results">Enter results</a>' : ''}<button class="btn small" data-act="export">Export record</button><label class="btn small">Import<input type="file" accept=".json,application/json" data-act="import" hidden></label></div></div>
  <div class="toolbar"><div class="seg" role="group" aria-label="Which results">${S.key ? `<button data-rectab="card" class="${tab === 'card' ? 'on' : ''}">This card · ${cur.length}</button>` : ''}<button data-rectab="all" class="${tab === 'all' ? 'on' : ''}">All cards · ${all.length}</button></div>
    <div class="seg" role="group" aria-label="Which bets"><button data-recplayed="0" class="${op ? '' : 'on'}">Every suggested bet</button><button data-recplayed="1" class="${op ? 'on' : ''}">Only bets I played</button></div></div>
  ${op ? '<p class="note">Showing only tickets you ticked <b>played</b> on the race pages (or with “Mark these as played” on the bet slip).</p>' : ''}
  ${recordTables(summarize(rows, op), rows)}
  ${tab === 'card' && tickets.length ? `<div class="panel" style="margin-top:12px"><h3>Multi-race tickets${op ? ' — played' : ''}</h3><table class="rec"><thead><tr><th>Ticket</th><th>Call</th><th>Used</th><th>Cost</th><th>Result</th></tr></thead><tbody>${tickets.map((t) => `<tr><td>${esc(t.b.name)} R${t.b.races[0]}–${t.b.races[t.b.races.length - 1]}</td><td>${verdictPill(t)}</td><td>${ticketLine(t)}</td><td>${dollars(t.cost)}</td><td>${t.graded ? '<span class="ok">hit</span>' : '<span class="no">miss</span>'}</td></tr>`).join('')}</tbody></table></div>` : ''}
  ${tab === 'all' ? recordChart(per) : ''}
  ${tab === 'all' && per.length ? `<div class="panel" style="margin-top:12px"><h3>Cards</h3><table class="rec"><thead><tr><th>Card</th><th>Graded</th><th>Winners</th></tr></thead><tbody>${per.map(([v, rows]) => `<tr><td>${esc(v.track)} · ${esc(v.date)}</td><td>${rows.length}</td><td>${rows.filter((x) => x.win).length}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

// ---------------- weight suggestions ----------------
const MIN_RACES = 30, GOOD_RACES = 100;
function trainingRows(track = null) {
  const rows = [];
  for (const [key, st] of allStates()) {
    const t = key.split('|')[0];
    if (track && t !== track) continue;
    const dateStr = ymd(cardDate({ date: key.split('|')[1] }));
    for (const [rn, fin] of Object.entries(st.results || {})) {
      const snap = st.snaps && st.snaps[rn];
      const w = (fin || []).find(Boolean);
      if (!snap || !snap.feat || !w || !snap.feat.some(([p]) => p === w)) continue;
      // v22: pn + key let callers (trackPoolMerge) dedupe a local race already present in the shared pool
      rows.push({ feat: snap.feat, win: w, pn: snap.pn, key: dateStr ? poolKeyFor(normKey(t), dateStr, +rn) : null });
    }
  }
  return rows;
}
function evalMult(rows, mult) {
  let ll = 0, hits = 0;
  for (const r of rows) {
    let best = -Infinity, bestP = null, sw = 0;
    const sc = r.feat.map(([p, f]) => { const s = linearScore(f, mult) / TEMP; if (s > best) { best = s; bestP = p; } if (p === r.win) sw = s; return s; });
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
function runSuggestion(track = null) {
  const rows = trainingRows(track);
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
function profilesHtml() {
  const counts = {};
  for (const [key, st] of allStates()) {
    const t = key.split('|')[0];
    for (const [rn, fin] of Object.entries(st.results || {})) if ((fin || []).some(Boolean) && st.snaps && st.snaps[rn] && st.snaps[rn].feat) counts[t] = (counts[t] || 0) + 1;
  }
  const profs = LS.get(PROFILE_KEY, {});
  const tracks = [...new Set([...Object.keys(counts), ...Object.keys(profs), ...(S.card ? [S.card.track] : [])])].filter(Boolean).sort();
  const rows = tracks.map((t) => {
    const n = counts[t] || 0, p = profs[t];
    const diff = p ? customList({ ...DEFAULT_MULT, ...p.mult }) : [];
    return `<tr><td><b>${esc(t)}</b></td><td>${n} graded</td>
      <td>${p ? (diff.length ? diff.map(([l, x]) => `<span class="pill ${x > 1 ? 'value' : 'badv'}">${esc(l)} ${multText(x)}</span>`).join(' ') : 'normal weights') : '<span class="muted">—</span>'}${p ? ` <span class="note">· ${p.hits} vs ${p.base} winners · ${p.better ? (p.n >= AUTO_PROFILE ? '<b class="gv">auto-on</b>' : `beats normal — auto-on at ${AUTO_PROFILE}`) : 'not better than normal yet'}</span>` : ''}</td>
      <td>${n >= MIN_RACES ? `<button class="btn small" data-learn="${esc(t)}">${p ? 'Re-learn' : 'Learn this track'}</button>` : `<span class="note">needs ${MIN_RACES - n} more</span>`}${p ? ` <button class="btn small" data-unlearn="${esc(t)}">Clear</button>` : ''}</td></tr>`;
  }).join('');
  return `<div class="panel"><h3>Track profiles</h3>
    <p class="note">Each track gets its own learned weights from the races you've graded there (${MIN_RACES}+ races to start, 100+ to trust). When on, a card from that track uses its profile instead of your general weights.</p>
    <p class="note">A profile switches on by itself once its track has ${AUTO_PROFILE}+ graded races and it beats normal weights on races it hadn't seen (re-learned every 10 new races).</p>
    <label class="row note"><input type="checkbox" data-act="toggle-profiles" ${S.prefs.useProfiles ? 'checked' : ''}> Use every learned profile now, even under ${AUTO_PROFILE} races</label>
    <table class="rec"><thead><tr><th>Track</th><th>Results</th><th>Profile</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">No graded races yet.</td></tr>'}</tbody></table>
    <p class="note" id="learnOut"></p></div>`;
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

// ---------------- render: track book ----------------
const PLAYS_TEXT = { speed: 'Plays fast (speed)', closers: 'Fair to closers', size: 'Plays to its size' };
function renderTracks() {
  const books = LS.get(TRACKS_KEY, {});
  const names = [...new Set([...Object.keys(books), ...(S.card ? [S.card.track] : [])])].filter(Boolean).sort();
  const rows = names.map((name) => {
    const b = bookFor(name), code = b.code || '', info = TRACK_INFO[code] || {};
    const size = b.size ?? info.size, sl = SIZE_LABEL[size] || '—';
    const auto = info.plays ? PLAYS_TEXT[info.plays] : PLAYS_TEXT.size;
    const sel = `<select data-plays="${esc(name)}" aria-label="How ${esc(name)} plays">
      <option value="auto" ${!b.plays || b.plays === 'auto' ? 'selected' : ''}>Research: ${esc(auto)}</option>
      ${['size', 'speed', 'closers'].map((k) => `<option value="${k}" ${b.plays === k ? 'selected' : ''}>${PLAYS_TEXT[k]}</option>`).join('')}</select>`;
    // post table this track uses right now, posts 1-10
    const st = b.res_post ? b.res_post.starts.reduce((a, x) => a + x, 0) : 0;
    const gen = GENERIC_POST[size] || GENERIC_POST[0.625];
    let src, idx;
    if (b.post_tm) { src = `program table (${esc(b.post_tm.date || '')})`; idx = b.post_tm.fast.win.map((v, i) => (b.post_tm.fast.starts && !(b.post_tm.fast.starts[i] > 50) ? null : v)); }
    else {
      const w = b.res_post, avg = w && st ? w.wins.reduce((a, x) => a + x, 0) / st : 0;
      idx = gen.map((g, i) => { const n = w && w.starts[i] || 0; if (!n || !avg) return g; const k = n / (n + 150); return k * 100 * ((w.wins[i] || 0) / n / avg - 1) + (1 - k) * g; });
      src = st ? `typical ${sl} blended with your results (${b.n} races)` : `typical ${sl} (estimate)`;
    }
    if (b.has_rating && !b.post_tm) src = `the program's post rating for each horse (Trackmaster) — typical ${sl} shown for reference`;
    const posts = idx.slice(0, 10).map((v, i) => (v == null ? `<span class="pp muted">${i + 1}: —</span>` : `<span class="pp ${v >= 20 ? 'gv' : v <= -20 ? 'bv' : ''}">${i + 1}: ${v > 0 ? '+' : ''}${Math.round(v)}</span>`)).join(' ');
    const learn = b.n ? `${b.n} graded · winners with top-3 early speed ${Math.round(100 * b.early3)}% · top-3 closing ${Math.round(100 * b.close3)}%${b.suggest ? ` → <b>${PLAYS_TEXT[b.suggest]}</b>${b.plays !== b.suggest ? ` <button class="btn small" data-setplays="${esc(name)}|${b.suggest}">Use</button>` : ''}` : ` <span class="note">(suggestion at 30)</span>`}` : '<span class="muted">No results entered yet</span>';
    return `<tr><td><b>${esc(name)}</b><br><span class="note">${esc(code)} · ${Object.keys(b.cards || {}).length} program${Object.keys(b.cards || {}).length === 1 ? '' : 's'}</span></td>
      <td>${sl}</td><td>${sel}${info.note ? `<div class="note">${esc(info.note)}</div>` : ''}</td>
      <td><div class="note">${src}</div><div class="pps">${posts}</div></td><td>${learn}</td></tr>`;
  }).join('');
  return `<div class="cardhead"><div><h1>Track book</h1><div class="sub">What the site knows about each track — it builds as you load programs and enter results. Stored in this browser; Export record on the Record page carries it to another device.</div></div></div>
  <div class="panel"><table class="rec tracks"><thead><tr><th>Track</th><th>Size</th><th>Plays like</th><th>Post index (% vs an average post)</th><th>From your results</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="5" class="muted">Load a program to start.</td></tr>'}</tbody></table>
  <p class="note">Post index: a program's own post table always wins. Otherwise the site uses the last table it saw for that track, then your results (blended in — 150 starts from a post counts half), then a typical table for the track size. "Plays like" starts from published handicapping research; once a track has 30+ graded races the site compares winners' early speed vs closing speed and suggests a setting.</p></div>`;
}

// ---------------- render: settings ----------------
function methodHtml() {
  const wt = Object.entries(DEFAULT_WEIGHTS).map(([k, v]) => `${WEIGHT_LABELS[k].toLowerCase()} ${v}`).join(', ');
  return `<div class="panel method"><h3>How the numbers are built</h3>
  <p><b>Mile-adjusted times (*)</b>: every time is converted to a mile-track equivalent (half-mile −2.0s, ⅝ −1.0s, ⅞ −0.4s; quarters get ¼ of that), then corrected for the program's track variant (0.2s per point, capped at ±1.6s), which also covers off tracks.</p>
  <p><b>Track normal</b>: "Normal" changes with the race. Half-mile tracks count early speed 1.75× and closing 0.6× (leavers, pocket and first-over horses win most there); ⅝ tracks early 1.25×, closing 0.9×; ⅞ early 0.9×, closing 1.25×; mile tracks early 0.75×, closing 1.5×. Trotters count their opening ¼ more (1.1×) and closing, form, class and post a little more too; pacers count their closing ¼ more (1.1×). A track that plays fast or fair to closers tilts it further (Track book), and Dec–Mar cards lean slightly toward closers. Your own settings multiply on top.</p>
  <p><b>Avg mark</b>: average final time over the last 4 starts, throwing out breaks, parked-out trips (3-wide at any call or first-over at 3+ calls), qualifiers and DNFs — only races from the last 120 days when there are any.</p>
  <p><b>Open ¼</b>: estimated time at the first quarter (leader's quarter + 0.2s per length behind) and average position there. <b>Close ¼</b>: the horse's own last quarter. <b>¾→Fin</b>: average spots gained or lost from the 3/4 call to the wire. <b>Avg fin L3</b>: average finish over the last 3 real starts — this is also what the Form score now uses (v27: was the last 4). <b>Speed</b> is one number: average speed rating 55%, average adjusted mile 25%, best rating 20%, last 4 clean starts. <b>Beaten lengths</b>, <b>last-start odds</b>, <b>days since last start</b> (7–21 best) and <b>track-size fit</b> (speed ratings on today's size vs his other sizes) also count.</p>
  <p><b>Post position</b> uses the track's real win rate from each post — the program's post table when it has one (fast or off, blended 75/25 with the last 30 days), else the horse's post rating, else the last table saved for that track, else a typical table for the size blended with your own results there. Half-mile: rail best, post 8 worst; ⅝: posts 4–5 best; ⅞ and mile: posts 5–6 best.</p>
  <p><b>Speed trend</b>: the slope of speed figures over the last 3–4 starts without a break — rising horses get credit, sliding ones lose it. <b>Hot / cold</b>: driver UDR and trainer UTR over the last 30 days vs the year. <b>Connections &amp; course</b>: the driver/trainer team's record together, the horse's record at this track, and a first or second start for a new barn (better or weaker trainer). <b>Off-track</b> (only when the track is set to Off): the horse's off-track record vs its overall record, plus the sire's off-track win rate. <b>Trotters</b>: breaks count over the last 10 lines (qualifiers too), a break last time adds more, and a trotter with no breaks in its last 6+ starts gets a pro.</p>
  <p><b>Woodbine / Standardbred Canada programs</b> (Mohawk, Georgian, Flamboro…): cover, ad and how-to-bet pages are skipped. They print only this year and last year, so the "Life" win % and top-3 % are those two seasons (the lifetime mark and earnings are the real ones). Speed figures are built from the time like USTA programs. The program's own winning-post-position table (pace and trot separately), "Who's hot" drivers (last 20 days), driver/trainer combination stats and late driver changes are all read in.</p>
  <p><b>Standard USTA programs</b> (most tracks) don't print speed or class ratings, so speed figures are built from each mile time — adjusted for track size and the off-track variant, on the same scale as Trackmaster's ratings (within about ±5 points). Driver and trainer stats there are for the current meet, so small samples are pulled toward average.</p>
  <p> <b>TM ratings</b> (Power, Speed, Pace, Class) are TrackMaster's own numbers from Platinum programs; they're shown for reference and highlighted, but not scored.</p>
  <p><b>Green / red</b>: the best and worst number in the race for each column (marks compared mile-adjusted; win % needs 5+ lifetime or 3+ this-year starts).</p>
  <p><b>Class</b>: average class rating of the last 3 races versus today's, plus a circuit adjustment for shippers (Yonkers, the Meadowlands and Mohawk tougher; Vernon, Tioga, fairs softer).</p>
  <p><b>Added points</b>: lone speed +${ADJ.lone_speed}, closer with a hot pace +${ADJ.closer_setup}, driver upgrade +${ADJ.driver_up}/+${ADJ.driver_up_big}, tough trip that still finished close +${ADJ.tough_trip} each (max +${ADJ.tough_trip_cap}); speed duel ${ADJ.speed_duel}, driver downgrade ${ADJ.driver_down}. Penalties for breaks, layoffs, stale form and thin data.</p>
  <p><b>Winner confidence</b> blends the top pick's points margin with data quality. <b>Undercard</b> rates how often the projected 2nd–5th finish within one spot of projection in 40,000 simulated races.</p>
  <p><b>Exacta &amp; trifecta</b>: every race gets both. If the top pick is over 25% to win, KEY him — exacta over the next two, trifecta over the next three. Otherwise BOX — exacta the top two, trifecta the top three. Each ticket is rated out of 5 from the model's chance it hits (exacta 6.5% / 8% / 10% / 12.5% for 2–5 stars; trifecta 4% / 5% / 6.5% / 8.5%). A superfecta shows only when the trifecta is a key and the next two picks are each 14%+ to win.</p>
  <p><b>Longshots</b>: up to 3 straight exactas and 3 straight trifectas per race. Every horse on a ticket has to be live (top 60% of the field by our ranking, 5%+ to win, not flagged bad value), and each ticket needs a price horse — 5-1 or longer on the morning line that the numbers like at least as much as the line — and the ticket itself must be 25%+ more likely by our numbers than by the morning line. Tickets are mixed (different winners, price horse in different spots) but never padded with a weak horse; if a race has no live price horse it gets none.</p>
  <p><b>Value</b> (morning line vs our line): <span class="gv">good value</span> = ML at least 1.75× our line and 2+ points longer (ML 10-1, our line 5-1). <span class="bv">Bad value</span> = our line at least 2× the ML and 2+ points longer, on horses 8-1 or shorter (ML 5-1, our line 10-1). <b>Longshot trifectas</b> are built around the good-value horses: the tickets the model gives a real chance that the morning line prices much lower (model % vs ML %).</p>
  <p><b>Multi-race tickets</b> single a horse when he's 5/5 and 35%+ (or clears the style's coverage alone) and otherwise add horses in projected order until the leg covers 45% (tight), 60% (balanced) or 75% (wide) of the model's win chance.</p>
  <p><b>Opening speed</b> combines average position at the first quarter with the estimated opening-quarter time. Season and lifetime marks are shown but no longer scored — recent races say more.</p>
  <p><b>Default weights</b>: ${wt}. Your settings multiply these (2× doubles a weight, Off sets it to zero); the race-shape bonuses and penalties scale the same way. <b>Bold</b> pros and cons are the race-deciding ones.</p></div>`;
}
function renderSettings() {
  return `<div class="cardhead"><div><h1>Settings</h1><div class="sub">Put more or less weight on what you trust. Every race re-ranks with your settings, and they stay in this browser — a friend's phone keeps their own. <span id="wbadge2">${weightsBadge()}</span></div></div>
    <div class="row"><button class="btn small" data-act="reset-weights">Back to normal</button></div></div>
  <div class="panel" style="margin-top:12px"><h3>Look</h3>
    <div class="row"><div class="seg" role="group" aria-label="Theme">${[['light', 'Light'], ['dark', 'Dark'], ['auto', 'Auto']].map(([v, l]) => `<button data-themeset="${v}" class="${(S.prefs.theme || 'auto') === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <p class="note">Auto follows your phone or computer's own light/dark setting — handy for checking picks at the track after dark.</p></div>
  ${tuneHtml()}
  <div class="panel" style="margin-top:12px"><h3>Share your settings</h3>
    <div class="row"><label class="note" for="shareName">Your name (optional, shown to whoever opens the link)</label></div>
    <div class="row"><input id="shareName" class="txt" maxlength="24" value="${esc(S.prefs.shareName)}" placeholder="e.g. Marshall"><button class="btn primary" data-act="share">Copy share link</button></div>
    <p class="note" id="shareOut">Friends who open the link get asked whether to use your weights. Their own settings stay put unless they say yes.</p>
    <div class="row"><input id="pasteLink" class="txt" placeholder="Got a link from a friend? Paste it here"><button class="btn" data-act="use-link">Load their weights</button></div></div>
  <div class="panel" style="margin-top:12px"><h3>Email</h3>
    <div class="row"><label class="note" for="emailTo">Send-to address(es) for Email PDF — separate with commas (used when your browser opens an email draft)</label></div>
    <div class="row"><input id="emailTo" class="txt" type="email" multiple value="${esc(S.prefs.emailTo)}" placeholder="you@example.com, friend@example.com"><button class="btn" data-act="save-email">Save</button><span class="note" id="emailSaved"></span></div></div>
  <div class="panel" style="margin-top:12px"><h3>Morning line in the pick</h3>
    <div class="row"><div class="seg" role="group" aria-label="Morning line blend">${[[0, 'Off'], [20, 'Light'], [35, 'Normal'], [50, 'Heavy']].map(([v, l]) => `<button data-blend="${v}" class="${(S.prefs.mlBlend ?? 35) === v ? 'on' : ''}">${l}${v ? ` ${v}%` : ''}</button>`).join('')}</div></div>
    <p class="note">The line-maker sees things the past lines don't, so the ranking and the bets blend our numbers with the morning line. <b>Our line</b> and the Good / Bad value calls always stay our numbers alone — that's what makes them a second opinion.</p>
    <label class="row note" style="margin-top:10px"><input type="checkbox" data-act="toggle-livedrift" ${S.prefs.liveDrift === false ? '' : 'checked'}> Flag live-odds movement as a pro/con — once you've typed live odds in twice for a horse, a real drift from the first reading to the latest shows up as "Drifting" or "Taking money". Only shows up for a race once you've actually entered live odds there.</label></div>
  <div style="margin-top:12px">${learningHtml()}</div>
  <div style="margin-top:12px">${methodHtml()}</div>`;
}

// ---------------- share links ----------------
function shareUrl() {
  const w = Object.entries(S.mult).filter(([, v]) => v !== 1).map(([k, v]) => `${k}:${v}`).join(',');
  const q = new URLSearchParams();
  q.set('w', w || 'normal');
  if (S.prefs.shareName) q.set('n', S.prefs.shareName);
  return `${DESK ? SITE : location.origin + location.pathname}?${q.toString()}`;
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
function readSharedFromUrl(search = location.search) {
  const q = new URLSearchParams(search);
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
function cardHighlights() {
  const c = S.card;
  const races = c.races.filter((r) => r.ranked.length > 1);
  const gapOf = (r) => r.ranked[0].pick - r.ranked[1].pick;
  const best = [...races].sort((a, b) => (b.confidence - a.confidence) || (gapOf(b) - gapOf(a))).slice(0, 5);
  const tris = [...races].filter((r) => r.trifecta.type !== 'N/A')
    .sort((a, b) => (b.trifecta.hit - a.trifecta.hit)).slice(0, 5);
  const exs = [...races].filter((r) => !['N/A', 'PASS'].includes(r.exacta.type))
    .sort((a, b) => (b.exacta.hit / Math.sqrt(b.exacta.combos)) - (a.exacta.hit / Math.sqrt(a.exacta.combos))).slice(0, 5);
  const sups = [...races].filter((r) => !['N/A', 'PASS'].includes(r.superfecta.type))
    .sort((a, b) => b.superfecta.hit - a.superfecta.hit).slice(0, 5);
  const good = races.flatMap((r) => r.value.good.map((p) => ({ r, h: horseOf(r, p) }))).sort((a, b) => b.h.value_ratio - a.h.value_ratio);
  const bad = races.flatMap((r) => r.value.bad.map((p) => ({ r, h: horseOf(r, p) }))).sort((a, b) => b.h.value_ratio - a.h.value_ratio);
  const longs = races.flatMap((r) => r.longshots.map((l) => ({ r, l }))).sort((a, b) => (b.l.overlay * Math.sqrt(b.l.hit)) - (a.l.overlay * Math.sqrt(a.l.hit))).slice(0, 8);
  const plans = S.bets.map((b) => ({ b, ...pickPlan(b) }));
  const spend = {
    tri: races.reduce((a, r) => a + (r.trifecta.cost || 0), 0),
    ex: races.reduce((a, r) => a + (r.exacta.cost || 0), 0),
    sup: races.reduce((a, r) => a + (r.superfecta.cost || 0), 0),
    ls: longs.reduce((a, x) => a + x.l.cost, 0),
    picks: plans.filter((x) => x.t.verdict === 'PLAY').reduce((a, x) => a + x.t.cost, 0),
  };
  const plan = cardPlan(races, longs, plans);
  return { best, tris, exs, sups, good, bad, longs, plans, spend, plan };
}

// $50-per-program plan (Marshall, Nov 5): fill the budget in priority order —
// Pick plays (already value-checked) → tri + exacta in 4-5 star races → longshot tris →
// other races' tri + exacta by race strength → superfectas → "go light" races last.
const cardBudget = () => S.prefs.cardBudget || 50;
function cardPlan(races, longs, plans) {
  const items = [];
  const ok = (t) => t && !['N/A', 'PASS'].includes(t.type) && t.cost > 0;
  for (const { b, t } of plans) if (t.verdict === 'PLAY') items.push({ id: 'pk:' + b.name + b.races[0], kind: 'Pick', rn: b.races[0], label: `${b.name} R${b.races[0]}–${b.races[b.races.length - 1]}`, text: ticketLine(t), cost: t.cost, tier: 1, sc: t.hit });
  for (const r of races) {
    const strong = r.confidence >= 4, light = r.trifecta.caution;
    const rs = r.confidence + r.undercard / 10 + r.trifecta.hit / 100;   // stronger races first; tri and exacta go in together
    if (ok(r.trifecta)) items.push({ id: 'tri:' + r.number, kind: 'Tri', rn: r.number, pl: 'trifecta', label: `R${r.number} Tri ${tc(r.trifecta.type)}`, text: r.trifecta.text, cost: r.trifecta.cost, tier: light ? 6 : strong ? 2 : 4, sc: rs + 0.001 });
    if (ok(r.exacta)) items.push({ id: 'ex:' + r.number, kind: 'Ex', rn: r.number, pl: 'exacta', label: `R${r.number} Ex ${tc(r.exacta.type)}`, text: r.exacta.text, cost: r.exacta.cost, tier: light ? 6 : strong ? 2 : 4, sc: rs });
    if (ok(r.superfecta)) items.push({ id: 'sup:' + r.number, kind: 'Super', rn: r.number, pl: 'superfecta', label: `R${r.number} Super ${tc(r.superfecta.type)}`, text: r.superfecta.text, cost: r.superfecta.cost, tier: 5, sc: r.superfecta.hit / r.superfecta.cost });
  }
  longs.forEach(({ r, l }, i) => items.push({ id: `ls:${r.number}:${i}`, kind: 'Longshot', rn: r.number, pl: 'ls', lskey: `${l.bet || 'tri'}:${l.text}`, label: `R${r.number} Longshot ${l.bet === 'ex' ? 'ex' : 'tri'}`, text: l.text, cost: l.cost, tier: 3, sc: l.overlay * Math.sqrt(l.hit) }));
  items.sort((a, b) => (a.tier - b.tier) || (b.sc - a.sc));
  const budget = cardBudget(); let spent = 0;
  const inn = [], out = [];
  for (const it of items) { if (spent + it.cost <= budget + 1e-9) { inn.push(it); spent += it.cost; } else out.push(it); }
  const byRace = (a, b) => (a.rn - b.rn) || a.kind.localeCompare(b.kind);
  const sum = (k) => inn.filter((x) => x.kind === k).reduce((a, x) => a + x.cost, 0);
  return { budget, spent, all: items.reduce((a, x) => a + x.cost, 0), inn: inn.sort(byRace), out: out.sort(byRace), ids: new Set(inn.map((x) => x.id)),
    parts: { Tri: sum('Tri'), Ex: sum('Ex'), Super: sum('Super'), Longshot: sum('Longshot'), Pick: sum('Pick') } };
}
function planText(P) {
  const nm = { Tri: 'trifectas', Ex: 'exactas', Super: 'superfectas', Longshot: 'longshots', Pick: 'Pick plays' };
  return Object.entries(P.parts).filter(([, v]) => v > 0).map(([k, v]) => `${nm[k]} ${dollars(v)}`).join(' · ');
}

function buildPrint() {
  const c = S.card;
  const H = cardHighlights();
  const nScr = Object.values(S.st.scratches).reduce((a, b) => a + b.length, 0);
  const play = (t) => (t.type === 'PASS' || t.type === 'N/A' ? `<span class="faint">${t.type === 'PASS' ? 'pass' : 'n/a'}</span>` : `${esc(tc(t.type))} ${esc(t.text)}`);
  const vlist = (r, k) => r.value[k].map((p) => { const h = horseOf(r, p); return `#${p} ${esc(h.ml.replace('/', '-'))}→${esc(h.line)}`; }).join(', ') || '<span class="faint">—</span>';
  const mk = (id) => (H.plan.ids.has(id) ? '<span class="gv">✓</span> ' : '');
  const head = (sub) => `<h1>${esc(c.track)} <span class="muted" style="font-size:11pt">${esc(c.date)} · ${sub}</span></h1>
    <p class="muted" style="margin:2px 0 6px">${esc(weightsText(effMult()))}${S.st.cond === 'off' ? ' · track set to OFF' : ''}${nScr ? ` · ${nScr} scratch${nScr > 1 ? 'es' : ''} applied` : ''} · Model estimates from the program — check scratches and changes before you bet.</p>`;
  const page1 = `<section class="pp cover">${head('Card summary (1 of 2)')}
    <table><thead><tr><th>Race</th><th>Post</th><th>Win / Under</th><th>Projected top 5</th><th>Trifecta</th><th>Exacta · Super</th><th>Good value (ML→line)</th><th>Bad value (ML→line)</th></tr></thead><tbody>
    ${c.races.map((r) => { const rk = r.ranked;
      return `<tr class="${r.confidence >= 5 ? 'hi' : ''}"><td><b style="font-size:11pt">${r.number}</b></td><td>${esc(r.post_time)}<br><span class="muted">${esc(tc(r.gait))}</span></td>
      <td><span class="stars">${stars(r.confidence)}</span> ${r.confidence}/5<br><span class="stars u">${stars(r.undercard)}</span> ${r.undercard}/5</td>
      <td><b>#${rk[0].pgm} ${esc(tc(rk[0].name))}</b> <span class="muted">(${esc(rk[0].ml)})</span><br>${rk.slice(1, 5).map((h) => `#${h.pgm}`).join(' · ')}</td>
      <td><b>${mk('tri:' + r.number)}${play(r.trifecta)}</b></td><td>${mk('ex:' + r.number)}${play(r.exacta)}<br>${mk('sup:' + r.number)}${play(r.superfecta)}</td>
      <td class="gv">${vlist(r, 'good')}</td><td class="bv">${vlist(r, 'bad')}</td></tr>`; }).join('')}
    </tbody></table></section>`;
  const sp = H.spend;
  const li = (x) => `<li>${x}</li>`;
  const page2 = `<section class="pp cover sum2">${head('Best bets & plays (2 of 2)')}
    <div class="s2">
      <div class="s2box"><h2>Best bets</h2><ol>${H.best.map((r) => li(`<b>R${r.number} #${r.ranked[0].pgm} ${esc(tc(r.ranked[0].name))}</b> <span class="muted">ML ${esc(r.ranked[0].ml)} · line ${esc(r.ranked[0].line)} · ${r.confidence}/5</span><br><span class="small">${esc((r.ranked[0].pros[0] || ['best overall profile'])[0])}</span>`)).join('')}</ol></div>
      <div class="s2box"><h2>Best trifectas</h2><ol>${H.tris.map((r) => li(`<b>R${r.number} ${esc(tc(r.trifecta.type))} ${esc(r.trifecta.text)}</b> <span class="muted">${r.trifecta.conf}/5 · ${dollars(r.trifecta.cost)} · model hit ~${Math.round(r.trifecta.hit * 100)}%</span>`)).join('')}</ol></div>
      <div class="s2box"><h2>Best exactas</h2><ol>${H.exs.map((r) => li(`<b>R${r.number} ${esc(tc(r.exacta.type))} ${esc(r.exacta.text)}</b> <span class="muted">${r.exacta.conf}/5 · ${dollars(r.exacta.cost)} · model hit ~${Math.round(r.exacta.hit * 100)}%</span>`)).join('')}</ol></div>
      <div class="s2box"><h2>Superfectas</h2>${H.sups.length ? `<ol>${H.sups.map((r) => li(`<b>R${r.number} ${esc(tc(r.superfecta.type))} ${esc(r.superfecta.text)}</b> <span class="muted">${dollars(r.superfecta.cost)} · ~${Math.round(r.superfecta.hit * 100)}%</span>`)).join('')}</ol>` : '<p class="muted">No superfecta plays on this card.</p>'}</div>
      <div class="s2box"><h2>Good value <span class="muted">(ML → our line)</span></h2>${H.good.length ? `<ol>${H.good.slice(0, 8).map(({ r, h }) => li(`<b class="gv">R${r.number} #${h.pgm} ${esc(tc(h.name))}</b> ML ${esc(h.ml.replace('/', '-'))} → line <b>${esc(h.line)}</b> <span class="muted">· ranked ${ord(h.rank)}</span>`)).join('')}</ol>` : '<p class="muted">None on this card.</p>'}</div>
      <div class="s2box"><h2>Bad value — bet against <span class="muted">(ML → our line)</span></h2>${H.bad.length ? `<ol>${H.bad.slice(0, 8).map(({ r, h }) => li(`<b class="bv">R${r.number} #${h.pgm} ${esc(tc(h.name))}</b> ML ${esc(h.ml.replace('/', '-'))} → line <b>${esc(h.line)}</b> <span class="muted">· ranked ${ord(h.rank)}</span>`)).join('')}</ol>` : '<p class="muted">None on this card.</p>'}</div>
      <div class="s2box"><h2>Longshots <span class="muted">(top ${H.longs.length})</span></h2>${H.longs.length ? `<ol>${H.longs.map(({ r, l }) => li(`<b>R${r.number} ${l.bet === 'ex' ? 'Ex' : 'Tri'} ${esc(l.text)}</b> <span class="muted">${dollars(l.cost)} · ${esc(l.label)} · model ${pctP(l.hit, 1)} vs ${r.live ? 'odds' : 'ML'} ${pctP(l.market, l.market < 0.01 ? 2 : 1)}</span>`)).join('')}</ol>` : '<p class="muted">None on this card.</p>'}</div>
      <div class="s2box"><h2>Pick 3 / 4 / 5 &amp; doubles</h2>${H.plans.length ? `<ul class="plain">${H.plans.map(({ b, t, alt }) => li(`${t.verdict === 'PLAY' ? '<b class="gv">PLAY</b>' : '<span class="muted">PASS</span>'} <b>${esc(b.name)} R${b.races[0]}–${b.races[b.races.length - 1]}</b> ${t.verdict === 'PLAY' ? `${ticketLine(t)} = <b>${dollars(t.cost)}</b> <span class="muted">(~${pctP(t.hit, 1)})</span>` : `<span class="muted">— ${esc(t.why)}</span>`}${alt ? `<br><span class="small">At $10: ${ticketLine(alt)} = ${dollars(alt.cost)} (~${pctP(alt.hit, 1)})</span>` : ''}`)).join('')}</ul>` : '<p class="muted">No multi-race wagers on this card.</p>'}</div>
    </div>
    <div class="spend"><b>Card plan ${dollars(H.plan.spent)} of ${dollars(H.plan.budget)}:</b> ${planText(H.plan)} <span class="muted">(✓ on page 1)</span>${H.plan.inn.some((x) => x.kind === 'Longshot') ? `<br><span class="small">Longshots in the plan: ${H.plan.inn.filter((x) => x.kind === 'Longshot').map((x) => `${esc(x.label.replace(' Longshot tri', ''))} ${esc(x.text)}`).join(' · ')}</span>` : ''}${H.plan.out.length ? `<br><span class="small muted">Left out to stay on budget: ${H.plan.out.map((x) => `${esc(x.label)} ${dollars(x.cost)}`).join(' · ')} — playing everything would be ${dollars(H.plan.all)}.</span>` : ''}</div>
  </section>`;
  const races = c.races.map((r) => {
    const scrSet = new Set(S.st.scratches[r.number] || []);
    const sorted = [...r.horses].sort((a, b) => a.pgm - b.pgm);
    const res = S.st.results[r.number] || [];
    return `<section class="pp">${bannerHtml(r)}${projHtml(r)}${betsHtml(r)}<div class="why">${whyHtml(r)}</div>
      ${horseTable(r, sorted, scrSet, true)}
      <div class="pnotes"><span class="ord">OFFICIAL ORDER ${['1st', '2nd', '3rd', '4th'].map((l, i) => `${l}<span>${res[i] || ''}</span>`).join('')}</span>NOTES — RACE ${r.number} <span class="faint">· green = best in race, red = worst</span><br>${esc(S.st.notes[r.number] || '')}</div></section>`;
  }).join('');
  const root = $('#print');
  root.innerHTML = races + page1 + page2;
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
const pdfName = () => `${(S.card.track || 'card').replace(/\W+/g, '-')}-${(S.card.date || '').replace(/^\w+, /, '').replace(/\W+/g, '-')}-picks.pdf`.replace(/-+/g, '-');
async function makePdf(progress) {
  if (S.dirty) { rescoreAll(); S.dirty = false; }
  await Promise.all([loadScript('vendor/html2canvas.min.js'), loadScript('vendor/jspdf.umd.min.js')]);
  buildPrint();
  const root = $('#print');
  root.classList.add('capture');
  try {
    const pages = [...root.querySelectorAll('.pp')];
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'in', format: 'letter', compress: true });
    doc.setProperties({ title: `${S.card.track} ${S.card.date} — picks`, creator: 'Harness Handicapper' });
    const W = 11, Hh = 8.5, M = 0.3;
    const scale = /iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document ? 1.4 : 1.7;
    for (let i = 0; i < pages.length; i++) {
      progress(`Page ${i + 1} of ${pages.length}`);
      const pg = pages[i];
      pg.style.zoom = '';
      const canvas = await window.html2canvas(pg, { scale, backgroundColor: '#ffffff', logging: false, windowWidth: pg.scrollWidth });
      const img = canvas.toDataURL('image/jpeg', 0.8);
      const ratio = canvas.width / canvas.height;
      let w = W - 2 * M, h = w / ratio;
      if (h > Hh - 2 * M) { h = Hh - 2 * M; w = h * ratio; }
      if (i) doc.addPage('letter', 'landscape');
      doc.addImage(img, 'JPEG', (W - w) / 2, M, w, h, undefined, 'FAST');
      canvas.width = canvas.height = 0;
    }
    return doc.output('blob');
  } finally {
    root.classList.remove('capture');
  }
}
function overlay(title) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="overlay-box" role="dialog" aria-live="polite"><b>${esc(title)}</b><div class="note ov-msg">Getting ready</div></div>`;
  document.body.appendChild(ov);
  return { el: ov, msg: (m) => { ov.querySelector('.ov-msg').textContent = m; }, html: (h) => { ov.querySelector('.overlay-box').innerHTML = h; }, close: () => ov.remove() };
}
// ---------------- desktop app (Windows .exe) ----------------
const DESK = window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core : null;
const SITE = 'https://farmermarsh.github.io/harness-handicapper/';
async function deskSave(blob, name, folder = 'pdf') {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return DESK.invoke('save_file', { folder, name, b64: btoa(bin) });
}
const deskOpen = (path) => DESK.invoke('open_path', { path }).catch((e) => alert(String(e)));
function saveBlob(blob, name, folder = 'pdf') {
  if (DESK) return deskSave(blob, name, folder).then((path) => { S.lastSaved = path; return path; });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function downloadPdf() {
  if (!S.key || S._pdfBusy) return;
  S._pdfBusy = true;
  const ov = overlay('Building your PDF…');
  try {
    const path = await saveBlob(await makePdf(ov.msg), pdfName());
    if (DESK && path) deskOpen(path);
  }
  catch (e) { console.error(e); alert('Could not build the PDF: ' + (e.message || e) + '. You can still use Print → Save as PDF.'); }
  finally { ov.close(); S._pdfBusy = false; }
}
function emailBody() {
  const H = cardHighlights();
  const L = [`${S.card.track} — ${S.card.date}`, weightsText(), ''];
  L.push('BEST BETS');
  for (const r of H.best) L.push(`  R${r.number} #${r.ranked[0].pgm} ${tc(r.ranked[0].name)} (ML ${r.ranked[0].ml}, our line ${r.ranked[0].line}) ${r.confidence}/5`);
  L.push('', 'TRIFECTAS');
  for (const r of S.card.races) if (r.trifecta.type !== 'N/A') L.push(`  R${r.number} ${tc(r.trifecta.type)} ${r.trifecta.text}`);
  if (H.good.length) { L.push('', 'GOOD VALUE (ML -> our line)'); for (const { r, h } of H.good.slice(0, 6)) L.push(`  R${r.number} #${h.pgm} ${tc(h.name)} ${h.ml.replace('/', '-')} -> ${h.line}`); }
  const plays = H.plans.filter((x) => x.t.verdict === 'PLAY');
  if (plays.length) { L.push('', 'PICK PLAYS'); for (const { b, t } of plays) L.push(`  ${b.name} R${b.races[0]}-${b.races[b.races.length - 1]}: ${ticketLine(t)} = $${t.cost.toFixed(2)}`); }
  L.push('', `Full race-by-race PDF attached (${pdfName()}).`);
  return L.join('\n');
}
async function emailPdf() {
  if (!S.key || S._pdfBusy) return;
  S._pdfBusy = true;
  const ov = overlay('Building your PDF for email…');
  const subject = `${S.card.track} ${S.card.date.replace(/^\w+, /, '')} — picks`;
  const to = (S.prefs.emailTo || '').trim();
  try {
    const blob = await makePdf(ov.msg);
    const file = new File([blob], pdfName(), { type: 'application/pdf' });
    if (DESK) {
      const path = await saveBlob(blob, pdfName());
      ov.html(`<b>PDF saved</b><p class="note">Saved to <b>${esc(path)}</b>. Your email opens with the picks typed in — attach the PDF from that folder, then send.</p><button class="btn primary" id="ovMail">Open email</button> <button class="btn" id="ovPdf">Open PDF</button> <button class="btn" id="ovFolder">Open folder</button> <button class="btn" id="ovDone">Done</button>`);
      await new Promise((resolve) => {
        $('#ovDone').onclick = resolve;
        $('#ovPdf').onclick = () => deskOpen(path);
        $('#ovFolder').onclick = () => DESK.invoke('open_folder', { folder: 'pdf' }).catch((e) => alert(String(e)));
        $('#ovMail').onclick = () => { openMailDraft(to, subject); resolve(); };
      });
    } else if (navigator.canShare && navigator.canShare({ files: [file] })) {
      ov.html(`<b>PDF ready</b><p class="note">Pick <b>Mail</b> (or Outlook / Gmail) in the share menu — the PDF goes in as an attachment.</p><button class="btn primary" id="ovShare">Share / Email</button> <button class="btn" id="ovCancel">Cancel</button>`);
      await new Promise((resolve) => {
        $('#ovCancel').onclick = resolve;
        $('#ovShare').onclick = async () => {
          try { await navigator.share({ files: [file], title: subject, text: emailBody() }); }
          catch (e) { if (e.name !== 'AbortError') { saveBlob(blob, pdfName()); openMailDraft(to, subject); } }
          resolve();
        };
      });
    } else {
      saveBlob(blob, pdfName());
      ov.html(`<b>PDF downloaded</b><p class="note">Your email is opening with the picks typed in. Attach <b>${esc(pdfName())}</b> from your Downloads folder, then send.</p><button class="btn primary" id="ovMail">Open email</button> <button class="btn" id="ovDone">Done</button>`);
      await new Promise((resolve) => {
        $('#ovDone').onclick = resolve;
        $('#ovMail').onclick = () => { openMailDraft(to, subject); resolve(); };
      });
    }
  } catch (e) {
    console.error(e);
    alert('Could not build the PDF: ' + (e.message || e));
  } finally { ov.close(); S._pdfBusy = false; }
}
function openMailDraft(to, subject) {
  let body = emailBody();
  if (body.length > 1700) body = body.slice(0, 1700) + '\n…';
  const url = `mailto:${encodeURIComponent(to).replace(/%2C/gi, ',').replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  if (DESK) DESK.invoke('open_url', { url }).catch((e) => alert(String(e)));
  else location.href = url;
}

// ---------------- router ----------------
function render() {
  const hash = location.hash || '#/';
  const upload = $('#upload'), view = $('#view'), nav = $('#topnav');
  const bar = $('#daybar'); if (bar) { bar.hidden = !S.key; bar.innerHTML = daybarHtml(); }
  nav.hidden = !S.key;
  for (const a of nav.querySelectorAll('a')) a.classList.remove('on');
  const picksLink = nav.querySelector('[data-nav="picks"]');
  if (picksLink) picksLink.hidden = !S.bets.length;
  const route = hash.replace(/^#\/?/, '');
  const show = (html, navKey) => {
    upload.hidden = true; view.hidden = false;
    view.innerHTML = sharedBanner() + html;
    if (navKey) nav.querySelector(`[data-nav="${navKey}"]`)?.classList.add('on');
    if (S._floatHeadBar) { S._floatHeadBar.classList.remove('show'); S._floatHeadBar.dataset.src = ''; }
    if (S._miniBar) { S._miniBar.classList.remove('show'); S._miniBar.dataset.src = ''; }
    setTimeout(floatHeadSync, 0);
    setTimeout(miniBarSync, 0);
  };
  if (route === 'settings') return show(renderSettings(), 'settings');
  if (route === 'record') return show(renderRecord(), 'record');
  if (route === 'tracks') return show(renderTracks(), 'tracks');
  if (!S.key) {
    upload.hidden = false; view.hidden = !S.shared; view.innerHTML = sharedBanner();
    renderRecent(); return;
  }
  if (route === 'picks') return show(renderPicks(), 'picks');
  if (route === 'trends') return show(renderTrends(), 'trends');
  if (route === 'results') return show(renderResults(), 'record');
  const m = route.match(/^race\/(\d+)/);
  if (m) return show(renderRace(+m[1]));
  show(renderCard(), 'card');
}

function renderRecent() {
  const cards = LS.get(CARDS_KEY, {});
  const keys = Object.keys(cards).sort((a, b) => (Date.parse(cards[b].iso || 0) || 0) - (Date.parse(cards[a].iso || 0) || 0) || cards[b].savedAt - cards[a].savedAt);
  $('#recent').innerHTML = keys.length ? `<div class="note">Programs on this device</div>` +
    keys.map((k) => `<button class="btn" data-open="${esc(k)}">${esc(cards[k].track)} · ${esc(cards[k].date)}</button>`).join('') : '';
}

// ---------------- events ----------------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-scr],[data-sort],[data-view],[data-act],[data-open],[data-preset],[data-pick],[data-pbudget],[data-preset-ticket],[data-cond],[data-learn],[data-unlearn],[data-cbudget],[data-setplays],[data-switch],[data-tonight],[data-blend],[data-rectab],[data-recplayed],[data-themeset]');
  if (!t) return;
  const act = t.dataset.act;
  if (act === 'use-link') {
    const v = ($('#pasteLink') || {}).value || '';
    try { readSharedFromUrl(new URL(v.trim()).search); } catch { alert("That doesn't look like a share link."); return; }
    if (!S.shared) { alert("That link doesn't have any weights in it."); return; }
    render(); window.scrollTo(0, 0); return;
  }
  if (act === 'open-data') { e.preventDefault(); DESK && DESK.invoke('open_folder', { folder: '' }).catch((x) => alert(String(x))); return; }
  if (t.dataset.switch) {
    if (t.dataset.gohash) switchTo(t.dataset.switch, t.dataset.gohash);
    else if (t.dataset.switch !== S.key) switchTo(t.dataset.switch);
    return;
  }
  if (t.dataset.setplays) {
    const [name, v] = t.dataset.setplays.split('|'); const books = LS.get(TRACKS_KEY, {}); books[name] = { ...(books[name] || { cards: {} }), plays: v }; LS.set(TRACKS_KEY, books);
    if (S.key) rescoreAll(); render(); return;
  }
  if (t.dataset.tonight !== undefined) { S.st.tonight = +t.dataset.tonight; saveState(); rescoreAll(); render(); return; }
  if (t.dataset.rectab) { S.prefs.recTab = t.dataset.rectab; LS.set(PREF_KEY, S.prefs); render(); return; }
  if (t.dataset.recplayed !== undefined) { S.prefs.recPlayed = t.dataset.recplayed === '1'; LS.set(PREF_KEY, S.prefs); render(); return; }
  if (act === 'hexp') { S.prefs.expand = S.prefs.expand === true ? false : true; S.hOpen = {}; LS.set(PREF_KEY, S.prefs); render(); return; }
  if (act === 'plan-played') {
    const P = cardHighlights().plan; S.st.played = S.st.played || {}; let k = 0;
    for (const x of P.inn) { if (!x.pl) continue; const p = S.st.played[x.rn] = S.st.played[x.rn] || {}; if (x.pl === 'ls') p.ls = [...new Set([...(p.ls || []), x.lskey])]; else p[x.pl] = true; k++; }
    saveState(); S.prefs.slipOpen = true; render(); const m = $('#planMsg'); if (m) m.textContent = `Marked ${k} bets as played.`; return;
  }
  if (act === 'live-clear') { const n = +t.dataset.n; if (S.st.live) delete S.st.live[n]; if (S.st.liveOpen) delete S.st.liveOpen[n]; saveState(); rescoreAll(); render(); return; }
  if (t.dataset.blend !== undefined) { S.prefs.mlBlend = +t.dataset.blend; LS.set(PREF_KEY, S.prefs); if (S.key) rescoreAll(); render(); return; }
  if (t.dataset.themeset !== undefined) { S.prefs.theme = t.dataset.themeset; LS.set(PREF_KEY, S.prefs); applyTheme(); render(); return; }
  if (act === 'learn-use') { S.prefs.learnUse = t.checked; LS.set(PREF_KEY, S.prefs); if (S.key) rescoreAll(); render(); return; }
  if (act === 'learn-freeze') { S.prefs.learnFreeze = t.checked; LS.set(PREF_KEY, S.prefs); render(); return; }
  if (act === 'learn-now') { runLearning(); return; }
  if (act === 'toggle-base') { S.prefs.baseAuto = t.checked; LS.set(PREF_KEY, S.prefs); if (S.key) rescoreAll(); render(); return; }
  if (act === 'toggle-season') { S.prefs.season = t.checked; LS.set(PREF_KEY, S.prefs); if (S.key) rescoreAll(); render(); return; }
  if (act === 'toggle-livedrift') { S.prefs.liveDrift = t.checked; LS.set(PREF_KEY, S.prefs); if (S.key) rescoreAll(); render(); return; }
  if (act === 'adv') { S.advOpen = !t.closest('details').open; return; }
  if (t.dataset.cbudget) { S.prefs.cardBudget = +t.dataset.cbudget; LS.set(PREF_KEY, S.prefs); render(); return; }
  if (t.dataset.cond) {
    S.st.cond = t.dataset.cond; saveState(); rescoreAll(); render(); return;
  }
  if (t.dataset.learn) {
    const track = t.dataset.learn;
    t.disabled = true; t.textContent = 'Learning…';
    setTimeout(() => {
      const r = learnTrack(track);
      if (S.key) rescoreAll();
      render();
      const out = $('#learnOut');
      if (out && r.final) out.innerHTML = `${esc(track)}: tested on races it hadn't seen, the learned weights picked <b>${r.hitsSug}</b> winners of ${r.n} vs <b>${r.hitsNorm}</b> with normal weights.`;
    }, 30);
    return;
  }
  if (t.dataset.unlearn) {
    const profs = LS.get(PROFILE_KEY, {}); delete profs[t.dataset.unlearn]; LS.set(PROFILE_KEY, profs);
    if (S.key) rescoreAll(); render(); return;
  }
  if (act === 'toggle-profiles') {
    S.prefs.useProfiles = t.checked; LS.set(PREF_KEY, S.prefs); if (S.key) rescoreAll(); render(); return;
  }
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
  else if (t.dataset.pbudget) { S.prefs.pickBudget = +t.dataset.pbudget; LS.set(PREF_KEY, S.prefs); render(); }
  else if (t.dataset.pick) {
    const [id, ns, ps] = t.dataset.pick.split('|');
    const b = S.bets.find((x) => x.id === id);
    const tk = pickPlan(b).t;
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
    switchTo(t.dataset.open, '#/');
  } else if (act === 'new') {
    const f = $('[data-act="addfiles"]'); if (f) { f.value = ''; f.click(); } else { $('#file').value = ''; $('#file').click(); }
  } else if (act === 'reset-weights') {
    applyMult({ ...DEFAULT_MULT });
  } else if (t.dataset.preset) {
    applyMult({ ...DEFAULT_MULT, ...PRESETS[t.dataset.preset].mult });
  } else if (act === 'tune') {
    S.tuneOpen = !S.tuneOpen; render();
  } else if (act === 'pdf') {
    downloadPdf();
  } else if (act === 'email') {
    emailPdf();
  } else if (act === 'save-email') {
    S.prefs.emailTo = ($('#emailTo').value || '').trim(); LS.set(PREF_KEY, S.prefs);
    $('#emailSaved').textContent = S.prefs.emailTo ? 'Saved.' : 'Cleared.';
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
    for (const b of boxes) if (b.checked) {
      const n = +b.dataset.pr;
      applyResult(n, S.pasted.found[n].order);
      nApplied++;
    }
    saveState(); S.pasted = null; location.hash = '#/record'; render();
    if (S.card) rescoreAll();
    scheduleLearning(300);
    if (nApplied) setTimeout(() => alert(`Applied results for ${nApplied} race${nApplied > 1 ? 's' : ''}.`), 50);
  } else if (act === 'export') {
    const blob = buildExport();
    if (DESK) saveBlob(blob, `harness-record-${new Date().toISOString().slice(0, 10)}.json`, 'export').then((path) => alert('Record saved to ' + path));
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'harness-record.json'; a.click(); }
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'file' || t.dataset.act === 'addfiles') return loadFiles(t.files);
  if (t.dataset.other !== undefined && t.value) return switchTo(t.value, '#/');
  if (t.dataset.plays) {
    const books = LS.get(TRACKS_KEY, {}); books[t.dataset.plays] = { ...(books[t.dataset.plays] || { cards: {} }), plays: t.value }; LS.set(TRACKS_KEY, books);
    if (S.key) rescoreAll(); render(); return;
  }
  if (t.dataset.res) {
    const n = +t.dataset.res;
    const arr = [...(S.st.results[n] || [null, null, null, null])];
    arr[+t.dataset.pos] = t.value ? +t.value : null;
    S.st.results[n] = arr;
    if (arr.some(Boolean)) { S.st.snaps[n] = snapshot(raceOf(n)); syncGradedRace(n); } else delete S.st.snaps[n];
    saveState(); render(); scheduleLearning();
  }
  if (t.dataset.played) {
    const n = +t.dataset.n; S.st.played = S.st.played || {}; const p = S.st.played[n] = S.st.played[n] || {};
    if (t.dataset.played === 'ls') { const set = new Set(p.ls || []); if (t.checked) set.add(t.dataset.key); else set.delete(t.dataset.key); p.ls = [...set]; }
    else p[t.dataset.played] = t.checked;
    saveState(); return;
  }
  if (t.dataset.drv) {
    const n = +t.dataset.drv; S.st.drivers = S.st.drivers || {}; const d = S.st.drivers[n] = S.st.drivers[n] || {};
    if (t.value) d[t.dataset.pgm] = t.value; else delete d[t.dataset.pgm];
    if (!Object.keys(d).length) delete S.st.drivers[n];
    saveState(); scoreOne(raceOf(n)); S.dirty = true; render(); return;
  }
  if (t.dataset.live) {
    const n = +t.dataset.live, v = parseOdds(t.value);
    S.st.live = S.st.live || {}; const lv = S.st.live[n] = S.st.live[n] || {};
    if (v == null) delete lv[t.dataset.pgm]; else lv[t.dataset.pgm] = v;
    if (!Object.keys(lv).length) delete S.st.live[n];
    // v22 (#52): remember the FIRST live-odds reading per horse (powers the opt-in drift pro/con) — set once
    // and left alone on later edits; cleared together with the current value so a new run starts a fresh baseline.
    S.st.liveOpen = S.st.liveOpen || {}; const lo = S.st.liveOpen[n] = S.st.liveOpen[n] || {};
    if (v == null) delete lo[t.dataset.pgm]; else if (lo[t.dataset.pgm] == null) lo[t.dataset.pgm] = v;
    if (!Object.keys(lo).length) delete S.st.liveOpen[n];
    saveState();
    const r = raceOf(n); scoreOne(r); S.dirty = true;
    if ($('#raceTop')) { $('#raceTop').innerHTML = raceTopHtml(r); $('#raceBody').innerHTML = raceBodyHtml(r); }
    t.value = v == null ? '' : oddsStr(v);
    return;
  }
  if (t.dataset.pbase) {
    const st = S.st.picks[t.dataset.pbase] = S.st.picks[t.dataset.pbase] || {};
    st.base = +t.value; saveState(); render();
  }
  if (t.dataset.tplayed) {
    const id = t.dataset.tplayed, st = S.st.picks[id] = S.st.picks[id] || {};
    st.played = t.checked; saveState(); return;
  }
  if (t.dataset.act === 'import' && t.files[0]) {
    try {
      const data = JSON.parse(await t.files[0].text());
      for (const [k, v] of Object.entries(data.cards || {})) {
        const cur = LS.get(stateKey(k), null);
        LS.set(stateKey(k), cur ? { ...v.state, ...cur, results: { ...v.state.results, ...cur.results }, snaps: { ...v.state.snaps, ...cur.snaps } } : v.state);
      }
      if (data.tracks) { const cur = LS.get(TRACKS_KEY, {}); for (const [k, v] of Object.entries(data.tracks)) cur[k] = { ...v, ...(cur[k] || {}), cards: { ...(v.cards || {}), ...((cur[k] || {}).cards || {}) } }; LS.set(TRACKS_KEY, cur); }
      if (data.profiles) LS.set(PROFILE_KEY, { ...data.profiles, ...LS.get(PROFILE_KEY, {}) });
      if (S.key) { S.st = { ...S.st, ...LS.get(stateKey(S.key), {}) }; rescoreAll(); }
      render();
    } catch { alert("That file isn't a Harness Handicapper record."); }
  }
});

document.addEventListener('toggle', (e) => {
  const t = e.target;
  if (t.matches && t.matches('details.horse')) S.hOpen[t.dataset.h] = t.open;
  if (t.matches && t.matches('details.slip')) { S.prefs.slipOpen = t.open; LS.set(PREF_KEY, S.prefs); }
}, true);

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.notes) { S.st.notes[t.dataset.notes] = t.value; saveState(); }
  if (t.dataset.m || t.dataset.g) {
    if (t.dataset.m) S.mult[t.dataset.m] = +t.value; else setGroup(t.dataset.g, +t.value);
    saveMult(); syncTune();
    clearTimeout(S._wt);
    S._wt = setTimeout(() => {
      if (!S.key) return;
      const r = curRace() && raceOf(curRace());
      if (r) { scoreOne(r); $('#raceTop').innerHTML = raceTopHtml(r); $('#raceBody').innerHTML = raceBodyHtml(r); $('#wbadge').innerHTML = weightsBadge(); }
      // full re-rank in the background for the "how many picks change" line
      clearTimeout(S._wt2);
      S._wt2 = setTimeout(() => { rescoreAll(); S.dirty = false; const d = $('#tuneDiff'); if (d) d.innerHTML = diffText(); }, 250);
    }, 120);
  }
});

const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => loadFiles(e.dataTransfer.files));
// drop PDFs anywhere once a card is open
document.addEventListener('dragover', (e) => { if (S.key && [...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
document.addEventListener('drop', (e) => { if (S.key && e.dataTransfer?.files?.length && !e.target.closest('#drop')) { e.preventDefault(); loadFiles(e.dataTransfer.files); } });

$('#printBtn').addEventListener('click', () => emailPdf());
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
(async function init() {
  await storageInit();
  if (DESK) {
    document.body.classList.add('desk');
    DESK.invoke('data_dir').then((d) => { const v = $('#ver'); if (v) v.insertAdjacentHTML('afterend', ` · Desktop app · data: <a href="#" data-act="open-data">${esc(d)}</a>`); }).catch(() => {});
  }
  S.mult = { ...DEFAULT_MULT, ...LS.get(MULT_KEY, {}) };
  S.prefs = { ...S.prefs, ...LS.get(PREF_KEY, {}) };
  applyTheme();
  readSharedFromUrl();
  pruneCards();
  S.learned = LS.get(LEARN_KEY, null);
  const cards = LS.get(CARDS_KEY, {});
  const keys = Object.keys(cards).sort((a, b) => cards[b].savedAt - cards[a].savedAt);
  const last = LS.get('hh:open', null);
  const pick = last && cards[last] ? last : keys[0];
  if (pick && getCard(pick)) openCard(pick, getCard(pick));
  render();
  // catch up if results were entered since the last fit (or on another version); also always refreshes
  // the shared pool (v22: post-index + cross-night Trends) even for a fresh card with 0 local results yet
  scheduleLearning(1500);
})();
