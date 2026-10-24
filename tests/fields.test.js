// "What to find" per project: Description / Entities / Roles / Business type.
// The hard rule being tested: choosing what to find must never change the
// quality of what is found. So:
//   - any choice that includes entities, roles or business types sends the
//     EXACT question the extension always sent (compared byte-for-byte with a
//     copy saved before this feature was built, in tests/fixtures);
//   - "Description only" sends a shorter question made only of the full
//     question's own sentences.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { loadBackground, loadPopup, loadContentParser } = require("./load.js");
const ARF_STORE = require("../store.js");

const bg = loadBackground();
const popup = loadPopup();
const { parseAnswer, answeredCount } = loadContentParser();
const plain = (v) => JSON.parse(JSON.stringify(v));

const ITEMS = [
  { company_name: "Sousho Inc.", website: "https://www.so-sho.jp/", city: "Osaka", state: "Osaka", country: "Japan" },
  { company_name: "Logic Inc.", website: "", city: "Kanazawa", state: "", country: "Japan" },
  { company_name: "B&B Recycling GmbH", website: "https://bb-recycling.de", location: "Schönefeld OT Selchow, Germany" },
];
const FIXTURE_3 = fs.readFileSync(path.join(__dirname, "fixtures", "full-question-3-companies.txt"), "utf8");
const FIXTURE_1 = fs.readFileSync(path.join(__dirname, "fixtures", "full-question-1-company.txt"), "utf8");

// Every non-empty combination of the four ticks.
const ALL = ARF_STORE.ALL_FIELDS;
const COMBINATIONS = [];
for (let mask = 1; mask < 1 << ALL.length; mask++) COMBINATIONS.push(ALL.filter((_, i) => mask & (1 << i)));

test("every choice that includes entities, roles or business types sends today's exact question, byte for byte", () => {
  const classified = COMBINATIONS.filter((c) => c.some((f) => f !== "description"));
  assert.strictEqual(classified.length, 14);
  for (const fields of classified) {
    assert.strictEqual(bg.buildPrompt(ITEMS, fields), FIXTURE_3, `fields: ${fields.join(", ")}`);
    assert.strictEqual(bg.buildPrompt([ITEMS[0]], fields), FIXTURE_1, `fields: ${fields.join(", ")}`);
  }
  // Projects made before this choice existed have no fields stored: everything.
  assert.strictEqual(bg.buildPrompt(ITEMS), FIXTURE_3);
  assert.strictEqual(bg.buildPrompt(ITEMS, []), FIXTURE_3);
});

test("the Description-only question is made only of the full question's own sentences", () => {
  const desc = bg.buildPrompt(ITEMS, ["description"]);
  const fullLines = new Set(FIXTURE_3.split("\n"));
  const fullNone = FIXTURE_3.split("\n").find((l) => l.startsWith("If you cannot find reliable information"));
  for (const line of desc.split("\n")) {
    if (line.startsWith("If you cannot find reliable information")) {
      // The one sentence that has to differ: it no longer mentions ENTITY.
      assert.strictEqual(line, fullNone.replace(" and ENTITY: NONE", "").replace(/\s+$/, ""));
      continue;
    }
    if (line.startsWith("Use the same company numbers")) {
      // In the full question this sentence follows "Write one ENTITY line...".
      assert.ok(FIXTURE_3.includes(line), line);
      continue;
    }
    assert.ok(fullLines.has(line), `not in the full question: ${JSON.stringify(line)}`);
  }
  // The description instruction itself is identical.
  const task = "(a) Write a factual description of what the company actually does - its main products or services and who it sells to - in 2 to 3 sentences, on ONE line.";
  assert.ok(desc.includes(task) && FIXTURE_3.includes(task));
  // ...and nothing about entities, roles, business types or the list.
  assert.doesNotMatch(desc, /ENTITY|ROLE|business type|LIST/);
  assert.ok(desc.length < FIXTURE_3.length / 5, `${desc.length} vs ${FIXTURE_3.length} characters`);
});

