// Runs the learning fit off the main thread so the page never freezes.
import { learnAll } from './learn.js?v=29';

self.onmessage = (e) => {
  try { self.postMessage({ ok: true, result: learnAll(e.data.rows) }); } catch (err) { self.postMessage({ ok: false, error: String(err && err.stack || err) }); }
};
