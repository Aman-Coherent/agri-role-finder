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
// "official website" would actively mislead it.
const EMPTY_CELL_RE = /^(n\/?a|na|none|null|nil|-+|0|\.)$/i;

function cellValue(cols, idx) {
  if (idx === undefined) return "";
  const v = (cols[idx] || "").trim();
  return EMPTY_CELL_RE.test(v) ? "" : v;
}

// Returns { companies, detected } or null. Only the columns the extension
// uses are kept - native id, company name, website, city, state, country,
// and a combined address as a fallback location. The rest of the file (often
// dozens of columns) is dropped here; results are joined back to it on
// native_id. `detected` maps each field to the header it was read from, so
// the popup can show which columns were picked.
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

  // Internal ids ("r0", "r1", ...) are assigned later, in storage order (see
  // ARF_STORE.buildChunks) - unique even when two rows share a native_id.
  const companies = rows
    .slice(1)
    .map((cols) => ({
      native_id: cellValue(cols, idx.native_id),
      company_name: cellValue(cols, idx.company_name),
      website: cellValue(cols, idx.website),
      city: cellValue(cols, idx.city),
      state: cellValue(cols, idx.state),
      country: cellValue(cols, idx.country),
      location: cellValue(cols, idx.location),
    }))
    .filter((c) => c.company_name);
  return { companies, detected };
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

// Writes the companies into storage in pieces (see store.js) and only then
// tells background.js the project exists. The list never travels in a
// message: Chrome refuses messages over 64 MB, which a 50,000-company file
// easily exceeds. If anything goes wrong half-way, the pieces already
// written are removed again so no half-imported project is left behind.
const PIECES_PER_WRITE = 10;

async function createProject(name, companies, detected, settings, onProgress) {
  const projectId = ARF_STORE.newProjectId();
  const chunks = ARF_STORE.buildChunks(companies);
  const written = [];
  try {
    for (let i = 0; i < chunks.length; i += PIECES_PER_WRITE) {
      const entries = {};
      for (const { n, items } of chunks.slice(i, i + PIECES_PER_WRITE)) entries[ARF_STORE.chunkKey(projectId, n)] = items;
      await chrome.storage.local.set(entries);
      written.push(...Object.keys(entries));
      onProgress(Math.min((i + PIECES_PER_WRITE) * ARF_STORE.CHUNK_SIZE, companies.length));
    }
    const res = await chrome.runtime.sendMessage({
      type: "CREATE_PROJECT",
      projectId,
      name,
      total: companies.length,
      chunkCount: chunks.length,
      detected,
      ...settings,
    });
    if (!res || !res.ok) await chrome.storage.local.remove(written);
    return res;
  } catch (err) {
    await chrome.storage.local.remove(written).catch(() => {});
    throw err;
  }
}

let importing = false;

async function refresh() {
  if (importing) return; // the import's progress line owns the status box
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

  const counts = { ...ARF_STORE.emptyCounts(), ...(project.counts || {}) };
  const total = project.total || 0;
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
    // Each worker keeps the names of the batch it is searching.
    const names = engine.workers.flatMap((w) => w.currentNames || []);
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

  const status = document.getElementById("status");
  let parsed;
  try {
    status.textContent = `Reading ${file.name}...`;
    parsed = parseCsv(await file.text());
  } catch (err) {
    alert(`Couldn't read that file: ${err.message || err}`);
    refresh();
    return;
  }
  if (!parsed) {
    refresh();
    return;
  }
  const { companies, detected } = parsed;
  if (!companies.length) {
    alert("No rows with a company name were found in that file.");
    refresh();
    return;
  }

  const delayMinSec = Number(document.getElementById("delayMin").value) || 8;
  const delayMaxSec = Number(document.getElementById("delayMax").value) || 15;
  const concurrency = Number(document.getElementById("concurrency").value) || 1;
  const batchSize = Number(document.getElementById("batchSize").value) || 3;
  importing = true;
  try {
    const res = await createProject(name, companies, detected, { delayMinSec, delayMaxSec, concurrency, batchSize }, (done) => {
      status.textContent = `Importing ${done.toLocaleString()} of ${companies.length.toLocaleString()} companies - keep this window open...`;
    });
    if (!res || !res.ok) {
      alert("Couldn't create project" + (res && res.error ? `: ${res.error}` : "."));
    } else {
      selectedProjectId = res.projectId;
    }
  } catch (err) {
    alert(`Couldn't create project: ${err.message || err}`);
  } finally {
    importing = false;
    refresh();
  }
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

// Every export has the same fixed columns: the ones read from the input
// file, under fixed names (whatever the file called them - "Lead ID",
// "Company Name"...), then what was found. Results are joined back to the
// original file on native_id.
const INPUT_COLUMNS = ["native_id", "company_name", "country", "state", "city", "website"];
const RESULT_COLUMNS = ["description", "entity", "roles", "business_type"];

function inputCells(item) {
  return INPUT_COLUMNS.map((c) => item[c] || "");
}

function rolesCell(roles) {
  return roles.map((r) => (r.code ? `${r.name} (${r.code})` : r.name)).join("; ");
}

// Every individual business type of the roles in this row, each once.
// Already decided per role when the result came in (resolveBusinessTypes in
// taxonomy.js), so a company split across both files shows, in each file,
// only the types of the roles in that row.
function businessTypeCell(roles) {
  const types = roles.flatMap((r) => r.types || []);
  return types.filter((t, i) => types.indexOf(t) === i).join("; ");
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

// Every company of a project, piece by piece, straight from storage - a big
// project's companies never fit in one message.
async function forEachItem(project, fn) {
  for (let n = 0; n < project.chunkCount; n++) {
    const key = ARF_STORE.chunkKey(project.id, n);
    const items = (await chrome.storage.local.get(key))[key] || [];
    for (const item of items) fn(item);
  }
}

async function exportClassified(which, filename) {
  const project = await getSelectedProject();
  if (!project) return;
  const rows = [];
  await forEachItem(project, (item) => {
    if (item.status !== "found") return;
    for (const part of splitClassifications(item)[which]) {
      rows.push([...inputCells(item), item.description || "", part.entity, rolesCell(part.roles), businessTypeCell(part.roles)]);
    }
  });
  downloadCsv(filename, toCsv([...INPUT_COLUMNS, ...RESULT_COLUMNS], rows));
}

async function exportByStatus(status, filename, withDescription) {
  const project = await getSelectedProject();
  if (!project) return;
  const rows = [];
  await forEachItem(project, (item) => {
    if (item.status === status) rows.push([...inputCells(item), ...(withDescription ? [item.description || ""] : [])]);
  });
  downloadCsv(filename, toCsv([...INPUT_COLUMNS, ...(withDescription ? ["description"] : [])], rows));
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
