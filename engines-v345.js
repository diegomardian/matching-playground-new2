"use strict";
/*
 * engines-v345.js: engine variants and iterations beyond v2 (match-engine.js).
 *
 * v2 (global ENGINE) stays frozen for comparison. These are produced by one factory
 * so each adds a single concept on top of the previous:
 *
 *   v2 · Patient choice (key: v2choice)
 *       v2 plus an explicit first-come-first-served tiebreak, applied PER TRIAL:
 *       every trial has its own queue, and a patient joins it the moment they pick
 *       that trial (patients carry `joined` = { trialId: joinSeq }). Resolution is
 *       lexicographic, not score-based: the solver finds the optimal total first,
 *       then walks each seat's queue in join order and locks the earliest joiner
 *       whose seating still achieves that exact optimum. So queue order only ever
 *       decides exact ties, can never override a real rank difference, and a
 *       patient's position in one trial's queue is never traded against their
 *       position in another's. States without `joined` fall back to input order.
 *
 *   v2 · Uneven matrix (key: v2matrix)
 *       NOT an algorithm change — algorithmically identical to v2, which already
 *       handles non-square inputs by padding: every patient gets a 0-value dummy
 *       "unmatched" column, and dummy patient rows (worth 0) absorb leftover slots.
 *       This variant only EXPOSES that padded matrix in the result so the UI can
 *       render what the solver actually sees.
 *
 *   v3  Slot urgency. Trials may carry `expires_days` (days until the slot expires;
 *       null = no expiry). Urgency ramps linearly inside a horizon (default 30 days):
 *       u = clamp((horizon - days)/horizon, 0, 1). Cell score = pref + w_slot * u.
 *       Slots WITHOUT an expiry get u = 0 but still fill normally — urgency only
 *       re-ranks WHICH slot a contested patient goes to, it never starves a slot.
 *
 *   v4  Patient urgency. Patients carry an urgency level (none/low/medium/high/
 *       critical → 0/.25/.5/.75/1). It multiplies the whole cell score:
 *       score = (pref + w_slot*uSlot) * (1 + w_patient*uPat). Multiplicative (not
 *       additive) on purpose: an additive row bonus would only decide WHO gets
 *       enrolled; multiplying also lets urgent patients win their higher choices
 *       and claim expiring slots in contested trades.
 *       Urgency can also be DERIVED from diagnosis: state.urgency_rules is a list of
 *       { level, conds: [cond,...] } evaluated against patient attrs (all conds must
 *       hold; first matching rule wins). Example: cancer_type==SCLC AND stage==IV →
 *       critical, while NSCLC IV → low. The manual level still applies when it is
 *       HIGHER than the matched rule (escalation-only override, never a downgrade).
 *
 * Bonuses can never place a patient in a trial they refused: candidacy still requires
 * eligibility AND preference > 0, exactly like v2.
 *
 * Exposed as global `ENGINES` = { v2choice, v2matrix, v3, v4 }, each with the same
 * match()/scenarios surface app.js expects from v2's ENGINE.
 */