test("a Description-only answer is read by the same reader", () => {
  const answer = `COMPANY 1\nDESCRIPTION: Sousho makes precision chucks.\nCOMPANY 2\nDESCRIPTION: NONE\nCOMPANY 3\nDESCRIPTION: B&B recycles plastics.\nEND OF ANSWERS`;
  const p = parseAnswer(answer, 3);
  assert.strictEqual(answeredCount(p, 3), 3);
  assert.strictEqual(p.ended, true);
  assert.strictEqual(p.blocks.get(1).description, "Sousho makes precision chucks.");
  assert.strictEqual(p.blocks.get(2).description, null);
  assert.deepStrictEqual(plain(p.blocks.get(3).entities), []);
});

test("'found' follows what the project asks for", () => {
  const described = { itemId: "r0", status: "not_found", description: "Makes chucks.", entities: [] };
  assert.strictEqual(bg.sanitizeResultEntry(described, ["description"]).status, "found");
  assert.strictEqual(bg.sanitizeResultEntry(described, ALL).status, "not_found", "full projects: unchanged - needs an entity");
  assert.strictEqual(bg.sanitizeResultEntry(described).status, "not_found", "old projects: unchanged");
  assert.strictEqual(bg.sanitizeResultEntry({ itemId: "r1", status: "not_found", description: "NONE" }, ["description"]).status, "not_found");
  const classified = { itemId: "r2", status: "found", description: "x", entities: [{ entity: "Poultry", roles: ["Hatchery"] }] };
  assert.strictEqual(bg.sanitizeResultEntry(classified, ["roles"]).status, "found");
});

// --- Downloads ---

const ITEM = {
  status: "found",
  native_id: "L1", company_name: "ABC Agro", country: "India", state: "MH", city: "Pune", website: "abc.in",
  description: "ABC sells seeds and fertilizers.",
  classifications: bg.sanitizeResultEntry({
    itemId: "r0", status: "found",
    entities: [
      { entity: "Seeds & biologicals", roles: ["Seed Distributor [Distributor]", "Seed Importer / Exporter [Importer]"] },
      { entity: "Fertilizers", roles: ["Fertilizer Dealer / Retailer"] },
    ],
  }).classifications,
};
const INPUT = ["L1", "ABC Agro", "India", "MH", "Pune", "abc.in"];

test("with everything ticked, the downloads are exactly as before", () => {
  // The rows the extension produced before this feature, built the old way.
  const old = popup.splitClassifications(ITEM).onList.map((p) => [
    ...INPUT, ITEM.description, p.entity, popup.rolesCell(p.roles), popup.businessTypeCell(p.roles),
  ]);
  assert.deepStrictEqual(plain(popup.classifiedRows(ITEM, "onList", ALL)), plain(old));
  assert.deepStrictEqual(plain(popup.resultColumns(ALL)), ["description", "entity", "roles", "business_type"]);
  assert.deepStrictEqual(plain(popup.classifiedRows(ITEM, "onList", undefined)), plain(old), "old projects too");
});

test("only the ticked columns are downloaded", () => {
  assert.deepStrictEqual(plain(popup.resultColumns(["entities", "roles"])), ["entity", "roles"]);
  assert.deepStrictEqual(plain(popup.classifiedRows(ITEM, "onList", ["entities", "roles"])), [
    [...INPUT, "Seeds & biologicals", "Seed Distributor (D); Seed Importer / Exporter (EI)"],
    [...INPUT, "Fertilizers", "Fertilizer Dealer / Retailer (R)"],
  ]);
});

