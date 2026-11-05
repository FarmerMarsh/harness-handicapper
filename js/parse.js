// Trackmaster (USTA) harness program parser — runs on pdf.js text content.
// Port of parse_tm.py. Coordinates are in PDF points from the top-left, like pdfplumber.

export const TRACK_SIZE = { 'Á': 0.625, 'Â': 0.875, '½': 0.5, '1': 1.0 };

const isDigits = (s) => /^\d+$/.test(s || '');

export function tsec(main, fifth = null) {
  if (main == null) return null;
  const m = String(main).replace(/[^0-9]/g, '');
  if (!m) return null;
  const f = fifth && isDigits(fifth) ? parseInt(fifth, 10) : 0;
  if (m.length === 4) return +m[0] * 60 + +m.slice(1, 3) + +m[3] / 10;
  if (m.length === 3) {
    if ('12'.includes(m[0]) && +m.slice(1) < 60) return +m[0] * 60 + +m.slice(1) + f / 10;
    return +m.slice(0, 2) + +m[2] / 10;
  }
  if (m.length === 2) return +m + f / 10;
  if (m.length === 5) return +m[0] * 60 + +m.slice(1, 3) + +m[3] / 10;
  return null;
}

export function fmtTime(s) {
  if (s == null) return '—';
  if (s >= 60) {
    const mm = Math.floor(s / 60);
    const rest = s - mm * 60;
    return `${mm}:${rest.toFixed(1).padStart(4, '0')}`;
  }
  return s.toFixed(1);
}

const FRAC = { '¼': 0.25, '½': 0.5, '¾': 0.75 };

export function parseMargin(tok) {
  const t = tok.replace(/º/g, '').replace(/x/g, '').replace(/i/g, '');
  if (!t) return null;
  if (t.startsWith('hd')) return 0.1;
  if (t.startsWith('ns')) return 0.05;
  if (t.startsWith('nk')) return 0.25;
  if (t.startsWith('ds')) return 25.0;
  const m = t.match(/^(\d*)([¼½¾]?)/);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  const v = m[1] ? parseInt(m[1], 10) : 0;
  return v + (FRAC[m[2]] || 0);
}

export function parseCall(tokens, field) {
  const raw = tokens.join(' ');
  if (!raw.trim()) return null;
  const brk = raw.replace(/xp/g, 'x').includes('x');
  const parked = (raw.match(/º/g) || []).length;
  let s = raw.trim().replace(/^(rg|og|dx|be|x|i)+/, '').replace(/ /g, '');
  const m = s.match(/^(\d+)(.*)$/);
  if (!m) return { pos: null, margin: null, parked, brk, raw };
  const digits = m[1], rest = m[2];
  let pos, mar;
  if (tokens.length >= 2 && /^[a-z]*\d+[a-z]*$/.test(tokens[0].replace(/º/g, ''))) {
    pos = parseInt(tokens[0].replace(/\D/g, ''), 10);
    mar = parseMargin(tokens.slice(1).join(''));
  } else {
    let rest2;
    if (digits.startsWith('10') && field && field >= 10 && digits.length >= 3) {
      pos = 10; rest2 = digits.slice(2) + rest;
    } else {
      pos = parseInt(digits[0], 10); rest2 = digits.slice(1) + rest;
    }
    mar = parseMargin(rest2);
  }
  return { pos, margin: pos === 1 ? 0.0 : mar, parked, brk, raw };
}

const wordsIn = (ws, x0, x1) => ws.filter((w) => w.x0 >= x0 && w.x0 < x1);

function numPair(ws) {
  ws = [...ws].sort((a, b) => a.x0 - b.x0);
  const nums = ws.map((w) => w.text);
  if (!nums.length) return [null, null];
  const last = nums[nums.length - 1];
  if (nums.length >= 2 && last.length === 1 && isDigits(last)) return [nums.slice(0, -1).join(''), last];
  return [nums[0], null];
}

