// business_type: always individual types, never a group label, and always
// consistent with the role's code.
const test = require("node:test");
const assert = require("node:assert");
const T = require("../taxonomy.js");

// The types decided for one role written by the AI under one entity.
function typesOf(entity, roleText) {
  const [c] = T.classify([{ entity, roles: [roleText] }]);
  return c.roles[0].types;
}

test("all 13 individual types, and every code only allows types from that list", () => {
  assert.deepStrictEqual(T.BUSINESS_TYPES, [
    "Manufacturer", "Third Party Manufacturer", "Exporter", "Importer", "Distributor", "Wholesaler",
    "Trader", "Supplier", "Retailer", "Service Provider", "Brand", "Formulator", "CRO",
  ]);
  for (const groups of Object.values(T.BUSINESS_TYPE_GROUPS_BY_CODE)) {
    for (const t of groups.flat()) assert.ok(T.BUSINESS_TYPES.includes(t), t);
  }
});

test("the AI's specific pick is used when the role's code allows it", () => {
  assert.deepStrictEqual(typesOf("Seeds & biologicals", "Seed Importer / Exporter [Exporter]"), ["Exporter"]);
  assert.deepStrictEqual(typesOf("Fertilizers", "Fertilizer Distributor / Wholesaler [Wholesaler]"), ["Wholesaler"]);
  assert.deepStrictEqual(typesOf("Seeds & biologicals", "Seed Importer / Exporter [Importer, Exporter]"), ["Exporter", "Importer"]);
  assert.deepStrictEqual(typesOf("Certification & labs", "Field Trial CRO [CRO]"), ["CRO"]);
});

test("a type the role's code doesn't allow is dropped (an EI role can only be Exporter or Importer)", () => {
  assert.deepStrictEqual(typesOf("Seeds & biologicals", "Seed Importer / Exporter [Trader]"), ["Exporter"]);
  assert.deepStrictEqual(typesOf("Seeds & biologicals", "Seed Importer / Exporter [Trader, Importer]"), ["Importer"]);
});

test("a one-type code is settled by the code alone, whatever the AI wrote", () => {
  assert.deepStrictEqual(typesOf("Fertilizers", "Fertilizer Manufacturer [Brand]"), ["Manufacturer"]);
  assert.deepStrictEqual(typesOf("Fertilizers", "Fertilizer Dealer / Retailer"), ["Retailer"]);
  assert.deepStrictEqual(typesOf("Vet hospitals", "Veterinary Hospital / Clinic"), ["Service Provider"]);
});

test("a group label the AI wrote anyway counts as no answer, never as the group", () => {
  assert.deepStrictEqual(typesOf("Fertilizers", "Fertilizer Distributor / Wholesaler [Distributor/Wholesaler]"), ["Distributor"]);
  assert.deepStrictEqual(typesOf("Agri Insurance", "Crop Insurance Provider [Exporter/Importer]"), []);
});

test("with no valid pick, the role's own name decides when it points to one type", () => {
  assert.deepStrictEqual(typesOf("Exporters & trading", "Merchant Exporter"), ["Exporter"]);
  assert.deepStrictEqual(typesOf("Exporters & trading", "Agri Commodity Importer"), ["Importer"]);
  assert.deepStrictEqual(typesOf("Dealers, distributors & importers", "Stockist / Wholesaler"), ["Wholesaler"]);
  assert.deepStrictEqual(typesOf("Regional trading", "Mandi Commission Agent / Commodity Trader"), ["Trader"]);
  assert.deepStrictEqual(typesOf("Exporters & trading", "Trading House"), ["Trader"]);
  assert.deepStrictEqual(typesOf("Certification & labs", "Field Trial CRO"), ["CRO"]);
  assert.deepStrictEqual(typesOf("Seeds & biologicals", "Biologicals Formulator / R&D"), ["Formulator"]);
});

test("otherwise the group's first type: Distributor, Exporter, Formulator", () => {
  assert.deepStrictEqual(typesOf("Fertilizers", "Fertilizer Distributor / Wholesaler"), ["Distributor"]);
  assert.deepStrictEqual(typesOf("Supply chain & logistics", "Produce Aggregator / Procurement Agent"), ["Distributor"]);
  assert.deepStrictEqual(typesOf("Seeds & biologicals", "Seed Importer / Exporter"), ["Exporter"]);
  assert.deepStrictEqual(typesOf("Livestock nutrition & vet", "Veterinary Formulation Developer"), ["Formulator"]);
});

test("EI+D allows one type from each group", () => {
  const role = "Agri-innovation Importer / Distributor";
  assert.deepStrictEqual(typesOf("Innovative agri solutions", role), ["Importer", "Distributor"]);
  assert.deepStrictEqual(typesOf("Innovative agri solutions", `${role} [Importer]`), ["Importer"]);
  assert.deepStrictEqual(typesOf("Innovative agri solutions", `${role} [Exporter, Trader]`), ["Exporter", "Trader"]);
});

test("G and on-list roles without a code stay blank", () => {
  assert.deepStrictEqual(typesOf("Crop farming", "Crop Farmer / Grower [Trader]"), []);
  assert.deepStrictEqual(typesOf("Investors & VCs", "Agri Venture Capital [Service Provider]"), []);
});

test("new roles take the AI's pick from the 13, or stay blank", () => {
  assert.deepStrictEqual(typesOf("Agri Insurance", "Crop Insurance Provider [Service Provider]"), ["Service Provider"]);
  assert.deepStrictEqual(typesOf("Fertilizers", "Bio-stimulant Trader [Traders, Supplier]"), ["Trader", "Supplier"]);
  assert.deepStrictEqual(typesOf("Agri Insurance", "Crop Insurance Provider [Insurer]"), []);
  assert.deepStrictEqual(typesOf("Agri Insurance", "Crop Insurance Provider"), []);
});

test("the [type] suffix never stops the role from being recognised", () => {
  const [c] = T.classify([{ entity: "Seeds & biologicals", roles: ["Seed Distributor (D) [Distributor]"] }]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(c.roles)), [
    { name: "Seed Distributor", code: "D", inList: true, types: ["Distributor"] },
  ]);
});

test("round brackets are read as types only when they hold real types", () => {
  assert.deepStrictEqual(T.splitRoleText("Seed Distributor (Distributor)"), { name: "Seed Distributor", typeWords: ["Distributor"] });
  assert.deepStrictEqual(T.splitRoleText("Micro-irrigation (Drip/Sprinkler) Manufacturer"), {
    name: "Micro-irrigation (Drip/Sprinkler) Manufacturer", typeWords: [],
  });
  assert.deepStrictEqual(T.splitRoleText("Seed Distributor (D)"), { name: "Seed Distributor (D)", typeWords: [] });
  assert.deepStrictEqual(typesOf("Irrigation", "Micro-irrigation (Drip/Sprinkler) Manufacturer"), ["Manufacturer"]);
});

test("the same role written twice keeps the types of both", () => {
  const [c] = T.classify([
    { entity: "Seeds & biologicals", roles: ["Seed Importer / Exporter [Exporter]", "seed importer/exporter [Importer]"] },
  ]);
  assert.strictEqual(c.roles.length, 1);
  assert.deepStrictEqual(c.roles[0].types, ["Exporter", "Importer"]);
});
