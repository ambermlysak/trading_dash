---
name: worker-internals
description: Reference for worker.js internals and data plumbing — the /api endpoint list, Yahoo crumb auth and yahooSparkCloses, bsDelta / Black-Scholes and the FRED DGS3MO risk-free rate, SEC EDGAR Form 4 insider and 13F super-investor indexing, FINRA short interest, implied vs historical vol and volRegime, the full KV key and TTL table, the cron dispatch schedule and its jobs, primeTabs() page-load cost, the sweep universe and its refusal contract, and the Claude model call path. Load before editing any Worker endpoint, KV key, cron job, sweep, or external data source.
---

# Worker internals — endpoints, data sources, KV and cron

Extracted from `CLAUDE.md` so it loads only when this work is being done. The
short list of contracts a session can violate in a single edit stayed resident as
`### Worker invariants` in `CLAUDE.md`; **this file is the detail behind them.**

Nothing here was reworded. `CLAUDE.md` and `ARCHITECTURE.md` still apply on top of this.

### Worker (`worker.js`)

All data flows through the Worker. CORS is enforced via `ALLOWED_ORIGINS` allowlist.

**Endpoints:**
```
GET  /api/quote/:ticker           Yahoo quoteSummary (multi-module) + Alpaca price overlay
GET  /api/chart/:ticker           Yahoo v8 OHLCV (?range=1y&interval=1d)
GET  /api/options/:ticker         Yahoo v7 options chain
POST /api/premium/*             REMOVED — returns 410. Became Lane F of the Long screen.
GET  /api/long/batch?symbols=     Long screen, KV only — no fetches; 1 KV read/symbol
GET  /api/long/:ticker            One ticker (capCost 13 warm, 18-20 cold - cold is a RANGE)
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
GET  /api/watchlist               The saved list (read path for the adopt-on-empty bootstrap)
GET  /api/watchlist/batch         Bulk fundamentals + RSI + SMA/EMA cross + Claude analysis
GET  /api/daily                   Daily Claude synthesis (served from KV)
GET  /api/market/mood             Market Mood — candlestick emotion board (KV read only, capCost 1)
GET  /api/market/sectors          Sector summaries + top opportunity/avoid per sector (4h KV cache)
GET  /api/market/scanner?preset=  Day-trading momentum scanner (5 Pillars, 90s KV cache)
GET  /api/market/golden-cross     Names set up for a golden cross, EMA + SMA gaps (1h KV cache)
GET  /api/market/econ-calendar    Next FOMC / CPI events from the official schedule
GET  /api/earnings/:ticker        Last report: numbers, price reaction, call coverage (12h KV)
GET  /api/radar                   Off-watchlist discovery, <=5 quality names (radar:{PT-date})
```

**`GET /api/radar` — off-watchlist discovery.** Answers one question: which quality
names *not* on `watchlist:tickers` deserve attention today. **No Claude call anywhere
on the path**, so it is origin-gated only and takes no `x-dash-key`; the only write is
its own day cache.

| gate | constant | value |
|---|---|---|
| market cap > | `RADAR_MIN_MARKET_CAP` | $10B |
| price > | `RADAR_MIN_PRICE` | $20 |
| avg daily $-volume ≥ | `RADAR_MIN_DOLLAR_VOL` | $50M (`price × averageDailyVolume3Month`) |
| front-chain open interest ≥ | `RADAR_MIN_CHAIN_OI` | 1,000 (calls + puts, nearest listed expiry) |
| max returned | `RADAR_MAX` / `RADAR_MOVER_SLOTS` / `RADAR_SECTOR_SLOTS` | 5 / 3 / 2 |

