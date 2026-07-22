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

// --------------------------------------------------------------------------- //
// Engine version tabs. v2 (window.ENGINE, match-engine.js) is frozen; the other
// engines come from engines-v345.js (window.ENGINES). The "choice" tab reuses v2
// but replaces the numeric preference matrix with SphinxMatch-style ranked top-3
// picks, and "v2matrix" is v2's algorithm with the padded matrix visualized —
// neither changes the algorithm. v3 (slot urgency) and v4 (patient urgency) do.
// --------------------------------------------------------------------------- //
const URGENCY_LABEL = { none: "None", low: "Low", medium: "Medium", high: "High", critical: "Critical" };
const CHOICE_SCORES = [3, 2, 1]; // 1st/2nd/3rd pick -> preference; unpicked stays 0 (won't take)
const TABS = [
  { id: "v2", label: "v2 · Optimizer", engine: () => window.ENGINE, choice: false,
    desc: "The current engine: CNF eligibility gate → preference-only Hungarian assignment, with the value / maximal-matching toggle and the greedy comparison." },
  { id: "choice", label: "v2 · Patient choice", engine: () => window.ENGINES.v2choice, choice: true,
    desc: "Same v2 algorithm, driven by the SphinxMatch selection flow: act as a patient, review recommended vs not-a-fit trials (with blocks/slots/queue info), and add up to 3 trials in order of preference. Adding a trial joins its queue for prescreening at that moment; scores derive from rank (1st ♥3, 2nd ♥2, 3rd ♥1, unpicked 0 = won't take) and exact ties break by each trial's own queue. Advanced view has a quick-edit rank table." },
  { id: "v2matrix", label: "v2 · Uneven matrix", engine: () => window.ENGINES.v2matrix, choice: false },
  { id: "v3", label: "v3 · Slot urgency", engine: () => window.ENGINES.v3, choice: true },
  { id: "v4", label: "v4 · Patient urgency", engine: () => window.ENGINES.v4, choice: true },
];

// ---- patient-choice tab scenarios ---- //
const CHOICE_FIELDS = () => [
  { name: "cancer_type", label: "Cancer type", kind: "categorical", unit: "" },
  { name: "genomics", label: "Genomics", kind: "set", unit: "" },
];
const cpat = (id, name, choices, genomics) => ({ id, name, attrs: { cancer_type: "NSCLC", genomics: genomics || [] }, preferences: {}, choices });
const ctrial = (id, name) => ({ id, name, slots: 1, criteria: [{ conds: [{ field: "cancer_type", op: "==", value: "NSCLC", value2: null }] }] });
const chState = (patients) => ({ fields: CHOICE_FIELDS(), patients, trials: [ctrial("T1", "Trial A"), ctrial("T2", "Trial B"), ctrial("T3", "Trial C")], params: { max_match: false } });
const CHOICE_SCENARIOS = [
  { name: "1 · Distinct top picks", blurb: "Each patient ranks a different trial first, so everyone gets their #1. The derived scores (♥3/♥2/♥1) show on the assignment pills.",
    factory: () => chState([
      cpat("P1", "Eleanor Hughes", ["T1", "T2", "T3"]),
      cpat("P2", "Marcus Bell", ["T2", "T3", "T1"]),
      cpat("P3", "Priya Nair", ["T3", "T1", "T2"])]) },
  { name: "2 · Contested first choice", blurb: "All three rank Trial A first. Only one can have it; the optimizer seats the others at their 2nd choices instead of stranding anyone. Open Advanced to compare with greedy.",
    factory: () => chState([
      cpat("P1", "Eleanor Hughes", ["T1", "T2", "T3"]),
      cpat("P2", "Marcus Bell", ["T1", "T3", "T2"]),
      cpat("P3", "Priya Nair", ["T1", "T2", "T3"])]) },
  { name: "3 · Only one pick made", blurb: "Priya picked ONLY Trial C — every other trial scores 0 for her, so it's C or unmatched. Eleanor also ranks C first but has backups; the engine honors Priya's single pick and routes Eleanor to her 2nd choice.",
    factory: () => chState([
      cpat("P1", "Eleanor Hughes", ["T3", "T1", "T2"]),
      cpat("P2", "Marcus Bell", ["T2", null, null]),
      cpat("P3", "Priya Nair", ["T3", null, null])]) },
  { name: "4 · Identical rankings (queue decides)", blurb: "Everyone ranks A > B > C, so every seating totals the same score. Each trial's own queue breaks the tie: whoever joined Trial A's queue first gets A, and so on down the line. Use the ↑/↓ arrows in the queue card under the results to reorder any single trial's queue and watch its seat follow.",
    factory: () => chState([
      cpat("P1", "Eleanor Hughes", ["T1", "T2", "T3"]),
      cpat("P2", "Marcus Bell", ["T1", "T2", "T3"]),
      cpat("P3", "Priya Nair", ["T1", "T2", "T3"])]) },
  { name: "5 · Mutation-specific trial (KRAS G12C)", blurb: "Trial C requires KRAS G12C and only Marcus carries it. All three rank A > B > C, but the optimizer routes Marcus to C — the only patient who can fill it — even though it's his 3rd choice. Eleanor and Priya have identical picks, an exact tie, so Trial A's queue decides between them (Eleanor joined first; reorder the queue to flip it). For Eleanor and Priya, Trial C shows under NOT A FIT, and C's nurse would ✕ fail them at prescreening.",
    factory: () => ({
      fields: CHOICE_FIELDS(),
      patients: [
        cpat("P1", "Eleanor Hughes", ["T1", "T2", "T3"]),
        cpat("P2", "Marcus Bell", ["T1", "T2", "T3"], ["KRAS G12C"]),
        cpat("P3", "Priya Nair", ["T1", "T2", "T3"])],
      trials: [ctrial("T1", "Trial A"), ctrial("T2", "Trial B"),
        { id: "T3", name: "Trial C", slots: 1, criteria: [
          { conds: [{ field: "cancer_type", op: "==", value: "NSCLC", value2: null }] },
          { conds: [{ field: "genomics", op: "includes", value: "KRAS G12C", value2: null }] },
        ] }],
      params: { max_match: false },
    }) },
];

const state = {
  fields: [], patients: [], trials: [], params: { max_match: false }, urgency_rules: [],
  scenarios: [], view: "simple", lastResult: null, openPatientId: null,
  tab: "v2", actAsId: null, // which patient the selection flow is "acting as"
};

function currentTab() { return TABS.find((t) => t.id === state.tab) || TABS[0]; }
function currentEngine() { return currentTab().engine(); }
function engineFeatures() { return currentEngine().features || {}; }

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
// Engine wiring + per-tab persistence
// --------------------------------------------------------------------------- //
function payload() { return { fields: state.fields, patients: state.patients, trials: state.trials, params: state.params, urgency_rules: state.urgency_rules }; }

const storeKey = (tabId) => "mp_tab_state_v1_" + tabId;

