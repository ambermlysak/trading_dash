# Equity Research Terminal — Architecture & Data Sources

## Repo layout

```
stock-research/
├── index.html        # Single-page dashboard (dark fintech aesthetic, 16 sections)
├── worker.js         # Cloudflare Worker (Yahoo proxy + Claude API + KV log)
├── ARCHITECTURE.md   # this file
└── README.md         # quick start
```

## How it differs from `dashboard_v10`

This is a **per-ticker research page**, not a portfolio macro tracker. Every interaction starts with selecting a ticker (search bar in the top bar) and the entire page rebuilds against that symbol. Layout is bento-grid; centerpiece is the AI Synthesis card with the BUY/HOLD/SELL verdict and confidence ring.

The Worker pattern is deliberately the same as `dashboard_v10` — Yahoo proxy + Claude pass-through, model identifier `claude-sonnet-4-5` (the dated variant returns auth errors, per past sessions). New addition: a KV-backed forward log for the recommendation track record.

---

## Section-by-section data source map

For every component in the spec, this table shows what powers it in the **free prototype** and what to upgrade to once budget allows. "Light tier" is the ~$77/mo recommended stack you flagged for the production version.

| # | Component | Free prototype source | Coverage today | Light-tier upgrade ($77/mo) | Pro upgrade |
|---|---|---|---|---|---|
| 1 | Current price + SMA 20/50/200 | Yahoo `chart` (15-min delayed) → SMA computed client-side | **full** | Polygon real-time | Polygon Advanced |
| 1 | 5D / 1M / 1Y / 5Y performance | Yahoo `chart` historical | **full** | — | — |
| 2 | Next earnings date | Yahoo `calendarEvents` | **full** | — | — |
| 2 | Catalysts (Fed, CPI, geo) | **Hand-curated macro stub** | partial | Trading Economics API ($) | Bloomberg Event Calendar |
| 3 | Short interest 6mo MoM | **Mock (deterministic per ticker)** | mock | FINRA biweekly free file | **Ortex** ($35–80/mo) |
| 4 | Insider trades + flags | Yahoo `insiderTransactions` | **partial — works but limited fields** | **SEC EDGAR Form 4 direct** (free) | Verafin / SecForm4.com |
| 5 | Unusual options volume | **Mock (deterministic per ticker)** | mock | **Unusual Whales** ($48/mo) | Cheddar Flow ($75) + UW |
| 6 | Recommended option strategies | Computed client-side from RSI + IV + analyst upside | **rules-based, full** | OptionStrat API ($) | tastytrade backtest data |
| 7 | Day trade signals (ORB, VWAP) | Computed client-side from Yahoo OHLC | **functional but daily bars** | **Polygon Stocks Starter** ($29) for intraday | Polygon Advanced ($199) |
| 7 | Swing signals (EMA crossover) | Computed client-side | **full** | — | — |
| 8 | Dark pool 5d volumes | **Mock** | mock | **Unusual Whales** dark pool tab | Cheddar Flow Pro |
| 9 | Analyst targets + recs | Yahoo `financialData` + `recommendationTrend` | **full** | FactSet Estimates (paid) | Visible Alpha |
| 9 | Recent upgrades/downgrades | Yahoo `upgradeDowngradeHistory` | **full** | Benzinga Pro ($177) | — |
| 10 | Super-investor 13F | **Mock** | mock | **WhaleWisdom Premium** ($30/mo) | Dataroma + WW Pro |
| 11 | Technical indicators (RSI, MACD, Bollinger, Stoch, CCI, IV) | Computed client-side from Yahoo OHLC | **full** | Same — local compute is correct | — |
| 11 | Support/resistance | Local extrema detection (60-bar lookback) | **functional** | TrendSpider API ($) | — |
| 11 | Chart with patterns + 30d projection | TradingView Lightweight Charts + linear regression | **functional** | Add ML projection via Claude | Quantcast / Aiera |
| 12 | Sentiment (news, insiders, mood) | **Claude synthesis** of news headlines + insider data | **full** | Add Benzinga news firehose | RavenPack ($$$$) |
| 13 | Fundamentals + valuation | Yahoo `financialData` + `defaultKeyStatistics` | **full** | **FMP** ($14) for 30+ years history | Tikr Terminal ($30) |
| 13 | Peer comparison | Claude infers in synthesis (sector context) | **partial** | FMP `sector-pe` endpoint | Tikr screener |
| 14 | Overall rating + confidence + factors | **Claude synthesis** with structured JSON output | **full** | Same | Same |
| 15 | Recommendation history | **Cloudflare KV forward-log** (writes on every synthesis) | **full** | Same | Same |
| 16 | News flow | Yahoo `search` newsCount=15 | **functional** | Benzinga ($177) or NewsAPI ($) | Bloomberg Terminal feed |

Bold rows are the highest-leverage upgrades — biggest data quality jump per dollar spent.

---

## Recommended paid stack by tier

### Light tier ($77/mo) — for production launch to a few users

| Service | Plan | Cost | Replaces |
|---|---|---|---|
| Polygon.io | Stocks Starter | $29/mo | Yahoo for real-time prices, intraday, fundamentals |
| Unusual Whales | Standard | $48/mo | Mock options flow + dark pool sections |
| **Total** | | **$77/mo** | Sections 1, 5, 7, 8 upgraded to real |

Optional add-ons under $30:
- WhaleWisdom Premium ($30) → real 13F holdings (section 10)
- FMP ($14) → deeper fundamentals + peer screening (section 13)

A practical Light+ at ~$120/mo: Polygon + UW + WhaleWisdom + FMP. That's all 16 sections on real data except SEC EDGAR (which is free anyway — see below).

### Pro tier ($400+/mo) — when other users are paying

