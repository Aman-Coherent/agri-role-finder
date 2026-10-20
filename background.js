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
 *   arfProject_<id>         -> a project's meta (settings, counts) - its
 *   arfChunk_<id>_<n>          companies live in pieces of 500 alongside it;
 *                              see store.js for the layout and why.
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

importScripts("taxonomy.js", "store.js"); // define globalThis.ARF_TAXONOMY and ARF_STORE

const PROJECT_INDEX_KEY = "arfProjectIndex";
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
// content.js waits at most 60s + 20s per company (120s for 3, 260s for 10);
// this stays well above that at every batch size (80s + 20s per company more).
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
// No upper limit on companies per search - that trade-off is the user's: a
// bigger batch means fewer searches (and fewer AI requests against Google's
// limit), but a longer answer the AI is more likely to cut short; companies
// it skips get their second try in a later batch. The one hard ceiling is
// technical - see MAX_SEARCH_URL_LEN.
// Lower than the sibling extension's 5: every company's answer here is a
// description plus several entity lines, so a batch answer is several times
// longer and the AI is more likely to cut it short.
const DEFAULT_BATCH_SIZE = 3;

// How many times a company may get NO answer (its block missing from the
// reply, or the tab never reporting back) before it is recorded not_found.
// See settleUnanswered.
const MAX_ATTEMPTS = 2;
// This many batches in a row with no answer at all pauses the run - see
// emptyStreakPatch.
const EMPTY_STREAK_LIMIT = 4;
// Google caps how many AI answers one account gets in a while ("You've
// reached the request limit for AI responses at the moment"). When a tab
// hits it, the whole run pauses for a cool-down and then resumes by itself.
// The first wait is short - Google only says "a little while" - and each hit
// in a row doubles it, so a limit that hasn't lifted isn't asked about every
// few minutes; back to the first once answers come through again. See
// handleAiLimited.
const AI_LIMIT_ALARM = "arf-ai-cooldown";
const AI_LIMIT_COOLDOWNS_MIN = [5, 10, 20, 40, 60];
// How many times the extension may move one batch's tab around while a
// CAPTCHA is being dealt with - see renavigateWorkerTab. The normal long-
// query CAPTCHA takes 2 (to the short search, then back to the real one);
// the rest is room for Google's redirects landing somewhere unexpected.
const MAX_RENAVIGATIONS = 4;

// The short search a worker tab is sent to when Google's CAPTCHA page for
// the real (very long) query can't even display - see handleWorkerTabUrl.
// Any short query works; this one is simply harmless and recognisable.
const CAPTCHA_LANDING_QUERY = "agriculture companies";
const CAPTCHA_LANDING_URL = `https://www.google.com/search?q=${encodeURIComponent(CAPTCHA_LANDING_QUERY)}&hl=en&pws=0`;
// Longer than this, Google's CAPTCHA page fails with "400. That's an error"
// instead of showing a CAPTCHA, because it carries the whole blocked search
// in its own address. A short query's CAPTCHA page is a few hundred
// characters; this extension's real one is tens of thousands.
const MAX_WORKING_SORRY_URL_LEN = 4000;

// "found" here means "classified into at least one entity" - see
// sanitizeResultEntry. "missing" is never stored: it is content.js saying
// "no answer for this company this time", which handleResult turns into
// another try or not_found.
const ALLOWED_STATUSES = new Set(["found", "not_found", "blocked", "missing"]);

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
const CONTENT_SCRIPT_TYPES = new Set(["GET_CURRENT", "RESULT", "CAPTCHA_DETECTED", "RETRY_SEARCH", "AI_LIMITED"]);
const POPUP_TYPES = new Set([
  "CREATE_PROJECT", "UPDATE_PROJECT_SETTINGS", "RETRY_NOT_FOUND", "DELETE_PROJECT",
  "START", "STOP", "RESUME", "GET_STATE", "GET_PROJECT",
]);

