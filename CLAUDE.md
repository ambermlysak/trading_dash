# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Two-page equity research terminal: a macro landing dashboard (`dashboard.html`) and a per-ticker deep-dive (`index.html`). A single Cloudflare Worker (`worker.js`) handles all API proxying, Claude calls, and KV persistence.

---

## ⚠ Read this before writing any code

**These rules in `CLAUDE.md` take precedence over any general platform or skill
documentation where the two conflict.** General guidance does not know about this
account's plan limits or this Worker's history. Where it disagrees with what is
below, what is below wins.

Each constraint here has already caused a failure in this codebase. The first
three were *silent* — code that returned normally and rendered plausible output
while being wrong. The fourth was the opposite: total, immediate, and invisible
in the Worker logs, because the browser never sent the requests.

### 1. Subrequest budget: 10,000 per invocation, one pool — and the cap is no longer the constraint

This account moved to **Workers Paid on 2026-08-07**. Since Cloudflare's
**2026-02-11** change the paid default is **10,000 subrequests per invocation**,
raisable to 10 million via `limits.subrequests` in `wrangler.toml`. The **50**
that used to sit in this slot is the Free-plan figure and no longer applies
(Free also carries a separate 1,000 ceiling on calls to Cloudflare services;
that split is Free-only). The cap is still **per invocation, not per chunk** —
chunking inside one handler has never bought anything.

**It is ONE pool, and this rule has now been wrong in both directions.** The
original said "every `fetch()` is a subrequest" and budgeted KV against the same
ceiling. The correction over-corrected: it claimed external fetches and binding
operations were *separate buckets*, and that a handler reading 40 KV keys and
fetching 3 URLs cost **3**. It costs **43**. Verified 2026-08-08 against
[developers.cloudflare.com/workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/),
which defines a subrequest as *"any request a Worker makes using the Fetch API or
to Cloudflare services like R2, KV, or D1"*, and lists the paid internal-services
limit as matching the configured limit rather than sitting in its own bucket:

| call | counts against the 10,000? |
|---|---|
| external `fetch()` — Yahoo, SEC EDGAR, FINRA, FRED, Alpaca, Anthropic | **yes** |
| `env.REC_LOG.get/put/delete`, and any R2 / D1 / Durable Object binding | **yes — same pool** |

Do not restore the two-bucket table, and do not write a comment claiming KV reads
are free of the cap.

#### The cap is not what stops fan-out. Yahoo is.

**Read this before treating 10,000 as permission to fan out.** Every structure in
this codebase that avoids fan-out stays exactly as it is:

- `/api/premium/batch` and `/api/long/batch` remain **KV reads that make no
  outbound fetch** (they still cost one KV read per symbol — cheap, not free);
  `/api/premium/:ticker` and `/api/long/:ticker` remain the only paths that touch Yahoo.
- **Load all is strictly sequential** on both tabs, one awaited request at a time.
- The deleted KV queue that once drained the premium sweep across cron firings
  **stays deleted**.

The binding constraint is **Yahoo crumb rate-limiting**, which the plan change did
not touch. Firing 22 tickers concurrently puts 22 invocations against Yahoo at
once and gets the crumb rate-limited — a different failure from the cap and just
as effective. The screen is also used one or two names at a time, so fetching all
22 solves a problem nobody has.

Measured costs, all **external fetches** (see the instrumentation caveat below for
why that is now a lower bound):

| work | external fetches |
|---|---|
| one premium ticker | **~4.8** (1 expiry list + 1 quoteSummary + ~2.8 dated chains) |
| one 13F manager | **3** (submissions.json + filing index.json + info table) |
| fixed overhead per invocation | ~3 (Yahoo crumb, FRED rate, one spark per 20 symbols) |
| one EOD summary | **12**, measured 2026-08-07 (11 index charts + 1 news search) |

Two silent failures came from not budgeting. **Both happened under the Free plan's
50 and both would fit comfortably now** — they are retained because the *failure
shape* is what matters, and the shape is untouched by the ceiling moving:

- The premium screen fanned out the whole watchlist (~110 fetches). Most rows
  rendered "options chain unavailable", which read like a data problem with those
  tickers. It was ours.
- `build13FIndex` needed ~61 and **did not fail** — a per-manager `catch`
  swallowed the cap error and it returned 16 of 20 managers, written to KV as
  though complete. **A per-item `catch` that cannot tell "this item failed" from
  "we exhausted a budget and every remaining item will fail" still reports partial
  data as complete, at any ceiling.**

**`ctx.waitUntil` does not get its own budget.** It shares the invocation's, so
two jobs dispatched on the same cron firing share one ceiling.

**Measure, do not estimate.** `worker.js` counts **both** halves of the pool:
`INSTR` wraps `globalThis.fetch` at module load, and `instrWrapBindings(env)` runs
at the top of `fetch()` and `scheduled()` to wrap every binding. `instrMark()` /
`instrSince()` bracket a job and the result rides along as `_instr`:

| field | what it is |
|---|---|
| `extFetches` | external `fetch()` calls |
| `bindingOps` | KV / R2 / D1 / DO calls |
| **`capCost`** | **extFetches + bindingOps — the figure the 10,000 meters** |
| `bindingsWrapped` / `bindingsSkipped` | the counter's own coverage |
| `cacheApiCounted` | always `false` — see the gap below |

**Quote `capCost`, never `extFetches`.** `extFetches` alone was reported as the
cost of a long-screen ticker and understated it by **125–143%**: measured on AAPL
2026-08-08, premium-warm is 4 external + 5 binding = **9**, and premium-cold is
7 external + 6 binding = **13** (17 when the Yahoo crumb is also cold, which adds
2 fetches and 2 KV ops). The `/api/long/batch` and `/api/premium/batch` endpoints
were documented as "zero outbound calls"; that is true of *fetches* and false of
*subrequests* — they cost **exactly one KV read per symbol**, so a 22-name
watchlist paints for **22** against the cap, not 0. Both now report `_instr`.

**Coverage is declared, not assumed.** `instrWrapBindings` does not name
`REC_LOG` — it walks `env` and wraps everything binding-*shaped* (an object or
function carrying at least one callable member; a secret is a string, a `[vars]`
JSON entry has no methods). So a binding added later is counted the day it
appears. What it wrapped and what it could not ride along in every payload,
because a total that silently omits a source is the `build13FIndex` failure in
different clothing. It sits in front of every KV call in the Worker, so it fails
safe in the strongest sense: any fault returns the **original, unwrapped `env`**
and degrades the report to `bindingsWrapped: []`.

**KNOWN GAP — the Cache API.** `caches.default.match/put` and `caches.open()`
count against the cap and travel over neither `globalThis.fetch` nor `env`, so
**neither counter can see them**. Nothing in the Worker uses the Cache API today
(verified by grep, not assumed), and `cacheApiCounted: false` says so in every
payload.

> **Rule: any new binding, or the first use of the Cache API, must be checked
> against the instrumentation's coverage in the same commit.** For a binding that
> means confirming it appears in `bindingsWrapped` at runtime — shape detection
> should handle it, but "should" is what this codebase keeps getting caught by.
> For the Cache API it means extending `INSTR` to count it and flipping
> `cacheApiCounted`, because a gap that lives only in a JSON payload is invisible
> to the person adding the call. `node instr-bindings.check.mjs` covers the
> detection and the failure paths.

The same `_instr` block is stamped on `daily:snapshot`, `daily:midday` and
`daily:eod`:

```json
"_instr": { "extFetches": 12, "settledRejected": 0, "invocationFetches": 12,
            "scope": "scheduled", "measured": true, "phase": "complete" }
```

- `extFetches` — this job's external calls. Budget against `capCost`, not this.
- `settledRejected` — promises its `Promise.allSettled` blocks swallowed. See
  rule #7; `errors: 0` in Cloudflare's telemetry is not evidence of success.
- `invocationFetches` / `invocationCapCost` — whole-invocation totals. Larger
  than the per-job figures when two jobs share a firing.
- `measured` — whether the `globalThis.fetch` wrap installed. **A zero count with
  `measured: false` means "not instrumented", not "made no calls."**
- `phase` — `briefing` or `complete`. `daily:snapshot` is written before the
  watchlist and sector fan-out and re-stamped after, so a stored payload still
  reading `briefing` means the job died partway. Truncation describes itself.

**Instrumentation may never break what it measures.** A measuring device that can
take out the morning briefing is worse than no measuring device — it would cause
exactly the outcome it exists to make visible. So every function in that block
swallows its own failures:

- `instrSince()` returns a `{ measured: false, note }` stub rather than throwing.
  It is called **inside the `JSON.stringify` of a KV put**, so a throw would lose
  the whole payload.
- `allSettledCounted()` wraps the counting separately from the `await`.
  `Promise.allSettled` never rejects and neither may this, or a bookkeeping slip
  becomes a job failure.
- `instrMark()` returns `null` on failure; `instrSince(null, …)` handles it.
- `stampInstr()` is fully wrapped and runs *after* the payload is stored, so its
  worst case is a stored `_instr` still reading `phase: "briefing"`.

The contract is: **instrumentation failure degrades to a missing or
`measured:false` `_instr` field, never to a missing briefing.** `node
cron-gate.check.mjs` proves it with forced faults — a null baseline and a
rejection whose `reason` throws on property access.

### 2. The cron expression is a coarse wakeup — put no calendar logic in it

The trigger is `*/15 13-22 * * *`: every 15 minutes, UTC hours 13–22, **every
day**. It decides *how often we wake up* and nothing else. Which day, which date,
which job — all of that is decided in `scheduled()`, in code, against Pacific
wall-clock time.

**Do not put a day-of-week, day-of-month or month back into the expression.**

This rule used to be scoped to *hours* ("the window must cover both PST and PDT"),
and the failure that forced the rewrite was the same mistake one field over.

The expression used to end in `1-5`, which reads as Mon–Fri under standard cron
(`0` = Sunday). **Cloudflare's day-of-week field is 1-indexed with 1 = Sunday**, so
`1-5` actually meant **Sun–Thu**. The consequences ran for weeks:

- No cron job ever ran on a **Friday** — no morning briefing, no midday pulse, no
  EOD recap, no IV sample. Friday is a 20% hole in the `iv:{TICKER}:{DATE}` series
  that `ivRank` is being built from.
- A full morning briefing burned every **Sunday** — ~25 Claude calls narrating a
  market that was closed — and, because `generateDailySnapshot` deleted
  `daily:eod` up front, it wiped Friday's close recap every Sunday morning.

Verified from `workersInvocationsAdaptive` telemetry over 2026-07-26 … 2026-08-07:
every Sunday fired, both Fridays did not. Sunday firing is the decisive
observation — under standard cron semantics Sunday (`0`) is outside `1-5` and
should never have fired at all.

**`2-6` would have been correct and is still the wrong fix.** The lesson is not
which magic numbers to type. It is that a cron expression's semantics are not
testable from this repo, and `scheduled()`'s are: `node cron-gate.check.mjs` runs
the real gate over Fridays, weekends, holidays and both DST regimes and prints
computed against expected. Anything the dispatcher decides can be tested before
deploy. Anything the expression decides cannot.

