// How long content.js waits on a Google results page, and what it does when
// no AI answer ever comes. The real content.js runs against a fake page and a
// fake clock, so minutes of waiting take milliseconds and every timing is
// exact. Nothing here contacts Google.
const nodeTest = require("node:test");
const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn);
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ROOT } = require("./load.js");

const SOURCE = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
const tick = () => new Promise((r) => setImmediate(r));

function makeClock() {
  let now = 1_000_000;
  let timers = [];
  let seq = 0;
  const add = (fn, ms, repeat) => {
    const id = ++seq;
    timers.push({ id, at: now + Math.max(ms || 0, 0), fn, every: repeat ? Math.max(ms || 0, 1) : 0 });
    return id;
  };
  const clear = (id) => (timers = timers.filter((t) => t.id !== id));
  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, false),
    setInterval: (fn, ms) => add(fn, ms, true),
    clear,
    // Runs every timer due in the next `ms`, in order.
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        now = t.at;
        if (t.every) t.at += t.every;
        else clear(t.id);
        t.fn();
        await tick();
      }
      now = end;
      await tick();
    },
  };
}

// One page load of content.js. `session` is shared between loads, like the
// browser's sessionStorage for a tab, so a reload remembers it already
// reloaded once.
function loadPage(clock, page, session) {
  const sent = [];
  const reloads = { count: 0 };
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    window: {},
    module: { exports: {} },
    Date: { now: clock.now },
    setTimeout: clock.setTimeout,
    setInterval: clock.setInterval,
    clearTimeout: clock.clear,
    clearInterval: clock.clear,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_FRAGMENT_NODE: 11 },
    document: {
      get body() {
        return { innerText: page.text };
      },
      documentElement: {},
      // The results page's AI Mode tab, if the test page has one.
      querySelector: (sel) => (page.aiModeTab && sel.includes("udm=50") ? { click: () => page.aiModeTab.onClick() } : null),
      querySelectorAll: () => [],
    },
    location: { pathname: "/search", reload: () => reloads.count++ },
    sessionStorage: {
      getItem: (k) => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => session.set(k, String(v)),
    },
    chrome: { runtime: { sendMessage: (m) => sent.push(m) } },
  });
  vm.runInContext(SOURCE, ctx);
  return { api: ctx.module.exports, sent, reloads };
}

const ITEMS = [{ itemId: "r0" }, { itemId: "r1" }, { itemId: "r2" }];

const RESULTS_PAGE = `I will list 3 agriculture-sector companies. For EACH one
AI Mode  All  Forums  Shopping  Images  Videos  News
Scribd
Home Products | PDF | Home Appliance | Scissors
East Best Enterprise (Mfy) Co. Ltd. Source from one of the biggest mainland China-based companies in the industry.
Global Sources - 2010 June - Home Products | PDF
Pacific Access is a leading home appliance exporter, searching for suppliers, loading equipment, generating leads.`;

// Starts runBatch on the page and lets the clock run until it reports back or
// reloads, returning how long that took in (fake) seconds.
async function runUntilDone(clock, loaded, maxSeconds) {
  const started = clock.now();
  loaded.api.runBatch(ITEMS, "b_1");
  for (let s = 0; s < maxSeconds; s++) {
    await clock.advance(1000);
    if (loaded.reloads.count || loaded.sent.some((m) => m.type === "RESULT")) break;
  }
  return (clock.now() - started) / 1000;
}

