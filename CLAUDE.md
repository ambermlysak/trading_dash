# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this is

A two-page equity research terminal — a macro landing dashboard (`dashboard.html`) and a
per-ticker deep-dive (`index.html`) — with a single Cloudflare Worker (`worker.js`)
handling all API proxying, Claude calls and KV persistence.

## Where everything is

**This file is the rules, and it is deliberately small so it loads whole.** It reached
178 KB on 2026-09-02 — past what a session loads, so every session was working from a
silently truncated copy of its own rules. **Nothing was deleted**; the narratives moved
to `docs/history.md`.

| file | holds |
|---|---|
| **`CLAUDE.md`** (every session) | **the rules, the Worker invariants, the active gotchas, the commands** |
| `ARCHITECTURE.md` | data sources, design decisions, the two pages, build position |
| `worker-internals` skill | endpoints, the **KV key + TTL table**, cron, data sources |
| `long-screen` skill | Lanes A–F, move coverage, the macro regime |
| **`docs/history.md`** | **incident narratives, superseded values with their dates, and the measurement write-ups behind the rules below** |
| `docs/rules-evidence.md` · `docs/failure-modes.md` | rules 1–7 · the named failure modes |
| `worker.js` | **every constant, threshold, weight and anchor — the source of truth** |

---

## ⚠ Read this before writing any code

**These rules take precedence over any general platform or skill documentation where the
two conflict** — general guidance does not know this account's plan limits or this
Worker's history. **Each has already caused a failure here**, the first three *silently*.

### 1. Subrequest budget: 10,000 per invocation, one pool

Workers Paid: **10,000 subrequests per invocation** (`limits.subrequests` raises it),
**per invocation, not per chunk** — chunking inside one handler has never bought
anything. **IT IS ONE POOL, and this rule has been wrong in BOTH directions:** external
`fetch()` **and** `env.REC_LOG.get/put/delete` and every R2 / D1 / DO binding count
against the same 10,000. **Do not restore the two-bucket table, and do not write a
comment claiming KV reads are free of the cap.**

**THE CAP IS NOT WHAT STOPS FAN-OUT. YAHOO IS.** Firing 22 tickers at once gets the
**Yahoo crumb rate-limited**, which the plan change did not touch. So `/api/long/batch`
and `/api/premium/batch` stay **KV reads that make no outbound fetch**, "Load all" stays
**strictly sequential**, and the deleted KV queue that drained the premium sweep **stays
deleted**. A per-item `catch` that cannot tell "this item failed" from "the budget is
gone and every remaining item will fail" reports partial data as complete at any
ceiling. **`ctx.waitUntil` gets no budget of its own.**

**MEASURE, DO NOT ESTIMATE, AND QUOTE `capCost`.** `INSTR` wraps `globalThis.fetch` and
`instrWrapBindings(env)` wraps every binding; `instrMark()`/`instrSince()` bracket a job
and the result rides as `_instr`. **`capCost` = `extFetches` + `bindingOps`** is the
figure the 10,000 meters — `extFetches` alone understates the batch paths, which cost
**one KV read per symbol** (22 names = 22, not 0).

**`_instr` IS A COUNTER DELTA, NOT A PER-JOB TOTAL — concurrent jobs contaminate each
other.** On a firing dispatching more than one job (the normal case on the cron path) a
per-job figure is an **upper bound on the job and a lower bound on the invocation**.
**Quote a per-job `_instr` only for a job that ran ALONE, and say which case you are
in**; otherwise quote `invocationCapCost`, or **quote the DERIVATION instead of the
counter** (`collectMarketMood`: 16 ext + 3 bindings = **capCost 19**).

**KNOWN GAP — the Cache API** counts against the cap and travels over neither counter;
nothing uses it today (verified by grep) and `cacheApiCounted: false` says so. **Any new
binding, or the first use of the Cache API, must be checked against the
instrumentation's coverage in the same commit**, and **a zero count with
`measured: false` means "not instrumented", not "made no calls"**. **Instrumentation may
never break what it measures**: a failure degrades to a missing `_instr`, never a
missing briefing.

> [`docs/history.md`](docs/history.md) · [`docs/rules-evidence.md`](docs/rules-evidence.md)

### 2. The cron expression is a coarse wakeup — put no calendar logic in it

The trigger is `*/15 12-22 * * *`: every 15 minutes, UTC hours 12–22, **every day**. It
decides *how often we wake up* and nothing else — which day, date and job is decided in
`scheduled()`, in code, against Pacific wall-clock time. **Do not put a day-of-week,
day-of-month or month back into the expression.** It once ended in `1-5`, and
**Cloudflare's day-of-week field is 1-indexed with 1 = Sunday**, so that meant Sun–Thu:
no job ran on a Friday and a Claude briefing burned every Sunday, unnoticed for weeks
because a cron that does not fire logs nothing. **`2-6` would be correct today and is
still the wrong fix** — a cron expression's semantics are not testable from this repo
and `scheduled()`'s are (`node cron-gate.check.mjs`).

**The gate skips NYSE holidays, not just weekends.** `NYSE_HOLIDAYS` is derived from
`NYSE_HOLIDAY_TABLE`, so the gate and `GET /api/calendar/holidays` cannot disagree, and
runs through `NYSE_HOLIDAYS_THROUGH` = **`2027-12-31`**. **Extend it before the runway
runs out** — past that date every weekday reads as open and the dispatcher logs a
`WARN`. **Early closes are NOT modelled — a known, deliberate gap**: the NYSE closes
10:00am PT the day after Thanksgiving and on Christmas Eve, so the 11:30am PT midday
pulse runs post-close and describes a finished session as live.

