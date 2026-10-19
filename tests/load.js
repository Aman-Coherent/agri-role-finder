// Loads the extension's browser scripts into plain Node for testing, with
// just enough of the chrome.* / DOM surface stubbed for them to load. Nothing
// here talks to Google - these tests check the extension's own logic only.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

function chromeStub() {
  const noop = () => {};
  return {
    runtime: { id: "test", onMessage: { addListener: noop }, sendMessage: async () => ({ engine: {}, summaries: [] }) },
    alarms: { create: noop, clear: noop, onAlarm: { addListener: noop } },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    tabs: {}, windows: {}, scripting: {}, downloads: { download: noop },
  };
}

// background.js as the service worker sees it: importScripts("taxonomy.js")
// is honoured by evaluating that file into the same context first.
function loadBackground() {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, URL, URLSearchParams, chrome: chromeStub() });
  ctx.globalThis = ctx;
  ctx.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), ctx);
  return ctx;
}

// popup.js as popup.html loads it: taxonomy.js first, then popup.js, with a
// fake document whose elements accept anything.
function loadPopup() {
  const el = () => ({ addEventListener() {}, style: {}, value: "", textContent: "", appendChild() {}, options: [] });
  const ctx = vm.createContext({
    console, URL, Blob: class {}, setInterval: () => 0, alert: () => {},
    chrome: chromeStub(),
    document: { getElementById: el, createElement: el, activeElement: null },
  });
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(path.join(ROOT, "taxonomy.js"), "utf8"), ctx);
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
