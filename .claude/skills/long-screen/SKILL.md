---
name: long-screen
description: Reference for the Long tab (the only options screen) — Lanes A–F including Lane F defined-risk credit spreads and its direction inversion, Lane E straddle/strangle and its four gates, the macroRegime display-only chip, and move coverage / drift / expectancy. Load before editing longRow, any lane builder, attachCoverage, expectancyFrom, probBeyondBreakeven, collectMoveSeries, collectMacroState, or the Long tab rendering in dashboard.html.
---

# The Long screen — lanes, coverage, and the macro chip

Extracted from `CLAUDE.md` so it loads only when this work is being done. Everything
here carries the same weight as the root file: the prohibitions are load-bearing, not
background. `CLAUDE.md` and `ARCHITECTURE.md` still apply on top of this.

### Lane F — defined-risk credit spreads (the merged Premium screen)

**THE STANDALONE PREMIUM TAB IS GONE.** It was a separate surface weighted as
though selling were the primary activity, and it priced **naked** single legs —
a cash-secured put and a covered call. Both were wrong for how this dashboard is
used: options are bought here on high-conviction directional setups, and short
premium is secondary, defined-risk and quick to decide. It is now **one lane of
six** on the Long tab.

**Deleted, and nothing else consumed any of it** (verified by grep across
`worker.js`, `dashboard.html` and `index.html` before removal):
`premiumRow`, `pickCandidates`, `sellableFrom`, `handlePremiumBatch`,
`handlePremiumTicker`, `premiumRowMeta`, `refreshPremiumTicker`,
`PREM_MIN_DTE`, `PREM_MAX_SYMBOLS`, `IVR_SELL_MIN`, `RATIO_SELL_MIN`, the
`#tab-premium` panel and ~24 KB of its JS. **`/api/premium/*` returns 410**,
not 404 and not silently absent — a stale bookmark or a cached frontend should be
told the route was retired and where it went.

**What survived, and why each is still load-bearing:**

| survives | why |
|---|---|
| `PREM_TARGETS` (0.30/0.16) | feeds Lane F's short leg and wing, and Lane E's strangle |
| `ivPlausible` / `IV_OUTLIER_MULT` / `ivOutlierNote` | the strike-selection guard, always shared |
| `ivRankFrom` | also feeds `/api/iv` and the earnings facts payload |
| `nextEarningsIso` | also feeds `longRow` |
| `volRegime` | `/api/iv` **and index.html** |
| **`premium:{TICKER}`** | **repurposed — see below** |

**`premium:{TICKER}` survived the tab, but it had to change hands.** It is no
longer a screen row; it is the **shared IV/earnings header** `longRow` reuses on
its warm path. Deleting the tab removed its ONLY writer (there was never a cron
write — `refreshPremiumTicker` had exactly one caller, the route). Left alone,
the warm branch would have become permanently unreachable and every Long request
would run cold: **8 external Yahoo fetches instead of 4**, doubling crumb pressure
on a 35-name sequential "Load all" — and crumb rate-limiting, not the subrequest
cap, is the binding constraint there. So `refreshLongTicker` now writes it, but
**only when it ran cold**: rewriting on a warm run would refresh `ts` without
refreshing the data, producing a stale record that reports itself as fresh.
`PREM_SCHEMA` 2 → 3 retires every old full-row value.

**The lane: short ~0.30Δ, long ~0.16Δ, put side and call side**, on Lane B's
already-fetched monthlies — zero extra subrequests, the same arrangement as
Lanes C, D and E.

**`maxLoss = width × 100 − credit` is the point of the lane.** It renders in the
danger treatment, and it is **also the capital `expectancyFrom` divides by** —
computed once so the figure on the card and the denominator behind E[R] cannot
drift. Using the credit instead would inflate expectancy by 2.3–3.2× on real
candidates and pin every credit row to the top of the screen. Credit is the short
leg's **bid** minus the wing's **ask**.