**A job whose UTC hour falls outside the window silently does not run for half the
year**, because `scheduled()` dispatches on **Pacific** time while the trigger is
**UTC**. **Before scheduling anything, check the target Pacific hour in BOTH regimes:**

```
PT hour  →  UTC under PDT (-7)  |  UTC under PST (-8)     the window is 12-22
 4:00am  →  11:00  ✗ OUTSIDE    |  12:00  ✓   <- the early edge
 5:00am  →  12:00  ✓            |  13:00  ✓
 5:30am  →  12:30  ✓            |  13:30  ✓   print-tape BMO pass 1
 2:30pm  →  21:30  ✓            |  22:30  ✓   print-tape AMC pass 2 — the last job
 3:00pm  →  22:00  ✓            |  23:00  ✗ OUTSIDE  <- the late edge
```

**The hour range is the ONE thing in this expression allowed to change.** It widened
`13-22` → `12-22` on 2026-09-01 for the 05:30 PT print-tape pass, which is 12:30 UTC
under PDT and would otherwise have silently not run all summer. `longarch.check.mjs`
§6e READS the range from `wrangler.toml`, asserts the three calendar fields are `*`, and
re-derives every scheduled PT hour against it in both regimes.

### 3. Encoding: declare `charset=utf-8` on every JSON response

The Worker emits UTF-8 and its strings carry `–`, `—`, `·`, `≥`, `×`. Served as bare
`application/json` the charset is unstated, and a Latin-1 fallback renders `E2 80 93` as
`â` — the mojibake that appeared in the econ-calendar notes. `json()` sends `JSON_CT`
(`application/json; charset=utf-8`), and so must every hand-built
`new Response(JSON.stringify(...))`. **The bytes were always correct; only the
declaration was missing** — never "fix" it by replacing the characters with ASCII.

### 4. CORS preflight: any custom request header must be allowlisted

**Adding a custom request header to either frontend is a two-file change.** The browser
CORS-safelists exactly four request headers (`Accept`, `Accept-Language`,
`Content-Language`, `Content-Type`); anything else makes the request "non-simple" and
the browser **will not send the real request** unless the preflight response names that
header in `Access-Control-Allow-Headers`. `CORS_ALLOW_HEADERS` is declared next to
`ALLOWED_ORIGINS`, built from `AI_SECRET_HEADER` so the check and the advertisement
cannot drift. **Add any new header there in the same commit that adds it to the client.**

Two ordering rules in `fetch()`: **`OPTIONS` is answered before the origin 403 and
before any gate** (a preflight carries no custom headers by definition, so a gate
running first would reject its own preflight — **never move a check above that block**),
and **the preflight response must carry `Access-Control-Allow-Origin`, `-Methods`,
`-Headers`, `-Max-Age` and `Vary: Origin`**. A disallowed origin gets a bare 403.

**curl cannot catch this class of bug, and neither can I without a browser.** Open
`cors-check.html` **in a browser** from an allowlisted origin. There a **401 or 429 is a
PASS**; only a `TypeError` with no status is a CORS block.

### 5. The spend gate: `/api/claude` is gone

**Never reintroduce a path where the caller supplies prompt text.** Rate limiting does
not help: one request at an open LLM proxy is already worth stealing. A caller may name
only a *task* and a *ticker* — `POST /api/ai/:type/:ticker`, types in `AI_TASKS`, whose
`build()` gathers its own data and assembles the prompt from a template in `worker.js`.
The ticker is regex-constrained because it is the only caller-controlled value reaching
the prompt. **If a task needs caller input, constrain it to an enum in the Worker.**

**Seven request paths could reach `workerClaude()`, and all are gated.**

| gate | paths |
|---|---|
| `aiGuard` — **reject** | `POST /api/ai/:type/:ticker` · `GET /api/earnings/:ticker` · `GET /api/market/week-ahead` · `GET /api/market/sectors?refresh=1` (a warm read stays ungated so the tab still paints) |
| `maySpend` — **degrade** | `GET /api/market/scanner` · `GET /api/daily` (**BOTH** regeneration paths) · `GET /api/watchlist/batch` |
| `requireSecret` — KV writes | `POST`/`DELETE /api/analysis/:ticker` · `POST /api/watchlist/save` · `POST /api/log-rec` |

The `maySpend` paths degrade rather than reject **on purpose**: their *data* must reach
the page regardless. **The gate FAILS CLOSED** — with `AI_GATE_SECRET` unset every AI
path 503s, so **AI features stay dark until you set the secret after deploying.**

**Ceilings are denominated in CLAUDE CALLS, not requests, and the difference is 30×.**
`AI_RATE_PER_IP_HOUR` (40) and `AI_RATE_GLOBAL_DAY` (60) — **the global one bounds the
bill**, since rotating IPs defeats the per-IP one. `aiGuard` takes a `cost`;
`/api/watchlist/batch` passes the number of analyses it will queue, and a request whose
cost would breach a ceiling is refused **entirely**. **`maySpend()` INCREMENTS**, so call
it only once the handler knows it will spend. **None of this is authentication.**

```bash
# generate one, then set it on the Worker
node -e "console.log(crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,''))"
npx wrangler secret put AI_GATE_SECRET
```

Then paste the same value into `DASH_KEY` at the top of the script block in **both**
`index.html` and `dashboard.html`. It is sent as `x-dash-key`.

### 6. `DASH_KEY` is only live once it is pushed to GitHub Pages

