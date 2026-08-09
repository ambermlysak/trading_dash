# Equity Research Terminal — Architecture & Data Sources

## Repo layout

```
trading_dash/
├── dashboard.html       # Macro landing view — 6 tabs (market, midday, scanner,
│                        #   watchlist, sectors, premium)
├── index.html           # Per-ticker research page — hero + 14 numbered cards
├── worker.js            # Cloudflare Worker: Yahoo / SEC EDGAR / FINRA / FRED /
│                        #   Alpaca proxy, Claude calls, KV persistence, cron jobs
├── wrangler.toml        # Worker config: KV binding, cron trigger, secret inventory
├── bs-delta.check.mjs   # Black-Scholes delta check — prints computed vs expected
├── nd2.check.mjs        # Long tab P(BE)@exp = N(d2), theta, vega — three
│                        #   independent cross-checks, prints computed vs expected
├── long-fixtures.check.mjs # Long-screen paths live data cannot reach: the IV-rank
│                        #   gate branch, Lane A with two Januaries, the IV guard
├── instr-bindings.check.mjs # The binding counter: shape detection, automatic
│                        #   pickup of a new binding, and its failure paths
├── cron-gate.check.mjs  # Cron trading-day gate check — weekends, NYSE holidays,
│                        #   both DST regimes; prints computed vs expected
├── cron-gate.check.mjs  # Cron trading-day gate check — weekends, NYSE holidays,
│                        #   both DST regimes; prints computed vs expected
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

**`dashboard.html`** — seven tabs, all deep-linkable by hash:

| Tab | Contents | Data path |
|---|---|---|
| Market | Index/futures/commodities strip, 6am Claude briefing, EOD card, Friday week-ahead, news cards, pre/post-market movers (≥ ±10%), IPO calendar, watchlist signals | loads on page load |
| Midday | 11:30am PT pulse: session narrative, topics, next-day events, short-term ideas, big movers | `daily:midday` via `/api/daily` |
| Scanner | Momentum / HOD · Pre-Market Gappers · All Movers · **Golden Cross Setup** | first three `/api/market/scanner`; golden cross has its own endpoint and renderer |
| Watchlist | 14 columns, sortable, expandable rows, one consolidated Recommendation | `/api/watchlist/batch` |
| Sectors | 11 SPDR sectors, ETF change + Claude opportunity/avoid per sector | `/api/market/sectors`, 4h KV |
| **Premium** | Short-premium screen: collapsed rows, expand to fetch | `/api/premium/batch` (KV only) + `/api/premium/:ticker` on expand |
| **Long** | Long-premium screen: LEAPS / swing / debit verticals / calendars, collapsed rows, expand to fetch | `/api/long/batch` (KV only) + `/api/long/:ticker` on expand |

The Premium tab replaced an "Options" tab that showed a V/OI unusual-activity
recap of the nearest expiration. That view is deleted, not moved — it answered
"what traded today", and at the nearest expiration the answer is mostly 0DTE churn.
It is the only tab that fetches on interaction rather than on load; Sectors and
Scanner paint a KV snapshot immediately and revalidate behind it, so no tab
requires a click to show data.

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
11. **"We have not looked yet" is not the same as "there is nothing there."** The premium screen
   rendered four different situations as one dim red block: no row computed yet, no options listed,
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
| — | Premium screen (dashboard) | Yahoo chain via `/api/premium/:ticker`, one ticker per request: term structure, expected move, 0.30/0.16-delta strikes, credit, ROC, annualised ROC, POP | **real** | ORATS for a historical IV surface |
| — | Long screen (dashboard) | Yahoo chain via `/api/long/:ticker`, one ticker per request: four lanes, ask-based debit, breakeven, BE/EM, extrinsic %, leverage, annualised carry, theta, vega, `P(BE)@exp` from N(d2). Reuses `premium:{TICKER}`'s slower-moving fields when fresh (4 external fetches) and refetches them when not (7) | **real** — Lane D's breakeven/BE/EM/P(BE)/carry are **suppressed**, not estimated | ORATS for a historical IV surface; a term-structure model would unlock Lane D |

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
GET  /api/premium/batch?symbols=   Premium screen — KV read only, zero outbound calls
GET  /api/premium/:ticker          One ticker (?refresh=1 forces, ?cached=1 never fetches)
GET  /api/long/batch?symbols=      Long screen — KV read only, zero outbound calls
GET  /api/long/:ticker             One ticker (?refresh=1 forces, ?cached=1 never fetches)
GET  /api/insider/:ticker          SEC EDGAR Form 4, last 90 days
GET  /api/short/:ticker            FINRA consolidated short interest (Yahoo fallback)
GET  /api/13f/:ticker              Super-investor 13F, from the KV reverse index
GET  /api/earnings/:ticker         Last report: numbers, price reaction, call coverage
GET  /api/search?q=apple           Ticker search
GET  /api/news/:ticker             Alpaca news → Yahoo fallback
GET  /api/peers/:ticker            Yahoo recommendationsBySymbol
POST /api/claude                   {messages, max_tokens?, system?, output_config?}  ⚠ unauthenticated
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
   date on the catalyst card, the watchlist column and the premium screen's
   `insideFront` flag is presented with equal confidence whether the company has
   confirmed the date or Yahoo guessed it from last year's pattern. That matters
   most exactly where it is used hardest: the premium screen picks a "clean"
   expiry by asking whether earnings falls inside it, and an estimated date can be
   off by a week. Surface the flag and let the expiry selection say when it is
   working from an estimate.

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

5. **`Hist Win` backtest.** The stat stays blank pending a real backtest of each
   structure on the underlying. It sits beside POP so the difference between a
   formula and a measurement stays visible. Needs historical option chains (ORATS /
   IVolatility) — no free source carries them.

6. **Chart pattern recognition.** Head-and-shoulders, cup-and-handle etc.
   Lightweight Charts supports custom drawings; recognition would be rules-based
   code or a Claude vision call against a chart screenshot.

7. **Backfill of recommendation history.** The forward log only grows from first
   use. RSI/MACD/Bollinger/analyst inputs are all reproducible from Yahoo history,
   so a replay script could synthesise "what would the model have said on date X".
   Roughly 100 lines of Node, and it would make the calibration card useful
   immediately rather than after 10 resolved entries.

8. **Two `setBadge()` implementations.** `index.html` and `dashboard.html` each
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