test("without Entities ticked, a company's roles / business types are merged into one row", () => {
  assert.deepStrictEqual(plain(popup.classifiedRows(ITEM, "onList", ["roles"])), [
    [...INPUT, "Seed Distributor (D); Seed Importer / Exporter (EI); Fertilizer Dealer / Retailer (R)"],
  ]);
  assert.deepStrictEqual(plain(popup.classifiedRows(ITEM, "onList", ["businessType"])), [
    [...INPUT, "Distributor; Importer; Retailer"],
  ]);
  assert.deepStrictEqual(plain(popup.classifiedRows(ITEM, "onList", ["description", "businessType"])), [
    [...INPUT, ITEM.description, "Distributor; Importer; Retailer"],
  ]);
});

test("a merged row with nothing to show is left out", () => {
  const noRoles = { ...ITEM, classifications: [{ entity: "Poultry", entityInList: true, roles: [] }] };
  assert.deepStrictEqual(plain(popup.classifiedRows(noRoles, "onList", ["roles"])), []);
  assert.strictEqual(popup.classifiedRows(noRoles, "onList", ["entities"]).length, 1, "with Entities ticked it still shows");
});

test("the fields list is shared, ordered, and defaults to everything", () => {
  assert.deepStrictEqual(ARF_STORE.normalizeFields(["roles", "description", "bogus"]), ["description", "roles"]);
  assert.deepStrictEqual(ARF_STORE.normalizeFields(undefined), ALL);
  assert.strictEqual(ARF_STORE.needsClassification(["description"]), false);
  assert.strictEqual(ARF_STORE.needsClassification(["description", "businessType"]), true);
  assert.deepStrictEqual(plain(vm.runInContext("FIELD_COLUMN", popup)), {
    description: "description", entities: "entity", roles: "roles", businessType: "business_type",
  });
});

// --- The tick boxes in the popup ---

function popupWithElements() {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, addEventListener() {}, style: {}, value: "", textContent: "", appendChild() {}, options: [] });
  const boxes = ARF_STORE.ALL_FIELDS.map((value) => ({ value, checked: true, disabled: false }));
  const ctx = vm.createContext({
    console, URL, Blob: class {}, setInterval: () => 0, alert: () => {},
    chrome: { runtime: { sendMessage: async () => ({ engine: {}, summaries: [] }) }, storage: { local: {} }, downloads: {} },
    document: { getElementById: el, createElement: el, querySelectorAll: () => boxes, activeElement: null },
  });
  ctx.globalThis = ctx;
  for (const f of ["taxonomy.js", "store.js", "popup.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), ctx);
  return { ctx, els, boxes };
}

test("for a selected project the ticks show what it finds, locked; downloads switch to match", () => {
  const { ctx, els, boxes } = popupWithElements();
  ctx.renderFieldChoices({ name: "P", fields: ["description"] });
  assert.deepStrictEqual(boxes.map((b) => [b.value, b.checked, b.disabled]), [
    ["description", true, true], ["entities", false, true], ["roles", false, true], ["businessType", false, true],
  ]);
  assert.match(els.fieldsHint.textContent, /"P" finds: Description\. Chosen when the project was created/);
  assert.strictEqual(els.exportResults.style.display, "");
  assert.strictEqual(els.exportOnList.style.display, "none");
  assert.strictEqual(els.exportNew.style.display, "none");

  ctx.renderFieldChoices({ name: "Q", fields: ["roles", "businessType"] });
  assert.strictEqual(els.exportResults.style.display, "none");
  assert.strictEqual(els.exportOnList.style.display, "");
  assert.match(els.exportHintText.textContent, /One row per company \(no entity column/);
});

test("while creating a new project the ticks are editable and become its choice", () => {
  const { ctx, boxes } = popupWithElements();
  vm.runInContext("newProjectFormOpen = true", ctx);
  ctx.renderFieldChoices({ name: "P", fields: ["description"] });
  assert.ok(boxes.every((b) => !b.disabled), "editable");
  boxes[1].checked = false; // untick Entities
  boxes[2].checked = false; // untick Roles
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.chosenFields())), ["description", "businessType"]);
});