Editing `DASH_KEY` in the working tree changes nothing the browser sees: the pages are
served by **GitHub Pages from the last pushed commit**, so the fix is `git push`, not
the edit. This has produced the same dead end twice. **Both frontends carry their own
copy and must be updated together.** Separate the two questions — the symptom is one
401 either way:

| Question | Test | Fix |
|---|---|---|
| Does the key match `AI_GATE_SECRET`? | `curl -H 'x-dash-key: …' …/api/earnings/AAPL?facts=1` → 200 vs 401 | repaste / rotate the secret |
| Are the right bytes deployed? | `curl -s <pages URL>/index.html \| grep -m1 '^const DASH_KEY'` | `git push` |

**`?facts=1` is the probe to use**: it passes the gate *before* `handleEarningsAnalysis`
decides not to call Claude, so it tests the gate at **zero Anthropic spend** (it still
costs one unit of `AI_RATE_GLOBAL_DAY`). **Never probe with `POST /api/analysis/:ticker`
or `/api/watchlist/save`** — they pass the gate by *writing KV*, so a successful test
corrupts a card or reseeds what the crons spend on. **A 503 rather than a 401 means
`AI_GATE_SECRET` is unset on the Worker** — a config fault, not a key fault.

> The symptom → cause table: [`docs/history.md`](docs/history.md)

### 7. A job that never runs produces no evidence — log every dispatch decision

`scheduled()` logs on **every** invocation, skips included, with the PT date, PT weekday,
holiday verdict and branch taken (`[cron] 2026-09-07 Mon 06:00 PT · not a trading day
(nyse-holiday) · branch=none`) — **a no-op that logs "Sat — skipped" is falsifiable;
silence is not.**

**`Promise.allSettled` discards rejections**, so a truncated run reports `errors: 0`
while dropping a third of its work — that is how `build13FIndex` shipped 16 of 20
managers. Fan-out goes through `allSettledCounted(promises, label)`. **When adding a
scheduled job or a fan-out: give it a branch name in the log line and a counted
`allSettled`.**

**Every cron job goes through `dispatchJob(ctx, name, () => job(env))`**, which catches
and logs `!! JOB-FAILED !!` naming the job — **never write a bare
`ctx.waitUntil(job(env))` in `scheduled()`.** The cost: **invocation status and
`errors: 0` are NOT evidence that any cron job succeeded**, only that nothing escaped
uncaught. The evidence is the job's own **per-job KV stamp** plus a grep for
`!! JOB-FAILED !!` — which **only fires when a job REJECTS**, so it is a **positive
signal, never a negative one**.

> **THE GREP HALF HAS NEVER BEEN RUNNABLE.** Workers Observability returns **403 with a
> valid token** and no Observability-Read token is provisioned. **Do not write a
> verification step that greps for `JOB-FAILED` until one exists** — a standard nobody
> can execute reads, at a glance, as one that was.

**EVERY DEDUP STAMP IS GUARDED ON THE RUN HAVING ACCOMPLISHED SOMETHING.** Five jobs used
to stamp after a run that did nothing — a clean 200, no `JOB-FAILED`, **and** dedupped
out of the day. The key → guard table is in [`docs/history.md`](docs/history.md); the
four non-obvious thresholds are **`ok === N`, not `ok > 0`** (IV sweep — per-ticker
writes are idempotent, so a retry fills gaps), **NOT `filled > 0`** (forward-returns —
most days 0 filled is correct *and* complete; the incomplete signal is an unreadable
chart), **`written + skipped === N`** (move-series — `skipped` is a complete outcome,
`absent` is not), and **an infrastructure `error` blocks the stamp while a DOMAIN status
does not** (`no-options`/`no-iv`/`no-expiries` are facts about the ticker).

**A PARTIAL RUN WRITES BUT DOES NOT STAMP** (`market-mood`, `top3`): a finding over the
readable names is still a finding, and the key is rewritten whole so a retry replaces
rather than duplicates. A run where **every** item failed writes nothing.

**`data.eod.complete === false` IS A THIRD RENDER STATE, and the test is never
`!data.eod.complete`** — a record with no `complete` field predates 2026-08-12 and is a
**REAL** summary. Its timestamp assignment must be **unconditional**: skipping it left
the previous render's line in place, so a failed generation appeared as a timestamped
market-close report. **A stale value is a worse lie than a blank one.**

Three telemetry facts, each of which has already been misread as evidence:

- **`iv:` `src` IS LAST-WRITER-WINS.** Four writers share `iv:{TICKER}:{DATE}` and
  `recordIvSample` rewrites the body whole, so **an absent `src` means pre-2026-08-12,
  not `'api'`** and counting `src: 'sweep'` is not sweep coverage. **Sweep completeness
  cannot be measured retroactively and a raw `iv:` count is actively misleading** —
  2026-08-10 showed 35 samples against a 33-name watchlist on a day it never ran.
- **There is no cron execution history unless `[observability] enabled = true` is in
  `wrangler.toml`**, and **absence of cron lines in a tail is not evidence** — it is an
  unreadable instrument, read as evidence for two hours. It must be in the file, not the
  dashboard (`wrangler deploy` overwrites dashboard-set values), and the top-level
  `enabled` **seeds** `logs.enabled`.
- **`workersInvocationsAdaptive` IS SAMPLED — NEVER ARGUE FROM ABSENCE.**
  `sampleInterval` took the values 1, 1.6, 1.667, 2, 2.5, 2.8 and 10 inside one two-hour
  window. **A present row (with `sampleInterval` 1) proves that invocation happened; an
  absent row proves NOTHING, ever.** Always select `avg { sampleInterval }` beside what
  you count. Its `subrequests` field **excludes KV binding ops**, so it is not `capCost`.