// one-time migration: tabs were renumbered (uneven-matrix folded into v2 as "v2matrix",
// slot urgency v4→v3, patient urgency v5→v4) — carry saved states to their new keys
(function migrateTabKeys() {
  try {
    if (localStorage.getItem("mp_tabs_renumbered_v2")) return;
    const moves = [["v3", "v2matrix"], ["v4", "v3"], ["v5", "v4"]];
    const vals = moves.map(([from]) => localStorage.getItem(storeKey(from)));
    moves.forEach(([, to], i) => { if (vals[i] != null) localStorage.setItem(storeKey(to), vals[i]); else localStorage.removeItem(storeKey(to)); });
    localStorage.removeItem(storeKey("v5"));
    const at = localStorage.getItem("mp_active_tab_v1");
    const remap = { v3: "v2matrix", v4: "v3", v5: "v4" };
    if (remap[at]) localStorage.setItem("mp_active_tab_v1", remap[at]);
    localStorage.setItem("mp_tabs_renumbered_v2", "1");
  } catch (e) { /* storage blocked — nothing to migrate */ }
})();
function defaultTabState(tab) {
  if (tab.id === "choice") return CHOICE_SCENARIOS[0].factory();
  const eng = tab.engine(); return eng.scenarioState(eng.DEFAULT_SCENARIO);
}
function loadTabRaw(tab) {
  try {
    const s = localStorage.getItem(storeKey(tab.id));
    if (s) return JSON.parse(s);
    if (tab.id === "v2") { const legacy = localStorage.getItem("matching_playground_state_v3"); if (legacy) return JSON.parse(legacy); }
  } catch (e) { /* fall through to seed */ }
  return defaultTabState(tab);
}
function persist() { try { localStorage.setItem(storeKey(state.tab), JSON.stringify(payload())); } catch (e) { /* storage blocked/full */ } }

// ---- top-3 choices -> preference scores (choice tab) ---- //
function ensureChoices(p) {
  if (!Array.isArray(p.choices)) {
    const ranked = Object.entries(p.preferences || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    p.choices = ranked;
  }
  p.choices = [0, 1, 2].map((i) => p.choices[i] || null);
}
function applyChoices() {
  state.patients.forEach((p) => {
    ensureChoices(p);
    syncJoined(p);
    p.preferences = {};
    p.choices.forEach((tid, i) => { if (tid && state.trials.some((t) => t.id === tid)) p.preferences[tid] = CHOICE_SCORES[i]; });
  });
}

// ---- per-trial queues: a patient joins a trial's queue when they pick it ---- //
function nextJoinSeq() {
  let mx = 0;
  state.patients.forEach((p) => { Object.values(p.joined || {}).forEach((v) => { if (isFinite(v) && v > mx) mx = v; }); });
  return mx + 1;
}
function syncJoined(p) {
  if (!p.joined) p.joined = {};
  const chosen = new Set((p.choices || []).filter(Boolean));
  Object.keys(p.joined).forEach((tid) => { if (!chosen.has(tid)) delete p.joined[tid]; }); // un-picking leaves the queue
  (p.choices || []).forEach((tid) => { if (tid && !(tid in p.joined)) p.joined[tid] = nextJoinSeq(); }); // new pick joins at the back
}
function trialQueue(t) {
  return state.patients
    .map((p) => ({ p, rank: (p.choices || []).indexOf(t.id), seq: (p.joined || {})[t.id] }))
    .filter((x) => x.rank >= 0)
    .sort((a, b) => (a.seq == null ? Infinity : a.seq) - (b.seq == null ? Infinity : b.seq));
}

function loadState(raw) {
  state.fields = raw.fields;
  state.patients = raw.patients;
  state.trials = raw.trials;
  state.params = raw.params || { max_match: false };
  state.urgency_rules = Array.isArray(raw.urgency_rules) ? raw.urgency_rules : [];
  state.actAsId = null; // selection flow re-anchors to the first patient of the new state
  if (currentTab().choice) state.patients.forEach(ensureChoices);
  renderInputs();
  renderEngineParams();
  runAndRender();
}
function runAndRender() {
  if (currentTab().choice) applyChoices();
  renderPreviews();
  const st = payload();
  if (!st.patients.length || !st.trials.length) { renderError("Add at least one patient and one trial."); return; }
  persist();
  try {
    const { result } = currentEngine().match(st); state.lastResult = result; renderResults(result); renderPreviews();
    // the selection flow shows result-derived info (eligibility, fill, blocks) — keep it in sync.
    // safe to re-render: it's buttons/chips only, no text inputs to lose focus on.
    if (currentTab().choice && state.view === "simple") renderPreferences();
  }
  catch (e) { renderError("Could not compute: " + e.message); }
}
let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(runAndRender, 200); }

// --------------------------------------------------------------------------- //
// Engine tabs / toolbar / scenarios
// --------------------------------------------------------------------------- //
function renderTabs() {
  const nav = $("#engineTabs"); nav.innerHTML = "";
  TABS.forEach((t) => nav.appendChild(el("button", {
    class: "etab" + (t.id === state.tab ? " active" : ""), role: "tab",
    "aria-selected": t.id === state.tab ? "true" : "false",
    onclick: () => setTab(t.id),
  }, t.label)));
}
function applyTabChrome() {
  const tab = currentTab(), eng = currentEngine();
  $("#tabDesc").textContent = tab.desc || eng.tagline || "";
  const h = $("#prefHeading"); h.innerHTML = "";
  if (tab.choice && state.view === "simple") { h.append("🧭 Patient selection "); h.appendChild(el("span", { class: "count" }, ": act as a patient · add up to 3 trials in order (1st ♥3 / 2nd ♥2 / 3rd ♥1) · adding joins that trial's queue")); }
  else if (tab.choice) { h.append("🎯 Top-3 choices "); h.appendChild(el("span", { class: "count" }, ": quick-edit rank table · auto-scores ♥3 / ♥2 / ♥1; unpicked = 0 (won't take)")); }
  else { h.append("⭐ Preferences "); h.appendChild(el("span", { class: "count" }, ": higher = wants it more; 0 = won't take it")); }
}
function setTab(id) {
  if (state.tab === id) return;
  persist(); // save the tab we're leaving
  state.tab = id;
  try { localStorage.setItem("mp_active_tab_v1", id); } catch (e) { /* ignore */ }
  closeDrawer();
  renderTabs(); applyTabChrome(); populateScenarios();
  loadState(loadTabRaw(currentTab()));
}
function tabScenarios() { const tab = currentTab(); return tab.id === "choice" ? CHOICE_SCENARIOS : tab.engine().scenarios; }
function seedScenario(name) {
  const tab = currentTab();
  if (tab.id === "choice") { const s = CHOICE_SCENARIOS.find((x) => x.name === name) || CHOICE_SCENARIOS[0]; loadState(s.factory()); }
  else loadState(tab.engine().scenarioState(name));
}
function populateScenarios() {
  state.scenarios = tabScenarios();
  const sel = $("#scenarioSelect"); sel.innerHTML = "";
  state.scenarios.forEach((s) => sel.appendChild(el("option", { value: s.name }, s.name)));
  updateBlurb();
}
function updateBlurb() {
  const b = $("#scenarioBlurb"); if (!b) return;
  const s = state.scenarios.find((x) => x.name === $("#scenarioSelect").value);
  b.textContent = s ? s.blurb : "";
}