test("a results page with no AI Overview (the screenshot): reload once after ~15s, then report and move on", async () => {
  const clock = makeClock();
  const session = new Map();
  const page = { text: RESULTS_PAGE };

  const first = loadPage(clock, page, session);
  const firstWait = await runUntilDone(clock, first, 300);
  assert.strictEqual(first.reloads.count, 1, "the search is reloaded once");
  assert.ok(firstWait <= 17, `gave up after ${firstWait}s, not minutes`);
  assert.ok(first.sent.some((m) => m.type === "RETRY_SEARCH"), "the engine is told, so its timer allows the second try");

  const second = loadPage(clock, page, session); // the reloaded page
  const secondWait = await runUntilDone(clock, second, 300);
  assert.strictEqual(second.reloads.count, 0, "no second reload");
  assert.ok(secondWait <= 17, `second try gave up after ${secondWait}s`);
  const result = second.sent.find((m) => m.type === "RESULT");
  assert.ok(result, "a result is reported - the run moves on");
  assert.deepStrictEqual(result.results.map((r) => r.status), ["missing", "missing", "missing"]);
  assert.strictEqual(result.noAiAnswer, true);
});

test("words like 'loading' or 'searching' inside ordinary results no longer look like an answer being written", () => {
  const { api } = loadPage(makeClock(), { text: "" }, new Map());
  assert.strictEqual(api.isStillGenerating(RESULTS_PAGE), false);
  assert.strictEqual(api.isStillGenerating("AI Overview\nSearching\n"), true);
  assert.strictEqual(api.isStillGenerating("AI Overview\nGenerating...\n"), true);
  assert.strictEqual(api.isStillGenerating("AI Overview\nThinking a little longer…"), true);
});

test("while the AI Overview is still being written, it keeps waiting past 15s and reads the answer when it lands", async () => {
  const clock = makeClock();
  const page = { text: `${RESULTS_PAGE}\nAI Overview\nSearching` };
  const loaded = loadPage(clock, page, new Map());
  loaded.api.runBatch(ITEMS, "b_1");
  await clock.advance(40000);
  assert.strictEqual(loaded.reloads.count, 0, "not given up on at 15s");
  assert.strictEqual(loaded.sent.length, 0);

  page.text = `${RESULTS_PAGE}\nAI Overview\n` + [1, 2, 3]
    .map((i) => `COMPANY ${i}\nDESCRIPTION: Company ${i} sells seeds.\nENTITY: Seeds & biologicals | ROLES: Seed Distributor [Distributor]`)
    .join("\n") + "\nEND OF ANSWERS";
  await clock.advance(1000);
  const result = loaded.sent.find((m) => m.type === "RESULT");
  assert.ok(result, "reported as soon as the answer is complete");
  assert.deepStrictEqual(result.results.map((r) => r.status), ["found", "found", "found"]);
  assert.strictEqual(result.noAiAnswer, false);
});

test("an AI Overview that ignores the answer format is given up on after it goes quiet, not after the 2-minute limit", async () => {
  const clock = makeClock();
  const page = { text: `${RESULTS_PAGE}\nAI Overview\nThese companies supply agricultural inputs across India.` };
  const loaded = loadPage(clock, page, new Map());
  const waited = await runUntilDone(clock, loaded, 300);
  assert.strictEqual(loaded.reloads.count, 1);
  assert.ok(waited <= 14, `gave up after ${waited}s`);
});

test("a partly written answer is still given the long patience (Google pauses mid-answer)", async () => {
  const clock = makeClock();
  const page = {
    text: `AI Overview\nCOMPANY 1\nDESCRIPTION: Company 1 sells seeds.\nENTITY: Seeds & biologicals | ROLES: Seed Distributor`,
  };
  const loaded = loadPage(clock, page, new Map());
  loaded.api.runBatch(ITEMS, "b_1");
  await clock.advance(30000);
  assert.strictEqual(loaded.sent.filter((m) => m.type === "RESULT").length, 0, "still waiting at 30s");
  await clock.advance(20000);
  const result = loaded.sent.find((m) => m.type === "RESULT");
  assert.ok(result, "reported once the page stayed quiet for 45s");
  assert.deepStrictEqual(result.results.map((r) => r.status), ["found", "missing", "missing"]);
});

// --- The AI Mode step ---