**No expectancy above 1.0 — and know when that bound can legitimately break.**
Measured 0 of 138 across all 35 names, highest 28.0%. The ceiling is
`credit / (width × 100 − credit)`, which exceeds 1 only when the credit is more
than **half** the width; at 0.30/0.16 deltas that is not a normal quote. So a Lane
F expectancy above 1.0 is a denominator bug until proven otherwise — but it is not
*arithmetically* impossible, and `lane-f.check.mjs` §4 prints the algebra rather
than asserting a law that does not hold.

**THE DIRECTION INVERSION, which is the easiest thing here to get wrong.** For
every other lane `coverage` is the frequency with which the stock **moved past**
the breakeven, and that is the win. A credit spread wins when it **does not**. So
Lane F reports coverage and `pBe` as the probability of the WIN, which inverts
the direction relative to a long option of the same side:

- bull put spread → wins ABOVE → `dir: 'up'` at a negative threshold
- bear call spread → wins BELOW → `dir: 'down'` at a positive threshold

A long put uses `'down'` and a long call `'up'`, so this is the **opposite** of
what `attachCoverage`'s type inference picks — hence `covDir` is passed
explicitly, and `probBeyondBreakeven` is called with the opposite `type`.
Getting it from `type` would put the LOSS frequency in the column Lane B uses for
its win frequency: measured **54.1 points out** on a real 0.30-delta short.

**What the lane deliberately does NOT get:**

- **No rating gate.** `analysis:` is informational-only — it measured a negative
  edge, and gating a lane on a measured non-edge reintroduces what was disabled.
- **No vol gate of its own.** `buyableFrom` is now the only vol gate on the
  screen and it does not apply here.
- **No position awareness, and this is a correctness constraint rather than a
  missing feature.** The screen cannot know whether shares are held, so nothing in
  the lane may imply a covered position: no covered-call framing, no share-based
  capital, no assignment modelling. Every card is a defined-risk spread on its own
  terms, and `positionNote` says so on the row.
- **No special placement.** It sorts with the rest on expectancy and renders last.

**It does not dominate the sort, confirmed rather than assumed.** Measured across
16 candidates each: NVDA ranks 7–10, AAPL 5/7/9/10, PLTR 7–10. Lane F never took a
top-4 slot on any of the three. Expectancy handles credit structures correctly
because it divides by real capital at risk — the high win rate is offset by the
small max gain, which is exactly what a probability-only ranking would miss.

**Lane F has no gates, so it has no gate rate** — the Lane E figure (91% gated)
has no analogue here. What it has is a *pricing* rate: **70 of 70 entries priced,
138 candidates, 0% unpriced** across all 35 names. If it ever fails it reports
`no-iv` with the reason.

**`episodesTo50` never fires the concentration flag on this lane** — `==1` on
**0 of 138**, mean 6.05 against Lane B's 2.10. This falsified the breakeven-distance
mechanism written up for Lane E; the driver is the **win rate**, not breakeven
distance. Full correction in `ARCHITECTURE.md`.

`node lane-f.check.mjs` covers the credit payoffs at five prices each (their
**first-ever caller** — those branches existed since the §6.2 work and had never
executed), `capitalOf`, both guards, the ≤1.0 ceiling and the direction
inversion. **36 comparisons.**

### The Long tab — the long-premium screen

The mirror of Premium: Premium asks *where is vol rich enough to sell*, Long asks *where is vol cheap
enough to own, and is the debit structurally payable*. Same architecture — `/api/long/batch?symbols=`
is a KV read making no outbound fetch (1 KV read/symbol), `/api/long/:ticker` is the only path that
touches Yahoo, Load all is strictly
sequential, expanded/sort state in `sessionStorage` under `trading_dash_long_open` /
`trading_dash_long_sort`. `long:{TICKER}`, `LONG_FRESH_MS` 4h, retention 24h.

**Measured subrequest cost.** `capCost` is the number the 10,000 meters — external
fetches *and* KV together.

