/**
 * popup.js - manages named projects (each with its own CSV-derived company
 * list, kept separate) and drives the single shared background automation
 * engine. See background.js for the storage/engine design.
 */

// ---------------------------------------------------------------------------
// CSV import: column auto-detection matches headers by meaning, not exact
// spelling.
//
// Parsing follows RFC 4180 quoting, and has to: this used to split every line
// on every comma with no notion of quotes, on the assumption that company
// names rarely contain one. They do - "Wilkes Kunststoffe GmbH, Co KG" and
// every other `GmbH & Co. KG` variant exported with quoting - and the damage
// wasn't a tidy truncation. Splitting inside a quoted field chopped the name
// in half AND shifted every column after it by one, so the row was searched
// under a broken name with some other column's value as its city. Silent,
// and invisible in the results.
// ---------------------------------------------------------------------------

// Tokenizes the whole file in one pass rather than line-by-line, because a
// quoted field is allowed to contain newlines too - splitting on newlines
// first would corrupt those rows before quoting was ever considered.
// Returns an array of rows, each an array of raw cell strings.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let sawAnyChar = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // "" inside a quoted field is one literal quote
          i++;
        } else {
          inQuotes = false;
        }
      } else if (ch !== "\r") {
        field += ch;
      }
      sawAnyChar = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawAnyChar = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      sawAnyChar = true;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      sawAnyChar = false;
      continue;
    }
    if (ch === "\r") continue;
    field += ch;
    sawAnyChar = true;
  }
  if (sawAnyChar || field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length));
}

function normalizeHeader(h) {
  return h.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Exact header names first (after normalizeHeader strips case, spaces and
// punctuation, so "Company Name", "company_name" and "COMPANY-NAME" are all
// "companyname"). Order inside each list matters: the first alias present
// wins.
const FIELD_ALIASES = {
  native_id: ["nativeid", "id", "recordid", "referenceid", "refid", "customerid", "leadid", "companyid", "uniqueid"],
  website: [
    "website", "websiteurl", "companywebsite", "officialwebsite", "web", "url", "domain", "site",
    "homepage", "webaddress", "websitelink",
  ],
  company_name: [
    "companyname", "company", "businessname", "business", "organization", "organisation",
    "organizationname", "organisationname", "firmname", "firm", "clientname", "accountname", "name",
  ],
  city: ["city", "town", "cityname"],
  state: ["state", "province", "statename", "stateprovince", "region", "county"],
  country: ["country", "nation", "countryname"],
  location: ["location", "address", "fulladdress", "companyaddress"],
};

// Second pass for headers no exact alias caught ("Company Website (if any)",
// "HQ Country"). Checked in this order, and a column already claimed by an
// earlier field is never reused - website runs before company name so a
// "companywebsite" header can't be taken as the name.
const FIELD_CONTAINS = [
  ["native_id", ["nativeid"]],
  ["website", ["website", "url", "domain"]],
  ["company_name", ["companyname", "company", "organization", "organisation", "business"]],
  ["city", ["city", "town"]],
  ["state", ["state", "province"]],
  ["country", ["country"]],
  ["location", ["location", "address"]],
];

function detectColumns(normalizedHeaders) {
  const found = {};
  const used = new Set();
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const idx = normalizedHeaders.indexOf(alias);
      if (idx > -1 && !used.has(idx)) {
        found[field] = idx;
        used.add(idx);
        break;
      }
    }
  }
  for (const [field, needles] of FIELD_CONTAINS) {
    if (found[field] !== undefined) continue;
    const idx = normalizedHeaders.findIndex((h, i) => !used.has(i) && needles.some((n) => h.includes(n)));
    if (idx > -1) {
      found[field] = idx;
      used.add(idx);
    }
  }
  return found;
}

