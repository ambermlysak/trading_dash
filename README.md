# Equity Research Terminal

A one-page-per-ticker research dashboard built around 16 components: price action with SMA position, performance windows, earnings + macro catalysts, short interest, insider trades, options volume, swing trade signals (EMA crossovers), recommended option strategies, analyst targets + recent actions, super-investor 13F holdings, technical analysis with chart projections, sentiment, fundamentals + valuation, an AI-synthesized BUY/HOLD/SELL with confidence and factor breakdown, and a forward-logged recommendation track record.

## Stack

- **Frontend**: Single HTML file (`index.html`). TradingView Lightweight Charts + custom SVG. Fraunces / Geist / JetBrains Mono fonts.
- **Backend**: Cloudflare Worker (`worker.js`) — proxies Yahoo Finance, calls Claude API, persists rating history to KV.
- **AI**: Claude Opus 5 for sentiment scoring + overall rating synthesis, with a JSON schema rather than a prompt instruction.

## Quick start

### 1. Deploy the Worker

```bash
npm install -g wrangler
wrangler login
wrangler kv:namespace create REC_LOG    # copy the returned id
```

Edit `wrangler.toml`:

```toml
name = "stock-research-worker"
main = "worker.js"
compatibility_date = "2024-09-01"

[[kv_namespaces]]
binding = "REC_LOG"
id = "<paste-the-id-here>"
```

Then:

```bash
wrangler secret put ANTHROPIC_API_KEY    # paste your key
wrangler deploy
```

Note the Worker URL printed at the end (e.g. `https://stock-research-worker.you.workers.dev`).

### 2. Wire up the frontend

In `index.html`, find the `API_BASE` constant near the top of the script block and replace with your Worker URL:

```js
const API_BASE = 'https://stock-research-worker.you.workers.dev/api';
```

Push to GitHub Pages (or open `index.html` locally — note: opening directly will work because the Worker is CORS-enabled).

### 3. Use it

- Type a ticker into the search bar (e.g. `PLTR`, `NVDA`) and hit Enter — or pick from the autocomplete.
- The full page rebuilds: price/SMA, performance, catalysts, technical chart with indicator overlays, fundamentals, analyst targets, options strategies, trade signals, news, and the AI synthesis at top.
- The AI Synthesis card runs a few seconds after the rest of the page loads (Claude call). Each synthesis is logged to KV.

## What's real, what's stubbed

See `ARCHITECTURE.md` for the section-by-section data source map and the paid-API upgrade path. Short version:

- **Real Yahoo data**: prices, SMAs, performance windows, fundamentals, analyst targets, recent up/downgrades, news, earnings dates, technical indicators, implied vol + option chains, trade signals
- **Real SEC / FINRA / FRED data**: Form 4 insider trades, super-investor 13F holdings, consolidated short interest, macro release dates
- **Computed here**: all technical indicators, HV30, Black-Scholes delta and POP (Yahoo carries no greeks)
- **Claude-generated**: sentiment scores, overall rating + confidence + factor breakdown + thesis paragraphs
- **Nothing is stubbed.** The dark-pool card was deleted rather than faked — no free source exists for it. Every card names the source it actually called and when it last called it; a source that fails renders "unavailable" with the reason, never a generated number.

## Files

- `index.html` — the dashboard
- `worker.js` — Cloudflare Worker
- `ARCHITECTURE.md` — full data source map, upgrade path, design notes
- `README.md` — this file

## Notes

- Yahoo Finance data is delayed 15 minutes. For real-time, swap to Polygon (already proxied through the Worker — just add a new handler).
- Claude model identifier is locked to `claude-opus-5` in `worker.js`.
- Recommendation track record (section 15) starts populating on first use. For backfilled history, see the "next steps" section in `ARCHITECTURE.md`.
- Not investment advice. For research only.
