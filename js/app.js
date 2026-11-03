import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { parseProgram, fmtTime } from './parse.js';
import { scoreRace, cardDate, cardDriverTable, DEFAULT_WEIGHTS, WEIGHT_LABELS, ADJ } from './engine.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

// ---------------- storage ----------------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const CARDS_KEY = 'hh:cards';        // { key: { track, date, savedAt, card } }
const stateKey = (k) => 'hh:state:' + k; // { scratches, notes, results, snaps }
const WEIGHTS_KEY = 'hh:weights';
const PREF_KEY = 'hh:prefs';

const S = {
  key: null, base: null, card: null, st: null,
  weights: { ...DEFAULT_WEIGHTS, ...LS.get(WEIGHTS_KEY, {}) },
  prefs: { sort: 'pgm', view: 'auto', ...LS.get(PREF_KEY, {}) },
  driverTable: [], today: null, year: null,
};

// ---------------- helpers ----------------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const money = (x) => '$' + Number(x).toLocaleString('en-US');
const pct0 = (x) => (x == null ? '—' : `${Math.round(x)}%`);
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
const isValue = (h) => !!(h.ml_dec && h.win_prob >= 0.15 && h.ml_dec >= 2 * Math.max(h.fair_odds, 0.5));
const trk = (t) => esc((t || '').replace('Á', '⅝').replace('Â', '⅞'));
const kind = (t) => (t.type.startsWith('KEY') ? 'key' : t.type.startsWith('BOX') ? 'box' : 'pass');

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
  S.st = { scratches: {}, notes: {}, results: {}, snaps: {}, ...LS.get(stateKey(key), {}) };
  rescoreAll();
}

function rescoreAll() {
  S.card = JSON.parse(S.base);
  S.today = cardDate(S.card);
  S.year = new Date(S.today).getUTCFullYear();
  S.driverTable = cardDriverTable(S.card);
  for (const r of S.card.races) scoreOne(r);
}
function scoreOne(r) {
  scoreRace(r, { today: S.today, year: S.year, weights: S.weights, driverTable: S.driverTable, scratched: S.st.scratches[r.number] || [] });
}
const saveState = () => LS.set(stateKey(S.key), S.st);

// ---------------- grading ----------------
function snapshot(r) {
  return {
    order: r.ranked.map((h) => h.pgm), conf: r.confidence, under: r.undercard,
    plays: Object.fromEntries(['exacta', 'trifecta', 'superfecta'].map((k) => [k, { type: r[k].type, text: r[k].text, combos: r[k].combos, cost: r[k].cost }])),
  };
}
function playHit(kindName, play, top, fin) {
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
    row[k] = playHit(k, snap.plays[k], o, fin);
    row[k + '_cost'] = row[k] == null ? 0 : snap.plays[k].cost;
  }
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

// ---------------- render: card ----------------
function racePlaysHtml(r) {
  const one = (lbl, t) => `<span class="pill ${kind(t)}">${lbl} ${t.type === 'PASS' ? 'pass' : t.type === 'N/A' ? 'n/a' : esc(t.type.toLowerCase() + ' ' + t.text)}</span>`;
  return one('TRI', r.trifecta) + one('EX', r.exacta) + one('SUP', r.superfecta);
}

