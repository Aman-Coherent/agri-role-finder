/**
 * background.js - orchestrates the automated search loop across named
 * "projects" (each project = one company list + its own results, kept
 * fully separate from other projects).
 *
 * Agri Role Finder is a sibling of ai-mode-scraper/ and runs on the same
 * engine. What differs is the question: instead of website/email/phone, each
 * company gets a short description plus the entities and roles it belongs
 * to, picked from the fixed list in taxonomy.js (see buildPrompt below, and
 * buildSearchUrl() on why that query must NOT ask for &udm=50).
 *
 * It searches in BATCHES: each worker claims up to `project.batchSize`
 * pending companies and asks about all of them in one Google query. Fewer
 * searches means a faster run AND lower CAPTCHA/block risk, at the cost of
 * a longer answer that is a little less reliable per company. content.js
 * reloads a completely empty search once, then records whatever is still
 * unresolved as not_found and the run moves on; those rows stay recoverable
 * through the popup's "Retry not-found rows".
 *
 * Trust boundary: content.js only reports what the AI wrote. Whether an
 * entity or role is "on the list" is decided HERE, against taxonomy.js
 * (classify), never taken from the AI's word for it - see handleResult.
 *
 * Only ONE project can be actively running at a time, but a running
 * project can use several concurrent tabs ("workers", configurable per
 * project, 1 to MAX_CONCURRENCY - independent of batchSize: concurrency is
 * how many tabs run in parallel, batchSize is how many companies each tab
 * asks about per search). Running two DIFFERENT projects through the
 * engine at once is still rejected - that's what would actually corrupt
 * which result belongs to which company. Multiple workers on the SAME
 * project's queue is safe because every read-modify-write of the shared
 * engine state goes through mutateEngine(), which serializes them (see
 * "Concurrency safety" below) - two workers finishing at nearly the same
 * instant can't claim the same item or clobber each other's write.
 *
 * Storage layout (chrome.storage.local):
 *   arfProjectIndex        -> { [id]: { name, createdAt, total, counts } }
 *                              lightweight, always small - safe to read on
 *                              every poll for the project list.
 *   arfProject_<id>         -> full project record (including its queue and
 *                              the input file's column order) -
 *                              read/written per-project, not all at once,
 *                              so one large project doesn't make every
 *                              write touch every other project's data too.
 *   arfEngine               -> the single shared run-state: which project
 *                              is active, running/paused, and one entry
 *                              per worker (its tab + claimed item IDs).
 *
 * IMPORTANT / non-negotiable behaviour:
 *   On a CAPTCHA/block page, this PAUSES the whole run and brings that tab
 *   to the front so you can solve it by hand - it never attempts to solve,
 *   click through, or otherwise bypass one itself. See content.js's
 *   isBlockedPage() / waitForCaptchaSolved(). Once solved, the search that
 *   was interrupted continues and the run resumes automatically - no
 *   button to click. If nobody solves it within CAPTCHA_WATCHDOG_MS, the
 *   whole in-flight batch is marked "blocked" for manual review and the
 *   run stays paused (Resume is a manual click at that point). More
 *   concurrent tabs means more simultaneous traffic from one IP, which
 *   raises block risk - that trade-off is the user's to make via the
 *   per-project setting, not silently maximized here.
 */

importScripts("taxonomy.js"); // defines globalThis.ARF_TAXONOMY

const PROJECT_INDEX_KEY = "arfProjectIndex";
const PROJECT_KEY_PREFIX = "arfProject_";
const ENGINE_KEY = "arfEngine";

const ALARM_PREFIX = "arf-next-";
// A worker's tab is expected to report a RESULT well within this window -
// see computeWatchdogMs() below, which scales this up for larger batches
// (a 5-company AI Mode answer legitimately takes longer to stream in than
// a 1-company one). If it doesn't report back in time - a page layout the
// content script didn't expect, a crash, a tab that failed to load - this
// fires and frees the worker anyway, so one stuck tab can never freeze the
// whole run. See content.js's run()/runInner() split for the matching
// guard on that side.
const WATCHDOG_PREFIX = "arf-watchdog-";
// These MUST stay comfortably above content.js's longest possible answer
// wait (ANSWER_BASE_MS / ANSWER_PER_ITEM_MS over there) plus page-load time.
// If the watchdog fires first it marks the whole in-flight batch not_found
// even though the content script was still legitimately waiting for the AI
// to finish writing - and from outside that looks exactly like "the
// extension can't extract anything". Answers here are much longer than the
// sibling extension's one-line-per-company replies (a description plus
// several entity lines each), so both sides allow more per company.
// content.js caps a 3-company batch at 120s and a 10-company one at 240s;
// this leaves roughly a 2x margin on top of that.
const BASE_WATCHDOG_MS = 180000;
const PER_ITEM_WATCHDOG_MS = 40000;
function computeWatchdogMs(batchLength) {
  return BASE_WATCHDOG_MS + PER_ITEM_WATCHDOG_MS * Math.max(batchLength - 1, 0);
}
// The same watchdog alarm gets re-armed with this much longer leash the
// moment a worker reports a CAPTCHA (see handleCaptchaDetected) - a person
// solving one by hand needs far more than a batch's normal answer window.
// If this fires, nobody came back in time: the whole in-flight batch is
// marked "blocked" for manual review and the run stays paused. See
// handleWatchdogTimeout.
const CAPTCHA_WATCHDOG_MS = 10 * 60 * 1000;
// Extra time granted to a worker that turned out to still be mid-wait when its
// watchdog fired, after being asked to report immediately - see the nudge in
// handleWatchdogTimeout.
const NUDGE_GRACE_MS = 20000;
const COMPLETION_LOG_SIZE = 30;
const MAX_CONCURRENCY = 20;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 10; // higher risks the query getting too long / the AI dropping companies from a longer list
// Lower than the sibling extension's 5: every company's answer here is a
// description plus several entity lines, so a batch answer is several times
// longer and the AI is more likely to cut it short.
const DEFAULT_BATCH_SIZE = 3;

// "found" here means "classified into at least one entity" - see
// sanitizeResultEntry.
const ALLOWED_STATUSES = new Set(["found", "not_found", "blocked"]);

// Caps for the AI's free text. Generous enough for a real 2-3 sentence
// description or a long role name, short enough that a runaway answer cannot
// bloat every stored item (chrome.storage is shared by every project, and a
// queue can run to thousands of rows).
const MAX_DESCRIPTION_LEN = 1200;
const MAX_NAME_LEN = 200; // a role name plus its "[business type]" suffix
const MAX_ENTITIES_PER_COMPANY = 12;
const MAX_ROLES_PER_ENTITY = 15;

// Message types that must come from our content script running on an
// actual Google search results tab, vs. types that only the popup should
// ever send (it has no sender.tab).
const CONTENT_SCRIPT_TYPES = new Set(["GET_CURRENT", "RESULT", "CAPTCHA_DETECTED", "RETRY_SEARCH"]);
const POPUP_TYPES = new Set([
  "CREATE_PROJECT", "UPDATE_PROJECT_SETTINGS", "RETRY_NOT_FOUND", "DELETE_PROJECT",
  "START", "STOP", "RESUME", "GET_STATE", "GET_PROJECT",
]);

