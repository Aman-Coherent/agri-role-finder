# Agri Role Finder (Chrome extension)

Takes a CSV of agriculture companies and, for each one, finds:

- **description**: 2-3 sentences on what the company does
- **entity**: which sector(s) it belongs to, e.g. *Seeds & biologicals*
- **roles**: what it does in that sector, e.g. *Seed Distributor (D)*
- **business_type**: the exact type for each role, e.g. *Distributor* or *Exporter* (never a group like *Exporter/Importer*)

Entities and roles are picked from a fixed list (49 entities, 240 roles) kept
in [taxonomy.js](taxonomy.js). If a company does something the list doesn't
cover, the AI may name a new entity or role, and those go to a separate file.

It runs on the same engine as the sibling `ai-mode-scraper/` extension
(projects, batches, delays, several tabs, CAPTCHA pause). Only the question
asked and the results differ.

## Setup

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this `agri-role-finder` folder.
4. Pin the extension icon.

## Input CSV

Columns are detected by meaning, not exact spelling. The popup shows which
column it used for each field ("Columns used: ..."), so check that before a
long run.

| Field | Recognised headers (any case, spaces/underscores ignored) |
|---|---|
| native id | native id, id, record id, lead id, company id ... |
| company name (**required**) | company name, company, business name, organisation, firm, name ... |
| website | website, company website, url, domain, homepage ... |
| city / state / country | city, town / state, province, region / country, nation |
| location | location, address (used only if there's no city/state/country) |

- **If a row has a website**, the AI is told to use it as the main source.
- **If not**, it identifies the company by name and location.
- Values like `N/A`, `-` or `none` count as empty.
- **Every column of your file is kept** and copied into every export.

## How it works, step by step

1. **+ New**: name the project and choose the CSV.
2. **Start**: it takes 3 companies at a time ("Companies per search") and
   asks Google one question about all 3. The question includes the whole
   entity/role list and a strict answer format:
   ```
   COMPANY 1
   DESCRIPTION: ...
   ENTITY: Seeds & biologicals | ROLES: Seed Distributor [Distributor]; Seed Importer / Exporter [Exporter]
   END OF ANSWERS
   ```
3. It reads the answer. Each `COMPANY <number>` block is matched to its
   company by number, so if the AI skips one company, the others still go to
   the right rows.
4. **The extension itself checks each entity and role against the list.** It
   ignores small differences like capitals, "&" vs "and", or a code the AI
   copied, and always writes the list's own spelling. The code comes from
   the list, never from the AI, and the AI's business type is only kept if
   that code allows it (see **business_type** below).
5. It waits a random 8-15 seconds, then does the next 3.
6. **CAPTCHA**: the run pauses and brings that tab to the front. You solve
   it, and the run continues by itself. It never solves one for you. If
   nobody solves it in 10 minutes, those companies go to `needs_review.csv`
   and you click **Resume**.

## Downloads

One row per **company + entity**. Roles inside a cell are separated by `;`.

| File | What's in it |
|---|---|
| `on_list_results.csv` | Entities, and roles, that are **on the list** |
| `new_results.csv` | Entities or roles **not on the list** |
| `not_found.csv` | No usable answer. A description may still be there if the AI described the company but gave no entity |
| `needs_review.csv` | Blocked by a CAPTCHA nobody solved |

The split happens **role by role**. If a company is in *Fertilizers* with one
list role and one new role, the list role goes to `on_list_results.csv` and
the new role to `new_results.csv`, both under *Fertilizers*. So one company
can appear in both files.

### business_type

Always **individual** types, never a group label like "Exporter/Importer".
Only these 13 can appear:

> Manufacturer, Third Party Manufacturer, Exporter, Importer, Distributor,
> Wholesaler, Trader, Supplier, Retailer, Service Provider, Brand,
> Formulator, CRO

The AI writes a type after each role, e.g. `Seed Importer / Exporter [Exporter]`,
and the extension checks it against **that role's code**:

| Role's code | Allowed types | If the AI gave no valid type |
|---|---|---|
| M / 3PM / R / SP / B | just that one (Manufacturer, Third Party Manufacturer, Retailer, Service Provider, Brand) | the code decides; the AI isn't needed |
| EI | Exporter, Importer | the role's name decides if it names one ("Merchant Exporter" → Exporter), otherwise **Exporter** |
| D | Distributor, Wholesaler, Trader, Supplier | same, otherwise **Distributor** |
| F | Formulator, CRO | same, otherwise **Formulator** |
| EI+D | one from each of the EI and D groups | same, for each group |
| G, or no code | *(blank)* | *(blank)* |
| new role (not on the list) | any of the 13 | *(blank)* |

A type the code doesn't allow is dropped. An EI role can only ever be
Exporter or Importer, even if the AI wrote "Trader". Each row shows the
types of the roles in that row, separated by `;`.

**Retry not-found rows** re-queues every not-found company for another try
(stop the project first).

## Settings

- **Companies per search** (default 3, max 10): more is faster but the
  answer gets longer, so the AI is more likely to skip a company.
- **Concurrent tabs** (default 1): more is faster but sends more traffic
  from your IP to Google, so there's a higher risk of a CAPTCHA. 2-4 is a
  sensible maximum.
- **Delay min/max**: the wait between searches. Shorter is faster but
  riskier.

## Things to know

- **The AI can be wrong.** Treat results as a strong first pass, not
  checked facts, and `new_results.csv` most of all.
- **The question is long** (~9,000 characters, because it carries the whole
  list). Google accepts it, but how well the AI follows such a long list can
  only be judged on real runs. Start with a small test.
- **Google changes its AI answers without notice.** If results suddenly drop
  off, the answer format probably changed. The places to adjust are
  `parseAnswer` in [content.js](content.js) and `buildPrompt` in
  [background.js](background.js).
- Everything stays in your browser. The only site it talks to is google.com.

## Changing the list

Edit [taxonomy.js](taxonomy.js) only. Each role is `["Role name", "CODE"]`,
or `["Role name", null]` for no code. Then click the reload icon on the
extension in `chrome://extensions`.

## Tests

Offline checks of the list matching, the answer parsing, CSV reading and the
export split (they don't contact Google):

```
node --test tests/*.test.js
```