const AI_MODE_ANSWER = `AI Mode  All  Forums  Shopping  Images  More
I will list 3 agriculture-sector companies. For EACH one: if a website is given, use that official website as the main source...
` + [1, 2, 3]
  .map((i) => `COMPANY ${i}\nDESCRIPTION: Company ${i} makes fertilizers.\nENTITY: Fertilizers | ROLES: Fertilizer Manufacturer [Manufacturer]`)
  .join("\n") + "\nEND OF ANSWERS\nAsk anything";

const NO_RESULTS_PAGE = `AI Mode  All  Forums  Shopping  Images  Videos  News  More  Tools
No results found for I will list 3 agriculture-sector companies. For EACH one: if a website is given...`;

test("no AI Overview: after ~15s the AI Mode tab is clicked (not a reload), and its answer is read", async () => {
  const clock = makeClock();
  const page = { text: NO_RESULTS_PAGE, clicks: 0 };
  // Google switches to AI Mode in place; AI Mode thinks, then answers.
  page.aiModeTab = {
    onClick() {
      page.clicks++;
      page.text = "AI Mode\nI will list 3 agriculture-sector companies...\nThinking\nAsk anything";
      clock.setTimeout(() => (page.text = AI_MODE_ANSWER), 20000);
    },
  };
  const loaded = loadPage(clock, page, new Map());
  const waited = await runUntilDone(clock, loaded, 300);

  assert.strictEqual(page.clicks, 1, "AI Mode tab clicked once");
  assert.strictEqual(loaded.reloads.count, 0, "no reload needed");
  assert.ok(loaded.sent.some((m) => m.type === "RETRY_SEARCH"), "engine told, so AI Mode gets its own time window");
  const result = loaded.sent.find((m) => m.type === "RESULT");
  assert.ok(result, "the AI Mode answer was reported");
  assert.deepStrictEqual(result.results.map((r) => r.status), ["found", "found", "found"]);
  assert.strictEqual(result.results[0].entities[0].entity, "Fertilizers");
  assert.ok(waited < 60, `answered after ${waited}s`);
});

test("if clicking AI Mode loads a new page, that page carries on with the AI Mode step", async () => {
  const clock = makeClock();
  const session = new Map();
  const page = { text: NO_RESULTS_PAGE, clicks: 0 };
  page.aiModeTab = { onClick: () => page.clicks++ };
  const first = loadPage(clock, page, session);
  first.api.runBatch(ITEMS, "b_1");
  await clock.advance(16000);
  assert.strictEqual(page.clicks, 1);

  // The AI Mode page loads (a new copy of the script, same tab session).
  const aiPage = { text: AI_MODE_ANSWER, clicks: 0 };
  aiPage.aiModeTab = { onClick: () => aiPage.clicks++ };
  const second = loadPage(clock, aiPage, session);
  const waited = await runUntilDone(clock, second, 120);
  const result = second.sent.find((m) => m.type === "RESULT");
  assert.ok(result, "reported from the AI Mode page");
  assert.deepStrictEqual(result.results.map((r) => r.status), ["found", "found", "found"]);
  assert.strictEqual(aiPage.clicks, 0, "AI Mode is not clicked again from AI Mode");
  assert.ok(waited <= 2, `read straight away (${waited}s)`);
});

test("AI Mode researching silently for 35s is not given up on", async () => {
  const clock = makeClock();
  const page = { text: NO_RESULTS_PAGE };
  page.aiModeTab = {
    onClick() {
      page.text = "AI Mode\nI will list 3 agriculture-sector companies...\nAsk anything"; // nothing changing
      clock.setTimeout(() => (page.text = AI_MODE_ANSWER), 35000);
    },
  };
  const loaded = loadPage(clock, page, new Map());
  await runUntilDone(clock, loaded, 300);
  const result = loaded.sent.find((m) => m.type === "RESULT");
  assert.ok(result);
  assert.deepStrictEqual(result.results.map((r) => r.status), ["found", "found", "found"]);
});

