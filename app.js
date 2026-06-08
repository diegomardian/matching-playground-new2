"use strict";

// --------------------------------------------------------------------------- //
// Access gate (hosted deployment only) — a LIGHTWEIGHT DETERRENT, not real security.
// Static hosting can't hide the page source, so this only keeps casual visitors out.
// Skipped on localhost/file:// so local development isn't gated. Stores only a hash.
// --------------------------------------------------------------------------- //
(function authGate() {
  if (typeof window === "undefined" || typeof document === "undefined" || typeof location === "undefined") return;
  var KEY = "mp_auth_v1";
  var EXPECT = "c7b33ecd2083fbd035a5147091c1f5cf802822696407534f6ee81381f2c865e0"; // sha256(email\npassword)
  var h = location.hostname;
  if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "" || location.protocol === "file:") return;
  try { if (localStorage.getItem(KEY) === EXPECT) return; } catch (e) { /* storage blocked -> still gate */ }
  if (!(window.crypto && crypto.subtle)) return; // no SubtleCrypto (very old browser) -> don't lock out

  function sha256Hex(str) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    });
  }

  var ov = document.createElement("div");
  ov.style.cssText = "position:fixed;inset:0;z-index:99999;background:linear-gradient(120deg,#0f766e,#0d9488 55%,#14b8a6);display:flex;align-items:center;justify-content:center;font-family:ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif";
  ov.innerHTML =
    '<div style="background:#fff;border-radius:16px;box-shadow:0 12px 44px rgba(0,0,0,.25);padding:28px 26px;width:330px;max-width:90vw">' +
      '<div style="font-size:30px;text-align:center">🧮</div>' +
      '<h1 style="margin:6px 0 2px;font-size:18px;text-align:center;color:#1e293b">Matching Playground</h1>' +
      '<p style="margin:0 0 16px;font-size:12px;text-align:center;color:#64748b">Sign in to continue</p>' +
      '<input id="agEmail" type="email" placeholder="email" autocomplete="username" style="width:100%;box-sizing:border-box;border:1px solid #e2e8f0;border-radius:9px;padding:10px 11px;font-size:14px;margin-bottom:9px" />' +
      '<input id="agPass" type="password" placeholder="password" autocomplete="current-password" style="width:100%;box-sizing:border-box;border:1px solid #e2e8f0;border-radius:9px;padding:10px 11px;font-size:14px;margin-bottom:12px" />' +
      '<button id="agBtn" style="width:100%;border:none;background:#0d9488;color:#fff;padding:10px;border-radius:10px;font-size:14px;font-weight:650;cursor:pointer">Sign in</button>' +
      '<p id="agErr" style="margin:10px 0 0;font-size:12px;color:#dc2626;text-align:center;min-height:14px"></p>' +
    '</div>';
  document.body.appendChild(ov);
  document.documentElement.style.overflow = "hidden";

  var email = ov.querySelector("#agEmail"), pass = ov.querySelector("#agPass"), btn = ov.querySelector("#agBtn"), err = ov.querySelector("#agErr");
  email.focus();
  function submit() {
    err.textContent = "";
    sha256Hex((email.value || "").trim().toLowerCase() + "\n" + (pass.value || "")).then(function (hex) {
      if (hex === EXPECT) {
        try { localStorage.setItem(KEY, EXPECT); } catch (e) { /* ignore */ }
        document.documentElement.style.overflow = "";
        ov.remove();
      } else {
        err.textContent = "Incorrect email or password.";
        pass.value = ""; pass.focus();
      }
    });
  }
  btn.addEventListener("click", submit);
  pass.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
  email.addEventListener("keydown", function (e) { if (e.key === "Enter") pass.focus(); });
})();

// --------------------------------------------------------------------------- //
// Constants (mirror pipeline.py)
// --------------------------------------------------------------------------- //
const OPS_FOR_KIND = {
  numeric: [">=", ">", "<=", "<", "==", "!=", "between"],
  categorical: ["==", "!="],
  set: ["includes", "excludes"],
};
const OP_SYMBOL = { ">=": "≥", ">": ">", "<=": "≤", "<": "<", "==": "=", "!=": "≠", between: "between", includes: "includes", excludes: "excludes" };
const SCORING_LABEL = { gate: "Pass/fail", higher: "Higher better", lower: "Lower better", target: "Closer to centre", range: "In-range (flat)" };
function scoringOptionsForOp(op) {
  if (op === ">=" || op === ">") return ["higher", "gate"];
  if (op === "<=" || op === "<") return ["lower", "gate"];
  if (op === "between") return ["target", "range", "gate"];
  return ["gate"]; // ==, !=, includes, excludes
}
const REASON_CLASS = {
  INELIGIBLE_NO_TRIAL: "rc-ineligible", NO_SLOT_AVAILABLE: "rc-noslot", BELOW_THRESHOLD: "rc-below",
  NO_ELIGIBLE_PATIENT: "rc-noelig", NO_PATIENT_AVAILABLE: "rc-nopatient",
};

const state = {
  fields: [], patients: [], trials: [], params: { min_score_threshold: 0.3 },
  scenarios: [], default: null, view: "simple", lastResult: null, openPatientId: null,
};

