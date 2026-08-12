# Equity Research Terminal — Architecture & Data Sources

## Repo layout

```
trading_dash/
├── dashboard.html       # Macro landing view — 6 tabs (market, midday, scanner,
│                        #   watchlist, sectors, long)
├── index.html           # Per-ticker research page — hero + 14 numbered cards
├── worker.js            # Cloudflare Worker: Yahoo / SEC EDGAR / FINRA / FRED /
│                        #   Alpaca proxy, Claude calls, KV persistence, cron jobs
├── wrangler.toml        # Worker config: KV binding, cron trigger, secret inventory
├── bs-delta.check.mjs   # Black-Scholes delta check — prints computed vs expected
├── nd2.check.mjs        # Long tab P(BE)@exp = N(d2), theta, vega — three
│                        #   independent cross-checks, prints computed vs expected
├── long-fixtures.check.mjs # Long-screen paths live data cannot reach: the IV-rank
│                        #   gate branch, Lane A with two Januaries, the IV guard
├── moves.check.mjs      # Move coverage + expectancy — coverage vs brute force,
│                        #   all 8 payoff structures, the two expectancy guards,
│                        #   the independent-window floor, episode de-clustering
├── instr-bindings.check.mjs # The binding counter: shape detection, automatic
│                        #   pickup of a new binding, and its failure paths
├── cron-gate.check.mjs  # Cron trading-day gate check — weekends, NYSE holidays,
│                        #   both DST regimes; prints computed vs expected. Also the
│                        #   cheapest real ES-MODULE parse of worker.js — `node --check`
│                        #   parses it as CommonJS and misses duplicate declarations
macro.check.mjs       # macroRegime phase 1 — sign convention, both thresholds,
│                        #   hostileVia, date alignment vs brute force, all four
│                        #   states, and collectMacroState's cost with stub bindings
├── cors-check.html      # Open in a BROWSER to verify CORS preflight; curl cannot
├── package.json         # wrangler devDependency only; there is no build step
├── .dev.vars            # LOCAL SECRETS — gitignored, absent on a fresh clone
├── ARCHITECTURE.md      # this file
├── CLAUDE.md            # working rules; read its constraints block first
└── README.md            # quick start
```

Both HTML files are standalone: no bundler, no module system, no framework. Shared
logic between them is therefore either duplicated deliberately (`setBadge`) or
moved into the Worker and shipped in the payload (`volRegime`, gate thresholds).

## The two pages

**`dashboard.html`** — **six** tabs, all deep-linkable by hash:

| Tab | Contents | Data path |
|---|---|---|
| Market | Index/futures/commodities strip, 6am Claude briefing, EOD card, Friday week-ahead, news cards, pre/post-market movers (≥ ±10%), IPO calendar, watchlist signals | loads on page load |
| Midday | 11:30am PT pulse: session narrative, topics, next-day events, short-term ideas, big movers | `daily:midday` via `/api/daily` |
| Scanner | Momentum / HOD · Pre-Market Gappers · All Movers · **Golden Cross Setup** | first three `/api/market/scanner`; golden cross has its own endpoint and renderer |
| Watchlist | 14 columns, sortable, expandable rows, one consolidated Recommendation | `/api/watchlist/batch` |
| Sectors | 11 SPDR sectors, ETF change + Claude opportunity/avoid per sector | `/api/market/sectors`, 4h KV |
| **Long** | **The only options screen.** Six lanes — LEAPS / swing / debit verticals / calendars / straddle+strangle / defined-risk credit spreads. Collapsed rows, expand to fetch. Carries the **macro chip** in its header — one per screen, display only | `/api/long/batch` (KV only) + `/api/long/:ticker` on expand |

**There is no Premium tab.** It existed from 2026-08 until **2026-08-10**, when it
was merged into the Long screen as **Lane F** — short premium is secondary here and
now sits as one lane of six, ranked by the same expectancy as everything else. Its
row model, its naked CSP/covered-call pricing and `/api/premium/*` are all deleted;
the route returns **410** naming the replacement. The KV key `premium:{TICKER}`
survives but means something different — see the shared-header note below. It in
turn had replaced an "Options" V/OI recap, also deleted rather than moved.

**Long is the only tab that fetches upstream on interaction** rather than on load;
Sectors and Scanner paint a KV snapshot immediately and revalidate behind it, so no
tab requires a click to show data.

**Painting is cheap, not free.** `primeTabs()` fires the Long batch read on every
page load, costing one KV read per symbol — 33 on the current watchlist — which
counts against the same 10,000 pool as an outbound fetch. A full dashboard page
load measured **capCost ≈ 133–140** across 12 requests on 2026-08-08 (≈90 in steady
state, once the sectors cache is warm); that figure predates the Premium tab's
deletion, which removed one batch read of ~22–33, so the current total is lower and
has not been re-measured. The cap meters per *invocation*, so
the figure that matters against 10,000 is the largest single request — ~47 for a
cold sectors rebuild, 22 for a batch read — not the page-load total.

