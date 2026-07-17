# Matching Playground

A standalone, **100% client-side** study harness for two-stage patient ↔ clinical-trial
matching: a boolean **eligibility pre-filter** → **Hungarian** optimal assignment.

Open `index.html` in any browser, or host the folder on any static host (GitHub Pages,
Cloudflare Pages, Netlify…). There is **no backend** — the matching engine
(`engine.js`) runs entirely in the browser, and your edits are saved to that browser's
`localStorage`. Nothing leaves your machine.

## Use it

- **Engine tabs** (in the header) switch between versions, each with its own scenarios
  and saved state (per-browser, per-tab persistence):
  - **v2 · Optimizer** — the current engine: CNF eligibility gate → preference-only
    Hungarian assignment, value vs maximal-matching toggle, greedy comparison.
  - **v2 · Patient choice** — same engine, but preferences come from SphinxMatch-style
    ranked picks: each patient ranks up to 3 trials; scores derive automatically
    (1st ♥3, 2nd ♥2, 3rd ♥1, unpicked 0 = won't take).
  - **v2 · Uneven matrix** — the SAME algorithm as v2 (no changes), just visualizing
    how it already pads non-square inputs: dummy "unmatched" columns absorb surplus
    patients, dummy rows absorb surplus slots. The padded Hungarian matrix renders
    under the results (also on v3/v4).
  - **v3 · Slot urgency** — patient input is the same ranked top-3 picker (with
    per-trial queues); trials can expire in N days; cell score = rank score +
    weight × urgency (linear ramp inside a horizon, default 30 days). No-expiry
    slots still fill (urgency 0 bonus); the toolbar slider tunes how much a
    closing window can override a patient's ranking.
  - **v4 · Patient urgency** — ranked picks + queues as well; patients carry an
    urgency level (none…critical) that multiplies their whole row, so urgent
    patients win contested seats, better choices, and expiring slots (equal
    urgency falls back to the trial queue). Urgency can be set manually or derived
    from editable, reorderable diagnosis rules (e.g. SCLC + stage IV → critical,
    NSCLC + stage IV → low); the first matching rule wins, and a manual level
    still escalates when it's higher than the rule (never downgrades).
- **Simple / Advanced** toggle (top right). Simple shows inputs + assignments + why each
  patient is/ isn't matched; Advanced adds the criteria/scoring editors, the matrices,
  and the greedy-vs-optimal comparison.
- **Load example** dropdown seeds scenarios for the active tab; **Reset** restores that
  tab's default.
- Click any patient card for a criterion-by-criterion breakdown of how they matched.

## Files

| File | What |
|---|---|
| `index.html` | the page |
| `style.css` | styling |
| `engine.js` | v1 — Python-mirrored engine (lab-fit scoring + thresholds), kept for reference, not loaded |
| `match-engine.js` | v2 — the frozen current engine (global `ENGINE`) |
| `engines-v345.js` | v2-matrix / v3 / v4 — one factory, feature flags per version (global `ENGINES`) |
| `app.js` | the UI (engine tabs, renders + edits state, calls the active engine) |

The reference Python implementation, tests, and the graph-theory analysis live in the
parent project (`hungarian_demo/`).
