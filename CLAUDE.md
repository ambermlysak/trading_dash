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

**It is ONE pool, and this rule has now been wrong in both directions.**

| call | counts against the 10,000? |
|---|---|
| external `fetch()` — Yahoo, SEC EDGAR, FINRA, FRED, Alpaca, Anthropic | **yes** |
| `env.REC_LOG.get/put/delete`, and any R2 / D1 / Durable Object binding | **yes — same pool** |

Do not restore the two-bucket table, and do not write a comment claiming KV reads
are free of the cap.

#### The cap is not what stops fan-out. Yahoo is.

**Read this before treating 10,000 as permission to fan out.** Every structure in
this codebase that avoids fan-out stays exactly as it is:

- `/api/long/batch` remains a **KV read that makes no
  outbound fetch** (they still cost one KV read per symbol — cheap, not free);
  `/api/long/:ticker` remains the only path that touches Yahoo.
- **Load all is strictly sequential** on both tabs, one awaited request at a time.
- The deleted KV queue that once drained the premium sweep across cron firings
  **stays deleted**.

The binding constraint is **Yahoo crumb rate-limiting**, which the plan change did
not touch. Firing 22 tickers concurrently puts 22 invocations against Yahoo at
once and gets the crumb rate-limited — a different failure from the cap and just
as effective. The screen is also used one or two names at a time, so fetching all
22 solves a problem nobody has.

**A per-item `catch` that cannot tell "this item failed" from "we exhausted a
budget and every remaining item will fail" still reports partial data as
complete, at any ceiling.**

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

**Quote `capCost`, never `extFetches`.** The `/api/long/batch` and
`/api/premium/batch` endpoints cost **exactly one KV read per symbol**, so a
22-name watchlist paints for **22** against the cap, not 0.

**`_instr` IS A COUNTER DELTA, NOT A PER-JOB TOTAL — two concurrent jobs
contaminate each other.** `instrMark()` / `instrSince()` bracket a span of *time*
and subtract invocation-wide counters. Anything else running inside that bracket
is attributed to whichever job stamped the payload. On a firing that dispatches
two jobs through `ctx.waitUntil`, the per-job figures are **upper bounds on that
job and lower bounds on the invocation**, not measurements of either.

So: **quote a per-job `_instr` only for a job that ran alone, and say which case
you are in.** The N=22 sweep figure of `2 / 47 / 49` is trustworthy precisely
because it was measured in isolation and matches `2N + 3` exactly. When two jobs
share a firing, `invocationCapCost` is the honest number and the per-job split is
an inference. This is not a defect to fix — a per-job counter would need
async-context tracking the runtime does not offer — but an unlabelled per-job
figure from a shared firing is a measurement that is quietly wrong, which is the
failure this whole section exists to prevent.

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

**A zero count with `measured: false` means "not instrumented", not "made no
calls."**

**Instrumentation may never break what it measures.** A measuring device that can
take out the morning briefing is worse than no measuring device.

The contract is: **instrumentation failure degrades to a missing or
`measured:false` `_instr` field, never to a missing briefing.** `node
cron-gate.check.mjs` proves it with forced faults — a null baseline and a
rejection whose `reason` throws on property access.

> **Evidence for this rule** — the measured runs, cost tables and incident
> write-ups behind it — is in [`docs/rules-evidence.md`](docs/rules-evidence.md),
> section *"1. Subrequest budget: 10,000 per invocation, one pool — and the cap is no longer the constraint"*.

### 2. The cron expression is a coarse wakeup — put no calendar logic in it

The trigger is `*/15 13-22 * * *`: every 15 minutes, UTC hours 13–22, **every
day**. It decides *how often we wake up* and nothing else. Which day, which date,
which job — all of that is decided in `scheduled()`, in code, against Pacific
wall-clock time.

**Do not put a day-of-week, day-of-month or month back into the expression.**

The expression used to end in `1-5`, which reads as Mon–Fri under standard cron
(`0` = Sunday). **Cloudflare's day-of-week field is 1-indexed with 1 = Sunday**, so
`1-5` actually meant **Sun–Thu**.

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

> **Evidence for this rule** — the measured runs, cost tables and incident
> write-ups behind it — is in [`docs/rules-evidence.md`](docs/rules-evidence.md),
> section *"2. The cron expression is a coarse wakeup — put no calendar logic in it"*.

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

Two things now exist for it:

- `cors-check.html` — open it **in a browser** from an allowlisted origin. It
  issues real cross-origin requests, so real preflights, and reports pass/fail.
  A 401 or 429 there is a **pass**: it means the browser let the request through
  and the Worker answered. Only a `TypeError` with no status is a CORS block.
