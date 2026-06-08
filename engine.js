"use strict";
/*
 * engine.js — the matching engine ported to the browser (no backend needed).
 *
 * A faithful 1:1 port of the Python pipeline (hungarian.py + pipeline.py + model_io.py +
 * scenarios.py). `ENGINE.match(state)` mirrors Python `match_state(state)` and returns
 * { state: canonical, result: payload }. Verified against the Python on shared inputs
 * (see tests/diff_test.js). Persistence is localStorage instead of SQLite.
 *
 * Exposed as global `ENGINE` (browser) and module.exports (node, for the diff test).
 */
(function (global) {

  // ---- reason codes ---- //
  const INELIGIBLE_NO_TRIAL = "INELIGIBLE_NO_TRIAL";
  const NO_SLOT_AVAILABLE = "NO_SLOT_AVAILABLE";
  const BELOW_THRESHOLD = "BELOW_THRESHOLD";
  const NO_ELIGIBLE_PATIENT = "NO_ELIGIBLE_PATIENT";
  const NO_PATIENT_AVAILABLE = "NO_PATIENT_AVAILABLE";

  // ---- field kinds / operators / scoring ---- //
  const NUMERIC = "numeric", CATEGORICAL = "categorical", SET = "set";
  const OP_SYMBOL = { ">=": "≥", ">": ">", "<=": "≤", "<": "<", "==": "=", "!=": "≠", between: "between", includes: "includes", excludes: "excludes" };
  const OPS_FOR_KIND = {
    numeric: [">=", ">", "<=", "<", "==", "!=", "between"],
    categorical: ["==", "!="],
    set: ["includes", "excludes"],
  };
  const SCORING_GATE = "gate", SCORING_HIGHER = "higher", SCORING_LOWER = "lower", SCORING_TARGET = "target", SCORING_RANGE = "range";
  const SCORING_MODES = new Set([SCORING_GATE, SCORING_HIGHER, SCORING_LOWER, SCORING_TARGET, SCORING_RANGE]);

  // ---- value helpers (mirror pipeline._as_float / _as_list / _clamp01) ---- //
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function asFloat(v) {
    if (typeof v === "number") return isFinite(v) ? v : 0;
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }
  function asList(v) {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => x);
    if (v === null || v === undefined || v === "") return [];
    return [String(v).trim()];
  }
  function isNumber(x) {
    if (typeof x === "number") return isFinite(x);
    if (typeof x === "string") { if (x.trim() === "") return false; const n = Number(x); return isFinite(n); }
    return false;
  }
  function defaultValue(kind) { return kind === NUMERIC ? 0 : (kind === SET ? [] : ""); }
  function fmt(x, d) { return Number(x).toFixed(d); }
  function fmtNum(x) { const n = Number(x); return isFinite(n) ? String(n) : String(x); }  // matches Python _fmt_num

  // ---- eligibility test ---- //
  function evaluate(op, patientValue, target, kind, target2) {
    if (kind === NUMERIC) {
      const pv = asFloat(patientValue);
      if (op === "between") {
        let lo = asFloat(target), hi = asFloat(target2);
        if (lo > hi) { const t = lo; lo = hi; hi = t; }
        return lo <= pv && pv <= hi;
      }
      const tv = asFloat(target);
      switch (op) {
        case ">=": return pv >= tv; case ">": return pv > tv;
        case "<=": return pv <= tv; case "<": return pv < tv;
        case "==": return pv === tv; case "!=": return pv !== tv;
        default: return false;
      }
    }
    if (kind === CATEGORICAL) {
      const pv = String(patientValue).trim(), tv = String(target).trim();
      return op === "==" ? pv === tv : op === "!=" ? pv !== tv : false;
    }
    if (kind === SET) {
      const members = asList(patientValue), tv = String(target).trim();
      if (op === "includes") return members.indexOf(tv) !== -1;
      if (op === "excludes") return members.indexOf(tv) === -1;
    }
    return false;
  }

  function criterionText(c, fields) {
    const f = fields[c.field];
    const label = f ? f.label : c.field;
    const isNum = !!(f && f.kind === NUMERIC);
    const unit = (isNum && f.unit) ? " " + f.unit : "";
    const fv = isNum ? fmtNum : (x) => `${x}`;
    if (c.op === "between") return `${label} between ${fv(c.value)}–${fv(c.value2)}${unit}`;
    const sym = OP_SYMBOL[c.op] || c.op;
    return `${label} ${sym} ${fv(c.value)}${unit}`;
  }

  function resolvedScoring(c, f) {
    if (SCORING_MODES.has(c.scoring)) return c.scoring;
    if (f && f.kind === NUMERIC) {
      if (c.op === ">=" || c.op === ">") return SCORING_HIGHER;
      if (c.op === "<=" || c.op === "<") return SCORING_LOWER;
      if (c.op === "between") return SCORING_TARGET;
    }
    return SCORING_GATE;
  }

  function criterionFit(c, patientValue, f) {
    const mode = resolvedScoring(c, f);
    const kind = f ? f.kind : CATEGORICAL;
    const passes = evaluate(c.op, patientValue, c.value, kind, c.value2);
    if (mode === SCORING_GATE) {
      return c.required ? null : (passes ? 1.0 : 0.0);
    }
    if (!f || f.kind !== NUMERIC) return null;
    const x = asFloat(patientValue);
    const rng = f.norm_range ? f.norm_range : 1.0;
    if (mode === SCORING_HIGHER) return clamp01((x - asFloat(c.value)) / rng);
    if (mode === SCORING_LOWER) return clamp01((asFloat(c.value) - x) / rng);
    let lo = asFloat(c.value), hi = asFloat(c.value2);
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    if (mode === SCORING_RANGE) return (lo <= x && x <= hi) ? 1.0 : 0.0;
    const half = (hi - lo) / 2.0;
    if (half <= 0) return x === lo ? 1.0 : 0.0;
    return clamp01(1.0 - Math.abs(x - (lo + hi) / 2.0) / half);
  }

  // ---- stage 1 ---- //
  function eligibilityForPair(patient, trial, fields) {
    const failed = [];
    for (const c of trial.criteria) {
      if (!c.required) continue;
      const f = fields[c.field];
      const kind = f ? f.kind : CATEGORICAL;
      const pv = (c.field in patient.attrs) ? patient.attrs[c.field] : defaultValue(kind);
      if (!evaluate(c.op, pv, c.value, kind, c.value2)) failed.push(c);
    }
    return [failed.length === 0, failed];
  }

  function pairCriteriaDetail(patient, trial, fields) {
    const out = [];
    for (const c of trial.criteria) {
      const f = fields[c.field];
      const kind = f ? f.kind : CATEGORICAL;
      const pv = (c.field in patient.attrs) ? patient.attrs[c.field] : defaultValue(kind);
      out.push({
        field: c.field, label: f ? f.label : c.field, op: c.op, op_symbol: OP_SYMBOL[c.op] || c.op,
        value: c.value, value2: c.value2, unit: (f && f.kind === NUMERIC) ? f.unit : "", kind: kind,
        patient_value: pv, passed: evaluate(c.op, pv, c.value, kind, c.value2),
        scoring: resolvedScoring(c, f), required: c.required, weight: c.weight, fit: criterionFit(c, pv, f),
      });
    }
    return out;
  }

  function buildEligibility(patients, trials, fields) {
    const elig = patients.map(() => trials.map(() => false));
    const fails = patients.map(() => trials.map(() => []));
    patients.forEach((p, pi) => trials.forEach((t, ti) => {
      const [ok, failed] = eligibilityForPair(p, t, fields);
      elig[pi][ti] = ok;
      fails[pi][ti] = failed.map((c) => criterionText(c, fields));
    }));
    return [elig, fails];
  }

  // ---- stage 2 ---- //
  function pairScore(patient, trial, fields) {
    let num = 0, den = 0;
    for (const c of trial.criteria) {
      const f = fields[c.field];
      const kind = f ? f.kind : CATEGORICAL;
      const pv = (c.field in patient.attrs) ? patient.attrs[c.field] : defaultValue(kind);
      const fit = criterionFit(c, pv, f);
      if (fit === null) continue;
      const w = (c.weight && c.weight > 0) ? c.weight : 1.0;
      num += w * fit; den += w;
    }
    const s = den > 0 ? num / den : 1.0;
    return Math.max(s, 1e-6);
  }

  function expandSlots(trials) {
    const slots = [];
    for (const t of trials) {
      const k = Math.max(1, t.slots);
      for (let i = 0; i < k; i++) {
        slots.push({ trial_id: t.id, slot_index: i, label: k <= 1 ? t.name : `${t.name} #${i + 1}` });
      }
    }
    return slots;
  }

  function buildPreferenceScore(patients, trials, slots, eligibility) {
    const trialIdx = {}; trials.forEach((t, i) => { trialIdx[t.id] = i; });
    const raw = patients.map(() => slots.map(() => 0));
    let mx = 0;
    patients.forEach((p, pi) => slots.forEach((slot, si) => {
      if (eligibility[pi][trialIdx[slot.trial_id]]) {
        let v = asFloat((p.preferences || {})[slot.trial_id]);
        if (v < 0) v = 0;
        raw[pi][si] = v;
        if (v > mx) mx = v;
      }
    }));
    if (mx <= 0) mx = 1;
    return raw.map((row) => row.map((v) => v / mx));
  }

  function buildScoreMatrix(patients, trials, slots, eligibility, fields) {
    const trialById = {}; trials.forEach((t) => { trialById[t.id] = t; });
    const trialIdx = {}; trials.forEach((t, i) => { trialIdx[t.id] = i; });
    const score = patients.map(() => slots.map(() => 0));
    patients.forEach((p, pi) => slots.forEach((slot, si) => {
      const ti = trialIdx[slot.trial_id];
      if (eligibility[pi][ti]) score[pi][si] = pairScore(p, trialById[slot.trial_id], fields);
    }));
    return score;
  }

  function buildPaddedCost(score) {
    const nP = score.length, nS = nP ? score[0].length : 0, n = Math.max(nP, nS);
    let maxReal = 0;
    for (let r = 0; r < nP; r++) for (let c = 0; c < nS; c++) { const rc = 1 - score[r][c]; if (rc > maxReal) maxReal = rc; }
    const pad = maxReal + 1;
    const cost = Array.from({ length: n }, () => new Array(n).fill(pad));
    for (let r = 0; r < nP; r++) for (let c = 0; c < nS; c++) cost[r][c] = 1 - score[r][c];
    return [cost, pad, n];
  }

  // ---- hungarian solver (O(n^3) potentials method) ---- //
  function hungarian(cost) {
    const n = cost.length;
    if (n === 0) return [];
    const INF = Infinity;
    const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0);
    const p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i;
      let j0 = 0;
      const minv = new Array(n + 1).fill(INF), used = new Array(n + 1).fill(false);
      while (true) {
        used[j0] = true;
        const i0 = p[j0];
        let delta = INF, j1 = -1;
        for (let j = 1; j <= n; j++) {
          if (!used[j]) {
            const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
            if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
            if (minv[j] < delta) { delta = minv[j]; j1 = j; }
          }
        }
        for (let j = 0; j <= n; j++) {
          if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
          else minv[j] -= delta;
        }
        j0 = j1;
        if (p[j0] === 0) break;
      }
      while (j0) { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; }
    }
    const assign = new Array(n).fill(0);
    for (let j = 1; j <= n; j++) if (p[j] !== 0) assign[p[j] - 1] = j - 1;
    return assign;
  }

  function greedyAssignment(score, minScore) {
    const rows = score.length, cols = rows ? score[0].length : 0;
    const usedR = new Set(), usedC = new Set(), picks = [];
    while (true) {
      let best = null;
      for (let r = 0; r < rows; r++) {
        if (usedR.has(r)) continue;
        for (let c = 0; c < cols; c++) {
          if (usedC.has(c)) continue;
          const s = score[r][c];
          if (s <= minScore) continue;
          if (best === null || s > best.s) best = { s: s, r: r, c: c };
        }
      }
      if (best === null) break;
      usedR.add(best.r); usedC.add(best.c); picks.push([best.r, best.c]);
    }
    return picks;
  }

  function eligibleAnywhere(elig, pi) { return elig[pi].some((x) => x); }

  // ---- full pipeline ---- //
  function runPipeline(patients, trials, fields, params) {
    patients = patients.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    trials = trials.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const nP = patients.length;
    // preference mode honors any positive preference -> threshold forced to 0 (see pipeline.py)
    const threshold = params.objective === "preference" ? 0 : params.min_score_threshold;

    const [eligibility, failing] = buildEligibility(patients, trials, fields);
    const slots = expandSlots(trials);
    const score = params.objective === "preference"
      ? buildPreferenceScore(patients, trials, slots, eligibility)
      : buildScoreMatrix(patients, trials, slots, eligibility, fields);

    const optScore = params.threshold_aware
      ? score.map((row) => row.map((s) => (s >= threshold ? s : 0)))
      : score;
    const [cost, padCost, n] = buildPaddedCost(optScore);
    const assign = n > 0 ? hungarian(cost) : [];
    const nS = slots.length;

    const assignments = [], unmatched = [], realFilled = {};
    for (let pi = 0; pi < nP; pi++) {
      const p = patients[pi];
      const ci = pi < assign.length ? assign[pi] : n;
      const eligible = eligibleAnywhere(eligibility, pi);
      if (ci >= nS) {
        const reason = !eligible ? INELIGIBLE_NO_TRIAL : NO_SLOT_AVAILABLE;
        const detail = !eligible ? "passed the pre-filter for no trial"
          : "every real slot went to a better-fitting patient (structural shortage)";
        unmatched.push({ patient_id: p.id, patient_name: p.name, reason: reason, detail: detail });
        continue;
      }
      const slot = slots[ci];
      const s = score[pi][ci];
      if (!eligible) {
        unmatched.push({ patient_id: p.id, patient_name: p.name, reason: INELIGIBLE_NO_TRIAL,
          detail: "passed the pre-filter for no trial (forced onto an ineligible slot)" });
      } else if (s < threshold || s <= 0) {
        let detail;
        if (params.objective === "preference") {
          const wants = trials.some((t, ti) => eligibility[pi][ti] && asFloat((p.preferences || {})[t.id]) > 0);
          detail = wants
            ? "every trial this patient prefers was filled by patients who wanted it more"
            : "this patient expressed no preference for any trial they qualify for";
        } else {
          detail = `best available slot ${slot.label} scored ${fmt(s, 3)} < threshold ${fmt(threshold, 2)}`;
        }
        unmatched.push({ patient_id: p.id, patient_name: p.name, reason: BELOW_THRESHOLD, detail: detail });
      } else {
        assignments.push({ patient_id: p.id, patient_name: p.name, trial_id: slot.trial_id, slot_label: slot.label, score: s });
        realFilled[ci] = pi;
      }
    }
    const totalScore = assignments.reduce((a, x) => a + x.score, 0);

    const trialIdx = {}; trials.forEach((t, i) => { trialIdx[t.id] = i; });
    const slotHasEligible = slots.map((slot) => {
      const ti = trialIdx[slot.trial_id];
      for (let pi = 0; pi < nP; pi++) if (eligibility[pi][ti]) return true;
      return false;
    });
    const unfilled = [];
    slots.forEach((slot, si) => {
      if (si in realFilled) return;
      if (slotHasEligible[si]) unfilled.push({ trial_id: slot.trial_id, slot_label: slot.label, reason: NO_PATIENT_AVAILABLE,
        detail: "eligible patient(s) existed but were assigned elsewhere or outnumbered" });
      else unfilled.push({ trial_id: slot.trial_id, slot_label: slot.label, reason: NO_ELIGIBLE_PATIENT,
        detail: "no patient passed the pre-filter for this trial" });
    });

    const trialFill = {};
    for (const t of trials) {
      const total = slots.filter((s) => s.trial_id === t.id).length;
      let filled = 0;
      for (const si in realFilled) if (slots[si].trial_id === t.id) filled++;
      trialFill[t.id] = [filled, total];
    }

    const greedyPairs = greedyAssignment(score, threshold);
    const greedyAssignments = greedyPairs.map(([pi, si]) => ({
      patient_id: patients[pi].id, patient_name: patients[pi].name,
      trial_id: slots[si].trial_id, slot_label: slots[si].label, score: score[pi][si],
    }));
    const greedyTotal = greedyAssignments.reduce((a, x) => a + x.score, 0);

    return {
      patients, trials, fields, slots, params,
      eligibility, failing_criteria: failing,
      score, cost_padded: cost, pad_cost: padCost, n_real_patients: nP, n_real_slots: nS,
      assignments, unmatched, unfilled_slots: unfilled, total_score: totalScore,
      greedy_assignments: greedyAssignments, greedy_total: greedyTotal, trial_fill: trialFill,
    };
  }

  // ---- state (JSON) -> model objects (mirror model_io.to_models) ---- //
  function fieldFromDict(d) {
    let kind = d.kind;
    if (kind !== NUMERIC && kind !== CATEGORICAL && kind !== SET) kind = CATEGORICAL;
    return { name: String(d.name).trim(), label: String(d.label || d.name).trim(), kind: kind,
      unit: String(d.unit || ""), norm_range: Number(d.norm_range) || 1.0 };
  }
  function coerceAttr(value, kind) {
    if (kind === NUMERIC) { const n = Number(value); return isFinite(n) ? n : 0; }
    if (kind === SET) {
      if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter((x) => x);
      if (value === null || value === undefined || value === "") return [];
      return String(value).split(",").map((t) => t.trim()).filter((t) => t);
    }
    return String(value).trim();
  }
  function patientFromDict(d, fields) {
    const attrs = {}; const raw = d.attrs || {};
    for (const name of Object.keys(fields)) {
      const f = fields[name];
      attrs[name] = coerceAttr(name in raw ? raw[name] : defaultValue(f.kind), f.kind);
    }
    const prefs = {}; const rawp = d.preferences || {};
    for (const k of Object.keys(rawp)) { const n = Number(rawp[k]); prefs[String(k)] = isFinite(n) ? n : 0; }
    return { id: String(d.id).trim(), name: String(d.name || d.id).trim(), attrs: attrs, preferences: prefs };
  }
  function criterionFromDict(d, fields) {
    const fieldName = String(d.field || "").trim();
    const f = fields[fieldName];
    if (!f) return null;
    let op = String(d.op || "").trim();
    if ((OPS_FOR_KIND[f.kind] || []).indexOf(op) === -1) op = OPS_FOR_KIND[f.kind][0];
    const raw = d.value !== undefined ? d.value : "";
    let value = (f.kind === NUMERIC && isNumber(raw)) ? Number(raw) : String(raw).trim();
    let value2 = null;
    if (op === "between") {
      const raw2 = d.value2 !== undefined ? d.value2 : "";
      value2 = isNumber(raw2) ? Number(raw2) : 0.0;
      if (!isNumber(raw)) value = 0.0;
    }
    let scoring = String(d.scoring || "").trim();
    if (!SCORING_MODES.has(scoring)) scoring = "";
    const required = d.required === undefined ? true : Boolean(d.required);
    let weight = Number(d.weight); if (!isFinite(weight) || weight <= 0) weight = 1.0;
    return { field: fieldName, op: op, value: value, value2: value2, scoring: scoring, required: required, weight: weight };
  }
  function trialFromDict(d, fields) {
    const crits = (d.criteria || []).map((c) => criterionFromDict(c, fields)).filter((c) => c !== null);
    return { id: String(d.id).trim(), name: String(d.name || d.id).trim(),
      slots: Math.max(1, parseInt(d.slots, 10) || 1), criteria: crits };
  }
  function toModels(state) {
    const fields = {};
    for (const fd of (state.fields || [])) { const f = fieldFromDict(fd); if (f.name) fields[f.name] = f; }
    const patients = (state.patients || []).filter((p) => String(p.id || "").trim()).map((p) => patientFromDict(p, fields));
    const trials = (state.trials || []).filter((t) => String(t.id || "").trim()).map((t) => trialFromDict(t, fields));
    const pr = state.params || {};
    const params = {
      min_score_threshold: pr.min_score_threshold === undefined ? 0.3 : Number(pr.min_score_threshold),
      threshold_aware: Boolean(pr.threshold_aware),
      objective: pr.objective === "preference" ? "preference" : "fit",
    };
    return { patients, trials, fields, params };
  }

  // ---- model objects -> canonical state + render payload (mirror model_io) ---- //
  function canonicalState(patients, trials, fields, params) {
    return {
      fields: Object.values(fields).map((f) => ({ name: f.name, label: f.label, kind: f.kind, unit: f.unit, norm_range: f.norm_range })),
      patients: patients.map((p) => ({ id: p.id, name: p.name,
        attrs: Object.fromEntries(Object.keys(fields).map((k) => [k, (k in p.attrs) ? p.attrs[k] : defaultValue(fields[k].kind)])),
        preferences: Object.assign({}, p.preferences) })),
      trials: trials.map((t) => ({ id: t.id, name: t.name, slots: t.slots,
        criteria: t.criteria.map((c) => ({ field: c.field, op: c.op, value: c.value, value2: c.value2, scoring: c.scoring, required: c.required, weight: c.weight })) })),
      params: { min_score_threshold: params.min_score_threshold, threshold_aware: params.threshold_aware, objective: params.objective },
    };
  }
  function assignPayload(a) { return { patient_id: a.patient_id, patient_name: a.patient_name, trial_id: a.trial_id, slot_label: a.slot_label, score: a.score }; }
  function resultPayload(r) {
    const n = r.cost_padded.length;
    const rowNames = r.patients.map((p) => p.name).concat(Array.from({ length: n - r.n_real_patients }, (_, i) => `dummy_p${i + 1}`));
    const colNames = r.slots.map((s) => s.label).concat(Array.from({ length: n - r.n_real_slots }, (_, i) => `dummy_s${i + 1}`));
    const nameById = {}; r.trials.forEach((t) => { nameById[t.id] = t.name; });
    return {
      patient_ids: r.patients.map((p) => p.id),
      patient_names: r.patients.map((p) => p.name),
      fields: Object.values(r.fields).map((f) => ({ name: f.name, label: f.label, kind: f.kind, unit: f.unit })),
      patients_detail: r.patients.map((p) => ({ id: p.id, name: p.name, attrs: p.attrs, preferences: Object.assign({}, p.preferences) })),
      criteria_detail: r.patients.map((p) => r.trials.map((t) => pairCriteriaDetail(p, t, r.fields))),
      trial_score: r.patients.map((p) => r.trials.map((t) => pairScore(p, t, r.fields))),
      trial_ids: r.trials.map((t) => t.id),
      trial_names: r.trials.map((t) => t.name),
      slot_labels: r.slots.map((s) => s.label),
      params: { min_score_threshold: r.params.min_score_threshold, threshold_aware: r.params.threshold_aware, objective: r.params.objective },
      eligibility: r.eligibility,
      failing_criteria: r.failing_criteria,
      score: r.score,
      cost_padded: r.cost_padded,
      pad_cost: r.pad_cost,
      n: n,
      n_real_patients: r.n_real_patients,
      n_real_slots: r.n_real_slots,
      row_names: rowNames,
      col_names: colNames,
      assignments: r.assignments.map(assignPayload),
      unmatched: r.unmatched.map((u) => ({ patient_id: u.patient_id, patient_name: u.patient_name, reason: u.reason, detail: u.detail })),
      unfilled_slots: r.unfilled_slots.map((s) => ({ trial_id: s.trial_id, trial_name: nameById[s.trial_id] || s.trial_id, slot_label: s.slot_label, reason: s.reason, detail: s.detail })),
      total_score: r.total_score,
      greedy_assignments: r.greedy_assignments.map(assignPayload),
      greedy_total: r.greedy_total,
      trial_fill: Object.fromEntries(Object.keys(r.trial_fill).map((tid) => [tid, { name: nameById[tid] || tid, filled: r.trial_fill[tid][0], total: r.trial_fill[tid][1] }])),
    };
  }

  function match(state) {
    const m = toModels(state);
    const result = runPipeline(m.patients, m.trials, m.fields, m.params);
    return { state: canonicalState(m.patients, m.trials, m.fields, m.params), result: resultPayload(result) };
  }

  // ---- scenarios (mirror scenarios.py) ---- //
  const EGFR = "EGFR L858R", KRAS = "KRAS G12C";
  const DEFAULT_FIELDS = () => [
    { name: "cancer_type", label: "Cancer type", kind: CATEGORICAL, unit: "", norm_range: 1.0 },
    { name: "genomics", label: "Genomics", kind: SET, unit: "", norm_range: 1.0 },
    { name: "hemoglobin", label: "Hemoglobin", kind: NUMERIC, unit: "g/dL", norm_range: 8.0 },
    { name: "creatinine_clearance", label: "Creatinine clearance", kind: NUMERIC, unit: "mL/min", norm_range: 90.0 },
  ];
  const crit = (field, op, value) => ({ field, op, value });
  const basePatients = () => [
    { id: "P1", name: "Eleanor Hughes", attrs: { cancer_type: "NSCLC", genomics: [EGFR], hemoglobin: 13.0, creatinine_clearance: 90 } },
    { id: "P2", name: "Marcus Bell", attrs: { cancer_type: "NSCLC", genomics: [], hemoglobin: 9.5, creatinine_clearance: 40 } },
    { id: "P3", name: "Priya Nair", attrs: { cancer_type: "NSCLC", genomics: [KRAS], hemoglobin: 11.0, creatinine_clearance: 65 } },
  ];
  const trialA = (cancer = "NSCLC", slots = 1) => ({ id: "T1", name: "Trial A", slots, criteria: [crit("cancer_type", "==", cancer), crit("genomics", "includes", EGFR), crit("hemoglobin", ">=", 10.0), crit("creatinine_clearance", ">=", 60.0)] });
  const trialB = (cancer = "NSCLC", slots = 1) => ({ id: "T2", name: "Trial B", slots, criteria: [crit("cancer_type", "==", cancer), crit("hemoglobin", ">=", 9.0), crit("creatinine_clearance", ">=", 30.0)] });
  const trialC = (cancer = "NSCLC", slots = 1) => ({ id: "T3", name: "Trial C", slots, criteria: [crit("cancer_type", "==", cancer), crit("genomics", "includes", KRAS), crit("hemoglobin", ">=", 12.0), crit("creatinine_clearance", ">=", 60.0)] });
  const mkState = (patients, trials) => ({ fields: DEFAULT_FIELDS(), patients, trials, params: { min_score_threshold: 0.3, threshold_aware: false, objective: "fit" } });

  const prefPatient = (pid, name, alts, hgb, prefs) => ({ id: pid, name, attrs: { cancer_type: "NSCLC", genomics: alts, hemoglobin: hgb, creatinine_clearance: 80 }, preferences: prefs });
  const gate = (field, op, value) => ({ field, op, value, scoring: "gate" });
  const preferenceDemo = () => ({
    fields: DEFAULT_FIELDS(),
    patients: [
      prefPatient("P1", "Eleanor Hughes", [], 13.0, { T1: 10, T2: 9, T3: 1 }),
      prefPatient("P2", "Marcus Bell", [], 11.0, { T1: 8, T2: 2, T3: 5 }),
      prefPatient("P3", "Priya Nair", [KRAS], 12.0, { T1: 3, T2: 4, T3: 9 }),
    ],
    trials: [
      { id: "T1", name: "Trial A", slots: 1, criteria: [gate("cancer_type", "==", "NSCLC")] },
      { id: "T2", name: "Trial B", slots: 1, criteria: [gate("cancer_type", "==", "NSCLC")] },
      { id: "T3", name: "Trial C", slots: 1, criteria: [gate("cancer_type", "==", "NSCLC"), gate("genomics", "includes", KRAS)] },
    ],
    params: { min_score_threshold: 0.0, threshold_aware: false, objective: "preference" },
  });

  const SCENARIOS = [
    { name: "Preference: patients rank trials", blurb: "PREFERENCE objective: labs/genomics are pass/fail gates; the optimizer maximizes each patient's stated preference. Hungarian (total 26) beats greedy (21) by giving Eleanor her 2nd choice.", factory: preferenceDemo },
    { name: "Balanced 3×3 (default)", blurb: "FIT objective: 3 patients, 3 single-slot trials. Trial B is contested, Trial C has no eligible patient. Shows a real trade-off + BELOW_THRESHOLD + NO_ELIGIBLE_PATIENT; greedy loses to optimal.", factory: () => mkState(basePatients(), [trialA(), trialB(), trialC()]) },
    { name: "More patients than slots (3×2)", blurb: "Drop Trial C -> 2 slots for 3 patients. A surplus patient lands on a dummy = NO_SLOT_AVAILABLE.", factory: () => mkState(basePatients(), [trialA(), trialB()]) },
    { name: "More slots than patients (3×5)", blurb: "Trial B gets 3 slots -> 5 slots for 3 patients. Surplus slots report NO_PATIENT_AVAILABLE / NO_ELIGIBLE_PATIENT.", factory: () => mkState(basePatients(), [trialA(), trialB("NSCLC", 3), trialC()]) },
    { name: "Nobody eligible (wrong cancer type)", blurb: "All trials require CRC; every patient is NSCLC. Everyone -> INELIGIBLE_NO_TRIAL.", factory: () => mkState(basePatients(), [trialA("CRC"), trialB("CRC"), trialC("CRC")]) },
  ];
  const DEFAULT_SCENARIO = "Balanced 3×3 (default)";
  function scenarioState(name) {
    const s = SCENARIOS.find((x) => x.name === name) || SCENARIOS[0];
    return s.factory();
  }

  // ---- persistence (localStorage; falls back to memory in node) ---- //
  const STORE_KEY = "matching_playground_state_v1";
  let _mem = null;
  function _ls() { try { return global.localStorage || null; } catch (e) { return null; } }
  const store = {
    load() {
      try { const ls = _ls(); const s = ls ? ls.getItem(STORE_KEY) : _mem; return s ? JSON.parse(s) : scenarioState(DEFAULT_SCENARIO); }
      catch (e) { return scenarioState(DEFAULT_SCENARIO); }
    },
    save(state) { const str = JSON.stringify(state); const ls = _ls(); if (ls) { try { ls.setItem(STORE_KEY, str); } catch (e) { _mem = str; } } else _mem = str; },
    seed(name) { const s = scenarioState(name); store.save(s); return s; },
    reset() { return store.seed(DEFAULT_SCENARIO); },
  };

  const ENGINE = {
    match, scenarios: SCENARIOS.map((s) => ({ name: s.name, blurb: s.blurb })),
    scenarioState, DEFAULT_SCENARIO, store,
    // exposed for the differential test
    _internals: { hungarian, greedyAssignment, runPipeline, toModels, resultPayload },
  };
  global.ENGINE = ENGINE;
  if (typeof module !== "undefined" && module.exports) module.exports = ENGINE;

})(typeof window !== "undefined" ? window : globalThis);
