# Equity Research Terminal

A two-page equity research terminal backed by a single Cloudflare Worker.

- **`dashboard.html`** — macro landing view with six tabs: Market, Midday, Scanner,
  Watchlist, Sectors and Premium (a short-premium options screen).
- **`index.html`** — per-ticker deep dive: price and performance, catalysts and
  earnings, short interest, insider trades, an options V/OI screen, rule-based
  option strategies with a computed probability of profit, swing setups, analyst
  targets, super-investor 13F holdings, technical analysis, sentiment,
  fundamentals, an AI-synthesised BUY/HOLD/SELL, and a forward-logged
  recommendation track record with calibration.

## Stack

- **Frontend** — two standalone HTML files. No bundler, no framework, no build
  step. TradingView Lightweight Charts plus custom SVG. Fraunces / Geist /
  JetBrains Mono.
- **Backend** — one Cloudflare Worker (`worker.js`) proxying Yahoo Finance, SEC
  EDGAR, FINRA, FRED and Alpaca; calling the Anthropic API; and persisting to
  Workers KV.
- **AI** — Claude Opus 5 (`const CLAUDE_MODEL = 'claude-opus-5'` in `worker.js`)
  for sentiment scoring and the overall rating, with a JSON schema rather than a
  prompt instruction.

## Quick start

### 1. Deploy the Worker

```bash
npm install
npx wrangler login
npx wrangler kv namespace create REC_LOG    # copy the returned id
```

Put the id in `wrangler.toml`:

```toml
name = "stock-research-worker"
main = "worker.js"
compatibility_date = "2024-09-01"

[[kv_namespaces]]
binding = "REC_LOG"
id = "<paste-the-id-here>"

[triggers]
crons = ["*/15 13-22 * * *"]
```

Set the secrets:

```bash
npx wrangler secret put AI_GATE_SECRET       # REQUIRED — gates AI + KV-write paths
npx wrangler secret put ANTHROPIC_API_KEY    # required — all Claude synthesis
npx wrangler secret put FRED_API_KEY         # macro release dates + the DGS3MO risk-free rate
npx wrangler secret put FINRA_CLIENT_ID      # official short interest
npx wrangler secret put FINRA_CLIENT_SECRET
npx wrangler secret put ALPACA_KEY           # optional — real-time prices, news archive
npx wrangler secret put ALPACA_SECRET

npx wrangler deploy
```

SEC EDGAR needs no key, but `SEC_UA` in `worker.js` must carry a real contact
email or EDGAR returns 403 for every request.

Note the Worker URL printed at the end.

### 2. Wire up the frontend

Set `API_BASE` near the top of **both** `index.html` and `dashboard.html`:

```js
const API_BASE = 'https://stock-research-worker.you.workers.dev/api';
```

Paste the `AI_GATE_SECRET` value into `DASH_KEY` at the top of the script block in
both files as well.

Push to GitHub Pages. **Opening the files from `file://` no longer works** — that
sends `Origin: null`, which the Worker rejects. For local testing serve them over
http (`npx http-server -p 8123`); `http://localhost:*` is allowlisted.

### 3. Local development

```bash
npx wrangler dev     # Worker on localhost:8787
npx wrangler tail    # live logs from the deployed Worker
```

**`wrangler dev` cannot see deployed secrets.** It reads `.dev.vars` in the repo
root, which is gitignored and so absent on a fresh clone. Without it a local run
degrades in specific, expected ways — no premium candidate strikes (no risk-free
rate, so Black-Scholes deltas are suppressed rather than computed at `r = 0`), a
FOMC-only econ calendar, Yahoo-estimate short interest instead of FINRA, and empty
Claude cards. Create `.dev.vars` with the same keys to test those paths:

```
AI_GATE_SECRET="..."
ANTHROPIC_API_KEY="..."
FRED_API_KEY="..."
FINRA_CLIENT_ID="..."
FINRA_CLIENT_SECRET="..."
```