- A curl-based simulation of the Fetch spec's preflight algorithm is useful for a
  quick check, but it is a *model* of the browser, not the browser. When they
  disagree, the browser is right.

> **Evidence for this rule** — the measured runs, cost tables and incident
> write-ups behind it — is in [`docs/rules-evidence.md`](docs/rules-evidence.md),
> section *"4. CORS preflight: any custom request header must be allowlisted"*.

### 5. The spend gate: `/api/claude` is gone

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

**None of this is authentication.** Read the residual-risk section in
`ARCHITECTURE.md` before assuming any of it stops a motivated attacker.

> **Evidence for this rule** — the measured runs, cost tables and incident
> write-ups behind it — is in [`docs/rules-evidence.md`](docs/rules-evidence.md),
> section *"5. The spend gate: `/api/claude` is gone"*.

### 6. `DASH_KEY` is only live once it is pushed to GitHub Pages

Editing `DASH_KEY` in the working tree changes nothing the browser sees. The
pages are served by **GitHub Pages from the last pushed commit**, so the fix is
`git push`, not the edit. This has produced the same dead end twice:

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

> **Evidence for this rule** — the measured runs, cost tables and incident
> write-ups behind it — is in [`docs/rules-evidence.md`](docs/rules-evidence.md),
> section *"6. `DASH_KEY` is only live once it is pushed to GitHub Pages"*.

### 7. A job that never runs produces no evidence — log every dispatch decision

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

#### Every cron job goes through `dispatchJob()` — a sibling must not be able to kill it

`dispatchJob(ctx, name, () => job(env))` makes it a property of the dispatcher.

**It also removes an ambiguity that matters when reading telemetry.** An
unhandled `waitUntil` rejection marks the whole invocation as an exception, so one
failed job and a failed branch look identical from the outside. `dispatchJob`
catches, and logs `!! JOB-FAILED !!` naming the job instead.

**That is a deliberate trade against rule #7's own warning** that `errors: 0` is
not evidence of success: catching does clean the invocation. What replaces it is a
greppable ERROR line naming the job — the same trade `allSettledCounted` already
makes.

**Never write a bare `ctx.waitUntil(job(env))` in `scheduled()` again.**

##### What the trade costs: invocation status is no longer evidential on the cron path

**Invocation status and `errors: 0` do not indicate that any cron job succeeded.**
Since `dispatchJob` catches, a failed job reads as a clean **200** and `errors: 0`
means only *"nothing escaped uncaught"*. Before it, a failed job at least made the
invocation look wrong — that signal is gone, deliberately, because it could not
distinguish one failed job from a failed branch.

**The evidence is two things, neither of which is the invocation:**

1. the job's own **per-job KV stamp** — `daily:snapshot`, `daily:midday`,
   `daily:eod`, `ivsweep:last`, `macrosweep:last`, `recfwd:last`,
   `movesweep:last`, `moodsweep:last`, `13f:cursor`
2. a grep for **`!! JOB-FAILED !!`**, which names the job

This now covers all nine dispatch sites in `scheduled()`: `morning-briefing`,
`midday-pulse`, `eod-summary`, `iv-sweep`, `macro-state`, `forward-returns`,
`move-series`, `market-mood`, `13f-slice`.

> ##### THE GREP HALF OF THIS STANDARD HAS NEVER BEEN RUNNABLE — 2026-08-12
>
> Reading `!! JOB-FAILED !!` means querying Workers Logs, and the Observability
> telemetry endpoint
> (`POST /accounts/{id}/workers/observability/telemetry/query`) returns **403
> with a valid, freshly-refreshed token**. Wrangler's OAuth scope set —
> `account:read user:read workers:write workers_kv:write workers_routes:write
> workers_scripts:write workers_tail:read d1:write pages:write zone:read …` —
> contains nothing that authorises it; `workers_tail:read` does not.
>
> **It requires a Cloudflare API token with Observability Read, and no such token
> is provisioned.** Until one is, this evidence channel does not exist and
> everything above rests on the KV stamp alone — which the next section shows is
> not sufficient either. `wrangler tail` is not a substitute: it streams live
> events only, so it cannot be pointed at a firing that already happened.
>
> **Do not write a verification step that greps for `JOB-FAILED` until the token
> exists.** A standard nobody can execute reads, at a glance, as one that was.

**`!! JOB-FAILED !!` only fires when a job REJECTS.** A job that catches its own
failure internally resolves normally, so it prints no line and the grep comes back
empty on a run that did nothing. The grep is a positive signal, never a negative
one: a silent grep plus a stamped key is *not* proof of success, and the five jobs
in the table below can produce exactly that.

##### EVERY DEDUP STAMP IS GUARDED ON THE RUN HAVING ACCOMPLISHED SOMETHING

