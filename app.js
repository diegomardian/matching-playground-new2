"use strict";

// --------------------------------------------------------------------------- //
// Access gate (hosted deployment only): a LIGHTWEIGHT DETERRENT, not real security.
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
// Constants
// --------------------------------------------------------------------------- //
const OPS_FOR_KIND = ENGINE.OPS_FOR_KIND;
const OP_SYMBOL = ENGINE.OP_SYMBOL;
const REASON_CLASS = {
  INELIGIBLE_NO_TRIAL: "rc-ineligible", NO_SLOT_AVAILABLE: "rc-noslot", NO_PREFERENCE: "rc-below",
  NO_ELIGIBLE_PATIENT: "rc-noelig", NO_PATIENT_AVAILABLE: "rc-nopatient",
};

const state = {
  fields: [], patients: [], trials: [], params: { max_match: false },
  scenarios: [], view: "simple", lastResult: null, openPatientId: null,
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
function nextId(prefix, existing) { let k = existing.length + 1; const set = new Set(existing); while (set.has(prefix + k)) k++; return prefix + k; }

// --------------------------------------------------------------------------- //
// Engine wiring (client-side; ENGINE from match-engine.js)
// --------------------------------------------------------------------------- //
function payload() { return { fields: state.fields, patients: state.patients, trials: state.trials, params: state.params }; }

function loadState(raw) {
  state.fields = raw.fields;
  state.patients = raw.patients;
  state.trials = raw.trials;
  state.params = raw.params || state.params;
  renderInputs();
  runAndRender();
}
function runAndRender() {
  const st = payload();
  if (!st.patients.length || !st.trials.length) { renderError("Add at least one patient and one trial."); return; }
  ENGINE.store.save(st);
  try { const { result } = ENGINE.match(st); state.lastResult = result; renderResults(result); }
  catch (e) { renderError("Could not compute: " + e.message); }
}
let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(runAndRender, 200); }

// --------------------------------------------------------------------------- //
// Toolbar / scenarios
// --------------------------------------------------------------------------- //
function populateScenarios() {
  const sel = $("#scenarioSelect"); sel.innerHTML = "";
  state.scenarios.forEach((s) => sel.appendChild(el("option", { value: s.name }, s.name)));
  updateBlurb();
}
function updateBlurb() {
  const s = state.scenarios.find((x) => x.name === $("#scenarioSelect").value);
  $("#scenarioBlurb").textContent = s ? s.blurb : "";
}

// --------------------------------------------------------------------------- //
// Render inputs
// --------------------------------------------------------------------------- //
function renderInputs() {
  renderPatients();
  renderTrials();
  renderPreferences();
  renderFields();
  $("#patientCount").textContent = `· ${state.patients.length}`;
  $("#trialCount").textContent = `· ${state.trials.length}`;
  $("#fieldCount").textContent = `· ${state.fields.length}`;
}

function attrInput(field, value, onChange) {
  if (field.kind === "numeric") {
    return el("div", { style: "display:flex;align-items:center;gap:6px" }, [
      el("input", { type: "number", step: "0.1", value: value, oninput: (e) => onChange(parseFloat(e.target.value) || 0) }),
      field.unit ? el("span", { class: "unit" }, field.unit) : null,
    ]);
  }
  if (field.kind === "set") {
    const arr = Array.isArray(value) ? value : (value ? [value] : []);
    return el("input", { type: "text", value: arr.join(", "), placeholder: "comma, separated",
      oninput: (e) => onChange(e.target.value.split(",").map((x) => x.trim()).filter(Boolean)) });
  }
  return el("input", { type: "text", value: value || "", oninput: (e) => onChange(e.target.value) });
}

