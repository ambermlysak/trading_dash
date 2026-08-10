# Pre-sweep baseline — scratch reference

> **THIS IS A SCRATCH REFERENCE, NOT DOCUMENTATION.** It exists so the comparisons
> in item 4 survive a session compaction. It is a frozen snapshot of numbers as
> measured on one afternoon, not a description of how the system works. Nothing
> here is maintained. When item 4 is complete this file has served its purpose and
> can be deleted. For how anything actually works, read `CLAUDE.md` and
> `ARCHITECTURE.md`, which are maintained and authoritative.

- **Written:** 2026-08-10, ~08:40 PT
- **Deployed commit at time of writing:** `e56c57e` — deployed 2026-08-10T15:37:21Z
  (08:37 PT), confirmed live by black-box probe (`calibration.ratingMinN = 10`,
  `sortDisabled = true`).
- **Repo HEAD:** `e56c57e`
- **Critical context:** the 2:00pm PT `forward-returns+moves` cron branch **has not
  yet fired**. There are **zero `moves:` keys** and **no `calib:pooled`** in
  production KV. Every figure below was computed **on the fly** from Yahoo spark
  data, never from a stored `moves:` value. That is the entire point of the file.

---

## 1. `expectancyEpisodesTo50` distribution, computed ON THE FLY

**Item 4(b) compares stored-pair output against exactly these tables.** A shift
means the storage round-trip is losing something — most likely `startIdx`
precision or ordering.

### How these were produced (needed to reproduce)

Two different populations were measured. **Do not mix them up** — they use
different strike ranges and produce different totals.

Common to both:

- tickers: `NVDA, PLTR, QUBT, AAPL, JPM, MRK, TSLA, APP` (8)
- horizons: `N ∈ {5, 10, 20, 45, 90}` (180 and 365 never resolve at a 3y range)
- series: `yahooSparkCloses(syms, '3y', 4, {withTimestamps:true})`, then
  `buildMoveSeries(t, closes, '2026-08-07')`
- structure: `long-call`, `strike = spot × km`, `debit = spot × 0.03 × 100`
  (per contract), `breakeven = strike + spot × 0.03`
- scored via `expectancyFrom(arr, st, spot, be, N)`
- only candidates with **≥1 winning window** are counted

| population | strike multipliers `km` | totals |
|---|---|---|
| **REALISTIC** (what Lane B/C actually select) | `0.95, 1.00, 1.03, 1.06, 1.10` | 353 = **155 (1y) + 198 (3y)** |
| **WIDE** (used for the top3Share comparison in §2) | `1.00, 1.05, 1.10, 1.20, 1.35, 1.60, 2.00` | 323 = 120 (1y) + 203 (3y) |

### REALISTIC — trailing 3y (n=198) ← the table the threshold was set from

| episodesTo50 | count | cum% |
|---|---|---|
| 1 | 53 | 26.8% |
| 2 | 51 | 52.5% |
| 3 | 31 | 68.2% |
| 4 | 15 | 75.8% |
| 5 | 12 | 81.8% |
| 6 | 9 | 86.4% |
| 7 | 3 | 87.9% |
| 8 | 6 | 90.9% |
| 9 | 6 | 93.9% |
| 10 | 1 | 94.4% |
| 11 | 2 | 95.5% |
| 13 | 2 | 96.5% |
| 16 | 2 | 97.5% |
| 17 | 1 | 98.0% |
| 20 | 1 | 98.5% |
| 21 | 1 | 99.0% |
| 22 | 1 | 99.5% |
| 25 | 1 | 100.0% |

deciles: **p10 1 · p25 1 · p50 2 · p75 4 · p90 8 · max 25**
headline: **==1 on 26.8% · ≤2 on 52.5% · ≤3 on 68.2%**

### REALISTIC — trailing 1y (n=155)

| episodesTo50 | count | cum% |
|---|---|---|
| 1 | 79 | 51.0% |
| 2 | 35 | 73.5% |
| 3 | 22 | 87.7% |
| 4 | 10 | 94.2% |
| 5 | 2 | 95.5% |
| 6 | 3 | 97.4% |
| 7 | 2 | 98.7% |
| 8 | 1 | 99.4% |
| 9 | 1 | 100.0% |

deciles: **p10 1 · p25 1 · p50 1 · p75 3 · p90 4 · max 9**
headline: **==1 on 51.0% · ≤2 on 73.5% · ≤3 on 87.7%**

> The 1y table is recorded for completeness only. **Expectancy never resolves on
> the 1y array** — the 1y series is a suffix of the 3y one, so `sorted3y === null`
> implies `sorted1y === null`. See the design note in `ARCHITECTURE.md`. The 51%
> figure describes a population that does not reach the expectancy code.

### WIDE — for cross-reference with §2

- 1y (n=120): 1→77 (64.2%), 2→25 (85.0%), 3→12 (95.0%), 4→5 (99.2%), 5→1 (100%);
  p50 1, p75 2, p90 3, max 5
