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

Each of the three constraints here has already caused a *silent* failure — code
that returned normally and rendered plausible output while being wrong.

### 1. Subrequest cap: 50 per Worker invocation

This account is on the **Cloudflare Workers Free plan**. Every `fetch()` a Worker
makes is a subrequest, and the cap is **per invocation, not per chunk** — chunking
inside one handler buys nothing at all.

Measured costs, not estimates:

| work | subrequests |
|---|---|
| one premium ticker | **~4.8** (1 expiry list + 1 quoteSummary + ~2.8 dated chains) |
| one 13F manager | **3** (submissions.json + filing index.json + info table) |
| fixed overhead per invocation | ~3 (Yahoo crumb, FRED rate, one spark per 20 symbols) |

**Budget any new fan-out feature against this before writing it.** Two silent
failures have come from not doing so:

- The premium screen fanned out the whole watchlist (~110 subrequests). Most rows
  rendered "options chain unavailable", which read like a data problem with those
  tickers. It was ours.
- `build13FIndex` needed ~61 and **did not fail** — a per-manager `catch`
  swallowed the cap error and it returned 16 of 20 managers, written to KV as
  though complete.

To re-measure, wrap `globalThis.fetch` with a counter and reset it at the top of
the handler. Do not estimate.

### 2. Cron window must cover both PST and PDT

`scheduled()` dispatches on **Pacific wall-clock time**, but the cron trigger is
expressed in **UTC**. A Pacific hour maps to two different UTC hours across the
year, so a job whose UTC hour falls outside the trigger window **silently does not
run for half the year**. Nothing errors; the job simply never fires.

Current window is `*/15 13-22 * * 1-5`, which covers **6:00am–3:00pm PDT** and
**5:00am–2:00pm PST**. Before scheduling anything, check the target Pacific hour in
*both* regimes:

```
PT hour  →  UTC under PDT (UTC-7)  |  UTC under PST (UTC-8)
 5:00am  →  12:00  ✗ outside       |  13:00  ✓
 6:00am  →  13:00  ✓               |  14:00  ✓
 1:15pm  →  20:15  ✓               |  21:15  ✓
 3:00pm  →  22:00  ✓               |  23:00  ✗ outside
```

This has bitten twice. A premium pre-open anchor at 5:00am PT only existed under
PST. The 13F job sat at 3:00pm PT and had **never executed under PST** — it now
runs at 10:00am PT (17:00/18:00 UTC), inside the window in both regimes.

Also: `ctx.waitUntil` does **not** get its own subrequest budget. It shares the
invocation's. Two jobs on the same firing share one cap.

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

---

## Deploy & develop

```bash
npm install

# First-time setup
npx wrangler login
npx wrangler kv namespace create REC_LOG   # NOT `kv:namespace` — that syntax is
                                           # deprecated. Copy the id into wrangler.toml

# Secrets (deployed environment)
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

To test those paths locally, create `.dev.vars` with the same keys:

```
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

The HTML files can be opened locally or hosted on GitHub Pages — the Worker is CORS-enabled for `https://ambermlysak.github.io` and `localhost`.

There is no build step. The only check is `node bs-delta.check.mjs`, which prints
computed vs expected for the Black-Scholes delta rather than asserting.

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
| `premium:{TICKER}` | **24h retention / 4h freshness** | One premium-screen row. The two differ on purpose — see below. |
| `cik:map` | 30d | SEC ticker→CIK map from `company_tickers.json` |
| `insider:{TICKER}` | 12h | Parsed SEC Form 4 report |
| `short:{TICKER}` | 6h, or **15min** on the Yahoo fallback | FINRA short interest. The short TTL on the fallback is deliberate: a labelled estimate should be retried soon, not cached like the official figure. |
| `finra:token` | expiry-bound (`expires_in − 60s`, min 120s) | FINRA OAuth2 bearer token |
| `13f:index` | 100d | ticker→managers reverse index plus `byManager` per-manager holdings |
| `13f:cursor` | 100d | Which manager the incremental 13F pass is up to. **Outside the `13f:index` key** so advancing the cursor never rewrites the index. |
| `econ:fred` | 12h, or **15min** on failure | FRED release dates |
| `econ:dgs3mo` | **7d retention / 12h freshness** | FRED 3-month T-bill — the risk-free rate for Black-Scholes. See below. |
| `earnings:{TICKER}` | 2d | Earnings analysis for the last report |
| `fund:{TICKER}` | 6h | Yahoo fundamentals cache |
| `market:ipos` | 12h | IPO calendar |
| `market:sectors` | 4h | Sector summaries + opportunity/avoid picks |
| `market:goldencross` | 2h | Golden-cross setups (served fresh for 1h via `GOLDEN_TTL`) |
| `scanner:{preset}` | 5min | Day-trading scanner results (served fresh for 90s via `SCAN_TTL`) |
| `auction:{DATE}:{SYMBOLS}` | 20h | Closing-auction block trades, keyed by ET date |
| `watchlist:tickers` | none | Saved watchlist, pushed by the dashboard; also seeds scan universes |
| `rec:{TICKER}` | none | Recommendation history, one entry per PT trading day (up to 500) |
| `recfwd:last` | 2d | PT date of the last forward-return fill. **Outside the `rec:` prefix** so the fill sweep's own `list()` cannot see it. |
| `admin:token` | none | Bearer token gating the `/api/admin/*` routes |