// Placeholder text spreadsheets use for "no value". Treated as empty for
// the fields we read - a website of "N/A" sent to the AI as the company's
// "official website" would actively mislead it. The original cell is still
// exported exactly as it was.
const EMPTY_CELL_RE = /^(n\/?a|na|none|null|nil|-+|0|\.)$/i;

function cellValue(cols, idx) {
  if (idx === undefined) return "";
  const v = (cols[idx] || "").trim();
  return EMPTY_CELL_RE.test(v) ? "" : v;
}

// Returns { companies, columns, detected } or null. `columns` is the input
// file's header row exactly as written - every export starts with it.
// `detected` maps each field we use to the header it was read from, so the
// popup can show which columns were picked.
function parseCsv(text) {
  const clean = text.replace(/^\uFEFF/, ""); // strip BOM some exporters add
  const rows = parseCsvRows(clean);
  if (!rows.length) return null;

  const rawHeaders = rows[0].map((h) => h.trim());
  const idx = detectColumns(rawHeaders.map(normalizeHeader));

  if (idx.company_name === undefined) {
    alert(
      "Couldn't find a company name column.\nHeaders found: " +
        (rawHeaders.join(", ") || "(none)") +
        "\n\nRename one to something like 'company_name', 'company', or 'business name' and try again."
    );
    return null;
  }

  const detected = {};
  for (const [field, i] of Object.entries(idx)) detected[field] = rawHeaders[i];

  const companies = rows
    .slice(1)
    .map((cols, i) => {
      const original = {};
      rawHeaders.forEach((h, c) => {
        original[h] = cols[c] || "";
      });
      const native_id = cellValue(cols, idx.native_id);
      return {
        // Internal only, and unique even when two rows share a native_id -
        // results are filed against this, so a collision would put one
        // company's answer on another's row.
        id: `r${i}`,
        native_id,
        company_name: cellValue(cols, idx.company_name),
        website: cellValue(cols, idx.website),
        city: cellValue(cols, idx.city),
        state: cellValue(cols, idx.state),
        country: cellValue(cols, idx.country),
        location: cellValue(cols, idx.location),
        original,
      };
    })
    .filter((c) => c.company_name);
  return { companies, columns: rawHeaders, detected };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

// CSV Injection / formula-injection guard: if a cell value starts with a
// character Excel/Sheets treats as a formula prefix, prepending a single
// quote forces it to be read as plain text instead of executed.
const CSV_FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

function sanitizeCsvCell(value) {
  const str = String(value ?? "");
  return CSV_FORMULA_PREFIXES.some((c) => str.startsWith(c)) ? "'" + str : str;
}

function csvCell(value) {
  return `"${sanitizeCsvCell(value).replace(/"/g, '""')}"`;
}

// header: [string], rows: [[value]]. Rows are arrays rather than objects so
// an input column that happens to share a name with one of ours can't
// overwrite it (or be overwritten).
function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
}

function downloadCsv(filename, text) {
  // Prepend a UTF-8 BOM - without it, Excel guesses the file's encoding
  // from the system codepage instead of UTF-8, and mangles any non-ASCII
  // character (accented names, umlauts, etc.) into mojibake.
  const blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true });
}

// ---------------------------------------------------------------------------
// Rate / ETA - computed from real recent completions, not a guess
// ---------------------------------------------------------------------------

function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return null;
  const mins = seconds / 60;
  if (mins < 60) return `${Math.ceil(mins)} min`;
  const hours = mins / 60;
  if (hours < 48) return `${hours.toFixed(1)} hr`;
  return `${(hours / 24).toFixed(1)} days`;
}

function computeRateAndEta(project, pendingCount) {
  const log = project.completionLog || [];
  if (log.length < 2) return null;
  const perItemSec = (log[log.length - 1] - log[0]) / 1000 / (log.length - 1);
  if (!(perItemSec > 0)) return null;
  const perHour = Math.round(3600 / perItemSec);
  const eta = formatDuration(perItemSec * pendingCount);
  return `~${perHour}/hr` + (eta ? ` · ETA ${eta}` : "");
}

