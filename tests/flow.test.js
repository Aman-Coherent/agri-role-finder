// The parts in between: reading the input CSV, checking a result against the
// list in background.js, and building the export rows.
const test = require("node:test");
const assert = require("node:assert");
const { loadBackground, loadPopup } = require("./load.js");

const bg = loadBackground();
const popup = loadPopup();

const plain = (v) => JSON.parse(JSON.stringify(v));
const ARF_STORE = require("../store.js");
const vm = require("vm");

test("CSV columns are detected by meaning, and only the ones the extension uses are kept", () => {
  const csv = [
    "Native ID,Company Name,Country,State,City,Company Website,Notes",
    'IN001,"Green Agro, Pvt Ltd",India,Maharashtra,Pune,greenagro.in,not kept',
    "IN002,Blue Feeds,India,,Nashik,N/A,",
  ].join("\n");
  const { companies, detected } = popup.parseCsv(csv);
  assert.deepStrictEqual(plain(detected), {
    native_id: "Native ID", website: "Company Website", company_name: "Company Name",
    city: "City", state: "State", country: "Country",
  });
  assert.deepStrictEqual(plain(companies[0]), {
    native_id: "IN001", company_name: "Green Agro, Pvt Ltd", website: "greenagro.in",
    city: "Pune", state: "Maharashtra", country: "India", location: "",
  });
  // "N/A" is not sent to the AI as a website.
  assert.strictEqual(companies[1].website, "");
});

test("a lead_id column is the native id", () => {
  const { companies, detected } = popup.parseCsv("lead_id,company_name,city\nL9,Green Agro,Pune");
  assert.strictEqual(detected.native_id, "lead_id");
  assert.strictEqual(companies[0].native_id, "L9");
});

test("rows sharing a native id still get separate internal ids", () => {
  const { companies } = popup.parseCsv("native_id,company\nX1,A\nX1,B");
  const ids = ARF_STORE.buildChunks(companies).flatMap((c) => c.items.map((it) => it.id));
  assert.deepStrictEqual(ids, ["r0", "r1"]);
});

test("the question names the website when there is one, and the location otherwise", () => {
  const p = bg.buildPrompt([
    { company_name: "A", website: "a.com", city: "Pune", state: "MH", country: "India" },
    { company_name: "B", website: "", city: "", state: "", country: "", location: "Nashik, India" },
  ]);
  assert.match(p, /1\) "A" - website: a\.com - location: Pune, MH, India/);
  assert.match(p, /2\) "B" - location: Nashik, India/);
  assert.match(p, /Seeds & biologicals: Seed Company \/ Seed Producer; Seed Production Organiser/);
  assert.match(p, /ROLES: <role> \[<business type>\]/);
  assert.match(p, /Manufacturer, Third Party Manufacturer, Exporter, Importer, Distributor, Wholesaler, Trader, Supplier, Retailer, Service Provider, Brand, Formulator, CRO\./);
  assert.ok(encodeURIComponent(p).length < 20000, "URL stays within the length Google was checked to accept");
});

test("background decides on-list vs new itself, and status follows what survives", () => {
  const found = bg.sanitizeResultEntry({
    itemId: "r0",
    status: "found",
    description: "Makes seeds.",
    entities: [
      { entity: "seeds and biologicals", roles: ["Seed Distributor [Wholesaler]", "Seed Kiosk Operator [Retailer]"] },
      { entity: "Agri Insurance", roles: ["Crop Insurance; Advisory"] },
    ],
  });
  assert.strictEqual(found.status, "found");
  assert.deepStrictEqual(plain(found.classifications), [
    {
      entity: "Seeds & biologicals", entityInList: true,
      roles: [
        { name: "Seed Distributor", code: "D", inList: true, types: ["Wholesaler"] },
        { name: "Seed Kiosk Operator", code: null, inList: false, types: ["Retailer"] },
      ],
    },
    // A ";" inside one role name would read as two roles in the export.
    { entity: "Agri Insurance", entityInList: false, roles: [{ name: "Crop Insurance, Advisory", code: null, inList: false, types: [] }] },
  ]);

  const describedOnly = bg.sanitizeResultEntry({ itemId: "r1", status: "found", description: "A firm.", entities: [] });
  assert.strictEqual(describedOnly.status, "not_found");
  assert.strictEqual(describedOnly.description, "A firm.");

  assert.strictEqual(bg.sanitizeResultEntry({ itemId: "r2", status: "bogus" }), null);
  // "No answer this time" passes through as-is for handleResult to retry.
  assert.deepStrictEqual(plain(bg.sanitizeResultEntry({ itemId: "r3", status: "missing", entities: [{ entity: "Poultry" }] })), {
    itemId: "r3", status: "missing",
  });
});

test("export rows split role by role between the two files, with codes and business types", () => {
  const item = {
    status: "found",
    classifications: bg.sanitizeResultEntry({
      itemId: "r0",
      status: "found",
      entities: [
        { entity: "Fertilizers", roles: ["Fertilizer Manufacturer [Manufacturer]", "Fertilizer Dealer / Retailer", "Bio-stimulant Trader [Trader]"] },
        { entity: "Innovative agri solutions", roles: ["Agri-innovation Importer / Distributor"] },
        { entity: "Crop farming", roles: ["Crop Farmer / Grower"] },
        { entity: "Agri Insurance", roles: ["Crop Insurance Provider [Service Provider]"] },
        { entity: "Seeds & biologicals", roles: ["Seed Importer / Exporter [Exporter]", "Seed Distributor [Trader]"] },
      ],
    }).classifications,
  };
  const { onList, fresh } = popup.splitClassifications(item);
  const rows = (parts) => parts.map((p) => [p.entity, popup.rolesCell(p.roles), popup.businessTypeCell(p.roles)]);
  assert.deepStrictEqual(plain(rows(onList)), [
    ["Fertilizers", "Fertilizer Manufacturer (M); Fertilizer Dealer / Retailer (R)", "Manufacturer; Retailer"],
    // No type given: the role name points to Importer and Distributor.
    ["Innovative agri solutions", "Agri-innovation Importer / Distributor (EI+D)", "Importer; Distributor"],
    // G has no business type.
    ["Crop farming", "Crop Farmer / Grower (G)", ""],
    // Individual types, one per role, each once.
    ["Seeds & biologicals", "Seed Importer / Exporter (EI); Seed Distributor (D)", "Exporter; Trader"],
  ]);
  assert.deepStrictEqual(plain(rows(fresh)), [
    // New roles keep the AI pick; each row shows only its own roles types.
    ["Fertilizers", "Bio-stimulant Trader", "Trader"],
    ["Agri Insurance", "Crop Insurance Provider", "Service Provider"],
  ]);
});

test("every export has the same fixed columns, whatever the input file called them", () => {
  // Top-level consts of a script are reachable from later code run in its context.
  assert.deepStrictEqual(plain(vm.runInContext("INPUT_COLUMNS", popup)), ["native_id", "company_name", "country", "state", "city", "website"]);
  assert.deepStrictEqual(plain(vm.runInContext("RESULT_COLUMNS", popup)), ["description", "entity", "roles", "business_type"]);
  assert.deepStrictEqual(plain(popup.inputCells({ native_id: "L9", company_name: "A", city: "Pune" })), ["L9", "A", "", "", "Pune", ""]);
});

test("CSV output quotes every cell and neutralises formula-like values", () => {
  const csv = popup.toCsv(["a", "b"], [["=SUM(1)", 'say "hi"']]);
  assert.strictEqual(csv, `"a","b"\n"'=SUM(1)","say ""hi"""`);
});