function renderPatients() {
  const grid = $("#patientGrid"); grid.innerHTML = "";
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

// ---- trials + OR (CNF) criteria editor ---- //
function condText(c) {
  const f = fieldsByName()[c.field]; const lbl = f ? f.label : c.field;
  const unit = f && f.kind === "numeric" && f.unit ? " " + f.unit : "";
  if (c.op === "between") return `${lbl} ${c.value} to ${c.value2}${unit}`;
  return `${lbl} ${OP_SYMBOL[c.op] || c.op} ${c.value}${unit}`;
}
function newCond() { const f = state.fields[0]; return { field: f.name, op: OPS_FOR_KIND[f.kind][0], value: f.kind === "numeric" ? 0 : "", value2: null }; }

function condEditor(t, group, c, ci, gi) {
  const fmap = fieldsByName();
  const kind = (fmap[c.field] || {}).kind || "categorical";
  const fieldSel = el("select", { onchange: (e) => { c.field = e.target.value; const nf = fmap[c.field]; c.op = OPS_FOR_KIND[nf.kind][0]; c.value = nf.kind === "numeric" ? 0 : ""; c.value2 = null; renderTrials(); scheduleSave(); } },
    state.fields.map((f) => el("option", { value: f.name, selected: f.name === c.field ? "" : null }, f.label)));
  const opSel = el("select", { onchange: (e) => { c.op = e.target.value; renderTrials(); scheduleSave(); } },
    (OPS_FOR_KIND[kind] || ["=="]).map((o) => el("option", { value: o, selected: o === c.op ? "" : null }, OP_SYMBOL[o] || o)));
  let valIn;
  if (kind === "numeric" && c.op === "between") {
    valIn = el("div", { class: "crit-between" }, [
      el("input", { type: "number", step: "0.1", value: c.value, oninput: (e) => { c.value = parseFloat(e.target.value) || 0; scheduleSave(); } }),
      el("span", { class: "between-dash" }, "to"),
      el("input", { type: "number", step: "0.1", value: (c.value2 == null ? "" : c.value2), oninput: (e) => { c.value2 = parseFloat(e.target.value) || 0; scheduleSave(); } }),
    ]);
  } else if (kind === "numeric") {
    valIn = el("input", { type: "number", step: "0.1", value: c.value, oninput: (e) => { c.value = parseFloat(e.target.value) || 0; scheduleSave(); } });
  } else {
    valIn = el("input", { type: "text", value: c.value, oninput: (e) => { c.value = e.target.value; scheduleSave(); } });
  }
  return el("div", { class: "crit-cond" }, [fieldSel, opSel, valIn,
    el("button", { class: "del-crit", title: "remove option", onclick: () => { group.conds.splice(ci, 1); if (!group.conds.length) t.criteria.splice(gi, 1); renderTrials(); scheduleSave(); } }, "✕")]);
}

function renderTrialCriteria(t, body) {
  const advanced = state.view === "advanced";
  body.appendChild(el("div", { class: "crit-title" }, "Eligibility: ALL rows must hold; within a row, ANY option (OR)"));
  if (advanced) {
    (t.criteria || []).forEach((group, gi) => {
      const gEl = el("div", { class: "crit-grp" });
      (group.conds || []).forEach((c, ci) => { if (ci > 0) gEl.appendChild(el("div", { class: "or-tag" }, "OR")); gEl.appendChild(condEditor(t, group, c, ci, gi)); });
      gEl.appendChild(el("div", { class: "crit-add" }, [el("button", { onclick: () => { group.conds.push(newCond()); renderTrials(); scheduleSave(); } }, "＋ OR option")]));
      body.appendChild(gEl);
    });
    body.appendChild(el("button", { class: "btn-add-crit", onclick: () => { t.criteria.push({ conds: [newCond()] }); renderTrials(); scheduleSave(); } }, "＋ AND criterion"));
  } else {
    const chips = el("div", { class: "crit-chips" });
    if (!(t.criteria || []).length) chips.appendChild(el("div", { class: "crit-none" }, "none: every patient passes"));
    (t.criteria || []).forEach((group) => chips.appendChild(el("div", { class: "crit-chip" }, group.conds.map(condText).join("  OR  "))));
    body.appendChild(chips);
  }
}

function renderTrials() {
  const grid = $("#trialGrid"); grid.innerHTML = "";
  state.trials.forEach((t, i) => {
    const body = el("div", { class: "entity-body" });
    body.appendChild(el("div", { class: "slot-row" }, [
      el("label", {}, "Open slots"),
      el("input", { type: "number", min: "1", step: "1", value: t.slots, oninput: (e) => { t.slots = Math.max(1, parseInt(e.target.value) || 1); scheduleSave(); } }),
    ]));
    renderTrialCriteria(t, body);
    grid.appendChild(el("div", { class: "entity trial" }, [
      el("div", { class: "entity-head" }, [
        el("span", { class: "ehemoji" }, "🔬"),
        el("input", { class: "name-input", value: t.name, oninput: (e) => { t.name = e.target.value; scheduleSave(); } }),
        el("span", { class: "id-chip" }, t.id),
        el("button", { class: "del-entity", title: "remove", onclick: () => { state.trials.splice(i, 1); state.patients.forEach((p) => { if (p.preferences) delete p.preferences[t.id]; }); renderInputs(); scheduleSave(); } }, "✕"),
      ]),
      body,
    ]));
  });
}

function renderPreferences() {
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
        oninput: (e) => { const n = parseFloat(e.target.value); if (e.target.value === "" || isNaN(n)) delete p.preferences[t.id]; else p.preferences[t.id] = n; scheduleSave(); },
      })]));
    });
    tbl.appendChild(tr);
  });
  wrap.appendChild(tbl);
}