- 3y (n=203): 1→103 (50.7%), 2→50 (75.4%), 3→21 (85.7%), 4→7, 5→7, 6→4, 7→4, 8→3,
  9→2, 11→1, 13→1; p50 1, p75 2, p90 5, max 13
- combined (n=323): 1→180 (55.7%), 2→75 (78.9%), 3→33 (89.2%), 4→12 (92.9%),
  5→8 (95.4%), 6→4, 7→4, 8→3, 9→2, 11→1, 13→1; p50 1, p75 2, p90 4, max 13

---

## 2. The superseded naive `top3Share`, on the WIDE population (n=323)

`expectancyTop3Share` was removed in `fbb53c5`/`20d5f9f`. These are the numbers
that justified replacing rather than rewording it.

| | |
|---|---|
| old flag fired (`top3Share > 0.40`) | **60** |
| candidates resting on a single episode (`episodesTo50 == 1`) | **180** |
| overlap between the two | **54** |
| single-episode candidates the old flag **missed** | **126** |
| range of `top3Share` *within* the `episodesTo50 == 1` bucket | **2.1% – 100%** |

`top3Share` distribution across the same 323:

| bucket | count | cum% |
|---|---|---|
| 0–10% | 122 | 37.8% |
| 10–20% | 87 | 64.7% |
| 20–30% | 33 | 74.9% |
| 30–40% | 21 | 81.4% |
| 40–60% | 16 | 86.4% |
| 60–80% | 15 | 91.0% |
| 80–101% | 29 | 100.0% |

`top3Share` range by episode count:

| episodesTo50 | n | top3Share min..max | median winners |
|---|---|---|---|
| 1 | 180 | 2.1% .. 100.0% | 49 |
| 2 | 75 | 1.7% .. 73.6% | 83 |
| 3 | 33 | 2.1% .. 22.7% | 102 |
| 4 | 12 | 3.3% .. 17.4% | 172 |
| 5 | 8 | 2.7% .. 13.9% | 195 |
| 6 | 4 | 4.0% .. 13.8% | 299 |
| 7 | 4 | 3.5% .. 10.0% | 335 |
| 8 | 3 | 3.5% .. 9.0% | 171 |

---

## 3. Per-request binding cost, as of `e56c57e`

`/api/long/:ticker?refresh=1`, crumb already in the isolate's memory. **Must still
sum to exactly 9** — an unattributed op is how this compounds silently.

```
riskFreeRate (econ:dgs3mo)   1     directionalRead (analysis:, rec:)   2
readPremiumRow               1     calib:pooled                        1
recordIvSample (long-live)   1     readMoveSeries                      1
ivHistory (list)             1     storeLongRow                        1
                                                              total    9
```

Tier (three consecutive `?refresh=1` on one local isolate, PLTR):

| tier | ext | binding | capCost |
|---|---|---|---|
| crumb in isolate memory | 7 | 9 | **16** |
| crumb in KV, not memory | 7 | 10 | **17** ← common in production |
| crumb fully cold | 9 | 11 | **~20** |

History of the binding figure: **6** before move coverage → **8** after it
(`readMoveSeries` + `recordIvSample`) → **9** after pooled calibration
(`calib:pooled`).

**PROVENANCE (added 2026-08-10).** Every figure in this section is **request-path
and therefore isolated by construction** — one HTTP request is one invocation
running one job — except the move sweep below, which runs on the two-job 2:00pm
branch. See the audit in CLAUDE.md rule #1. Note also that the tier figures here
are `?refresh=1` on a **premium-cold** path; premium-warm is one op lower because
`ivHistory()` is skipped.

Other measured costs:

- **move-series sweep, 22 symbols:** `extFetches 2`, `bindingOps 47`,
  `capCost 49`. The 2 is the whole point — spark takes 20 symbols per request.
  **SURVIVES the provenance audit despite the shared branch**: contamination is
  strictly additive, and `2 = ceil(22/20)` and `47 = 2·22 + 3` are the exact
  structural derivations, so nothing foreign is in them. The N=35 re-measurement
  (`5 / 76 / 81` against a derived `2 / 73 / 75`) is the contaminated one.
- `/api/long/batch`, 22 symbols: capCost 22 (one KV read per symbol)
- warm cache hit on `/api/long/:ticker`: capCost 1
- pooled scan **if it had been on the request path**: `list('rec:')` + 63 gets =
  **64 binding ops**. It is not; `fillForwardReturns` already does this scan.

---

## 4. Calibration state at `e56c57e`

**`rec:` keys — 63 total, 290 resolved outcomes** (`rec:JPM` needed three read
attempts; earlier figures in this session said 62 keys / 289 resolved because JPM
was missing. JPM contributes 1 BUY, resolved).

Pooled per-rating: **BUY 113 · HOLD 173 · SELL 4**