**Current figures, re-measured 2026-08-11 as a BEFORE/AFTER A/B for the macro
read.** Both halves ran against the *same local KV state* on `wrangler dev`, which
is the only way to attribute a one-op delta: a production "before" against a local
"after" differs by KV *contents* (how many `iv:` pages a `list()` walks, whether
`analysis:` exists) and would have buried the signal. AAPL / NVDA / PLTR, three
tickers because one is a coincidence:

| case | before capCost | after capCost | delta |
|---|---|---|---|
| `/api/long/batch`, 33 symbols | 0 ext / 33 bind / **33** | 0 / 34 / **34** | **+1** |
| `/api/long/:ticker` **warm** (all three) | 4 / 8 / **12** | 4 / 9 / **13** | **+1** |
| `/api/long/:ticker` **cold** — AAPL | 8 / 11 / **19** | 8 / 12 / **20** | **+1** |
| — NVDA | 8 / 10 / **18** | 8 / 11 / **19** | **+1** |
| — PLTR | 7 / 10 / **17** | 7 / 11 / **18** | **+1** |
| cache hit (`?cached=1` or fresh) | 0 / 1 / **1** | 0 / 2 / **2** | **+1** |

**Exactly +1 binding op on every path and zero extra external fetches**, which is
one KV read of the ~727-byte `macro:state` key. **The delta is a single number; two
of the three absolutes are not.**

> **SUPERSEDED FOR THE BATCH ROW, 2026-08-25.** `/api/long/batch` now also reads
> `top3:{PT-date}` into the envelope beside `macro`, so it is **`N + 2`**, not
> `N + 1`. Measured on the same day: N=10 → capCost **12**, N=1 → capCost **3**,
> both `extFetches 0`. The `+1` delta below still describes the macro read on its
> own and is left as measured; the *absolute* for this row is now N + 2.
>
> **AND IT IS NO LONGER A SINGLE VALUE, 2026-08-26.** `readTop3` serves today's
> key when it exists and otherwise walks back up to `TOP3_SERVE_WALKBACK_DAYS`
> (3) calendar days, because the record is written at 1:15pm PT and today-only
> reading served `null` on every trading morning while a valid record sat in KV
> inside its 36h TTL. So the row is **`N + 2` on the hit and at most `N + 5` on
> the miss**. Measured at N=2 on 2026-08-26: hit **4**, `-1` hop **5**, full
> miss **7**, with `extFetches 0` on all three. **Quote which path you are on**
> — the same discipline the cold row below demands.

| path | absolute after | is it one value? |
|---|---|---|
| `/api/long/batch`, 33 symbols | **34** → now **35** | **yes** — `N + 1`, now `N + 2`, exactly, by construction |
| `/api/long/:ticker` **warm** | **13** | **yes** — all three tickers identical |
| `/api/long/:ticker` **cold** | **18–20** | **NO — a range, and quote it as one** |

**COLD IS A RANGE AND THE DOCS HAVE ALREADY ENCODED IT AS A SINGLE VALUE ONCE.**
Before the macro read it was **17–19** across AAPL / NVDA / PLTR; after, **18–20**.
Same code, same commit, same minute — the spread is `ivHistory()`'s paged `list()`,
which walks **one more page for AAPL** than for NVDA or PLTR because AAPL has more
`iv:AAPL:{DATE}` samples banked. It grows with collection, so this range widens over
time on its own.

So: **quote the delta (+1, exact), and never quote a bare cold number.** Name the
tier, the ticker and the crumb state with any absolute — a single measurement of
this path is ambiguous by ±2 on `iv:` history depth alone, and by a further ±4 on
crumb state (see the tier table below).

> **SUPERSEDED HISTORY, kept because the breakdown column still explains where the
> external fetches go.** The table below was measured 2026-08-08 and its binding
> column predates move coverage and pooled calibration; it was corrected once
> already on 2026-08-10 (premium-warm `4 / 8 / 12`, premium-cold `8 / 10 / 18`,
> the `+3` being `readMoveSeries` + `recordIvSample` + `calib:pooled`). All of
> these are request-path figures and so are isolated by construction — this is
> staleness, not `_instr` concurrency contamination.

