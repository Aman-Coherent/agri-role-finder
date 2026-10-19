/**
 * taxonomy.js - the fixed list of entities and roles every company is
 * classified against, plus the helpers that decide whether an AI answer is
 * "on the list" or "new".
 *
 * THIS IS THE ONE FILE TO EDIT when the list changes. Each role is
 * [name, code]. The code drives the business_type column (see
 * BUSINESS_TYPE_BY_CODE); a role with no code (null) gets a blank
 * business_type. Names are matched forgivingly (case, "&" vs "and",
 * punctuation, a trailing "(M)"), but what gets exported is always the exact
 * name written here, never the AI's spelling of it.
 *
 * Loaded by background.js via importScripts(), and by plain Node for tests -
 * hence the globalThis / module.exports pair at the bottom instead of ES
 * module syntax (an MV3 service worker can only importScripts() classic
 * scripts).
 */

// G (Grower) is deliberately absent: the business-type dropdown this feeds
// has no Grower option, so G roles export a blank business_type, the same as
// roles with no code at all.
const BUSINESS_TYPE_BY_CODE = {
  M: ["Manufacturer"],
  "3PM": ["Third Party Manufacturer"],
  EI: ["Exporter/Importer"],
  D: ["Distributor/Wholesaler/Trader/Supplier"],
  R: ["Retailer"],
  SP: ["Service Provider"],
  B: ["Brand"],
  F: ["Formulator/CRO"],
  "EI+D": ["Exporter/Importer", "Distributor/Wholesaler/Trader/Supplier"],
};