Resolved-count distribution across the 63:

| resolved | tickers |
|---|---|
| 0 | 13 |
| 1–2 | 23 |
| 3–5 | 5 |
| 6–9 | 14 |
| 10–19 | 4 |
| 20+ | 3 |

**The 7 tickers clearing `REC_CALIB_MIN_N` (10) on their own**, and what they
rendered *before* the per-rating floor landed:

| ticker | total n | BUY n | BUY hit (pre-floor) | SELL n |
|---|---|---|---|---|
| AAPL | 22 | **2** | 100% | 0 |
| AMD | 28 | **1** | 100% | 0 |
| CAVA | 10 | **1** | 100% | 0 |
| PLTR | 32 | **1** | 100% | 0 |
| APP | 10 | 9 | 67% | 0 |
| GOOGL | 10 | 10 | 0% | 0 |
| NVDA | 19 | 19 | 47% | 0 |

No ticker has a SELL cell at all. With `REC_RATING_MIN_N = 10` all four ⚠ rows and
APP go null; only GOOGL and NVDA still publish a BUY rate.

Watchlist tickers' own resolved counts:

```
PLTR:32  NVDA:19  AMD:28  AAPL:22  AMZN:9   GOOGL:10 QUBT:7  TWLO:7
NOW:7    TSM:5    MU:7    APP:10   CRCL:5   CRWV:7   MRK:2   UNH:1
TSLA:1   PANW:9   RDDT:6  CAVA:10  JPM:0    HOOD:5
```

(JPM shows 0 here — the dump used for the per-ticker table predates the JPM
re-read. Its single entry is in the 290 pooled total.)

**`analysis:` keys — 35 total: 29 HOLD · 6 BUY · 0 SELL.** Zero tickers carry a
SELL rating, so the pooled SELL cell had no rendering path in practice even before
the floor nulled it.

**PLTR's shape**, since it is the canonical example: 32 resolved, **31 HOLD**,
1 BUY with `fwd20 = 14.64`. Its bar is 10.89%, so that single BUY cleared the
magnitude test too — pre-floor it rendered **100% on both**.

`affectsSort` before pooled calibration: **7 of 63**. After: 63 of 63. After the
sort disable in `e56c57e`: **0 of 63** (`affectsSort` is false everywhere).

---

## 5. Shipped edge figures — and the superseded ones

**AUTHORITATIVE (population-matched, what `e56c57e` computes):**

| outcome | rate | base rate | edge | n |
|---|---|---|---|---|
| sign-scored BUY (`fwd20 > 0`) | **53.3%** | **61.4%** | **−8.1 pts** | **75** |
| magnitude-scored BUY | **17.3%** | **34.3%** | **−16.9 pts** | **75** |

Both over the same 75 benchmarked outcomes. Pooled magnitude bar (median across
entries): **7.38%**. `benchmarkedN` 75 vs `n` 112 for the sign cell — the gap is
BUY entries on tickers with no stored move series.

**SUPERSEDED — DO NOT RECONCILE AGAINST THESE:**

| outcome | rate | base rate | edge | n |
|---|---|---|---|---|
| sign-scored BUY | ~~53.9%~~ | ~~61.5%~~ | ~~−7.5 pts~~ | ~~76~~ |
| magnitude-scored BUY | ~~18.4%~~ | ~~34.3%~~ | ~~−15.9 pts~~ | ~~76~~ |

Those came from the standalone analysis before the population-matching fix, which
took the rate over all 112 BUY outcomes and the benchmark over the 75 with a
series. On the unmatched basis the sign rate reads **48.2%** against 61.4%. The
matched rate is 53.3%. The superseded figures appear in this session's transcript
and in the `b56d18a` commit message; they are wrong and are corrected in
`ARCHITECTURE.md`.

---

## 6. Everything else needed to reproduce item 4, that lives only in session history

### 6.1 Per-ticker magnitude bars and base rates (watchlist, 3y, N=20)

Bar = median 20-session **absolute** move, percent. Base = `P(clear bar UP)`.
Computed on the fly 2026-08-10; item 4 should re-derive these from stored `moves:`.

| ticker | bar % | base rate |
|---|---|---|
| CRCL | 19.2 | 15.9% |
| QUBT | 17.9 | 27.4% |
| CRWV | 17.7 | 27.9% |
| RDDT | 15.0 | 33.2% |
| HOOD | 13.3 | 38.0% |
| APP | 12.9 | 36.5% |
| CAVA | 12.8 | 28.7% |
| MU | 11.0 | — |
| PLTR | 10.9 | 38.7% |
| AMD | 10.5 | 33.2% |
| TWLO | 8.8 | 31.6% |
| TSLA | 8.4 | 26.8% |
| TSM | 7.5 | 40.2% |
| PANW | 7.4 | 33.7% |
| NVDA | 7.4 | 36.0% |
| NOW | 6.6 | — |
| GOOGL | 6.2 | 34.3% |
| UNH | 5.5 | 27.2% |
| AMZN | 5.3 | 32.3% |
| AAPL | 5.2 | 32.9% |
| JPM | 4.7 | 39.8% |
| MRK | 4.1 | — |