Two sources, both filtered through the same gates: the Yahoo predefined screeners in
`RADAR_SCREENERS` (`day_gainers`, `most_actives` — their rows already carry
`marketCap`, `regularMarketPrice`, `regularMarketVolume` and
`averageDailyVolume3Month`, so **zero extra fetches**), and the `opportunity` picks
banked in `market:sectors`, priced by **one batched** `/v7/finance/quote` call rather
than one per name. **An S&P 500 golden-cross sweep is deliberately out of v1** — no
verified constituent source is wired, and a hand-typed 500-name list is the
unverifiable constant honesty rule 18 exists to kill.

Four contracts, each of which the endpoint would be dishonest without:

- **`watchlist:tickers` unreadable REFUSES.** Radar is defined as *not on the
  watchlist*; with no exclusion set it answers a different question under the first
  one's label. All four unusable shapes refuse with their own message (same
  discipline as `sweepUniverse()`, separate function because that one caps at 60 and
  is worded for a cron). A refusal returns **`candidates: null`, never `[]`** — `[]`
  means the gates ran and nothing survived — and **is never cached**.
- **A failing source is NAMED.** `sources: [{name, ok, reason, rows}]` carries one
  entry per source and `complete` is true only when every one reported `ok`. A thin
  day and a broken source must not look the same.
- **Ranking is `rvol` (today's volume ÷ 3-month average), tie-broken on `|chgPct|`,
  with RESERVED SLOTS per lane.** In one pool the sector picks would never surface (a
  large cap sits at ~1.0× while a gainer sits at 3–15×), which would make that source
  a branch that cannot fire. Unused slots spill to the other lane, and spilling only
  ever promotes a name that already cleared every gate — nothing is padded to reach 5.
- **Optionability is checked ONLY on the final ≤5, and there is no backfill.** A name
  that fails it reduces the count rather than promoting the next one behind an
  unchecked chain. `listed: false` (no chain) and `listed: null` (the fetch failed)
  are different facts and both are recorded.

`?trail=1` emits the full elimination trail — every row considered, the gate that
removed it, and its numbers. The trail is **stored either way** so a cached record can
still answer for it; `funnel` (counts per gate) ships unconditionally. `?refresh=1`
forces a rebuild.

Cost, **measured** on `wrangler dev --remote` against production KV 2026-08-19:
**warm 1** · **cold 13** with a warm crumb (8 ext + 5 bindings) · **cold 16** with a
cold crumb (10 ext + 6 bindings) · **refusal 2**, writing nothing.

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
`RATIO_HIGH` 1.2 / `RATIO_LOW` 0.9). It used to be computed in `index.html`; the
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