const DEFAULT_ENGINE = {
  activeProjectId: null,
  isRunning: false,
  isPaused: false,
  pauseReason: null,
  // Why the run is paused, which decides what may un-pause it on its own:
  // a "captcha" pause lifts once every CAPTCHA is dealt with, an "ai_limit"
  // pause when its cool-down alarm fires. "captcha_giveup" | "empty_streak" |
  // "manual" wait for Resume.
  pauseKind: null,
  // Google AI-limit hits in a row (picks the next cool-down) and when the
  // current cool-down ends - see handleAiLimited.
  aiLimitHits: 0,
  resumeAt: null,
  // tabIds of workers currently sitting on an unsolved CAPTCHA or consent
  // page - non-empty implies isPaused. See markNeedsHuman.
  captchaTabIds: [],
  // { [tabId]: "captcha" | "consent" } for those tabs - only changes the
  // wording of the pause message.
  humanKinds: {},
  // Batches in a row that came back with no answer at all - see
  // emptyStreakPatch.
  emptyStreak: 0,
  // [{ tabId, windowId, ownsWindow, currentItemIds, batchToken, searchUrl }, ...] -
  // length === the active project's concurrency. `ownsWindow` records whether
  // THIS extension created that window (concurrency > 1 gives each worker its
  // own window - see ensureWorkerTab). It exists so cleanup can close what we
  // opened without ever closing a window the user opened themselves.
  // `searchUrl` is the batch's own search, so a tab that lands somewhere
  // else after a CAPTCHA can be sent back to it.
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

function newBatchToken() {
  return `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function clampConcurrency(n) {
  const v = Math.round(Number(n) || 1);
  return Math.max(1, Math.min(v, MAX_CONCURRENCY));
}

function clampBatchSize(n) {
  const v = Math.round(Number(n) || DEFAULT_BATCH_SIZE);
  return Math.max(MIN_BATCH_SIZE, v);
}

// The longest search link this extension will send. Every company adds ~100-
// 150 characters to the ~13,600 the question itself takes; Google was
// checked to accept links up to ~29,000. A batch whose link would be longer
// is claimed with as many companies as fit - the rest simply wait for the
// next search - rather than sending a request Google may reject outright.
const MAX_SEARCH_URL_LEN = 29000;

// ---------------------------------------------------------------------------
// Project storage - in pieces of ARF_STORE.CHUNK_SIZE companies; see store.js
// for the layout and why.
//
// Every read-modify-write of project data goes through withDataLock, the
// same chaining pattern as the engine lock below. Without it, two tabs whose
// answers arrive at the same moment could each read a piece, add their own
// results, and write it back - and the second write would silently erase the
// first tab's results.
// ---------------------------------------------------------------------------

async function getProjectIndex() {
  const data = await chrome.storage.local.get(PROJECT_INDEX_KEY);
  return data[PROJECT_INDEX_KEY] || {};
}

async function saveProjectIndex(index) {
  await chrome.storage.local.set({ [PROJECT_INDEX_KEY]: index });
}

// A project's meta (no companies - see readChunk). Records in the old
// single-record layout are converted by migrateLegacyProjects, never read
// here.
async function getMeta(pid) {
  if (!pid) return null;
  const key = ARF_STORE.metaKey(pid);
  const data = await chrome.storage.local.get(key);
  const meta = data[key];
  return meta && !meta.queue ? meta : null;
}

async function readChunk(pid, n) {
  const key = ARF_STORE.chunkKey(pid, n);
  const data = await chrome.storage.local.get(key);
  return data[key] || [];
}

let dataLock = Promise.resolve();

function withDataLock(fn) {
  const result = dataLock.then(fn, fn);
  dataLock = result.then(
    () => {},
    () => {}
  );
  return result;
}

async function updateIndexCounts(meta) {
  const index = await getProjectIndex();
  if (!index[meta.id]) return;
  index[meta.id] = { ...index[meta.id], total: meta.total, counts: meta.counts };
  await saveProjectIndex(index);
}

// Writes the changed pieces and the meta (whose counts are recomputed from
// those pieces) in ONE storage call, so counts and companies can't drift
// apart. Must be called inside withDataLock.
async function commitChunks(meta, chunks, logCompletion) {
  const entries = {};
  const chunkCounts = meta.chunkCounts.slice();
  for (const [n, items] of chunks) {
    entries[ARF_STORE.chunkKey(meta.id, n)] = items;
    chunkCounts[n] = ARF_STORE.countsOfItems(items);
  }
  const next = {
    ...meta,
    chunkCounts,
    counts: ARF_STORE.sumCounts(chunkCounts),
    completionLog: logCompletion
      ? [...(meta.completionLog || []), Date.now()].slice(-COMPLETION_LOG_SIZE)
      : meta.completionLog || [],
  };
  entries[ARF_STORE.metaKey(meta.id)] = next;
  await chrome.storage.local.set(entries);
  await updateIndexCounts(next);
  return next;
}

// Read-modify-write of specific companies. Only the pieces they live in are
// read and rewritten. `mutate(byId, meta)` changes items in place and may
// return { logCompletion: true } to count this as a finished batch for the
// rate/ETA. Resolves to the updated meta (null if the project is gone).
function updateItems(pid, ids, mutate) {
  return withDataLock(async () => {
    const meta = await getMeta(pid);
    if (!meta) return null;
    const chunks = new Map();
    const byId = new Map();
    for (const n of new Set(ids.map(ARF_STORE.chunkOfId))) {
      if (n < 0 || n >= meta.chunkCount) continue;
      const items = await readChunk(pid, n);
      chunks.set(n, items);
      for (const it of items) byId.set(it.id, it);
    }
    const outcome = (await mutate(byId, meta)) || {};
    return chunks.size ? commitChunks(meta, chunks, !!outcome.logCompletion) : meta;
  });
}

// The same for every company with a given status ("Retry not-found rows",
// Resume re-queueing blocked ones). The per-piece counts mean only pieces
// that actually hold such a company are read.
function updateItemsWithStatus(pid, status, mutate) {
  return withDataLock(async () => {
    const meta = await getMeta(pid);
    if (!meta) return { meta: null, count: 0 };
    const chunks = new Map();
    let count = 0;
    for (let n = 0; n < meta.chunkCount; n++) {
      if (!meta.chunkCounts[n] || !meta.chunkCounts[n][status]) continue;
      const items = await readChunk(pid, n);
      for (const it of items) {
        if (it.status !== status) continue;
        mutate(it);
        count++;
      }
      chunks.set(n, items);
    }
    return { meta: chunks.size ? await commitChunks(meta, chunks, false) : meta, count };
  });
}

// Settings and other changes to the meta alone.
function updateMeta(pid, mutate) {
  return withDataLock(async () => {
    const meta = await getMeta(pid);
    if (!meta) return null;
    mutate(meta);
    await chrome.storage.local.set({ [ARF_STORE.metaKey(pid)]: meta });
    return meta;
  });
}

// Up to `limit` pending companies that no worker is already searching, in
// file order. Pieces with nothing pending are skipped on their counts alone,
// so a nearly finished 50,000-company project doesn't read every piece to
// find the last few.
async function findPending(meta, excludeIds, limit) {
  const picked = [];
  for (let n = 0; n < meta.chunkCount && picked.length < limit; n++) {
    if (!meta.chunkCounts[n] || !meta.chunkCounts[n].pending) continue;
    for (const it of await readChunk(meta.id, n)) {
      if (it.status !== "pending" || excludeIds.has(it.id)) continue;
      picked.push(it);
      if (picked.length >= limit) break;
    }
  }
  return picked;
}

// Registers a project whose pieces the popup has already written (see
// createProject in popup.js - the company list itself is far too big to send
// in a message). Every piece is read back once to check it is really there
// and to count it, so a half-finished import can never become a project with
// companies silently missing.
function createProjectFromChunks(message) {
  return withDataLock(async () => {
    const pid = String(message.projectId || "");
    const total = Number(message.total);
    const chunkCount = Number(message.chunkCount);
    if (!ARF_STORE.PROJECT_ID_RE.test(pid)) return { ok: false, error: "Invalid project id." };
    if (!message.name || !Number.isInteger(total) || total < 1) {
      return { ok: false, error: "A project name and at least one company are required." };
    }
    if (chunkCount !== Math.ceil(total / ARF_STORE.CHUNK_SIZE)) return { ok: false, error: "The import is incomplete." };
    const index = await getProjectIndex();
    if (index[pid]) return { ok: false, error: "That project already exists." };

    const chunkCounts = [];
    for (let n = 0; n < chunkCount; n++) {
      const items = await readChunk(pid, n);
      if (!items.length) return { ok: false, error: `The import is incomplete (part ${n + 1} of ${chunkCount} is missing).` };
      chunkCounts.push(ARF_STORE.countsOfItems(items));
    }
    const counts = ARF_STORE.sumCounts(chunkCounts);
    const stored = ARF_STORE.STATUSES.reduce((s, k) => s + counts[k], 0);
    if (stored !== total) return { ok: false, error: `The import is incomplete (${stored} of ${total} companies saved).` };

    const detected = {};
    for (const [field, header] of Object.entries(message.detected || {})) {
      if (typeof header === "string") detected[field] = header.slice(0, 200);
    }
    const meta = {
      id: pid,
      name: String(message.name).trim().slice(0, 120) || "Untitled project",
      createdAt: Date.now(),
      // Which input header each field was read from - shown in the popup so
      // a wrong auto-detection is visible before a long run, not after.
      detected,
      total,
      chunkCount,
      chunkCounts,
      counts,
      delayMinSec: Number(message.delayMinSec) || 8,
      delayMaxSec: Number(message.delayMaxSec) || 15,
      // How many tabs run this project's queue at once. More = faster, but
      // more simultaneous traffic from one IP = higher block risk.
      concurrency: clampConcurrency(message.concurrency),
      // How many companies go into one search - see the file-level comment.
      batchSize: clampBatchSize(message.batchSize),
      completionLog: [],
    };
    await chrome.storage.local.set({ [ARF_STORE.metaKey(pid)]: meta });
    index[pid] = { name: meta.name, createdAt: meta.createdAt, total, counts };
    await saveProjectIndex(index);
    return { ok: true, projectId: pid };
  });
}

function projectDataKeys(pid, chunkCount) {
  const keys = [ARF_STORE.metaKey(pid)];
  for (let n = 0; n < chunkCount; n++) keys.push(ARF_STORE.chunkKey(pid, n));
  return keys;
}

// Leftovers of an import that never finished (the popup was closed half-way
// through writing pieces) belong to no project. chrome.storage.local.getKeys
// lists keys without loading their values; on a Chrome too old to have it,
// this simply does nothing.
async function cleanupOrphanData() {
  if (typeof chrome.storage.local.getKeys !== "function") return;
  const index = await getProjectIndex();
  const keys = await chrome.storage.local.getKeys();
  const orphans = keys.filter((k) => {
    const m = k.match(/^arf(?:Project|Chunk)_(proj_[a-z0-9]+_[a-z0-9]+)/);
    return m && !index[m[1]];
  });
  if (orphans.length) {
    await chrome.storage.local.remove(orphans);
    debug(`removed ${orphans.length} piece(s) left over from unfinished imports`);
  }
}

// Projects saved by the first version of this extension were one record with
// the whole queue inside. Converted once, in place, keeping every result.
async function migrateLegacyProjects() {
  const index = await getProjectIndex();
  for (const pid of Object.keys(index)) {
    const key = ARF_STORE.metaKey(pid);
    const legacy = (await chrome.storage.local.get(key))[key];
    if (!legacy || !Array.isArray(legacy.queue)) continue;
    const queue = legacy.queue;
    const chunks = ARF_STORE.buildChunks(queue);
    const entries = {};
    const chunkCounts = [];
    for (const { n, items } of chunks) {
      items.forEach((it, i) => {
        const old = queue[n * ARF_STORE.CHUNK_SIZE + i];
        Object.assign(it, {
          status: old.status === "pending" || ARF_STORE.STATUSES.includes(old.status) ? old.status : "pending",
          attempts: old.attempts || 0,
          description: old.description || null,
          classifications: old.classifications || [],
        });
      });
      entries[ARF_STORE.chunkKey(pid, n)] = items;
      chunkCounts.push(ARF_STORE.countsOfItems(items));
    }
    const { queue: _dropped, columns: _cols, ...rest } = legacy;
    const counts = ARF_STORE.sumCounts(chunkCounts);
    entries[key] = { ...rest, total: queue.length, chunkCount: chunks.length, chunkCounts, counts };
    await chrome.storage.local.set(entries);
    index[pid] = { ...index[pid], total: queue.length, counts };
    await saveProjectIndex(index);
    debug(`converted project ${pid} to the piece-by-piece layout`);
  }
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
    `Reply in exactly this format and nothing else - no greeting, no explanation, ` +
    `no markdown, no tables:\n` +
    `COMPANY <number>\n` +
    `DESCRIPTION: <2-3 sentences on one line>\n` +
    `ENTITY: <entity name> | ROLES: <role> [<business type>]; <role> [<business type>]\n` +
    `Write one ENTITY line for each entity the company belongs to. Use the same ` +
    `company numbers as above, keep the same order, and do not skip any company. ` +
    `After the last company, write one final line: END OF ANSWERS\n` +
    `If you cannot find reliable information about a company, write DESCRIPTION: NONE ` +
    `and ENTITY: NONE for it instead of guessing - never invent what a company does.\n\n` +
    // The long list goes LAST: if Google ever cuts a very long query short,
    // what is lost is the end of the list - not the reply format above,
    // without which no answer could be read at all.
    `LIST - each line is an entity, a colon, then that entity's roles separated by semicolons:\n` +
    `${ARF_TAXONOMY.promptList()}`
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

function isGoogleUrl(url) {
  return /^https:\/\/([^/]*\.)?google\.[a-z.]+\//i.test(url || "");
}

function isGoogleSearchUrl(url) {
  return /^https:\/\/([^/]*\.)?google\.[a-z.]+\/search\b/i.test(url || "");
}

// Google's "unusual traffic" CAPTCHA page. A search it is suspicious of is
// redirected here, so the results page - and content.js with it - never
// loads at all. See handleWorkerTabUrl.
function isSorryUrl(url) {
  return /^https:\/\/([^/]*\.)?google\.[a-z.]+\/sorry\//i.test(url || "");
}

// The short stand-in search used to get a working CAPTCHA (see
// CAPTCHA_LANDING_URL) - never a batch's own search.
function isCaptchaLandingUrl(url) {
  if (!isGoogleSearchUrl(url)) return false;
  try {
    return new URL(url).searchParams.get("q") === CAPTCHA_LANDING_QUERY;
  } catch {
    return false;
  }
}

// Google's cookie-consent page ("Before you continue"), shown to some regions
// before any search. Needs one click from a person, exactly like a CAPTCHA.
function isConsentUrl(url) {
  return /^https:\/\/consent\.google\.[a-z.]+\//i.test(url || "");
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
  if (entry.status === "blocked" || entry.status === "missing") return { itemId: entry.itemId, status: entry.status };
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
function updateBadge(engine, meta) {
  const total = meta ? meta.total : 0;
  if (!total || (!engine.isRunning && !engine.isPaused)) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  const done = total - ((meta.counts && meta.counts.pending) || 0);
  chrome.action.setBadgeText({ text: `${Math.round((done / total) * 100)}%` });
  chrome.action.setBadgeBackgroundColor({ color: engine.isPaused ? "#f9a825" : "#0a8043" });
}

// Builds the pause banner text shown while one or more tabs are sitting on
// an unsolved CAPTCHA. A captcha'd tab may have several companies in flight
// (a whole batch), all named here - from the names each worker keeps for its
// batch (currentNames), so this needs no project read.
function buildCaptchaPauseReason(captchaTabIds, engine) {
  const names = captchaTabIds.flatMap((tabId) => {
    const worker = engine.workers.find((w) => w.tabId === tabId);
    return worker ? worker.currentNames || [] : [];
  });
  const who = names.length ? names.join(", ") : "a company";
  const kinds = captchaTabIds.map((id) => (engine.humanKinds || {})[id] || "captcha");
  if (kinds.every((k) => k === "consent")) {
    return (
      `Google is asking you to accept or reject cookies (once) in the highlighted tab, ` +
      `while searching for: ${who}. Answer it there - the run continues automatically after.`
    );
  }
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

  const project = await getMeta(snapshot.activeProjectId);
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
  let searchUrl = null;
  const engineAfterClaim = await mutateEngine(async (engine) => {
    if (!engine.isRunning || engine.isPaused) return {}; // stopped/paused since we last checked
    const worker = engine.workers[workerIndex];
    if (!worker || (worker.currentItemIds || []).length) return {}; // already claimed by a previous call
    // Re-read the project INSIDE the lock rather than reusing the snapshot
    // taken above. With several workers running, another one can finish a
    // batch and save its results in between - and against the stale snapshot
    // those companies still look "pending", so this worker would re-claim
    // and re-search work that is already done. (A batch's results are saved
    // BEFORE its worker is freed - see handleResult - so a company is always
    // either still in flight here or already saved, never neither.)
    //
    // Everything is claimed in batches of project.batchSize. A company a
    // batch answer doesn't cover goes back in the queue once (joining a
    // later batch - see settleUnanswered) rather than being pulled out for a
    // slow one-at-a-time search.
    const fresh = (await getMeta(engine.activeProjectId)) || project;
    const inFlightIds = new Set(engine.workers.flatMap((w) => w.currentItemIds || []));
    const pending = await findPending(fresh, inFlightIds, project.batchSize || DEFAULT_BATCH_SIZE);
    if (!pending.length) return {};
    claimed = pending;
    searchUrl = buildSearchUrl(claimed);
    while (searchUrl.length > MAX_SEARCH_URL_LEN && claimed.length > 1) {
      claimed = claimed.slice(0, -1);
      searchUrl = buildSearchUrl(claimed);
    }
    const workers = engine.workers.slice();
    workers[workerIndex] = {
      ...workers[workerIndex],
      currentItemIds: claimed.map((c) => c.id),
      // Shown in the popup and the CAPTCHA message without reading the
      // project's pieces every few seconds.
      currentNames: claimed.map((c) => c.company_name),
      batchToken: newBatchToken(),
      searchUrl,
      renavigations: 0,
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
  const url = searchUrl;
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

// ---------------------------------------------------------------------------
// Outcomes that need a decision: no answer, a stuck tab, a CAPTCHA
// ---------------------------------------------------------------------------

// A company that got no answer this time - its block was missing from the
// AI's reply, or the tab never reported back at all. That says nothing about
// the company itself (the AI skipped it, the page failed to load, Google
// had a bad moment), so the first time it simply goes back in the queue and
// joins a later batch alongside different companies. Only after
// MAX_ATTEMPTS is it recorded not_found.
//
// An answer that explicitly said NONE is different - the AI looked and
// didn't know - and is final straight away (see handleResult).
function settleUnanswered(item) {
  item.attempts = (item.attempts || 0) + 1;
  item.status = item.attempts >= MAX_ATTEMPTS ? "not_found" : "pending";
}

function workerIndexForTab(engine, tabId) {
  return engine.workers.findIndex((w) => w.tabId === tabId);
}

// The engine patch for one more batch that came back with nothing at all
// (or never came back). Several in a row means something is wrong for every
// company, not just these - the network is down, or Google's page changed
// so nothing can be read - so the run pauses instead of quietly working
// through the rest of the list marking everything not_found. `answered`
// resets the streak.
//
// A results page that loaded fine but simply had no AI answer (content.js
// reports noAiAnswer) does NOT count: nothing is broken, Google just didn't
// answer that search, and the run should move straight on - see handleResult.
function emptyStreakPatch(e, answered) {
  if (answered) return { emptyStreak: 0 };
  const emptyStreak = (e.emptyStreak || 0) + 1;
  if (emptyStreak < EMPTY_STREAK_LIMIT || !e.isRunning || e.isPaused) return { emptyStreak };
  return {
    emptyStreak,
    isPaused: true,
    pauseKind: "empty_streak",
    pauseReason:
      `No answers came back for ${emptyStreak} searches in a row, so the run paused instead of marking ` +
      `everything not found. Check one of the Google tabs (internet down? Google showing no AI answer?), ` +
      `then click Resume.`,
  };
}

// Fires (after computeWatchdogMs(), or CAPTCHA_WATCHDOG_MS for a worker
// that's been sitting on a CAPTCHA - see markNeedsHuman) if a worker never
// reported a RESULT for its claimed batch in the meantime, and frees the
// worker so the run keeps moving instead of hanging on it forever.
//   - A plain stuck tab (page never loaded, network error page, a layout the
//     content script didn't expect, a crash): its companies count one
//     unanswered attempt each - see settleUnanswered.
//   - A CAPTCHA/consent page nobody dealt with in time: its companies are
//     marked blocked and the run stays paused, since giving up is not the
//     same as solving it. Resume puts blocked companies back in the queue.
async function handleWatchdogTimeout(workerIndex) {
  const engine = await getEngine();
  const worker = engine.workers[workerIndex];
  const stuckItemIds = (worker && worker.currentItemIds) || [];
  if (!stuckItemIds.length || !engine.activeProjectId) return; // already resolved normally - nothing to do

  const isHumanStall = worker.tabId != null && engine.captchaTabIds.includes(worker.tabId);

  // Last chance before giving up on this batch. Worker tabs run hidden, and
  // Chrome throttles a hidden tab's timers hard (roughly once a minute once
  // it's been hidden a few minutes). A tab in that state can be sitting on a
  // complete, perfectly readable answer and simply not have gotten around to
  // ending its own wait. Message delivery is NOT throttled, so asking it
  // directly works where its own timers don't.
  //
  // One attempt per batch (nudged flag), and never for a CAPTCHA stall: that
  // needs a person, not a nudge.
  if (!isHumanStall && !worker.nudged && worker.tabId != null) {
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

  let sampleCompanyName = null;
  const project = await updateItems(engine.activeProjectId, stuckItemIds, (byId) => {
    for (const id of stuckItemIds) {
      const item = byId.get(id);
      if (!item || item.status !== "pending") continue; // already resolved normally
      sampleCompanyName = sampleCompanyName || item.company_name;
      if (isHumanStall) item.status = "blocked";
      else settleUnanswered(item);
    }
    return { logCompletion: true };
  });
  if (!project) return;

  console.warn(
    `[AgriRoleFinder] watchdog fired for worker ${workerIndex} - ` +
      `${stuckItemIds.length} company(ies) ${isHumanStall ? "marked blocked (CAPTCHA not solved in time)" : "got no answer this time"}` +
      (sampleCompanyName ? ` (e.g. "${sampleCompanyName}")` : "")
  );

  // The worker is always freed - even if every one of its companies turned
  // out to be resolved already - or it would sit "busy" forever.
  const stuckBatchToken = worker.batchToken;
  const newEngine = await mutateEngine((e) => {
    const workers = e.workers.slice();
    if (workers[workerIndex] && workers[workerIndex].batchToken === stuckBatchToken) {
      workers[workerIndex] = { ...workers[workerIndex], currentItemIds: [], batchToken: null, searchUrl: null };
    }
    if (!isHumanStall) return { workers, ...emptyStreakPatch(e, false) };
    const captchaTabIds = e.captchaTabIds.filter((id) => id !== worker.tabId);
    const humanKinds = { ...(e.humanKinds || {}) };
    delete humanKinds[worker.tabId];
    const pauseReason =
      captchaTabIds.length > 0
        ? buildCaptchaPauseReason(captchaTabIds, { ...e, humanKinds })
        : `Gave up waiting for a CAPTCHA to be solved (no response after ` +
          `${Math.round(CAPTCHA_WATCHDOG_MS / 60000)} min)` +
          (sampleCompanyName ? ` on "${sampleCompanyName}"` : "") +
          `. Click Resume to continue - those companies are searched again.`;
    return {
      workers, captchaTabIds, humanKinds, isPaused: true, pauseReason,
      pauseKind: captchaTabIds.length > 0 ? "captcha" : "captcha_giveup",
    };
  });
  updateBadge(newEngine, project);

  if (!isHumanStall && newEngine.isRunning && !newEngine.isPaused) {
    scheduleNext(workerIndex, randomDelayMs(project));
  }
}

// A worker's tab needs a person: a CAPTCHA (Google's /sorry/ page, or one
// shown inline on the results page) or Google's cookie-consent page. Rather
// than failing that batch, this pauses the whole run (other tabs shouldn't
// keep hitting Google while one of them is being challenged) and brings the
// tab to the front, since worker tabs otherwise run in the background. The
// long CAPTCHA_WATCHDOG_MS leash replaces the normal batch watchdog as the
// backstop if nobody ever comes back; see handleWatchdogTimeout. Once it is
// dealt with, handleHumanCleared (or handleResult, for an inline CAPTCHA
// solved without leaving the page) resumes the run.
//
// It never tries to solve, click through or bypass one itself.
async function markNeedsHuman(workerIndex, tabId, kind) {
  const engine = await getEngine();
  const worker = engine.workers[workerIndex];
  if (!engine.activeProjectId || !worker || !(worker.currentItemIds || []).length) return;
  if (engine.captchaTabIds.includes(tabId)) return; // already flagged - e.g. re-detected after a failed solve attempt
  const project = await getMeta(engine.activeProjectId);
  if (!project) return;

  armWatchdog(workerIndex, CAPTCHA_WATCHDOG_MS);
  const newEngine = await mutateEngine((e) => {
    if (e.captchaTabIds.includes(tabId)) return {};
    const captchaTabIds = [...e.captchaTabIds, tabId];
    const humanKinds = { ...(e.humanKinds || {}), [tabId]: kind };
    return {
      isPaused: true,
      pauseKind: "captcha",
      pauseReason: buildCaptchaPauseReason(captchaTabIds, { ...e, humanKinds }),
      captchaTabIds,
      humanKinds,
    };
  });
  updateBadge(newEngine, project);
  console.warn(`[AgriRoleFinder] worker ${workerIndex}: ${kind} page in tab ${tabId} - run paused for you to deal with it`);

  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // Tab/window closed out from under us - handleWorkerTabClosed deals with
    // that.
  }
}

// The CAPTCHA/consent page was dealt with: the tab has navigated back onto a
// Google results page (Google's own redirect after solving). That search
// still has to run there, so this worker gets a fresh normal watchdog - the
// 10-minute CAPTCHA leash was armed when the CAPTCHA appeared, and could
// otherwise expire while the answer is still being written, which would
// wrongly mark the batch blocked. If it was the last outstanding one, the
// whole run resumes immediately rather than waiting for this batch's answer.
async function handleHumanCleared(workerIndex, tabId) {
  const engine = await getEngine();
  const worker = engine.workers[workerIndex];
  if (!worker || !(worker.currentItemIds || []).length) return;
  const project = await getMeta(engine.activeProjectId);
  if (!project) return;

  armWatchdog(workerIndex, computeWatchdogMs(worker.currentItemIds.length));
  let resumeAll = false;
  const newEngine = await mutateEngine((e) => {
    if (!e.captchaTabIds.includes(tabId)) return {};
    const captchaTabIds = e.captchaTabIds.filter((id) => id !== tabId);
    const humanKinds = { ...(e.humanKinds || {}) };
    delete humanKinds[tabId];
    if (captchaTabIds.length === 0 && e.isPaused && e.pauseKind === "captcha") {
      resumeAll = true;
      return { captchaTabIds, humanKinds, isPaused: false, pauseKind: null, pauseReason: null };
    }
    return {
      captchaTabIds,
      humanKinds,
      ...(captchaTabIds.length ? { pauseReason: buildCaptchaPauseReason(captchaTabIds, { ...e, humanKinds }) } : {}),
    };
  });
  updateBadge(newEngine, project);
  console.warn(`[AgriRoleFinder] worker ${workerIndex}: CAPTCHA/consent cleared in tab ${tabId}` + (resumeAll ? " - resuming the run" : ""));
  // processNext is a no-op for this worker (it still holds its batch), so
  // this only restarts the others.
  if (resumeAll) wakeAllWorkers(newEngine.workers.length);
}

// content.js saw a CAPTCHA on the results page itself.
async function handleCaptchaDetected(rawMessage, tabId) {
  const engine = await getEngine();
  const workerIndex = workerIndexForTab(engine, tabId);
  if (workerIndex === -1) return;
  if (rawMessage.batchToken !== engine.workers[workerIndex].batchToken) return; // this worker has already moved on - ignore
  await markNeedsHuman(workerIndex, tabId, "captcha");
}

// Sends a worker's tab somewhere, at most MAX_RENAVIGATIONS times per batch
// - a hard stop against any redirect loop with Google that the reasoning in
// handleWorkerTabUrl missed. Returns whether it did.
async function renavigateWorkerTab(workerIndex, batchToken, tabId, url, why) {
  let allowed = false;
  await mutateEngine((e) => {
    const w = e.workers[workerIndex];
    if (!w || w.batchToken !== batchToken || (w.renavigations || 0) >= MAX_RENAVIGATIONS) return {};
    allowed = true;
    const workers = e.workers.slice();
    workers[workerIndex] = { ...w, renavigations: (w.renavigations || 0) + 1 };
    return { workers };
  });
  if (!allowed) {
    console.warn(`[AgriRoleFinder] worker ${workerIndex}: not re-navigating again (${why}) - limit reached for this batch`);
    return false;
  }
  console.warn(`[AgriRoleFinder] worker ${workerIndex}: ${why}`);
  await chrome.tabs.update(tabId, { url });
  return true;
}

// Every URL change of a worker tab, straight from Chrome. This is how a
// CAPTCHA is noticed at all in the usual case: Google answers a search it
// considers suspicious by REDIRECTING to https://www.google.com/sorry/...,
// a page content.js is never injected into (it only runs on /search). The
// same goes for the cookie-consent page on consent.google.com.
//
// Only a URL change (changeInfo.url) can mean "solved" - the redirect back
// to /search. A "finished loading" event for the page the tab is already on
// never does, or the very page that showed an inline CAPTCHA would clear it.
//
// THE LONG-QUERY PROBLEM. Google's CAPTCHA page carries the whole blocked
// search in its own address (sorry/index?continue=<the search URL>), so it
// can send you back after. This extension's query is ~9K characters - the
// entity list rides along - and inside that continue= link it grows past
// what the CAPTCHA page accepts: instead of a CAPTCHA it shows "400. That's
// an error. Your client has issued a malformed or illegal request", with
// nothing to solve. (The sibling ai-mode-scraper never hits this: its query
// is a few hundred characters.) So a CAPTCHA page with a long address is
// swapped for a short search (CAPTCHA_LANDING_URL): Google shows a normal,
// solvable CAPTCHA for that, and once it is solved - which unblocks this
// browser for Google, not just that one search - the tab is sent on to the
// batch's real search.
async function handleWorkerTabUrl(tabId, url, isUrlChange) {
  const engine = await getEngine();
  if (!engine.activeProjectId) return;
  const workerIndex = workerIndexForTab(engine, tabId);
  if (workerIndex === -1) return;
  const worker = engine.workers[workerIndex];

  // A CAPTCHA solved AFTER the 10-minute give-up. By then this tab's batch
  // was marked blocked and handed back, and the run paused for Resume - so
  // without this, solving it late left the tab sitting on the page Google
  // returns to (the stand-in "agriculture companies" search, typically) and
  // the run paused for good. Google's redirect after a solved CAPTCHA
  // carries its google_abuse exemption token, and the stand-in search is
  // only ever reached via a CAPTCHA; either means it really was solved, so
  // it counts exactly like pressing Resume.
  if (
    isUrlChange && engine.isRunning && engine.isPaused && engine.pauseKind === "captcha_giveup" &&
    isGoogleSearchUrl(url) && (/[?&]google_abuse=/.test(url) || isCaptchaLandingUrl(url))
  ) {
    console.warn(`[AgriRoleFinder] worker ${workerIndex}: CAPTCHA solved after the give-up - resuming the run`);
    await resumeRun();
    return;
  }

  if (!(worker.currentItemIds || []).length) return;
  const waiting = engine.captchaTabIds.includes(tabId);

  // Chrome moved the page onto its own AI Mode surface, which no extension
  // can read - e.g. if a Chrome update starts doing that for the AI Mode tab
  // content.js clicks, too. Back to the batch's normal search: content.js
  // remembers AI Mode was already tried for this batch, so it won't click
  // again, and the batch finishes (or moves on) from there.
  if (isContextualTasksUrl(url) && worker.searchUrl) {
    await renavigateWorkerTab(
      workerIndex, worker.batchToken, tabId, worker.searchUrl,
      "Chrome opened AI Mode on a chrome:// page extensions can't read - back to the normal search"
    );
    return;
  }

  if (isSorryUrl(url)) {
    if (!waiting) await markNeedsHuman(workerIndex, tabId, "captcha");
    if (isUrlChange && url.length > MAX_WORKING_SORRY_URL_LEN) {
      await renavigateWorkerTab(
        workerIndex, worker.batchToken, tabId, CAPTCHA_LANDING_URL,
        "CAPTCHA page with a too-long address (Google shows a 400 error there) - opening a short search so Google shows a real CAPTCHA"
      );
    }
    return;
  }
  if (isConsentUrl(url)) {
    if (!waiting) await markNeedsHuman(workerIndex, tabId, "consent");
    return;
  }
  if (!waiting) return;
  if (isUrlChange && isGoogleSearchUrl(url)) {
    await handleHumanCleared(workerIndex, tabId);
    // Solved on the short stand-in search: now run the real one.
    if (isCaptchaLandingUrl(url) && worker.searchUrl) {
      await renavigateWorkerTab(workerIndex, worker.batchToken, tabId, worker.searchUrl, "CAPTCHA solved - opening this batch's search");
    }
    return;
  }
  // Solved, but Google's redirect landed somewhere other than a results page
  // (its home page, say). Send the tab back to this batch's own search;
  // arriving there is what clears the pause.
  //
  // Never for a page that already IS a search: an inline CAPTCHA sits on the
  // results page, and that page finishing loading (or you refreshing it)
  // would otherwise re-open the search, finish loading, re-open it again -
  // an endless reload loop.
  if (!isUrlChange && isGoogleUrl(url) && !isGoogleSearchUrl(url) && worker.searchUrl) {
    await renavigateWorkerTab(
      workerIndex, worker.batchToken, tabId, worker.searchUrl,
      `landed on ${url.slice(0, 60)} after the CAPTCHA - re-opening the search`
    );
  }
}

// A worker tab was closed (by you, or by Chrome). Its companies were never
// actually answered, so they simply stay pending - no attempt is counted
// against them - and the worker gets a new tab on its next batch. If that
// tab was the one showing a CAPTCHA, the run stays paused: closing it is
// not solving it.
async function handleWorkerTabClosed(tabId) {
  let freedIndex = -1;
  const newEngine = await mutateEngine((e) => {
    const idx = workerIndexForTab(e, tabId);
    if (idx === -1) return {};
    freedIndex = idx;
    const workers = e.workers.slice();
    workers[idx] = {
      ...workers[idx], tabId: null, windowId: null, ownsWindow: false,
      currentItemIds: [], batchToken: null, searchUrl: null,
    };
    if (!e.captchaTabIds.includes(tabId)) return { workers };
    const captchaTabIds = e.captchaTabIds.filter((id) => id !== tabId);
    const humanKinds = { ...(e.humanKinds || {}) };
    delete humanKinds[tabId];
    if (captchaTabIds.length) return { workers, captchaTabIds, humanKinds };
    return {
      workers, captchaTabIds, humanKinds, isPaused: true, pauseKind: "manual",
      pauseReason: "The tab showing the CAPTCHA was closed before it was solved. Click Resume to continue.",
    };
  });
  if (freedIndex === -1) return;
  disarmWatchdog(freedIndex);
  debug(`worker ${freedIndex}: its tab ${tabId} was closed - its companies stay in the queue`);
  if (newEngine.isRunning && !newEngine.isPaused) scheduleNext(freedIndex, 3000);
}

// content.js got a completely empty answer and is about to reload the same
// search once (see runBatch). That second pass needs its own room to run -
// re-arm a fresh watchdog rather than letting the original one (already most
// of the way through its window) cut it off mid-retry.
async function handleRetrySearch(rawMessage, tabId) {
  const engine = await getEngine();
  const workerIndex = workerIndexForTab(engine, tabId);
  if (workerIndex === -1) return;
  const worker = engine.workers[workerIndex];
  if (!engine.activeProjectId || !(worker.currentItemIds || []).length) return;
  if (rawMessage.batchToken !== worker.batchToken) return; // stale - ignore
  armWatchdog(workerIndex, computeWatchdogMs(worker.currentItemIds.length));
}

function aiLimitPauseReason(resumeAt, minutes) {
  const at = new Date(resumeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    `Google's limit for AI answers has been reached for now ("You've reached the request limit for AI ` +
    `responses"). The run is paused and resumes by itself at ${at} (in ${minutes} min) - the companies ` +
    `being searched were not counted as tried. Fewer concurrent tabs (1-2) makes this happen less ` +
    `often. Click Resume to try sooner.`
  );
}

// A tab ran into Google's AI answer limit. That limit is on the whole
// account, so carrying on would only fail every search - and, worse, record
// good companies as not found. Instead:
//   - this batch goes back in the queue untouched (its companies stay
//     pending, no try counted - nothing was wrong with them);
//   - the whole run pauses, and a cool-down alarm resumes it by itself
//     (5, 10, 20, 40, then 60 min if the limit is hit again in a row);
//   - another tab hitting the same limit during the pause only gives its
//     batch back - the cool-down isn't restarted or lengthened.
// Nothing here tries to get round the limit; it waits it out.
async function handleAiLimited(rawMessage, tabId) {
  const engine = await getEngine();
  const workerIndex = workerIndexForTab(engine, tabId);
  if (workerIndex === -1 || !engine.activeProjectId) return;
  const worker = engine.workers[workerIndex];
  if (!(worker.currentItemIds || []).length || rawMessage.batchToken !== worker.batchToken) return; // stale
  disarmWatchdog(workerIndex);

  const token = worker.batchToken;
  let cooldownMin = null;
  const next = await mutateEngine((e) => {
    const workers = e.workers.slice();
    if (workers[workerIndex] && workers[workerIndex].batchToken === token) {
      workers[workerIndex] = { ...workers[workerIndex], currentItemIds: [], currentNames: [], batchToken: null, searchUrl: null };
    }
    if (!e.isRunning || (e.isPaused && e.pauseKind === "ai_limit")) return { workers };
    const hits = (e.aiLimitHits || 0) + 1;
    cooldownMin = AI_LIMIT_COOLDOWNS_MIN[Math.min(hits, AI_LIMIT_COOLDOWNS_MIN.length) - 1];
    const resumeAt = Date.now() + cooldownMin * 60000;
    return {
      workers, aiLimitHits: hits, resumeAt,
      isPaused: true, pauseKind: "ai_limit", pauseReason: aiLimitPauseReason(resumeAt, cooldownMin),
    };
  });
  if (cooldownMin) {
    chrome.alarms.create(AI_LIMIT_ALARM, { delayInMinutes: cooldownMin });
    console.warn(`[AgriRoleFinder] Google's AI request limit reached - run paused for ${cooldownMin} min`);
  }
  updateBadge(next, await getMeta(next.activeProjectId));
}

// The AI-limit cool-down is over: resume - unless a CAPTCHA turned up in the
// meantime, which still needs a person first.
async function handleAiLimitCooldownOver() {
  let resumeAll = false;
  const next = await mutateEngine((e) => {
    if (!e.isRunning || !e.isPaused || e.pauseKind !== "ai_limit") return {};
    if (e.captchaTabIds.length) {
      return { pauseKind: "captcha", resumeAt: null, pauseReason: buildCaptchaPauseReason(e.captchaTabIds, e) };
    }
    resumeAll = true;
    return { isPaused: false, pauseKind: null, pauseReason: null, resumeAt: null };
  });
  updateBadge(next, await getMeta(next.activeProjectId));
  if (resumeAll) {
    console.warn("[AgriRoleFinder] AI-limit cool-down over - resuming the run");
    wakeAllWorkers(next.workers.length);
  }
}

// Applies one worker's full batch result (every company it was claiming,
// resolved together) in a single pass.
async function handleResult(rawMessage, tabId) {
  if (!rawMessage || !Array.isArray(rawMessage.results)) return; // malformed - drop it

  const engine = await getEngine();
  const workerIndex = workerIndexForTab(engine, tabId);
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

  const claimedIds = new Set(worker.currentItemIds);
  let anyResolved = false;
  let anyAnswered = false;
  let anyBlocked = false;
  // Saved before the worker is freed below, so processNext can never see
  // these companies as both "not in flight" and "still pending".
  const project = await updateItems(engine.activeProjectId, worker.currentItemIds, (byId) => {
    for (const raw of rawMessage.results) {
      if (!raw || !claimedIds.has(raw.itemId)) continue; // not part of this worker's claimed batch - ignore
      const entry = sanitizeResultEntry(raw);
      if (!entry) continue; // malformed/failed re-validation - drop just this entry
      const item = byId.get(entry.itemId);
      if (!item || item.status !== "pending") continue;
      anyResolved = true;

      if (entry.status === "missing") {
        settleUnanswered(item);
        continue;
      }
      item.status = entry.status; // "found" | "not_found" | "blocked"
      if (entry.status === "blocked") {
        anyBlocked = true;
        continue; // nothing was read - keep whatever an earlier pass found
      }
      anyAnswered = true;
      // Never overwrite something with nothing: a "Retry not-found rows" pass
      // that comes back emptier than the first must not blank out a
      // description the first pass did get.
      item.description = entry.description || item.description || null;
      if (entry.status === "found") item.classifications = entry.classifications;
    }
    return { logCompletion: anyResolved };
  });
  if (!project) return;

  const claimedBatchToken = worker.batchToken;
  // Any real result at all means this tab made it past whatever CAPTCHA it
  // was showing (content.js's own last-resort give-up, status "blocked" on
  // every entry, doesn't count as solved). If this was the last outstanding
  // CAPTCHA, the run can resume on its own - but only a pause that was FOR
  // that CAPTCHA; a pause for any other reason waits for Resume.
  const clearedCaptcha = !anyBlocked;
  let resolvingLastCaptcha = false;

  const newEngine = await mutateEngine((e) => {
    const workers = e.workers.slice();
    // Only clear if this worker still points at the same batch - defends
    // against any unexpected reordering of concurrent messages.
    if (workers[workerIndex] && workers[workerIndex].batchToken === claimedBatchToken) {
      workers[workerIndex] = { ...workers[workerIndex], currentItemIds: [], batchToken: null, searchUrl: null };
    }
    const neutral = anyBlocked || (!anyAnswered && rawMessage.noAiAnswer === true);
    const streak = {
      ...(neutral ? {} : emptyStreakPatch(e, anyAnswered)),
      // Answers are coming through again: the next AI-limit hit starts from
      // the shortest cool-down.
      ...(anyAnswered ? { aiLimitHits: 0 } : {}),
    };
    const wasCaptchaTab = e.captchaTabIds.includes(tabId);
    if (!wasCaptchaTab) return { workers, ...streak };
    const captchaTabIds = e.captchaTabIds.filter((id) => id !== tabId);
    const humanKinds = { ...(e.humanKinds || {}) };
    delete humanKinds[tabId];
    resolvingLastCaptcha = clearedCaptcha && e.isPaused && e.pauseKind === "captcha" && captchaTabIds.length === 0;
    return {
      workers,
      captchaTabIds,
      humanKinds,
      ...(resolvingLastCaptcha
        ? { isPaused: false, pauseKind: null, pauseReason: null }
        : captchaTabIds.length > 0
        ? { pauseReason: buildCaptchaPauseReason(captchaTabIds, { ...e, humanKinds }) }
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

// What the Resume button does - and what a CAPTCHA solved after the
// 10-minute give-up does too (see handleWorkerTabUrl).
async function resumeRun() {
  const engineBefore = await getEngine();
  // Blocked companies were never answered - a CAPTCHA got in the way, which
  // says nothing about the company - so resuming searches them again rather
  // than leaving them for a manual pass.
  const { meta: project } = engineBefore.activeProjectId
    ? await updateItemsWithStatus(engineBefore.activeProjectId, "blocked", (item) => {
        item.status = "pending";
      })
    : { meta: null };
  if (!project) return { ok: false, error: "That project no longer exists." };
  chrome.alarms.clear(AI_LIMIT_ALARM); // resuming ends any AI-limit cool-down early
  const resumed = await mutateEngine(() => ({
    isRunning: true,
    isPaused: false,
    pauseReason: null,
    pauseKind: null,
    emptyStreak: 0,
    resumeAt: null,
  }));
  updateBadge(resumed, project);
  wakeAllWorkers(resumed.workers.length);
  return { ok: true };
}

// Chrome restarted, or the extension was reloaded/updated, mid-run. Every
// worker tab and timer from before is gone (or no longer ours), so a run
// still marked "running" would sit there doing nothing. Instead it is paused
// with the reason shown, and Resume picks up exactly where it stopped:
// companies that were in flight never left "pending", so nothing is lost or
// skipped.
async function resetAfterRestart(reason, closeOldTabs) {
  const before = await getEngine();
  if (!before.activeProjectId || (!before.isRunning && !before.isPaused)) return;
  clearAllWorkerAlarms(before.workers.length);
  chrome.alarms.clear(AI_LIMIT_ALARM);
  const after = await mutateEngine((e) => ({
    isRunning: true,
    isPaused: true,
    pauseKind: "manual",
    pauseReason: reason,
    captchaTabIds: [],
    humanKinds: {},
    emptyStreak: 0,
    workers: e.workers.map((w) => ({
      ...w, tabId: null, windowId: null, ownsWindow: false,
      currentItemIds: [], batchToken: null, searchUrl: null, nudged: false,
    })),
  }));
  // Tab ids are only unique within one browser session, so the old ones are
  // only closed when Chrome itself did NOT restart (an extension reload) -
  // after a restart they could belong to tabs of yours.
  if (closeOldTabs) await closeWorkerSurfaces(before.workers);
  updateBadge(after, await getMeta(after.activeProjectId));
}

chrome.runtime.onStartup.addListener(() => {
  cleanupOrphanData();
  resetAfterRestart("Chrome was restarted while this project was running. Click Resume to continue where it left off.", false);
});

chrome.runtime.onInstalled.addListener(async () => {
  await migrateLegacyProjects();
  cleanupOrphanData();
  resetAfterRestart("The extension was reloaded or updated while this project was running. Click Resume to continue where it left off.", true);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) handleWorkerTabUrl(tabId, changeInfo.url, true);
  else if (changeInfo.status === "complete" && tab && tab.url) handleWorkerTabUrl(tabId, tab.url, false);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handleWorkerTabClosed(tabId);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AI_LIMIT_ALARM) {
    handleAiLimitCooldownOver();
    return;
  }
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
        // The short stand-in search used to get a working CAPTCHA has nothing
        // to do with this batch - reading it as the answer would record every
        // company as not found. The tab moves on to the real search next.
        if (isCaptchaLandingUrl(sender.tab.url)) {
          debug(`GET_CURRENT from worker ${workerIndex}: on the CAPTCHA stand-in search - leaving that page alone`);
          sendResponse(null);
          return;
        }
        const names = worker.currentNames || [];
        const items = worker.currentItemIds.map((id, i) => ({ id, company_name: names[i] || "" }));
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
      case "AI_LIMITED": {
        await handleAiLimited(message, sender.tab.id);
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
        sendResponse(await createProjectFromChunks(message));
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
        const updated = await updateMeta(message.projectId, (project) => {
          project.delayMinSec = message.delayMinSec || project.delayMinSec;
          project.delayMaxSec = message.delayMaxSec || project.delayMaxSec;
          project.concurrency = clampConcurrency(message.concurrency || project.concurrency);
          project.batchSize = clampBatchSize(message.batchSize || project.batchSize);
        });
        sendResponse(updated ? { ok: true } : { ok: false, error: "Project not found." });
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
        const { meta, count } = await updateItemsWithStatus(message.projectId, "not_found", (item) => {
          item.status = "pending";
          item.attempts = 0;
        });
        sendResponse(meta ? { ok: true, count } : { ok: false, error: "Project not found." });
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
          chrome.alarms.clear(AI_LIMIT_ALARM);
          // Engine first, tabs second: closing a tab fires
          // handleWorkerTabClosed, which must find nothing left to reschedule.
          await mutateEngine(() => ({
            isRunning: false,
            isPaused: false,
            pauseReason: null,
            pauseKind: null,
            activeProjectId: null,
            captchaTabIds: [],
            humanKinds: {},
            workers: [],
          }));
          await closeWorkerSurfaces(engineBefore.workers);
          chrome.action.setBadgeText({ text: "" });
        }
        await withDataLock(async () => {
          const meta = await getMeta(message.projectId);
          const fresh = await getProjectIndex();
          delete fresh[message.projectId];
          await saveProjectIndex(fresh);
          await chrome.storage.local.remove(projectDataKeys(message.projectId, meta ? meta.chunkCount : 0));
        });
        cleanupOrphanData(); // catches pieces of a project whose meta was already gone
        sendResponse({ ok: true });
        return;
      }
      case "START": {
        const engineBefore = await getEngine();
        if (engineBefore.isRunning && engineBefore.activeProjectId && engineBefore.activeProjectId !== message.projectId) {
          sendResponse({ ok: false, error: "Another project is currently running - stop it first." });
          return;
        }
        const project = await getMeta(message.projectId);
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
            pauseKind: null,
            captchaTabIds: [],
            humanKinds: {},
            emptyStreak: 0,
            aiLimitHits: 0,
            resumeAt: null,
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
        chrome.alarms.clear(AI_LIMIT_ALARM);
        const stopped = await mutateEngine((engine) => ({
          isRunning: false,
          isPaused: false,
          pauseReason: null,
          pauseKind: null,
          resumeAt: null,
          captchaTabIds: [],
          humanKinds: {},
          workers: engine.workers.map((w) => ({
            ...w,
            tabId: null,
            windowId: null,
            ownsWindow: false,
            currentItemIds: [],
            batchToken: null,
            searchUrl: null,
          })),
        }));
        // Close the windows/tabs this run opened - AFTER the engine is
        // stopped, so handleWorkerTabClosed (fired by each close) finds no
        // worker to reschedule. closeWorkerSurfaces only ever closes what the
        // extension itself created (see ownsWindow). Companies that were in
        // flight never left "pending", so Start picks them up again.
        await closeWorkerSurfaces(before.workers);
        const project = stopped.activeProjectId ? await getMeta(stopped.activeProjectId) : null;
        updateBadge(stopped, project);
        sendResponse({ ok: true });
        return;
      }
      case "RESUME": {
        sendResponse(await resumeRun());
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
        // The meta only (settings, counts, rate log) - never the companies,
        // which the popup reads from storage itself when exporting.
        sendResponse(await getMeta(message.projectId));
        return;
      }
      default:
        sendResponse(null);
    }
  })();
  return true; // keep the message channel open for the async work above
});
