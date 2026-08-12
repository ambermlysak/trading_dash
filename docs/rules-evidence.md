# Rule evidence — the measured runs behind rules 1–7

The seven numbered rules under *"⚠ Read this before writing any code"* stay resident
in [`CLAUDE.md`](../CLAUDE.md): the imperative, every constant and threshold, every
table a change is checked *against*, and one line of reason.

**This file holds what makes them credible on re-reading** — the dated instrumentation
runs, the measured cost tables, the "what it used to say and why it changed" passages,
and the incident write-ups. One section per rule, same heading text, linked both ways.

**Rule 3 is not here.** At 709 chars it is entirely rule and was left whole in
`CLAUDE.md`; splitting it would have saved nothing.

Nothing here was reworded. A few sentences appear in both files by design: where a
paragraph carried both a gate and its evidence, the gate sentence was lifted into the
resident rule and the full paragraph kept here.

---

### 1. Subrequest budget: 10,000 per invocation, one pool — and the cap is no longer the constraint

> Rule text is resident in [`CLAUDE.md`](../CLAUDE.md) under the same heading.
> This is the evidence behind it.

**It is ONE pool, and this rule has now been wrong in both directions.** The
original said "every `fetch()` is a subrequest" and budgeted KV against the same
ceiling. The correction over-corrected: it claimed external fetches and binding
operations were *separate buckets*, and that a handler reading 40 KV keys and
fetching 3 URLs cost **3**. It costs **43**. Verified 2026-08-08 against
[developers.cloudflare.com/workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/),
which defines a subrequest as *"any request a Worker makes using the Fetch API or
to Cloudflare services like R2, KV, or D1"*, and lists the paid internal-services
limit as matching the configured limit rather than sitting in its own bucket:

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

**Quote `capCost`, never `extFetches`.** `extFetches` alone was reported as the
cost of a long-screen ticker and understated it by **125–143%**: measured on AAPL
2026-08-08, premium-warm was 4 external + 5 binding = **9**, and premium-cold
7 external + 6 binding = **13**. Those binding figures are SUPERSEDED — measured
live 2026-08-11 the path is premium-warm **4 ext / 8 bind / 12 cap** and
premium-cold **7 ext / 11 bind / 18 cap**, the growth being move coverage, pooled
calibration and the shared-header write. The `/api/long/batch` and `/api/premium/batch` endpoints
were documented as "zero outbound calls"; that is true of *fetches* and false of
*subrequests* — they cost **exactly one KV read per symbol**, so a 22-name
watchlist paints for **22** against the cap, not 0. Both now report `_instr`.