(Three base rates were not captured in the printed output; bars are complete.)

### 6.2 KV value sizes — item 4(a) compares against these

Schema 1 (bare numbers) vs **schema 2 (`[return, startIdx]` pairs)**, same 22
tickers, same day:

| | largest | ticker | sessions |
|---|---|---|---|
| schema 1 | 35,168 B (34.3 KB) | QUBT | 751 |
| **schema 2** | **61,496 B (60.1 KB)** | **QUBT** | 751 |

Roughly 2×, as predicted. KV's ceiling is 25 MB. Schema-2 sizes ran ~59.5–60.1 KB
for the full-history names; short-history names were far smaller
(CRCL 295 sessions, CRWV 342, RDDT 597).

### 6.3 AAPL horizon nulls — item 4(a) asks for one ticker's, with the numbers behind them

Computed on the fly, 753 sessions 3y / 252 sessions 1y, `asOfClose 2026-08-07`:

| N | indep 3y | 3y | indep 1y | 1y |
|---|---|---|---|---|
| 5 | 149.6 | ok | 49.4 | ok |
| 10 | 74.3 | ok | 24.2 | ok |
| 20 | 36.65 | ok | 11.6 | ok |
| 45 | 15.73 | ok | 4.6 | ok |
| 90 | 7.37 | ok | 1.8 | **NULL** |
| 180 | 3.18 | **NULL** | 0.4 | **NULL** |
| 365 | 1.06 | **NULL** | 0 | **NULL** |

Reason strings, which item 4(a) should see reproduced verbatim from stored data:

```
N=90  1y: 252 sessions of 1y history support only 1.80 independent 90-session
          windows (162 overlapping); the floor is 4
N=180 1y: 252 sessions of 1y history support only 0.40 independent 180-session
          windows (72 overlapping); the floor is 4
N=180 3y: 753 sessions of 3y history support only 3.18 independent 180-session
          windows (573 overlapping); the floor is 4
N=365 1y: only 252 sessions of 1y history — a 365-session window needs at least 366
N=365 3y: 753 sessions of 3y history support only 1.06 independent 365-session
          windows (388 overlapping); the floor is 4
```

Short-history names (the recent-IPO case): CRCL 295 sessions, CRWV 342 — both null
at N=365 with the *too-short* reason rather than the floor reason.

### 6.4 IV sample state — item 4(c) baseline

`skip-if-exists` has **never executed live**. There is **no `long-warm` sample
anywhere** in production. Today is the first day the 1:15pm cron and a warm
`longRow` read can both touch the same key.

Samples present on 2026-08-09 (the day before), all three written by page views on
a non-trading day:

```
iv:AAPL:2026-08-09  {"atmIv":23.28,"expiry":"2026-08-17","dte":8,"spot":313.33,
                     "ts":"2026-08-09T20:04:17.505Z","src":"long-live"}
iv:AMD:2026-08-09   {"atmIv":62.74,...,"ts":"2026-08-09T14:56:00.090Z"}   (no src → handleIv)
iv:AMZN:2026-08-09  {"atmIv":30.69,...,"ts":"2026-08-09T14:48:44.471Z"}   (no src → handleIv)
```

KV metadata shape, which must be unchanged after any new write:
`{"atmIv":23.28,"spot":313.33,"dte":8}` — exactly three flat numbers. `src` rides
in the **body only**.

`ivHistory()` lengths as of 2026-08-09: **AAPL 5** (29.36, 28.38, 26.01, 23.79,
23.28 on 08-04/05/06/08/09), **NVDA 3** (35.96, 33.88, 34.28 on 08-05/06/08).

Note the front expiry moved between 2026-08-08 and 2026-08-09 because Yahoo listed
new weeklies mid-day — 08-08 resolved to `2026-08-21 / dte 13`, 08-09 to
`2026-08-17 / dte 8`. Not a code disagreement.

### 6.5 Scratchpad artefacts that will NOT survive compaction

These were built in the session scratchpad and are **not in the repo**. Item 4 must
rebuild them:

| file | what it was | how to rebuild |
|---|---|---|
| `rec-dump.json` | all 63 `rec:` lists pulled from production | `wrangler kv key list --prefix rec:` then a `get` per key |
| `rec-jpm.json` | `rec:JPM` alone (failed in the bulk pull) | retry the single get |
| `moves-{T}.json` | schema-2 payloads built from spark | `buildMoveSeries(t, closes, asOf)` |
| `pooled-bars.json` | `calib:pooled` fixture, schema 2 | `buildPooledCalibration(lists, ratesByTicker)` |
| `analysis-keys.json` | the 35 `analysis:` key names | `wrangler kv key list --prefix analysis:` |