**Fetches are `ceil(N/20)`, and every "2" in these docs is an artifact of N ≤ 40.**
The move-series sweep is documented at `extFetches 2`. That is not a property of
the sweep — it is what `ceil(N/20)` happens to equal for the current **35**-name
watchlist. **At 41 names it becomes 3** and every figure here that says 2 silently
stops matching, with nothing failing to announce it. The watchlist has already
grown from 22 to 35 during this work, so 41 is not a hypothetical. When quoting a
spark-backed cost, quote the formula and the N it was evaluated at, never the bare
number.

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
- **`claudeText()` cannot see truncation, and that is a SEPARATE hazard from the thinking-block one.**
  A capped answer and a complete answer both arrive as text; the capped one parses or renders as
  though it were whole. So `workerClaude(prompt, env, maxTokens, schema, { raw: true })` returns
  `{ text, stopReason }` instead of the bare string, letting a caller check
  `stopReason === 'max_tokens'` and refuse. The flag is opt-in precisely so every existing caller
  keeps the string return unchanged. Use it wherever a cut-off answer would be **stored or rendered
  as finished prose** — `collectMarketMood` is the only user today, and it falls back to its house
  template and records the reason in `sentenceNote` rather than storing half a sentence.

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
| `macro:state` | **90d retention / 26h freshness** (`MACRO_FRESH_MS`) | The classified macro regime — state, `hostileVia`, the four raw inputs, both term spreads, the gates. **~640–730 bytes.** Written by the 1:15pm PT `collectMacroState`; read once per request by `/api/long/batch` and `/api/long/:ticker`. Freshness ≠ retention for the same reason as `econ:dgs3mo`: a labelled old macro read beats a blank one, and the chip renders its own age. A weekend or holiday legitimately ages it past 26h. |
| `macro:series` | **90d** | The 756-session (~3y) slice of **derived per-session inputs** — dates, SPY/QQQ spreads, VIX level, raw and smoothed term spread — computed over the full 10y pull then sliced, so the SMA200 is valid from the slice's first session. **~31 KB. Read by NOTHING in phase 1**; it exists so phase 2 needs no second collection pass. **THE SPLIT FROM `macro:state` IS A REQUEST-PATH COST DECISION**: one key would mean every `/api/long/*` request pulls 31 KB out of KV to render a 640-byte chip, and stripping the slice on read hides that rather than avoiding it. Both keys carry `MACRO_SCHEMA` and **are bumped together**. |
| `macrosweep:last` | 2d | PT date of the last macro collection, for dedup. **Outside the `macro:` prefix**, so nothing scanning that prefix can read it as a record — the same rule as `ivsweep:last` and `movesweep:last`. Stamped **last**, after both writes, so any failure leaves the next firing to retry. |
| `mood:state` | **7d retention / 26h freshness** (`MOOD_FRESH_MS`, derived from `TTL.mood`) | The Market Mood board: macro state, stance category, the one-sentence verdict and its `sentenceSource`, the breadth counts, and all 15 per-symbol reads (emotion, score, detected patterns, 1-session change, or a `status: 'unavailable'` row with its reason). **~5.2 KB measured** on a full 15-symbol run — one key, no state/series split, because the whole payload is small enough to read on the request path. `MOOD_SCHEMA` 1, checked by **strict equality**; any other value reads as ABSENT and the next 2:00pm firing rewrites it. Written by the 2:00pm PT `collectMarketMood`; read by `/api/market/mood` and nothing else. |
| `moodsweep:last` | 2d | PT date of the last mood collection, for dedup. **Outside the `mood:` prefix**, the same rule as `ivsweep:last` / `movesweep:last` / `macrosweep:last`. Stamped **last**, and only when all 15 symbols returned bars — a partial run still writes `mood:state` (a readable sector board with an unavailable verdict is a finding) but does not stamp, so the next firing retries. |
| `premium:{TICKER}` | **24h retention / 4h freshness** | One premium-screen row. The two differ on purpose — see below. |
| `long:{TICKER}` | **24h retention / 4h freshness** (`LONG_FRESH_MS`) | One long-screen row: **six lanes** (A–F), both timestamps, the buy gate and the directional read. Same freshness/retention split as `premium:` and for the same reason — past 4h the row still renders, badged stale. |
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
| `market:sectors` | 4h | Sector summaries + opportunity/avoid picks. **Also source (b) of `/api/radar`** — its `opportunity` tickers are gate-filtered as radar candidates |
| `radar:{PT-DATE}` | **36h** (`RADAR_TTL`) | One PT day's off-watchlist radar: the ≤5 candidates, the `sources` verdicts, the `funnel` counts and the full elimination `trail`. Keyed on the PT date, so there is no freshness question — retention outlives the day it names so a late-evening read still finds the answer instead of paying for a rebuild after the close. `RADAR_SCHEMA` 1, checked by **strict equality**; any other value reads as ABSENT and the next request rebuilds. An **incomplete** build (a source was down) is cached like any other so cost stays bounded, but is re-built rather than re-served once `RADAR_RETRY_MS` (10 min) has passed — a source that was down at 6am must not define discovery for the whole day. A **refusal is never written**, because it is a fact about our own config rather than about the day. |
| `market:goldencross` | 2h | Golden-cross setups (served fresh for 1h via `GOLDEN_TTL`) |
| `scanner:{preset}` | 5min | Day-trading scanner results (served fresh for 90s via `SCAN_TTL`) |
| `auction:{DATE}:{SYMBOLS}` | 20h | Closing-auction block trades, keyed by ET date |
| `watchlist:prev` | none | Previous watchlist, snapshotted before every overwrite — a one-step undo for a clobbered list |
| `watchlist:tickers` | none | **The ONLY sweep universe.** Written by the dashboard on an EDIT, or on load only when this key is empty (read-then-adopt — see the bootstrap rule; an unconditional on-load push clobbered it once). `DEFAULT_WATCHLIST` is deleted, so an absent or unusable value makes `sweepUniverse()` refuse loudly rather than sweep zero names. Also seeds scan universes |
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