const DEFAULT_ENGINE = {
  activeProjectId: null,
  isRunning: false,
  isPaused: false,
  pauseReason: null,
  // tabIds of workers currently sitting on an unsolved CAPTCHA - non-empty
  // implies isPaused. See handleCaptchaDetected/handleResult.
  captchaTabIds: [],
  // [{ tabId, windowId, ownsWindow, currentItemIds, batchToken }, ...] -
  // length === the active project's concurrency. `ownsWindow` records whether
  // THIS extension created that window (concurrency > 1 gives each worker its
  // own window - see ensureWorkerTab). It exists so cleanup can close what we
  // opened without ever closing a window the user opened themselves.
  workers: [],
};

// How long to leave between waking each worker for the first time. Starting
// N workers on the same instant means N simultaneous requests to Google from
// one IP, which is the exact pattern abuse detection looks for - and if it
// trips, it trips for every worker at once.
const WORKER_STAGGER_MS = 4000;


// Set to false to silence these. They print in the extension's SERVICE
// WORKER console (chrome://extensions -> this extension -> "Inspect views:
// service worker"), which is the one place that shows the whole loop
// regardless of which tab is which: what got claimed, which tab was
// navigated where, whether the content script ever called back, what it
// reported, and whether a watchdog gave up. See content.js's own DEBUG for
// the page-side half.
const DEBUG = true;
function debug(...args) {
  if (DEBUG) console.log("[AgriRoleFinder]", ...args);
}

function projectKey(id) {
  return PROJECT_KEY_PREFIX + id;
}

function newProjectId() {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function newBatchToken() {
  return `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function clampConcurrency(n) {
  const v = Math.round(Number(n) || 1);
  return Math.max(1, Math.min(v, MAX_CONCURRENCY));
}

function clampBatchSize(n) {
  const v = Math.round(Number(n) || DEFAULT_BATCH_SIZE);
  return Math.max(MIN_BATCH_SIZE, Math.min(v, MAX_BATCH_SIZE));
}

function countsOf(queue) {
  const counts = { pending: 0, found: 0, blocked: 0, not_found: 0 };
  for (const c of queue) counts[c.status] = (counts[c.status] || 0) + 1;
  return counts;
}

function makeProject(name, companies, columns, delayMinSec, delayMaxSec, concurrency, batchSize) {
  return {
    id: newProjectId(),
    name: String(name || "Untitled project").trim().slice(0, 120) || "Untitled project",
    createdAt: Date.now(),
    // The input file's own header row, in its own order. Every export starts
    // with exactly these columns (from each item's `original`), so results
    // line up with the file the user uploaded.
    columns: Array.isArray(columns) ? columns.map(String) : [],
    queue: companies.map((c) => ({
      id: String(c.id),
      native_id: c.native_id || "",
      company_name: c.company_name,
      website: c.website || "",
      city: c.city || "",
      state: c.state || "",
      country: c.country || "",
      // A single combined address column, used only when the file has no
      // separate city/state/country columns.
      location: c.location || "",
      // Every cell of the input row, keyed by its header, carried through to
      // the exports untouched.
      original: c.original && typeof c.original === "object" ? c.original : {},
      status: "pending",
      description: null,
      // [{ entity, entityInList, roles: [{ name, code, inList, types }] }] -
      // see ARF_TAXONOMY.classify in taxonomy.js.
      classifications: [],
    })),
    delayMinSec: delayMinSec || 8,
    delayMaxSec: delayMaxSec || 15,
    // How many tabs run this project's queue at once. More = faster, but
    // more simultaneous traffic from one IP = higher block risk - a
    // deliberate per-project trade-off, not maximized by default.
    concurrency: clampConcurrency(concurrency),
    // How many companies get bundled into one AI Mode search. More = fewer
    // total searches (faster, lower block risk) but a longer, harder-for-
    // the-AI-to-fully-comply-with query - see the file-level comment.
    batchSize: clampBatchSize(batchSize),
    completionLog: [],
  };
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getProjectIndex() {
  const data = await chrome.storage.local.get(PROJECT_INDEX_KEY);
  return data[PROJECT_INDEX_KEY] || {};
}

async function saveProjectIndex(index) {
  await chrome.storage.local.set({ [PROJECT_INDEX_KEY]: index });
}

async function getProject(id) {
  if (!id) return null;
  const data = await chrome.storage.local.get(projectKey(id));
  return data[projectKey(id)] || null;
}

async function saveProject(project) {
  await chrome.storage.local.set({ [projectKey(project.id)]: project });
}

async function deleteProjectStorage(id) {
  await chrome.storage.local.remove(projectKey(id));
}

async function updateIndexCounts(project) {
  const index = await getProjectIndex();
  if (!index[project.id]) return;
  index[project.id] = { ...index[project.id], total: project.queue.length, counts: countsOf(project.queue) };
  await saveProjectIndex(index);
}

// ---------------------------------------------------------------------------
// Concurrency safety: every read-modify-write of the shared engine state
// goes through mutateEngine(), which chains onto a single promise so the
// (read -> compute -> write) sequence for one call can never interleave
// with another. Without this, two workers finishing at nearly the same
// moment could both read the same stale `workers` array, each compute a
// change based on it, and the second write would silently erase the
// first's update (a classic lost-update race) - e.g. two tabs claiming
// the same "pending" item, or one worker's completion vanishing because
// another worker's write clobbered it a moment later.
// ---------------------------------------------------------------------------

let engineLock = Promise.resolve();

function withEngineLock(fn) {
  const result = engineLock.then(fn, fn);
  // Keep the chain alive even if this step throws, so one failure doesn't
  // permanently wedge every future engine update behind a rejected promise.
  engineLock = result.then(
    () => {},
    () => {}
  );
  return result;
}

async function getEngine() {
  const data = await chrome.storage.local.get(ENGINE_KEY);
  return { ...DEFAULT_ENGINE, ...(data[ENGINE_KEY] || {}) };
}

// updater(engine) returns a partial patch to shallow-merge onto the
// freshly-read engine, or a Promise of one. Runs inside the lock.
function mutateEngine(updater) {
  return withEngineLock(async () => {
    const engine = await getEngine();
    const patch = (await updater(engine)) || {};
    const next = { ...engine, ...patch };
    await chrome.storage.local.set({ [ENGINE_KEY]: next });
    return next;
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function randomDelayMs(project) {
  const min = project.delayMinSec * 1000;
  const max = Math.max(project.delayMaxSec * 1000, min + 1000);
  return min + Math.random() * (max - min);
}

// How one company is introduced to the AI. The website, when there is one,
// is named as the main source: a domain points at exactly one company, which
// a name + town often does not. Without a website, the location is what
// tells "Green Agro" in Pune apart from every other Green Agro.
function describeCompany(item) {
  const location = [item.city, item.state, item.country].filter(Boolean).join(", ") || item.location || "";
  return [
    `"${item.company_name}"`,
    item.website ? `website: ${item.website}` : "",
    location ? `location: ${location}` : "",
  ]
    .filter(Boolean)
    .join(" - ");
}

// One prompt for any batch size, including 1, so content.js only ever has to
// understand one answer format.
//
// Format choices content.js depends on (change them together):
//   - Each answer starts with a "COMPANY <n>" line. That text is typed by the
//     AI, so unlike an HTML list's auto-numbers it survives into the page
//     text, and it lets answers be matched to companies by number even if
//     the AI skips one. The company list below deliberately numbers with
//     "1)" instead, so the prompt itself never contains "COMPANY <digit>" and
//     cannot be mistaken for an answer if Google echoes it.
//   - Every template value is in <angle brackets>, which a real answer never
//     contains - that is how an echoed template line is told apart from a
//     real one (see isTemplateValue in content.js).
//   - "END OF ANSWERS" lets content.js stop waiting the moment the AI is done,
//     instead of waiting out a silence to be sure the last company's final
//     ENTITY line isn't still on its way.
//   - Each role carries its business type in [square brackets]. Square, not
//     round, because several role names already contain round brackets
//     ("Micro-irrigation (Drip/Sprinkler) Manufacturer"). content.js splits
//     roles on ";" outside the brackets, and taxonomy.js checks the types
//     against the role's code (resolveBusinessTypes).
//   - "Write NONE instead of guessing" is the main defence against a
//     generative answer inventing plausible-sounding activities.
function buildPrompt(items) {
  const n = items.length;
  const companyLines = items.map((it, i) => `${i + 1}) ${describeCompany(it)}`).join("\n");
  return (
    `I will list ${n} agriculture-sector ${n === 1 ? "company" : "companies"}. For EACH one: ` +
    `if a website is given, use that official website as the main source to identify ` +
    `the company and what it does; if no website is given, identify the company by ` +
    `its name and location.\n\n` +
    `Companies:\n${companyLines}\n\n` +
    `For each company:\n` +
    `(a) Write a factual description of what the company actually does - its main ` +
    `products or services and who it sells to - in 2 to 3 sentences, on ONE line.\n` +
    `(b) Choose every ENTITY from the list below that the company belongs to, and ` +
    `under each entity every ROLE from that entity's own roles that the company ` +
    `actually performs. Copy entity and role names EXACTLY as written in the list. ` +
    `A company can have several entities and several roles.\n` +
    `(c) Only if the company clearly does something that no entity or role in the ` +
    `list covers, write your own short, plain name for that entity or role instead.\n` +
    `(d) After each role, in square brackets, write the business type the company ` +
    `actually is for that role, using ONLY these exact words: ` +
    `${ARF_TAXONOMY.BUSINESS_TYPES.join(", ")}. Pick the specific one - for example ` +
    `Exporter, not Exporter/Importer; Distributor, not Distributor/Wholesaler. If it ` +
    `is more than one, separate them with commas inside the brackets.\n\n` +
    `LIST - each line is an entity, a colon, then that entity's roles separated by semicolons:\n` +
    `${ARF_TAXONOMY.promptList()}\n\n` +
    `Reply in exactly this format and nothing else - no greeting, no explanation, ` +
    `no markdown, no tables:\n` +
    `COMPANY <number>\n` +
    `DESCRIPTION: <2-3 sentences on one line>\n` +
    `ENTITY: <entity name> | ROLES: <role> [<business type>]; <role> [<business type>]\n` +
    `Write one ENTITY line for each entity the company belongs to. Use the same ` +
    `company numbers as above, keep the same order, and do not skip any company. ` +
    `After the last company, write one final line: END OF ANSWERS\n` +
    `If you cannot find reliable information about a company, write DESCRIPTION: NONE ` +
    `and ENTITY: NONE for it instead of guessing - never invent what a company does.`
  );
}