**Provenance: all request-path, therefore isolated.** Every figure in this
paragraph comes from an HTTP request, and one request is one invocation running
one job, so none of it is exposed to the `_instr` concurrency contamination that
affects two-job cron branches (CLAUDE.md rule #1). The per-symbol figures scale
with the watchlist and **the saved list is now 35, not 22** — a batch read costs
35, and the page-load total rises with it.

**`index.html`** — per-ticker deep dive. Hero strip (price, change, market cap,
P/E, sector, exchange, AI verdict + confidence ring) over numbered cards:

```
01 Price & Performance            09 Analyst Opinion
02 Catalysts & Earnings           10 Super-Investor Holdings
03 Short Interest                 11 Technical Analysis
04 Insider Trades                 12 Sentiment Analysis
05 Options Volume · V/OI Screen   13 Fundamentals & Valuation
06 Recommended Option Strategies  15 Recommendation History
07 Swing Setups · EMA Crossover      News Flow
```

**08 is missing on purpose.** It was the dark-pool card, which was fabricated and
was deleted rather than renumbered. The gap is a deliberate scar; do not reuse the
number. 14 is the AI Synthesis card, which renders in the hero rather than inline.

---

---

## Data honesty rules

These govern every section below and every change to them. Each one exists because it was broken
in this codebase and shipped:

1. **Never display one quantity under another's label.** A 30-day close-to-close standard deviation
   was displayed and consumed as "IV" for months. It is historical vol; it is now `hv30`/HV30, and
   implied vol comes from the options chain via `/api/iv` or not at all.
2. **Never present a hardcoded or generated number as computed.** Strategy POP and "Hist Win" were
   literal strings (`'72%'`, `'78%'`) rendered in the same style as live figures. If a number is not
   computed, render `—` and say why on hover. POP is now genuinely computed (1 − |Δ| of the short
   strike, Black-Scholes delta from the Worker) — and **the card states what kind of number it is**:
   a delta-derived approximation under a lognormal assumption, not a measured frequency. That caption
   is not decoration. The stat sitting next to it, "Hist Win", is exactly the measured thing POP is
   not, and it stays blank until a real backtest exists.
3. **When a source is unavailable, render unavailable with a reason — never a fallback value.**
   IV rank returns `null` plus a `rankReason` below 60 days of history rather than a percentile of HV
   standing in for it. On screen a plausible stand-in is indistinguishable from the real thing.
4. **Every displayed number carries a source and an as-of timestamp.** "Computed from daily bars" is
   a source; so is "Yahoo `calendarEvents`". A figure whose provenance cannot be stated should not be
   on the page. Provenance alone was not enough: a 15-minute-delayed price, a 6-hour-cached P/E and a
   nightly Claude rating sat in one watchlist row with nothing distinguishing them. So `srcMeta()`
   also carries `ttlSeconds`, every badge renders **as of HH:MM** from `fetchedAt`, and it turns amber
   once the age passes the TTL. `delayed` and `stale` are deliberately separate: `delayed` is a
   property of the *source* (Yahoo is 15 minutes behind however recently we asked), staleness is a
   property of *our copy*. A badge can be both. Staleness is re-evaluated on a 30-second timer,
   because a "stale" flag computed only at page load announces itself at the one moment it is least
   likely to be true.
5. **A source may only be named by code that actually called it.** Provenance badges are generated
   from the `_meta` a fetch returned, never hand-written in markup. Two had already drifted: one card
   credited FINRA without ever calling it; another read "Sample" while running live data.
6. **A model's self-reported confidence is not a measurement.** It renders as Low/Moderate/High, never
   as a percentage. Numbers scored against realized outcomes (the Brier score) stay numeric.
7. **Constants that identify external records get verified, not recalled.** 7 of 18 hand-written
   super-investor CIKs were wrong, several pointing at real but unrelated managers. Same rule killed
   the hardcoded FRED release IDs.
8. **A non-zero-baseline chart is honest only when the baseline is visible.** Scaling a small-range
   series from zero is its own failure — six short-interest settlements spanning 4% all rendered at
   the same bar height, costing vertical space to say less than the text beside them. Zero is not a
   meaningful comparison for short interest or days-to-cover; the shape of the change is the signal.
   So `sparkline()` scales to the data range — and because a suppressed baseline exaggerates
   movement, it draws the **min and max on the axis as required elements, not options**. Never ship a
   truncated axis the reader cannot see.
9. **A metric that requires data the app does not have is not approximated — it is removed.**
   Opening-range breakout and VWAP were computed from daily bars, which cannot express either;
   they were deleted rather than caveated.
10. **A formula that does not describe the structure is not applied to it.** POP as 1 − |delta| holds
   for a short strike. For a debit spread or a long straddle the break-even is not the short strike,
   so the same formula would produce a plausible-looking number measuring nothing at all. Those cards
   render **n/a** with the reason, not a figure. The temptation is always to fill the cell — a blank
   looks like a bug and a number looks like work — but a wrong number is the more expensive of the two.
11. **"We have not looked yet" is not the same as "there is nothing there."** The since-deleted premium
   screen rendered four different situations as one dim red block: no row computed yet, no options listed,
   options listed but nothing priced, and a failed fetch. Only the third is a finding about the
   ticker; the first is a fact about our own scheduler and the fourth is worth retrying. Collapsing
   them cost the user the ability to act on any of them — and it made a scheduling gap look like a
   verdict on the stock. Every unavailable state now carries its own `status` and says which it is.
12. **A swallowed error is worse than a loud one when it changes what the data means.**
   `build13FIndex` needed ~61 SEC round trips against the Free plan's 50-subrequest cap then in
   force (this account is now on Workers Paid: 10,000 per invocation, one pool covering external
   fetches and KV/R2/D1 binding calls alike). It
   never failed — a
   per-manager `try/catch` absorbed the cap error and the function returned normally with 16 of 20
   managers, which was then written to KV and rendered as a complete answer. The dropped managers
   were stored in the same shape as a manager who genuinely filed nothing, so the card said "16/20
   managers filed" and attributed our budget overrun to them. **Verified by stubbing the fetch layer
   to throw the real cap error**: always the same last four, because the loop order is fixed. A
   `catch` that lets a loop continue is fine; one that cannot distinguish "this item failed" from
   "we ran out of budget and every remaining item will fail" is not. Two Sigma's real Apple position
   was missing from the card for as long as this shipped.
13. **A gate whose input does not exist yet must not read as a verdict.** `sellable` was
   `ivRank != null && ivRank >= 50`, so a null rank — the state for the first 60 days of collection —
   counted as failing. The whole screen greyed out for three months, which reads as "nothing here is
   worth selling" rather than "we cannot tell yet". The gate is now tri-state, falls through to the
   IV/HV30 proxy while the rank collects, and names the number that decided it on hover.
14. **An input that is unavailable is not defaulted to a convenient value.** Black-Scholes delta needs
   a risk-free rate. With FRED unreachable and nothing banked, every delta is **suppressed** rather
   than computed at `r = 0`: that substitution is worth about a full delta point at 30 DTE, which is
   enough to change which strike the screen selects, and it would be invisible on screen. Same rule as
   3, applied to an input rather than an output.
15. **The same rule applies to what the model is asked for, not just what the code computes.**
   The Midday Pulse had a "Day Trade" bucket. No bad calculation sat behind it — but the model was
   being asked for same-session ideas while holding only daily bars and a delayed quote, so any
   entry, stop or intraday timing it emitted was invented. The absence of a bad calculation is not
   the presence of a basis. It is now "Short-Term", horizon 2–10 trading days, and the prompt
   forbids intraday levels and timing outright. Before asking Claude for a number, check that the
   data to ground it is actually in the prompt.
16. **A `catch` must not absorb an infrastructure failure into a domain-failure shape.**
   `build13FIndex` wrapped each manager in a try/catch that logged and continued. When it hit the
   Free plan's 50-subrequest cap then in force, the error was swallowed four times and the function **returned normally with
   16 of 20 managers**, which was written to KV as a complete index. Worse, the dropped managers were
   stored in the *same shape* as a manager who genuinely filed nothing, so the card read
   **"16/20 managers filed"** — reporting our own budget exhaustion as a fact about the managers.
   The truth was "16/20 fetched, 4 dropped by our own cap." Two Sigma's real 5.9M-share AAPL
   position was missing from the card for as long as that shipped. A catch that lets a loop continue
   is fine; one that cannot distinguish "this item failed" from "we ran out of budget and every
   remaining item will fail" is not.
17. **An error message must not misattribute its own cause.** APP and CRCL rendered
   "no usable implied vol on the front expiry" — a specific, plausible claim about thin options on
   those two names. The real cause was subrequest exhaustion partway through the sweep. Both compute
   fine once the fan-out is removed. An error string that names a *domain* reason for an
   *infrastructure* failure is worse than a generic one, because it terminates the investigation:
   nobody re-checks a ticker the app has confidently declared untradeable.
18. **Verify identifiers against the source, never from memory or documentation consensus.**
   Two separate incidents. 7 of 18 super-investor CIKs were written from memory and pointed at real
   but *unrelated* managers — the "Third Point" CIK returned Two Sigma, "ARK" returned ValueAct.
   A wrong CIK does not error; it silently attributes one manager's book to another. Check
   `data.sec.gov/submissions/CIK{n}.json` and confirm both the name and that `13F-HR` appears.
   Separately, a **working** FINRA field name (`symbolCode`) was changed to a broken one (`symbol`)
   because three documentation sources agreed it should be `symbol`. The live API is the
   authority; documentation consensus is not evidence.
19. **A non-zero-baseline chart must label its min and max on the axis.** Suppressing the baseline
   exaggerates movement, so the reader has to be able to see the scale. `sparkline()` draws them as
   required elements, not options. (This is the visual half of rule 8; it is restated because it is
   the part that gets dropped when someone reuses the helper.)
20. **`CLAUDE.md` takes precedence over general platform or skill documentation.** Where generic
   guidance conflicts with a project rule here, the project rule wins. General documentation does
   not know this account is on Workers Paid, does not know which cron hours fall outside
   the trigger window, and does not know which of these numbers have already been wrong on screen.
21. **A vendor number that drives *selection* must be validated against its peers — and then every
   other selector fed by the same source must be checked too.** Yahoo quoted implied vol of 195.72% on
   AAPL's 2026-09-18 420 put against an expiry ATM IV of 24.54% — an 8× outlier on a strike with zero
   open interest. The Black-Scholes delta computed from it was 0.544, which beat the genuine
   near-the-money put for the Long tab's 0.55-delta target. Every number downstream — breakeven, BE/EM,
   P(BE), leverage, a 272.9% annualised carry — was then arithmetically correct and completely
   meaningless, describing a "0.55 delta swing put" struck 34% *above* spot. A bad input to a *display*
   shows up as one wrong cell; a bad input to a *selection* is invisible, because the output looks like
   a normal row.
   **The first fix covered only the Long screen, and that was the real mistake.** Premium's
   `pickCandidates()` and Long's `nearestDelta()` are separate functions selecting from the same chains
   with the same arithmetic. Premium had not been observed picking a junk strike only because inflated
   IV drags apparent delta *toward 0.5*, away from its 0.30/0.16 targets — a difference in exposure,
   not in correctness. On a real AAPL chain the 400 strike's true delta is 0.0017 and reads 0.280 at
   4× IV, which wins the 0.30 target outright; enabling the guard excluded 43 junk strikes on AAPL and
   32 on NVDA (one at 973.63%) that were already sitting in Premium's selectable pool. The guard is now
   one shared `ivPlausible()` above both callers. Nothing is substituted and the exclusions are
   declared on the card, so this is not the banned "fill a missing IV from ATM".
23. **A status word that cannot fire is worse than no status word.** The Long screen shipped a
   `no-leaps` row status whose condition required no January past 365 DTE *and* no monthly at either
   swing horizon — effectively unreachable, and had it fired it would have blamed missing LEAPS for a
   chain with no usable expiries at all (rule 17). Worse, it would have failed the whole row — blanking
   three working lanes — to report a fact about the fourth. Renamed `no-expiries`; the LEAPS signal now
   lives in the Lane A entry's `not-listed` reason and in `leapsListed: 0` on the row.
24. **A single upstream must not be able to blank a whole screen when a stale value would do.**
   The risk-free rate is cached 12h and was *retained* only 7 days, so a FRED outage longer than a week
   evicted the key, suppressed every Black-Scholes delta, and took the premium and long screens down
   entirely. Suppression is the right answer to *never having had* a rate (rule 14 — never default to
   `r = 0`). It is the wrong answer to a transient outage of the slowest-moving input on the page.
   Retention is now 90 days and the stored print is served flagged `stale` with its age rendered
   ("FRED DGS3MO · 9d old"). **Match the failure response to the failure: "no value has ever existed"
   and "the refresh is late" are different states and must not degrade the same way.**
25. **A metric that needs a paragraph of caveat to avoid misleading is the wrong
   metric — measure the claimed thing instead.** The Long tab's first concentration
   figure was `top3Share`: the share of total positive P/L carried by the three
   largest windows. But the windows OVERLAP by design, so one market move appears in
   up to N consecutive windows and the "three largest" were routinely three
   overlapping views of a *single* episode. The number was arithmetically correct and
   described something nobody wanted to know. Rewording the tooltip to admit that was
   honest and still wrong: it left a metric on screen whose plain reading was false.
   It is now `expectancyEpisodesTo50` — every window assigned to exactly one episode
   by start-index proximity, and a count of how many episodes carry half the positive
   P/L. Measured on 323 real candidates, the old flag fired on 60 and **missed 126
   candidates whose expectancy rested on a single episode**; within the
   `episodesTo50 == 1` group the old share ranged from 2.1% to 100%, i.e. the two
   were near-uncorrelated where it mattered.
26. **A real-world frequency and a risk-neutral probability differ by drift, and
   subtracting them silently attributes that drift to volatility.** The Long tab's
   `gap` is `coverage − pBe`. Coverage is measured from what the stock actually did
   and therefore contains its realized drift; `pBe` is driftless by construction. On
   a trending name the drift term dominates the difference, so a reader seeing a
   large positive gap concludes "vol is cheap here" when the true statement is "this
   stock went up." Nothing was miscalculated — the defect was presenting a
   two-component quantity as though it had one component. `drift1y`/`drift3y` are now
   rendered directly adjacent to the gap, and the legend states the confound outright.
   **When a metric is a difference of two things measured under different assumptions,
   name the assumption that differs and put it next to the number.**
22. **A null pushed through arithmetic becomes a fabricated measurement.** The Long tab's legend
   rendered **"hit rate 0% over n=12"**. Calibration really was resolved, but `hitRate` was `null`
   because a hit rate belongs to a rating and that ticker had no stored rating — and
   `(null * 100).toFixed(0)` is `"0"`. An absent measurement silently became a measured 0% accuracy,
   the exact claim the alignment tag is forbidden from implying. The code modelled two states
   (resolved / unresolved) where there were three. Check `== null` *before* the arithmetic: a missing
   value and a zero must never render the same way. **A rendered bar is a rendered number too** — the
   golden-cross `gapBar()` divided a null gap to 0 and clamped it to a 2% floor, drawing a real bar for
   a missing measurement. Caught only by auditing the whole class after the first instance; a
   `.toFixed` sweep alone would have missed it.

## Design note: overlapping windows and the proxy-vs-thing failure

The Long tab's first concentration metric was `expectancyTop3Share` — the share of
total positive P/L carried by the three largest historical windows. It was replaced
by `expectancyEpisodesTo50`, and the reason is worth keeping because the failure
generalises well beyond this one metric.

**The windows overlap by construction.** Coverage uses overlapping N-session
windows deliberately — disjoint windows would leave about five samples a year at
N=45, and the number would be worthless. But that means a single market move
appears in up to N consecutive windows. The "three largest windows" were therefore,
almost always, **three overlapping views of one episode**. The metric counted one
move three times and reported three.

Nothing about it was miscalculated. It computed exactly what it said, and what it
said was not what anyone would read it as. That is the distinguishing mark of a
**proxy standing in for the thing**, rather than a wrong number: no arithmetic
check can find it, because the arithmetic is right.

**The tell was the caveat.** The first fix was to reword the tooltip — to explain
that the three windows were probably one move, so the reader would not be misled.
That was honest and still wrong: it left a metric on screen whose plain reading was
false and relied on a paragraph of prose to undo it. **A metric that needs a
paragraph of caveat to avoid misleading is the wrong metric.** Measure the claimed
thing instead. Every window is now assigned to exactly one episode by start-index
proximity, and the metric counts how many episodes carry half the positive P/L.

**How far apart the two actually were**, measured over 323 real candidates
(8 tickers × 5 horizons × 7 strikes × 2 windows, 2026-08-09):

| | |
|---|---|
| Old flag fired (`top3Share > 0.40`) | 60 candidates |
| Candidates resting on a **single** episode (`episodesTo50 == 1`) | 180 |
| Overlap between the two | **54** |
| Single-episode candidates the old flag **missed** | **126** |
| Range of `top3Share` *within* the `episodesTo50 == 1` bucket | **2.1% – 100%** |

That last row is the finding. Inside the group the metric most needed to identify,
the old number spanned nearly its entire domain — it was close to uncorrelated with
the property it was named for. It was not a weaker version of concentration; it was
a different quantity that happened to share a plausible name.

**The general rule: anything computed over overlapping windows should be checked
for the same defect.** Ask whether the statistic counts *observations* or *events*.
Counts, extremes, "top N", tail frequencies and any variance estimate over
overlapping windows all inherit this — the independent-window estimate
(`(sessions − N) / N`) is the honest denominator, not the window count. Coverage
itself is safe because a frequency over overlapping windows is still an unbiased
estimate of the marginal probability; the counts built *on top of* it were not.

Constants: `EPISODE_CONCENTRATION_WARN` and the episode assignment in
`expectancyFrom()` (`worker.js`), tested in `moves.check.mjs` §10 — which asserts
in **both** directions, because a test that only proves de-clustering collapses
things passes on code that always answers 1.

### Lane E concentrates MORE than the one-sided lanes — measured, with the mechanism

Measured 2026-08-10 against the deployed build across all 35 watchlist names, both
populations from the **same payloads on the same day** so they are population-matched
rather than compared across sessions:

| | n | ==1 | ≤2 | ≤3 | median | p90 | max |
|---|---|---|---|---|---|---|---|
| **Lane E** (straddle + strangle, two-sided) | **140** | **28.6%** | 70.7% | 92.1% | 2 | 3 | 5 |
| — straddles only | 70 | 27.1% | 70.0% | 88.6% | 2 | 4 | 5 |
| — strangles only | 70 | 30.0% | 71.4% | 95.7% | 2 | 3 | 4 |
| **Lane B/C** (single-leg + verticals, one-sided) | **420** | **18.8%** | 56.7% | 80.5% | 2 | 4 | 7 |

**`==1` fires on 28.6% of Lane E candidates against 18.8% on Lane B/C — 9.8 points
more often, roughly 1.5×.** Do not reconcile either against the earlier
`REALISTIC 3y` table (n=198, 26.8%): that was a synthetic long-call population at
fixed moneyness multipliers, a third population again.

**The mechanism is the breakeven distance, not two-sidedness as such.** A Lane E
structure must clear a two-leg debit, so its breakevens sit far out — NVDA
2026-09-18 required 11.61% against a 0.55Δ call's few percent. Far breakevens mean
**few winning windows**, and the few winners cluster into the handful of large
market episodes. A near-the-money call wins on many moderate moves spread across
many episodes. So the concentration is a consequence of *where the breakeven is*,
and any future structure with distant breakevens should be expected to behave the
same way.

Note the distribution is also **tighter**, not merely shifted: max 5 against 7, p90
3 against 4. More mass at 1 *and* less in the long tail, consistent with the same
mechanism — fewer winners overall leaves less room for a candidate whose positive
P/L is spread thinly.

**The prediction that led here was right for the wrong evidence.** It was expected
that `==1` would fire frequently on this lane; the two tickers first inspected
(NVDA, AAPL) scored 3 and 4 and looked like a falsification. They were simply not
representative — n=2 out of 140.

### CORRECTION: the driver is the WIN RATE, not breakeven distance

The Lane E write-up above explains its concentration by **breakeven distance** —
far breakevens → few winning windows → the winners cluster into a handful of
episodes. It predicted that credit spreads, whose breakevens are also far out,
would sit nearer Lane B/C than Lane E.

**Lane F falsified it.** Measured 2026-08-10 over 698 candidates across every
lane, same day:

| lane | n | mean episodesTo50 | ==1 | mean winRate | mean \|bePct\| |
|---|---|---|---|---|---|
| B | 280 | 2.10 | 26.1% | 30.2% | 10.37 |
| C | 140 | 3.47 | 4.3% | 40.2% | 4.92 |
| E | 140 | 2.09 | 28.6% | 33.6% | 22.48 |
| **F** | **138** | **6.05** | **0.0%** | **76.0%** | **14.19** |

Lane F has the **second-farthest breakevens and the least concentration of any
lane** — the opposite of what distance predicts, and further from Lane B/C than
Lane E is rather than nearer.

```
corr(episodesTo50, winRate) =  0.691   (n=698, all lanes)
corr(episodesTo50, |bePct|) = -0.233
```

**The real driver is how many windows WIN.** Many winners spread across many
episodes; few winners concentrate into the largest moves. Breakeven distance is
only a *proxy* for that, and it is a good one **within debit structures**, where
a farther breakeven mechanically means fewer winners — restricted to Lanes
A/B/C/E the distance correlation is the stronger of the two (−0.432 against
0.319). A credit spread breaks the coincidence: it wins by *not* reaching its
breakeven, so a far breakeven means MORE winners, not fewer.

**Read the general lesson, not the specific numbers.** The original explanation
was fitted on a population where the proxy and the thing moved together, and it
was stated as the mechanism rather than as a correlate. That is the same
proxy-vs-thing failure the `top3Share` note above describes, committed while
documenting the fix for it. When an explanation is only ever tested where two
candidate causes agree, it has not been tested.

**Consequence worth knowing:** `EPISODE_CONCENTRATION_WARN = 1` **never fires on
Lane F** — 0 of 138. That is correct rather than a coverage gap: a structure that
wins 76% of the time does not rest its expectancy on a single market episode.

### The up-tail share tracks drift ÷ σ, not drift — a general result

This is **not a Lane E detail.** It applies to any coverage figure read against
realized drift, which includes the `gap` confound on every lane.

Measured across all 35 stored `moves:` series at a fixed ±10% required move, N=45,
3y window (2026-08-10):

```
corr(up-tail share, drift ÷ σ) = 0.902
corr(up-tail share, raw drift) = 0.038
```

**Raw drift is the wrong x-axis and the near-zero correlation says so.** A fixed
threshold is a large move for a quiet name and a trivial one for a wild one:

| ticker | σ (45-session) | 3y drift | up-tail share |
|---|---|---|---|
| JPM | 6.4% | 5.7% | **89%** |
| QUBT | 62% | 75.5% | **49%** |

JPM has a *tenth* of QUBT's drift and a far more lopsided split. So "on a trending
name the up-tail carries the coverage" is only true relative to that name's own
volatility — a big trend on a wild name can still split evenly, and a small trend
on a quiet one need not. The first draft of the Lane E legend asserted raw drift
and was corrected by measuring it.

Five of 35 names are lopsided past 80/20, all upward: **JPM (89%), TSM (89%),
AVGO (84%), NVDA (81%), AAPL (80%)**. One is lopsided downward: CRCL (26%), the
only name with negative 3y drift (−9.9%).

## Design note: expectancy always resolves on 3y — and why the 1y fallback was deleted

`attachCoverage()` runs expectancy on `h.sorted3y` and **nothing else**. It briefly
had a `|| h.sorted1y` fallback. That branch could never be taken, and this is a
structural property rather than an observation about current data.

**The branch was removed rather than commented, because a branch that provably
cannot fire is a false statement about the code.** It advertised a fallback that
did not exist, and a comment could not repair that: the next reader would have had
to re-derive the argument below to know whether the comment was still true. Worse,
if the horizon set or the window definitions ever changed, the dead branch would
have quietly become live with nothing covering it. What stands in its place is an
explicit invariant check in `attachCoverage()` — which *reports* the divergence
instead of silently scoring nothing — plus `moves.check.mjs` §11, which sweeps 13
series lengths across every shipped horizon and fails if a resolved 1y ever
outlives an unresolved 3y.

The 1y series is built as `c3y.slice(-min(len, 252))` — a *suffix* of the 3y one.
So:

- if the 3y series holds **≤ 252** sessions the two arrays are **identical**, and
  they resolve or fail together;
- if it holds **> 252**, then `len(3y) > len(1y)`, and since
  `independent = (len − N) / N` is increasing in `len`, `independent3y >
  independent1y` at every horizon.

Either way `sorted3y === null` implies `independent3y < 4` implies
`independent1y < 4` implies `sorted1y === null`. **3y resolves whenever 1y does.**
Confirmed exhaustively: 154 ticker × horizon pairs across the watchlist **as it
stood at 22 names (2026-08-09)**, **0 cases** where 3y is null and 1y is not; 242
scored candidates, 172 on 3y, **0 on 1y**, 70 unresolved. The argument is
structural rather than empirical, so a larger watchlist does not weaken it — but
the population is named because it is not the current one (33).

**`coverage1y` AND THE 1y EXPECTANCY PATH ARE DIFFERENT THINGS, AND THEY WILL BE
CONFLATED.** Keep them apart:

- **The `cov 1y` column is fully alive.** `coverage1y` calls
  `coverageAt(h.sorted1y, …)` **directly**, several lines before the expectancy
  block and nowhere near the deleted fallback. It renders a number on **88** of the
  horizons the watchlist reaches. The 1y-versus-3y comparison the screen exists to
  show is completely unaffected — nothing about it was removed or weakened.
- **Only the 1y *expectancy* path was dead**, and only that was deleted.

The one real consequence is for calibration: the "51% of 1y candidates flag" figure
from the concentration work describes a population that **never reaches the
expectancy code at all**. `EPISODE_CONCENTRATION_WARN = 1` is calibrated on the 3y
distribution (27%), which is the only one that ever renders — so the threshold is
correct for a stronger reason than was originally given.

Any change to `MOVES_1Y_SESSIONS`, the slicing, `MOVES_HORIZONS`, or the
independence rule must re-derive the suffix argument above. The check in §11 will
catch a divergence, but it will report it as a failure, not fix it.

## Decision: the alignment tag does not reorder, and why

The Long tab's directional alignment tag renders and has **no sort influence**.
`affectsSort` is false everywhere. This is a **data-driven disable, not dead code**
— the machinery is intact and lights up again if the measurement changes.

Read off the shipped `calib:pooled` record via `directionalRead()` on deployed rows,
2026-08-11 (`pooledAsOf: 2026-08-10`, 300 resolved outcomes), against the base rate
for the same population and window:

| outcome | rate | base rate | edge | benchmarked n |
|---|---|---|---|---|
| sign-scored BUY (`fwd20 > 0`) | **50.5%** | **60.5%** | **−10.1 pts** | 109 |
| magnitude-scored BUY (`fwd20 ≥ median abs move`) | **20.2%** | **33.7%** | **−13.5 pts** | 109 |

50.5% reads as a coin flip. It is a **negative edge**: these names drifted up, so
`P(fwd20 > 0)` over the same 20-session windows is 60.5%, and the rating
underperformed simply being long. The magnitude test — the one that actually
matters for buying options, since "went up at all" does not pay a debit — is worse.

> **SUPERSEDED, 2026-08-11.** This table read **53.3 / 61.4 / −8.1** and
> **17.3 / 34.3 / −16.9** at **n=75, 290 resolved**. Those figures came from an
> **ad-hoc analysis script, not from `recCalibration()`** — they carry the same
> date as the live pooled record and still disagree with it. The values above are
> what the shipped code emits, cross-checked against a hand recount (NVDA 9/19 =
> 0.4737, matching the endpoint exactly) and a brute-force rebuild of
> `baseRatesFrom` from raw closes (median |20d| 7.34% and `P(20d ≥ median)` 0.3575,
> both exact). Do not restore the old numbers from a stale reading; the full note,
> including the **unexplained population gap that remains open**, is under "No hit
> rate goes on screen without its base rate" in `CLAUDE.md`.

**Both outcomes score below their benchmark, so any sort influence would reorder
candidates on a measured non-edge.** That is worse than reordering on nothing: the
ordering carries an implicit claim the data contradicts. The re-enable condition is
`edgePts > 0` on the cell in use — a rate that *beats* its base rate on a population
clearing both floors — not a rate that merely exists.

**The caveats matter as much as the figures**, and are recorded verbatim:

> n=76 is small; the base rate is computed over a 3y window overlapping the period
> the recommendations were made, so it isn't clean out-of-sample; the watchlist is
> survivor-biased upward, which inflates base rates and makes the signal look
> worse; and 173 of 290 entries are HOLD, which is excluded — so the measured
> signal is thin.

(The n in those caveats was 76 at the time of that analysis; the shipped
computation now reports **109 benchmarked of 300 resolved**. The caveats stand —
they are about the *shape* of the evidence, and a thin, survivor-biased,
HOLD-dominated log at n=109 is thin in exactly the same ways it was at n=76.)

Two floors guard the figures behind this. `REC_CALIB_MIN_N` (10) gates the total
resolved count; **`REC_RATING_MIN_N` (10) gates each rating's own cell**, because a
ticker can clear the total while a rating rests on one observation — PLTR had 32
resolved entries of which 31 were HOLD, leaving BUY n=1 and a card rendering a
confident **100%**. AAPL (n=2), AMD (n=1) and CAVA (n=1) did the same, and the
pooled record added a SELL cell at n=4. All are now null with a reason naming the
count.

## Section-by-section data source map

**Everything on both pages runs on real data.** There are no mock generators left
in the codebase — the last two (`mockShortInterest`, `mockUnusualOptions`) turned
out to be dead code their cards never called, and the one genuinely fabricated
section (dark pool) was deleted rather than replaced.

The "Pro upgrade" column is gone. Free official sources — SEC EDGAR, FINRA, FRED —
now cover every row that column existed to fix, and keeping a paid recommendation
next to a working free source invites replacing something that already works.
Where a paid feed would still add something real, it is named in the notes.

| # | Component | Source today | State | Worth paying for? |
|---|---|---|---|---|
| 1 | Price, SMA 20/50/200 | Yahoo `chart`, 15-min delayed; Alpaca overlays real-time when keyed | **real** | Polygon Starter ($29) for true real-time |
| 1 | 5D/1M/1Y/5Y performance | Yahoo `chart` historical | **real** | — |
| 2 | Next earnings date | Yahoo `calendarEvents.earnings.earningsDate[0]` | **real** | — |
| 2 | Macro catalysts (FOMC, CPI, PPI, PCE, jobs, retail) | **FOMC** from the Fed's published calendar (hand-maintained `FOMC_MEETINGS`); **all statistical releases from FRED**, IDs resolved by name at runtime | **real** | — |
| 3 | Short interest, 6 settlements | **FINRA** consolidated short interest — the official biweekly figure. Yahoo single-snapshot fallback, labelled an estimate and badged Yahoo | **real** | Ortex ($35–80) for daily rather than biweekly |
| 4 | Insider trades | **SEC EDGAR Form 4** — real transaction codes, so an open-market buy (`P`) is distinguishable from a grant (`A`) or option exercise (`M`) | **real** | — |
| 5 | Options volume · V/OI screen | Yahoo chain volume + open interest | **real data, but not flow** — no side classification, no sweep detection. The card says so. | Unusual Whales ($48) for true flow |
| 6 | Option strategies + POP | Rule-based from RSI + `volRegime()` + analyst upside; POP from Worker-side Black-Scholes delta on each strike's own IV | **real** | — |
| 7 | Swing signals (EMA crossover) | Computed client-side from Yahoo daily closes | **real** | — |
| 7 | ~~Day-trade signals (ORB, VWAP)~~ | **Removed.** Both were computed from *daily* bars, which cannot express either — "ORB High" was just yesterday's high | **not shipped** | Polygon Starter ($29) for intraday bars would make them possible |
| 8 | ~~Dark pool prints~~ | **Deleted.** Fabricated, and no free source exists | **not shipped** | Unusual Whales dark-pool tab |
| 9 | Analyst targets + recommendations | Yahoo `financialData` + `recommendationTrend` | **real** | — |
| 9 | Recent upgrades/downgrades | Yahoo `upgradeDowngradeHistory` | **real** | Benzinga Pro ($177) for a firehose |
| 10 | Super-investor 13F | **SEC EDGAR 13F-HR**, 20 verified manager CIKs, index built 4 managers per cron firing | **real, partial mapping** — ~2 in 3 positions resolve to a ticker; card states how many managers are indexed and when the last full pass completed | WhaleWisdom ($30) for full CUSIP coverage |
| 11 | Technical indicators (RSI, MACD, Bollinger, Stoch, CCI, **HV30**) | Computed client-side from Yahoo OHLC | **real** | — |
| 11 | **Implied volatility** (ATM IV front/back, term structure, IV/HV30) | **Yahoo options chain via `/api/iv`** — *not* OHLC. IV cannot be derived from price history; the thing that used to be called "IV" here was a close-to-close stdev and is now labelled HV30 | **real** | — |
| 11 | IV rank | Worker-collected daily IV samples in KV (`iv:{TICKER}:{DATE}`) | **collecting** — null until 60 days, never estimated | Historical IV surface (ORATS / IVolatility) for instant history |
| 11 | Option greeks (delta) | **Computed** — Black-Scholes in the Worker; Yahoo's chain carries no greeks. Risk-free rate from FRED `DGS3MO` | **real** | Broker greeks (tastytrade / IBKR) |
| 11 | Support/resistance | Local extrema detection, 60-bar lookback | **functional** | — |
| 11 | Chart + 30d projection | TradingView Lightweight Charts + linear regression | **functional** | — |
| 12 | Sentiment | Claude synthesis over news headlines + real insider data | **real** | RavenPack ($$$$) |
| 13 | Fundamentals + valuation | Yahoo `financialData` + `defaultKeyStatistics` | **real** | FMP ($14) for 30+ years of history |
| 13 | Peer comparison | Claude infers sector context in synthesis | **partial** | FMP `sector-pe` |
| 14 | Overall rating + confidence | Claude synthesis, JSON schema; confidence renders Low/Moderate/High, never a % | **real** | — |
| 15 | Recommendation history + calibration | Cloudflare KV forward log; `fwd5`/`fwd20` filled by a 2pm PT cron; hit rate and Brier score once n ≥ 10 | **real** | — |
| 16 | News flow | Alpaca news when keyed, Yahoo `search` otherwise | **real** | Benzinga ($177) |
| — | ~~Premium screen (dashboard)~~ | **DELETED 2026-08-10.** Became Lane F of the Long screen. See the aROC note below | — | — |
| — | Long screen (dashboard) | Yahoo chain via `/api/long/:ticker`, one ticker per request: six lanes, ask-based debit (bid-based credit on F), breakeven, BE/EM, extrinsic %, leverage, annualised carry, theta, vega, `P(BE)@exp` from N(d2). Reuses `premium:{TICKER}`'s slower-moving fields when fresh (4 external fetches) and refetches them when not (8) | **real** — Lane D's breakeven/BE/EM/P(BE)/carry are **suppressed**, not estimated | ORATS for a historical IV surface; a term-structure model would unlock Lane D |
| — | Macro regime chip (Long tab header) | **Yahoo spark** — SPY, QQQ, `^VIX`, `^VIX3M`, 10y, one request/day banked by the 1:15pm PT cron into `macro:state`. SPY/QQQ trend from `smaCrossState(50,200)`; term structure = `^VIX` − `^VIX3M`, 5-session trailing mean | **real** — thresholds derived from 2,293 historical sessions; **phase 1 is display only and ranks nothing** | — |
| — | Long screen · `cov` / `gap` / `E[R]` / `E[$]` | **Measured** from `moves:{TICKER}` — 3y of Yahoo daily closes banked by the 2pm PT sweep (2 external fetches for the whole watchlist), then overlapping N-session windows. `cov` is an empirical frequency, `p(be)` beside it is modelled; `E[R]` is mean P/L over those windows ÷ capital risked | **real** — 1y/3y never averaged; horizons the history cannot support return null naming the numbers; `gapBaseline` null this release | ORATS for a historical IV surface would let `pBe` be checked against a *measured* IV rather than only against realized moves |

## Design note: the naked-margin aROC denominator, and why it is gone

The deleted premium screen ranked every row by **annualised return on capital**:

```
roc  = credit / (strike × 100 − credit)
aroc = roc × 365 / dte
```

On the put side that denominator is the cash a cash-secured put ties up, which is
defensible. **On the call side it was the naked-margin equivalent** — the capital
a broker would hold against an uncovered short call. The screen said so in its
legend, and the legend was the problem rather than the fix.

**It is the wrong denominator for the person using this dashboard.** Nobody sells
uncovered calls here; a short call is sold against shares. For a share-holder the
capital at risk is not the naked-margin requirement — it is the position already
owned, whose cost basis this codebase does not know and cannot know. So the number
was computed against a capital base the user did not have, for a structure they
would not put on, and then used as the **primary sort key** for the whole screen.

Three distinct faults, worth separating because only the first is obvious:

1. **Not comparable across sides.** Put-side aROC and call-side aROC used
   different capital bases, so ranking them in one list ordered by an inconsistent
   unit. A row could outrank another purely by being on the other side.
2. **Not comparable to anything else in the app.** Every other return figure is
   over capital genuinely at risk. This one was not, so it could not be read
   against `E[R]` or against a debit structure's return.
3. **It flattered exactly the structures with unbounded risk.** Naked margin is
   far smaller than the loss a short call can actually produce, so the worse the
   tail, the better the number looked. A ranking metric that rewards unbounded
   risk is not a weak metric; it points the wrong way.

**Lane F's replacement is `returnOnRisk = credit / (width × 100 − credit)`** —
credit over the real, bounded max loss, identical in construction on both sides,
and the same quantity `expectancyFrom` divides by. It is **not annualised**,
deliberately: annualising invites comparison across DTEs that the expectancy sort
already handles properly, and the `× 365 / dte` factor was doing most of the work
in the old ranking.

**Do not reintroduce an annualised ROC against a naked or share-based denominator.**
If a covered-call view is ever wanted it needs a real cost basis, which means
position awareness this app does not have — see the position-unaware note on Lane F.

## If you ever want to pay for data

The free stack now covers everything except intraday bars and true options flow.
What is left is genuinely not obtainable free:

| Service | Cost | What it would actually add |
|---|---|---|
| Polygon.io Stocks Starter | $29/mo | **Intraday bars.** The only thing that would bring back opening-range breakout and VWAP, which were deleted because daily bars cannot express them. Also real-time rather than 15-min-delayed prices. |
| Unusual Whales | $48/mo | **Real options flow** — side classification and sweep detection, which the V/OI screen explicitly does not do. Also a dark-pool feed, the one deleted section with no free substitute. |
| WhaleWisdom Premium | $30/mo | **Full CUSIP→ticker coverage** for 13F, taking mapping from ~2 in 3 to complete and resolving dual-class properly. |
| FMP | $14/mo | 30+ years of fundamentals and a real peer screener. |
| ORATS / IVolatility | $$ | **Historical IV surface** — would make IV rank meaningful immediately instead of after 60 days of self-collected samples. |
| Ortex | $35–80/mo | Daily short interest rather than FINRA's biweekly settlement. |

Nothing here replaces something already working. SEC EDGAR, FINRA and FRED are
free, authoritative, and already wired.

## Cloudflare Worker setup

### Bindings

```toml
# wrangler.toml
name = "stock-research-worker"
main = "worker.js"
compatibility_date = "2024-09-01"

[[kv_namespaces]]
binding = "REC_LOG"
id = "<your-kv-namespace-id>"

[triggers]
crons = ["*/15 13-22 * * *"]
```

The expression is a coarse wakeup only — every day, no calendar logic. `scheduled()`
gates on the Pacific trading day (weekends + `NYSE_HOLIDAYS`) and dispatches by
Pacific wall-clock. The UTC hour range must still cover the target Pacific hours
under **both** PDT and PST. See rules #2 and #7 in `CLAUDE.md`: a `1-5` in the
day-of-week field meant Sun–Thu, not Mon–Fri, and no job ran on a Friday for weeks.

### Secrets

```bash
npx wrangler kv namespace create REC_LOG    # NOT kv:namespace — deprecated syntax

npx wrangler secret put ANTHROPIC_API_KEY   # required — all Claude synthesis
npx wrangler secret put FRED_API_KEY        # macro release dates AND the DGS3MO risk-free rate
npx wrangler secret put FINRA_CLIENT_ID     # official short interest
npx wrangler secret put FINRA_CLIENT_SECRET #   (FINRA_API_KEY / _SECRET also accepted)
npx wrangler secret put ALPACA_KEY          # optional — real-time price + news archive
npx wrangler secret put ALPACA_SECRET
npx wrangler deploy
```

SEC EDGAR needs no key, but `SEC_UA` in `worker.js` must carry a real contact
email or EDGAR 403s every request.

**`wrangler dev` does not see deployed secrets** — it reads `.dev.vars`, which is
gitignored. A local run without it shows no premium candidate strikes (no
risk-free rate → deltas suppressed), a FOMC-only econ calendar, Yahoo-estimate
short interest, and empty Claude cards. That is the expected degradation, not a
bug.

Then set `API_BASE` at the top of **both** HTML files to your Worker URL and push
to GitHub Pages.

### Endpoints

All return `application/json; charset=utf-8`, all CORS-enabled via
`ALLOWED_ORIGINS`, all carrying `_meta` for the provenance badge.

```
GET  /api/quote/:ticker            Yahoo quoteSummary (multi-module) + Alpaca overlay
GET  /api/chart/:ticker            ?range=1y&interval=1d
GET  /api/options/:ticker          ?date=<unix>
GET  /api/iv/:ticker               ATM IV front/back, term structure, IV rank, HV30, POP ladder
GET  /api/premium/*                REMOVED 2026-08-10 — returns 410. Became Lane F of the Long screen.
GET  /api/watchlist                The saved list; read path for the adopt-on-empty bootstrap
GET  /api/long/batch?symbols=      Long screen — no fetches; 1 KV read/symbol + 1 macro read (33 = capCost 34)
GET  /api/long/:ticker             One ticker (?refresh=1 forces, ?cached=1 never fetches)
GET  /api/insider/:ticker          SEC EDGAR Form 4, last 90 days
GET  /api/short/:ticker            FINRA consolidated short interest (Yahoo fallback)
GET  /api/13f/:ticker              Super-investor 13F, from the KV reverse index
GET  /api/earnings/:ticker         Last report: numbers, price reaction, call coverage
GET  /api/search?q=apple           Ticker search
GET  /api/news/:ticker             Alpaca news → Yahoo fallback
GET  /api/peers/:ticker            Yahoo recommendationsBySymbol
POST /api/claude                   REMOVED — returns 410. Was an unauthenticated LLM passthrough.
POST /api/log-rec                  {ticker, rating, confidence, price, factors}
GET  /api/track/:ticker            Rating history + calibration
GET  /api/daily                    Morning briefing + EOD + midday, from KV
GET  /api/market/snapshot          Index / futures / commodities strip
GET  /api/market/movers            Pre-market and day movers (≥ ±10%)
GET  /api/market/ipos              Upcoming IPO calendar
GET  /api/market/sectors           11 SPDR sectors + Claude picks   (?cached=1)
GET  /api/market/scanner?preset=   Momentum scanner, 5 Pillars      (?cached=1)
GET  /api/market/golden-cross      Golden-cross setups, EMA + SMA   (?cached=1)
GET  /api/market/econ-calendar     FOMC + FRED release dates
GET  /api/market/week-ahead        Friday-only week preview
GET  /api/watchlist/batch          Bulk fundamentals + RSI + SMA cross + Claude analysis
GET  /api/watchlist/auction        Closing-auction block trades
POST /api/watchlist/save           Persist the watchlist for the cron jobs
GET|POST|DELETE /api/analysis/:t   Per-ticker Claude analysis cache
POST /api/admin/refresh-daily      Bearer-token gated (admin:token in KV)
POST /api/admin/refresh-midday     Bearer-token gated
```

---

## Recommendation track record — how it works

This is the section the spec asked for explicitly: *"History of recommendations and price action so user can see where the analysis was good/bad."*

The prototype implements **forward-logging from day one**:

1. `synthesize()` runs on every ticker page-load, but the Worker writes **at most one entry per
   ticker per US/Pacific trading day** to `rec:{TICKER}` — a same-day call overwrites the newest
   entry instead of appending:
   ```json
   { "ticker": "PLTR", "rating": "BUY", "confidence": 78, "price": 187.34,
     "factors": {...}, "ts": "2026-05-01T14:23:11Z", "d": "2026-05-01",
     "fwd5": null, "fwd5Close": null, "fwd20": null, "fwd20Close": null }
   ```
   Appending on every load produced a dozen rows for one trading day, which weighted the log by how
   often a ticker was browsed rather than how often the call was right.
2. A 2pm PT cron (`fillForwardReturns`) resolves `fwd5` / `fwd20` — percent return vs the entry
   price — 5 and 20 trading sessions later, keeping the realising close alongside for audit.
3. The Recommendation History card (section 15) reads the list back with per-entry forward returns
   and current price.
4. Calibration appears once **10 entries have a resolved 20-session outcome**: hit rate by rating
   (HOLD excluded — it makes no directional claim), mean fwd5/fwd20 by rating, and a Brier score
   over the confidence values. Below that threshold the endpoint returns nulls and a reason string,
   and the card renders the reason rather than a number (honesty rules 2 and 3).

**For backfilling history**: the underlying signals (RSI/MACD/Bollinger/analyst targets) are all reproducible from Yahoo's historical data. A backfill script could synthesize "what would Claude have said on date X" by pulling Yahoo data as-of date X and replaying. Worth a session — maybe 100 lines of Node.

**For automation**: schedule the Worker via Cloudflare Cron Triggers (free) to refresh ratings nightly for a watchlist of tickers. That builds the track record while you sleep.

---

## Build position — steps 1–4 SHIPPED, step 5 next

This is the authoritative record of where the build stands. **All four steps below
are live in production as of 2026-08-11.** Nothing in this document describes them
as planned; if you find language that does, it is stale and wrong.

**This file is authoritative for build position, data sources and design decisions —
not for the whole system.** The record is six files, and this is one of them:
`CLAUDE.md` (rules, Worker invariants, workflow — resident every session),
`ARCHITECTURE.md` (this file), `.claude/skills/worker-internals/SKILL.md` (Worker
endpoints, KV keys and TTLs, cron, external data sources),
`.claude/skills/long-screen/SKILL.md` (Lanes A–F, move coverage, macro regime),
`docs/rules-evidence.md` (the measured runs behind rules 1–7), and
`docs/failure-modes.md` (the incident record behind the nine named failure modes).
The two skills load on demand, not every session.

| step | what it was | status |
|---|---|---|
| **1** | **`moveCoverage`** — measured historical move frequency, `moves:{TICKER}`, coverage / gap / drift / expectancy / de-clustered episode concentration | **SHIPPED** 2026-08-09 |
| **2** | **Pooled calibration + magnitude-scored outcome** — `calib:pooled`, per-rating floor, base rates beside every rate | **SHIPPED** 2026-08-10 |
| **3** | **Lane E** — straddle + strangle, two-sided coverage and P(BE), the hold-to-expiry caveat | **SHIPPED** 2026-08-10 |
| **4** | **Premium merged into Long as Lane F** — defined-risk credit spreads; the standalone Premium tab, its row model and `/api/premium/*` deleted | **SHIPPED** 2026-08-10 |
| **5** | **`macroRegime` phase 1** — SPY/QQQ trend + VIX level + VIX term structure, one chip in the Long tab header, **display only: no sort, no gate, no blend** | **SHIPPED** 2026-08-11 |

Everything under "Not yet done" is genuinely outstanding. It does **not** include
steps 1–5, but it **does** include `macroRegime` **phase 2**, which is specified
and deliberately unbuilt.

## Not yet done

Items 1, 2, 5 and 6 of the original list are **done** (SEC EDGAR Form 4 + 13F, FINRA
short interest, the watchlist, cron-driven refresh) and have been removed. So has
Strategy POP, which now ships — Black-Scholes delta in the Worker, a `pop` strike
ladder on `/api/iv/:ticker`, and `1 − |Δ|` on the cards. What remains:

1. ~~**Lock down `/api/claude`**~~ — **done**, in four layers. See the residual-risk
   section below for what those layers do *not* cover, which is the part worth
   reading.

2. **Confirmed-vs-estimated earnings dates.** Yahoo returns
   `earningsDateIsEstimate` and nothing in the codebase reads it. Every earnings
   date on the catalyst card, the watchlist column and the Long screen is presented
   with equal confidence whether the company confirmed it or Yahoo guessed it from
   last year's pattern. **This got MORE load-bearing, not less, when the premium
   screen was deleted**: Lane E gates on whether a catalyst falls inside the expiry
   (`no-catalyst-inside`), so an estimated date off by a week can flip a gate on
   the lane whose whole value is refusing 91% of candidates. Surface the flag and
   let the gate say when it is working from an estimate.

3. **Position awareness.** The app knows nothing about what is actually held, so
   every recommendation is written as if from flat. Missing: cost basis, days to
   long-term capital gains, open option legs, and wash-sale windows. A SELL on a
   lot 20 days from LTCG, or a covered call written against shares already assigned
   elsewhere, is advice that ignores the constraints that matter most. This is the
   largest gap between the tool and how it is actually used.

4. **13F dual-class CUSIP resolution.** Mapping is by issuer name via
   `normIssuer()`, which deliberately strips `CL`/`CLASS`/`A`–`C` tokens, so
   GOOGL/GOOG and BRK.A/BRK.B collapse to one normalised name and resolve to
   whichever ticker SEC's `company_tickers.json` happens to list first
   (`if (!byName.has(n))` — first wins). **There is no hardcoded override map**, in
   this or any other form; if you came here expecting one, it does not exist. About
   1 in 3 positions fail to map at all. A real CUSIP table would fix both problems;
   SEC's ticker file carries no CUSIPs and no share-class detail, which is the
   binding constraint.

5. **`Hist Win` backtest on `index.html`.** The stat stays blank on the research
   page's strategy card, pending a real backtest of each structure on the
   underlying. It sits beside POP so the difference between a formula and a
   measurement stays visible. **The Long tab now has the measured counterpart**
   (`cov`, from `moves:{TICKER}`), but wiring it into `renderStrategies()` was
   deliberately deferred: that card's structures are mostly credit strategies with
   no Long-tab equivalent, and it would need coverage delivered over `/api/iv`.

6. **A structural baseline for `gap`.** Currently `gapBaseline` is null with a
   reason, because a median over the handful of candidates a row scores is
   circular. The intended replacement is computed at collection time: compare the
   empirical distribution to the lognormal implied by that day's ATM IV at fixed
   reference points (±0.5σ, ±1σ, ±1.5σ), stored in `moves:{TICKER}`, reading
   `iv:{TICKER}:{date}` written 45 minutes earlier by the 1:15pm cron — no extra
   fetch and no request-path race. **That baseline is itself drift-contaminated**
   (honesty rule 26) and whatever spec it gets must say so.

7. ~~**Recalibrate `EPISODE_CONCENTRATION_WARN` once a full watchlist sweep
   exists.**~~ — **DONE 2026-08-10.** The first stored sweep landed and the
   threshold was re-derived from stored pairs: the storage round-trip is exact
   (40 of 40 arrays identical pair-for-pair, 0 differing), and `==1` held at
   **26.8%** on the calibration population, unchanged. It was then measured per
   lane on real candidates: **Lane B/C 18.8%** (n=420), **Lane E 28.6%** (n=140),
   **Lane F 0.0%** (n=138). `1` stands. See the mechanism correction above — that
   exercise is also what falsified the breakeven-distance explanation.

8. **Base rates on `index.html`'s Recommendation History card.** The rule is that
   no rate renders without its base rate, and it applies retroactively.
   `/api/track/:ticker` now returns `baseRate` and `edgePts` on every cell, and the
   per-rating floor already reaches that card — so the n=1 100% is fixed there. But
   the card still renders only the raw rate. Surfacing the benchmark means touching
   `index.html`, which is a separate commit.

12. **THE CALIBRATION ELIGIBILITY GAP — open, and the most consequential loose
   thread in the repo.** Reconciling the BUY figures on 2026-08-11 established
   *which* numbers ship (50.5 / 60.5 / −10.1 and 20.2 / 33.7 / −13.5, n=109
   benchmarked of 300 resolved) and left a hole underneath them: the superseded
   ad-hoc figures reported **75 benchmarked of 290 resolved on the same date**.
   Two cross-checks — a hand recount of NVDA at 9/19 = 0.4737 and a brute-force
   rebuild of `baseRatesFrom` from raw closes — confirm the **arithmetic**.
   **Neither confirms the ELIGIBILITY RULE**: which rows are admitted to the
   benchmarked set at all. If the ad-hoc script excluded ~34 entries for a reason
   nobody wrote down, `recCalibration()` is admitting them wrongly and every rate
   inherits it.

   **This is load-bearing rather than academic.** The Long tab's directional
   alignment tag is disabled *on these figures* — `sortDisabled: true`,
   re-enabled only at `edgePts > 0` — so the eligibility rule decides whether a
   shipped ranking behaviour is correctly disabled. Needs its own task: reconstruct
   what the ad-hoc script filtered on, and either justify `recCalibration()`'s
   population or narrow it. Do not close it by re-running the same arithmetic.

13. **`MOVES_RANGE` 3y → 10y — COUPLED TO PHASE 2, and genuinely two-sided.**
   Ranks below item 12: the eligibility gap underpins a live disablement decision,
   this only widens a horizon that is currently *honest* about refusing.

   **What it fixes.** Lane A publishes no measured coverage at all, and that is
   arithmetic rather than a data gap: its contracts snap to the 365-session
   horizon, where a 3y series gives `(751 − 365)/365 ≈ 1.06` independent windows
   against `COVERAGE_MIN_INDEPENDENT = 4`. Clearing 4 needs ~1,825 sessions
   (~7.25y). **Measured 2026-08-11: 0 of 66 Lane A candidates clear it.** The
   `macroRegime` §1 work already proved spark honours `range=10y`.

   **Verified per ticker, not extrapolated from an index** (10y spark, 2026-08-11,
   all 33 watchlist names). **23 of 33 would clear the floor; 10 still refuse:**

   | | sessions | ind @365 |
   |---|---|---|
   | CRCL / CRWV / RDDT | 297 / 344 / 599 | −0.19 / −0.06 / 0.64 |
   | ARM / CAVA / APLD / SMR | 729 / 790 / 1080 / 1110 | 1.00 / 1.16 / 1.96 / 2.04 |
   | HOOD / APP / **PLTR** | 1259 / 1336 / **1470** | 2.45 / 2.66 / **3.03** |
   | QUBT / MDB / VST … AAPL | 1986 … 2512 | 4.44 … 5.88 |

   **So 10y is not a universal fix**, and PLTR — a core name — still refuses at
   1,470. Any write-up claiming "10y resolves Lane A" is wrong; it resolves it for
   the names that have existed long enough, which is a per-ticker floor of 1,825
   sessions that must be stated wherever the change is described.

   **The arguments against, which are the real ones:**
   - Storage ~60 KB → ~200 KB per ticker. **Irrelevant** against KV's 25 MB.
   - **10y reaches to 2016 — a different vol regime, a different rate regime, and
     for NVDA / PLTR / CRWV a materially different company.** Coverage that clears
     its floor by borrowing 2017 may be worse than an honest refusal. This is the
     objection the arithmetic does not answer. Note the uncomfortable shape of it:
     **10y helps precisely the names where the regime objection is strongest**
     (the long-listed mega-caps that have re-rated), and does nothing for the
     recent listings where a longer window would be most welcome.
   - It needs a **`MOVES_SCHEMA` bump**, which retires every cached blob and blanks
     the coverage columns until the next 2:00pm sweep.
   - **THE STRONGEST OBJECTION, AND IT IS A PREREQUISITE RATHER THAN A DETAIL:
     the refusal is UNIFORM today and would become PARTIAL.** All 66 Lane A
     candidates refuse, so no ticker is advantaged over another and there is no
     ranking distortion — the lane is equally silent everywhere. At 10y it splits
     **23 measured / 10 refusing**. And `moves:` backs the **expectancy ranking**,
     not only the `cov` column, so Lane A candidates would then be ordered on a
     basis that exists for some tickers and not others — **PLTR competing against
     NVDA on a metric only NVDA has.**

     **There is no rule for how a null coverage sorts against a present one within
     a lane, because it has never been needed.** Uniform refusal has meant the
     question could not arise. So the range bump is **not self-contained**: it
     requires that rule to be stated and shipped first, or in the same commit.
     Sorting nulls last silently demotes every young name; sorting them first
     promotes them; treating null as zero is a fabricated measurement (honesty
     rule 22). None of those is obviously right and the choice must be deliberate.
     Note Lane A currently sorts on cost of carry rather than expectancy, which
     narrows but does not remove the problem — any lane whose sort key comes from
     `moves:` inherits it the moment coverage becomes partial.

   **Why it is COUPLED to item 14 rather than separate.** Phase 2 needs the same
   schema bump for the `startIdx → date` mapping, so **the two belong in ONE
   commit**. And the coupling is substantive, not just convenient: phase 2's
   pre-registered expectation was computed at 3y — ~5.3 independent windows per
   regime at N=45, expected to null at most horizons. At 10y that becomes
   `(2514/3 − 45)/45 ≈ 17` per regime. **That could move conditioned coverage from
   "expected to null everywhere" to "actually measurable"**, which is the most
   consequential thing on this list and the main reason to consider the change at
   all. Do not do one without deciding the other.

14. **`macroRegime` phase 2 — does macro state actually SEPARATE outcomes?**
   Phase 1 displays the state and deliberately does not rank on it. Phase 2 is the
   measurement that could earn a ranking influence, and nothing else can:
   `moves:{TICKER}` stores `[return, startIdx]` pairs, so if each historical
   session index can be mapped to a date, every window can be labelled with the
   regime it started in and coverage computed conditioned on regime — *"in
   backwardated-VIX regimes NVDA cleared this breakeven 14% of the time, against
   31% across all regimes."* `macro:series` already holds the 3y per-session slice
   precisely so no second collection pass is needed. Mapping `startIdx` to a date
   needs a **`MOVES_SCHEMA` bump**, which retires every cached blob and blanks the
   coverage columns until the next 2:00pm sweep — a phase 2 decision, and it was
   deliberately **not** taken in phase 1.

   **The likely outcome, stated in advance so it is not read as a failure:**
   conditioning splits an already-thin sample. At N=45 a 3y series gives ~15.8
   independent windows; split three ways that is ~5.3 per regime against
   `COVERAGE_MIN_INDEPENDENT = 4` — and 5.3 is optimistic, because regimes arrive
   in contiguous stretches (measured: median hostile run 7 sessions, p90 55) so
   conditioned windows are far more autocorrelated than an even split implies.
   Pooling across the 33 names does not fix it: they share the regime by
   construction, so pooling adds windows without adding independent observations of
   the regime. **If conditioned coverage nulls out at most horizons that is a
   legitimate finding, not something to engineer around.** Do not lower
   `COVERAGE_MIN_INDEPENDENT` to buy the horizons back; the honest conclusion would
   be that this dataset cannot support a macro-conditioned claim and `macroRegime`
   stays informational permanently. Any conditioned figure must be reported against
   its unconditioned base rate — 14% means nothing without the 31% beside it.

   **Phase 2 should condition on `hostileVia`, not only on `state`.** Two thirds of
   hostile sessions come from the index-trend clause with the VIX term structure in
   contango; those are unlikely to behave like backwardation episodes.

15. **FOUR CRON JOBS STAMP THEIR DEDUP KEY ON A FAILED RUN — measured, awaiting a
   decision on the fix.** `eod-summary`, `iv-sweep`, `forward-returns`,
   `move-series` and `13f-slice` all stamp after a run that accomplished nothing,
   because each swallows its own per-item failures. The full measured table, the
   forcing method and the per-job verdicts are in **CLAUDE.md rule #7**, under
   *"KNOWN DEFECT, NOT FIXED"*. Three things make this worth its own item:

   - **The IV sweep is the one that costs data.** A 0-of-33 sweep stamps
     `ivsweep:last` and dedups itself out for the PT day; `ivRank` needs an
     unbroken daily series and the gap does not backfill. A day of macro or 13F is
     recoverable; a day of IV samples is not.
   - **The 13F window is 7 days, not 1.** `lastFullPass` is stamped on wrap even
     when all 20 managers failed, and `refresh13FIndexIfStale` then idles.
   - **`dispatchJob` made it quieter.** Such a run is a clean 200 and prints no
     `!! JOB-FAILED !!`, so neither of rule #7's two evidence channels sees it.

   **`generateDailySnapshot` already contains the fix pattern** and is the model to
   copy: it writes its failure placeholder with `ts: 0`, and its dedup demands
   `isComplete` as well as freshness — two independent guards, both verified to
   hold. The shape of a fix is to make each stamp conditional on the run having
   accomplished something, and to decide per job what "something" means (`ok > 0`?
   `ok >= some fraction of N`?) — that threshold is a judgement call, which is why
   this is queued rather than done.

   **One line in `worker.js` is now known to be false and is deliberately left
   alone** so it can be corrected alongside the fix: the block comment above
   `dispatchJob` claims *"A job that fails still fails: it stamps no dedup key, so
   the next firing retries it."* That holds on the rejection path it was measured
   against, and not for the four jobs above.

9. **Chart pattern recognition.** Head-and-shoulders, cup-and-handle etc.
   Lightweight Charts supports custom drawings; recognition would be rules-based
   code or a Claude vision call against a chart screenshot.

10. **Backfill of recommendation history.** The forward log only grows from first
   use. RSI/MACD/Bollinger/analyst inputs are all reproducible from Yahoo history,
   so a replay script could synthesise "what would the model have said on date X".
   Roughly 100 lines of Node, and it would make the calibration card useful
   immediately rather than after 10 resolved entries.

11. **Two `setBadge()` implementations.** `index.html` and `dashboard.html` each
   carry one, byte-for-byte equivalent. No build step and no module system, so the
   alternatives were duplication or a third HTTP request. If a bundler ever
   arrives, unify these first — they are the most drift-prone duplication left.

---

## Security posture and residual risk

`POST /api/claude` was an unauthenticated passthrough that forwarded caller-supplied
`messages` to Anthropic on the owner's key. Four layers now sit in front of AI
spend. **None of them is authentication**, and the honest summary is that they
convert an unbounded liability into a bounded one — they do not make the Worker
secure.

### What each layer actually does

| Layer | Stops | Does **not** stop |
|---|---|---|
| **1. No passthrough.** Callers name a task + ticker; prompts are built in `worker.js` | The endpoint having any value as a free LLM. This is the only *structural* fix here | Someone burning your quota generating equity analyses of random tickers |
| **2. Origin allowlist**, absent Origin now rejected | Hostile web pages using the Worker through a visitor's browser; scanners that send no headers | `curl -H 'Origin: https://ambermlysak.github.io'`. Origin is client-set and forging it is one flag |
| **3. Shared secret** `x-dash-key` | Opportunistic abuse of a URL found in a network trace or a repo search | Anyone who opens devtools or reads `index.html`, which is public on GitHub Pages. **The secret is in the client bundle by design** |
| **4. Rate limits**, 40/IP/hour + 60/day global, counted in Claude *calls* | The bill being unbounded. This is the layer that actually protects money | A determined attacker rotating IPs, who still gets 60 calls/day out of you |

### What remains open, concretely

- **The secret is public.** Anyone who views source on the GitHub Pages site has it.
  Layer 3 raises the effort from "curl the URL" to "read one JS file". That is a
  real reduction in drive-by risk and nothing more. Treat it as a speed bump with
  a rotation procedure, not a credential.
- **Origin is forgeable in one flag.** Layer 2 is meaningful only against browsers,
  which honour it, and against lazy scanners, which do not set it.
- **The global daily cap is the real ceiling, and it is not zero.** 60 calls/day at
  the most expensive gated route (7500 output tokens) ≈ **$12/day worst case**, or
  ~$365/month, if someone with the secret decides to spend it. `AI_RATE_GLOBAL_DAY`
  is the only number that bounds this.
- **The ceiling counts Claude calls, not HTTP requests** — `aiGuard` takes a `cost`
  and `/api/watchlist/batch` charges one per queued analysis. This was not true at
  first: counting requests meant a 60/day ceiling actually authorised ~1,800 calls,
  because one batch request fans out to 30. Any new endpoint that makes more than
  one Claude call per request must pass its own `cost`, or it silently reopens the
  same 30× gap.
- **Cron spend is on top of the ceiling, not inside it** — see below.
- **Rate limiting is approximate.** KV has no atomic increment, so the counter is
  read-modify-write and concurrent requests undercount. A burst can overshoot the
  ceiling before the count catches up. It is a ceiling, not a valve.
- **A KV failure degrades to the secret alone.** If the counter read or write
  throws, the request proceeds and logs a warning. Failing closed on a KV blip
  would take the app down; the tradeoff is that a KV outage removes the ceilings.
- **KV writes are still attackable — the move to Workers Paid changed the shape of
  it, not the exposure.** The limiter writes two KV entries per gated request. Under
  the Free plan's 1,000 writes/day that meant sustained hammering could *exhaust the
  quota*, breaking the counters and the app's own caching. On Paid there is no daily
  write cliff, so the same hammering becomes *billed KV operations* instead: a
  smaller functional risk and a new cost one. Either way the rate limit bounds
  Anthropic spend, not KV spend.
- **Cron spend is outside all of this.** The scheduled jobs call `workerClaude()`
  directly and are bounded by their schedule, not by the gate. That is deliberate —
  they have no request to authenticate — but it means the ceilings describe
  request-path spend only.
- **Nothing here authenticates a *user*.** There are no accounts and no sessions.
  Every visitor to the public page is the same principal.

### What would actually close it

In increasing order of effort:

1. **Cloudflare Access** in front of the Worker — real identity, ~free at this
   scale, and the only item on this list that is genuinely authentication.
2. **Move synthesis fully server-side and delete the request path**, letting the
   cron own all generation. The page would read KV only, and there would be no
   AI endpoint to abuse.
3. **Anthropic-side spend caps** as the backstop that does not depend on this
   Worker being correct.

Until one of those is in place, the accurate statement is: *the endpoint is no
longer an open LLM proxy, and worst-case request-path spend is bounded at roughly
$12/day by a limiter that a determined attacker can still reach.*

## Visual design notes

- **Fonts**: Fraunces (display serif), Geist (body), JetBrains Mono (numbers). Serif headers in
  fintech are deliberately rare — it reads as editorial research rather than terminal clone.
- **Aesthetic**: "trading floor at midnight" — deep charcoal base (`#0a0a0c`), warm off-white text
  (`#f5f1eb`), restrained accents. Subtle grain overlay and soft radial gradients.
- **Colours** are CSS custom properties in `:root`; never hardcode a hex. `--bull` `#23d18b` /
  `--bear` `#f25f5c` (muted, not neon), `--amber` `#f4b740` neutral and stale, `--cyan` `#5ec5ea`
  data accent, `--violet` `#b48ead`, `--bg-0..3` background layers, `--ink-0..3` text.
- **`--violet` no longer means "mock data".** It marked the "Sample · upgrade: X" badges, which are
  gone along with the mock sections. It is now just an accent — earnings news tags, the week-ahead
  badge, options trade labels in the Midday pulse, and the earnings-unavailable panel. Nothing in
  the UI signals "this data is fake", because nothing is.
- **Provenance instead**: `.src-tag` on every card header, rendered from the `_meta` a fetch
  returned. Cyan when fresh, amber when the source is delayed or our copy is stale, red when the
  fetch failed. Never hand-written in markup — see honesty rule 5.
- **Centerpiece**: the AI Synthesis card, italic Fraunces verdict at 56px with a circular SVG
  confidence ring. The ring is drawn in **three discrete steps** (Low / Moderate / High) so the arc
  cannot be read back as a percentage — see honesty rule 6.