> The stamp-guard and 9-day `iv:` tables: [`docs/history.md`](docs/history.md)

## Deploy & develop

```bash
npm install

# First-time setup
npx wrangler login
npx wrangler kv namespace create REC_LOG   # NOT `kv:namespace` (deprecated).
                                           # Copy the id into wrangler.toml

# Secrets (deployed environment)
npx wrangler secret put AI_GATE_SECRET      # REQUIRED — gates every AI + KV-write
                                            #   path; without it they 503 (fail closed)
npx wrangler secret put ANTHROPIC_API_KEY   # required — all Claude synthesis
npx wrangler secret put FRED_API_KEY        # macro release dates + DGS3MO risk-free rate
npx wrangler secret put FINRA_CLIENT_ID     # official short interest
npx wrangler secret put FINRA_CLIENT_SECRET
npx wrangler secret put ALPACA_KEY          # optional — real-time prices, news archive
npx wrangler secret put ALPACA_SECRET

npx wrangler deploy
npx wrangler dev      # local, port 8787 by default
npx wrangler tail     # live logs from the deployed Worker
```

**`wrangler dev` cannot see deployed secrets.** It reads `.dev.vars`, **gitignored**
and so absent on a fresh clone — the most common source of confusion when testing
locally. Without it: **no premium candidate strikes at all** (no `FRED_API_KEY` →
`riskFreeRate()` null → every BS delta **suppressed rather than computed at `r = 0`**),
**econ calendar FOMC-only**, **short interest on the labelled Yahoo estimate**, **every
Claude-backed card empty**, and **Market Mood rendering its house TEMPLATE sentence
rather than an empty card** (the verdict is rules-decided, so only the phrasing
degrades and `sentenceSource` reads `template` — the fallback working, and why the
Claude half of that job cannot be exercised locally).

To test those paths locally, create `.dev.vars` with the same key names as the secrets
above (`AI_GATE_SECRET`, `ANTHROPIC_API_KEY`, `FRED_API_KEY`, `FINRA_CLIENT_ID`,
`FINRA_CLIENT_SECRET`), one `NAME="value"` per line. FINRA credentials are also read as
`FINRA_API_KEY`/`FINRA_API_SECRET`, a `finraToken()` fallback for the older names.

After deploying, set `API_BASE` near the top of both HTML files to the Worker URL. The
HTML is hosted on GitHub Pages, and **opening it from `file://` no longer works** — that
sends `Origin: null`, which the Worker rejects along with every other absent origin.
Serve over http locally (`npx http-server -p 8123`); `http://localhost:*` and
`http://127.0.0.1:*` are allowlisted.

There is no build step. **Eighteen check scripts** (`*.check.mjs`) cover `worker.js`.
Every one **prints computed vs expected** rather than asserting, and extracts what it
tests **from `worker.js` by source**, because every named export there must be a
function or `workerd` refuses to boot. **`longarch` and `printtape` also IMPORT the
default export**, which is the ES-module parse `node --check` cannot perform.

Floors (each script's `minComparisons`): **138 / 31 / 28 / 35 / 13 / 30 / 70 / 36 / 67 /
144 / 287 / 91 / 113 / 68 / 99 / 240 / 241 / 862** for moves / long-fixtures / cron-gate
/ instr-bindings / bs-delta / nd2 / lane-e / lane-f / sweep-universe / macro / mood /
swing / earnings-timing / daily-slots / analysis-shape / top3 / longarch / printtape —
**2,593** (printtape 543 → 862 on 2026-09-03, the two-gate restructure). A full run on
2026-09-03 observed **2,647, 0 failing**; the 54-comparison gap
is entirely the two scripts that read **live** data (`swing` **99**, `earnings-timing`
**159**), whose floors are deliberately their FIXED counts so a quiet tape reports a
verdict rather than a false NO VERDICT. **Never raise either to an observed total.**
`node iv-capture.fixture.mjs` is a nineteenth script, deliberately outside that total.

**`node --check` IS NOT A SUFFICIENT PRE-DEPLOY PARSE.** `worker.js` is an ES module
and `node --check` parses it as CommonJS, so it has returned exit 0 twice on a file
`workerd` would refuse to boot.

```bash
node --check worker.js         # NOT sufficient on its own
node cron-gate.check.mjs       # imports worker.js as an ES module — the cheap one
npx wrangler dev               # the real workerd startup validation
```

Three rules for the checks themselves: **a check that goes red on the calendar is worse
than no check** (any fixture compared against a freshness window gets a **relative**
timestamp); **a fixture must rebuild the CALL'S clock, not just its bars** (the hour is
an *input*, and when a heading claims a symmetry, count the assertions on each side
before believing it); and **`mood.check.mjs` uses a brace-matching `grabConst`** — copy
that version for any table holding prose.

> Per-script detail and the fixture incidents: [`docs/history.md`](docs/history.md)

## Architecture

### Worker invariants

**Every line here is a contract a session can violate in a single edit.** The annotated
originals, with the incident behind each, are in [`docs/history.md`](docs/history.md);
endpoints, the KV key/TTL table and the cron schedule are in `worker-internals`.

**Cost and Claude calls**

- `capCost` = `extFetches` + `bindingOps`; `extFetches` alone understates the long
  screen. `yahooSparkCloses` takes 20 symbols/request — `ceil(N/20)` fetches