// --------------------------------------------------------------------------- //
// tiny DOM helper
// --------------------------------------------------------------------------- //
const $ = (s) => document.querySelector(s);
function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) { if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); }
  return n;
}
const fieldsByName = () => Object.fromEntries(state.fields.map((f) => [f.name, f]));
function nextId(prefix, existing) {
  let k = existing.length + 1;
  const set = new Set(existing);
  while (set.has(prefix + k)) k++;
  return prefix + k;
}

// --------------------------------------------------------------------------- //
// Engine (client-side — no backend). ENGINE comes from engine.js.
// --------------------------------------------------------------------------- //
function payload() {
  return { fields: state.fields, patients: state.patients, trials: state.trials, params: state.params };
}

// Adopt a raw state (from a scenario seed / reset / localStorage): replace the editable
// inputs, then compute + render. Used when the inputs themselves change wholesale.
function loadState(raw) {
  state.fields = raw.fields;
  state.patients = raw.patients;
  state.trials = raw.trials;
  state.params = raw.params || state.params;
  renderInputs();
  syncThreshold();
  runAndRender();
}

// Recompute from the current editable state and render (does NOT re-render the inputs, so
// it never steals focus while typing). Persists to localStorage.
function runAndRender() {
  const st = payload();
  if (!st.patients.length || !st.trials.length) { renderError("Add at least one patient and one trial."); return; }
  ENGINE.store.save(st);
  try {
    const { result } = ENGINE.match(st);
    state.lastResult = result;
    renderResults(result);
  } catch (e) {
    renderError("Could not compute: " + e.message);
  }
}

let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(runAndRender, 200); }

// --------------------------------------------------------------------------- //
// Toolbar / scenarios
// --------------------------------------------------------------------------- //
function populateScenarios() {
  const sel = $("#scenarioSelect");
  sel.innerHTML = "";
  state.scenarios.forEach((s) => sel.appendChild(el("option", { value: s.name }, s.name)));
  updateBlurb();
}
function updateBlurb() {
  const name = $("#scenarioSelect").value;
  const s = state.scenarios.find((x) => x.name === name);
  $("#scenarioBlurb").textContent = s ? s.blurb : "";
}

// --------------------------------------------------------------------------- //
// Render inputs
// --------------------------------------------------------------------------- //
function renderInputs() {
  renderObjective();
  renderPatients();
  renderTrials();
  renderPreferences();
  renderFields();
  $("#patientCount").textContent = `· ${state.patients.length}`;
  $("#trialCount").textContent = `· ${state.trials.length}`;
  $("#fieldCount").textContent = `· ${state.fields.length}`;
}

function isPreference() { return state.params.objective === "preference"; }

function renderObjective() {
  const pref = isPreference();
  $("#objFit").classList.toggle("active", !pref);
  $("#objPref").classList.toggle("active", pref);
  $("#objHint").textContent = pref
    ? "Labs/genomics are pass/fail GATES; the optimizer maximizes total stated preference. Any positive preference is matchable — only a patient with no preference for an available slot is left out (no score threshold)."
    : "Labs GRADE the fit (Higher / Lower / Target…); tune per-criterion scoring in Advanced.";
  // the normalized-score threshold + threshold-aware toggle don't apply to preference mode
  $("#paramsSection").style.display = pref ? "none" : "";
  $("#optSection").style.display = pref ? "none" : "";
}

function setObjective(obj) {
  state.params.objective = obj;
  renderInputs();
  runAndRender();
}

function renderPreferences() {
  const sec = $("#prefSection");
  if (!isPreference()) { sec.style.display = "none"; return; }
  sec.style.display = "";
  const wrap = $("#prefMatrix"); wrap.innerHTML = "";
  const tbl = el("table", { class: "mtx pref-table" });
  const head = el("tr", {}, [el("th", {}, "patient \\ trial")]);
  state.trials.forEach((t) => head.appendChild(el("th", {}, t.name)));
  tbl.appendChild(head);
  state.patients.forEach((p) => {
    if (!p.preferences) p.preferences = {};
    const tr = el("tr", {}, [el("td", { class: "rowhead" }, p.name)]);
    state.trials.forEach((t) => {
      const v = p.preferences[t.id];
      tr.appendChild(el("td", {}, [el("input", {
        type: "number", step: "1", min: "0", class: "pref-input", value: (v == null ? "" : v),
        oninput: (e) => {
          const n = parseFloat(e.target.value);
          if (e.target.value === "" || isNaN(n)) delete p.preferences[t.id]; else p.preferences[t.id] = n;
          scheduleSave();
        },
      })]));
    });
    tbl.appendChild(tr);
  });
  wrap.appendChild(tbl);
}

function attrInput(field, value, onChange) {
  if (field.kind === "numeric") {
    const wrap = el("div", { style: "display:flex;align-items:center;gap:6px" }, [
      el("input", { type: "number", step: "0.1", value: value, oninput: (e) => onChange(parseFloat(e.target.value) || 0) }),
      field.unit ? el("span", { class: "unit" }, field.unit) : null,
    ]);
    return wrap;
  }
  if (field.kind === "set") {
    const arr = Array.isArray(value) ? value : (value ? [value] : []);
    return el("input", { type: "text", value: arr.join(", "), placeholder: "comma, separated",
      oninput: (e) => onChange(e.target.value.split(",").map((x) => x.trim()).filter(Boolean)) });
  }
  return el("input", { type: "text", value: value || "", oninput: (e) => onChange(e.target.value) });
}