Five of the eight used to stamp after a run that did nothing. Fixed 2026-08-12;
before and after both measured by forcing each failure locally and reading KV
through the Worker's own binding (logs are unusable here — wrangler dev surfaces
only `warn`/`error` from `waitUntil`). It interacted badly with the trade above:
such a run was a clean 200, printed no `JOB-FAILED`, **and** dedupped itself out
of the day's remaining firings.

| job | key | guard | before → after |
|---|---|---|---|
| `morning-briefing` | `daily:snapshot` | `ts: 0` + `isComplete` in the dedup | was already safe; **the pattern the other four copied** |
| `midday-pulse` | `daily:midday` | returns before the put | was already safe |
| `macro-state` | `macrosweep:last` | four refusal paths, all returning before the stamp | was already safe |
| `eod-summary` | `daily:eod` | `ts: 0` + `complete` term in the dedup | stamped `ts: Date.now()` on a Claude failure → **placeholder `ts: 0`, `complete: false`, retries** |
| `iv-sweep` | `ivsweep:last` | `ok === tickers.length` | 0 samples written, key stamped → **key ABSENT** |
| `forward-returns` | `recfwd:last` | `chartFailures === 0` | per-ticker chart failures `continue`d and it stamped → **key ABSENT** |
| `move-series` | `movesweep:last` | `written + skipped === tickers.length` | same `allSettled` shape → **key ABSENT** |
| `market-mood` | `moodsweep:last` | `fetched === MOOD_SYMBOLS.length` | built to the pattern above, never had the defect |
| `13f-slice` | `13f:cursor`, `lastFullPass` | cursor holds on a wholly-failed batch; `lastFullPass` needs `managersOk > 0` | advanced 4→8→12→16→0, set `lastFullPass`, then idled 7 days → **cursor held at 0 across 5 slices, `lastFullPass: null`** |

**The thresholds, and why each is what it is:**

- **`ok === N`, not `ok > 0`, for the IV sweep.** Per-ticker writes are idempotent
  (one key per ticker per PT day), so a retry fills the gaps rather than
  duplicating work. `ok > 0` would have accepted 2026-08-06's 7-of-N.
- **`written + skipped === N` for move-series.** `skipped` means "already current",
  which is a complete outcome; `absent` (spark did not return the name) is not.
- **NOT `filled > 0` for forward-returns.** Most days nothing is pending and 0
  filled is correct and complete. The incomplete signal is a ticker whose chart
  could not be read at all.
- **`fetched === 15` for market-mood, and a partial run still WRITES.** The two
  are separate decisions and both are deliberate: a readable sector board with an
  unavailable verdict is a finding worth rendering, so the payload is stored; but
  the run is not done, so it does not stamp. The write is one key rewritten
  whole, so a retry replaces rather than duplicates. A run where **every** fetch
  failed writes nothing at all — a board of 15 unavailable rows is not a finding.

**Cost, bounded and stated:** the 1:15pm window admits exactly two firings, so a
persistently failing name costs one extra pass per day and no more.

**Verified both directions.** Forced failures leave every key absent; clean runs
still stamp — 13F cursor advanced 0→4 with the index at 16,237 B against 4,829 B
when every manager failed, forward-returns and move-series both stamped, and the
IV sweep stamped on a real 14-name local run, so `ok === N` does not block a
genuinely complete pass.

**A note on the instrument, because it changed under the fix.** The old test
compared stored bytes across two firings: the pre-fix EOD placeholder carried
`ts: Date.now()`, so identical bytes proved a skip. The fix makes the payload
deterministic (`ts: 0`), so identical bytes prove nothing. The working
discriminator is the **KV expiration**, which moves on every write: 1786666522 →
1786666570 across the second firing, i.e. rewritten, i.e. retried. **When a fix
makes an instrument degenerate, replace the instrument.**

**Blind spot:** `morning-briefing` and `midday-pulse` cannot have their
post-Claude paths exercised locally — with no `ANTHROPIC_API_KEY` in `.dev.vars`
neither is reached. Those two rows are measured on the *failure* path only.

**Not changed, and worth knowing:** `handleDailyGet` triggers request-path
regeneration on `!eod`, not on `!eod.complete`, so a page visit will not
regenerate a placeholder. The impact is bounded because the next cron firing now
does retry. Changing it would add a Claude-spend path to ordinary page loads, which
is its own decision.

##### THE PLACEHOLDER IS A THIRD RENDER STATE — and it rendered as a real report

`daily:eod` can now hold `complete: false, ts: 0`, which is a state the EOD card
had never seen. Rendered before the fix, with a stale timestamp seeded as a
re-render would leave it:

```
─── PLACEHOLDER (complete:false, ts:0)      BEFORE
   badge     : "Market Close"
   headline  : "Market closed Wednesday, August 12, 2026"
   body      : "Market data unavailable."
   timestamp : "As of 01:15 PM PDT"          <- the PREVIOUS render's line
```

