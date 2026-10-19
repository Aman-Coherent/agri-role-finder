// The run engine (background.js) driven through the situations that go wrong
// in real life: CAPTCHA pages, a tab closed mid-search, Chrome restarting,
// Google returning nothing. A fake Chrome stands in for the browser; the
// answers are parsed by content.js's real parser. Nothing here contacts
// Google.
// Each test gets a time limit: a broken engine tends to hang (a reply that
// never comes) rather than fail, and a hang must show up as a failure.
const nodeTest = require("node:test");
const test = (name, fn) => nodeTest(name, { timeout: 5000 }, fn);
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { loadContentParser, ROOT } = require("./load.js");

const { parseAnswer } = loadContentParser();
const SEARCH = "https://www.google.com/search?q=";
const SORRY = "https://www.google.com/sorry/index?continue=https://www.google.com/search";
const tick = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 40; i++) await tick();
}

function makeHarness() {
  const store = {};
  const on = { message: null, alarm: null, updated: [], removed: [], startup: [], installed: [] };
  const alarms = new Map();
  const tabs = new Map();
  const activated = [];
  const navigations = [];
  // Stands in for Google redirecting a request before the page commits
  // (e.g. a blocked search going straight to its CAPTCHA page).
  let redirect = null;
  let nextTab = 1;
  const fire = (list, ...args) => list.forEach((f) => f(...args));

  const chrome = {
    runtime: {
      id: "ext",
      onMessage: { addListener: (f) => (on.message = f) },
      onStartup: { addListener: (f) => on.startup.push(f) },
      onInstalled: { addListener: (f) => on.installed.push(f) },
    },
    storage: {
      local: {
        get: async (k) => (k in store ? { [k]: structuredClone(store[k]) } : {}),
        set: async (o) => Object.entries(o).forEach(([k, v]) => (store[k] = structuredClone(v))),
        remove: async (k) => delete store[k],
      },
    },
    alarms: {
      create: (name, o) => alarms.set(name, o),
      clear: (name) => alarms.delete(name),
      onAlarm: { addListener: (f) => (on.alarm = f) },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    tabs: {
      create: async () => {
        const t = { id: nextTab++, windowId: 1, url: "about:blank" };
        tabs.set(t.id, t);
        return { ...t };
      },
      get: async (id) => {
        if (!tabs.has(id)) throw new Error("no tab");
        return { ...tabs.get(id), status: "complete" };
      },
      update: async (id, p) => {
        if (!tabs.has(id)) throw new Error("no tab");
        if (p.active) activated.push(id);
        if (p.url) navigate(id, (redirect && redirect(p.url)) || p.url);
        return { ...tabs.get(id) };
      },
      remove: async (id) => {
        if (tabs.delete(id)) setImmediate(() => fire(on.removed, id));
      },
      sendMessage: async () => ({ waiting: false }),
      onUpdated: { addListener: (f) => on.updated.push(f) },
      onRemoved: { addListener: (f) => on.removed.push(f) },
    },
    windows: { update: async () => {}, remove: async () => {} },
    scripting: { executeScript: async () => {} },
  };

  // What Chrome does when a tab navigates: the URL change, then "complete".
  function navigate(id, url) {
    navigations.push(url);
    const t = tabs.get(id);
    t.url = url;
    setImmediate(() => {
      fire(on.updated, id, { url }, { ...t });
      setImmediate(() => fire(on.updated, id, { status: "complete" }, { ...t }));
    });
  }

  const unrefTimeout = (fn, ms) => {
    const t = setTimeout(fn, ms);
    if (t.unref) t.unref();
    return t;
  };
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    setTimeout: unrefTimeout, clearTimeout, URL, URLSearchParams, structuredClone, chrome,
  });
  ctx.globalThis = ctx;
  ctx.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), ctx);

  const send = (message, sender = {}) =>
    new Promise((resolve) => on.message(message, { id: "ext", ...sender }, resolve));
  const engine = () => store.arfEngine;
  const project = () => store[Object.keys(store).find((k) => k.startsWith("arfProject_"))];
  const byName = (name) => project().queue.find((c) => c.company_name === name);
  const workerTab = () => {
    const w = (engine().workers || [])[0];
    return w && w.tabId != null ? tabs.get(w.tabId) : null;
  };

  return {
    send, engine, project, byName, workerTab, tabs, alarms, activated, navigate, navigations,
    setRedirect(fn) {
      redirect = fn;
    },
    // The page in a tab finishing loading (or being refreshed) without its
    // URL changing.
    async pageLoaded(id) {
      for (const f of on.updated) f(id, { status: "complete" }, { ...tabs.get(id) });
      await settle();
    },
    async create(names, opts = {}) {
      const companies = names.map((n, i) => ({ id: `r${i}`, company_name: n, original: { Company: n } }));
      const res = await send({
        type: "CREATE_PROJECT", name: "Test", companies, columns: ["Company"],
        batchSize: opts.batchSize || 3, concurrency: 1, delayMinSec: 2, delayMaxSec: 3,
      });
      return res.projectId;
    },
    async start(projectId) {
      await send({ type: "START", projectId });
      await settle();
    },
    // Plays the content script on the worker tab: read the batch, "answer"
    // it with answerFor(items), parse that with the real parser, report.
    async answer(answerFor) {
      const tab = workerTab();
      assert.ok(tab && tab.url.startsWith(SEARCH), "worker tab should be on a search page");
      const sender = { tab: { id: tab.id, url: tab.url } };
      const current = await send({ type: "GET_CURRENT" }, sender);
      assert.ok(current, "the worker tab should have a batch to answer");
      const n = current.items.length;
      const parsed = parseAnswer(answerFor(current.items), n);
      const results = current.items.map((it, i) => {
        const b = parsed.blocks.get(i + 1);
        if (!b || !b.answered) return { itemId: it.itemId, status: "missing" };
        return { itemId: it.itemId, status: b.entities.length ? "found" : "not_found", description: b.description, entities: b.entities };
      });
      await send({ type: "RESULT", batchToken: current.batchToken, results }, sender);
      await settle();
      return current.items.map((it) => it.company_name);
    },
    // The delay between batches elapsing.
    async nextBatch() {
      for (const name of [...alarms.keys()].filter((n) => n.startsWith("arf-next-"))) {
        alarms.delete(name);
        on.alarm({ name });
      }
      await settle();
    },
    async fireWatchdog() {
      alarms.delete("arf-watchdog-0");
      on.alarm({ name: "arf-watchdog-0" });
      await settle();
    },
    async closeTab(id) {
      await chrome.tabs.remove(id);
      await settle();
    },
    async restartChrome() {
      on.startup.forEach((f) => f());
      await settle();
    },
  };
}