| case | extFetches | bindingOps | **capCost** | breakdown |
|---|---|---|---|---|
| premium-**warm** | 4 | ~~5~~ → 8 → **9** | ~~9~~ → 12 → **13** | base list + 3 dated chains (Jan 2028, Sep, Oct) |
| premium-**cold** | 7–8 | ~~6~~ → 10 → **11–12** | ~~13~~ → 18 → **18–20** | the above + earnings `quoteSummary` + hv30 chart |
| premium-cold, **crumb also cold** | 9 | 8 → 11 → **12** | 17 → ~20 → **~21** | + 2 crumb fetches and 2 crumb KV ops |
| cache hit (`?cached=1` or fresh) | 0 | 1 → **2** | 1 → **2** | one KV read → + the macro read |
| `/api/long/batch`, 22 symbols | 0 | 22 → **23** | **22** → **23** | one KV read per symbol, + one macro read for the whole batch |

**Warm is 8 and cold is 10 because `ivHistory()` runs only on the cold path** —
warm reuses `ivRank` / `historyDays` / `rankReason` from `premium:{TICKER}`, so the
`list()` never happens. The 9-op breakdown further down is the **cold** figure.

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
                                   readMacroState (macro:state)        1   ← step 5
                                                                total 10
```

**`readMacroState` is the tenth, and it is one read of `macro:state` — never
`macro:series`.** The two-key split exists so this line stays a 640-byte read
rather than a 31 KB one; if a future change makes the request path touch
`macro:series`, this accounting is where it must be justified.

**That 9 is the premium-COLD figure. Premium-warm is 8, and the missing op is
`ivHistory`** — on the warm path `ivRank`, `historyDays` and `rankReason` are
reused from `premium:{TICKER}`, so the list call never happens. Verified live
2026-08-10 on AAPL: warm `ext 4 / bind 8 / cap 12`, cold `ext 8 / bind 10 /
cap 18`. Do not "fix" the warm path to 9 by re-adding a history read.

**`?refresh=1` on `/api/long/:ticker` does NOT force the premium row to refetch.**
`refreshLongTicker()` reuses `premium:{TICKER}` whenever it is inside
`PREMIUM_FRESH_MS`, independently of the long endpoint's own refresh flag. So a
bare `?refresh=1` on a ticker whose premium row is cold takes the **cold** path
every time, and the warm branch cannot be reached by repeating the call. To
exercise it the premium header must already be fresh. This cost a wasted test
cycle when the warm-path IV skip was being verified.

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
- **Low IV rank is the good state.** `buyableFrom()` inherits the deleted `sellableFrom()`'s shape — same tri-state
  fallthrough, opposite direction: `IVR_BUY_MAX` 40 on rank, `RATIO_BUY_MAX` 0.95 on the IV/HV30 proxy,
  `buyable: null` when neither exists (renders **neutral, not dim** — the same null-is-not-a-fail rule
  that greyed the old Premium tab for three months). Note `buyable` is **not** `!sellable`: an IV rank of 55
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

**Six lanes.** A = stock replacement, the two nearest Januaries ≥365 DTE, 0.85/0.70Δ ITM calls. B =
directional swing, first monthly ≥30 and ≥60 DTE, 0.55/0.40Δ. C = debit verticals on B's already-fetched
chains (zero extra subrequests), long ~0.55Δ short ~0.25Δ, **actual leg deltas reported, not the
targets**. D = calendar/diagonal. E = straddle + strangle. F = defined-risk credit spreads (the merged Premium screen).

### Lane E — straddle and strangle

**The lane does not exist to surface these trades. It exists to say, before one is
put on, whether the required move has historically happened** — and most of the
time the honest answer is no. A lane that renders something tradeable on every
name would defeat its own purpose. It reuses Lane B's already-fetched monthlies,
so it costs **zero extra subrequests**.

**The pair is never split.** Straddle and strangle always render together for the
same expiry, stacked. The strangle cuts the debit and cuts coverage by *more* —
a property of the structure rather than of any quote, so seeing it once is the
point. If one fails to price the other still renders and the missing one carries
its reason. Measured on live chains 2026-08-10: NVDA 2026-09-18, the strangle
saved **$11.80/share and gave up 6.2 pts** of 3y coverage; AAPL, **$9.80 for
6.7 pts**.

**Strike selection invents nothing.** The straddle takes the listed strike nearest
spot (`nearestTradeableStrike()` — a plausible IV *and* a quoted ask, which
`ivNearPrice()` does not check because it answers a different question). The
strangle uses **`PREM_TARGETS[0]` (0.30Δ)** on each side — the premium screen's
canonical wide/OTM leg delta, already used to pick exactly this kind of strike on
both sides. `LANE_E_STRANGLE_TARGET` is *derived from* `PREM_TARGETS`, not copied,
so the two cannot drift. `PREM_TARGETS[1]` (0.16Δ) would give a second, wider
strangle; the pair rule calls for one.

**The headline is the product**: `required / expected / typical realized`, one
line, three numbers, in that order. Required is the **wider** breakeven as % from
spot — the narrow side flatters the structure and is not what has to happen.
Typical realized is `medianAbsMovePct()` at the snapped horizon. Live 2026-08-10,
NVDA 39d: **required 11.61% / expected 12.86% / typical realized 7.35%** — the
typical move has *not* covered it, which is the lane working.

**Four gates, and failing one renders the lane WITH THE GATE NAMED** — never
hidden, never blank. `status: 'gated'`, `gateFailed[]`, `gateDetail{}`:
`vol-not-cheap` (`buyableFrom` returned false — **null is not a failure**, it means
no basis yet) · `no-catalyst-inside` (no earnings date within the expiry) ·
`hostile-term` (`termStructure > 0`, backwardation) · `no-coverage`. Hiding a
failure would make "no straddle worth looking at" and "no data for this name"
identical on screen.

**The `analysis:` rating is deliberately NOT a gate.** It measured a negative edge
(sign-scored BUY 50.5% against a 60.5% base rate, −10.1 pts, n=109 benchmarked of
300 resolved — the live figures, reconciled 2026-08-11), which is why the alignment tag
is informational-only; gating a lane on a measured non-edge would reintroduce
exactly what was disabled. A straddle makes no directional claim anyway.

**Two-sided coverage and P(BE) are COMPOSED, not extensions.** `coverageTwoSided()`
calls `coverageAt()` twice and `probBeyondEither()` calls `probBeyondBreakeven()`
twice. `coverageAt` is load-bearing on every other lane and was not touched;
composition also yields the tail split, which is required output rather than a
diagnostic. Both assert `beLower < beUpper` and return null on crossed breakevens,
so the sum is a probability and not an over-count. The one-sided figure would
understate a straddle by **26.7 pts at ±10% / 45 DTE** — an error with no shape to
it, which is why it gets its own check script.

**THE TAILS ARE RENDERED APART AND NEVER SUMMED.** `coverageUpper*` /
`coverageLower*` are separate fields, null on one-sided candidates (a long call
*has* no lower tail — not the same as one measuring 0). A straddle covering 24%
split 22↑/2↓ is closer to a long call than a volatility trade; 13↑/11↓ is an
actual volatility trade, and the total alone cannot tell them apart.

**It is drift ÷ σ that drives the split, not raw drift — measured, and the naive
version is wrong.** Across all 35 stored series at ±10% / 45 sessions
(2026-08-10), up-tail share correlates **0.902 with drift÷σ and 0.038 with drift
alone**. A fixed threshold is a large move for JPM (σ 6.4% → 89% up-share on 5.7%
drift) and trivial for QUBT (σ 62% → 49% up-share on 75% drift). The first draft
of this note claimed raw drift and the near-zero correlation caught it. Five of 35
names are lopsided past 80/20: JPM, TSM, AVGO, NVDA, AAPL.

**THREE OF THE FOUR GATES READ THE SHARED HEADER, so on a warm run the verdict is
computed on data up to 4h old.** `vol-not-cheap` ← `ivRank`/`ivHvRatio`,
`no-catalyst-inside` ← `earnings`, `hostile-term` ← `termStructure` — all in
`sharedFields`. Only `no-coverage` is independent, coming from `moves:`.

`hostileTerm` is the live one: front IV − back IV, both moving intraday, so near
zero a stale read can **flip** it. This lane's value is that it refuses 91% of
candidates, which makes "a gate that passes something it should have refused,
silently" the failure mode that matters.

**The verdict is AGED, not suppressed.** A verdict marked *"computed on 3h-old vol
data"* is more useful than no verdict. The chip renders **on the gate verdict
itself** — where the eye lands — not in the legend and not on the row header, and
it renders in **both** states: a passing verdict used to be the *absence* of a
gate block, so the one case where staleness can do real harm had nothing on screen
to age. Quiet when live, cyan under an hour, amber past it. Suppression would need
a case where staleness makes the verdict actively meaningless; none is known.

**The earnings-straddle limitation is on screen, not in a comment.** Expectancy
and coverage both assume **hold to expiry**. The trade actually worth considering
into a print is buy-before / sell-after — a two-day vega trade — and IV crush can
take that position down even when the move happens. Where a catalyst sits inside
the expiry the card renders `holdToExpiryCaveat` as visible text. **No IV-crush
model is attempted**: there is no vol-surface history in this codebase to build
one from, so the limitation is stated and the derivation stops, exactly as Lane D
refuses rather than assuming a future IV.

**`upsideTruncated` fires on both** — `maxGainOf` returns null for `straddle` and
`strangle`, so expectancy is scored only as far as the largest observed window.
The concentration flag renders on this lane with its window named inline, same as
everywhere else, and **it fires more here than anywhere else**: `==1` on **28.6%**
of 140 Lane E candidates against **18.8%** of 420 Lane B/C candidates, same day,
same payloads. The cause is breakeven distance, not two-sidedness — full write-up
and the mechanism in `ARCHITECTURE.md`.

**Most names do not qualify, and that is the lane working.** Measured live
2026-08-10 across all 35: **64 of 70 entries gated (91%)**, failing
`no-catalyst-inside` 44 times, `hostile-term` 36, `vol-not-cheap` 30. Only six
entries passed every gate — NVDA (both monthlies), MRVL (both), TSM and MU. A
build of this lane that renders something tradeable on most names has a bug.

`node lane-e.check.mjs` covers the two-sided half in six sections: two-sided pBe
against a series-erf reference at five prices, two-sided coverage against a
brute-force loop over raw closes (including a tail contributing exactly 0, which
must not read as null), both payoff functions at five prices spanning all four
breakevens, the bound and breakeven-crossing guards, `upsideTruncated`, and the
tail split across synthetic trending / range-bound / downtrending regimes.
**70 comparisons.**

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

### `macroRegime` — phase 1, and it is DISPLAY ONLY

One chip in the Long tab header. **It does not sort, gate, filter or blend into any
existing figure, and the card says so in visible body text** — not a tooltip,
because a coloured state chip above a ranked list reads as a ranking input unless
it explicitly denies being one. That sentence comes out only when a phase 2
measurement justifies removing it.

**This shape is deliberate and it is the correction to a specific mistake.** The
`analysis:` rating was wired into sort order before anyone measured whether it had
edge; measured against a base rate it came back **negative** (−10.1 pts) and the
influence had to be disabled after the fact. Macro state is the same kind of
plausible-feeling signal, so it ships with no ranking influence at all.

| constant | value | what it is |
|---|---|---|
| `MACRO_SCHEMA` | 1 | on **both** keys; bumped together |
| `MACRO_KEY` / `MACRO_SERIES_KEY` | `macro:state` / `macro:series` | see the KV table for why these are separate |
| `MACRO_SWEEP_KEY` | `macrosweep:last` | dedup, outside the `macro:` prefix |
| `MACRO_TTL` | 90d | retention on both keys |
| `MACRO_FRESH_MS` | 26h | stale-badge threshold — one daily write plus slack |
| `MACRO_SYMBOLS` | `SPY QQQ ^VIX ^VIX3M` | field name → Yahoo symbol; the carets never leak past this table |
| `MACRO_RANGE` | `10y` | derivation range. **Never `max`** — spark returns 1 session for `^VIX3M` at `max` |
| `MACRO_SLICE_DAYS` | 756 | ~3y, aligned with `MOVES_RANGE`, stored for phase 2 |
| `MACRO_TREND_FAST/SLOW` | 50 / 200 | fed to `smaCrossState` |
| `MACRO_SMOOTH_SESSIONS` | 5 | trailing mean — **the classifier's input** |
| `T_BACK` | **0** | classifier input above this reads hostile |
| `T_CONTANGO` | **−1.0** | classifier input below this reads constructive |
| `MACRO_GATES` | — | ships all of the above plus `sign` and `classifierInput` in the payload |

**THE SIGN CONVENTION IS A SUBTRACTION, NOT A RATIO.** `vixTermSpread = VIX −
VIX3M`; **positive is backwardation and positive is hostile.** This matches
`longRow`'s `termStructure = front − back`, which Lane E gates `hostile-term` on at
`> 0`. A macro field where *below 1.0* meant backwardation would put two opposite
polarities for the same concept on one screen. `vixTermRatio` ships for display and
**must never classify**.

**THE CLASSIFIER READS THE SMOOTHED FIELD, AND THE RAW ONE HAS THE MORE OBVIOUS
NAME.** `vixTermSpread` is raw and decides nothing; `vixTermSpreadSmoothed` is the
input, and `gates.classifierInput` names it in the payload so no frontend can pick
the wrong one. Raw gives a **2-session** median hostile run — noise wearing a regime
label — against **7** smoothed, with transitions cut from 229 to 98 and only 0.8pp
of frequency given up. **The lag this costs was measured before the constant was
set**: median **1 session**, mean 0.67, max 1, across six stress episodes.

**`hostileVia` is `'term' | 'trend' | 'both'`, null on every other state, and it
renders.** Of hostile sessions, **66.8% came from the index-trend clause alone**,
26.8% from backwardation alone, 6.4% from both — so the chip is currently more a
trend read than a vol read, and "hostile" on its own misdescribes the common case.
2022-06-16 is the proof: VIX 33.0, term −0.54, hostile **while in contango**.

**Any null input → `unavailable` naming which.** No partial state is computed from
three of four; the four are never blended into a score. The collector **refuses**
rather than storing an `unavailable` record — an absent key means our own scheduler
did not run, which is a different fact and the reader says so.

**Alignment is BY DATE, never by index.** Measured 2026-08-11 at `range=10y`: `^VIX`
2514 sessions, SPY and QQQ 2512, `^VIX3M` **2492**. Index-zipping would pair a VIX
close with a VIX3M close up to 22 sessions away and produce a term spread that is
arithmetically fine and describes nothing.

**Collection cost: 1 external fetch + 4 binding ops = capCost 5**, counted with stub
bindings rather than read off `_instr`. **`_instr` cannot measure this job**: it
shares the 1:15pm branch with the EOD summary and the IV sweep, and `instrSince()`
subtracts invocation-wide counters over a span of *time*, so their KV calls land
inside its bracket. Measured on that branch it reported `bindingOps 5` where its
structure predicts 4 — contamination is strictly additive, so that is an upper
bound, not a cost. See rule #1.

**Phase 2 is specified but NOT built**, and phase 1 must not foreclose it: the
`macro:series` slice exists so phase 2 needs no second collection pass. Do **not**
bump `MOVES_SCHEMA` for it in this release.

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
