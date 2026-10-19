// Parsing Google's answer text (what content.js reads off the page) into
// per-company blocks.
const test = require("node:test");
const assert = require("node:assert");
const { loadContentParser, loadBackground } = require("./load.js");

const { parseAnswer, answeredCount } = loadContentParser();
const bg = loadBackground();

const ITEMS = [
  { company_name: "ABC Seeds", website: "abcseeds.com", city: "Pune", state: "Maharashtra", country: "India" },
  { company_name: "Green Feeds", website: "", city: "Nashik", state: "", country: "India" },
  { company_name: "AquaGrow", website: "aquagrow.in", city: "", state: "", country: "India" },
];
const PROMPT = bg.buildPrompt(ITEMS);

const CLEAN = `COMPANY 1
DESCRIPTION: ABC Seeds produces hybrid vegetable seeds and sells them to farmers across India.
ENTITY: Seeds & biologicals | ROLES: Seed Company / Seed Producer; Seed Importer / Exporter
ENTITY: Fertilizers | ROLES: Fertilizer Distributor / Wholesaler
COMPANY 2
DESCRIPTION: Green Feeds makes compound cattle feed in Nashik.
ENTITY: Feed mill | ROLES: Compound Feed Manufacturer; Feed Brand
COMPANY 3
DESCRIPTION: AquaGrow supplies shrimp feed and probiotics to aqua farmers.
ENTITY: Aqua products & services | ROLES: Aqua Distributor
END OF ANSWERS`;

test("a clean answer gives one block per company, in the right place", () => {
  const p = parseAnswer(CLEAN, 3);
  assert.strictEqual(p.ended, true);
  assert.strictEqual(answeredCount(p, 3), 3);
  const b1 = p.blocks.get(1);
  assert.match(b1.description, /^ABC Seeds produces hybrid/);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(b1.entities)), [
    { entity: "Seeds & biologicals", roles: ["Seed Company / Seed Producer", "Seed Importer / Exporter"] },
    { entity: "Fertilizers", roles: ["Fertilizer Distributor / Wholesaler"] },
  ]);
  assert.strictEqual(p.blocks.get(3).entities[0].entity, "Aqua products & services");
});

test("the question itself, if Google shows it above the answer, is never read as an answer", () => {
  const page = `${PROMPT}\n\nAI Overview\n${CLEAN}\nAI responses may include mistakes.`;
  const p = parseAnswer(page, 3);
  assert.strictEqual(answeredCount(p, 3), 3);
  assert.strictEqual(p.blocks.get(1).entities.length, 2);
  // Only the question on the page, no answer yet: nothing parsed, not "ended".
  const onlyEcho = parseAnswer(PROMPT, 3);
  assert.strictEqual(onlyEcho.blocks.size, 0);
  assert.strictEqual(onlyEcho.ended, false);
});

test("the question never contains a 'COMPANY <digit>' line that could pass for an answer", () => {
  assert.doesNotMatch(PROMPT, /^\s*COMPANY\s*#?\s*\d/im);
});

test("bold labels, bullets and headings around the labels are tolerated", () => {
  const md = `**COMPANY 1**
- **DESCRIPTION:** ABC Seeds produces seeds.
- **ENTITY:** Seeds & biologicals | **ROLES:** Seed Distributor
## Company 2:
* DESCRIPTION: Green Feeds makes feed.
* ENTITY: Feed mill | ROLES: Feed Brand
COMPANY #3 - AquaGrow
DESCRIPTION: AquaGrow sells feed.
ENTITY: Aqua products & services | ROLES: Aqua Shop
**END OF ANSWERS**`;
  const p = parseAnswer(md, 3);
  assert.strictEqual(answeredCount(p, 3), 3);
  assert.strictEqual(p.ended, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.blocks.get(1).entities)), [
    { entity: "Seeds & biologicals", roles: ["Seed Distributor"] },
  ]);
  assert.strictEqual(p.blocks.get(2).description, "Green Feeds makes feed.");
});

test("a skipped company does not shift the others onto the wrong company", () => {
  const skipped = CLEAN.replace(/COMPANY 2[\s\S]*?(?=COMPANY 3)/, "");
  const p = parseAnswer(skipped, 3);
  assert.strictEqual(p.blocks.has(2), false);
  assert.match(p.blocks.get(3).description, /^AquaGrow/);
  assert.strictEqual(answeredCount(p, 3), 2);
});

test("an answer still being written is not treated as finished", () => {
  const partial = CLEAN.split("COMPANY 3")[0];
  const p = parseAnswer(partial, 3);
  assert.strictEqual(p.ended, false);
  assert.strictEqual(answeredCount(p, 3), 2);
});

test("NONE answers count as answered, with no entities", () => {
  const none = `COMPANY 1
DESCRIPTION: NONE
ENTITY: NONE
END OF ANSWERS`;
  const p = parseAnswer(none, 1);
  const b = p.blocks.get(1);
  assert.strictEqual(b.answered, true);
  assert.strictEqual(b.description, null);
  assert.strictEqual(b.entities.length, 0);
});

test("ROLES written on its own line is attached to the entity above it", () => {
  const split = `COMPANY 1
DESCRIPTION: ABC Seeds produces seeds.
ENTITY: Seeds & biologicals
ROLES: Seed Distributor; Seed Company / Seed Producer
END OF ANSWERS`;
  const b = parseAnswer(split, 1).blocks.get(1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(b.entities)), [
    { entity: "Seeds & biologicals", roles: ["Seed Distributor", "Seed Company / Seed Producer"] },
  ]);
});

test("a description broken over several lines is joined back up", () => {
  const multi = `COMPANY 1
DESCRIPTION: ABC Seeds produces hybrid vegetable seeds.
It sells them to farmers across India.
ENTITY: Seeds & biologicals | ROLES: Seed Distributor
END OF ANSWERS`;
  const b = parseAnswer(multi, 1).blocks.get(1);
  assert.strictEqual(b.description, "ABC Seeds produces hybrid vegetable seeds. It sells them to farmers across India.");
});

test("page text after the last company (Google's footer, sources) is ignored", () => {
  const withFooter = CLEAN.replace("END OF ANSWERS", "") + "\nAI responses may include mistakes.\nSources\nabcseeds.com";
  const b = parseAnswer(withFooter, 3).blocks.get(3);
  assert.strictEqual(b.description, "AquaGrow supplies shrimp feed and probiotics to aqua farmers.");
  assert.strictEqual(b.entities.length, 1);
});

test("without COMPANY lines, descriptions are paired in order only when the count is exact", () => {
  const unmarked = CLEAN.replace(/^COMPANY \d\n/gm, "");
  assert.strictEqual(answeredCount(parseAnswer(unmarked, 3), 3), 3);
  // One company short: too ambiguous to pair - nothing is guessed.
  assert.strictEqual(parseAnswer(unmarked, 4).blocks.size, 0);
});