// ---- per-version engine parameters (urgency weights) ---- //
function renderEngineParams() {
  const box = $("#engineParams"); if (!box) return;
  box.innerHTML = "";
  const f = engineFeatures();
  if (!f.slotUrgency && !f.patientUrgency) return;
  const slider = (label, key, hint, dflt) => {
    const val = state.params[key] == null ? dflt : state.params[key];
    const out = el("span", { class: "prm-val" }, Number(val).toFixed(2));
    return el("label", { class: "prm", title: hint }, [
      el("span", { class: "prm-lbl" }, label),
      el("input", { type: "range", min: "0", max: "1", step: "0.05", value: val,
        oninput: (e) => { state.params[key] = parseFloat(e.target.value); out.textContent = state.params[key].toFixed(2); scheduleSave(); } }),
      out,
    ]);
  };
  if (f.slotUrgency) {
    box.appendChild(slider("⏳ Slot urgency", "w_slot", "How much an expiring slot can outweigh preference (0 = ignore expirations)", 0.5));
    const hv = state.params.horizon == null ? 30 : state.params.horizon;
    box.appendChild(el("label", { class: "prm", title: "Slots expiring beyond this many days count as urgency 0" }, [
      el("span", { class: "prm-lbl" }, "Horizon"),
      el("input", { type: "number", min: "1", step: "1", class: "prm-num", value: hv,
        oninput: (e) => { state.params.horizon = Math.max(1, parseInt(e.target.value) || 30); scheduleSave(); } }),
      el("span", { class: "prm-val" }, "days"),
    ]));
  }
  if (f.patientUrgency) box.appendChild(slider("🚨 Patient urgency", "w_patient", "How strongly a patient's urgency amplifies their whole row (0 = ignore urgency)", 0.5));
}

// --------------------------------------------------------------------------- //
// Render inputs
// --------------------------------------------------------------------------- //
function renderInputs() {
  renderPatients();
  renderTrials();
  renderPreferences();
  renderFields();
  renderRules();
  renderPreviews();
  $("#patientCount").textContent = `· ${state.patients.length}`;
  $("#trialCount").textContent = `· ${state.trials.length}`;
  $("#fieldCount").textContent = `· ${state.fields.length}`;
}

// compact read-only summaries shown on the collapsed Patients / Trials sections
function renderPreviews() {
  const pv = $("#patientPreview");
  if (pv) {
    pv.innerHTML = "";
    state.patients.forEach((p) => {
      const bits = state.fields.map((f) => { let v = p.attrs[f.name]; if (f.kind === "set") v = (Array.isArray(v) && v.length) ? v.join(", ") : ""; return v ? String(v) : ""; }).filter(Boolean);
      if (engineFeatures().patientUrgency) {
        // effective urgency (incl. diagnosis rules) from the last solve, else manual
        const d = state.lastResult;
        const i = d && d.patient_ids ? d.patient_ids.indexOf(p.id) : -1;
        const u = (i >= 0 && d.patients_detail[i].urgency) || p.urgency || "none";
        if (u !== "none") bits.push("🚨 " + u);
      }
      pv.appendChild(el("span", { class: "cs-chip" }, [el("b", {}, p.name), bits.length ? el("span", { class: "cs-chip-sub" }, " " + bits.join(" · ")) : null]));
    });
  }
  const tv = $("#trialPreview");
  if (tv) {
    tv.innerHTML = "";
    state.trials.forEach((t) => {
      const crit = (t.criteria || []).map((g) => (g.conds || []).map(condText).join(" OR ")).join(" AND ");
      const slots = (t.slots > 1) ? `${t.slots} slots` : "1 slot";
      const exp = (engineFeatures().slotUrgency && t.expires_days != null) ? ` · ⏳ ${t.expires_days}d` : "";
      tv.appendChild(el("span", { class: "cs-chip" }, [el("b", {}, t.name), el("span", { class: "cs-chip-sub" }, " " + (crit ? crit + " · " : "open · ") + slots + exp)]));
    });
  }
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
    if (engineFeatures().patientUrgency) {
      body.appendChild(el("div", { class: "attr-row" }, [
        el("label", { title: "Manual urgency. Diagnosis rules can raise the effective urgency above this; the higher of the two wins." }, "Urgency (manual)"),
        el("select", { class: "urgency-sel", onchange: (e) => { p.urgency = e.target.value; renderPreviews(); scheduleSave(); } },
          Object.keys(URGENCY_LABEL).map((lv) => el("option", { value: lv, selected: (p.urgency || "none") === lv ? "" : null }, URGENCY_LABEL[lv]))),
      ]));
    }
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
    if (engineFeatures().slotUrgency) {
      body.appendChild(el("div", { class: "slot-row" }, [
        el("label", {}, "Expires in (days)"),
        el("input", { type: "number", min: "0", step: "1", placeholder: "no expiry", value: (t.expires_days == null ? "" : t.expires_days),
          oninput: (e) => { const v = e.target.value; t.expires_days = (v === "" ? null : Math.max(0, parseInt(v) || 0)); renderPreviews(); scheduleSave(); } }),
      ]));
    }
    renderTrialCriteria(t, body);
    grid.appendChild(el("div", { class: "entity trial" }, [
      el("div", { class: "entity-head" }, [
        el("span", { class: "ehemoji" }, "🔬"),
        el("input", { class: "name-input", value: t.name, oninput: (e) => { t.name = e.target.value; scheduleSave(); } }),
        el("span", { class: "id-chip" }, t.id),
        el("button", { class: "del-entity", title: "remove", onclick: () => { state.trials.splice(i, 1); state.patients.forEach((p) => { if (p.preferences) delete p.preferences[t.id]; if (Array.isArray(p.choices)) p.choices = p.choices.map((c) => (c === t.id ? null : c)); if (p.joined) delete p.joined[t.id]; }); renderInputs(); scheduleSave(); } }, "✕"),
      ]),
      body,
    ]));
  });
}