// ---------------------------------------------------------------------------
// Project selection + rendering. selectedProjectId is popup-local state -
// it resets each time the popup is reopened, defaulting back to whichever
// project the engine is actively running/paused on, if any.
// ---------------------------------------------------------------------------

let selectedProjectId = null;
let pendingProjectName = null;

function populateSelect(summaries, engine) {
  const select = document.getElementById("projectSelect");
  const previousValue = select.value;
  select.innerHTML = '<option value="">Select a project...</option>';
  for (const p of summaries) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name} (${p.total})`;
    select.appendChild(opt);
  }
  const candidate = selectedProjectId || previousValue || engine.activeProjectId || (summaries[0] && summaries[0].id) || "";
  const valid = summaries.some((p) => p.id === candidate) ? candidate : "";
  select.value = valid;
  selectedProjectId = valid || null;
}

function renderEngineBanner(engine, summaries) {
  const banner = document.getElementById("engineBanner");
  if (!engine.activeProjectId || (!engine.isRunning && !engine.isPaused)) {
    banner.style.display = "none";
    return;
  }
  const meta = summaries.find((p) => p.id === engine.activeProjectId);
  banner.style.display = "block";
  banner.className = engine.isPaused ? "paused" : "running";
  banner.textContent = (engine.isPaused ? "Paused: " : "Running: ") + (meta ? meta.name : "a project");
}

async function refresh() {
  const { engine, summaries } = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  populateSelect(summaries, engine);
  renderEngineBanner(engine, summaries);

  const isSelectedTheActiveOne = !!selectedProjectId && selectedProjectId === engine.activeProjectId;

  const pauseBanner = document.getElementById("pauseBanner");
  const resumeBtn = document.getElementById("resumeBtn");
  if (isSelectedTheActiveOne && engine.isPaused && engine.pauseReason) {
    pauseBanner.style.display = "block";
    pauseBanner.textContent = engine.pauseReason;
    resumeBtn.style.display = "inline-block";
  } else {
    pauseBanner.style.display = "none";
    resumeBtn.style.display = "none";
  }

  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const isOtherRunning = engine.isRunning && engine.activeProjectId && engine.activeProjectId !== selectedProjectId;
  const thisOneAlreadyRunning = isSelectedTheActiveOne && engine.isRunning && !engine.isPaused;
  startBtn.disabled = !selectedProjectId || isOtherRunning || thisOneAlreadyRunning;
  startBtn.title = isOtherRunning ? "Stop the currently running project first." : "";
  stopBtn.disabled = !isSelectedTheActiveOne || (!engine.isRunning && !engine.isPaused);

  const updateSettingsBtn = document.getElementById("updateSettingsBtn");
  const settingsHint = document.getElementById("settingsHint");

  if (!selectedProjectId) {
    document.getElementById("status").textContent = "No project selected.";
    document.getElementById("progressBar").style.display = "none";
    document.getElementById("currentItem").textContent = "";
    document.getElementById("rateEta").textContent = "";
    updateSettingsBtn.style.display = "none";
    settingsHint.textContent = "These settings apply to a new project when you create one.";
    return;
  }

  const project = await chrome.runtime.sendMessage({ type: "GET_PROJECT", projectId: selectedProjectId });
  if (!project) {
    // Selected project vanished (e.g. deleted from elsewhere) - fall back.
    selectedProjectId = null;
    refresh();
    return;
  }

  // Keep the fields honest: always reflect the SELECTED project's actual
  // stored settings, not whatever was last typed for a different project.
  // Skip re-syncing while the user has focus in one of these fields, so
  // editing isn't fought mid-keystroke.
  const active = document.activeElement;
  const editingSettings = active && ["delayMin", "delayMax", "concurrency", "batchSize"].includes(active.id);
  if (!editingSettings) {
    document.getElementById("delayMin").value = project.delayMinSec;
    document.getElementById("delayMax").value = project.delayMaxSec;
    document.getElementById("concurrency").value = project.concurrency || 1;
    document.getElementById("batchSize").value = project.batchSize || 3;
  }
  const canEditSettings = !isSelectedTheActiveOne || (!engine.isRunning && !engine.isPaused);
  updateSettingsBtn.style.display = "inline-block";
  updateSettingsBtn.disabled = !canEditSettings;
  settingsHint.textContent = canEditSettings
    ? `Showing settings for "${project.name}". Change and click Update to apply.`
    : `Stop "${project.name}" to change its settings.`;

  const counts = { pending: 0, found: 0, blocked: 0, not_found: 0 };
  for (const c of project.queue) counts[c.status] = (counts[c.status] || 0) + 1;
  const total = project.queue.length;
  const done = total - counts.pending;
  const batchSize = project.batchSize || 3;

  const detected = project.detected || {};
  const detectedText = ["company_name", "website", "native_id", "city", "state", "country", "location"]
    .filter((f) => detected[f])
    .map((f) => `${f} = "${detected[f]}"`)
    .join(", ");

  document.getElementById("status").textContent =
    `Total: ${total} (${project.concurrency || 1} concurrent tab${(project.concurrency || 1) > 1 ? "s" : ""}, ` +
    `${batchSize} ${batchSize > 1 ? "companies" : "company"} per search)\n` +
    `Pending: ${counts.pending}\nClassified: ${counts.found}\n` +
    `Blocked (needs manual review): ${counts.blocked}\nNot found: ${counts.not_found}` +
    (detectedText ? `\n\nColumns used: ${detectedText}` : "");

  const progressBar = document.getElementById("progressBar");
  if (total > 0 && (isSelectedTheActiveOne || done > 0)) {
    progressBar.style.display = "block";
    progressBar.value = Math.round((done / total) * 100);
  } else {
    progressBar.style.display = "none";
  }

  const currentItem = document.getElementById("currentItem");
  if (isSelectedTheActiveOne && engine.workers && engine.workers.length) {
    // Each worker holds an ARRAY of claimed item ids (currentItemIds) since
    // a batch claims several companies at once - not a single currentItemId
    // (that field never existed on the engine's worker objects, so this
    // always evaluated to an empty list and the line below never showed
    // anything).
    const inFlightIds = engine.workers.flatMap((w) => w.currentItemIds || []);
    const names = inFlightIds
      .map((id) => project.queue.find((c) => c.id === id))
      .filter(Boolean)
      .map((c) => c.company_name);
    const shown = names.slice(0, 3).join(", ");
    const extra = names.length > 3 ? ` +${names.length - 3} more` : "";
    currentItem.textContent = names.length ? `Searching: ${shown}${extra}` : "";
  } else {
    currentItem.textContent = "";
  }

  const rateEta = document.getElementById("rateEta");
  rateEta.textContent =
    isSelectedTheActiveOne && engine.isRunning && !engine.isPaused
      ? computeRateAndEta(project, counts.pending) || ""
      : "";
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

document.getElementById("projectSelect").addEventListener("change", (e) => {
  selectedProjectId = e.target.value || null;
  refresh();
});

// Deliberately NOT using window.prompt() here: it's unreliable inside
// Chrome extension popups - the native OS dialog can steal focus from the
// popup, which causes the popup to auto-close (popups dismiss on blur)
// before you can ever type a name. A plain in-page input avoids that.
document.getElementById("newProjectBtn").addEventListener("click", () => {
  document.getElementById("newProjectForm").style.display = "block";
  const input = document.getElementById("newProjectNameInput");
  input.value = "";
  input.focus();
});

document.getElementById("newProjectCancelBtn").addEventListener("click", () => {
  document.getElementById("newProjectForm").style.display = "none";
});

document.getElementById("newProjectNameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("newProjectConfirmBtn").click();
});

document.getElementById("newProjectConfirmBtn").addEventListener("click", () => {
  const input = document.getElementById("newProjectNameInput");
  const name = input.value.trim();
  if (!name) {
    input.focus();
    return;
  }
  pendingProjectName = name;
  document.getElementById("newProjectForm").style.display = "none";
  document.getElementById("csvFile").click();
});

document.getElementById("csvFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const name = pendingProjectName;
  pendingProjectName = null;
  e.target.value = ""; // reset so choosing the same file again still fires 'change'
  if (!file || !name) return;

  const text = await file.text();
  const parsed = parseCsv(text);
  if (!parsed) return;
  const { companies, columns, detected } = parsed;
  if (!companies.length) {
    alert("No rows with a company name were found in that file.");
    return;
  }

  const delayMinSec = Number(document.getElementById("delayMin").value) || 8;
  const delayMaxSec = Number(document.getElementById("delayMax").value) || 15;
  const concurrency = Number(document.getElementById("concurrency").value) || 1;
  const batchSize = Number(document.getElementById("batchSize").value) || 3;
  const res = await chrome.runtime.sendMessage({
    type: "CREATE_PROJECT",
    name,
    companies,
    columns,
    detected,
    delayMinSec,
    delayMaxSec,
    concurrency,
    batchSize,
  });
  if (!res || !res.ok) {
    alert("Couldn't create project" + (res && res.error ? `: ${res.error}` : "."));
    return;
  }
  selectedProjectId = res.projectId;
  refresh();
});

document.getElementById("updateSettingsBtn").addEventListener("click", async () => {
  if (!selectedProjectId) return;
  const delayMinSec = Number(document.getElementById("delayMin").value) || 8;
  const delayMaxSec = Number(document.getElementById("delayMax").value) || 15;
  const concurrency = Number(document.getElementById("concurrency").value) || 1;
  const batchSize = Number(document.getElementById("batchSize").value) || 3;
  const res = await chrome.runtime.sendMessage({
    type: "UPDATE_PROJECT_SETTINGS",
    projectId: selectedProjectId,
    delayMinSec,
    delayMaxSec,
    concurrency,
    batchSize,
  });
  if (!res || !res.ok) {
    alert("Couldn't update settings" + (res && res.error ? `: ${res.error}` : "."));
  }
  refresh();
});

document.getElementById("startBtn").addEventListener("click", async () => {
  if (!selectedProjectId) return;
  const res = await chrome.runtime.sendMessage({ type: "START", projectId: selectedProjectId });
  if (!res || !res.ok) alert((res && res.error) || "Couldn't start.");
  refresh();
});

document.getElementById("stopBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP" });
  refresh();
});

document.getElementById("resumeBtn").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "RESUME" });
  if (!res || !res.ok) alert((res && res.error) || "Couldn't resume.");
  refresh();
});

// The columns this extension adds after the input file's own. If the input
// already has a column with one of these names, ours gets a suffix rather
// than producing two identically-named columns.
const RESULT_COLUMNS = ["description", "entity", "roles", "business_type"];

function resultHeader(inputColumns, added) {
  const taken = new Set(inputColumns.map((c) => c.toLowerCase()));
  return [...inputColumns, ...added.map((c) => (taken.has(c) ? `${c}_found` : c))];
}

function originalCells(project, item) {
  return project.columns.map((c) => (item.original || {})[c] ?? "");
}

function rolesCell(roles) {
  return roles.map((r) => (r.code ? `${r.name} (${r.code})` : r.name)).join("; ");
}

// From the role codes, via the mapping in taxonomy.js. Roles with no code,
// and G (Grower) roles, contribute nothing - see BUSINESS_TYPE_BY_CODE.
function businessTypeCell(roles) {
  return ARF_TAXONOMY.businessTypesFor(roles.map((r) => r.code).filter(Boolean)).join("; ");
}

// One row per company + entity ("Option B"), split ROLE BY ROLE between the
// two files:
//   on-list file: an entity from the list, with the roles that are on THAT
//     entity's list. An on-list entity with no roles at all also goes here.
//   new file: a new entity with all its roles, or an on-list entity's roles
//     that aren't on its list.
// So a company can appear in both files, and nothing is dropped or merged.
function splitClassifications(item) {
  const onList = [];
  const fresh = [];
  for (const cls of item.classifications || []) {
    if (!cls.entityInList) {
      fresh.push({ entity: cls.entity, roles: cls.roles });
      continue;
    }
    const listRoles = cls.roles.filter((r) => r.inList);
    const newRoles = cls.roles.filter((r) => !r.inList);
    if (listRoles.length || !cls.roles.length) onList.push({ entity: cls.entity, roles: listRoles });
    if (newRoles.length) fresh.push({ entity: cls.entity, roles: newRoles });
  }
  return { onList, fresh };
}

async function getSelectedProject() {
  if (!selectedProjectId) {
    alert("Select a project first.");
    return null;
  }
  return chrome.runtime.sendMessage({ type: "GET_PROJECT", projectId: selectedProjectId });
}

async function exportClassified(which, filename) {
  const project = await getSelectedProject();
  if (!project) return;
  const rows = [];
  for (const item of project.queue) {
    if (item.status !== "found") continue;
    const parts = splitClassifications(item)[which];
    for (const part of parts) {
      rows.push([
        ...originalCells(project, item),
        item.description || "",
        part.entity,
        rolesCell(part.roles),
        // New roles have no code, so this is always blank in the new file.
        businessTypeCell(part.roles),
      ]);
    }
  }
  downloadCsv(filename, toCsv(resultHeader(project.columns, RESULT_COLUMNS), rows));
}

async function exportByStatus(status, filename, withDescription) {
  const project = await getSelectedProject();
  if (!project) return;
  const added = withDescription ? ["description"] : [];
  const rows = project.queue
    .filter((item) => item.status === status)
    .map((item) => [...originalCells(project, item), ...(withDescription ? [item.description || ""] : [])]);
  downloadCsv(filename, toCsv(resultHeader(project.columns, added), rows));
}

document.getElementById("exportOnList").addEventListener("click", () =>
  exportClassified("onList", "on_list_results.csv")
);

document.getElementById("exportNew").addEventListener("click", () => exportClassified("fresh", "new_results.csv"));

// A not_found row can still carry a description: the AI described the
// company but put it in no entity at all.
document.getElementById("exportNotFound").addEventListener("click", () =>
  exportByStatus("not_found", "not_found.csv", true)
);

document.getElementById("exportReview").addEventListener("click", () =>
  exportByStatus("blocked", "needs_review.csv", false)
);

document.getElementById("retryNotFoundBtn").addEventListener("click", async () => {
  if (!selectedProjectId) {
    alert("Select a project first.");
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: "RETRY_NOT_FOUND", projectId: selectedProjectId });
  if (!res || !res.ok) {
    alert("Couldn't retry" + (res && res.error ? `: ${res.error}` : "."));
    return;
  }
  alert(res.count > 0 ? `${res.count} row(s) re-queued. Click Start to run them.` : "No not-found rows to retry.");
  refresh();
});

document.getElementById("deleteProjectBtn").addEventListener("click", async () => {
  if (!selectedProjectId) {
    alert("Select a project first.");
    return;
  }
  const select = document.getElementById("projectSelect");
  const label = select.options[select.selectedIndex] ? select.options[select.selectedIndex].textContent : "this project";
  const ok = confirm(`Delete "${label}"? This permanently removes its company list and results. Export any CSVs you still need first.`);
  if (!ok) return;
  await chrome.runtime.sendMessage({ type: "DELETE_PROJECT", projectId: selectedProjectId });
  selectedProjectId = null;
  refresh();
});

refresh();
setInterval(refresh, 3000);
