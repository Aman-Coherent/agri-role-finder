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
- **Only these columns are kept.** Any other columns in your file are
  ignored. To see them next to the results, join the results back to your
  file on `native_id`.
- **Big files are fine.** A 50,000-company file is saved in pieces of 500,
  with an "Importing ... of ..." counter. **Keep the popup open until it
  finishes.** If it gets closed half-way, nothing half-imported is left
  behind: just create the project again.

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
3. **If the normal page shows no AI Overview, it clicks the AI Mode tab** and
   asks there instead (see **When things go wrong**).
4. It reads the answer. Each `COMPANY <number>` block is matched to its
   company by number, so if the AI skips one company, the others still go to
   the right rows.
5. **The extension itself checks each entity and role against the list.** It
   ignores small differences like capitals, "&" vs "and", or a code the AI
   copied, and always writes the list's own spelling. The code comes from
   the list, never from the AI, and the AI's business type is only kept if
   that code allows it (see **business_type** below).
6. It waits a random 8-15 seconds, then does the next 3.
7. **CAPTCHA**: the run pauses and brings that tab to the front. You solve
   it, and the run continues by itself. It never solves one for you. See
   **When things go wrong** below for the details.

## When things go wrong

| Situation | What the extension does |
|---|---|
| **Google shows its CAPTCHA page** ("unusual traffic") | Pauses the whole run, brings that tab to the front, and waits. Once you solve it, Google sends the tab back to the search, the search runs, and the whole run resumes by itself. If Google lands the tab somewhere else (e.g. its home page), the extension re-opens the search itself. |
| **CAPTCHA page shows "400. That's an error"** instead of a CAPTCHA | This happens because the question is so long: Google's CAPTCHA page carries the whole search in its own address, and ours is too long for it. The extension sends the tab to a short search (`agriculture companies`), where Google shows a normal CAPTCHA. After you solve it, the tab goes on to the real search by itself. The short search is never read as an answer. |
| **CAPTCHA right on the results page** | Same: pauses, waits for you, resumes. |
| **Google's cookie-consent page** ("Before you continue") | Same as a CAPTCHA: answer it once in that tab and the run continues. |
| **CAPTCHA not solved within 10 minutes** | Those companies are marked blocked and the run stays paused. **Resume** searches them again. |
| **Google's AI limit**: "You've reached the request limit for AI responses at the moment" | Google caps how many AI answers one account gets in a while; heavy use (many tabs) reaches it. The run **pauses**, and the batch goes back in the queue with **no try counted**. It **resumes by itself** after a cool-down: 5 min, or 10, 20, 40, then 60 if the limit is hit again straight away, going back to 5 once answers come through. The popup shows when it will resume. Click **Resume** to try sooner. Fewer tabs (1–2) makes this much less likely. |
| **No AI Overview at all**, just normal search results (or "No results found") | After **15 seconds** with no AI Overview, it **clicks the page's "AI Mode" tab**, the same as you would by hand, and reads the answer there. It's the same question and the same checks; AI Mode is built for long questions and usually answers. If AI Mode gives nothing either, it reloads once, then moves on. Those companies get one more try later, in a different batch. These pages never pause the run. |
| **Empty answer, or Google says "Something went wrong"** | Reloads that search once. |
| **The AI skips a company** in its answer | The company goes back in the queue once and is asked again in a later batch, alongside different companies. Only after a second miss is it recorded not found. |
| **The AI says NONE** (it has no information) | Recorded not found straight away. The AI looked and didn't know, so asking again rarely helps. |
| **A tab gets stuck** (page didn't load, internet blip) | After a few minutes it's given up on. Its companies count one missed try (as above) and the run moves on. |
| **Several searches in a row fail completely** (4): the page never loads, or Google's AI answer can't be read | The run **pauses** instead of marking the whole list not found, so you can check what's wrong (internet down, Google changed its page). Click Resume once it's fixed. |
| **Google folds the answer behind "Show more"** | Clicks it (only buttons, never links), and also reads the hidden text. |
| **You close a worker tab** mid-search | Nothing is lost: its companies stay queued and get a new tab. If it was the CAPTCHA tab, the run stays paused until Resume. |
| **Chrome restarts, or the extension is reloaded,** mid-run | The run is paused with a message. **Resume** continues exactly where it stopped. |
| **Stop** mid-search | The tabs close. Companies that were being searched stay queued for the next Start. |

## Downloads

One row per **company + entity**. Roles inside a cell are separated by `;`.

Every file has the same columns, whatever your input file called them:

`native_id, company_name, country, state, city, website`, then
`description, entity, roles, business_type` (not_found.csv has
`description`; needs_review.csv has just the first six).

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

- **Companies per search** (default 3, no maximum): more means fewer
  searches, so it's faster and uses fewer of Google's AI answers. But the
  answer gets longer, so the AI is more likely to cut it short or skip a
  company; skipped companies get their second try in a later batch. Very
  large numbers are fitted automatically to what one Google search link can
  carry (about 85 companies).
- **Concurrent tabs** (default 1): more is faster but sends more traffic
  to Google, so there's a higher risk of a CAPTCHA and of reaching Google's
  limit for AI answers. **1–2 is recommended**, since AI Mode answers count
  towards that limit.
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

Offline checks of the list matching, the answer parsing, CSV reading, the
export split, and the run engine in every situation in **When things go
wrong** above (a fake Chrome stands in for the browser; nothing contacts
Google):

```
node --test tests/*.test.js
```