// A fake AI answer: every company gets one on-list classification, except
// those in `skip` (no block at all) and `none` (explicit NONE).
function answers({ skip = [], none = [] } = {}) {
  return (items) =>
    items
      .map((it, i) => {
        if (skip.includes(it.company_name)) return "";
        if (none.includes(it.company_name)) return `COMPANY ${i + 1}\nDESCRIPTION: NONE\nENTITY: NONE`;
        return `COMPANY ${i + 1}\nDESCRIPTION: ${it.company_name} sells seeds.\nENTITY: Seeds & biologicals | ROLES: Seed Distributor [Distributor]`;
      })
      .filter(Boolean)
      .join("\n") + "\nEND OF ANSWERS";
}
const nothing = () => "AI Overview is not available for this search.";

test("a company the AI skipped is tried once more in a later batch, then recorded not found", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A", "B", "C", "D", "E"]));
  assert.deepStrictEqual(await h.answer(answers({ skip: ["B"] })), ["A", "B", "C"]);
  assert.strictEqual(h.byName("B").status, "pending");
  assert.strictEqual(h.byName("B").attempts, 1);
  await h.nextBatch();
  assert.deepStrictEqual(await h.answer(answers({ skip: ["B"] })), ["B", "D", "E"]);
  assert.strictEqual(h.byName("B").status, "not_found");
  for (const n of ["A", "C", "D", "E"]) assert.strictEqual(h.byName(n).status, "found", n);
  await h.nextBatch();
  assert.strictEqual(h.engine().isRunning, false, "the run ends by itself when nothing is left");
});

test("a skipped company that is answered on its second try is found", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A", "B", "C", "D"]));
  await h.answer(answers({ skip: ["B"] }));
  await h.nextBatch();
  await h.answer(answers());
  assert.strictEqual(h.byName("B").status, "found");
});

