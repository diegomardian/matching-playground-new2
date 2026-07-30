// Calendar-time simulation: measures the OPERATIONAL advantages the head-to-head
// missed. Five arms decompose the value chain:
//   statusquo  = hand greedy at Thursday meetings, no backfill (fall-through waits
//                for the NEXT meeting; offer the week after that)
//   cadence    = optimizer proposals, but still meeting-cadence only (no instant re-solve)
//   interest   = optimizer + instant backfill re-solve on every fall-through
//   choice100  = ranked top-3 + queues + instant re-solve; ALL patients ranked at day 0
//   choice50   = same, but only 50% ranked at day 0; the rest rank at their first
//                appointment (day 7) and only then enter the pool
// Offers always happen at the patient's next weekly appointment (+7d after being
// proposed). Decline resolves at the offer; pre-screen fail at +2d; screen fail or
// enrollment at +7d. Horizon 84 days.
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
global.window = undefined;
global.ENGINE = require(path.join(ROOT, "match-engine.js"));
const ENGINES = require(path.join(ROOT, "engines-v345.js"));

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function shuffle(arr, rand) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const N_RUNS = 400, N_T = 4, N_P = 8, ELIG_P = 0.6, H = 84;
const ACCEPT_BY_RANK = [0.95, 0.85, 0.7, 0.55, 0.45];
const PRESCREEN_PASS = 0.8, SCREEN_PASS = 0.85;

function makePop(rand) {
  const trials = Array.from({ length: N_T }, (_, t) => ({ t, slots: 1 + (rand() < 0.4 ? 1 : 0) }));
  const patients = Array.from({ length: N_P }, (_, idx) => {
    const elig = [];
    for (let t = 0; t < N_T; t++) if (rand() < ELIG_P) elig.push(t);
    if (!elig.length) elig.push(Math.floor(rand() * N_T));
    return { idx, elig, latent: shuffle(elig, rand) };
  });
  return { trials, patients };
}