// IMPORTANT (Chrome 2025+): `&udm=50` ("AI Mode") must NOT be used here any
// more. Chrome now intercepts a udm=50 navigation and renders it on its own
// internal `chrome://contextual-tasks/...` page instead of loading google.com
// as a normal web page - and extensions are forbidden from injecting into or
// reading any chrome:// page. The symptom is brutal and silent: the engine
// navigates the tab, no content script ever runs, nothing reports back, the
// watchdog eventually fires, and every company in the batch is written off as
// not_found while a perfectly good answer sits rendered on screen.
//
// Staying on a plain https://www.google.com/search URL keeps the page
// scriptable. Google still renders its AI answer panel ("AI Overview") on the
// normal results page for many queries.
//
// The query is long - the whole entity/role list rides along on every search,
// roughly 8-9K characters before URL-encoding. Google accepts URLs well past
// that (checked up to ~29K encoded), so length alone doesn't break the
// request.
//   &hl=en  - keep the answer's language (and so its labels) predictable
//   &pws=0  - no personalized results, so what's scraped doesn't depend on
//             this browser profile's search history
function buildSearchUrl(items) {
  return `https://www.google.com/search?q=${encodeURIComponent(buildPrompt(items))}&hl=en&pws=0`;
}

function isContextualTasksUrl(url) {
  return /^chrome:\/\/contextual-tasks\b/i.test(url || "");
}

// If Chrome hijacked a search into its native AI Mode surface anyway, the
// query is still sitting in that URL's `q` param - rebuild the equivalent
// plain https search so the tab can be bounced back onto a page that can
// actually be read. Returns null if there's no query to recover.
function httpsSearchFromContextualTasks(url) {
  try {
    const raw = url || "";
    const qs = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
    const q = new URLSearchParams(qs).get("q") || "";
    return q ? `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&pws=0` : null;
  } catch {
    return null;
  }
}

function isGoogleSearchTab(tab) {
  if (!tab || !tab.url) return false;
  try {
    const u = new URL(tab.url);
    return u.origin === "https://www.google.com" && u.pathname === "/search";
  } catch {
    return false;
  }
}

// Free text straight out of a third-party-rendered page, so it gets capped
// and stripped rather than trusted: control characters have no business in a
// CSV cell. (Formula-injection in the export is handled separately by
// sanitizeCsvCell in popup.js.)
function sanitizeFreeText(value, maxLen) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
  return cleaned && !/^none$/i.test(cleaned) ? cleaned : null;
}

// An entity or role name. ";" is the separator between roles in the export's
// roles cell, so a name must never contain one or it would read as two roles.
function sanitizeName(value) {
  const cleaned = sanitizeFreeText(value, MAX_NAME_LEN);
  return cleaned ? cleaned.replace(/;/g, ",").replace(/\|/g, "/") || null : null;
}