| Service | Cost | Replaces |
|---|---|---|
| Polygon Stocks Advanced | $199 | Real-time L2 quotes, news, full options |
| Unusual Whales Pro | $75 | Full options flow + dark pool |
| Benzinga Pro API | $177 | Premium news + analyst actions firehose |
| Ortex | $35 | Real-time short interest with squeeze score |
| **Total** | **$486/mo** | Institutional-grade across the board |

### What you should always wire (free, just takes effort)

These are best-in-class data sources that cost nothing — the only reason they're stubbed in the prototype is they need dedicated parsers. Each is worth doing in v2:

1. **SEC EDGAR Form 4** (insider trades, section 4) — `data.sec.gov/submissions/CIK{cik}.json`. Better than any paid feed for raw filings; lag is just SEC's filing window.
2. **SEC EDGAR 13F-HR** (super investors, section 10) — same endpoint family. Free version of WhaleWisdom for the names you care about.
3. **FINRA short interest** (section 3) — biweekly download from finra.org. Two-week lag but it's official.
4. **FRED** (Fed economic data, section 2 macro) — `api.stlouisfed.org`. Free, official, perfect for Fed dot plot, CPI prints.

If you want, the next session I'll wire SEC EDGAR + FINRA into the Worker — that alone takes the prototype from ~70% real data to ~90% real data with zero monthly cost.

---

## Cloudflare Worker setup

### Required bindings

```toml
# wrangler.toml
name = "stock-research-worker"
main = "worker.js"
compatibility_date = "2024-09-01"

[[kv_namespaces]]
binding = "REC_LOG"
id = "<your-kv-namespace-id>"
```

### Required secret

```bash
wrangler secret put ANTHROPIC_API_KEY
```

### Deploy

```bash
wrangler kv:namespace create REC_LOG       # → put the id in wrangler.toml
wrangler deploy
```

Then update `API_BASE` in `index.html` to your Worker URL (e.g. `https://stock-research-worker.you.workers.dev/api`) and push to GitHub Pages.

### Endpoints

All return JSON, all CORS-enabled.

```
GET  /api/quote/:ticker           Yahoo quoteSummary (multi-module)
GET  /api/chart/:ticker           ?range=1y&interval=1d
GET  /api/options/:ticker         ?date=<unix>
GET  /api/search?q=apple          Ticker search
GET  /api/news/:ticker            Yahoo news feed
GET  /api/peers/:ticker           Yahoo recommendationsBySymbol
POST /api/claude                  Body: {messages, max_tokens?, system?}
POST /api/log-rec                 Body: {ticker, rating, confidence, price, factors}
GET  /api/track/:ticker           Read past rating snapshots
```

---

## Recommendation track record — how it works

This is the section the spec asked for explicitly: *"History of recommendations and price action so user can see where the analysis was good/bad."*

The prototype implements **forward-logging from day one**:

1. Every time `synthesize()` runs (one call per ticker page-load), the Worker writes the result to KV under key `rec:{TICKER}`:
   ```json
   { "ticker": "PLTR", "rating": "BUY", "confidence": 78, "price": 187.34,
     "factors": {...}, "ts": "2026-05-01T14:23:11Z" }
   ```
2. The Recommendation History card (section 15) reads the KV list back and shows past calls vs current price.
3. Once you have 5+ entries per ticker, calibration metrics appear: hit rate, mean realized return by rating, Brier score for confidence calibration.

**For backfilling history**: the underlying signals (RSI/MACD/Bollinger/analyst targets) are all reproducible from Yahoo's historical data. A backfill script could synthesize "what would Claude have said on date X" by pulling Yahoo data as-of date X and replaying. Worth a session — maybe 100 lines of Node.

**For automation**: schedule the Worker via Cloudflare Cron Triggers (free) to refresh ratings nightly for a watchlist of tickers. That builds the track record while you sleep.

---

## Things deliberately NOT done in v1

These are reasonable next-session targets:

1. **SEC EDGAR Form 4 / 13F-HR direct** — biggest free data win, just needs ticker→CIK lookup + XML parsing.
2. **FINRA short interest CSV** — biweekly file pull, replace mock generator.
3. **Pattern recognition on the chart** — the spec mentions "chart with pattern drawings" (head & shoulders, cup & handle, etc.). Lightweight Charts supports custom drawings; recognition itself is a Claude vision call against a chart screenshot, or rules-based code.
4. **Backfill of recommendation history** — replay synthesis as-of past dates so the track record card has data on day one.
5. **Watchlist** — multi-ticker overview that links into the research page.
6. **Cron-driven auto-refresh** — Cloudflare Cron Triggers wake the Worker nightly to refresh top tickers.

---

## Visual design notes

- **Fonts**: Fraunces (display serif), Geist (body), JetBrains Mono (numbers). Serif headers in fintech are deliberately rare — gives an editorial-research feel rather than terminal-clone.
- **Aesthetic**: "Trading floor at midnight" — deep charcoal base (`#0a0a0c`), warm off-white text (`#f5f1eb`), restrained accent palette. Subtle grain overlay + soft radial gradients for atmosphere.
- **Colors**: green `#23d18b` / red `#f25f5c` for bull/bear (slightly muted, not neon), amber `#f4b740` for neutral, cyan `#5ec5ea` for data accent, violet `#b48ead` for "mock data" markers.
- **Centerpiece**: AI Synthesis card uses an italic Fraunces verdict ("BUY", "HOLD", "SELL") at 56px, with a circular SVG confidence ring next to it. The rating also appears in the top hero strip for quick reference.
- **Mock data markers**: every section relying on stubs has a small violet "Sample · upgrade: X" tag in its header, making the upgrade path obvious to any user.