const TAXONOMY = [
  // Input & upstream
  {
    group: "Input & upstream",
    entity: "Seeds & biologicals",
    roles: [
      ["Seed Company / Seed Producer", "M"],
      ["Seed Production Organiser", "3PM"],
      ["Seed Importer / Exporter", "EI"],
      ["Seed Distributor", "D"],
      ["Biologicals Manufacturer, i.e. biofertilizer/biopesticide", "M"],
      ["Biologicals Formulator / R&D", "F"],
    ],
  },
  {
    group: "Input & upstream",
    entity: "Fertilizers",
    roles: [
      ["Fertilizer Manufacturer", "M"],
      ["Fertilizer Contract / Toll Manufacturer", "3PM"],
      ["Fertilizer Importer / Exporter", "EI"],
      ["Fertilizer Distributor / Wholesaler", "D"],
      ["Fertilizer Dealer / Retailer", "R"],
      ["Fertilizer Brand Owner / Marketer", "B"],
      ["Specialty Fertilizer Formulator", "F"],
    ],
  },
  {
    group: "Input & upstream",
    entity: "Crop protection",
    roles: [
      ["Agrochemical Technical Manufacturer", "M"],
      ["Agrochemical Formulation Manufacturer", "M"],
      ["Agrochemical Contract / Toll Manufacturer", "3PM"],
      ["Agrochemical Importer / Exporter", "EI"],
      ["Pesticide Distributor", "D"],
      ["Pesticide Retailer", "R"],
      ["Agrochemical Brand Marketer", "B"],
      ["Formulation Developer / Registration CRO", "F"],
    ],
  },
  {
    group: "Input & upstream",
    entity: "Coco peat / substrate",
    roles: [
      ["Coco Peat / Substrate Manufacturer", "M"],
      ["Private-label Substrate Manufacturer", "3PM"],
      ["Coco Peat Exporter / Importer", "EI"],
      ["Growing Media Distributor", "D"],
      ["Potting Mix / Garden Retailer", "R"],
      ["Growing Media Brand", "B"],
    ],
  },
  {
    group: "Input & upstream",
    entity: "Agri inputs & solutions",
    roles: [
      ["Integrated Agri-input Company", "M"],
      ["Agri-input Contract Manufacturer", "3PM"],
      ["Agri-input Importer / Exporter", "EI"],
      ["Multi-brand Agri-input Distributor", "D"],
      ["Agri-input Retail Chain / Krishi Kendra", "R"],
      ["Agronomy / Crop Advisory Service", "SP"],
      ["Agri-input Brand", "B"],
      ["Agri-input Formulator", "F"],
    ],
  },
  {
    group: "Input & upstream",
    entity: "Innovative agri solutions",
    roles: [
      ["Innovative Agri-product Manufacturer", "M"],
      ["Agri-innovation Importer / Distributor", "EI+D"],
      ["Agri Solution Integrator", "SP"],
      ["Agri-innovation Brand", "B"],
    ],
  },
  {
    group: "Input & upstream",
    entity: "Livestock nutrition & vet",
    roles: [
      ["Feed Additive / Premix Manufacturer", "M"],
      ["Veterinary Medicine & Vaccine Manufacturer", "M"],
      ["Animal Health Contract Manufacturer", "3PM"],
      ["Animal Health Importer / Exporter", "EI"],
      ["Veterinary Product Distributor", "D"],
      ["Veterinary Medical Store", "R"],
      ["Animal Health Marketing Company", "B"],
      ["Veterinary Formulation Developer", "F"],
    ],
  },
  {
    group: "Input & upstream",
    entity: "Aquaculture input & tech",
    roles: [
      ["Aqua Feed Manufacturer", "M"],
      ["Aquaculture Equipment Manufacturer", "M"],
      ["Aqua Contract Manufacturer", "3PM"],
      ["Aqua Input Importer / Exporter", "EI"],
      ["Aqua Input Distributor", "D"],
      ["Aqua Shop / Retailer", "R"],
      ["Aquaculture Technical Service", "SP"],
      ["Aqua Brand", "B"],
    ],
  },
  // Infrastructure & equipment
  {
    group: "Infrastructure & equipment",
    entity: "GH/CEA consortium",
    roles: [
      ["Turnkey CEA Project Consortium", "SP"],
      ["CEA Export Alliance", "EI"],
    ],
  },
  {
    group: "Infrastructure & equipment",
    entity: "GH sustainability consulting",
    roles: [
      ["Greenhouse Design & Engineering Consultant", "SP"],
      ["Greenhouse Energy & Sustainability Consultant", "SP"],
    ],
  },
  {
    group: "Infrastructure & equipment",
    entity: "GH construction & hydroponics",
    roles: [
      ["Greenhouse / Polyhouse Manufacturer", "M"],
      ["Hydroponic System Manufacturer", "M"],
      ["Greenhouse Component Fabricator", "3PM"],
      ["Greenhouse Importer / Exporter", "EI"],
      ["Hydroponics Distributor", "D"],
      ["Hydroponics / Grow Shop", "R"],
      ["Greenhouse Turnkey Contractor", "SP"],
      ["Greenhouse Brand", "B"],
    ],
  },
  {
    group: "Infrastructure & equipment",
    entity: "Vertical racking",
    roles: [
      ["Vertical Farm Rack Manufacturer", "M"],
      ["Racking Contract Fabricator", "3PM"],
      ["Racking Importer / Exporter", "EI"],
      ["Racking Distributor", "D"],
      ["Vertical Farm Installer", "SP"],
      ["Racking Brand", "B"],
    ],
  },
  {
    group: "Infrastructure & equipment",
    entity: "Liquid storage",
    roles: [
      ["Agri Storage Tank Manufacturer", "M"],
      ["Tank Contract Fabricator", "3PM"],
      ["Tank Importer / Exporter", "EI"],
      ["Tank Distributor", "D"],
      ["Tank Retailer", "R"],
      ["Storage Installation Service", "SP"],
      ["Tank Brand", "B"],
    ],
  },
  {
    group: "Infrastructure & equipment",
    entity: "Plastics",
    roles: [
      ["Greenhouse / Mulch Film Manufacturer", "M"],
      ["Agri Pipe & Fittings Manufacturer", "M"],
      ["Agri Plastics Contract Manufacturer", "3PM"],
      ["Agri Plastics Importer / Exporter", "EI"],
      ["Agri Plastics Distributor", "D"],
      ["Agri Plastics Retailer", "R"],
      ["Agri Plastics Brand", "B"],
    ],
  },
  {
    group: "Infrastructure & equipment",
    entity: "Farm machinery",
    roles: [
      ["Tractor & Farm Machinery OEM", "M"],
      ["Farm Implement Manufacturer", "M"],
      ["Machinery Component Manufacturer", "3PM"],
      ["Machinery Importer / Exporter", "EI"],
      ["Regional Machinery Distributor", "D"],
      ["Authorised Tractor / Machinery Dealer", "R"],
      ["Custom Hiring / Machinery Rental Service", "SP"],
      ["Machinery Brand", "B"],
    ],
  },
  {
    group: "Infrastructure & equipment",
    entity: "Irrigation",
    roles: [
      ["Micro-irrigation (Drip/Sprinkler) Manufacturer", "M"],
      ["Irrigation Component Contract Manufacturer", "3PM"],
      ["Irrigation Importer / Exporter", "EI"],
      ["Irrigation Distributor", "D"],
      ["Irrigation Dealer", "R"],
      ["Irrigation Installer / Turnkey Contractor", "SP"],
      ["Irrigation Brand", "B"],
    ],
  },
  // Technology
  {
    group: "Technology",
    entity: "Tech / digital",
    roles: [
      ["Farm Management Software (SaaS) Provider", null],
      ["Agri Marketplace / E-commerce Platform", null],
      ["Traceability Software Provider", null],
    ],
  },
  {
    group: "Technology",
    entity: "Agri-tech, IoT, drones, robotics",
    roles: [
      ["Agri Drone Manufacturer", null],
      ["Drone Spraying Service Provider", null],
      ["IoT Sensor / Farm Device Manufacturer", null],
      ["Agri Robotics Developer", null],
    ],
  },
  {
    group: "Technology",
    entity: "Strategy & CEA advisory",
    roles: [
      ["Agri Strategy Consultant", null],
      ["CEA Feasibility & Technical Advisor", null],
    ],
  },
  {
    group: "Technology",
    entity: "Market intelligence",
    roles: [
      ["Agri Market Research Firm", null],
      ["Commodity Price & Data Provider", null],
    ],
  },
  {
    group: "Technology",
    entity: "Sustainability platform",
    roles: [
      ["Agri Carbon Credit Program Developer", null],
      ["ESG / Impact Program Operator", null],
    ],
  },
  {
    group: "Technology",
    entity: "Sustainable & regenerative",
    roles: [
      ["Regenerative / Organic Input Manufacturer", "M"],
      ["Organic Input Importer / Exporter", "EI"],
      ["Organic Input Distributor", "D"],
      ["Organic Input Retailer", "R"],
      ["Regenerative Farming Advisory", "SP"],
      ["Organic Input Brand", "B"],
    ],
  },
  // Channels & trade
  {
    group: "Channels & trade",
    entity: "Agri input / equipment manufacturer",
    roles: [
      ["Agri-input Manufacturer", "M"],
      ["Agri Equipment Manufacturer", "M"],
      ["Agri Contract Manufacturer", "3PM"],
      ["Manufacturer-Exporter", "EI"],
      ["Agri Brand", "B"],
    ],
  },
  {
    group: "Channels & trade",
    entity: "Agri input / equipment distributor",
    roles: [
      ["Agri-input Distributor / Wholesaler", "D"],
      ["Agri Equipment Distributor", "D"],
      ["Agri-input Importer", "EI"],
      ["Own-label Distributor", "B"],
    ],
  },
  {
    group: "Channels & trade",
    entity: "Regional trading",
    roles: [
      ["Regional Agri-input Trader", "D"],
      ["Mandi Commission Agent / Commodity Trader", "D"],
      ["Rural Agri Retail Outlet", "R"],
    ],
  },
  {
    group: "Channels & trade",
    entity: "Dealers, distributors & importers",
    roles: [
      ["Authorised Dealer", "R"],
      ["Stockist / Wholesaler", "D"],
      ["Agri Importer", "EI"],
    ],
  },
  {
    group: "Channels & trade",
    entity: "Exporters & trading",
    roles: [
      ["Merchant Exporter", "EI"],
      ["Manufacturer-Exporter", "M"],
      ["Agri Commodity Importer", "EI"],
      ["Trading House", "D"],
      ["Own-label Export Brand", "B"],
    ],
  },
  {
    group: "Channels & trade",
    entity: "Supply chain & logistics",
    roles: [
      ["Cold Storage Operator", "SP"],
      ["Agri Warehousing Provider", "SP"],
      ["Agri Transport & Cold-chain Logistics", "SP"],
      ["Agri Freight Forwarder / Customs Broker", "EI"],
      ["Produce Aggregator / Procurement Agent", "D"],
    ],
  },
  // Production
  {
    group: "Production",
    entity: "Large-scale farm / agribusiness",
    roles: [
      ["Large Commercial Farm", "G"],
      ["Integrated Agribusiness, farm + processing", "M"],
      ["Farm Produce Exporter", "EI"],
      ["Produce Aggregator / Wholesaler", "D"],
      ["Farm-to-consumer Retail", "R"],
      ["Farm Produce Brand", "B"],
    ],
  },
  {
    group: "Production",
    entity: "GH/CEA operators",
    roles: [
      ["Greenhouse Produce Grower", "G"],
      ["Greenhouse Produce Exporter", "EI"],
      ["Wholesale Supplier to Retail Chains", "D"],
      ["Farm-direct / D2C Seller", "R"],
      ["Branded Greenhouse Produce", "B"],
    ],
  },
  {
    group: "Production",
    entity: "Urban / vertical",
    roles: [
      ["Vertical Farm Operator", "G"],
      ["Microgreens / D2C Seller", "R"],
      ["HoReCa Supplier", "D"],
      ["Branded Urban Produce", "B"],
    ],
  },
  {
    group: "Production",
    entity: "Nurseries & landscaping",
    roles: [
      ["Nursery / Plant Propagator", "G"],
      ["Tissue Culture Lab", "G"],
      ["Plant & Sapling Exporter", "EI"],
      ["Wholesale Nursery", "D"],
      ["Retail Nursery / Garden Centre", "R"],
      ["Landscaping Contractor", "SP"],
    ],
  },
  {
    group: "Production",
    entity: "Organic / regenerative",
    roles: [
      ["Certified Organic Grower", "G"],
      ["Organic Produce Exporter", "EI"],
      ["Organic Produce Aggregator", "D"],
      ["Organic Store / D2C", "R"],
      ["Organic Food Brand", "B"],
    ],
  },
  {
    group: "Production",
    entity: "Renewable energy adopters",
    roles: [
      ["Agrivoltaic (Solar) Farm", "G"],
      ["Biogas / Bio-CNG Plant Operator", "G"],
    ],
  },
  {
    group: "Production",
    entity: "Alt protein & circular",
    roles: [
      ["Plant-based Protein Manufacturer", "M"],
      ["Insect Protein Producer", "M"],
      ["Agri-waste-to-value Processor", "M"],
      ["Food Co-packer", "3PM"],
      ["Alt-protein Importer / Exporter", "EI"],
      ["Alt-protein Distributor", "D"],
      ["Alt-protein Brand", "B"],
      ["Food-tech R&D / Formulator", "F"],
    ],
  },
  {
    group: "Production",
    entity: "Crop farming",
    roles: [
      ["Crop Farmer / Grower", "G"],
      ["Farmer Producer Organisation, FPO", "G"],
      ["Produce Exporter", "EI"],
      ["Produce Aggregator / Trader", "D"],
    ],
  },
  // Livestock, poultry & aqua
  {
    group: "Livestock, poultry & aqua",
    entity: "Livestock farms",
    roles: [
      ["Dairy Farm", "G"],
      ["Cattle / Sheep Farm", "G"],
      ["Dairy Processor", "M"],
      ["Livestock / Meat Exporter", "EI"],
      ["Milk Collection & Distribution", "D"],
      ["Farm-fresh Milk D2C", "R"],
      ["Dairy Brand", "B"],
    ],
  },
  {
    group: "Livestock, poultry & aqua",
    entity: "Poultry",
    roles: [
      ["Broiler Farm", "G"],
      ["Layer / Egg Farm", "G"],
      ["Hatchery", "G"],
      ["Poultry Integrator / Processor", "M"],
      ["Egg & Poultry Exporter", "EI"],
      ["Egg & Chicken Distributor", "D"],
      ["Chicken Retail Outlet", "R"],
      ["Poultry Brand", "B"],
    ],
  },
  {
    group: "Livestock, poultry & aqua",
    entity: "Vet hospitals",
    roles: [
      ["Veterinary Hospital / Clinic", "SP"],
      ["Mobile Veterinary Service", "SP"],
    ],
  },
  {
    group: "Livestock, poultry & aqua",
    entity: "Feed mill",
    roles: [
      ["Compound Feed Manufacturer", "M"],
      ["Toll Feed Miller", "3PM"],
      ["Feed Importer / Exporter", "EI"],
      ["Feed Distributor", "D"],
      ["Feed Dealer / Retailer", "R"],
      ["Feed Brand", "B"],
      ["Feed Formulation Nutritionist", "F"],
    ],
  },
  {
    group: "Livestock, poultry & aqua",
    entity: "Fish & shrimp farms",
    roles: [
      ["Fish / Shrimp Farm", "G"],
      ["Shrimp / Fish Hatchery", "G"],
      ["Seafood Processor", "M"],
      ["Seafood Exporter", "EI"],
      ["Fish Wholesaler", "D"],
      ["Fish Retail Outlet", "R"],
      ["Seafood Brand", "B"],
    ],
  },
  {
    group: "Livestock, poultry & aqua",
    entity: "Aquaponics & RAS",
    roles: [
      ["RAS Fish Farm", "G"],
      ["Aquaponics Farm", "G"],
      ["Farm-direct Seller", "R"],
      ["RAS Produce Brand", "B"],
    ],
  },
  {
    group: "Livestock, poultry & aqua",
    entity: "Aqua products & services",
    roles: [
      ["Aqua Product Manufacturer", "M"],
      ["Aqua Importer / Exporter", "EI"],
      ["Aqua Distributor", "D"],
      ["Aqua Shop", "R"],
      ["Aqua Lab & Technical Service", "SP"],
      ["Aqua Brand", "B"],
    ],
  },
  // Institutions
  {
    group: "Institutions",
    entity: "Agri & food security authorities",
    roles: [
      ["National Agriculture Ministry / Agency", null],
    ],
  },
  {
    group: "Institutions",
    entity: "Regional development authorities",
    roles: [
      ["State / District Agriculture Department", null],
    ],
  },
  {
    group: "Institutions",
    entity: "Water & irrigation authorities",
    roles: [
      ["Irrigation Department / Water Board", null],
    ],
  },
  {
    group: "Institutions",
    entity: "Investors & VCs",
    roles: [
      ["Agri Venture Capital", null],
      ["Agri Private Equity", null],
      ["Agri Incubator / Angel Network", null],
    ],
  },
  {
    group: "Institutions",
    entity: "Banks & DFIs",
    roles: [
      ["Agri Lending Bank", null],
      ["Development Finance Institution", null],
      ["Agri NBFC / Microfinance", null],
    ],
  },
  {
    group: "Institutions",
    entity: "Certification & labs",
    roles: [
      ["Organic / Quality Certification Body", "SP"],
      ["Soil, Seed & Residue Testing Lab", "SP"],
      ["Standards Organisation", "SP"],
      ["Field Trial CRO", "F"],
    ],
  },
];

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// Reduces a name to bare lowercase words so trivial differences in how the AI
// wrote it don't decide whether it is "on the list": case, "&" vs "and",
// slashes/hyphens/commas, markdown asterisks, and a trailing role code the AI
// may have copied, e.g. "Seed Distributor (D)".
function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\*/g, "")
    .replace(/\s*\((?:3pm|ei\+d|ei|sp|m|d|r|b|f|g)\)\s*$/, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// The full name plus the shorter forms the AI tends to use for the longer
// ones: "Biologicals Manufacturer, i.e. biofertilizer/biopesticide" is often
// answered as just "Biologicals Manufacturer", and "Micro-irrigation
// (Drip/Sprinkler) Manufacturer" as "Micro-irrigation Manufacturer".
function nameVariants(name) {
  const forms = [name, name.replace(/\s*\([^)]*\)/g, ""), name.split(",")[0]];
  return [...new Set(forms.map(normalizeName).filter(Boolean))];
}