(function (global) {

  const V2 = global.ENGINE;
  const OPS_FOR_KIND = V2.OPS_FOR_KIND, OP_SYMBOL = V2.OP_SYMBOL;

  // ---- reason codes ---- //
  const INELIGIBLE_NO_TRIAL = "INELIGIBLE_NO_TRIAL";
  const NO_SLOT_AVAILABLE = "NO_SLOT_AVAILABLE";
  const NO_PREFERENCE = "NO_PREFERENCE";
  const NO_ELIGIBLE_PATIENT = "NO_ELIGIBLE_PATIENT";
  const NO_PATIENT_AVAILABLE = "NO_PATIENT_AVAILABLE";

  // ---- field kinds ---- //
  const NUMERIC = "numeric", CATEGORICAL = "categorical", SET = "set";

  // ---- urgency levels (patient) ---- //
  const URGENCY_LEVELS = ["none", "low", "medium", "high", "critical"];
  const URGENCY_VALUE = { none: 0, low: 0.25, medium: 0.5, high: 0.75, critical: 1 };

  // ---- value helpers (same semantics as v2) ---- //
  const asFloat = (v) => { if (typeof v === "number") return isFinite(v) ? v : 0; const n = Number(v); return isFinite(n) ? n : 0; };
  const asList = (v) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : (v == null || v === "" ? [] : String(v).split(",").map((s) => s.trim()).filter(Boolean));
  const isNumber = (x) => { if (typeof x === "number") return isFinite(x); if (typeof x === "string") { if (x.trim() === "") return false; const n = Number(x); return isFinite(n); } return false; };
  const defaultValue = (kind) => kind === NUMERIC ? 0 : (kind === SET ? [] : "");
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const numOr = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };

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

  // ---- CNF eligibility (same as v2) ---- //
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
    trials.forEach((t) => {
      const k = Math.max(1, t.slots || 1);
      for (let i = 0; i < k; i++) out.push({ trial_id: t.id, index: i, label: k <= 1 ? t.name : `${t.name} #${i + 1}`, expires_days: (t.expires_days == null ? null : t.expires_days) });
    });
    return out;
  }

  // ---- Hungarian (identical to v2) ---- //
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

  function maxWeight(W, cand) {
    const nP = W.length, nS = nP ? W[0].length : 0, cols = nS + nP, n = Math.max(nP, cols);
    let mx = 0; for (let i = 0; i < nP; i++) for (let j = 0; j < nS; j++) if (cand[i][j] && W[i][j] > mx) mx = W[i][j];
    const NEG = -(mx + 1000);
    const M = Array.from({ length: n }, () => Array(n).fill(0)); // dummy cols (j>=nS) stay 0
    for (let i = 0; i < nP; i++) for (let j = 0; j < nS; j++) M[i][j] = cand[i][j] ? W[i][j] : NEG;
    const big = Math.max(mx, 0) + 1; const cost = M.map((r) => r.map((x) => big - x));
    return hungarian(cost);
  }

  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  // slot urgency ramp: expires today (or already) => 1; expires >= horizon days out => 0
  function slotUrgencyOf(expiresDays, horizon) {
    if (expiresDays == null) return 0;
    return clamp01((horizon - expiresDays) / horizon);
  }

  // diagnosis-rule urgency: first rule whose conds ALL pass wins; the manual level
  // still applies when higher (escalation-only override).
  function effectiveUrgency(p, rules, fm) {
    const manualLevel = URGENCY_LEVELS.indexOf(p.urgency) >= 0 ? p.urgency : "none";
    const manualV = URGENCY_VALUE[manualLevel] || 0;
    let ruleLevel = null;
    for (const r of (rules || [])) {
      const hit = r.conds.every((c) => {
        const f = fm[c.field], kind = f ? f.kind : CATEGORICAL;
        const pv = (p.attrs && c.field in p.attrs) ? p.attrs[c.field] : defaultValue(kind);
        return evaluate(c.op, pv, c.value, kind, c.value2);
      });
      if (hit) { ruleLevel = r.level; break; }
    }
    const ruleV = ruleLevel ? (URGENCY_VALUE[ruleLevel] || 0) : 0;
    if (ruleLevel && ruleV >= manualV) return { level: ruleLevel, value: ruleV, source: "rule" };
    return { level: manualLevel, value: manualV, source: "manual" };
  }

  // =========================================================================== //
  // Factory
  // =========================================================================== //
  function makeEngine(cfg) {
    const features = cfg.features;

    function runPipeline(patients, trials, fields, params, rules) {
      patients = patients.slice().sort(byId);
      trials = trials.slice().sort(byId);
      const fm = fields;
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

      // candidacy = eligible AND wanted. An enrolled patient (passed prescreening)
      // is a fact on the ground: their cell stays a candidate no matter what.
      const cand = patients.map((p, pi) => slots.map((sl) => { const ti = tIdx[sl.trial_id]; return (elig[pi][ti] && prefRaw(pi, ti) > 0) || (features.queueTiebreak && p.enrolled === sl.trial_id); }));
      const prefNorm = patients.map((_, pi) => slots.map((sl) => prefRaw(pi, tIdx[sl.trial_id]) / mxPref));

      // urgency terms (0 when the feature is off)
      const wS = features.slotUrgency ? params.w_slot : 0;
      const wP = features.patientUrgency ? params.w_patient : 0;
      const horizon = features.slotUrgency ? params.horizon : 30;
      const uSlot = slots.map((sl) => features.slotUrgency ? slotUrgencyOf(sl.expires_days, horizon) : 0);
      const uEff = patients.map((p) => features.patientUrgency ? effectiveUrgency(p, rules, fm) : { level: "none", value: 0, source: "manual" });
      const uPat = uEff.map((u) => u.value);

      // combined cell score: (pref + slot bonus) amplified by patient urgency.
      const score = patients.map((_, pi) => slots.map((__, si) => (prefNorm[pi][si] + wS * uSlot[si]) * (1 + wP * uPat[pi])));
      const SCALE = (1 + wS) * (1 + wP); // max possible score, for max-match normalization

      const EPS = 1e-6;
      // value plan: weight = score, minus a hair per match (fewer-enrolled wins exact ties).
      // maximal plan: weight = 1 + score/SCALE, so an extra enrollment always dominates.
      const buildW = (maxMatch) => patients.map((_, pi) => slots.map((__, si) => maxMatch ? (1 + score[pi][si] / (SCALE + EPS)) : (score[pi][si] - EPS)));
      function solveTotal(W, candM) {
        const asn = maxWeight(W, candM);
        let total = 0;
        for (let pi = 0; pi < nP; pi++) { const si = asn[pi]; if (si < nS && candM[pi][si]) total += W[pi][si]; }
        return { asn, total };
      }
      function asnToMatched(asn) {
        const matched = {};
        for (let pi = 0; pi < nP; pi++) {
          const si = pi < asn.length ? asn[pi] : nS;
          if (si < nS && cand[pi][si]) { const sl = slots[si]; matched[pi] = { si, trial_id: sl.trial_id, slot_label: sl.label, pref: prefRaw(pi, tIdx[sl.trial_id]), score: score[pi][si] }; }
        }
        return matched;
      }
      // first-come-first-served tiebreak, PER TRIAL, resolved lexicographically:
      // solve for the optimal total first, then walk each slot's queue in join order
      // and LOCK the earliest joiner whose seating still achieves that exact optimum
      // (re-solving under the locks to check). Locks are all-or-nothing per seat, so
      // a patient's position in one trial's queue can never be traded against their
      // position in another's — the seat goes to the earliest joiner of THAT trial's
      // queue among the tied-optimal plans, and the tiebreak never costs any real
      // score (rank difference, urgency, or enrollment count).
      function solve(maxMatch) {
        const W = buildW(maxMatch);
        const TOL = 1e-9;
        const pLock = {}, sLock = {};
        const restricted = () => patients.map((_, pi) => slots.map((__, si) =>
          cand[pi][si] && (pLock[pi] === undefined || pLock[pi] === si) && (sLock[si] === undefined || sLock[si] === pi)));
        // enrollment locks FIRST: a patient who passed prescreening occupies their
        // seat unconditionally — the projection optimizes only what's still open.
        if (features.queueTiebreak) patients.forEach((p, pi) => {
          if (!p.enrolled) return;
          for (let si = 0; si < nS; si++) if (slots[si].trial_id === p.enrolled && sLock[si] === undefined) { pLock[pi] = si; sLock[si] = pi; break; }
        });
        const base = solveTotal(W, restricted());
        if (!features.queueTiebreak) return asnToMatched(base.asn);
        slots.forEach((sl, si) => {
          if (sLock[si] !== undefined) return; // seat already taken by an enrollee
          const entrants = patients
            .map((p, pi) => ({ pi, seq: (p.joined && isFinite(p.joined[sl.trial_id])) ? p.joined[sl.trial_id] : 1e9 + (p.queue_pos || 0) }))
            .filter((x) => cand[x.pi][si] && pLock[x.pi] === undefined)
            .sort((a, b) => a.seq - b.seq);
          for (const { pi } of entrants) {
            pLock[pi] = si; sLock[si] = pi;
            if (Math.abs(solveTotal(W, restricted()).total - base.total) < TOL) break; // lock holds
            delete pLock[pi]; delete sLock[si];
          }
        });
        return asnToMatched(solveTotal(W, restricted()).asn);
      }
      const matchedVal = solve(false), matchedMax = solve(true);
      const maxMatch = !!params.max_match;
      const active = maxMatch ? matchedMax : matchedVal;
      const alt = maxMatch ? matchedVal : matchedMax;

      // greedy baseline on the SAME combined score, for a fair comparison
      function greedy() {
        const usedP = new Set(), usedS = new Set(), picks = [];
        while (true) {
          let best = null;
          for (let pi = 0; pi < nP; pi++) { if (usedP.has(pi)) continue;
            for (let si = 0; si < nS; si++) { if (usedS.has(si) || !cand[pi][si]) continue;
              const s = score[pi][si]; if (best === null || s > best.s) best = { s, pi, si }; } }
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
        if (m) { assignments.push({ patient_id: p.id, patient_name: p.name, trial_id: m.trial_id, slot_label: m.slot_label, pref: m.pref, score: m.score }); return; }
        const anyElig = trials.some((_, ti) => elig[pi][ti]);
        const anyPref = trials.some((_, ti) => elig[pi][ti] && prefRaw(pi, ti) > 0);
        let reason, detail;
        if (!anyElig) { reason = INELIGIBLE_NO_TRIAL; detail = "qualifies for no trial (diagnosis or genomics gate)"; }
        else if (!anyPref) { reason = NO_PREFERENCE; detail = "qualifies, but expressed no preference (0) for any trial they qualify for"; }
        else { reason = NO_SLOT_AVAILABLE; detail = "every trial they qualify for and want is already taken"; }
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
      const totalScore = Object.values(active).reduce((a, m) => a + m.score, 0);
      const byPid = (matched) => { const o = {}; patients.forEach((p, pi) => { const m = matched[pi]; o[p.id] = m ? m.slot_label : null; }); return o; };

      // padded-matrix view: real patients × real slots, plus the per-patient 0-value
      // dummy "unmatched" column. Unfilled slots are the ones the solver handed to
      // dummy rows; the UI flags them via slot_filled.
      const matrixView = {
        slot_labels: slots.map((s) => s.label),
        slot_expires: slots.map((s) => (s.expires_days == null ? null : s.expires_days)),
        slot_urgency: uSlot,
        slot_filled: slots.map((_, si) => filledSi.has(si)),
        patient_names: patients.map((p) => p.name),
        patient_ids: patients.map((p) => p.id),
        patient_urgency: patients.map((_, pi) => features.patientUrgency ? uEff[pi].level : null),
        cells: patients.map((_, pi) => slots.map((__, si) => ({
          score: score[pi][si], cand: cand[pi][si], assigned: !!(active[pi] && active[pi].si === si),
        }))),
        unmatched: patients.map((_, pi) => !active[pi]),
        has_slot_urgency: features.slotUrgency,
        has_patient_urgency: features.patientUrgency,
      };

      return {
        patients, trials, fields, slots, params, urgency_eff: uEff,
        eligibility: elig, gate_detail: gateD,
        assignments, unmatched, unfilled_slots: unfilled, trial_fill: trialFill,
        total_pref: totalPref, total_score: totalScore, count: Object.keys(active).length,
        val_count: Object.keys(matchedVal).length, max_count: Object.keys(matchedMax).length,
        greedy_assignments: greedyAssignments, greedy_total: greedyTotal, greedy_count: greedyAssignments.length,
        active_by_pid: byPid(active), alt_by_pid: byPid(alt),
        alt_label: maxMatch ? "Best preference (maximal matching off)" : "Maximal matching on",
        alt_count: Object.keys(alt).length,
        matrix_view: features.matrixView ? matrixView : null,
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
      const p = { id: String(d.id).trim(), name: String(d.name || d.id).trim(), attrs, preferences: prefs };
      if (features.patientUrgency) p.urgency = URGENCY_LEVELS.indexOf(d.urgency) >= 0 ? d.urgency : "none";
      if (features.queueTiebreak) {
        p.joined = {};
        const rawj = d.joined || {};
        for (const k of Object.keys(rawj)) { const n = Number(rawj[k]); if (isFinite(n)) p.joined[String(k)] = n; }
        p.enrolled = (typeof d.enrolled === "string" && d.enrolled.trim()) ? d.enrolled.trim() : null;
      }
      return p;
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
        const conds = ("conds" in g ? (g.conds || []) : [g]).map((c) => condFromDict(c, fields)).filter(Boolean);
        return { conds };
      }).filter((g) => g.conds.length);
      const t = { id: String(d.id).trim(), name: String(d.name || d.id).trim(), slots: Math.max(1, parseInt(d.slots, 10) || 1), criteria: groups };
      if (features.slotUrgency) t.expires_days = isNumber(d.expires_days) ? Math.max(0, Math.round(Number(d.expires_days))) : null;
      return t;
    }
    function paramsFromDict(pr) {
      pr = pr || {};
      const params = { max_match: !!pr.max_match };
      if (features.slotUrgency) { params.w_slot = clamp01(numOr(pr.w_slot, 0.5)); params.horizon = Math.max(1, Math.round(numOr(pr.horizon, 30))); }
      if (features.patientUrgency) params.w_patient = clamp01(numOr(pr.w_patient, 0.5));
      return params;
    }
    function rulesFromDict(raw, fields) {
      if (!features.patientUrgency) return [];
      return (raw || []).map((r) => ({
        level: URGENCY_LEVELS.indexOf(r.level) > 0 ? r.level : "medium", // "none" rules are pointless
        conds: (r.conds || []).map((c) => condFromDict(c, fields)).filter(Boolean),
      })).filter((r) => r.conds.length);
    }
    function toModels(state) {
      const fields = {};
      for (const fd of (state.fields || [])) { const f = fieldFromDict(fd); if (f.name) fields[f.name] = f; }
      const patients = (state.patients || []).filter((p) => String(p.id || "").trim()).map((p) => patientFromDict(p, fields));
      patients.forEach((p, i) => { p.queue_pos = i; }); // arrival order = input order
      const trials = (state.trials || []).filter((t) => String(t.id || "").trim()).map((t) => trialFromDict(t, fields));
      return { patients, trials, fields, params: paramsFromDict(state.params), rules: rulesFromDict(state.urgency_rules, fields) };
    }

    // ---- models -> canonical state + render payload ---- //
    function canonicalState(patients, trials, fields, params, rules) {
      const out = {
        fields: Object.values(fields).map((f) => ({ name: f.name, label: f.label, kind: f.kind, unit: f.unit })),
        patients: patients.map((p) => {
          const o = { id: p.id, name: p.name,
            attrs: Object.fromEntries(Object.keys(fields).map((k) => [k, (k in p.attrs) ? p.attrs[k] : defaultValue(fields[k].kind)])),
            preferences: Object.assign({}, p.preferences) };
          if (features.patientUrgency) o.urgency = p.urgency || "none";
          if (features.queueTiebreak) { o.joined = Object.assign({}, p.joined || {}); o.enrolled = p.enrolled || null; }
          return o;
        }),
        trials: trials.map((t) => {
          const o = { id: t.id, name: t.name, slots: t.slots,
            criteria: t.criteria.map((g) => ({ conds: g.conds.map((c) => ({ field: c.field, op: c.op, value: c.value, value2: c.value2 })) })) };
          if (features.slotUrgency) o.expires_days = (t.expires_days == null ? null : t.expires_days);
          return o;
        }),
        params: Object.assign({}, params),
      };
      if (features.patientUrgency) out.urgency_rules = (rules || []).map((r) => ({ level: r.level, conds: r.conds.map((c) => ({ field: c.field, op: c.op, value: c.value, value2: c.value2 })) }));
      return out;
    }
    function resultPayload(r) {
      return {
        patient_ids: r.patients.map((p) => p.id),
        patient_names: r.patients.map((p) => p.name),
        fields: Object.values(r.fields).map((f) => ({ name: f.name, label: f.label, kind: f.kind, unit: f.unit })),
        patients_detail: r.patients.map((p, i) => ({ id: p.id, name: p.name, attrs: p.attrs, preferences: Object.assign({}, p.preferences),
          urgency: (features.patientUrgency ? r.urgency_eff[i].level : undefined),
          urgency_source: (features.patientUrgency ? r.urgency_eff[i].source : undefined),
          urgency_manual: (features.patientUrgency ? (p.urgency || "none") : undefined) })),
        trial_ids: r.trials.map((t) => t.id),
        trial_names: r.trials.map((t) => t.name),
        trial_expires: r.trials.map((t) => (features.slotUrgency ? (t.expires_days == null ? null : t.expires_days) : null)),
        slot_labels: r.slots.map((s) => s.label),
        eligibility: r.eligibility,
        gate_detail: r.gate_detail,
        params: r.params,
        assignments: r.assignments,
        unmatched: r.unmatched,
        unfilled_slots: r.unfilled_slots,
        trial_fill: r.trial_fill,
        total_pref: r.total_pref,
        total_score: r.total_score,
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
        matrix_view: r.matrix_view,
      };
    }

    function match(state) {
      const m = toModels(state);
      const r = runPipeline(m.patients, m.trials, m.fields, m.params, m.rules);
      return { state: canonicalState(m.patients, m.trials, m.fields, m.params, m.rules), result: resultPayload(r) };
    }

    const scenarios = cfg.scenarios;
    const DEFAULT_SCENARIO = scenarios[0].name;
    function scenarioState(name) { const s = scenarios.find((x) => x.name === name) || scenarios[0]; return s.factory(); }

    return {
      version: cfg.version, label: cfg.label, tagline: cfg.tagline, features,
      match, scenarios: scenarios.map((s) => ({ name: s.name, blurb: s.blurb })),
      scenarioState, DEFAULT_SCENARIO,
      OPS_FOR_KIND, OP_SYMBOL, URGENCY_LEVELS, URGENCY_VALUE,
    };
  }

  // =========================================================================== //
  // Scenario builders
  // =========================================================================== //
  const FIELDS = () => [
    { name: "cancer_type", label: "Cancer type", kind: CATEGORICAL, unit: "" },
    { name: "genomics", label: "Genomics", kind: SET, unit: "" },
  ];
  const cond = (field, op, value) => ({ field, op, value });
  const grp = (...conds) => ({ conds });
  const nsclc = () => grp(cond("cancer_type", "==", "NSCLC"));
  const pat = (id, name, cancer, prefs, extra) => Object.assign({ id, name, attrs: { cancer_type: cancer, genomics: [] }, preferences: prefs }, extra || {});
  // ranked-pick patient: choices [1st,2nd,3rd] -> preferences 3/2/1 (v3/v4 use the top-3 picker UI)
  const rankPrefs = (choices) => { const o = {}; (choices || []).forEach((tid, i) => { if (tid) o[tid] = 3 - i; }); return o; };
  const patc = (id, name, cancer, choices, extra) => pat(id, name, cancer, rankPrefs(choices), Object.assign({ choices }, extra || {}));
  const trial = (id, name, opts, ...groups) => Object.assign({ id, name, slots: (opts && opts.slots) || 1, criteria: groups.length ? groups : [nsclc()] }, (opts && opts.expires != null) ? { expires_days: opts.expires } : { expires_days: null });
  const mkState = (patients, trials, params) => ({ fields: FIELDS(), patients, trials, params: Object.assign({ max_match: false }, params || {}) });

  // ---- v3 scenarios: uneven matrices ---- //
  const MATRIX_SCENARIOS = [
    { name: "1 · 3 patients, 2 slots (surplus patients)",
      blurb: "One more patient than slots. The solver pads the matrix square: each patient gets a 0-value dummy 'unmatched' column, so leaving someone out is always a legal (just worthless) assignment. One patient lands on their dummy column — that IS the unmatched outcome. Watch the matrix card below the results.",
      factory: () => mkState(
        [pat("P1", "Eleanor Hughes", "NSCLC", { T1: 1, T2: 1 }),
         pat("P2", "Marcus Bell", "NSCLC", { T1: 1, T2: 1 }),
         pat("P3", "Priya Nair", "NSCLC", { T1: 1, T2: 1 })],
        [trial("T1", "Trial A"), trial("T2", "Trial B")]) },
    { name: "2 · 2 patients, 3 slots (surplus slots)",
      blurb: "One more slot than patients. The padding also adds 0-value dummy patient ROWS; the leftover slot is 'won' by a dummy row, which is exactly what an unfilled slot is. No special-casing — empty capacity is just a 0-weight match.",
      factory: () => mkState(
        [pat("P1", "Eleanor Hughes", "NSCLC", { T1: 1, T2: 1, T3: 1 }),
         pat("P2", "Marcus Bell", "NSCLC", { T1: 1, T2: 1, T3: 1 })],
        [trial("T1", "Trial A"), trial("T2", "Trial B"), trial("T3", "Trial C")]) },
    { name: "3 · Blank preference = won't take",
      blurb: "Marcus left Trial B blank (0 = refuses it), so that cell is blocked (✕) even though he's eligible. Default plan seats Eleanor in Trial A and leaves Marcus out (equal total, fewer enrolled wins ties); toggle Maximal matching to route Eleanor to B so Marcus gets his only wanted trial.",
      factory: () => mkState(
        [pat("P1", "Eleanor Hughes", "NSCLC", { T1: 2, T2: 1 }),
         pat("P2", "Marcus Bell", "NSCLC", { T1: 1 })],
        [trial("T1", "Trial A"), trial("T2", "Trial B")]) },
    { name: "4 · Multi-slot trial (2 + 1 slots, 4 patients)",
      blurb: "Trial A has 2 open slots, so it expands into two columns (Trial A #1 / #2) in the matrix. Four patients compete for three real columns; the surplus patient falls to their dummy column.",
      factory: () => mkState(
        [pat("P1", "Eleanor Hughes", "NSCLC", { T1: 2, T2: 1 }),
         pat("P2", "Marcus Bell", "NSCLC", { T1: 1, T2: 2 }),
         pat("P3", "Priya Nair", "NSCLC", { T1: 1, T2: 1 }),
         pat("P4", "Dev Kapoor", "NSCLC", { T1: 1, T2: 1 })],
        [trial("T1", "Trial A", { slots: 2 }), trial("T2", "Trial B")]) },
  ];

  // ---- v3 scenarios: slot urgency (top-3 ranked picks; scores 3/2/1) ---- //
  const V3_SCENARIOS = [
    { name: "1 · Expiring slot outranks the 1st choice",
      blurb: "Eleanor ranks durable A 1st and expiring B (3 days) 2nd. At the default slot-urgency weight 0.5 the closing window wins: she's seated at her 2nd choice (B = 2/3 + 0.5×0.9 ≈ 1.12 vs A = 1.00). Drop the weight below ~0.37 and her 1st choice holds — the slider decides how much a deadline can bend a patient's ranking.",
      factory: () => mkState(
        [patc("P1", "Eleanor Hughes", "NSCLC", ["T1", "T2"])],
        [trial("T1", "Trial A"), trial("T2", "Trial B", { expires: 3 })]) },
    { name: "2 · How deep can urgency reach? (slider)",
      blurb: "Now the expiring B is only Eleanor's 3rd choice (♥1, with C her 2nd). At weight 0.5 her 1st choice A wins (B = 1/3 + 0.45 = 0.78 vs 1.00). The closing window overtakes a 3rd choice only past ~0.74 — versus ~0.37 for a 2nd choice (scenario 1). The deeper the preference gap, the more urgency it takes to cross it.",
      factory: () => mkState(
        [patc("P1", "Eleanor Hughes", "NSCLC", ["T1", "T3", "T2"])],
        [trial("T1", "Trial A"), trial("T2", "Trial B", { expires: 3 }), trial("T3", "Trial C")]) },
    { name: "3 · No expiry still fills",
      blurb: "Marcus picked only the no-expiry A — it still fills normally (urgency is a bonus, never a requirement). Eleanor ranks A 1st too, but she also picked expiring B: the optimizer gives Marcus the only trial he'll take and spends Eleanor on the closing window (her 2nd choice).",
      factory: () => mkState(
        [patc("P1", "Eleanor Hughes", "NSCLC", ["T1", "T2"]),
         patc("P2", "Marcus Bell", "NSCLC", ["T1"])],
        [trial("T1", "Trial A"), trial("T2", "Trial B", { expires: 5 })]) },
    { name: "4 · Two windows closing at different speeds",
      blurb: "B expires in 2 days, C in 20, A never. Marcus picked only C, so he covers it. Priya ranks durable A 1st — but the 2-day window B (her 2nd choice) outscores it (2/3 + 0.47 ≈ 1.13 vs 1.00), so the engine spends her on the fastest-closing slot and lets A wait.",
      factory: () => mkState(
        [patc("P1", "Priya Nair", "NSCLC", ["T1", "T2", "T3"]),
         patc("P2", "Marcus Bell", "NSCLC", ["T3"])],
        [trial("T1", "Trial A"), trial("T2", "Trial B", { expires: 2 }), trial("T3", "Trial C", { expires: 20 })]) },
    { name: "5 · Expired today: max urgency (edge)",
      blurb: "Trial A expires in 0 days — the ramp clamps at urgency 1, the maximum. Even as Eleanor's 2nd choice it overtakes her 1st (2/3 + 0.5 = 1.17 vs 1.00). Edge to note for production: here 'expires today' means MOST urgent and the slot still fills; a real system may want a hard cutoff that excludes already-dead slots instead.",
      factory: () => mkState(
        [patc("P1", "Eleanor Hughes", "NSCLC", ["T2", "T1"])],
        [trial("T1", "Trial A", { expires: 0 }), trial("T2", "Trial B")]) },
    { name: "6 · Inside vs outside the horizon (edge)",
      blurb: "B (29 days, Eleanor's 2nd choice) sits just inside the 30-day horizon — urgency 0.03, far too small to beat her 1st choice A. Anything at 30+ days is EXACTLY 0, indistinguishable from no expiry. Stretch the Horizon to 90 and the very same 29-day window becomes urgent enough to flip her to B — the horizon defines what 'expiring' even means.",
      factory: () => mkState(
        [patc("P1", "Eleanor Hughes", "NSCLC", ["T1", "T2"])],
        [trial("T1", "Trial A"), trial("T2", "Trial B", { expires: 29 })]) },
    { name: "7 · Urgency can't force a refused slot (edge)",
      blurb: "Trial A expires TOMORROW, but Eleanor didn't pick it (unpicked = won't take it). Maximum urgency changes nothing: candidacy still requires eligibility AND a pick, so A goes unfilled and Eleanor gets her chosen B. Urgency re-ranks the trials a patient chose; it never overrides consent.",
      factory: () => mkState(
        [patc("P1", "Eleanor Hughes", "NSCLC", ["T2"])],
        [trial("T1", "Trial A", { expires: 1 }), trial("T2", "Trial B")]) },
    { name: "8 · Greedy's urgency trap (edge)",
      blurb: "The urgent Trial A (2 days) tops both patients' lists, but Marcus picked ONLY A while Eleanor also has B as her 2nd choice. A greedy ranker grabs the first top-scoring pair — Eleanor into A — and strands Marcus (1 enrolled). The optimizer seats Marcus in A and Eleanor at her 2nd choice: both enrolled, urgent slot still covered.",
      factory: () => mkState(
        [patc("P1", "Eleanor Hughes", "NSCLC", ["T1", "T2"]),
         patc("P2", "Marcus Bell", "NSCLC", ["T1"])],
        [trial("T1", "Trial A", { expires: 2 }), trial("T2", "Trial B")]) },
  ];

  // ---- v4 scenarios: patient urgency (top-3 ranked picks; scores 3/2/1) ---- //
  const V4_SCENARIOS = [
    { name: "1 · Stage IV wins the contested slot",
      blurb: "Both patients picked only Trial A (1 slot). Priya is stage I (urgency: low), Marcus is stage IV metastatic (critical). His row is amplified ×1.5 vs her ×1.125 — far more than the queue tiebreak — so the contested seat goes to the sickest patient, not to whoever picked first.",
      factory: () => mkState(
        [patc("P1", "Priya Nair", "NSCLC", ["T1"], { urgency: "low" }),
         patc("P2", "Marcus Bell", "NSCLC", ["T1"], { urgency: "critical" })],
        [trial("T1", "Trial A")]) },
    { name: "2 · Urgent patient gets their top choice",
      blurb: "Identical picks (A 1st, B 2nd), both enroll either way — but WHO gets the better trial? Patient urgency multiplies the whole row, so giving critical Marcus his #1 is worth more to the objective than giving it to low-urgency Priya. Set the patient-urgency weight to 0 and the seat falls back to queue order.",
      factory: () => mkState(
        [patc("P1", "Priya Nair", "NSCLC", ["T1", "T2"], { urgency: "low" }),
         patc("P2", "Marcus Bell", "NSCLC", ["T1", "T2"], { urgency: "critical" })],
        [trial("T1", "Trial A"), trial("T2", "Trial B")]) },
    { name: "3 · Triage under scarcity (3 patients, 2 slots)",
      blurb: "Two seats, three patients with identical picks (A 1st, B 2nd) at low / medium / critical urgency. Someone must be left out, and urgency decides who: critical Marcus takes the 1st-choice A, medium Priya gets B, and low-urgency Eleanor waits.",
      factory: () => mkState(
        [patc("P1", "Eleanor Hughes", "NSCLC", ["T1", "T2"], { urgency: "low" }),
         patc("P2", "Priya Nair", "NSCLC", ["T1", "T2"], { urgency: "medium" }),
         patc("P3", "Marcus Bell", "NSCLC", ["T1", "T2"], { urgency: "critical" })],
        [trial("T1", "Trial A"), trial("T2", "Trial B")]) },
    { name: "4 · Sickest patient to the expiring slot",
      blurb: "Both rank durable A 1st and expiring B (3 days) 2nd. Because patient urgency multiplies the slot bonus too, critical Marcus is pulled to the expiring B — even at the cost of his 1st choice — while low-urgency Priya keeps A. The perishable capacity goes to the patient who can least afford to wait.",
      factory: () => mkState(
        [patc("P1", "Priya Nair", "NSCLC", ["T1", "T2"], { urgency: "low" }),
         patc("P2", "Marcus Bell", "NSCLC", ["T1", "T2"], { urgency: "critical" })],
        [trial("T1", "Trial A"), trial("T2", "Trial B", { expires: 3 })]) },
    { name: "5 · Diagnosis rules: SCLC IV vs NSCLC IV",
      blurb: "Urgency derived from diagnosis instead of a manual level: SCLC stage IV → critical (aggressive, short treatment window) while NSCLC stage IV → low (more treatment runway). Both patients want the same single seat; the rules give it to the SCLC IV patient. Edit the rules in the 🚨 Diagnosis urgency rules section — first matching rule wins, and a manual level still escalates if higher.",
      factory: () => ({
        fields: [
          { name: "cancer_type", label: "Cancer type", kind: CATEGORICAL, unit: "" },
          { name: "stage", label: "Stage", kind: CATEGORICAL, unit: "" },
        ],
        patients: [
          { id: "P1", name: "Priya Nair (NSCLC IV)", attrs: { cancer_type: "NSCLC", stage: "IV" }, preferences: { T1: 3 }, choices: ["T1"], urgency: "none" },
          { id: "P2", name: "Marcus Bell (SCLC IV)", attrs: { cancer_type: "SCLC", stage: "IV" }, preferences: { T1: 3 }, choices: ["T1"], urgency: "none" },
        ],
        trials: [{ id: "T1", name: "Lung Trial", slots: 1, expires_days: null, criteria: [
          { conds: [{ field: "cancer_type", op: "==", value: "NSCLC" }, { field: "cancer_type", op: "==", value: "SCLC" }] }, // NSCLC OR SCLC
          { conds: [{ field: "stage", op: "==", value: "IV" }] },
        ] }],
        urgency_rules: [
          { level: "critical", conds: [{ field: "cancer_type", op: "==", value: "SCLC" }, { field: "stage", op: "==", value: "IV" }] },
          { level: "low", conds: [{ field: "cancer_type", op: "==", value: "NSCLC" }, { field: "stage", op: "==", value: "IV" }] },
        ],
        params: { max_match: false, w_slot: 0.5, w_patient: 0.5, horizon: 30 },
      }) },
    { name: "6 · Urgency amplifies, preference rules (slider · edge)",
      blurb: "One seat. Priya (low urgency) ranked it 1st (♥3); Marcus (critical) only 2nd (♥2). At the default patient-urgency weight 0.5 the stronger preference wins: Priya is seated. Push the weight past ~0.8 and Marcus's ×(1+w) multiplier overcomes the preference gap. A 1st-vs-3rd gap can NEVER flip (the multiplier maxes at ×2) — urgency scales preference, it doesn't replace it.",
      factory: () => mkState(
        [patc("P1", "Priya Nair", "NSCLC", ["T1"], { urgency: "low" }),
         patc("P2", "Marcus Bell", "NSCLC", [null, "T1"], { urgency: "critical" })],
        [trial("T1", "Trial A")]) },
    { name: "7 · Equal urgency: the queue decides (edge)",
      blurb: "Both patients are critical and ranked the same single seat 1st. Urgency only separates patients when it DIFFERS — with equal levels the multiplier cancels out, and the per-trial queue breaks the tie instead: Priya picked Trial A first, so Priya is seated. Reorder Trial A's queue in the card below to flip it.",
      factory: () => mkState(
        [patc("P1", "Priya Nair", "NSCLC", ["T1"], { urgency: "critical" }),
         patc("P2", "Marcus Bell", "NSCLC", ["T1"], { urgency: "critical" })],
        [trial("T1", "Trial A")]) },
    { name: "8 · Urgency can't create eligibility (edge)",
      blurb: "Marcus is critical but has SCLC, and Trial A requires NSCLC — he fails the gate, and no amount of urgency changes that (eligibility is checked BEFORE any scoring). Low-urgency Priya takes the seat; Marcus shows as INELIGIBLE_NO_TRIAL. Urgency prioritizes among qualified patients; it never bypasses criteria.",
      factory: () => mkState(
        [patc("P1", "Priya Nair", "NSCLC", ["T1"], { urgency: "low" }),
         patc("P2", "Marcus Bell", "SCLC", ["T1"], { urgency: "critical" })],
        [trial("T1", "Trial A", null, nsclc())]) },
    { name: "9 · Rule order matters: shadowing (edge)",
      blurb: "A generic rule (Stage IV → High) sits ABOVE the specific one (SCLC + IV → Critical). First match wins, so BOTH stage-IV patients collapse to High and the seat falls back to queue order (Priya picked first). Open 🚨 Diagnosis urgency rules and press ↑ on the SCLC rule to evaluate it first — Marcus becomes Critical and outranks the queue. Order specific rules before general ones.",
      factory: () => ({
        fields: [
          { name: "cancer_type", label: "Cancer type", kind: CATEGORICAL, unit: "" },
          { name: "stage", label: "Stage", kind: CATEGORICAL, unit: "" },
        ],
        patients: [
          { id: "P1", name: "Priya Nair (NSCLC IV)", attrs: { cancer_type: "NSCLC", stage: "IV" }, preferences: { T1: 3 }, choices: ["T1"], urgency: "none" },
          { id: "P2", name: "Marcus Bell (SCLC IV)", attrs: { cancer_type: "SCLC", stage: "IV" }, preferences: { T1: 3 }, choices: ["T1"], urgency: "none" },
        ],
        trials: [{ id: "T1", name: "Lung Trial", slots: 1, expires_days: null, criteria: [
          { conds: [{ field: "cancer_type", op: "==", value: "NSCLC" }, { field: "cancer_type", op: "==", value: "SCLC" }] },
          { conds: [{ field: "stage", op: "==", value: "IV" }] },
        ] }],
        urgency_rules: [
          { level: "high", conds: [{ field: "stage", op: "==", value: "IV" }] }, // generic rule shadows the specific one below
          { level: "critical", conds: [{ field: "cancer_type", op: "==", value: "SCLC" }, { field: "stage", op: "==", value: "IV" }] },
        ],
        params: { max_match: false, w_slot: 0.5, w_patient: 0.5, horizon: 30 },
      }) },
  ];

  // =========================================================================== //
  // Build + expose
  // =========================================================================== //
  // stub scenario list for v2choice (the app's choice tab supplies its own scenarios)
  const CHOICE_STUB_SCENARIOS = [
    { name: "1 · Identical rankings (queue decides)", blurb: "All patients rank the trials identically; the arrival queue breaks the tie.",
      factory: () => mkState(
        [pat("P1", "Eleanor Hughes", "NSCLC", { T1: 3, T2: 2, T3: 1 }),
         pat("P2", "Marcus Bell", "NSCLC", { T1: 3, T2: 2, T3: 1 }),
         pat("P3", "Priya Nair", "NSCLC", { T1: 3, T2: 2, T3: 1 })],
        [trial("T1", "Trial A"), trial("T2", "Trial B"), trial("T3", "Trial C")]) },
  ];

  const ENGINES = {
    // v2 + first-come-first-served tiebreak (used by the app's "Patient choice" tab)
    v2choice: makeEngine({
      version: "v2", label: "v2 · Patient choice", tagline: "v2 with SphinxMatch-style ranked picks; exact ties break by each trial's own queue (first to pick that trial, first served).",
      features: { matrixView: false, slotUrgency: false, patientUrgency: false, queueTiebreak: true },
      scenarios: CHOICE_STUB_SCENARIOS,
    }),
    // algorithmically identical to v2 — only adds the matrix_view visualization
    v2matrix: makeEngine({
      version: "v2", label: "v2 · Uneven matrix", tagline: "Same algorithm as v2 — this tab only VISUALIZES how it already handles empty values: surplus patients fall to 0-value dummy columns (unmatched), surplus slots are absorbed by dummy rows (unfilled). The padded matrix is rendered under the results.",
      features: { matrixView: true, slotUrgency: false, patientUrgency: false },
      scenarios: MATRIX_SCENARIOS,
    }),
    v3: makeEngine({
      version: "v3", label: "v3 · Slot urgency", tagline: "Patients rank up to 3 trials (1st ♥3 / 2nd ♥2 / 3rd ♥1; unpicked = won't take). Trials can carry an expiration (days): cell score = rank score + weight × urgency, ramping from 0 (≥ horizon days out, or no expiry) to 1 (expires today). No-expiry slots still fill, and exact ties break by each trial's own queue.",
      features: { matrixView: true, slotUrgency: true, patientUrgency: false, queueTiebreak: true },
      scenarios: V3_SCENARIOS,
    }),
    v4: makeEngine({
      version: "v4", label: "v4 · Patient urgency", tagline: "Patients rank up to 3 trials (♥3/♥2/♥1). Patient urgency multiplies the whole row score, so urgent patients win contested seats, better choices, and expiring slots; when urgency ties exactly, each trial's own queue decides. Urgency is manual or derived from diagnosis rules (e.g. SCLC + stage IV → critical, NSCLC + stage IV → low); first matching rule wins, manual escalates if higher.",
      features: { matrixView: true, slotUrgency: true, patientUrgency: true, queueTiebreak: true },
      scenarios: V4_SCENARIOS,
    }),
  };

  global.ENGINES = ENGINES;
  if (typeof module !== "undefined" && module.exports) module.exports = ENGINES;

})(typeof window !== "undefined" ? window : globalThis);