function run(pop, arm, rand) {
  const isChoice = arm.startsWith("choice");
  const instant = arm === "interest" || isChoice;
  const ps = pop.patients.map((p) => ({ ...p, knocked: new Set(), enrolled: null, enrolledDay: null, pending: null,
    choices: p.latent.slice(0, 3), ranksDay: (arm === "choice50" && rand() < 0.5) ? 7 : 0 }));
  const m = { appointments: 0, offers: 0 };

  function enginePropose(day) {
    const st = {
      fields: [{ name: "tags", label: "Tags", kind: "set", unit: "" }],
      patients: ps.map((p, i) => {
        const sp = { id: "P" + String(i).padStart(2, "0"), name: "P" + i, attrs: { tags: p.elig.map((t) => "t" + t) }, preferences: {}, pinned: null };
        sp.enrolled = p.enrolled != null ? "T" + p.enrolled : (p.pending != null ? "T" + p.pending : null); // pending offers hold their seat
        if (sp.enrolled) { sp.preferences[sp.enrolled] = 1; return sp; }
        if (isChoice) {
          if (day < p.ranksDay) return sp; // not yet ranked -> not in the pool
          sp.joined = {};
          let live = p.choices.filter((t) => !p.knocked.has(t));
          if (!live.length) { // re-pick with the physician: next-best remaining eligible
            const next = p.latent.find((t) => !p.knocked.has(t) && !p.choices.includes(t));
            if (next != null) { p.choices.push(next); m.appointments++; live = [next]; }
          }
          live.forEach((t, k) => { sp.preferences["T" + t] = [3, 2, 1][k] || 1; sp.joined["T" + t] = i * 100 + k; });
        } else {
          p.elig.filter((t) => !p.knocked.has(t)).forEach((t) => { sp.preferences["T" + t] = 1; });
        }
        return sp;
      }),
      trials: pop.trials.map((tr) => ({ id: "T" + tr.t, name: "T" + tr.t, slots: tr.slots, criteria: [{ conds: [{ field: "tags", op: "includes", value: "t" + tr.t, value2: null }] }] })),
      params: { max_match: false },
    };
    const eng = isChoice ? ENGINES.v2choice : ENGINES.v2interest;
    return eng.match(st).result.assignments
      .map((a) => ({ p: ps[Number(a.patient_id.slice(1))], t: Number(a.trial_id.slice(1)) }))
      .filter((x) => x.p.enrolled == null && x.p.pending == null);
  }
  function greedyPropose() {
    const free = pop.trials.map((tr) => tr.slots - ps.filter((p) => p.enrolled === tr.t || p.pending === tr.t).length);
    const out = [];
    for (const p of ps) {
      if (p.enrolled != null || p.pending != null) continue;
      const t = p.elig.find((t2) => !p.knocked.has(t2) && free[t2] > 0);
      if (t != null) { free[t]--; out.push({ p, t }); }
    }
    return out;
  }
  const events = [{ day: 0, type: "solve" }];
  if (!instant) for (let d = 7; d <= H; d += 7) events.push({ day: d, type: "solve" });
  if (arm === "choice50") events.push({ day: 7, type: "ranked" });

  const schedule = (day) => {
    for (const pr of (arm === "statusquo" ? greedyPropose() : enginePropose(day))) {
      pr.p.pending = pr.t;
      events.push({ day: day + 7, type: "offer", p: pr.p, t: pr.t });
    }
  };
  while (events.length) {
    events.sort((a, b) => a.day - b.day);
    const ev = events.shift();
    if (ev.day > H) break;
    if (ev.type === "solve") { schedule(ev.day); continue; }
    if (ev.type === "ranked") { m.appointments += ps.filter((p) => p.ranksDay === 7).length; if (instant) schedule(ev.day); continue; }
    if (ev.type === "offer") {
      const { p, t } = ev;
      m.appointments++; m.offers++;
      const acc = ACCEPT_BY_RANK[Math.min(p.latent.indexOf(t), ACCEPT_BY_RANK.length - 1)];
      if (rand() > acc) events.push({ day: ev.day, type: "knock", p, t });
      else if (rand() > PRESCREEN_PASS) events.push({ day: ev.day + 2, type: "knock", p, t });
      else if (rand() > SCREEN_PASS) events.push({ day: ev.day + 7, type: "knock", p, t });
      else events.push({ day: ev.day + 7, type: "enroll", p, t });
      continue;
    }
    if (ev.type === "knock") {
      ev.p.knocked.add(ev.t); ev.p.pending = null;
      // statusquo penalty: the fall-through is only DISCUSSED at the next meeting
      // (weekly solve events already model that); instant arms re-plan today.
      if (instant) schedule(ev.day);
      continue;
    }
    if (ev.type === "enroll") { ev.p.enrolled = ev.t; ev.p.enrolledDay = ev.day; ev.p.pending = null; continue; }
  }
  const enrolled = ps.filter((p) => p.enrolled != null);
  const seats = pop.trials.reduce((a, t) => a + t.slots, 0);
  // seat idle: per seat, days until its enrollment landed (horizon if never)
  let idle = 0;
  pop.trials.forEach((tr) => {
    const days = ps.filter((p) => p.enrolled === tr.t).map((p) => p.enrolledDay).sort((a, b) => a - b);
    for (let k = 0; k < tr.slots; k++) idle += k < days.length ? days[k] : H;
  });
  return {
    enrolled: enrolled.length, seats, fillPct: enrolled.length / seats,
    by28: enrolled.filter((p) => p.enrolledDay <= 28).length / seats,
    meanDay: enrolled.length ? enrolled.reduce((a, p) => a + p.enrolledDay, 0) / enrolled.length : NaN,
    idlePerSeat: idle / seats,
    appointments: m.appointments, offers: m.offers,
  };
}

const agg = {};
function add(key, r) { const a = (agg[key] = agg[key] || { sums: {}, ns: {} }); for (const [k, v] of Object.entries(r)) if (isFinite(v)) { a.sums[k] = (a.sums[k] || 0) + v; a.ns[k] = (a.ns[k] || 0) + 1; } }
const ARMS = ["statusquo", "cadence", "interest", "choice100", "choice50"];
for (let i = 0; i < N_RUNS; i++) {
  const pop = makePop(rng(1000 + i));
  for (const arm of ARMS) add(arm, run(pop, arm, rng(7e6 + i)));
}
console.log(`runs=${N_RUNS} · horizon ${H}d · offers land at next weekly appointment · statusquo/cadence re-plan only on Thursdays\n`);
const fmt = (x, d = 1) => x.toFixed(d);
for (const arm of ARMS) {
  const a = agg[arm]; const g = (k) => a.sums[k] / a.ns[k];
  console.log(arm.padEnd(10)
    + " fill " + fmt(100 * g("fillPct")) + "%"
    + " · filled by day 28: " + fmt(100 * g("by28")) + "%"
    + " · mean day-to-enroll " + fmt(g("meanDay")) + "d"
    + " · seat-idle " + fmt(g("idlePerSeat")) + "d"
    + " · appts " + fmt(g("appointments")));
}
