/**
 * content.js - runs on https://www.google.com/search* pages.
 *
 * GET_CURRENT hands this script the batch of companies its tab was claimed
 * for, and background.js's buildPrompt turned all of them into ONE Google
 * query demanding a strict reply, one block per company:
 *
 *   COMPANY 1
 *   DESCRIPTION: <2-3 sentences>
 *   ENTITY: <entity> | ROLES: <role>; <role>
 *   ENTITY: <entity> | ROLES: <role>
 *   COMPANY 2
 *   ...
 *   END OF ANSWERS
 *
 * runBatch() reads that back. Blocks are matched to companies by the number
 * on their "COMPANY <n>" line - text the AI typed, which (unlike an HTML
 * list's auto-generated numbers) is really in the page - so one skipped
 * company doesn't shift every answer after it onto the wrong company. A
 * company with no block is never guessed at: if the whole answer came back
 * empty the search is RELOADED once, and anything still unresolved after
 * that is recorded not_found so the run moves on.
 *
 * This script only reports what the AI wrote. Whether each entity/role is on
 * the list is decided in background.js against taxonomy.js.
 *
 * Reading the page: innerText first, with deepText() as a fallback for
 * answers composed inside shadow roots - see pageText().
 *
 * NOTE ON AI MODE: this deliberately does not request &udm=50. Chrome
 * intercepts that and renders it on an internal chrome:// page that no
 * extension may read - see buildSearchUrl() in background.js.
 *
 * CAPTCHA handling: hitting one doesn't fail the batch. This script tells
 * background.js (which pauses the whole run and brings this tab to the
 * front) and then just waits - however long it takes - for a human to clear
 * it. It never tries to solve or bypass one. See waitForCaptchaSolved() and
 * background.js's CAPTCHA_WATCHDOG_MS for the give-up backstop.
 *
 * If this page load isn't part of an active automation run (e.g. you're
 * just browsing Google yourself), GET_CURRENT returns null and this script
 * does nothing.
 */