The verification scripts (`verify-moves.mjs`, `episodes-dist.mjs`,
`floor-analysis.mjs`, `iv-parity.mjs`, `y1path.mjs`, `flagtest.mjs`,
`build-pooled.mjs`, `seed-moves.mjs`, `pull-rec.mjs`) are also scratchpad-only.
They all extract functions from `worker.js` **by source**, using a `grab()` that
must keep an `async ` prefix or an async function becomes a sync one whose
`await`s are a syntax error.

### 6.6 Gotchas that cost time this session

- **Do not build JS containing backticks or `\n` inside a bash heredoc.** The shell
  expands them and silently mangles the file. Use the Write/Edit tools. This
  corrupted `moves.check.mjs` three separate times.
- **`wrangler kv key list` output** has preamble before the JSON; slice from the
  first `[`. It also occasionally emits an auth banner instead of data — retry.
- **A single negative probe within ~60s of a deploy is unconfirmed**, not a
  failure. See the rule in `CLAUDE.md`.
- Line numbers in `worker.js` have shifted ~800 lines across this work. **Cite by
  function name.**

### 6.7 What item 4 still has to confirm

- (a) first sweep: `extFetches` (expect 2), written key count, largest schema-2
  value size, one ticker's horizon nulls with the independent numbers
- (b) `episodesTo50` from **stored pairs via `readMoveSeries`**, side by side with
  §1's REALISTIC 3y table (n=198). A shift implicates `startIdx` precision or sort
  ordering — **but read §7.1 first: as originally specified this test cannot
  isolate that.**
- (c) `skip-if-exists` firing, and the resulting `iv:{TICKER}:{DATE}` sample + `src`
- (d) `fillForwardReturns` actually wrote `calib:pooled`, and the magnitude field
  resolving against real `moves:` data rather than the seeded fixture

---

## 7. Gaps found on re-reading this file cold, 2026-08-10 ~11:45 PT

Added after compaction, before the sweep. Everything above is frozen measurement;
this section is correction to the *method* of item 4, not to any number.

### 7.1 4(b) as specified cannot isolate what it claims to

Two independent problems.

