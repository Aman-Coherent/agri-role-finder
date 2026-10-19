// The parts in between: reading the input CSV, checking a result against the
// list in background.js, and building the export rows.
const test = require("node:test");
const assert = require("node:assert");
const { loadBackground, loadPopup } = require("./load.js");

const bg = loadBackground();
const popup = loadPopup();

const plain = (v) => JSON.parse(JSON.stringify(v));

test("CSV columns are detected by meaning, and every input column is kept", () => {
  const csv = [
    "Native ID,Company Name,Country,State,City,Company Website,Notes",
    'IN001,"Green Agro, Pvt Ltd",India,Maharashtra,Pune,greenagro.in,keep me',
    "IN002,Blue Feeds,India,,Nashik,N/A,",
  ].join("\n");
  const { companies, columns, detected } = popup.parseCsv(csv);
  assert.deepStrictEqual(plain(columns), ["Native ID", "Company Name", "Country", "State", "City", "Company Website", "Notes"]);
  assert.deepStrictEqual(plain(detected), {
    native_id: "Native ID", website: "Company Website", company_name: "Company Name",
    city: "City", state: "State", country: "Country",
  });
  assert.strictEqual(companies[0].company_name, "Green Agro, Pvt Ltd");
  assert.strictEqual(companies[0].website, "greenagro.in");
  assert.strictEqual(companies[0].original.Notes, "keep me");
  // "N/A" is not sent to the AI as a website - but is exported untouched.
  assert.strictEqual(companies[1].website, "");
  assert.strictEqual(companies[1].original["Company Website"], "N/A");
});

test("rows sharing a native id still get separate internal ids", () => {
  const { companies } = popup.parseCsv("native_id,company\nX1,A\nX1,B");
  assert.notStrictEqual(companies[0].id, companies[1].id);
});

test("the question names the website when there is one, and the location otherwise", () => {
  const p = bg.buildPrompt([
    { company_name: "A", website: "a.com", city: "Pune", state: "MH", country: "India" },
    { company_name: "B", website: "", city: "", state: "", country: "", location: "Nashik, India" },
  ]);
  assert.match(p, /1\) "A" - website: a\.com - location: Pune, MH, India/);
  assert.match(p, /2\) "B" - location: Nashik, India/);
  assert.match(p, /Seeds & biologicals: Seed Company \/ Seed Producer; Seed Production Organiser/);
  assert.ok(encodeURIComponent(p).length < 20000, "URL stays within the length Google was checked to accept");
});

test("background decides on-list vs new itself, and status follows what survives", () => {
  const found = bg.sanitizeResultEntry({
    itemId: "r0",
    status: "found",
    description: "Makes seeds.",
    entities: [
      { entity: "seeds and biologicals", roles: ["Seed Distributor", "Seed Kiosk Operator"] },
      { entity: "Agri Insurance", roles: ["Crop Insurance; Advisory"] },
    ],
  });
  assert.strictEqual(found.status, "found");
  assert.deepStrictEqual(plain(found.classifications), [
    {
      entity: "Seeds & biologicals", entityInList: true,
      roles: [
        { name: "Seed Distributor", code: "D", inList: true },
        { name: "Seed Kiosk Operator", code: null, inList: false },
      ],
    },
    // A ";" inside one role name would read as two roles in the export.
    { entity: "Agri Insurance", entityInList: false, roles: [{ name: "Crop Insurance, Advisory", code: null, inList: false }] },
  ]);

  const describedOnly = bg.sanitizeResultEntry({ itemId: "r1", status: "found", description: "A firm.", entities: [] });
  assert.strictEqual(describedOnly.status, "not_found");
  assert.strictEqual(describedOnly.description, "A firm.");

  assert.strictEqual(bg.sanitizeResultEntry({ itemId: "r2", status: "bogus" }), null);
});

test("export rows split role by role between the two files, with codes and business types", () => {
  const item = {
    status: "found",
    classifications: bg.sanitizeResultEntry({
      itemId: "r0",
      status: "found",
      entities: [
        { entity: "Fertilizers", roles: ["Fertilizer Manufacturer", "Fertilizer Dealer / Retailer", "Bio-stimulant Trader"] },
        { entity: "Innovative agri solutions", roles: ["Agri-innovation Importer / Distributor"] },
        { entity: "Crop farming", roles: ["Crop Farmer / Grower"] },
        { entity: "Agri Insurance", roles: ["Crop Insurance Provider"] },
      ],
    }).classifications,
  };
  const { onList, fresh } = popup.splitClassifications(item);
  const rows = (parts) => parts.map((p) => [p.entity, popup.rolesCell(p.roles), popup.businessTypeCell(p.roles)]);
  assert.deepStrictEqual(plain(rows(onList)), [
    ["Fertilizers", "Fertilizer Manufacturer (M); Fertilizer Dealer / Retailer (R)", "Manufacturer; Retailer"],
    ["Innovative agri solutions", "Agri-innovation Importer / Distributor (EI+D)", "Exporter/Importer; Distributor/Wholesaler/Trader/Supplier"],
    // G has no business type.
    ["Crop farming", "Crop Farmer / Grower (G)", ""],
  ]);
  assert.deepStrictEqual(plain(rows(fresh)), [
    ["Fertilizers", "Bio-stimulant Trader", ""],
    ["Agri Insurance", "Crop Insurance Provider", ""],
  ]);
});

test("an input column with the same name as an added one doesn't collide", () => {
  assert.deepStrictEqual(plain(popup.resultHeader(["Company", "Description"], ["description", "entity"])), [
    "Company", "Description", "description_found", "entity",
  ]);
});

test("CSV output quotes every cell and neutralises formula-like values", () => {
  const csv = popup.toCsv(["a", "b"], [["=SUM(1)", 'say "hi"']]);
  assert.strictEqual(csv, `"a","b"\n"'=SUM(1)","say ""hi"""`);
});
