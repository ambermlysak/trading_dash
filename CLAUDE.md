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
GET  /api/insider/:ticker         SEC EDGAR Form 4, last 90 days (12h KV)
GET  /api/short/:ticker           FINRA consolidated short interest, 6 settlements (Yahoo fallback)
GET  /api/13f/:ticker             Super-investor 13F holdings, from a KV reverse index
GET  /api/iv/:ticker              ATM implied vol (front/back), term structure, IV rank, HV30
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
- **`/api/13f/:ticker` — SEC EDGAR 13F-HR.** `SUPER_INVESTORS` holds 20 verified manager CIKs.

**SEC EDGAR requires a real contact email in the User-Agent** (`SEC_UA`) or it 403s everything.

**Verify every CIK against EDGAR before adding one.** The first draft of `SUPER_INVESTORS` was
written from memory and **7 of 18 entries were wrong** — several pointed at real but unrelated
managers (the "Third Point" CIK returned Two Sigma; "ARK" returned ValueAct). A wrong CIK does not
fail loudly; it silently attributes one manager's book to another. Check
`data.sec.gov/submissions/CIK{n}.json` and confirm both the `name` and that `13F-HR` appears.

**13F index is built off the request path.** 20 managers cost ~60 rate-limited SEC round trips —
about a minute — which is far too long to hold a page load and wedges `wrangler dev` outright. A
weekly cron owns `refresh13FIndexIfStale()`; requests only ever read `13f:index`. A 13F reports one
issuer across several rows (separate accounts, share classes, discretion categories), so rows are
**summed per manager** — otherwise Berkshire appears to hold Apple twelve times.

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

**Cron trigger:** a single `*/15 13-22 * * 1-5` UTC cron; `scheduled()` dispatches by Pacific wall-clock time to the morning briefing (6am PT), midday pulse (11:30am PT), EOD summary + IV sample sweep (1:15pm PT), and the forward-return fill (2pm PT). Each job uses a KV timestamp check with a 2-hour dedup window to avoid double-runs; the two jobs added later (`recordWatchlistIv`, `fillForwardReturns`) use a PT-date key instead, since they should run once a day rather than once per window.

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

Sections with mock data are labeled with a violet "Sample · upgrade: X" badge in the UI. Currently stubbed: short interest, unusual options flow, dark pool prints, super-investor 13F holdings. See `ARCHITECTURE.md` for the paid upgrade path.

## Design system

CSS custom properties in `:root`. Never hardcode colors — use the variables:
- `--bull` / `--bear` — green `#23d18b` / red `#f25f5c`
- `--amber` — neutral `#f4b740`
- `--cyan` — data accent `#5ec5ea`
- `--violet` — mock data markers `#b48ead`
- `--bg-0..3` — background layers (darkest to lightest)
- `--ink-0..3` — text (brightest to dimmest)

Fonts: `--serif` (Fraunces, display), `--sans` (Geist, body), `--mono` (JetBrains Mono, numbers/labels).
