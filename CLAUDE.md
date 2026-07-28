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
GET  /api/market/golden-cross     Names set up for a golden cross (1h KV cache)
```

**Moving averages:** the watchlist's `vs 50D` / `vs 200D` / `50D vs 200D` columns use Yahoo's
`summaryDetail.fiftyDayAverage` / `twoHundredDayAverage` — simple moving averages of daily closes
through the *prior* close. The `Golden X` / `Death X` columns and the golden-cross scanner use
**exponential** moving averages computed in the Worker by `emaCrossState()`.

**EMA cross (`emaCrossState`):** EMAs are seeded with an SMA of the first `period` closes and
smoothed forward, so EMA200 needs a long runway before the seed washes out. Callers pass ~3y of
daily closes (~750 bars), leaving the seed ~0.4% weight and EMA200 within ~0.01% of a fully
converged value. Symbols with fewer than 450 bars return `null` rather than an unreliable value.
A *setup* means the fast EMA is within `EMA_CROSS_NEAR_PCT` (5%) of the slow EMA **and** trending
into the cross; `EMA_CROSS_SLOPE_BARS` (5) sessions define the slope.

**Multi-symbol closes (`yahooSparkCloses`):** Yahoo v7 `spark` returns close-only series for up to
**20 symbols per request** and needs no crumb, so a 250-name EMA sweep costs ~13 subrequests
instead of 250. Results key off `item.symbol` — the response order does not match the request
order, and unknown/delisted symbols are silently absent.

**Yahoo crumb auth:** Yahoo v10 requires a session crumb. `getYahooCrumb()` tries two strategies (direct user-agent endpoint, then HTML stream scan), caches in memory + KV (`yahoo:crumb`, 50-min TTL), and deduplicates concurrent fetches via `_crumbInflight` promise. On 401/403 it invalidates and retries once.

**Alpaca integration:** Optional — if `ALPACA_KEY`/`ALPACA_SECRET` are set, Alpaca overlays real-time prices on quote results and provides the news feed. Yahoo is always the fallback.

**Claude model:** Locked to `const CLAUDE_MODEL = 'claude-sonnet-4-6'` at the top of `worker.js`. Change it there when upgrading models.

**KV namespace (`REC_LOG`) keys:**
```
yahoo:crumb        — Yahoo session crumb (50-min TTL)
daily:snapshot     — 6am cron Claude synthesis
daily:midday       — 11:30am cron midday pulse (narrative, topics, tomorrow, trades, bigMovers)
daily:eod          — 1:15pm cron EOD summary
analysis:{TICKER}  — on-demand per-ticker Claude analysis
fund:{TICKER}      — Yahoo fundamentals cache (6h TTL)
market:ipos        — IPO calendar (12h TTL)
market:sectors     — Sector summaries + picks (4h TTL)
market:goldencross — Golden-cross setups (1h TTL)
scanner:{preset}   — Day-trading scanner results (90s TTL)
watchlist:tickers  — Saved watchlist, pushed by the dashboard; also seeds scan universes
rec:{TICKER}       — recommendation history (up to 500 entries)
```

**Cron trigger:** a single `*/15 13-22 * * 1-5` UTC cron; `scheduled()` dispatches by Pacific wall-clock time to the morning briefing (6am PT), midday pulse (11:30am PT), and EOD summary (1:15pm PT). Each job uses a KV timestamp check with a 2-hour dedup window to avoid double-runs.

### Frontends

`dashboard.html` — macro landing view: market strip, AI headline, news cards, pre/post-market movers, watchlist, IPO calendar. The Midday Pulse (11:30am PT synthesis) lives on its own tab (`#tab-midday`, deep-linkable via `dashboard.html#midday`).

The Scanner tab hosts four presets. Three (Momentum, Pre-Market Gappers, All Movers) hit
`/api/market/scanner` and share `renderScanner()`; the Golden Cross Setup preset hits
`/api/market/golden-cross` and uses `renderGoldenCross()`. `loadScanner()` branches on the preset
to pick the endpoint, renderer, header copy, and legend.

`index.html` — per-ticker research page with 16 sections (price/SMA, performance, catalysts, short interest, insider trades, unusual options, dark pool, trade signals, option strategies, analyst targets, 13F holdings, technicals, sentiment, fundamentals, AI synthesis, recommendation history).

All technical indicators (RSI, MACD, Bollinger, EMA crossovers, support/resistance) are computed client-side from Yahoo OHLCV. Chart rendering uses TradingView Lightweight Charts.

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