**The populations differ.** §1 was built at `asOf 2026-08-07`; the sweep stores
`asOfClose 2026-08-10`. That adds a session at the tail **and** rolls sessions off
the head of a 3y spark window. §1's structure is spot-relative — `strike = spot ×
km`, `debit = spot × 0.03 × 100`, `breakeven = strike + spot × 0.03` — so a new
spot moves every strike and every breakeven, and the candidate set is not the same
set. **A shift against the n=198 table is EXPECTED and does not implicate
`startIdx`.**

**The stated hypothesis cannot fire.** `buildMoveSeries` stores
`+r.toFixed(4)` and an integer `startIdx`, and §1's arrays came from
`buildMoveSeries` too — so both sides are already rounded identically and a JSON
round-trip of a 4dp number and a small integer is exact. "Precision loss" is not a
reachable failure here. The reachable ones are **sort ordering**, the strict
`m.schema === MOVES_SCHEMA` guard silently reading as absent, and truncation.

So run **three** columns, not two:

| column | source | what a difference means |
|---|---|---|
| (i) stored | `readMoveSeries(t, env)` | — |
| (ii) rebuilt | fresh spark, `buildMoveSeries(t, closes, <stored asOfClose>)` | **(i) vs (ii) = the round-trip.** Any difference is a real bug: ordering, schema guard, truncation |
| (iii) frozen | §1 REALISTIC 3y, n=198 | **(ii) vs (iii) = data drift.** Expected to move; not evidence of anything |

For (ii), confirm spark's last session equals the stored `asOfClose` before
comparing; if spark has moved on, say so rather than treating (ii) as faithful.
Take `spot` the same way §1 did — the last close of the series.

### 7.2 The sweep's `extFetches` is LOG-ONLY — start a tail before 2:00pm PT

`collectMoveSeries` emits its `_instr` through `console.log` (the line ending
`· ${JSON.stringify(instrSince(mark, 'complete'))}`). **Nothing writes it to KV** —
`movesweep:last` holds a bare PT date and nothing else. So 4(a)'s "expect
`extFetches` 2" is retrievable only from Workers Logs.

`wrangler tail` **streams live and retains nothing**, so it must be running before
the firing. Dashboard log search is the fallback (observability is on in
`wrangler.toml`). Note both jobs share the invocation, so `invocationFetches` will
exceed the sweep's own `extFetches`; the figure to quote is the sweep's.

The same log line carries `written / already current / not returned by spark /
thin history`. **First-sweep prediction: `skipped` = 0** — the sweep's own
skip-if-exists compares `prev.asOfClose === asOfClose` and `prev` is null
everywhere today, so expect ~22 written.

> Two distinct `skip-if-exists` mechanisms are now in play and must not be
> conflated: the **sweep's** (`prev.asOfClose`, expected NOT to fire today) and the
> **IV sample's** (§6.4, item 4(c), expected TO fire today for the first time).

### 7.3 4(d) has a first-day race — a low `magnitudeN` is not a defect

Both jobs are dispatched on the same firing under `ctx.waitUntil`, and they run
concurrently: `fillForwardReturns` first, `collectMoveSeries` second. Fill builds
`ratesByTicker` by calling `readMoveSeries` per ticker — but only at the **end** of
its walk, after the per-ticker chart fetches, so the short sweep will most likely
have written first. **It is not ordered**, and `moves:` starts empty today.

So on the first day `magnitudeN` may be **0 or partial**, and that is a race rather
than a fault in the magnitude field. It self-heals on the next firing. Do not
"fix" it on one observation; re-check tomorrow.

Related and structural, not a race: the sweep writes only the **22** watchlist
names while `listsByTicker` covers **63** `rec:` keys, so `ratesByTicker.size ≤ 22`
and `benchmarkedN < n` always. That is what §5's 75-of-112 already reflects.

### 7.4 Live preconditions, captured 11:50 PT — these expire when the crons run

Taken against production KV before either firing. **None of this is recoverable
after the fact**, which is the only reason it is here.

**Confirmed absent** (`moves:` list returned `[]`; the other three 404 on `get`,
and the successful list on the same namespace proves that is absence and not an
auth failure):

```
moves:*          0 keys      ← 4(a)'s "first sweep" premise, verified not assumed
movesweep:last   absent
calib:pooled     absent      ← 4(d) is a first write, not an overwrite
recfwd:last      absent      (2d TTL, last written Fri 08-07 — expired over the weekend)
ivsweep:last     absent      (same)
```

**4(c) is now a precise prediction rather than a wait-and-see.** 65 `iv:` keys
total, and **12 already carry today's date**, written by page views before the
cron:

| dte 7 (08-17 weekly) | atmIv / spot | dte 11 (08-21 monthly) | atmIv / spot |
|---|---|---|---|
| AAPL | 22.41 / 306.805 | CRCL | 77.73 / 64.95 |
| AMD | 54.09 / 475.79 | CRWV | 115.09 / 90.69 |
| AMZN | 28.71 / 279.26 | DELL | 82.07 / 469.055 |
| MSFT | 27.06 / 509.7 | HOOD | 60.45 / 93.36 |
| MU | 62.6 / 876 | MDB | 59.38 / 414.46 |
| | | SHOP | 49.75 / 153.84 |
| | | TWLO | 57.75 / 248.55 |

Of these, **8 are watchlist names** — AAPL, AMD, AMZN, CRCL, CRWV, HOOD, MU,
TWLO. DELL, MDB, MSFT and SHOP are not on the watchlist, so the sweep never
reaches them; they are here to explain why the key count exceeds the skip count.

> **Prediction for 4(c): `recordWatchlistIv` at 13:15 should SKIP exactly those 8
> and write the other 14.** A skip count of 8 is the pass. 0 skips means
> skip-if-exists still is not firing; 22 skips means it is matching something it
> should not.

**↑ THAT PREDICTION IS WRONG AND WAS FALSIFIED AT 13:15. Corrected in §7.6.**
It put the skip on the cron. The cron is the side that deliberately does *not*
skip.

Two documented invariants verified live in passing: KV metadata is exactly the
three flat numbers `{"atmIv","spot","dte"}`, and the front-expiry split is
coherent — names with weeklies resolve to 08-17 at dte 7, names without to the
08-21 monthly at dte 11. AAPL reads 22.41 @ 306.805 today against §6.4's 23.28 @
313.33 yesterday: same expiry, one day less, spot down ~2%.

### 7.5 The `*/5 * * * *` probe is scheduled for removal TODAY

Not drift — `wrangler.toml` (the `crons` block) and `worker.js` (`PROBE_CRON`)
both document it at length, and both carry `TODO(2026-08-10)`, which is today. It
logs `branch=none (probe · dispatch suppressed)` and returns before dispatch, so
it does **not** interfere with item 4; it only triples the line count in a tail.

It exists to prove this morning's 6:00am run was clean after the day-of-week fix,
which it has now done. Removing it is a two-file change **plus a deploy**, so it
waits until after item 4 rather than landing mid-measurement. CLAUDE.md rule #2
still says "a single cron" and should be reconciled in the same commit that
removes it.

---

## 8. Observed 13:15 PT — corrections that move the 14:00 predictions

### 8.1 The watchlist is 35, not 22 — every per-symbol figure above is undersized

`DEFAULT_WATCHLIST` in `worker.js` is the 22 names §4 lists. But
`watchlist:tickers` in production holds **33**, and both sweeps take the **union**:

```
[...new Set([...saved, ...DEFAULT_WATCHLIST])]
```

33 saved ∪ {MRK, JPM} from the default = **35**. `recordWatchlistIv` slices to 50,
`collectMoveSeries` to `LONG_MAX_SYMBOLS` (**60**) — neither clips at 35.

The 13 names in the saved list but not the default: **AVGO, APLD, INTC, ARM, SMR,
HD, MRVL, KTOS, VST, MSFT, DELL, MDB, SHOP**. So MSFT/DELL/MDB/SHOP are **on** the
watchlist; §7.4 called them off-watchlist, which was read off §4's stale 22.

**Revised 4(a) predictions.** §3's measured `binding = 2N + 3` (22 → 47 ✓) gives:

| | N=22 (§3, measured) | **N=35 (today, predicted)** |
|---|---|---|
| `extFetches` | 2 | **2** — 35 symbols ÷ 20 per spark request = 2 requests |
| `bindingOps` | 47 | **73** = 2 gets + 35 `readMoveSeries` + 35 puts + 1 put |
| `capCost` | 49 | **75** |
| keys written | ~22 | **~35** |

`extFetches 2` survives only because 35 ≤ 40. At 41 watchlist names it becomes 3,
and a future reader comparing to "2" would see a regression that is arithmetic.

### 8.2 4(c) — prediction falsified, and the mechanism is the opposite way round

Observed: `[cron] iv samples recorded for 35/35 tickers`. No skips, and all three
sampled keys were overwritten by the cron at 20:15 UTC:

| ticker | 11:50 page-view | 13:15 cron | `src` after |
|---|---|---|---|
| AAPL | 22.41 / 306.805 | **21.52 / 308.26** | *(none)* |
| TWLO | 57.75 / 248.55 | **51.72 / 250.06** | *(none)* |
| MSFT | 27.06 / 509.7 | **24.49 / 506.06** | *(none)* |

**This is correct behaviour, not a failure.** `recordIvSample(ticker, snap, env,
{ src, skipIfPresent })` takes the skip as an *option*, and the precedence comment
above it says plainly: *"the warm path passes `skipIfPresent` and the cron does
not — watchlist names: the 1:15pm cron always wins, whatever the page does."*
`recordWatchlistIv` calls it with **no options**, so it overwrites by design; the
absent `src` field is the signature of a cron write.

So **skip-if-exists lives on the warm `longRow` path** (`{ src: 'long-warm',
skipIfPresent: true }`), not on the cron, and item 4(c) has **not** been exercised
by the sweep. It needs a warm long request:

1. read `iv:{T}:2026-08-10` — currently cron-written, no `src`, ts ~20:15
2. `GET /api/long/{T}?refresh=1` — writes `src: 'long-live'` (the live path passes
   `src` only, no skip)
3. `GET /api/long/{T}?refresh=1` again — `premium:{T}` is now fresh, so the **warm**
   branch runs and passes `skipIfPresent: true`
4. read the key again

**Pass = the body after step 4 is byte-identical to step 3** (same `ts`, still
`long-live`). A `long-warm` src appearing on a ticker that already had a sample
means the skip did not fire. Nothing logs `'skipped'`, so the unchanged `ts` is
the only observable.

Separately confirmed working at 13:30: `[cron] iv sweep already ran today,
skipping` — that is the sweep-level daily dedup on `ivsweep:last`, a different
mechanism from the per-key skip and not what 4(c) is about.

### 8.3 4(d) — `benchmarkedN` should now RISE above 75

§5's 75-of-112 was computed when only 22 names could have a move series.
`ratesByTicker` can now reach **35**, so more BUY entries carry a bar and
`benchmarkedN` should increase. The edge figures will therefore move off
53.3 / 61.4 / −8.1 legitimately — **that is a population change, not a
regression**, and it must be reported as one. The §5 figures stay authoritative
for the 22-name population they describe.

### 8.4 ITEM 4 RESULTS — all four complete, 14:00–14:10 PT

Sweep log, verbatim:

```
[cron] 2026-08-10 Mon 14:00 PT · branch=forward-returns+moves
[cron] forward fill /BTC: chart failed — Yahoo 404
[cron] move-series sweep: 35 written, 0 already current, 0 not returned by spark,
       0 with thin history · {"extFetches":5,"bindingOps":76,"capCost":81,
       "settledRejected":0,"invocationFetches":5,"invocationCapCost":82,
       "scope":"scheduled","measured":true,"bindingsWrapped":["REC_LOG"],
       "bindingsSkipped":[],"cacheApiCounted":false,"phase":"complete"}