- Never read `content[0].text` — Opus 5 thinks by default and slot 0 is `thinking`
- **`claudeText()` cannot tell a complete answer from a truncated one.** Use
  `workerClaude(…, { raw: true })` and check `stopReason === 'max_tokens'` wherever a
  cut-off answer would be stored or rendered as finished prose
- `max_tokens` caps thinking + answer together, not the answer alone

**Data honesty**

- IV is carried as **percent**; `bsDelta` takes **decimals**
- `ivRank` is null until 60 days of history exist, and nothing stands in for it
- The risk-free rate is FRED `DGS3MO`, **suppressed and never defaulted**
- SEC EDGAR needs a real contact email in `SEC_UA` or it 403s everything; verify every
  CIK against EDGAR before adding it to `SUPER_INVESTORS`
- Option-strategy gates are relative, never absolute; provenance badges are derived by
  `setBadge()`, never authored
- **Market Mood's states are decided by rules**; Claude may only rephrase the verdict,
  and `sentenceSource` says which the reader is seeing

**KV records**

- Do not declare a local `const TTL` — `TTL` is a module-level table
- **`/api/daily` is THREE KEYS merged at read time.** A run writes its own slot and may
  clear a sibling **only** on a PT-date rollover, via `purgeStaleDailySlots()` — never
  restore an unconditional `delete('daily:eod'/'daily:midday')`. All three carry
  `ptDate`; absent `ptDate` **and** unusable `ts` means STALE, which regenerates
- **`analysis:{TICKER}`: never read the key directly — go through
  `readAnalysisRecord()`**, or a legacy record reads as unanalysed and re-spends. Core
  `rating · confidence · recommendation · drivers[] · summary`; `factors{}`/`thesis` are
  synthesis-only and **omitted, never nulled**
- `moves:`, `mood:state`, `radar:`, `top3:`, `incomerow:`, `printtape:` schema checks
  stay **strict equality**; `calib:pooled` lives in the cron and must never move
- **A REFUSAL IS A DISTINCT STATE FROM AN EMPTY RESULT**: radar returns
  `candidates: null` and **never caches a refusal**, `top3`'s `entries: []` means the
  gates ran and nothing survived while absent means it did not run, and income returns
  `entries: null`

**Prefix discipline — a scanned prefix must not read a sibling as a ticker**

- `ivsweep:last` outside `iv:`, `top3sweep:last` outside `top3:`, `morningrows:last`
  outside every scanned prefix, `printtapeday:` outside `printtape:`
- Income rows are **`incomerow:`**, never `income:`; `longarch:` and `long:` are
  **disjoint**, which is why the archive is not `long:{TICKER}:{DATE}`
- **`income:tickers` is NOT a sweep universe** — `sweepUniverse()` reads
  `watchlist:tickers` and nothing else; folding the sleeve in enlarges three cron sweeps

**Freshness vs retention — always two different questions**

- **`LONG_ROW_TTL` 7d vs `LONG_FRESH_MS` 4h. Never raise freshness to "match"
  retention.** Retention outlives the weekend/holiday gaps the writer's own schedule
  creates; freshness decides the stale badge, the cache hit and the sweep's reuse gate.
  Three guards keep an aged row out of anything that ranks or scores: `top3Sweep`'s 4h
  non-`error` reuse gate, `top3Rank` dropping any row whose PT date is not today, and
  `readLongRow` retiring any row whose schema is not `LONG_SCHEMA`
- **A `status: 'error'` long row IS banked — a refusal is a finding — but NO PATH MAY
  TREAT ONE AS A SATISFIED CACHE.** The no-param path falls through to the refetch;
  **`?cached=1` is the one exception and must stay one**, being a no-fetch promise
- **THE YAHOO CRUMB HAS RETENTION AND NO FRESHNESS TERM.** `CRUMB_KV_TTL` 2d, reused
  **whatever its age**, because every 401/403 path re-acquires — a stale crumb
  self-corrects, a missing one guarantees a cold acquire. Those paths must call
  `getYahooCrumb(env, { force: true })`, which skips both caches and **overwrites** KV;
  `force` must appear **nowhere else**
- **A CRUMB FAILURE MUST CARRY WHAT YAHOO SAID.** Both acquisition strategies once
  swallowed their response (`if (r.ok)` plus a bare `catch (_) {}`), so every failure
  read as the one string *"all strategies exhausted"* and **the HTTP status was never
  captured anywhere** — not in KV, not in a log, so **not in a `wrangler tail` either.
  The instrument was missing, not the log line**, and that is why the two 2026-09-02 BMO
  passes are permanently unanswerable. `attempts`/`note()` now record each strategy's
  status into the warn **and** the throw, and the print-tape scan keeps the message
  instead of discarding it with `.catch(() => …)`, so `scanReason` in
  `printtapeday:{PT-DATE}` answers the question **durably**. It is **diagnostic only** —
  every push is unconditional, `note` cannot throw, and nothing reads it back as control
  flow. `no-status` means the response carried no `status`; it is **not** a 0
- **`TOP3_TTL` (7d) and `TOP3_SERVE_WALKBACK_DAYS` (5) are separate bounds; neither
  works alone.** **`readTop3` serves the NEWEST SURVIVING record**, unmodified and with
  no `served` marker. A KV throw ABORTS the walk; a schema mismatch reads as absent and
  the walk CONTINUES
- `premium:` and `mood:state` freshness and retention must not be equal either
- `/api/long/batch` is **`N + 2`** binding ops on the top3 hit path, at most **`N + 7`**
  on the miss — macro and `top3` are read in the envelope, never per row