**`premium:{TICKER}` — 4h freshness, 24h retention, and they must not be equal.**
A literal 4h KV TTL would evict the row at the exact moment it becomes stale,
leaving nothing to render *as* stale. A 5-hour-old chain badged "stale" is more
useful than a blank row, so `PREMIUM_FRESH_MS` (4h) drives the badge and
revalidation while `PREMIUM_ROW_TTL` (24h) keeps the row alive to be badged.

**`econ:dgs3mo` — 12h freshness, 7d retention.** The FRED integration originally
resolved *release dates* only; `fetchFredReleaseDates()` never fetched a series
observation, so there was no cached rate to read and this was added later.
`riskFreeRate()` calls `/fred/series/observations?series_id=DGS3MO`. The long
retention is the outage path: past 12h it refetches, and if FRED is unreachable it
returns the **last stored print flagged `stale: true`** rather than nothing. With
no stored print at all the rate is `null` and every delta is suppressed — never
defaulted to `r = 0`, which is worth about a full delta point at 30 DTE and would
change which strike the screen picks. DGS3MO publishes `"."` on market holidays,
so the fetch scans the **last 10 observations** for a numeric one instead of taking
row 0.

**Do not declare a local `const TTL`.** `TTL` is a module-level table (`TTL.quote`,
`TTL.scanner`, …) feeding `srcMeta({ ttlSeconds })`. Four handlers each declared
their own `const TTL = <number>`, which shadowed it silently and turned
`TTL.scanner` into `undefined` — no error, just a missing staleness threshold on
the badge. They are now **`CRUMB_TTL`, `SCAN_TTL`, `GOLDEN_TTL`, `IPO_TTL`**. Any
new local cache window needs its own name.

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

`dashboard.html` — macro landing view with **six tabs**. Every tab is deep-linkable
by hash (`dashboard.html#premium`), and `switchTab()` only lazy-loads a tab whose
data is still empty — `primeTabs()` has usually painted it already.

| Tab | `#hash` | What it is |
|---|---|---|
| **Market** | `#market` | Default. Index/futures/commodities strip, the 6am Claude briefing headline, EOD card, Friday week-ahead, news cards, pre/post-market movers (≥ ±10%), IPO calendar, watchlist signals. |
| **Midday** | `#midday` | The 11:30am PT midday pulse — session narrative, topics, next-day events, short-term trade ideas, big movers. |
| **Scanner** | `#scanner` | Four presets. Three (Momentum / HOD, Pre-Market Gappers, All Movers) hit `/api/market/scanner` and share `renderScanner()`; **Golden Cross Setup** hits `/api/market/golden-cross` and uses `renderGoldenCross()`. `loadScanner()` branches on the preset for endpoint, renderer, header copy and legend. |
| **Watchlist** | `#watchlist` | The 14-column table, sortable, with expandable rows and the consolidated Recommendation column. |
| **Sectors** | `#sectors` | All 11 SPDR sectors, ETF % change plus a Claude-picked opportunity and avoid per sector. |
| **Premium** | `#premium` | The short-premium screen. **Renamed from "Options"** — the old tab was a V/OI unusual-activity recap on the nearest expiration and was deleted outright, along with `handleOptionsRecap()` and its Claude flow synthesis. |

Note the Premium tab is the only one that fetches on interaction rather than on
load: expanding a row is what spends the subrequests. Sectors and Scanner use
stale-while-revalidate (`?cached=1` paints the KV snapshot, then the normal
endpoint revalidates behind it), so **no tab requires a click to show data**.

The `index.html` "Options Volume · V/OI Screen" card is a *different thing* and
still exists — real Yahoo chain volume and open interest, on the per-ticker page.