// Re-validate whatever the content script reported before trusting it - a
// different trust boundary than content.js, which runs inside a live,
// third-party-rendered Google page. This is also where "on the list" is
// decided: the raw entity/role names go through ARF_TAXONOMY.classify, so the
// AI's own claim that a name came from the list is never what decides it.
//
// Status is re-derived rather than taken from the message: "found" means at
// least one entity survived all of the above. A company with a description
// but no entity at all is not_found (its description is still kept), since it
// has nothing to put in either results file.
function sanitizeResultEntry(entry) {
  if (!entry || typeof entry.itemId !== "string") return null;
  if (!ALLOWED_STATUSES.has(entry.status)) return null;
  if (entry.status === "blocked") return { itemId: entry.itemId, status: "blocked" };
  const description = sanitizeFreeText(entry.description, MAX_DESCRIPTION_LEN);
  const raw = (Array.isArray(entry.entities) ? entry.entities : [])
    .slice(0, MAX_ENTITIES_PER_COMPANY)
    .map((e) => ({
      entity: sanitizeName(e && e.entity),
      roles: (Array.isArray(e && e.roles) ? e.roles : []).slice(0, MAX_ROLES_PER_ENTITY).map(sanitizeName).filter(Boolean),
    }))
    .filter((e) => e.entity);
  const classifications = ARF_TAXONOMY.classify(raw);
  return {
    itemId: entry.itemId,
    status: classifications.length ? "found" : "not_found",
    description,
    classifications,
  };
}

// A raw pending count gets silently truncated by Chrome's small badge area
// and isn't very informative anyway. A percentage always fits, and color
// makes "is this actually running" visible without opening the popup.
function updateBadge(engine, project) {
  const total = project ? project.queue.length : 0;
  if (!total || (!engine.isRunning && !engine.isPaused)) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  const done = total - project.queue.filter((c) => c.status === "pending").length;
  chrome.action.setBadgeText({ text: `${Math.round((done / total) * 100)}%` });
  chrome.action.setBadgeBackgroundColor({ color: engine.isPaused ? "#f9a825" : "#0a8043" });
}

// Builds the pause banner text shown while one or more tabs are sitting on
// an unsolved CAPTCHA. `engine` supplies the tabId -> worker -> items
// lookup; `project` is always the single currently-active project. A
// captcha'd tab may have several companies in flight (a whole batch), all
// named here.
function buildCaptchaPauseReason(captchaTabIds, engine, project) {
  const names = captchaTabIds.flatMap((tabId) => {
    const worker = engine.workers.find((w) => w.tabId === tabId);
    if (!worker) return [];
    return (worker.currentItemIds || [])
      .map((id) => project.queue.find((c) => c.id === id))
      .filter(Boolean)
      .map((item) => item.company_name);
  });
  const who = names.length ? names.join(", ") : "a company";
  return (
    `CAPTCHA showing for: ${who}. Solve it in the highlighted tab - the run ` +
    `continues automatically once solved. Nothing else runs while this is up.`
  );
}

function alarmNameForWorker(idx) {
  return `${ALARM_PREFIX}${idx}`;
}

function watchdogNameForWorker(idx) {
  return `${WATCHDOG_PREFIX}${idx}`;
}

function scheduleNext(workerIndex, delayMs) {
  chrome.alarms.create(alarmNameForWorker(workerIndex), { delayInMinutes: Math.max(delayMs / 60000, 0.01) });
}

function armWatchdog(workerIndex, ms) {
  // Creating an alarm with a name that already exists replaces it - this is
  // how handleCaptchaDetected extends an in-flight worker's normal
  // batch-scaled watchdog into the much longer CAPTCHA_WATCHDOG_MS leash
  // (and how a plain-search fallback pass gets a fresh window of its own).
  chrome.alarms.create(watchdogNameForWorker(workerIndex), { delayInMinutes: ms / 60000 });
}

function disarmWatchdog(workerIndex) {
  chrome.alarms.clear(watchdogNameForWorker(workerIndex));
}

function clearAllWorkerAlarms(count) {
  for (let i = 0; i < count; i++) {
    chrome.alarms.clear(alarmNameForWorker(i));
    disarmWatchdog(i);
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

// Ensures worker[workerIndex] has a live tab, creating one if needed. Runs
// the "is the existing tab still alive" check and the "create a new one"
// fallback inside the SAME locked transaction as the write, so two workers
// can't both decide their (identical, stale) tabId is dead and each spin
// up a redundant tab in a race.
async function ensureWorkerTab(workerIndex) {
  const engine = await mutateEngine(async (engine) => {
    const worker = engine.workers[workerIndex];
    if (worker && worker.tabId) {
      try {
        await chrome.tabs.get(worker.tabId);
        return {}; // still alive, nothing to change
      } catch {
        // fall through - tab was closed, need a new one
      }
    }
    const workers = engine.workers.slice();

    // Plain background tabs in whatever window is already open: never
    // activated, never focused, so a run doesn't fight you for the foreground
    // and keeps working with the window minimised or while you're in another
    // app.
    //
    // Chrome does throttle TIMERS in hidden tabs (to ~1/s, then ~1/min once a
    // tab has been hidden a few minutes), which is why content.js's answer
    // wait is driven by a MutationObserver rather than a polling loop - DOM
    // mutations are delivered to hidden tabs normally. REPORT_NOW in
    // handleWatchdogTimeout covers the remaining case of a tab whose timers
    // stalled before it ended its own wait.
    const tab = await chrome.tabs.create({ active: false, url: "about:blank" });
    workers[workerIndex] = {
      ...workers[workerIndex],
      tabId: tab.id,
      windowId: tab.windowId,
      ownsWindow: false, // that window is the user's - cleanup closes the tab only
    };
    return { workers };
  });
  return engine.workers[workerIndex].tabId;
}

// Closes only what this extension opened: a worker's own window if we created
// it, otherwise just its tab. Never closes a window the user opened - hence
// the ownsWindow flag rather than inferring it from windowId.
async function closeWorkerSurfaces(workers) {
  for (const w of workers || []) {
    if (w.ownsWindow && w.windowId != null) {
      try {
        await chrome.windows.remove(w.windowId);
        continue;
      } catch {
        // Already gone - fall through and try the tab directly.
      }
    }
    if (w.tabId != null) {
      try {
        await chrome.tabs.remove(w.tabId);
      } catch {
        // Already closed - nothing to do.
      }
    }
  }
}

// Wakes every worker, spaced out by WORKER_STAGGER_MS. Used by START and
// RESUME (and after the last CAPTCHA clears), all of which otherwise fire N
// simultaneous searches.
function wakeAllWorkers(count) {
  for (let i = 0; i < count; i++) {
    if (i === 0) processNext(0);
    else setTimeout(() => processNext(i), i * WORKER_STAGGER_MS);
  }
}

// Verifies that the URL which actually COMMITTED in a worker's tab is a
// readable https google.com/search page, and repairs it if it isn't.
//
// Two things make this necessary rather than paranoid:
//   1. Chrome can intercept an AI-Mode-ish search and render it on its own
//      chrome://contextual-tasks surface, where no content script may run.
//      The query survives in that URL, so the tab gets bounced straight back
//      onto a plain https search instead of the batch silently dying.
//   2. A declarative content_scripts registration can miss a page that
//      arrives via a client-side (soft) navigation, so content.js is
//      re-injected once the tab finishes loading. Injecting twice is
//      harmless - content.js's own guard makes the second run a no-op.
function watchCommittedUrl(workerIndex, tabId) {
  let bounced = false;
  const check = async () => {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return true; // tab is gone - stop checking
    }
    const url = tab.url || tab.pendingUrl || "";
    if (isContextualTasksUrl(url) && !bounced) {
      const httpsUrl = httpsSearchFromContextualTasks(url);
      console.warn(
        `[AgriRoleFinder] worker ${workerIndex}: Chrome hijacked this search onto ${url.slice(0, 60)}... ` +
          `(its native AI Mode page, which extensions cannot read)` +
          (httpsUrl ? " - bouncing the tab back to a plain google.com search" : " - and the query isn't recoverable from it")
      );
      if (httpsUrl) {
        bounced = true;
        // No `active: true` here: with several workers running, each already
        // owns its window and is the active tab in it, so forcing activation
        // only starts a focus fight between workers.
        await chrome.tabs.update(tabId, { url: httpsUrl });
      }
      return false;
    }
    if (!/^https:\/\/([^/]*\.)?google\.[^/]+\/search/i.test(url)) return false; // still loading - look again
    debug(`worker ${workerIndex}: tab ${tabId} is on a readable page (${tab.status})`);
    // Re-inject in case the declarative registration missed this navigation.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch {
      // Already injected, or the page went away mid-injection - either is fine.
    }
    return true;
  };
  let attempts = 0;
  const tick = async () => {
    attempts++;
    if (await check()) return;
    if (attempts < 12) setTimeout(tick, 1500);
  };
  setTimeout(tick, 2500);
}