**Cron trigger:** a single `*/15 13-22 * * *` UTC cron — every day, because the expression is a coarse wakeup and carries no calendar logic (rule #2). `scheduled()` first gates on the Pacific trading day (weekends and `NYSE_HOLIDAYS` are skipped, with the decision logged either way), then dispatches by Pacific wall-clock time to the morning briefing (6am PT), midday pulse (11:30am PT), the **`eod+iv-sweep+macro`** branch (1:15pm PT — EOD summary, IV sample sweep, and the macro-regime collection), the **`forward-returns+moves+mood`** branch (2pm PT — the forward-return fill, the move-series sweep, *and* the Market Mood collection), and a 13F slice (10am PT). The premium screen is deliberately **not** here — it loads on demand.

**`collectMarketMood` runs at 2:00pm PT for the same bar-settlement reason as
`collectMoveSeries`**, and it is the third job on that branch. Cost, stated
structurally because three concurrent jobs make any per-job `_instr` from this
branch an upper bound rather than a measurement (rule #1): **15 external chart
fetches + 1 Anthropic call = 16 ext; 1 dedup get + 1 `mood:state` put + 1 dedup
put = 3 bindings; capCost 19.** Measured in a local run with no
`ANTHROPIC_API_KEY` (so no Claude call): `extFetches 15, bindingOps 3, capCost
18`, with `invocationCapCost 20` on the same firing — exactly the documented
contamination.

**There is no batched substitute for those 15 fetches.** Candlestick patterns
need OHLC and `yahooSparkCloses` is close-only, so this is one `/v8` chart call
per symbol. That is the cost of the feature.

**`moodSettledBars()` drops a final bar dated today ONLY when the run is
pre-close** (PT hour < `MOOD_PRECLOSE_PT_HOUR`, 13). At 2:00pm PT the bell has
rung and today's daily bar is final — it is the most informative bar in the
series and the one the whole feature exists to read. An unconditional
"drop if `iso === ptDate()`" would discard a settled bar every day and make the
2:00pm placement buy nothing over 1:15pm. The guard exists for a manual or
admin-triggered run, which is the only way a forming bar can reach this code.

**`unavailable` IS NOT ONE CONDITION, AND `_meta.ok` MUST NOT TREAT IT AS ONE.**
`MOOD_FAULT_CAUSES` (`stale-sweep`, `record-missing`) names the two causes that
are genuine faults; `moodMetaOk()` derives `_meta.ok` from it. `never-collected`
(nothing has run yet) and `schema` (an old record retiring after a deploy) are
expected transitional states and report `ok: true`.

**This was a live defect, caught on the deployed build 2026-08-13.** `ok` was
`state !== 'unavailable'`, so a cold start rendered `.src-tag.bad` — a **red**
provenance badge — right beside a chip that was deliberately neutral for the same
state under a comment saying a cold start is not a fault. One fact, two elements,
opposite tones, and the red one carried more weight. The list therefore ships on
the payload as `faultCauses`, and `dashboard.html` tones its chip from that plus
its own `CLIENT_FAULT_CAUSES` (`request-failed`) — causes the Worker can never
send because they describe the request rather than the record. The page keeps a
literal copy as its deploy-window fallback; **keep the two in sync**, and
`mood.check.mjs` §10 asserts against both files for exactly that reason.

**KNOWN WATCH ITEM — the two loosened predicates have never fired on live data.**
`moodIsPiercingLine` and `moodIsDarkCloudCover` test the open against the prior
**close** rather than the prior low/high. The strict form needs a gap past the
extreme, which index and sector ETFs almost never produce, so the strict version
would have been a predicate that cannot fire — the `no-leaps` failure again. But
the loosening is only verified by fixtures: the first live run (15 symbols,
2026-08-12) fired marubozu, engulfing, three-white-soldiers, spinning-top and the
direction-neutral shadow names, and **neither of these two**.

**Watch for OVER-firing, not silence.** A wider window on a ±2 pattern skews
per-symbol scores toward `caution` / `optimism` and away from `neutral`, and the
macro blend drifts with them — nothing errors, the board simply reads more
decisive than the tape. Once `mood:state` has history, count each of the two
against the **engulfing** rate: engulfing reads the same two bars and is the
strict version of the same idea, so it is the right comparator. A rate materially
above it is the signal to tighten back toward the prior extreme. `mood.check.mjs`
§1 pins both the firing and the non-firing boundary for each, so tightening is a
deliberate fixture change rather than a threshold nudge.

**The mood job's Claude call is the only one in this Worker that cannot change
what it is called about.** The verdict is computed first; the model is handed it
and asked for a sentence; `moodSentenceUsable()` rejects an answer that names a
different state, is multi-line, or falls outside `MOOD_SENTENCE_MIN`/`_MAX`. It
also passes `{ raw: true }` to `workerClaude` so it can check
`stopReason === 'max_tokens'` — `claudeText()` alone cannot tell a complete
answer from a truncated one. Every rejection falls back to the house template
and records why in `sentenceNote`.

**`collectMoveSeries` runs at 2:00pm PT, not on the 1:15pm EOD branch, and the
reason is bar settlement rather than load balance.** The NYSE closes at 1:00pm PT,
so at 1:15pm the day's daily bar may still be forming. Banking a forming bar into
the series every coverage figure is measured against would never surface as an
error — it would quietly shift the most recent window. By 2:00pm the bar is
settled. (`fillForwardReturns` guards the same hazard from the other side with
`bars[idx].iso < today`.) Both jobs share that invocation's subrequest budget:
`ctx.waitUntil` does not get its own.

**Cost of the sweep, and the reason two numbers are quoted.** The model is
`bindingOps = 2N + 3` (one read + one write per symbol, plus the dedup get, the
watchlist get and the dedup put) and `extFetches = ceil(N/20)` (spark takes 20
symbols per request). Measured in isolation at N=22: `2 / 47 / 49`, matching
exactly. Observed in production 2026-08-10 at **N=35**: `extFetches 5,
bindingOps 76, capCost 81`, against a predicted `2 / 73 / 75`.

**The excess is the instrumentation, not the sweep — see the concurrency caveat
in rule #1.** `fillForwardReturns` runs concurrently on the same firing, and
`instrSince()` measures an invocation-wide counter delta, so its fetches land
inside the sweep's bracket. The +3 appears on *both* counters, and
`invocationFetches` was 5 at stamp time against the ~45 charts the fill went on
to do — the fill had only started.

**N is whatever `watchlist:tickers` holds — 33 as of 2026-08-11.** It was 35: the
sweeps used to take `watchlist:tickers` ∪ `DEFAULT_WATCHLIST`, so the server
permanently covered two names (MRK, JPM) the dashboard never showed. The union is
gone; see the empty-universe rule below. `extFetches` is `ceil(N/20)` and stays at
2 only while **N ≤ 40** — at 41 names it becomes 3, which a later reader would
otherwise read as a regression.

### The sweep universe has ONE source, and an empty one REFUSES

`sweepUniverse(env, job, cap)` is the only way a cron gets tickers, and it reads
**`watchlist:tickers` and nothing else**. `DEFAULT_WATCHLIST` is deleted.

**Dropping the fallback removed a divergence and created a failure mode**, so the
mode is closed in the same place. With no default, an absent, unparseable, empty
or all-invalid key yields zero names — and **a sweep that writes zero keys is
indistinguishable from a cron that never fired**, which is rule #7's signature
exactly. Worse, the IV and move sweeps stamp a dedup key on the way out, so a
silent zero would have persisted for the rest of the day.

So `sweepUniverse` returns **`null`, never `[]`**, and logs at ERROR with a
greppable marker:

```
[cron] !! EMPTY-UNIVERSE !! iv sweep has ZERO tickers to sweep: watchlist:tickers
key is absent (no dashboard has ever saved a watchlist). REFUSING to run rather
than writing nothing … No dedup key has been stamped, so the next firing will retry.
```

Four causes produce four distinguishable messages (absent / empty / wrong type /
KV threw), because one indistinguishable "no tickers" would just move the problem.

**Callers split on whether they own a dedup key**, and the split is deliberate:

| caller | on `null` | why |
|---|---|---|
| `recordWatchlistIv` | **refuse before stamping `ivsweep:last`** | so the next firing retries |
| `collectMoveSeries` | **refuse before stamping `movesweep:last`** | same |
| `refreshWatchlistAnalyses` | skip | owns no dedup key; the briefing around it still has value |
| `generateMiddaySnapshot` | skip that section only | the pulse's narrative and movers do not depend on it |
| briefing opportunity/avoid prompt | **change the instruction** | see below |

**The prompt site degraded worse than the sweeps and is the one to understand.**
It interpolated `DEFAULT_WATCHLIST.join(', ')` into *"For opportunity and avoid,
choose from: …"*. With an empty list that reads **"choose from: "** — an empty
constraint does not stop the model, it stops *constraining* it, so the briefing
would have named arbitrary tickers and looked entirely normal. It now switches to
an explicit instruction to return `null` for both and not substitute its own.

**The dashboard bootstraps with READ-THEN-ADOPT, and pushes only on an edit or an
empty server.** `initWatchlist()` runs before anything reads the list:

| local | server | action |
|---|---|---|
| populated | — | use it. **No push** — an unedited load asserts nothing |
| empty | populated | **ADOPT** into localStorage. No push |
| empty | empty | seed `DEFAULT_WL` and push. Nothing can be destroyed |
| empty | **read failed** | render defaults, **adopt nothing, push nothing** |

**The first version of this was a data-loss bug and the shape is worth keeping.**
It pushed `getWatchlist()` on every load; on an empty localStorage that returns
`DEFAULT_WL`, so a new device, a cleared profile or an incognito window would have
silently replaced a populated server list with the 22 bare defaults — and every
sweep would have followed it, with no fallback left to bound the damage. It was
only survivable in testing by seeding localStorage from the server first, which is
the tell: **needing a workaround to avoid destroying data while testing IS the bug
report.** A failed read must never be mistaken for an empty server.

`DEFAULT_WL` stays in `dashboard.html` as the **client's** empty state — a
bootstrap default, not a second source of truth.

**`POST /api/watchlist/save` snapshots before it overwrites.** The previous value
goes to `watchlist:prev` on every save, and a shrink past 30% logs at WARN naming
both counts and the dropped tickers. It does **not** block: replacing 33 names
with 22 is indistinguishable from a legitimate edit down to 22, so the guard makes
the event visible and recoverable rather than refusing it. Recoverability is
precisely what the `DEFAULT_WATCHLIST` deletion removed — before it, a clobbered
list still swept the defaults.

**`GET /api/watchlist`** exists only so the adopt path can tell "the server has 33"
from "the server has nothing". Origin-gated, NOT secret-gated: requiring the key
would make adoption fail exactly when the key is misconfigured, which is the moment
it most needs to not overwrite anything.

`node sweep-universe.check.mjs` covers all of it — cleaning, dedup, cap, junk
dropping, and that **every** unusable shape returns null with a distinguishable
ERROR. **37 comparisons.**

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