**Sweeps and the cron**

- `scheduled()` gates on the Pacific trading day before dispatching
- **The IV sweep's unconditional overwrite IS the sampling design** — one sample per
  name per day at 13:15 PT. **Never add `skipIfPresent` to the cron path**
- The top-3 and 7am sweeps are **strictly sequential** — Yahoo crumb rate-limiting, not
  the cap. **`refreshLongTicker` does not throw on a Yahoo failure**; it returns
  `{ok:false, status:'error'}`, so a `try/catch` alone would stamp a broken run out of
  the day
- **The 7:00am PT `collectMorningRows` job RANKS NOTHING** — never `collectTop3`,
  `top3:{PT-date}` or `top3sweep:last`. That dedup is a PT-date compare, so a 7am stamp
  would make the 1:15pm firing skip and replace the day's post-close ranking with one
  priced off opening spreads. Own stamp `morningrows:last`; `h === 7 && m < 45`
- `longarch:{TICKER}:{PT-DATE}:{SLOT}` is written by the **cron sweeps only** — a
  fixed-clock write is a daily series, an on-demand one a record of what someone opened.
  The SLOT names when the snapshot was taken, the row's `ts` when its data was computed,
  and a reused row legitimately disagrees. Served verbatim, forward only

**`printtape:` — the rules that make the record honest**

- **NEVER COMPARE AN ACTUAL AGAINST A CONSENSUS FROM A DIFFERENT QUARTER** — same
  period-end date by **string equality**, or the unmatched half is
  `{status:'not-published'}`. The PRE-BANKED quarter NAMES the quarter; it does not
  relax the gate
- **`tape` is a PAIR of windows and the verdict reads `tape[tape.usedWindow]`** — the
  freshest by `quoteTime`, **re-derived after every merge, never carried**, nothing
  hoisted to the top level. **`consensusSource` and `consensusBankedTs` answer DIFFERENT
  questions**: a bank was *taken* vs where **this record's** figures came from
- **THE TEST IS TWO GATES AND `stage` IS THE ANSWER (schema 3).** Gate 1 — EPS beat AND
  the used window sold it — is free and structured; gate 2 is the revenue beat. `stage` ∈
  `not-run` · `refused` · `agree` · `candidate` · `divergent`, and **`divergent` is DERIVED
  from it, never assigned**: `printTapeStage` is the only decider and the job's
  `applyStage` the only assigner. **A `candidate` IS A FINDING, NOT AN ABSENCE** — it is
  not `printTapeComplete` and it does carry over. **`null` is still a REFUSAL, not a "no."**
  Measured on AVGO 2026-09-02: the revenue actual is not obtainable from Yahoo inside this
  feature's window at all (absent 14h after the print, NVDA's absent six days), so a single
  five-input test could only ever refuse
- **THE STAGE IS RE-DECIDED TWICE PER RECORD — after `mergePrintTapeRecord` AND after the
  release read** — because each supplies inputs the previous decision did not have. A stage
  that outlives its own cause is the defect schema 3 is downstream of
- **ONE Claude call per ticker per report, reaching BOTH halves.** It runs for a
  `candidate` or a `divergent` (not divergents alone — that was almost never reachable),
  gated on the **`releaseRead` stamp, set only when the model ANSWERED**, so a ceiling
  rejection stays retryable and an empty answer is never re-asked. **A model-extracted
  revenue passes three gates before it is believed**: a null guard, a units cross-check
  against the model's own `revenueValueText`, and a 4× plausibility band against the same
  quarter's consensus. **Its citation is resolved BY INDEX from the numbered coverage
  block — never from a URL the model wrote**
- **YAHOO IS THE LATER CROSS-CHECK, NEVER AN OVERWRITE.** A release figure stands; a Yahoo
  figure past 1% becomes `revenueConflict` carrying BOTH numbers. The gap-fill runs one way
  only — a Yahoo actual that landed first is never displaced
- **The carry-over reads YESTERDAY'S DAY INDEX, never a re-scan** (Yahoo rolls
  `earningsTimestampStart` forward within a day); a carried name with no `earningsTs` is
  REFUSED, and **`prevTradingDay`/`nextTradingDay` skip NYSE holidays**. **It appends its
  own entry to the REPORT DAY'S index whenever it SCREENED anything**, carrying
  `written:[tickers]` — AVGO's real 2026-09-02 index had both morning passes at
  `scanOk: false` and was answered the next morning, and with no entry a report day reads
  as one whose scans simply failed. **`scanOk` there is the prior-index read, not an
  eligibility scan** — the carry-over runs none

### Feature records and the two skills

**`printtape:` · `GET /api/income/*` · `GET /api/radar` · `top3:{PT-DATE}` ·
`long:`/`longarch:` · the Yahoo crumb** each have their own constants and gates, and
**the invariants above carry every rule from them a session can break in one edit.**
TTLs, schemas, endpoint gates and the cron schedule are in **`worker-internals`** —
**load it before editing any `/api` endpoint, KV key, cron job, sweep or external data
source**; it also holds Yahoo crumb auth, `bsDelta` and the FRED risk-free rate, SEC
EDGAR insider and 13F indexing, FINRA short interest, `primeTabs()` cost and the sweep
universe's refusal contract. **Load `long-screen` before touching `longRow()`, any lane
builder, `attachCoverage`, `expectancyFrom`, `probBeyondBreakeven`, `collectMoveSeries`,
`collectMacroState`, or the Long tab rendering** — it holds Lane F's direction inversion
(coverage is the probability of the WIN, the opposite of every other lane), Lane E's four
gates and tail split, Lane A's coverage refusal, the `moves:` schema-2 pair shape and
`macroRegime`'s sign convention.

