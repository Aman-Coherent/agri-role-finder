// Loads the extension's browser scripts into plain Node for testing, with
// just enough of the chrome.* / DOM surface stubbed for them to load. Nothing
// here talks to Google - these tests check the extension's own logic only.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

function chromeStub() {
  const noop = () => {};
  const event = () => ({ addListener: noop });
  return {
    runtime: {
      id: "test", onMessage: event(), onStartup: event(), onInstalled: event(),
      sendMessage: async () => ({ engine: {}, summaries: [] }),
    },
    alarms: { create: noop, clear: noop, onAlarm: event() },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    tabs: { onUpdated: event(), onRemoved: event() }, windows: {}, scripting: {}, downloads: { download: noop },
  };
}

// background.js as the service worker sees it: importScripts(...) is
// honoured by evaluating those files into the same context first.
function loadBackground() {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, URL, URLSearchParams, chrome: chromeStub() });
  ctx.globalThis = ctx;
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx));
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), ctx);
  return ctx;
}

// popup.js as popup.html loads it: taxonomy.js and store.js first, with a
// fake document whose elements accept anything.
function loadPopup() {
  const el = () => ({ addEventListener() {}, style: {}, value: "", textContent: "", appendChild() {}, options: [] });
  const ctx = vm.createContext({
    console, URL, Blob: class {}, setInterval: () => 0, alert: () => {},
    chrome: chromeStub(),
    document: { getElementById: el, createElement: el, activeElement: null },
  });
  ctx.globalThis = ctx;
  for (const f of ["taxonomy.js", "store.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "popup.js"), "utf8"), ctx);
  return ctx;
}

// content.js exports its parser when `module` exists (and skips run()).
function loadContentParser() {
  const ctx = vm.createContext({ console, window: {}, module: { exports: {} } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "content.js"), "utf8"), ctx);
  return ctx.module.exports;
}

module.exports = { loadBackground, loadPopup, loadContentParser, ROOT };