// Full names are indexed before any short form, and a short form never
// overwrites an existing key, so a shortened name can only ever stand in for
// its own full name - never shadow a different entry's.
function buildIndex(entries, nameOf) {
  const index = new Map();
  for (const entry of entries) {
    const key = normalizeName(nameOf(entry));
    if (key && !index.has(key)) index.set(key, entry);
  }
  for (const entry of entries) {
    for (const key of nameVariants(nameOf(entry))) {
      if (!index.has(key)) index.set(key, entry);
    }
  }
  return index;
}

const ENTITY_INDEX = buildIndex(TAXONOMY, (e) => e.entity);
const ROLE_INDEX = new Map(TAXONOMY.map((e) => [e, buildIndex(e.roles, (r) => r[0])]));

function findEntity(rawName) {
  return ENTITY_INDEX.get(normalizeName(rawName)) || null;
}

// Roles are only ever looked up inside their own entity. The same role name
// can carry a different code in two entities ("Manufacturer-Exporter" is EI
// under one and M under another), so a global lookup would be wrong.
function findRole(entity, rawName) {
  return (entity && ROLE_INDEX.get(entity).get(normalizeName(rawName))) || null;
}

function businessTypesFor(codes) {
  const out = [];
  for (const code of codes) {
    for (const type of BUSINESS_TYPE_BY_CODE[code] || []) {
      if (!out.includes(type)) out.push(type);
    }
  }
  return out;
}