// ---- fields manager (advanced) ---- //
function renderFields() {
  const card = $("#fieldsCard"); card.innerHTML = "";
  const tbl = el("table", { class: "fields-table" });
  tbl.appendChild(el("tr", {}, ["Field (label)", "kind", "unit", ""].map((h) => el("th", {}, h))));
  state.fields.forEach((f) => {
    const kindSel = el("select", { onchange: (e) => { f.kind = e.target.value; if (e.target.value !== "numeric") f.unit = ""; cleanupAfterFieldChange(); renderInputs(); scheduleSave(); } },
      ["categorical", "set", "numeric"].map((k) => el("option", { value: k, selected: k === f.kind ? "" : null }, k)));
    tbl.appendChild(el("tr", {}, [
      el("td", {}, [el("input", { value: f.label, oninput: (e) => { f.label = e.target.value; renderPatients(); renderTrials(); scheduleSave(); } })]),
      el("td", {}, [kindSel]),
      el("td", {}, [f.kind === "numeric" ? el("input", { value: f.unit || "", oninput: (e) => { f.unit = e.target.value; renderPatients(); scheduleSave(); } }) : el("span", { class: "locked" }, "-")]),
      el("td", {}, [el("button", { class: "del-row", title: "remove field", onclick: () => removeField(f.name) }, "✕")]),
    ]));
  });
  card.appendChild(tbl);
}
function cleanupAfterFieldChange() {
  const fmap = fieldsByName();
  state.trials.forEach((t) => (t.criteria || []).forEach((g) => (g.conds || []).forEach((c) => { const f = fmap[c.field]; if (f && !OPS_FOR_KIND[f.kind].includes(c.op)) c.op = OPS_FOR_KIND[f.kind][0]; })));
}
function removeField(name) {
  state.fields = state.fields.filter((f) => f.name !== name);
  state.patients.forEach((p) => { delete p.attrs[name]; });
  state.trials.forEach((t) => { t.criteria = (t.criteria || []).map((g) => ({ conds: g.conds.filter((c) => c.field !== name) })).filter((g) => g.conds.length); });
  renderInputs(); scheduleSave();
}