function renderPatients() {
  const grid = $("#patientGrid");
  grid.innerHTML = "";
  state.patients.forEach((p, i) => {
    const body = el("div", { class: "entity-body" });
    state.fields.forEach((f) => {
      body.appendChild(el("div", { class: "attr-row" }, [
        el("label", {}, f.label),
        attrInput(f, p.attrs[f.name], (v) => { p.attrs[f.name] = v; scheduleSave(); }),
      ]));
    });
    grid.appendChild(el("div", { class: "entity patient" }, [
      el("div", { class: "entity-head" }, [
        el("span", { class: "ehemoji" }, "👤"),
        el("input", { class: "name-input", value: p.name, oninput: (e) => { p.name = e.target.value; scheduleSave(); } }),
        el("span", { class: "id-chip" }, p.id),
        el("button", { class: "del-entity", title: "remove", onclick: () => { state.patients.splice(i, 1); renderInputs(); scheduleSave(); } }, "✕"),
      ]),
      body,
    ]));
  });
}

function critChip(c) {
  const f = fieldsByName()[c.field];
  const label = f ? f.label : c.field;
  const unit = f && f.kind === "numeric" && f.unit ? " " + f.unit : "";
  const ruleVal = c.op === "between" ? `${c.value}–${c.value2}${unit}` : `${c.value}${unit}`;
  const opTxt = c.op === "between" ? "between" : (OP_SYMBOL[c.op] || c.op);
  const children = [el("span", { class: "cf" }, label), el("span", { class: "co" }, opTxt), el("span", {}, ruleVal)];
  if (c.required === false) children.push(el("span", { class: "pref-tag" }, "preferred"));
  return el("div", { class: "crit-chip" }, children);
}

function critEdit(trial, c, idx) {
  const fmap = fieldsByName();
  const fieldSel = el("select", {
    onchange: (e) => {
      c.field = e.target.value;
      const nf = fmap[c.field];
      c.op = OPS_FOR_KIND[nf.kind][0];
      c.value = nf.kind === "numeric" ? 0 : "";
      c.value2 = null; c.scoring = "";
      renderTrials(); scheduleSave();
    },
  }, state.fields.map((ff) => el("option", { value: ff.name, selected: ff.name === c.field ? "" : null }, ff.label)));
  const kind = (fmap[c.field] || {}).kind || "categorical";
  const opSel = el("select", {
    onchange: (e) => {
      c.op = e.target.value; c.scoring = "";
      if (c.op === "between" && (c.value2 == null || c.value2 === "")) c.value2 = (parseFloat(c.value) || 0) + 10;
      renderTrials(); scheduleSave();
    },
  }, OPS_FOR_KIND[kind].map((op) => el("option", { value: op, selected: op === c.op ? "" : null }, OP_SYMBOL[op])));

  let valuePart;
  if (kind === "numeric" && c.op === "between") {
    valuePart = el("div", { class: "crit-between" }, [
      el("input", { type: "number", step: "0.1", value: c.value, oninput: (e) => { c.value = parseFloat(e.target.value) || 0; scheduleSave(); } }),
      el("span", { class: "between-dash" }, "–"),
      el("input", { type: "number", step: "0.1", value: (c.value2 == null ? "" : c.value2), oninput: (e) => { c.value2 = parseFloat(e.target.value) || 0; scheduleSave(); } }),
    ]);
  } else if (kind === "numeric") {
    valuePart = el("input", { type: "number", step: "0.1", value: c.value, oninput: (e) => { c.value = parseFloat(e.target.value) || 0; scheduleSave(); } });
  } else {
    valuePart = el("input", { type: "text", value: c.value, oninput: (e) => { c.value = e.target.value; scheduleSave(); } });
  }
  const row1 = el("div", { class: "crit-edit" }, [
    fieldSel, opSel, valuePart,
    el("button", { class: "del-crit", title: "remove criterion", onclick: () => { trial.criteria.splice(idx, 1); renderTrials(); scheduleSave(); } }, "✕"),
  ]);

  // row 2: how it scores + weight + required/preferred
  const opts = scoringOptionsForOp(c.op);
  const cur = (c.scoring && opts.includes(c.scoring)) ? c.scoring : opts[0];
  const scoringSel = el("select", { onchange: (e) => { c.scoring = e.target.value; scheduleSave(); } },
    opts.map((s) => el("option", { value: s, selected: s === cur ? "" : null }, SCORING_LABEL[s])));
  const weightInput = el("input", { type: "number", step: "0.5", min: "0.5", value: (c.weight == null ? 1 : c.weight),
    oninput: (e) => { c.weight = parseFloat(e.target.value) || 1; scheduleSave(); } });
  const reqToggle = el("label", { class: "req-check", title: "Required = gates eligibility. Off = preferred (only nudges the fit score, never excludes)." }, [
    el("input", { type: "checkbox", checked: (c.required !== false) ? "" : null, onchange: (e) => { c.required = e.target.checked; renderTrials(); scheduleSave(); } }),
    document.createTextNode("required"),
  ]);
  const row2 = el("div", { class: "crit-opts" }, [
    el("span", { class: "co-lbl" }, "scores:"), scoringSel,
    el("span", { class: "co-lbl" }, "×"), weightInput,
    reqToggle,
  ]);
  return el("div", { class: "criterion" }, [row1, row2]);
}