test("an explicit NONE answer is final straight away - no retry", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A", "Ghost", "C"]));
  await h.answer(answers({ none: ["Ghost"] }));
  assert.strictEqual(h.byName("Ghost").status, "not_found");
  assert.strictEqual(h.byName("Ghost").attempts, undefined);
});

test("Google's CAPTCHA page pauses the run and brings the tab forward; solving it resumes the run", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A", "B", "C", "D"]));
  const tab = h.workerTab();
  const searchUrl = tab.url;

  h.navigate(tab.id, SORRY); // Google redirects the search to its CAPTCHA page
  await settle();
  assert.strictEqual(h.engine().isPaused, true);
  assert.strictEqual(h.engine().pauseKind, "captcha");
  assert.match(h.engine().pauseReason, /CAPTCHA showing for: A, B, C/);
  assert.ok(h.activated.includes(tab.id), "the CAPTCHA tab is brought to the front");
  assert.ok(h.alarms.get("arf-watchdog-0").delayInMinutes >= 10, "a person gets 10 minutes");

  h.navigate(tab.id, searchUrl); // solved: Google sends the tab back to the search
  await settle();
  assert.strictEqual(h.engine().isPaused, false, "the run resumes by itself");
  assert.ok(h.alarms.get("arf-watchdog-0").delayInMinutes < 10, "the normal timer is back for the search itself");

  await h.answer(answers());
  for (const n of ["A", "B", "C"]) assert.strictEqual(h.byName(n).status, "found", n);
  await h.nextBatch();
  assert.deepStrictEqual(await h.answer(answers()), ["D"], "and the run carries on");
});

test("a CAPTCHA page too long to show (Google's 400 error) is swapped for a short search's CAPTCHA, then the real search runs", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A", "B", "C", "D"]));
  const tab = h.workerTab();
  const searchUrl = tab.url;
  const landing = "https://www.google.com/search?q=agriculture%20companies&hl=en&pws=0";
  const sorryFor = (u) => `https://www.google.com/sorry/index?continue=${encodeURIComponent(u)}&q=token`;

  // While blocked, Google sends every search to its CAPTCHA page.
  h.setRedirect((u) => (u.startsWith(SEARCH) ? sorryFor(u) : null));
  const longSorry = sorryFor(searchUrl);
  assert.ok(longSorry.length > 4000, `the real CAPTCHA page address is ${longSorry.length} characters`);
  h.navigate(tab.id, longSorry); // what the screenshot showed
  await settle();

  assert.strictEqual(h.engine().isPaused, true);
  assert.ok(h.activated.includes(tab.id), "the tab is brought to the front");
  assert.strictEqual(h.tabs.get(tab.id).url, sorryFor(landing), "now on the SHORT search's CAPTCHA page, which works");
  await h.pageLoaded(tab.id);
  assert.strictEqual(h.tabs.get(tab.id).url, sorryFor(landing), "and left there for you to solve");

  // Solved: Google is happy again and sends the tab back to the short search.
  h.setRedirect(null);
  const contentOnLanding = await h.send({ type: "GET_CURRENT" }, { tab: { id: tab.id, url: landing } });
  assert.strictEqual(contentOnLanding, null, "the stand-in search is never read as an answer");
  h.navigate(tab.id, landing);
  await settle();
  assert.strictEqual(h.engine().isPaused, false, "the run resumes");
  assert.strictEqual(h.tabs.get(tab.id).url, searchUrl, "and the tab goes on to the batch's real search");

  await h.answer(answers());
  for (const n of ["A", "B", "C"]) assert.strictEqual(h.byName(n).status, "found", n);
});

test("if Google keeps refusing even the short search, the tab is not bounced around forever", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A"]));
  const tab = h.workerTab();
  const sorryFor = (u) => `https://www.google.com/sorry/index?continue=${encodeURIComponent(u)}&q=token`;
  // Every search, short or long, comes back as a too-long CAPTCHA page.
  const longTail = "x".repeat(5000);
  h.setRedirect((u) => (u.startsWith(SEARCH) ? sorryFor(u + longTail) : null));
  h.navigate(tab.id, sorryFor(tab.url + longTail));
  await settle();
  assert.ok(h.navigations.length < 12, `navigated ${h.navigations.length} times`);
  assert.strictEqual(h.engine().isPaused, true, "still waiting for a person");
});

