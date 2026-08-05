# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Two-page equity research terminal: a macro landing dashboard (`dashboard.html`) and a per-ticker deep-dive (`index.html`). A single Cloudflare Worker (`worker.js`) handles all API proxying, Claude calls, and KV persistence.

## Deploy & develop

```bash
# Install wrangler
npm install

# First-time setup
wrangler login
wrangler kv:namespace create REC_LOG   # copy the returned id into wrangler.toml

# Set secrets
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ALPACA_KEY       # optional — improves price/news quality
npx wrangler secret put ALPACA_SECRET

# Deploy
wrangler deploy

# Local dev (Worker runs at localhost:8787)
wrangler dev

# Tail live Worker logs
npx wrangler tail
```

After deploying, set `API_BASE` near the top of both HTML files to your Worker URL:
```js
const API_BASE = 'https://stock-research-worker.you.workers.dev/api';
```

The HTML files can be opened locally or hosted on GitHub Pages — the Worker is CORS-enabled for `https://ambermlysak.github.io` and `localhost`.

There is no build step. No tests.

## Architecture

### Worker (`worker.js`)

All data flows through the Worker. CORS is enforced via `ALLOWED_ORIGINS` allowlist.

**Endpoints:**
```
GET  /api/quote/:ticker           Yahoo quoteSummary (multi-module) + Alpaca price overlay
GET  /api/chart/:ticker           Yahoo v8 OHLCV (?range=1y&interval=1d)
GET  /api/options/:ticker         Yahoo v7 options chain
GET  /api/premium/batch?symbols=  Premium screen, KV only — zero outbound calls
GET  /api/premium/:ticker         One ticker (?refresh=1 rebuilds it, ~5 subrequests)
GET  /api/insider/:ticker         SEC EDGAR Form 4, last 90 days (12h KV)
GET  /api/short/:ticker           FINRA consolidated short interest, 6 settlements (Yahoo fallback)
GET  /api/13f/:ticker             Super-investor 13F holdings, from a KV reverse index
GET  /api/iv/:ticker              ATM implied vol (front/back), term structure, IV rank, HV30, POP ladder
GET  /api/search?q=               Ticker autocomplete
GET  /api/news/:ticker            Alpaca news → Yahoo fallback
GET  /api/peers/:ticker           Yahoo recommendationsBySymbol
POST /api/claude                  Anthropic Messages API proxy
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
SEC round trips each = **61, against a 50-subrequest cap**. It did not fail. `fetch13F` is wrapped in a
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

**Stale-while-revalidate: no tab waits on a click.** Sectors, Scanner and Premium accept `?cached=1`,
which returns the banked KV snapshot at **any** age and never rebuilds; `primeTabs()` paints all three
on page load, then revalidates through the normal endpoint (which still serves from KV inside its TTL,
so priming all three costs about what clicking one used to). A failed revalidation leaves the painted
snapshot alone rather than blanking a view the user is reading, and a loading wall is only drawn when
there is nothing on screen yet. The manual Refresh buttons pass `?refresh=1` and still force a rebuild.

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

**KV namespace (`REC_LOG`) keys:**
```
yahoo:crumb        — Yahoo session crumb (50-min TTL)
daily:snapshot     — 6am cron Claude synthesis
daily:midday       — 11:30am cron midday pulse (narrative, topics, tomorrow, trades, bigMovers)
daily:eod          — 1:15pm cron EOD summary
analysis:{TICKER}  — on-demand per-ticker Claude analysis
iv:{TICKER}:{DATE} — daily front-month ATM IV sample, feeds ivRank (400d TTL; atmIv/spot/dte also in KV metadata)
premium:{TICKER}   — one premium-screen row, cached on demand (4h fresh horizon, 24h KV retention)
13f:cursor         — which manager the 13F pass is up to (deliberately outside the 13f:index key)
econ:dgs3mo        — FRED 3-month T-bill, the risk-free rate for Black-Scholes (refreshed 12h, kept 7d)
cik:map            — SEC ticker→CIK map (30d TTL)
insider:{TICKER}   — parsed Form 4 report (12h TTL)
short:{TICKER}     — FINRA short interest (6h TTL; 15min when falling back to Yahoo)
13f:index          — ticker→managers reverse index, rebuilt weekly by cron
finra:token        — FINRA OAuth2 bearer token (expiry-bound)
econ:fred          — FRED release dates (12h TTL; 15min on failure)
ivsweep:last       — PT date of the last cron IV sweep (dedup; deliberately outside the iv: prefix)
earnings:{TICKER}  — earnings analysis for the last report (12h TTL)
fund:{TICKER}      — Yahoo fundamentals cache (6h TTL)
market:ipos        — IPO calendar (12h TTL)
market:sectors     — Sector summaries + picks (4h TTL)
market:goldencross — Golden-cross setups (1h TTL)
scanner:{preset}   — Day-trading scanner results (90s TTL)
watchlist:tickers  — Saved watchlist, pushed by the dashboard; also seeds scan universes
rec:{TICKER}       — recommendation history, one entry per PT trading day (up to 500)
recfwd:last        — PT date of the last forward-return fill (dedup; outside the rec: prefix on purpose)
```

**Cron trigger:** a single `*/15 13-22 * * 1-5` UTC cron; `scheduled()` dispatches by Pacific wall-clock time to the morning briefing (6am PT), midday pulse (11:30am PT), EOD summary + IV sample sweep (1:15pm PT), the forward-return fill (2pm PT), and a 13F slice (10am PT). The premium screen is deliberately **not** here — it loads on demand.

**Check the UTC hour in both DST regimes before scheduling anything.** The 13F job used to run at 3pm PT, which is 22:00 UTC under PDT but **23:00 under PST** — outside this window — so it silently never ran for the winter half of the year. It moved to 10am PT (17:00/18:00 UTC), inside the window in both. Every other job was already safe; this one was not.

**Anything added here shares the invocation's subrequest budget with whatever else that firing runs.** `ctx.waitUntil` does not get its own. Each job uses a KV timestamp check with a 2-hour dedup window to avoid double-runs; the two jobs added later (`recordWatchlistIv`, `fillForwardReturns`) use a PT-date key instead, since they should run once a day rather than once per window.

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

`dashboard.html` — macro landing view: market strip, AI headline, news cards, pre/post-market movers, watchlist, IPO calendar. The Midday Pulse (11:30am PT synthesis) lives on its own tab (`#tab-midday`, deep-linkable via `dashboard.html#midday`).