Observed 2026-08-10 on the `forward-returns+moves` branch: `collectMoveSeries`
reported `extFetches 5, bindingOps 76` where its own structure predicts `2` and
`73`. The +3 landed on **both** counters, `fillForwardReturns` was demonstrably
mid-run (its `/BTC` failure logged before the sweep's line and its summary after),
and `invocationFetches` read 5 at stamp time against the ~45 chart fetches the
fill went on to make. The sweep's own cost was almost certainly the predicted
`2 / 73`; the stamped figure is the branch's, not the job's.

#### Provenance audit — every per-job figure in these docs, 2026-08-10

Rule #1 covers this going forward, but the figures already written down were
measured the same way and had to be re-classified rather than left implicit.

**The criterion is that contamination is strictly ADDITIVE.** A concurrent job can
only add ops to another's bracket, never remove them. So a figure that equals its
structural derivation *exactly* provably contains nothing foreign, whatever branch
it came from. Only figures that **exceed** their derivation need explaining.

Two things are isolated by construction and need no argument: every **request-path**
figure (one HTTP request is one invocation running one job), and every cron branch
that dispatches **one** `waitUntil` — `morning-briefing`, `midday-pulse` and
`13f-slice`. `eod+iv-sweep+macro` dispatches THREE and `forward-returns+moves` two.

| figure | branch | derivation | verdict |
|---|---|---|---|
| move sweep N=22 — `2 / 47 / 49` | shared (2pm) | `ceil(22/20)=2`, `2·22+3=47` | **SURVIVES** — exact, so uncontaminated even on a shared branch |
| move sweep N=35 — `5 / 76 / 81` | shared (2pm) | `2 / 73 / 75` | **CONTAMINATED** — exceeds by +3/+3; labelled at the call site |
| one EOD summary — `12` fetches | shared (1:15pm) | 11 index charts + 1 news search = 12 | **SURVIVES** — exact; the IV sweep had already deduped |
| one 13F manager — `3` | isolated (10am) | submissions + filing index + info table | **SURVIVES** |
| long tiers `9 / 13 / 17`, `16 / 17 / ~20` | request path | — | **SURVIVES** — isolated by construction |
| `/api/long/batch` 22, cache hit 1 | request path | 1 KV read/symbol | **SURVIVES** |
| `primeTabs()` page load ~133–140 | request path | per-request table | **SURVIVES** |

**So exactly one documented figure fails the audit, and it is the newest one.**
That is the reassuring outcome, but it is reassuring *because of the additivity
argument*, not because the measurements were careful — before that argument every
cron figure was equally suspect.

**Separately, the AAPL 2026-08-08 table below is STALE, not contaminated** — a
different fault that this audit surfaced. Its `5` and `6` binding figures predate
move coverage and pooled calibration. Measured live 2026-08-10: premium-warm
`4 / 8 / 12`, premium-cold `8 / 10 / 18`. The `+3` matches this file's own
`6 → 8 → 9` history exactly, so the table is superseded rather than wrong for its
date, and it is marked as such where it appears.

**Coverage is declared, not assumed.** `instrWrapBindings` does not name
`REC_LOG` — it walks `env` and wraps everything binding-*shaped* (an object or
function carrying at least one callable member; a secret is a string, a `[vars]`
JSON entry has no methods). So a binding added later is counted the day it
appears. What it wrapped and what it could not ride along in every payload,
because a total that silently omits a source is the `build13FIndex` failure in
different clothing. It sits in front of every KV call in the Worker, so it fails
safe in the strongest sense: any fault returns the **original, unwrapped `env`**
and degrades the report to `bindingsWrapped: []`.

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

---

### 2. The cron expression is a coarse wakeup — put no calendar logic in it

> Rule text is resident in [`CLAUDE.md`](../CLAUDE.md) under the same heading.
> This is the evidence behind it.

**There is exactly one expression again as of 2026-08-10.** A temporary
every-5-minutes diagnostic probe ran as a second `crons` entry from 2026-08-08,
paired with a `PROBE_CRON` constant that suppressed its dispatch. It existed
because three post-deploy boundaries produced no `[cron]` line while observability
logs were off — silence that was uninterpretable rather than informative. It did
its job (invocations confirmed, weekend gate observed firing, the Monday 6:00am
run clean) and **both halves were removed together**. If a probe is ever needed
again, add the trigger *and* its suppression in the same commit and remove them
the same way: a trigger without suppression triples the firings inside every
dispatch window, which dedup absorbs on a successful run but not on a failed
morning briefing — that retries by design, turning 2 attempts into 6.

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

That one has bitten twice too. A premium pre-open anchor at 5:00am PT only
existed under PST. The 13F job sat at 3:00pm PT and had **never executed under
PST** — it now runs at 10:00am PT (17:00/18:00 UTC), inside the window in both
regimes.

---

### 4. CORS preflight: any custom request header must be allowlisted

> Rule text is resident in [`CLAUDE.md`](../CLAUDE.md) under the same heading.
> This is the evidence behind it.

Adding `x-dash-key` to the frontends without adding it to `CORS_ALLOW_HEADERS`
took the whole site down — **12 requests blocked client-side, nothing in the
Worker logs, because nothing arrived.** The Worker was working perfectly; the
browser never called it.

**curl cannot catch this class of bug, and neither can I without a browser.**
A direct `curl -H 'x-dash-key: …'` never preflights — it just sends the header —
so every one of my layer-2 origin tests passed against a Worker that no browser
could talk to. That is exactly how this shipped.

---

### 5. The spend gate: `/api/claude` is gone

> Rule text is resident in [`CLAUDE.md`](../CLAUDE.md) under the same heading.
> This is the evidence behind it.

`POST /api/claude` accepted a caller-supplied `messages` array and forwarded it to
Anthropic on the owner's key. It had **no authentication** — `isAllowedOrigin()`
returned `true` when `Origin` was absent, so any non-browser client with the URL
could generate anything at all. It is now a **410** pointing at the replacement.

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

---

### 6. `DASH_KEY` is only live once it is pushed to GitHub Pages

> Rule text is resident in [`CLAUDE.md`](../CLAUDE.md) under the same heading.
> This is the evidence behind it.

- Commit `35206f0`, *"Set AI gate secret in frontend"*, replaced the placeholder
  `REPLACE_WITH_YOUR_AI_GATE_SECRET` with **another placeholder**,
  `YOUR_STRING_HERE`. The message asserts a step that did not happen, which is
  worse than no commit at all — the log becomes evidence against the real cause.
- The real key was then pasted into both files correctly and the site still
  failed **identically**, because the change was staged and never committed. The
  live page was still serving `YOUR_STRING_HERE`.

**Check what the local server is actually serving before debugging the page.**
`http-server` serves `.`, and its command line does not record which directory
that was. A run started from a **stale copy of the project** served a 148,135-byte
`index.html` from Aug 4 — the same app, same title, but 3,082 lines with
`API_BASE` at line 865 — which **predates the gate entirely**: zero occurrences of
`DASH_KEY`, zero of `x-dash-key`. So the page sent no gate header, the Worker
returned a perfectly correct 401, and it was indistinguishable on screen from a
wrong secret. Meanwhile every curl test passed, because curl read the key from the
*working-tree* file rather than the one being served.

---

### 7. A job that never runs produces no evidence — log every dispatch decision

> Rule text is resident in [`CLAUDE.md`](../CLAUDE.md) under the same heading.
> This is the evidence behind it.

Rule #2 is about *why* the Friday cron was wrong. This one is about why it took
**weeks** to notice, which is the more expensive half.

A cron that does not fire writes nothing. No error, no warning, no log line, no
`errors` count in Cloudflare's telemetry — the same silence as a healthy idle
system. There was nothing to grep for, because the absence of a thing is not a
thing. The bug was eventually found only by pulling `workersInvocationsAdaptive`
and noticing a **missing** quarter-hourly heartbeat on two Fridays: a diagnosis
built from a hole in a chart, not from any output the app produced.

#### Every cron job goes through `dispatchJob()` — a sibling must not be able to kill it

Branches run two or three jobs. **Measured 2026-08-11 by forcing each failure
locally and reading the outcome from KV state**, because a failing invocation
loses its console output and the logs were not a usable instrument — each job
stamps its own key on success, so the presence of `daily:eod` / `ivsweep:last` /
`macrosweep:last` is the decisive evidence:

| forced failure | dispatch | raw `ctx.waitUntil` | via `dispatchJob` |
|---|---|---|---|
| macro **rejects**, dispatched last | 3rd | HTTP 500 · eod ✓ iv ✓ macro ✗ | HTTP 200 · eod ✓ iv ✓ macro ✗ |
| macro **rejects**, dispatched first | 1st | HTTP 500 · eod ✓ iv ✓ macro ✗ | — order is irrelevant |
| **synchronous throw** at dispatch | 1st | HTTP 500 · **ALL THREE ABSENT** | HTTP 200 · **all three present** |

**A rejected promise never reached its siblings, in either dispatch position. A
synchronous throw took out the entire branch** — including the two jobs that had
nothing wrong with them, because everything after the throwing line is never
reached.

That second row was not reachable at the time: every job is an `async function`,
which converts a synchronous throw into a rejected promise. But that was a
property of **each job**, not of the dispatcher — one ordinary refactor from being
untrue, with a whole branch as the blast radius and nothing on screen to say so.

That produced the worst two hours of this investigation. `wrangler tail` streams
**live events only** — it shows what happens while you are watching, and retains
nothing. With logging disabled, a quiet tail cannot distinguish:

- the cron did not fire, from
- the cron fired and nothing was kept.

The bug was ultimately found through the **analytics** side, which worked the
whole time: a quarter-hourly invocation heartbeat present on Sun–Thu and missing
on both Fridays. That is the fallback when logs are off — counts and timestamps,
never message content. See the diagnosis recipe: pull
`workersInvocationsAdaptive` for the script, bucket by second-of-minute, and look
for the repeating offset that marks a cron firing.