test("solved, but Google lands on its home page: the tab is sent back to the same search", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A", "B"]));
  const tab = h.workerTab();
  const searchUrl = tab.url;
  h.navigate(tab.id, SORRY);
  await settle();
  h.navigate(tab.id, "https://www.google.com/");
  await settle();
  assert.strictEqual(h.tabs.get(tab.id).url, searchUrl);
  assert.strictEqual(h.engine().isPaused, false);
  await h.answer(answers());
  assert.strictEqual(h.byName("A").status, "found");
});

test("the cookie-consent page pauses the run the same way, with its own message", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A"]));
  const tab = h.workerTab();
  const searchUrl = tab.url;
  h.navigate(tab.id, "https://consent.google.com/ml?continue=x");
  await settle();
  assert.strictEqual(h.engine().isPaused, true);
  assert.match(h.engine().pauseReason, /accept or reject cookies/);
  h.navigate(tab.id, searchUrl);
  await settle();
  assert.strictEqual(h.engine().isPaused, false);
});

test("a CAPTCHA shown on the results page itself, solved without leaving the page, resumes on the answer", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A", "B"]));
  const tab = h.workerTab();
  const sender = { tab: { id: tab.id, url: tab.url } };
  const current = await h.send({ type: "GET_CURRENT" }, sender);
  await h.send({ type: "CAPTCHA_DETECTED", batchToken: current.batchToken }, sender);
  await settle();
  assert.strictEqual(h.engine().isPaused, true);
  await h.answer(answers());
  assert.strictEqual(h.engine().isPaused, false);
  assert.strictEqual(h.byName("A").status, "found");
});

test("an inline CAPTCHA page finishing loading, or being refreshed, never triggers a reload loop", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A", "B"]));
  const tab = h.workerTab();
  const sender = { tab: { id: tab.id, url: tab.url } };
  const current = await h.send({ type: "GET_CURRENT" }, sender);
  await h.send({ type: "CAPTCHA_DETECTED", batchToken: current.batchToken }, sender);
  await settle();
  const before = h.navigations.length;
  await h.pageLoaded(tab.id);
  await h.pageLoaded(tab.id);
  assert.strictEqual(h.navigations.length, before, "the extension did not navigate the tab");
  assert.strictEqual(h.engine().isPaused, true, "still waiting for the CAPTCHA");
});

test("repeated page loads off the search after a CAPTCHA never cause more than a couple of resends", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A"]));
  const tab = h.workerTab();
  const searchUrl = tab.url;
  h.navigate(tab.id, SORRY);
  await settle();
  for (let i = 0; i < 5; i++) {
    h.tabs.get(tab.id).url = "https://www.google.com/";
    await h.pageLoaded(tab.id);
  }
  const resends = h.navigations.filter((u) => u === searchUrl).length - 1;
  assert.ok(resends >= 1 && resends <= 2, `sent back ${resends} time(s)`);
  assert.strictEqual(h.engine().isPaused, false, "arriving back on the search resumed the run");
});

test("CAPTCHA not solved in 10 minutes: companies blocked, run stays paused; Resume searches them again", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A", "B", "C"]));
  const tab = h.workerTab();
  h.navigate(tab.id, SORRY);
  await settle();
  await h.fireWatchdog(); // the 10 minutes run out
  assert.strictEqual(h.byName("A").status, "blocked");
  assert.strictEqual(h.engine().isPaused, true);
  assert.strictEqual(h.engine().pauseKind, "captcha_giveup");

  // Even if it gets solved late, a give-up pause waits for Resume.
  await h.send({ type: "RESUME" });
  await settle();
  assert.strictEqual(h.byName("A").status, "pending", "Resume puts blocked companies back in the queue");
  assert.strictEqual(h.engine().isPaused, false);
  h.navigate(h.workerTab().id, SEARCH + "x"); // the tab is free again: the next batch navigates it
  await settle();
});

test("closing the worker tab mid-search loses nothing: its companies stay queued and get a new tab", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A", "B", "C"]));
  const first = h.workerTab();
  await h.closeTab(first.id);
  assert.strictEqual(h.byName("A").status, "pending");
  assert.strictEqual(h.byName("A").attempts, undefined, "not counted as a failed try");
  assert.deepStrictEqual(h.engine().workers[0].currentItemIds, []);
  assert.strictEqual(h.alarms.has("arf-watchdog-0"), false);
  await h.nextBatch();
  assert.notStrictEqual(h.workerTab().id, first.id, "a fresh tab");
  assert.deepStrictEqual(await h.answer(answers()), ["A", "B", "C"]);
});