[cron] forward fill: 23 value(s) across 42 ticker(s)
[cron] pooled calibration: n=300 across 50 ticker(s), magnitude n=276 over 33 with a bar
```

**(a) PASS with one caveat.** 35 keys written, `skipped 0` as predicted (`prev`
was null everywhere), `settledRejected 0`, `phase: complete`. Largest value
**QUBT 61,359 B** against §6.2's 61,496 B — schema-2 pair shape confirmed at
scale. `extFetches 5 / bindingOps 76` against the predicted `2 / 73`: the +3 on
both counters is the concurrent `fillForwardReturns` inside the same `_instr`
bracket, now written up as the concurrency caveat in CLAUDE.md rule #1. AAPL's
horizon nulls read back from stored KV exactly as §6.3 froze them — nulls at
3y{180, 365} and 1y{90, 180, 365}, all five reason strings verbatim, at 751
sessions vs 753 (the 3y window rolled).

**(b) PASS — the round-trip loses nothing.** Ran as the three-column test from
§7.1. Parity held first: all 8 tickers' stored `asOfClose` equals fresh spark's
last session (2026-08-10), so column (ii) is a faithful rebuild.

- **(i) vs (ii): identical.** 40 non-null horizon arrays compared pair-by-pair,
  **0 differing**, and the scored distributions match exactly at n=198.
- **(ii) vs (iii): 5 of 198 candidates moved**, all between adjacent bins in the
  sparse tail — `4` 16↔15, `5` 13↔12, `6` 7↔9, max 26 vs 25. Pure drift.

Every headline figure is unchanged from the frozen table: **==1 26.8% · ≤2 52.5%
· ≤3 68.2% · p50 2 · p75 4 · p90 8**. `EPISODE_CONCENTRATION_WARN = 1` still rests
on the 26.8% it was calibrated against.

> The first run of this script scored **0 candidates** on both columns — wrong
> field names (`winners` / `episodesTo50` for `expectancyWinRate` /
> `expectancyEpisodesTo50`) — and printed **"IDENTICAL"**, because two empty sets
> compare equal. That is the codebase's own recurring failure in miniature. The
> script now refuses a verdict when either set is empty.

**(c) PASS, after the prediction in §7.4 was falsified.** The cron does not skip
(§8.2). The warm `longRow` path does, and reaching it needs a fresh
`premium:{TICKER}` — `?refresh=1` on the long endpoint does **not** refetch the
premium row, so repeating that call takes the cold path every time. Seeding
`/api/premium/AAPL?refresh=1` first gave `premiumWarm=True`, and the sample was
byte-identical before and after:

```
before  {"atmIv":21.66,...,"ts":"2026-08-10T21:08:54.878Z"}
after   {"atmIv":21.66,...,"ts":"2026-08-10T21:08:54.878Z"}     ← unchanged
```

Warm cost `ext 4 / bind 8 / cap 12`; cold `ext 8 / bind 10 / cap 18`. The warm 8
is one below §3's 9 because `ivHistory()` is skipped when the rank is reused.

**(d) PASS.** `calib:pooled` written by `fillForwardReturns`, schema 2,
`d: 2026-08-10`, `magnitudeN 276` over `tickersWithBar 33` — **the §7.3 race did
not bite**; the sweep finished before the fill read `moves:`. Resolving against
real data, not the fixture:

| | rate | base | edge | n / benchmarkedN |
|---|---|---|---|---|
| BUY sign | 50.46% | 60.54% | **−10.1** | 116 / **109** |
| BUY magnitude | 20.18% | 33.72% | **−13.5** | 109 / 109 |

`benchmarkedN` rose 75 → 109 exactly as §8.3 predicted, so these supersede §5 on
population, not on correctness — §5 remains right for the 22-name population.
**The negative edge persists and the sign edge widened.** SELL correctly nulls at
`n=4` with the per-rating floor reason; HOLD nulls with the no-directional-claim
reason. Bar 7.34% vs the pre-sweep 7.38%. `brier 0.3057` over 121.

### 8.5 Incidental finding: `rec:/BTC` is a malformed key

One of the 63 `rec:` keys is named `/BTC`, the only one failing
`/^[A-Z][A-Z.\-]{0,9}$/`. It 404s its chart fetch on **every** 2pm run — one
wasted external fetch and a `warn` line daily, forever. Harmless to the
calibration (it contributes no resolved outcome) but it is permanent noise in the
log that a future reader will spend time on. Deleting a KV key is destructive and
was not done unasked.

---

## 9. This file has served its purpose

All four parts of item 4 are complete and recorded in §8.4. The durable findings
have been moved into `CLAUDE.md`:

- the `_instr` concurrency caveat (rule #1) — the widest-reaching of them
- the sweep's `2N + 3` / `ceil(N/20)` cost model and the N=35 universe
- premium-warm being 8 binding ops, not 9, and why
- `?refresh=1` on `/api/long/` not refetching the premium row

What remains here is a frozen snapshot with no maintained value. **This file can
be deleted.** Two things would need a home first if they are ever acted on:
`rec:/BTC` (§8.5), and the still-open follow-ups from the earlier session —
a structural baseline for `gap`, recalibrating `EPISODE_CONCENTRATION_WARN` now
that a full sweep exists (the 26.8% held, so there is nothing to change today),
and surfacing `baseRate`/`edgePts` on `index.html`'s Recommendation History card.