// --------------------------------------------------------------------------- //
// Add buttons / view
// --------------------------------------------------------------------------- //
function addPatient() {
  const id = nextId("P", state.patients.map((p) => p.id));
  const attrs = {}; state.fields.forEach((f) => { attrs[f.name] = f.kind === "numeric" ? 0 : f.kind === "set" ? [] : ""; });
  state.patients.push({ id, name: "New patient", attrs, preferences: {} });
  renderInputs(); scheduleSave();
}
function addTrial() {
  const id = nextId("T", state.trials.map((t) => t.id));
  const letter = String.fromCharCode(65 + state.trials.length);
  const f = state.fields[0];
  state.trials.push({ id, name: "Trial " + letter, slots: 1, criteria: [{ conds: [{ field: f.name, op: OPS_FOR_KIND[f.kind][0], value: f.kind === "numeric" ? 0 : "", value2: null }] }] });
  renderInputs(); scheduleSave();
}
function addField() {
  const name = nextId("field_", state.fields.map((f) => f.name));
  state.fields.push({ name, label: "New field", kind: "categorical", unit: "" });
  state.patients.forEach((p) => { p.attrs[name] = ""; });
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

// --------------------------------------------------------------------------- //
// Results
// --------------------------------------------------------------------------- //
function renderError(msg) { $("#results").innerHTML = ""; $("#results").appendChild(el("div", { class: "card error-card" }, "⚠ " + msg)); }

function renderResults(d) {
  const root = $("#results"); root.innerHTML = "";
  root.appendChild(metricsCard(d));
  const board = boardCard(d);
  root.appendChild(board);
  root.appendChild(unassignedCard(d));
  if (state.view === "advanced") root.appendChild(greedyCard(d));
  observeBoard(board);
  updateSticky(d);
  if (state.openPatientId) { if (d.patient_ids.includes(state.openPatientId)) fillDrawer(state.openPatientId); else closeDrawer(); }
}

function metric(label, num, sub, cls = "") { return el("div", { class: "metric " + cls }, [el("div", { class: "label" }, label), el("div", { class: "num" }, num), el("div", { class: "sub" }, sub)]); }
function metricsCard(d) {
  const filled = Object.values(d.trial_fill).reduce((a, v) => a + v.filled, 0);
  const total = d.slot_labels.length;
  return el("div", { class: "metrics" }, [
    metric("Patients matched", String(d.count), `${d.unmatched.length} unmatched`, "good"),
    metric("Slots filled", `${filled}/${total}`, `${d.patient_ids.length} patients`),
    metric("Total preference", d.total_pref.toFixed(0), "summed over matches", "accent"),
    metric("Maximal would enroll", String(d.max_count), d.max_count > d.val_count ? `vs ${d.val_count} on preference` : "same as preference", d.max_count > d.val_count ? "accent" : ""),
  ]);
}

// ---- max-match toggle + kanban board ---- //
function maxMatchControl(d) {
  const note = d.max_count > d.val_count
    ? `Maximal matching fills ${d.max_count} slots vs ${d.val_count} on preference alone; turning it ${state.params.max_match ? "off honors preferences" : "on enrolls more patients"}.`
    : "On this input both plans enroll the same number; the toggle has no effect here.";
  const sw = el("label", { class: "switch" }, [
    el("input", { type: "checkbox", id: "maxMatchToggle", checked: state.params.max_match ? "" : null, onchange: (e) => { state.params.max_match = e.target.checked; runAndRender(); } }),
    el("span", { class: "slider" }),
  ]);
  return el("div", { class: "maxmatch-row" }, [
    sw,
    el("div", {}, [el("div", { class: "switch-label" }, "Maximal matching"), el("p", { class: "hint", style: "margin-top:2px" }, note)]),
  ]);
}
function ptAssigned(a) {
  return el("div", { class: "pt-card assigned clickable", onclick: () => openPatient(a.patient_id) }, [
    el("div", { class: "pt-top" }, [el("span", { class: "pt-name" }, a.patient_name), el("span", { class: "pt-fit" }, "♥ " + a.pref)]),
    el("div", { class: "pt-slot" }, a.slot_label),
  ]);
}
function ptEmpty(s) {
  return el("div", { class: "pt-card empty" }, [
    el("div", { class: "empty-label" }, "○ empty slot: " + s.slot_label),
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
    const full = fill.total > 0 && fill.filled === fill.total;
    board.appendChild(el("div", { class: "trial-col" }, [
      el("div", { class: "trial-col-head" }, [el("div", { class: "tc-name" }, d.trial_names[i]), el("div", { class: "tc-slots" + (full ? " full" : "") }, `${fill.filled}/${fill.total} slots filled`)]),
      body,
    ]));
  });
  return el("section", { class: "card", id: "boardCard" }, [
    el("div", { class: "card-head" }, [el("h3", {}, "Assignments by trial")]),
    maxMatchControl(d),
    el("div", { class: "board-scroll" }, [board]),
  ]);
}

function unassignedCard(d) {
  const inner = [el("div", { class: "card-head" }, [el("h3", {}, `Unmatched patients (${d.unmatched.length})`)])];
  if (!d.unmatched.length) inner.push(el("div", { class: "empty-good" }, "✓ Every patient was matched."));
  else {
    const grid = el("div", { class: "unassigned-grid" });
    d.unmatched.forEach((u) => grid.appendChild(el("div", { class: "pt-card unassigned clickable", onclick: () => openPatient(u.patient_id) }, [
      el("div", { class: "pt-top" }, [el("span", { class: "pt-name" }, u.patient_name), el("span", { class: "rc " + (REASON_CLASS[u.reason] || "") }, u.reason)]),
      el("div", { class: "pt-detail" }, u.detail),
    ])));
    inner.push(grid);
  }
  return el("section", { class: "card" }, inner);
}

// ---- SphinxMatch Optimizer vs greedy (advanced) ---- //
function greedyCard(d) {
  const opt = d.total_pref, greedy = d.greedy_total, max = Math.max(opt, greedy, 1e-9);
  const bar = (label, val, cls) => el("div", { class: "gvo-row" }, [
    el("div", { class: "gvo-label" }, label),
    el("div", { class: "bar-track" }, [el("div", { class: "bar-fill " + cls, style: `width:${(val / max) * 100}%` })]),
    el("div", { class: "gvo-val" }, val.toFixed(0)),
  ]);
  let callout;
  if (d.count > d.greedy_count) callout = el("div", { class: "callout win" }, `SphinxMatch Optimizer enrolls ${d.count} vs greedy's ${d.greedy_count}. Greedy grabbed a locally-best pair that blocked a better global trade-off.`);
  else if (opt > greedy + 1e-9) callout = el("div", { class: "callout win" }, `SphinxMatch Optimizer reaches ${opt.toFixed(0)} total preference vs greedy's ${greedy.toFixed(0)} (same headcount). Greedy's myopic picks cost overall preference.`);
  else if (opt > 0 || greedy > 0) callout = el("div", { class: "callout tie" }, "Greedy ties the SphinxMatch Optimizer on this input. Try scenario 5 (with Maximal matching on) to see them diverge.");
  else callout = el("div", { class: "callout none" }, "No eligible, preferred pairs exist, so both totals are 0.");
  return el("section", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", {}, "SphinxMatch Optimizer vs. greedy")]),
    el("p", { class: "hint", style: "margin:0 0 10px" }, "Greedy takes the single highest-preference pair at each step, then locks out that patient and slot. The SphinxMatch Optimizer instead solves for the best assignment across everyone at once."),
    el("div", { class: "gvo" }, [bar("SphinxMatch", opt, "opt"), bar("Greedy", greedy, "greedy")]),
    callout,
  ]);
}

