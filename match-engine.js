"use strict";
/*
 * match-engine.js: redesigned client-side engine for the Matching Playground demo.
 *
 * Differs from the Python-mirrored engine.js on purpose:
 *   - PREFERENCE-only objective (no lab-fit scoring, no thresholds).
 *   - Eligibility is CNF: trial.criteria = [ group, ... ]; group = { conds:[cond,...] }.
 *     A group passes if ANY of its conds pass (OR); the trial gates if EVERY group passes (AND).
 *   - Two assignment plans from one solve: "best preference" (value) and "maximal matching"
 *     (fill the most slots, break ties by preference). A UI toggle picks which is shown.
 *
 * Exposed as global `ENGINE` (same name app.js expects). Self-contained; no backend.
 */
(function (global) {

  // ---- reason codes ---- //
  const INELIGIBLE_NO_TRIAL = "INELIGIBLE_NO_TRIAL";
  const NO_SLOT_AVAILABLE = "NO_SLOT_AVAILABLE";
  const NO_PREFERENCE = "NO_PREFERENCE";
  const NO_ELIGIBLE_PATIENT = "NO_ELIGIBLE_PATIENT";
  const NO_PATIENT_AVAILABLE = "NO_PATIENT_AVAILABLE";

  // ---- field kinds / operators ---- //
  const NUMERIC = "numeric", CATEGORICAL = "categorical", SET = "set";
  const OP_SYMBOL = { ">=": "≥", ">": ">", "<=": "≤", "<": "<", "==": "=", "!=": "≠", between: "between", includes: "includes", excludes: "excludes" };
  const OPS_FOR_KIND = {
    numeric: [">=", ">", "<=", "<", "==", "!=", "between"],
    categorical: ["==", "!="],
    set: ["includes", "excludes"],
  };

  // ---- value helpers ---- //
  const asFloat = (v) => { if (typeof v === "number") return isFinite(v) ? v : 0; const n = Number(v); return isFinite(n) ? n : 0; };
  const asList = (v) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : (v == null || v === "" ? [] : String(v).split(",").map((s) => s.trim()).filter(Boolean));
  const isNumber = (x) => { if (typeof x === "number") return isFinite(x); if (typeof x === "string") { if (x.trim() === "") return false; const n = Number(x); return isFinite(n); } return false; };
  const defaultValue = (kind) => kind === NUMERIC ? 0 : (kind === SET ? [] : "");
  const fmtNum = (x) => { const n = Number(x); return isFinite(n) ? String(n) : String(x); };

  function evaluate(op, pv, target, kind, target2) {
    if (kind === NUMERIC) {
      const x = asFloat(pv);
      if (op === "between") { let lo = asFloat(target), hi = asFloat(target2); if (lo > hi) { const t = lo; lo = hi; hi = t; } return lo <= x && x <= hi; }
      const t = asFloat(target);
      switch (op) { case ">=": return x >= t; case ">": return x > t; case "<=": return x <= t; case "<": return x < t; case "==": return x === t; case "!=": return x !== t; default: return false; }
    }
    if (kind === CATEGORICAL) { const a = String(pv == null ? "" : pv).trim(), b = String(target == null ? "" : target).trim(); return op === "!=" ? a !== b : a === b; }
    if (kind === SET) { const m = asList(pv), b = String(target == null ? "" : target).trim(); if (op === "includes") return m.indexOf(b) >= 0; if (op === "excludes") return m.indexOf(b) < 0; }
    return false;
  }

  const fieldsByName = (fields) => { const m = {}; (fields || []).forEach((f) => { m[f.name] = f; }); return m; };

  // ---- CNF eligibility ---- //
  function condDetail(p, c, fm) {
    const f = fm[c.field], kind = f ? f.kind : CATEGORICAL;
    const pv = (p.attrs && c.field in p.attrs) ? p.attrs[c.field] : defaultValue(kind);
    return {
      field: c.field, label: f ? f.label : c.field, op: c.op, op_symbol: OP_SYMBOL[c.op] || c.op,
      value: c.value, value2: c.value2, kind, unit: (f && f.kind === NUMERIC) ? f.unit : "",
      patient_value: pv, passed: evaluate(c.op, pv, c.value, kind, c.value2),
    };
  }
  function gateTrial(p, t, fm) {
    const groups = (t.criteria || []).map((g) => {
      const conds = (g.conds || []).map((c) => condDetail(p, c, fm));
      return { conds, passed: conds.length ? conds.some((c) => c.passed) : true };
    });
    return { eligible: groups.every((g) => g.passed), groups };
  }

  function expandSlots(trials) {
    const out = [];
    trials.forEach((t) => { const k = Math.max(1, t.slots || 1); for (let i = 0; i < k; i++) out.push({ trial_id: t.id, index: i, label: k <= 1 ? t.name : `${t.name} #${i + 1}` }); });
    return out;
  }

  // ---- Hungarian (min-cost square) ---- //
  function hungarian(cost) {
    const n = cost.length; if (!n) return [];
    const INF = Infinity;
    const u = Array(n + 1).fill(0), v = Array(n + 1).fill(0), p = Array(n + 1).fill(0), way = Array(n + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i; let j0 = 0;
      const minv = Array(n + 1).fill(INF), used = Array(n + 1).fill(false);
      do {
        used[j0] = true; const i0 = p[j0]; let dl = INF, j1 = -1;
        for (let j = 1; j <= n; j++) if (!used[j]) { const cur = cost[i0 - 1][j - 1] - u[i0] - v[j]; if (cur < minv[j]) { minv[j] = cur; way[j] = j0; } if (minv[j] < dl) { dl = minv[j]; j1 = j; } }
        for (let j = 0; j <= n; j++) { if (used[j]) { u[p[j]] += dl; v[j] -= dl; } else minv[j] -= dl; } j0 = j1;
      } while (p[j0] !== 0);
      while (j0) { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; }
    }
    const a = Array(n).fill(0); for (let j = 1; j <= n; j++) if (p[j]) a[p[j] - 1] = j - 1; return a;
  }

  // maximize Σ weight over P×S. Each patient also gets a 0-value "unmatched" dummy column
  // (cols nS..nS+nP-1) so leaving a patient out is always an option. Non-candidate real
  // cells are strongly discouraged (NEG). asn[row] < nS means a real match.
  function maxWeight(W, cand) {
    const nP = W.length, nS = nP ? W[0].length : 0, cols = nS + nP, n = Math.max(nP, cols);
    let mx = 0; for (let i = 0; i < nP; i++) for (let j = 0; j < nS; j++) if (cand[i][j] && W[i][j] > mx) mx = W[i][j];
    const NEG = -(mx + 1000);
    const M = Array.from({ length: n }, () => Array(n).fill(0)); // dummy cols (j>=nS) stay 0
    for (let i = 0; i < nP; i++) for (let j = 0; j < nS; j++) M[i][j] = cand[i][j] ? W[i][j] : NEG;
    const big = Math.max(mx, 0) + 1; const cost = M.map((r) => r.map((x) => big - x));
    return hungarian(cost);
  }

  // ---- pipeline ---- //
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  function runPipeline(patients, trials, fields, params) {
    patients = patients.slice().sort(byId);
    trials = trials.slice().sort(byId);
    const fm = fields; // already a name -> field map (from toModels)
    const nP = patients.length, nT = trials.length;
    const gateD = patients.map((p) => trials.map((t) => gateTrial(p, t, fm)));
    const elig = patients.map((_, pi) => trials.map((__, ti) => gateD[pi][ti].eligible));

    const slots = expandSlots(trials);
    const nS = slots.length;
    const tIdx = {}; trials.forEach((t, i) => { tIdx[t.id] = i; });
    const prefRaw = (pi, ti) => { const v = (patients[pi].preferences || {})[trials[ti].id]; return v == null || v === "" ? 0 : Math.max(0, asFloat(v)); };

    let mxPref = 0;
    for (let pi = 0; pi < nP; pi++) for (let ti = 0; ti < nT; ti++) if (elig[pi][ti]) { const v = prefRaw(pi, ti); if (v > mxPref) mxPref = v; }
    if (mxPref <= 0) mxPref = 1;

    const cand = patients.map((_, pi) => slots.map((sl) => { const ti = tIdx[sl.trial_id]; return elig[pi][ti] && prefRaw(pi, ti) > 0; }));
    const prefNorm = patients.map((_, pi) => slots.map((sl) => prefRaw(pi, tIdx[sl.trial_id]) / mxPref));

    const EPS = 1e-6;
    // value plan: weight = normalized preference, minus a hair per match so that on an exact
    // preference tie the FEWER-enrolled plan wins (reproduces the "even score" shortfall).
    // maximal plan: weight = 1 + normalized preference, so an extra enrollment (integer +1)
    // always beats any preference re-shuffle (<1), filling the most slots; pref breaks ties.
    const buildW = (maxMatch) => patients.map((_, pi) => slots.map((sl, si) => maxMatch ? (1 + prefNorm[pi][si]) : (prefNorm[pi][si] - EPS)));
    function solve(maxMatch) {
      const asn = maxWeight(buildW(maxMatch), cand);
      const matched = {};
      for (let pi = 0; pi < nP; pi++) {
        const si = pi < asn.length ? asn[pi] : nS;
        if (si < nS && cand[pi][si]) { const sl = slots[si]; matched[pi] = { si, trial_id: sl.trial_id, slot_label: sl.label, pref: prefRaw(pi, tIdx[sl.trial_id]) }; }
      }
      return matched;
    }
    const matchedVal = solve(false), matchedMax = solve(true);
    const maxMatch = !!params.max_match;
    const active = maxMatch ? matchedMax : matchedVal;
    const alt = maxMatch ? matchedVal : matchedMax;

    // greedy baseline: repeatedly take the single highest-preference candidate pair, locking
    // out that patient and slot. A myopic comparison for the SphinxMatch Optimizer: greedy can
    // grab a locally-best pair that blocks a better global trade-off (fewer enrolled / lower total).
    function greedy() {
      const usedP = new Set(), usedS = new Set(), picks = [];
      while (true) {
        let best = null;
        for (let pi = 0; pi < nP; pi++) { if (usedP.has(pi)) continue;
          for (let si = 0; si < nS; si++) { if (usedS.has(si) || !cand[pi][si]) continue;
            const s = prefNorm[pi][si]; if (best === null || s > best.s) best = { s, pi, si }; } }
        if (!best) break;
        usedP.add(best.pi); usedS.add(best.si); picks.push([best.pi, best.si]);
      }
      return picks;
    }
    const greedyPicks = greedy();
    const greedyAssignments = greedyPicks.map(([pi, si]) => ({ patient_id: patients[pi].id, patient_name: patients[pi].name, trial_id: slots[si].trial_id, slot_label: slots[si].label, pref: prefRaw(pi, tIdx[slots[si].trial_id]) }));
    const greedyTotal = greedyAssignments.reduce((a, x) => a + x.pref, 0);

    const assignments = [], unmatched = [];
    patients.forEach((p, pi) => {
      const m = active[pi];
      if (m) { assignments.push({ patient_id: p.id, patient_name: p.name, trial_id: m.trial_id, slot_label: m.slot_label, pref: m.pref }); return; }
      const anyElig = trials.some((_, ti) => elig[pi][ti]);
      const anyPref = trials.some((_, ti) => elig[pi][ti] && prefRaw(pi, ti) > 0);
      let reason, detail;
      if (!anyElig) { reason = INELIGIBLE_NO_TRIAL; detail = "qualifies for no trial (diagnosis or genomics gate)"; }
      else if (!anyPref) { reason = NO_PREFERENCE; detail = "qualifies, but expressed no preference (0) for any trial they qualify for"; }
      else { reason = NO_SLOT_AVAILABLE; detail = "every trial they qualify for is already full"; }
      unmatched.push({ patient_id: p.id, patient_name: p.name, reason, detail });
    });

    const filledSi = new Set(Object.values(active).map((m) => m.si));
    const trialFill = {}; trials.forEach((t) => { trialFill[t.id] = { name: t.name, filled: 0, total: slots.filter((s) => s.trial_id === t.id).length }; });
    Object.values(active).forEach((m) => { trialFill[m.trial_id].filled++; });
    const unfilled = [];
    slots.forEach((sl, si) => {
      if (filledSi.has(si)) return;
      const anyCand = patients.some((_, pi) => cand[pi][si]);
      unfilled.push({ trial_id: sl.trial_id, slot_label: sl.label, reason: anyCand ? NO_PATIENT_AVAILABLE : NO_ELIGIBLE_PATIENT,
        detail: anyCand ? "eligible patient(s) existed but were placed elsewhere" : "no patient qualifies for this trial" });
    });

    const totalPref = Object.values(active).reduce((a, m) => a + m.pref, 0);
    const byPid = (matched) => { const o = {}; patients.forEach((p, pi) => { const m = matched[pi]; o[p.id] = m ? m.slot_label : null; }); return o; };

    return {
      patients, trials, fields, slots, params: { max_match: maxMatch },
      eligibility: elig, gate_detail: gateD,
      assignments, unmatched, unfilled_slots: unfilled, trial_fill: trialFill,
      total_pref: totalPref, count: Object.keys(active).length,
      val_count: Object.keys(matchedVal).length, max_count: Object.keys(matchedMax).length,
      greedy_assignments: greedyAssignments, greedy_total: greedyTotal, greedy_count: greedyAssignments.length,
      active_by_pid: byPid(active), alt_by_pid: byPid(alt),
      alt_label: maxMatch ? "Best preference (maximal matching off)" : "Maximal matching on",
      alt_count: Object.keys(alt).length,
    };
  }

  // ---- state (JSON) -> models ---- //
  function fieldFromDict(d) {
    let kind = d.kind; if (kind !== NUMERIC && kind !== CATEGORICAL && kind !== SET) kind = CATEGORICAL;
    return { name: String(d.name).trim(), label: String(d.label || d.name).trim(), kind, unit: String(d.unit || "") };
  }
  function coerceAttr(value, kind) {
    if (kind === NUMERIC) { const n = Number(value); return isFinite(n) ? n : 0; }
    if (kind === SET) { if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean); if (value == null || value === "") return []; return String(value).split(",").map((t) => t.trim()).filter(Boolean); }
    return String(value == null ? "" : value).trim();
  }
  function patientFromDict(d, fields) {
    const attrs = {}; const raw = d.attrs || {};
    for (const name of Object.keys(fields)) { const f = fields[name]; attrs[name] = coerceAttr(name in raw ? raw[name] : defaultValue(f.kind), f.kind); }
    const prefs = {}; const rawp = d.preferences || {};
    for (const k of Object.keys(rawp)) { const n = Number(rawp[k]); prefs[String(k)] = isFinite(n) ? n : 0; }
    return { id: String(d.id).trim(), name: String(d.name || d.id).trim(), attrs, preferences: prefs };
  }
  function condFromDict(c, fields) {
    const fieldName = String(c.field || "").trim();
    const f = fields[fieldName]; if (!f) return null;
    let op = String(c.op || "").trim();
    if ((OPS_FOR_KIND[f.kind] || []).indexOf(op) === -1) op = OPS_FOR_KIND[f.kind][0];
    const raw = c.value !== undefined ? c.value : "";
    let value = (f.kind === NUMERIC && isNumber(raw)) ? Number(raw) : String(raw).trim();
    let value2 = null;
    if (op === "between") { const raw2 = c.value2 !== undefined ? c.value2 : ""; value2 = isNumber(raw2) ? Number(raw2) : 0; if (!isNumber(raw)) value = 0; }
    return { field: fieldName, op, value, value2 };
  }
  function trialFromDict(d, fields) {
    const groups = (d.criteria || []).map((g) => {
      // tolerate a legacy flat criterion ({field,op,value}) as a 1-cond group
      const conds = ("conds" in g ? (g.conds || []) : [g]).map((c) => condFromDict(c, fields)).filter(Boolean);
      return { conds };
    }).filter((g) => g.conds.length);
    return { id: String(d.id).trim(), name: String(d.name || d.id).trim(), slots: Math.max(1, parseInt(d.slots, 10) || 1), criteria: groups };
  }
  function toModels(state) {
    const fields = {};
    for (const fd of (state.fields || [])) { const f = fieldFromDict(fd); if (f.name) fields[f.name] = f; }
    const patients = (state.patients || []).filter((p) => String(p.id || "").trim()).map((p) => patientFromDict(p, fields));
    const trials = (state.trials || []).filter((t) => String(t.id || "").trim()).map((t) => trialFromDict(t, fields));
    const pr = state.params || {};
    return { patients, trials, fields, params: { max_match: !!pr.max_match } };
  }

  // ---- models -> canonical state + render payload ---- //
  function canonicalState(patients, trials, fields, params) {
    return {
      fields: Object.values(fields).map((f) => ({ name: f.name, label: f.label, kind: f.kind, unit: f.unit })),
      patients: patients.map((p) => ({ id: p.id, name: p.name,
        attrs: Object.fromEntries(Object.keys(fields).map((k) => [k, (k in p.attrs) ? p.attrs[k] : defaultValue(fields[k].kind)])),
        preferences: Object.assign({}, p.preferences) })),
      trials: trials.map((t) => ({ id: t.id, name: t.name, slots: t.slots,
        criteria: t.criteria.map((g) => ({ conds: g.conds.map((c) => ({ field: c.field, op: c.op, value: c.value, value2: c.value2 })) })) })),
      params: { max_match: !!params.max_match },
    };
  }
  function resultPayload(r) {
    return {
      patient_ids: r.patients.map((p) => p.id),
      patient_names: r.patients.map((p) => p.name),
      fields: Object.values(r.fields).map((f) => ({ name: f.name, label: f.label, kind: f.kind, unit: f.unit })),
      patients_detail: r.patients.map((p) => ({ id: p.id, name: p.name, attrs: p.attrs, preferences: Object.assign({}, p.preferences) })),
      trial_ids: r.trials.map((t) => t.id),
      trial_names: r.trials.map((t) => t.name),
      slot_labels: r.slots.map((s) => s.label),
      eligibility: r.eligibility,
      gate_detail: r.gate_detail,
      params: r.params,
      assignments: r.assignments,
      unmatched: r.unmatched,
      unfilled_slots: r.unfilled_slots,
      trial_fill: r.trial_fill,
      total_pref: r.total_pref,
      count: r.count,
      val_count: r.val_count,
      max_count: r.max_count,
      greedy_assignments: r.greedy_assignments,
      greedy_total: r.greedy_total,
      greedy_count: r.greedy_count,
      active_by_pid: r.active_by_pid,
      alt_by_pid: r.alt_by_pid,
      alt_label: r.alt_label,
      alt_count: r.alt_count,
    };
  }

  function match(state) {
    const m = toModels(state);
    const r = runPipeline(m.patients, m.trials, m.fields, m.params);
    return { state: canonicalState(m.patients, m.trials, m.fields, m.params), result: resultPayload(r) };
  }

  // ---- scenarios ---- //
  const KRAS = "KRAS G12C";
  const FIELDS = () => [
    { name: "cancer_type", label: "Cancer type", kind: CATEGORICAL, unit: "" },
    { name: "genomics", label: "Genomics", kind: SET, unit: "" },
  ];
  const cond = (field, op, value) => ({ field, op, value });
  const grp = (...conds) => ({ conds });
  const pat = (id, name, cancer, genomics, prefs) => ({ id, name, attrs: { cancer_type: cancer, genomics }, preferences: prefs });
  const trial = (id, name, ...groups) => ({ id, name, slots: 1, criteria: groups });
  const nsclc = () => grp(cond("cancer_type", "==", "NSCLC"));
  const mkState = (patients, trials, max_match = false) => ({ fields: FIELDS(), patients, trials, params: { max_match } });

  function scenario1() {
    return mkState(
      [pat("P1", "Eleanor Hughes", "NSCLC", [], { T1: 1, T2: 1, T3: 1 }),
       pat("P2", "Marcus Bell", "NSCLC", [], { T1: 1, T2: 1, T3: 1 }),
       pat("P3", "Priya Nair", "NSCLC", [], { T1: 1, T2: 1, T3: 1 })],
      [trial("T1", "Trial A", nsclc()), trial("T2", "Trial B", nsclc()), trial("T3", "Trial C", nsclc())]);
  }
  function scenario2() {
    const s = scenario1();
    s.patients[2].attrs.cancer_type = "Pancreas"; // Priya no longer NSCLC
    return s;
  }
  function scenario3() {
    return mkState(
      [pat("P1", "Eleanor Hughes", "NSCLC", [], { T1: 1, T2: 2, T3: 1 }), // personal preference for Trial B
       pat("P2", "Marcus Bell", "NSCLC", [], { T1: 1, T2: 1, T3: 1 }),
       pat("P3", "Priya Nair", "NSCLC", [], { T1: 1, T2: 1, T3: 1 })],
      [trial("T1", "Trial A", nsclc()), trial("T2", "Trial B", nsclc()), trial("T3", "Trial C", nsclc())]);
  }
  function scenario4() {
    return mkState(
      [pat("P1", "Eleanor Hughes", "NSCLC", [], { T1: 1, T2: 2, T3: 1 }),
       pat("P2", "Marcus Bell", "NSCLC", [KRAS], { T1: 1, T2: 1, T3: 1 }), // Marcus carries KRAS G12C
       pat("P3", "Priya Nair", "NSCLC", [], { T1: 1, T2: 1, T3: 1 })],
      [trial("T1", "Trial A", nsclc()), trial("T2", "Trial B", nsclc()),
       trial("T3", "Trial C", nsclc(), grp(cond("genomics", "includes", KRAS)))]); // Trial C is mutation-specific
  }
  function scenario5() {
    return mkState(
      [pat("P1", "Eleanor Hughes", "NSCLC", [], { T1: 1, T2: 2, T3: 1 }),
       pat("P2", "Marcus Bell", "NSCLC", [KRAS], { T1: 2, T2: 1, T3: 1 }), // Marcus now prefers Trial A = 2
       pat("P3", "Priya Nair", "NSCLC", [], { T1: 1, T2: 1, T3: 1 })],
      [trial("T1", "Trial A", nsclc()), trial("T2", "Trial B", nsclc()),
       trial("T3", "Trial C", nsclc(), grp(cond("genomics", "includes", KRAS)))]);
  }
  function scenario6() {
    return mkState(
      [pat("PA", "Alex (G1+G2)", "NSCLC", ["G1", "G2"], { T1: 1, T2: 1 }),
       pat("PB", "Blake (G1)", "NSCLC", ["G1"], { T1: 1, T2: 1 })],
      [trial("T1", "Trial G1", nsclc(), grp(cond("genomics", "includes", "G1"))),
       trial("T2", "Trial G2", nsclc(), grp(cond("genomics", "includes", "G2")))]);
  }
  function scenario7() {
    // Worst case for greedy (the 1/2 bound): its biggest single pick blocks another patient.
    // Eleanor wants only A; Priya wants only B; Marcus is happy with B or C. Greedy grabs
    // Marcus to B and strands Priya (Trial C left empty); SphinxMatch sends Marcus to C and
    // gives B to Priya, enrolling all three.
    return mkState(
      [pat("P1", "Eleanor Hughes", "NSCLC", [], { T1: 10 }),
       pat("P2", "Marcus Bell", "NSCLC", [], { T2: 10, T3: 10 }),
       pat("P3", "Priya Nair", "NSCLC", [], { T2: 10 })],
      [trial("T1", "Trial A", nsclc()), trial("T2", "Trial B", nsclc()), trial("T3", "Trial C", nsclc())]);
  }

  const SCENARIOS = [
    { name: "1 · Equal preferences (baseline)", blurb: "All 3 patients are NSCLC and prefer every NSCLC trial equally (1). Baseline: the algorithm fills all three slots. Start here.", factory: scenario1 },
    { name: "2 · Diagnosis mismatch", blurb: "Priya is changed to Pancreas cancer. She qualifies for no NSCLC trial, so Priya goes unmatched and a trial slot is left open, and the engine recognizes the diagnosis change.", factory: scenario2 },
    { name: "3 · Personal preference (Trial B)", blurb: "All equal again, but Eleanor states a personal preference for Trial B (=2). The engine honors the greater preference: Eleanor → Trial B, Marcus → Trial A.", factory: scenario3 },
    { name: "4 · Mutation-specific trial", blurb: "Trial C now requires KRAS G12C and Marcus carries it. Only Marcus qualifies for C, so the match shifts Marcus from Trial A to Trial C and keeps everyone enrolled.", factory: scenario4 },
    { name: "5 · Even score → maximal matching", blurb: "Marcus also prefers Trial A (=2). Two plans tie on total preference: by default Marcus → Trial A and Priya is left out (Trial C is KRAS-only). Toggle Maximal matching to enroll Priya instead. (The Cartel case.)", factory: scenario5 },
    { name: "6 · Qualifies for 2 vs 1", blurb: "Alex qualifies for both Trial G1 and G2; Blake qualifies only for G1. The engine maximally matches, sending Alex to G2 and Blake to G1, to fill both slots.", factory: scenario6 },
    { name: "7 · Greedy strands a patient", blurb: "Eleanor wants only Trial A, Priya wants only Trial B, Marcus is fine with B or C. Greedy grabs Marcus to B and strands Priya (enrolls 2, total 20). The SphinxMatch Optimizer routes Marcus to C and gives B to Priya, enrolling all 3 (total 30). Open Advanced to see the gap.", factory: scenario7 },
  ];
  const DEFAULT_SCENARIO = SCENARIOS[0].name;
  function scenarioState(name) { const s = SCENARIOS.find((x) => x.name === name) || SCENARIOS[0]; return s.factory(); }

  // ---- persistence ---- //
  const STORE_KEY = "matching_playground_state_v3";
  let _mem = null;
  function _ls() { try { return global.localStorage || null; } catch (e) { return null; } }
  const store = {
    load() { try { const ls = _ls(); const s = ls ? ls.getItem(STORE_KEY) : _mem; return s ? JSON.parse(s) : scenarioState(DEFAULT_SCENARIO); } catch (e) { return scenarioState(DEFAULT_SCENARIO); } },
    save(state) { const str = JSON.stringify(state); const ls = _ls(); if (ls) { try { ls.setItem(STORE_KEY, str); } catch (e) { _mem = str; } } else _mem = str; },
    seed(name) { const s = scenarioState(name); store.save(s); return s; },
    reset() { return store.seed(DEFAULT_SCENARIO); },
  };

  const ENGINE = {
    match, scenarios: SCENARIOS.map((s) => ({ name: s.name, blurb: s.blurb })),
    scenarioState, DEFAULT_SCENARIO, store,
    OPS_FOR_KIND, OP_SYMBOL,
  };
  global.ENGINE = ENGINE;
  if (typeof module !== "undefined" && module.exports) module.exports = ENGINE;

})(typeof window !== "undefined" ? window : globalThis);