`if (data.eod.ts) { … }` skipped the assignment rather than clearing it, so a
failed generation appeared as a **timestamped market-close report**. That branch
was unreachable until the guard started writing `ts: 0`. After:

```
─── PLACEHOLDER                              AFTER
   badge     : "Market Close · unavailable"
   headline  : "End-of-day summary could not be generated"
   body      : "The 1:15pm PT job did not get a usable summary back. It retries…"
   timestamp : "no summary for today yet — retrying"
```

**The test is `data.eod.complete === false`, never `!data.eod.complete`.** A record
with no `complete` field came from a Worker predating 2026-08-12 and is a REAL
summary — the frontend ships ahead of the Worker routinely, and treating absent as
false would relabel every genuine record as failed. Verified against all three
states; the old-Worker record still renders normally.

**A stale value is a worse lie than a blank one.** Both `eod-ts` assignments are
now unconditional, including the `data.open` branch, which shares the element.

##### `iv:` SAMPLE COUNT DOES NOT MEASURE SWEEP SUCCESS — and never has

**Four writers share `iv:{TICKER}:{DATE}`. Until 2026-08-12 the stored record only
told two of them apart.** `recordIvSample` puts provenance in the body via
`...(src ? { src } : {})`:

| caller | `src` |
|---|---|
| `longRow` live path | `'long-live'` |
| `longRow` warm path | `'long-warm'` (+ `skipIfPresent`) |
| `/api/iv/:ticker` handler | `'api'` — **added 2026-08-12** |
| `recordWatchlistIv` (the cron) | `'sweep'` — **added 2026-08-12** |

**AN ABSENT `src` MEANS PRE-2026-08-12, NOT `'api'`.** Historical keys are
deliberately not backfilled — the gaps and their provenance are the evidence for
how biased the series is. Anything reading `src` must treat absent as UNKNOWN.

For everything written before that, a sample with no `src` is the cron **or** an
ordinary page view, and nothing stored separates them. The only separator for the
historical record is behavioural — the sweep writes the whole watchlist within
seconds of 1:15pm PT, a page view writes one at an arbitrary time. **That is an
inference from clustering, not a field**, and it misclassifies any page view
landing inside the window.

**Consequence: sweep completeness cannot be measured retroactively, and a raw
`iv:` count is actively misleading.** Measured 2026-08-12 over the whole 123-key
history — the naive count and the timing-classified count disagree on five of nine
dates, and in one case by 35:

| PT date | dow | `iv:` keys | writes in the 1:15pm window | what it actually was |
|---|---|---|---|---|
| PT date | dow | `iv:` keys | 1:15pm-window writes | cron fired? (analytics) | verdict |
|---|---|---|---|---|---|
| 2026-08-04 | Tue | 1 | 0 | **yes** 20:15:55, 13 sub | job-level failure |
| 2026-08-05 | Wed | 20 | 15 (13:15:17–19) | series at :14, **no 20:15 row** | anomalous, see below |
| 2026-08-06 | Thu | 16 | 7 (13:15:25–27) | **yes** 20:15:23, 50 sub | job-level, partial |
| 2026-08-07 | Fri | 5 | 0 | **yes** 20:15:42, 11 sub | job-level failure |
| 2026-08-08 | Sat | 5 | 0 | yes, 0 sub | market closed, correct |
| 2026-08-09 | Sun | 6 | 0 | yes, 0 sub | market closed, correct |
| 2026-08-10 | Mon | **35** | **0** | **yes** 20:15:35, **105 sub** | job-level failure |
| 2026-08-11 | Tue | 3 | 0 | **yes** 20:15:31, 41 sub | job-level failure |
| 2026-08-12 | Wed | 32 | 32 (13:15:07–18) | **yes** 20:15:05, 113 sub | full sweep, 32/33 |

**One full sweep in seven trading days**, and `2026-08-10` is the trap: 35 samples
against a 33-name watchlist reads as a complete sweep and is a sweep that never
ran — every one of the 35 was `long-live` or traffic.

**THE CRON FIRED ON EVERY TRADING DAY.** Established from Workers Analytics
(`workersInvocationsAdaptive`, which needs no observability token) by matching the
cron's stable per-day second-offset at quarter-hour minutes. So **these are
job-level failures, not schedule failures** — which is what makes the stamp guards
above the right fix rather than a schedule change.

**2026-08-07 was NOT a Sun–Thu casualty** — an earlier revision of this table said
it was and that was wrong. The expression fix (`f313c04`, 2026-08-07 11:23 PT)
predates that day's 1:15pm branch, and the cron did fire at 20:15:42.