// raw: [{ entity: "<AI's text>", roles: ["<AI's text>", ...] }, ...]
// Returns one entry per distinct entity, each role marked inList or not:
//   [{ entity, entityInList, roles: [{ name, code, inList }] }]
// A role is only "on the list" if it is on THIS entity's list. Under a new
// entity, every role is new by definition - there is no list to check it
// against.
function classify(raw) {
  const byKey = new Map();
  for (const r of raw || []) {
    const listed = findEntity(r.entity);
    const entityName = listed ? listed.entity : String(r.entity || "").trim();
    if (!entityName) continue;
    const key = listed ? `list:${listed.entity}` : `new:${normalizeName(entityName)}`;
    if (!byKey.has(key)) byKey.set(key, { entity: entityName, entityInList: !!listed, roles: [], _seen: new Set() });
    const out = byKey.get(key);
    for (const rawRole of r.roles || []) {
      const role = findRole(listed, rawRole);
      const name = role ? role[0] : String(rawRole || "").trim();
      if (!name) continue;
      const seenKey = role ? `list:${role[0]}` : `new:${normalizeName(name)}`;
      if (out._seen.has(seenKey)) continue;
      out._seen.add(seenKey);
      out.roles.push({ name, code: role ? role[1] : null, inList: !!role });
    }
  }
  return [...byKey.values()].map(({ _seen, ...rest }) => rest);
}

// The list exactly as it is shown to the AI in the prompt: one line per
// entity. Codes are deliberately left out - the AI only has to pick names,
// and the code is attached afterwards from this file, so it can never be
// mis-copied. That also keeps the (already very long) query shorter.
function promptList() {
  return TAXONOMY.map((e) => `${e.entity}: ${e.roles.map((r) => r[0]).join("; ")}`).join("\n");
}

const ARF_TAXONOMY = {
  TAXONOMY, BUSINESS_TYPE_BY_CODE, normalizeName, findEntity, findRole, businessTypesFor, classify, promptList,
};
globalThis.ARF_TAXONOMY = ARF_TAXONOMY;
if (typeof module !== "undefined") module.exports = ARF_TAXONOMY;