function renderTrials() {
  const grid = $("#trialGrid");
  grid.innerHTML = "";
  const advanced = state.view === "advanced";
  state.trials.forEach((t, i) => {
    const body = el("div", { class: "entity-body" });
    body.appendChild(el("div", { class: "slot-row" }, [
      el("label", {}, "Open slots"),
      el("input", { type: "number", min: "1", step: "1", value: t.slots, oninput: (e) => { t.slots = Math.max(1, parseInt(e.target.value) || 1); scheduleSave(); } }),
    ]));
    body.appendChild(el("div", { class: "crit-title" }, "Eligibility criteria"));
    if (advanced) {
      if (t.criteria.length === 0) body.appendChild(el("div", { class: "crit-none" }, "none — every patient passes"));
      t.criteria.forEach((c, idx) => body.appendChild(critEdit(t, c, idx)));
      body.appendChild(el("button", { class: "btn-add-crit", onclick: () => {
        const f = state.fields[0]; t.criteria.push({ field: f.name, op: OPS_FOR_KIND[f.kind][0], value: f.kind === "numeric" ? 0 : "" });
        renderTrials(); scheduleSave();
      } }, "＋ add criterion"));
    } else {
      const chips = el("div", { class: "crit-chips" });
      if (t.criteria.length === 0) chips.appendChild(el("div", { class: "crit-none" }, "none — every patient passes"));
      t.criteria.forEach((c) => chips.appendChild(critChip(c)));
      body.appendChild(chips);
    }
    grid.appendChild(el("div", { class: "entity trial" }, [
      el("div", { class: "entity-head" }, [
        el("span", { class: "ehemoji" }, "🔬"),
        el("input", { class: "name-input", value: t.name, oninput: (e) => { t.name = e.target.value; scheduleSave(); } }),
        el("span", { class: "id-chip" }, t.id),
        el("button", { class: "del-entity", title: "remove", onclick: () => { state.trials.splice(i, 1); renderInputs(); scheduleSave(); } }, "✕"),
      ]),
      body,
    ]));
  });
}

function renderFields() {
  const card = $("#fieldsCard");
  card.innerHTML = "";
  const tbl = el("table", { class: "fields-table" });
  tbl.appendChild(el("tr", {}, ["Field (label)", "kind", "unit", "score range", ""].map((h) => el("th", {}, h))));
  state.fields.forEach((f, i) => {
    const kindSel = el("select", { onchange: (e) => { f.kind = e.target.value; if (e.target.value !== "numeric") f.unit = ""; cleanupAfterFieldChange(); renderInputs(); scheduleSave(); } },
      ["numeric", "categorical", "set"].map((k) => el("option", { value: k, selected: k === f.kind ? "" : null }, k)));
    tbl.appendChild(el("tr", {}, [
      el("td", {}, [el("input", { value: f.label, oninput: (e) => { f.label = e.target.value; renderPatients(); renderTrials(); scheduleSave(); } })]),
      el("td", {}, [kindSel]),
      el("td", {}, [f.kind === "numeric" ? el("input", { value: f.unit || "", oninput: (e) => { f.unit = e.target.value; renderPatients(); scheduleSave(); } }) : el("span", { class: "locked" }, "—")]),
      el("td", {}, [f.kind === "numeric" ? el("input", { type: "number", step: "0.5", value: f.norm_range, oninput: (e) => { f.norm_range = parseFloat(e.target.value) || 1; scheduleSave(); } }) : el("span", { class: "locked" }, "—")]),
      el("td", {}, [el("button", { class: "del-row", title: "remove field", onclick: () => { removeField(f.name); } }, "✕")]),
    ]));
  });
  card.appendChild(tbl);
}

function cleanupAfterFieldChange() {
  // drop criteria whose op no longer fits the field kind
  const fmap = fieldsByName();
  state.trials.forEach((t) => {
    t.criteria.forEach((c) => {
      const f = fmap[c.field];
      if (f && !OPS_FOR_KIND[f.kind].includes(c.op)) c.op = OPS_FOR_KIND[f.kind][0];
    });
  });
}
function removeField(name) {
  state.fields = state.fields.filter((f) => f.name !== name);
  state.patients.forEach((p) => { delete p.attrs[name]; });
  state.trials.forEach((t) => { t.criteria = t.criteria.filter((c) => c.field !== name); });
  renderInputs(); scheduleSave();
}

// --------------------------------------------------------------------------- //
// Add buttons / view
// --------------------------------------------------------------------------- //
function addPatient() {
  const id = nextId("P", state.patients.map((p) => p.id));
  const attrs = {};
  state.fields.forEach((f) => { attrs[f.name] = f.kind === "numeric" ? 0 : f.kind === "set" ? [] : ""; });
  state.patients.push({ id, name: "New patient", attrs });
  renderInputs(); scheduleSave();
}
function addTrial() {
  const id = nextId("T", state.trials.map((t) => t.id));
  const letter = String.fromCharCode(65 + state.trials.length); // A, B, C...
  state.trials.push({ id, name: "Trial " + letter, slots: 1, criteria: [] });
  renderInputs(); scheduleSave();
}
function addField() {
  const name = nextId("field_", state.fields.map((f) => f.name));
  state.fields.push({ name, label: "New field", kind: "numeric", unit: "", norm_range: 10 });
  state.patients.forEach((p) => { p.attrs[name] = 0; });
  renderInputs(); scheduleSave();
}
function setView(v) {
  state.view = v;
  document.body.classList.toggle("advanced", v === "advanced");
  $("#viewSimple").classList.toggle("active", v === "simple");
  $("#viewAdvanced").classList.toggle("active", v === "advanced");
  renderTrials();
  if (state.lastResult) renderResults(state.lastResult);
}
function syncThreshold() {
  $("#threshold").value = state.params.min_score_threshold;
  $("#thrVal").textContent = Number(state.params.min_score_threshold).toFixed(2);
  $("#thresholdAware").checked = !!state.params.threshold_aware;
}