**2026-08-05, where the sampling rule above was found.** 15 samples were written at
13:15:17–19 PT with **no invocation recorded** at that minute, though the cron
series is plainly present at `:14` seconds on either side (20:00:14, 20:30:14,
20:45:14). It is a dropped row, not a missing firing: `20:30:14` shows **0
subrequests**, which under the pre-fix code means all three jobs dedupped, which
requires the 20:15 firing to have run and stamped.

**Every quarter-hour row the table above rests on carried `sampleInterval = 1`, and
the claim is "the cron fired", never "the cron did not."** That is the safe
direction of the asymmetry. Do not invert it.

#### None of that logging exists unless observability is on

`[observability] enabled = true` in `wrangler.toml` is a **prerequisite for cron
execution history existing at all**. With it off, the log lines above are emitted
into nothing and are not retained anywhere.

**Absence of cron lines in a tail is not evidence.** It is an unreadable
instrument, and it was read as evidence for two hours.

Know which of the two telemetry systems you are querying, because they are
independent and only one of them needs observability:

| system | needs `observability.enabled`? | what it gives you |
|---|---|---|
| **Workers Logs** (`wrangler tail`, dashboard log search) | **yes** — for anything retained | your own `console.log` lines, e.g. `branch=morning-briefing` |
| **Workers Analytics** (GraphQL `workersInvocationsAdaptive`) | **no** | invocation counts, errors, subrequest totals, timestamps |

> ##### `workersInvocationsAdaptive` IS SAMPLED — NEVER ARGUE FROM ABSENCE
>
> The **Adaptive** in the name is load-bearing. Measured 2026-08-12 across three
> single-day queries, `sampleInterval` took the values **1, 1.6, 1.588…, 1.667, 2,
> 2.5, 2.8 and 10** — within a single two-hour window. Rows are dropped.
>
> **The asymmetry is the whole rule:**
>
> | reading | valid? |
> |---|---|
> | a row is present (check `sampleInterval` is 1) → that invocation happened | **YES** |
> | no row at that time → the invocation did not happen | **NO. Never.** |
>
> This applies to every question asked of this dataset — "did the cron fire", "was
> there traffic", "did anything run at all" — not just the one it was found on.
> **Always select `avg { sampleInterval }` alongside whatever you are counting**,
> and say which rows carried 1. A count taken without it is a lower bound wearing
> the costume of a measurement.
>
> `subrequests` from this dataset also **excludes KV binding operations** — see
> ARCHITECTURE #18 — so it is not `capCost` and must never be quoted as one.
>
> Second, smaller bound on the same method: the cron's second-offset drifts across
> days (**`:05` to `:55` observed**), so attributing firings by quarter-hour minute
> misclassifies whenever drift crosses a minute boundary.

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

> **Evidence for this rule** — the measured runs, cost tables and incident
> write-ups behind it — is in [`docs/rules-evidence.md`](docs/rules-evidence.md),
> section *"7. A job that never runs produces no evidence — log every dispatch decision"*.


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
- **Market Mood renders its house TEMPLATE sentence, not an empty card** — the
  whole verdict is rules-decided, so only the phrasing degrades. `sentenceSource`
  reads `template` and the note names `ANTHROPIC_API_KEY not set`. That is the
  fallback working, not a failure, and it is why the Claude half of that job
  cannot be exercised locally without a key

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

There is no build step. Eleven checks exist, all of which print computed vs
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
shared `ivPlausible()` guard at its boundaries), `node lane-e.check.mjs` (Lane E's two-sided half:
two-sided coverage against brute force including a zero-contribution tail, two-sided pBe against a
series-erf reference, both payoff functions across all four breakevens, and the drift split across
trending / range-bound / downtrending regimes), `node nd2.check.mjs` (the Long tab's `P(BE)@exp`,
theta and vega — N(d2) against a reference series-erf **and** against
e^{rT}·(−∂C/∂K) by central difference, which is a structurally different
derivation and so catches "right arithmetic, wrong quantity"; greeks against
numerical differentiation), and `node macro.check.mjs` (macroRegime phase 1: the
term-structure SIGN convention, both classification boundaries as strict
inequalities, `hostileVia`, date alignment against a brute-force intersection,
`unavailable` with each of the four inputs missing in turn, the trailing mean, the
two trend derivations agreeing, and `collectMacroState`'s exact cost and every
refusal path driven with stub bindings), and `node mood.check.mjs` (Market Mood:
every candlestick predicate firing **and** at a non-firing boundary value, the
trend-context reclassification — one geometry reading `hammer` / `hanging-man` /
direction-neutral — both sides of every emotion cut, the macro classifier across
all seven states with stub reads, the stance table, the template for every
(macroState, breadth qualifier) pair, the sentence guard that stops a rephrase
becoming a reclassification, and `collectMarketMood`'s exact cost and every
refusal path with stub bindings). All of them extract functions from
`worker.js` by source, not by import, because every named export in `worker.js`
must be a function or `workerd` refuses to boot.