There is no test suite. Two checks exist — `node cron-gate.check.mjs` (cron
trading-day gate) and `node bs-delta.check.mjs`, which prints
computed vs expected for the Black-Scholes delta against Hull's published worked
example, an independent series-erf implementation and put-call parity.

## What's real

**Everything.** There are no mock generators in the codebase.

- **Yahoo Finance** — prices (15-min delayed), OHLCV, fundamentals, analyst
  targets, upgrades/downgrades, earnings dates, options chains, news fallback
- **SEC EDGAR** — Form 4 insider transactions with real transaction codes; 13F-HR
  holdings for 20 verified super-investor CIKs
- **FINRA** — official biweekly consolidated short interest, six settlements
- **FRED** — CPI/PPI/PCE/jobs/retail release dates, and the DGS3MO 3-month T-bill
  used as the risk-free rate for Black-Scholes
- **Alpaca** (optional) — real-time price overlay and the news archive
- **Computed locally** — RSI, MACD, Bollinger, Stochastic, CCI, HV30, EMA
  crossovers, support/resistance; and in the Worker, Black-Scholes delta and the
  probability of profit derived from it
- **Claude** — sentiment scores, the overall rating with confidence and factor
  breakdown, sector picks, and the daily briefings

Two things were **removed rather than faked**: the dark-pool card (fabricated, and
no free source exists) and the opening-range-breakout / VWAP signals (both were
computed from daily bars, which cannot express either). Section 08 is missing from
`index.html`'s numbering as a deliberate scar.

Where a source fails, the card renders "unavailable" with the reason — never a
generated number. Every card shows what it called and when, and turns amber once
the data is past its refresh window.

## Files

- `dashboard.html` — macro landing view
- `index.html` — per-ticker research page
- `worker.js` — Cloudflare Worker
- `wrangler.toml` — Worker config: KV binding, cron trigger, secret inventory
- `bs-delta.check.mjs` — Black-Scholes delta check
- `cron-gate.check.mjs` — cron trading-day gate check (weekends, NYSE holidays, both DST regimes)
- `cors-check.html` — open in a browser to verify CORS preflight against the Worker
- `CLAUDE.md` — working rules; **read the constraints block first**
- `ARCHITECTURE.md` — data source map, honesty rules, what is deliberately not done

## Notes

- **The Worker is on Cloudflare Workers Paid: 10,000 subrequests per invocation** (settable via `limits.subrequests`). External `fetch()` and KV/binding calls are *different* buckets — see rule #1 in `CLAUDE.md`.
  Any new feature that fans out across tickers must be budgeted against this
  before it is written — it has caused two silent failures already. See
  `CLAUDE.md`.
- Yahoo data is 15 minutes delayed. Alpaca overlays real-time prices when keyed.
- **`POST /api/claude` has been removed** (returns 410). It was an unauthenticated
  passthrough that forwarded arbitrary prompts on the owner's Anthropic key.
  Replaced by `POST /api/ai/:type/:ticker`, where the caller names a task and a
  ticker and the prompt is built server-side. Four layers now gate AI spend —
  no passthrough, an origin allowlist, a shared `x-dash-key` secret, and rate
  limits of 40/IP/hour and 60/day (counted in Claude calls, ~$12/day worst case).
  **None of it is authentication**; read the
  residual-risk section in `ARCHITECTURE.md` before relying on it.
- **`AI_GATE_SECRET` must be set or every AI endpoint 503s** — the gate fails
  closed on purpose. Set it on the Worker and paste the same value into `DASH_KEY`
  in both HTML files.
- **`file://` no longer works.** That sends `Origin: null`, which is now rejected.
  Serve the pages over http for local testing (`npx http-server -p 8123`).
- The recommendation track record starts populating on first use; calibration
  appears once 10 entries have a resolved 20-session outcome.
- Not investment advice. For research only.