(function () {
  // background.js re-injects this file after a navigation completes (a
  // declarative content_scripts registration can miss a client-side/soft
  // navigation), so the same page can legitimately get two copies. Only the
  // first one should drive the search.
  if (window.__agriRoleFinderBooted) return;
  window.__agriRoleFinderBooted = true;

  // Set to false to silence the diagnostic logs below. They print in the
  // worker tab's OWN console (right-click that tab -> Inspect -> Console) -
  // the only practical way to see why a given batch resolved the way it
  // did: how long it waited, how many company blocks were on the page when
  // it looked, and what it reported back.
  const DEBUG = true;
  function debug(...args) {
    if (DEBUG) console.log("[AgriRoleFinder]", ...args);
  }

  // How long to let the AI's answer stream in. Deliberately generous: each
  // company's answer here is a description plus several entity lines, and
  // giving up early records not_found for companies whose answers were
  // seconds away.
  //
  // HARD CONSTRAINT: the longest wait possible here must stay comfortably
  // BELOW background.js's per-batch watchdog (computeWatchdogMs) plus page
  // load time, or the watchdog fires first and marks the whole in-flight
  // batch not_found before this script ever reports a real answer. If you
  // raise these, raise those too.
  const ANSWER_BASE_MS = 60000;
  const ANSWER_PER_ITEM_MS = 20000;
  const ANSWER_MAX_MS = 240000;
  // The wait is driven by whether the PAGE IS STILL PRODUCING OUTPUT, not by
  // elapsed time: while the text keeps changing the wait keeps going (up to
  // the cap above). How much silence counts as "finished" depends on what is
  // already on the page:
  //
  //   nothing parseable yet -> most likely this query isn't getting an AI
  //     answer at all, so give up on silence fairly quickly.
  //   a PARTIAL answer -> Google is mid-answer and does go quiet for a long
  //     time while researching the next company (measured on the sibling
  //     extension: ~28s between two lines of one answer). Accepting that
  //     pause as "finished" loses every company after it.
  //   every company answered, but no END OF ANSWERS line -> almost certainly
  //     done, the AI just didn't write the end line. A short silence is
  //     enough to be sure the last company's final ENTITY line isn't still
  //     arriving.
  const ANSWER_QUIET_MS = 12000;
  const PARTIAL_QUIET_MS = 45000;
  const COMPLETE_QUIET_MS = 8000;
  // Google's answer streaming fires mutations in bursts; re-reading the page on
  // every single one would mean hundreds of full innerText reads a second.
  // Coalesced on a timestamp rather than a timer, because a timer is the one
  // thing that gets throttled in the hidden tabs this has to work in.
  const OBSERVER_COALESCE_MS = 300;
  const POLL_MS = 250;
  // How long this script itself will keep polling a CAPTCHA page waiting
  // for a human to clear it, before giving up and reporting "blocked" on
  // its own. Deliberately much longer than background.js's own
  // CAPTCHA_WATCHDOG_MS (10 min) - that alarm-based watchdog is the real
  // backstop; this is only a last-resort safety net for the rare case that
  // alarm doesn't fire (e.g. the tab was closed and reopened by hand).
  const CAPTCHA_POLL_TIMEOUT_MS = 20 * 60 * 1000;

  // Set while a wait is in progress: calling it ends that wait immediately and
  // reports whatever is on the page. background.js triggers it with REPORT_NOW
  // when a batch nears its watchdog deadline - message delivery still works in
  // a throttled tab even when its timers have effectively stopped, so an
  // answer that did arrive can still be collected rather than written off.
  let nudgeNow = null;

  function isBlockedPage() {
    if (location.pathname.startsWith("/sorry/")) return true;
    const bodyText = pageText().toLowerCase();
    return (
      bodyText.includes("unusual traffic") ||
      bodyText.includes("detected unusual traffic") ||
      !!document.querySelector("iframe[src*='recaptcha']") ||
      !!document.querySelector("#captcha-form")
    );
  }

  // --- Reading the answer text off the page ---

  // Google renders parts of its answer inside web components, and text inside
  // a shadow root is NOT returned by document.body.innerText - so reading
  // innerText alone can come back empty while the answer is plainly visible on
  // screen. This walks the real composed tree, stepping into every open
  // shadowRoot it meets.
  //
  // Only these force a line break. Everything else (notably <a> and <span>)
  // is treated as inline and kept on the SAME line, so an "ENTITY: x | ROLES:
  // y" line whose values Google wrapped in spans or links stays one line.
  const BLOCK_TAGS = new Set([
    "address", "article", "aside", "blockquote", "br", "dd", "details", "div", "dl", "dt",
    "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
    "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table",
    "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
  ]);

  function deepText(root) {
    let out = "";
    const breakLine = () => {
      if (out && !out.endsWith("\n")) out += "\n";
    };
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const t = (node.textContent || "").replace(/\s+/g, " ");
        if (t.trim()) out += t;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      const tag = (node.tagName || "").toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") return;
      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) breakLine();
      if (node.shadowRoot) walk(node.shadowRoot);
      for (const child of node.childNodes) walk(child);
      if (isBlock) breakLine();
    };
    walk(root);
    return out
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // The primary read is innerText, NOT the tree-walker above, and that choice
  // is load-bearing: innerText is CSS-aware - it breaks lines the way the page
  // actually renders - whereas a hand-rolled walker has to guess from tag
  // names, and Google composes one rendered line out of several nested <div>s
  // styled inline. The sibling extension measured this on the real page:
  // innerText found every answer line; the walker split them apart.
  // deepText() is kept strictly as a fallback for text inside shadow roots,
  // which innerText omits - see deepenIfEmpty().
  function pageText() {
    if (!document.body) return "";
    const light = document.body.innerText || "";
    return light.trim() ? light : deepText(document.body);
  }

  // Second opinion for when the normal read produced nothing parseable.
  // `count` says how many parseable items each candidate text yields, so the
  // deeper read is only adopted if it genuinely finds more.
  function deepenIfEmpty(text, count) {
    if (count(text) > 0 || !document.body) return text;
    const deep = deepText(document.body);
    return count(deep) > count(text) ? deep : text;
  }

  // Google shows these while it is still researching/generating - they are a
  // "not finished yet" signal, never an answer.
  function isStillGenerating(text) {
    return /\b(thinking(?:\s+a\s+little\s+longer)?|searching|generating|loading)\b/i.test(text || "");
  }

  // --- Parsing the answer ---

  const INVISIBLE_CHARS_RE = new RegExp("[\\u200B\\u200C\\u200D\\uFEFF]", "g");

  // Strips what Google's rendering or the AI's habits glue onto a value:
  // invisible formatting characters, markdown emphasis, leftover bullets,
  // trailing punctuation.
  function clean(raw) {
    return String(raw || "")
      .replace(INVISIBLE_CHARS_RE, "")
      .replace(/\*/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[|:\-–•]+\s*/, "")
      .replace(/[\s|,;]+$/, "");
  }

  // Every value in the prompt's reply template is written in <angle
  // brackets> ("<entity name>", "<role>"), and a real answer never contains
  // them. If Google echoes the query on the page, its template lines are
  // recognised and skipped by this alone.
  function isTemplateValue(raw) {
    return /[<>]/.test(raw || "");
  }

  // The prompt asks for NONE, and mostly gets it, but a generative answer
  // phrases "I don't know" a dozen ways.
  const NO_VALUE_RE =
    /^(none|n\/?a|null|unknown|not\s+(found|known|available|listed|specified|applicable|public|publicly\s+(available|listed|known))|no\s+(information|data|reliable\s+information)(\s+\w+)*)$/i;

  function isNoneValue(raw) {
    const cleaned = clean(raw).replace(/[.!]+$/, "");
    return !cleaned || NO_VALUE_RE.test(cleaned);
  }

  // A line that opens with a label, tolerating whatever Google or the AI puts
  // in front of it: a bullet, a dash, markdown asterisks, a heading "#".
  const LABEL_PREFIX = "^[\\s>#*\\-–•]*";
  const MARKER_RE = new RegExp(`${LABEL_PREFIX}COMPANY\\s*(?:#|no\\.?|number)?\\s*(\\d{1,2})\\b[^\\n]*`, "gim");
  const END_RE = new RegExp(`${LABEL_PREFIX}END\\s+OF\\s+ANSWERS\\b`, "gim");
  const DESCRIPTION_RE = new RegExp(`${LABEL_PREFIX}DESCRIPTION\\s*\\**\\s*:\\s*(.*)$`, "i");
  const ENTITY_RE = new RegExp(`${LABEL_PREFIX}ENTITY\\s*\\**\\s*:\\s*(.*)$`, "i");
  const ROLES_ONLY_RE = new RegExp(`${LABEL_PREFIX}ROLES?\\s*\\**\\s*:\\s*(.*)$`, "i");
  const ROLES_SPLIT_RE = /\|?\s*\**\s*\bROLES?\s*\**\s*:/i;
  const ANY_LABEL_RE = new RegExp(`${LABEL_PREFIX}(COMPANY\\s*#?\\s*\\d|DESCRIPTION\\s*\\**\\s*:|ENTITY\\s*\\**\\s*:|ROLES?\\s*\\**\\s*:|END\\s+OF\\s+ANSWERS)`, "i");

  // Roles are separated by ";", but only OUTSIDE square brackets: each role
  // carries its business type(s) as "Seed Distributor [Distributor]", and an
  // AI that separates several types with ";" instead of "," must not have
  // its role cut in half. The "[...]" itself is kept and passed on as-is -
  // taxonomy.js reads it (splitRoleText).
  function splitRoles(raw) {
    if (!raw || isTemplateValue(raw)) return [];
    const parts = [];
    let depth = 0;
    let current = "";
    for (const ch of raw) {
      if (ch === "[") depth++;
      else if (ch === "]") depth = Math.max(0, depth - 1);
      if (ch === ";" && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    parts.push(current);
    return parts.map(clean).filter((r) => r && !isNoneValue(r) && !isTemplateValue(r));
  }

  // Reads one company's block (the text between its COMPANY line and the
  // next). `answered` means the AI wrote at least one real DESCRIPTION or
  // ENTITY line for it, even if that line said NONE - an explicit "I don't
  // know" is a finished answer, not a missing one.
  function parseBlock(body) {
    const lines = body.split(/\n/);
    const block = { description: null, entities: [], answered: false };
    let descriptionOpen = false;
    let lastEntity = null;
    for (const line of lines) {
      const desc = line.match(DESCRIPTION_RE);
      if (desc) {
        if (isTemplateValue(desc[1])) continue;
        block.answered = true;
        lastEntity = null;
        if (!block.description && !isNoneValue(desc[1])) {
          block.description = clean(desc[1]);
          descriptionOpen = true;
        }
        continue;
      }
      const ent = line.match(ENTITY_RE);
      if (ent) {
        descriptionOpen = false;
        if (isTemplateValue(ent[1])) continue;
        block.answered = true;
        const [entityPart, rolesPart] = ent[1].split(ROLES_SPLIT_RE);
        const entity = clean(entityPart);
        if (!entity || isNoneValue(entity)) {
          lastEntity = null;
          continue;
        }
        lastEntity = { entity, roles: splitRoles(rolesPart) };
        block.entities.push(lastEntity);
        continue;
      }
      const rolesOnly = line.match(ROLES_ONLY_RE);
      if (rolesOnly) {
        // "ROLES:" rendered onto its own line under the ENTITY it belongs to.
        descriptionOpen = false;
        if (lastEntity && !lastEntity.roles.length) lastEntity.roles = splitRoles(rolesOnly[1]);
        continue;
      }
      // A description the AI broke over several lines: keep the following
      // plain lines, but only up to the first ENTITY line (see the check in
      // parseAnswer) - anything later in a block is page furniture.
      if (descriptionOpen && line.trim() && !ANY_LABEL_RE.test(line)) {
        block._descriptionTail = (block._descriptionTail || "") + " " + line;
      }
    }
    // Only an entity line proves the description ended where we think it
    // did; without one, the "tail" may just be Google's footer.
    if (block._descriptionTail && block.entities.length) {
      block.description = clean(`${block.description} ${block._descriptionTail}`);
    }
    delete block._descriptionTail;
    return block;
  }

  // Parses the whole page. Returns { blocks: Map<number, block>, ended }.
  //
  // Blocks are keyed by the number on their COMPANY line. If a number shows
  // up twice (the AI restarted, or Google rendered a draft and a final
  // answer), the first block that actually has an answer wins.
  //
  // `ended` requires END OF ANSWERS to appear AFTER the last COMPANY line, so
  // an echo of the prompt (which also contains those words, and always sits
  // above the answer) can never count as the end of the answer.
  //
  // If the AI ignored the COMPANY lines entirely, there's one narrow
  // fallback: exactly as many DESCRIPTION lines as companies are matched in
  // order. Any other count is too ambiguous to pair safely.
  function parseAnswer(text, expected) {
    const markers = [...text.matchAll(MARKER_RE)].map((m) => ({
      num: Number(m[1]),
      start: m.index,
      bodyStart: m.index + m[0].length,
    }));
    const blocks = new Map();
    let ended = false;

    if (markers.length) {
      const endMatches = [...text.matchAll(END_RE)];
      const lastStart = markers[markers.length - 1].start;
      const endAfter = endMatches.find((m) => m.index > lastStart);
      ended = !!endAfter;
      markers.forEach((m, i) => {
        const next = i + 1 < markers.length ? markers[i + 1].start : endAfter ? endAfter.index : text.length;
        const block = parseBlock(text.slice(m.bodyStart, next));
        const existing = blocks.get(m.num);
        if (!existing || (!existing.answered && block.answered)) blocks.set(m.num, block);
      });
      return { blocks, ended };
    }

    const lines = text.split(/\n/);
    const starts = [];
    lines.forEach((line, i) => {
      const d = line.match(DESCRIPTION_RE);
      if (d && !isTemplateValue(d[1])) starts.push(i);
    });
    if (starts.length === expected) {
      starts.forEach((s, i) => {
        const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
        blocks.set(i + 1, parseBlock(lines.slice(s, end).join("\n")));
      });
      ended = END_RE.test(text);
      END_RE.lastIndex = 0;
    }
    return { blocks, ended };
  }

  function answeredCount(parsed, expected) {
    let n = 0;
    for (let k = 1; k <= expected; k++) {
      const b = parsed.blocks.get(k);
      if (b && b.answered) n++;
    }
    return n;
  }

  async function waitFor(conditionFn, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = conditionFn();
      if (result) return result;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return null;
  }

  // Waits for Google to finish answering. The rule is "keep waiting while the
  // page is still producing output", NOT "wait N seconds and hope".
  //
  // Returns:
  //   "ready"   - readyFn(text) is satisfied. Returns the instant that's true,
  //               so a fast answer is never made to wait.
  //   "settled" - the page went quiet for quietMsFn(text) and isn't showing a
  //               "Searching..." indicator: as complete as it's going to get.
  //   "error"   - Google itself reported a failure.
  //   "blocked" - a CAPTCHA appeared mid-wait.
  //   "nudged"  - background.js asked for an immediate report (REPORT_NOW).
  //   "timeout" - hit the hard cap while still changing. Rare by design.
  //
  // DRIVEN BY MUTATIONOBSERVER, NOT BY A TIMER LOOP. Worker tabs run hidden,
  // and Chrome throttles timers in hidden tabs to about once a MINUTE after a
  // few minutes - but a MutationObserver still fires when the DOM changes, so
  // it is what actually notices the answer arriving. The interval below is
  // only a coarse backstop for the give-up paths, where being late costs
  // nothing.
  function waitForAnswer(readyFn, quietMsFn, maxMs) {
    return new Promise((resolve) => {
      let settled = false;
      let lastLength = -1;
      let lastChangeAt = Date.now();
      let lastCheckAt = 0;

      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearInterval(backstop);
        clearTimeout(cap);
        nudgeNow = null;
        resolve(outcome);
      };

      const check = () => {
        if (settled) return;
        if (isBlockedPage()) return finish("blocked");
        const text = pageText();
        if (/something went wrong/i.test(text)) return finish("error");
        if (readyFn(text)) return finish("ready");
        if (text.length !== lastLength) {
          lastLength = text.length;
          lastChangeAt = Date.now();
        } else if (!isStillGenerating(text)) {
          if (Date.now() - lastChangeAt >= quietMsFn(text)) return finish("settled");
        }
      };

      const observer = new MutationObserver(() => {
        const now = Date.now();
        if (now - lastCheckAt < OBSERVER_COALESCE_MS) return;
        lastCheckAt = now;
        check();
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      const backstop = setInterval(check, POLL_MS);
      const cap = setTimeout(() => finish("timeout"), maxMs);
      nudgeNow = () => finish("nudged");
      check();
    });
  }

  // Tells background.js a CAPTCHA showed up (it pauses the run and brings
  // this tab to the front for you), then just waits for it to clear.
  // Returns true once isBlockedPage() goes false, or false if
  // CAPTCHA_POLL_TIMEOUT_MS is exceeded with nobody solving it.
  //
  // This only returns at all if the CAPTCHA clears *without* the page
  // navigating away. The far more common case - Google's /sorry/ page
  // redirecting back to the results once solved - is a real navigation,
  // which tears down this script; a fresh instance then runs on the reloaded
  // page and picks the search back up (GET_CURRENT still hands it the same
  // batch). Either way the search continues normally.
  async function waitForCaptchaSolved(batchToken) {
    chrome.runtime.sendMessage({ type: "CAPTCHA_DETECTED", batchToken });
    return waitFor(() => !isBlockedPage(), CAPTCHA_POLL_TIMEOUT_MS);
  }

  // The background engine waits for exactly one RESULT message per claimed
  // batch; if this script throws before sending one, that worker would be
  // stuck until its watchdog fired. run() is the outer guard: whatever
  // runInner() does, something always gets reported back.
  async function run() {
    let current = null;
    try {
      current = await chrome.runtime.sendMessage({ type: "GET_CURRENT" });
      if (!current || !Array.isArray(current.items) || !current.items.length) return; // not part of an active run - don't touch the page
      await runInner(current);
    } catch (err) {
      console.error("Agri Role Finder: content script error, reporting not_found instead of hanging", err);
      try {
        if (current && current.batchToken && Array.isArray(current.items)) {
          chrome.runtime.sendMessage({
            type: "RESULT",
            batchToken: current.batchToken,
            results: current.items.map((it) => ({ itemId: it.itemId, status: "not_found" })),
          });
        }
      } catch {
        // Extension context itself is gone (e.g. reloaded mid-run) -
        // nothing more we can do from here.
      }
    }
  }

  // Reports every company in the batch as "blocked" - used when a CAPTCHA was
  // never cleared, so they land in needs_review.csv for a manual look instead
  // of being mislabelled not_found.
  function reportAllBlocked(items, batchToken) {
    chrome.runtime.sendMessage({
      type: "RESULT",
      batchToken,
      results: items.map((it) => ({ itemId: it.itemId, status: "blocked" })),
    });
  }

  async function runInner(current) {
    const { batchToken, items } = current;

    // Checked synchronously rather than by polling: this runs in a hidden
    // background tab whose timers Chrome throttles, so a short poll here
    // could really cost up to a minute of every search. A CAPTCHA appearing
    // later is caught by the mutation-driven check inside waitForAnswer.
    if (isBlockedPage()) {
      const solved = await waitForCaptchaSolved(batchToken);
      if (!solved) {
        reportAllBlocked(items, batchToken);
        return;
      }
    }
    await runBatch(items, batchToken);
  }

  async function runBatch(items, batchToken) {
    const n = items.length;
    const waitMs = Math.min(ANSWER_BASE_MS + ANSWER_PER_ITEM_MS * n, ANSWER_MAX_MS);
    const started = Date.now();
    const readyFn = (text) => {
      const parsed = parseAnswer(text, n);
      return parsed.ended && answeredCount(parsed, n) === n;
    };
    const quietMsFn = (text) => {
      const answered = answeredCount(parseAnswer(text, n), n);
      if (answered === n) return COMPLETE_QUIET_MS;
      return answered > 0 ? PARTIAL_QUIET_MS : ANSWER_QUIET_MS;
    };
    let outcome = await waitForAnswer(readyFn, quietMsFn, waitMs);

    // A CAPTCHA that appeared mid-wait: hand it to a human, then give the
    // answer another full wait if it clears, rather than throwing the batch
    // away over an interruption that has since been resolved.
    if (outcome === "blocked") {
      const solved = await waitForCaptchaSolved(batchToken);
      if (!solved) {
        reportAllBlocked(items, batchToken);
        return;
      }
      outcome = await waitForAnswer(readyFn, quietMsFn, waitMs);
    }

    const answerText = deepenIfEmpty(pageText(), (t) => answeredCount(parseAnswer(t, n), n));
    const parsed = parseAnswer(answerText, n);
    const answered = answeredCount(parsed, n);

    // Nothing at all came back for this search. Reload the exact same query
    // ONCE - Google frequently answers on a second attempt when the first
    // produced no answer panel. If the retry is also empty, the whole batch
    // is recorded not_found below and the run moves on.
    //
    // Only a completely empty answer triggers this. If even one company
    // parsed, that data is reported immediately instead - a reload would
    // re-ask the whole batch and could come back worse, and the engine only
    // accepts one RESULT per batch.
    if (answered === 0) {
      const retryKey = `arfBatchRetried_${batchToken}`;
      if (sessionStorage.getItem(retryKey) !== "1") {
        sessionStorage.setItem(retryKey, "1");
        debug(`runBatch: no answer at all (outcome ${outcome}) for ${n} companies - reloading this search once`);
        // Re-arm the watchdog first: a second full wait would otherwise run
        // past the deadline armed for the first one.
        chrome.runtime.sendMessage({ type: "RETRY_SEARCH", batchToken });
        location.reload();
        return; // this script instance is about to be torn down by the reload
      }
      debug(`runBatch: retry also came back empty - recording ${n} not_found and moving on`);
    }

    const results = items.map((it, idx) => {
      const block = parsed.blocks.get(idx + 1);
      if (!block || !block.answered) return { itemId: it.itemId, status: "not_found" };
      return {
        itemId: it.itemId,
        // background.js re-derives this from what survives its own checks.
        status: block.entities.length ? "found" : "not_found",
        description: block.description,
        entities: block.entities,
      };
    });

    debug("runBatch", {
      companies: n,
      outcome,
      waitedMs: Date.now() - started,
      answered,
      endLineSeen: parsed.ended,
      pageTextLength: answerText.length,
      results,
    });
    chrome.runtime.sendMessage({ type: "RESULT", batchToken, results });
  }

  // Exposed for the offline parser tests only (see tests/). In the extension
  // this script is never loaded as a module, so this branch never runs.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { parseAnswer, parseBlock, answeredCount };
    return;
  }

  // background.js sends this when a batch is nearing its watchdog deadline
  // with nothing reported yet. In a hidden/minimised tab the timers that would
  // normally end the wait may be throttled to a crawl - but message delivery
  // is not, so this is the reliable way to say "stop waiting and tell me what
  // you've got", which beats letting the watchdog write the batch off.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "REPORT_NOW") return;
    const waiting = typeof nudgeNow === "function";
    debug("REPORT_NOW received", waiting ? "- ending the wait now" : "- not currently waiting");
    if (waiting) nudgeNow();
    sendResponse({ waiting });
  });

  run();
})();
