# Matching Playground

A standalone, **100% client-side** study harness for two-stage patient ↔ clinical-trial
matching: a boolean **eligibility pre-filter** → **Hungarian** optimal assignment.

Open `index.html` in any browser, or host the folder on any static host (GitHub Pages,
Cloudflare Pages, Netlify…). There is **no backend** — the matching engine
(`engine.js`) runs entirely in the browser, and your edits are saved to that browser's
`localStorage`. Nothing leaves your machine.

## Use it

- **Simple / Advanced** toggle (top right). Simple shows inputs + assignments + why each
  patient is/ isn't matched; Advanced adds the criteria/scoring editors, the matrices,
  and the greedy-vs-optimal comparison.
- **Load example** dropdown seeds scenarios (balanced, surplus patients, surplus slots,
  nobody eligible); **Reset** restores the default.
- Click any patient card for a criterion-by-criterion breakdown of how they matched.

## Files

| File | What |
|---|---|
| `index.html` | the page |
| `style.css` | styling |
| `engine.js` | the matching engine — Hungarian solver + eligibility + scoring + scenarios (ported from the reference Python, verified byte-identical on 800 random cases) |
| `app.js` | the UI (renders + edits state, calls `engine.js`) |

The reference Python implementation, tests, and the graph-theory analysis live in the
parent project (`hungarian_demo/`).
