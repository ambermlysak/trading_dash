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

Other measured costs:

- **move-series sweep, 22 symbols:** `extFetches 2`, `bindingOps 47`,
  `capCost 49`. The 2 is the whole point — spark takes 20 symbols per request.
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
  ordering
- (c) `skip-if-exists` firing, and the resulting `iv:{TICKER}:{DATE}` sample + `src`
- (d) `fillForwardReturns` actually wrote `calib:pooled`, and the magnitude field
  resolving against real `moves:` data rather than the seeded fixture