async function processNext(workerIndex) {
  const snapshot = await getEngine();
  if (!snapshot.isRunning || snapshot.isPaused || !snapshot.activeProjectId) return;
  if (!snapshot.workers[workerIndex] || (snapshot.workers[workerIndex].currentItemIds || []).length) return;

  const project = await getProject(snapshot.activeProjectId);
  if (!project) {
    await mutateEngine(() => ({ isRunning: false, isPaused: false, activeProjectId: null, workers: [] }));
    chrome.action.setBadgeText({ text: "" });
    return;
  }

  // Claim the next batch of unclaimed pending items for this worker
  // atomically - the check-for-available-items and the claim happen inside
  // one locked transaction, so two workers racing here can never claim the
  // same item.
  let claimed = null;
  const engineAfterClaim = await mutateEngine(async (engine) => {
    if (!engine.isRunning || engine.isPaused) return {}; // stopped/paused since we last checked
    const worker = engine.workers[workerIndex];
    if (!worker || (worker.currentItemIds || []).length) return {}; // already claimed by a previous call
    // Re-read the project INSIDE the lock rather than reusing the snapshot
    // taken above. With several workers running, another one can finish a
    // batch and save its results in between - and against the stale snapshot
    // those companies still look "pending", so this worker would re-claim
    // and re-search work that is already done. Harmless to the data, pure
    // waste of the run's throughput, and it grows with the worker count.
    const fresh = (await getProject(engine.activeProjectId)) || project;
    const inFlightIds = new Set(engine.workers.flatMap((w) => w.currentItemIds || []));
    const pending = fresh.queue.filter((c) => c.status === "pending" && !inFlightIds.has(c.id));
    if (!pending.length) return {};
    // Everything is claimed in batches of project.batchSize. A company a
    // batch answer doesn't cover is recorded not_found by content.js after
    // one reload of that search - recoverable later via "Retry not-found
    // rows" - rather than pulled out for a slow one-at-a-time search.
    claimed = pending.slice(0, project.batchSize || DEFAULT_BATCH_SIZE);
    const workers = engine.workers.slice();
    workers[workerIndex] = {
      ...workers[workerIndex],
      currentItemIds: claimed.map((c) => c.id),
      batchToken: newBatchToken(),
      nudged: false, // one REPORT_NOW nudge is allowed per batch
    };
    return { workers };
  });

  if (!claimed) {
    // Nothing left for this worker right now. If no worker anywhere has
    // anything in flight either, the whole run is done.
    const anyInFlight = (engineAfterClaim.workers || []).some((w) => (w.currentItemIds || []).length);
    if (!anyInFlight) {
      const finished = await mutateEngine(() => ({ isRunning: false }));
      updateBadge(finished, project);
    }
    return;
  }

  const concurrency = clampConcurrency(project.concurrency || 1);
  armWatchdog(workerIndex, computeWatchdogMs(claimed.length));
  const tabId = await ensureWorkerTab(workerIndex);
  const url = buildSearchUrl(claimed);
  debug(
    `worker ${workerIndex}: claimed ${claimed.length} company(ies), navigating tab ${tabId} ` +
      `(watchdog ${Math.round(computeWatchdogMs(claimed.length) / 1000)}s)`,
    claimed.map((c) => c.company_name)
  );
  // Deliberately no `active: true`: worker tabs stay in the background so the
  // run never steals focus and keeps working while the window is minimised.
  chrome.tabs.update(tabId, { url });
  watchCommittedUrl(workerIndex, tabId);
}