function parsePPRow(ws) {
  ws = [...ws].sort((a, b) => a.x0 - b.x0);
  const txt = (a, b) => wordsIn(ws, a, b).map((w) => w.text).join(' ').trim();
  const row = { date: txt(55, 78), race_no: txt(78, 84) };
  const trk = wordsIn(ws, 83, 103).map((w) => w.text).join('').replace(/(ft|gd|sy|sl|my|wf|hy|fr)\d*$/, '');
  row.track = trk;
  row.size = TRACK_SIZE[trk.slice(-1)] ?? 0.625;
  row.cond = txt(103, 117).replace(/\d/g, '');
  row.purse = null;
  const p = txt(117, 135);
  if (isDigits(p)) row.purse = parseInt(p, 10);
  row.cls = txt(135, 172);
  const full = ws.map((w) => w.text).join(' ');
  row.scratched = full.includes('SCRATCHED');
  row.qua = row.cls.startsWith('QUA');
  if (row.scratched) return row;
  row.lead_q1 = tsec(...numPair(wordsIn(ws, 172, 189)));
  row.lead_q2 = tsec(...numPair(wordsIn(ws, 189, 201)));
  row.lead_q3 = tsec(...numPair(wordsIn(ws, 201, 215)));
  row.lead_fin = tsec(...numPair(wordsIn(ws, 215, 230)));
  const cr = txt(230, 241), sr = txt(241, 252);
  row.cr = isDigits(cr) ? parseInt(cr, 10) : null;
  row.sr = isDigits(sr) ? parseInt(sr, 10) : null;
  row.post_raw = txt(252, 272);
  const pm = row.post_raw.match(/\d+/);
  row.post = pm ? parseInt(pm[0], 10) : null;
  const fs = txt(588, 612);
  const field = isDigits(fs) ? parseInt(fs, 10) : null;
  row.field = field;
  const cols = [[272, 300], [300, 327], [327, 354], [354, 380], [380, 405]];
  const calls = cols.map(([a, b]) => {
    const toks = wordsIn(ws, a, b).map((w) => w.text);
    return toks.length ? parseCall(toks, field) : null;
  });
  row.calls = calls;
  const lq = numPair(wordsIn(ws, 405, 420));
  let ht = numPair(wordsIn(ws, 420, 434));
  let odds = txt(434, 449);
  const om0 = odds.match(/^(\d)(\d{3}\.\d)$/);
  if (om0 && ht[1] == null && ht[0] && ht[0].length === 3) { ht = [ht[0], om0[1]]; odds = om0[2]; }
  row.last_q = tsec(...lq);
  row.horse_time = tsec(...ht);
  row.odds_raw = odds;
  row.fav = odds.includes('*');
  const om = odds.match(/\d+\.\d/);
  row.odds = om ? parseFloat(om[0]) : null;
  const drvRaw = wordsIn(ws, 436, 500).filter((w) => !/^[*e]*\d+\.\d$/.test(w.text)).map((w) => w.text).join(' ');
  const dm = drvRaw.match(/([A-Z][\w'\-]*(?: [A-Z][\w'\-]*)?),\s*([A-Z][a-z]*\.?(?: [A-Z][a-z]*)?)/);
  if (dm) row.driver = `${dm[1]}, ${dm[2].replace(/(L|†)+$/, '').trim()}`;
  else { const d2 = drvRaw.match(/^([A-Z][\w'\-]+)/); row.driver = d2 ? d2[1] : ''; }
  const vm = txt(484, 500).replace(/†/g, '').match(/[+-]?\d+/g);
  row.var = vm ? parseInt(vm[vm.length - 1], 10) : null;
  row.brk = row.post_raw.includes('x') || calls.some((c) => c && c.brk) ||
    (full.split('Top')[0].includes('ds') && calls.some((c) => c && c.raw.includes('ds')));
  row.dnf = full.includes('dnf') || calls.filter(Boolean).map((c) => c.raw).join(' ').includes('pu');
  row.parked_calls = calls.slice(0, 4).filter((c) => c && c.parked >= 1).length;
  row.parked3w = calls.slice(0, 4).some((c) => c && c.parked >= 2);
  const f = calls[4];
  row.finish = f ? f.pos : null;
  row.beaten = f ? f.margin : null;
  const c1 = calls[0];
  if (c1 && row.lead_q1 != null && c1.pos) {
    const mar = c1.margin || 0;
    row.open_q = row.lead_q1 + 0.2 * (c1.pos > 1 ? mar : 0);
    row.open_pos = c1.pos;
  } else { row.open_q = null; row.open_pos = null; }
  return row;
}

function clusterRows(ws, anchors) {
  const out = new Map(anchors.map((a) => [a, []]));
  for (const w of ws) {
    let best = null, bd = Infinity;
    for (const a of anchors) {
      const d = w.top >= a - 1.6 ? Math.abs((w.top + 0.5) - (a + 3)) : 999;
      if (d < bd) { bd = d; best = a; }
    }
    if (best != null && w.top >= best - 1.6 && w.top < best + 7) out.get(best).push(w);
  }
  return out;
}

function parseStatsBox(ws) {
  const labels = ws.filter((w) => w.text === 'Life' || w.text === 'Off' || (/^20\d\d$/.test(w.text) && w.x0 > 465 && w.x0 < 480))
    .sort((a, b) => a.top - b.top);
  const res = {};
  for (const lab of labels) {
    const t0 = lab.top;
    const band = ws.filter((w) => w.x0 >= 478 && w.top >= t0 - 1.8 && w.top <= t0 + 1.8 && w !== lab).sort((a, b) => a.x0 - b.x0);
    const nums = (band.filter((w) => w.x0 < 530 && !w.text.startsWith('$') && (w.text.includes('~') || isDigits(w.text))).sort((a, b) => a.x0 - b.x0)
      .map((w) => w.text).join(' ').match(/\d+/g) || []).map(Number);
    const st = {};
    if (nums.length >= 4) Object.assign(st, { starts: nums[0], wins: nums[1], places: nums[2], shows: nums[3] });
    const earn = band.filter((w) => w.text.startsWith('$')).map((w) => w.text);
    st.earnings = earn.length ? parseInt(earn[0].replace(/[$,]/g, ''), 10) : 0;
    // mark area: <time> [fifth] <track…> <age>[Q]   e.g. "154 3 YR ½ 5Q" or "150 3 PcD Á 9"
    const tail = band.filter((w) => w.x0 >= 545 && !w.text.startsWith('$') && w.text !== 'L5').sort((a, b) => a.x0 - b.x0).map((w) => w.text);
    const mm = tail.join(' ').match(/^(\d{3,4})(?:\s+(\d))?\s*([A-Za-z]+\s*[½ÁÂ1]?)\s*(\d+Q?)?/);
    if (mm && lab.text !== 'Off') {
      st.mark = tsec(mm[1], mm[1].length === 3 ? mm[2] || null : null);
      st.mark_track = mm[3].replace(/\s+/g, '');
      st.mark_size = TRACK_SIZE[st.mark_track.slice(-1)] ?? 0.625;
      st.mark_q = !!(mm[4] && mm[4].includes('Q'));
    }
    if (!(lab.text in res)) res[lab.text] = st;
  }
  return res;
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (m, a, b) => a + b.toUpperCase());

// Turn one pdf.js page into pdfplumber-like words.
export async function pageWords(page) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const words = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const [, , c, d, e, f] = it.transform;
    const size = Math.hypot(c, d);
    const top = vp.height - f - 0.8 * size;
    const str = it.str;
    const n = str.length;
    const cw = n ? it.width / n : 0;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(str))) {
      words.push({ text: m[0], x0: e + cw * m.index, top, size, font: it.fontName });
    }
  }
  return { words, height: vp.height };
}