// --------------------------------------------------------------------------- //
// Results
// --------------------------------------------------------------------------- //
function renderError(msg) { $("#results").innerHTML = ""; $("#results").appendChild(el("div", { class: "card error-card" }, "⚠ " + msg)); }

function renderResults(d) {
  const root = $("#results"); root.innerHTML = "";
  if (d.params && d.params.threshold_aware) {
    root.appendChild(el("div", { class: "mode-banner" },
      "⚙ Threshold-aware optimization is ON — the optimizer hides below-threshold pairs so it keeps the most patients matchable."));
  }
  root.appendChild(metricsCard(d));
  root.appendChild(boardCard(d));
  root.appendChild(unassignedCard(d));
  if (state.view === "advanced") {
    root.appendChild(greedyCard(d));
    root.appendChild(matricesCard(d));
  }
  // keep an open drawer in sync with re-rendered results
  if (state.openPatientId) {
    if (d.patient_ids.includes(state.openPatientId)) fillDrawer(state.openPatientId);
    else closeDrawer();
  }
}

// --------------------------------------------------------------------------- //
// Patient detail drawer
// --------------------------------------------------------------------------- //
function openPatient(pid) {
  if (!state.lastResult) return;
  state.openPatientId = pid;
  fillDrawer(pid);
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#drawerBackdrop").classList.add("open");
}
function closeDrawer() {
  state.openPatientId = null;
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#drawerBackdrop").classList.remove("open");
}
function fmtSet(v) { return Array.isArray(v) && v.length ? v.join(", ") : "(none)"; }

function drawerPref(d, pi, ti) {
  const raw = (d.patients_detail[pi].preferences || {})[d.trial_ids[ti]];
  return (raw == null) ? 0 : raw;
}
function trialBlock(d, pi, ti, isAssigned) {
  const pref = d.params && d.params.objective === "preference";
  const eligible = d.eligibility[pi][ti];
  const score = d.trial_score[pi][ti];
  const crits = d.criteria_detail[pi][ti];
  const badges = el("div", { class: "tblock-badges" });
  if (isAssigned) badges.appendChild(el("span", { class: "pill here" }, "matched here"));
  badges.appendChild(el("span", { class: "pill " + (eligible ? "elig" : "inelig") }, eligible ? "eligible" : "ineligible"));
  if (eligible) {
    if (pref) {
      const rp = drawerPref(d, pi, ti);
      badges.appendChild(el("span", { class: "pill fit" }, rp > 0 ? ("♥ preference " + rp) : "no preference"));
    } else {
      badges.appendChild(el("span", { class: "pill fit" }, "fit " + score.toFixed(3)));
    }
  }

  const block = el("div", { class: "tblock" + (isAssigned ? " is-assigned" : "") }, [
    el("div", { class: "tblock-head" }, [el("div", { class: "tblock-name" }, d.trial_names[ti]), badges]),
  ]);
  if (!crits.length) block.appendChild(el("div", { class: "tblock-none" }, "no criteria — every patient passes"));
  crits.forEach((c) => {
    let ruleVal;
    if (c.kind === "set") ruleVal = c.value;
    else if (c.op === "between") ruleVal = `${c.value}–${c.value2}${c.unit ? " " + c.unit : ""}`;
    else ruleVal = c.value + (c.unit ? " " + c.unit : "");
    const pv = c.kind === "set" ? fmtSet(c.patient_value) : (c.patient_value + (c.unit ? " " + c.unit : ""));
    const preferred = c.required === false;
    const icon = preferred ? "★" : (c.passed ? "✓" : "✗");
    const rowcls = preferred ? "soft" : (c.passed ? "pass" : "fail");
    const tags = [];
    if (preferred) tags.push("preferred");
    if (c.scoring && c.scoring !== "gate") tags.push(SCORING_LABEL[c.scoring] || c.scoring);
    if (c.weight && c.weight !== 1) tags.push("×" + c.weight);
    const labelKids = [el("b", {}, c.label), document.createTextNode(" "), el("span", { class: "rule" }, c.op_symbol + " " + ruleVal)];
    if (tags.length) labelKids.push(el("span", { class: "crit-tag" }, " · " + tags.join(" · ")));
    block.appendChild(el("div", { class: "crit-row " + rowcls }, [
      el("span", { class: "ci" }, icon),
      el("span", { class: "cl" }, labelKids),
      el("span", { class: "cv" }, "patient: " + pv),
    ]));
  });
  if (!eligible) {
    const failed = crits.filter((c) => !c.passed && c.required !== false).length;
    block.appendChild(el("div", { class: "tblock-foot" }, `Ineligible — fails ${failed} required ${failed === 1 ? "criterion" : "criteria"}.`));
  } else if (!isAssigned) {
    block.appendChild(el("div", { class: "tblock-foot" }, pref
      ? "Eligible, but the optimizer maximized the overall preference total — this slot went to someone who wanted it more, or this patient was placed in a trial they prefer."
      : "Eligible here, but the optimizer placed this patient elsewhere (better global total) or the slot went to a stronger fit."));
  }
  return block;
}