function renderCard() {
  const c = S.card;
  const best = [...c.races].filter((r) => r.ranked.length).sort((a, b) =>
    (b.confidence - a.confidence) || ((b.ranked[0].score - b.ranked[1].score) - (a.ranked[0].score - a.ranked[1].score))).slice(0, 3);
  const nScr = Object.values(S.st.scratches).reduce((a, b) => a + b.length, 0);
  return `
  <div class="cardhead">
    <div><h1>${esc(c.track)}</h1><div class="sub">${esc(c.date)} · ${c.races.length} races${nScr ? ` · ${nScr} scratched` : ''}</div></div>
    <div class="row"><button class="btn small" data-act="new">Load another program</button></div>
  </div>
  <div class="bestbets"><b>Best bets:</b> ${best.map((r) => `<a href="#/race/${r.number}"><b>R${r.number}</b> #${r.ranked[0].pgm} ${esc(tc(r.ranked[0].name))}</a> (${r.confidence}/5)`).join(' &nbsp;·&nbsp; ')}</div>
  <div class="races">
    ${c.races.map((r) => {
      const rk = r.ranked;
      if (!rk.length) return '';
      const v = rk.slice(0, 3).filter(isValue);
      return `<a class="racecard ${r.confidence >= 5 ? 'top' : ''}" href="#/race/${r.number}">
        <div class="rc-head"><div class="rc-num">${r.number}</div>
          <div class="rc-meta"><b>${esc(r.post_time)}</b> · ${esc(tc(r.gait))} · ${money(r.purse)}<br>${rk.length} starters</div>
          <div class="rc-conf"><span class="stars">${stars(r.confidence)}</span> <b>${r.confidence}/5</b><br><span class="stars u">${stars(r.undercard)}</span> <span class="muted">undercard</span></div>
        </div>
        <div class="rc-pick"><b>#${rk[0].pgm} ${esc(tc(rk[0].name))}</b> <span class="muted">(${esc(rk[0].ml)}) · ${Math.round(rk[0].win_prob * 100)}%</span>${v.length ? ` <span class="pill value">value</span>` : ''}</div>
        <div class="rc-under">Then #${rk[1].pgm} ${esc(tc(rk[1].name))}, #${rk[2] ? rk[2].pgm + ' ' + esc(tc(rk[2].name)) : ''}</div>
        <div class="rc-plays">${racePlaysHtml(r)}</div>
      </a>`;
    }).join('')}
  </div>`;
}

// ---------------- render: race ----------------
function betHtml(name, t, main = false) {
  if (t.type === 'N/A') return `<div class="bet"><div class="lbl">${name}</div><div class="call faint">Not offered</div></div>`;
  if (t.type === 'PASS') return `<div class="bet ${main ? 'main' : ''}"><div class="lbl">${name}</div><div class="call">Pass</div><div class="det">${esc(t.why || '')}</div></div>`;
  return `<div class="bet ${kind(t)} ${main ? 'main' : ''}"><div class="lbl">${name}</div>
    <div class="call">${esc(tc(t.type))} ${esc(t.text)}</div>
    <div class="det">${t.combos} combos · $${t.cost.toFixed(2)} at ${baseLabel(t.base)} · model hit ~${Math.round(t.hit * 100)}%</div></div>`;
}

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

const pcList = (items, cls) => `<ul class="${cls}">${items.length ? items.map(([t, imp]) => `<li class="${imp >= 3 ? 'b' : ''}">${esc(t)}</li>`).join('') : '<li class="faint" style="list-style:none">—</li>'}</ul>`;

function statCells(h) {
  const m = h.m;
  const late = m.late_gain == null ? '—' : `<span class="${m.late_gain >= 1 ? 'gain' : m.late_gain <= -1 ? 'lose' : ''}">${Math.abs(m.late_gain) < 0.05 ? '0.0' : (m.late_gain > 0 ? '+' : '') + m.late_gain.toFixed(1)}</span>`;
  const lp = m.late_pairs.length ? `last ${m.late_pairs[0][0]}→${m.late_pairs[0][1]}` : '';
  return [
    ['Life mark', m.life_mark ? fmtTime(m.life_mark) : '—', trk(m.life_mark_trk)],
    [`'${String(S.year).slice(2)} mark`, m.yr_mark ? fmtTime(m.yr_mark) : '—', trk(m.yr_mark_trk)],
    ['Avg mark*', m.avg_mark ? fmtTime(m.avg_mark) : '—', `${m.clean_n} clean`],
    ['Open ¼*', m.open_q ? m.open_q.toFixed(1) : '—', m.open_pos ? `avg pos ${m.open_pos.toFixed(1)}` : ''],
    ['Close ¼*', m.close_q ? m.close_q.toFixed(1) : '—', m.close_best ? `best ${m.close_best.toFixed(1)}` : ''],
    ['¾→Fin', late, lp],
    ['Avg fin L3', m.avg_fin3 ? m.avg_fin3.toFixed(1) : '—', m.fins3.join('-')],
    ['Life W/T3', m.life_win == null ? '—' : `${pct0(m.life_win)}/${pct0(m.life_top3)}`, `${m.life_starts} starts`],
    [`'${String(S.year).slice(2)} W/T3`, m.yr_win == null ? '—' : `${pct0(m.yr_win)}/${pct0(m.yr_top3)}`, `${m.yr_starts} starts`],
    ['Class', m.cr_avg3 != null ? Math.round(m.cr_avg3) : '—', m.cr_avg3 != null ? 'avg CR faced' : ''],
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

function horseCard(h, r, scr) {
  const cls = scr ? 'scr' : h.rank === 1 ? 'r1' : h.rank <= 3 ? 'r23' : '';
  const proj = scr ? '<span class="pill pass">SCR</span>' : `<div class="h-proj">${h.rank}<small> · ${Math.round(h.win_prob * 100)}%</small></div>`;
  return `<article class="horse ${cls}">
    <div class="h-top">
      <button class="scrbtn ${scr ? 'on' : ''}" data-scr="${h.pgm}" aria-pressed="${scr}">${scr ? 'Scratched' : 'Scratch'}</button>
      <div class="h-pgm">${h.pgm}</div>
      <div style="min-width:0"><div class="h-name">${esc(tc(h.name))}</div>
        <div class="h-sub">${esc(tc(h.driver))}${h.drv_w != null ? ` (${h.drv_w}%)` : ''} · ${esc(tc(h.trainer))}${h.trn_w != null ? ` (${h.trn_w}%)` : ''}</div>
        <div class="h-extra">${esc(extraLine(h))}</div></div>
      <div class="h-right">${proj}<div class="h-ml">ML ${esc(h.ml)}</div></div>
    </div>
    ${scr || !h.m ? '' : `<div class="h-stats">${statCells(h).map(([k, v, s]) => `<div class="st"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}</div>
    <div class="pc">${pcList(h.pros, 'pro')}${pcList(h.cons, 'con')}</div>`}
  </article>`;
}

function horseTable(r, sorted, scrSet, forPrint = false) {
  const yy = String(S.year).slice(2);
  const head = ['Scr', '#', 'Horse / Driver · Trainer', 'ML', 'Proj', 'Life mark', `'${yy} mark`, 'Avg mark*', 'Open ¼*', 'Close ¼*', '¾→Fin', 'Avg fin L3', 'Life W/T3', `'${yy} W/T3`, 'Pros', 'Cons'];
  const rows = sorted.map((h) => {
    const scr = scrSet.has(h.pgm);
    const cls = scr ? 'scr' : h.rank === 1 ? 'r1' : h.rank <= 3 ? 'r23' : '';
    const cells = !scr && h.m ? statCells(h) : null;
    const c = (i) => cells ? `${cells[i][1]}<span class="s">${cells[i][2]}</span>` : '—';
    const scrCell = forPrint ? `<span class="scrbox"></span>` : `<button class="scrbtn ${scr ? 'on' : ''}" data-scr="${h.pgm}" aria-pressed="${scr}">${scr ? 'SCR' : '✕'}</button>`;
    return `<tr class="${cls}">
      <td>${scrCell}</td><td><b style="font-size:1.15em">${h.pgm}</b></td>
      <td class="l"><span class="h-name"><b>${esc(tc(h.name))}</b></span><span class="s">${esc(tc(h.driver))} · ${esc(tc(h.trainer))}</span><span class="s faint">${esc(extraLine(h))}</span></td>
      <td>${esc(h.ml)}</td>
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
      <div class="od">ML ${esc(h.ml)} · model ${Math.round(h.win_prob * 100)}% (fair ${oddsStr(h.fair_odds)})${isValue(h) && i < 3 ? ' · <b style="color:var(--green)">VALUE</b>' : ''}</div></div>`).join('')}</div>`;
}
function betsHtml(r) {
  return `<div class="bets">${betHtml('EXACTA', r.exacta)}${betHtml('TRIFECTA', r.trifecta, true)}${betHtml('SUPERFECTA', r.superfecta)}</div>`;
}

function renderRace(n) {
  const r = S.card.races.find((x) => x.number === n);
  if (!r) return `<p>Race not found. <a href="#/">Back to the card</a></p>`;
  const sorted = sortedHorses(r);
  const scrSet = new Set(S.st.scratches[n] || []);
  const res = S.st.results[n] || [];
  const opts = (sel) => `<option value="">—</option>` + r.horses.filter((h) => !scrSet.has(h.pgm)).map((h) => `<option ${+sel === h.pgm ? 'selected' : ''}>${h.pgm}</option>`).join('');
  const snap = S.st.snaps[n];
  let graded = '';
  if (snap && res.filter(Boolean).length) {
    const g = gradeRace(snap, res.filter(Boolean).map(Number));
    const mark = (v) => (v == null ? '<span class="faint">no play</span>' : v ? '<span class="ok">hit</span>' : '<span class="no">miss</span>');
    graded = `<div class="graded">Pick #${snap.order[0]}: ${g.win ? '<span class="ok">won</span>' : g.itm ? '<span class="ok">in the money</span>' : '<span class="no">out</span>'} · Exacta ${mark(g.exacta)} · Trifecta ${mark(g.trifecta)} · Superfecta ${mark(g.superfecta)}</div>`;
  }
  const v = S.prefs.view;
  return `
  <div class="racenav"><a class="btn small" href="#/">← Card</a>
    <div class="tabs">${S.card.races.map((x) => `<a href="#/race/${x.number}" class="${x.number === n ? 'on' : ''}">${x.number}</a>`).join('')}</div></div>
  ${bannerHtml(r)}${projHtml(r)}${betsHtml(r)}
  <div class="why">${whyHtml(r)}</div>
  <div class="toolbar">
    <div class="seg" role="group" aria-label="Sort horses"><button data-sort="pgm" class="${S.prefs.sort === 'pgm' ? 'on' : ''}">Program #</button><button data-sort="proj" class="${S.prefs.sort === 'proj' ? 'on' : ''}">Projected</button></div>
    <div class="seg" role="group" aria-label="Layout"><button data-view="auto" class="${v === 'auto' ? 'on' : ''}">Auto</button><button data-view="cards" class="${v === 'cards' ? 'on' : ''}">Cards</button><button data-view="table" class="${v === 'table' ? 'on' : ''}">Table</button></div>
  </div>
  <div class="horses hview-cards ${v === 'auto' ? 'auto' : v === 'cards' ? 'force' : 'hide'}">${sorted.map((h) => horseCard(h, r, scrSet.has(h.pgm))).join('')}</div>
  <div class="hview-table ${v === 'auto' ? 'auto' : v === 'table' ? 'force' : 'hide'}">${horseTable(r, sorted, scrSet)}</div>
  <div class="notes">
    <div class="panel"><h3>Notes — Race ${n}</h3><textarea data-notes="${n}" placeholder="Your notes for this race…">${esc(S.st.notes[n] || '')}</textarea></div>
    <div class="panel"><h3>Official order</h3><div class="order">
      ${['1st', '2nd', '3rd', '4th'].map((lbl, i) => `<label>${lbl}<select data-res="${n}" data-pos="${i}">${opts(res[i])}</select></label>`).join('')}
      </div>${graded || '<div class="graded note">Enter the result after the race to grade the picks and plays.</div>'}</div>
  </div>
  <div class="racenav" style="margin-top:14px">${n > 1 ? `<a class="btn" href="#/race/${n - 1}">← Race ${n - 1}</a>` : '<span></span>'}${S.card.races.some((x) => x.number === n + 1) ? `<a class="btn primary" href="#/race/${n + 1}">Race ${n + 1} →</a>` : ''}</div>`;
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
  return { by, plays, n: rows.length, w: rows.filter((x) => x.win).length };
}
function recordTables(sum) {
  const conf = Object.entries(sum.by).sort((a, b) => b[0] - a[0]).map(([c, v]) => `<tr><td><span class="stars">${stars(+c)}</span> ${c}/5</td><td>${v.w}/${v.n}</td><td>${Math.round((100 * v.w) / v.n)}%</td><td>${v.itm}/${v.n}</td></tr>`).join('');
  const plays = Object.entries(sum.plays).map(([k, v]) => `<tr><td>${k[0].toUpperCase() + k.slice(1)}</td><td>${v.hit}/${v.n}</td><td>${v.n ? Math.round((100 * v.hit) / v.n) + '%' : '—'}</td><td>$${v.cost.toFixed(2)}</td></tr>`).join('');
  return `<div class="grid2">
    <div class="panel"><h3>Winners by confidence</h3><table class="rec"><thead><tr><th>Confidence</th><th>Won</th><th>Win %</th><th>In the money</th></tr></thead><tbody>${conf || '<tr><td colspan="4" class="muted">No graded races yet</td></tr>'}</tbody></table></div>
    <div class="panel"><h3>Plays</h3><table class="rec"><thead><tr><th>Bet</th><th>Hit</th><th>Hit %</th><th>Wagered</th></tr></thead><tbody>${plays}</tbody></table>
      <p class="note">Wagered is at the program's base amount. Payouts aren't tracked yet.</p></div></div>`;
}
function renderRecord() {
  const cur = S.key ? gradedRows(S.st) : [];
  const cards = LS.get(CARDS_KEY, {});
  const all = [];
  const per = [];
  for (const [k, v] of Object.entries(cards)) {
    const st = LS.get(stateKey(k), null);
    if (!st) continue;
    const rows = gradedRows(st);
    if (rows.length) { all.push(...rows); per.push([v, rows]); }
  }
  return `
  <div class="cardhead"><div><h1>Record</h1><div class="sub">Graded from the official orders you enter on each race page. Kept in this browser.</div></div>
    <div class="row"><button class="btn small" data-act="export">Export record</button><label class="btn small">Import<input type="file" accept=".json,application/json" data-act="import" hidden></label></div></div>
  ${S.key ? `<h2 class="section">${esc(S.card.track)} · ${esc(S.card.date)} — ${cur.length} graded</h2>${recordTables(summarize(cur))}` : ''}
  <h2 class="section">All cards — ${all.length} graded races</h2>${recordTables(summarize(all))}
  ${per.length ? `<div class="panel" style="margin-top:12px"><h3>Cards</h3><table class="rec"><thead><tr><th>Card</th><th>Graded</th><th>Winners</th></tr></thead><tbody>${per.map(([v, rows]) => `<tr><td>${esc(v.track)} · ${esc(v.date)}</td><td>${rows.length}</td><td>${rows.filter((x) => x.win).length}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

// ---------------- render: settings ----------------
function methodHtml() {
  const wt = Object.entries(DEFAULT_WEIGHTS).map(([k, v]) => `${WEIGHT_LABELS[k].toLowerCase()} ${v}`).join(', ');
  return `<div class="panel method"><h3>How the numbers are built</h3>
  <p><b>Mile-adjusted times (*)</b>: every time is converted to a mile-track equivalent (half-mile −2.0s, ⅝ −1.0s, ⅞ −0.4s; quarters get ¼ of that), then corrected for the program's track variant (0.2s per point, capped at ±1.6s), which also covers off tracks.</p>
  <p><b>Avg mark</b>: average final time over the last 5 starts, throwing out breaks, parked-out trips (3-wide at any call or first-over at 3+ calls), qualifiers and DNFs — only races from the last 120 days when there are any.</p>
  <p><b>Open ¼</b>: estimated time at the first quarter (leader's quarter + 0.2s per length behind) and average position there. <b>Close ¼</b>: the horse's own last quarter. <b>¾→Fin</b>: average spots gained or lost from the 3/4 call to the wire. <b>Avg fin L3</b>: average finish over the last 3 real starts.</p>
  <p><b>Class</b>: average class rating of the last 3 races versus today's, plus a circuit adjustment for shippers (Yonkers, the Meadowlands and Mohawk tougher; Vernon, Tioga, fairs softer).</p>
  <p><b>Added points</b>: lone speed +${ADJ.lone_speed}, closer with a hot pace +${ADJ.closer_setup}, driver upgrade +${ADJ.driver_up}/+${ADJ.driver_up_big}, tough trip that still finished close +${ADJ.tough_trip} each (max +${ADJ.tough_trip_cap}); speed duel ${ADJ.speed_duel}, driver downgrade ${ADJ.driver_down}. Penalties for breaks, layoffs, stale form and thin data.</p>
  <p><b>Winner confidence</b> blends the top pick's points margin with data quality. <b>Undercard</b> rates how often the projected 2nd–5th finish within one spot of projection in 40,000 simulated races.</p>
  <p><b>Plays</b>: trifecta KEY when the winner is 4/5+ and 30%+ to win; BOX the top three when the winner isn't a lock but the undercard is 3/5+; otherwise a 4-horse box or a pass. Exacta keys over the next two in key races and boxes the top three in box races. Superfecta keys over the next four when the undercard is 3/5+, or boxes four when it's 4/5+.</p>
  <p><b>Default weights</b>: ${wt}. <b>Bold</b> pros and cons are the race-deciding ones. <b>VALUE</b> flags a top-3 contender the model gives 15%+ whose morning line is at least 2× its fair odds.</p></div>`;
}
function renderSettings() {
  return `<div class="cardhead"><div><h1>Settings</h1><div class="sub">Tune what matters to you. Changes re-rank every race instantly and stay in this browser.</div></div>
    <div class="row"><button class="btn small" data-act="reset-weights">Reset to defaults</button></div></div>
  <div class="panel"><h3>Ranking weights</h3><div class="weights">
    ${Object.keys(DEFAULT_WEIGHTS).map((k) => `<div class="w"><label for="w-${k}">${WEIGHT_LABELS[k]}</label><output id="o-${k}">${S.weights[k]}</output>
      <input type="range" id="w-${k}" min="0" max="30" step="1" value="${S.weights[k]}" data-w="${k}"></div>`).join('')}
  </div><p class="note">0 turns a factor off. Default total is 100, but any mix works — what matters is how big each one is next to the others.</p></div>
  <div style="margin-top:12px">${methodHtml()}</div>`;
}

// ---------------- print ----------------
function buildPrint() {
  const c = S.card;
  const cover = `<section class="pp cover"><h1>${esc(c.track)} <span class="muted" style="font-size:11pt">${esc(c.date)}</span></h1>
    <table><thead><tr><th>Race</th><th>Post</th><th>Gait</th><th>Purse</th><th>Winner</th><th>Undercard</th><th>Projected winner</th><th>2nd</th><th>3rd</th><th>Trifecta</th><th>Exacta</th><th>Superfecta</th></tr></thead><tbody>
    ${c.races.map((r) => { const rk = r.ranked; const p = (t) => (t.type === 'PASS' || t.type === 'N/A' ? `<span class="faint">${t.type === 'PASS' ? 'pass' : 'n/a'}</span>` : `${esc(tc(t.type))} ${esc(t.text)}`);
      return `<tr class="${r.confidence >= 5 ? 'hi' : ''}"><td><b>${r.number}</b></td><td>${esc(r.post_time)}</td><td>${esc(tc(r.gait))}</td><td>${money(r.purse)}</td>
      <td><span class="stars">${stars(r.confidence)}</span> ${r.confidence}/5</td><td><span class="stars u">${stars(r.undercard)}</span> ${r.undercard}/5</td>
      <td><b>#${rk[0].pgm} ${esc(tc(rk[0].name))}</b> (${esc(rk[0].ml)})</td><td>#${rk[1].pgm} ${esc(tc(rk[1].name))}</td><td>${rk[2] ? '#' + rk[2].pgm + ' ' + esc(tc(rk[2].name)) : ''}</td>
      <td>${p(r.trifecta)}</td><td>${p(r.exacta)}</td><td>${p(r.superfecta)}</td></tr>`; }).join('')}
    </tbody></table><p class="muted" style="margin-top:6px">Model estimates from the program — check scratches and changes before you bet.</p></section>`;
  const races = c.races.map((r) => {
    const scrSet = new Set(S.st.scratches[r.number] || []);
    const sorted = [...r.horses].sort((a, b) => a.pgm - b.pgm);
    const res = S.st.results[r.number] || [];
    return `<section class="pp">${bannerHtml(r)}${projHtml(r)}${betsHtml(r)}<div class="why">${whyHtml(r)}</div>
      ${horseTable(r, sorted, scrSet, true)}
      <div class="pnotes"><span class="ord">OFFICIAL ORDER ${['1st', '2nd', '3rd', '4th'].map((l, i) => `${l}<span>${res[i] || ''}</span>`).join('')}</span>NOTES — RACE ${r.number}<br>${esc(S.st.notes[r.number] || '')}</div></section>`;
  }).join('');
  const root = $('#print');
  root.innerHTML = cover + races;
  // shrink any page that would spill onto a second sheet (7.86in of printable height)
  const maxH = 7.8 * 96;
  for (const pg of root.querySelectorAll('.pp')) {
    pg.style.zoom = '';
    const h = pg.scrollHeight;
    if (h > maxH) pg.style.zoom = String(Math.max(0.6, (maxH / h) * 0.99));
  }
}

// ---------------- router ----------------
function render() {
  const hash = location.hash || '#/';
  const upload = $('#upload'), view = $('#view'), nav = $('#topnav');
  nav.hidden = !S.key;
  for (const a of nav.querySelectorAll('a')) a.classList.remove('on');
  const route = hash.replace(/^#\/?/, '');
  if (route === 'settings' || route === 'record') {
    upload.hidden = true; view.hidden = false;
    view.innerHTML = route === 'settings' ? renderSettings() : renderRecord();
    nav.querySelector(`[data-nav="${route}"]`)?.classList.add('on');
    return;
  }
  if (!S.key) { upload.hidden = false; view.hidden = true; renderRecent(); return; }
  upload.hidden = true; view.hidden = false;
  const m = route.match(/^race\/(\d+)/);
  if (m) { view.innerHTML = renderRace(+m[1]); }
  else { view.innerHTML = renderCard(); nav.querySelector('[data-nav="card"]').classList.add('on'); }
}

function renderRecent() {
  const cards = LS.get(CARDS_KEY, {});
  const keys = Object.keys(cards).sort((a, b) => cards[b].savedAt - cards[a].savedAt);
  $('#recent').innerHTML = keys.length ? `<div class="note">Recent programs on this device</div>` +
    keys.map((k) => `<button class="btn" data-open="${esc(k)}">${esc(cards[k].track)} · ${esc(cards[k].date)}</button>`).join('') : '';
}

// ---------------- events ----------------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-scr],[data-sort],[data-view],[data-act],[data-open]');
  if (!t) return;
  if (t.dataset.scr) {
    const n = +location.hash.match(/race\/(\d+)/)?.[1];
    const pgm = +t.dataset.scr;
    const list = new Set(S.st.scratches[n] || []);
    if (list.has(pgm)) list.delete(pgm); else list.add(pgm);
    S.st.scratches[n] = [...list];
    const r = S.card.races.find((x) => x.number === n);
    if (r.horses.length - list.size < 2) { list.delete(pgm); S.st.scratches[n] = [...list]; alert('A race needs at least two starters.'); return; }
    scoreOne(r);
    if ((S.st.results[n] || []).some(Boolean)) S.st.snaps[n] = snapshot(r);
    saveState(); render();
  } else if (t.dataset.sort) { S.prefs.sort = t.dataset.sort; LS.set(PREF_KEY, S.prefs); render(); }
  else if (t.dataset.view) { S.prefs.view = t.dataset.view; LS.set(PREF_KEY, S.prefs); render(); }
  else if (t.dataset.open) {
    const cards = LS.get(CARDS_KEY, {});
    const v = cards[t.dataset.open];
    if (v) { openCard(t.dataset.open, v.card); location.hash = '#/'; render(); }
  } else if (t.dataset.act === 'new') {
    S.key = null; location.hash = '#/'; render(); $('#file').value = ''; $('#file').click();
  } else if (t.dataset.act === 'reset-weights') {
    S.weights = { ...DEFAULT_WEIGHTS }; LS.set(WEIGHTS_KEY, {}); if (S.key) rescoreAll(); render();
  } else if (t.dataset.act === 'export') {
    const cards = LS.get(CARDS_KEY, {});
    const out = { exported: new Date().toISOString(), cards: {} };
    for (const k of Object.keys(cards)) { const st = LS.get(stateKey(k), null); if (st) out.cards[k] = { track: cards[k].track, date: cards[k].date, state: st }; }
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
    const r = S.card.races.find((x) => x.number === n);
    if (arr.some(Boolean)) S.st.snaps[n] = snapshot(r); else delete S.st.snaps[n];
    saveState(); render();
  }
  if (t.dataset.act === 'import' && t.files[0]) {
    try {
      const data = JSON.parse(await t.files[0].text());
      const cards = LS.get(CARDS_KEY, {});
      for (const [k, v] of Object.entries(data.cards || {})) {
        LS.set(stateKey(k), v.state);
        if (!cards[k]) cards[k] = { track: v.track, date: v.date, savedAt: 0, card: { track: v.track, date: v.date, races: [] } };
      }
      LS.set(CARDS_KEY, cards);
      if (S.key) S.st = { ...S.st, ...LS.get(stateKey(S.key), {}) };
      render();
    } catch { alert("That file isn't a Harness Handicapper record."); }
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.notes) { S.st.notes[t.dataset.notes] = t.value; saveState(); }
  if (t.dataset.w) {
    S.weights[t.dataset.w] = +t.value;
    $('#o-' + t.dataset.w).textContent = t.value;
    const diff = Object.fromEntries(Object.entries(S.weights).filter(([k, v]) => DEFAULT_WEIGHTS[k] !== v));
    LS.set(WEIGHTS_KEY, diff);
    clearTimeout(S._wt); S._wt = setTimeout(() => { if (S.key) rescoreAll(); }, 150);
  }
});

const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

$('#printBtn').addEventListener('click', () => { if (!S.key) return; buildPrint(); window.print(); });
window.addEventListener('beforeprint', () => { if (S.key) buildPrint(); });
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

// reopen the most recent card on this device
(function init() {
  const cards = LS.get(CARDS_KEY, {});
  const keys = Object.keys(cards).filter((k) => cards[k].card && cards[k].card.races.length).sort((a, b) => cards[b].savedAt - cards[a].savedAt);
  if (keys.length && (Date.now() - cards[keys[0]].savedAt) < 36 * 3600 * 1000) openCard(keys[0], cards[keys[0]].card);
  render();
})();