**The Premium tab (`#tab-premium`) replaced the Options flow recap.** The old view showed the nearest
expiration filtered to volume/OI ≥ 2×, which answers "what traded today" — and at the nearest
expiration the answer is mostly 0DTE and expiry-week churn, the wrong question for selling 20–45 DTE
premium against earnings dates. `handleOptionsRecap()` and its Claude flow synthesis are **deleted**.
The separate "Options Volume · V/OI Screen" card on `index.html` is untouched: that one is real Yahoo
chain data and was never part of this.

`/api/premium` returns one row per watchlist ticker:

- front/back ATM IV and `termStructure`.

  **`termStructure = front − back`. POSITIVE means front IV is RICHER than back —
  that is backwardation, and it is the earnings-crush setup.** This is the single
  easiest thing in the codebase to get backwards, and the original spec for this
  feature had it inverted (it asked to flag *negative* values as backwardation).
  Both `/api/iv` and `/api/premium/:ticker` compute it the same way so the two
  endpoints cannot disagree, `backwardation` is `termStructure > 0`, and the chip
  (`◤`) and the legend both state the sign on screen. If you find yourself
  "fixing" the sign, re-read this first.
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

**Two gates, two different jobs — `volRegime()` and `IVR_SELL_MIN`.** They look
like duplication and are not:

- `volRegime()` (worker.js) answers *"is vol rich or cheap enough to justify a
  volatility structure at all?"* — `IVR_HIGH` 70 / `IVR_LOW` 30, with
  `RATIO_HIGH` 1.2 / `RATIO_LOW` 0.9 as the IV/HV30 proxy. It gates the strategy
  cards on `index.html`: iron condor and CSP need `elevated`, straddle needs
  `depressed`.
- `IVR_SELL_MIN` (50) answers a *different* question: *"is this row worth the
  user's attention on a screen sorted by yield?"* It is a display threshold for
  dimming, not a trading gate, and 50 is the median rather than the 70th
  percentile because a screen that dims everything below 70 shows almost nothing.

Keeping them separate is deliberate. Collapsing them would mean either dimming
rows that still qualify for a structure, or recommending structures on rows the
screen calls uninteresting. `IVR_SELL_MIN` lives beside the `volRegime` constants
so the relationship is visible, and both ship to the frontend in `gates` — neither
frontend hardcodes a threshold.

**The gate is tri-state, and a null rank is not a fail.** `sellableFrom()` returns
`{ sellable, basis, reason }` with `basis` falling through in order:

| basis | when | test |
|---|---|---|
| `rank` | `ivRank` exists (≥60 days of history) | `ivRank × 100 ≥ IVR_SELL_MIN` (50) |
| `proxy` | no rank yet, but HV30 exists | `ivHvRatio ≥ RATIO_SELL_MIN` (**1.0×**) |
| `none` | neither | `sellable: null` — **not** a fail |

`sellable` was originally `ivRank != null && ivRank * 100 >= IVR_SELL_MIN`, which
treats a null rank as below-threshold. Since `ivRank` is null until 60 days of
samples exist, **that dimmed every row on the tab for the entire collection
window** — three months of a screen reading as if nothing were worth selling. The
proxy was already computed and already drove the regime chip; the gate simply
never consulted it.

`RATIO_SELL_MIN = 1.0` is the proxy analogue of "at or above the median": implied
vol is pricing at least as much movement as the stock has actually realised. It is
coarser than a percentile and is labelled a proxy everywhere it surfaces.
`sellable: null` renders **neutral, not dim** — "no basis to judge" is not the same
as "fails the gate". `sellableReason` names the deciding number, so "IVR 34" and
"rank collecting, proxy 0.94×" are distinguishable on hover.

**POP is delta-derived, and the card says so.** `1 − |Δ|` of the short strike;
`1 − (|Δcall| + |Δput|)` for an iron condor. Delta is Black-Scholes computed in the
Worker from each strike's **own** implied vol — not ATM IV — so put skew is
respected, and the `/api/iv` `pop` ladder carries real listed strikes so the leg
printed is one that exists.

**Debit structures render `n/a`, not a number.** For a bull call spread, bear put
spread or long straddle the break-even sits inside the long strike, so `1 − |Δ|` is
simply the wrong quantity — it would produce a plausible-looking figure measuring
nothing. Three of seven cards therefore show `n/a` with the reason on hover. The
temptation is always to fill the cell; a wrong number costs more than a blank one.

**`Hist Win` stays suppressed** pending a real backtest of the structure on the
underlying. It sits directly beside POP precisely so the difference between a
formula and a measurement is visible. Do not wire it to anything derived.

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