function fillDrawer(pid) {
  const d = state.lastResult;
  const pi = d.patient_ids.indexOf(pid);
  if (pi < 0) { closeDrawer(); return; }
  const pdet = d.patients_detail[pi];
  $("#drawerName").textContent = pdet.name;
  $("#drawerId").textContent = pdet.id;
  const body = $("#drawerBody"); body.innerHTML = "";

  // attribute chips
  const attrs = el("div", { class: "dr-attrs" });
  d.fields.forEach((f) => {
    let v = pdet.attrs[f.name];
    if (f.kind === "set") v = fmtSet(v);
    else if (f.kind === "numeric") v = (v ?? 0) + (f.unit ? " " + f.unit : "");
    else v = v || "(none)";
    attrs.appendChild(el("div", { class: "dr-attr" }, [el("b", {}, f.label + ": "), document.createTextNode(String(v))]));
  });
  body.appendChild(attrs);

  // outcome banner
  const assign = d.assignments.find((a) => a.patient_id === pid);
  const unmatch = d.unmatched.find((u) => u.patient_id === pid);
  if (assign) {
    body.appendChild(el("div", { class: "dr-outcome assigned" }, [
      el("span", { class: "big" }, "✓ Matched to " + assign.slot_label),
      document.createTextNode("Fit score " + assign.score.toFixed(3) + " — the optimizer's best global assignment for this patient."),
    ]));
  } else {
    const reason = unmatch ? unmatch.reason : "UNASSIGNED";
    body.appendChild(el("div", { class: "dr-outcome unassigned" }, [
      el("span", { class: "big" }, "✕ Not assigned"),
      el("span", { class: "rc " + (REASON_CLASS[reason] || "") }, reason),
      document.createTextNode(" " + (unmatch ? unmatch.detail : "")),
    ]));
  }

  // trial blocks: assigned first, then the rest by (eligible, then fit/preference) desc
  const pref = d.params && d.params.objective === "preference";
  const sortVal = (ti) => pref ? drawerPref(d, pi, ti) : d.trial_score[pi][ti];
  const assignedTi = assign ? d.trial_ids.indexOf(assign.trial_id) : -1;
  const others = d.trial_ids.map((_, ti) => ti).filter((ti) => ti !== assignedTi)
    .sort((a, b) => (d.eligibility[pi][b] - d.eligibility[pi][a]) || (sortVal(b) - sortVal(a)));
  if (assignedTi >= 0) {
    body.appendChild(el("div", { class: "dr-section-title" }, "Assigned trial — criterion by criterion"));
    body.appendChild(trialBlock(d, pi, assignedTi, true));
    body.appendChild(el("div", { class: "dr-section-title" }, "Trials it didn't go to"));
  } else {
    body.appendChild(el("div", { class: "dr-section-title" }, pref ? "Every trial (most-preferred first)" : "Every trial (best fit first)"));
  }
  others.forEach((ti) => body.appendChild(trialBlock(d, pi, ti, false)));
}

function metric(label, num, sub, cls = "") {
  return el("div", { class: "metric " + cls }, [el("div", { class: "label" }, label), el("div", { class: "num" }, num), el("div", { class: "sub" }, sub)]);
}
function metricsCard(d) {
  const filled = Object.values(d.trial_fill).reduce((a, v) => a + v.filled, 0);
  return el("div", { class: "metrics" }, [
    metric("Patients matched", String(d.assignments.length), `${d.unmatched.length} unassigned`, "good"),
    metric("Slots filled", `${filled}/${d.slot_labels.length}`, `${d.n_real_patients} patients · ${d.slot_labels.length} slots`),
    (d.params.objective === "preference"
      ? metric("Total preference", d.total_score.toFixed(3), "normalized (Hungarian)", "accent")
      : metric("Optimal score", d.total_score.toFixed(3), "total fit (Hungarian)", "accent")),
    metric("Matrix size", `${d.n}×${d.n}`, `pad cost ${d.pad_cost.toFixed(2)}`),
  ]);
}

