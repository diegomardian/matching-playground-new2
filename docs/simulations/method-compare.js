// Head-to-head: v2choice (ranked top-3 + per-trial queues) vs v2interest
// (unordered interest + backfill) on identical random populations, using the
// playground's real engines. Patients carry a LATENT preference ranking:
// choice mode encodes it upfront (top-3 hearts); interest mode cannot see it
// (team marks all eligible trials), so preference surfaces only as declines.
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
global.window = undefined;
global.ENGINE = require(path.join(ROOT, "match-engine.js"));
const ENGINES = require(path.join(ROOT, "engines-v345.js"));

// deterministic LCG so runs are reproducible
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function shuffle(arr, rand) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const N_RUNS = 400, N_T = 4, N_P = 8, ELIG_P = 0.6;
const ACCEPT_BY_RANK = [0.95, 0.85, 0.7, 0.55, 0.45]; // latent rank 1..5+
const PRESCREEN_PASS = 0.8, SCREEN_PASS = 0.85;

function makePop(rand) {
  const trials = Array.from({ length: N_T }, (_, t) => ({ t, slots: 1 + (rand() < 0.4 ? 1 : 0) }));
  const patients = Array.from({ length: N_P }, (_, idx) => {
    const elig = [];
    for (let t = 0; t < N_T; t++) if (rand() < ELIG_P) elig.push(t);
    if (!elig.length) elig.push(Math.floor(rand() * N_T));
    return { idx, elig, latent: shuffle(elig, rand) }; // latent[0] = true favorite
  });
  return { trials, patients };
}

function baseState(pop, maxMatch) {
  return {
    fields: [{ name: "tags", label: "Tags", kind: "set", unit: "" }],
    patients: pop.patients.map((p) => ({ id: "P" + String(p.idx).padStart(2, "0"), name: "P" + p.idx, attrs: { tags: p.elig.map((t) => "t" + t) }, preferences: {} })),
    trials: pop.trials.map((tr) => ({ id: "T" + tr.t, name: "T" + tr.t, slots: tr.slots, criteria: [{ conds: [{ field: "tags", op: "includes", value: "t" + tr.t, value2: null }] }] })),
    params: { max_match: maxMatch },
  };
}

function simulate(pop, method, rand, maxMatch) {
  const ps = pop.patients.map((p) => ({ ...p, knocked: new Set(), enrolled: null, choices: method === "choice" ? p.latent.slice(0, 3) : null }));
  const m = { offers: 0, declines: 0, prescreens: 0, screens: 0, waves: 0, repicks: 0 };
  while (m.waves < 40) {
    const st = baseState(pop, maxMatch);
    st.patients.forEach((sp, i) => {
      const p = ps[i];
      sp.enrolled = p.enrolled;
      if (method === "choice") {
        sp.joined = {};
        const cs = p.choices.filter((t) => !p.knocked.has(t));
        cs.forEach((t, k) => { sp.preferences["T" + t] = [3, 2, 1][k] || 1; sp.joined["T" + t] = i * 100 + k; });
        if (p.enrolled) sp.preferences[p.enrolled] = sp.preferences[p.enrolled] || 1;
      } else {
        sp.pinned = null;
        p.elig.filter((t) => !p.knocked.has(t)).forEach((t) => { sp.preferences["T" + t] = 1; });
        if (p.enrolled) sp.preferences[p.enrolled] = 1;
      }
    });
    const eng = method === "choice" ? ENGINES.v2choice : ENGINES.v2interest;
    const res = eng.match(st).result;
    const proposals = res.assignments.filter((a) => !ps[Number(a.patient_id.slice(1))].enrolled);
    if (!proposals.length) {
      // choice mode: an exhausted patient goes back to the physician and picks
      // their next-best remaining eligible trial (a re-selection touchpoint)
      if (method === "choice") {
        let repicked = false;
        ps.forEach((p) => {
          if (p.enrolled) return;
          if (p.choices.some((t) => !p.knocked.has(t))) return; // has live picks; pool is just full
          const next = p.latent.find((t) => !p.knocked.has(t) && !p.choices.includes(t));
          if (next != null) { p.choices.push(next); m.repicks++; repicked = true; }
        });
        if (repicked) continue;
      }
      break;
    }
    m.waves++;
    let progress = false;
    for (const a of proposals) {
      const p = ps[Number(a.patient_id.slice(1))];
      const t = Number(a.trial_id.slice(1));
      m.offers++;
      const acc = ACCEPT_BY_RANK[Math.min(p.latent.indexOf(t), ACCEPT_BY_RANK.length - 1)];
      if (rand() > acc) { m.declines++; p.knocked.add(t); progress = true; continue; }
      m.prescreens++;
      if (rand() > PRESCREEN_PASS) { p.knocked.add(t); progress = true; continue; }
      m.screens++;
      if (rand() > SCREEN_PASS) { p.knocked.add(t); progress = true; continue; }
      p.enrolled = "T" + t; progress = true;
    }
    if (!progress) break;
  }
  const enrolled = ps.filter((p) => p.enrolled);
  const seats = pop.trials.reduce((a, t) => a + t.slots, 0);
  const ranks = enrolled.map((p) => p.latent.indexOf(Number(p.enrolled.slice(1))) + 1);
  return {
    enrolled: enrolled.length, seats,
    fillPct: enrolled.length / seats,
    meanRank: ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : NaN,
    top1Pct: ranks.length ? ranks.filter((r) => r === 1).length / ranks.length : NaN,
    ...m,
  };
}

const agg = {};
function add(key, r) {
  const a = (agg[key] = agg[key] || { n: 0, sums: {} });
  a.n++;
  for (const [k, v] of Object.entries(r)) if (isFinite(v)) { a.sums[k] = (a.sums[k] || 0) + v; a.sums["_n_" + k] = (a.sums["_n_" + k] || 0) + 1; }
}
for (let run = 0; run < N_RUNS; run++) {
  const popRand = rng(1000 + run);
  const pop = makePop(popRand);
  // identical outcome randomness per method: same seed stream per arm
  add("choice (hearts, value plan)", simulate(pop, "choice", rng(9e6 + run), false));
  add("choice (hearts, max-match)", simulate(pop, "choice", rng(9e6 + run), true));
  add("interest (backfill)", simulate(pop, "interest", rng(9e6 + run), false));
}
console.log(`runs=${N_RUNS} · patients=${N_P} · trials=${N_T} (1-2 seats) · elig p=${ELIG_P}`);
console.log(`accept by latent rank: ${ACCEPT_BY_RANK.join("/")} · prescreen ${PRESCREEN_PASS} · screen ${SCREEN_PASS}\n`);
const fmt = (x, d = 2) => x.toFixed(d);
for (const [key, a] of Object.entries(agg)) {
  const g = (k) => a.sums[k] / (a.sums["_n_" + k] || a.n);
  console.log(key.padEnd(28)
    + " fill " + fmt(100 * g("fillPct"), 1) + "%"
    + " · enrolled " + fmt(g("enrolled")) + "/" + fmt(g("seats"), 1)
    + " · meanRank " + fmt(g("meanRank"))
    + " · got-1st " + fmt(100 * g("top1Pct"), 1) + "%"
    + " · offers " + fmt(g("offers"), 1)
    + " · declines " + fmt(g("declines"), 1)
    + " · nurse " + fmt(g("prescreens") + g("screens"), 1)
    + " · waves " + fmt(g("waves"), 1)
    + " · repicks " + fmt(g("repicks"), 2));
}