// Fires (after computeWatchdogMs(), or CAPTCHA_WATCHDOG_MS for a worker
// that's been sitting on a CAPTCHA - see handleCaptchaDetected) if a
// worker never reported a RESULT for its claimed batch in the meantime,
// and frees the worker so the run keeps moving instead of hanging on it
// forever. A plain stuck tab (bad layout, crash, page never loaded) marks
// every still-pending item in that batch not_found, same as always. A
// CAPTCHA nobody solved in time marks them blocked instead - they
// genuinely do need a manual look - and leaves the run paused rather than
// quietly continuing, since giving up is not the same as solving it.
async function handleWatchdogTimeout(workerIndex) {
  const engine = await getEngine();
  const worker = engine.workers[workerIndex];
  const stuckItemIds = (worker && worker.currentItemIds) || [];
  if (!stuckItemIds.length || !engine.activeProjectId) return; // already resolved normally - nothing to do

  // Last chance before writing this batch off. Worker tabs run hidden, and
  // Chrome throttles a hidden tab's timers hard (roughly once a minute once
  // it's been hidden a few minutes). A tab in that state can be sitting on a
  // complete, perfectly readable answer and simply not have gotten around to
  // ending its own wait. Message delivery is NOT throttled, so asking it
  // directly works where its own timers don't - and a real answer here beats
  // marking five companies not_found, which is final.
  //
  // One attempt per batch (nudged flag), and never for a CAPTCHA stall: that
  // needs a person, not a nudge.
  const isCaptchaStall = worker.tabId != null && engine.captchaTabIds.includes(worker.tabId);
  if (!isCaptchaStall && !worker.nudged && worker.tabId != null) {
    const stuckToken = worker.batchToken;
    let stillWaiting = false;
    try {
      const reply = await chrome.tabs.sendMessage(worker.tabId, { type: "REPORT_NOW" });
      stillWaiting = !!(reply && reply.waiting);
    } catch {
      stillWaiting = false; // nothing listening - the tab really is stuck
    }
    await mutateEngine((e) => {
      const workers = e.workers.slice();
      if (workers[workerIndex] && workers[workerIndex].batchToken === stuckToken) {
        workers[workerIndex] = { ...workers[workerIndex], nudged: true };
      }
      return { workers };
    });
    if (stillWaiting) {
      console.warn(
        `[AgriRoleFinder] worker ${workerIndex}: watchdog reached but the tab was still waiting ` +
          `(throttled hidden tab) - told it to report now, allowing ${Math.round(NUDGE_GRACE_MS / 1000)}s more`
      );
      armWatchdog(workerIndex, NUDGE_GRACE_MS);
      return;
    }
  }

  const project = await getProject(engine.activeProjectId);
  if (!project) return;
  const wasAwaitingCaptcha = worker.tabId != null && engine.captchaTabIds.includes(worker.tabId);
  let anyStillPending = false;
  let sampleCompanyName = null;
  for (const id of stuckItemIds) {
    const item = project.queue.find((c) => c.id === id);
    if (!item || item.status !== "pending") continue; // already resolved normally - nothing to do for this one
    anyStillPending = true;
    sampleCompanyName = sampleCompanyName || item.company_name;
    item.status = wasAwaitingCaptcha ? "blocked" : "not_found";
  }
  if (!anyStillPending) return;

  console.warn(
    `[AgriRoleFinder] watchdog fired for worker ${workerIndex} after ` +
      `${wasAwaitingCaptcha ? Math.round(CAPTCHA_WATCHDOG_MS / 1000) : "the normal"}s - ` +
      `${stuckItemIds.length} company(ies) marked ${wasAwaitingCaptcha ? "blocked" : "not_found"} ` +
      `(no RESULT came back in time; e.g. "${sampleCompanyName}")`
  );

  project.completionLog = [...(project.completionLog || []), Date.now()].slice(-COMPLETION_LOG_SIZE);
  await saveProject(project);
  await updateIndexCounts(project);

  const stuckBatchToken = worker.batchToken;
  const newEngine = await mutateEngine((e) => {
    const workers = e.workers.slice();
    if (workers[workerIndex] && workers[workerIndex].batchToken === stuckBatchToken) {
      workers[workerIndex] = { ...workers[workerIndex], currentItemIds: [], batchToken: null };
    }
    if (!wasAwaitingCaptcha || worker.tabId == null) return { workers };
    const captchaTabIds = e.captchaTabIds.filter((id) => id !== worker.tabId);
    const pauseReason =
      captchaTabIds.length > 0
        ? buildCaptchaPauseReason(captchaTabIds, e, project)
        : `Gave up waiting for a CAPTCHA to be solved (no response after ` +
          `${Math.round(CAPTCHA_WATCHDOG_MS / 60000)} min) on "${sampleCompanyName}"` +
          `${stuckItemIds.length > 1 ? ` and ${stuckItemIds.length - 1} more` : ""} - marked as blocked for ` +
          `manual review. Click Resume to continue with the rest.`;
    return { workers, captchaTabIds, isPaused: true, pauseReason };
  });
  updateBadge(newEngine, project);

  // A plain stuck tab isn't necessarily Google blocking us, so let the run
  // carry on. A CAPTCHA give-up, though, always leaves the run paused
  // (set above) - never auto-resume from giving up.
  if (!wasAwaitingCaptcha && newEngine.isRunning && !newEngine.isPaused) {
    scheduleNext(workerIndex, randomDelayMs(project));
  }
}

// A worker's tab hit a CAPTCHA. Rather than failing that batch of
// companies, this pauses the whole run (other tabs shouldn't keep
// hammering Google while one of them just got challenged) and brings the
// tab to front so it's actually visible to solve - these worker tabs run
// hidden (`active: false`) by design otherwise. The long
// CAPTCHA_WATCHDOG_MS leash (armed here, in place of the normal
// batch-scaled watchdog) is the backstop if nobody ever comes back to it;
// see handleWatchdogTimeout.
async function handleCaptchaDetected(rawMessage, tabId) {
  const engine = await getEngine();
  const workerIndex = engine.workers.findIndex((w) => w.tabId === tabId);
  if (workerIndex === -1) return;
  const worker = engine.workers[workerIndex];
  if (!engine.activeProjectId || !(worker.currentItemIds || []).length) return; // stale/unexpected - ignore
  if (rawMessage.batchToken !== worker.batchToken) return; // this worker has already moved on - ignore

  armWatchdog(workerIndex, CAPTCHA_WATCHDOG_MS);

  const project = await getProject(engine.activeProjectId);
  if (!project) return;

  const newEngine = await mutateEngine((e) => {
    if (e.captchaTabIds.includes(tabId)) return {}; // already flagged - e.g. re-detected after a failed solve attempt
    const captchaTabIds = [...e.captchaTabIds, tabId];
    return { isPaused: true, pauseReason: buildCaptchaPauseReason(captchaTabIds, e, project), captchaTabIds };
  });
  updateBadge(newEngine, project);

  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // Tab/window closed out from under us - nothing more to do here; the
    // watchdog armed above still catches this case if nobody comes back.
  }
}

// content.js got a completely empty answer and is about to reload the same
// search once (see runBatch). That second pass needs its own room to run -
// re-arm a fresh watchdog rather than letting the original one (already most
// of the way through its window) cut it off mid-retry.
async function handleRetrySearch(rawMessage, tabId) {
  const engine = await getEngine();
  const workerIndex = engine.workers.findIndex((w) => w.tabId === tabId);
  if (workerIndex === -1) return;
  const worker = engine.workers[workerIndex];
  if (!engine.activeProjectId || !(worker.currentItemIds || []).length) return;
  if (rawMessage.batchToken !== worker.batchToken) return; // stale - ignore
  armWatchdog(workerIndex, computeWatchdogMs(worker.currentItemIds.length));
}