// --- kanban board: one column per trial, assigned patient cards beneath ---- //
function ptAssigned(a) {
  // in preference mode show the patient's RAW stated preference, not the normalized score
  let num = a.score.toFixed(3);
  if (state.lastResult && state.lastResult.params && state.lastResult.params.objective === "preference") {
    const p = state.patients.find((x) => x.id === a.patient_id);
    const raw = p && p.preferences ? p.preferences[a.trial_id] : undefined;
    num = (raw == null) ? a.score.toFixed(2) : "♥ " + raw;
  }
  return el("div", { class: "pt-card assigned clickable", onclick: () => openPatient(a.patient_id) }, [
    el("div", { class: "pt-top" }, [
      el("span", { class: "pt-name" }, a.patient_name),
      el("span", { class: "pt-fit" }, num),
    ]),
    el("div", { class: "pt-slot" }, a.slot_label),
    el("div", { class: "pt-bar" }, [el("span", { style: `width:${Math.min(100, a.score * 100)}%` })]),
  ]);
}
function ptEmpty(s) {
  return el("div", { class: "pt-card empty" }, [
    el("div", { class: "empty-label" }, "○ empty slot — " + s.slot_label),
    el("span", { class: "rc " + (REASON_CLASS[s.reason] || "") }, s.reason),
  ]);
}
function boardCard(d) {
  const byAssign = {}, byEmpty = {};
  d.assignments.forEach((a) => (byAssign[a.trial_id] = byAssign[a.trial_id] || []).push(a));
  d.unfilled_slots.forEach((s) => (byEmpty[s.trial_id] = byEmpty[s.trial_id] || []).push(s));

  const board = el("div", { class: "trial-board" });
  d.trial_ids.forEach((tid, i) => {
    const fill = d.trial_fill[tid] || { filled: 0, total: 0 };
    const body = el("div", { class: "trial-col-body" });
    (byAssign[tid] || []).forEach((a) => body.appendChild(ptAssigned(a)));
    (byEmpty[tid] || []).forEach((s) => body.appendChild(ptEmpty(s)));
    const filledFull = fill.total > 0 && fill.filled === fill.total;
    board.appendChild(el("div", { class: "trial-col" }, [
      el("div", { class: "trial-col-head" }, [
        el("div", { class: "tc-name" }, d.trial_names[i]),
        el("div", { class: "tc-slots" + (filledFull ? " full" : "") }, `${fill.filled}/${fill.total} slots filled`),
      ]),
      body,
    ]));
  });
  return el("section", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", {}, "Assignments by trial")]),
    el("div", { class: "board-scroll" }, [board]),
  ]);
}

function unassignedCard(d) {
  const inner = [el("div", { class: "card-head" }, [el("h3", {}, `Unassigned patients (${d.unmatched.length})`)])];
  if (d.unmatched.length === 0) {
    inner.push(el("div", { class: "empty-good" }, "✓ Every patient was matched."));
  } else {
    const grid = el("div", { class: "unassigned-grid" });
    d.unmatched.forEach((u) => grid.appendChild(el("div", { class: "pt-card unassigned clickable", onclick: () => openPatient(u.patient_id) }, [
      el("div", { class: "pt-top" }, [
        el("span", { class: "pt-name" }, u.patient_name),
        el("span", { class: "rc " + (REASON_CLASS[u.reason] || "") }, u.reason),
      ]),
      el("div", { class: "pt-detail" }, u.detail),
    ])));
    inner.push(grid);
  }
  return el("section", { class: "card" }, inner);
}

function greedyCard(d) {
  const opt = d.total_score, greedy = d.greedy_total, max = Math.max(opt, greedy, 1e-9), delta = opt - greedy;
  const bar = (label, val, cls) => el("div", { class: "gvo-row" }, [
    el("div", { class: "gvo-label" }, label),
    el("div", { class: "bar-track" }, [el("div", { class: "bar-fill " + cls, style: `width:${(val / max) * 100}%` })]),
    el("div", { class: "gvo-val" }, val.toFixed(3)),
  ]);
  let callout;
  if (delta > 1e-9) callout = el("div", { class: "callout win" }, `Hungarian beats greedy by ${delta.toFixed(3)} (${d.assignments.length} vs ${d.greedy_assignments.length} matches). Greedy grabbed a locally-best pair that blocked a better global trade-off.`);
  else if (opt > 0 || greedy > 0) callout = el("div", { class: "callout tie" }, "Greedy ties the optimum on this input. Try the Balanced 3×3 example to see them diverge.");
  else callout = el("div", { class: "callout none" }, "No eligible above-threshold matches exist, so both totals are 0.");
  return el("section", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", {}, "Greedy vs. optimal")]),
    el("div", { class: "gvo" }, [bar("Hungarian", opt, "opt"), bar("Greedy", greedy, "greedy")]), callout,
  ]);
}

// matrices
function scoreColor(v) { if (v <= 0) return "#fff"; const t = Math.min(1, v); return `rgb(${Math.round(255 + (13 - 255) * t)},${Math.round(255 + (148 - 255) * t)},${Math.round(255 + (136 - 255) * t)})`; }
function costColor(v, pad) { const t = Math.max(0, Math.min(1, v / (pad || 1))); return `rgb(${Math.round(240 + (203 - 240) * (1 - t))},${Math.round(253 + (213 - 253) * (1 - t))},${Math.round(244 + (225 - 244) * (1 - t))})`; }