Observed comparison counts, which are also each script's `minComparisons` floor:
**138 / 31 / 28 / 35 / 13 / 30 / 70 / 36 / 67 / 144 / 273** for moves /
long-fixtures / cron-gate / instr-bindings / bs-delta / nd2 / lane-e / lane-f /
sweep-universe / macro / mood — **865 comparisons** across the suite.

**`mood.check.mjs` uses a brace-matching `grabConst`, not the scan-to-semicolon
one the other scripts share.** `MOOD_STANCE`'s sentences contain semicolons, and
a `[^;]+` grab truncates the table mid-string — the generated module then fails
to parse, which reads as a missing constant rather than as a harness bug. Copy
that version, not the older one, for any table holding prose.

**`node iv-capture.fixture.mjs` is an eleventh script and is deliberately NOT in
that total**, because it tests `iv-capture.mjs` — an operational capture tool —
rather than anything in `worker.js`, and the 592 has always meant "comparisons
against the Worker". It contributes **15** of its own. It exists because
`iv-capture.mjs`'s first live run exercised only the no-change branch
(`rewritten: 0`), and **an empty comparison is not a pass**: the rewrite detection,
the per-ticker delta arithmetic, the `ts` gap and the only-in-pass-1 /
only-in-pass-2 buckets had never executed against changed data. It synthesises that
data from a real snapshot and checks the arithmetic against hand-computed values.

**`node --check` IS NOT A SUFFICIENT PRE-DEPLOY PARSE, and it gave a false pass on
this commit.** `worker.js` is an ES module; `node --check` parses it as a CommonJS
script, where a duplicate `let`/`const` in one scope is **not** an error. A
`const { head, series }` destructuring shadowing an existing `let series` in
`collectMacroState` passed `node --check` with exit 0 and threw
`SyntaxError: Identifier 'series' has already been declared` the moment anything
loaded it as a module. Reproduced minimally, both ways. That is the same class as
the non-function named export that once stopped `workerd` from booting — a total
outage with no partial failure — so the check has to be one that actually parses
it as a module:

```bash
node --check worker.js                      # NOT sufficient on its own
node cron-gate.check.mjs                    # imports worker.js as an ES module
npx wrangler dev                            # the real workerd startup validation
```

`cron-gate.check.mjs` is the cheap one and it caught this; run it, or a real
`wrangler dev` boot, before believing a syntax check.

## Architecture

### Worker invariants

The detail behind every line here is in
[`.claude/skills/worker-internals/SKILL.md`](.claude/skills/worker-internals/SKILL.md).
These stay resident because each is a contract a session can violate in a single edit
without ever opening that file.

- `capCost` = `extFetches` + `bindingOps`; quoting `extFetches` alone understates
  the long-screen path
- `yahooSparkCloses` takes 20 symbols per request; fetches are `ceil(N/20)`
- Never read `content[0].text` — Opus 5 thinks by default and slot 0 is a
  `thinking` block
- `max_tokens` caps thinking + answer together, not the answer alone
- IV is carried through this codebase as **percent**; `bsDelta` takes **decimals**
- `ivRank` is null until 60 days of history exist, and nothing stands in for it
- Risk-free rate comes from FRED `DGS3MO` and is **suppressed, never defaulted**
- SEC EDGAR requires a real contact email in `SEC_UA` or it 403s everything
- Verify every CIK against EDGAR before adding it to `SUPER_INVESTORS`
- Option-strategy gates are relative, never absolute
- Provenance badges are derived by `setBadge()`, never authored
- Do not declare a local `const TTL` — `TTL` is a module-level table
- `premium:{TICKER}` freshness and retention must not be equal
- `moves:{TICKER}` schema check stays strict equality
- `mood:state` schema check stays strict equality; Market Mood's states are
  decided by rules and Claude may only rephrase the verdict, never change it
- `calib:pooled` lives in the cron and must never move
- `scheduled()` gates on the Pacific trading day before dispatching

### Worker endpoints, data sources, KV and cron → the `worker-internals` skill

**Editing any `/api` endpoint, KV key, cron job, sweep, or external data source? Load
the `worker-internals` skill first.** It holds the endpoint list, Yahoo crumb auth,
`bsDelta` and the FRED risk-free rate, SEC EDGAR insider and 13F indexing, FINRA short
interest, the full KV key and TTL table, the cron dispatch schedule, `primeTabs()` cost,
and the sweep universe's refusal contract — including
*"The sweep universe has ONE source, and an empty one REFUSES"*.