// Applies one worker's full batch result (every company it was claiming,
// resolved together) in a single pass.
async function handleResult(rawMessage, tabId) {
  if (!rawMessage || !Array.isArray(rawMessage.results)) return; // malformed - drop it

  const engine = await getEngine();
  const workerIndex = engine.workers.findIndex((w) => w.tabId === tabId);
  if (workerIndex === -1) return; // not a recognized worker tab
  const worker = engine.workers[workerIndex];
  if (!engine.activeProjectId || !(worker.currentItemIds || []).length) return; // stale/unexpected - ignore
  if (rawMessage.batchToken !== worker.batchToken) return; // this worker has already moved on to a different batch - a late report from the old one, ignore it

  disarmWatchdog(workerIndex); // got a real result - cancel the stuck-detector for this worker

  debug(
    `RESULT from worker ${workerIndex} (tab ${tabId}):`,
    rawMessage.results.map((r) => ({
      itemId: r && r.itemId,
      status: r && r.status,
      entities: (r && Array.isArray(r.entities) && r.entities.length) || 0,
    }))
  );

  const project = await getProject(engine.activeProjectId);
  if (!project) return;

  const claimedIds = new Set(worker.currentItemIds);
  let anyResolved = false;
  let anyBlocked = false;
  for (const raw of rawMessage.results) {
    if (!raw || !claimedIds.has(raw.itemId)) continue; // not part of this worker's claimed batch - ignore
    const entry = sanitizeResultEntry(raw);
    if (!entry) continue; // malformed/failed re-validation - drop just this entry
    const item = project.queue.find((c) => c.id === entry.itemId);
    if (!item) continue;
    anyResolved = true;

    item.status = entry.status; // "found" | "not_found" | "blocked"
    if (entry.status === "blocked") {
      anyBlocked = true;
      continue; // nothing was read - keep whatever an earlier pass found
    }
    // Never overwrite something with nothing: a "Retry not-found rows" pass
    // that comes back emptier than the first must not blank out a
    // description the first pass did get.
    item.description = entry.description || item.description || null;
    if (entry.status === "found") item.classifications = entry.classifications;
  }

  if (anyResolved) {
    project.completionLog = [...(project.completionLog || []), Date.now()].slice(-COMPLETION_LOG_SIZE);
    await saveProject(project);
    await updateIndexCounts(project);
  }

  const claimedBatchToken = worker.batchToken;
  // Any real result at all - even not_found - means this tab
  // made it past whatever CAPTCHA it was showing (content.js's own
  // last-resort give-up, status "blocked" on every entry, doesn't count as
  // solved). If this was the last outstanding CAPTCHA, the run can resume
  // on its own - that's the whole point of pausing on CAPTCHA instead of
  // just failing the batch.
  const clearedCaptcha = !anyBlocked;
  let resolvingLastCaptcha = false;

  const newEngine = await mutateEngine((e) => {
    const workers = e.workers.slice();
    // Only clear if this worker still points at the same batch - defends
    // against any unexpected reordering of concurrent messages.
    if (workers[workerIndex] && workers[workerIndex].batchToken === claimedBatchToken) {
      workers[workerIndex] = { ...workers[workerIndex], currentItemIds: [], batchToken: null };
    }
    const wasCaptchaTab = e.captchaTabIds.includes(tabId);
    if (!wasCaptchaTab) return { workers };
    const captchaTabIds = e.captchaTabIds.filter((id) => id !== tabId);
    resolvingLastCaptcha = clearedCaptcha && e.isPaused && captchaTabIds.length === 0;
    return {
      workers,
      captchaTabIds,
      ...(resolvingLastCaptcha
        ? { isPaused: false, pauseReason: null }
        : captchaTabIds.length > 0
        ? { pauseReason: buildCaptchaPauseReason(captchaTabIds, e, project) }
        : {}),
    };
  });
  updateBadge(newEngine, project);

  if (resolvingLastCaptcha) {
    // Same as clicking Resume by hand - wake every worker, not just this
    // one, since their scheduled alarms already fired-and-no-opped while
    // paused (see the "RESUME" message handler below for the same pattern).
    wakeAllWorkers(newEngine.workers.length);
    return;
  }

  if (newEngine.isRunning && !newEngine.isPaused) {
    scheduleNext(workerIndex, randomDelayMs(project));
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(WATCHDOG_PREFIX)) {
    const idx = Number(alarm.name.slice(WATCHDOG_PREFIX.length));
    if (Number.isInteger(idx)) handleWatchdogTimeout(idx);
    return;
  }
  if (alarm.name.startsWith(ALARM_PREFIX)) {
    const idx = Number(alarm.name.slice(ALARM_PREFIX.length));
    if (Number.isInteger(idx)) processNext(idx);
  }
});

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Defense in depth: Chrome already blocks other extensions/web pages
  // from reaching us here (we don't declare externally_connectable), but
  // verify explicitly anyway, and make sure each message type only comes
  // from the context it's supposed to (content script on an actual Google
  // search tab, vs. the popup).
  if (sender.id !== chrome.runtime.id) return false;
  if (CONTENT_SCRIPT_TYPES.has(message?.type) && !isGoogleSearchTab(sender.tab)) return false;
  if (POPUP_TYPES.has(message?.type) && sender.tab) return false;

  (async () => {
    switch (message.type) {
      case "GET_CURRENT": {
        const engine = await getEngine();
        const workerIndex = engine.workers.findIndex((w) => w.tabId === sender.tab.id);
        if (workerIndex === -1 || !engine.activeProjectId) {
          debug(`GET_CURRENT from tab ${sender.tab.id}: not a worker tab of an active run - leaving that page alone`);
          sendResponse(null);
          return;
        }
        const worker = engine.workers[workerIndex];
        if (!(worker.currentItemIds || []).length) {
          debug(`GET_CURRENT from worker ${workerIndex} (tab ${sender.tab.id}): nothing claimed right now`);
          sendResponse(null);
          return;
        }
        const project = await getProject(engine.activeProjectId);
        const items = project
          ? worker.currentItemIds.map((id) => project.queue.find((c) => c.id === id)).filter(Boolean)
          : [];
        debug(
          `GET_CURRENT -> worker ${workerIndex} (tab ${sender.tab.id}) handed ${items.length} company(ies) - ` +
            `content script is running on that page`
        );
        sendResponse(
          items.length
            ? {
                // Echoed back on every RESULT/CAPTCHA_DETECTED/
                // RETRY_SEARCH this content script sends, so a late/
                // stale message from a batch this worker has since moved
                // on from can be told apart and dropped instead of
                // misfiled against the wrong companies.
                batchToken: worker.batchToken,
                // Only what content.js needs to report back: the question
                // itself is already in the page's URL.
                items: items.map((item) => ({
                  itemId: item.id,
                  company_name: item.company_name,
                })),
              }
            : null
        );
        return;
      }
      case "RESULT": {
        await handleResult(message, sender.tab.id);
        sendResponse({ ok: true });
        return;
      }
      case "CAPTCHA_DETECTED": {
        await handleCaptchaDetected(message, sender.tab.id);
        sendResponse({ ok: true });
        return;
      }
      case "RETRY_SEARCH": {
        // "I'm starting another full pass in this same tab" - the in-flight
        // batch needs a fresh watchdog window or the one armed for the first
        // pass fires mid-retry and writes the batch off.
        await handleRetrySearch(message, sender.tab.id);
        sendResponse({ ok: true });
        return;
      }
      case "CREATE_PROJECT": {
        if (!message.name || !Array.isArray(message.companies) || !message.companies.length) {
          sendResponse({ ok: false, error: "A project name and at least one company are required." });
          return;
        }
        const project = makeProject(
          message.name, message.companies, message.columns, message.delayMinSec, message.delayMaxSec,
          message.concurrency, message.batchSize
        );
        // Which input header each field was read from - shown in the popup so
        // a wrong auto-detection is visible before a long run, not after.
        project.detected = {};
        for (const [field, header] of Object.entries(message.detected || {})) {
          if (typeof header === "string") project.detected[field] = header.slice(0, 200);
        }
        await saveProject(project);
        const index = await getProjectIndex();
        index[project.id] = {
          name: project.name,
          createdAt: project.createdAt,
          total: project.queue.length,
          counts: countsOf(project.queue),
        };
        await saveProjectIndex(index);
        sendResponse({ ok: true, projectId: project.id });
        return;
      }
      case "UPDATE_PROJECT_SETTINGS": {
        // Delay/concurrency/batch size used to be fixable only at creation,
        // which meant the popup's fields could show a value that didn't
        // match the actually-selected project at all. Now they're editable
        // for an existing project too, just not while it's the one
        // currently running (changing a running engine's worker count
        // isn't supported - stop it first).
        const engineNow = await getEngine();
        if (engineNow.activeProjectId === message.projectId && (engineNow.isRunning || engineNow.isPaused)) {
          sendResponse({ ok: false, error: "Stop this project before changing its settings." });
          return;
        }
        const project = await getProject(message.projectId);
        if (!project) {
          sendResponse({ ok: false, error: "Project not found." });
          return;
        }
        project.delayMinSec = message.delayMinSec || project.delayMinSec;
        project.delayMaxSec = message.delayMaxSec || project.delayMaxSec;
        project.concurrency = clampConcurrency(message.concurrency || project.concurrency);
        project.batchSize = clampBatchSize(message.batchSize || project.batchSize);
        await saveProject(project);
        sendResponse({ ok: true });
        return;
      }
      case "RETRY_NOT_FOUND": {
        // not_found rows are otherwise never revisited - re-queues every one
        // for a fresh attempt. Google's AI answer often differs on a second
        // try, and a company skipped in one batch answer may well be covered
        // when asked alongside different companies.
        const engineNow = await getEngine();
        if (engineNow.activeProjectId === message.projectId && (engineNow.isRunning || engineNow.isPaused)) {
          sendResponse({ ok: false, error: "Stop this project before retrying." });
          return;
        }
        const project = await getProject(message.projectId);
        if (!project) {
          sendResponse({ ok: false, error: "Project not found." });
          return;
        }
        let count = 0;
        for (const item of project.queue) {
          if (item.status === "not_found") {
            item.status = "pending";
            count++;
          }
        }
        if (count > 0) {
          await saveProject(project);
          await updateIndexCounts(project);
        }
        sendResponse({ ok: true, count });
        return;
      }
      case "DELETE_PROJECT": {
        const index = await getProjectIndex();
        if (!index[message.projectId]) {
          sendResponse({ ok: false, error: "Project not found." });
          return;
        }
        const engineBefore = await getEngine();
        if (engineBefore.activeProjectId === message.projectId && (engineBefore.isRunning || engineBefore.isPaused)) {
          clearAllWorkerAlarms(engineBefore.workers.length);
          await closeWorkerSurfaces(engineBefore.workers);
          await mutateEngine(() => ({
            isRunning: false,
            isPaused: false,
            pauseReason: null,
            activeProjectId: null,
            captchaTabIds: [],
            workers: [],
          }));
          chrome.action.setBadgeText({ text: "" });
        }
        delete index[message.projectId];
        await saveProjectIndex(index);
        await deleteProjectStorage(message.projectId);
        sendResponse({ ok: true });
        return;
      }
      case "START": {
        const engineBefore = await getEngine();
        if (engineBefore.isRunning && engineBefore.activeProjectId && engineBefore.activeProjectId !== message.projectId) {
          sendResponse({ ok: false, error: "Another project is currently running - stop it first." });
          return;
        }
        const project = await getProject(message.projectId);
        if (!project) {
          sendResponse({ ok: false, error: "Project not found." });
          return;
        }
        const concurrency = clampConcurrency(project.concurrency || 1);
        const started = await mutateEngine((engine) => {
          // Reuse existing workers/tabs if resuming the SAME project with
          // the same concurrency, instead of opening fresh tabs every time.
          const reuse = engine.activeProjectId === message.projectId && engine.workers.length === concurrency;
          const workers = reuse
            ? engine.workers
            : Array.from({ length: concurrency }, () => ({
                tabId: null,
                windowId: null,
                ownsWindow: false,
                currentItemIds: [],
                batchToken: null,
              }));
          return {
            activeProjectId: message.projectId,
            isRunning: true,
            isPaused: false,
            pauseReason: null,
            captchaTabIds: [],
            workers,
          };
        });
        updateBadge(started, project);
        wakeAllWorkers(started.workers.length);
        sendResponse({ ok: true });
        return;
      }
      case "STOP": {
        const before = await getEngine();
        clearAllWorkerAlarms(before.workers.length);
        // Close the windows/tabs this run opened. At concurrency 1 that's one
        // tab; at 8 it's eight windows, and leaving those lying around after
        // Stop is its own kind of mess. closeWorkerSurfaces only ever closes
        // what the extension itself created (see ownsWindow).
        await closeWorkerSurfaces(before.workers);
        const stopped = await mutateEngine((engine) => ({
          isRunning: false,
          isPaused: false,
          captchaTabIds: [],
          workers: engine.workers.map((w) => ({
            ...w,
            tabId: null,
            windowId: null,
            ownsWindow: false,
            currentItemIds: [],
            batchToken: null,
          })),
        }));
        const project = stopped.activeProjectId ? await getProject(stopped.activeProjectId) : null;
        updateBadge(stopped, project);
        sendResponse({ ok: true });
        return;
      }
      case "RESUME": {
        const engineBefore = await getEngine();
        const project = engineBefore.activeProjectId ? await getProject(engineBefore.activeProjectId) : null;
        if (!project) {
          sendResponse({ ok: false, error: "That project no longer exists." });
          return;
        }
        const resumed = await mutateEngine(() => ({
          isRunning: true,
          isPaused: false,
          pauseReason: null,
        }));
        updateBadge(resumed, project);
        wakeAllWorkers(resumed.workers.length);
        sendResponse({ ok: true });
        return;
      }
      case "GET_STATE": {
        const [engine, index] = await Promise.all([getEngine(), getProjectIndex()]);
        const summaries = Object.entries(index)
          .map(([id, meta]) => ({ id, ...meta }))
          .sort((a, b) => b.createdAt - a.createdAt);
        sendResponse({ engine, summaries });
        return;
      }
      case "GET_PROJECT": {
        sendResponse(await getProject(message.projectId));
        return;
      }
      default:
        sendResponse(null);
    }
  })();
  return true; // keep the message channel open for the async work above
});