function eligibilityMatrix(d) {
  const tbl = el("table", { class: "mtx" });
  const head = el("tr", {}, [el("th", {}, "patient \\ trial")]); d.trial_names.forEach((t) => head.appendChild(el("th", {}, t))); tbl.appendChild(head);
  d.patient_names.forEach((pn, pi) => {
    const tr = el("tr", {}, [el("td", { class: "rowhead" }, pn)]);
    d.trial_names.forEach((_, ti) => {
      if (d.eligibility[pi][ti]) tr.appendChild(el("td", { class: "elig" }, "✓"));
      else tr.appendChild(el("td", { class: "inelig", title: "fails: " + d.failing_criteria[pi][ti].join("; ") }, "✗"));
    });
    tbl.appendChild(tr);
  });
  return tbl;
}
function scoreMatrix(d) {
  const assignedSet = new Set(d.assignments.map((a) => a.patient_name + "||" + a.slot_label));
  const tbl = el("table", { class: "mtx" });
  const head = el("tr", {}, [el("th", {}, "patient \\ slot")]); d.slot_labels.forEach((s) => head.appendChild(el("th", {}, s))); tbl.appendChild(head);
  d.patient_names.forEach((pn, pi) => {
    const tr = el("tr", {}, [el("td", { class: "rowhead" }, pn)]);
    d.slot_labels.forEach((label, si) => {
      const v = d.score[pi][si]; const isA = assignedSet.has(pn + "||" + label);
      tr.appendChild(el("td", { class: isA ? "assigned-cell" : "", style: `background:${scoreColor(v)}` }, v.toFixed(2)));
    });
    tbl.appendChild(tr);
  });
  return tbl;
}
function costMatrix(d) {
  const tbl = el("table", { class: "mtx" });
  const head = el("tr", {}, [el("th", {}, "row \\ col")]); d.col_names.forEach((c) => head.appendChild(el("th", { class: c.startsWith("dummy_") ? "dummy" : "" }, c))); tbl.appendChild(head);
  d.row_names.forEach((rn, r) => {
    const rd = rn.startsWith("dummy_");
    const tr = el("tr", {}, [el("td", { class: "rowhead" + (rd ? " dummy" : "") }, rn)]);
    d.col_names.forEach((cn, c) => {
      const cd = cn.startsWith("dummy_"); const v = d.cost_padded[r][c];
      tr.appendChild((rd || cd) ? el("td", { class: "dummy" }, v.toFixed(2)) : el("td", { style: `background:${costColor(v, d.pad_cost)}` }, v.toFixed(2)));
    });
    tbl.appendChild(tr);
  });
  return tbl;
}
function block(title, cap, table, legend) {
  const ch = [el("h3", {}, title), el("p", { class: "cap" }, cap), el("div", { class: "mtx-wrap" }, [table])];
  if (legend) ch.push(legend);
  return el("div", { class: "matrix-block" }, ch);
}
function matricesCard(d) {
  const scoreCap = "Eligible pair score = weighted mean of each scoring criterion's fit (Higher/Lower ramp, Closer-to-centre peak, In-range, or a preferred Pass/fail bonus). Required pass/fail gates don't add a gradient. Ineligible = hard 0. Teal outline = chosen by the optimizer.";
  let costCap = `cost = 1 − score, padded to ${d.n}×${d.n} (n = max(#patients, #slots)). Dummy rows/cols (grey) carry pad = maxRealCost + 1 = ${d.pad_cost.toFixed(3)} — strictly above every real cost, so dummies are matched last. Real region = ${d.n_real_patients}×${d.n_real_slots}.`;
  if (d.params && d.params.threshold_aware) costCap += ` Threshold-aware mode is ON: pairs scoring below ${d.params.min_score_threshold.toFixed(2)} are masked to 0 before solving, so the optimizer won't strand a patient on a slot it would only drop.`;
  const eligLegend = el("div", { class: "legend" }, [
    el("span", {}, [el("span", { class: "swatch", style: "background:#dcfce7" }), "eligible (✓)"]),
    el("span", {}, [el("span", { class: "swatch", style: "background:#fef2f2" }), "ineligible (✗) — hover for failing criterion"]),
  ]);
  const details = el("details", { class: "matrix-section", open: "" }, [
    el("summary", {}, "Show the work — the three matrices the pipeline builds"),
    block("1 · Boolean eligibility (P × trials)", "Stage 1 pre-filter on the trial's criteria.", eligibilityMatrix(d), eligLegend),
    block("2 · Score matrix (P × slots)", scoreCap, scoreMatrix(d)),
    block("3 · Padded square cost matrix", costCap, costMatrix(d)),
  ]);
  return el("section", { class: "card" }, [details]);
}

// --------------------------------------------------------------------------- //
// Wire + init
// --------------------------------------------------------------------------- //
function wire() {
  $("#viewSimple").addEventListener("click", () => setView("simple"));
  $("#viewAdvanced").addEventListener("click", () => setView("advanced"));
  $("#addPatient").addEventListener("click", addPatient);
  $("#addTrial").addEventListener("click", addTrial);
  $("#addField").addEventListener("click", addField);
  $("#objFit").addEventListener("click", () => setObjective("fit"));
  $("#objPref").addEventListener("click", () => setObjective("preference"));
  $("#scenarioSelect").addEventListener("change", updateBlurb);
  $("#seedBtn").addEventListener("click", () => loadState(ENGINE.store.seed($("#scenarioSelect").value)));
  $("#resetBtn").addEventListener("click", () => loadState(ENGINE.store.reset()));
  $("#threshold").addEventListener("input", (e) => { state.params.min_score_threshold = parseFloat(e.target.value); $("#thrVal").textContent = parseFloat(e.target.value).toFixed(2); scheduleSave(); });
  $("#thresholdAware").addEventListener("change", (e) => { state.params.threshold_aware = e.target.checked; scheduleSave(); });
  $("#drawerClose").addEventListener("click", closeDrawer);
  $("#drawerBackdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
}
function init() {
  wire();
  setView("simple");
  state.scenarios = ENGINE.scenarios;
  state.default = ENGINE.DEFAULT_SCENARIO;
  populateScenarios();
  loadState(ENGINE.store.load());
}
init();