**The Premium tab (`#tab-premium`) replaced the Options flow recap.** The old view showed the nearest
expiration filtered to volume/OI ≥ 2×, which answers "what traded today" — and at the nearest
expiration the answer is mostly 0DTE and expiry-week churn, the wrong question for selling 20–45 DTE
premium against earnings dates. `handleOptionsRecap()` and its Claude flow synthesis are **deleted**.
The separate "Options Volume · V/OI Screen" card on `index.html` is untouched: that one is real Yahoo
chain data and was never part of this.

`/api/premium` returns one row per watchlist ticker:

- front/back ATM IV and `termStructure` — **front minus back**, matching `/api/iv` exactly so the two
  endpoints cannot disagree. **Backwardation therefore reads POSITIVE here**, which is the reverse of
  how it is usually said aloud; the chip and the legend both state the sign. It is the earnings-crush
  setup, which is what the flag is for.
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
invocation** and this account is on **Workers Free: 50**. One ticker costs a *measured* ~4.8 outbound
fetches (1 expiry list + 1 quoteSummary for earnings + ~2.8 dated expiry chains); a 22-name watchlist
is ~110 and cannot be done in one invocation at all. **Chunking inside a handler does nothing for
this** — the cap is per invocation, not per chunk. Re-measure with a counting `fetch` wrapper before
changing anything here; do not estimate it.

There was briefly a KV queue drained across cron firings to work around that. It is gone. The screen
is used one or two names at a time when deciding what to sell, so fetching all 22 daily was solving a
problem nobody had at the cost of a queue, a cursor, a seed step and a share of every cron firing.

- `GET /api/premium/batch?symbols=` is a **cache-status read, not a data fetch**: it reads KV and
  makes zero outbound calls, so the tab paints every watchlist ticker on load for free. Tickers with
  nothing cached come back in `missing[]` as `not-loaded`.
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

**The sellable gate is tri-state, and null rank is not a fail.** It was
`ivRank != null && ivRank * 100 >= IVR_SELL_MIN`, which treats a null rank as below-threshold — and
since `ivRank` is null until 60 days of history exist, that dimmed *every row on the tab* for the whole
collection window. The proxy was already computed and already drove the regime chip; the gate simply
never consulted it. `sellableFrom()` now returns `{sellable, basis, reason}` with `basis` of
`rank` → `proxy` → `none`, and `sellable: null` for "no basis to judge", which renders neutral rather
than unattractive. `RATIO_SELL_MIN` (1.0) is the proxy analogue of "at or above the median": IV is
pricing at least as much movement as the stock has actually realised. `sellableReason` names the
number that decided it, so "IVR 34" and "rank collecting, proxy 0.94×" are distinguishable on hover.

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

The Scanner tab hosts four presets. Three (Momentum, Pre-Market Gappers, All Movers) hit
`/api/market/scanner` and share `renderScanner()`; the Golden Cross Setup preset hits
`/api/market/golden-cross` and uses `renderGoldenCross()`. `loadScanner()` branches on the preset
to pick the endpoint, renderer, header copy, and legend.

`index.html` — per-ticker research page with 15 sections (price/SMA, performance, catalysts, short interest, insider trades, unusual options, swing signals, option strategies, analyst targets, 13F holdings, technicals, sentiment, fundamentals, AI synthesis, recommendation history).

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

Deployment stays manual — do not run npx wrangler deploy unless I explicitly ask.