**The gate skips NYSE holidays, not just weekends.** `NYSE_HOLIDAYS` in
`worker.js` holds full-day closures through `NYSE_HOLIDAYS_THROUGH`
(`2027-12-31`), verified two independent ways — NYSE Group's published calendar
and a re-derivation from the observance rules (Easter computus for Good Friday;
Saturday holidays observed the preceding Friday, Sunday holidays the following
Monday; New Year's Day exempt from the Saturday rule). Extend it before the
runway runs out; past `NYSE_HOLIDAYS_THROUGH` every weekday reads as open and the
dispatcher logs a `WARN`.

**Early closes are not modelled, and that is a known gap.** The NYSE closes at
1:00pm ET / **10:00am PT** the day after Thanksgiving and on Christmas Eve
(2026-11-27, 2026-12-24, 2027-11-26 in the current table). On those days the
11:30am PT midday pulse runs **post-close** and describes a finished session as
though it were live, and the 1:15pm PT EOD job runs 3h15m after the bell instead
of 15 minutes after it. Flagged deliberately; not fixed.

The **UTC hour range is still load-bearing**, for the original reason:
`scheduled()` dispatches on **Pacific wall-clock time**, but the trigger is
expressed in **UTC**, and a Pacific hour maps to two different UTC hours across
the year. A job whose UTC hour falls outside the window **silently does not run
for half the year**. `13-22` covers **6:00am–3:00pm PDT** and **5:00am–2:00pm
PST**. Before scheduling anything, check the target Pacific hour in *both*
regimes:

```
PT hour  →  UTC under PDT (UTC-7)  |  UTC under PST (UTC-8)
 5:00am  →  12:00  ✗ outside       |  13:00  ✓
 6:00am  →  13:00  ✓               |  14:00  ✓
 1:15pm  →  20:15  ✓               |  21:15  ✓
 3:00pm  →  22:00  ✓               |  23:00  ✗ outside
```

That one has bitten twice too. A premium pre-open anchor at 5:00am PT only
existed under PST. The 13F job sat at 3:00pm PT and had **never executed under
PST** — it now runs at 10:00am PT (17:00/18:00 UTC), inside the window in both
regimes.

### 3. Encoding: declare `charset=utf-8` on every JSON response

The Worker emits UTF-8, and plenty of its strings carry `–`, `—`, `·`, `≥`, `×` —
the FOMC label `Jul 28–29` among them. Served as bare `application/json` the
charset is unstated, and anything falling back to Latin-1 renders those three
bytes (`E2 80 93`) as `â` — which is exactly the mojibake that appeared in the
econ-calendar notes.

`json()` now sends `JSON_CT` (`application/json; charset=utf-8`), and so does
every hand-built `new Response(JSON.stringify(...))`. **The bytes were always
correct; only the declaration was missing.** Never "fix" this by replacing the
characters with ASCII — that hides the fault and loses the typography.

### 4. CORS preflight: any custom request header must be allowlisted

**Adding a custom request header to either frontend is a two-file change.** The
browser CORS-safelists exactly four request headers — `Accept`,
`Accept-Language`, `Content-Language`, `Content-Type`. Anything else makes the
request "non-simple": the browser first sends an `OPTIONS` preflight, and it will
**not send the real request** unless the preflight response names that header in
`Access-Control-Allow-Headers`.

Adding `x-dash-key` to the frontends without adding it to `CORS_ALLOW_HEADERS`
took the whole site down — **12 requests blocked client-side, nothing in the
Worker logs, because nothing arrived.** The Worker was working perfectly; the
browser never called it.

So: `CORS_ALLOW_HEADERS` is declared next to `ALLOWED_ORIGINS`, built from
`AI_SECRET_HEADER` so the check and the advertisement cannot drift. Add any new
header there in the same commit that adds it to the client.

Two ordering rules in `fetch()`, both load-bearing:

- **`OPTIONS` is answered before the origin 403 and before any gate.** A preflight
  carries no custom headers *by definition* — the browser sends
  `Access-Control-Request-Headers` naming them, not the headers themselves. If the
  gate ran first it would reject its own preflight for want of the very header the
  preflight exists to request permission for, and nothing could ever succeed.
  **Never move a check above that block.**
- **The preflight response must carry `Access-Control-Allow-Origin`,
  `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers` and
  `Access-Control-Max-Age`**, and `Vary: Origin` so a cache cannot serve one
  origin's ACAO to another. A disallowed origin gets a bare 403 with no CORS
  headers at all.

**curl cannot catch this class of bug, and neither can I without a browser.**
A direct `curl -H 'x-dash-key: …'` never preflights — it just sends the header —
so every one of my layer-2 origin tests passed against a Worker that no browser
could talk to. That is exactly how this shipped.

Two things now exist for it:

- `cors-check.html` — open it **in a browser** from an allowlisted origin. It
  issues real cross-origin requests, so real preflights, and reports pass/fail.
  A 401 or 429 there is a **pass**: it means the browser let the request through
  and the Worker answered. Only a `TypeError` with no status is a CORS block.
- A curl-based simulation of the Fetch spec's preflight algorithm is useful for a
  quick check, but it is a *model* of the browser, not the browser. When they
  disagree, the browser is right.

### 5. The spend gate: `/api/claude` is gone

`POST /api/claude` accepted a caller-supplied `messages` array and forwarded it to
Anthropic on the owner's key. It had **no authentication** — `isAllowedOrigin()`
returned `true` when `Origin` was absent, so any non-browser client with the URL
could generate anything at all. It is now a **410** pointing at the replacement.

**Never reintroduce a path where the caller supplies prompt text.** Rate limiting
does not help: the value of an open LLM proxy is per-request, and one request is
already worth stealing. The structural fix is that a caller can only name a *task*
and a *ticker*:

```
POST /api/ai/:type/:ticker      types: see AI_TASKS in worker.js
```

`AI_TASKS.synthesis.build()` gathers its own data (chart, quote, IV, news,
insider, short interest) and assembles the prompt from a template in `worker.js`.
The ticker is regex-constrained (`/^[A-Z][A-Z.\-]{0,9}$/`) because it is the only
caller-controlled value that reaches the prompt. Adding a task means adding an
`AI_TASKS` entry with its own `build()`; if a task needs caller input, constrain
it to an enum in the Worker rather than passing text through.

**`/api/claude` was never the only exposure.** Seven request paths could reach
`workerClaude()`. All are now gated:

| Path | Gate | Why that gate |
|---|---|---|
| `POST /api/ai/:type/:ticker` | `aiGuard` — reject | the endpoint exists to spend |
| `GET /api/earnings/:ticker` | `aiGuard` — reject | button-triggered, ~1800 tokens on a miss |
| `GET /api/market/week-ahead` | `aiGuard` — reject | ~2000 tokens on a cold cache |
| `GET /api/market/sectors?refresh=1` | `aiGuard` — reject | ~3500 tokens; a warm read stays ungated so the tab still paints |
| `GET /api/market/scanner` | `maySpend` — degrade | the ranked list is served either way; only catalyst tagging is skipped |
| `GET /api/daily` | `maySpend` — degrade | the cached briefing is served; only regeneration is gated |
| `GET /api/watchlist/batch` | `maySpend` — degrade | **was the second-worst hole**: 30 uncached symbols in one request fanned out to 30 Claude calls |

The `maySpend` paths degrade rather than reject on purpose — their *data* must
reach the page regardless, and rejecting the endpoint would break the dashboard
for no security gain.

Three KV-write routes also took `requireSecret` (secret, no rate limit):
`POST /api/analysis/:ticker` and its `DELETE` (anyone could store text that then
rendered as a ticker's analysis), `POST /api/watchlist/save` (seeds what the crons
spend on), and `POST /api/log-rec` (poisoning it corrupts the Brier score silently).

**The gate fails closed.** With `AI_GATE_SECRET` unset, every AI path 503s with a
message naming the missing secret. A security control that disables itself on a
missing config is not a control — but it does mean **AI features stay dark until
you set the secret after deploying**.

```bash
# generate one, then set it on the Worker
node -e "console.log(crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,''))"
npx wrangler secret put AI_GATE_SECRET
```

Then paste the same value into `DASH_KEY` at the top of the script block in
**both** `index.html` and `dashboard.html`. It is sent as `x-dash-key`.

Ceilings live next to the gate: `AI_RATE_PER_IP_HOUR` (40) and
`AI_RATE_GLOBAL_DAY` (60). The **global** one is what bounds the bill, because
rotating IPs defeats the per-IP one for free.

**They are denominated in Claude calls, not requests, and the difference is 30×.**
`aiGuard` takes a `cost`, and `/api/watchlist/batch` passes the number of
analyses it is about to queue. Counting requests would have let a 60/day ceiling
authorise ~1,800 calls, because one batch request fans out to up to 30. A request
whose cost would breach a ceiling is refused **entirely** — never partially
charged and never partially served.

Order matters at the call site: `maySpend()` *increments*, so it must be called
only once the handler knows it will actually spend. Asking before checking
`needsAnalysis.length` charged ordinary cached page loads against the ceiling.

Worst case, every call taking the most expensive gated route (`generateSectors`,
3500 answer + 4000 thinking headroom = 7500 output tokens):

```
60 × 7500 output = 0.45 MTok × $25  = $11.25
   + ~3000 input/call = 0.18 MTok × $5 =  $0.90
                                       ---------
                                        ~$12/day   (~$365/month)
```

That is the number to move if the exposure still feels wrong — not the per-IP
one, which an attacker simply routes around. Note the crons are **not** counted:
they call `workerClaude()` directly, so their ~30 calls/day sit on top.

**None of this is authentication.** Read the residual-risk section in
`ARCHITECTURE.md` before assuming any of it stops a motivated attacker.

### 6. `DASH_KEY` is only live once it is pushed to GitHub Pages

Editing `DASH_KEY` in the working tree changes nothing the browser sees. The
pages are served by **GitHub Pages from the last pushed commit**, so the fix is
`git push`, not the edit. This has produced the same dead end twice:

- Commit `35206f0`, *"Set AI gate secret in frontend"*, replaced the placeholder
  `REPLACE_WITH_YOUR_AI_GATE_SECRET` with **another placeholder**,
  `YOUR_STRING_HERE`. The message asserts a step that did not happen, which is
  worse than no commit at all — the log becomes evidence against the real cause.
- The real key was then pasted into both files correctly and the site still
  failed **identically**, because the change was staged and never committed. The
  live page was still serving `YOUR_STRING_HERE`.

So when a gate failure survives a `DASH_KEY` edit, **check the deployed bytes
before re-checking the value**:

```bash
curl -s https://ambermlysak.github.io/trading_dash/index.html | grep -m1 '^const DASH_KEY'
```

Separate the two questions, because they have different fixes and the symptom is
one 401 either way:

| Question | Test | Fix |
|---|---|---|
| Does the key match `AI_GATE_SECRET`? | `curl -H 'x-dash-key: …' …/api/earnings/AAPL?facts=1` → 200 vs 401 | repaste / rotate the secret |
| Are the right bytes deployed? | curl the live Pages HTML, grep `DASH_KEY` | `git push` |

`?facts=1` is the probe to use: it passes the gate in the router **before**
`handleEarningsAnalysis` decides not to call Claude, so it tests the gate at
**zero Anthropic spend**. It still costs one unit of `AI_RATE_GLOBAL_DAY`. Never
probe the gate with `POST /api/analysis/:ticker` or `/api/watchlist/save` — they
pass the gate by *writing KV*, so a successful test corrupts a card or reseeds
what the crons spend on.

Both frontends carry their own copy of the constant (`index.html`,
`dashboard.html`) and both must be updated together — `index.html` alone leaves
the whole dashboard 401ing.

**Check what the local server is actually serving before debugging the page.**
`http-server` serves `.`, and its command line does not record which directory
that was. A run started from a **stale copy of the project** served a 148,135-byte
`index.html` from Aug 4 — the same app, same title, but 3,082 lines with
`API_BASE` at line 865 — which **predates the gate entirely**: zero occurrences of
`DASH_KEY`, zero of `x-dash-key`. So the page sent no gate header, the Worker
returned a perfectly correct 401, and it was indistinguishable on screen from a
wrong secret. Meanwhile every curl test passed, because curl read the key from the
*working-tree* file rather than the one being served.

Compare the served bytes to the file on disk before trusting anything about the
page:

```bash
curl -s http://localhost:8123/index.html | wc -c;  wc -c < index.html
curl -s http://localhost:8123/index.html | grep -c x-dash-key   # 0 == pre-gate copy
```

A byte-count mismatch means you are debugging a different file. Line endings do
not explain a large gap — CRLF→LF on this file is ~3.5KB, not 33KB.

Symptom→cause, since three different faults produce the same 401:

| Symptom | Cause |
|---|---|
| 401, page sends **no** `x-dash-key` | serving a pre-gate copy — wrong directory |
| 401, header sent but value is `YOUR_STRING_HERE` | placeholder never replaced, or Pages not rebuilt |
| 401, header sent with a real 64-char key | genuine mismatch with `AI_GATE_SECRET` |
| **503**, not 401 | `AI_GATE_SECRET` unset on the Worker — a config fault, not a key fault |

Start `http-server` with an explicit path, never `.`, and confirm the port is
serving this repo before concluding anything about the key.

### 7. A job that never runs produces no evidence — log every dispatch decision

Rule #2 is about *why* the Friday cron was wrong. This one is about why it took
**weeks** to notice, which is the more expensive half.

A cron that does not fire writes nothing. No error, no warning, no log line, no
`errors` count in Cloudflare's telemetry — the same silence as a healthy idle
system. There was nothing to grep for, because the absence of a thing is not a
thing. The bug was eventually found only by pulling `workersInvocationsAdaptive`
and noticing a **missing** quarter-hourly heartbeat on two Fridays: a diagnosis
built from a hole in a chart, not from any output the app produced.

`scheduled()` therefore logs on **every** invocation, skips included:

```
[cron] 2026-08-07 Fri 06:00 PT · trading day · branch=morning-briefing
[cron] 2026-08-08 Sat 06:00 PT · not a trading day (weekend) · branch=none
[cron] 2026-09-07 Mon 06:00 PT · not a trading day (nyse-holiday) · branch=none
```

Every line carries the PT date, the PT weekday, the holiday verdict and the
branch taken. **A no-op that logs "Sat — skipped" is falsifiable; silence is
not.** `wrangler tail` on a Friday morning is now a one-line check.

The same principle applies inside the jobs. `Promise.allSettled` discards
rejections, so a truncated run reports `errors: 0` while dropping a third of its
work — that is how `build13FIndex` shipped 16 of 20 managers and how the IV sweep
banked 16 of 22 tickers. Fan-out in the cron generators goes through
`allSettledCounted(promises, label)`, which logs the rejections and totals them
into `_instr.settledRejected` on the stored payload (rule #1).

**When adding a scheduled job or a fan-out: give it a branch name in the log line
and a counted `allSettled`.** A job whose only evidence of running is its own
success is a job you cannot debug when it stops.

#### None of that logging exists unless observability is on

`[observability] enabled = true` in `wrangler.toml` is a **prerequisite for cron
execution history existing at all**. With it off, the log lines above are emitted
into nothing and are not retained anywhere.

That produced the worst two hours of this investigation. `wrangler tail` streams
**live events only** — it shows what happens while you are watching, and retains
nothing. With logging disabled, a quiet tail cannot distinguish:

- the cron did not fire, from
- the cron fired and nothing was kept.

**Absence of cron lines in a tail is not evidence.** It is an unreadable
instrument, and it was read as evidence for two hours.

Know which of the two telemetry systems you are querying, because they are
independent and only one of them needs observability:

| system | needs `observability.enabled`? | what it gives you |
|---|---|---|
| **Workers Logs** (`wrangler tail`, dashboard log search) | **yes** — for anything retained | your own `console.log` lines, e.g. `branch=morning-briefing` |
| **Workers Analytics** (GraphQL `workersInvocationsAdaptive`) | **no** | invocation counts, errors, subrequest totals, timestamps |

The bug was ultimately found through the **analytics** side, which worked the
whole time: a quarter-hourly invocation heartbeat present on Sun–Thu and missing
on both Fridays. That is the fallback when logs are off — counts and timestamps,
never message content. See the diagnosis recipe: pull
`workersInvocationsAdaptive` for the script, bucket by second-of-minute, and look
for the repeating offset that marks a cron firing.

**Observability set in the dashboard does not survive a deploy.** `wrangler
deploy` sends the whole config and overwrites dashboard-set values — the same
drift that produced the cron-trigger divergence warning. Wrangler's own
`normalizeRemoteConfigAsResolvedLocal()` skips `observability` when diffing local
against remote, noting it "has a remote default behavior different from that of
wrangler". So it must be in `wrangler.toml`, and it now is. Note also that
top-level `observability.enabled` is **not** redundant with
`observability.logs.enabled`: `normalizeObservability()` computes
`const enabled = obs?.enabled === true ? true : false` and uses that as the
default for `logs.enabled`.

---

## Deploy & develop

```bash
npm install

# First-time setup
npx wrangler login
npx wrangler kv namespace create REC_LOG   # NOT `kv:namespace` — that syntax is
                                           # deprecated. Copy the id into wrangler.toml

# Secrets (deployed environment)
npx wrangler secret put AI_GATE_SECRET      # REQUIRED — gates every AI + KV-write path;
                                            #   without it those endpoints 503 (fail closed)
npx wrangler secret put ANTHROPIC_API_KEY   # required — all Claude synthesis
npx wrangler secret put FRED_API_KEY        # macro release dates AND the DGS3MO risk-free rate
npx wrangler secret put FINRA_CLIENT_ID     # official short interest
npx wrangler secret put FINRA_CLIENT_SECRET
npx wrangler secret put ALPACA_KEY          # optional — real-time prices + news archive
npx wrangler secret put ALPACA_SECRET

npx wrangler deploy
npx wrangler dev      # local, port 8787 by default
npx wrangler tail     # live logs from the deployed Worker
```

**`wrangler dev` cannot see deployed secrets.** It reads `.dev.vars` in the repo
root instead, which is **gitignored** and therefore absent on a fresh clone. This
is not a bug and it is the single most common source of confusion when testing
locally — a local run with no `.dev.vars` shows:

- **no premium candidate strikes at all** — `riskFreeRate()` returns null without
  `FRED_API_KEY`, and every Black-Scholes delta is then suppressed rather than
  computed at `r = 0` (see the honesty rules)
- **econ calendar degraded to FOMC-only**, reporting `dataReleases.ok: false`
- **short interest falling back to the labelled Yahoo estimate** instead of FINRA
- **every Claude-backed card empty**, since `/api/claude` 500s with no key

To test those paths locally, create `.dev.vars` with the same keys:

```
AI_GATE_SECRET="..."
ANTHROPIC_API_KEY="..."
FRED_API_KEY="..."
FINRA_CLIENT_ID="..."
FINRA_CLIENT_SECRET="..."
```

FINRA credentials are also read as `FINRA_API_KEY` / `FINRA_API_SECRET` — a
fallback in `finraToken()` for the older names. Either pair works.

After deploying, set `API_BASE` near the top of both HTML files to your Worker URL:
```js
const API_BASE = 'https://stock-research-worker.you.workers.dev/api';
```

The HTML files are hosted on GitHub Pages. **Opening them from `file://` no longer works** — that sends `Origin: null`, which the Worker now rejects along with every other absent origin. For local testing serve them over http (`npx http-server -p 8123`); `http://localhost:*` and `http://127.0.0.1:*` are allowlisted.

There is no build step. Six checks exist, all of which print computed vs
expected rather than asserting: `node cron-gate.check.mjs` (the cron trading-day
gate, over weekends / NYSE holidays / both DST regimes), `node bs-delta.check.mjs`
(Black-Scholes delta), `node moves.check.mjs` (ten sections over the Long tab's
measured half: coverage against a brute-force reference, all eight payoff
structures at five prices each, the two expectancy guards, the independent-window
floor, and de-clustered episode concentration tested in **both** directions —
one move must report 1 *and* separated moves must report more, since a test that
only proves collapsing passes on code that always answers 1),
`node instr-bindings.check.mjs` (the binding counter:
shape detection across bindings/secrets/vars, automatic pickup of a second
binding, `this`-binding through the proxy, and the failure paths that must return
a working `env`), `node long-fixtures.check.mjs` (the three Long-screen paths
live data cannot reach: `buyableFrom()`'s `rank` branch, which stays unreachable
until 60 days of IV history exist; Lane A with **two** listed Januaries; and the
shared `ivPlausible()` guard at its boundaries), and `node nd2.check.mjs` (the Long tab's `P(BE)@exp`,
theta and vega — N(d2) against a reference series-erf **and** against
e^{rT}·(−∂C/∂K) by central difference, which is a structurally different
derivation and so catches "right arithmetic, wrong quantity"; greeks against
numerical differentiation). All three extract functions from `worker.js` by
source, not by import, because every named export in `worker.js` must be a
function or `workerd` refuses to boot.

## Architecture

### Worker (`worker.js`)

All data flows through the Worker. CORS is enforced via `ALLOWED_ORIGINS` allowlist.

**Endpoints:**
```
GET  /api/quote/:ticker           Yahoo quoteSummary (multi-module) + Alpaca price overlay
GET  /api/chart/:ticker           Yahoo v8 OHLCV (?range=1y&interval=1d)
GET  /api/options/:ticker         Yahoo v7 options chain
GET  /api/premium/batch?symbols=  Premium screen, KV only — no fetches; 1 KV read/symbol
GET  /api/premium/:ticker         One ticker (?refresh=1 rebuilds it, ~5 subrequests)
GET  /api/long/batch?symbols=     Long screen, KV only — no fetches; 1 KV read/symbol
GET  /api/long/:ticker            One ticker (4 measured warm / 7 cold)
GET  /api/insider/:ticker         SEC EDGAR Form 4, last 90 days (12h KV)
GET  /api/short/:ticker           FINRA consolidated short interest, 6 settlements (Yahoo fallback)
GET  /api/13f/:ticker             Super-investor 13F holdings, from a KV reverse index
GET  /api/iv/:ticker              ATM implied vol (front/back), term structure, IV rank, HV30, POP ladder
GET  /api/search?q=               Ticker autocomplete
GET  /api/news/:ticker            Alpaca news → Yahoo fallback
GET  /api/peers/:ticker           Yahoo recommendationsBySymbol
POST /api/ai/:type/:ticker        Structured AI task; prompt built server-side
POST /api/claude                  REMOVED — returns 410. Was an open LLM proxy.
POST /api/log-rec                 Append BUY/HOLD/SELL rating to KV
GET  /api/track/:ticker           Read rating history from KV
GET  /api/market/snapshot         Index + futures + commodities strip
GET  /api/market/movers           Pre-market / day gainers + losers (≥±10%)
GET  /api/market/ipos             Upcoming IPO calendar (12h KV cache)
GET  /api/watchlist/batch         Bulk fundamentals + RSI + SMA/EMA cross + Claude analysis
GET  /api/daily                   Daily Claude synthesis (served from KV)
GET  /api/market/sectors          Sector summaries + top opportunity/avoid per sector (4h KV cache)
GET  /api/market/scanner?preset=  Day-trading momentum scanner (5 Pillars, 90s KV cache)
GET  /api/market/golden-cross     Names set up for a golden cross, EMA + SMA gaps (1h KV cache)
GET  /api/market/econ-calendar    Next FOMC / CPI events from the official schedule
GET  /api/earnings/:ticker        Last report: numbers, price reaction, call coverage (12h KV)
```

**Earnings analysis (`/api/earnings/:ticker`):** powers the "Analyze Earnings" button under Catalysts
on `index.html`. Gathers EPS history, quarterly revenue, forward estimates and revisions, a price
reaction measured from daily bars, and news from the report window, then runs one Claude synthesis
cached 12h in KV. **Button-triggered only** — never wire it to page load (see the credit-burn note
under KV keys). `?refresh=1` forces regeneration; `?facts=1` returns the gathered data without
spending a Claude call, which is the cheap way to debug upstream data.

Details worth knowing:
- **Report date** comes from Yahoo's `calendarEvents.earnings.earningsCallDate` — `earningsDate` is
  normally the *next* scheduled report, not the last one. If neither carries a past date, the date is
  inferred from the largest post-quarter price gap and `dateSource` says so.
- **Which session traded the print** is resolved by testing the report date and the following
  session and keeping the larger move, since Yahoo does not reliably flag before-open vs after-close.
  A report that landed today sets `isPartial`, which suppresses the volume ratio (a partial bar is
  not comparable to completed sessions).
- **Call commentary has no transcript feed.** It is reconstructed from news in the report window and
  each item carries its source. Without `ALPACA_KEY`/`ALPACA_SECRET` the only source is Yahoo search,
  which returns ~20 recent items and cannot be queried by date — so commentary is available for a
  fresh report and simply absent for an older one. `newsStatus` (`ok` / `no-archive` / `none-found` /
  `no-report-date`) drives what the UI says, and the prompt is told to return an empty array rather
  than invent a quote. Setting the Alpaca secrets unlocks the archive for past quarters.
- Scorecard rows are sanitised server-side: a metric with no consensus figure is forced to `n/a`
  rather than trusting the model not to call it a beat.

**Implied vs historical volatility — do not let these merge again.** `index.html` used to compute
a 30-day close-to-close standard deviation into a variable named `iv` and feed it to rules written
for implied vol. That number is *historical* vol; it now travels as `hv30` and is labelled **HV30**
everywhere it appears. Implied vol comes off the options chain and nowhere else: `/api/iv/:ticker`
returns front/back ATM IV, `termStructure`, `hv30`, `ivHvRatio` and `ivRank`, all vol figures in
**percent** (Yahoo's `impliedVolatility` is a decimal fraction and is scaled by 100 at the source so
the ratio divides like with like). Front expiry is the nearest expiration ≥7 DTE; back is the next
standard monthly (third Friday) after it; ATM IV averages the call and put nearest spot.

HV30 rather than HV20 is the comparator because front-expiry ATM IV *is* a forward ~30-day estimate.

**`ivRank` is null until 60 days of history exist, and nothing stands in for it.** Nothing was
collecting IV history, so it is being built now: every `/api/iv` call and the 1:15pm PT cron
(`recordWatchlistIv()`) writes `iv:{TICKER}:{YYYY-MM-DD}` with a 400-day TTL. The reading is
duplicated into the key's **KV metadata** so `ivHistory()` rebuilds the series from one paged
`list()` instead of 400 `get()`s — metadata caps at 1024 bytes, so keep it to the three flat numbers
it holds today. Below `IV_RANK_MIN_DAYS` the endpoint returns `ivRank: null` plus a `rankReason`, and
the UI renders "collecting (N/252d)". Never substitute a percentile of HV: on screen a stand-in is
indistinguishable from the real thing, which is exactly the failure being corrected here.

**Option-strategy gates are relative, never absolute.** `renderStrategies()` previously keyed Iron
Condor on `iv > 50` and Long Straddle on `iv < 30` — absolute cutoffs are meaningless across tickers
(NVDA and AAPL have completely different baseline vol), and they were being fed HV besides. The gate
is now `volRegime()`: IV rank ≥70 for premium selling (condor, CSP, covered call, wheel), ≤30 for
long premium (straddle, debit spreads). Until the rank exists, `ivHvRatio` stands in at ≥1.2× / ≤0.9×
and the card is visibly labelled a proxy. With no vol reading at all the strategy list is
**suppressed**, not defaulted — every structure there is a bet on vol being rich or cheap.

`volRegime()` **lives in `worker.js`**, not in the page. It arrives on `/api/iv` as `regime` and on
`/api/premium` per row, with its thresholds as `gates` (`IVR_HIGH` 70 / `IVR_LOW` 30 /
`RATIO_HIGH` 1.2 / `RATIO_LOW` 0.9 / `IVR_SELL_MIN` 50). It used to be computed in `index.html`; the
premium screen on `dashboard.html` needs the identical gate, and two copies of a threshold across two
HTML files is exactly how they drift apart. `index.html` is now only a reader — do not reintroduce a
local copy.

**Black-Scholes delta (`bsDelta`) is computed in the Worker, because Yahoo's chain has no greeks.**
Everything downstream leans on it: which strikes `/api/premium` selects, and the POP on every
short-strike strategy card. `normCdf()` is Abramowitz & Stegun 26.2.17. `vol` and `rate` are
**decimals**, not the percent this codebase carries IV around in — Yahoo's `impliedVolatility` is
already a decimal and feeds straight in, but anything read off an `atmIv` field must be divided by 100.
No dividend yield and no American early exercise: both would be invented inputs, and for the OTM
strikes this screen selects the early-exercise difference is immaterial.

`node bs-delta.check.mjs` **prints computed vs expected** for every case rather than asserting — Hull's
published worked example (0.522), an independently implemented series-erf reference, put-call parity,
and the OTM ladder the screen actually selects from. Worst deviation 7.0e-8 against the 7.5e-8 the
approximation claims. Run it after any edit to that block; a silently wrong delta does not fail, it
just picks the wrong strikes and prints a confident probability beside them.

**The risk-free rate comes from FRED `DGS3MO`, and is suppressed rather than defaulted.** The FRED
integration only ever fetched release *dates*; `riskFreeRate()` adds a series-observations call
(`econ:dgs3mo`, refreshed 12h, kept 7d so an outage degrades to the last real print, flagged stale).
With no print at all the rate is `null` and **every delta is suppressed** — `r = 0` is not a neutral
default, it is worth about a full delta point at 30 DTE, enough to move which strike gets picked, and
invisible on screen. Holidays publish `"."` as the value, so the fetch scans the last 10 rows for a
numeric one.

**Real sources replaced the last mock generators.** Short interest, insider trades, dark pool and
13F were all documented as "mock". Two of the four were not: `mockShortInterest()` and
`mockUnusualOptions()` were dead code — never called — while their cards ran on live Yahoo data.
Dark pool was genuinely fabricated and had no free source, so it was **deleted outright** rather than
replaced. Nothing generates numbers any more.

- **`/api/insider/:ticker` — SEC EDGAR Form 4.** Replaces Yahoo's free-text `insiderTransactions`.
  Parses the real transaction code, so an open-market buy (`P`) is finally distinguishable from a
  grant (`A`) or an option exercise (`M`) — the old free-text matching conflated them. Flags cluster
  buying (≥3 *distinct* insiders buying within 30 days) and any `P` over $500k.
- **`/api/short/:ticker` — FINRA, Yahoo as fallback.** FINRA is the official biweekly settlement
  figure and the only source with the 6-period history the MoM chart needs; Yahoo carries a single
  unofficial snapshot. When FINRA is down the card renders Yahoo **labelled an estimate**, and the
  badge says Yahoo — it must never borrow FINRA's name.

  **Never send `sortFields` on `settlementDate`.** It is the dataset's *partition* field
  (`/metadata/group/otcMarket/name/consolidatedShortInterest` lists `partitionFields`), and sorting a
  partition field without a partition equality filter is a hard 400. This cost a deploy cycle to find.
  The query filters by `symbolCode` + a `dateRangeFilters` window and sorts in the Worker instead.
  The symbol field is **`symbolCode`** — `symbol` 400s with "fields are not available in this dataset".
  `Accept: application/json` is required on both the token and query calls.

  Failures log the full request (token redacted), FINRA's response body, and the `/metadata` field
  list; successes log row 0's keys. Keep all of that — a 400 with a swallowed body is unfixable
  guesswork, and the one cycle it took to fix this was entirely down to those two log lines.
- **`/api/13f/:ticker` — SEC EDGAR 13F-HR.** `SUPER_INVESTORS` holds 20 verified manager CIKs.

**SEC EDGAR requires a real contact email in the User-Agent** (`SEC_UA`) or it 403s everything.

**Verify every CIK against EDGAR before adding one.** The first draft of `SUPER_INVESTORS` was
written from memory and **7 of 18 entries were wrong** — several pointed at real but unrelated
managers (the "Third Point" CIK returned Two Sigma; "ARK" returned ValueAct). A wrong CIK does not
fail loudly; it silently attributes one manager's book to another. Check
`data.sec.gov/submissions/CIK{n}.json` and confirm both the `name` and that `13F-HR` appears.

**The 13F index is built a few managers at a time, and the old version silently truncated.**
`build13FIndex()` walked all 20 managers in one invocation: 1 fetch for the issuer-name table plus 3
SEC round trips each = **61, against the Free plan's 50-subrequest cap in force at
the time** (this account is now on Paid: 10,000, one pool — see rule #1). It did not fail. `fetch13F` is wrapped in a
per-manager `try/catch` that logs and continues, so the cap error was swallowed four times and the
function **returned normally with 16 of 20 managers** — and `refresh13FIndex` wrote that partial index
to KV as if complete. The four dropped managers were recorded as `{ ok: false }`, the same shape used
for a manager who genuinely filed nothing, and the card reported "16/20 managers filed" — blaming the
managers for our own budget overrun. Always the same last four, because the loop order is fixed.

`refresh13FSlice()` now does `THIRTEENF_BATCH` (4) managers per firing — 13 subrequests — keeping
per-manager holdings in `byManager` and **deriving** the ticker→managers index from it, so one manager
can be replaced without touching the others. `13f:cursor` tracks the position and `lastFullPass` is
stamped when it wraps. A transient failure keeps the previous good record rather than blanking a
manager that was already indexed. Requests only ever read `13f:index`.

The card now reports `managersRepresented` / `managersNotFetched` / `managersFailed` separately —
"still filling in" and "no readable 13F-HR" are different facts and neither is "did not file".

**Pabrai Investment Funds (CIK 0001173334) has no 13F-HR on file, and that is
correct.** A full pass lands on **19/20**, not 20/20. Mohnish Pabrai's US-listed
long positions sit below the $100M 13F reporting threshold, so there is nothing to
fetch. The CIK is verified and the parser is fine. **Do not "fix" this** — it will
look like a parse bug to anyone counting managers, and the last time a manager
count came up short the cause really was a bug, which makes the false alarm more
likely. `managersFailed: 1` with `reason: 'no 13F-HR filing found'` is the honest
answer.

A 13F reports one issuer across several rows (separate accounts, share classes, discretion
categories), so rows are **summed per manager** — otherwise Berkshire appears to hold Apple twelve
times.

CUSIP→ticker mapping is built opportunistically from issuer names and is **knowingly partial**
(~2 in 3 resolve). An unmapped ticker renders "no mapped holdings", never "no institutional
interest" — a much stronger claim the data does not support. SEC's ticker file carries no share-class
detail, so dual-class names (GOOGL/GOOG) collapse into one line; the card says so.

**Statistical-release dates come from FRED, not a hand-maintained table.** The `CPI_RELEASES` table
is gone. `FRED_RELEASES` names five releases (CPI, PCE, Employment Situation, PPI, retail sales) and
their **IDs are resolved by name from `/fred/releases`** rather than hardcoded — an ID recalled from
memory is the same unverifiable constant that produced the wrong CIKs. FOMC stays hardcoded because
the Fed calendar is not a FRED release. If FRED fails the calendar degrades to FOMC-only and reports
`dataReleases.ok: false` with a reason; it never invents a date.

**Provenance badges are derived, never authored.** Every card badge is rendered by `setBadge()` from
the `_meta` a fetch returned (`srcMeta()` server-side). Hand-written badges had already drifted from
the fetch layer in both directions: one card credited **FINRA without ever calling it**, another read
"Sample · upgrade" while running on live data. A literal in the markup has nothing tying it to the
code that fetches, so it drifts silently. A card that never called a source now cannot name it.

**Every response carries `_meta`, and every badge carries an as-of time.** `srcMeta()` also returns
`ttlSeconds` (from the `TTL` table near the top of `worker.js`, so a card and the handler feeding it
cannot disagree). Badges render `source · 15-min delayed · as of HH:MM` and turn amber `.stale` once
`Date.now() - fetchedAt` passes `ttlSeconds`. **`delayed` and `stale` are different failures and a
badge can be both**: `delayed` is a property of the *source* (Yahoo is 15 minutes behind however
recently we asked), staleness is a property of *our copy*. Alpaca-sourced payloads say "real-time".
`sweepStaleBadges()` re-ages every badge on a 30-second timer — staleness computed only at page load
would announce itself at the one moment it is least likely to be true.

Note the `TTL` object is a **global**; four handlers used to declare a local `const TTL` that shadowed
it (now `CRUMB_TTL` / `SCAN_TTL` / `GOLDEN_TTL` / `IPO_TTL`). If you add another, do not call it `TTL`
— the shadow is silent and turns `TTL.scanner` into `undefined`.

**Stale-while-revalidate: no tab waits on a click.** Sectors and Scanner accept `?cached=1`, which
returns the banked KV snapshot at **any** age and never rebuilds; Premium and Long have no such split
because their list views *are* KV reads. `primeTabs()` paints all four on page load, then revalidates
Sectors and Scanner through the normal endpoint (which still serves from KV inside its TTL). A failed
revalidation leaves the painted snapshot alone rather than blanking a view the user is reading, and a
loading wall is only drawn when there is nothing on screen yet. The manual Refresh buttons pass
`?refresh=1` and still force a rebuild.

**What `primeTabs()` actually costs, measured (`_instr`, 22-ticker watchlist, 2026-08-08).** It used
to be described as costing "about what clicking one tab used to", which was a comparison rather than a
number. One full dashboard page load fires **12 requests — 10 GET plus 2 CORS preflights — and totals
capCost ≈ 133–140** across all of them:

| request | capCost |
|---|---|
| `/market/sectors` (revalidate, cold cache) | **~47** |
| `/premium/batch` (22 symbols) | 22 |
| `/long/batch` (22 symbols) | 22 |
| `/market/snapshot` | 12 |
| `/market/movers` | 8 |
| `/daily` | 4 |
| `/market/ipos`, `/market/sectors?cached=1`, `/market/scanner` ×2 | 2 each |
| CORS preflight ×2 | 0 (returns before any binding call) |

Three things follow, and only the third is a change:

1. **The cap is unaffected and this is not close.** The 10,000 meters **per invocation**, and each of
   these is its own invocation. The largest single one is the cold sectors rebuild at ~47, then the
   batch reads at 22 — roughly 0.5% and 0.2% of the ceiling. Adding Long to `primeTabs()` did not
   change the per-invocation figure at all; it added one more 22-cost invocation alongside Premium's.
2. **The batch reads are not the expensive part.** They are ~32% of the page load between them, and
   one cold sectors revalidation costs more than both together. If page-load cost ever needs reducing,
   that is the line to look at, not the batch reads.
3. **Stop saying these reads are free.** "Zero outbound calls" is true of *fetches* and false of
   *subrequests*: one KV read per symbol, so 44 for the two batch tabs on every page load. Both
   endpoints now report `_instr` so the figure is readable rather than asserted.

Caveat on the ~47: measured against a **cold** local sectors cache with no `ANTHROPIC_API_KEY`, so it
attempted a rebuild and 500ed. In production inside the 4h TTL that call is a KV read (~2), which puts
a steady-state page load nearer **~90**. The number that was actually measured is stated; the
production figure is an inference and is labelled as one.

**Model confidence renders as an ordinal, never a percentage.** `confLabel()` maps to Low / Moderate
/ High in all three places it surfaced (synthesis hero + ring, watchlist recommendation, options-recap
strategies). A self-reported "78%" has nothing measured behind it yet reads as a probability. The
numeric value is still logged — the Brier score in the rec history is scored against realized forward
returns, so that one is a measurement and stays numeric. The confidence ring is three discrete steps
so the arc cannot be read back as a percentage.

**Economic calendar (`FOMC_MEETINGS`):** the single source of truth for macro
event dates, hand-maintained near the top of `worker.js` from
[federalreserve.gov](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm); the CPI/PPI/PCE/jobs/retail dates now come from FRED. **Never let Claude date an FOMC
meeting or CPI print from memory** — it answers from its training cutoff and silently ships a wrong
date. Every prompt that can mention macro timing (morning briefing, midday pulse, EOD, week ahead)
is fed `econPromptLines()` and told to use only those dates; `index.html` pulls the same table via
`/api/market/econ-calendar`. FOMC minutes are derived as decision day + 21 days per Fed practice.
Refresh the tables when `ECON_CALENDAR_THROUGH` gets close — the endpoint reports `stale: true`
once the runway runs short.

**Moving averages:** the watchlist's `vs 50D` / `vs 200D` / `50D vs 200D` columns use Yahoo's
`summaryDetail.fiftyDayAverage` / `twoHundredDayAverage` — simple moving averages of daily closes
through the *prior* close. The watchlist's `SMA X` column uses **simple** MAs too, but computed in
the Worker by `smaCrossState()` over spark closes — so its `crossFast` runs a touch ahead of
Yahoo's `sma50`, which stops at the prior close. The golden-cross scanner's row selection is the
one place still on **exponential** MAs (`emaCrossState()`).

**Watchlist `Recommendation` column:** one consolidated call per ticker, replacing the old
Trend / Pattern / Action / Rating quartet. `refreshTickerAnalysis()` writes
`{rating, confidence, recommendation, drivers[], summary}` to `analysis:{TICKER}` under
`ANALYSIS_SCHEMA`; `recCell()` renders badge + one-line call + driver chips, with the full rationale
in the expanded row. Four columns invited the model to answer each in isolation — a single call
forces it to weigh factors against each other and commit, which is the judgement the row is for.
Confidence measures how strongly the evidence agrees, so genuine conflict lowers it rather than
producing a hedged call. Sorts on `recRank` (signed conviction: strongest BUY → strongest SELL).

The prompt is fed technicals, multi-period momentum, price action, fundamentals, and
positioning/sentiment, plus the **macro and geopolitical backdrop** — which comes from the morning
briefing's `daily:snapshot` headline and news cards, and event dates from `econEventsAhead()`. Never
from model memory: the prompt says so explicitly, for the same reason the economic-calendar tables
exist. If `daily:snapshot` is missing the prompt says so and tells the model to weight
company-specific evidence instead of inventing world events.

**Watchlist `Key Level` column:** distance to the nearer of support/resistance — never both, per the
column's whole purpose. The worker computes `levelPct` / `levelKind` / `levelAbove` / `levelPrice`
(so it is sortable server-side) and `levelCell()` renders it. The arrow is literal position (▲ above
the level, ▼ below); colour is what that position *means*, which is deliberately not the same thing —
below resistance is ordinary headroom and reads amber, not red, while below support is a break and
reads red.

**Watchlist `SMA X` column:** one column covers both formations — there is no separate Death column.
`crossCell()` names the cross in effect from the sign of `crossSpread` (`Golden` / `Death`) and
prints the gap, e.g. `● Golden 11.3% ▲`. The arrow is `crossSpreadChg`, the signed move in the
spread over `EMA_CROSS_SLOPE_BARS`: ▲ the 50D is pulling up on the 200D, ▼ pulling down. It is
coloured by direction rather than by formation, so a decaying golden cross reads
green-with-a-red-arrow. Note the gap is `|spread|`, so it *widens* on ▲ under a golden cross but on
▼ under a death cross — the tooltip resolves that for you. Leading glyph: ● in formation · ◆ setup
(within 5% and trending into a flip, amber) · ○ within 5% but not trending that way. The column
sorts on `crossSpread`, which orders strongest golden → strongest death in one pass.

The row fields are named `cross*` (`crossFast`, `crossSlow`, `crossSpread`, `crossGap`,
`crossSlope`, `crossSpreadChg`, `crossBarsToCross`) rather than after an MA type, for two reasons:
`sma50` / `sma200` on the same row are already Yahoo's figures and must not be clobbered, and the
column's MA type has changed once already. Swapping it back to EMA is a one-line change in the merge
block of `handleWatchlistBatch()` — no field renames, no frontend edit.

**MA cross (`crossStateFrom` / `emaCrossState` / `smaCrossState`):** one geometry routine over a
fast/slow MA pair — spread, absolute gap, fast-MA slope, projected sessions to the cross, and the
setup flags. `emaCrossState()` feeds it `emaSeries()`, `smaCrossState()` feeds it `smaSeries()`;
both return the same shape apart from the MA values (`ema50`/`ema200` vs `sma50`/`sma200`).
A *setup* means the fast MA is within `EMA_CROSS_NEAR_PCT` (5%) of the slow MA **and** trending
into the cross; `EMA_CROSS_SLOPE_BARS` (5) sessions define the slope.

History requirements differ, and that is the point of the split. EMAs are seeded with an SMA of the
first `period` closes and smoothed forward, so EMA200 needs a long runway before the seed washes
out — callers pass ~3y of daily closes (~750 bars), leaving the seed ~0.4% weight and EMA200 within
~0.01% of converged; under 450 bars `emaCrossState()` returns `null` rather than an unreliable
value. A rolling mean has no seed, so `smaCrossState()` is exact from `slow + EMA_CROSS_SLOPE_BARS`
(205) bars and resolves on histories where the EMA version does not.

**Golden-cross rows carry both gaps.** `/api/market/golden-cross` selects rows on the EMA setup and
then attaches the SMA pair (`sma50`, `sma200`, `smaGap`, `smaSpread`, `smaSlope`, `smaBarsToCross`)
purely as reference — the SMA figures never filter. The two disagree by design: the SMA pair lags,
so on the tightest EMA setups `smaSpread` is often already **positive** (the simple-MA cross has
happened) while on wider ones `smaGap` sits outside the 5% band. `renderGoldenCross()` renders those
as a "crossed" chip and a dimmed bar respectively. Payloads carry `schema`; bump it in
`handleGoldenCross()` when the row shape changes so cached entries retire instead of rendering as
blanks, and use `?refresh=1` to force a rebuild.

**Multi-symbol closes (`yahooSparkCloses`):** Yahoo v7 `spark` returns close-only series for up to
**20 symbols per request** and needs no crumb, so a 250-name EMA sweep costs ~13 subrequests
instead of 250. Results key off `item.symbol` — the response order does not match the request
order, and unknown/delisted symbols are silently absent.

**Yahoo crumb auth:** Yahoo v10 requires a session crumb. `getYahooCrumb()` tries two strategies (direct user-agent endpoint, then HTML stream scan), caches in memory + KV (`yahoo:crumb`, 50-min TTL), and deduplicates concurrent fetches via `_crumbInflight` promise. On 401/403 it invalidates and retries once.

**Alpaca integration:** Optional — if `ALPACA_KEY`/`ALPACA_SECRET` are set, Alpaca overlays real-time prices on quote results and provides the news feed. Yahoo is always the fallback.

**Claude model:** Locked to `const CLAUDE_MODEL = 'claude-opus-5'` at the top of `worker.js`, alongside
`CLAUDE_EFFORT` and `CLAUDE_THINKING_HEADROOM`. Change them there when upgrading models.

**Opus 5 thinks by default, and that has two consequences the code has to respect:**

- **Never read `content[0].text`.** When the model thinks, slot 0 is a `thinking` block whose text is
  empty by default, so `content[0].text` is `undefined` and the caller silently gets `''`. Use
  `claudeText(data)`, which filters for `type === 'text'` and joins. This fails *intermittently* —
  trivial prompts skip thinking and parse fine, so a naive parse looks healthy right up until a real
  analytical prompt returns nothing. `index.html` already iterates blocks correctly.
- **`max_tokens` caps thinking + answer together.** Every per-call budget (`workerClaude(prompt, env, N)`,
  `body.max_tokens` on `/api/claude`) is sized for the *answer*; `CLAUDE_THINKING_HEADROOM` is added on
  top at each of the three call sites. Raising the cap is free — it bounds spend, it doesn't cause it.

**Ask for JSON with a schema, not with a prompt.** `POST /api/claude` forwards a caller-supplied
`output_config` (merged with, not replaced by, the effort setting), so the frontend can pass
`{format: {type: 'json_schema', schema}}`. `index.html`'s AI synthesis does this via
`SYNTHESIS_SCHEMA`. This is not a style preference — "Return STRICT JSON" in the prompt plus
`JSON.parse` is a coin flip once narrative fields get long, because one unescaped quote inside the
prose terminates the string early and the parse dies mid-object with an opaque character offset.
Opus 5 writes longer, more quote-prone prose than Sonnet 4.6 did, which is what turned a latent bug
into a reliable one. A schema makes malformed JSON ungenerable, and removes the need to strip
```` ``` ```` fences. The API's schema subset rejects `minimum`/`maximum`/`minLength` — keep ranges
like "score 0-100" as prompt guidance. Truncation is still possible independently of the schema, so
check `stop_reason === 'max_tokens'` and say so rather than surfacing a JSON offset.

`CLAUDE_EFFORT` (`medium`) is the cost/latency dial. **Latency roughly tripled vs Sonnet 4.6** — a
briefing-sized generation (~3500 answer tokens) measures 45–50s, against a 30s cron budget. Wall-clock
time spent awaiting a subrequest is not CPU time, which is why the chained cron jobs still complete, but
this is the thing to check first if a scheduled run starts coming up empty: drop `CLAUDE_EFFORT` to
`'low'` before reaching for anything else. Do **not** set `thinking` to `disabled` to claw back latency —
on Opus 5 that can leak `<thinking>` tags into the visible text, and much of what comes back here is
parsed as JSON. Note Opus 5 bills $5/$25 per MTok vs Sonnet 4.6's $3/$15, and thinking tokens bill as
output.

**KV namespace (`REC_LOG`) keys.** TTLs below are the `expirationTtl` actually
passed at the `put()` site — not intentions. Where a key's *freshness* window
differs from its retention, both are given and the reason is in the notes.

| Key | TTL | What it holds |
|---|---|---|
| `yahoo:crumb` | 1h | Yahoo session crumb. In-memory `CRUMB_TTL` treats it as good for 50 min; KV keeps it an hour. |
| `daily:snapshot` | 2d | 6:00am PT Claude morning briefing |
| `daily:midday` | 2d | 11:30am PT midday pulse (narrative, topics, tomorrow, trades, bigMovers) |
| `daily:eod` | 2d | 1:15pm PT end-of-day summary |
| `market:week-ahead` | 18h | Friday-only week-ahead preview |
| `analysis:{TICKER}` | 2d | Per-ticker Claude recommendation for the watchlist column |
| `iv:{TICKER}:{DATE}` | **400d** | One daily front-expiry ATM IV sample — the series `ivRank` is built from. `atmIv`/`spot`/`dte` are duplicated into **KV metadata** so `ivHistory()` rebuilds the series from one paged `list()` instead of 400 `get()`s. Metadata caps at 1024 bytes; keep it to those three flat numbers. |
| `ivsweep:last` | 2d | PT date of the last cron IV sweep, for dedup. **Deliberately outside the `iv:` prefix** so `ivHistory()`'s prefix scan cannot pick it up as a sample. |
| `calib:pooled` | **none** | Pooled recommendation calibration across every `rec:` key — the basis used when a ticker has fewer than `REC_CALIB_MIN_N` resolved outcomes of its own. Written once a trading day by `fillForwardReturns()`; **no TTL on purpose**, since a stale pooled figure beats none and `d`/`ts` ride along so the reader can age it. |
| `moves:{TICKER}` | **7d** | The historical N-session return distribution behind the Long tab's measured `cov` column, its `gap`, and the expectancy ranking. Banked by the 2:00pm PT sweep. **~60 KB/ticker measured** (largest QUBT 61,496 bytes, 2026-08-09); KV's ceiling is 25 MB. Stores sorted **`[return, startIdx]` pairs**, not bare numbers — see below. |
| `movesweep:last` | 2d | PT date of the last move-series sweep, for dedup. **Outside the `moves:` prefix** so nothing scanning that prefix can read it as a ticker — the same rule as `ivsweep:last`. |
| `premium:{TICKER}` | **24h retention / 4h freshness** | One premium-screen row. The two differ on purpose — see below. |
| `long:{TICKER}` | **24h retention / 4h freshness** (`LONG_FRESH_MS`) | One long-screen row: four lanes, both timestamps, the buy gate and the directional read. Same freshness/retention split as `premium:` and for the same reason — past 4h the row still renders, badged stale. |
| `cik:map` | 30d | SEC ticker→CIK map from `company_tickers.json` |
| `insider:{TICKER}` | 12h | Parsed SEC Form 4 report |
| `short:{TICKER}` | 6h, or **15min** on the Yahoo fallback | FINRA short interest. The short TTL on the fallback is deliberate: a labelled estimate should be retried soon, not cached like the official figure. |
| `finra:token` | expiry-bound (`expires_in − 60s`, min 120s) | FINRA OAuth2 bearer token |
| `13f:index` | 100d | ticker→managers reverse index plus `byManager` per-manager holdings |
| `13f:cursor` | 100d | Which manager the incremental 13F pass is up to. **Outside the `13f:index` key** so advancing the cursor never rewrites the index. |
| `econ:fred` | 12h, or **15min** on failure | FRED release dates |
| `econ:dgs3mo` | **90d retention / 12h freshness** | FRED 3-month T-bill — the risk-free rate for Black-Scholes. Retention was 7d and is now 90d: FRED is the one upstream that can blank two entire screens, and a week-old bill is not a difference anyone trades on. See below. |
| `earnings:{TICKER}` | 2d | Earnings analysis for the last report |
| `fund:{TICKER}` | 6h | Yahoo fundamentals cache |
| `market:ipos` | 12h | IPO calendar |
| `market:sectors` | 4h | Sector summaries + opportunity/avoid picks |
| `market:goldencross` | 2h | Golden-cross setups (served fresh for 1h via `GOLDEN_TTL`) |
| `scanner:{preset}` | 5min | Day-trading scanner results (served fresh for 90s via `SCAN_TTL`) |
| `auction:{DATE}:{SYMBOLS}` | 20h | Closing-auction block trades, keyed by ET date |
| `watchlist:tickers` | none | Saved watchlist, pushed by the dashboard; also seeds scan universes |
| `rec:{TICKER}` | none | Recommendation history, one entry per PT trading day (up to 500) |
| `recfwd:last` | 2d | PT date of the last forward-return fill. **Outside the `rec:` prefix** so the fill sweep's own `list()` cannot see it. |
| `admin:token` | none | Bearer token gating the `/api/admin/*` routes |

**`premium:{TICKER}` — 4h freshness, 24h retention, and they must not be equal.**
A literal 4h KV TTL would evict the row at the exact moment it becomes stale,
leaving nothing to render *as* stale. A 5-hour-old chain badged "stale" is more
useful than a blank row, so `PREMIUM_FRESH_MS` (4h) drives the badge and
revalidation while `PREMIUM_ROW_TTL` (24h) keeps the row alive to be badged.

**`calib:pooled` — why the scan lives in the cron and must never move.**
Requiring `REC_CALIB_MIN_N` (10) *resolved* outcomes **per ticker** splits the
evidence across every ticker ever browsed. Measured 2026-08-10: **62 tickers, 289
resolved entries, and only 7 clear the floor on their own** — so `affectsSort` was
false on 55 of 62 and the alignment tag reordered nothing almost everywhere. Pooled,
the same 289 entries clear it immediately.

A pooled scan is `list('rec:')` + one `get` per key = **64 binding ops measured**,
and the key count grows with every ticker ever opened. `directionalRead()` runs on
every `/api/long/:ticker`, whose entire binding budget is 9 — so that scan on the
request path would be a ~8× increase. **A TTL cache does not fix this**: a cache
still pays the full scan on each miss, and the miss lands on whatever user request
happens to be first.

`fillForwardReturns()` (2:00pm PT) **already performs exactly this scan** to fill
forward returns. The pooled figures are therefore computed there from lists already
in hand — **zero additional list or get ops** — and the request path pays one KV
read. Accumulate into `listsByTicker` *before* the `continue`s in that walk, or
every ticker with nothing pending (most of them, most days) drops out of the pool.

**`moves:{TICKER}` — schema 2, and the schema check must stay strict equality.**
The stored return arrays are `[return, startIdx]` **pairs**. Schema 1 stored bare
numbers, and a reader that coerced one shape into the other would produce coverage
figures that look entirely normal and are wrong — the worst available outcome.
`readMoveSeries()` guards with `m.schema === MOVES_SCHEMA`: **any** other value
reads as *absent*, `attachCoverage()` returns its stated reason, and the next 2pm
sweep recomputes the key from scratch. Never relax that to `<` or `>=`, and never
bump the schema without changing the shape in the same commit — stamping a new
version onto old-shaped data is the same bug inverted.

The start index is **load-bearing, not bookkeeping**: overlapping windows mean one
market move appears in up to N consecutive windows, and without knowing which
windows are neighbours any concentration measure counts a single episode many
times. See the episode note in the Long-screen section.

**`econ:dgs3mo` — 12h freshness, 90d retention, and the gap is the whole point.**
The FRED integration originally resolved *release dates* only; `fetchFredReleaseDates()`
never fetched a series observation, so there was no cached rate to read and this
was added later. `riskFreeRate()` calls `/fred/series/observations?series_id=DGS3MO`.

**FRED is the single upstream that can blank two entire screens.** No rate means
no Black-Scholes delta; no delta means the premium screen has no candidate strikes
and the long screen has no lanes at all. Retention was **7 days**, which meant a
FRED outage lasting longer than a week evicted the key and took both screens down
completely. It is now **90 days**: past 12h the value refetches, and if FRED is
unreachable the **last stored print is returned flagged `stale: true` with
`ageDays`**, which the card renders as *"FRED DGS3MO · 9d old"* in amber. The
3-month bill is the slowest-moving input on either screen — a week-old print moves
a delta in the third decimal, and that is categorically smaller than the difference
between a stale rate and no screen.

Suppression is still correct for the one case it describes: **never having had a
rate at all.** Then it is `null`, every delta is suppressed, the card reads
*"— · unavailable"*, and nothing is defaulted to `r = 0` — worth about a full delta
point at 30 DTE and enough to change which strike gets picked. DGS3MO publishes
`"."` on market holidays, so the fetch scans the **last 10 observations** for a
numeric one instead of taking row 0.

**Do not declare a local `const TTL`.** `TTL` is a module-level table (`TTL.quote`,
`TTL.scanner`, …) feeding `srcMeta({ ttlSeconds })`. Four handlers each declared
their own `const TTL = <number>`, which shadowed it silently and turned
`TTL.scanner` into `undefined` — no error, just a missing staleness threshold on
the badge. They are now **`CRUMB_TTL`, `SCAN_TTL`, `GOLDEN_TTL`, `IPO_TTL`**. Any
new local cache window needs its own name.

**Cron trigger:** a single `*/15 13-22 * * *` UTC cron — every day, because the expression is a coarse wakeup and carries no calendar logic (rule #2). `scheduled()` first gates on the Pacific trading day (weekends and `NYSE_HOLIDAYS` are skipped, with the decision logged either way), then dispatches by Pacific wall-clock time to the morning briefing (6am PT), midday pulse (11:30am PT), EOD summary + IV sample sweep (1:15pm PT), the **`forward-returns+moves`** branch (2pm PT — the forward-return fill *and* the move-series sweep), and a 13F slice (10am PT). The premium screen is deliberately **not** here — it loads on demand.

**`collectMoveSeries` runs at 2:00pm PT, not on the 1:15pm EOD branch, and the
reason is bar settlement rather than load balance.** The NYSE closes at 1:00pm PT,
so at 1:15pm the day's daily bar may still be forming. Banking a forming bar into
the series every coverage figure is measured against would never surface as an
error — it would quietly shift the most recent window. By 2:00pm the bar is
settled. (`fillForwardReturns` guards the same hazard from the other side with
`bars[idx].iso < today`.) Both jobs share that invocation's subrequest budget:
`ctx.waitUntil` does not get its own. **Measured cost of the sweep: `extFetches` 2,
`bindingOps` 47, `capCost` 49** for a 22-name watchlist — one `yahooSparkCloses`
call at 20 symbols per request, then one KV read and one write per symbol.

**Check the UTC hour in both DST regimes before scheduling anything.** The 13F job used to run at 3pm PT, which is 22:00 UTC under PDT but **23:00 under PST** — outside this window — so it silently never ran for the winter half of the year. It moved to 10am PT (17:00/18:00 UTC), inside the window in both. Every other job was already safe; this one was not.

**Anything added here shares the invocation's subrequest budget with whatever else that firing runs.** `ctx.waitUntil` does not get its own. Each job uses a KV timestamp check with a 2-hour dedup window to avoid double-runs; the two jobs added later (`recordWatchlistIv`, `fillForwardReturns`) use a PT-date key instead, since they should run once a day rather than once per window.

**The dispatch helpers, and the one time basis.** `ptParts(pt)` returns
`{ iso, dow }` read off the *same* `Date` object `scheduled()` already builds from
`event.scheduledTime` — do not add a second derivation (`ptDate()`, a fresh
`Intl` call, `etToday()`) inside the dispatcher, because two ways of computing
"today in Pacific" is how they drift. `tradingDayStatus(iso, dow)` returns
`{ open, reason, calendarStale }` with `reason` one of `weekend` /
`nyse-holiday` / `weekday`. Both are covered by `node cron-gate.check.mjs`.

**`generateDailySnapshot()` deletes `daily:eod` and `daily:midday` only after the
new snapshot is successfully written.** It used to delete them at the top, before
it knew whether the briefing would generate at all — so a Claude failure, a Yahoo
outage or any exception below left the page with no morning briefing *and* no
close recap. A stale-but-labelled recap beats a blank card. This is a distinct
bug from the cron day-of-week one; fixing the cron would have hidden it rather
than fixed it, because on a correct schedule the delete is followed within
seconds by a successful write.

**Every named export in `worker.js` must be a function.** `workerd` validates the
module's exports at startup and refuses to boot on anything else. Exporting
`NYSE_HOLIDAYS` (a `Set`) and `NYSE_HOLIDAYS_THROUGH` (a string) so the check
script could import them produced:

```
service core:user:stock-research-worker: Uncaught TypeError: Incorrect type for
map entry 'NYSE_HOLIDAYS_THROUGH': the provided value is not of type 'function
or ExportedHandler'.
The Workers runtime failed to start.
```

The runtime never came up — a total outage, caught only because `wrangler dev`
was run before deploying. Constants are therefore handed to the test through
accessor **functions** (`cronGateCalendar()`, `instrPeek()`). `workerd` only ever
dispatches through the default export; the named ones exist purely for testing.

**Recommendation log: one entry per ticker per trading day.** `synthesize()` fires on every page
load, and `handleLogRec()` used to append unconditionally — so a ticker opened a dozen times in a
day produced a dozen near-identical rows. That is not a cosmetic problem: it weights whichever name
got refreshed most and makes hit rate and Brier score describe browsing habits rather than
forecasting skill. `handleLogRec()` now compares the newest entry's US/Pacific trading date
(`ptDate()`) against today's and **overwrites** rather than appends on a match. Forward fields reset
to null on overwrite because the replacement carries a new entry price.

Each entry carries `fwd5` / `fwd20` — **percent return vs the entry price**, not the close — plus
`fwd5Close` / `fwd20Close` holding the raw realising close so the number can be audited later. The
returns are what `fwd20 > 0` as a hit test and "mean forward return" both need. `fillForwardReturns()`
(2pm PT cron) walks every `rec:` key, fetches 2y of daily bars **once per ticker**, anchors each
entry on the last session at or before its trading date, and reads the close `N` sessions on. It
only writes completed sessions (`bars[idx].iso < etToday()`), skips entries with no entry price, and
a ticker whose chart fetch fails is skipped without stopping the sweep.

`GET /api/track/:ticker` returns `calibration` alongside `entries`: `n` (entries with a resolved
`fwd20`), per-rating hit rate and mean fwd5/fwd20, and a Brier score. **HOLD is excluded from hit
rate and from Brier** — it makes no directional claim, so no outcome counts as right. Below
`REC_CALIB_MIN_N` (10) every figure comes back null with a `reason` string and the card renders that
reason: a hit rate over four entries is noise wearing a percentage sign, and on screen it would look
exactly like a real one.

### Frontends

`dashboard.html` — macro landing view with **seven tabs**. Every tab is deep-linkable
by hash (`dashboard.html#premium`), and `switchTab()` only lazy-loads a tab whose
data is still empty — `primeTabs()` has usually painted it already.

| Tab | `#hash` | What it is |
|---|---|---|
| **Market** | `#market` | Default. Index/futures/commodities strip, the 6am Claude briefing headline, EOD card, Friday week-ahead, news cards, pre/post-market movers (≥ ±10%), IPO calendar, watchlist signals. |
| **Midday** | `#midday` | The 11:30am PT midday pulse — session narrative, topics, next-day events, short-term trade ideas, big movers. |
| **Scanner** | `#scanner` | Four presets. Three (Momentum / HOD, Pre-Market Gappers, All Movers) hit `/api/market/scanner` and share `renderScanner()`; **Golden Cross Setup** hits `/api/market/golden-cross` and uses `renderGoldenCross()`. `loadScanner()` branches on the preset for endpoint, renderer, header copy and legend. |
| **Watchlist** | `#watchlist` | The 14-column table, sortable, with expandable rows and the consolidated Recommendation column. |
| **Sectors** | `#sectors` | All 11 SPDR sectors, ETF % change plus a Claude-picked opportunity and avoid per sector. |
| **Premium** | `#premium` | The short-premium screen. **Renamed from "Options"** — the old tab was a V/OI unusual-activity recap on the nearest expiration and was deleted outright, along with `handleOptionsRecap()` and its Claude flow synthesis. |
| **Long** | `#long` | The long-premium screen — the mirror of Premium. Four lanes (LEAPS / swing / debit verticals / calendars), gated on vol being *cheap* and the debit being structurally payable. See the Long-screen section below for everything that inverts. |

Note the Premium tab is the only one that fetches on interaction rather than on
load: expanding a row is what spends the subrequests. Sectors and Scanner use
stale-while-revalidate (`?cached=1` paints the KV snapshot, then the normal
endpoint revalidates behind it), so **no tab requires a click to show data**.

The `index.html` "Options Volume · V/OI Screen" card is a *different thing* and
still exists — real Yahoo chain volume and open interest, on the per-ticker page.

**The Premium tab (`#tab-premium`) replaced the Options flow recap.** The old view showed the nearest
expiration filtered to volume/OI ≥ 2×, which answers "what traded today" — and at the nearest
expiration the answer is mostly 0DTE and expiry-week churn, the wrong question for selling 20–45 DTE
premium against earnings dates. `handleOptionsRecap()` and its Claude flow synthesis are **deleted**.
The separate "Options Volume · V/OI Screen" card on `index.html` is untouched: that one is real Yahoo
chain data and was never part of this.

`/api/premium` returns one row per watchlist ticker:

- front/back ATM IV and `termStructure`.

  **`termStructure = front − back`. POSITIVE means front IV is RICHER than back —
  that is backwardation, and it is the earnings-crush setup.** This is the single
  easiest thing in the codebase to get backwards, and the original spec for this
  feature had it inverted (it asked to flag *negative* values as backwardation).
  Both `/api/iv` and `/api/premium/:ticker` compute it the same way so the two
  endpoints cannot disagree, `backwardation` is `termStructure > 0`, and the chip
  (`◤`) and the legend both state the sign on screen. If you find yourself
  "fixing" the sign, re-read this first.
- `expectedMove` = spot × ATM IV × √(dte/365) through front expiry, in dollars and percent.
- next earnings from `calendarEvents.earnings.earningsDate[0]` — deliberately the **same field the
  watchlist's Earnings column reads**, because two tabs quoting different earnings dates for one
  ticker is a bug the user finds before we do. Past dates are discarded, not shown as upcoming.
- two candidate expiries: `clean` (first monthly ≥ 21 DTE with no earnings inside) and `post` (first
  monthly expiring after the print). They collapse to one `clean+post` leg when earnings already sits
  before the first monthly ≥ 21 DTE. **A missing clean leg is a finding, not a gap** — when the print
  lands inside 21 DTE, every monthly from here spans it, and `cleanMissing` says so rather than
  leaving an absent row that reads as missing data.
- per candidate: nearest 0.30- and 0.16-delta put and call, **OTM only** (a short strike is OTM by
  definition, and without that filter a sparse chain hands back an ITM strike whose |delta| happens to
  sit nearer the target). Delta uses each strike's **own** implied vol, so put skew is respected.
  Credit is the **bid**, not the mid — what a seller can actually hit. `roc = credit / (strike × 100 −
  credit)`, `aroc = roc × 365/dte`. On the call side that denominator is the naked-margin equivalent,
  not the cost of shares in a covered call; the legend says so, because the same number under two
  capital bases would not be comparable.

**The screen loads on demand, one ticker per request.** Cloudflare caps subrequests **per
invocation**. One ticker costs a *measured* ~4.8 outbound fetches (1 expiry list + 1 quoteSummary
for earnings + ~2.8 dated expiry chains); a 22-name watchlist is ~110. That did not fit under the
old Workers Free cap of 50 and comfortably fits the current 10,000 (rule #1) — **the on-demand
design is retained on purpose and is not to be changed without a decision**: the screen is used one
or two names at a time, and **the Yahoo crumb rate-limits long before the subrequest budget does,
which is why the higher cap changes nothing here**. **Chunking inside a handler does nothing for
this** — the cap is per invocation, not per chunk. Re-measure with a counting `fetch` wrapper before
changing anything here; do not estimate it.

There was briefly a KV queue drained across cron firings to work around that. It is gone. The screen
is used one or two names at a time when deciding what to sell, so fetching all 22 daily was solving a
problem nobody had at the cost of a queue, a cursor, a seed step and a share of every cron firing.

- `GET /api/premium/batch?symbols=` is a **cache-status read, not a data fetch**: no outbound fetches,
  so the tab paints every watchlist ticker on load without touching Yahoo. It is **not free** — one KV
  read per symbol, measured `capCost 22` for a 22-name watchlist, and KV counts against the same pool.
  Cheap, not free. Tickers with nothing cached come back in `missing[]` as `not-loaded`.
- `GET /api/premium/:ticker` is the only path that spends subrequests, and spends ~5. Bare = serve
  cache if inside `PREMIUM_FRESH_MS`, else refetch. `?refresh=1` always refetches (the ↻ control).
  `?cached=1` never fetches.
- **Freshness (4h) and KV retention (24h) are deliberately different.** If KV evicted at exactly the
  freshness horizon there would be nothing left to render as stale — and "stale" is the honest state
  for a 5-hour-old chain, more useful than a blank row. Past 4h the cached row still shows, badged
  stale, and revalidates behind itself.
- **Load all is strictly sequential**, one awaited request at a time, with a progress line and a Stop
  control. Firing 22 concurrently would put 22 invocations against Yahoo at once and get the crumb
  rate-limited — a different failure from the subrequest cap but just as effective. `premInflight`
  guarantees a ticker is never fetched twice concurrently, since expand and Load all can both reach
  for the same row. **Expand all never fetches**; it only opens what is already loaded.

**Row `status` distinguishes three failures that used to render identically as dim red:**
`ok` · `no-options` (nothing listed — nothing to screen) · `no-iv` (options listed but the front expiry
quotes no usable IV — a real finding about a thin name, which will not fix itself) · `error` (the fetch
failed; transient, worth retrying). `pending` is never stored — it is what the batch endpoint reports
for a ticker the sweep has not reached. Conflating "we have not looked yet" with "this name has no
tradeable options" hides both.

**Two gates, two different jobs — `volRegime()` and `IVR_SELL_MIN`.** They look
like duplication and are not:

- `volRegime()` (worker.js) answers *"is vol rich or cheap enough to justify a
  volatility structure at all?"* — `IVR_HIGH` 70 / `IVR_LOW` 30, with
  `RATIO_HIGH` 1.2 / `RATIO_LOW` 0.9 as the IV/HV30 proxy. It gates the strategy
  cards on `index.html`: iron condor and CSP need `elevated`, straddle needs
  `depressed`.
- `IVR_SELL_MIN` (50) answers a *different* question: *"is this row worth the
  user's attention on a screen sorted by yield?"* It is a display threshold for
  dimming, not a trading gate, and 50 is the median rather than the 70th
  percentile because a screen that dims everything below 70 shows almost nothing.

Keeping them separate is deliberate. Collapsing them would mean either dimming
rows that still qualify for a structure, or recommending structures on rows the
screen calls uninteresting. `IVR_SELL_MIN` lives beside the `volRegime` constants
so the relationship is visible, and both ship to the frontend in `gates` — neither
frontend hardcodes a threshold.

**The gate is tri-state, and a null rank is not a fail.** `sellableFrom()` returns
`{ sellable, basis, reason }` with `basis` falling through in order:

| basis | when | test |
|---|---|---|
| `rank` | `ivRank` exists (≥60 days of history) | `ivRank × 100 ≥ IVR_SELL_MIN` (50) |
| `proxy` | no rank yet, but HV30 exists | `ivHvRatio ≥ RATIO_SELL_MIN` (**1.0×**) |
| `none` | neither | `sellable: null` — **not** a fail |

`sellable` was originally `ivRank != null && ivRank * 100 >= IVR_SELL_MIN`, which
treats a null rank as below-threshold. Since `ivRank` is null until 60 days of
samples exist, **that dimmed every row on the tab for the entire collection
window** — three months of a screen reading as if nothing were worth selling. The
proxy was already computed and already drove the regime chip; the gate simply
never consulted it.

`RATIO_SELL_MIN = 1.0` is the proxy analogue of "at or above the median": implied
vol is pricing at least as much movement as the stock has actually realised. It is
coarser than a percentile and is labelled a proxy everywhere it surfaces.
`sellable: null` renders **neutral, not dim** — "no basis to judge" is not the same
as "fails the gate". `sellableReason` names the deciding number, so "IVR 34" and
"rank collecting, proxy 0.94×" are distinguishable on hover.

**POP is delta-derived, and the card says so.** `1 − |Δ|` of the short strike;
`1 − (|Δcall| + |Δput|)` for an iron condor. Delta is Black-Scholes computed in the
Worker from each strike's **own** implied vol — not ATM IV — so put skew is
respected, and the `/api/iv` `pop` ladder carries real listed strikes so the leg
printed is one that exists.

**Debit structures render `n/a`, not a number.** For a bull call spread, bear put
spread or long straddle the break-even sits inside the long strike, so `1 − |Δ|` is
simply the wrong quantity — it would produce a plausible-looking figure measuring
nothing. Three of seven cards therefore show `n/a` with the reason on hover. The
temptation is always to fill the cell; a wrong number costs more than a blank one.

**`Hist Win` stays suppressed** pending a real backtest of the structure on the
underlying. It sits directly beside POP precisely so the difference between a
formula and a measurement is visible. Do not wire it to anything derived.

Rows sort by `bestAroc` (the best annualised ROC among the row's candidates), nulls last. Rows failing
the gate are **dimmed, never hidden**: a thin-premium name has to look unattractive, and hiding it
makes "no vol edge here" and "no data for this ticker" render identically.

**The tab is a collapsed list.** Every ticker as a full-height block made a 22-name watchlist several
screens of scrolling with no way to compare rows. Each row is one summary line — ticker, spot, front
IV, IV rank or proxy, term-structure chip, days to earnings, best annualised ROC — and expands on
click. Headers sort on any of those (alphabetical by default, annualised ROC descending being the
useful one); unavailable rows always sink regardless of sort, and nulls sort last in **both**
directions because a missing value is not a small value. Expanded state persists per ticker in
`sessionStorage` — it is "where was I", not a durable preference.

### The Long tab — the long-premium screen

The mirror of Premium: Premium asks *where is vol rich enough to sell*, Long asks *where is vol cheap
enough to own, and is the debit structurally payable*. Same architecture — `/api/long/batch?symbols=`
is a KV read making no outbound fetch (1 KV read/symbol), `/api/long/:ticker` is the only path that
touches Yahoo, Load all is strictly
sequential, expanded/sort state in `sessionStorage` under `trading_dash_long_open` /
`trading_dash_long_sort`. `long:{TICKER}`, `LONG_FRESH_MS` 4h, retention 24h.

**Measured subrequest cost (`_instr` on the response, AAPL 2026-08-08).**
`capCost` is the number the 10,000 meters — external fetches *and* KV together:

| case | extFetches | bindingOps | **capCost** | breakdown |
|---|---|---|---|---|
| premium-**warm** | 4 | 5 | **9** | base list + 3 dated chains (Jan 2028, Sep, Oct) |
| premium-**cold** | 7 | 6 | **13** | the above + earnings `quoteSummary` + hv30 chart |
| premium-cold, **crumb also cold** | 9 | 8 | **17** | + 2 crumb fetches and 2 crumb KV ops |
| cache hit (`?cached=1` or fresh) | 0 | 1 | **1** | one KV read |
| `/api/long/batch`, 22 symbols | 0 | 22 | **22** | one KV read per symbol |

**Re-measured 2026-08-09 after move coverage was added, and the crumb is why the
figure looks unstable.** Three consecutive `?refresh=1` calls on one local isolate:

| tier | extFetches | bindingOps | capCost | what differs |
|---|---|---|---|---|
| crumb in isolate memory | 7 | 9 | **16** | the steady state on a warm isolate |
| crumb in KV, not memory | 7 | 10 | **17** | one extra KV read, no fetch — the common production case |
| crumb fully cold | 9 | 11 | **~20** | + 2 crumb fetches and 2 crumb KV ops |

Full binding accounting for the crumb-in-memory path. It sums to exactly the
observed 9 with nothing unattributed, and **it must keep closing** — an
unexplained op here is how a per-request cost compounds silently as more reads get
threaded through `longRow()`:

```
riskFreeRate (econ:dgs3mo)   1     directionalRead (analysis:, rec:)   2
readPremiumRow               1     calib:pooled                        1   ← step 2
recordIvSample (long-live)   1     readMoveSeries                      1
ivHistory (list)             1     storeLongRow                        1
                                                                 total 9
```

History of that figure: **6** before move coverage (measured with the crumb already
in memory), **8** after it (`readMoveSeries` + `recordIvSample`), **9** after pooled
calibration (`calib:pooled`). Each step is one read, and the pooled read replaced
what would otherwise have been a 64-op scan — see the KV-key note below.

**Quote the tier, not a bare number** — a single measurement of this path is
ambiguous by ±4 on crumb state alone.

The earlier figures of 4 and 7 were `extFetches` only and understated the real
cost by 125–143%. Do not quote them.

**Everything that inverts, because an inverted thing that looks like a copy is how this gets broken:**

- **Debit is the ASK**, the mirror of Premium's credit-is-the-bid. On a vertical it is long ask − short bid.
- **Low IV rank is the good state.** `buyableFrom()` mirrors `sellableFrom()` — same tri-state
  fallthrough, opposite direction: `IVR_BUY_MAX` 40 on rank, `RATIO_BUY_MAX` 0.95 on the IV/HV30 proxy,
  `buyable: null` when neither exists (renders **neutral, not dim** — the same null-is-not-a-fail rule
  that greyed the Premium tab for three months). Note `buyable` is **not** `!sellable`: an IV rank of 55
  is neither rich enough to sell nor cheap enough to buy, which is a real and common state.
- **The dim gate is two-part**: not-rich vol **AND** best-candidate BE/EM ≤ 1.0. Cheap vol alone is not
  enough — a name can have depressed IV and still price every breakeven outside its own expected move.
- **`termStructure = front − back` is unchanged, and its MEANING is opposite.** Positive is
  backwardation (front IV richer). On Premium that is the crush setup and reads favourable; here it is
  **hostile**, because front-dated premium is exactly what a buyer is paying for. The row carries
  `hostileTerm` as a field distinct from `backwardation`, the chip glyph is **▰ / ▱** (never Premium's
  ◤ / ◢), and the legend states the inversion. Do not reuse the Premium chip renderer.
- **`P(BE)@exp` is N(d2), not 1 − |Δ|.** Delta is N(d1) and d1 − d2 = σ√T, so the delta shortcut fails
  worst on exactly the structure Lane A exists for. `node nd2.check.mjs` prints the gap: **5.34 pts at
  45 DTE / 40% IV, 22.57 pts at 531 DTE / 50% IV, 36.94 pts at 895 DTE / 65% IV.** σ comes from the
  listed strike nearest the *breakeven* and that strike is named on the card; if it quotes nothing
  usable the cell is `n/a` with the reason — **never** backfilled from ATM IV.

**Four lanes.** A = stock replacement, the two nearest Januaries ≥365 DTE, 0.85/0.70Δ ITM calls. B =
directional swing, first monthly ≥30 and ≥60 DTE, 0.55/0.40Δ. C = debit verticals on B's already-fetched
chains (zero extra subrequests), long ~0.55Δ short ~0.25Δ, **actual leg deltas reported, not the
targets**. D = calendar/diagonal.

**Lane A's two Januaries usually collapse.** §2's "nearest 540 DTE" and "nearest January ≥365 DTE" pick
the same expiry on all but ~7 days a year, so the second slot is the *next* January out. Expect it to be
unlisted on most names — AAPL, NVDA, CRCL, CAVA, QUBT, CRWV, TWLO, MRK and HOOD all listed exactly one
January beyond 365 DTE on 2026-08-08. That renders as `not-listed` with a reason, never as an error.

**Lane D is deliberately thin and the card says why.** It shows net debit, both IVs, the differential,
both DTEs and where earnings falls. It shows **no** breakeven, BE/EM, P(BE), cost of carry or payoff
diagram, because a calendar's P/L at the front expiry depends on the back month's IV *at that future
date* — a term-structure model this codebase does not have. Deriving any of them from an assumed future
IV would be a plausible number measuring nothing. Cost of carry is likewise absent on Lane C verticals:
the short leg refunds part of the extrinsic, so the Lane A formula does not describe the structure.

### Move coverage, drift and expectancy — the measured half

`beEm` and `pBe` both come off the implied-vol surface: they say whether a contract
is priced consistently with its own chain. **Neither measures what the underlying
has actually done.** `coverage` does — the fraction of historical N-session windows
in which the stock really moved past a given breakeven, from `moves:{TICKER}`.
Rendered beside `pBe`, the difference between the two is the finding.

Five things here are already-decided and must not be "simplified":

1. **Windows overlap, deliberately.** Disjoint windows leave ~5 samples/year at
   N=45. The consequence is carried in `independent = (sessions − N) / N` and
   stated on screen. Below `COVERAGE_MIN_INDEPENDENT` (4) a horizon returns `null`
   **naming the actual numbers**, never a shorter horizon relabelled as the
   requested one.
2. **Coverage is computed from the raw return array, never from binned data.**
3. **1y and 3y are reported separately and never averaged.** They disagree on names
   that have re-rated, and that disagreement *is* the regime warning. Measured
   2026-08-09: NVDA's 45 DTE calls read cov3y 40–56% against cov1y 17–35%.
4. **`gap = coverage − pBe` in POINTS, and zero is not fair value.** `pBe` is
   risk-neutral, coverage is a real-world frequency. A persistent modest *negative*
   gap is **expected** — it is the variance risk premium. No copy may imply otherwise.
5. **`gapBaseline` is null this release, with a reason.** A median over the 2–6
   candidates a row scores at one horizon is not a baseline, and those candidates
   are the same population being measured against it.

**GAP IS NOT A PURE VOLATILITY SIGNAL — this is the easiest wrong inference on the
screen.** Coverage contains whatever direction the stock actually went; `pBe` is
driftless by construction. So `gap` conflates *how fat the tails were* with *which
way the stock ran*, and **on a trending name the drift term dominates**. A name
that rose 40% shows large positive gaps on every call and large negative ones on
every put with the chain having priced vol perfectly well. `drift1y` / `drift3y`
(mean N-session return) are therefore rendered **directly adjacent to the gap** in
each candidate's expanded detail — not as a table column, and not somewhere else on
the card. Reading them together is the whole point of the adjacency.

**`expectancyEpisodesTo50` replaced `expectancyTop3Share`, which measured the wrong
thing.** Because windows overlap, the "three largest windows" were usually one
market move counted three times. Every window is now assigned to exactly one
**episode** — greedily: take the highest `pl_i`, claim every unassigned window
starting within N sessions of it, repeat — and the metric is how many episodes it
takes to reach half the total positive P/L. Ranking is on **`pl_i`, not on return**:
a straddle's payoff is not monotonic in S, so ranking by return builds the episode
around the wrong extreme.

Three properties worth knowing before touching it:

- **Low is the warning**, the opposite polarity to the share it replaced. 1 or 2
  means the expectancy rests on one or two market moves; 8 is unremarkable.
- **Episodes are scored on their POSITIVE P/L contribution, not their net.** The
  obvious formulation — rank by net episode P/L — *does not terminate*: net sums
  total `mean × n`, which on a losing structure sits far below half the positive
  total. Scored on positive contribution the episode sums equal `totalPos` exactly,
  so the count always terminates. Verified in `moves.check.mjs` §10 against a
  structure with +150,000 positive and −190,000 net.
- **The metric is bounded by `ceil(k/2)` for k equal episodes** — reaching *half*
  the positive P/L can never require every episode. Three separated moves report
  **2, not 3**. Do not write a test expecting 3; it is unachievable.

**`EPISODE_CONCENTRATION_WARN = 1`**, chosen from the observed distribution rather
than intuition (real candidates at the 0.95–1.10× moneyness the screen selects,
2026-08-09): on the **3y** window `episodesTo50` is 1 for **27%**, median 2, p90 8,
max 25; on **1y** it is 1 for **51%**, median 1. 1 is the only value making an
unambiguous claim — half the expected value from a single market episode. 2 would
fire on the median 3y candidate (53%), and a warning that fires on the median is
decoration. The old `0.40` did **not** carry over; it applied to a share, and this
is a count with inverted polarity.

**The flag must name its window inline, and `concentrationLabel` is its only
renderable form.** Calibration is on 3y, but expectancy falls back to the 1y array
when 3y is unsupported — and a 252-session series holds fewer distinct episodes, so
the same candidate can flag on one window and not the other. That is correct and it
looks like a bug, which is why the rendered string is *"half the expected value from
ONE 3y episode"* and never a bare ⚑. **Never draw a warning glyph from
`concentrationFlag` alone.** Nothing dims, hides or reorders on the flag.

**Row status extends the Premium vocabulary** rather than forking it: `ok` · `no-options` · `no-iv` ·
**`no-expiries`** (options listed but nothing screenable — no monthly at the swing horizon and no
January past the LEAPS floor) · `illiquid` · `error`. `pending` is never stored. There is deliberately
**no `no-leaps` row status**: "this name has no LEAPS" is a Lane A fact, carried by that lane's
`not-listed` reason and by `leapsListed: 0` on the row, which drives a chip. Failing the whole row would
have blanked three working lanes to report one missing one.

**Liquidity floors** `LONG_SPREAD_MAX_NEAR` (0.15) and `LONG_SPREAD_MAX_LEAPS` (0.30) as spread ÷ mid,
plus `LONG_MIN_OI` (10). A breach is **flagged and dimmed, never dropped** — a name whose options are
untradeable has to look untradeable, and dropping it makes that indistinguishable from missing data.

**Directional alignment annotates and demotes, never filters.** The rating comes from
**`analysis:{TICKER}`** — the same key the Watchlist Recommendation column writes (`ANALYSIS_SCHEMA`,
strict `BUY|HOLD|SELL`). There is no `watchlist:{TICKER}` key; `watchlist:tickers` is the saved symbol
list. Two KV reads, **zero external fetches and zero Claude calls — measured: 4 external both with and
without the key present**. A missing analysis is `no read` and must never trigger a generation. Lanes B/C
get a live tag; **Lane A is tagged `out-of-horizon`** (a 531-day contract judged by a signal scored at 5
and 20 sessions) and its sort is unaffected; Lane D gets no tag. `counter` candidates are demoted below
the rest **only once calibration resolves at n ≥ 10** — an unscored tag must not reorder anything.

### Adding a rule: two failure modes found building the Long tab

**1. Yahoo quotes junk implied vol on deep untraded strikes, and it corrupts strike SELECTION —
on BOTH screens.** Observed on AAPL 2026-08-08: the 2026-09-18 **420 put quoted IV 195.72% against an
expiry ATM IV of 24.54%** — an 8× outlier on a strike with open interest 0. Delta from that quote is
0.544, which beat the real near-the-money put for the long screen's 0.55 target. The screen would have
printed a confident, fully-priced "0.55Δ swing put" struck **34% above spot** with a 272.9% annualised
cost of carry, and every downstream number would have been arithmetically correct and completely
meaningless.

**The first fix was scoped to the long screen and that was wrong.** `pickCandidates()` (premium) and
`nearestDelta()` (long) are *separate* functions selecting from the *same* chains with the *same* delta
arithmetic, and only one of them got the guard. Delta is monotonic in sigma for an OTM option, so
inflated quotes drag apparent delta up toward 0.5 — which is why the long screen's 0.55/0.40 targets
were hit first and the premium screen's 0.30/0.16 were not. That is a difference in *exposure*, not in
*correctness*. Measured on a real AAPL chain (spot 313.33, 41 DTE, ATM 24%):

| strike | % OTM | true delta at ATM IV | delta at 4× IV | wins premium target |
|---|---|---|---|---|
| 400 | 27.7% | **0.0017** | **0.280** | 0.30 |
| 470 | 50.0% | 0.0000 | 0.139 | 0.16 |

And the junk strikes are demonstrably sitting in premium's selectable pool right now: turning the guard
on excluded **43 strikes on AAPL and 32 on NVDA** (one quoting **973.63%**) from the *nearest* expiry
alone, while changing zero live selections. They were not winning today; they were waiting for a day
when the genuine strike sat marginally further from the target.

The guard is therefore `ivPlausible()` / `IV_OUTLIER_MULT` (4), declared **above both callers** and
passed each expiry's *own* ATM IV — not the row's front IV, which is the wrong comparator for a 104-day
leg. Both screens report the exclusions on the card via `ivOutlierNote()`. **RESIDUAL, not fixed:** a
2–3× inflated quote still wins a target and is deliberately not excluded, because 2–3× is inside
genuine far-strike skew. This catches broken quotes, not merely optimistic ones.

**When a metric SELECTS using a vendor-supplied number, validate that number against its own peers
first — and then check every other selector fed by the same source.** A bad input to a display is one
wrong cell; a bad input to a selection is invisible, because the output looks like an ordinary row.

**2. A null rendered through arithmetic becomes a fabricated measurement.** The legend printed
**"hit rate 0% over n=12"**. Calibration was genuinely resolved (n=12 ≥ 10) but `hitRate` was `null`,
because a hit rate belongs to a *rating* and that ticker had no stored rating — and
`(null * 100).toFixed(0)` is `"0"`. A missing number silently became a measured 0% accuracy, which is
exactly what §6b forbids. **Guard the null before the arithmetic, not after: `x == null` and `x === 0`
must never render the same way.** The state count was two (resolved / unresolved) and the truth was
three.

An audit of every `.toFixed` and `× 100` site in both HTML files followed. The only *fabricated number*
was that one; the rest were already guarded by an early return, a ternary, or an upstream `.filter()`.
One further site of the same class was found and fixed — `gapBar()` on the golden-cross tab, where a
null gap divided to 0 and clamped to the 2% floor, **drawing a real bar for a missing measurement**.
A bar is a rendered number. Note also what the audit got *wrong*: the fundamentals grid looked
unguarded (`${v}` on a `?.raw?.toFixed()`) but line 2439 already filters with `.filter(r => r[1] != null)`,
and `undefined != null` is false — **check the guard that is already there before adding one**, or the
"fix" is noise and the comment beside it is a lie.

**3. A status word that cannot fire is worse than no status word.** The long screen shipped a
`no-leaps` row status whose condition required no January past 365 DTE **and** no monthly at either
swing horizon — effectively unreachable, and if it ever had fired it would have said "no LEAPS" about a
chain whose actual problem was having no usable expiries at all (honesty rule 17). It also implied a
row-level coverage check the screen does not perform. It is now `no-expiries`, accurately named, and the
LEAPS signal it was reaching for lives where it belongs: the Lane A entry's `not-listed` reason, and
`leapsListed: 0` on the row driving a chip. **A row status must not fail three working lanes to report
a fact about the fourth.**

The Scanner tab hosts four presets. Three (Momentum, Pre-Market Gappers, All Movers) hit
`/api/market/scanner` and share `renderScanner()`; the Golden Cross Setup preset hits
`/api/market/golden-cross` and uses `renderGoldenCross()`. `loadScanner()` branches on the preset
to pick the endpoint, renderer, header copy, and legend.

`index.html` — per-ticker research page. A hero strip (price, change, market cap,
P/E, sector, exchange, AI rating + confidence ring) above numbered cards:

```
01 Price & Performance          09 Analyst Opinion
02 Catalysts & Earnings         10 Super-Investor Holdings
03 Short Interest               11 Technical Analysis
04 Insider Trades               12 Sentiment Analysis
05 Options Volume · V/OI Screen 13 Fundamentals & Valuation
06 Recommended Option Strategies   (14 AI Synthesis — the hero card, not numbered inline)
07 Swing Setups · EMA Crossover  15 Recommendation History
                                   News Flow
```

Numbers 08 (dark pool) is **absent by design** — the card was fabricated and was
deleted, not renumbered, so the gap is a deliberate scar. Card element ids are
`card-perf`, `card-catalysts`, `card-short`, `card-insider`, `card-unusual`,
`card-strategies`, `card-trade`, `card-analyst`, `card-13f`, `card-chart`,
`card-sentiment`, `card-fundamentals`, `card-news`, `card-track`.

The Catalysts card carries an "Analyze Earnings" button that expands an inline panel
(`renderEarnings()`, backed by `/api/earnings/:ticker`). It fetches once per ticker and then just
toggles, and `resetEarnings()` clears it on ticker change. That panel is deliberately retrospective —
it analyses the *last* report — which is separate from the catalyst list above it.

**The catalyst list shows only events dated today or later.** `renderCatalysts()` filters on
`iso >= today`, where `today` is the `asOf` field returned by `/api/market/econ-calendar` (the
Worker's ET today, and the same reference the macro events are already filtered against server-side;
falls back to a local ET computation if that call fails). This is not belt-and-braces: Yahoo's
`calendarEvents.exDividendDate` and `dividendDate` are routinely the *most recent past* ones rather
than the next, and `earningsDate` can lag a report that already happened — unfiltered, the card
advertised settled events as upcoming catalysts (an NVDA quote in August still listed a June
ex-dividend). Today itself is kept, and `isoOf`/`fmt.dateLong` both work in UTC, so item dates and
their rendered labels stay consistent with each other.

All technical indicators (RSI, MACD, Bollinger, EMA crossovers, support/resistance, HV30) are computed client-side from Yahoo OHLCV. Chart rendering uses TradingView Lightweight Charts. Implied vol is the exception and comes from `/api/iv` — it cannot be derived from OHLCV.

**Section 07 is swing-only, deliberately.** It used to carry an opening-range-breakout block and a
VWAP line computed from *daily* bars. ORB needs the first N minutes of a session and VWAP needs
intraday prints weighted by intraday volume; on a one-bar-per-day series both were fabrications —
"ORB High" was just yesterday's high, and "VWAP" was a cumulative typical-price average over the
whole visible range. Both were deleted. The EMA crossover kept its place because it is genuinely a
daily-bar signal. Do not re-add either without an intraday feed.

### Data: real vs. stubbed

**Nothing is stubbed.** This section used to describe a violet "Sample · upgrade: X" badge and four
mock sections; the badge system is gone, the dark-pool card was deleted outright (fabricated, no free
source), and short interest / insider / 13F run on FINRA and SEC EDGAR. Provenance now comes from
`_meta` on every response — see the badge notes above. `ARCHITECTURE.md` holds the paid upgrade path
and the section-by-section source map.

**POP on the strategy cards** is 1 − |Δ| of the short strike (both short deltas for the condor),
against the `pop` strike ladder `/api/iv` returns: real listed strikes, each delta from that strike's
own IV, at the listed expiry nearest 35 DTE. `renderStrategies()` snaps its legs to those strikes, so
the card prints a strike you can actually trade with a probability that belongs to it. It is labelled
on the card as a **delta-derived approximation under a lognormal assumption, not a backtested
frequency** — that caption is load-bearing, because "Hist Win" sits right beside it and is exactly the
measured thing POP is not. Debit structures (both verticals, the straddle) render **n/a**: their
break-even is not the short strike, so 1 − |Δ| would be a plausible number measuring nothing. Hist Win
stays suppressed pending a real backtest.

## Design system

CSS custom properties in `:root`. Never hardcode colors — use the variables:
- `--bull` / `--bear` — green `#23d18b` / red `#f25f5c`
- `--amber` — neutral `#f4b740`
- `--cyan` — data accent `#5ec5ea`
- `--violet` — mock data markers `#b48ead`
- `--bg-0..3` — background layers (darkest to lightest)
- `--ink-0..3` — text (brightest to dimmest)

Fonts: `--serif` (Fraunces, display), `--sans` (Geist, body), `--mono` (JetBrains Mono, numbers/labels).

## Git workflow

Commit and push automatically at the end of each completed task, without being asked. One commit per logical task, not per file. Message format: short imperative summary line, then a blank line, then 2-4 bullets on what changed and why.

Do not commit:
- Mid-task, or when a task ended with something broken or unverified
- Work whose verification failed, or that you haven't tested
- Anything requiring my decision that I haven't answered yet

When a task ends with an open question or a known defect, say so and hold the commit until I respond.

Never use git push --force, never rewrite published history, never commit secrets or .dev.vars.

If a push fails, report the error rather than working around it.

Deployment requires approval — do not run npx wrangler deploy without asking for approval.

Kill background processes when a task completes. Don't leave wrangler dev, wrangler tail, or http servers running between tasks.

Add a "Verification standard" section to CLAUDE.md:

## No hit rate goes on screen without its base rate

**Any hit rate, win rate or accuracy figure must be reported against the base rate
for the same population and the same window, or it does not render at all.** Not in
a tooltip, not in a legend — beside the number, with the signed difference.

A rate on its own is unreadable, and it is worse than unreadable when it looks
fine. Measured 2026-08-10 on the recommendation log:

| outcome | rate | base rate | edge |
|---|---|---|---|
| sign-scored BUY (`fwd20 > 0`) | 53.3% | **61.4%** | **−8.1 pts** |
| magnitude-scored BUY | 17.3% | **34.3%** | **−16.9 pts** |

Both over the same 75 benchmarked BUY outcomes. 53.3% reads as a coin flip — an unremarkable, believable number. It is in fact a
**negative edge**: these names drifted up, so `P(fwd20 > 0)` over the same 20-session
windows is 61.5%, and the rating *underperformed simply being long*. Nothing about
the figure 53.9% reveals that. The benchmark is not context for the number; without
it there is no number.

The base rate must be **direction-matched and population-matched**: a BUY is scored
on upside so its benchmark is `P(r ≥ threshold)` on the same underlying and horizon,
a SELL on downside. For a pooled figure it is entry-weighted across the contributing
tickers, because each entry carries its own name's benchmark.

**Population-matched is not a formality, and it was got wrong on the first pass.**
Not every logged entry has a stored move series — the sweep covers the watchlist,
the log covers every ticker ever browsed. The first version took the rate over all
**112** BUY outcomes and the benchmark over the **75** with a series, printing
**48.2% against 61.4%** as though the two described the same thing. On the matched
population the rate is **53.3%** — a 5-point difference produced entirely by the
mismatch, in the direction that exaggerates the deficit. `cell()` now restricts
BOTH to the benchmarked rows and reports `n` and `benchmarkedN` separately, so the
shrinkage is visible rather than silent. `baseRatesFrom()` and
the `cell()` helper in `recCalibration()` do this; every rate cell ships `baseRate`
and `edgePts` alongside `hitRate`.

**This applies retroactively.** Anything already rendering a rate is in scope. Known
outstanding: `index.html`'s Recommendation History card renders raw hit rates —
`/api/track/:ticker` now returns `baseRate`/`edgePts`, but surfacing them there is
still to do.

**A rate below its base rate must never drive ranking, sizing or selection.** It is
not a weak signal, it is a signal pointing the wrong way, and ordering on it makes a
claim the data contradicts. The Long tab's alignment tag is disabled on exactly this
basis — see `directionalRead()`.

## A single negative probe right after a deploy is UNCONFIRMED, not a failure

**Re-probe after ~60 seconds before acting on it.** For roughly a minute after
`wrangler deploy`, requests can still land on a stale isolate serving pre-deploy
code, and there is no marker in the response saying so.

This needs to be a rule rather than left to judgement, because **the stale-isolate
signature is identical to a genuinely failed deploy**. Observed 2026-08-09, 23
seconds after deploying the coverage commit:

- the new gate field (`gates.episodeConcentrationWarn`) was **absent** — exactly
  what a build that never shipped looks like
- `long:` rows were still served under the **old schema number** — exactly what a
  `LONG_SCHEMA` bump that never landed looks like

Both read correctly a minute later; the deploy had been fine the whole time. The
natural response to that signature is to redeploy or start debugging the bump, and
both would have been wrong — a redeploy in particular would have looked like it
"fixed" the problem and buried the real behaviour.

So: **treat the first post-deploy probe as advisory only.** Confirm a suspected bad
deploy on a second probe at least a minute later before changing anything. This
applies to KV-shape checks especially, since a stale isolate reads and writes the
same namespace as the new one.

## Verification standard

Before reporting a task complete, state which checks were run and print the actual values. "Verified" without a number is not verification. This applies to every numeric output, every identifier taken from an external source, and every calculation.

Print, don't assert. Show computed values alongside expected values, with deviations. The Black-Scholes check was trustworthy because it printed 0.52160473 against 0.52200000; a claim that it passed would not have been.

Check against a different source than the one being tested. Cross-check a formula against a different algorithm, an identifier against the live API, a field name against the live response. Documentation consensus is not verification — three sources agreed on the wrong FINRA field name while the live API had the right one in our own code.

Name the verification method's blind spot. curl cannot catch CORS preflight failures. A DOM shim cannot catch CSS layout problems. Local dev without .dev.vars cannot exercise live-credential paths. When the available method can't reach the failure mode, say so explicitly rather than reporting a pass — a bug shipped this session because preflight was modeled by hand instead of observed in a browser.

Verify against a second case before declaring success. One passing ticker is a coincidence; three is a pattern.

## Before every task

Read CLAUDE.md and ARCHITECTURE.md first. Do not work from assumptions carried over from earlier in a session or from my prompt — I have been wrong about what exists in this codebase multiple times (a 13F override map that doesn't exist, a cached risk-free rate that wasn't there, mock generators that were dead code, the term-structure sign). If my instruction contradicts the code, say so before acting.

Check any change against the subrequest budget (rule #1 — 10,000 per invocation, and KV/binding calls are a *different* bucket from external `fetch()`) and against rule #2: no calendar logic in the cron expression, and any new Pacific hour must fall inside the UTC window under **both** PST and PDT. Both have caused silent failures.

## After every task

Update the docs in the same task, not later. Any new KV key, constant, secret, endpoint, or threshold goes into CLAUDE.md as it is created. Docs that lag the code are how a session starts by acting on false premises.

Report what you could not verify, separately and explicitly. That section has been the most useful part of every report this session.

Kill background processes. No wrangler dev, wrangler tail, or http servers left running between tasks.

## Adding a new failure mode

When a bug is found, add a rule naming the specific failure that produced it. Rules tied to a concrete incident are followed; abstract ones are not.

cron execution history doesn't exist unless observability logs are enabled, and observability.enabled seeds logs.enabled in wrangler's normalization — writing only the nested table silently disables both.