// ---- sticky bottom assignment bar ---- //
let boardObserver = null;
function observeBoard(boardEl) {
  if (boardObserver) boardObserver.disconnect();
  if (typeof IntersectionObserver === "undefined") return;
  boardObserver = new IntersectionObserver((entries) => {
    const e = entries[0];
    // show the pegged bar whenever the board is off-screen, whether it is above
    // (scrolled past) or below (not yet reached) the viewport
    $("#stickyAssign").classList.toggle("show", !e.isIntersecting);
  }, { threshold: 0 });
  boardObserver.observe(boardEl);
}
function updateSticky(d) {
  const bar = $("#stickyAssign"); bar.innerHTML = "";
  bar.appendChild(el("span", { class: "sa-label" }, "Assignments"));
  const byAssign = {};
  d.assignments.forEach((a) => (byAssign[a.trial_id] = byAssign[a.trial_id] || []).push(a));
  const board = el("div", { class: "sa-board" });
  d.trial_ids.forEach((tid, i) => {
    const fill = d.trial_fill[tid] || { filled: 0, total: 0 };
    const body = el("div", { class: "sa-col-b" });
    (byAssign[tid] || []).forEach((a) => body.appendChild(el("span", { class: "sa-pt", onclick: () => openPatient(a.patient_id) }, a.patient_name)));
    if (!(byAssign[tid] || []).length) body.appendChild(el("span", { class: "sa-pt open" }, "open"));
    const full = fill.total > 0 && fill.filled === fill.total;
    board.appendChild(el("div", { class: "sa-col" }, [
      el("div", { class: "sa-col-h" }, [el("span", { class: "sa-col-nm" }, d.trial_names[i]), el("span", { class: "sa-col-ct" + (full ? " full" : "") }, `${fill.filled}/${fill.total}`)]),
      body,
    ]));
  });
  bar.appendChild(board);
  if (d.unmatched.length) bar.appendChild(el("span", { class: "sa-unmatched" }, `${d.unmatched.length} unmatched`));
  bar.appendChild(el("span", { class: "sa-mode" + (state.params.max_match ? " on" : "") }, state.params.max_match ? "maximal ✓" : "preference"));
}