export async function parseProgram(pdfDoc) {
  const card = { track: null, date: null, races: [] };
  for (let pn = 1; pn <= pdfDoc.numPages; pn++) {
    const page = await pdfDoc.getPage(pn);
    const { words: ws, height } = await pageWords(page);
    if (!ws.length) continue;
    const head = ws.filter((w) => w.top < 28).sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(' ');
    const hm = head.match(/([A-Z ]+?)\s+-\s+([A-Z]+DAY, [A-Z]+ \d+, \d{4})/);
    if (hm && !card.track) { card.track = titleCase(hm[1].trim()); card.date = titleCase(hm[2]); }
    const rn = ws.filter((w) => w.size > 33 && w.top < 45 && isDigits(w.text));
    const footTxt = ws.filter((w) => w.top > height - 40).sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(' ');
    const fm = footTxt.match(/Race (\d+)\s*-\s*Page/);
    const hasHorses = ws.some((w) => w.size > 25 && w.size < 33 && w.x0 < 40 && isDigits(w.text));
    let race;
    if (rn.length) {
      race = { number: parseInt(rn[0].text, 10) };
    } else if (hasHorses && card.races.length) {
      // continuation page: more horses for the race started on an earlier page
      const n = fm ? parseInt(fm[1], 10) : card.races[card.races.length - 1].number;
      race = card.races.find((r) => r.number === n);
      if (!race) continue;
      race._cont = true;
    } else continue;
    const isCont = !rn.length;
    if (!isCont) {
    const pm = head.match(/PURSE \$([\d,]+)/);
    race.purse = pm ? parseInt(pm[1].replace(/,/g, ''), 10) : null;
    const top = ws.filter((w) => w.top < 70);
    race.gait = (top.find((w) => w.text === 'PACE' || w.text === 'TROT') || {}).text || '';
    const byLine = [...top].sort((a, b) => (Math.round(a.top) - Math.round(b.top)) || (a.x0 - b.x0));
    race.conditions = byLine.filter((w) => w.x0 >= 150 && w.x0 < 462 && w.top > 30 && w.top < 62).map((w) => w.text).join(' ');
    race.wagers = byLine.filter((w) => w.x0 >= 455 && w.top > 30 && w.top < 62).map((w) => w.text).join(' ');
    const pt = byLine.filter((w) => w.top > 28).map((w) => w.text).join(' ');
    const m = pt.match(/POST\s*-\s*([\d:]+)\s+CR\s+(\d+)/);
    race.post_time = m ? m[1] : '';
    race.cr = m ? parseInt(m[2], 10) : null;
    race.horses = [];
    }
    const footTops = ws.filter((w) => w.text === 'Help' || w.text === '©').map((w) => w.top);
    const footer = footTops.length ? Math.min(...footTops) : height;
    const nums = ws.filter((w) => w.size > 25 && w.size < 33 && w.x0 < 40 && w.top > (isCont ? 10 : 60) && isDigits(w.text)).sort((a, b) => a.top - b.top);
    const horses = race.horses;
    nums.forEach((nw, i) => {
      const b0 = nw.top - 21;
      const b1 = i + 1 < nums.length ? nums[i + 1].top - 21 : footer;
      const bw = ws.filter((w) => w.top >= b0 && w.top < b1);
      const h = { pgm: parseInt(nw.text, 10) };
      const namew = bw.filter((w) => w.size > 12 && w.size < 14).sort((a, b) => a.x0 - b.x0);
      const name = namew.map((w) => w.text).join(' ');
      h.lasix = name.includes('Â');
      h.name = name.replace(/[®Â†Ã]/g, '').replace(/\s+/g, ' ').trim();
      const ml = bw.find((w) => w.x0 < 40 && /^\d+\/\d+$/.test(w.text));
      h.ml = ml ? ml.text : '';
      if (h.ml) { const [a, b] = h.ml.split('/').map(Number); h.ml_dec = b ? a / b : null; } else h.ml_dec = null;
      const clm = bw.find((w) => w.x0 < 48 && w.text.startsWith('$'));
      h.claim = clm ? clm.text : '';
      const nameTop = namew.length ? namew[0].top + 1.5 : 0;
      const ped = bw.filter((w) => w.x0 >= 236 && w.x0 < 470 && w.size > 6.8 && w.size < 7.3 && Math.abs(w.top - nameTop) < 3)
        .sort((a, b) => a.x0 - b.x0);
      h.pedigree = ped.map((w) => w.text).join(' ');
      const sa = h.pedigree.match(/^(\w+) (\w) (\d+)/);
      h.sex = sa ? sa[2] : ''; h.age = sa ? parseInt(sa[3], 10) : null;
      h.driver = ''; h.trainer = ''; h.drv_w = null; h.trn_w = null; h.drv_udr = null; h.trn_st = null; h.earn_l5 = null;
      const dl = bw.find((w) => (w.text === 'Driver' || w.text === 'Driver:') && w.x0 < 60);
      let rowsStart = b0 + 25;
      if (dl && dl.text === 'Driver:') {
        // Platinum: "Driver: JIM TAGGART JR silks   Trainer: CHRIS LEFEBVRE", stats on "Last365" lines below
        const line = bw.filter((w) => Math.abs(w.top - dl.top) < 2.5).sort((a, b) => a.x0 - b.x0);
        const caps = (arr) => { const out = []; for (const w of arr) { const t = w.text; if ((t === t.toUpperCase() && /[A-Z]/.test(t)) || t === '(P)') out.push(t); else break; } return titleCase(out.join(' ').replace('(P)', '').trim()); };
        const trIdx = line.findIndex((w) => w.text === 'Trainer:');
        h.driver = caps(line.filter((w) => w.x0 > dl.x0 && (trIdx < 0 || w.x0 < line[trIdx].x0)));
        if (trIdx >= 0) h.trainer = caps(line.slice(trIdx + 1).filter((w) => w.x0 < 465));
        const statLine = (label, x0, x1) => {
          const l = bw.filter((w) => w.text.replace('*', '') === label && w.x0 >= x0 && w.x0 < x1 && w.top > dl.top)[0];
          if (!l) return null;
          return bw.filter((w) => Math.abs(w.top - l.top) < 2 && w.x0 >= x0 && w.x0 < x1 + 190).sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(' ').replace(/~+/g, ' ');
        };
        const dS = statLine('Last365', 40, 60), tS = statLine('Last365', 230, 250);
        const num = (t, re) => { const x = t && t.match(re); return x ? parseFloat(x[1]) : null; };
        if (dS) { h.drv_st = num(dS, /St\s+(\d+)/); h.drv_w = num(dS, /W\s+(\d+)%/); h.drv_udr = num(dS, /UDR\s+([.\d]+)/); }
        if (tS) { h.trn_st = num(tS, /St\s+(\d+)/); h.trn_w = num(tS, /W\s+(\d+)%/); h.trn_utr = num(tS, /UTR\s+([.\d]+)/); }
        const l5 = bw.filter((w) => w.text.startsWith('$') && w.x0 > 560 && w.top > dl.top - 2 && w.top < dl.top + 12).map((w) => w.text);
        if (l5.length) h.earn_l5 = parseInt(l5[l5.length - 1].replace(/[$,]/g, ''), 10);
        const firstPP = bw.filter((w) => w.x0 >= 55 && w.x0 < 66 && /^\d\d[A-Z][a-z]{2}\d\d$/.test(w.text)).map((w) => w.top);
        rowsStart = firstPP.length ? Math.min(...firstPP) - 1 : dl.top + 4;
        // TrackMaster Platinum ratings
        const rat = (lab) => { const l = bw.find((w) => w.text === lab && w.x0 > 385 && w.x0 < 440); if (!l) return null; const v = bw.filter((w) => Math.abs(w.top - l.top) < 2.5 && w.x0 > l.x0 && w.x0 < l.x0 + 40 && /^\d+(\.\d)?$/.test(w.text)).sort((a, b) => a.x0 - b.x0)[0]; return v ? parseFloat(v.text) : null; };
        h.tm = { power: rat('POWER'), speed: rat('SPEED'), pace: rat('PACE'), class: rat('CLASS') };
      } else if (dl) {
        const line = bw.filter((w) => Math.abs(w.top - dl.top) < 2.5).sort((a, b) => a.x0 - b.x0);
        const lt = line.map((w) => w.text).join(' ');
        const dm = lt.match(/Driver - (.+?)\s+(?:[a-z(].*?)?\(\s*\*?St (\d+) W (\d+)% P (\d+)% S (\d+)% UDR ([.\d]+)/);
        if (dm) {
          const caps = [];
          for (const t of dm[1].split(/\s+/)) {
            if ((t === t.toUpperCase() && /[A-Z]/.test(t)) || t === '(P)' || t === 'JR' || t === 'GEO.') caps.push(t); else break;
          }
          h.driver = titleCase(caps.join(' ').replace('(P)', '').trim());
          h.drv_st = parseInt(dm[2], 10); h.drv_w = parseInt(dm[3], 10); h.drv_udr = parseFloat(dm[6]);
        }
        const tm = lt.match(/Trainer (.+?) \(\s*\*?St (\d+) W (\d+)% P (\d+)% S (\d+)%/);
        if (tm) { h.trainer = titleCase(tm[1]); h.trn_st = parseInt(tm[2], 10); h.trn_w = parseInt(tm[3], 10); }
        const l5 = line.filter((w) => w.text.startsWith('$') && w.x0 > 560).map((w) => w.text);
        if (l5.length) h.earn_l5 = parseInt(l5[l5.length - 1].replace(/[$,]/g, ''), 10);
        rowsStart = dl.top + 4;
      }
      h.stats = parseStatsBox(bw);
      h.post_rating = null;
      for (const w of bw.filter((w) => w.text.startsWith('PP') && w.x0 < 30)) {
        const nxt = bw.find((x) => Math.abs(x.top - w.top) < 1 && x.x0 > 30 && x.x0 < 45);
        if (nxt) { const r = nxt.text.match(/([+-]?\d+)/); if (r) h.post_rating = parseInt(r[1], 10); }
      }
      const allText = bw.map((w) => w.text).join(' ');
      h.equip_note = (allText.match(/(HOPPLES OFF|1ST TIME LASIX|LASIX OFF)/g) || []).join(' ');
      const anchors = [...new Set(bw.filter((w) => w.x0 >= 55 && w.x0 < 66 && /^\d\d[A-Z][a-z]{2}\d\d$/.test(w.text))
        .map((w) => Math.round(w.top * 10) / 10))].sort((a, b) => a - b);
      const rows = anchors.length ? clusterRows(bw.filter((w) => w.top > rowsStart - 2 && w.x0 > 45), anchors) : new Map();
      h.pp = anchors.map((a) => parsePPRow(rows.get(a)));
      horses.push(h);
    });
    if (!isCont) card.races.push(race);
  }
  card.races.sort((a, b) => a.number - b.number);
  return card;
}
