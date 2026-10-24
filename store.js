/**
 * store.js - how a project is laid out in chrome.storage.local.
 *
 * A project is stored in PIECES of CHUNK_SIZE companies, not as one record.
 * Real input files run to 50,000+ companies, and a single record that size
 * breaks twice over:
 *   - creating the project: Chrome refuses any extension message over 64 MB,
 *     so handing the whole list from the popup to background.js failed
 *     (silently) before a single company was searched;
 *   - running it: every batch result rewrote the entire record, and the popup
 *     re-read all of it every 3 seconds.
 * In pieces, the popup writes the list straight into storage itself, the
 * engine only ever reads and rewrites the one piece a batch's companies live
 * in, and the popup polls a small summary.
 *
 * Only the columns the extension uses are kept from the input file (native
 * id, company name, website, city, state, country, plus a combined address
 * when there is no city/state/country) - the rest of a wide CSV is dropped
 * at import. Results are joined back to the original file on native_id.
 *
 *   arfProject_<pid>     -> meta: name, settings, detected columns, counts, and
 *                           per-piece counts (chunkCounts) so the engine can
 *                           find pending companies without reading every piece
 *   arfChunk_<pid>_<n>   -> the companies of piece n (id, name, website,
 *                           location, status, results)
 *
 * Company ids are "r<position>", so the piece a company lives in is simply
 * its position / CHUNK_SIZE - no lookup table needed.
 *
 * Loaded by background.js (importScripts), popup.html (<script>) and the
 * tests (require), hence the globalThis / module.exports pair at the bottom.
 */

const ARF_STORE = (() => {
  const CHUNK_SIZE = 500;
  const STATUSES = ["pending", "found", "blocked", "not_found"];

  const metaKey = (pid) => `arfProject_${pid}`;
  const chunkKey = (pid, n) => `arfChunk_${pid}_${n}`;
  const PROJECT_ID_RE = /^proj_[a-z0-9_]+$/;

  function newProjectId() {
    return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function chunkOfId(id) {
    const position = Number(String(id).slice(1));
    return Number.isInteger(position) && position >= 0 ? Math.floor(position / CHUNK_SIZE) : -1;
  }

  function emptyCounts() {
    return { pending: 0, found: 0, blocked: 0, not_found: 0 };
  }

  function countsOfItems(items) {
    const counts = emptyCounts();
    for (const it of items) counts[it.status] = (counts[it.status] || 0) + 1;
    return counts;
  }

  function sumCounts(list) {
    const total = emptyCounts();
    for (const c of list) for (const s of STATUSES) total[s] += (c && c[s]) || 0;
    return total;
  }

  // Everything kept per company.
  function leanItem(c, position) {
    return {
      id: `r${position}`,
      native_id: c.native_id || "",
      company_name: c.company_name,
      website: c.website || "",
      city: c.city || "",
      state: c.state || "",
      country: c.country || "",
      location: c.location || "",
      status: "pending",
      attempts: 0,
      description: null,
      // [{ entity, entityInList, roles: [{ name, code, inList, types }] }] -
      // see classify in taxonomy.js.
      classifications: [],
    };
  }

  // Splits the parsed companies into storage pieces: [{ n, items }].
  function buildChunks(companies) {
    const chunks = [];
    for (let start = 0, n = 0; start < companies.length; start += CHUNK_SIZE, n++) {
      const slice = companies.slice(start, start + CHUNK_SIZE);
      chunks.push({ n, items: slice.map((c, i) => leanItem(c, start + i)) });
    }
    return chunks;
  }

  // What a project can ask for, chosen when it is created (see buildPrompt in
  // background.js). Entities, roles and business types are always worked out
  // together - a role belongs to an entity, a business type to a role - so any
  // of them needs the full question; Description alone needs a shorter one.
  const ALL_FIELDS = ["description", "entities", "roles", "businessType"];
  const FIELD_LABELS = { description: "Description", entities: "Entities", roles: "Roles", businessType: "Business type" };

  // Known fields only, in a fixed order; nothing (or nothing valid) means
  // everything - which is also what projects made before this choice existed
  // were asked.
  function normalizeFields(fields) {
    const picked = Array.isArray(fields) ? ALL_FIELDS.filter((f) => fields.includes(f)) : [];
    return picked.length ? picked : ALL_FIELDS.slice();
  }

  function needsClassification(fields) {
    return normalizeFields(fields).some((f) => f !== "description");
  }

  return {
    CHUNK_SIZE, STATUSES, PROJECT_ID_RE, ALL_FIELDS, FIELD_LABELS, normalizeFields, needsClassification,
    metaKey, chunkKey, newProjectId, chunkOfId,
    emptyCounts, countsOfItems, sumCounts, leanItem, buildChunks,
  };
})();

globalThis.ARF_STORE = ARF_STORE;
if (typeof module !== "undefined") module.exports = ARF_STORE;
