// ---------------------------------------------------------------------------
// Shared results pool (Marshall's 4th ask, Nov 17): every graded race's
// model-view-before-the-race + official finish gets pooled across every
// device/browser that uses the site, so everyone's learning draws on
// everyone's results — not just the ones entered on this one device.
// Backend: Supabase (his pick). Write access is wide open (his pick, so
// anyone using the site adds to the pool with no sign-in and no gate).
//
// Privacy: the only things ever sent are race identity (track/date/race
// number/gait/size), each horse's feature vector as the model already
// computed it (no names needed — program number is enough), and the
// official finish order. Never sent: bets, picks, notes, scratches typed
// in for betting purposes, live odds you typed in, driver overrides, or
// anything else personal. This is exactly the same data `snapshot()` and
// `learnRows()` already use locally — the pool is just a second place that
// data also goes.
//
// Resilience: every call here fails silently. If the pool is unreachable
// (offline, the Supabase project hasn't been set up yet, a hiccup) the
// site keeps working exactly as it always has from this browser's own
// local results; nothing the pool does ever blocks saving, grading, or
// re-learning.
// ---------------------------------------------------------------------------
const SUPA_URL = 'https://ufbvajckitbqnixqbehc.supabase.co';
const SUPA_KEY = 'sb_publishable_riINvAfNNrJFzh1NF8srpw_zAamG5-V';
const SUPA_TABLE = `${SUPA_URL}/rest/v1/race_results`;
const supaHeaders = (extra) => ({ apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json', ...extra });

export let poolStatus = 'idle';   // idle | ok | error — last attempt's outcome, for a small status line in the UI
const TIMEOUT_MS = 6000;
function withTimeout(ms) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return { signal: c.signal, done: () => clearTimeout(t) }; }

export function normKey(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
export function ymd(ms) { return ms == null ? null : new Date(ms).toISOString().slice(0, 10); }
// the first run of truthy values (matches how learnRows() reads a partially-filled result)
export function firstRun(arr) { const out = []; for (const x of arr || []) { if (!x) break; out.push(x); } return out; }

export function poolKeyFor(trackKey, dateStr, raceNo) { return `${trackKey}|${dateStr}|${raceNo}`; }

// push one graded race to the shared pool (fire-and-forget; never throws)
export async function pushToPool(row) {
  const { signal, done } = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPA_TABLE}?on_conflict=track_key,race_date,race_no`, {
      method: 'POST', signal,
      headers: supaHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([row]),
    });
    poolStatus = res.ok ? 'ok' : 'error';
    return res.ok;
  } catch { poolStatus = 'error'; return false; } finally { done(); }
}

let _cache = { at: 0, rows: null };
const CACHE_MS = 60000;   // reuse the last pull for a minute so a burst of result edits doesn't hammer the pool
// pull every pooled race (best-effort). Returns [] (not null) on any failure so callers never have to special-case it.
export async function pullPool(force = false) {
  if (!force && _cache.rows && Date.now() - _cache.at < CACHE_MS) return _cache.rows;
  const { signal, done } = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPA_TABLE}?select=track_key,race_date,race_no,gait,track_size,entries,finish&limit=20000`, { signal, headers: supaHeaders() });
    if (!res.ok) { poolStatus = 'error'; return _cache.rows || []; }
    const data = await res.json();
    poolStatus = 'ok';
    _cache = { at: Date.now(), rows: Array.isArray(data) ? data : [] };
    return _cache.rows;
  } catch { poolStatus = 'error'; return _cache.rows || []; } finally { done(); }
}

// convert one pool row (as stored) into the same shape learnRows() builds locally, or null if it doesn't look usable
export function poolRowToLearnRow(row) {
  try {
    const fin = firstRun(row.finish);
    if (!row.entries || !Array.isArray(row.entries) || !fin.length) return null;
    if (!row.entries.some(([p]) => p === fin[0])) return null;
    return {
      feat: row.entries, fin: fin.slice(0, 3), track: row.track_key, size: row.track_size ?? null,
      gait: row.gait || null, card: `pool:${row.track_key}|${row.race_date}`,
      key: poolKeyFor(row.track_key, row.race_date, row.race_no),
    };
  } catch { return null; }
}