// --------------------------------------------------------------------------- //
// Patient detail drawer
// --------------------------------------------------------------------------- //
function openPatient(pid) {
  if (!state.lastResult) return;
  state.openPatientId = pid; fillDrawer(pid);
  $("#drawer").classList.add("open"); $("#drawer").setAttribute("aria-hidden", "false"); $("#drawerBackdrop").classList.add("open");
}
function closeDrawer() {
  state.openPatientId = null;
  $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true"); $("#drawerBackdrop").classList.remove("open");
}
function fmtSet(v) { return Array.isArray(v) && v.length ? v.join(", ") : "(none)"; }

function trialBlock(d, pi, ti, isAssigned) {
  const eligible = d.eligibility[pi][ti];
  const gate = d.gate_detail[pi][ti];
  const prefRaw = (d.patients_detail[pi].preferences || {})[d.trial_ids[ti]] || 0;
  const badges = el("div", { class: "tblock-badges" });
  if (isAssigned) badges.appendChild(el("span", { class: "pill here" }, "matched here"));
  badges.appendChild(el("span", { class: "pill " + (eligible ? "elig" : "inelig") }, eligible ? "eligible" : "ineligible"));
  if (eligible) badges.appendChild(el("span", { class: "pill fit" }, prefRaw > 0 ? "♥ preference " + prefRaw : "no preference"));

  const block = el("div", { class: "tblock" + (isAssigned ? " is-assigned" : "") }, [
    el("div", { class: "tblock-head" }, [el("div", { class: "tblock-name" }, d.trial_names[ti]), badges]),
  ]);
  if (!gate.groups.length) block.appendChild(el("div", { class: "tblock-none" }, "no criteria: every patient passes"));
  gate.groups.forEach((g) => {
    const passed = g.passed;
    const txt = g.conds.map((c) => `${c.label} ${c.op_symbol} ${c.value}`).join("  OR  ");
    const pv = g.conds.length ? (g.conds[0].kind === "set" ? fmtSet(g.conds[0].patient_value) : String(g.conds[0].patient_value)) : "";
    block.appendChild(el("div", { class: "crit-row " + (passed ? "pass" : "fail") }, [
      el("span", { class: "ci" }, passed ? "✓" : "✗"),
      el("span", { class: "cl" }, [el("b", {}, txt)]),
      el("span", { class: "cv" }, "patient: " + pv),
    ]));
  });
  if (!eligible) {
    const failed = gate.groups.filter((g) => !g.passed).length;
    block.appendChild(el("div", { class: "tblock-foot" }, `Ineligible: fails ${failed} criterion ${failed === 1 ? "group" : "groups"}.`));
  } else if (!isAssigned) {
    block.appendChild(el("div", { class: "tblock-foot" }, "Eligible, but the SphinxMatch Optimizer placed this patient elsewhere or the slot went to a stronger preference."));
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

  const attrs = el("div", { class: "dr-attrs" });
  d.fields.forEach((f) => {
    let v = pdet.attrs[f.name];
    if (f.kind === "set") v = fmtSet(v); else v = (v === "" || v == null) ? "(none)" : String(v);
    attrs.appendChild(el("div", { class: "dr-attr" }, [el("b", {}, f.label + ": "), document.createTextNode(v)]));
  });
  body.appendChild(attrs);

  const assign = d.assignments.find((a) => a.patient_id === pid);
  const unmatch = d.unmatched.find((u) => u.patient_id === pid);
  if (assign) {
    body.appendChild(el("div", { class: "dr-outcome assigned" }, [
      el("span", { class: "big" }, "✓ Matched to " + assign.slot_label),
      document.createTextNode("Preference " + assign.pref + ". The SphinxMatch Optimizer's best assignment for this patient."),
    ]));
  } else {
    const reason = unmatch ? unmatch.reason : "UNASSIGNED";
    body.appendChild(el("div", { class: "dr-outcome unassigned" }, [
      el("span", { class: "big" }, "✕ Not assigned"),
      el("span", { class: "rc " + (REASON_CLASS[reason] || "") }, reason),
      document.createTextNode(" " + (unmatch ? unmatch.detail : "")),
    ]));
  }

  // what the other plan would do for this patient
  const here = d.active_by_pid[pid], there = d.alt_by_pid[pid];
  if (here !== there) {
    body.appendChild(el("div", { class: "dr-altline" }, `Under "${d.alt_label}": ${there ? there : "unmatched"}.`));
  }

  const prefRaw = (ti) => (pdet.preferences || {})[d.trial_ids[ti]] || 0;
  const assignedTi = assign ? d.trial_ids.indexOf(assign.trial_id) : -1;
  const others = d.trial_ids.map((_, ti) => ti).filter((ti) => ti !== assignedTi)
    .sort((a, b) => (d.eligibility[pi][b] - d.eligibility[pi][a]) || (prefRaw(b) - prefRaw(a)));
  if (assignedTi >= 0) {
    body.appendChild(el("div", { class: "dr-section-title" }, "Assigned trial: criterion by criterion"));
    body.appendChild(trialBlock(d, pi, assignedTi, true));
    body.appendChild(el("div", { class: "dr-section-title" }, "Trials it didn't go to"));
  } else {
    body.appendChild(el("div", { class: "dr-section-title" }, "Every trial (most-preferred first)"));
  }
  others.forEach((ti) => body.appendChild(trialBlock(d, pi, ti, false)));
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
  $("#scenarioSelect").addEventListener("change", updateBlurb);
  $("#seedBtn").addEventListener("click", () => loadState(ENGINE.store.seed($("#scenarioSelect").value)));
  $("#resetBtn").addEventListener("click", () => loadState(ENGINE.store.reset()));
  $("#drawerClose").addEventListener("click", closeDrawer);
  $("#drawerBackdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
}
function init() {
  wire();
  setView("simple");
  state.scenarios = ENGINE.scenarios;
  populateScenarios();
  loadState(ENGINE.store.load());
}
init();
