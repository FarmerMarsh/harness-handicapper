# Harness Handicapper

Upload a USTA / Trackmaster harness program PDF and get every race handicapped:

- Races in numerical order, each with a **winner confidence** and an **undercard (2nd–5th) confidence**, rated out of 5
- Projected top five with model win % and fair odds, plus value flags against the morning line
- **Exacta, trifecta and superfecta** plays (key, box or pass) with combos, cost and model hit chance
- Every horse: lifetime / current-year / average mark, opening and closing quarter, ¾→finish late move, average finish last 3, lifetime and current-year win % and top-3 %, and pros and cons with the race-deciding ones in bold
- Pace, driver changes, tough trips, track variant and class / shipper adjustments all feed the ranking
- **Scratch** a horse and the race re-ranks instantly
- Notes and official-order boxes on every race; the **Record** page grades the picks and plays over time
- **Settings** to tune the ranking weights
- **Print / PDF** gives one landscape page per race

Everything runs in the browser. The program PDF is read on the viewer's own device and never uploaded anywhere; notes, scratches, results and settings are kept in that browser's local storage.

## Files

- `index.html`, `css/app.css`, `js/app.js` — the page
- `js/parse.js` — Trackmaster program parser (pdf.js text positions)
- `js/engine.js` — scoring engine, finish-order simulation, plays, pros and cons
- `vendor/` — pdf.js (Apache-2.0, see `vendor/PDFJS-LICENSE`)

Model estimates only — check scratches and changes before you bet.
