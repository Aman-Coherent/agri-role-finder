const test = require("node:test");
const assert = require("node:assert");
const T = require("../taxonomy.js");

test("list has every entity and role", () => {
  assert.strictEqual(T.TAXONOMY.length, 49);
  assert.strictEqual(T.TAXONOMY.reduce((s, e) => s + e.roles.length, 0), 240);
});

test("every role is found under its own entity by its own name", () => {
  for (const e of T.TAXONOMY) {
    assert.strictEqual(T.findEntity(e.entity), e, e.entity);
    for (const r of e.roles) assert.strictEqual(T.findRole(e, r[0]), r, `${e.entity} / ${r[0]}`);
  }
});

test("exact names are on the list, with the code attached from the list", () => {
  const [c] = T.classify([{ entity: "Seeds & biologicals", roles: ["Seed Distributor", "Seed Importer / Exporter"] }]);
  assert.strictEqual(c.entity, "Seeds & biologicals");
  assert.strictEqual(c.entityInList, true);
  assert.deepStrictEqual(
    c.roles.map((r) => [r.name, r.code, r.inList]),
    [["Seed Distributor", "D", true], ["Seed Importer / Exporter", "EI", true]]
  );
});

test("small spelling differences still count as on the list, exported in the list's own spelling", () => {
  const [c] = T.classify([
    { entity: "SEEDS AND BIOLOGICALS", roles: ["**seed distributor**", "Seed Importer/Exporter (EI)", "Biologicals Manufacturer"] },
  ]);
  assert.strictEqual(c.entity, "Seeds & biologicals");
  assert.deepStrictEqual(
    c.roles.map((r) => [r.name, r.code, r.inList]),
    [
      ["Seed Distributor", "D", true],
      ["Seed Importer / Exporter", "EI", true],
      ["Biologicals Manufacturer, i.e. biofertilizer/biopesticide", "M", true],
    ]
  );
});

test("shortened forms of long names match", () => {
  const [irr] = T.classify([{ entity: "Irrigation", roles: ["Micro-irrigation Manufacturer"] }]);
  assert.strictEqual(irr.roles[0].name, "Micro-irrigation (Drip/Sprinkler) Manufacturer");
  const [crop] = T.classify([{ entity: "Crop farming", roles: ["Farmer Producer Organisation"] }]);
  assert.strictEqual(crop.roles[0].name, "Farmer Producer Organisation, FPO");
  assert.strictEqual(T.findEntity("Agri-tech").entity, "Agri-tech, IoT, drones, robotics");
});

test("a role not on the entity's list is new, but the entity stays on the list", () => {
  const [c] = T.classify([{ entity: "Fertilizers", roles: ["Fertilizer Dealer / Retailer", "Bio-stimulant Trader"] }]);
  assert.strictEqual(c.entityInList, true);
  assert.deepStrictEqual(
    c.roles.map((r) => [r.name, r.code, r.inList]),
    [["Fertilizer Dealer / Retailer", "R", true], ["Bio-stimulant Trader", null, false]]
  );
});

test("a role from a DIFFERENT entity's list is new here - roles are only checked inside their own entity", () => {
  const [c] = T.classify([{ entity: "Fertilizers", roles: ["Seed Distributor"] }]);
  assert.strictEqual(c.roles[0].inList, false);
});

test("a new entity keeps the AI's wording and all its roles are new", () => {
  const [c] = T.classify([{ entity: "Agri Insurance", roles: ["Crop Insurance Provider"] }]);
  assert.strictEqual(c.entity, "Agri Insurance");
  assert.strictEqual(c.entityInList, false);
  assert.deepStrictEqual(c.roles, [{ name: "Crop Insurance Provider", code: null, inList: false }]);
});

test("the same entity written twice is merged, and repeated roles are kept once", () => {
  const out = T.classify([
    { entity: "Poultry", roles: ["Hatchery", "Broiler Farm"] },
    { entity: "poultry", roles: ["hatchery", "Poultry Brand"] },
  ]);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].roles.map((r) => r.name), ["Hatchery", "Broiler Farm", "Poultry Brand"]);
});

test("the same role name carries each entity's own code", () => {
  const [a] = T.classify([{ entity: "Agri input / equipment manufacturer", roles: ["Manufacturer-Exporter"] }]);
  const [b] = T.classify([{ entity: "Exporters & trading", roles: ["Manufacturer-Exporter"] }]);
  assert.strictEqual(a.roles[0].code, "EI");
  assert.strictEqual(b.roles[0].code, "M");
});

test("business type comes from the codes; G and code-less roles add nothing", () => {
  assert.deepStrictEqual(T.businessTypesFor(["M", "D", "M"]), ["Manufacturer", "Distributor/Wholesaler/Trader/Supplier"]);
  assert.deepStrictEqual(T.businessTypesFor(["EI+D"]), ["Exporter/Importer", "Distributor/Wholesaler/Trader/Supplier"]);
  assert.deepStrictEqual(T.businessTypesFor(["G"]), []);
  assert.deepStrictEqual(T.businessTypesFor([]), []);
});