Every threshold, weight and anchor (`TOP3_ANCHORS`, `TOP3_WEIGHTS`, `PRINTTAPE_PASSES`,
`RADAR_MIN_*`, `INCOME_*`) is declared at the top of its feature's block in
**`worker.js`**, the source of truth; the why is in
[`docs/history.md`](docs/history.md). **Do not restate a constant here** — a number
copied into this file can disagree with the Worker.

### Frontends

**Tab contents and the per-ticker card map are in `ARCHITECTURE.md` (*"The two
pages"*)**; below is only what a session can break in one edit.

`dashboard.html` has **six tabs**, deep-linkable by hash (`#market` default · `#midday` ·
`#scanner` · `#watchlist` · `#sectors` · `#long`; `#premium` → `#long`). `switchTab()`
only lazy-loads a tab whose data is still empty, and Sectors and Scanner use
stale-while-revalidate, so **no tab requires a click to show data**. **The Long tab is
the only one that fetches on interaction: expanding a row spends the subrequests.**

**The Swing column** is an OLS channel over the last `SWING_REG_BARS` (30) **completed**
daily closes, σ being the **standard error of the regression** — the spread of the closes
about the fitted line, *not* the stdev of the closes. **The Worker decides the signal**
and ships `swingThreshold`/`swingBars`; **the page never compares `swingZ` to a number of
its own.** Today's forming bar is excluded until the 4:00pm ET close and the line is then
read at x = 30, at **zero added subrequest cost**.

**Earnings session timing** (`earningsTs`, `earningsSession` — `bmo`|`amc`|`unknown`,
**never null** — and `earningsIsEstimate`) **decides a DEADLINE, not a label**: a wrong
answer moves a deadline by a whole session. The order in `earningsTimingFrom` is
**range → midnight guard → anchors → wall clock**, every step load-bearing. A second
*distinct* `earningsDate` entry means `unknown` (`new Set(raws).size > 1`, so a duplicate
must not trip it); a date-only placeholder is rejected on `utcSec === 0` **before any ET
reading**; then the fixed UTC anchors by **exact** equality (`12:30:00Z` → `bmo`,
`20:00:00Z` → `amc` — **Yahoo publishes a session flag encoded as a constant, so the ET
wall clock is the derived fiction**); then the ET windows. **`unknown` with a real date
is a valid answer**, `etMinutesOfDay` uses `hourCycle: 'h23'`, and **THE YAHOO FIELD IS
`isEarningsDateEstimate`** — the name in ARCHITECTURE #2 is not in the live payload.

Three deletions that must not be undone: **card 08 (dark pool) is absent BY DESIGN**,
deleted rather than renumbered so the gap is a deliberate scar; **section 07 is
swing-only**, because an ORB block and a VWAP line computed from *daily* bars were both
fabrications (**do not re-add either without an intraday feed**); and **the catalyst list
shows only events dated today or later**, because Yahoo's `exDividendDate`/`dividendDate`
are routinely the most recent *past* ones. Indicators are computed client-side from Yahoo
OHLCV; **implied vol is the exception**, from `/api/iv`.

### Data: real vs. stubbed

**Nothing is stubbed** — the dark-pool card was deleted outright rather than mocked, and
provenance comes from `_meta` on every response. **POP on the strategy cards** is
1 − |Δ| of the short strike, labelled a **delta-derived approximation under a lognormal
assumption, not a backtested frequency** — load-bearing, because "Hist Win" sits beside
it and is exactly the measured thing POP is not. **Debit structures render n/a** (their
break-even is not the short strike), and Hist Win stays suppressed pending a backtest.

## Design system

CSS custom properties in `:root` — **never hardcode colors or font stacks.** The token
list is the `:root` block at the top of `dashboard.html`.

## Git workflow

Commit and push automatically at the end of each completed task, without being asked.
One commit per logical task, not per file. Message format: short imperative summary
line, a blank line, then 2-4 bullets on what changed and why.

Do not commit:
- Mid-task, or when a task ended with something broken or unverified
- Work whose verification failed, or that you haven't tested
- Anything requiring my decision that I haven't answered yet

When a task ends with an open question or a known defect, say so and hold the commit until I respond.

Never use git push --force, never rewrite published history, never commit secrets or .dev.vars.

If a push fails, report the error rather than working around it.

Deployment requires approval — do not run npx wrangler deploy without asking for approval.

Kill background processes when a task completes — no wrangler dev, wrangler tail or
http servers left running between tasks.

## Named failure modes

Fifteen failure modes are named in this repo, each from a specific incident. **The
assertion is here; the narrative and post-mortem are in
[`docs/failure-modes.md`](docs/failure-modes.md)** under the same heading, except the
last six, whose evidence is in [`docs/history.md`](docs/history.md).

- **No hit rate goes on screen without its base rate**
- **A single negative probe right after a deploy is UNCONFIRMED, not a failure**
- **Name the population a distribution was measured over**
- **A workaround adopted to make a test safe is evidence about production**
- **When you remove a fallback, audit what it was BOUNDING — not just what reads it**
- **The frontend is ALWAYS newer than the Worker for a while — render that state**
- **A newly rendered figure gets eyes on it before the commit is done**
- **An empty comparison is not a pass**
- **`return ''` in a render helper is where this hides — audit them all.** The question
  is one line: **is this withholding a CONTROL, or a FACT?** A control may vanish; a fact
  may not. `alignChip` and `candDetail` both returned `''` on a **computed refusal**, and
  `candDetail`'s branch hid **66 of 757 candidates, all carrying a reason**.
  **A REFUSED MEASUREMENT IS A FINDING, NOT AN ABSENCE.**
- **A whole-object rewrite is a DELETE of every slot the writer does not own.**
  `/api/daily` is **three KV keys merged at read time**, and `generateDailySnapshot`
  deleted the other two on **every** write — triggered by a *request*, not a cron.
  **"Deletes yesterday's" and "deletes on every run" are the same line of code until a
  date is in the record**, and **a slot with a self-heal and a slot without look
  identical the moment they are both deleted**: the blast radius is what cannot come
  back, a property of the *other* slots the writer never consults.
- **When a metric SELECTS using a vendor-supplied number, validate it against its own
  peers first — then check every other selector fed by the same source.** Yahoo quotes
  junk IV on deep untraded strikes (an AAPL 420 put at **195.72%** against an expiry ATM
  IV of 24.54%), and delta from it wins a delta target 34% above spot. `ivPlausible()` /
  `IV_OUTLIER_MULT` (4) is declared **above both callers** and passed each expiry's *own*
  ATM IV — the first fix was scoped to one screen and that was wrong.
- **Guard the null before the arithmetic: `x == null` and `x === 0` must never render
  the same way.** `(null * 100).toFixed(0)` is `"0"`, which printed *"hit rate 0% over
  n=12"*. **Check the guard that is already there before adding one.**
- **A status word that cannot fire is worse than no status word.** `no-leaps` was
  unreachable and blamed the wrong thing; it is now `no-expiries`.
- **A DOC'S DEPLOY-STATUS COLUMN IS A CLAIM ABOUT THE WORLD, NOT ABOUT THE REPO — verify
  it against a deployed ARTIFACT before believing it.** ARCHITECTURE.md's build table
  carried **`NOT DEPLOYED` on three rows that were all live** (6, 7 and 8), because the
  cell is hand-written at build time and nothing updates it at deploy time. It sent a
  session — and the prompt that started it — down a plan built on a false premise. **A
  commit date proves a build; only an artifact proves a deploy**, and the artifact is
  whatever the change *writes*: `yahoo:crumb` `expiration − ts` = **172800s** vs the old
  **3600s**, `long:AAPL` = **604800s** vs the old **86400s**. **`wrangler deployments
  list` dates a deploy but never says WHAT is in it.** Re-verify the cell in the same
  task that reads it.
- **AN UNCAPTURED STATUS CANNOT BE TAILED FOR.** *"Tail it and report what the upstream
  returned"* is unanswerable when the code never recorded it — `if (r.ok)` beside a bare
  `catch (_) {}` discards the status before any log could carry it, and the failure
  arrives as one undifferentiated sentence. **Before planning to observe a failure live,
  confirm the value you want is CAPTURED somewhere** — otherwise the tail runs, the
  failure reproduces, and it still says nothing. **A durable record beats a live tail**:
  a status folded into a KV record answers the question on every future occurrence,
  including the ones nobody is watching.

## Verification standard

Before reporting a task complete, state which checks were run and **print the actual
values** — "verified" without a number is not verification, for every numeric output,
every identifier taken from an external source and every calculation.

**Print, don't assert** — computed alongside expected, with deviations. The
Black-Scholes check was trustworthy because it printed 0.52160473 against 0.52200000.

**Check against a different source than the one being tested** — a formula against a
different algorithm, an identifier against the live API, a field name against the live
response. Documentation consensus is not verification: three sources agreed on the wrong
FINRA field name while the live API had the right one in our code.

**Name the verification method's blind spot.** curl cannot catch CORS preflight
failures; a DOM shim cannot catch CSS layout problems; local dev without `.dev.vars`
cannot exercise live-credential paths. When the method cannot reach the failure mode,
say so rather than reporting a pass.

**Verify against a second case.** One passing ticker is a coincidence; three is a
pattern.

## Before every task

Read CLAUDE.md first, and `ARCHITECTURE.md` or the relevant skill for anything it points
at — the record is spread across the files in *"Where everything is"* above and no one of
them is complete alone. **Do not work from assumptions carried over from earlier in a
session or from my prompt** — I have been wrong about what exists in this codebase
multiple times (a 13F override map that doesn't exist, a cached risk-free rate that
wasn't there, mock generators that were dead code, the term-structure sign). **If my
instruction contradicts the code, say so before acting.**

Check any change against **rule #1** (10,000 subrequests per invocation, **one pool** —
external `fetch()` and KV/binding calls both count) and **rule #2** (no calendar logic in
the cron expression, and any new Pacific hour must fall inside the UTC window under
**both** PST and PDT). Both have caused silent failures.

## After every task

**Update the docs in the same task, not later** — a new KV key, constant, secret,
endpoint or threshold goes into its file (see *"Where everything is"*) as it is created.
Docs that lag the code are how a session starts on false premises.

**Report what you could not verify, separately and explicitly** — that section has been
the most useful part of every report.

**Kill background processes** — no `wrangler dev`, `wrangler tail` or http servers.

## Adding a new failure mode

When a bug is found, add a rule naming the specific failure that produced it — **rules
tied to a concrete incident are followed; abstract ones are not.** The assertion goes
here; the narrative and the measurement go in [`docs/history.md`](docs/history.md) or
[`docs/failure-modes.md`](docs/failure-modes.md), so this file stays loadable.