test("closing the tab that shows the CAPTCHA keeps the run paused until Resume", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A", "B"]));
  const tab = h.workerTab();
  h.navigate(tab.id, SORRY);
  await settle();
  await h.closeTab(tab.id);
  assert.strictEqual(h.engine().isPaused, true);
  assert.strictEqual(h.engine().pauseKind, "manual");
  assert.match(h.engine().pauseReason, /closed before it was solved/);
  assert.strictEqual(h.byName("A").status, "pending");
});

test("a tab that never reports back (page failed to load) counts one try, and the run moves on", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A", "B", "C", "D"]));
  await h.fireWatchdog();
  assert.strictEqual(h.byName("A").status, "pending");
  assert.strictEqual(h.byName("A").attempts, 1);
  assert.deepStrictEqual(h.engine().workers[0].currentItemIds, [], "the worker is freed");
  await h.nextBatch();
  assert.deepStrictEqual(await h.answer(answers()), ["A", "B", "C"]);
});

test("several searches in a row with no answer at all pause the run instead of writing everything off", async () => {
  const h = makeHarness();
  const names = Array.from({ length: 15 }, (_, i) => `C${i}`);
  await h.start(await h.create(names));
  for (let i = 0; i < 4; i++) {
    await h.answer(nothing);
    await h.nextBatch();
  }
  assert.strictEqual(h.engine().isPaused, true);
  assert.strictEqual(h.engine().pauseKind, "empty_streak");
  assert.match(h.engine().pauseReason, /No answers came back for 4 searches in a row/);
  const counts = { pending: 0, not_found: 0 };
  for (const c of h.project().queue) counts[c.status]++;
  assert.ok(counts.pending >= 6, "most companies are still waiting, not written off");

  await h.send({ type: "RESUME" });
  await settle();
  assert.strictEqual(h.engine().isPaused, false);
  assert.strictEqual(h.engine().emptyStreak, 0);
});

test("one answered company resets the no-answer streak", async () => {
  const h = makeHarness();
  await h.start(await h.create(Array.from({ length: 12 }, (_, i) => `C${i}`)));
  for (let i = 0; i < 3; i++) {
    await h.answer(nothing);
    await h.nextBatch();
  }
  await h.answer(answers());
  assert.strictEqual(h.engine().emptyStreak, 0);
  assert.strictEqual(h.engine().isPaused, false);
});

test("Chrome restarting mid-run pauses it; Resume continues with nothing lost", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A", "B", "C", "D"]));
  await h.restartChrome();
  assert.strictEqual(h.engine().isPaused, true);
  assert.match(h.engine().pauseReason, /Chrome was restarted/);
  assert.deepStrictEqual(h.engine().workers[0].currentItemIds, []);
  assert.strictEqual(h.byName("A").status, "pending");
  await h.send({ type: "RESUME" });
  await settle();
  assert.deepStrictEqual(await h.answer(answers()), ["A", "B", "C"]);
});

test("Stop mid-search keeps the companies queued and does not start another search", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A", "B", "C"]));
  const tab = h.workerTab();
  await h.send({ type: "STOP" });
  await settle();
  assert.strictEqual(h.tabs.has(tab.id), false, "the worker tab is closed");
  assert.strictEqual(h.engine().isRunning, false);
  assert.strictEqual(h.byName("A").status, "pending");
  assert.strictEqual([...h.alarms.keys()].some((n) => n.startsWith("arf-next-")), false);
});

test("a late answer from a batch the worker already gave up on is ignored", async () => {
  const h = makeHarness();
  await h.start(await h.create(["A", "B", "C", "D"]));
  const tab = h.workerTab();
  const sender = { tab: { id: tab.id, url: tab.url } };
  const stale = await h.send({ type: "GET_CURRENT" }, sender);
  await h.fireWatchdog();
  await h.send({
    type: "RESULT", batchToken: stale.batchToken,
    results: stale.items.map((it) => ({ itemId: it.itemId, status: "found", entities: [{ entity: "Poultry", roles: ["Hatchery"] }] })),
  }, sender);
  await settle();
  assert.strictEqual(h.byName("A").status, "pending", "the stale report did not overwrite anything");
});