function renderPreferences() {
  if (currentTab().choice) {
    if (state.view === "simple") renderSelectionFlow(); else renderChoicePicker();
    return;
  }
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

// ---- ranked top-3 picker (patient-choice tab) ---- //
function renderChoicePicker() {
  const wrap = $("#prefMatrix"); wrap.innerHTML = "";
  const tbl = el("table", { class: "mtx pref-table choice-table" });
  tbl.appendChild(el("tr", {}, [el("th", {}, "patient"), el("th", {}, "1st choice · ♥3"), el("th", {}, "2nd choice · ♥2"), el("th", {}, "3rd choice · ♥1")]));
  state.patients.forEach((p) => {
    ensureChoices(p);
    const tr = el("tr", {}, [el("td", { class: "rowhead" }, p.name)]);
    [0, 1, 2].forEach((rank) => {
      const sel = el("select", { class: "choice-sel", onchange: (e) => {
        const tid = e.target.value || null;
        if (tid) p.choices.forEach((c, i) => { if (i !== rank && c === tid) p.choices[i] = null; }); // one rank per trial
        p.choices[rank] = tid;
        syncJoined(p); // joins/leaves the affected trial queues
        renderPreferences(); scheduleSave();
      } }, [el("option", { value: "" }, "—")].concat(
        state.trials.map((t) => el("option", { value: t.id, selected: p.choices[rank] === t.id ? "" : null }, t.name))));
      tr.appendChild(el("td", {}, [sel]));
    });
    tbl.appendChild(tr);
  });
  wrap.appendChild(tbl);
  wrap.appendChild(el("p", { class: "hint" }, "Scores derive from rank automatically: 1st ♥3, 2nd ♥2, 3rd ♥1. Trials a patient doesn't pick score 0 — the engine never places them there. Picking a trial already used in another rank clears its previous slot."));
}

// ---- patient selection flow (choice tabs, simple view) ---- //
// Mirrors the SphinxMatch app: act as one patient, review recommended vs not-a-fit
// trials, and build an ORDERED selection (max 3). Adding a trial appends it as the
// next choice and joins that trial's queue for prescreening at that moment.
const ORDINAL = ["1st", "2nd", "3rd"];

function addToSelection(p, tid) {
  const sel = (p.choices || []).filter(Boolean);
  if (sel.length >= 3 || sel.includes(tid)) return;
  sel.push(tid); // next open choice, in order of adding
  p.choices = sel;
  ensureChoices(p); syncJoined(p); // joins the trial's queue now
  runAndRender();
}
function removeFromSelection(p, tid) {
  p.choices = (p.choices || []).filter(Boolean).filter((x) => x !== tid); // lower choices promote
  ensureChoices(p); syncJoined(p); // leaves that trial's queue
  runAndRender();
}
function moveSelection(p, i, dir) {
  const sel = (p.choices || []).filter(Boolean);
  const j = i + dir; if (j < 0 || j >= sel.length) return;
  const t = sel[j]; sel[j] = sel[i]; sel[i] = t;
  p.choices = sel; ensureChoices(p);
  runAndRender(); // rank changed; queue join times intentionally untouched
}

// If this patient took a seat in trial t, how many OTHER waiting patients would
// become unmatchable? A waiting patient can go to the trials they selected, or to
// any trial they're eligible for if they haven't selected yet. Computed as the drop
// in maximum bipartite matching when one seat of t is removed (Kuhn's algorithm).
function blocksCount(p, t, d) {
  const others = state.patients.filter((x) => x.id !== p.id && !x.enrolled); // enrolled patients are settled, not waiting
  if (!others.length) return 0;
  const caps = {}; state.trials.forEach((tr) => { caps[tr.id] = Math.max(0, Math.max(1, tr.slots || 1) - enrolledCount(tr.id)); });
  const adj = others.map((pt) => {
    const sel = (pt.choices || []).filter(Boolean);
    const piX = d.patient_ids.indexOf(pt.id);
    return state.trials.filter((tr) => {
      const tiX = d.trial_ids.indexOf(tr.id);
      const elig = piX >= 0 && tiX >= 0 && d.eligibility[piX][tiX];
      return elig && !(pt.screenfails && pt.screenfails[tr.id]) && (sel.length ? sel.includes(tr.id) : true);
    }).map((tr) => tr.id);
  });
  const matchSize = (capMap) => {
    const slotIds = []; state.trials.forEach((tr) => { for (let i = 0; i < (capMap[tr.id] || 0); i++) slotIds.push(tr.id); });
    const slotOf = Array(slotIds.length).fill(-1);
    const tryAug = (i, seen) => {
      for (let s = 0; s < slotIds.length; s++) {
        if (seen[s] || adj[i].indexOf(slotIds[s]) < 0) continue;
        seen[s] = true;
        if (slotOf[s] < 0 || tryAug(slotOf[s], seen)) { slotOf[s] = i; return true; }
      }
      return false;
    };
    let m = 0;
    for (let i = 0; i < others.length; i++) if (tryAug(i, Array(slotIds.length).fill(false))) m++;
    return m;
  };
  const reduced = Object.assign({}, caps); reduced[t.id] = Math.max(0, reduced[t.id] - 1);
  return Math.max(0, matchSize(caps) - matchSize(reduced));
}

function renderSelectionFlow() {
  const wrap = $("#prefMatrix"); wrap.innerHTML = "";
  if (!state.patients.length || !state.trials.length) { wrap.appendChild(el("p", { class: "muted" }, "Add at least one patient and one trial.")); return; }
  if (!state.patients.some((x) => x.id === state.actAsId)) state.actAsId = state.patients[0].id;
  const p = state.patients.find((x) => x.id === state.actAsId);
  ensureChoices(p);
  const d = state.lastResult;

  // patient switcher
  const chips = el("div", { class: "flow-patients" });
  state.patients.forEach((pt) => {
    ensureChoices(pt);
    const n = pt.choices.filter(Boolean).length;
    chips.appendChild(el("button", { class: "flow-pt" + (pt.id === state.actAsId ? " active" : "") + (pt.enrolled ? " done" : ""), onclick: () => { state.actAsId = pt.id; renderPreferences(); } },
      [el("b", {}, pt.name), el("span", { class: "flow-pt-ct" }, pt.enrolled ? " ✓ enrolled" : ` ${n}/3`)]));
  });
  wrap.appendChild(chips);

  // split layout: trial options on the left, the ordered selection panel on the right
  const selected = p.choices.filter(Boolean);
  const split = el("div", { class: "flow-split" });
  const left = el("div", { class: "flow-left" });

  // a result computed from the CURRENT state is needed for options/status; during a
  // scenario load this renders before the solve, with lastResult still describing
  // the old state. runAndRender re-renders the flow right after solving.
  const fresh = d && d.patient_ids && d.trial_ids
    && state.patients.every((x) => d.patient_ids.indexOf(x.id) >= 0)
    && state.trials.every((x) => d.trial_ids.indexOf(x.id) >= 0);
  const myAsn = fresh ? d.assignments.find((a) => a.patient_id === p.id) : null;

  // right: the patient's selection as three explicit choice slots
  const panel = el("div", { class: "flow-selpanel" });
  panel.appendChild(el("div", { class: "selpanel-head" }, [el("b", {}, p.name + "'s selection"), el("span", { class: "count" }, p.enrolled ? " · enrolled" : ` · ${selected.length}/3`)]));
  if (p.enrolled) {
    const te = state.trials.find((x) => x.id === p.enrolled);
    panel.appendChild(el("div", { class: "selslot enrolled" }, [
      el("span", { class: "selslot-rank" }, "✓ enrolled"),
      el("div", { class: "selslot-name" }, te ? te.name : p.enrolled),
      el("div", { class: "selslot-seated" }, "passed prescreening · seat locked"),
    ]));
    panel.appendChild(el("p", { class: "selpanel-note" }, "Enrollment is final in this demo; load the scenario again to reset."));
  } else [0, 1, 2].forEach((i) => {
    const tid = selected[i];
    const rank = el("span", { class: "selslot-rank" }, `${ORDINAL[i]} choice · ♥${CHOICE_SCORES[i]}`);
    if (!tid) {
      panel.appendChild(el("div", { class: "selslot empty" }, [rank, el("div", { class: "selslot-empty" }, "empty · add a trial from the list")]));
      return;
    }
    const t = state.trials.find((x) => x.id === tid);
    const q = t ? trialQueue(t) : [];
    const qPos = q.findIndex((x) => x.p.id === p.id);
    const slot = el("div", { class: "selslot" }, [
      el("div", { class: "selslot-top" }, [rank, el("span", { class: "selslot-btns" }, [
        el("button", { class: "sel-mv", title: "raise this choice", disabled: i === 0 ? "" : null, onclick: () => moveSelection(p, i, -1) }, "↑"),
        el("button", { class: "sel-mv", title: "lower this choice", disabled: i === selected.length - 1 ? "" : null, onclick: () => moveSelection(p, i, 1) }, "↓"),
        el("button", { class: "sel-rm", title: "remove (leaves this trial's queue; lower choices promote)", onclick: () => removeFromSelection(p, tid) }, "✕"),
      ])]),
      el("div", { class: "selslot-name" }, t ? t.name : tid),
      el("div", { class: "selslot-q" }, qPos >= 0 ? `#${qPos + 1} of ${q.length} in ${t ? t.name : tid}'s queue` : ""),
    ]);
    if (myAsn && myAsn.trial_id === tid) slot.appendChild(el("div", { class: "selslot-seated" }, "✓ optimizer seats them here"));
    panel.appendChild(slot);
  });
  if (!p.enrolled) panel.appendChild(el("p", { class: "selpanel-note" }, "Order = preference. Adding joins that trial's queue; removing leaves it and promotes lower choices."));

  split.appendChild(left);
  split.appendChild(panel);
  wrap.appendChild(split);

  // enrolled patients are done choosing — no options list, just the fact
  if (p.enrolled) {
    const te = state.trials.find((x) => x.id === p.enrolled);
    left.appendChild(el("div", { class: "flow-enrolled" }, `✓ ${p.name} is enrolled in ${te ? te.name : p.enrolled} after passing prescreening. Their other queue spots were released.`));
    return;
  }

  if (!fresh) { left.appendChild(el("p", { class: "muted" }, "Computing…")); return; }
  const pi = d.patient_ids.indexOf(p.id);

  const options = state.trials.map((t) => {
    const ti = d.trial_ids.indexOf(t.id);
    const gate = d.gate_detail[pi][ti];
    const fill = d.trial_fill[t.id] || { filled: 0, total: Math.max(1, t.slots || 1) };
    const q = trialQueue(t);
    return { t, ti, gate, eligible: d.eligibility[pi][ti], fill, qLen: q.length,
      qPos: q.findIndex((x) => x.p.id === p.id), selRank: selected.indexOf(t.id),
      failedPS: !!(p.screenfails && p.screenfails[t.id]),
      blocks: d.eligibility[pi][ti] ? blocksCount(p, t, d) : 0 };
  });
  const rec = options.filter((o) => o.eligible && !o.failedPS).sort((a, b) => a.blocks - b.blocks || a.qLen - b.qLen || a.ti - b.ti);
  const bad = options.filter((o) => !o.eligible || o.failedPS);
  const condChip = (c, ok) => el("span", { class: "tro-chip " + (ok ? "ok" : "fail") }, `${ok ? "✓" : "✕"} ${c.label} ${c.op_symbol} ${c.value}`);

  const recSec = el("div", { class: "tro-sec" });
  recSec.appendChild(el("div", { class: "tro-head rec" }, [el("b", {}, "RECOMMENDED"), el("span", {}, "open to this patient · ranked by who else stays matchable and by queue pressure")]));
  rec.forEach((o) => {
    const open = Math.max(0, o.fill.total - o.fill.filled);
    const chips2 = el("span", { class: "tro-chips" });
    if (!o.gate.groups.length) chips2.appendChild(el("span", { class: "tro-chip ok" }, "✓ open to all"));
    o.gate.groups.forEach((g) => { const c = g.conds.find((x) => x.passed) || g.conds[0]; if (c) chips2.appendChild(condChip(c, true)); });
    const full3 = selected.length >= 3;
    const btn = o.selRank >= 0
      ? el("button", { class: "tro-btn rm", title: "remove from selection (leaves this trial's queue)", onclick: () => removeFromSelection(p, o.t.id) }, `Selected · ${ORDINAL[o.selRank]} choice ✕`)
      : el("button", { class: "tro-btn add", disabled: full3 ? "" : null, title: full3 ? "selection full (max 3) · remove one first" : "adds as the next choice and joins this trial's queue", onclick: () => addToSelection(p, o.t.id) }, "Add to selection");
    const side = el("div", { class: "tro-side" }, [
      o.blocks > 0 ? el("span", { class: "tro-badge warn" }, `⚠ blocks ${o.blocks}`) : el("span", { class: "tro-badge ok" }, "✓ blocks no one"),
      el("span", { class: "tro-meta" }, `${open}/${o.fill.total} slot${o.fill.total > 1 ? "s" : ""} open`),
      el("span", { class: "tro-meta" }, o.qPos >= 0 ? `#${o.qPos + 1} of ${o.qLen} in queue` : (o.qLen ? `${o.qLen} in queue` : "queue empty")),
    ]);
    if (engineFeatures().slotUrgency && o.t.expires_days != null) side.insertBefore(el("span", { class: "tro-meta exp" }, `⏳ expires ${o.t.expires_days}d`), side.children[1]);
    side.appendChild(btn);
    recSec.appendChild(el("div", { class: "tro-card" + (o.selRank >= 0 ? " sel" : "") }, [
      el("div", { class: "tro-main" }, [
        el("div", { class: "tro-name" }, o.t.name),
        el("div", { class: "tro-sub" }, [document.createTextNode("Matched on "), chips2]),
      ]),
      side,
    ]));
  });
  left.appendChild(recSec);

  if (bad.length) {
    const badSec = el("div", { class: "tro-sec" });
    badSec.appendChild(el("div", { class: "tro-head bad" }, [el("b", {}, "NOT A FIT"), el("span", {}, "shown for awareness · a required criterion did not pass, or prescreening failed")]));
    bad.forEach((o) => {
      const chips2 = el("span", { class: "tro-chips" });
      if (o.failedPS) chips2.appendChild(el("span", { class: "tro-chip fail" }, "✕ screen-failed at prescreening"));
      o.gate.groups.filter((g) => !g.passed).forEach((g) => { const c = g.conds[0]; if (c) chips2.appendChild(condChip(c, false)); });
      badSec.appendChild(el("div", { class: "tro-card notfit" }, [
        el("div", { class: "tro-main" }, [
          el("div", { class: "tro-name" }, o.t.name),
          el("div", { class: "tro-sub" }, [document.createTextNode("Failed "), chips2]),
        ]),
      ]));
    });
    left.appendChild(badSec);
  }

  wrap.appendChild(el("p", { class: "hint" }, "Suggestions only: nothing is assigned until the optimizer runs on the selections. “Blocks N” = seating this patient there would leave N other waiting patients unmatchable (judged by their selections, or by eligibility if they haven't selected yet). The Advanced view has a quick-edit rank table."));
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
  (state.urgency_rules || []).forEach((r) => (r.conds || []).forEach((c) => { const f = fmap[c.field]; if (f && !OPS_FOR_KIND[f.kind].includes(c.op)) c.op = OPS_FOR_KIND[f.kind][0]; }));
}
function removeField(name) {
  state.fields = state.fields.filter((f) => f.name !== name);
  state.patients.forEach((p) => { delete p.attrs[name]; });
  state.trials.forEach((t) => { t.criteria = (t.criteria || []).map((g) => ({ conds: g.conds.filter((c) => c.field !== name) })).filter((g) => g.conds.length); });
  state.urgency_rules = (state.urgency_rules || []).map((r) => ({ level: r.level, conds: (r.conds || []).filter((c) => c.field !== name) })).filter((r) => r.conds.length);
  renderInputs(); scheduleSave();
}

// ---- diagnosis urgency rules editor (v4 · patient urgency) ---- //
function ruleCondEditor(rule, c, ci) {
  const fmap = fieldsByName();
  const kind = (fmap[c.field] || {}).kind || "categorical";
  const fieldSel = el("select", { onchange: (e) => { c.field = e.target.value; const nf = fmap[c.field]; c.op = OPS_FOR_KIND[nf.kind][0]; c.value = nf.kind === "numeric" ? 0 : ""; c.value2 = null; renderRules(); scheduleSave(); } },
    state.fields.map((f) => el("option", { value: f.name, selected: f.name === c.field ? "" : null }, f.label)));
  const opSel = el("select", { onchange: (e) => { c.op = e.target.value; renderRules(); scheduleSave(); } },
    (OPS_FOR_KIND[kind] || ["=="]).map((o) => el("option", { value: o, selected: o === c.op ? "" : null }, OP_SYMBOL[o] || o)));
  const valIn = kind === "numeric"
    ? el("input", { type: "number", step: "0.1", value: c.value, oninput: (e) => { c.value = parseFloat(e.target.value) || 0; scheduleSave(); } })
    : el("input", { type: "text", value: c.value, oninput: (e) => { c.value = e.target.value; scheduleSave(); } });
  return el("span", { class: "crit-cond" }, [fieldSel, opSel, valIn,
    el("button", { class: "del-crit", title: "remove condition", onclick: () => { rule.conds.splice(ci, 1); if (!rule.conds.length) state.urgency_rules.splice(state.urgency_rules.indexOf(rule), 1); renderRules(); scheduleSave(); } }, "✕")]);
}
function renderRules() {
  const sec = $("#rulesDetails"); if (!sec) return;
  const show = !!engineFeatures().patientUrgency;
  sec.style.display = show ? "" : "none";
  if (!show) return;
  if (!Array.isArray(state.urgency_rules)) state.urgency_rules = [];
  $("#ruleCount").textContent = `· ${state.urgency_rules.length}`;
  const pv = $("#rulesPreview"); pv.innerHTML = "";
  state.urgency_rules.forEach((r) => {
    const txt = (r.conds || []).map(condText).join(" AND ") + " → " + (URGENCY_LABEL[r.level] || r.level);
    pv.appendChild(el("span", { class: "cs-chip" }, [el("span", { class: "cs-chip-sub" }, txt)]));
  });
  const box = $("#rulesCard"); box.innerHTML = "";
  if (!state.urgency_rules.length) box.appendChild(el("p", { class: "muted", style: "margin:8px 0 0" }, "No rules: urgency comes from each patient's manual level only."));
  state.urgency_rules.forEach((r, ri) => {
    const row = el("div", { class: "rule-row" });
    row.appendChild(el("span", { class: "rule-when" }, "When"));
    (r.conds || []).forEach((c, ci) => {
      if (ci > 0) row.appendChild(el("span", { class: "or-tag" }, "AND"));
      row.appendChild(ruleCondEditor(r, c, ci));
    });
    row.appendChild(el("button", { class: "btn-add-crit", onclick: () => { r.conds.push(newCond()); renderRules(); scheduleSave(); } }, "＋ AND"));
    row.appendChild(el("span", { class: "rule-arrow" }, "→ urgency"));
    row.appendChild(el("select", { class: "urgency-sel", onchange: (e) => { r.level = e.target.value; renderRules(); scheduleSave(); } },
      Object.keys(URGENCY_LABEL).filter((lv) => lv !== "none").map((lv) => el("option", { value: lv, selected: (r.level || "medium") === lv ? "" : null }, URGENCY_LABEL[lv]))));
    // rules evaluate top-down and the FIRST match wins, so order is meaningful
    row.appendChild(el("span", { class: "queue-btns" }, [
      el("button", { class: "queue-btn", title: "move up (evaluated earlier)", disabled: ri === 0 ? "" : null,
        onclick: () => { state.urgency_rules[ri] = state.urgency_rules[ri - 1]; state.urgency_rules[ri - 1] = r; renderRules(); scheduleSave(); } }, "↑"),
      el("button", { class: "queue-btn", title: "move down (evaluated later)", disabled: ri === state.urgency_rules.length - 1 ? "" : null,
        onclick: () => { state.urgency_rules[ri] = state.urgency_rules[ri + 1]; state.urgency_rules[ri + 1] = r; renderRules(); scheduleSave(); } }, "↓"),
    ]));
    row.appendChild(el("button", { class: "del-crit", title: "remove rule", onclick: () => { state.urgency_rules.splice(ri, 1); renderRules(); scheduleSave(); } }, "✕"));
    box.appendChild(row);
  });
}
function addRule() {
  if (!Array.isArray(state.urgency_rules)) state.urgency_rules = [];
  state.urgency_rules.push({ level: "high", conds: [newCond()] });
  renderRules(); scheduleSave();
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
  applyTabChrome();
  renderPreferences(); // choice tabs swap between selection flow (simple) and rank table (advanced)
  if (state.lastResult) renderResults(state.lastResult);
}

// --------------------------------------------------------------------------- //
// Results
// --------------------------------------------------------------------------- //
function renderError(msg) { $("#queueSection").style.display = "none"; $("#queuePanel").innerHTML = ""; $("#results").innerHTML = ""; $("#results").appendChild(el("div", { class: "card error-card" }, "⚠ " + msg)); }

function renderResults(d) {
  // trial queues render in their own section ABOVE the results panel
  const qsec = $("#queueSection"), qpanel = $("#queuePanel");
  const showQueues = currentTab().choice;
  qsec.style.display = showQueues ? "" : "none";
  qpanel.innerHTML = "";
  if (showQueues) qpanel.appendChild(queueCard(d));

  const root = $("#results"); root.innerHTML = "";
  root.appendChild(unassignedCard(d));
  if (d.matrix_view) root.appendChild(matrixCard(d.matrix_view));
  updateSticky(d);
  if (state.openPatientId) { if (d.patient_ids.includes(state.openPatientId)) fillDrawer(state.openPatientId); else closeDrawer(); }
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

// ---- queue card (patient-choice tab): per-trial FCFS tiebreak made visible ---- //
const RANK_LABEL = ["1st ♥3", "2nd ♥2", "3rd ♥1"];
const enrolledCount = (tid) => state.patients.filter((x) => x.enrolled === tid).length;

// ---- prescreening simulation: the front of each queue gets prescreened ---- //
function prescreenPass(p, t) {
  p.enrolled = t.id;       // seat is taken — a fact, locked in every future solve
  p.choices = [t.id];      // withdraws from all other queues
  ensureChoices(p); syncJoined(p);
  runAndRender();
}
function prescreenFail(p, t) {
  if (!p.screenfails) p.screenfails = {};
  p.screenfails[t.id] = true; // out of THIS trial for good; other choices promote
  p.choices = (p.choices || []).filter(Boolean).filter((x) => x !== t.id);
  ensureChoices(p); syncJoined(p);
  runAndRender();
}
function moveInQueue(t, idx, dir) {
  const q = trialQueue(t);
  const j = idx + dir;
  if (j < 0 || j >= q.length) return;
  const a = q[idx].p, b = q[j].p; // swap their join seqs for THIS trial only
  const tmp = a.joined[t.id]; a.joined[t.id] = b.joined[t.id]; b.joined[t.id] = tmp;
  runAndRender();
}
function queueCard(d) {
  const trialsBox = el("div", { class: "queue-trials" });
  state.trials.forEach((t) => {
    const box = el("div", { class: "queue-trial" });
    const open = Math.max(0, Math.max(1, t.slots || 1) - enrolledCount(t.id));
    box.appendChild(el("div", { class: "queue-title" }, [
      document.createTextNode(t.name + " queue"),
      el("span", { class: "queue-open" + (open ? "" : " full") }, open ? ` · ${open} open` : " · full"),
    ]));
    const q = trialQueue(t);
    if (!q.length) box.appendChild(el("div", { class: "queue-empty" }, "no one picked this trial"));
    // the FRONT of the line (first non-enrolled entrant) is up for prescreening
    const frontIdx = open > 0 ? q.findIndex((x) => !x.p.enrolled) : -1;
    q.forEach(({ p, rank }, idx) => {
      const asn = d.assignments.find((a) => a.patient_id === p.id);
      const here = asn && asn.trial_id === t.id;
      const enrolledHere = p.enrolled === t.id;
      const status = enrolledHere ? "✓ enrolled" : here ? "✓ projected" : (asn ? "→ " + (d.trial_names[d.trial_ids.indexOf(asn.trial_id)] || asn.trial_id) : "✕ unmatched");
      const row = el("div", { class: "queue-row" + (here ? " seated" : "") + (enrolledHere ? " enrolled" : "") }, [
        el("span", { class: "queue-pos" }, "#" + (idx + 1)),
        el("span", { class: "queue-nm clickable", onclick: () => openPatient(p.id) }, p.name),
        el("span", { class: "queue-rank" }, RANK_LABEL[rank]),
        el("span", { class: "queue-status" + (here || enrolledHere ? " ok" : "") }, status),
      ]);
      if (idx === frontIdx && !p.enrolled) {
        row.appendChild(el("span", { class: "queue-ps" }, [
          el("span", { class: "queue-ps-lbl" }, "prescreen:"),
          el("button", { class: "ps-btn pass", title: "passes prescreening — enrolls here, seat locks, other queues released", onclick: () => prescreenPass(p, t) }, "✓ pass"),
          el("button", { class: "ps-btn fail", title: "fails prescreening — leaves this queue for good, lower choices promote, projection re-optimizes", onclick: () => prescreenFail(p, t) }, "✕ fail"),
        ]));
      }
      row.appendChild(el("span", { class: "queue-btns" }, [
        el("button", { class: "queue-btn", title: "move earlier in this trial's queue", disabled: (idx === 0 || enrolledHere) ? "" : null, onclick: () => moveInQueue(t, idx, -1) }, "↑"),
        el("button", { class: "queue-btn", title: "move later in this trial's queue", disabled: (idx === q.length - 1 || enrolledHere) ? "" : null, onclick: () => moveInQueue(t, idx, 1) }, "↓"),
      ]));
      box.appendChild(row);
    });
    trialsBox.appendChild(box);
  });

  return el("section", { class: "card" }, [
    trialsBox,
    el("p", { class: "hint" }, "Every trial keeps its own queue: a patient joins it the moment they pick that trial. Trial staff prescreen the FRONT of the line while seats remain: ✓ pass enrolls the patient (seat locks, their other queue spots release), ✕ fail removes them from that queue for good (their lower choices promote) and the projection re-optimizes everyone still waiting. When rankings tie exactly, the seat goes to whoever joined THAT trial's queue first; a real rank difference always beats queue position. Use ↑/↓ to reorder a queue and re-run."),
  ]);
}

// ---- Hungarian matrix card (v3+): the padded matrix the solver actually sees ---- //
function matrixCard(mv) {
  const tbl = el("table", { class: "mtx hmx" });
  const head = el("tr", {}, [el("th", {}, "patient \\ slot")]);
  mv.slot_labels.forEach((lbl, si) => {
    const bits = [document.createTextNode(lbl)];
    if (mv.has_slot_urgency && mv.slot_expires[si] != null) bits.push(el("span", { class: "hmx-exp", title: "urgency " + mv.slot_urgency[si].toFixed(2) }, "⏳" + mv.slot_expires[si] + "d"));
    if (!mv.slot_filled[si]) bits.push(el("span", { class: "hmx-open" }, "→ dummy row"));
    head.appendChild(el("th", { class: mv.slot_filled[si] ? null : "hmx-unfilled" }, bits));
  });
  head.appendChild(el("th", { class: "hmx-dummyhead" }, "∅ unmatched (dummy col)"));
  tbl.appendChild(head);
  mv.patient_names.forEach((nm, pi) => {
    const rowBits = [document.createTextNode(nm)];
    const urg = mv.has_patient_urgency ? mv.patient_urgency[pi] : null;
    if (urg && urg !== "none") rowBits.push(el("span", { class: "hmx-urg u-" + urg }, urg));
    const tr = el("tr", {}, [el("td", { class: "rowhead" }, rowBits)]);
    mv.cells[pi].forEach((c) => {
      const cls = c.assigned ? "hmx-asn" : (c.cand ? "hmx-cand" : "hmx-blocked");
      tr.appendChild(el("td", { class: "hmx-cell " + cls, title: c.cand ? "combined score (normalized pref + urgency bonuses)" : "blocked: ineligible or preference 0" }, c.cand ? c.score.toFixed(2) : "✕"));
    });
    tr.appendChild(el("td", { class: "hmx-cell hmx-dummy" + (mv.unmatched[pi] ? " hmx-asn" : "") }, "0"));
    tbl.appendChild(tr);
  });
  return el("section", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", {}, "Hungarian matrix (with dummy padding)")]),
    el("div", { class: "mtx-wrap" }, [tbl]),
    el("p", { class: "hint" }, "The solver only works on square matrices, so it pads: every patient gets a 0-value “unmatched” dummy column (being left out is always legal, just worthless), and 0-value dummy patient rows absorb leftover slots — an unfilled slot is simply one the solver handed to a dummy row. ✕ = blocked (ineligible or preference 0); highlighted = the active plan's pick."),
  ]);
}

// ---- pegged assignment dashboard (always visible at the bottom) ---- //
function maxMatchToggle(d) {
  const sw = el("label", { class: "switch" }, [
    el("input", { type: "checkbox", checked: state.params.max_match ? "" : null, onchange: (e) => { state.params.max_match = e.target.checked; runAndRender(); } }),
    el("span", { class: "slider" }),
  ]);
  const note = d.max_count > d.val_count
    ? (state.params.max_match ? `on: enrolls ${d.max_count}` : `off: ${d.val_count} in, on would enroll ${d.max_count}`)
    : "no effect on this input";
  return el("div", { class: "sa-toggle" }, [sw,
    el("div", { class: "sa-toggle-txt" }, [el("b", {}, "Maximal matching"), el("span", { class: "sa-toggle-note" }, note)])]);
}
function updateSticky(d) {
  const bar = $("#stickyAssign"); bar.innerHTML = "";
  const filled = Object.values(d.trial_fill).reduce((a, v) => a + v.filled, 0);
  const total = d.slot_labels.length;
  // left: title + stat chips + max-match toggle
  const f = engineFeatures();
  const stats = el("div", { class: "sa-stats" }, [
    el("span", { class: "sa-stat good" }, [el("b", {}, String(d.count)), " matched"]),
    el("span", { class: "sa-stat" }, [el("b", {}, `${filled}/${total}`), " slots"]),
    el("span", { class: "sa-stat" }, [el("b", {}, d.total_pref.toFixed(0)), " pref"]),
    (d.total_score != null && (f.slotUrgency || f.patientUrgency)) ? el("span", { class: "sa-stat", title: "total combined score (pref + urgency bonuses)" }, [el("b", {}, d.total_score.toFixed(2)), " score"]) : null,
    d.unmatched.length ? el("span", { class: "sa-stat warn" }, [el("b", {}, String(d.unmatched.length)), " unmatched"]) : null,
  ]);
  const isChoice = currentTab().choice;
  bar.appendChild(el("div", { class: "sa-info" }, [
    el("div", { class: "sa-title" }, isChoice ? "Projected placements" : "Assignments"),
    isChoice ? el("div", { class: "sa-subtitle" }, "a forecast, not enrollment: assumes everyone in queue passes prescreening · ✓ = enrolled (locked)") : null,
    stats, maxMatchToggle(d)]));
  // right: one box per trial with its patient pills
  const byAssign = {}, byEmpty = {};
  d.assignments.forEach((a) => (byAssign[a.trial_id] = byAssign[a.trial_id] || []).push(a));
  d.unfilled_slots.forEach((s) => (byEmpty[s.trial_id] = byEmpty[s.trial_id] || []).push(s));
  const board = el("div", { class: "sa-board" });
  d.trial_ids.forEach((tid, i) => {
    const fill = d.trial_fill[tid] || { filled: 0, total: 0 };
    const full = fill.total > 0 && fill.filled === fill.total;
    const body = el("div", { class: "sa-col-b" });
    (byAssign[tid] || []).forEach((a) => {
      const pd = d.patients_detail[d.patient_ids.indexOf(a.patient_id)];
      const urg = pd && pd.urgency && pd.urgency !== "none" ? pd.urgency : null;
      const stp = state.patients.find((x) => x.id === a.patient_id);
      const enr = stp && stp.enrolled === tid;
      body.appendChild(el("span", { class: "sa-pt" + (enr ? " enrolled" : ""), title: (enr ? "ENROLLED (passed prescreening) · " : "") + "preference " + a.pref + (urg ? " · urgency " + urg : ""), onclick: () => openPatient(a.patient_id) },
        [enr ? el("span", { class: "sa-pt-enr" }, "✓") : null, urg ? el("span", { class: "sa-pt-urg u-" + urg }, "🚨") : null, el("span", { class: "sa-pt-nm" }, a.patient_name), el("span", { class: "sa-pt-pref" }, "♥" + a.pref)]));
    });
    (byEmpty[tid] || []).forEach(() => body.appendChild(el("span", { class: "sa-pt open" }, "open")));
    const texp = (d.trial_expires && d.trial_expires[i] != null) ? d.trial_expires[i] : null;
    board.appendChild(el("div", { class: "sa-col" }, [
      el("div", { class: "sa-col-h" }, [
        el("span", { class: "sa-col-nm" }, d.trial_names[i]),
        texp != null ? el("span", { class: "sa-col-exp", title: "slot expires in " + texp + " days" }, "⏳" + texp + "d") : null,
        el("span", { class: "sa-col-ct" + (full ? " full" : "") }, `${fill.filled}/${fill.total}`)]),
      body,
    ]));
  });
  bar.appendChild(board);
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
  if (pdet.urgency) {
    let utxt = URGENCY_LABEL[pdet.urgency] || pdet.urgency;
    if (pdet.urgency_source === "rule") utxt += " · from diagnosis rule";
    else if (pdet.urgency_manual && pdet.urgency_manual !== "none") utxt += " · manual";
    attrs.appendChild(el("div", { class: "dr-attr" }, [el("b", {}, "Urgency: "), document.createTextNode(utxt)]));
  }
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
  $("#addRule").addEventListener("click", addRule);
  $("#scenarioSelect").addEventListener("change", updateBlurb);
  $("#seedBtn").addEventListener("click", () => seedScenario($("#scenarioSelect").value));
  $("#resetBtn").addEventListener("click", () => {
    const sel = $("#scenarioSelect"); if (sel.options.length) sel.selectedIndex = 0;
    updateBlurb();
    loadState(defaultTabState(currentTab()));
  });
  $("#drawerClose").addEventListener("click", closeDrawer);
  $("#drawerBackdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
}
function init() {
  wire();
  setView("simple");
  let savedTab = null;
  try { savedTab = localStorage.getItem("mp_active_tab_v1"); } catch (e) { /* ignore */ }
  state.tab = TABS.some((t) => t.id === savedTab) ? savedTab : TABS[0].id;
  renderTabs();
  applyTabChrome();
  populateScenarios();
  loadState(loadTabRaw(currentTab()));
}
init();