It was moved out of this file because it is ~53 KB of reference that was loading into
every session. The rules in it are not softer for living there.

### Frontends

`dashboard.html` — macro landing view with **six tabs**. Every tab is deep-linkable
by hash (`dashboard.html#long`; `#premium` redirects to `#long`), and `switchTab()` only lazy-loads a tab whose
data is still empty — `primeTabs()` has usually painted it already.

| Tab | `#hash` | What it is |
|---|---|---|
| **Market** | `#market` | Default. Index/futures/commodities strip, the 6am Claude briefing headline, **Market Mood** (candlestick emotion read, directly under the brief), EOD card, Friday week-ahead, news cards, pre/post-market movers (≥ ±10%), IPO calendar, watchlist signals. |
| **Midday** | `#midday` | The 11:30am PT midday pulse — session narrative, topics, next-day events, short-term trade ideas, big movers. |
| **Scanner** | `#scanner` | Four presets. Three (Momentum / HOD, Pre-Market Gappers, All Movers) hit `/api/market/scanner` and share `renderScanner()`; **Golden Cross Setup** hits `/api/market/golden-cross` and uses `renderGoldenCross()`. `loadScanner()` branches on the preset for endpoint, renderer, header copy and legend. |
| **Watchlist** | `#watchlist` | The 14-column table, sortable, with expandable rows and the consolidated Recommendation column. |
| **Sectors** | `#sectors` | All 11 SPDR sectors, ETF % change plus a Claude-picked opportunity and avoid per sector. |
| **Long** | `#long` | The only options screen. **Six lanes** (LEAPS / swing / debit verticals / calendars / straddle+strangle / defined-risk credit spreads). The standalone Premium tab was merged in as Lane F on 2026-08-10 — short premium is secondary and now sits as one lane among six, ranked by the same expectancy as everything else. |

Note the Long tab is the only one that fetches on interaction rather than on
load: expanding a row is what spends the subrequests. Sectors and Scanner use
stale-while-revalidate (`?cached=1` paints the KV snapshot, then the normal
endpoint revalidates behind it), so **no tab requires a click to show data**.

The `index.html` "Options Volume · V/OI Screen" card is a *different thing* and
still exists — real Yahoo chain volume and open interest, on the per-ticker page.

### The Long tab, its six lanes, coverage and the macro chip → the `long-screen` skill

**Working on the Long tab (Lanes A–F), move coverage / drift / expectancy, or the
macro-regime chip? Load the `long-screen` skill before touching that code.** It holds
Lane F's direction inversion (coverage is the probability of the WIN, the opposite of
every other lane), Lane E's four gates and its two-sided tail split, Lane A's structural
coverage refusal, the `moves:` schema-2 pair shape, and `macroRegime`’s sign convention.

It was moved out of this file because it is ~36 KB of reference for one screen and was
loading into every session. The rules in it are not softer for living there — a change
to `longRow()`, any lane builder, `attachCoverage`, `expectancyFrom`,
`probBeyondBreakeven`, `collectMoveSeries`, `collectMacroState`, or the Long tab
rendering in `dashboard.html` should load it first.

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

CSS custom properties in `:root`. Never hardcode colors or font stacks — use the
variables. The full token list is the `:root` block at the top of `dashboard.html`.

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

## Named failure modes

Nine failure modes have been named in this repo, each from a specific incident. The
assertion is here; the incident narrative, post-mortem and harness detail behind each
one is in [`docs/failure-modes.md`](docs/failure-modes.md) under the same heading.

- **No hit rate goes on screen without its base rate** — [evidence](docs/failure-modes.md)
- **A single negative probe right after a deploy is UNCONFIRMED, not a failure** — [evidence](docs/failure-modes.md)
- **Name the population a distribution was measured over** — [evidence](docs/failure-modes.md)
- **A workaround adopted to make a test safe is evidence about production** — [evidence](docs/failure-modes.md)
- **When you remove a fallback, audit what it was BOUNDING — not just what reads it** — [evidence](docs/failure-modes.md)
- **The frontend is ALWAYS newer than the Worker for a while — render that state** — [evidence](docs/failure-modes.md)
- **`return ''` in a render helper is where this hides — audit them all** — discipline retained below; [evidence](docs/failure-modes.md)
- **A newly rendered figure gets eyes on it before the commit is done** — [evidence](docs/failure-modes.md)
- **An empty comparison is not a pass** — [evidence](docs/failure-modes.md)

### `return ''` in a render helper is where this hides — audit them all

Fixing `macroChip` prompted an audit of every early empty-string return in
`dashboard.html`, and **two of the four were the same bug**. The distinguishing
question is one line: **is this withholding a CONTROL, or a FACT?**