test("AI Mode empty too: one reload, then report missing and move on - AI Mode is tried only once", async () => {
  const clock = makeClock();
  const session = new Map();
  const emptyAi = "AI Mode\nI will list 3 agriculture-sector companies...\nAsk anything";
  const page = { text: NO_RESULTS_PAGE, clicks: 0 };
  page.aiModeTab = { onClick: () => { page.clicks++; page.text = emptyAi; } };

  const first = loadPage(clock, page, session);
  await runUntilDone(clock, first, 300);
  assert.strictEqual(page.clicks, 1);
  assert.strictEqual(first.reloads.count, 1, "AI Mode page reloaded once");

  const reloaded = loadPage(clock, page, session); // the reloaded AI Mode page
  const waited = await runUntilDone(clock, reloaded, 300);
  assert.strictEqual(page.clicks, 1, "not clicked again");
  assert.strictEqual(reloaded.reloads.count, 0);
  const result = reloaded.sent.find((m) => m.type === "RESULT");
  assert.ok(result, "reported - the run moves on");
  assert.deepStrictEqual(result.results.map((r) => r.status), ["missing", "missing", "missing"]);
  assert.strictEqual(result.noAiAnswer, true, "doesn't count towards pausing the run");
  assert.ok(waited <= 47, `gave up after ${waited}s`);
});

test("an AI Overview that does answer is used as before - AI Mode is not touched", async () => {
  const clock = makeClock();
  const page = {
    text: `AI Overview\n` + [1, 2, 3]
      .map((i) => `COMPANY ${i}\nDESCRIPTION: Company ${i} sells seeds.\nENTITY: Seeds & biologicals | ROLES: Seed Distributor [Distributor]`)
      .join("\n") + "\nEND OF ANSWERS",
    clicks: 0,
  };
  page.aiModeTab = { onClick: () => page.clicks++ };
  const loaded = loadPage(clock, page, new Map());
  await runUntilDone(clock, loaded, 60);
  assert.strictEqual(page.clicks, 0);
  assert.deepStrictEqual(loaded.sent.find((m) => m.type === "RESULT").results.map((r) => r.status), ["found", "found", "found"]);
});

// --- Google's AI answer limit ---

const LIMIT_TEXT = "You've reached the request limit for AI responses at the moment. Try again in a little while.";

test("Google's AI limit in AI Mode (the screenshot): reported straight away - no waiting, no reload, nothing written off", async () => {
  const clock = makeClock();
  const page = { text: NO_RESULTS_PAGE, clicks: 0 };
  page.aiModeTab = {
    onClick() {
      page.clicks++;
      page.text = `AI Mode\nI will list 3 agriculture-sector companies...\nThinking`;
      clock.setTimeout(() => (page.text = `AI Mode\nI will list 3 agriculture-sector companies...\n${LIMIT_TEXT}\nAsk anything`), 4000);
    },
  };
  const loaded = loadPage(clock, page, new Map());
  loaded.api.runBatch(ITEMS, "b_1");
  await clock.advance(25000);
  assert.ok(loaded.sent.some((m) => m.type === "AI_LIMITED" && m.batchToken === "b_1"), "the engine is told");
  assert.strictEqual(loaded.sent.some((m) => m.type === "RESULT"), false, "no companies reported as missing");
  assert.strictEqual(loaded.reloads.count, 0, "no reload");
});

test("the limit on the normal results page is caught the same way", async () => {
  const clock = makeClock();
  const loaded = loadPage(clock, { text: `${RESULTS_PAGE}\n${LIMIT_TEXT}` }, new Map());
  loaded.api.runBatch(ITEMS, "b_1");
  await clock.advance(2000);
  assert.ok(loaded.sent.some((m) => m.type === "AI_LIMITED"));
  assert.strictEqual(loaded.sent.some((m) => m.type === "RESULT"), false);
});

test("ordinary text mentioning limits is not mistaken for Google's AI limit", () => {
  const { api } = loadPage(makeClock(), { text: "" }, new Map());
  assert.strictEqual(api.isAiLimited(LIMIT_TEXT), true);
  assert.strictEqual(api.isAiLimited("DESCRIPTION: The company sells speed limit signs and AI-based request routing."), false);
});