| site | returns `''` when | verdict |
|---|---|---|
| `alignChip` | `align` is absent | **BUG — fixed.** Its own comment says *"Renders ALWAYS"* and it did not. A blank made "no alignment field exists" identical to "the tag was never built", on a tag whose entire status is *informational and disabled by measurement*. Now renders `no tag`, distinct from `no read` (which means the rating store was consulted and held nothing). |
| `candDetail` | `coverage1y`, `coverage3y` and `expectancyMean` are all null | **BUG — fixed.** `COVERAGE_MIN_INDEPENDENT` nulls coverage **deliberately**, and the Worker computes the exact reason. **Measured against production: 66 of 757 candidates hit this branch and ALL 66 carried a reason.** Sixty-six computed refusals, none on screen. See below — the 66 are structural, not a thin sample. |
| `laneSortLine` | lane is D or E | **CORRECT.** A sort control, not a finding. An absent control makes no claim about data, so there is no state to mistake for another. |
| `longDetail`'s lane map | a lane has no entries | **CORRECT, for a structural reason.** A lane that finds nothing still emits an entry with its own status and reason, and `readLongRow()` guards `row.schema === LONG_SCHEMA` by strict equality — so a row with a different lane set is rejected whole and renders `not-loaded`. Measured: 0 lanes absent across 33 rows × 6. |

**A REFUSED MEASUREMENT IS A FINDING, NOT AN ABSENCE.** That is the whole of it.

The worked audit behind the `candDetail` row — why all 66 Lane A refusals are
arithmetic rather than a thin sample, and so evidence for the line above rather than
a caveat on it — is in
[`docs/failure-modes.md`](docs/failure-modes.md), *"The 66 are ARITHMETIC, not a thin sample"*.

## Verification standard

Before reporting a task complete, state which checks were run and print the actual values. "Verified" without a number is not verification. This applies to every numeric output, every identifier taken from an external source, and every calculation.

Print, don't assert. Show computed values alongside expected values, with deviations. The Black-Scholes check was trustworthy because it printed 0.52160473 against 0.52200000; a claim that it passed would not have been.

Check against a different source than the one being tested. Cross-check a formula against a different algorithm, an identifier against the live API, a field name against the live response. Documentation consensus is not verification — three sources agreed on the wrong FINRA field name while the live API had the right one in our own code.

Name the verification method's blind spot. curl cannot catch CORS preflight failures. A DOM shim cannot catch CSS layout problems. Local dev without .dev.vars cannot exercise live-credential paths. When the available method can't reach the failure mode, say so explicitly rather than reporting a pass — a bug shipped this session because preflight was modeled by hand instead of observed in a browser.

Verify against a second case before declaring success. One passing ticker is a coincidence; three is a pattern.

## Before every task

Read CLAUDE.md and ARCHITECTURE.md first. Do not work from assumptions carried over from earlier in a session or from my prompt — I have been wrong about what exists in this codebase multiple times (a 13F override map that doesn't exist, a cached risk-free rate that wasn't there, mock generators that were dead code, the term-structure sign). If my instruction contradicts the code, say so before acting.

**The authoritative record is six files, not two.** No one of them is complete on its
own, and the two skills load on demand rather than every session:

| file | holds | loaded |
|---|---|---|
| `CLAUDE.md` | the rules, the Worker invariants, workflow | every session |
| `ARCHITECTURE.md` | data sources, design decisions, build position | on request |
| `.claude/skills/worker-internals/SKILL.md` | Worker endpoints, KV keys and TTLs, cron, external data sources | on demand |
| `.claude/skills/long-screen/SKILL.md` | Lanes A–F, move coverage, macro regime | on demand |
| `docs/rules-evidence.md` | the measured runs behind rules 1–7 | on request |
| `docs/failure-modes.md` | the incident record behind the nine named failure modes | on request |

Check any change against the subrequest budget (rule #1 — 10,000 per invocation, **one pool**: external `fetch()` and KV/binding calls both count against it) and against rule #2: no calendar logic in the cron expression, and any new Pacific hour must fall inside the UTC window under **both** PST and PDT. Both have caused silent failures.

## After every task

Update the docs in the same task, not later. Any new KV key, constant, secret, endpoint, or threshold goes into CLAUDE.md as it is created. Docs that lag the code are how a session starts by acting on false premises.

Report what you could not verify, separately and explicitly. That section has been the most useful part of every report this session.

Kill background processes. No wrangler dev, wrangler tail, or http servers left running between tasks.

## Adding a new failure mode

When a bug is found, add a rule naming the specific failure that produced it. Rules tied to a concrete incident are followed; abstract ones are not.

cron execution history doesn't exist unless observability logs are enabled, and observability.enabled seeds logs.enabled in wrangler's normalization — writing only the nested table silently disables both.
