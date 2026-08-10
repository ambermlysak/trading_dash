/**
 * Stock Research Dashboard — Cloudflare Worker
 *
 * Endpoints:
 *   GET  /api/quote/:ticker              → Yahoo v10 fundamentals + Alpaca/chart-meta price
 *   GET  /api/chart/:ticker?range&intvl  → Yahoo v8 OHLCV
 *   GET  /api/options/:ticker[?date]     → Yahoo v7 options chain
 *   GET  /api/search?q=                  → Yahoo ticker search
 *   GET  /api/news/:ticker               → Alpaca news (Yahoo fallback)
 *   GET  /api/peers/:ticker              → Yahoo recommendationsBySymbol
 *   POST /api/claude                     → Anthropic Messages API proxy
 *   POST /api/log-rec                    → Append rating to KV
 *   GET  /api/track/:ticker              → Read rating history from KV
 *   GET  /api/market/snapshot            → Index + futures + commodities + bonds strip
 *   GET  /api/market/movers              → Pre-market / day gainers + losers
 *   GET  /api/market/scanner?preset=     → Day-trading momentum scanner (5 Pillars)
 *   GET  /api/market/ipos                → Upcoming IPO calendar (12h KV cache)
 *   GET  /api/market/econ-calendar?limit → Next FOMC / CPI events (static official schedule)
 *   GET  /api/earnings/:ticker           → Last report: numbers, price reaction, call coverage (12h KV)
 *   GET  /api/watchlist/batch?symbols=   → Bulk fundamentals + RSI + Claude analysis
 *   GET  /api/daily                      → Daily Claude synthesis (6am PT cron) + midday pulse (11:30am PT) + EOD
 *
 * Required secrets (npx wrangler secret put <NAME>):
 *   ANTHROPIC_API_KEY  ALPACA_KEY  ALPACA_SECRET
 */

/* ── Instrumentation: external subrequests + swallowed failures ──────────────
   ONE POOL, and this comment has been wrong in both directions. It first said
   every fetch was a subrequest and budgeted KV against the same ceiling; the
   correction claimed they were SEPARATE buckets. Both were wrong. On Workers
   Paid (this account since 2026-08-07) the cap is 10,000 per invocation —
   settable via `limits.subrequests` in wrangler.toml — and it covers BOTH:

     • external `fetch()` — Yahoo, SEC EDGAR, FINRA, FRED, Alpaca, Anthropic
     • KV / R2 / D1 / Durable Object binding calls — env.REC_LOG.get/put/delete

   Cloudflare defines a subrequest as any request made "using the Fetch API or to
   Cloudflare services like R2, KV, or D1" (verified 2026-08-08). The Free plan's
   50-external / 1,000-service split does not apply here.

   BOTH are counted, separately, and the total is named `capCost`:

     • `extFetches`  — the `globalThis.fetch` wrap below
     • `bindingOps`  — the per-request binding proxy (`instrWrapBindings`)
     • `capCost`     — extFetches + bindingOps, the figure the 10,000 meters

   `extFetches` alone used to be reported as the cost, which understated it by
   the whole of KV — for one long-screen ticker that is roughly a third of the
   real number. Never quote extFetches as a budget again.

   COVERAGE IS DECLARED, NOT ASSUMED. `instrWrapBindings` does not name
   `REC_LOG`; it walks `env` and wraps everything binding-SHAPED, so a binding
   added later is counted the day it appears rather than the day someone
   remembers this file. What it wrapped and what it could not rides along as
   `bindingsWrapped` / `bindingsSkipped`, because a total that silently omits a
   source is the `build13FIndex` failure wearing different clothes.

   KNOWN GAP, stated rather than papered over: the **Cache API**
   (`caches.default.match/put`, `caches.open`) also counts against the cap and
   does NOT travel over `globalThis.fetch` or `env`, so neither counter can see
   it. Nothing in this file uses it today (`cacheApiUsed: false` is asserted by
   grep, not by hope). If you add one, you must extend this block in the same
   commit — see the rule in CLAUDE.md.

   In practice the cap is not the binding constraint anyway: Yahoo crumb
   rate-limiting is, and it is untouched by the plan tier. Nothing that avoids
   fan-out in this file should be relaxed because the ceiling went up.

   `settledRejected` exists because `Promise.allSettled` discards rejections.
   Every truncated cron run in this codebase reported `errors: 0` in Cloudflare's
   telemetry while silently dropping a third of its work — the 13F index shipped
   16 of 20 managers that way. Truncation has to describe itself.

   Scope note: the counter is per-isolate and reset at the top of `scheduled()`.
   An isolate can also serve requests, so a page load landing mid-cron inflates
   `invocationFetches`. The per-job `extFetches` delta is the number to trust,
   and `scope` records which reset it was measured against. */
const INSTR = {
  fetches: 0, rejected: 0, scope: 'none', wrapped: false,
  bindingOps: 0,
  bindingsWrapped: [],   // names actually counted this invocation
  bindingsSkipped: [],   // {name, reason} — present on env, NOT counted
};

try {
  const _nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (...args) => { INSTR.fetches++; return _nativeFetch(...args); };
  INSTR.wrapped = true;
} catch (e) {
  // Never let instrumentation take the Worker down. `wrapped:false` rides along
  // in every payload so a zero count can't be misread as "made no calls".
  console.error('[instr] could not wrap globalThis.fetch:', e.message);
}

/* ── Binding counter ─────────────────────────────────────────────────────────
   Binding calls (KV/R2/D1/DO/service) count against the same 10,000 as external
   fetches, and they do not go through `globalThis.fetch`, so they need their own
   interception. This one is deliberately NOT written as "wrap env.REC_LOG":
   naming the binding means a second binding added later is silently uncounted
   while the total still looks authoritative — the same shape as a per-item catch
   reporting 16 of 20 managers as complete.

   So it detects by SHAPE. A binding is an object (or function) carrying at least
   one callable member; a `[vars]` entry that happens to be JSON is an object with
   none, and a secret is a string. Anything binding-shaped gets a counting proxy;
   anything that cannot be wrapped is recorded in `bindingsSkipped` with a reason
   and reported, never quietly dropped.

   This sits in front of EVERY KV call in the Worker, which is a far more
   dangerous place than the fetch wrap. It therefore fails safe in the strongest
   sense available: any failure returns the ORIGINAL, unwrapped `env` so the
   request proceeds normally, and degrades the report to `bindingsWrapped: []`. */

/** An object/function carrying at least one callable member. */
function looksLikeBinding(v) {
  if (v == null) return false;
  const t = typeof v;
  if (t !== 'object' && t !== 'function') return false;   // strings = secrets
  const seen = new Set();
  for (let o = v; o && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (k === 'constructor' || seen.has(k)) continue;
      seen.add(k);
      try { if (typeof v[k] === 'function') return true; } catch (_) { /* getter threw; keep looking */ }
    }
  }
  return false;
}

/** Counting proxy over one binding. Method wrappers are memoised so a hot loop
 *  (ivHistory's paged list()) does not allocate a closure per property access. */
function countingBinding(target) {
  const cache = new Map();
  return new Proxy(target, {
    get(t, prop) {
      // Receiver is the raw target on purpose: a proxy receiver breaks internal
      // slots / private fields on some runtime classes.
      const val = Reflect.get(t, prop, t);
      if (typeof val !== 'function') return val;
      let wrapped = cache.get(prop);
      if (!wrapped) {
        wrapped = (...args) => {
          try { INSTR.bindingOps++; } catch (_) { /* counting must never break the call */ }
          return val.apply(t, args);
        };
        cache.set(prop, wrapped);
      }
      return wrapped;
    },
  });
}

/**
 * Wrap every binding-shaped member of `env` in a counting proxy.
 * Returns the env to actually use. On ANY failure returns the original env
 * untouched — a broken counter must never become a broken KV read.
 */
function instrWrapBindings(env) {
  try {
    if (!env || typeof env !== 'object') return env;
    const wrapped = [], skipped = [];
    const out = {};
    for (const name of Object.keys(env)) {
      const val = env[name];
      if (!looksLikeBinding(val)) { out[name] = val; continue; }   // secret or plain var
      try {
        out[name] = countingBinding(val);
        wrapped.push(name);
      } catch (e) {
        out[name] = val;                                          // uncounted but WORKING
        skipped.push({ name, reason: e.message || 'proxy failed' });
      }
    }
    INSTR.bindingsWrapped = wrapped;
    INSTR.bindingsSkipped = skipped;
    if (skipped.length) console.warn('[instr] bindings not counted:', JSON.stringify(skipped));
    return out;
  } catch (e) {
    console.error('[instr] binding wrap failed, counts will read 0:', e.message);
    try { INSTR.bindingsWrapped = []; INSTR.bindingsSkipped = [{ name: '*', reason: e.message }]; } catch (_) {}
    return env;
  }
}

/* ── EVERY function below swallows its own failures ──────────────────────────
   These exist to *observe* the cron jobs. A measuring device that can break the
   thing it measures is worse than no measuring device: an exception inside
   instrumentation would take out the morning briefing, which is the exact
   outcome all of this was added to make visible.

   So the contract is: instrumentation failure degrades to a MISSING or
   `measured:false` `_instr` field, and never to a missing briefing. Nothing here
   may throw, and `allSettledCounted` may never reject where `Promise.allSettled`
   would not. */

function instrReset(scope) {
  try { INSTR.fetches = 0; INSTR.rejected = 0; INSTR.bindingOps = 0; INSTR.scope = scope; }
  catch (e) { console.warn('[instr] reset failed:', e.message); }
}

/** Baseline, so one job's cost separates from the whole invocation's. */
function instrMark() {
  try { return { f: INSTR.fetches, r: INSTR.rejected, b: INSTR.bindingOps }; }
  catch (e) { console.warn('[instr] mark failed:', e.message); return null; }
}

/** Cost of the work done since `mark`. `phase` says how far the job actually got.
 *  Returns a `measured:false` stub rather than throwing — this call sits inside
 *  the JSON.stringify of a KV put, so a throw here would lose the payload.
 *
 *  `capCost` is the number the 10,000 actually meters. `extFetches` on its own is
 *  a LOWER BOUND and must not be quoted as a budget — that mistake is why this
 *  block exists. `bindingsWrapped` / `bindingsSkipped` / `cacheApiCounted` state
 *  the counter's own coverage, so a total can be read as complete or not. */
function instrSince(mark, phase) {
  try {
    if (!mark) return { measured: false, phase, note: 'no baseline captured' };
    const extFetches = INSTR.fetches - mark.f;
    const bindingOps = INSTR.bindingOps - (mark.b || 0);
    return {
      extFetches,
      bindingOps,
      capCost: extFetches + bindingOps,
      settledRejected:   INSTR.rejected - mark.r,
      invocationFetches: INSTR.fetches,
      invocationCapCost: INSTR.fetches + INSTR.bindingOps,
      scope:             INSTR.scope,
      measured:          INSTR.wrapped,
      bindingsWrapped:   [...(INSTR.bindingsWrapped || [])],
      bindingsSkipped:   [...(INSTR.bindingsSkipped || [])],
      // The Cache API counts against the cap and is invisible to both counters.
      // Nothing uses it today; this field exists so that stops being silent.
      cacheApiCounted:   false,
      phase,
    };
  } catch (e) {
    console.warn('[instr] since failed:', e.message);
    return { measured: false, phase, note: 'instrumentation error' };
  }
}

/** `Promise.allSettled` that counts — and logs — the rejections nobody reads.
 *  The counting is wrapped separately from the await: `Promise.allSettled` never
 *  rejects, and neither may this, or a bookkeeping slip becomes a job failure. */
async function allSettledCounted(promises, label) {
  const results = await Promise.allSettled(promises);
  try {
    const bad = results.filter(r => r.status === 'rejected');
    if (bad.length) {
      INSTR.rejected += bad.length;
      console.warn(`[instr] ${label}: ${bad.length}/${results.length} rejected · first: ${bad[0].reason?.message || bad[0].reason}`);
    }
  } catch (e) {
    console.warn(`[instr] count failed for ${label}:`, e.message);
  }
  return results;
}

/** Stamp a finished job's instrumentation onto an already-written KV payload.
 *  Fully swallowed: this runs AFTER the payload is safely stored, so the worst
 *  case is a stored `_instr` that still reads `phase: "briefing"`. */
async function stampInstr(env, key, mark, phase, ttlSeconds) {
  try {
    const cur = await env?.REC_LOG?.get(key, 'json');
    if (!cur) return;
    cur._instr = instrSince(mark, phase);
    await env?.REC_LOG?.put(key, JSON.stringify(cur), { expirationTtl: ttlSeconds });
    console.log(`[instr] ${key} · ${JSON.stringify(cur._instr)}`);
  } catch (e) {
    console.warn(`[instr] stamp failed for ${key}:`, e.message);
  }
}

const ALLOWED_ORIGINS = [
  'https://ambermlysak.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

/* ── The preflight contract ──────────────────────────────────────────────────
   `x-dash-key` is the gate header the frontend sends. It is NOT one of the four
   CORS-safelisted request headers (Accept, Accept-Language, Content-Language,
   Content-Type), so the browser issues an `OPTIONS` preflight before every real
   request and refuses to send it unless the response advertises the header in
   `Access-Control-Allow-Headers`.

   It did not, and the whole site went dark: 12 requests blocked client-side,
   before the Worker was ever reached. Nothing in the Worker logs, because
   nothing arrived.

   **Any custom request header added anywhere in either frontend must be added to
   CORS_ALLOW_HEADERS.** This is declared beside ALLOWED_ORIGINS, and the gate
   header name is defined here rather than next to the gate so the two cannot
   drift — `AI_SECRET_HEADER` is the single source of truth for both the check
   and the preflight advertisement. */
const AI_SECRET_HEADER = 'x-dash-key';
const CORS_ALLOW_HEADERS = ['Content-Type', AI_SECRET_HEADER].join(', ');

const CLAUDE_MODEL = 'claude-opus-5';

/* Opus 5 thinks by default, and `max_tokens` caps thinking + answer together —
 * so every per-call budget below is the room for the *answer*, and this is added
 * on top for reasoning. Raising the cap is free: it bounds spend, it doesn't
 * cause it, and unused headroom is never billed.
 *
 * Effort is the cost/latency dial. `medium` is a genuine step up from Sonnet 4.6
 * while keeping cron jobs inside the 30s waitUntil budget; drop to `low` if the
 * scheduled runs start getting cut off. Do NOT set thinking to `disabled` — on
 * Opus 5 that can leak `<thinking>` tags into the visible text, and half of what
 * comes back here is parsed as JSON. */
const CLAUDE_THINKING_HEADROOM = 4000;
const CLAUDE_EFFORT = 'medium';   // low | medium | high | xhigh | max
const CLAUDE_REASONING = {
  thinking:      { type: 'adaptive' },
  output_config: { effort: CLAUDE_EFFORT },
};

/* Pull the answer out of a Messages response. Never index content[0] — with
 * thinking on, slot 0 is a thinking block whose text is empty by default. */
function claudeText(data) {
  return (data?.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text || '')
    .join('')
    .trim();
}

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
};

const SNAPSHOT_SYMBOLS = {
  '^GSPC': 'S&P 500',
  '^IXIC': 'NASDAQ',
  '^DJI':  'Dow Jones',
  '^RUT':  'Russell 2000',
  'ES=F':  'S&P Futures',
  'NQ=F':  'NQ Futures',
  'GC=F':  'Gold',
  'SI=F':  'Silver',
  'CL=F':  'WTI Oil',
  '^TNX':  '10Y Yield',
  '^VIX':  'VIX',
};

const DEFAULT_WATCHLIST = [
  'PLTR','NVDA','AMD','AAPL','AMZN','GOOGL','QUBT','TWLO','NOW','TSM',
  'MU','APP','CRCL','CRWV','MRK','UNH','TSLA','PANW','RDDT','CAVA','JPM','HOOD',
];

const SECTOR_ETFS = {
  'XLK':  'Technology',
  'XLF':  'Financials',
  'XLE':  'Energy',
  'XLV':  'Health Care',
  'XLY':  'Consumer Discretionary',
  'XLP':  'Consumer Staples',
  'XLI':  'Industrials',
  'XLB':  'Materials',
  'XLRE': 'Real Estate',
  'XLC':  'Communication Services',
  'XLU':  'Utilities',
};

const SECTOR_STOCKS = {
  'Technology':             ['NVDA', 'AAPL', 'MSFT'],
  'Financials':             ['JPM',  'GS',   'BAC'],
  'Energy':                 ['XOM',  'CVX',  'COP'],
  'Health Care':            ['UNH',  'LLY',  'MRK'],
  'Consumer Discretionary': ['AMZN', 'TSLA', 'HD'],
  'Consumer Staples':       ['WMT',  'COST', 'PG'],
  'Industrials':            ['CAT',  'BA',   'HON'],
  'Materials':              ['LIN',  'FCX',  'NEM'],
  'Real Estate':            ['PLD',  'AMT',  'SPG'],
  'Communication Services': ['META', 'GOOGL','NFLX'],
  'Utilities':              ['NEE',  'DUK',  'SO'],
};

/* ── Economic calendar ────────────────────────────────────────────────────────
 * Hand-maintained from the official sources. This is the ONLY place macro event
 * dates are allowed to come from — never let Claude infer them from memory, or
 * it will emit dates from its training cutoff (that bug shipped an "FOMC in 7
 * days" catalyst on every ticker page regardless of the real schedule).
 *
 * FOMC:  https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 * CPI:   https://www.bls.gov/schedule/news_release/cpi.htm
 *
 * Refresh when ECON_CALENDAR_THROUGH is within a few months: the Fed publishes
 * two years ahead each summer, BLS publishes the next year each fall.
 */
const ECON_CALENDAR_THROUGH = '2027-12-08'; // last date covered by the tables below

/* ── NYSE trading-day calendar ───────────────────────────────────────────────
 * Full-day closures. The cron dispatcher skips these, so no job spends a Claude
 * call narrating a session that never happened.
 *
 * VERIFIED 2026-08-07, two independent ways, because a hand-typed calendar is
 * exactly the class of constant that has been wrong here before (7 of 18
 * super-investor CIKs, and the hardcoded FRED release IDs):
 *   1. NYSE Group's published 2025–2027 holiday calendar.
 *   2. Re-derived from the observance rules — Easter computus for Good Friday;
 *      a holiday on Saturday observed the preceding Friday, on Sunday the
 *      following Monday; New Year's Day exempt from the Saturday rule.
 * Both produced the same 13 dates, with no extras and none missing.
 *
 * Forward-looking only: 2026 starts in August because everything earlier is in
 * the past and the gate is never asked about it.
 *
 * EARLY CLOSES ARE NOT MODELLED, AND THAT HAS A CONSEQUENCE. The NYSE closes at
 * 1:00pm ET — 10:00am PT — the day after Thanksgiving and on Christmas Eve. In
 * this window that is 2026-11-27, 2026-12-24 and 2027-11-26. On those days the
 * 11:30am PT midday pulse runs POST-CLOSE and will describe a finished session
 * as though it were still mid-session, and the 1:15pm PT EOD job runs 3h15m
 * after the bell rather than 15 minutes after it. Flagged deliberately; not
 * fixed here.
 *
 * Note 2027-12-24 is a FULL closure (Christmas Day observed, since Dec 25 2027
 * is a Saturday), not an early close — two of the three sources consulted got
 * that one backwards.
 */
const NYSE_HOLIDAYS = new Set([
  // 2026
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas Day
  // 2027
  '2027-01-01', // New Year's Day
  '2027-01-18', // Martin Luther King, Jr. Day
  '2027-02-15', // Washington's Birthday
  '2027-03-26', // Good Friday
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth observed (Jun 19 is a Saturday)
  '2027-07-05', // Independence Day observed (Jul 4 is a Sunday)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas Day observed (Dec 25 is a Saturday)
]);
const NYSE_HOLIDAYS_THROUGH = '2027-12-31'; // past this the gate can only see weekends

/** PT calendar date + weekday, read off the SAME Date object the dispatch uses. */
function ptParts(pt) {
  const p2 = n => String(n).padStart(2, '0');
  return {
    iso: `${pt.getFullYear()}-${p2(pt.getMonth() + 1)}-${p2(pt.getDate())}`,
    dow: pt.getDay(),                       // 0 = Sunday … 6 = Saturday
  };
}

/* Named exports purely so the cron gate is testable outside the Worker runtime;
   workerd only ever dispatches through the default export.

   EVERY NAMED EXPORT MUST BE A FUNCTION. workerd validates the module's exports
   at startup and refuses to boot on anything else — exporting the Set and the
   string directly produced "Incorrect type for map entry
   'NYSE_HOLIDAYS_THROUGH': the provided value is not of type 'function or
   ExportedHandler'" and the runtime never came up. So the constants are handed
   out through an accessor rather than exported as values. */
export { ptParts, tradingDayStatus, allSettledCounted, instrMark, instrSince };
export const cronGateCalendar = () => ({
  holidays: NYSE_HOLIDAYS,
  through:  NYSE_HOLIDAYS_THROUGH,
});
export const instrPeek = () => ({ ...INSTR });

// TODO(2026-08-10): remove this constant together with the second entry in
// `crons` in wrangler.toml. The two are a pair; deleting one without the other
// is the drift this codebase keeps getting caught by.
//
// The temporary diagnostic trigger, matched EXACTLY as wrangler.toml spells it.
// scheduled() suppresses dispatch for firings carrying this expression: the
// probe exists to prove invocations happen and to exercise the weekend gate,
// and neither needs it to run a job.
//
// Matched by allowlisting the PROBE rather than by "anything that is not the
// primary cron" on purpose. If Cloudflare ever reports a normalized expression
// string, an allowlist-the-probe test fails toward the probe dispatching —
// bounded, and exactly the behaviour before this guard existed. The inverted
// test would fail toward the REAL cron being suppressed and nothing running at
// all, which is the far more expensive direction to be wrong in.
const PROBE_CRON = '*/5 * * * *';

/** Is this a NYSE trading day? Weekend or full-day holiday means no dispatch. */
function tradingDayStatus(isoDate, dow) {
  if (dow === 0 || dow === 6)      return { open: false, reason: 'weekend' };
  if (NYSE_HOLIDAYS.has(isoDate))  return { open: false, reason: 'nyse-holiday' };
  // Past the table's runway every weekday looks open, including holidays. Say so
  // rather than letting the calendar expire silently.
  return { open: true, reason: 'weekday', calendarStale: isoDate > NYSE_HOLIDAYS_THROUGH };
}

// Two-day meetings; the rate decision lands at 2:00pm ET on the second day.
// sep = meeting also publishes the Summary of Economic Projections ("dot plot").
const FOMC_MEETINGS = [
  { start: '2026-01-27', end: '2026-01-28', sep: false },
  { start: '2026-03-17', end: '2026-03-18', sep: true  },
  { start: '2026-04-28', end: '2026-04-29', sep: false },
  { start: '2026-06-16', end: '2026-06-17', sep: true  },
  { start: '2026-07-28', end: '2026-07-29', sep: false },
  { start: '2026-09-15', end: '2026-09-16', sep: true  },
  { start: '2026-10-27', end: '2026-10-28', sep: false },
  { start: '2026-12-08', end: '2026-12-09', sep: true  },
  { start: '2027-01-26', end: '2027-01-27', sep: false },
  { start: '2027-03-16', end: '2027-03-17', sep: true  },
  { start: '2027-04-27', end: '2027-04-28', sep: false },
  { start: '2027-06-08', end: '2027-06-09', sep: true  },
  { start: '2027-07-27', end: '2027-07-28', sep: false },
  { start: '2027-09-14', end: '2027-09-15', sep: true  },
  { start: '2027-10-26', end: '2027-10-27', sep: false },
  { start: '2027-12-07', end: '2027-12-08', sep: true  },
];

/**
 * Statistical-release dates come from FRED, not from a table here.
 *
 * The CPI dates used to be hand-maintained alongside the FOMC table above. FRED
 * publishes the official schedule for all of these, so the table is gone and the
 * dates are fetched — one less thing that silently goes stale. FOMC stays
 * hardcoded because the Fed's calendar is not a FRED release.
 *
 * Release IDs are deliberately NOT hardcoded: they are resolved by name from
 * /fred/releases and cached, because an ID recalled from memory is exactly the
 * kind of unverifiable constant this codebase keeps getting wrong.
 */
const FRED_RELEASES = [
  { key: 'cpi',    name: 'Consumer Price Index',                               impact: 'HIGH',   title: 'CPI report',           note: '8:30am ET. Headline and core consumer inflation.' },
  { key: 'pce',    name: 'Personal Income and Outlays',                        impact: 'HIGH',   title: 'PCE price index',      note: "8:30am ET. The Fed's preferred inflation gauge." },
  { key: 'jobs',   name: 'Employment Situation',                               impact: 'HIGH',   title: 'Employment Situation', note: '8:30am ET. Nonfarm payrolls and the unemployment rate.' },
  { key: 'ppi',    name: 'Producer Price Index',                               impact: 'MEDIUM', title: 'PPI report',           note: '8:30am ET. Producer-level inflation.' },
  { key: 'retail', name: 'Advance Monthly Sales for Retail and Food Services', impact: 'MEDIUM', title: 'Retail sales',         note: '8:30am ET. Advance monthly retail and food-services sales.' },
];
const FRED_KV_KEY  = 'econ:fred';
const FRED_TTL     = 43_200;   // 12h — the schedule moves rarely, but not never
const FRED_HORIZON = 120;      // days of upcoming releases to keep

/** Today in US Eastern (market) time as an ISO `YYYY-MM-DD` string. */
const etToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

/** Format an ISO date without letting the local timezone shift the day. */
function isoLabel(isoDate, opts = {}) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', ...opts,
  });
}

/** Add `days` to an ISO date, returning a new ISO date. */
function isoAddDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** "Jul 28–29" for a same-month meeting, "Apr 28–May 1" when it straddles months. */
function isoRangeLabel(startIso, endIso) {
  const sameMonth = startIso.slice(0, 7) === endIso.slice(0, 7);
  const end = sameMonth ? String(Number(endIso.slice(8, 10))) : isoLabel(endIso);
  return `${isoLabel(startIso)}–${end}`;
}

/**
 * Every known macro event as a flat, date-sorted list.
 * ISO dates compare correctly as strings, so callers can filter with < / >.
 */
/**
 * Resolve FRED release IDs by name, then pull each one's upcoming dates.
 * Returns `{ events, error, asOfIds }` — on any failure `events` is empty and
 * `error` says why, so callers can report "unavailable" instead of showing a
 * calendar that is quietly missing half its entries.
 */
async function fetchFredReleaseDates(env) {
  const key = env?.FRED_API_KEY;
  if (!key) return { events: [], error: 'FRED_API_KEY not configured', asOfIds: {} };

  const base = 'https://api.stlouisfed.org/fred';
  const today = etToday();
  const through = isoAddDays(today, FRED_HORIZON);

  // Name → id, from FRED itself.
  const listUrl = `${base}/releases?api_key=${encodeURIComponent(key)}&file_type=json&limit=1000`;
  const listRes = await fetch(listUrl);
  if (!listRes.ok) return { events: [], error: `FRED releases ${listRes.status}`, asOfIds: {} };
  const all = (await listRes.json())?.releases || [];

  const byName = new Map(all.map(r => [String(r.name || '').toLowerCase(), r.id]));
  const asOfIds = {};
  for (const spec of FRED_RELEASES) {
    const want = spec.name.toLowerCase();
    let id = byName.get(want);
    if (id == null) {
      const hit = all.find(r => String(r.name || '').toLowerCase().startsWith(want));
      id = hit?.id;
    }
    if (id != null) asOfIds[spec.key] = id;
  }
  if (!Object.keys(asOfIds).length) {
    return { events: [], error: 'no FRED release IDs resolved by name', asOfIds: {} };
  }

  const events = [];
  const missing = [];
  for (const spec of FRED_RELEASES) {
    const id = asOfIds[spec.key];
    if (id == null) { missing.push(spec.name); continue; }
    try {
      const u = `${base}/release/dates?release_id=${id}&api_key=${encodeURIComponent(key)}`
              + `&file_type=json&include_release_dates_with_no_data=true&sort_order=asc`
              + `&realtime_start=${today}&realtime_end=${through}&limit=12`;
      const r = await fetch(u);
      if (!r.ok) { missing.push(spec.name); continue; }
      for (const d of ((await r.json())?.release_dates || [])) {
        if (!d?.date || d.date < today || d.date > through) continue;
        events.push({
          date: d.date, type: 'Economic', impact: spec.impact,
          title: spec.title, note: spec.note, source: 'FRED',
        });
      }
    } catch (_) { missing.push(spec.name); }
  }

  return {
    events,
    error: events.length ? null : 'FRED returned no upcoming release dates',
    partial: missing.length ? `no dates for: ${missing.join(', ')}` : null,
    asOfIds,
  };
}

/** FRED release dates, cached. Never throws — a failure degrades to FOMC-only. */
async function getEconReleases(env) {
  try {
    const cached = await env?.REC_LOG?.get(FRED_KV_KEY, 'json');
    if (cached && Array.isArray(cached.events)) return cached;
  } catch (_) {}
  let res;
  try {
    res = await fetchFredReleaseDates(env);
  } catch (e) {
    res = { events: [], error: `FRED fetch failed: ${e.message}`, asOfIds: {} };
  }
  // Cache failures too, briefly, so a FRED outage does not mean a call per request.
  try {
    await env?.REC_LOG?.put(FRED_KV_KEY, JSON.stringify({ ...res, ts: Date.now() }),
      { expirationTtl: res.events.length ? FRED_TTL : 900 });
  } catch (_) {}
  return res;
}

function econCalendar(dataReleases = []) {
  const events = [...dataReleases];

  for (const m of FOMC_MEETINGS) {
    const range = isoRangeLabel(m.start, m.end);
    events.push({
      date:   m.end,
      type:   'Fed',
      impact: 'HIGH',
      title:  'FOMC rate decision',
      note:   `2:00pm ET statement plus Chair press conference, closing the ${range} meeting.` +
              (m.sep ? ' Includes the Summary of Economic Projections (dot plot).' : ''),
    });
    // Minutes are released three weeks after the policy decision, by Fed rule.
    events.push({
      date:   isoAddDays(m.end, 21),
      type:   'Fed',
      impact: 'MEDIUM',
      title:  'FOMC minutes',
      note:   `2:00pm ET release of minutes from the ${range} meeting.`,
    });
  }

  return events.sort((a, b) => a.date.localeCompare(b.date));
}

/** Macro events falling within [startIso, endIso] inclusive. */
function econEventsBetween(startIso, endIso, dataReleases = []) {
  return econCalendar(dataReleases).filter(e => e.date >= startIso && e.date <= endIso);
}

/** The next `limit` macro events on or after `fromIso` (defaults to today ET). */
function econEventsAhead(limit = 5, fromIso = etToday(), dataReleases = []) {
  return econCalendar(dataReleases).filter(e => e.date >= fromIso).slice(0, limit);
}

/**
 * Render events as prompt lines. Returns '' when there are none so callers can
 * fall back to explicit "no scheduled events" wording rather than an empty list.
 */
function econPromptLines(events) {
  return events
    .map(e => `• ${isoLabel(e.date, { weekday: 'short', year: 'numeric' })} — ${e.title} [${e.type}, ${e.impact}]: ${e.note}`)
    .join('\n');
}

/* ── CORS ── */
/**
 * Origin allowlist — **defense in depth, not authentication.**
 *
 * `Origin` is set by the browser and is trivially forged by anything that is not
 * a browser: `curl -H 'Origin: https://ambermlysak.github.io'` passes this check
 * completely. It stops a hostile *web page* from using the Worker via a user's
 * browser, and it stops opportunistic scanners that do not bother to set a
 * header. It stops nothing else. Never treat a passing origin as an identity.
 *
 * This used to `return true` when `Origin` was absent or the literal `'null'`,
 * which meant every non-browser client on earth was allowed — the exact hole
 * that left `/api/claude` open. **An absent Origin now fails.**
 *
 * Consequence worth knowing: opening `index.html` from `file://` sends
 * `Origin: null` and is now rejected. Serve the pages over http for local dev
 * (`npx http-server -p 8123`) — `http://localhost:*` is allowlisted.
 */
function isAllowedOrigin(origin) {
  if (!origin || origin === 'null') return false;
  return ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + ':'));
}

/* ═══════════════════════════════════════════════════════════════════════════
   SPEND GATE

   Every request path that can reach `workerClaude()` bills the owner's Anthropic
   key. `/api/claude` was the worst of these — an unauthenticated passthrough
   that forwarded arbitrary `messages` — but it was never the only one. These all
   spend on the request path:

     POST /api/ai/:type/:ticker      synthesis (replaces /api/claude)
     GET  /api/earnings/:ticker      ~1800 answer tokens on a cache miss
     GET  /api/market/sectors        ~3500, on ?refresh=1 or a cold cache
     GET  /api/market/week-ahead     ~2000 on a cold cache
     GET  /api/market/scanner        ~500 for catalyst tagging
     GET  /api/daily                 ~2500 when the snapshot is stale/incomplete
     GET  /api/watchlist/batch       ~700 PER UNCACHED TICKER, up to 30 a request

   That last one was the second-worst hole: 30 arbitrary symbols in one
   unauthenticated GET fans out to 30 Claude calls.

   Three checks, applied in cost order — cheapest rejection first:
     1. shared secret header  (no KV read)
     2. global daily ceiling  (1 KV read)
     3. per-IP hourly ceiling (1 KV read)

   None of this is authentication. See the residual-risk note in ARCHITECTURE.md;
   the limits are what actually bound the bill.
   ══════════════════════════════════════════════════════════════════════════ */


/* Ceilings, denominated in **Claude calls** — not requests. See the `cost`
   handling in aiGuard: one /api/watchlist/batch can queue 30 analyses, so a
   request-denominated ceiling would authorise ~30× what it appeared to.

   Cron spend does NOT count against these. The scheduled jobs call workerClaude
   directly, having no request to authenticate, so the crons' ~30 calls/day are
   on top of whatever the ceiling permits. These bound REQUEST-PATH spend only.

   Sizing: interactive use is roughly one synthesis per ticker opened, plus the
   occasional earnings click and sectors refresh. A heavy session is ~15 tickers.
   60/day is about 4× that; 40/hour per IP is deliberately left higher than the
   daily figure so a single burst is limited by the day, not the hour.

   The global cap is what bounds the bill — rotating IPs defeats the per-IP one
   for free. Worst case, every call taking the most expensive gated route
   (generateSectors at 3500 answer + 4000 thinking headroom = 7500 output):

       60 × 7500 = 450,000 output tokens = 0.45 MTok × $25 = $11.25
       plus input, ~3000 tok/call → 0.18 MTok × $5             = $0.90
                                                        total ≈ $12/day

   That is the number to move if the exposure still feels wrong — not the per-IP
   one, which an attacker simply routes around. */
const AI_RATE_PER_IP_HOUR = 40;
const AI_RATE_GLOBAL_DAY  = 60;

/** Constant-time string compare. `===` on a secret leaks length and prefix
 *  through timing; over the internet that is mostly theoretical, but the correct
 *  version is three lines. */
function safeEqual(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const utcHourBucket = () => new Date().toISOString().slice(0, 13);  // YYYY-MM-DDTHH
const utcDayBucket  = () => new Date().toISOString().slice(0, 10);  // YYYY-MM-DD

/**
 * Gate a request that is about to spend Anthropic credit.
 * Returns `null` to proceed, or a `Response` to return instead.
 *
 * **Fails closed.** With `AI_GATE_SECRET` unset every AI path 503s rather than
 * running unauthenticated — a security control that silently disables itself on
 * a missing config is not a control. The error names the missing secret so the
 * cause is obvious rather than looking like an outage.
 */
/** Secret only, no rate limiting — for endpoints that WRITE KV but do not spend
 *  Anthropic credit. Storage abuse and data poisoning are cheaper problems than
 *  a billed API, but an unauthenticated write that later renders on a card is
 *  still a way to put someone else's text on the page. */
function requireSecret(request, env, origin) {
  const expected = env?.AI_GATE_SECRET;
  if (!expected) {
    return err('Write endpoints are disabled: AI_GATE_SECRET is not configured on this Worker.', 503, origin);
  }
  if (!safeEqual(request.headers.get(AI_SECRET_HEADER), expected)) {
    return err('missing or invalid API key', 401, origin);
  }
  return null;
}

/** Boolean form of the gate, for opportunistic background spends inside handlers
 *  whose *data* must still be served to everyone. `/api/daily` and
 *  `/api/watchlist/batch` both return a useful payload from cache regardless;
 *  what they must not do for an unauthenticated caller is kick off generation.
 *  Rejecting the whole endpoint would break the page for no security gain. */
async function maySpend(request, env, cost = 1) {
  return (await aiGuard(request, env, '', { cost })) === null;
}

async function aiGuard(request, env, origin, { cost = 1 } = {}) {
  const expected = env?.AI_GATE_SECRET;
  if (!expected) {
    console.error('[aiGuard] AI_GATE_SECRET is not set — refusing to spend unauthenticated');
    return err('AI endpoints are disabled: AI_GATE_SECRET is not configured on this Worker. '
             + 'Set it with `npx wrangler secret put AI_GATE_SECRET`.', 503, origin);
  }
  if (!safeEqual(request.headers.get(AI_SECRET_HEADER), expected)) {
    return err('missing or invalid API key', 401, origin);
  }

  const kv = env?.REC_LOG;
  if (!kv) return null;   // no KV bound: secret alone still applies

  const ip     = request.headers.get('CF-Connecting-IP') || 'unknown';
  const dayKey = `ratelimit:ai:global:${utcDayBucket()}`;
  const ipKey  = `ratelimit:ai:ip:${ip}:${utcHourBucket()}`;

  try {
    const [dayRaw, ipRaw] = await Promise.all([kv.get(dayKey), kv.get(ipKey)]);
    const dayN = Number(dayRaw) || 0;
    const ipN  = Number(ipRaw)  || 0;

    // `cost` is how many Claude calls this request is about to make, not how many
    // requests it is. They are not the same number: one /api/watchlist/batch can
    // fan out to 30 analyses. Counting requests would have let a 60/day ceiling
    // authorise 1,800 calls — the ceiling has to be denominated in the thing that
    // costs money.
    if (dayN + cost > AI_RATE_GLOBAL_DAY) {
      console.warn(`[aiGuard] global daily cap: ${dayN} + ${cost} > ${AI_RATE_GLOBAL_DAY}`);
      return json({ error: `daily AI call ceiling reached (${AI_RATE_GLOBAL_DAY} calls). Resets at 00:00 UTC.`,
                    used: dayN, requested: cost, limit: AI_RATE_GLOBAL_DAY,
                    retryAfter: 'next UTC day' }, 429, origin);
    }
    if (ipN + cost > AI_RATE_PER_IP_HOUR) {
      return json({ error: `hourly AI call ceiling reached (${AI_RATE_PER_IP_HOUR} calls per IP). Try again next hour.`,
                    used: ipN, requested: cost, limit: AI_RATE_PER_IP_HOUR,
                    retryAfter: 'next UTC hour' }, 429, origin);
    }

    // Read-modify-write, so concurrent requests can undercount. KV is eventually
    // consistent and has no atomic increment; a small overshoot under burst is
    // accepted deliberately rather than pretending otherwise. TTLs are one bucket
    // plus slack so the keys expire themselves.
    await Promise.all([
      kv.put(dayKey, String(dayN + cost), { expirationTtl: 90_000 }),
      kv.put(ipKey,  String(ipN  + cost), { expirationTtl: 7_200 }),
    ]);
  } catch (e) {
    // A KV failure must not become a free pass. The secret already passed, so
    // proceed — but say so, because it means the ceilings are not being enforced.
    console.warn('[aiGuard] rate-limit bookkeeping failed, proceeding on secret alone:', e.message);
  }
  return null;
}

/* `Access-Control-Allow-Origin` echoes the caller's origin when it is allowlisted.
   It used to fall back to ALLOWED_ORIGINS[0] otherwise, which told an unallowed
   caller which origin IS allowed — pointless, since the browser blocks on the
   mismatch anyway. Now a disallowed origin simply gets no ACAO at all.
   `Vary: Origin` is required: without it a cache can serve one origin's ACAO to
   another. */
const cors = (origin = '') => ({
  ...(isAllowedOrigin(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
});

/* `charset=utf-8` is not decoration.
 *
 * Every string this Worker emits is UTF-8, and plenty of them carry en dashes,
 * em dashes, `·`, `≥` and `×` — the FOMC label "Jul 28–29" among them. Served as
 * bare `application/json`, the charset is unstated, and anything that falls back
 * to Latin-1 renders those three bytes (E2 80 93) as "â" instead of "–". That is
 * exactly the mojibake that was showing up in the econ-calendar notes.
 *
 * The bytes were always correct; only the declaration was missing. Fix it here,
 * at the one place every response is built — never by swapping the characters for
 * ASCII, which hides the fault and loses the typography. */
const JSON_CT = 'application/json; charset=utf-8';

const json = (data, status = 200, origin = '') =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': JSON_CT, ...cors(origin) },
  });

const err = (msg, status = 500, origin = '') => json({ error: msg }, status, origin);

/**
 * Provenance stamp attached to every payload that feeds a card badge.
 *
 * The UI badge is rendered FROM this object, never hand-written in markup. Two
 * badges had already drifted from their fetch layer — one card credited FINRA
 * without ever calling it, another was marked "Sample" while running on live
 * data — and a hand-written string cannot help drifting, because nothing ties
 * it to the code that fetches. A card that never called a source now has no way
 * to name it.
 *
 * `ttlSeconds` is how long this payload is meant to stay good — the cache TTL for
 * a cached endpoint, the refresh interval for a live one. The UI renders "as of
 * HH:MM" from `fetchedAt` and flips the badge amber once the age passes it, which
 * is the only thing separating a 15-minute-delayed quote from a 6-hour-old P/E
 * and a nightly Claude rating when all three sit in the same row.
 *
 * `delayed` says the *source* is not real-time (Yahoo's 15 minutes); staleness is
 * about our own copy. They are different failures and both need saying.
 */
const srcMeta = (source, {
  ok = true, delayed = false, note = null, asOf = null, ttlSeconds = null,
} = {}) => ({
  source, ok, delayed, note, asOf, ttlSeconds, fetchedAt: new Date().toISOString(),
});

/** The `?cached=1` answer when nothing has been banked yet: an explicitly empty
 *  payload the UI can render as "loading" rather than as "no results". */
const emptySnapshot = (source, ttlSeconds) => ({
  empty: true, ts: null,
  _meta: srcMeta(source, { ok: false, ttlSeconds, note: 'no snapshot banked yet — refreshing' }),
});

/* Delay/TTL constants, so a card and the handler feeding it cannot disagree. */
const YAHOO_DELAY_NOTE = '15-min delayed';
const TTL = {
  quote:    60,        // live-ish price; Yahoo itself is 15 min behind
  chart:    300,
  chain:    900,       // option quotes move, but not faster than the 15-min delay
  iv:       900,
  premium:  900,
  news:     900,
  fund:     6 * 3600,
  insider:  12 * 3600,
  short:    6 * 3600,
  thirteenF: 7 * 24 * 3600,
  econ:     12 * 3600,
  daily:    24 * 3600,
  sectors:  4 * 3600,
  scanner:  90,
  golden:   3600,
  ipos:     12 * 3600,
  earnings: 12 * 3600,
  track:    3600,
};

/* ── Yahoo Finance (no-auth) ── */
async function yahoo(path, search = '') {
  const url = `https://query2.finance.yahoo.com${path}${search}`;
  const r = await fetch(url, {
    headers: YAHOO_HEADERS,
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  return r.json();
}

/* ── Yahoo crumb authentication ── */
let _crumbCache = null;
let _crumbInflight = null; // dedup concurrent fetches

async function scanStream(response, regex, limitBytes = 150_000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (buf.length < limitBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const m = buf.match(regex);
      if (m) { reader.cancel().catch(() => {}); return m[1]; }
    }
  } catch (_) {}
  reader.cancel().catch(() => {});
  return null;
}

function extractCookie(rawSetCookie, ...names) {
  for (const name of names) {
    const m = rawSetCookie.match(new RegExp(`${name}=([^;,\\s]+)`));
    if (m) return `${name}=${m[1]}`;
  }
  return '';
}

async function getYahooCrumb(env) {
  const now = Date.now();
  const CRUMB_TTL = 3_000_000; // 50 minutes

  // Fast path — no await needed
  if (_crumbCache && _crumbCache.ts > now - CRUMB_TTL) return _crumbCache;

  // Dedup: if another concurrent call is already fetching, piggyback on it
  if (_crumbInflight) return _crumbInflight;

  _crumbInflight = (async () => {
    try {
      // KV cache
      try {
        const kv = await env?.REC_LOG?.get('yahoo:crumb', 'json');
        if (kv && kv.ts > Date.now() - CRUMB_TTL) { _crumbCache = kv; return _crumbCache; }
      } catch (_) {}

      let crumb = null;
      let cookie = '';

      // Strategy A: direct user-agent endpoint
      try {
        const r = await fetch('https://query2.finance.yahoo.com/v1/finance/user-agent', {
          headers: YAHOO_HEADERS,
        });
        if (r.ok) {
          cookie = extractCookie(r.headers.get('set-cookie') || '', 'A1', 'B');
          const txt = (await r.text()).trim();
          if (txt && txt.length < 50 && !txt.startsWith('<')) crumb = txt;
        }
      } catch (_) {}

      // Strategy B: scan finance.yahoo.com HTML stream
      if (!crumb) {
        try {
          const r = await fetch('https://finance.yahoo.com', {
            headers: { ...YAHOO_HEADERS, Accept: 'text/html' },
            redirect: 'follow',
          });
          cookie = extractCookie(r.headers.get('set-cookie') || '', 'A1', 'B') || cookie;
          crumb = await scanStream(r, /"crumb"\s*:\s*"([^"\\]{1,30})"/, 200_000);

          if (!crumb && cookie) {
            const r2 = await fetch('https://query2.finance.yahoo.com/v1/finance/user-agent', {
              headers: { ...YAHOO_HEADERS, Cookie: cookie },
            });
            if (r2.ok) {
              const txt = (await r2.text()).trim();
              if (txt && txt.length < 50 && !txt.startsWith('<')) crumb = txt;
            }
          }
        } catch (_) {}
      }

      if (!crumb) throw new Error('Yahoo crumb unavailable (all strategies exhausted)');

      _crumbCache = { crumb, cookie, ts: Date.now() };
      env?.REC_LOG?.put('yahoo:crumb', JSON.stringify(_crumbCache), { expirationTtl: 3600 }).catch(() => {});
      return _crumbCache;
    } finally {
      _crumbInflight = null;
    }
  })();

  return _crumbInflight;
}

async function yahooAuth(path, search, env) {
  const make = async (crumb, cookie) => {
    const sep = search.includes('?') ? '&' : '?';
    const url = `https://query2.finance.yahoo.com${path}${search}${sep}crumb=${encodeURIComponent(crumb)}`;
    const headers = { ...YAHOO_HEADERS };
    if (cookie) headers['Cookie'] = cookie;
    return fetch(url, { headers, cf: { cacheTtl: 30, cacheEverything: true } });
  };

  let { crumb, cookie } = await getYahooCrumb(env);
  let r = await make(crumb, cookie);

  if (r.status === 401 || r.status === 403) {
    _crumbCache = null;
    ({ crumb, cookie } = await getYahooCrumb(env));
    r = await make(crumb, cookie);
  }

  if (!r.ok) throw new Error(`Yahoo v10 ${r.status}`);
  return r.json();
}

function chartMetaToQuoteSummary(meta, ticker) {
  const p = (v) => (v != null ? { raw: v, fmt: String(v) } : undefined);
  return {
    price: {
      symbol:                     meta.symbol || ticker,
      longName:                   meta.longName || meta.shortName || '',
      shortName:                  meta.shortName || '',
      exchangeName:               meta.exchangeName || '',
      fullExchangeName:           meta.fullExchangeName || '',
      marketState:                meta.marketState || 'CLOSED',
      regularMarketPrice:         p(meta.regularMarketPrice),
      regularMarketPreviousClose: p(meta.chartPreviousClose),
      regularMarketVolume:        p(meta.regularMarketVolume),
      regularMarketDayHigh:       p(meta.regularMarketDayHigh),
      regularMarketDayLow:        p(meta.regularMarketDayLow),
    },
    summaryDetail: {
      fiftyTwoWeekHigh: p(meta.fiftyTwoWeekHigh),
      fiftyTwoWeekLow:  p(meta.fiftyTwoWeekLow),
    },
  };
}

/* ── Alpaca Market Data API ── */
async function alpacaFetch(path, env) {
  if (!env?.ALPACA_KEY || !env?.ALPACA_SECRET) throw new Error('Alpaca keys not configured');
  const r = await fetch(`https://data.alpaca.markets${path}`, {
    headers: {
      'APCA-API-KEY-ID':     env.ALPACA_KEY,
      'APCA-API-SECRET-KEY': env.ALPACA_SECRET,
      'Accept':              'application/json',
    },
    cf: { cacheTtl: 15, cacheEverything: true },
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => String(r.status));
    throw new Error(`Alpaca ${r.status}: ${txt.slice(0, 120)}`);
  }
  return r.json();
}

/* ── Computation helpers ── */
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += -d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

function computeSR(highs, lows) {
  const n = Math.min(20, highs.length);
  const support = Math.min(...lows.slice(-n));
  const resist  = Math.max(...highs.slice(-n));
  return {
    support: Math.round(support * 100) / 100,
    resist:  Math.round(resist  * 100) / 100,
  };
}

/* ── EMA cross analysis (golden / death cross) ───────────────────────────────
 * Seeded with the SMA of the first `period` closes, then smoothed forward.
 * Callers feed ~3y of daily closes: EMA200 needs a long runway before the seed
 * washes out. At 750 bars the seed carries ~0.4% weight, putting EMA200 within
 * ~0.01% of a fully-converged value — well inside the 5% proximity threshold.
 * ─────────────────────────────────────────────────────────────────────────── */
const EMA_CROSS_NEAR_PCT = 5;   // "about to cross" band, in % of the slower EMA
const EMA_CROSS_SLOPE_BARS = 5; // sessions used to measure EMA50 direction

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += values[i];
  ema /= period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/* Simple moving average series — plain rolling mean, no seed to wash out, so
 * SMA200 is exact from bar `period - 1` onward. */
function smaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/* Cross geometry for any fast/slow moving-average pair.
 * spread > 0 → fast above slow (golden cross in effect)
 * spread < 0 → fast below slow (death cross in effect) */
function crossStateFrom(sf, ss) {
  if (!sf || !ss) return null;
  const n = sf.length;
  const back = EMA_CROSS_SLOPE_BARS;
  const maFast = sf[n - 1], maSlow = ss[n - 1];
  const prevFast = sf[n - 1 - back], prevSlow = ss[n - 1 - back];
  if (!maFast || !maSlow || !prevFast || !prevSlow) return null;

  const r2 = v => Math.round(v * 100) / 100;
  const spread     = (maFast - maSlow) / maSlow * 100;
  const prevSpread = (prevFast - prevSlow) / prevSlow * 100;
  const gap        = Math.abs(spread);
  const fastSlope  = (maFast - prevFast) / prevFast * 100;

  // Projected sessions to the cross, from the recent rate of spread convergence.
  // Only meaningful while the spread is actually moving toward zero.
  const closingPerBar = (Math.abs(prevSpread) - gap) / back;
  const barsToCross = closingPerBar > 0.0001 ? Math.round(gap / closingPerBar) : null;

  const near   = gap <= EMA_CROSS_NEAR_PCT;
  const golden = spread > 0;

  return {
    fast:   r2(maFast),
    slow:   r2(maSlow),
    spread: r2(spread),
    gap:    r2(gap),
    slope:  Math.round(fastSlope * 1000) / 1000,
    // Signed move in the spread over the slope window. Sign matches `spread`
    // when the formation is strengthening and opposes it when it is decaying.
    spreadChg: Math.round((spread - prevSpread) * 1000) / 1000,
    barsToCross: barsToCross != null && barsToCross <= 400 ? barsToCross : null,
    // Approaching a golden cross: below, rising, and inside the band.
    goldenSetup: !golden && fastSlope > 0 && near,
    // Approaching a death cross: above, falling, and inside the band.
    deathSetup:   golden && fastSlope < 0 && near,
    near,
  };
}

/* Returns null when history is too short to trust EMA200. */
function emaCrossState(closes, fast = 50, slow = 200) {
  const vals = (closes || []).filter(v => v != null && isFinite(v));
  // Require real smoothing runway past the EMA200 seed, not just `slow` bars.
  if (vals.length < slow + 250) return null;

  const st = crossStateFrom(emaSeries(vals, fast), emaSeries(vals, slow));
  if (!st) return null;
  const { fast: f, slow: s, ...rest } = st;
  return { ema50: f, ema200: s, ...rest };
}

/* SMA counterpart. Needs only `slow` bars plus the slope lookback — a rolling
 * mean has no seed weight to dilute — so it resolves on histories where
 * emaCrossState() still returns null. */
function smaCrossState(closes, fast = 50, slow = 200) {
  const vals = (closes || []).filter(v => v != null && isFinite(v));
  if (vals.length < slow + EMA_CROSS_SLOPE_BARS) return null;

  const st = crossStateFrom(smaSeries(vals, fast), smaSeries(vals, slow));
  if (!st) return null;
  const { fast: f, slow: s, ...rest } = st;
  return { sma50: f, sma200: s, ...rest };
}

/* Yahoo v7 spark: close-only series for many symbols per request (max 20).
 * Far cheaper than one v8 chart call per symbol. Returns Map<symbol, closes[]>.
 * Unknown/delisted symbols are simply absent from the response. */
async function yahooSparkCloses(symbols, range = '3y', concurrency = 4, { withTimestamps = false } = {}) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 20) chunks.push(symbols.slice(i, i + 20));

  for (let i = 0; i < chunks.length; i += concurrency) {
    await Promise.allSettled(chunks.slice(i, i + concurrency).map(async (chunk) => {
      const url = `https://query1.finance.yahoo.com/v7/finance/spark`
                + `?symbols=${chunk.map(encodeURIComponent).join(',')}&range=${range}&interval=1d`;
      const r = await fetch(url, { headers: YAHOO_HEADERS });
      if (!r.ok) throw new Error(`spark ${r.status}`);
      const d = await r.json();
      for (const item of (d?.spark?.result || [])) {
        const closes = item?.response?.[0]?.indicators?.quote?.[0]?.close;
        if (!Array.isArray(closes)) continue;
        // Keep only the numbers — the raw response is dropped on the next tick.
        const clean = closes.filter(v => v != null);
        if (!withTimestamps) { out.set(item.symbol, clean); continue; }

        /* OPT-IN ONLY. The default return shape stays a bare close array because
           two existing callers (the golden-cross sweep and the watchlist batch)
           index it directly. The move-series sweep needs dates: it stores
           `asOfClose` and skips a symbol whose stored series already ends on the
           latest close, and neither is expressible from closes alone.
           Timestamps are filtered on the SAME predicate as the closes so the two
           arrays stay aligned; if they cannot be aligned, null rather than a
           silently mismatched pairing. */
        const ts = item?.response?.[0]?.timestamp;
        let stamps = null;
        if (Array.isArray(ts) && ts.length === closes.length) {
          stamps = [];
          for (let k = 0; k < closes.length; k++) if (closes[k] != null) stamps.push(ts[k]);
          if (stamps.length !== clean.length) stamps = null;
        }
        out.set(item.symbol, { closes: clean, timestamps: stamps });
      }
    }));
  }
  return out;
}

/* ── Worker-side Claude call ──
   Retries transient failures (429 rate limit, 5xx overload) with backoff.
   A single un-retried hiccup during the 6am cron used to wipe out the daily
   briefing, sector intelligence, and watchlist signals for the whole day. */
async function workerClaude(prompt, env, maxTokens = 400, schema = null) {
  if (!env?.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const MAX_ATTEMPTS = 4;
  let lastErr = 'unknown';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      CLAUDE_MODEL,
          max_tokens: maxTokens + CLAUDE_THINKING_HEADROOM,
          messages:   [{ role: 'user', content: prompt }],
          ...CLAUDE_REASONING,
          // A schema makes malformed JSON ungenerable. Prefer it over asking for
          // JSON in the prompt and hoping the escaping holds.
          ...(schema ? {
            output_config: {
              ...CLAUDE_REASONING.output_config,
              format: { type: 'json_schema', schema },
            },
          } : {}),
        }),
      });
    } catch (e) {
      // Network-level failure — retry
      lastErr = `network ${e.message}`;
      if (attempt < MAX_ATTEMPTS) { await sleep(backoffMs(attempt)); continue; }
      throw new Error(`Claude ${lastErr}`);
    }

    if (r.ok) {
      return claudeText(await r.json());
    }

    // Retry only transient statuses; fail fast on 4xx client errors (bad key, bad request)
    const retryable = r.status === 429 || r.status >= 500;
    const detail = await r.text().catch(() => '');
    lastErr = `${r.status}${detail ? ' ' + detail.slice(0, 200) : ''}`;
    if (retryable && attempt < MAX_ATTEMPTS) {
      await sleep(backoffMs(attempt));
      continue;
    }
    throw new Error(`Claude ${lastErr}`);
  }
  throw new Error(`Claude ${lastErr}`);
}

const sleep = ms => new Promise(res => setTimeout(res, ms));
// 0.8s, 2s, 5s (+ jitter) — keeps total wait well under cron/subrequest limits
const backoffMs = attempt => Math.min(5000, 800 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 300);

/* ── Existing route handlers ── */

async function handleQuote(ticker, origin, env) {
  const modules = [
    'price', 'summaryDetail', 'defaultKeyStatistics', 'financialData',
    'calendarEvents', 'recommendationTrend', 'upgradeDowngradeHistory',
    'assetProfile', 'insiderTransactions', 'netSharePurchaseActivity',
  ].join(',');

  const [yahooRes, chartRes, alpacaRes] = await Promise.allSettled([
    yahooAuth(`/v10/finance/quoteSummary/${ticker}`, `?modules=${modules}`, env),
    yahoo(`/v8/finance/chart/${ticker}`, '?range=1d&interval=1d'),
    alpacaFetch(`/v2/stocks/${ticker}/snapshot`, env),
  ]);

  let data;

  if (yahooRes.status === 'fulfilled') {
    data = yahooRes.value;
  } else {
    console.error(`[quote] Yahoo v10 failed (${yahooRes.reason?.message}); using chart meta fallback`);
    const chartMeta = chartRes.status === 'fulfilled'
      ? (chartRes.value?.chart?.result?.[0]?.meta || {})
      : {};
    data = {
      quoteSummary: {
        result: [chartMetaToQuoteSummary(chartMeta, ticker)],
        error:  null,
      },
    };
  }

  if (alpacaRes.status === 'fulfilled') {
    const snap   = alpacaRes.value;
    const result = data.quoteSummary?.result?.[0];
    if (result) {
      if (!result.price) result.price = {};
      const lp  = snap.latestTrade?.p ?? snap.dailyBar?.c;
      const pc  = snap.prevDailyBar?.c;
      const vol = snap.dailyBar?.v;
      const p   = (v) => v != null ? { raw: v, fmt: v.toFixed(2) } : undefined;
      if (lp  != null) result.price.regularMarketPrice        = p(lp);
      if (pc  != null) result.price.regularMarketPreviousClose = p(pc);
      if (vol != null) result.price.regularMarketVolume        = { raw: vol, fmt: String(vol) };
      result.price.symbol = result.price.symbol || ticker;

      if (!result.price.marketState || result.price.marketState === 'CLOSED') {
        const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const t    = et.getHours() * 100 + et.getMinutes();
        const open = et.getDay() > 0 && et.getDay() < 6 && t >= 930 && t < 1600;
        result.price.marketState = open ? 'REGULAR' : 'CLOSED';
      }
    }
  }

  // Alpaca is a real-time feed; Yahoo is 15 minutes behind. The badge has to be
  // able to tell them apart, because on the page they land in the same field.
  const priced = alpacaRes.status === 'fulfilled';
  data._meta = srcMeta(priced ? 'Alpaca + Yahoo Finance' : 'Yahoo Finance', {
    ok: yahooRes.status === 'fulfilled' || chartRes.status === 'fulfilled',
    delayed: !priced,
    ttlSeconds: TTL.quote,
    note: priced ? 'price real-time · fundamentals 15-min delayed' : YAHOO_DELAY_NOTE,
  });
  return json(data, 200, origin);
}

async function handleChart(ticker, params, origin) {
  const range    = params.get('range')    || '1y';
  const interval = params.get('interval') || '1d';
  const data = await yahoo(
    `/v8/finance/chart/${ticker}`,
    `?range=${range}&interval=${interval}&includePrePost=false`,
  );
  data._meta = srcMeta('Yahoo Finance', {
    delayed: true, ttlSeconds: TTL.chart, note: `${range}/${interval} · ${YAHOO_DELAY_NOTE}`,
  });
  return json(data, 200, origin);
}

async function handleOptions(ticker, params, origin, env) {
  const date   = params.get('date');
  const search = date ? `?date=${date}` : '';
  try {
    const data = await yahooAuth(`/v7/finance/options/${ticker}`, search, env);
    data._meta = srcMeta('Yahoo options chain', {
      delayed: true, ttlSeconds: TTL.chain, note: YAHOO_DELAY_NOTE,
    });
    return json(data, 200, origin);
  } catch (e) {
    // Ticker may have no listed options — return empty chain instead of 500
    return json({
      optionChain: { result: [], error: e.message },
      _meta: srcMeta('Yahoo options chain', { ok: false, ttlSeconds: TTL.chain, note: e.message }),
    }, 200, origin);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   PREMIUM-SELLING SCREEN  (/api/premium)

   Replaces the old options recap, which surfaced the nearest expiration filtered
   to volume/OI ≥ 2×. That view answers "what traded today", and at the nearest
   expiration the answer is mostly 0DTE and expiry-week churn — the wrong
   question for anyone selling 20–45 DTE premium against earnings dates.

   What this returns per ticker: where implied vol sits relative to its own
   history, what the chain implies the stock can move by front expiry, when
   earnings lands relative to that, and the strikes a premium seller would
   actually consider — at a real delta, computed here, with the bid actually
   quoted against them.

   Two candidate expiries, because they answer different questions:
     • `clean`  — first monthly ≥ PREM_MIN_DTE with no earnings inside it. Vol
                  decay with no event risk.
     • `post`   — first monthly expiring after the earnings date. This one holds
                  the print, so it carries the crush and the gap risk together.
   When earnings falls before the first monthly ≥ 21 DTE the two collapse into
   one expiry, and the row says so rather than printing a duplicate.
   ══════════════════════════════════════════════════════════════════════════ */

const PREM_MIN_DTE     = 21;             // "20–45 DTE": first monthly at least this far out
const PREM_TARGETS     = [0.30, 0.16];   // the two short-strike deltas this screen selects

/* ── IV outlier guard — SHARED by the premium and long screens ───────────────
   Yahoo quotes an implausible implied vol on deep, untraded strikes, and it
   corrupts strike SELECTION rather than just one displayed number. Delta is
   monotonic in sigma for an OTM option, so an inflated quote drags a strike's
   apparent delta up toward 0.5 — and both screens pick strikes BY delta.

   Found on the long screen (AAPL 2026-09-18 420 put: IV 195.72% against a
   24.54% ATM, open interest 0, delta 0.544, which beat the genuine
   near-the-money put for the 0.55 target). The premium screen selects from the
   same chains with the same delta arithmetic and had NO such guard. It has not
   been observed picking one — its 0.30/0.16 targets sit away from the ~0.5
   region where inflated quotes cluster — but it is plainly reachable, and a
   bogus premium candidate is a trade you might place rather than a row you
   might squint at. Measured on a real AAPL chain (spot 313.33, 41 DTE, ATM 24%):

     strike 400 (27.7% OTM)  true delta 0.0017  ·  at 4x IV reads 0.280  -> wins 0.30
     strike 470 (50.0% OTM)  true delta 0.0000  ·  at 4x IV reads 0.139  -> wins 0.16

   So the guard lives here, above both callers, and both pass their expiry's own
   ATM IV. RESIDUAL, stated because it is not fixed: a 2-3x inflated quote still
   wins a target and is NOT excluded, because 2-3x is inside genuine skew on far
   strikes and excluding it would drop real candidates. This catches broken
   quotes, not merely optimistic ones.

   This is NOT the banned "fill a missing IV from ATM" (rule §7 on the long
   screen): nothing is substituted, the strike is dropped from SELECTION only,
   and the count plus the worst value are reported on the card. */
const IV_OUTLIER_MULT = 4;

/** True when a strike's IV is close enough to its expiry's ATM IV to be trusted
 *  for selection. `atmIv` and `iv` are both DECIMALS. A null/absent ATM IV
 *  disables the guard rather than rejecting everything — no reference, no verdict. */
function ivPlausible(iv, atmIv) {
  if (!Number.isFinite(iv) || iv <= 0) return false;
  if (!Number.isFinite(atmIv) || atmIv <= 0) return true;
  return iv <= atmIv * IV_OUTLIER_MULT && iv >= atmIv / IV_OUTLIER_MULT;
}

/** Shared reporting line for excluded strikes, so both screens word it identically.
 *
 *  The band is two-sided and the note has to say WHICH side. An earlier version
 *  reported only `max(iv)` as "worst", which rendered "(worst: 0%)" whenever the
 *  exclusions were all near-zero quotes — a number that reads like a bug rather
 *  than like the low-side rejection it actually describes. */
function ivOutlierNote(rejects, atmIvPct) {
  const uniq = [...new Map(rejects.map(r => [`${r.type}:${r.strike}`, r])).values()];
  if (!uniq.length) return null;
  const lo = atmIvPct / IV_OUTLIER_MULT, hi = atmIvPct * IV_OUTLIER_MULT;
  const above = uniq.filter(r => r.iv > hi), below = uniq.filter(r => r.iv < lo);
  const parts = [];
  if (above.length) parts.push(`${above.length} above (highest ${Math.max(...above.map(r => r.iv)).toFixed(1)}%)`);
  if (below.length) parts.push(`${below.length} below (lowest ${Math.min(...below.map(r => r.iv)).toFixed(2)}%)`);
  return {
    count: uniq.length,
    note: `${uniq.length} strike${uniq.length === 1 ? '' : 's'} excluded from selection for quoting an implied `
        + `vol outside ${lo.toFixed(1)}%–${hi.toFixed(1)}% (${IV_OUTLIER_MULT}× either side of this expiry's `
        + `ATM IV of ${atmIvPct.toFixed(1)}%): ${parts.join(', ')}. Nothing was substituted for them.`,
  };
}
const PREM_MAX_SYMBOLS = 60;
const PREM_SCHEMA      = 2;              // bump when the row shape changes, to retire cached rows

/* ── Subrequest budget: why this is on-demand ────────────────────────────────
   MEASURED, not estimated: one ticker costs ~4.8 outbound fetches — 1 expiry
   list, 1 quoteSummary for the earnings date, and ~2.8 dated expiry chains
   (front, back, clean monthly, post-earnings monthly, minus whatever dedupes).
   A 6-ticker probe came to 30 fetches: 6 base + 6 quoteSummary + 17 dated + 1
   spark.

   This account is on **Workers Paid: 10,000 subrequests per invocation**, one
   pool covering external fetches AND KV binding calls. A 22-name watchlist at
   ~110 fetches would now fit — and it is still NOT done, because the cap was
   never the real constraint. **Yahoo crumb rate-limiting is**, and 22 concurrent
   invocations against Yahoo get throttled regardless of plan tier. The screen is
   also used one or two names at a time, so the fan-out solved a problem nobody
   had. Do not restore it on the strength of the higher ceiling.

   (Under the Free plan's 50 this was a hard impossibility rather than a choice,
   and the cap is per *invocation*, not per chunk, so no internal chunking helped.)

   There was briefly a KV queue drained across cron firings to work around that.
   It is gone: the screen is used one or two names at a time when deciding what
   to sell, so fetching all 22 daily was solving a problem nobody had, at the
   cost of a queue, a cursor, a seed step and a share of every cron firing.
   Expanding a row fetches that row. Nothing else fetches anything.

   Rows are cached PREMIUM_FRESH_MS (4h) and KEPT longer than that on purpose:
   if KV evicted at exactly the freshness horizon there would be nothing left to
   render as stale, and "stale" is the honest state for a 5-hour-old chain — more
   useful than a blank row. Past the freshness window the cached row still shows,
   badged stale, and revalidates behind itself. */
const PREMIUM_FRESH_MS = 4 * 3600_000;    // "fresh" horizon — drives the stale badge
const PREMIUM_ROW_TTL  = 24 * 3600;       // KV retention — outlives freshness so stale can render

/* Row status, so the UI can tell three different failures apart. They used to
   render identically as dim red, which conflated "we have not looked yet" with
   "this name has no tradeable options" — the second is a real finding about a
   ticker, the first is a fact about our own scheduler.
     ok          — row computed
     no-options  — ticker has no listed options at all
     no-iv       — options exist but the front expiry quotes no usable IV
                   (thin names: the chain is listed but nothing is priced)
     error       — the fetch itself failed; transient, worth retrying
   `pending` is never stored: it is what the batch endpoint reports for a ticker
   with no KV row yet. */

/** Premium-selling gate.
 *
 *  `sellable` used to be `ivRank != null && ivRank * 100 >= IVR_SELL_MIN`, which
 *  treats a null rank as a FAIL. IV rank is null until 60 days of history exist,
 *  so that dimmed every row on the tab for the entire collection window — three
 *  months of a screen that renders as if nothing were worth selling.
 *
 *  The proxy was already computed and already drove the regime chip; the gate
 *  simply never consulted it. It does now. `RATIO_SELL_MIN` of 1.0 is the proxy
 *  analogue of "at or above the median": implied vol is pricing at least as much
 *  movement as the stock has actually realised. It is a coarser instrument than a
 *  percentile and is labelled a proxy everywhere it surfaces.
 *
 *  Three outcomes, not two — `null` means "no basis to judge", which is neither
 *  a pass nor a fail and must not render as unattractive. */
const RATIO_SELL_MIN = 1.0;

function sellableFrom(ivRank, ivHvRatio, historyDays) {
  if (ivRank != null) {
    const pts = ivRank * 100;
    const ok  = pts >= IVR_SELL_MIN;
    return {
      sellable: ok, basis: 'rank',
      reason: ok
        ? `IV rank ${pts.toFixed(0)} is at or above the ${IVR_SELL_MIN} floor for selling premium`
        : `IV rank ${pts.toFixed(0)} is below the ${IVR_SELL_MIN} floor for selling premium`,
    };
  }
  if (ivHvRatio != null) {
    const ok = ivHvRatio >= RATIO_SELL_MIN;
    return {
      sellable: ok, basis: 'proxy',
      reason: `IV rank still collecting (${historyDays}/${IV_RANK_MIN_DAYS}d needed) — gating on the `
            + `IV/HV30 proxy instead: ${ivHvRatio.toFixed(2)}× is ${ok ? 'at or above' : 'below'} `
            + `${RATIO_SELL_MIN.toFixed(2)}×, meaning implied vol is pricing ${ok ? 'more' : 'less'} `
            + `movement than this name has actually realised. A proxy, not a percentile.`,
    };
  }
  return {
    sellable: null, basis: 'none',
    reason: 'No IV rank yet and no IV/HV30 proxy either — there is no basis to judge whether '
          + 'premium is rich here, so the row is neither recommended nor dismissed.',
  };
}

/** Next *scheduled* earnings date as ISO, or null.
 *  Same field the watchlist's Earnings column reads, deliberately — two tabs
 *  quoting different earnings dates for one ticker is a bug the user would find
 *  before we did. Yahoo sometimes leaves a past report in here, so anything not
 *  in the future is discarded rather than shown as upcoming. */
function nextEarningsIso(qsResult) {
  const raw = qsResult?.calendarEvents?.earnings?.earningsDate?.[0]?.raw;
  if (!Number.isFinite(raw)) return null;
  const iso = new Date(raw * 1000).toISOString().slice(0, 10);
  return iso >= etToday() ? iso : null;
}

/**
 * IV rank from a stored history. Factored out so `/api/iv` and `/api/premium`
 * cannot drift into two different definitions of the same number.
 * Below IV_RANK_MIN_DAYS the rank is null and carries a reason — never a
 * percentile of HV standing in for it.
 */
function ivRankFrom(history, currentIv) {
  const historyDays = history.length;
  if (historyDays < IV_RANK_MIN_DAYS) {
    return {
      ivRank: null, historyDays,
      rankReason: `collecting — ${historyDays}/${IV_RANK_TARGET_DAYS}d (rank needs ${IV_RANK_MIN_DAYS})`,
    };
  }
  const min = Math.min(...history), max = Math.max(...history);
  return {
    ivRank: max === min ? 0 : +((currentIv - min) / (max - min)).toFixed(4),
    historyDays, rankReason: null,
  };
}

/**
 * The 0.30- and 0.16-delta put and call for one expiry.
 *
 * Only OTM strikes are considered: a short strike for premium selling is OTM by
 * definition, and without that filter a sparse chain can hand back an ITM strike
 * whose |delta| happens to sit nearer the target.
 *
 * ROC uses the cash-secured denominator the screen is specified on —
 * credit / (strike × 100 − credit) — for both sides. On the put that is literal
 * collateral. On the call it is the equivalent naked-margin basis, not the cost
 * of the shares in a covered call; the card says so, because the same number
 * under two different capital bases would not be comparable.
 */
function pickCandidates(chainExp, spot, rate, expUnix, { atmIv = null, rejects = null } = {}) {
  const dte = dteOf(expUnix);
  if (!(dte > 0) || !Number.isFinite(spot) || !Number.isFinite(rate)) return [];
  const tYears = dte / 365;

  const build = (list, type) => (list || [])
    .filter((o) => {
      if (!Number.isFinite(o?.strike)) return false;
      if (!Number.isFinite(o?.impliedVolatility) || o.impliedVolatility <= 0) return false;
      // Selection guard, shared with the long screen. Delta is monotonic in
      // sigma for an OTM option, so a broken IV quote inflates a far strike's
      // apparent delta into the target band and displaces the real strike.
      if (!ivPlausible(o.impliedVolatility, atmIv)) {
        if (rejects) rejects.push({ strike: o.strike, type, iv: +(o.impliedVolatility * 100).toFixed(2) });
        return false;
      }
      return type === 'call' ? o.strike >= spot : o.strike <= spot;
    })
    .map((o) => {
      const delta = bsDelta({ spot, strike: o.strike, tYears, vol: o.impliedVolatility, rate, type });
      if (delta == null) return null;
      // Credit is the bid, not the mid: it is what a seller can actually hit.
      const bid    = Number.isFinite(o.bid) && o.bid > 0 ? o.bid : null;
      const credit = bid == null ? null : +(bid * 100).toFixed(2);
      const collateral = o.strike * 100;
      const roc  = credit == null || collateral <= credit ? null : credit / (collateral - credit);
      const aroc = roc == null ? null : roc * 365 / dte;
      return {
        type: type.toUpperCase(),
        strike: o.strike,
        delta: +delta.toFixed(4),
        // Single short strike, so POP is exactly the case 1 − |Δ| describes.
        // Delta-derived under a lognormal assumption, not a measured frequency —
        // the card says so.
        pop: +(1 - Math.abs(delta)).toFixed(4),
        iv: +(o.impliedVolatility * 100).toFixed(2),
        bid, credit,
        openInterest: o.openInterest ?? null,
        volume: o.volume ?? null,
        roc:  roc  == null ? null : +roc.toFixed(6),
        aroc: aroc == null ? null : +aroc.toFixed(6),
        otmPct: +(Math.abs(o.strike / spot - 1) * 100).toFixed(2),
      };
    })
    .filter(Boolean);

  const calls = build(chainExp?.calls, 'call');
  const puts  = build(chainExp?.puts,  'put');
  const nearest = (arr, target) => arr.reduce((best, o) =>
    best == null || Math.abs(Math.abs(o.delta) - target) < Math.abs(Math.abs(best.delta) - target)
      ? o : best, null);

  const out  = [];
  const seen = new Set();
  for (const target of PREM_TARGETS) {
    for (const arr of [puts, calls]) {
      const hit = nearest(arr, target);
      if (!hit) continue;
      const id = `${hit.type}:${hit.strike}`;
      // A chain too sparse to offer distinct 0.30 and 0.16 strikes would otherwise
      // print the same contract twice and read as a rendering bug.
      if (seen.has(id)) { out.find(c => `${c.type}:${c.strike}` === id).sparse = true; continue; }
      seen.add(id);
      out.push({ ...hit, targetDelta: target, sparse: false });
    }
  }
  return out;
}

/** One screen row. Never throws — a failed ticker reports why and the sweep continues.
 *  `status` distinguishes a transient fetch error from a genuine finding about the
 *  ticker; see the status taxonomy above. */
async function premiumRow(sym, rate, hv30, env) {
  const fail = (status, reason) => ({
    symbol: sym, ok: false, status, reason, legs: [], bestAroc: null,
    schema: PREM_SCHEMA, ts: Date.now(),
  });

  let base;
  try {
    base = await yahooAuth(`/v7/finance/options/${encodeURIComponent(sym)}`, '', env);
  } catch (e) { return fail('error', `options chain fetch failed: ${e.message}`); }

  const res  = base?.optionChain?.result?.[0];
  const spot = res?.quote?.regularMarketPrice;
  const exps = (res?.expirationDates || []).slice().sort((a, b) => a - b);
  if (!res || !Number.isFinite(spot) || !exps.length) {
    return fail('no-options', 'no listed options for this ticker');
  }

  // Earnings is a separate module; a failure here costs the earnings flag and the
  // post-earnings leg, not the whole row.
  let earnIso = null, earnErr = null;
  try {
    const qs = await yahooAuth(
      `/v10/finance/quoteSummary/${encodeURIComponent(sym)}`, '?modules=calendarEvents', env);
    earnIso = nextEarningsIso(qs?.quoteSummary?.result?.[0]);
  } catch (e) { earnErr = e.message; }

  // The base response already carries one expiry's strikes — reuse it when it matches.
  const loaded = new Map();
  if (res.options?.[0]?.expirationDate) loaded.set(res.options[0].expirationDate, res.options[0]);
  const chainFor = async (exp) => {
    if (exp == null) return null;
    if (loaded.has(exp)) return loaded.get(exp);
    try {
      const d = await yahooAuth(
        `/v7/finance/options/${encodeURIComponent(sym)}`, `?date=${exp}`, env);
      const c = d?.optionChain?.result?.[0]?.options?.[0] || null;
      if (c) loaded.set(exp, c);
      return c;
    } catch (_) { return null; }
  };

  // Front/back match /api/iv exactly, so the two endpoints cannot disagree about
  // this ticker's term structure.
  const frontExp = exps.find(e => dteOf(e) >= IV_MIN_DTE) ?? exps[exps.length - 1];
  const backExp  = exps.find(e => e > frontExp && isMonthlyExpiry(e)) ?? null;

  const monthlies = exps.filter(isMonthlyExpiry);
  // earnIso is already known to be today or later, so "inside this expiry" is
  // just "on or before the expiration date".
  const holdsEarnings = e => earnIso != null && earnIso <= expiryIso(e);
  const cleanExp = monthlies.find(e => dteOf(e) >= PREM_MIN_DTE && !holdsEarnings(e)) ?? null;
  const postExp  = earnIso ? (monthlies.find(e => expiryIso(e) > earnIso) ?? null) : null;

  // Sequential: chainFor dedupes through `loaded`, which concurrent calls would defeat.
  const frontChain = await chainFor(frontExp);
  const backChain  = await chainFor(backExp);
  const cleanChain = await chainFor(cleanExp);
  const postChain  = await chainFor(postExp);

  const frontIv = frontChain ? atmIvFor(frontChain, spot) : null;
  const backIv  = backChain  ? atmIvFor(backChain,  spot) : null;
  // A real finding, not a failure of ours: the chain is listed but nothing on the
  // front expiry is priced. Thin names sit here permanently.
  if (!frontIv) {
    return fail('no-iv',
      `options are listed but the front expiry (${expiryIso(frontExp)}, ${dteOf(frontExp)}d) quotes `
      + 'no usable implied vol — too thin to price');
  }

  const frontDte = dteOf(frontExp);
  const snap = {
    spot: +spot.toFixed(4),
    front: { expiry: expiryIso(frontExp), dte: frontDte, atmIv: frontIv.atmIv, strike: frontIv.strike },
    back: backIv
      ? { expiry: expiryIso(backExp), dte: dteOf(backExp), atmIv: backIv.atmIv, strike: backIv.strike }
      : null,
  };

  // Bank the reading before ranking, so today sits inside its own window. This
  // screen sweeping the whole watchlist is now a second collector for the history
  // that IV rank — the thing gating this entire tab — is waiting on.
  try { await recordIvSample(sym, snap, env); }
  catch (e) { console.warn(`[premium] ${sym} iv sample write failed:`, e.message); }

  const history = await ivHistory(sym, env).catch(() => []);
  const { ivRank, historyDays, rankReason } = ivRankFrom(history, frontIv.atmIv);

  const ivHvRatio = Number.isFinite(hv30) && hv30 > 0 ? +(frontIv.atmIv / hv30).toFixed(3) : null;
  const regime = volRegime({ ivRank, ivHvRatio, historyDays, rankTargetDays: IV_RANK_TARGET_DAYS });

  // Expected move through front expiry: spot × IV × √(dte/365), the one-sigma
  // move the chain is pricing. IV is carried in percent here, hence the /100.
  const emPct     = (frontIv.atmIv / 100) * Math.sqrt(frontDte / 365) * 100;
  const emDollars = spot * emPct / 100;

  const termStructure = (frontIv && backIv) ? +(frontIv.atmIv - backIv.atmIv).toFixed(2) : null;

  const legFor = (exp, chain, kind) => {
    if (exp == null) return null;
    if (!chain) return { kind, expiry: expiryIso(exp), dte: dteOf(exp), holdsEarnings: holdsEarnings(exp),
                         candidates: [], reason: 'expiry chain did not load' };
    // This leg's OWN ATM IV is the reference for the outlier guard — not the
    // row's front-expiry IV, which would be the wrong comparator for a 104-day
    // post-earnings leg.
    const legAtm = atmIvFor(chain, spot);
    const rejects = [];
    const leg = {
      kind, expiry: expiryIso(exp), dte: dteOf(exp),
      holdsEarnings: holdsEarnings(exp),
      candidates: Number.isFinite(rate)
        ? pickCandidates(chain, spot, rate, exp, { atmIv: legAtm ? legAtm.atmIv / 100 : null, rejects })
        : [],
      reason: Number.isFinite(rate) ? null : 'no risk-free rate — deltas suppressed',
    };
    const out = legAtm ? ivOutlierNote(rejects, legAtm.atmIv) : null;
    if (out) { leg.ivOutliers = out.count; leg.ivOutlierNote = out.note; }
    return leg;
  };

  const legs = [];
  if (cleanExp != null && cleanExp === postExp) {
    // Earnings already sits before the first monthly ≥ 21 DTE, so one expiry is
    // both the clean one and the first one after the print.
    const leg = legFor(cleanExp, cleanChain, 'clean+post');
    if (leg) legs.push(leg);
  } else {
    const a = legFor(cleanExp, cleanChain, 'clean');
    const b = legFor(postExp,  postChain,  'post');
    if (a) legs.push(a);
    if (b) legs.push(b);
  }

  // A missing clean leg is a finding, not a gap: when the next print lands inside
  // 21 DTE, every monthly from here spans it and there is no earnings-free expiry
  // to sell. Absent rows read as missing data, so the row says which it is.
  const cleanMissing = cleanExp == null
    ? (earnIso
        ? `no earnings-free monthly ≥ ${PREM_MIN_DTE} DTE — the ${isoLabel(earnIso)} print falls inside every one`
        : `no monthly expiry ≥ ${PREM_MIN_DTE} DTE is listed`)
    : null;

  const allCands = legs.flatMap(l => l.candidates);
  const arocs    = allCands.map(c => c.aroc).filter(Number.isFinite);
  const bestAroc = arocs.length ? Math.max(...arocs) : null;

  const gate = sellableFrom(ivRank, ivHvRatio, historyDays);

  return {
    symbol: sym,
    ok: true,
    status: 'ok',
    schema: PREM_SCHEMA,
    ts: Date.now(),
    spot: +spot.toFixed(2),
    front: snap.front,
    back:  snap.back,
    termStructure,
    // Front IV richer than back = backwardation, the earnings-crush setup. The
    // sign convention is stated on the card: with termStructure = front − back
    // that condition is POSITIVE, which is the opposite of how it is often said
    // aloud ("negative term structure").
    backwardation: termStructure != null && termStructure > 0,
    expectedMove: {
      pct: +emPct.toFixed(2),
      dollars: +emDollars.toFixed(2),
      dte: frontDte,
      expiry: expiryIso(frontExp),
    },
    earnings: earnIso
      ? {
          iso: earnIso,
          daysAway: Math.round((Date.parse(earnIso + 'T00:00:00Z') - Date.parse(etToday() + 'T00:00:00Z')) / 86_400_000),
          insideFront: earnIso <= expiryIso(frontExp),
          source: 'Yahoo calendarEvents',
        }
      : { iso: null, reason: earnErr ? `earnings lookup failed: ${earnErr}` : 'no scheduled earnings date from Yahoo' },
    hv30: Number.isFinite(hv30) ? hv30 : null,
    ivHvRatio,
    ivRank, historyDays, rankReason,
    rankTargetDays: IV_RANK_TARGET_DAYS,
    regime,
    // Dimmed, never hidden: a low-IV name should look unattractive rather than
    // vanish, so the absence of candidates is visibly a judgement and not a gap.
    // `sellable` is tri-state — null means there is no basis to judge, which is
    // not the same as failing the gate and must not render as unattractive.
    sellable:     gate.sellable,
    sellableBasis: gate.basis,      // 'rank' | 'proxy' | 'none'
    sellableReason: gate.reason,    // shown on hover, and it names the actual number
    legs,
    cleanMissing,
    bestAroc,
    daysToEarnings: earnIso
      ? Math.round((Date.parse(earnIso + 'T00:00:00Z') - Date.parse(etToday() + 'T00:00:00Z')) / 86_400_000)
      : null,
  };
}

/* ── Per-ticker KV storage ───────────────────────────────────────────────────
   One key per ticker, so the batch endpoint is a pure KV read and the refresh
   path can be sliced across invocations. The old combined key
   (`premium:{SORTED,SYMBOL,LIST}`) is gone: it made the cache a function of
   which tickers you happened to ask for together, so adding one name to the
   watchlist invalidated the whole screen. */
const premiumKey = sym => `premium:${sym.toUpperCase()}`;

async function storePremiumRow(row, env) {
  try {
    await env?.REC_LOG?.put(premiumKey(row.symbol), JSON.stringify(row), { expirationTtl: PREMIUM_ROW_TTL });
  } catch (e) { console.warn(`[premium] ${row.symbol} KV write failed:`, e.message); }
}

async function readPremiumRow(sym, env) {
  try {
    const row = await env?.REC_LOG?.get(premiumKey(sym), 'json');
    // A row written under an older shape renders as blanks rather than failing
    // loudly, so retire it and let the caller report it as pending.
    return row && row.schema === PREM_SCHEMA ? row : null;
  } catch (_) { return null; }
}

/** Refresh exactly one ticker and bank it. ~5 subrequests — safe anywhere. */
async function refreshPremiumTicker(sym, env, shared = null) {
  const rate = shared?.rate ?? (await riskFreeRate(env));
  let hv30 = shared?.hv?.get(sym);
  if (hv30 === undefined) {
    try {
      const closes = await yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}`, '?range=3mo&interval=1d');
      hv30 = historicalVol(closes?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [], IV_HV_WINDOW);
    } catch (_) { hv30 = null; }
  }
  const row = await premiumRow(sym, rate.rate, hv30, env);
  row.rate = {
    value: rate.rate, asOf: rate.asOf ?? null,
    stale: !!rate.stale, ageDays: rate.ageDays ?? null, reason: rate.reason || null,
  };
  await storePremiumRow(row, env);
  return row;
}

/* ── GET /api/premium/batch?symbols= ─────────────────────────────────────────
   Cache-status read, NOT a data fetch: reads KV and makes ZERO outbound FETCHES,
   so the tab can paint every watchlist ticker on load without touching Yahoo.

   It does NOT cost zero subrequests, which is what this comment used to imply:
   one KV read per symbol, and KV counts against the same 10,000 pool. The number
   ships in `_instr`. Tickers with nothing cached come back in `missing` so the
   row can say "not loaded" rather than being silently absent. */
async function handlePremiumBatch(params, origin, env) {
  const mark = instrMark();
  const symbols = (params.get('symbols') || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, PREM_MAX_SYMBOLS);
  if (!symbols.length) return err('symbols required', 400, origin);

  const rows = [], missing = [];
  await Promise.all(symbols.map(async (sym) => {
    const row = await readPremiumRow(sym, env);
    if (row) rows.push(row);
    else missing.push({
      symbol: sym, status: 'not-loaded',
      reason: 'not loaded — expand the row, or use ↻, to fetch this ticker',
    });
  }));

  rows.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const oldest = rows.length ? Math.min(...rows.map(r => r.ts || 0)) : null;
  const rate   = rows.find(r => r.rate)?.rate || null;

  return json({
    rows, missing,
    symbols,
    schema: PREM_SCHEMA,
    ts: Date.now(),
    minDte: PREM_MIN_DTE,
    targetDeltas: PREM_TARGETS,
    freshMs: PREMIUM_FRESH_MS,
    gates: { ...REGIME_GATES, ratioSellMin: RATIO_SELL_MIN },
    rate,
    _instr: instrSince(mark, 'batch'),
    _meta: srcMeta('KV cache (no fetch)', {
      ttlSeconds: PREMIUM_FRESH_MS / 1000,
      // The as-of that matters is the OLDEST row on screen, not this read.
      asOf: oldest ? new Date(oldest).toISOString().slice(0, 16).replace('T', ' ') : null,
      ok: true,
      note: `${rows.length}/${symbols.length} cached`
          + (missing.length ? ` · ${missing.length} not loaded` : '')
          + ' · rows fetch on expand, one ticker per request',
    }),
  }, 200, origin);
}

/* ── GET /api/premium/:ticker ────────────────────────────────────────────────
   The only path in the premium screen that spends subrequests, and it spends
   ~5 against a 10,000 cap. **One ticker per invocation, never more** — not for
   the cap's sake but for Yahoo's: this is the whole reason the batch sweep is gone.

     (no param)   serve the cached row if it is inside PREMIUM_FRESH_MS,
                  otherwise refetch. A cache hit costs ZERO outbound calls.
     ?refresh=1   always refetch, whatever the cache says. Backs the ↻ control.
     ?cached=1    never fetch; report what is banked and how old it is. */
async function handlePremiumTicker(ticker, params, origin, env, ctx) {
  const sym = String(ticker || '').toUpperCase();
  if (!sym) return err('ticker required', 400, origin);

  const force      = params.get('refresh') === '1';
  const cachedOnly = params.get('cached')  === '1';
  const cached = force ? null : await readPremiumRow(sym, env);
  const age    = cached?.ts ? Date.now() - cached.ts : null;
  const fresh  = age != null && age < PREMIUM_FRESH_MS;

  if (cached && (fresh || cachedOnly)) {
    return json({ row: cached, cached: true, stale: !fresh, ageMs: age, _meta: premiumRowMeta(cached) }, 200, origin);
  }
  if (cachedOnly) {
    return json({
      row: null, cached: true,
      missing: { symbol: sym, status: 'not-loaded', reason: 'not loaded — no cached row for this ticker' },
      _meta: srcMeta('KV cache (no fetch)', {
        ok: false, ttlSeconds: PREMIUM_FRESH_MS / 1000, note: 'nothing cached',
      }),
    }, 200, origin);
  }

  await getYahooCrumb(env).catch(() => {});
  const row = await refreshPremiumTicker(sym, env);
  return json({ row, cached: false, stale: false, ageMs: 0, _meta: premiumRowMeta(row) }, 200, origin);
}

function premiumRowMeta(row) {
  return srcMeta('Yahoo options chain', {
    delayed: true,
    ok: !!row?.ok,
    ttlSeconds: PREMIUM_FRESH_MS / 1000,
    asOf: row?.ts ? new Date(row.ts).toISOString().slice(0, 16).replace('T', ' ') : null,
    note: row?.ok
      ? `${row.legs?.length || 0} expir${(row.legs?.length || 0) === 1 ? 'y' : 'ies'}`
        + (row.rate?.value != null ? ` · r=${(row.rate.value * 100).toFixed(2)}%` : ' · deltas suppressed')
      : (row?.reason || 'unavailable'),
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   LONG-PREMIUM SCREEN  (/api/long)

   The mirror of the premium screen, and the places it is NOT a mirror are
   commented individually. Premium asks "where is vol rich enough to sell".
   This asks "where is vol cheap enough to own, and is the debit structurally
   payable". Several things invert, and an inverted thing that looks like a copy
   is how this gets broken later:

     • Premium takes the BID (what a seller can hit). This takes the ASK.
     • Premium wants IV rank HIGH. This wants it LOW.
     • Premium reads positive termStructure (backwardation) as the crush setup,
       a GOOD thing. Here it is the HOSTILE state — front-dated premium is
       exactly what you are buying, and backwardation means it is the rich end.
     • Premium's POP is 1 − |Δ| of a short strike. That is N(d1) and it is the
       WRONG quantity for a long: see probBeyondBreakeven() below.

   Subrequest cost, measured with the INSTR counter (see §"Verification" in the
   report and rule #1 — the 10,000 cap is one pool and these figures are
   external fetches only):

     premium-warm  5   base list + 2 Lane A Januaries + 2 Lane B monthlies
     premium-cold  8-9  + earnings quoteSummary + hv30 chart + back ATM chain

   The reuse of `premium:{TICKER}` is deliberate coupling and is made visible:
   if the premium row is cold this endpoint is MORE EXPENSIVE, never broken.
   What is reused is only the slow-moving half (front/back ATM IV, term
   structure, earnings date, hv30 / IV rank / proxy). Spot and the expiry list
   are ALWAYS taken live from the base options call, because that call has to
   happen anyway and a 4-hour-old spot would propagate into every breakeven,
   leverage figure and N(d2) on a screen where the user is about to pay a debit.
   The row therefore carries TWO timestamps — `ts` for the live half and
   `sharedTs`/`sharedFrom` for the reused half — so the card can age them
   separately instead of implying one as-of for both.
   ══════════════════════════════════════════════════════════════════════════ */

/* SCHEMA 2 — the CANDIDATE shape changed: `drift1y` / `drift3y` and
   `expectancyEpisodesTo50` in, `expectancyTop3Share` out. Bumped so cached
   schema-1 rows RETIRE instead of rendering every coverage cell blank with a
   generic hover — a stale row whose fields are simply absent reads on screen as
   "no measurement available", which misattributes our own cache to the ticker
   (honesty rule 17). Same rule the golden-cross payload follows. */
const LONG_SCHEMA      = 2;
const LONG_FRESH_MS    = 4 * 3600_000;   // freshness horizon — drives the stale badge
const LONG_ROW_TTL     = 24 * 3600;      // KV retention: outlives freshness so stale can render
const LONG_MAX_SYMBOLS = 60;

/* Lane A — stock replacement. The two nearest Januaries clearing the LTCG line.
   §2 selects "nearest 540 DTE" and "nearest January ≥365 DTE"; on most dates
   those collapse to the same expiry (2026-08-08: both resolve to 2028-01-21),
   so the second slot is the next January out. Expect the far one to be unlisted
   or unpriced on all but the largest names — that is a finding about the name,
   reported as a per-expiry status, never filled in from ATM IV. */
const LEAPS_MIN_DTE    = 365;
const LEAPS_TARGET_DTE = 540;
const LANE_A_TARGETS   = [0.85, 0.70];   // ITM — deep enough to be a share proxy
const LANE_B_DTES      = [30, 60];       // first monthly at or beyond each
const LANE_B_TARGETS   = [0.55, 0.40];
const LANE_C_LONG      = 0.55;
const LANE_C_SHORT     = 0.25;

/* Gate constants. Shipped to the frontend in `gates` so neither HTML file
   hardcodes a threshold — the same reason volRegime() lives in the Worker. */
const IVR_BUY_MAX   = 40;     // IV rank at or below this is "not rich"
const RATIO_BUY_MAX = 0.95;   // IV/HV30 proxy analogue, used while the rank collects
const LONG_SPREAD_MAX_NEAR  = 0.15;  // (ask−bid)/mid ceiling, ≤90 DTE
const LONG_SPREAD_MAX_LEAPS = 0.30;  // ditto, LEAPS — far chains are legitimately wider
const LONG_MIN_OI   = 10;
const LONG_BE_EM_MAX = 1.0;   // best-candidate BE/EM must clear this for a row to be undimmed
const LTCG_DAYS     = 366;    // a hold longer than this can qualify for long-term treatment

/* Row status — EXTENDS the premium vocabulary rather than forking it:
     ok · no-options · no-iv · error   (identical meaning to premium)
     no-expiries — options are listed but nothing on the chain is screenable: no
                   monthly at the swing horizon and no January past the LEAPS
                   floor. Rare and correctly attributed.
     illiquid    — every candidate breached its spread floor. Still fully priced
                   and still rendered; the row just has to LOOK untradeable.
   `pending` is never stored; it is what the batch endpoint reports for a ticker
   that has never been fetched.

   There is deliberately NO `no-leaps` row status. "This name has no LEAPS" is a
   Lane A fact, not a row failure — the swing and vertical lanes are unaffected
   by it — so it surfaces as the Lane A entry's `not-listed` reason and as
   `leapsListed: 0` on the row, which drives a chip. A row status would have
   blanked three working lanes to report one missing one. */

/** Long-premium gate. The inverse of sellableFrom() in direction, and the SAME
 *  tri-state shape — deliberately, because the null case has already caused one
 *  incident on the premium tab: treating "no basis to judge" as a fail dimmed
 *  every row for the whole 60-day collection window. `buyable: null` renders
 *  NEUTRAL, not dim.
 *
 *  Note this is NOT `!sellable`. Both gates can be false at once — an IV rank of
 *  55 is neither rich enough to sell nor cheap enough to buy, and that is a real
 *  and common state, not a contradiction. */
function buyableFrom(ivRank, ivHvRatio, historyDays) {
  if (ivRank != null) {
    const pts = ivRank * 100;
    const ok  = pts <= IVR_BUY_MAX;
    return {
      buyable: ok, basis: 'rank',
      reason: `IVR ${pts.toFixed(0)} — ${ok ? 'at or below' : 'above'} the ${IVR_BUY_MAX} ceiling for `
            + `buying premium${ok ? '' : '; vol is not cheap here'}`,
    };
  }
  if (ivHvRatio != null) {
    const ok = ivHvRatio <= RATIO_BUY_MAX;
    return {
      buyable: ok, basis: 'proxy',
      reason: `rank collecting (${historyDays}/${IV_RANK_MIN_DAYS}d), proxy ${ivHvRatio.toFixed(2)}× — `
            + `${ok ? 'at or below' : 'above'} ${RATIO_BUY_MAX.toFixed(2)}×, i.e. implied vol is pricing `
            + `${ok ? 'no more' : 'more'} movement than this name has actually realised. A proxy, not a percentile.`,
    };
  }
  return {
    buyable: null, basis: 'none',
    reason: 'No IV rank yet and no IV/HV30 proxy either — no basis to judge whether vol is cheap here, '
          + 'so this row is neither recommended nor dismissed.',
  };
}

/** Standard normal PDF — needed for theta and vega, which delta alone does not give. */
function normPdf(x) {
  return Number.isFinite(x) ? Math.exp(-x * x / 2) * 0.3989422804014327 : null;
}

/**
 * Full Black-Scholes greeks for one contract. `vol`/`rate` are DECIMALS, the
 * same convention as bsDelta() — anything read off an `atmIv` field is percent
 * and must be divided by 100 first.
 *
 * theta is per YEAR here; callers divide by 365. vega is per 1.00 of sigma, so
 * "per 1 IV point" is vega/100 per share — which, times the 100-share contract
 * multiplier, is numerically just `vega`. That coincidence is commented at the
 * call site because it looks like a missing conversion.
 */
function bsGreeks({ spot, strike, tYears, vol, rate = 0, type = 'call' }) {
  if (![spot, strike, tYears, vol, rate].every(Number.isFinite)) return null;
  if (spot <= 0 || strike <= 0 || tYears <= 0 || vol <= 0) return null;
  const sqrtT = Math.sqrt(tYears);
  const d1 = (Math.log(spot / strike) + (rate + vol * vol / 2) * tYears) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  const nd1 = normCdf(d1), nd2 = normCdf(d2), pdf = normPdf(d1);
  if (nd1 == null || nd2 == null || pdf == null) return null;
  const disc = Math.exp(-rate * tYears);
  const theta = type === 'put'
    ? -spot * pdf * vol / (2 * sqrtT) + rate * strike * disc * normCdf(-d2)
    : -spot * pdf * vol / (2 * sqrtT) - rate * strike * disc * nd2;
  return {
    delta: type === 'put' ? nd1 - 1 : nd1,
    d1, d2, theta,
    vega: spot * pdf * sqrtT,
  };
}

/**
 * P(BE)@exp — the risk-neutral probability of finishing beyond the breakeven.
 *
 * THIS IS NOT DELTA, and the difference is the whole reason this function
 * exists. Delta is N(d1); what is wanted is N(d2) with the BREAKEVEN in the
 * strike slot, and d1 − d2 = σ√T. At 45 DTE and 40% IV that gap is a couple of
 * points. On an 18-month LEAPS at 50% IV, σ√T ≈ 0.61 and N(d1) overstates N(d2)
 * by twenty-plus points — i.e. the shortcut fails worst on exactly the structure
 * this tab exists for. Reading a probability off the delta ladder here would
 * produce a confident, plausible, badly optimistic number.
 *
 * Returns null rather than a fallback if any input is missing. Callers render
 * `n/a` with the reason; §4 forbids substituting ATM IV for a missing strike IV.
 */
function probBeyondBreakeven({ spot, breakeven, tYears, vol, rate, type }) {
  if (![spot, breakeven, tYears, vol, rate].every(Number.isFinite)) return null;
  if (spot <= 0 || breakeven <= 0 || tYears <= 0 || vol <= 0) return null;
  const d2 = (Math.log(spot / breakeven) + (rate - vol * vol / 2) * tYears) / (vol * Math.sqrt(tYears));
  const n = normCdf(d2);
  if (n == null) return null;
  return type === 'put' ? 1 - n : n;
}

/** The listed strike nearest a price that actually quotes a usable IV.
 *  Named on the card, because "which strike's vol did you use" is the first
 *  question anyone should ask of a P(BE). */
function ivNearPrice(list, price) {
  const usable = (list || []).filter(o =>
    Number.isFinite(o?.strike) && Number.isFinite(o?.impliedVolatility) && o.impliedVolatility > 0);
  if (!usable.length || !Number.isFinite(price)) return null;
  const hit = usable.reduce((best, o) =>
    Math.abs(o.strike - price) < Math.abs(best.strike - price) ? o : best);
  return { strike: hit.strike, iv: hit.impliedVolatility };
}

/** Bid/ask/mid/spread for one contract. Debit is the ASK — the mirror of
 *  premium's credit-is-the-bid. Mid would flatter every number on this screen. */
function quoteOf(o) {
  const bid = Number.isFinite(o?.bid) && o.bid > 0 ? o.bid : null;
  const ask = Number.isFinite(o?.ask) && o.ask > 0 ? o.ask : null;
  const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
  const spreadPct = mid != null && mid > 0 ? (ask - bid) / mid : null;
  return { bid, ask, mid, spreadPct };
}

/* ══════════════════════════════════════════════════════════════════════════════
   MOVE COVERAGE — the measured half of the Long screen
   ══════════════════════════════════════════════════════════════════════════════

   `beEm` and `pBe` are both derived from the implied-vol surface: `emPct` from
   ATM IV, `pBe` from the IV of the strike nearest the breakeven. They say whether
   a contract is priced consistently with its own chain. NEITHER is a measurement
   of what the underlying has actually done.

   `moveCoverage` is that measurement: the fraction of historical N-session
   windows in which the underlying actually moved past a given breakeven. Rendered
   next to `pBe`, the difference between the two is the finding.

   FIVE things here have already been reasoned about and must not be "simplified":

   1. WINDOWS OVERLAP, DELIBERATELY. Disjoint windows leave ~5 samples/year at
      N=45 and the number would be worthless. The consequence — these are not
      independent observations — is carried in `independent` and stated on screen,
      not buried. `COVERAGE_MIN_INDEPENDENT` nulls a horizon the history cannot
      support rather than returning a confident-looking percentage.

   2. COVERAGE IS COMPUTED FROM THE RAW RETURN ARRAY, never from binned data. Any
      histogram a frontend draws is for the picture. If you find yourself deriving
      coverage from bin counts, that is the bug.

   3. 1y AND 3y ARE REPORTED SEPARATELY AND NEVER AVERAGED. They disagree on names
      that have re-rated, and that disagreement IS the regime-dependence warning.
      A blended figure would hide exactly what this exists to expose.

   4. `pBe` IS A RISK-NEUTRAL PROBABILITY; COVERAGE IS A REAL-WORLD FREQUENCY.
      They are not the same measure, and ZERO IS NOT FAIR VALUE. A persistent
      modest negative gap is the variance risk premium — what compensates option
      sellers — not a defect. No copy anywhere may imply otherwise.

   5. NEVER FALL BACK TO A SHORTER HORIZON AND LABEL IT AS THE REQUESTED ONE.
      Same failure class as substituting a percentile of HV for IV rank. The
      horizon actually used and the candidate's own DTE are reported side by side.

   Expectancy (below) is the ranking derived from the same array. It is sorted on
   because a descending PROBABILITY sort is a descending moneyness sort wearing a
   probability label — it ignores payoff and systematically selects against
   convexity, the property this screen exists to buy. */

/* SCHEMA 2 — the stored return arrays are `[return, startIdx]` PAIRS, not bare
   numbers. Schema 1 stored bare numbers and a reader that coerced one shape into
   the other would produce coverage figures that look entirely normal and are
   wrong. `readMoveSeries()` guards with STRICT EQUALITY, so any schema that is
   not exactly this one reads as ABSENT and the next sweep recomputes it. Never
   relax that to `<` or `>=`. */
const MOVES_SCHEMA   = 2;
const MOVES_TTL      = 7 * 24 * 3600;     // 7d retention; the sweep rewrites daily
const MOVES_RANGE    = '3y';              // see the note on COVERAGE_MIN_INDEPENDENT
const MOVES_HORIZONS = [5, 10, 20, 45, 90, 180, 365];   // trading sessions
const MOVES_1Y_SESSIONS = 252;            // the trailing-1y slice of the same series
const SESSIONS_PER_YEAR = 252;            // calendar DTE → trading sessions

/* A horizon whose history supports fewer than this many INDEPENDENT windows
   returns null with a reason instead of a percentage.
   At a 3y range (~756 sessions) this nulls N=180 (3.2) and N=365 (1.07); on the
   1y slice (~252) it nulls everything from N=90 up. That is the correct outcome,
   not a bug to engineer around.

   DO NOT RAISE `MOVES_RANGE` TO BUY BACK THOSE HORIZONS. 5y still yields only
   2.45 independent windows at N=365, and 10y of a name like NVDA spans a
   different company — it makes the stationarity problem worse, not better. The
   consequence is that Lane A (365+ DTE) has no expectancy, which is why Lane A
   keeps its native cost-of-carry sort rather than joining the cross-lane one. */
const COVERAGE_MIN_INDEPENDENT = 4;

/* Flag `expectancyEpisodesTo50` at or below this. LOW IS THE WARNING — the
   opposite polarity to the old top-3 SHARE this replaced, which is why that
   constant (0.40) was deleted rather than carried over: a stale threshold shipped
   in `gates` reads as a live one.

   1 is chosen from the OBSERVED distribution, not from intuition. Measured over
   real candidates at the moneyness the screen actually selects (0.95–1.10× spot),
   2026-08-09:

     3y window (n=198):  ==1 on 27%,  median 2,  p90 8,  max 25
     1y window (n=155):  ==1 on 51%,  median 1,  p90 4,  max 9

   1 is the only value that makes an unambiguous claim — half the expected value
   from a SINGLE market episode. 2 would fire on the median candidate at 3y (53%)
   and on three-quarters at 1y, and a warning that fires on the median is
   decoration.

   CALIBRATED ON 3y, AND THE SAME CANDIDATE FLAGS DIFFERENTLY BY WINDOW. That is
   correct — a 252-session window simply contains fewer distinct episodes, so the
   fire rate roughly doubles — but on screen it looks like a bug. The flag
   therefore NAMES ITS WINDOW INLINE (`concentrationLabel`), and no bare warning
   glyph may render without that text attached. */
const EPISODE_CONCENTRATION_WARN = 1;

const movesKey = sym => `moves:${sym.toUpperCase()}`;

/** One KV read. Returns null on a schema mismatch so a stored series from an
 *  older shape retires rather than rendering as blanks. */
async function readMoveSeries(sym, env) {
  try {
    const m = await env?.REC_LOG?.get(movesKey(sym), 'json');
    return m && m.schema === MOVES_SCHEMA ? m : null;
  } catch (_) { return null; }
}

/**
 * Overlapping N-session forward returns as `[return, startIdx]` PAIRS.
 * `c[i+N]/c[i] − 1` for every i that fits; length is `closes.length − n`.
 * Unbinned, and it stays that way.
 *
 * THE START INDEX IS LOAD-BEARING, not bookkeeping. Overlapping windows mean one
 * market move appears in up to N consecutive windows, so any concentration
 * measure computed without knowing WHICH windows are neighbours counts a single
 * episode many times over. `startIdx` is what lets the episode assignment in
 * `expectancyFrom()` collapse those back into one.
 */
function moveWindows(closes, n) {
  const out = [];
  if (!Array.isArray(closes) || !Number.isFinite(n) || n < 1) return out;
  for (let i = 0; i + n < closes.length; i++) {
    const a = closes[i], b = closes[i + n];
    if (!(a > 0) || !Number.isFinite(b)) continue;
    out.push([b / a - 1, i]);
  }
  return out;
}

/* Binary search on an array of pairs sorted ascending BY ELEMENT 0 (the return).
   Split out rather than inlined because coverage in both directions has to agree
   on tie handling: a return exactly equal to the required move counts as covered
   on BOTH sides, so `>=` uses the lower bound and `<=` uses the upper. */
function lowerBound(sorted, x) {           // first index with sorted[i][0] >= x
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid][0] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
function upperBound(sorted, x) {           // first index with sorted[i][0] > x
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid][0] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * Empirical coverage against a required signed move.
 *
 *   dir 'up'   → P(r ≥ threshold)   (a long call's breakeven sits above spot)
 *   dir 'down' → P(r ≤ threshold)   (a long put's sits below, so threshold < 0)
 *
 * Returns 0 — NOT null — when the breakeven falls outside every observed window.
 * Zero coverage is a valid, informative answer: the underlying has never once
 * made that move over this horizon. `null` is reserved for "we cannot tell", and
 * the two must never render the same way (honesty rule 22).
 */
function coverageAt(sorted, threshold, dir) {
  if (!Array.isArray(sorted) || !sorted.length || !Number.isFinite(threshold)) return null;
  const n = sorted.length;
  return dir === 'down'
    ? upperBound(sorted, threshold) / n
    : (n - lowerBound(sorted, threshold)) / n;
}

/** Calendar DTE → trading sessions, snapped to the nearest precomputed horizon.
 *  Returns BOTH so the card can print "scored at 45 sessions, contract is 41". */
function snapHorizon(dte) {
  if (!Number.isFinite(dte) || dte <= 0) return null;
  const sessions = Math.round(dte * SESSIONS_PER_YEAR / 365);
  let horizon = MOVES_HORIZONS[0];
  for (const h of MOVES_HORIZONS) {
    if (Math.abs(h - sessions) < Math.abs(horizon - sessions)) horizon = h;
  }
  return { sessions, horizon };
}

/**
 * Build the stored move series for one ticker from a daily close array.
 *
 * The sorted return arrays are stored rather than fitted parameters, deliberately:
 * coverage against an arbitrary breakeven is a lookup into the EMPIRICAL
 * distribution, and fitting a distribution to it would reintroduce the exact
 * model assumption this measurement exists to check. Expectancy needs the raw
 * returns too, not just quantiles.
 *
 * `reason1y` / `reason3y` are separate fields rather than the single `reason` the
 * spec sketched, because the two windows resolve independently: at N=90 the 3y
 * window supports 7.4 independent windows and the 1y window supports 1.8, so one
 * horizon genuinely has two different verdicts and one field cannot carry both.
 */
function buildMoveSeries(symbol, closes, asOfClose) {
  const c3y = (closes || []).filter(v => Number.isFinite(v) && v > 0);
  const c1y = c3y.slice(-Math.min(c3y.length, MOVES_1Y_SESSIONS));

  const horizons = {};
  for (const n of MOVES_HORIZONS) {
    const entry = {};
    for (const [label, series] of [['1y', c1y], ['3y', c3y]]) {
      const independent = series.length > n ? (series.length - n) / n : 0;
      // The reason names the ACTUAL numbers. A generic "insufficient history"
      // string cannot be checked against anything.
      if (series.length <= n) {
        entry[`n${label}`]           = null;
        entry[`independent${label}`] = +independent.toFixed(2);
        entry[`sorted${label}`]      = null;
        entry[`drift${label}`]       = null;
        entry[`reason${label}`] =
          `only ${series.length} sessions of ${label} history — a ${n}-session window needs at least ${n + 1}`;
        continue;
      }
      if (independent < COVERAGE_MIN_INDEPENDENT) {
        entry[`n${label}`]           = series.length - n;
        entry[`independent${label}`] = +independent.toFixed(2);
        entry[`sorted${label}`]      = null;
        entry[`drift${label}`]       = null;
        entry[`reason${label}`] =
          `${series.length} sessions of ${label} history support only ${independent.toFixed(2)} independent `
          + `${n}-session windows (${series.length - n} overlapping); the floor is ${COVERAGE_MIN_INDEPENDENT}`;
        continue;
      }
      const raw = moveWindows(series, n);
      const w = raw.slice().sort((a, b) => a[0] - b[0]).map(([r, i]) => [+r.toFixed(4), i]);
      entry[`n${label}`]           = w.length;
      entry[`independent${label}`] = +independent.toFixed(2);
      entry[`sorted${label}`]      = w;
      /* REALIZED DRIFT over this window, precomputed because every candidate at
         this horizon needs it and it does not depend on the structure.

         This is the confound in `gap`. Coverage is a real-world frequency and
         therefore INCLUDES whatever drift the stock actually had; `pBe` is
         risk-neutral and driftless by construction. So a positive gap can mean
         "the tails were fatter than the chain priced" OR simply "the stock went
         up", and on a strongly trending name the second term dominates. Carrying
         drift beside the gap is what stops a reader inferring "vol is cheap
         here" from what is really a directional observation. */
      entry[`drift${label}`]       = +(raw.reduce((a, [r]) => a + r, 0) / raw.length).toFixed(5);
      entry[`reason${label}`]      = null;
    }
    horizons[String(n)] = entry;
  }

  return {
    symbol: String(symbol).toUpperCase(),
    schema: MOVES_SCHEMA,
    ts: Date.now(),
    range: MOVES_RANGE,
    sessions:   c3y.length,
    sessions1y: c1y.length,
    asOfClose:  asOfClose || null,
    minIndependent: COVERAGE_MIN_INDEPENDENT,
    horizonList: MOVES_HORIZONS,
    horizons,
  };
}

/* ── Payoff at expiry, per structure ──────────────────────────────────────────
   GET THESE EXACTLY RIGHT: an error here INVERTS the ranking rather than
   degrading it.

   UNITS: `debit` and `credit` are PER CONTRACT, in dollars (i.e. per-share × 100).
   `strike` and `width` are per share. Every terminal value below is per contract.
   This codebase carries BOTH conventions on the same object — `longCandidate`
   returns `debit` (per contract) alongside `debitPerShare` — so feeding a
   per-share figure into one of these produces an expectancy 100× too SMALL, which
   sorts to the bottom and looks like a bad trade rather than a bug. The invariant
   check in `expectancyFrom()` is what catches that; the ≤1.0 credit-spread
   ceiling alone does not.

   Credit spreads have NO CALLER on this screen — Lanes A/B are long single legs,
   Lane C is a debit vertical, Lane D is null. They are implemented anyway and
   exercised in `moves.check.mjs`, following the `long-fixtures.check.mjs`
   precedent for paths live data cannot reach. Do not wire them to a candidate
   without deciding to add a credit lane. */

const clampTo = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const CREDIT_KINDS = new Set(['credit-call-spread', 'credit-put-spread']);

/** Terminal value at expiry given a terminal underlying price `S`, per contract.
 *  For DEBIT structures this is the value of what you hold; P/L subtracts the
 *  debit. For CREDIT structures this column already IS the P/L. */
function terminalValue(st, S) {
  if (!st || !Number.isFinite(S)) return null;
  switch (st.kind) {
    case 'long-call':
      return Math.max(0, S - st.strike) * 100;
    case 'long-put':
      return Math.max(0, st.strike - S) * 100;
    // A call vertical is long the LOWER strike, a put vertical the HIGHER one, so
    // the clamp bounds swap. Both are written lo-then-hi.
    case 'debit-call-vertical':
      return (clampTo(S, st.longStrike, st.shortStrike) - st.longStrike) * 100;
    case 'debit-put-vertical':
      return (st.longStrike - clampTo(S, st.shortStrike, st.longStrike)) * 100;
    case 'straddle':
      return (Math.max(0, S - st.strike) + Math.max(0, st.strike - S)) * 100;
    case 'strangle':
      return (Math.max(0, S - st.callStrike) + Math.max(0, st.putStrike - S)) * 100;
    // Short the near strike, long the far wing. Loss grows from the short strike
    // and stops at the long one.
    case 'credit-call-spread':
      return st.credit - (clampTo(S, st.shortStrike, st.longStrike) - st.shortStrike) * 100;
    case 'credit-put-spread':
      return st.credit - (st.shortStrike - clampTo(S, st.longStrike, st.shortStrike)) * 100;
    default:
      return null;
  }
}

/** P/L at expiry, per contract, in dollars. */
function payoffAt(st, S) {
  const tv = terminalValue(st, S);
  if (tv == null) return null;
  return CREDIT_KINDS.has(st.kind) ? tv : tv - st.debit;
}

/** Capital risked = MAX LOSS.
 *  For a credit spread that is `width × 100 − credit`, NOT the credit received.
 *  Using the credit would post expectancies in the hundreds of percent and pin
 *  every credit candidate to the top of the screen. */
function capitalOf(st) {
  if (!st) return null;
  if (CREDIT_KINDS.has(st.kind)) {
    const cap = st.width * 100 - st.credit;
    return Number.isFinite(cap) && cap > 0 ? cap : null;
  }
  return Number.isFinite(st.debit) && st.debit > 0 ? st.debit : null;
}

/** Maximum gain, or null where it is genuinely unbounded (long call, straddle,
 *  strangle). A long PUT is bounded — its maximum is at S = 0 — so it is not
 *  flagged as truncated. */
function maxGainOf(st) {
  if (!st) return null;
  switch (st.kind) {
    case 'long-call': case 'straddle': case 'strangle':
      return null;
    case 'long-put':
      return st.strike * 100 - st.debit;
    case 'debit-call-vertical': case 'debit-put-vertical':
      return Math.abs(st.shortStrike - st.longStrike) * 100 - st.debit;
    case 'credit-call-spread': case 'credit-put-spread':
      return st.credit;
    default:
      return null;
  }
}

/**
 * Expectancy over the stored historical windows.
 *
 *   expectancy = mean(pl_i) / capital        (0.34 = +34% expected return on capital)
 *
 * ASSIGNMENT IS NOT MODELLED, and neither is early close or any IV path between
 * now and expiry. This is expectancy for a position held to expiration, so it
 * UNDERSTATES any structure that would realistically be closed early — which is
 * most of them. It is a relative ranking, not a P&L forecast.
 *
 * TWO GUARDS, AND THEY CATCH DIFFERENT THINGS. Both are required.
 *
 *   1. THE BREAKEVEN CROSS-CHECK is the primary one. The candidate already
 *      derived a breakeven by a completely separate route (`strike + debit` on
 *      the option price); this payoff table derives one implicitly. Evaluating
 *      the payoff AT the candidate's claimed breakeven must give ~0. Two
 *      derivations of the same quantity, so a disagreement is structural.
 *
 *      This is what catches a per-share/per-contract unit mixup — and the bound
 *      check below CANNOT, which is the whole reason this exists. For any debit
 *      structure `min(pl) = −debit = −capital` holds BY CONSTRUCTION whatever
 *      units `debit` is in, so the bound is trivially satisfied however wrong the
 *      units are. Measured in `moves.check.mjs`: a long call given a per-share
 *      debit of 5 instead of 500 passes the bound check cleanly and reports an
 *      expectancy of **169.80 against a true 0.708** — 240× out, and the bound
 *      never notices. The breakeven anchor rejects it deterministically.
 *
 *   2. THE BOUND CHECK, `min(pl) ≥ −capital` and `max(pl) ≤ maxGain` for capped
 *      structures. It catches what the breakeven cannot: a wrong clamp bound, a
 *      flipped sign, a credit spread denominated on its credit.
 *
 * The cheaper "no credit-spread expectancy above 1.0" ceiling is a third check,
 * in `moves.check.mjs`.
 */
function expectancyFrom(sorted, st, spot, breakeven = null, horizon = null) {
  if (!Array.isArray(sorted) || !sorted.length) return null;
  if (!Number.isFinite(spot) || spot <= 0) return null;
  const capital = capitalOf(st);
  if (capital == null) return null;

  /* Guard 1 — the payoff must cross zero at the breakeven the candidate computed
     independently. Tolerance is 1% of capital or $1, whichever is larger: the
     stored breakeven is rounded to 2dp, which is worth up to $0.50 of payoff, and
     a unit error is off by orders of magnitude rather than dollars. */
  if (Number.isFinite(breakeven)) {
    const atBe = payoffAt(st, breakeven);
    const beTol = Math.max(1, 0.01 * capital);
    if (!Number.isFinite(atBe) || Math.abs(atBe) > beTol) {
      return { ok: false, reason: `payoff does not cross zero at the candidate's own breakeven `
        + `${breakeven}: P/L there is ${Number.isFinite(atBe) ? atBe.toFixed(2) : 'not finite'}, expected ~0 `
        + `(±${beTol.toFixed(2)}). The payoff table and the option pricing disagree — most likely a `
        + `per-share figure passed where a per-contract one belongs.` };
    }
  }

  const pl = [], startIdx = [];
  for (const [r, i] of sorted) {
    const v = payoffAt(st, spot * (1 + r));
    if (!Number.isFinite(v)) return null;
    pl.push(v);
    startIdx.push(i);
  }

  // Guard 2 — the bounds.
  const maxGain = maxGainOf(st);
  const minPl = Math.min(...pl), maxPl = Math.max(...pl);
  const tol = 1e-6 * Math.max(1, capital);
  if (minPl < -capital - tol) {
    return { ok: false, reason: `payoff breached max loss: min P/L ${minPl.toFixed(2)} below −${capital.toFixed(2)} `
                              + `capital — the payoff and the capital denominator disagree` };
  }
  if (maxGain != null && maxPl > maxGain + tol) {
    return { ok: false, reason: `payoff breached max gain: max P/L ${maxPl.toFixed(2)} above ${maxGain.toFixed(2)}` };
  }

  const n    = pl.length;
  const mean = pl.reduce((a, b) => a + b, 0) / n;
  const ord  = [...pl].sort((a, b) => a - b);
  const median = n % 2 ? ord[(n - 1) / 2] : (ord[n / 2 - 1] + ord[n / 2]) / 2;

  const variance = pl.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  const stdev    = Math.sqrt(variance);

  /* ── CONCENTRATION, DE-CLUSTERED ────────────────────────────────────────────
     The old `top3Share` measured the wrong thing. Windows OVERLAP, so one market
     move appears in up to N consecutive windows: the "three largest windows" are
     usually three overlapping views of a SINGLE episode, and the metric counted
     it three times while calling it three. A metric that needs a paragraph of
     caveat to avoid misleading is the wrong metric — so this measures the claimed
     thing instead, and `top3Share` is REMOVED rather than kept alongside.

     Measured over 323 real candidates: the old flag fired on 60 and MISSED 126
     that rest on a single episode; inside the `episodesTo50 == 1` bucket the old
     share ranged 2.1%–100%, i.e. near-uncorrelated with the property it was named
     for. Full write-up and the general rule for anything computed over
     overlapping windows: see "Design note: overlapping windows and the
     proxy-vs-thing failure" in ARCHITECTURE.md.

     Every window is assigned to exactly one episode, greedily:
       1. among unassigned windows take the one with the highest pl_i
       2. claim it and every unassigned window starting within N sessions of it
       3. repeat until nothing is unassigned

     Ranking on pl_i and NOT on return is deliberate: for a straddle the payoff is
     not monotonic in S — both tails pay — so ranking by return would build the
     episode around the wrong extreme. */
  const totalPos = pl.reduce((a, v) => a + (v > 0 ? v : 0), 0);

  let episodesTo50 = null, episodeCount = null, episodesReason = null;
  if (!(totalPos > 0)) {
    // 0/0 must never render as a measured concentration (honesty rule 22).
    episodesReason = 'no winning windows — there is no positive P/L to concentrate';
  } else {
    // `span`, not `n` — `n` is already pl.length in this scope and shadowing it
    // here would be silent and wrong-by-a-factor-of-thirty.
    const span = Number.isFinite(horizon) && horizon > 0 ? horizon : 1;
    const order = pl.map((_, i) => i).sort((a, b) => pl[b] - pl[a]);   // by pl desc
    const taken = new Uint8Array(pl.length);
    const episodes = [];
    for (const seed of order) {
      if (taken[seed]) continue;
      const at = startIdx[seed];
      let posSum = 0;
      for (let k = 0; k < pl.length; k++) {
        if (taken[k]) continue;
        if (Math.abs(startIdx[k] - at) < span) {
          taken[k] = 1;
          if (pl[k] > 0) posSum += pl[k];
        }
      }
      episodes.push(posSum);
    }
    episodeCount = episodes.length;

    /* An episode is scored by the POSITIVE P/L it contributes, not its net.
       The spec's termination argument — "every window is assigned, so the sum
       over episodes equals the total" — holds for the positive total but NOT for
       the net: net episode sums add up to mean x n, which on a losing structure
       is far below 50% of the positive total, and the accumulation would never
       terminate. Scoring by positive contribution makes the episode sums add to
       exactly `totalPos`, so the count always terminates by construction. */
    episodes.sort((a, b) => b - a);
    let acc = 0;
    for (let i = 0; i < episodes.length; i++) {
      acc += episodes[i];
      if (acc >= 0.5 * totalPos) { episodesTo50 = i + 1; break; }
    }
    // Unreachable given the invariant above; kept so a future change to the
    // scoring cannot silently produce a null that reads as "not measured".
    if (episodesTo50 == null) {
      episodesReason = `episode sums (${acc.toFixed(2)}) did not reach 50% of positive P/L `
                     + `(${totalPos.toFixed(2)}) — episode scoring invariant broken`;
      console.warn(`[moves] ${episodesReason}`);
    }
  }

  // Quarter-Kelly under a Gaussian approximation (f* ≈ mean/variance in units of
  // capital). DISPLAY ONLY and NEVER a sort key: Kelly is highly sensitive to the
  // variance estimate, and that estimate rests on ~5 independent windows a year
  // at N=45. Clamped at 0 so a negative-expectancy structure never suggests a size.
  const rMean = mean / capital;
  const rVar  = variance / (capital * capital);
  const kellyQuarter = rVar > 0 ? clampTo(rMean / rVar / 4, 0, 1) : null;

  const largestWindow = sorted[sorted.length - 1][0];

  return {
    ok: true,
    expectancyMean:      +(mean / capital).toFixed(4),
    expectancyMedian:    +(median / capital).toFixed(4),
    /* How many SEPARATE market episodes carry half the positive P/L. LOW is the
       alarming reading: 1 or 2 means the expectancy rests on one or two moves.
       Replaces `expectancyTop3Share`, which counted one episode three times. */
    expectancyEpisodesTo50: episodesTo50,
    expectancyEpisodes:     episodeCount,
    expectancyEpisodesReason: episodesReason,
    expectancyWinRate:   +(pl.filter(v => v > 0).length / n).toFixed(4),
    expectedDollars:     +mean.toFixed(2),
    expectancySharpe:    stdev > 0 ? +(mean / stdev).toFixed(4) : null,
    expectancyWindows:   n,
    capital:             +capital.toFixed(2),
    maxGain:             maxGain == null ? null : +maxGain.toFixed(2),
    riskReward:          maxGain == null ? null : +(maxGain / capital).toFixed(3),
    kellyQuarter:        kellyQuarter == null ? null : +kellyQuarter.toFixed(4),
    // An uncapped structure can only be scored at the largest move that actually
    // happened and no further, while a vertical's cap is real and binding. The
    // metric therefore STRUCTURALLY UNDERSTATES uncapped structures relative to
    // capped ones. Not fixable without assuming a distribution — which is exactly
    // what this measurement exists to avoid. Flagged, and the number left alone.
    upsideTruncated: maxGain == null,
    upsideTruncatedReason: maxGain == null
      ? `unbounded upside scored only as far as the largest observed ${n}-window move `
        + `(${(largestWindow * 100).toFixed(1)}%); capped structures are not truncated this way, `
        + 'so this figure understates it relative to a vertical'
      : null,
  };
}

/**
 * Attach the measured half to one candidate.
 *
 * `st` is the payoff descriptor; `bePct`/`breakeven` come from the candidate.
 * Direction is taken from the SIGNED required move (`breakeven/spot − 1`) rather
 * than the candidate's `bePct`, which is an absolute value and would point a put
 * the wrong way.
 *
 * WHEN `pBe` IS NULL, `gap` IS NULL — it is a difference of two numbers and one
 * is missing. Coverage alone never renders in the gap cell.
 * WHEN COVERAGE IS NULL, EXPECTANCY IS NULL — both come from the same array.
 */
function attachCoverage(cand, st, { moves, spot, dte, pBe }) {
  const out = {
    coverage1y: null, coverage3y: null,
    coverageHorizon: null, coverageSessions: null, coverageDte: dte ?? null,
    coverageN1y: null, coverageN3y: null,
    coverageIndependent1y: null, coverageIndependent3y: null,
    gap1y: null, gap3y: null,
    // Ships null for this release, on purpose. A median over the 2–6 candidates a
    // row scores at one horizon is not a baseline — and those candidates are the
    // same population being measured against it, which is close to circular. A
    // thin median rendered in the style of a real one is the stand-in this
    // codebase forbids. Raw gaps across the watchlist come first.
    gapBaseline: null,
    gapBaselineReason: 'gap is uncalibrated this release: no per-ticker, per-horizon baseline is '
      + 'computed yet, so a gap cannot be read as large or small for this name. NOTE a modest '
      + 'negative gap is EXPECTED — it is the variance risk premium, not a defect.',
    /* REALIZED DRIFT at this horizon — the confound in `gap`, carried beside it.
       Coverage includes whatever the stock actually did; pBe is driftless. So a
       positive gap is NOT a pure "vol is cheap here" signal, and on a trending
       name the drift term dominates it entirely. */
    drift1y: null, drift3y: null,
    coverageReason: null,
    expectancyMean: null, expectancyMedian: null,
    expectancyEpisodesTo50: null, expectancyEpisodes: null, expectancyEpisodesReason: null,
    expectancyWinRate: null, expectedDollars: null, expectancySharpe: null,
    // `expectancyRiskReward`, not `riskReward`: verticalCandidate ALREADY returns a
    // `riskReward` the card renders, and spreading this block over it would have
    // silently replaced a displayed field with a differently-rounded one. The two
    // are algebraically identical for a debit vertical — which is exactly why the
    // collision would have been invisible.
    expectancyWindows: null, maxGain: null, expectancyRiskReward: null, kellyQuarter: null,
    upsideTruncated: null, upsideTruncatedReason: null,
    // `concentrationLabel` is the flag's ONLY renderable form and always names its
    // window. A UI must never draw a warning glyph from `concentrationFlag` alone.
    concentrationFlag: false, concentrationLabel: null, concentrationNote: null,
    expectancyReason: null,
  };

  if (!moves || moves.schema !== MOVES_SCHEMA) {
    out.coverageReason = 'no move series collected for this ticker yet — the 2:00pm PT sweep banks one daily';
    out.expectancyReason = out.coverageReason;
    return out;
  }
  const snap = snapHorizon(dte);
  if (!snap) {
    out.coverageReason = 'no usable DTE on this candidate';
    out.expectancyReason = out.coverageReason;
    return out;
  }
  out.coverageHorizon  = snap.horizon;
  out.coverageSessions = snap.sessions;

  const h = moves.horizons?.[String(snap.horizon)];
  if (!h) {
    out.coverageReason = `horizon ${snap.horizon} is not in the stored series (schema ${moves.schema})`;
    out.expectancyReason = out.coverageReason;
    return out;
  }
  out.coverageN1y = h.n1y; out.coverageN3y = h.n3y;
  out.coverageIndependent1y = h.independent1y ?? null;
  out.coverageIndependent3y = h.independent3y ?? null;
  out.drift1y = h.drift1y ?? null;
  out.drift3y = h.drift3y ?? null;

  const reqMove = Number.isFinite(cand.breakeven) && spot > 0 ? cand.breakeven / spot - 1 : null;
  const dir = cand.type === 'PUT' ? 'down' : 'up';
  if (reqMove == null) {
    out.coverageReason = 'no breakeven to measure against';
    out.expectancyReason = out.coverageReason;
    return out;
  }

  out.coverage1y = coverageAt(h.sorted1y, reqMove, dir);
  out.coverage3y = coverageAt(h.sorted3y, reqMove, dir);
  if (out.coverage1y == null && out.coverage3y == null) {
    out.coverageReason = h.reason3y || h.reason1y || 'no window at this horizon is supported by the stored history';
  } else if (out.coverage1y == null) {
    out.coverageReason = h.reason1y;
  } else if (out.coverage3y == null) {
    out.coverageReason = h.reason3y;
  }

  // GAP IS IN POINTS, and its sign convention is stated in the legend: POSITIVE
  // means the underlying has historically cleared this breakeven MORE often than
  // the chain prices it to.
  if (pBe != null) {
    if (out.coverage1y != null) out.gap1y = +((out.coverage1y - pBe) * 100).toFixed(1);
    if (out.coverage3y != null) out.gap3y = +((out.coverage3y - pBe) * 100).toFixed(1);
  }

  /* EXPECTANCY RUNS ON THE 3y ARRAY, AND ONLY ON IT. There is deliberately no
     `|| h.sorted1y` fallback: it could never fire, and a branch that cannot fire
     is a false statement about the code — it advertises a fallback that does not
     exist, and a comment cannot repair that because the next reader would have to
     re-derive the argument to know whether the comment still held.

     Why it cannot fire, in one line: the 1y series is a SUFFIX of the 3y one, so
     `len(3y) >= len(1y)`, and `independent = (len − N)/N` increases in `len` —
     therefore `sorted3y === null` implies `sorted1y === null`. Full argument in
     ARCHITECTURE.md, "expectancy always resolves on 3y".

     THIS SAYS NOTHING ABOUT `coverage1y`, which reads `h.sorted1y` DIRECTLY a few
     lines above and is fully live. Only the expectancy fallback was dead. The two
     are easy to conflate. */
  const arr = h.sorted3y;
  const arrLabel = '3y';
  if (!arr) {
    /* AN ASSERTION, NOT A FALLBACK — and the difference is why this survives
       while the `|| h.sorted1y` above it was deleted for being unreachable.

       Both branches are unreachable today. But a FALLBACK that cannot fire is a
       false claim about behaviour: it says "expectancy can run on 1y", which is
       untrue, and a reader has to re-derive the suffix argument to find that out.
       An ASSERTION that cannot fire is the opposite — it claims nothing about
       normal operation, it says "this must never happen, and if it does you will
       hear about it rather than getting a silent null". Assertions are supposed
       to be unreachable; that is what makes them assertions.

       So do NOT delete this by applying the same rule that removed the fallback.
       If the horizon set or the window definitions ever diverge enough to make a
       resolved 1y outlive an unresolved 3y, this is the only thing that will say
       so at runtime. `moves.check.mjs` §11 covers the same invariant statically,
       across 13 series lengths × every shipped horizon. */
    if (h.sorted1y) {
      out.expectancyReason = `1y resolves at horizon ${snap.horizon} but 3y does not — the window `
        + `definitions have diverged and expectancy has no array to run on. This is structurally `
        + `impossible while the 1y series is a suffix of the 3y one; see ARCHITECTURE.md.`;
      console.warn(`[moves] ${out.expectancyReason}`);
    } else {
      out.expectancyReason = out.coverageReason;
    }
    return out;
  }
  // The candidate's own breakeven is handed across as an independent anchor —
  // see guard 1 in expectancyFrom(). The horizon is passed too: it is the
  // session span that defines when two windows belong to the same episode.
  const e = expectancyFrom(arr, st, spot, cand.breakeven, snap.horizon);
  if (!e) {
    out.expectancyReason = 'structure could not be priced across the historical windows';
    return out;
  }
  if (e.ok === false) {
    console.warn(`[moves] expectancy invariant failed for ${st.kind}: ${e.reason}`);
    out.expectancyReason = e.reason;
    return out;
  }

  out.expectancyMean      = e.expectancyMean;
  out.expectancyMedian    = e.expectancyMedian;
  out.expectancyEpisodesTo50   = e.expectancyEpisodesTo50;
  out.expectancyEpisodes       = e.expectancyEpisodes;
  out.expectancyEpisodesReason = e.expectancyEpisodesReason;
  out.expectancyWinRate   = e.expectancyWinRate;
  out.expectedDollars     = e.expectedDollars;
  out.expectancySharpe    = e.expectancySharpe;
  out.expectancyWindows   = e.expectancyWindows;
  out.maxGain             = e.maxGain;
  out.expectancyRiskReward = e.riskReward;
  out.kellyQuarter        = e.kellyQuarter;
  out.upsideTruncated     = e.upsideTruncated;
  out.upsideTruncatedReason = e.upsideTruncatedReason;
  out.expectancyWindow    = arrLabel;

  /* CONCENTRATION FLAG. Fires at or below EPISODE_CONCENTRATION_WARN (1).
     `concentrationLabel` is the ONLY thing a UI may render as the flag, and it
     always carries the window. The same candidate legitimately flags on 3y and
     not on 1y — a shorter series holds fewer distinct episodes — so a bare glyph
     would read as a bug at exactly the moment the number is doing its job. */
  const ep = e.expectancyEpisodesTo50;
  if (ep != null) {
    const win = arrLabel;
    out.concentrationFlag = EPISODE_CONCENTRATION_WARN != null && ep <= EPISODE_CONCENTRATION_WARN;
    out.concentrationLabel = out.concentrationFlag
      ? `half the expected value from ${ep === 1 ? 'ONE' : ep} ${win} episode${ep === 1 ? '' : 's'}`
      : null;
    out.concentrationNote = `Half the positive P/L comes from ${ep} separate market `
      + `episode${ep === 1 ? '' : 's'} out of ${e.expectancyEpisodes}, over the ${win} series `
      + `(${e.expectancyWindows} overlapping windows). LOW IS THE WARNING: 1 means this expectancy `
      + `rests on a single market move rather than a property of the trade. `
      + `Read it against the median (${(e.expectancyMedian * 100).toFixed(0)}%). `
      + `Flagged at ${EPISODE_CONCENTRATION_WARN} or below, calibrated on the 3y distribution — `
      + `the 1y series holds fewer episodes, so the same candidate can flag on one window and not `
      + `the other, and that is correct rather than a defect.`;
  } else if (e.expectancyEpisodesReason) {
    out.concentrationNote = e.expectancyEpisodesReason;
  }
  return out;
}

/**
 * One single-leg long candidate (Lanes A and B), fully priced.
 *
 * `emPct` is the expected move for THIS candidate's own expiry, not the front
 * one — BE/EM compares a breakeven against the 1σ the market is pricing over the
 * same horizon, and using the front expiry's move for a 531-day contract would
 * make every LEAPS look impossible.
 */
function longCandidate(o, ctx, type, laneId) {
  const { spot, rate, dte, tYears, emPct, chainSide, spreadMax, moves } = ctx;
  const g = bsGreeks({ spot, strike: o.strike, tYears, vol: o.impliedVolatility, rate, type });
  if (!g) return null;
  const q = quoteOf(o);
  // No ask = nothing to buy. Report it rather than pricing off the bid.
  if (q.ask == null) {
    return {
      lane: laneId, type: type.toUpperCase(), strike: o.strike, status: 'no-quote',
      reason: 'no ask quoted — nothing to buy at this strike',
      delta: +g.delta.toFixed(4), iv: +(o.impliedVolatility * 100).toFixed(2),
      openInterest: o.openInterest ?? null, volume: o.volume ?? null,
    };
  }

  const debit     = q.ask;                              // per share
  const intrinsic = type === 'call' ? Math.max(0, spot - o.strike) : Math.max(0, o.strike - spot);
  const extrinsic = Math.max(0, debit - intrinsic);
  const breakeven = type === 'call' ? o.strike + debit : o.strike - debit;
  const bePct     = Math.abs(breakeven / spot - 1) * 100;
  const beEm      = Number.isFinite(emPct) && emPct > 0 ? bePct / emPct : null;

  // σ for P(BE) comes from the strike nearest the BREAKEVEN, not this strike and
  // never ATM. Suppressed with a reason if that strike quotes nothing usable.
  const beIv = ivNearPrice(chainSide, breakeven);
  const pBe  = beIv ? probBeyondBreakeven({ spot, breakeven, tYears, vol: beIv.iv, rate, type }) : null;

  const notional = Math.abs(g.delta) * spot;
  const spreadOk = q.spreadPct == null ? null : q.spreadPct <= spreadMax;
  const flags = [];
  if (spreadOk === false) flags.push('wide-spread');
  if ((o.openInterest ?? 0) < LONG_MIN_OI) flags.push('thin-oi');

  /* The measured half. `debit` here is PER CONTRACT — the same figure the row
     reports below — because every payoff in the coverage block is per contract.
     Passing `debit` (per share) instead would make expectancy 100× too small. */
  const cov = attachCoverage(
    { type: type.toUpperCase(), breakeven },
    { kind: type === 'call' ? 'long-call' : 'long-put', strike: o.strike, debit: +(debit * 100).toFixed(2) },
    { moves, spot, dte, pBe },
  );

  return {
    lane: laneId,
    type: type.toUpperCase(),
    strike: o.strike,
    status: spreadOk === false ? 'illiquid' : 'ok',
    delta: +g.delta.toFixed(4),
    iv: +(o.impliedVolatility * 100).toFixed(2),
    bid: q.bid, ask: q.ask,
    mid: q.mid == null ? null : +q.mid.toFixed(2),
    spreadPct: q.spreadPct == null ? null : +q.spreadPct.toFixed(4),
    spreadMax,
    debit: +(debit * 100).toFixed(2),          // per contract, the number you pay
    debitPerShare: +debit.toFixed(2),
    intrinsic: +(intrinsic * 100).toFixed(2),
    extrinsic: +(extrinsic * 100).toFixed(2),
    extrinsicPct: debit > 0 ? +(extrinsic / debit).toFixed(4) : null,
    breakeven: +breakeven.toFixed(2),
    bePct: +bePct.toFixed(2),
    beEm: beEm == null ? null : +beEm.toFixed(3),
    // (delta × spot) ÷ debit — how much share exposure a dollar of debit buys.
    leverage: debit > 0 ? +(notional / debit).toFixed(2) : null,
    // Annualised cost of carry: the extrinsic paid, per dollar of share exposure
    // controlled, annualised. Rendered beside the DGS3MO rate so the comparison
    // is on screen rather than implied.
    carryAnnual: notional > 0 && dte > 0 ? +(extrinsic / notional * 365 / dte).toFixed(4) : null,
    thetaDay: +(g.theta / 365 * 100).toFixed(2),                    // $ per contract per day
    thetaPctDebit: debit > 0 ? +(g.theta / 365 / debit).toFixed(4) : null,
    // vega is per 1.00 sigma per share; per 1 IV POINT per CONTRACT that is
    // (vega/100) × 100 = vega. The two conversions cancel — this is not a bug.
    vegaPerPoint: +g.vega.toFixed(2),
    vegaLoss5: +(g.vega * 5).toFixed(2),
    pBe: pBe == null ? null : +pBe.toFixed(4),
    pBeIvStrike: beIv?.strike ?? null,
    pBeIvUsed: beIv ? +(beIv.iv * 100).toFixed(2) : null,
    pBeReason: pBe != null ? null
      : (!Number.isFinite(rate) ? 'no risk-free rate — P(BE) suppressed rather than computed at r=0'
                                : 'no listed strike near the breakeven quotes a usable IV; ATM IV is not substituted'),
    ltcgEligible: dte > LTCG_DAYS,
    ltcgHeadroomDays: dte - LTCG_DAYS,
    openInterest: o.openInterest ?? null,
    volume: o.volume ?? null,
    flags,
    ...cov,
  };
}

/** Nearest listed strike to a target |delta|, restricted to one moneyness side.
 *  The IV-outlier guard is `ivPlausible()` in the premium section above — shared
 *  with `pickCandidates()` on purpose, because both screens select strikes BY
 *  delta off the same chains and a second copy is how the two drift apart. */
function nearestDelta(list, spot, rate, tYears, type, target, { itm = null, atmIv = null, rejects = null } = {}) {
  let best = null, bestGap = Infinity;
  for (const o of list || []) {
    if (!Number.isFinite(o?.strike)) continue;
    if (!Number.isFinite(o?.impliedVolatility) || o.impliedVolatility <= 0) continue;
    if (!ivPlausible(o.impliedVolatility, atmIv)) {
      if (rejects) rejects.push({ strike: o.strike, type, iv: +(o.impliedVolatility * 100).toFixed(2) });
      continue;
    }
    if (itm === true  && (type === 'call' ? o.strike >= spot : o.strike <= spot)) continue;
    if (itm === false && (type === 'call' ? o.strike <= spot : o.strike >= spot)) continue;
    const d = bsDelta({ spot, strike: o.strike, tYears, vol: o.impliedVolatility, rate, type });
    if (d == null) continue;
    const gap = Math.abs(Math.abs(d) - target);
    if (gap < bestGap) { bestGap = gap; best = o; }
  }
  return best;
}

/**
 * Lane C — debit vertical. Long the ~0.55Δ strike, short a ~0.25Δ wing.
 *
 * Debit is long ASK minus short BID: the two sides of the spread cross in
 * opposite directions, and using mids here would understate what it costs to
 * open by roughly the full spread. The ACTUAL deltas of both legs are reported,
 * not the 0.55/0.25 targets — a sparse chain can land well away from them and a
 * card printing the target would be describing a contract that does not exist.
 */
function verticalCandidate(chainSide, ctx, type) {
  const { spot, rate, dte, tYears, emPct, spreadMax, atmIv, moves } = ctx;
  const band = { atmIv: atmIv / 100 };   // same IV-outlier guard as the single-leg lanes
  const longOpt  = nearestDelta(chainSide, spot, rate, tYears, type, LANE_C_LONG,  band);
  const shortOpt = nearestDelta(chainSide, spot, rate, tYears, type, LANE_C_SHORT, band);
  if (!longOpt || !shortOpt || longOpt.strike === shortOpt.strike) return null;
  // A call vertical is long the lower strike; a put vertical the higher one.
  if (type === 'call' ? shortOpt.strike <= longOpt.strike : shortOpt.strike >= longOpt.strike) return null;

  const lg = bsGreeks({ spot, strike: longOpt.strike,  tYears, vol: longOpt.impliedVolatility,  rate, type });
  const sg = bsGreeks({ spot, strike: shortOpt.strike, tYears, vol: shortOpt.impliedVolatility, rate, type });
  if (!lg || !sg) return null;

  const lq = quoteOf(longOpt), sq = quoteOf(shortOpt);
  if (lq.ask == null || sq.bid == null) return null;
  const debit = lq.ask - sq.bid;
  if (!(debit > 0)) return null;                       // a credit here means the chain is broken

  const width     = Math.abs(shortOpt.strike - longOpt.strike);
  const breakeven = type === 'call' ? longOpt.strike + debit : longOpt.strike - debit;
  const bePct     = Math.abs(breakeven / spot - 1) * 100;
  const beEm      = Number.isFinite(emPct) && emPct > 0 ? bePct / emPct : null;
  const beIv      = ivNearPrice(chainSide, breakeven);
  const pBe       = beIv ? probBeyondBreakeven({ spot, breakeven, tYears, vol: beIv.iv, rate, type }) : null;

  const netDelta = lg.delta - sg.delta;
  const netVega  = lg.vega  - sg.vega;
  const netTheta = lg.theta - sg.theta;

  /* Capital risked on a DEBIT vertical is the debit — which is already this
     row's `maxLoss`. Computed once here and used for both, so the number the
     card prints as max loss and the number expectancy divides by cannot drift. */
  const maxLoss = +(debit * 100).toFixed(2);
  const cov = attachCoverage(
    { type: type.toUpperCase(), breakeven },
    { kind: type === 'call' ? 'debit-call-vertical' : 'debit-put-vertical',
      longStrike: longOpt.strike, shortStrike: shortOpt.strike, debit: maxLoss },
    { moves, spot, dte, pBe },
  );

  const worstSpread = Math.max(lq.spreadPct ?? 0, sq.spreadPct ?? 0);
  const flags = [];
  if (worstSpread > spreadMax) flags.push('wide-spread');
  if (Math.min(longOpt.openInterest ?? 0, shortOpt.openInterest ?? 0) < LONG_MIN_OI) flags.push('thin-oi');

  return {
    lane: 'C',
    type: type.toUpperCase(),
    status: worstSpread > spreadMax ? 'illiquid' : 'ok',
    longStrike: longOpt.strike,
    shortStrike: shortOpt.strike,
    // The real deltas, not the targets they were selected against.
    longDelta:  +lg.delta.toFixed(4),
    shortDelta: +sg.delta.toFixed(4),
    targetDeltas: [LANE_C_LONG, LANE_C_SHORT],
    longIv:  +(longOpt.impliedVolatility * 100).toFixed(2),
    shortIv: +(shortOpt.impliedVolatility * 100).toFixed(2),
    width: +width.toFixed(2),
    debit: +(debit * 100).toFixed(2),
    debitPerShare: +debit.toFixed(2),
    maxProfit: +((width - debit) * 100).toFixed(2),
    maxLoss,
    riskReward: width > debit ? +((width - debit) / debit).toFixed(2) : null,
    breakeven: +breakeven.toFixed(2),
    bePct: +bePct.toFixed(2),
    beEm: beEm == null ? null : +beEm.toFixed(3),
    netDelta: +netDelta.toFixed(4),
    thetaDay: +(netTheta / 365 * 100).toFixed(2),
    vegaPerPoint: +netVega.toFixed(2),
    vegaLoss5: +(netVega * 5).toFixed(2),
    // Extrinsic on a vertical is not the Lane A quantity (the short leg refunds
    // part of it), so cost-of-carry is deliberately absent here rather than
    // computed from a formula that does not describe the structure.
    pBe: pBe == null ? null : +pBe.toFixed(4),
    pBeIvStrike: beIv?.strike ?? null,
    pBeIvUsed: beIv ? +(beIv.iv * 100).toFixed(2) : null,
    pBeReason: pBe != null ? null : 'no listed strike near the breakeven quotes a usable IV',
    ltcgEligible: dte > LTCG_DAYS,
    ltcgHeadroomDays: dte - LTCG_DAYS,
    spreadPct: +worstSpread.toFixed(4),
    spreadMax,
    openInterest: Math.min(longOpt.openInterest ?? 0, shortOpt.openInterest ?? 0),
    flags,
    ...cov,
  };
}

/**
 * Lane D — calendar / diagonal. DELIBERATELY THIN, and the card says why.
 *
 * A calendar has no single-expiry breakeven. Its P/L at the front expiry depends
 * on what the BACK month's IV is on that future date, which needs a
 * term-structure model this codebase does not have and cannot obtain free. So
 * everything that would require one is ABSENT, not blank and not estimated:
 * no breakeven, no BE/EM, no P(BE), no cost of carry, no payoff diagram.
 * Deriving any of them from an assumed future IV would produce a plausible
 * number measuring nothing — the same failure as POP on a debit spread.
 */
function calendarCandidate(frontChain, backChain, front, back, ctx, earnIso) {
  const { spot } = ctx;
  const atmOf = (chain) => {
    const c = (chain?.calls || []).filter(o => Number.isFinite(o?.strike));
    if (!c.length) return null;
    return c.reduce((b, o) => Math.abs(o.strike - spot) < Math.abs(b.strike - spot) ? o : b);
  };
  const f = atmOf(frontChain), b = atmOf(backChain);
  if (!f || !b) return null;
  const fq = quoteOf(f), bq = quoteOf(b);
  if (bq.ask == null || fq.bid == null) return null;
  const debit = bq.ask - fq.bid;                      // sell the front, buy the back
  if (!(debit > 0)) return null;

  const fIv = Number.isFinite(f.impliedVolatility) ? f.impliedVolatility * 100 : null;
  const bIv = Number.isFinite(b.impliedVolatility) ? b.impliedVolatility * 100 : null;

  return {
    lane: 'D',
    type: 'CALL',
    status: 'ok',
    strike: f.strike === b.strike ? f.strike : null,
    frontStrike: f.strike, backStrike: b.strike,
    diagonal: f.strike !== b.strike,
    frontExpiry: front.expiry, frontDte: front.dte,
    backExpiry:  back.expiry,  backDte:  back.dte,
    frontIv: fIv == null ? null : +fIv.toFixed(2),
    backIv:  bIv == null ? null : +bIv.toFixed(2),
    ivDiff:  (fIv != null && bIv != null) ? +(fIv - bIv).toFixed(2) : null,
    debit: +(debit * 100).toFixed(2),
    debitPerShare: +debit.toFixed(2),
    // Where the print falls relative to the two legs — the one genuinely
    // decision-relevant fact a calendar has that a single-expiry structure does not.
    earningsIso: earnIso,
    earningsPosition: !earnIso ? 'none'
      : earnIso <= front.expiry ? 'before-front'
      : earnIso <= back.expiry  ? 'between-legs'
      : 'after-back',
    suppressed: {
      fields: ['breakeven', 'beEm', 'pBe', 'carryAnnual', 'payoff'],
      reason: 'A calendar has no single-expiry breakeven: its P/L at the front expiry depends on the '
            + "back month's IV at that future date, which needs a term-structure model this app does "
            + 'not have. Deriving these from an assumed future IV would be a plausible number measuring nothing.',
    },
    openInterest: Math.min(f.openInterest ?? 0, b.openInterest ?? 0),
  };
}

/** Directional read for the alignment tag.
 *
 *  Source is `analysis:{TICKER}` — the SAME key the Watchlist tab's
 *  Recommendation column writes (refreshTickerAnalysis → ANALYSIS_SCHEMA, rating
 *  is a strict BUY|HOLD|SELL enum). NOT `watchlist:{TICKER}`, which does not
 *  exist; `watchlist:tickers` is the saved symbol list and a different thing.
 *
 *  Two KV reads and ZERO external fetches — and specifically zero Claude calls:
 *  a missing analysis yields `no read` and must never trigger a generation to
 *  fill it. Routing this through /api/ai/* would put model spend behind a screen
 *  the user expects to be free.
 */
async function directionalRead(sym, env) {
  let a = null, entries = [];
  try { a = await env?.REC_LOG?.get(`analysis:${sym}`, 'json'); } catch (_) {}
  try { entries = (await env?.REC_LOG?.get(`rec:${sym}`, 'json')) || []; } catch (_) {}
  const rating = ['BUY', 'HOLD', 'SELL'].includes(a?.rating) ? a.rating : null;
  const calib  = recCalibration(entries);
  // The tag ALWAYS renders. It only reorders anything once the model behind it
  // has a resolved track record — an alignment tag from an unscored model must
  // not look, or sort, like one from a scored model.
  const scored = calib.reason == null;
  return {
    rating,
    source: rating ? `analysis:${sym}` : null,
    asOf: a?.ts ?? null,
    confidence: Number.isFinite(a?.confidence) ? a.confidence : null,
    calibration: {
      n: calib.n, minN: calib.minN, reason: calib.reason,
      hitRate: scored && rating ? calib.byRating?.[rating]?.hitRate ?? null : null,
      brier: calib.brier,
    },
    affectsSort: scored,
  };
}

/** Tag one candidate against the row's directional read. */
function alignTagFor(rating, optType, lane) {
  if (lane === 'D') return null;                       // a calendar is not directional
  if (!rating) return { tag: 'no read', reason: 'no stored analysis for this ticker' };
  if (lane === 'A') {
    return {
      tag: 'out-of-horizon', rating,
      reason: `Rating is ${rating}, shown for context only. This contract is 365–900 DTE and the `
            + 'rating\'s track record is measured at 5 and 20 sessions (fwd5/fwd20) — it is not a '
            + 'signal about where this name sits in a year. Does not affect Lane A sorting.',
    };
  }
  if (rating === 'HOLD') return { tag: 'neutral', rating, reason: 'Rating is HOLD — no directional claim.' };
  const aligned = (rating === 'BUY') === (optType === 'CALL');
  return {
    tag: aligned ? 'aligned' : 'counter', rating,
    reason: `Rating is ${rating}; this is a long ${optType.toLowerCase()}. `
          + (aligned ? 'Same direction.' : 'Opposite direction — demoted in sort, never removed.'),
  };
}

/**
 * Lane A expiry selection, factored out of longRow so it is testable without a
 * network fixture — the same reasoning as `tradingDayStatus()` in the cron gate:
 * anything decided in code should be checkable before deploy.
 *
 * §2 asks for "the January nearest 540 DTE" plus "the nearest January ≥365 DTE".
 * With third-Friday Januaries spaced ~366 days apart those two rules select the
 * SAME expiry on all but ~7 days a year: the near January only wins the 540
 * target once it is already ≥358 DTE, and it clears the 365 floor at 365. So
 * Lane A takes the two nearest Januaries past the floor — primary nearest
 * `LEAPS_TARGET_DTE`, secondary the next one out. The secondary is frequently
 * unlisted; that is a fact about the name, reported rather than hidden.
 */
function pickJanuaries(monthlies) {
  const januaries = (monthlies || [])
    .filter(e => new Date(e * 1000).getUTCMonth() === 0 && dteOf(e) >= LEAPS_MIN_DTE);
  const janPrimary = januaries.length
    ? januaries.reduce((b, e) =>
        Math.abs(dteOf(e) - LEAPS_TARGET_DTE) < Math.abs(dteOf(b) - LEAPS_TARGET_DTE) ? e : b)
    : null;
  const janSecondary = janPrimary == null ? null
    : (januaries.filter(e => e !== janPrimary)
        .sort((a, b) => Math.abs(dteOf(a) - dteOf(janPrimary)) - Math.abs(dteOf(b) - dteOf(janPrimary)))[0] ?? null);
  return { januaries, janPrimary, janSecondary };
}

/** One long-screen row. Never throws — a failed ticker reports why. */
async function longRow(sym, env, { rate, premium }) {
  const fail = (status, reason) => ({
    symbol: sym, ok: false, status, reason, lanes: [], bestBeEm: null,
    schema: LONG_SCHEMA, ts: Date.now(),
  });

  let base;
  try {
    base = await yahooAuth(`/v7/finance/options/${encodeURIComponent(sym)}`, '', env);
  } catch (e) { return fail('error', `options chain fetch failed: ${e.message}`); }

  const res  = base?.optionChain?.result?.[0];
  const spot = res?.quote?.regularMarketPrice;
  const exps = (res?.expirationDates || []).slice().sort((a, b) => a - b);
  if (!res || !Number.isFinite(spot) || !exps.length) {
    return fail('no-options', 'no listed options for this ticker');
  }

  // Dividend status comes free off the base quote. If Yahoo carries no dividend
  // field we say UNKNOWN rather than "none" — §4's no-dividend-adjustment
  // caveat has to be stated against a fact, not against an absence.
  const divRate  = res.quote?.trailingAnnualDividendRate ?? res.quote?.dividendRate ?? null;
  const divYield = res.quote?.trailingAnnualDividendYield ?? res.quote?.dividendYield ?? null;
  const dividend = (divRate == null && divYield == null)
    ? { known: false, pays: null, note: 'Yahoo quoted no dividend field — dividend status unknown. '
        + 'The Black-Scholes inputs here carry no dividend adjustment either way.' }
    : { known: true, pays: (divRate > 0 || divYield > 0), rate: divRate, yield: divYield,
        note: (divRate > 0 || divYield > 0)
          ? 'This underlying pays a dividend and the model applies NO dividend adjustment: delta, '
            + 'P(BE) and cost of carry are all biased for long-dated calls. Stated, not silently ignored.'
          : 'No dividend on record — the no-dividend assumption holds here.' };

  const loaded = new Map();
  if (res.options?.[0]?.expirationDate) loaded.set(res.options[0].expirationDate, res.options[0]);
  let chainFetches = 0;
  const chainFor = async (exp) => {
    if (exp == null) return null;
    if (loaded.has(exp)) return loaded.get(exp);
    try {
      chainFetches++;
      const d = await yahooAuth(`/v7/finance/options/${encodeURIComponent(sym)}`, `?date=${exp}`, env);
      const c = d?.optionChain?.result?.[0]?.options?.[0] || null;
      if (c) loaded.set(exp, c);
      return c;
    } catch (_) { return null; }
  };

  /* ── The reuse boundary, and it is deliberately narrow ──────────────────────
     Reused from a fresh premium row: earnings date, front/back ATM IV, term
     structure, hv30 / ivRank / ivHvRatio. All slow-moving.
     NEVER reused: spot and the expiry list, which come off the base call above
     because that call happens regardless and a stale spot corrupts every
     breakeven on the screen. The row carries both timestamps so the card can
     age the two halves separately. */
  const warm = premium && premium.ok && premium.status === 'ok';
  let earnIso, frontMeta, backMeta, termStructure, hv30, ivRank, historyDays, rankReason, ivHvRatio;

  if (warm) {
    earnIso       = premium.earnings?.iso ?? null;
    frontMeta     = premium.front ?? null;
    backMeta      = premium.back ?? null;
    termStructure = premium.termStructure ?? null;
    hv30          = premium.hv30 ?? null;
    ivRank        = premium.ivRank ?? null;
    historyDays   = premium.historyDays ?? 0;
    rankReason    = premium.rankReason ?? null;
    ivHvRatio     = premium.ivHvRatio ?? null;
  } else {
    try {
      const qs = await yahooAuth(
        `/v10/finance/quoteSummary/${encodeURIComponent(sym)}`, '?modules=calendarEvents', env);
      // Same field as the watchlist column and the premium screen, deliberately:
      // three tabs quoting different earnings dates for one ticker is a bug.
      earnIso = nextEarningsIso(qs?.quoteSummary?.result?.[0]);
    } catch (_) { earnIso = null; }

    const frontExp = exps.find(e => dteOf(e) >= IV_MIN_DTE) ?? exps[exps.length - 1];
    const backExp  = exps.find(e => e > frontExp && isMonthlyExpiry(e)) ?? null;
    const fChain = await chainFor(frontExp);
    const bChain = await chainFor(backExp);
    const fIv = fChain ? atmIvFor(fChain, spot) : null;
    const bIv = bChain ? atmIvFor(bChain, spot) : null;
    if (!fIv) {
      return fail('no-iv',
        `options are listed but the front expiry (${expiryIso(frontExp)}, ${dteOf(frontExp)}d) quotes `
        + 'no usable implied vol — too thin to price');
    }
    frontMeta = { expiry: expiryIso(frontExp), dte: dteOf(frontExp), atmIv: fIv.atmIv, strike: fIv.strike };
    backMeta  = bIv ? { expiry: expiryIso(backExp), dte: dteOf(backExp), atmIv: bIv.atmIv, strike: bIv.strike } : null;
    termStructure = bIv ? +(fIv.atmIv - bIv.atmIv).toFixed(2) : null;

    /* Bank the IV sample from the LIVE branch, unconditionally, and BEFORE the
       ivHistory() read below — the same ordering handleIv() uses, so today's
       reading sits inside its own ranking window.

       This path exists because `/api/iv` is not the only place a ticker's IV gets
       read any more. Card 06 will stop calling it, and when it does, every
       off-watchlist name would silently stop collecting the history `ivRank`
       needs — the 1:15pm cron only sweeps the watchlist. Costs one KV write
       against data already fetched: zero additional subrequests to Yahoo.
       The call in handleIv() STAYS for now, deliberately: two paths writing the
       same key for one release is harmless and lets this one be verified against
       the old one. */
    try {
      await recordIvSample(sym, { spot, front: frontMeta }, env, { src: 'long-live' });
    } catch (e) { console.warn(`[long] ${sym} iv sample write failed:`, e.message); }

    try {
      const closes = await yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}`, '?range=3mo&interval=1d');
      hv30 = historicalVol(closes?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [], IV_HV_WINDOW);
    } catch (_) { hv30 = null; }

    const history = await ivHistory(sym, env).catch(() => []);
    ({ ivRank, historyDays, rankReason } = ivRankFrom(history, fIv.atmIv));
    ivHvRatio = Number.isFinite(hv30) && hv30 > 0 ? +(fIv.atmIv / hv30).toFixed(3) : null;
  }

  if (!frontMeta?.atmIv) {
    return fail('no-iv', 'no usable front-expiry implied vol to anchor the screen');
  }

  /* The warm counterpart. `frontMeta` here came from `premium:{TICKER}` and may
     be up to 4h old, so this write DEFERS to any sample already banked today
     rather than overwriting a fresher one — see the precedence note in
     recordIvSample(). `spot` is the live figure off the base call above (the
     premium row's would be equally stale, and the sample's purpose is the IV
     series); `src: 'long-warm'` declares that the two halves differ in age. */
  if (warm) {
    try {
      await recordIvSample(sym, { spot, front: frontMeta }, env,
                           { src: 'long-warm', skipIfPresent: true });
    } catch (e) { console.warn(`[long] ${sym} warm iv sample write failed:`, e.message); }
  }

  /* ── Expiry selection ─────────────────────────────────────────────────────── */
  const monthlies = exps.filter(isMonthlyExpiry);
  const { januaries, janPrimary, janSecondary } = pickJanuaries(monthlies);

  const bExp1 = monthlies.find(e => dteOf(e) >= LANE_B_DTES[0]) ?? null;
  const bExp2 = monthlies.find(e => dteOf(e) >= LANE_B_DTES[1] && e !== bExp1) ?? null;

  /* This was `no-leaps`, and that status has been REMOVED. It required no January
     beyond 365 DTE AND no monthly at either swing horizon — i.e. it could only
     fire when the name had essentially no usable expiries at all, at which point
     "no LEAPS" names the wrong cause (honesty rule 17: an error message must not
     misattribute itself). It also implied a row-level coverage check the screen
     does not perform, and it would have failed the whole row over a Lane A fact
     while Lanes B/C/D were still perfectly priceable.

     The LEAPS signal it was reaching for is Lane-A-scoped and already carried
     two ways: the lane entry reports `not-listed` with its reason, and the row
     carries `leapsListed` (0 = this name has no LEAPS) for the summary chip. */
  if (!januaries.length && !bExp1 && !bExp2) {
    return fail('no-expiries',
      `options are listed but there is no monthly expiry at ${LANE_B_DTES[0]}+ DTE and no January beyond `
      + `${LEAPS_MIN_DTE} DTE — nothing on this chain to screen`);
  }

  // Sequential on purpose: chainFor dedupes through `loaded`, which concurrent
  // calls would defeat, and Yahoo throttles parallel chain requests.
  const janChain1 = await chainFor(janPrimary);
  const janChain2 = await chainFor(janSecondary);
  const bChain1   = await chainFor(bExp1);
  const bChain2   = await chainFor(bExp2);

  const ctxFor = (exp, chain) => {
    const dte = dteOf(exp);
    const atm = chain ? atmIvFor(chain, spot) : null;
    // Expected move on THIS expiry, not the front one.
    const emPct = atm ? (atm.atmIv / 100) * Math.sqrt(dte / 365) * 100 : null;
    return {
      spot, rate, dte, tYears: dte / 365, emPct,
      atmIv: atm?.atmIv ?? null,
      spreadMax: dte > 90 ? LONG_SPREAD_MAX_LEAPS : LONG_SPREAD_MAX_NEAR,
      moves,
    };
  };

  const read = await directionalRead(sym, env);
  // One KV read. Banked daily by the 2:00pm PT sweep, so this path never fetches
  // for it — a per-ticker chart fetch here would put 22 invocations against Yahoo
  // the moment anyone hit "Load all".
  const moves = await readMoveSeries(sym, env);
  const lanes = [];

  const singleLegLane = (laneId, exp, chain, targets, types, itm) => {
    if (exp == null) {
      return { lane: laneId, expiry: null, candidates: [],
               status: 'not-listed', reason: laneId === 'A'
                 ? `no January expiry beyond ${LEAPS_MIN_DTE} DTE at this slot`
                 : `no monthly expiry at this horizon` };
    }
    const entry = { lane: laneId, expiry: expiryIso(exp), dte: dteOf(exp), candidates: [] };
    if (!chain) { entry.status = 'error'; entry.reason = 'expiry chain did not load'; return entry; }
    const ctx = ctxFor(exp, chain);
    entry.atmIv = ctx.atmIv;
    entry.expectedMovePct = ctx.emPct == null ? null : +ctx.emPct.toFixed(2);
    entry.ltcgEligible = ctx.dte > LTCG_DAYS;
    if (!Number.isFinite(rate)) { entry.status = 'no-rate'; entry.reason = 'no risk-free rate — greeks suppressed rather than computed at r=0'; return entry; }
    if (ctx.atmIv == null) {
      // A far January that is listed but quotes nothing. Real, common, and NOT
      // patched with ATM IV from a nearer expiry.
      entry.status = 'no-iv';
      entry.reason = 'listed but quotes no usable implied vol at any near-the-money strike — '
                   + 'not filled in from another expiry';
      return entry;
    }
    const rejects = [];
    for (const type of types) {
      const side = type === 'call' ? chain.calls : chain.puts;
      for (const target of targets) {
        const o = nearestDelta(side, spot, rate, ctx.tYears, type, target,
                               { itm, atmIv: ctx.atmIv / 100, rejects });
        if (!o) continue;
        const c = longCandidate(o, { ...ctx, chainSide: side }, type, laneId);
        if (!c) continue;
        if (entry.candidates.some(x => x.type === c.type && x.strike === c.strike)) { c.sparse = true; continue; }
        c.targetDelta = target;
        c.align = alignTagFor(read.rating, c.type, laneId);
        entry.candidates.push(c);
      }
    }
    // Reported, not hidden: an excluded strike is a fact about Yahoo's quote and
    // the user should be able to see how much of the chain it applied to.
    const out = ivOutlierNote(rejects, ctx.atmIv);
    if (out) { entry.ivOutliers = out.count; entry.ivOutlierNote = out.note; }
    entry.status = entry.candidates.length ? 'ok' : 'no-iv';
    if (!entry.candidates.length) entry.reason = 'no strike on this expiry quotes both a usable IV and an ask';
    return entry;
  };

  lanes.push({ ...singleLegLane('A', janPrimary,   janChain1, LANE_A_TARGETS, ['call'], true),  slot: 'primary' });
  lanes.push({ ...singleLegLane('A', janSecondary, janChain2, LANE_A_TARGETS, ['call'], true),  slot: 'secondary' });
  lanes.push(singleLegLane('B', bExp1, bChain1, LANE_B_TARGETS, ['call', 'put'], null));
  lanes.push(singleLegLane('B', bExp2, bChain2, LANE_B_TARGETS, ['call', 'put'], null));

  // Lane C reuses Lane B's already-fetched chains — zero extra subrequests.
  for (const [exp, chain] of [[bExp1, bChain1], [bExp2, bChain2]]) {
    if (exp == null || !chain || !Number.isFinite(rate)) continue;
    const ctx = ctxFor(exp, chain);
    if (ctx.atmIv == null) continue;
    const entry = { lane: 'C', expiry: expiryIso(exp), dte: dteOf(exp), atmIv: ctx.atmIv,
                    expectedMovePct: ctx.emPct == null ? null : +ctx.emPct.toFixed(2), candidates: [] };
    for (const type of ['call', 'put']) {
      const v = verticalCandidate(type === 'call' ? chain.calls : chain.puts, ctx, type);
      if (!v) continue;
      v.align = alignTagFor(read.rating, v.type, 'C');
      entry.candidates.push(v);
    }
    entry.status = entry.candidates.length ? 'ok' : 'no-iv';
    if (!entry.candidates.length) entry.reason = 'no pair of strikes on this expiry prices a debit vertical';
    lanes.push(entry);
  }

  // Lane D reuses Lane B's chains too.
  if (bExp1 != null && bExp2 != null && bChain1 && bChain2) {
    const d = calendarCandidate(bChain1, bChain2, ctxFor(bExp1, bChain1), ctxFor(bExp2, bChain2), { spot }, earnIso);
    lanes.push(d
      ? { lane: 'D', expiry: expiryIso(bExp1), dte: dteOf(bExp1), candidates: [
          { ...d, frontExpiry: expiryIso(bExp1), frontDte: dteOf(bExp1),
            backExpiry: expiryIso(bExp2), backDte: dteOf(bExp2) }], status: 'ok' }
      : { lane: 'D', expiry: expiryIso(bExp1), dte: dteOf(bExp1), candidates: [], status: 'no-iv',
          reason: 'the two monthly legs do not both quote a tradeable ATM contract' });
  }

  /* ── Row-level gate: TWO parts, and both must pass ─────────────────────────
     Cheap vol is necessary but not sufficient — a name can have depressed IV and
     still price every breakeven outside its own expected move, which makes the
     debit structurally unpayable however cheap the vol is. */
  const beEms = lanes.flatMap(l => l.candidates || [])
    .filter(c => c.lane === 'B' || c.lane === 'C')
    .map(c => c.beEm).filter(Number.isFinite);
  const bestBeEm = beEms.length ? Math.min(...beEms) : null;

  const gate = buyableFrom(ivRank, ivHvRatio, historyDays);
  const beOk = bestBeEm == null ? null : bestBeEm <= LONG_BE_EM_MAX;
  const dim  = gate.buyable === false || beOk === false;

  const frontDte = frontMeta.dte;
  return {
    symbol: sym,
    ok: true,
    status: 'ok',
    schema: LONG_SCHEMA,
    // TWO timestamps: `ts` is this fetch (spot, chains, every candidate).
    ts: Date.now(),
    // `sharedTs` is the age of the reused half. Equal to ts when nothing was
    // reused. The card ages them separately — one as-of for both would imply the
    // IV rank is as fresh as the spot, which it is not.
    sharedTs: warm ? (premium.ts ?? null) : Date.now(),
    sharedFrom: warm ? 'premium-row' : 'live',
    sharedFields: ['earnings', 'front', 'back', 'termStructure', 'hv30', 'ivRank', 'ivHvRatio'],
    spot: +spot.toFixed(2),
    front: frontMeta,
    back: backMeta,
    termStructure,
    /* SIGN INVERSION — the single easiest thing here to get backwards.
       termStructure = front − back, so POSITIVE is backwardation (front IV
       richer). On the PREMIUM tab that is the crush setup and reads as GOOD.
       Here it is HOSTILE: front-dated premium is what a long buyer is paying
       for, and backwardation means paying the rich end of the curve. Same
       number, same sign, opposite verdict — hence `hostileTerm`, a separate
       field from premium's `backwardation`, and a different chip glyph. */
    backwardation: termStructure != null && termStructure > 0,
    hostileTerm:   termStructure != null && termStructure > 0,
    termReading: termStructure == null ? null
      : termStructure > 0
        ? `Front IV is ${termStructure.toFixed(1)} pts RICHER than back — backwardation. Hostile for `
          + 'buying front-dated premium: you are paying the rich end of the curve. (The Premium tab '
          + 'reads this same sign as favourable, because it is selling it.)'
        : `Front IV is ${Math.abs(termStructure).toFixed(1)} pts CHEAPER than back — contango. `
          + 'Favourable for buying front-dated premium.',
    expectedMove: {
      pct: +((frontMeta.atmIv / 100) * Math.sqrt(frontDte / 365) * 100).toFixed(2),
      dollars: +(spot * (frontMeta.atmIv / 100) * Math.sqrt(frontDte / 365)).toFixed(2),
      dte: frontDte, expiry: frontMeta.expiry,
    },
    earnings: earnIso
      ? { iso: earnIso,
          daysAway: Math.round((Date.parse(earnIso + 'T00:00:00Z') - Date.parse(etToday() + 'T00:00:00Z')) / 86_400_000),
          source: 'Yahoo calendarEvents' }
      : { iso: null, reason: 'no scheduled earnings date from Yahoo' },
    daysToEarnings: earnIso
      ? Math.round((Date.parse(earnIso + 'T00:00:00Z') - Date.parse(etToday() + 'T00:00:00Z')) / 86_400_000)
      : null,
    hv30, ivHvRatio, ivRank, historyDays, rankReason,
    rankTargetDays: IV_RANK_TARGET_DAYS,
    regime: volRegime({ ivRank, ivHvRatio, historyDays, rankTargetDays: IV_RANK_TARGET_DAYS }),
    buyable: gate.buyable,
    buyableBasis: gate.basis,
    buyableReason: gate.reason,
    beEmOk: beOk,
    bestBeEm,
    dim,
    dimReason: !dim ? null
      : gate.buyable === false && beOk === false
        ? `${gate.reason} · and best BE/EM ${bestBeEm.toFixed(2)} is above ${LONG_BE_EM_MAX.toFixed(2)}`
        : gate.buyable === false ? gate.reason
        : `vol is not rich, but best BE/EM ${bestBeEm.toFixed(2)} is above ${LONG_BE_EM_MAX.toFixed(2)} — `
          + 'the breakeven sits outside the move the market is pricing',
    dividend,
    directional: read,
    lanes,
    leapsListed: januaries.length,
    janPrimary:   janPrimary   ? { expiry: expiryIso(janPrimary),   dte: dteOf(janPrimary) }   : null,
    janSecondary: janSecondary ? { expiry: expiryIso(janSecondary), dte: dteOf(janSecondary) } : null,
    chainFetches,
  };
}

const longKey = sym => `long:${sym.toUpperCase()}`;

async function storeLongRow(row, env) {
  try {
    await env?.REC_LOG?.put(longKey(row.symbol), JSON.stringify(row), { expirationTtl: LONG_ROW_TTL });
  } catch (e) { console.warn(`[long] ${row.symbol} KV write failed:`, e.message); }
}

async function readLongRow(sym, env) {
  try {
    const row = await env?.REC_LOG?.get(longKey(sym), 'json');
    return row && row.schema === LONG_SCHEMA ? row : null;
  } catch (_) { return null; }
}

function longRowMeta(row) {
  const warm = row?.sharedFrom === 'premium-row';
  return srcMeta('Yahoo options chain', {
    delayed: true,
    ok: !!row?.ok,
    ttlSeconds: LONG_FRESH_MS / 1000,
    asOf: row?.ts ? new Date(row.ts).toISOString().slice(0, 16).replace('T', ' ') : null,
    note: row?.ok
      ? `${(row.lanes || []).filter(l => l.status === 'ok').length} lane slots priced`
        + (warm && row.sharedTs
            ? ` · IV/earnings reused from premium row ${Math.round((row.ts - row.sharedTs) / 60000)}min older`
            : ' · all fields live')
      : (row?.reason || 'unavailable'),
  });
}

/** Refresh one ticker. Measured 5 subrequests premium-warm, 8–9 premium-cold. */
async function refreshLongTicker(sym, env) {
  const rate = await riskFreeRate(env);
  // Reuse a FRESH premium row only. A stale one is not reused: past the
  // freshness horizon its IV rank and earnings date are no better than refetching.
  let premium = null;
  try {
    const p = await readPremiumRow(sym, env);
    if (p && p.ts && Date.now() - p.ts < PREMIUM_FRESH_MS) premium = p;
  } catch (_) {}
  const row = await longRow(sym, env, { rate: rate.rate, premium });
  row.rate = { value: rate.rate, asOf: rate.asOf ?? null, stale: !!rate.stale,
               ageDays: rate.ageDays ?? null, reason: rate.reason || null };
  row.gates = {
    ivrBuyMax: IVR_BUY_MAX, ratioBuyMax: RATIO_BUY_MAX,
    spreadMaxNear: LONG_SPREAD_MAX_NEAR, spreadMaxLeaps: LONG_SPREAD_MAX_LEAPS,
    minOi: LONG_MIN_OI, beEmMax: LONG_BE_EM_MAX, ltcgDays: LTCG_DAYS,
    // Move-coverage thresholds ship too, for the same reason every other gate
    // does: neither frontend may hardcode a threshold the Worker owns.
    coverageMinIndependent: COVERAGE_MIN_INDEPENDENT,
    // null = no flag is set on episode concentration yet. The frontend must render
    // the metric unflagged while this is null rather than inventing a cutoff.
    episodeConcentrationWarn: EPISODE_CONCENTRATION_WARN,
    coverageHorizons: MOVES_HORIZONS, coverageRange: MOVES_RANGE,
  };
  await storeLongRow(row, env);
  return row;
}

/* ── GET /api/long/batch?symbols= ────────────────────────────────────────────
   Cache-status read, NOT a data fetch: zero outbound FETCHES, so the tab paints
   every watchlist ticker on load without touching Yahoo.

   "Zero outbound calls" was the old wording and it is not the same claim. This
   endpoint costs ONE KV READ PER SYMBOL, and KV reads count against the same
   10,000 pool — a 22-name watchlist is ~22 against the cap, not 0. It is still
   the cheap path (no upstream, no rate-limit exposure, ~11ms), but the figure
   now rides along in `_instr` rather than being described as nothing. */
async function handleLongBatch(params, origin, env) {
  const mark = instrMark();
  const symbols = (params.get('symbols') || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, LONG_MAX_SYMBOLS);
  if (!symbols.length) return err('symbols required', 400, origin);

  const rows = [], missing = [];
  await Promise.all(symbols.map(async (sym) => {
    const row = await readLongRow(sym, env);
    if (row) rows.push(row);
    else missing.push({ symbol: sym, status: 'not-loaded',
                        reason: 'not loaded — expand the row, or use ↻, to fetch this ticker' });
  }));
  rows.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const oldest = rows.length ? Math.min(...rows.map(r => r.ts || 0)) : null;
  return json({
    rows, missing, symbols,
    schema: LONG_SCHEMA,
    ts: Date.now(),
    freshMs: LONG_FRESH_MS,
    lanes: {
      A: { targets: LANE_A_TARGETS, minDte: LEAPS_MIN_DTE, targetDte: LEAPS_TARGET_DTE },
      B: { targets: LANE_B_TARGETS, dtes: LANE_B_DTES },
      C: { long: LANE_C_LONG, short: LANE_C_SHORT },
    },
    gates: {
      ivrBuyMax: IVR_BUY_MAX, ratioBuyMax: RATIO_BUY_MAX,
      spreadMaxNear: LONG_SPREAD_MAX_NEAR, spreadMaxLeaps: LONG_SPREAD_MAX_LEAPS,
      minOi: LONG_MIN_OI, beEmMax: LONG_BE_EM_MAX, ltcgDays: LTCG_DAYS,
    // Move-coverage thresholds ship too, for the same reason every other gate
    // does: neither frontend may hardcode a threshold the Worker owns.
    coverageMinIndependent: COVERAGE_MIN_INDEPENDENT,
    // null = no flag is set on episode concentration yet. The frontend must render
    // the metric unflagged while this is null rather than inventing a cutoff.
    episodeConcentrationWarn: EPISODE_CONCENTRATION_WARN,
    coverageHorizons: MOVES_HORIZONS, coverageRange: MOVES_RANGE,
      ...REGIME_GATES,
    },
    rate: rows.find(r => r.rate)?.rate || null,
    _instr: instrSince(mark, 'batch'),
    _meta: srcMeta('KV cache (no fetch)', {
      ttlSeconds: LONG_FRESH_MS / 1000,
      asOf: oldest ? new Date(oldest).toISOString().slice(0, 16).replace('T', ' ') : null,
      ok: true,
      note: `${rows.length}/${symbols.length} cached`
          + (missing.length ? ` · ${missing.length} not loaded` : '')
          + ' · rows fetch on expand, one ticker per request',
    }),
  }, 200, origin);
}

/* ── GET /api/long/:ticker ───────────────────────────────────────────────────
   The only path in this screen that spends subrequests.
     (no param)   cached row if inside LONG_FRESH_MS, else refetch
     ?refresh=1   always refetch
     ?cached=1    never fetch */
async function handleLongTicker(ticker, params, origin, env) {
  const sym = String(ticker || '').toUpperCase();
  if (!sym) return err('ticker required', 400, origin);

  /* Baseline at the TOP of the handler, not just before the refetch.
     It used to sit after the cache read and the crumb call, which quietly
     excluded their cost from a number labelled "this request" — a smaller
     version of the same understatement that made extFetches look like a budget.
     Every return path below reports, so a cache hit states its cost too. */
  const mark = instrMark();
  const stamp = (phase, extra = {}) => ({ ...instrSince(mark, phase), ...extra });

  const force      = params.get('refresh') === '1';
  const cachedOnly = params.get('cached')  === '1';
  const cached = force ? null : await readLongRow(sym, env);
  const age    = cached?.ts ? Date.now() - cached.ts : null;
  const fresh  = age != null && age < LONG_FRESH_MS;

  if (cached && (fresh || cachedOnly)) {
    return json({ row: cached, cached: true, stale: !fresh, ageMs: age,
                  _instr: stamp('cache-hit'), _meta: longRowMeta(cached) }, 200, origin);
  }
  if (cachedOnly) {
    return json({
      row: null, cached: true,
      missing: { symbol: sym, status: 'not-loaded', reason: 'not loaded — no cached row for this ticker' },
      _instr: stamp('cache-miss'),
      _meta: srcMeta('KV cache (no fetch)', { ok: false, ttlSeconds: LONG_FRESH_MS / 1000, note: 'nothing cached' }),
    }, 200, origin);
  }

  await getYahooCrumb(env).catch(() => {});
  // Measured, not estimated (rule #1). The bracket covers the cache probe, the
  // crumb, the base list, every dated chain, the KV traffic behind the IV
  // history and the directional read, and — on the premium-cold path — the
  // extra quoteSummary and hv30 chart. `capCost` is the figure the 10,000
  // meters; `premiumWarm` says which of the two cases the number describes,
  // because they differ by roughly a third and a bare number would be ambiguous.
  const row = await refreshLongTicker(sym, env);
  return json({
    row, cached: false, stale: false, ageMs: 0,
    _instr: stamp('complete', { premiumWarm: row.sharedFrom === 'premium-row' }),
    _meta: longRowMeta(row),
  }, 200, origin);
}

/* ═══════════════════════════════════════════════════════════════════════════
   IMPLIED VOLATILITY  (/api/iv/:ticker)

   Implied vol comes from the options chain and nowhere else. The page used to
   compute a 30-day close-to-close standard deviation into a variable named `iv`
   — that is *historical* vol, a different quantity, and it now travels as
   `hv30` under an HV30 label. This block is the real thing.

   HV30 rather than HV20 is the comparator on purpose: front-expiry ATM IV is a
   forward ~30-day vol estimate, so 30 sessions of realised vol is the
   apples-to-apples window for `ivHvRatio`.

   Every vol figure below (atmIv, hv30, termStructure) is in **percent** — Yahoo
   returns `impliedVolatility` as a decimal fraction and it is scaled by 100 here
   so the ratio divides like with like.
   ══════════════════════════════════════════════════════════════════════════ */

const IV_MIN_DTE          = 7;                // front expiry must be at least this far out
const IV_HV_WINDOW        = 30;               // sessions of realised vol compared against front IV
const IV_HISTORY_TTL      = 400 * 24 * 3600;  // per-day sample retention, in seconds
const IV_RANK_MIN_DAYS    = 60;               // below this, ivRank is null — never estimated
const IV_RANK_TARGET_DAYS = 252;              // one trading year: the goal the UI counts toward

/** Today in US Pacific time as an ISO `YYYY-MM-DD` string. */
const ptDate = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);

/** Yahoo expirations are midnight UTC; compare them as calendar days, not elapsed hours. */
function dteOf(expiryUnixSec, now = Date.now()) {
  const exp    = new Date(expiryUnixSec * 1000);
  const expDay = Date.UTC(exp.getUTCFullYear(), exp.getUTCMonth(), exp.getUTCDate());
  const n      = new Date(now);
  const nowDay = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  return Math.round((expDay - nowDay) / 86_400_000);
}

const expiryIso = unixSec => new Date(unixSec * 1000).toISOString().slice(0, 10);

/** Standard monthly expiry: the third Friday of the month. */
function isMonthlyExpiry(unixSec) {
  const d = new Date(unixSec * 1000);
  return d.getUTCDay() === 5 && d.getUTCDate() >= 15 && d.getUTCDate() <= 21;
}

/**
 * ATM implied vol for one expiry: the average of `impliedVolatility` on the call
 * and the put whose strike sits closest to spot. If only one side quotes a usable
 * IV that side stands alone rather than discarding the expiry.
 */
function atmIvFor(chain, spot) {
  const nearest = (arr = []) => arr
    .filter(o => Number.isFinite(o?.strike))
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];

  const call = nearest(chain?.calls);
  const put  = nearest(chain?.puts);
  const ivs  = [call?.impliedVolatility, put?.impliedVolatility]
    .filter(v => Number.isFinite(v) && v > 0);

  if (!ivs.length) return null;
  return {
    atmIv:  +(ivs.reduce((a, b) => a + b, 0) / ivs.length * 100).toFixed(2),
    strike: call?.strike ?? put?.strike ?? null,
    legs:   ivs.length,
  };
}

/** Annualised close-to-close historical volatility, in percent. */
function historicalVol(closes, period = IV_HV_WINDOW) {
  const c = (closes || []).filter(Number.isFinite);
  if (c.length < period + 1) return null;
  const rets = [];
  for (let i = c.length - period; i < c.length; i++) rets.push(Math.log(c[i] / c[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return +(Math.sqrt(varc) * Math.sqrt(252) * 100).toFixed(2);
}

/**
 * Front + back ATM IV for a ticker.
 *   front — nearest expiration at least IV_MIN_DTE out
 *   back  — the next standard monthly expiry after the front one
 * Costs one chain fetch when the base response already carries the front expiry,
 * plus one per expiry it does not.
 */
async function ivSnapshot(ticker, env, { withLadder = false, rate = null } = {}) {
  const base = await yahooAuth(`/v7/finance/options/${encodeURIComponent(ticker)}`, '', env);
  const res  = base?.optionChain?.result?.[0];
  if (!res) return null;

  const spot = res.quote?.regularMarketPrice;
  const exps = (res.expirationDates || []).slice().sort((a, b) => a - b);
  if (!Number.isFinite(spot) || !exps.length) return null;

  const frontExp = exps.find(e => dteOf(e) >= IV_MIN_DTE) ?? exps[exps.length - 1];
  const backExp  = exps.find(e => e > frontExp && isMonthlyExpiry(e)) ?? null;

  // The base response already carries one expiry's strikes — reuse it when it matches.
  const loaded = new Map();
  if (res.options?.[0]?.expirationDate) loaded.set(res.options[0].expirationDate, res.options[0]);

  const chainFor = async (exp) => {
    if (exp == null) return null;
    if (loaded.has(exp)) return loaded.get(exp);
    const d = await yahooAuth(`/v7/finance/options/${encodeURIComponent(ticker)}`, `?date=${exp}`, env);
    const c = d?.optionChain?.result?.[0]?.options?.[0] || null;
    if (c) loaded.set(exp, c);
    return c;
  };

  const frontChain = await chainFor(frontExp);
  const backChain  = await chainFor(backExp);
  const frontIv    = frontChain ? atmIvFor(frontChain, spot) : null;
  const backIv     = backChain  ? atmIvFor(backChain,  spot) : null;
  if (!frontIv) return null;

  // Only the research page needs the strike ladder; the cron sweep would pay an
  // extra chain fetch per ticker for something it never reads.
  let pop = null;
  if (withLadder && Number.isFinite(rate)) {
    const popExp = exps.reduce((best, e) =>
      best == null || Math.abs(dteOf(e) - IV_POP_TARGET_DTE) < Math.abs(dteOf(best) - IV_POP_TARGET_DTE)
        ? e : best, null);
    const popChain = await chainFor(popExp);
    if (popChain) pop = popLadder(popChain, spot, rate, popExp);
  }

  return {
    spot: +spot.toFixed(4),
    front: { expiry: expiryIso(frontExp), dte: dteOf(frontExp), atmIv: frontIv.atmIv, strike: frontIv.strike },
    back: backIv
      ? { expiry: expiryIso(backExp), dte: dteOf(backExp), atmIv: backIv.atmIv, strike: backIv.strike }
      : null,
    pop,
  };
}

/**
 * Persist one day's front-month ATM IV.
 *
 * IV rank needs a year of history that nothing has been collecting, so every read
 * path and the EOD cron drop a sample. The reading is duplicated into the key's KV
 * metadata so `ivHistory()` can rebuild the series from a single paged `list()`
 * rather than one `get()` per stored day. Metadata is capped at 1024 bytes per
 * key, so it stays three flat numbers — the full sample lives in the value.
 */
async function recordIvSample(ticker, snap, env, { src = null, skipIfPresent = false } = {}) {
  if (!env?.REC_LOG || !snap?.front?.atmIv) return null;
  const key = `iv:${ticker.toUpperCase()}:${ptDate()}`;

  /* PRECEDENCE. The key is one sample per ticker per PT day, last write wins, so
     a second caller does not double-count — but it can DOWNGRADE. `longRow`'s
     warm branch reuses `premium:{TICKER}`, which may be up to 4h old, and an
     11am reading overwriting the 1:15pm cron's live post-close one is a silent
     quality regression in the series `ivRank` is built from.

     So the warm path passes `skipIfPresent` and the cron does not:
       · watchlist names — the 1:15pm cron always wins, whatever the page does
       · off-watchlist names — the cron never touches them, so no sample exists
         and the warm write lands, which is the whole point of the new path
     One extra binding op, only on the branch that can regress the value. */
  if (skipIfPresent) {
    const existing = await env.REC_LOG.get(key);
    if (existing != null) return 'skipped';
  }

  const sample = {
    atmIv:  snap.front.atmIv,
    expiry: snap.front.expiry,
    dte:    snap.front.dte,
    spot:   snap.spot,
    ts:     new Date().toISOString(),
    // Provenance rides in the BODY. It must never go into the metadata, which is
    // capped at 1024 bytes and holds the three flat numbers `ivHistory()` rebuilds
    // the whole series from in one list() pass.
    ...(src ? { src } : {}),
  };
  await env.REC_LOG.put(
    key,
    JSON.stringify(sample),
    {
      expirationTtl: IV_HISTORY_TTL,
      metadata: { atmIv: sample.atmIv, spot: sample.spot, dte: sample.dte },
    },
  );
  return 'written';
}

/** Every stored daily ATM IV for a ticker, read from key metadata in one list pass.
 *  400 days sits under the 1000-key page limit today; the cursor loop is here so a
 *  longer retention later cannot silently truncate the window. */
async function ivHistory(ticker, env) {
  if (!env?.REC_LOG) return [];
  const out = [];
  let cursor;
  do {
    const page = await env.REC_LOG.list({ prefix: `iv:${ticker.toUpperCase()}:`, cursor });
    for (const k of page.keys) {
      const v = k.metadata?.atmIv;
      if (Number.isFinite(v)) out.push(v);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

/* ── Strike ladder for POP ────────────────────────────────────────────────────
   The strategy cards on the research page quote legs as a percentage of spot
   ("sell the 0.92× put"). A probability of profit attached to a strike that does
   not exist, priced off ATM IV rather than the strike's own IV, would be a
   decorative number — puts carry meaningful skew, so a 0.92× put's real IV is
   several points above ATM and its delta with it.

   So the ladder returns real listed strikes with each strike's own IV and a
   delta computed from it. The page snaps its leg to the nearest listed strike
   and reads the delta off this, which is why the card can print a strike you
   could actually trade next to a POP that belongs to it.

   Expiry is the listed one closest to 35 DTE — the middle of the 30–45 DTE band
   those cards are written for. */
const IV_POP_TARGET_DTE = 35;
const IV_POP_BAND       = 0.35;   // keep strikes within ±35% of spot

function popLadder(chainExp, spot, rate, expUnix) {
  const dte = dteOf(expUnix);
  if (!(dte > 0) || !Number.isFinite(spot) || !Number.isFinite(rate)) return null;
  const tYears = dte / 365;

  const byStrike = new Map();
  const add = (list, type) => {
    for (const o of (list || [])) {
      if (!Number.isFinite(o?.strike) || !Number.isFinite(o?.impliedVolatility) || o.impliedVolatility <= 0) continue;
      if (Math.abs(o.strike / spot - 1) > IV_POP_BAND) continue;
      const d = bsDelta({ spot, strike: o.strike, tYears, vol: o.impliedVolatility, rate, type });
      if (d == null) continue;
      const row = byStrike.get(o.strike) || { strike: o.strike };
      row[type === 'put' ? 'putDelta' : 'callDelta'] = +d.toFixed(4);
      row[type === 'put' ? 'putIv'    : 'callIv']    = +(o.impliedVolatility * 100).toFixed(2);
      row[type === 'put' ? 'putBid'   : 'callBid']   = Number.isFinite(o.bid) && o.bid > 0 ? o.bid : null;
      byStrike.set(o.strike, row);
    }
  };
  add(chainExp?.calls, 'call');
  add(chainExp?.puts,  'put');

  const strikes = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  if (!strikes.length) return null;
  return { expiry: expiryIso(expUnix), dte, strikes };
}

async function handleIv(ticker, params, origin, env, ctx) {
  if (!ticker) return err('ticker required', 400, origin);
  const sym = ticker.toUpperCase();

  const rate = await riskFreeRate(env);
  const snap = await ivSnapshot(sym, env, { withLadder: true, rate: rate.rate });

  // HV30 is independent of the chain, so it is still worth returning when a
  // ticker has no listed options — the UI needs to tell "no IV" apart from "no data".
  let hv30 = null;
  try {
    const chart  = await yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}`, '?range=3mo&interval=1d');
    const closes = chart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    hv30 = historicalVol(closes, IV_HV_WINDOW);
  } catch (e) { console.warn('[iv] hv30 failed:', e.message); }

  if (!snap) {
    return json({
      ticker: sym, asOf: new Date().toISOString(),
      spot: null, front: null, back: null,
      termStructure: null, hv30, ivHvRatio: null,
      ivRank: null, historyDays: 0,
      rankMinDays: IV_RANK_MIN_DAYS, rankTargetDays: IV_RANK_TARGET_DAYS,
      rankReason: 'no usable options chain — no implied-vol reading',
      regime: volRegime(null),
      gates: REGIME_GATES,
      pop: null,
      rate: { value: rate.rate, asOf: rate.asOf ?? null, stale: !!rate.stale, reason: rate.reason || null },
      units: 'percent',
      _meta: srcMeta('Yahoo options chain', {
        ok: false, delayed: true, ttlSeconds: TTL.iv,
        note: 'no usable options chain',
      }),
    }, 200, origin);
  }

  // Record before ranking so today's reading is inside its own window.
  try { await recordIvSample(sym, snap, env); }
  catch (e) { console.warn('[iv] sample write failed:', e.message); }

  // Below IV_RANK_MIN_DAYS there is no rank — and no percentile of HV standing in
  // for one, since a stand-in would be indistinguishable from the real thing on
  // screen. `ivRankFrom` is shared with /api/premium so the two cannot drift.
  const history = await ivHistory(sym, env);
  const { ivRank, historyDays, rankReason } = ivRankFrom(history, snap.front.atmIv);
  const ivHvRatio = (hv30 > 0) ? +(snap.front.atmIv / hv30).toFixed(3) : null;

  return json({
    ticker: sym,
    asOf:   new Date().toISOString(),
    spot:   snap.spot,
    front:  snap.front,
    back:   snap.back,
    termStructure: snap.back ? +(snap.front.atmIv - snap.back.atmIv).toFixed(2) : null,
    hv30,
    ivHvRatio,
    ivRank,
    historyDays,
    rankMinDays:    IV_RANK_MIN_DAYS,
    rankTargetDays: IV_RANK_TARGET_DAYS,
    rankReason,
    // The strategy gate travels with the reading it was derived from. It used to
    // be computed in index.html off these same fields; two frontends now need it,
    // and two copies of a threshold is how they drift apart.
    regime: volRegime({ ivRank, ivHvRatio, historyDays, rankTargetDays: IV_RANK_TARGET_DAYS }),
    gates: REGIME_GATES,
    // Real listed strikes with each strike's own IV and a delta computed from it,
    // so the strategy cards can print a POP that belongs to a tradeable strike.
    // Null when there is no risk-free rate — a delta is not guessed at r = 0.
    pop: snap.pop,
    rate: {
      value: rate.rate, pct: rate.pct ?? null, asOf: rate.asOf ?? null,
      source: rate.rate != null ? 'FRED DGS3MO' : null,
      stale: !!rate.stale, reason: rate.reason || null,
    },
    units: 'percent',
    _meta: srcMeta('Yahoo options chain', {
      delayed: true, ttlSeconds: TTL.iv, asOf: snap.front.expiry,
      note: `front ${snap.front.dte}d ATM IV${ivRank == null ? ' · IV rank collecting' : ''}`,
    }),
  }, 200, origin);
}

/* ── Cron: bank one IV reading per watchlist ticker (runs with the EOD job) ──
   IV rank is only ever as good as the history behind it, and page views alone
   would leave gaps on every day nobody opened the ticker. */
async function recordWatchlistIv(env) {
  // The 1:15pm branch spans two cron firings. Writes are idempotent (one key per
  // ticker per PT day) but the chain fetches are not free, so skip the repeat.
  try {
    const last = await env?.REC_LOG?.get('ivsweep:last');
    if (last === ptDate()) { console.log('[cron] iv sweep already ran today, skipping'); return; }
  } catch (_) {}

  let tickers = [...DEFAULT_WATCHLIST];
  try {
    const saved = await env?.REC_LOG?.get('watchlist:tickers', 'json');
    if (Array.isArray(saved) && saved.length) {
      tickers = [...new Set([...saved, ...DEFAULT_WATCHLIST].map(t => String(t).toUpperCase()))];
    }
  } catch (_) {}
  tickers = tickers.slice(0, 50); // each ticker costs 1–2 chain fetches

  let ok = 0;
  for (let i = 0; i < tickers.length; i += 5) {
    const results = await Promise.allSettled(tickers.slice(i, i + 5).map(async (t) => {
      const snap = await ivSnapshot(t, env);
      if (!snap) return false;
      await recordIvSample(t, snap, env);
      return true;
    }));
    ok += results.filter(r => r.status === 'fulfilled' && r.value).length;
  }
  try { await env?.REC_LOG?.put('ivsweep:last', ptDate(), { expirationTtl: 172800 }); } catch (_) {}
  console.log(`[cron] iv samples recorded for ${ok}/${tickers.length} tickers`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   BLACK-SCHOLES DELTA

   Yahoo's chain returns strikes, bids and an implied vol, and no greeks at all.
   Delta has to be computed, and everything downstream leans on it: which strikes
   the premium screen picks, and the POP printed on every short-strike card. A
   quietly wrong delta here would not fail — it would just select the wrong
   strikes and print a confident, wrong probability beside them.

   `node bs-delta.check.mjs` prints computed vs expected for every case rather
   than asserting silently — against Hull's published worked example, against an
   independently implemented series-erf, and against put-call parity. Worst
   deviation 7.0e-8, inside the 7.5e-8 the approximation claims. Run it after any
   edit here.
   ══════════════════════════════════════════════════════════════════════════ */

/** Standard normal CDF — Abramowitz & Stegun 26.2.17, |error| < 7.5e-8.
 *  Workers have no erf, and a cruder approximation shows up directly in delta. */
function normCdf(x) {
  if (!Number.isFinite(x)) return null;
  const b1 = 0.319381530, b2 = -0.356563782, b3 = 1.781477937,
        b4 = -1.821255978, b5 = 1.330274429, p = 0.2316419;
  const invRoot2Pi = 0.3989422804014327;
  const ax = Math.abs(x);
  const t  = 1 / (1 + p * ax);
  const poly = t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  const tail = invRoot2Pi * Math.exp(-ax * ax / 2) * poly;
  return x >= 0 ? 1 - tail : tail;
}

/**
 * Black-Scholes delta for a European option on a non-dividend-paying underlying.
 *
 * `vol` and `rate` are decimals (0.42, 0.043) — NOT the percent this codebase
 * carries IV around in. Yahoo's `impliedVolatility` is already a decimal, so it
 * feeds straight in; anything read off an `atmIv` field must be divided by 100.
 *
 * No dividend yield: Yahoo's chain carries none, and a made-up q would shift
 * every strike selection downstream. American early exercise is likewise ignored
 * — for the OTM strikes this screen selects the difference is immaterial, and
 * the alternative is a binomial tree the data does not justify.
 *
 * Returns null rather than NaN on unusable input, so callers suppress instead of
 * rendering a broken number.
 */
function bsDelta({ spot, strike, tYears, vol, rate = 0, type = 'call' }) {
  if (![spot, strike, tYears, vol, rate].every(Number.isFinite)) return null;
  if (spot <= 0 || strike <= 0 || tYears <= 0 || vol <= 0) return null;
  const sqrtT = Math.sqrt(tYears);
  const d1 = (Math.log(spot / strike) + (rate + vol * vol / 2) * tYears) / (vol * sqrtT);
  const nd1 = normCdf(d1);
  if (nd1 == null) return null;
  // Put-call parity: Δcall − Δput = 1 exactly when there is no dividend yield.
  return type === 'put' ? nd1 - 1 : nd1;
}

/* ── Risk-free rate: FRED DGS3MO ──────────────────────────────────────────────
   The FRED integration above resolves release *dates*; it never fetched a series
   observation, so there was no cached rate to read. This adds one.

   3-month T-bill is the right tenor for 21–45 DTE options. The value is cached
   12h but kept in KV for a week, so a FRED outage degrades to the last real
   print (flagged stale) rather than to a made-up rate — and with no print at all
   the rate is null and the deltas that depend on it are suppressed, not defaulted
   to zero. r = 0 is not a neutral choice; it is a 4-point error that biases every
   call delta down and every put delta up. */
const RATE_KV_KEY  = 'econ:dgs3mo';
const RATE_FRESH_S = 12 * 3600;
/* Retention is 90 days, NOT the 12h freshness window and no longer the 7 days it
   was. FRED is the single upstream that can blank an entire screen: with no rate
   there is no Black-Scholes delta, and with no delta the premium screen has no
   candidate strikes and the long screen has no lanes at all. Suppression is the
   right response to *never having had* a rate — it is a terrible response to a
   transient outage.

   The 3-month T-bill is the slowest-moving input on either screen. A week-old
   print moves a delta in the third decimal; the difference between a 7-day-old
   rate and today's is not a difference anyone would trade on, and it is
   categorically smaller than the difference between a rate and NO SCREEN. So the
   cached print survives 90 days of FRED being unreachable, is flagged `stale`,
   and carries `ageDays` so the card can say how old it is rather than implying
   it is current. Past 90 days the key expires and deltas suppress — at which
   point the value really would be doing more harm than good. */
const RATE_KEEP_S  = 90 * 24 * 3600;

/** Age of a stored rate in whole days, for display. */
const rateAgeDays = ts => Number.isFinite(ts) ? Math.max(0, Math.round((Date.now() - ts) / 86_400_000)) : null;

async function riskFreeRate(env) {
  let cached = null;
  try { cached = await env?.REC_LOG?.get(RATE_KV_KEY, 'json'); } catch (_) {}
  if (cached?.rate != null && Date.now() - (cached.ts || 0) < RATE_FRESH_S * 1000) {
    return { ...cached, stale: false, ageDays: rateAgeDays(cached.ts) };
  }

  const key = env?.FRED_API_KEY;
  if (!key) {
    return cached?.rate != null
      ? { ...cached, stale: true, ageDays: rateAgeDays(cached.ts),
          reason: `FRED_API_KEY not configured — using the last stored print from ${cached.asOf} `
                + `(${rateAgeDays(cached.ts)}d old). Deltas are computed from it rather than suppressed.` }
      : { rate: null, asOf: null, ageDays: null, reason: 'FRED_API_KEY not configured and no stored print' };
  }

  try {
    const u = `https://api.stlouisfed.org/fred/series/observations?series_id=DGS3MO`
            + `&api_key=${encodeURIComponent(key)}&file_type=json&sort_order=desc&limit=10`;
    const r = await fetch(u);
    if (!r.ok) throw new Error(`FRED observations ${r.status}`);
    // DGS3MO is not published on market holidays; those rows carry "." as the value.
    const obs = ((await r.json())?.observations || []).find(o => o?.value && o.value !== '.');
    const pct = Number(obs?.value);
    if (!Number.isFinite(pct)) throw new Error('no numeric DGS3MO observation in the last 10 rows');

    const fresh = { rate: +(pct / 100).toFixed(6), pct, asOf: obs.date, ts: Date.now(), source: 'FRED DGS3MO' };
    try { await env?.REC_LOG?.put(RATE_KV_KEY, JSON.stringify(fresh), { expirationTtl: RATE_KEEP_S }); } catch (_) {}
    return { ...fresh, stale: false, ageDays: 0 };
  } catch (e) {
    console.warn('[rate] DGS3MO fetch failed:', e.message);
    // Degrade to the stored print for up to RATE_KEEP_S rather than blanking every
    // delta on both screens. The age rides along so the card states it.
    return cached?.rate != null
      ? { ...cached, stale: true, ageDays: rateAgeDays(cached.ts),
          reason: `FRED unavailable (${e.message}) — using the last stored print from ${cached.asOf} `
                + `(${rateAgeDays(cached.ts)}d old). The 3-month bill moves too slowly for this to change a strike.` }
      : { rate: null, asOf: null, ageDays: null, reason: `FRED unavailable and no stored print: ${e.message}` };
  }
}

/* ── Volatility regime ────────────────────────────────────────────────────────
   Lives here rather than in the page because two frontends now gate on it, and
   two copies of a threshold is how they drift apart. `index.html` reads it off
   the /api/iv payload; the premium screen reads it off /api/premium.

   Absolute IV cutoffs are meaningless across tickers — a 45% print is calm for
   one name and extreme for another — so the gate is always *relative*. IV rank is
   the real measure. Until enough history exists for it, IV/HV30 stands in and
   every surface that shows it says so; the two are never conflated. */
const IVR_HIGH   = 70,  IVR_LOW   = 30;    // IV-rank gates, in points
const RATIO_HIGH = 1.2, RATIO_LOW = 0.9;   // IV/HV30 proxy gates
const IVR_SELL_MIN = 50;                   // below this the premium screen dims the row

const REGIME_GATES = {
  ivrHigh: IVR_HIGH, ivrLow: IVR_LOW,
  ratioHigh: RATIO_HIGH, ratioLow: RATIO_LOW,
  ivrSellMin: IVR_SELL_MIN,
};

function volRegime(iv) {
  if (iv && iv.ivRank != null) {
    const pts = iv.ivRank * 100;
    return {
      state: pts >= IVR_HIGH ? 'elevated' : pts <= IVR_LOW ? 'depressed' : 'normal',
      label: `IV regime: IV rank ${pts.toFixed(0)} · ${iv.historyDays}d history`,
      rankPts: +pts.toFixed(1),
      provisional: false,
    };
  }
  if (iv && iv.ivHvRatio != null) {
    const r = iv.ivHvRatio;
    return {
      state: r >= RATIO_HIGH ? 'elevated' : r <= RATIO_LOW ? 'depressed' : 'normal',
      label: `IV regime: proxy (IV/HV30 ${r.toFixed(2)}×) — rank collecting, ${iv.historyDays}/${iv.rankTargetDays ?? IV_RANK_TARGET_DAYS}d`,
      rankPts: null,
      provisional: true,
    };
  }
  return { state: 'unavailable', label: 'IV regime unavailable', rankPts: null, provisional: false };
}

/* ═══════════════════════════════════════════════════════════════════════════
   SEC EDGAR — insider Form 4 and super-investor 13F

   EDGAR is free and authoritative, and it 403s any request without a
   User-Agent carrying a real contact address. That constant is not decorative:
   change the email and the whole section stops working.

   Workers have no DOMParser, so the XML is read with narrow regex helpers.
   They tolerate namespace prefixes (<ns1:infoTable>) because filers use them
   inconsistently.
   ══════════════════════════════════════════════════════════════════════════ */

const SEC_UA = 'trading-dash/1.0 (ambermlysak@gmail.com)';
const SEC_MIN_GAP_MS = 120;      // SEC asks for ≤10 req/s; this stays well under
const CIK_MAP_TTL    = 30 * 24 * 3600;
const INSIDER_TTL    = 12 * 3600;
const INSIDER_WINDOW_DAYS = 90;
const CLUSTER_WINDOW_DAYS = 30;
const CLUSTER_MIN_BUYERS  = 3;
const LARGE_BUY_USD       = 500_000;

let _secLast = 0;
async function secFetch(url, asText = false) {
  const wait = SEC_MIN_GAP_MS - (Date.now() - _secLast);
  if (wait > 0) await sleep(wait);
  _secLast = Date.now();
  const r = await fetch(url, {
    headers: {
      'User-Agent': SEC_UA,
      'Accept': asText ? 'application/xml, text/xml, */*' : 'application/json, */*',
      'Accept-Encoding': 'gzip, deflate',
    },
  });
  if (!r.ok) throw new Error(`SEC ${r.status} ${url.replace('https://', '').slice(0, 80)}`);
  return asText ? r.text() : r.json();
}

/* ── tiny XML readers (namespace-tolerant) ── */
const xmlBlock = (s, tag) => {
  const m = s?.match(new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`));
  return m ? m[1] : null;
};
const xmlBlocks = (s, tag) =>
  [...(s || '').matchAll(new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'g'))]
    .map(m => m[1]);
const xmlText = (s, tag) => {
  const b = xmlBlock(s, tag);
  if (b == null) return null;
  return b
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim() || null;
};
/** Form 4 wraps most leaf values in <value>; fall back to the raw text. */
const xmlValue = (s, tag) => {
  const b = xmlBlock(s, tag);
  if (b == null) return null;
  const v = xmlBlock(b, 'value');
  const out = (v ?? b).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return out || null;
};
const xmlNum = (s, tag) => {
  const t = xmlValue(s, tag);
  if (t == null) return null;
  const n = Number(t.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Ticker → zero-padded 10-digit CIK, from SEC's own file. Cached 30 days. */
async function getCikMap(env) {
  try {
    const cached = await env?.REC_LOG?.get('cik:map', 'json');
    if (cached && typeof cached === 'object' && Object.keys(cached).length) return cached;
  } catch (_) {}

  const data = await secFetch('https://www.sec.gov/files/company_tickers.json');
  const map = {};
  for (const row of Object.values(data || {})) {
    if (!row?.ticker || row.cik_str == null) continue;
    map[String(row.ticker).toUpperCase()] = String(row.cik_str).padStart(10, '0');
  }
  if (!Object.keys(map).length) throw new Error('SEC ticker file parsed to zero entries');
  try { await env?.REC_LOG?.put('cik:map', JSON.stringify(map), { expirationTtl: CIK_MAP_TTL }); } catch (_) {}
  return map;
}

const cikToPath = cik => String(Number(cik));   // EDGAR archive paths drop leading zeros

/* ── Insider trades: Form 4 ────────────────────────────────────────────────
   Yahoo's insiderTransactions is a thin summary with free-text descriptions;
   Form 4 carries the actual transaction code, price, and post-transaction
   holdings, which is what makes an open-market buy distinguishable from a
   grant. Transaction codes: P = open-market purchase, S = sale, A = award/grant,
   M = option exercise, F = shares withheld for tax. */
const TXN_CODE_LABEL = {
  P: 'Open-market buy', S: 'Sale', A: 'Grant / award', M: 'Option exercise',
  F: 'Tax withholding', G: 'Gift', C: 'Conversion', X: 'Option exercise',
};

async function parseForm4(url) {
  const xml = await secFetch(url, true);
  const doc = xmlBlock(xml, 'ownershipDocument') || xml;

  const owners = xmlBlocks(doc, 'reportingOwner').map(o => {
    const rel = xmlBlock(o, 'reportingOwnerRelationship') || '';
    return {
      name:     xmlText(xmlBlock(o, 'reportingOwnerId') || '', 'rptOwnerName'),
      isOfficer:  /<(?:\w+:)?isOfficer>\s*(?:1|true)\s*</i.test(rel),
      isDirector: /<(?:\w+:)?isDirector>\s*(?:1|true)\s*</i.test(rel),
      isTenPct:   /<(?:\w+:)?isTenPercentOwner>\s*(?:1|true)\s*</i.test(rel),
      title:    xmlText(rel, 'officerTitle'),
    };
  });
  const owner = owners[0] || { name: null };

  const txns = [];
  // Non-derivative only: derivative rows are options grants and exercises, which
  // say far less about conviction than an open-market purchase of stock.
  const table = xmlBlock(doc, 'nonDerivativeTable') || '';
  for (const t of xmlBlocks(table, 'nonDerivativeTransaction')) {
    const code   = xmlValue(xmlBlock(t, 'transactionCoding') || '', 'transactionCode');
    const amts   = xmlBlock(t, 'transactionAmounts') || '';
    const shares = xmlNum(amts, 'transactionShares');
    const price  = xmlNum(amts, 'transactionPricePerShare');
    const ad     = xmlValue(amts, 'transactionAcquiredDisposedCode');
    const post   = xmlNum(xmlBlock(t, 'postTransactionAmounts') || '', 'sharesOwnedFollowingTransaction');
    const date   = xmlValue(t, 'transactionDate');
    if (!code || shares == null) continue;
    txns.push({
      date, code,
      label:      TXN_CODE_LABEL[code] || `Code ${code}`,
      shares,
      price:      price ?? null,
      value:      (price != null && shares != null) ? +(price * shares).toFixed(2) : null,
      acquired:   ad === 'A',
      sharesAfter: post ?? null,
      owner:      owner.name,
      isOfficer:  owner.isOfficer,
      isDirector: owner.isDirector,
      isTenPct:   owner.isTenPct,
      title:      owner.title,
    });
  }
  return txns;
}

async function buildInsiderReport(ticker, env) {
  const map = await getCikMap(env);
  const cik = map[ticker.toUpperCase()];
  if (!cik) return { ok: false, reason: `no SEC CIK on file for ${ticker.toUpperCase()}` };

  const sub = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const rec = sub?.filings?.recent || {};
  const cutoff = isoAddDays(etToday(), -INSIDER_WINDOW_DAYS);

  const wanted = [];
  for (let i = 0; i < (rec.form || []).length; i++) {
    if (rec.form[i] !== '4') continue;
    if ((rec.filingDate?.[i] || '') < cutoff) continue;
    wanted.push({
      accession: String(rec.accessionNumber[i]).replace(/-/g, ''),
      doc:       rec.primaryDocument?.[i] || '',
      filed:     rec.filingDate[i],
    });
  }
  if (!wanted.length) {
    return { ok: true, transactions: [], filings: 0, windowDays: INSIDER_WINDOW_DAYS,
             cik, companyName: sub?.name || null };
  }

  const txns = [];
  let failed = 0;
  for (const f of wanted.slice(0, 60)) {   // cap subrequests on heavily-filed names
    // primaryDocument is sometimes the XSL viewer path (xslF345X03/doc.xml);
    // the raw XML sits at the filing root under the same filename.
    const file = f.doc.includes('/') ? f.doc.slice(f.doc.lastIndexOf('/') + 1) : f.doc;
    if (!file.toLowerCase().endsWith('.xml')) { failed++; continue; }
    try {
      const rows = await parseForm4(
        `https://www.sec.gov/Archives/edgar/data/${cikToPath(cik)}/${f.accession}/${file}`);
      for (const r of rows) txns.push({ ...r, filed: f.filed });
    } catch (_) { failed++; }
  }

  txns.sort((a, b) => String(b.date || b.filed).localeCompare(String(a.date || a.filed)));

  // Cluster buying: distinct insiders making open-market purchases inside a
  // rolling 30-day window. One insider buying repeatedly is not a cluster.
  const buys = txns.filter(t => t.code === 'P');
  let cluster = null;
  for (const anchor of buys) {
    const from = isoAddDays(anchor.date || anchor.filed, -CLUSTER_WINDOW_DAYS);
    const names = new Set(
      buys.filter(b => (b.date || b.filed) >= from && (b.date || b.filed) <= (anchor.date || anchor.filed))
          .map(b => b.owner).filter(Boolean));
    if (names.size >= CLUSTER_MIN_BUYERS && (!cluster || names.size > cluster.buyers)) {
      cluster = { buyers: names.size, through: anchor.date || anchor.filed, names: [...names] };
    }
  }

  const largeBuys = buys.filter(t => t.value != null && t.value >= LARGE_BUY_USD);
  const sells     = txns.filter(t => t.code === 'S');
  const sum = arr => arr.reduce((a, t) => a + (t.value || 0), 0);

  return {
    ok: true,
    cik,
    companyName: sub?.name || null,
    windowDays:  INSIDER_WINDOW_DAYS,
    filings:     wanted.length,
    parseFailures: failed,
    transactions: txns.slice(0, 40),
    summary: {
      buyCount: buys.length, sellCount: sells.length,
      buyValue: +sum(buys).toFixed(2), sellValue: +sum(sells).toFixed(2),
      netValue: +(sum(buys) - sum(sells)).toFixed(2),
    },
    cluster,
    largeBuys: largeBuys.slice(0, 5).map(t => ({
      owner: t.owner, date: t.date, value: t.value, shares: t.shares, price: t.price, title: t.title,
    })),
  };
}

async function handleInsider(ticker, params, origin, env, ctx) {
  if (!ticker) return err('ticker required', 400, origin);
  const sym = ticker.toUpperCase();
  const key = `insider:${sym}`;

  if (params.get('refresh') !== '1') {
    try {
      const cached = await env?.REC_LOG?.get(key, 'json');
      if (cached) return json({ ...cached, cached: true }, 200, origin);
    } catch (_) {}
  }

  let payload;
  try {
    const r = await buildInsiderReport(sym, env);
    payload = r.ok
      ? { ticker: sym, ...r, _meta: srcMeta('SEC EDGAR Form 4', { ttlSeconds: TTL.insider, note: `last ${INSIDER_WINDOW_DAYS} days` }) }
      : { ticker: sym, unavailable: true, reason: r.reason,
          _meta: srcMeta('SEC EDGAR Form 4', { ok: false, ttlSeconds: TTL.insider, note: r.reason }) };
  } catch (e) {
    // No fallback to a lesser source and no generated stand-in: say what broke.
    return json({
      ticker: sym, unavailable: true, reason: `SEC EDGAR unavailable: ${e.message}`,
      _meta: srcMeta('SEC EDGAR Form 4', { ok: false, ttlSeconds: TTL.insider, note: e.message }),
    }, 200, origin);
  }

  if (ctx) ctx.waitUntil(
    env?.REC_LOG?.put(key, JSON.stringify(payload), { expirationTtl: INSIDER_TTL }).catch(() => {}));
  return json(payload, 200, origin);
}

/* ── Super-investor 13F ────────────────────────────────────────────────────
   A fixed roster of managers worth watching, by SEC CIK. 13F-HR is filed 45
   days after quarter end, so everything here is stale by construction — the
   card says so rather than implying it is current positioning.

   EVERY CIK BELOW WAS VERIFIED against data.sec.gov/submissions/CIK{n}.json —
   the returned `name` matches the firm and the filing history contains 13F-HR.
   That check is not optional: the first draft of this list was written from
   memory and 7 of 18 entries were wrong, several of them pointing at real but
   unrelated managers (Third Point's CIK returned Two Sigma, ARK's returned
   ValueAct). A wrong CIK does not fail loudly — it silently attributes one
   manager's book to another. Re-verify before adding a name. */
const SUPER_INVESTORS = [
  { cik: '0001067983', name: 'Warren Buffett',        firm: 'Berkshire Hathaway' },
  { cik: '0001649339', name: 'Michael Burry',         firm: 'Scion Asset Mgmt' },
  { cik: '0001006438', name: 'David Tepper',          firm: 'Appaloosa Management' },
  { cik: '0001336528', name: 'Bill Ackman',           firm: 'Pershing Square' },
  { cik: '0001536411', name: 'Stanley Druckenmiller', firm: 'Duquesne Family Office' },
  { cik: '0001167483', name: 'Chase Coleman',         firm: 'Tiger Global' },
  { cik: '0001135730', name: 'Philippe Laffont',      firm: 'Coatue Management' },
  { cik: '0001061165', name: 'Stephen Mandel',        firm: 'Lone Pine Capital' },
  { cik: '0001061768', name: 'Seth Klarman',          firm: 'Baupost Group' },
  { cik: '0001037389', name: 'Jim Simons',            firm: 'Renaissance Technologies' },
  { cik: '0001423053', name: 'Ken Griffin',           firm: 'Citadel Advisors' },
  { cik: '0001350694', name: 'Ray Dalio',             firm: 'Bridgewater Associates' },
  { cik: '0001040273', name: 'Daniel Loeb',           firm: 'Third Point' },
  { cik: '0001697748', name: 'Cathie Wood',           firm: 'ARK Investment Mgmt' },
  { cik: '0001112520', name: 'Chuck Akre',            firm: 'Akre Capital Mgmt' },
  { cik: '0000807249', name: 'Mario Gabelli',         firm: 'GAMCO Investors' },
  { cik: '0001179392', name: 'Two Sigma',             firm: 'Two Sigma Investments' },
  { cik: '0001418814', name: 'ValueAct',              firm: 'ValueAct Holdings' },
  { cik: '0001079114', name: 'David Einhorn',         firm: 'Greenlight Capital' },
  { cik: '0001173334', name: 'Mohnish Pabrai',        firm: 'Pabrai Investment Funds' },
];

const THIRTEENF_KEY   = '13f:index';
const THIRTEENF_TTL   = 100 * 24 * 3600;   // rebuilt quarterly; TTL is a backstop
const THIRTEENF_TOP_N = 150;               // largest positions per manager

/** Normalise an issuer name so 13F text can be matched to SEC's company titles. */
function normIssuer(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/&AMP;/g, '&')
    .replace(/[.,'"]/g, '')
    .replace(/\b(THE|COM|COMMON|STOCK|SHARES?|CL|CLASS|[A-C]|INC|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|LP|LLC|HOLDINGS?|GROUP|TRUST|NEW|SA|NV|AG)\b/g, ' ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Latest 13F-HR information table for one manager. */
async function fetch13F(cik) {
  const sub = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const rec = sub?.filings?.recent || {};
  let idx = -1;
  for (let i = 0; i < (rec.form || []).length; i++) {
    if (rec.form[i] === '13F-HR') { idx = i; break; }   // `recent` is newest-first
  }
  if (idx < 0) return null;

  const accession = String(rec.accessionNumber[idx]).replace(/-/g, '');
  const dir = `https://www.sec.gov/Archives/edgar/data/${cikToPath(cik)}/${accession}`;

  // The information table is a separate XML from the cover page; find it by name.
  const listing = await secFetch(`${dir}/index.json`);
  const files = (listing?.directory?.item || []).map(f => f.name || '');
  const info = files.find(n => /infotable.*\.xml$/i.test(n))
            || files.find(n => /\.xml$/i.test(n) && !/primary_doc/i.test(n));
  if (!info) return null;

  const xml = await secFetch(`${dir}/${info}`, true);
  const holdings = [];
  for (const b of xmlBlocks(xml, 'infoTable')) {
    const name  = xmlText(b, 'nameOfIssuer');
    const cusip = xmlText(b, 'cusip');
    // Post-2023 amendments report value in whole dollars (previously thousands).
    const value = xmlNum(b, 'value');
    const shrs  = xmlBlock(b, 'shrsOrPrnAmt') || '';
    const shares = xmlNum(shrs, 'sshPrnamt');
    const kind   = xmlText(shrs, 'sshPrnamtType');
    if (!name || !cusip || kind !== 'SH') continue;   // SH only: skip principal amounts
    holdings.push({ name, cusip, value: value ?? null, shares: shares ?? null });
  }
  holdings.sort((a, b) => (b.value || 0) - (a.value || 0));

  return {
    quarter:  rec.reportDate?.[idx] || null,
    filed:    rec.filingDate?.[idx] || null,
    holdings: holdings.slice(0, THIRTEENF_TOP_N),
  };
}

/**
 * Build the ticker → managers reverse index.
 *
 * There is no free CUSIP→ticker table, so the mapping is built opportunistically
 * by matching the filing's issuer name against SEC's own company titles.
 * Coverage is partial by design; anything unresolved is counted and reported
 * rather than guessed at.
 */
/* ── 13F index: built a few managers at a time ───────────────────────────────
   The old `build13FIndex` walked all 20 managers in one invocation: 1 fetch for
   the issuer-name table plus 3 SEC round trips each = 61, against the Free plan's
   50-subrequest cap in force at the time. (The cap is now 10,000 on Paid and 61
   would fit — the slicing stays because the *failure mode* it fixed was a
   per-manager catch reporting partial data as complete, which no ceiling fixes.)

   It did not fail. `fetch13F` is wrapped in a per-manager try/catch that logs and
   continues, so the cap error was swallowed 4 times and the function returned
   NORMALLY with 16 of 20 managers — and `refresh13FIndex` wrote that partial
   index to KV as if it were complete. Worse, the four dropped managers were
   recorded as `{ ok: false }`, which is the same shape used for a manager who
   genuinely filed nothing: the card reported "16/20 managers filed", blaming the
   managers for our own budget overrun. Verified by stubbing secFetch to throw the
   real cap error after 50 calls — always the same last four (Two Sigma, ValueAct,
   Greenlight, Pabrai), because the loop order is fixed.

   Now: THIRTEENF_BATCH managers per firing, merged into the stored index rather
   than rebuilding it. 13F data changes quarterly, so a pass taking several
   firings costs nothing. Per-manager holdings are kept in `byManager` and the
   ticker→managers index is derived from it, so one manager can be replaced
   without touching the others. */
const THIRTEENF_BATCH  = 4;             // 4 × 3 + 1 = 13 subrequests per firing
const THIRTEENF_CURSOR = '13f:cursor';  // deliberately outside the 13f:index key

/** Issuer-name → ticker, from SEC's company_tickers.json. One fetch. */
async function issuerNameMap() {
  const raw = await secFetch('https://www.sec.gov/files/company_tickers.json');
  const byName = new Map();
  for (const row of Object.values(raw || {})) {
    if (!row?.ticker || !row?.title) continue;
    const n = normIssuer(row.title);
    if (n && !byName.has(n)) byName.set(n, String(row.ticker).toUpperCase());
  }
  return byName;
}

/** Collapse one manager's 13F rows into per-ticker positions.
 *  A 13F reports one issuer across several rows — separate accounts, share
 *  classes and discretion categories each file their own line — so rows are
 *  summed. Listing them would show Berkshire holding Apple four times. */
function foldHoldings(filing, byName, cikMap) {
  const perTicker = new Map();
  let resolved = 0, unresolved = 0;
  for (const h of filing.holdings) {
    const t = byName.get(normIssuer(h.name));
    if (!t || !cikMap[t]) { unresolved++; continue; }
    resolved++;
    const cur = perTicker.get(t) || { shares: 0, value: 0, rows: 0, cusip: h.cusip };
    cur.shares += h.shares || 0;
    cur.value  += h.value  || 0;
    cur.rows   += 1;
    perTicker.set(t, cur);
  }
  return {
    resolved, unresolved,
    positions: [...perTicker].map(([ticker, a]) => ({
      ticker, shares: a.shares || null, value: a.value || null, rows: a.rows, cusip: a.cusip,
    })),
  };
}

/** Rebuild the ticker→managers reverse index from per-manager positions. */
function derive13FIndex(byManager) {
  const index = {};
  for (const rec of Object.values(byManager || {})) {
    if (!rec?.ok) continue;
    for (const p of (rec.positions || [])) {
      (index[p.ticker] ||= []).push({
        manager: rec.name, firm: rec.firm, cik: rec.cik,
        shares: p.shares, value: p.value, rows: p.rows, cusip: p.cusip,
        quarter: rec.quarter, filed: rec.filed,
      });
    }
  }
  for (const t of Object.keys(index)) index[t].sort((a, b) => (b.value || 0) - (a.value || 0));
  return index;
}

/**
 * Refresh one slice of managers and merge. Runs on the 3pm PT firing.
 * Spends ~13 subrequests, so it can never truncate the way the old build did —
 * and if a manager genuinely fails, only that manager is marked failed.
 */
async function refresh13FSlice(env) {
  let store = null, cursor = null;
  try { store  = await env?.REC_LOG?.get(THIRTEENF_KEY, 'json'); } catch (_) {}
  try { cursor = await env?.REC_LOG?.get(THIRTEENF_CURSOR, 'json'); } catch (_) {}

  // A store from before the incremental rewrite has no byManager; start it over
  // rather than trying to reinterpret a shape that was partial anyway.
  if (!store?.byManager) store = { byManager: {}, index: {}, builtAt: null, lastFullPass: null };
  let at = Number.isInteger(cursor?.at) ? cursor.at : 0;
  if (at >= SUPER_INVESTORS.length) at = 0;
  const passStartedAt = cursor?.passStartedAt || new Date().toISOString();

  const batch = SUPER_INVESTORS.slice(at, at + THIRTEENF_BATCH);
  if (!batch.length) return;

  const cikMap = await getCikMap(env);
  let byName;
  try { byName = await issuerNameMap(); }
  catch (e) { console.warn('[13f] issuer map failed, slice skipped:', e.message); return; }

  for (const inv of batch) {
    let f = null, failReason = null;
    try { f = await fetch13F(inv.cik); }
    catch (e) { failReason = e.message; console.warn(`[13f] ${inv.firm}: ${e.message}`); }

    if (!f) {
      // Keep any previous good record rather than replacing it with a failure —
      // a transient SEC hiccup should not blank a manager that was already indexed.
      const prev = store.byManager[inv.cik];
      store.byManager[inv.cik] = prev?.ok
        ? { ...prev, lastError: failReason || 'no 13F-HR found', lastTriedAt: new Date().toISOString() }
        : { ...inv, ok: false, reason: failReason || 'no 13F-HR filing found', lastTriedAt: new Date().toISOString() };
      continue;
    }

    const folded = foldHoldings(f, byName, cikMap);
    store.byManager[inv.cik] = {
      ...inv, ok: true,
      quarter: f.quarter, filed: f.filed,
      positions: folded.positions,
      resolved: folded.resolved, unresolved: folded.unresolved,
      refreshedAt: new Date().toISOString(),
      lastError: null,
    };
  }

  store.index = derive13FIndex(store.byManager);

  const recs = Object.values(store.byManager);
  const okRecs = recs.filter(r => r.ok);
  store.managers = SUPER_INVESTORS.map((inv) => {
    const r = store.byManager[inv.cik];
    return r
      ? { name: inv.name, firm: inv.firm, cik: inv.cik, ok: !!r.ok,
          quarter: r.quarter ?? null, filed: r.filed ?? null,
          positions: r.positions?.length ?? 0, refreshedAt: r.refreshedAt ?? null,
          reason: r.ok ? null : (r.reason || r.lastError || null) }
      : { name: inv.name, firm: inv.firm, cik: inv.cik, ok: false,
          quarter: null, filed: null, positions: 0, refreshedAt: null,
          reason: 'not yet fetched — the index is still filling in' };
  });
  store.stats = {
    resolved:   okRecs.reduce((a, r) => a + (r.resolved   || 0), 0),
    unresolved: okRecs.reduce((a, r) => a + (r.unresolved || 0), 0),
    tickers: Object.keys(store.index).length,
    managersOk: okRecs.length,
    managersTotal: SUPER_INVESTORS.length,
    // Distinguishes "we have not reached this manager" from "this manager failed".
    managersNotFetched: SUPER_INVESTORS.length - recs.length,
  };
  store.builtAt = new Date().toISOString();

  const next = at + THIRTEENF_BATCH;
  const wrapped = next >= SUPER_INVESTORS.length;
  if (wrapped) store.lastFullPass = new Date().toISOString();

  try {
    await env?.REC_LOG?.put(THIRTEENF_KEY, JSON.stringify(store), { expirationTtl: THIRTEENF_TTL });
    await env?.REC_LOG?.put(THIRTEENF_CURSOR, JSON.stringify({
      at: wrapped ? 0 : next,
      passStartedAt: wrapped ? null : passStartedAt,
    }), { expirationTtl: THIRTEENF_TTL });
  } catch (e) { console.warn('[13f] write failed:', e.message); }

  console.log(`[13f] slice ${at}–${Math.min(next, SUPER_INVESTORS.length) - 1} done · `
            + `${store.stats.managersOk}/${store.stats.managersTotal} represented · `
            + `${store.stats.tickers} tickers${wrapped ? ' · full pass complete' : ''}`);
}

/** Runs every 3pm PT firing. A slice is cheap, so it advances whenever the index
 *  is mid-pass, and only idles once a complete pass is recent. */
async function refresh13FIndexIfStale(env) {
  try {
    const cursor = await env?.REC_LOG?.get(THIRTEENF_CURSOR, 'json');
    const store  = await env?.REC_LOG?.get(THIRTEENF_KEY, 'json');
    const midPass = Number.isInteger(cursor?.at) && cursor.at > 0;
    const recent  = store?.lastFullPass && Date.now() - Date.parse(store.lastFullPass) < 7 * 86_400_000;
    if (!midPass && recent) { console.log('[13f] full pass recent, skipping'); return; }
  } catch (_) {}
  await refresh13FSlice(env);
}

async function handle13F(ticker, params, origin, env, ctx) {
  if (!ticker) return err('ticker required', 400, origin);
  const sym = ticker.toUpperCase();

  let store = null, cursor = null;
  try { store  = await env?.REC_LOG?.get(THIRTEENF_KEY, 'json'); } catch (_) {}
  try { cursor = await env?.REC_LOG?.get(THIRTEENF_CURSOR, 'json'); } catch (_) {}

  // One slice per request at most: a slice is ~13 subrequests and the caller is
  // not made to wait for it. `refresh=1` advances the pass by one batch, it does
  // not rebuild everything — that is what put the old version over the cap.
  if (params.get('refresh') === '1' && ctx) ctx.waitUntil(refresh13FSlice(env));

  if (!store?.index) {
    if (ctx) ctx.waitUntil(refresh13FSlice(env));
    return json({
      ticker: sym, unavailable: true, building: true,
      reason: `13F index has not started filling in yet. It is built ${THIRTEENF_BATCH} managers at a `
            + `time on the daily 3pm PT job — SEC round trips do not fit in one run — so first `
            + `coverage appears within a few runs.`,
      _meta: srcMeta('SEC EDGAR 13F-HR', { ok: false, ttlSeconds: TTL.thirteenF, note: 'index building' }),
    }, 200, origin);
  }

  const holders = store.index?.[sym] || [];
  const quarters = [...new Set(holders.map(h => h.quarter).filter(Boolean))].sort();

  // The card has to be able to say how much of the manager list is actually
  // behind this answer. The old build silently dropped 4 of 20 and reported the
  // survivors as "16/20 managers filed" — attributing our budget overrun to the
  // managers' filing behaviour.
  const st = store.stats || {};
  const coverage = {
    ...st,
    managersRepresented: st.managersOk ?? 0,
    managersTotal: st.managersTotal ?? SUPER_INVESTORS.length,
    managersNotFetched: st.managersNotFetched ?? 0,
    managersFailed: (st.managersTotal ?? SUPER_INVESTORS.length)
                    - (st.managersOk ?? 0) - (st.managersNotFetched ?? 0),
    lastFullPass: store.lastFullPass || null,
    passInProgress: Number.isInteger(cursor?.at) && cursor.at > 0,
    passPosition: Number.isInteger(cursor?.at) ? cursor.at : 0,
    batchSize: THIRTEENF_BATCH,
  };

  return json({
    ticker: sym,
    holders,
    // An unmapped ticker is reported as unmapped. It must never render as
    // "no institutional interest", which is a different and much stronger claim.
    mapped: holders.length > 0,
    coverage,
    managers: store.managers,
    builtAt: store.builtAt,
    _meta: srcMeta('SEC EDGAR 13F-HR', {
      ttlSeconds: TTL.thirteenF,
      asOf: quarters.at(-1) || null,
      ok: coverage.managersRepresented > 0,
      note: `${coverage.managersRepresented}/${coverage.managersTotal} managers indexed`
          + (coverage.passInProgress ? ' · pass in progress' : '')
          + (holders.length ? ` · quarter ending ${quarters.at(-1)}` : ' · no mapped holdings'),
    }),
  }, 200, origin);
}

/* ── Short interest: FINRA consolidated, official and biweekly ─────────────
   FINRA publishes settled short interest twice a month with roughly a two-week
   reporting lag. That lag is a property of the data, not a defect, and the
   settlement date travels with the payload so the card can show it.

   Yahoo's shortPercentOfFloat is a single unofficial snapshot with no history,
   which is why FINRA is primary: the 6-period series the MoM chart needs does
   not exist in Yahoo at all. */
const FINRA_TOKEN_URL = 'https://ews.fip.finra.org/fip/rest/ews/oauth2/access_token?grant_type=client_credentials';
const FINRA_DATA_URL  = 'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest';
const SHORT_TTL       = 6 * 3600;
const SHORT_PERIODS   = 6;

async function finraToken(env) {
  const id     = env?.FINRA_CLIENT_ID     || env?.FINRA_API_KEY;
  const secret = env?.FINRA_CLIENT_SECRET || env?.FINRA_API_SECRET;
  if (!id || !secret) throw new Error('FINRA credentials not configured');

  const cached = await env?.REC_LOG?.get('finra:token', 'json').catch(() => null);
  if (cached?.token && cached.exp > Date.now() + 60_000) return cached.token;

  const r = await fetch(FINRA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${btoa(`${id}:${secret}`)}`, 'Accept': 'application/json' },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    console.error(`[finra] auth failed ${r.status} at ${FINRA_TOKEN_URL}: ${String(t).slice(0, 300)}`);
    throw new Error(`FINRA auth ${r.status}`);
  }
  const d = await r.json();
  if (!d?.access_token) throw new Error('FINRA auth returned no token');
  console.log(`[finra] auth ok, token expires in ${d.expires_in || '?'}s`);

  const exp = Date.now() + Math.max(60, (d.expires_in || 1800) - 60) * 1000;
  try {
    await env?.REC_LOG?.put('finra:token', JSON.stringify({ token: d.access_token, exp }),
      { expirationTtl: Math.max(120, (d.expires_in || 1800) - 60) });
  } catch (_) {}
  return d.access_token;
}

/**
 * Field names CONFIRMED against a live 200 response, not taken from prose.
 *
 * Row 0 of otcMarket/consolidatedShortInterest returns:
 *   stockSplitFlag, previousShortPositionQuantity, averageDailyVolumeQuantity,
 *   issueName, currentShortPositionQuantity, changePreviousNumber,
 *   accountingYearMonthNumber, settlementDate, marketClassCode, symbolCode,
 *   daysToCoverQuantity, issuerServicesGroupExchangeCode, revisionFlag, changePercent
 *
 * The first name in each list is the confirmed one; the rest are documented
 * aliases kept as a cushion in case the dataset is versioned. The row-0 key log
 * below stays in place — it is what turned a blind 400 into a one-cycle fix.
 */
const FINRA_FIELDS = {
  settlementDate: ['settlementDate', 'settleDate', 'settlementDt'],
  shares:         ['currentShortPositionQuantity', 'shortVolume', 'currentShortPosition'],
  priorShares:    ['previousShortPositionQuantity', 'previousShortVolume', 'previousShortPosition'],
  avgDailyVolume: ['averageDailyVolumeQuantity', 'avgDailyVolume', 'averageDailyVolume'],
  daysToCover:    ['daysToCoverQuantity', 'daystoCover', 'daysToCover'],
};
// Confirmed from FINRA's own /metadata endpoint, not from documentation prose:
// the dataset exposes `symbolCode`, and `symbol` 400s with "fields are not
// available in this dataset". The original 400 was never this field — it was
// sortFields on `settlementDate`, which metadata lists under partitionFields
// and which therefore cannot be sorted without a partition equality filter.
const FINRA_SYMBOL_FIELD = 'symbolCode';

/** Log the request that failed, minus the bearer token. A blind 400 is unfixable. */
function logFinraFailure(url, body, status, respText) {
  console.error('[finra] query failed', JSON.stringify({
    status,
    url,
    method: 'POST',
    headers: { Authorization: 'Bearer <redacted>', 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
    response: String(respText || '').slice(0, 800),
  }));
}

/** Ask FINRA what this dataset's fields actually are; purely diagnostic. */
async function logFinraMetadata(token) {
  const url = FINRA_DATA_URL.replace('/data/group/', '/metadata/group/');
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const t = await r.text();
    console.error(`[finra] metadata ${r.status} from ${url}: ${t.slice(0, 2500)}`);
  } catch (e) {
    console.error(`[finra] metadata probe failed: ${e.message}`);
  }
}

async function fetchFinraShort(ticker, env) {
  const token = await finraToken(env);
  const sym = ticker.toUpperCase();

  // No sortFields: FINRA restricts sorting to partitioned fields and rejects the
  // request otherwise. A date window plus a client-side sort gets the same six
  // settlements without depending on that restriction.
  const today = etToday();
  const body = {
    limit: 60,
    compareFilters: [{ fieldName: FINRA_SYMBOL_FIELD, fieldValue: sym, compareType: 'EQUAL' }],
    dateRangeFilters: [{ fieldName: FINRA_FIELDS.settlementDate[0], startDate: isoAddDays(today, -400), endDate: today }],
  };

  const r = await fetch(FINRA_DATA_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',      // documented as required; its absence alone can 400
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    logFinraFailure(FINRA_DATA_URL, body, r.status, text);
    if (r.status === 400) await logFinraMetadata(token);
    // Carry FINRA's own words into the reason so the card is diagnostic too.
    let detail = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    try {
      const j = JSON.parse(text);
      detail = (j.message || j.error || j.errorMessage || detail).toString().slice(0, 160);
    } catch (_) {}
    throw new Error(`FINRA query ${r.status}${detail ? ` — ${detail}` : ''}`);
  }

  const payload = await r.json();
  const rows = Array.isArray(payload) ? payload : (payload?.data || payload?.results || []);
  if (!rows.length) throw new Error(`FINRA returned no short-interest rows for ${sym}`);

  // One line that makes the next field-name surprise a five-second fix.
  console.log(`[finra] ${sym}: ${rows.length} rows; row0 keys = ${Object.keys(rows[0]).join(',')}`);

  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const pick = (row, names) => {
    for (const n of names) if (row[n] != null && row[n] !== '') return row[n];
    return null;
  };

  return rows
    .map(row => ({
      settlementDate: pick(row, FINRA_FIELDS.settlementDate),
      shares:         num(pick(row, FINRA_FIELDS.shares)),
      priorShares:    num(pick(row, FINRA_FIELDS.priorShares)),
      avgDailyVolume: num(pick(row, FINRA_FIELDS.avgDailyVolume)),
      daysToCover:    num(pick(row, FINRA_FIELDS.daysToCover)),
    }))
    .filter(x => x.settlementDate)
    .sort((a, b) => String(b.settlementDate).localeCompare(String(a.settlementDate)))
    .slice(0, SHORT_PERIODS);
}

async function handleShortInterest(ticker, params, origin, env, ctx) {
  if (!ticker) return err('ticker required', 400, origin);
  const sym = ticker.toUpperCase();
  const key = `short:${sym}`;

  if (params.get('refresh') !== '1') {
    try {
      const cached = await env?.REC_LOG?.get(key, 'json');
      if (cached) return json({ ...cached, cached: true }, 200, origin);
    } catch (_) {}
  }

  let payload;
  try {
    const periods = await fetchFinraShort(sym, env);
    const latest  = periods[0];
    payload = {
      ticker: sym, official: true, periods, latest,
      _meta: srcMeta('FINRA', {
        asOf: latest.settlementDate,
        delayed: true,
        ttlSeconds: TTL.short,
        note: `official biweekly settlement · settled ${latest.settlementDate} · ~2-week reporting lag`,
      }),
    };
  } catch (e) {
    // Yahoo is the fallback, and it is labelled as an estimate. It must never
    // borrow FINRA's name — that is the exact drift this task is fixing.
    payload = {
      ticker: sym, official: false, periods: [], latest: null,
      reason: `Official FINRA figure unavailable: ${e.message}`,
      _meta: srcMeta('Yahoo Finance', {
        ok: false,
        ttlSeconds: 900,
        note: 'unofficial estimate — official FINRA settlement figure unavailable',
      }),
    };
  }

  if (ctx) ctx.waitUntil(
    env?.REC_LOG?.put(key, JSON.stringify(payload),
      { expirationTtl: payload.official ? SHORT_TTL : 900 }).catch(() => {}));
  return json(payload, 200, origin);
}

async function handleSearch(q, origin) {
  const r = await fetch(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`,
    { headers: YAHOO_HEADERS },
  );
  if (!r.ok) throw new Error(`Yahoo search ${r.status}`);
  return json({ ...(await r.json()), _meta: srcMeta('Yahoo Finance', { ttlSeconds: TTL.quote }) }, 200, origin);
}

async function handleNews(ticker, origin, env) {
  if (env?.ALPACA_KEY && env?.ALPACA_SECRET) {
    try {
      const data = await alpacaFetch(`/v1beta1/news?symbols=${ticker}&limit=15&sort=desc`, env);
      const news = (data.news || []).map(n => ({
        title:               n.headline,
        link:                n.url,
        publisher:           n.source,
        providerPublishTime: Math.floor(new Date(n.created_at).getTime() / 1000),
      }));
      return json({
        news,
        _meta: srcMeta('Alpaca news', { ttlSeconds: TTL.news, note: 'real-time' }),
      }, 200, origin);
    } catch (e) {
      console.error('[news] Alpaca failed, falling back to Yahoo:', e.message);
    }
  }

  const r = await fetch(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${ticker}&quotesCount=0&newsCount=15`,
    { headers: YAHOO_HEADERS },
  );
  return json({
    ...(await r.json()),
    _meta: srcMeta('Yahoo Finance', { delayed: true, ttlSeconds: TTL.news, note: YAHOO_DELAY_NOTE }),
  }, 200, origin);
}

async function handlePeers(ticker, origin) {
  const data = await yahoo(`/v6/finance/recommendationsbysymbol/${ticker}`);
  data._meta = srcMeta('Yahoo Finance', { delayed: true, ttlSeconds: TTL.fund });
  return json(data, 200, origin);
}

/* ═══════════════════════════════════════════════════════════════════════════
   STRUCTURED AI ENDPOINTS  (POST /api/ai/:type/:ticker)

   Replaces `POST /api/claude`, which accepted a caller-supplied `messages` array
   and forwarded it to Anthropic. That made the Worker a general-purpose LLM
   proxy on the owner's key: anyone with the URL could generate anything at all,
   and no amount of rate limiting changes what a single request is worth to an
   abuser.

   Here the caller chooses a **task name and a ticker**. Nothing else. Every
   prompt is assembled in this file from data the Worker fetches itself, so the
   most a caller can do is ask for an equity analysis of a symbol — which is what
   the app does anyway. The endpoint has no value as a free LLM even to someone
   holding a valid key.

   Adding a task means adding an entry to AI_TASKS with its own `build()`. Never
   add a parameter that reaches the prompt as free text; if a task needs caller
   input, constrain it to an enum here.
   ══════════════════════════════════════════════════════════════════════════ */

/* Indicators the synthesis prompt quotes. `index.html` computes these
   client-side for the charts; the Worker needs its own copy because the prompt
   is no longer built there. Same formulas — if one changes, change both. */
function emaArr(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

function smaArr(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function macdHist(closes) {
  const ef = emaArr(closes, 12), es = emaArr(closes, 26);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
  const sig  = emaArr(line.map(v => v ?? 0), 9);
  const last = line.length - 1;
  return (line[last] != null && sig[last] != null) ? line[last] - sig[last] : null;
}

/** Bollinger %B — where price sits in the band, 0 at the lower, 100 at the upper. */
function bollingerPctB(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const mid = smaArr(closes, period);
  const i = closes.length - 1;
  if (mid[i] == null) return null;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) sum += (closes[j] - mid[i]) ** 2;
  const sd = Math.sqrt(sum / period);
  if (!sd) return 50;
  const upper = mid[i] + mult * sd, lower = mid[i] - mult * sd;
  return ((closes[i] - lower) / (upper - lower)) * 100;
}

function stochasticKD(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  if (closes.length < kPeriod) return { k: null, d: null };
  const k = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < kPeriod - 1) { k.push(null); continue; }
    let h = -Infinity, l = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (highs[j] > h) h = highs[j];
      if (lows[j]  < l) l = lows[j];
    }
    k.push(h === l ? 50 : ((closes[i] - l) / (h - l)) * 100);
  }
  const d = smaArr(k.map(v => v ?? 0), dPeriod);
  return { k: k[k.length - 1], d: d[d.length - 1] };
}

function cciLast(highs, lows, closes, period = 20) {
  if (closes.length < period) return null;
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const m  = smaArr(tp, period);
  const i  = tp.length - 1;
  if (m[i] == null) return null;
  let dev = 0;
  for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - m[i]);
  const md = dev / period;
  return md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md);
}

const AI_FACTOR_SCHEMA = {
  type: 'object',
  properties: {
    score:     { type: 'integer' },
    note:      { type: 'string' },
    narrative: { type: 'string' },
  },
  required: ['score', 'note', 'narrative'],
  additionalProperties: false,
};

const AI_SYNTHESIS_SCHEMA = {
  type: 'object',
  properties: {
    rating:     { type: 'string', enum: ['BUY', 'HOLD', 'SELL'] },
    confidence: { type: 'integer' },
    trend:      { type: 'string' },
    pattern:    { type: 'string' },
    action:     { type: 'string' },
    summary:    { type: 'string' },
    factors: {
      type: 'object',
      properties: {
        technical:   AI_FACTOR_SCHEMA,
        fundamental: AI_FACTOR_SCHEMA,
        sentiment:   AI_FACTOR_SCHEMA,
        analyst:     AI_FACTOR_SCHEMA,
        insider:     AI_FACTOR_SCHEMA,
        macro:       AI_FACTOR_SCHEMA,
      },
      required: ['technical', 'fundamental', 'sentiment', 'analyst', 'insider', 'macro'],
      additionalProperties: false,
    },
    thesis: { type: 'string' },
  },
  required: ['rating', 'confidence', 'trend', 'pattern', 'action', 'summary', 'factors', 'thesis'],
  additionalProperties: false,
};

/** Gather everything the synthesis prompt quotes. ~5 subrequests. */
async function gatherSynthesisFacts(sym, env) {
  const [chartRes, quoteRes, ivRes, newsRes, insiderRes, shortRes] = await Promise.allSettled([
    yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}`, '?range=1y&interval=1d'),
    yahooAuth(`/v10/finance/quoteSummary/${encodeURIComponent(sym)}`,
      '?modules=price,summaryDetail,defaultKeyStatistics,financialData,recommendationTrend,assetProfile', env),
    ivSnapshot(sym, env).catch(() => null),
    yahoo('/v1/finance/search', `?q=${encodeURIComponent(sym)}&quotesCount=0&newsCount=8`).catch(() => null),
    env?.REC_LOG?.get(`insider:${sym}`, 'json') ?? Promise.resolve(null),
    env?.REC_LOG?.get(`short:${sym}`, 'json') ?? Promise.resolve(null),
  ]);

  const facts = { symbol: sym };

  if (chartRes.status === 'fulfilled') {
    const r = chartRes.value?.chart?.result?.[0];
    const q = r?.indicators?.quote?.[0] || {};
    const idx = (r?.timestamp || []).map((_, i) => q.close?.[i] != null ? i : -1).filter(i => i >= 0);
    const closes = idx.map(i => q.close[i]);
    const highs  = idx.map(i => q.high[i]  ?? q.close[i]);
    const lows   = idx.map(i => q.low[i]   ?? q.close[i]);
    facts.price = r?.meta?.regularMarketPrice ?? closes[closes.length - 1] ?? null;
    if (closes.length >= 30) {
      const st = stochasticKD(highs, lows, closes);
      facts.ind = {
        rsi:    computeRSI(closes),
        macdH:  macdHist(closes),
        bbPos:  bollingerPctB(closes),
        stochK: st.k, stochD: st.d,
        cci:    cciLast(highs, lows, closes),
        hv30:   historicalVol(closes, IV_HV_WINDOW),
        ...(highs.length >= 5 ? computeSR(highs, lows) : {}),
      };
    }
  }

  if (quoteRes.status === 'fulfilled') {
    const r  = quoteRes.value?.quoteSummary?.result?.[0] || {};
    const fd = r.financialData || {}, ks = r.defaultKeyStatistics || {}, sd = r.summaryDetail || {};
    facts.sector = r.assetProfile?.sector ?? null;
    facts.analyst = {
      low: fd.targetLowPrice?.raw ?? null, mean: fd.targetMeanPrice?.raw ?? null,
      high: fd.targetHighPrice?.raw ?? null,
      trend: r.recommendationTrend?.trend?.[0] ?? null,
    };
    facts.fundamentals = {
      'Trailing P/E':  sd.trailingPE?.raw ?? null,
      'Forward P/E':   ks.forwardPE?.raw ?? null,
      'Price/Book':    ks.priceToBook?.raw ?? null,
      'Profit margin': fd.profitMargins?.raw ?? null,
      'Rev growth':    fd.revenueGrowth?.raw ?? null,
      'ROE':           fd.returnOnEquity?.raw ?? null,
      'Debt/Equity':   fd.debtToEquity?.raw ?? null,
      'Market cap':    r.price?.marketCap?.raw ?? null,
      'Short % float': ks.shortPercentOfFloat?.raw ?? null,
    };
  }

  facts.iv = ivRes.status === 'fulfilled' ? ivRes.value : null;
  facts.news = newsRes.status === 'fulfilled'
    ? (newsRes.value?.news || []).slice(0, 8).map(n => n.title).filter(Boolean) : [];
  facts.insider = insiderRes.status === 'fulfilled' ? insiderRes.value : null;
  facts.short   = shortRes.status === 'fulfilled' ? shortRes.value : null;

  // IV rank rides along only when the history supports it, exactly as the page did.
  if (facts.iv?.front?.atmIv != null && env?.REC_LOG) {
    const hist = await ivHistory(sym, env).catch(() => []);
    Object.assign(facts.iv, ivRankFrom(hist, facts.iv.front.atmIv));
  }
  return facts;
}

/** The synthesis prompt. Built here, from `facts` — never from caller input. */
function buildSynthesisPrompt(sym, f) {
  const n = (v, d = 1) => (v == null || !Number.isFinite(v)) ? 'n/a' : Number(v).toFixed(d);
  const i = f.ind || {};

  // Implied vol is stated only when it exists, and IV rank only once its history
  // supports it — an absent rank is reported as absent rather than approximated,
  // so the model cannot cite a number nothing measured.
  const ivl = f.iv?.front?.atmIv != null
    ? [
        `Front ATM IV: ${n(f.iv.front.atmIv)}% (${f.iv.front.expiry}, ${f.iv.front.dte} DTE)`,
        f.iv.back ? `Back ATM IV: ${n(f.iv.back.atmIv)}% (${f.iv.back.expiry})` : 'Back month: not available',
        f.iv.back ? `Term structure: ${(f.iv.front.atmIv - f.iv.back.atmIv) >= 0 ? '+' : ''}${
          n(f.iv.front.atmIv - f.iv.back.atmIv)} pts (${
          f.iv.front.atmIv - f.iv.back.atmIv > 0 ? 'backwardation' : 'contango'})` : null,
        f.iv.ivRank != null
          ? `IV rank: ${(f.iv.ivRank * 100).toFixed(0)} (over ${f.iv.historyDays} days collected)`
          : `IV rank: NOT AVAILABLE — only ${f.iv.historyDays ?? 0} days of IV history collected, `
            + `${IV_RANK_MIN_DAYS} needed. Do not estimate or infer an IV rank.`,
      ].filter(Boolean).join('\n')
    : 'No implied-volatility reading available for this ticker. Do not infer one from the realized-vol figure below.';

  const fundLines = Object.entries(f.fundamentals || {})
    .filter(([, v]) => v != null).map(([k, v]) => `${k}: ${v}`).join('\n') || 'not available';

  const a = f.analyst || {};
  const t = a.trend;
  const ins = f.insider?.summary || f.insider || {};
  const si  = f.short?.latest || {};

  return `You are a sell-side equity research analyst. Produce an OVERALL RATING for ${sym} given the data below.

PRICE: $${n(f.price, 2)}${f.sector ? ` · Sector: ${f.sector}` : ''}

TECHNICAL:
RSI=${n(i.rsi)}, MACD hist=${n(i.macdH, 3)}, Bollinger %B=${n(i.bbPos, 0)}%, Stochastic K/D=${n(i.stochK, 0)}/${n(i.stochD, 0)}, CCI=${n(i.cci, 0)}, HV30 (30d realized vol)=${n(i.hv30)}%
Support=$${n(i.support, 2)}, Resistance=$${n(i.resist, 2)}

VOLATILITY (implied, from the options chain — distinct from the HV30 realized figure above):
${ivl}

ANALYST:
Targets: low $${n(a.low, 2)}, mean $${n(a.mean, 2)}, high $${n(a.high, 2)}
Recs: ${t ? `SBuy ${t.strongBuy}, Buy ${t.buy}, Hold ${t.hold}, Sell ${t.sell}, SSell ${t.strongSell}` : 'n/a'}

FUNDAMENTALS:
${fundLines}

INSIDER (last 90 days, SEC Form 4): buys=${ins.buyCount ?? ins.buys ?? 'n/a'}, sells=${ins.sellCount ?? ins.sells ?? 'n/a'}
SHORT INTEREST: ${si.shortPercentFloat != null ? n(si.shortPercentFloat) + '% of float' : 'n/a'}${si.daysToCover != null ? `, DTC=${n(si.daysToCover)}` : ''}

RECENT HEADLINES:
${f.news.length ? f.news.map(h => `- ${h}`).join('\n') : '- none retrieved'}

TASK:
Return JSON matching the provided schema.
- rating: BUY | HOLD | SELL
- confidence: 0-100 integer
- trend: under 10 words describing the current trend
- pattern: chart pattern name (e.g. Bull flag, Double bottom)
- action: actionable phrase (e.g. Buy dips to $85, Hold above $200)
- summary: 2-sentence trader summary
- factors: technical, fundamental, sentiment, analyst, insider, macro — each with
  score 0-100 (0=very bearish, 50=neutral, 100=very bullish), a note under 8 words,
  and a 2-3 sentence narrative
- thesis: 2 paragraphs, 60-100 words total, plain prose, no bullet points

Base every claim on the data above. Where a figure is marked n/a or NOT AVAILABLE,
say so rather than estimating it.`;
}

/* The task registry. A caller names a key here; it cannot supply prompt text. */
const AI_TASKS = {
  synthesis: {
    maxTokens: 2500,
    schema: AI_SYNTHESIS_SCHEMA,
    cacheKey: sym => `analysis:${sym}`,
    cacheTtl: 172_800,
    build: async (sym, env) => buildSynthesisPrompt(sym, await gatherSynthesisFacts(sym, env)),
  },
};

async function handleAi(type, ticker, request, origin, env, ctx) {
  const task = AI_TASKS[String(type || '').toLowerCase()];
  if (!task) {
    return err(`unknown analysis type. Supported: ${Object.keys(AI_TASKS).join(', ')}`, 404, origin);
  }
  // Symbol shape is constrained here, not trusted: it lands in a URL and in the
  // prompt, and "ticker" is the only caller-controlled value in this whole path.
  const sym = String(ticker || '').toUpperCase();
  if (!/^[A-Z][A-Z.\-]{0,9}$/.test(sym)) return err('invalid ticker', 400, origin);

  const gate = await aiGuard(request, env, origin);
  if (gate) return gate;

  if (!env?.ANTHROPIC_API_KEY) return err('ANTHROPIC_API_KEY not configured', 503, origin);

  try {
    const prompt = await task.build(sym, env);
    const text   = await workerClaude(prompt, env, task.maxTokens, task.schema);
    const result = JSON.parse(text);

    if (task.cacheKey && env?.REC_LOG) {
      ctx?.waitUntil(env.REC_LOG.put(task.cacheKey(sym), JSON.stringify({ ...result, ts: Date.now() }),
        { expirationTtl: task.cacheTtl }).catch(() => {}));
    }
    return json({
      ticker: sym, type, analysis: result, ts: Date.now(),
      _meta: srcMeta('Claude synthesis', {
        ttlSeconds: task.cacheTtl, note: `${type} · prompt built server-side`,
      }),
    }, 200, origin);
  } catch (e) {
    console.error(`[ai:${type}] ${sym} failed:`, e.message);
    return err(`analysis failed: ${e.message}`, 502, origin);
  }
}

/* ── Recommendation forward-log ──────────────────────────────────────────────
   synthesize() runs on every page load, so appending unconditionally produced a
   dozen near-identical rows for one trading day: the same call counted a dozen
   times, weighting whichever ticker got refreshed most and making hit rate and
   Brier score meaningless. The log is now one entry per ticker per US/Pacific
   trading date — the newest entry is overwritten rather than appended when it
   falls on the same date. */

const REC_FWD_HORIZONS = [
  { days: 5,  ret: 'fwd5',  close: 'fwd5Close'  },
  { days: 20, ret: 'fwd20', close: 'fwd20Close' },
];
const REC_CALIB_MIN_N = 10;

async function handleLogRec(request, env, origin) {
  if (!env.REC_LOG) return err('REC_LOG KV not bound', 500, origin);
  const body = await request.json();
  const { ticker, rating, confidence, price, factors } = body;
  if (!ticker || !rating) return err('ticker and rating required', 400, origin);

  const now   = new Date();
  const entry = {
    ticker:     ticker.toUpperCase(),
    rating,
    confidence: confidence ?? null,
    price:      price      ?? null,
    factors:    factors    ?? {},
    ts:         now.toISOString(),
    d:          ptDate(now),   // the trading date this call belongs to
    // Filled later by fillForwardReturns(): percent return vs `price`, with the
    // realising close kept alongside so the number can be audited.
    fwd5:  null, fwd5Close:  null,
    fwd20: null, fwd20Close: null,
  };

  const key      = `rec:${entry.ticker}`;
  const existing = await env.REC_LOG.get(key, 'json');
  const list     = Array.isArray(existing) ? existing : [];

  const lastIdx = list.length - 1;
  const last    = lastIdx >= 0 ? list[lastIdx] : null;
  const lastDay = last ? (last.d || ptDate(new Date(last.ts))) : null;

  // Forward fields stay null on overwrite: the replacement carries a new entry
  // price, so returns measured against the old one would no longer describe it.
  // (They are null in practice anyway — a fill needs 5+ sessions to have passed,
  // which means the entry is no longer same-day.)
  const replaced = !!last && lastDay === entry.d;
  if (replaced) list[lastIdx] = entry; else list.push(entry);

  await env.REC_LOG.put(key, JSON.stringify(list.slice(-500)));
  return json({ ok: true, count: list.length, replaced, tradingDate: entry.d }, 200, origin);
}

/**
 * Calibration over the resolved slice of a ticker's log.
 *
 * "Resolved" means fwd20 is filled — an entry logged nine sessions ago has no
 * outcome yet and cannot count. Below REC_CALIB_MIN_N the figures are returned
 * as nulls with a reason: a hit rate over four entries is noise wearing a
 * percentage sign, and it would read on screen exactly like a real one.
 */
function recCalibration(list) {
  const resolved = list.filter(e => Number.isFinite(e.fwd20));
  const n = resolved.length;

  if (n < REC_CALIB_MIN_N) {
    return {
      n, minN: REC_CALIB_MIN_N, brier: null, brierN: 0, byRating: null,
      reason: `${n} of ${REC_CALIB_MIN_N} recommendations have a 20-session outcome. `
            + `Each entry needs 20 trading days to elapse before it resolves.`,
    };
  }

  const mean = arr => arr.length
    ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)
    : null;

  const byRating = {};
  for (const r of ['BUY', 'HOLD', 'SELL']) {
    const rows = resolved.filter(e => e.rating === r);
    // HOLD is excluded from hit rate by design: it makes no directional claim,
    // so there is no outcome that would count as right.
    const hits = (r === 'HOLD' || !rows.length) ? null
      : rows.filter(e => r === 'BUY' ? e.fwd20 > 0 : e.fwd20 < 0).length;
    byRating[r] = {
      n:         rows.length,
      hitRate:   hits == null ? null : +(hits / rows.length).toFixed(4),
      meanFwd5:  mean(rows.filter(e => Number.isFinite(e.fwd5)).map(e => e.fwd5)),
      meanFwd20: mean(rows.map(e => e.fwd20)),
    };
  }

  // Brier scores the confidence number against the directional outcome, so it
  // covers BUY/SELL only. Lower is better; 0.25 is what you score by saying 50%
  // to everything.
  const scored = resolved.filter(e =>
    (e.rating === 'BUY' || e.rating === 'SELL') && Number.isFinite(e.confidence));
  const brier = scored.length
    ? +(scored.reduce((acc, e) => {
        const p = Math.min(1, Math.max(0, e.confidence / 100));
        const o = (e.rating === 'BUY' ? e.fwd20 > 0 : e.fwd20 < 0) ? 1 : 0;
        return acc + (p - o) ** 2;
      }, 0) / scored.length).toFixed(4)
    : null;

  return { n, minN: REC_CALIB_MIN_N, reason: null, brier, brierN: scored.length, byRating };
}

async function handleTrack(ticker, env, origin) {
  if (!env.REC_LOG) return err('REC_LOG KV not bound', 500, origin);
  const list = (await env.REC_LOG.get(`rec:${ticker.toUpperCase()}`, 'json')) || [];
  return json({
    ticker:      ticker.toUpperCase(),
    entries:     list,
    calibration: recCalibration(list),
    _meta: srcMeta('KV forward log', {
      ttlSeconds: TTL.track,
      asOf: list[list.length - 1]?.d || null,
      note: `${list.length} entr${list.length === 1 ? 'y' : 'ies'} · forward returns filled 2pm PT`,
    }),
  }, 200, origin);
}

/* ── Cron: fill forward returns on logged recommendations (2:00pm PT) ──
   Walks every rec:{TICKER} list and resolves entries that have come of age.
   One chart fetch per ticker covers all of its pending entries. */
async function fillForwardReturns(env) {
  if (!env?.REC_LOG) return;
  try {
    const last = await env.REC_LOG.get('recfwd:last');
    if (last === ptDate()) { console.log('[cron] forward fill already ran today, skipping'); return; }
  } catch (_) {}

  const keys = [];
  let cursor;
  do {
    const page = await env.REC_LOG.list({ prefix: 'rec:', cursor });
    for (const k of page.keys) keys.push(k.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  const today = etToday();
  let tickers = 0, filled = 0;

  for (const key of keys) {
    const ticker = key.slice(4);
    let list;
    try { list = await env.REC_LOG.get(key, 'json'); } catch (_) { continue; }
    if (!Array.isArray(list) || !list.length) continue;

    const pending = list.filter(e =>
      Number.isFinite(e.price) && REC_FWD_HORIZONS.some(h => e[h.ret] == null));
    if (!pending.length) continue;

    let bars;
    try {
      const chart = await yahoo(`/v8/finance/chart/${encodeURIComponent(ticker)}`, '?range=2y&interval=1d');
      bars = chartDailyBars(chart);
    } catch (e) {
      console.warn(`[cron] forward fill ${ticker}: chart failed — ${e.message}`);
      continue;
    }
    if (bars.length < 2) continue;
    tickers++;

    let dirty = false;
    for (const e of pending) {
      const day = e.d || ptDate(new Date(e.ts));
      // Anchor on the session in effect when the call was logged: the last bar at
      // or before that date. A call logged on a weekend anchors to the Friday.
      let anchor = -1;
      for (let i = bars.length - 1; i >= 0; i--) {
        if (bars[i].iso <= day) { anchor = i; break; }
      }
      if (anchor < 0) continue;

      for (const h of REC_FWD_HORIZONS) {
        if (e[h.ret] != null) continue;
        const idx = anchor + h.days;
        // Require a completed session: today's bar is still forming.
        if (idx >= bars.length || bars[idx].iso >= today) continue;
        const close = bars[idx].close;
        if (!Number.isFinite(close)) continue;
        e[h.close] = +close.toFixed(4);
        e[h.ret]   = +(((close / e.price) - 1) * 100).toFixed(2);
        dirty = true;
        filled++;
      }
    }

    if (dirty) {
      try { await env.REC_LOG.put(key, JSON.stringify(list)); }
      catch (e) { console.warn(`[cron] forward fill ${ticker}: write failed — ${e.message}`); }
    }
  }

  try { await env.REC_LOG.put('recfwd:last', ptDate(), { expirationTtl: 172800 }); } catch (_) {}
  console.log(`[cron] forward fill: ${filled} value(s) across ${tickers} ticker(s)`);
}

/* ── Cron: bank the historical move distribution per watchlist ticker ─────────
   Runs on the 2:00pm PT `forward-returns` branch, NOT the 1:15pm EOD one, and
   the reason is bar settlement rather than load: the NYSE closes at 1:00pm PT,
   so at 1:15pm the day's daily bar may still be forming. Banking a forming bar
   into the series every coverage figure is measured against would never surface
   as an error — it would just quietly shift the most recent window. By 2:00pm
   the bar is settled. (`fillForwardReturns` guards the same hazard from the
   other side with `bars[idx].iso < today`.)

   ONE `yahooSparkCloses` CALL FOR THE WHOLE WATCHLIST. Spark takes 20 symbols
   per request and needs no crumb, so 22 names cost 2 external fetches. Do not
   replace this with a per-ticker chart fetch: 22 concurrent invocations against
   Yahoo is the crumb-rate-limit failure, which the subrequest ceiling has
   nothing to do with. */
const MOVES_SWEEP_KEY = 'movesweep:last';

/** ISO date of the last session in a spark timestamp array. Yahoo stamps a daily
 *  bar at the exchange open, which is mid-afternoon UTC for US names, so the UTC
 *  calendar date is the session date. */
function lastSessionIso(timestamps) {
  if (!Array.isArray(timestamps) || !timestamps.length) return null;
  const t = timestamps[timestamps.length - 1];
  if (!Number.isFinite(t)) return null;
  return new Date(t * 1000).toISOString().slice(0, 10);
}

async function collectMoveSeries(env) {
  if (!env?.REC_LOG) return;
  const mark = instrMark();

  try {
    const last = await env.REC_LOG.get(MOVES_SWEEP_KEY);
    if (last === ptDate()) { console.log('[cron] move-series sweep already ran today, skipping'); return; }
  } catch (_) {}

  let tickers = [...DEFAULT_WATCHLIST];
  try {
    const saved = await env.REC_LOG.get('watchlist:tickers', 'json');
    if (Array.isArray(saved) && saved.length) {
      tickers = [...new Set([...saved, ...DEFAULT_WATCHLIST].map(t => String(t).toUpperCase()))];
    }
  } catch (_) {}
  tickers = tickers.slice(0, LONG_MAX_SYMBOLS);

  let series;
  try {
    series = await yahooSparkCloses(tickers, MOVES_RANGE, 4, { withTimestamps: true });
  } catch (e) {
    console.warn('[cron] move-series sweep: spark failed —', e.message);
    return;
  }

  let written = 0, skipped = 0, absent = 0, thin = 0;
  await allSettledCounted(tickers.map(async (sym) => {
    const s = series.get(sym);
    // Spark drops unknown/delisted symbols silently and keys off `item.symbol`,
    // so an absent entry is a fact worth counting rather than a loop that ends early.
    if (!s?.closes?.length) { absent++; return; }

    const asOfClose = lastSessionIso(s.timestamps);
    const prev = await readMoveSeries(sym, env);
    if (prev && asOfClose && prev.asOfClose === asOfClose) { skipped++; return; }

    const payload = buildMoveSeries(sym, s.closes, asOfClose);
    // A name with too little history still gets stored: every horizon carries its
    // own reason, and "3 months since IPO" is a finding the card should state
    // rather than an absence that reads as a collection failure.
    if (payload.sessions < MOVES_HORIZONS[0] + 1) thin++;
    await env.REC_LOG.put(movesKey(sym), JSON.stringify(payload), { expirationTtl: MOVES_TTL });
    written++;
  }), 'move-series sweep');

  try { await env.REC_LOG.put(MOVES_SWEEP_KEY, ptDate(), { expirationTtl: 172800 }); } catch (_) {}
  console.log(
    `[cron] move-series sweep: ${written} written, ${skipped} already current, ${absent} not returned by spark, `
    + `${thin} with thin history · ${JSON.stringify(instrSince(mark, 'complete'))}`,
  );
}

/* ── New route handlers ── */

async function handleMarketSnapshot(origin, env) {
  const tickers = Object.keys(SNAPSHOT_SYMBOLS);
  const results = await Promise.allSettled(
    tickers.map(t => yahoo(`/v8/finance/chart/${encodeURIComponent(t)}`, '?range=1d&interval=1d')),
  );

  const snapshot = tickers.map((ticker, i) => {
    if (results[i].status !== 'fulfilled') {
      return { ticker, name: SNAPSHOT_SYMBOLS[ticker], price: null, changePct: null };
    }
    const meta      = results[i].value?.chart?.result?.[0]?.meta || {};
    const price     = meta.regularMarketPrice ?? null;
    const prev      = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const changePct = price != null && prev != null
      ? Math.round((price - prev) / prev * 10000) / 100
      : null;
    return {
      ticker,
      name:      SNAPSHOT_SYMBOLS[ticker],
      price:     price != null ? Math.round(price * 100) / 100 : null,
      changePct,
    };
  });

  return json({
    snapshot, ts: Date.now(),
    _meta: srcMeta('Yahoo Finance', {
      delayed: true, ttlSeconds: TTL.quote, note: `${snapshot.length} symbols · ${YAHOO_DELAY_NOTE}`,
    }),
  }, 200, origin);
}

async function handleMarketMovers(origin, env) {
  const MIN_PCT = 10;

  // Wider pool for Alpaca batch — increases hit rate for ≥10% moves
  const MOVER_POOL = [
    'AAPL','NVDA','MSFT','GOOGL','AMZN','META','TSLA','AMD','PLTR','HOOD',
    'RDDT','APP','CAVA','PANW','MU','NOW','TSM','JPM','UNH','MRK',
    'NFLX','UBER','COIN','MSTR','SMCI','ARM','AVGO','ORCL','CRM','SNOW',
    'RBLX','UPST','SOFI','RIVN','NIO','BABA','MELI','DKNG','IONQ','QUBT',
  ];

  // ── Regular / pre-market movers ──
  let dayMovers = [];

  if (env?.ALPACA_KEY && env?.ALPACA_SECRET) {
    try {
      const data = await alpacaFetch(`/v2/stocks/snapshots?symbols=${MOVER_POOL.join(',')}`, env);
      dayMovers = Object.entries(data).map(([sym, snap]) => {
        const price     = snap.latestTrade?.p ?? snap.dailyBar?.c ?? null;
        const prev      = snap.prevDailyBar?.c ?? null;
        const changePct = price != null && prev != null
          ? Math.round((price - prev) / prev * 10000) / 100
          : null;
        return { ticker: sym, price, changePct };
      }).filter(m => m.changePct != null);
    } catch (_) {}
  }

  // Yahoo screener fallback (broader universe, no Alpaca needed)
  if (!dayMovers.length) {
    try {
      const [gr, lr] = await Promise.allSettled([
        fetch('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=true&scrIds=day_gainers&count=25', { headers: YAHOO_HEADERS }),
        fetch('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=true&scrIds=day_losers&count=25',  { headers: YAHOO_HEADERS }),
      ]);
      for (const res of [gr, lr]) {
        if (res.status === 'fulfilled' && res.value.ok) {
          const d = await res.value.json();
          for (const q of (d.finance?.result?.[0]?.quotes || [])) {
            dayMovers.push({
              ticker:    q.symbol,
              price:     q.regularMarketPrice?.raw ?? null,
              changePct: q.regularMarketChangePercent?.raw != null
                ? Math.round(q.regularMarketChangePercent.raw * 100) / 100 : null,
            });
          }
        }
      }
    } catch (_) {}
  }

  // ── Post-market / after-hours movers (Yahoo extended-hours screeners) ──
  let postMovers = [];
  try {
    const [agr, alr] = await Promise.allSettled([
      fetch('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=true&scrIds=afterhr_gainers&count=25', { headers: YAHOO_HEADERS }),
      fetch('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=true&scrIds=afterhr_losers&count=25',  { headers: YAHOO_HEADERS }),
    ]);
    for (const res of [agr, alr]) {
      if (res.status === 'fulfilled' && res.value.ok) {
        const d = await res.value.json();
        for (const q of (d.finance?.result?.[0]?.quotes || [])) {
          // Prefer postMarketChangePercent; fall back to regularMarketChangePercent
          const pct   = q.postMarketChangePercent?.raw ?? q.regularMarketChangePercent?.raw ?? null;
          const price = q.postMarketPrice?.raw ?? q.regularMarketPrice?.raw ?? null;
          if (pct != null) {
            postMovers.push({
              ticker:    q.symbol,
              price,
              changePct: Math.round(pct * 100) / 100,
            });
          }
        }
      }
    }
  } catch (_) {}

  // Also supplement post-market with Alpaca after-hours data (latestTrade vs dailyBar close)
  if (env?.ALPACA_KEY && env?.ALPACA_SECRET && !postMovers.length) {
    try {
      const data = await alpacaFetch(`/v2/stocks/snapshots?symbols=${MOVER_POOL.join(',')}`, env);
      for (const [sym, snap] of Object.entries(data)) {
        const afterPrice  = snap.latestTrade?.p ?? null;
        const regularClose = snap.dailyBar?.c ?? null;
        if (afterPrice == null || regularClose == null) continue;
        const pct = Math.round((afterPrice - regularClose) / regularClose * 10000) / 100;
        postMovers.push({ ticker: sym, price: afterPrice, changePct: pct });
      }
    } catch (_) {}
  }

  const applyFilter = (list, positive) => list
    .filter(m => positive ? m.changePct >= MIN_PCT : m.changePct <= -MIN_PCT)
    .sort((a, b) => positive ? b.changePct - a.changePct : a.changePct - b.changePct)
    .slice(0, 10);

  return json({
    gainers:     applyFilter(dayMovers,  true),
    losers:      applyFilter(dayMovers,  false),
    postGainers: applyFilter(postMovers, true),
    postLosers:  applyFilter(postMovers, false),
    ts: Date.now(),
    _meta: srcMeta('Yahoo screener', {
      delayed: true, ttlSeconds: TTL.quote, note: `≥ ±${MIN_PCT}% · ${YAHOO_DELAY_NOTE}`,
    }),
  }, 200, origin);
}

/* ───────────────────────────────────────────────────────────────────────────
 * Day-Trading Momentum Scanner  (Warrior Trading "5 Pillars" methodology)
 *
 * Mirrors Warrior Trading's "Most Active Stocks" watch list: surface every
 * active intraday mover, excluding only sub-$2 penny stocks and OTC/pink sheets.
 * The 5 Pillars are scored/ranked — they are NOT all hard gates, so higher-
 * priced and larger-float active names still appear (just lower-scored):
 *   1. Relative Volume   ≥ 5×   (today's volume ÷ 10-day avg)   — scoring
 *   2. Daily % change    ≥ +10% (≥ +15% = "on fire")            — scoring
 *   3. News catalyst             (AI-tagged from the news feed)  — scoring
 *   4. Price             ≥ $2    (hard filter — excludes pennies)
 *   5. Float             < 20M shares                            — scoring
 * Hard filters ONLY: major US exchange (no OTC / pink), price ≥ $2, and a
 * small candidate-net floor on % change + volume to keep flat names out.
 *
 * Two-stage pipeline:
 *   Stage 1 — candidate sweep via Yahoo custom screener (+ predefined fallback)
 *   Stage 2 — per-candidate enrichment: float, RVOL, then one batched Claude
 *             call to tag catalysts. Scored 0–100 against the 5 pillars.
 * Cached 90s in KV (scanner:{preset}) to respect upstream rate limits.
 * ─────────────────────────────────────────────────────────────────────────── */

// Major US exchange codes to KEEP — everything else (PNK/OTC/pink) is dropped.
const SCANNER_MAJOR_EXCHANGES = new Set(['NMS', 'NGM', 'NCM', 'NYQ', 'ASE', 'PCX', 'BTS', 'BATS']);

// Pillar thresholds used for SCORING (not hard filters).
const SCANNER_GAP_PILLAR   = 10;          // % change at/above this lights the "change" pillar
const SCANNER_FLOAT_PILLAR = 20_000_000;  // float below this lights the "float" pillar

// Penny-stock floor — anything under this price is excluded (hard filter).
// minPct here is the candidate-net floor (keeps flat names out), NOT the 10%
// momentum rule, which is scored via SCANNER_GAP_PILLAR. maxPrice null = no cap.
const SCANNER_PRESETS = {
  // Pre-market gappers — the Gap & Go candidate list.
  premarket: { minPct: 2, minPrice: 2, maxPrice: null, minVol: 50_000  },
  // Live momentum / high-of-day — the prime 9:30–12:00 window.
  momentum:  { minPct: 3, minPrice: 2, maxPrice: null, minVol: 100_000 },
  // All movers — widest net for manual review.
  all:       { minPct: 1, minPrice: 2, maxPrice: null, minVol: 100_000 },
};

// Yahoo custom screener (POST, crumb-authed). Returns candidate quotes or [].
async function yahooScreenerPOST(cfg, env) {
  const body = {
    size: 50,
    offset: 0,
    sortField: 'percentchange',
    sortType: 'DESC',
    quoteType: 'EQUITY',
    query: {
      operator: 'AND',
      operands: [
        { operator: 'eq', operands: ['region', 'us'] },
        { operator: 'gt', operands: ['percentchange', cfg.minPct] },
        { operator: 'gt', operands: ['intradayprice', cfg.minPrice] },
        // Upper price bound only when the preset caps it (default: no cap).
        ...(cfg.maxPrice != null ? [{ operator: 'lt', operands: ['intradayprice', cfg.maxPrice] }] : []),
        { operator: 'gt', operands: ['dayvolume', cfg.minVol] },
      ],
    },
    userId: '',
    userIdType: 'guid',
  };

  const make = async (crumb, cookie) => {
    const headers = { ...YAHOO_HEADERS, 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    return fetch(
      `https://query2.finance.yahoo.com/v1/finance/screener?crumb=${encodeURIComponent(crumb)}&formatted=true&lang=en-US&region=US`,
      { method: 'POST', headers, body: JSON.stringify(body) },
    );
  };

  try {
    let { crumb, cookie } = await getYahooCrumb(env);
    let r = await make(crumb, cookie);
    if (r.status === 401 || r.status === 403) {
      _crumbCache = null;
      ({ crumb, cookie } = await getYahooCrumb(env));
      r = await make(crumb, cookie);
    }
    if (!r.ok) return [];
    const d = await r.json();
    return d?.finance?.result?.[0]?.quotes || [];
  } catch (_) {
    return [];
  }
}

// Map a raw Yahoo screener quote → normalized candidate (or null to drop).
function scannerNormalize(q) {
  const num = (v) => (v && typeof v === 'object' ? (v.raw ?? null) : (v ?? null));
  const price     = num(q.regularMarketPrice);
  const changePct = num(q.regularMarketChangePercent);
  const preChg    = num(q.preMarketChangePercent);
  const volume    = num(q.regularMarketVolume);
  const avgVol    = num(q.averageDailyVolume10Day) ?? num(q.averageDailyVolume3Month);
  const exchange  = q.exchange || '';
  if (!q.symbol || price == null) return null;
  // Drop OTC / pink sheets — keep only recognised major US exchanges.
  if (exchange && !SCANNER_MAJOR_EXCHANGES.has(exchange)) return null;
  return {
    ticker:    q.symbol,
    name:      q.shortName || q.longName || '',  // may be refined in stage 2
    sector:    null,      // filled in stage 2
    price:     Math.round(price * 100) / 100,
    changePct: changePct != null ? Math.round(changePct * 100) / 100 : null,
    preChg:    preChg    != null ? Math.round(preChg    * 100) / 100 : null,
    volume,
    avgVol,
    rvol:      avgVol ? Math.round(volume / avgVol * 10) / 10 : null,
    float:     null,      // filled in stage 2
    catalyst:  null,      // filled in stage 2
  };
}

async function handleScanner(searchParams, origin, env, ctx, request) {
  const preset = SCANNER_PRESETS[searchParams.get('preset')] ? searchParams.get('preset') : 'momentum';
  const cfg    = SCANNER_PRESETS[preset];
  const KV_KEY = `scanner:${preset}`;
  const SCAN_TTL = 90_000; // 90s

  let cached = null;
  try { cached = await env?.REC_LOG?.get(KV_KEY, 'json'); } catch (_) {}

  // Stale-while-revalidate: return the banked snapshot at any age, never rebuild.
  if (searchParams.get('cached') === '1') {
    return json(cached ? { ...cached, cached: true } : { preset, results: [], ...emptySnapshot('Yahoo screener', TTL.scanner) }, 200, origin);
  }

  // Serve fresh KV cache
  if (cached && Date.now() - (cached.ts || 0) < SCAN_TTL) {
    return json({ ...cached, cached: true }, 200, origin);
  }

  // ── Stage 1: candidate sweep ──
  let raw = await yahooScreenerPOST(cfg, env);

  // Fallback: predefined day_gainers screener (no float/RVOL guarantees but robust)
  if (!raw.length) {
    try {
      const r = await fetch(
        'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=true&scrIds=day_gainers&count=50',
        { headers: YAHOO_HEADERS },
      );
      if (r.ok) raw = (await r.json())?.finance?.result?.[0]?.quotes || [];
    } catch (_) {}
  }

  // Normalize, drop OTC, exclude sub-$2 pennies (and any preset price cap),
  // keep a small candidate-net floor on % change to drop flat names.
  let candidates = raw
    .map(scannerNormalize)
    .filter(Boolean)
    .filter(c => c.price >= cfg.minPrice && (cfg.maxPrice == null || c.price <= cfg.maxPrice))
    .filter(c => {
      const pct = preset === 'premarket' ? (c.preChg ?? c.changePct) : c.changePct;
      return pct != null && pct >= cfg.minPct;
    })
    .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
    .slice(0, 15); // cap enrichment cost

  // ── Stage 2: enrich float + RVOL via quoteSummary ──
  await Promise.allSettled(candidates.map(async (c) => {
    try {
      const r = await yahooAuth(
        `/v10/finance/quoteSummary/${c.ticker}`,
        '?modules=defaultKeyStatistics,price,summaryDetail,assetProfile',
        env,
      );
      const m = r?.quoteSummary?.result?.[0] || {};
      const float = m.defaultKeyStatistics?.floatShares?.raw
                 ?? m.defaultKeyStatistics?.sharesOutstanding?.raw ?? null;
      if (float != null) c.float = float;
      const name = m.price?.longName || m.price?.shortName;
      if (name) c.name = name;
      c.sector = m.assetProfile?.sector ?? c.sector;
      // Backfill RVOL if the screener didn't carry avg volume
      if (c.rvol == null) {
        const vol = m.price?.regularMarketVolume?.raw ?? c.volume;
        const avg = m.summaryDetail?.averageDailyVolume10Day?.raw
                 ?? m.summaryDetail?.averageVolume?.raw ?? null;
        if (vol && avg) c.rvol = Math.round(vol / avg * 10) / 10;
      }
    } catch (_) {}
  }));

  // Float is scored, not gated — high-float active names stay in the list.

  // ── Stage 2b: AI-tag catalysts (one batched Claude call) ──
  // Gated: the scan itself is free, the catalyst tagging is not. An ungated
  // caller still gets the full ranked list, just without catalyst strings.
  if (candidates.length && env?.ANTHROPIC_API_KEY && await maySpend(request, env)) {
    try {
      // Pull a headline for each candidate in parallel
      const heads = await Promise.allSettled(candidates.map(async (c) => {
        if (env?.ALPACA_KEY && env?.ALPACA_SECRET) {
          const d = await alpacaFetch(`/v1beta1/news?symbols=${c.ticker}&limit=2&sort=desc`, env);
          const n = d.news?.[0];
          return n ? `${c.ticker}: ${n.headline}` : `${c.ticker}: (no recent headline)`;
        }
        return `${c.ticker}: (no recent headline)`;
      }));
      const lines = heads.map(h => h.status === 'fulfilled' ? h.value : null).filter(Boolean);

      if (lines.length) {
        const prompt = `You are a day-trading desk analyst. For each ticker below, give the single most likely intraday CATALYST in 3-6 words (e.g. "Q2 earnings beat + raise", "FDA Phase 3 win", "secondary offering", "analyst upgrade"). If the headline shows no real catalyst, return null.\nReturn ONLY a JSON object mapping ticker → catalyst string or null.\n\n${lines.join('\n')}`;
        const cr = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: CLAUDE_MODEL,
            max_tokens: 500 + CLAUDE_THINKING_HEADROOM,
            messages: [{ role: 'user', content: prompt }],
            ...CLAUDE_REASONING,
          }),
        });
        if (cr.ok) {
          const txt = claudeText(await cr.json());
          const match = txt.match(/\{[\s\S]*\}/);
          if (match) {
            const tags = JSON.parse(match[0]);
            for (const c of candidates) {
              const t = tags[c.ticker];
              if (t && typeof t === 'string' && t.toLowerCase() !== 'null') c.catalyst = t;
            }
          }
        }
      }
    } catch (_) {}
  }

  // ── Stage 3: 5-pillar scoring ──
  const scored = candidates.map((c) => {
    const pct = preset === 'premarket' ? (c.preChg ?? c.changePct) : c.changePct;
    const pillars = {
      rvol:     c.rvol != null && c.rvol >= 5,
      change:   pct   != null && pct  >= SCANNER_GAP_PILLAR,
      catalyst: !!c.catalyst,
      price:    c.price >= cfg.minPrice,                 // always true post-filter
      float:    c.float != null && c.float < SCANNER_FLOAT_PILLAR,
    };
    // Continuous score for ranking (price pillar is a given, so weight the other 4)
    let score = 0;
    score += Math.min(c.rvol ?? 0, 10) / 10 * 30;        // RVOL up to 30
    score += Math.min(Math.max(pct ?? 0, 0), 30) / 30 * 25; // %chg up to 25
    score += c.catalyst ? 25 : 0;                        // catalyst 25
    score += c.float != null ? (c.float < 5e6 ? 20 : c.float < 10e6 ? 16 : c.float < 20e6 ? 10 : 4) : 6; // float up to 20
    return {
      ...c,
      pct,
      pillars,
      pillarCount: Object.values(pillars).filter(Boolean).length,
      score: Math.round(score),
    };
  }).sort((a, b) => b.score - a.score);

  const payload = {
    preset, count: scored.length, results: scored, ts: Date.now(),
    _meta: srcMeta('Yahoo screener', {
      delayed: true, ttlSeconds: TTL.scanner,
      note: `${preset} · ${scored.length} names · ${YAHOO_DELAY_NOTE}`,
    }),
  };
  try { await env?.REC_LOG?.put(KV_KEY, JSON.stringify(payload), { expirationTtl: 300 }); } catch (_) {}
  return json(payload, 200, origin);
}

/* ── Golden-cross scanner ────────────────────────────────────────────────────
 * Surfaces names where the 50-day EMA sits BELOW the 200-day EMA but is RISING
 * and within EMA_CROSS_NEAR_PCT of crossing above it.
 *
 * Universe: the most valuable liquid US equities (screener, market-cap sorted),
 * unioned with the saved watchlist so the user's own names are always covered.
 * A golden cross is a slow structural signal, so the result is cached 1h.
 * ─────────────────────────────────────────────────────────────────────────── */
const GOLDEN_UNIVERSE_SIZE = 250;

async function goldenCrossUniverse(env) {
  const symbols = new Set();
  let source = 'screener';

  // Primary: crumb-authed custom screener — liquid, market-cap ranked.
  try {
    const body = {
      size: GOLDEN_UNIVERSE_SIZE, offset: 0,
      sortField: 'intradaymarketcap', sortType: 'DESC', quoteType: 'EQUITY',
      query: {
        operator: 'AND',
        operands: [
          { operator: 'eq', operands: ['region', 'us'] },
          { operator: 'gt', operands: ['intradayprice', 5] },
          { operator: 'gt', operands: ['avgdailyvol3m', 1_000_000] },
        ],
      },
      userId: '', userIdType: 'guid',
    };
    const make = async (crumb, cookie) => {
      const headers = { ...YAHOO_HEADERS, 'Content-Type': 'application/json' };
      if (cookie) headers['Cookie'] = cookie;
      return fetch(
        `https://query2.finance.yahoo.com/v1/finance/screener?crumb=${encodeURIComponent(crumb)}&formatted=true&lang=en-US&region=US`,
        { method: 'POST', headers, body: JSON.stringify(body) },
      );
    };
    let { crumb, cookie } = await getYahooCrumb(env);
    let r = await make(crumb, cookie);
    if (r.status === 401 || r.status === 403) {
      _crumbCache = null;
      ({ crumb, cookie } = await getYahooCrumb(env));
      r = await make(crumb, cookie);
    }
    if (r.ok) {
      const d = await r.json();
      for (const q of (d?.finance?.result?.[0]?.quotes || [])) {
        if (q.symbol && (!q.exchange || SCANNER_MAJOR_EXCHANGES.has(q.exchange))) symbols.add(q.symbol);
      }
    }
  } catch (_) {}

  // Fallback: predefined most-actives (no crumb required).
  if (symbols.size < 50) {
    source = symbols.size ? 'screener+actives' : 'most_actives';
    try {
      const r = await fetch(
        'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=true&scrIds=most_actives&count=250',
        { headers: YAHOO_HEADERS },
      );
      if (r.ok) {
        const d = await r.json();
        for (const q of (d?.finance?.result?.[0]?.quotes || [])) {
          if (q.symbol && (!q.exchange || SCANNER_MAJOR_EXCHANGES.has(q.exchange))) symbols.add(q.symbol);
        }
      }
    } catch (_) {}
  }

  // Always include the saved watchlist.
  let watchlistCount = 0;
  try {
    const wl = await env?.REC_LOG?.get('watchlist:tickers', 'json');
    if (Array.isArray(wl)) { wl.forEach(t => symbols.add(t)); watchlistCount = wl.length; }
  } catch (_) {}

  // Drop non-equity share classes spark handles poorly (warrants, units, rights).
  const list = [...symbols].filter(s => /^[A-Z][A-Z.-]{0,6}$/.test(s) && !/[.-](WS|U|R|RT)$/.test(s));
  return { symbols: list, source, watchlistCount };
}

async function handleGoldenCross(origin, env, params) {
  const KV_KEY = 'market:goldencross';
  const GOLDEN_TTL = 3_600_000; // 1h — EMA crosses move on a daily timescale
  const SCHEMA = 2;      // bump when the row shape changes, to retire old caches
  const force = params?.get('refresh') === '1';

  let cached = null;
  try { cached = await env?.REC_LOG?.get(KV_KEY, 'json'); } catch (_) {}
  if (cached && cached.schema !== SCHEMA) cached = null;

  // Stale-while-revalidate: return the banked snapshot at any age, never rebuild.
  if (params?.get('cached') === '1') {
    return json(cached ? { ...cached, cached: true } : { results: [], ...emptySnapshot('Yahoo daily closes', TTL.golden) }, 200, origin);
  }

  if (!force && cached && Date.now() - (cached.ts || 0) < GOLDEN_TTL) {
    return json({ ...cached, cached: true }, 200, origin);
  }

  const { symbols, source, watchlistCount } = await goldenCrossUniverse(env);
  if (!symbols.length) return err('universe unavailable', 502, origin);

  const closesBySymbol = await yahooSparkCloses(symbols, '3y');

  const results = [];
  let evaluated = 0, skipped = 0;
  for (const [symbol, closes] of closesBySymbol) {
    const st = emaCrossState(closes);
    if (!st) { skipped++; continue; }
    evaluated++;
    if (!st.goldenSetup) continue;
    // Same geometry on simple MAs, shown alongside. The SMA pair crosses on its
    // own schedule — it lags the EMA pair, so the two gaps rarely agree and the
    // SMA one can still be widening while the EMA one closes.
    const sma = smaCrossState(closes);
    results.push({
      ticker: symbol,
      price:  Math.round(closes[closes.length - 1] * 100) / 100,
      ema50:  st.ema50,
      ema200: st.ema200,
      gap:    st.gap,        // % below the 200-day EMA
      slope:  st.slope,      // 5-session EMA50 change, %
      barsToCross: st.barsToCross,
      sma50:  sma?.sma50  ?? null,
      sma200: sma?.sma200 ?? null,
      smaGap:    sma?.gap    ?? null,   // distance between the SMAs, %
      smaSpread: sma?.spread ?? null,   // signed: > 0 means SMA50 is already above
      smaSlope:  sma?.slope  ?? null,
      smaBarsToCross: sma?.barsToCross ?? null,
    });
  }

  // Closest to crossing first; break ties on the stronger upward slope.
  results.sort((a, b) => a.gap - b.gap || b.slope - a.slope);

  const payload = {
    results,
    count: results.length,
    universe: symbols.length,
    evaluated,
    skipped,
    source,
    watchlistCount,
    nearPct: EMA_CROSS_NEAR_PCT,
    slopeBars: EMA_CROSS_SLOPE_BARS,
    schema: SCHEMA,
    ts: Date.now(),
    _meta: srcMeta('Yahoo daily closes', {
      delayed: true, ttlSeconds: TTL.golden,
      note: `${results.length} setups from ${evaluated} evaluated · EMA 50/200 over 3y`,
    }),
  };
  try { await env?.REC_LOG?.put(KV_KEY, JSON.stringify(payload), { expirationTtl: 7200 }); } catch (_) {}
  return json(payload, 200, origin);
}

async function handleMarketIPOs(origin, env) {
  const KV_KEY = 'market:ipos';
  const IPO_TTL = 43_200_000; // 12 hours

  try {
    const cached = await env?.REC_LOG?.get(KV_KEY, 'json');
    if (cached && Date.now() - cached.ts < IPO_TTL) return json(cached, 200, origin);
  } catch (_) {}

  const NASDAQ_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.nasdaq.com',
    'Referer': 'https://www.nasdaq.com/market-activity/ipos',
  };

  // Build list of months to fetch (current + next 2)
  const today = new Date();
  const months = [0, 1, 2].map(offset => {
    const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  let ipos = [];

  // Primary: NASDAQ IPO calendar API
  try {
    const results = await Promise.allSettled(
      months.map(m => fetch(`https://api.nasdaq.com/api/ipo/calendar?date=${m}`, { headers: NASDAQ_HEADERS })),
    );
    for (const res of results) {
      if (res.status !== 'fulfilled' || !res.value.ok) continue;
      const d = await res.value.json();
      // Upcoming (not yet priced)
      const upcoming = d.data?.upcoming?.upcomingTable?.rows || [];
      for (const row of upcoming) {
        const sym = row.proposedTickerSymbol?.trim() || '';
        if (ipos.find(i => i.ticker === sym && sym)) continue;
        ipos.push({
          name:     row.companyName || '',
          ticker:   sym,
          date:     row.expectedPriceDate || '',
          exchange: row.proposedExchange || '',
          price:    row.proposedSharePrice || 'TBD',
          status:   'upcoming',
        });
      }
      // Recently filed (S-1 / prospectus)
      const filings = d.data?.filings?.filingTable?.rows || [];
      for (const row of filings) {
        const sym = row.proposedTickerSymbol?.trim() || '';
        if (ipos.find(i => i.ticker === sym && sym)) continue;
        ipos.push({
          name:     row.companyName || '',
          ticker:   sym,
          date:     row.filedDate || '',
          exchange: row.proposedExchange || '',
          price:    row.proposedSharePrice || 'TBD',
          status:   'filed',
        });
      }
    }
  } catch (e) {
    console.error('[ipos] NASDAQ failed:', e.message);
  }

  // Fallback: Yahoo Finance IPO calendar
  if (!ipos.length) {
    try {
      const from = today.toISOString().split('T')[0];
      const to   = new Date(today.getTime() + 90 * 86_400_000).toISOString().split('T')[0];
      const r    = await fetch(
        `https://query2.finance.yahoo.com/v2/finance/calendar/ipo?from=${from}&to=${to}`,
        { headers: YAHOO_HEADERS },
      );
      if (r.ok) {
        const d      = await r.json();
        const events = d.ipoCalendar?.ipoData || [];
        ipos = events.map(e => ({
          name:     e.companyName || e.company || '',
          ticker:   e.symbol || '',
          date:     e.startDate?.fmt || e.date || '',
          exchange: e.exchange || '',
          price:    e.priceLow && e.priceHigh ? `$${e.priceLow}–$${e.priceHigh}` : (e.price || 'TBD'),
          status:   'upcoming',
        }));
      }
    } catch (e) {
      console.error('[ipos] Yahoo fallback failed:', e.message);
    }
  }

  // Sort: upcoming by date asc, filed after
  ipos.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'upcoming' ? -1 : 1;
    return (a.date || '').localeCompare(b.date || '');
  });

  const result = {
    ipos: ipos.slice(0, 20), ts: Date.now(),
    _meta: srcMeta('Yahoo IPO calendar', {
      ok: ipos.length > 0, ttlSeconds: TTL.ipos,
      note: ipos.length ? `${Math.min(ipos.length, 20)} upcoming` : 'no upcoming IPOs returned',
    }),
  };
  env?.REC_LOG?.put(KV_KEY, JSON.stringify(result), { expirationTtl: 43200 }).catch(() => {});
  return json(result, 200, origin);
}

// Persist the user's watchlist so the 6am cron can refresh analysis for exactly
// the tickers on their Watchlist tab (not just the static default list).
async function handleWatchlistSave(request, origin, env) {
  const body = await request.json().catch(() => null);
  const tickers = Array.isArray(body?.tickers)
    ? [...new Set(body.tickers.map(t => String(t).trim().toUpperCase()).filter(Boolean))].slice(0, 60)
    : null;
  if (!tickers || !tickers.length) return err('tickers required', 400, origin);
  await env?.REC_LOG?.put('watchlist:tickers', JSON.stringify(tickers));
  return json({ ok: true, count: tickers.length }, 200, origin);
}

async function handleWatchlistBatch(symbols, origin, env, ctx, request) {
  const tickers = symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 30);
  if (!tickers.length) return err('symbols required', 400, origin);

  // Pre-warm the crumb once so all parallel Yahoo v10 calls share it
  await getYahooCrumb(env).catch(() => {});

  // Golden/death cross needs a long close history — one spark call per 20
  // tickers, fired now and merged in after the per-ticker work below.
  const crossClosesPromise = yahooSparkCloses(tickers, '3y').catch(() => new Map());

  const stocks = {};

  // Process in chunks of 4 to avoid rate-limiting Yahoo with 40+ concurrent requests
  const CHUNK = 4;
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const batch = tickers.slice(i, i + CHUNK);
    await Promise.allSettled(batch.map(async ticker => {
      try {
        const [chartRes, fundRes, analysisRes] = await Promise.allSettled([
          yahoo(`/v8/finance/chart/${ticker}`, '?range=3mo&interval=1d'),
          yahooAuth(
            `/v10/finance/quoteSummary/${ticker}`,
            '?modules=price,summaryDetail,defaultKeyStatistics,financialData,calendarEvents,assetProfile',
            env,
          ),
          env?.REC_LOG?.get(`analysis:${ticker}`, 'json'),
        ]);

        let price = null, changePct = null, volume = null;
        let w52High = null, w52Low = null;
        let rsi = null, support = null, resist = null;

        if (chartRes.status === 'fulfilled') {
          const result = chartRes.value?.chart?.result?.[0];
          const meta   = result?.meta || {};
          const q      = result?.indicators?.quote?.[0] || {};
          const closes = (q.close || []).filter(v => v != null);
          const highs  = (q.high  || []).filter(v => v != null);
          const lows   = (q.low   || []).filter(v => v != null);

          price   = meta.regularMarketPrice ?? null;
          volume  = meta.regularMarketVolume ?? null;
          w52High = meta.fiftyTwoWeekHigh ?? null;
          w52Low  = meta.fiftyTwoWeekLow  ?? null;
          // changePct derived from fundRes price module below for accuracy

          if (closes.length >= 15) rsi = computeRSI(closes);
          if (highs.length  >= 5)  ({ support, resist } = computeSR(highs, lows));
        }

        let pe = null, forwardPE = null, targetLow = null, targetMean = null, targetHigh = null;
        let shortPct = null, earningsDate = null, daysToEarnings = null, sector = null;
        let sma50 = null, sma200 = null;

        if (fundRes.status === 'fulfilled') {
          const r = fundRes.value?.quoteSummary?.result?.[0] || {};
          pe         = r.summaryDetail?.trailingPE?.raw ?? null;
          forwardPE  = r.defaultKeyStatistics?.forwardPE?.raw ?? null;
          targetLow  = r.financialData?.targetLowPrice?.raw ?? null;
          targetMean = r.financialData?.targetMeanPrice?.raw ?? null;
          targetHigh = r.financialData?.targetHighPrice?.raw ?? null;
          shortPct   = r.defaultKeyStatistics?.shortPercentOfFloat?.raw ?? null;
          sector     = r.assetProfile?.sector ?? null;
          // Yahoo's 50/200-day averages are simple moving averages of daily closes
          // through the prior close (today's in-progress bar is excluded).
          sma50      = r.summaryDetail?.fiftyDayAverage?.raw ?? null;
          sma200     = r.summaryDetail?.twoHundredDayAverage?.raw ?? null;

          // Use quoteSummary price module for authoritative 1-day values
          const qPrice   = r.price?.regularMarketPrice?.raw ?? null;
          const qPctRaw  = r.price?.regularMarketChangePercent?.raw ?? null;  // decimal, e.g. 0.025 = +2.5%
          const qPrev    = r.price?.regularMarketPreviousClose?.raw ?? null;
          if (qPrice  != null) price = qPrice;
          volume = r.price?.regularMarketVolume?.raw ?? volume;
          if (qPctRaw != null) {
            changePct = Math.round(qPctRaw * 10000) / 100;
          } else if (qPrice != null && qPrev != null) {
            changePct = Math.round((qPrice - qPrev) / qPrev * 10000) / 100;
          }

          const epoch = r.calendarEvents?.earnings?.earningsDate?.[0]?.raw;
          if (epoch) {
            const d = new Date(epoch * 1000);
            earningsDate   = `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}, '${String(d.getFullYear()).slice(2)}`;
            daysToEarnings = Math.ceil((d.getTime() - Date.now()) / 86_400_000);
          }
        }

        // Claude analysis from KV (written by cron or previous on-demand run)
        let recommendation = null, drivers = null, summary = null, rating = null, confidence = null, analysisTs = null;
        const cached = analysisRes.status === 'fulfilled' ? analysisRes.value : null;
        // Entries written before the four columns were consolidated carry a rating
        // but no `recommendation`. Treat those as absent so the row regenerates in
        // the new shape instead of rendering a badge with an empty call beside it.
        if (cached && cached.recommendation && Date.now() - (cached.ts || 0) < 172_800_000) {
          ({ recommendation, drivers, summary, rating, confidence } = cached);
          analysisTs = cached.ts;
        }

        // Nearest decision level: whichever of support/resistance the price sits
        // closest to in percentage terms. The watchlist shows one, not both.
        let levelPct = null, levelKind = null, levelAbove = null, levelPrice = null;
        if (price != null) {
          for (const [kind, lvl] of [['support', support], ['resistance', resist]]) {
            if (lvl == null || !isFinite(lvl) || lvl <= 0) continue;
            const d = Math.abs(price - lvl) / price * 100;
            if (levelPct == null || d < levelPct) {
              levelPct   = Math.round(d * 100) / 100;
              levelKind  = kind;
              levelPrice = lvl;
              levelAbove = price >= lvl;
            }
          }
        }

        stocks[ticker] = {
          symbol: ticker,
          price,
          changePct,
          volume,
          pe:         pe        != null ? Math.round(pe        * 10) / 10 : null,
          forwardPE:  forwardPE != null ? Math.round(forwardPE * 10) / 10 : null,
          sector,
          w52High,
          w52Low,
          targetLow:  targetLow  != null ? Math.round(targetLow  * 100) / 100 : null,
          targetMean: targetMean != null ? Math.round(targetMean * 100) / 100 : null,
          targetHigh: targetHigh != null ? Math.round(targetHigh * 100) / 100 : null,
          shortPct:   shortPct   != null ? Math.round(shortPct   * 10000) / 100 : null,
          earningsDate,
          daysToEarnings,
          sma50:    sma50  != null ? Math.round(sma50  * 100) / 100 : null,
          sma200:   sma200 != null ? Math.round(sma200 * 100) / 100 : null,
          pctVs50:  price != null && sma50  ? Math.round((price - sma50)  / sma50  * 10000) / 100 : null,
          pctVs200: price != null && sma200 ? Math.round((price - sma200) / sma200 * 10000) / 100 : null,
          smaSpread: sma50 != null && sma200 ? Math.round((sma50 - sma200) / sma200 * 10000) / 100 : null,
          rsi,
          support,
          resist,
          levelPct,
          levelKind,
          levelAbove,
          levelPrice,
          recommendation,
          drivers,
          summary,
          rating,
          confidence,
          // Sort key for the consolidated column: strongest BUY through strongest
          // SELL in one pass. Signed so conviction ranks within each rating.
          recRank: rating
            ? (rating === 'BUY' ? 1 : rating === 'SELL' ? -1 : 0) * (confidence ?? 50)
            : null,
          analysisTs,
        };
      } catch (e) {
        console.error(`[watchlist] ${ticker}:`, e.message);
        stocks[ticker] = { symbol: ticker, error: e.message };
      }
    }));
  }

  // Merge golden/death cross state for the `SMA X` column. Deliberately
  // MA-agnostic field names: `sma50`/`sma200` above are Yahoo's own averages
  // through the prior close and must not be clobbered by ours, and the column's
  // MA type has already changed once. Tickers with too little history keep
  // nulls, which the UI renders as "—" rather than a misleading state.
  try {
    const closesBySymbol = await crossClosesPromise;
    for (const t of tickers) {
      const s = stocks[t];
      if (!s || s.error) continue;
      const st = smaCrossState(closesBySymbol.get(t));
      if (!st) continue;
      s.crossFast      = st.sma50;
      s.crossSlow      = st.sma200;
      s.crossSpread    = st.spread;
      s.crossGap       = st.gap;
      s.crossSlope     = st.slope;
      s.crossSpreadChg = st.spreadChg;
      s.crossBarsToCross = st.barsToCross;
      s.goldenSetup    = st.goldenSetup;
      s.deathSetup     = st.deathSetup;
    }
  } catch (e) {
    console.error('[watchlist] sma cross:', e.message);
  }

  // Fire on-demand Claude analysis for tickers that have no cached entry.
  // Runs after the response is sent so it doesn't block the client.
  const needsAnalysis = tickers.filter(t => stocks[t] && !stocks[t].recommendation && !stocks[t].error);
  // THE fan-out: up to 30 uncached symbols in one request became 30 Claude calls.
  // The row data is served either way; only the analysis spend is gated.
  // Order matters: `maySpend` INCREMENTS the counter, so asking before we know
  // there is anything to analyse would charge an ordinary cached page load
  // against the daily ceiling. Charge for exactly the number of analyses queued.
  const willAnalyse = needsAnalysis.length > 0 && ctx && env?.ANTHROPIC_API_KEY;
  if (willAnalyse && await maySpend(request, env, needsAnalysis.length)) {
    ctx.waitUntil((async () => {
      for (let i = 0; i < needsAnalysis.length; i += 5) {
        await Promise.allSettled(
          needsAnalysis.slice(i, i + 5).map(t => refreshTickerAnalysis(t, env)),
        );
      }
    })());
  }

  // Three different clocks land in one watchlist row and the badge has to say so:
  // the price is 15 minutes behind, the fundamentals are a 6-hour cache, and the
  // Recommendation column is whatever the nightly Claude pass last wrote.
  return json({
    stocks, analysisLoading: needsAnalysis.length > 0, ts: Date.now(),
    _meta: srcMeta('Yahoo Finance + Claude', {
      delayed: true, ttlSeconds: TTL.quote,
      note: `price ${YAHOO_DELAY_NOTE} · fundamentals cached 6h · recommendation refreshed daily`,
    }),
  }, 200, origin);
}

async function handleWatchlistAuction(symbols, origin, env, ctx) {
  const tickers = symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 30);
  if (!tickers.length) return err('symbols required', 400, origin);

  const etDate   = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const cacheKey = `auction:${etDate}:${tickers.slice().sort().join(',')}`;

  try {
    const cached = await env?.REC_LOG?.get(cacheKey, 'json');
    if (cached && Date.now() - cached.ts < 72_000_000) return json(cached, 200, origin);
  } catch (_) {}

  // Return early if market hasn't closed yet (before 4:01pm ET)
  const nowParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const etH = parseInt(nowParts.find(p => p.type === 'hour').value);
  const etM = parseInt(nowParts.find(p => p.type === 'minute').value);
  if (etH < 16 || (etH === 16 && etM < 1)) {
    return json({ auction: {}, pending: true, ts: Date.now() }, 200, origin);
  }

  const auction = {};

  for (let i = 0; i < tickers.length; i += 5) {
    await Promise.allSettled(
      tickers.slice(i, i + 5).map(async ticker => {
        try {
          const data = await yahoo(
            `/v8/finance/chart/${ticker}`,
            '?range=1d&interval=1m&includePrePost=true',
          );
          const result = data?.chart?.result?.[0];
          if (!result) return;

          const meta       = result.meta       || {};
          const timestamps = result.timestamp  || [];
          const q          = result.indicators?.quote?.[0] || {};
          const closes  = q.close  || [];
          const volumes = q.volume || [];
          const opens   = q.open   || [];

          const regularClose = meta.regularMarketPrice ?? meta.chartPreviousClose ?? null;
          const closeTs      = meta.regularMarketTime  ?? null; // Unix secs, end of regular session
          if (regularClose == null || closeTs == null) return;

          // First bar strictly after the regular session close timestamp
          let ahIdx = -1;
          for (let j = 0; j < timestamps.length; j++) {
            if (timestamps[j] > closeTs) { ahIdx = j; break; }
          }
          if (ahIdx === -1) return;

          const ahVol    = volumes[ahIdx] ?? 0;
          const ahOpen   = opens[ahIdx]   ?? null;
          const ahClose  = closes[ahIdx]  ?? null;
          const ahChg    = ahClose != null ? Math.round((ahClose - regularClose) * 100) / 100 : null;
          const ahChgPct = ahClose != null ? Math.round((ahClose - regularClose) / regularClose * 10000) / 100 : null;

          auction[ticker] = { regularClose, ahVol, ahOpen, ahClose, ahChg, ahChgPct };
        } catch (e) {
          console.error(`[auction] ${ticker}:`, e.message);
        }
      })
    );
  }

  const result = { auction, pending: false, ts: Date.now() };
  if (ctx) ctx.waitUntil(
    env?.REC_LOG?.put(cacheKey, JSON.stringify(result), { expirationTtl: 72000 }).catch(() => {})
  );
  return json(result, 200, origin);
}

async function handleDailyGet(origin, env, ctx, request) {
  try {
    const [snapshotRes, eodRes, middayRes] = await Promise.allSettled([
      env?.REC_LOG?.get('daily:snapshot', 'json'),
      env?.REC_LOG?.get('daily:eod', 'json'),
      env?.REC_LOG?.get('daily:midday', 'json'),
    ]);
    const snapshot = snapshotRes.status === 'fulfilled' ? snapshotRes.value : null;
    const eod      = eodRes.status === 'fulfilled' ? eodRes.value : null;
    const midday   = middayRes.status === 'fulfilled' ? middayRes.value : null;

    const ptNow     = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const isWeekday = ptNow.getDay() >= 1 && ptNow.getDay() <= 5;
    const minsPT    = ptNow.getHours() * 60 + ptNow.getMinutes();

    // Auto-trigger EOD generation if market is closed, data is missing, and we have API access
    let eodLoading = false;
    if (!eod && ctx && env?.ANTHROPIC_API_KEY) {
      // Market closes at 1pm PT; allow generation from 1pm through midnight
      if (isWeekday && minsPT >= 780) {
        ctx.waitUntil(generateEODSummary(env));
        eodLoading = true;
      }
    }

    // No fetch-path self-heal for the midday pulse: the pipeline (~50s) outruns
    // the ~30s fetch-context waitUntil budget, so a trigger here can never
    // complete — it only burns Yahoo quota and a billed Claude call per page
    // poll. The cron retries every 15 min from 11:30am to 1pm PT instead, and
    // POST /api/admin/refresh-midday covers manual regeneration. middayLoading
    // just tells the UI a cron run is still expected shortly.
    const middayLoading = !midday && isWeekday && minsPT >= 690 && minsPT < 800;

    if (snapshot) {
      const isComplete = (snapshot.newsCards?.length || 0) > 0 || snapshot.opportunity;
      const isStale    = Date.now() - (snapshot.ts || 0) > 43_200_000;
      // Regenerate in background if the cron missed (stale) OR left an empty/failed
      // snapshot (incomplete) — the latter recovers a blank briefing on first visit.
      // The cached briefing is served to anyone; only the REGENERATION is gated.
      if (ctx && env?.ANTHROPIC_API_KEY && (isStale || !isComplete) && await maySpend(request, env)) {
        ctx.waitUntil(generateDailySnapshot(env));
      }
      // Signal "still preparing" when there's nothing useful yet, so the UI shows a
      // friendly loading state instead of an empty briefing.
      const loading = !isComplete;
      return json({
        ...snapshot, eod: eod || null, eodLoading, midday: midday || null, middayLoading, loading,
        _meta: srcMeta('Claude synthesis', {
          ok: isComplete, ttlSeconds: TTL.daily,
          asOf: snapshot.ts ? new Date(snapshot.ts).toISOString() : null,
          note: '6am PT briefing' + (isStale ? ' · regenerating' : ''),
        }),
      }, 200, origin);
    }
  } catch (_) {}

  // No morning snapshot — kick off generation, if this caller is allowed to spend.
  if (ctx && env?.ANTHROPIC_API_KEY && await maySpend(request, env)) {
    ctx.waitUntil(generateDailySnapshot(env));
  }
  return json({
    loading: true, ts: Date.now(),
    _meta: srcMeta('Claude synthesis', { ok: false, ttlSeconds: TTL.daily, note: 'generating' }),
  }, 200, origin);
}

/* ── Cron: per-ticker analysis ──
 * Produces ONE consolidated recommendation per ticker rather than the separate
 * trend / pattern / action / rating fields the watchlist used to show in four
 * columns. Splitting them across columns invited the model to answer each in
 * isolation; a single call forces it to weigh the factors against each other and
 * commit, which is the judgement a trader actually wants from the row.
 *
 * The prompt is fed every factor the dashboard already has — technicals,
 * multi-period momentum, price action, fundamentals, positioning/sentiment — plus
 * the macro backdrop. Macro comes from the morning briefing and the hand-kept
 * FOMC/CPI tables, never from model memory (see the economic-calendar note). */
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    rating:         { type: 'string', enum: ['BUY', 'HOLD', 'SELL'] },
    confidence:     { type: 'integer' },
    recommendation: { type: 'string' },
    drivers:        { type: 'array', items: { type: 'string' } },
    summary:        { type: 'string' },
  },
  required: ['rating', 'confidence', 'recommendation', 'drivers', 'summary'],
  additionalProperties: false,
};

async function refreshTickerAnalysis(ticker, env) {
  try {
    const [chartRes, fundRes, snapRes] = await Promise.allSettled([
      yahoo(`/v8/finance/chart/${ticker}`, '?range=1y&interval=1d'),
      yahooAuth(
        `/v10/finance/quoteSummary/${ticker}`,
        '?modules=price,summaryDetail,defaultKeyStatistics,financialData,assetProfile,recommendationTrend',
        env,
      ),
      env?.REC_LOG?.get('daily:snapshot', 'json') ?? Promise.resolve(null),
    ]);

    const pct = (a, b) => (a == null || b == null || !b) ? null : Math.round((a - b) / b * 1000) / 10;

    let priceCtx = '', momentumCtx = '';
    if (chartRes.status === 'fulfilled') {
      const result = chartRes.value?.chart?.result?.[0];
      const meta   = result?.meta || {};
      const q      = result?.indicators?.quote?.[0] || {};
      const closes = (q.close  || []).filter(v => v != null);
      const highs  = (q.high   || []).filter(v => v != null);
      const lows   = (q.low    || []).filter(v => v != null);
      const vols   = (q.volume || []).filter(v => v != null);
      const price  = meta.regularMarketPrice ?? closes[closes.length - 1] ?? null;
      const w52h   = meta.fiftyTwoWeekHigh ?? null;
      const w52l   = meta.fiftyTwoWeekLow  ?? null;
      const rsi    = closes.length >= 15 ? computeRSI(closes) : null;
      const sr     = highs.length  >= 5  ? computeSR(highs, lows) : null;
      const at     = n => closes.length > n ? closes[closes.length - 1 - n] : null;
      const sma    = n => closes.length >= n
        ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : null;
      const s50 = sma(50), s200 = sma(200);
      // Where in the 52-week band the price sits — 0% at the low, 100% at the high.
      const bandPos = (price != null && w52h != null && w52l != null && w52h > w52l)
        ? Math.round((price - w52l) / (w52h - w52l) * 100) : null;
      const avgVol = vols.length >= 30
        ? vols.slice(-30).reduce((a, b) => a + b, 0) / 30 : null;
      const rvol = (avgVol && vols.length) ? Math.round(vols[vols.length - 1] / avgVol * 100) / 100 : null;

      priceCtx = [
        price != null && `Price $${price}`,
        w52l != null && w52h != null && `52W range $${w52l}–$${w52h}${bandPos != null ? ` (sitting ${bandPos}% up the band)` : ''}`,
        rsi != null && `RSI(14) ${rsi}`,
        sr && `Support $${sr.support}, Resistance $${sr.resist}`,
        s50 != null && `50D SMA $${s50.toFixed(2)}`,
        s200 != null && `200D SMA $${s200.toFixed(2)}`,
        s50 != null && s200 != null && `50D is ${pct(s50, s200) >= 0 ? 'above' : 'below'} 200D by ${Math.abs(pct(s50, s200))}%`,
      ].filter(Boolean).join('. ');

      momentumCtx = [
        pct(price, at(1))  != null && `1D ${pct(price, at(1))}%`,
        pct(price, at(5))  != null && `1W ${pct(price, at(5))}%`,
        pct(price, at(21)) != null && `1M ${pct(price, at(21))}%`,
        pct(price, at(63)) != null && `3M ${pct(price, at(63))}%`,
        pct(price, at(252))!= null && `1Y ${pct(price, at(252))}%`,
        rvol != null && `latest volume ${rvol}x the 30-day average`,
      ].filter(Boolean).join(', ');
    }

    let fundCtx = '', sentimentCtx = '', sector = null;
    if (fundRes.status === 'fulfilled') {
      const r  = fundRes.value?.quoteSummary?.result?.[0] || {};
      const sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {}, fd = r.financialData || {};
      sector = r.assetProfile?.sector ?? null;
      const num = v => v?.raw ?? null;
      fundCtx = [
        sector && `Sector: ${sector}`,
        r.assetProfile?.industry && `Industry: ${r.assetProfile.industry}`,
        num(sd.trailingPE)   != null && `Trailing P/E ${num(sd.trailingPE).toFixed(1)}`,
        num(ks.forwardPE)    != null && `Forward P/E ${num(ks.forwardPE).toFixed(1)}`,
        num(ks.pegRatio)     != null && `PEG ${num(ks.pegRatio).toFixed(2)}`,
        num(fd.profitMargins)!= null && `Net margin ${(num(fd.profitMargins) * 100).toFixed(1)}%`,
        num(fd.revenueGrowth)!= null && `Revenue growth ${(num(fd.revenueGrowth) * 100).toFixed(1)}% YoY`,
        num(fd.earningsGrowth)!= null && `Earnings growth ${(num(fd.earningsGrowth) * 100).toFixed(1)}% YoY`,
        num(fd.debtToEquity) != null && `Debt/equity ${num(fd.debtToEquity).toFixed(0)}`,
        num(fd.returnOnEquity)!= null && `ROE ${(num(fd.returnOnEquity) * 100).toFixed(1)}%`,
      ].filter(Boolean).join('. ');

      const rt = (r.recommendationTrend?.trend || [])[0];
      sentimentCtx = [
        num(fd.targetMeanPrice) != null && `Analyst mean target $${num(fd.targetMeanPrice)}`,
        fd.recommendationKey && `Street rating: ${fd.recommendationKey}`,
        rt && `Analyst spread — strong buy ${rt.strongBuy}, buy ${rt.buy}, hold ${rt.hold}, sell ${rt.sell}, strong sell ${rt.strongSell}`,
        num(ks.shortPercentOfFloat) != null && `Short interest ${(num(ks.shortPercentOfFloat) * 100).toFixed(1)}% of float`,
        num(ks.heldPercentInstitutions) != null && `Institutional ownership ${(num(ks.heldPercentInstitutions) * 100).toFixed(0)}%`,
        num(sd.dividendYield) != null && `Dividend yield ${(num(sd.dividendYield) * 100).toFixed(2)}%`,
      ].filter(Boolean).join('. ');
    }

    // Macro + geopolitical backdrop: reuse the morning briefing rather than asking
    // the model to recall world events, and take event dates only from the tables.
    const snap = snapRes.status === 'fulfilled' ? snapRes.value : null;
    const macroCtx = [
      snap?.headline && `Today's market headline: ${snap.headline}`,
      Array.isArray(snap?.newsCards) && snap.newsCards.length
        ? `Macro and geopolitical backdrop currently driving the tape:\n` +
          snap.newsCards.slice(0, 6).map(c => `• [${c.tag}] ${c.title} — ${c.body}`).join('\n')
        : null,
    ].filter(Boolean).join('\n');

    const econCtx = econPromptLines(econEventsAhead(3, etToday(), (await getEconReleases(env)).events));

    const prompt = `You are a senior portfolio manager. Weigh ALL the evidence below for ${ticker} and commit to ONE consolidated recommendation. Do not evaluate each category in isolation — decide what actually drives this name right now, let the dominant factors outweigh the noise, and say what you would do.

TECHNICALS AND PRICE ACTION
${priceCtx || 'Unavailable.'}

MOMENTUM
${momentumCtx || 'Unavailable.'}

FUNDAMENTALS
${fundCtx || 'Unavailable.'}

POSITIONING AND SENTIMENT
${sentimentCtx || 'Unavailable.'}

MACRO AND GEOPOLITICAL BACKDROP
${macroCtx || 'No market briefing available — weight company-specific evidence accordingly and do not invent macro or geopolitical events.'}

SCHEDULED MACRO EVENTS
${econCtx || 'Nothing scheduled in the tracked calendar.'}

Rules:
- Use ONLY the evidence above. Do not introduce news, earnings dates, or world events that are not stated here — your training data is stale and this is a live position.
- Weight the macro and geopolitical backdrop by how much it actually bears on THIS name and sector${sector ? ` (${sector})` : ''}; ignore it where it does not.
- "recommendation" is the single actionable line a PM would read in a table row: the call plus its trigger or level, at most 14 words. No hedging both ways.
- "drivers" lists the 2-4 factors that actually decided the call, most important first, 2-5 words each, each naming its category (e.g. "Momentum: 3M +18%", "Macro: CPI risk Wed").
- "confidence" reflects how strongly the evidence agrees. Genuine conflict between factors means a lower number, not a hedged recommendation.
- "summary" is 2-3 sentences explaining the call and naming the main thing that would invalidate it.`;

    const analysis = JSON.parse(await workerClaude(prompt, env, 700, ANALYSIS_SCHEMA));

    await env?.REC_LOG?.put(
      `analysis:${ticker}`,
      JSON.stringify({ ...analysis, ts: Date.now() }),
      { expirationTtl: 172800 },
    );
  } catch (e) {
    console.error(`[cron] analysis failed for ${ticker}:`, e.message);
  }
}

/* ── Economic calendar endpoint ──
 * FOMC dates come from the hardcoded table (the Fed calendar is not a FRED
 * release); everything else comes from FRED, cached 12h. `stale` warns when the
 * hand-maintained FOMC runway is running out; `dataReleases` reports whether the
 * FRED half is live, so the card can say what is missing rather than silently
 * showing a Fed-only calendar.
 */
async function handleEconCalendar(params, origin, env) {
  const limit  = Math.min(Math.max(parseInt(params.get('limit') || '6', 10) || 6, 1), 25);
  const today  = etToday();
  const fred   = await getEconReleases(env);
  const events = econEventsAhead(limit, today, fred.events).map(e => ({
    ...e,
    label: isoLabel(e.date, { weekday: 'short', year: 'numeric' }),
  }));

  return json({
    events,
    asOf:    today,
    through: ECON_CALENDAR_THROUGH,
    stale:   today > ECON_CALENDAR_THROUGH,
    dataReleases: {
      ok:      !fred.error,
      count:   fred.events.length,
      reason:  fred.error || fred.partial || null,
      source:  'FRED',
    },
    fomcSource: 'federalreserve.gov (hand-maintained table)',
    ts: Date.now(),
    _meta: srcMeta(fred.error ? 'FOMC calendar (FRED unavailable)' : 'FRED + FOMC calendar', {
      ok: !fred.error, ttlSeconds: TTL.econ, asOf: today,
      note: fred.error || fred.partial || `${events.length} events ahead`,
    }),
  }, 200, origin);
}

/* ── Earnings analysis ───────────────────────────────────────────────────────
 * User-triggered from the "Analyze Earnings" button on the research page, then
 * cached 12h in KV so repeat clicks and other viewers do not re-bill Claude.
 * Never call this from a polling path — see the credit-burn note on the daily
 * self-heal.
 *
 * There is no transcript feed in this stack (Yahoo/Alpaca do not carry them), so
 * "call commentary" is reconstructed from news published in the days around the
 * report. The prompt forbids inventing quotes, and the payload reports which
 * source the commentary came from so the UI can label it honestly.
 */
const EARNINGS_TTL = 43_200_000; // 12h

/** Daily bars as [{iso, open, close, volume}], oldest first. */
function chartDailyBars(chart) {
  const res = chart?.chart?.result?.[0];
  const ts  = res?.timestamp || [];
  const q   = res?.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close?.[i] == null) continue;
    out.push({
      iso:    new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open:   q.open?.[i] ?? null,
      close:  q.close[i],
      volume: q.volume?.[i] ?? null,
    });
  }
  return out;
}

/**
 * Measure how the tape absorbed a print.
 *
 * Yahoo does not reliably say whether a report landed before the open or after
 * the close, so rather than trust a timestamp we test both the report session
 * and the one after it and keep whichever moved more — that is the session that
 * actually traded the news.
 */
function earningsReaction(bars, reportIso) {
  const idx = bars.findIndex(b => b.iso >= reportIso);
  if (idx <= 0) return null;

  const candidates = [idx, idx + 1].filter(i => i < bars.length && i > 0);
  let best = null;
  for (const i of candidates) {
    const prev = bars[i - 1];
    const move = (bars[i].close - prev.close) / prev.close * 100;
    if (!best || Math.abs(move) > Math.abs(best.move)) best = { i, move, prev };
  }
  if (!best) return null;

  const bar   = bars[best.i];
  const prior = best.prev;
  const pct   = (v) => v == null ? null : Math.round(v * 100) / 100;

  // Average volume over the 30 sessions before the print, for a relative read.
  const preVols = bars.slice(Math.max(0, best.i - 31), best.i - 1).map(b => b.volume).filter(v => v != null);
  const avgVol  = preVols.length ? preVols.reduce((a, b) => a + b, 0) / preVols.length : null;

  const after5 = bars[best.i + 5];
  const latest = bars[bars.length - 1];

  // A report that landed today is still being traded — the bar is partial, so
  // its volume is not comparable to completed sessions.
  const isPartial = bar.iso === etToday();

  return {
    reportDate:   reportIso,
    reactionDate: bar.iso,
    // Compare dates, not indices: a missing bar for the report date would make
    // index equality claim "same session" for a later date.
    timing: bar.iso === reportIso ? 'same session as the report date' : 'session after the report date',
    isPartial,
    priorClose:   pct(prior.close),
    reactionClose: pct(bar.close),
    openGapPct:   bar.open != null ? pct((bar.open - prior.close) / prior.close * 100) : null,
    day1Pct:      pct(best.move),
    day5Pct:      after5 ? pct((after5.close - prior.close) / prior.close * 100) : null,
    sinceReportPct: pct((latest.close - prior.close) / prior.close * 100),
    volumeVsAvg:  !isPartial && avgVol && bar.volume ? Math.round(bar.volume / avgVol * 10) / 10 : null,
    sessionsSince: bars.length - 1 - best.i,
  };
}

/** Pull everything factual we can about the most recent completed report. */
async function gatherEarningsFacts(sym, env) {
  const modules = 'earnings,earningsHistory,earningsTrend,calendarEvents,price,summaryDetail,financialData';
  const [sumRes, chartRes] = await Promise.allSettled([
    yahooAuth(`/v10/finance/quoteSummary/${sym}`, `?modules=${modules}`, env),
    yahoo(`/v8/finance/chart/${sym}`, '?range=1y&interval=1d'),
  ]);

  if (sumRes.status !== 'fulfilled') {
    console.error(`[earnings] quoteSummary failed for ${sym}:`, sumRes.reason?.message);
  }
  const r = sumRes.status === 'fulfilled' ? (sumRes.value?.quoteSummary?.result?.[0] || {}) : {};
  const bars = chartRes.status === 'fulfilled' ? chartDailyBars(chartRes.value) : [];

  const num = (v) => v?.raw ?? (typeof v === 'number' ? v : null);
  const today = etToday();

  // ── Which report are we analysing? ──
  // Yahoo splits these: `earningsDate` is normally the *next* scheduled report,
  // while `earningsCallDate` is when the last call actually happened — that is
  // the one we want. Take the most recent past date across both, and only fall
  // back to gap-detection if neither carries a past date.
  const cal = r.calendarEvents?.earnings || {};
  const toIso = (e) => e?.fmt ?? (num(e) != null ? new Date(num(e) * 1000).toISOString().slice(0, 10) : null);
  const callDates = (cal.earningsCallDate || []).map(toIso).filter(Boolean);
  const dateDates = (cal.earningsDate || []).map(toIso).filter(Boolean);
  const pastDates = [...callDates, ...dateDates].filter(d => d <= today).sort();

  let reportIso  = pastDates.length ? pastDates[pastDates.length - 1] : null;
  let dateSource = reportIso
    ? (callDates.includes(reportIso) ? 'Yahoo earnings call date' : 'Yahoo earnings calendar')
    : null;

  // EPS is conventionally quoted to two decimals; Yahoo's consensus carries far
  // more precision than that ("0.34634"), which reads like false accuracy when
  // the model echoes it back.
  const eps = (v) => v == null ? null : Math.round(v * 100) / 100;
  const history = (r.earningsHistory?.history || []).map(h => ({
    quarter:     h.quarter?.fmt ?? null,
    epsActual:   eps(num(h.epsActual)),
    epsEstimate: eps(num(h.epsEstimate)),
    surprisePct: num(h.surprisePercent) != null ? Math.round(num(h.surprisePercent) * 1000) / 10 : null,
  })).filter(h => h.quarter);
  history.sort((a, b) => a.quarter.localeCompare(b.quarter));

  if (!reportIso && history.length && bars.length) {
    const qEnd = history[history.length - 1].quarter;
    const from = isoAddDays(qEnd, 7), to = isoAddDays(qEnd, 70);
    let best = null;
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].iso < from || bars[i].iso > to) continue;
      const gap = Math.abs((bars[i].close - bars[i - 1].close) / bars[i - 1].close);
      if (!best || gap > best.gap) best = { gap, iso: bars[i].iso };
    }
    if (best) {
      reportIso  = best.iso;
      dateSource = 'inferred from the largest post-quarter price gap (Yahoo carried no past report date)';
    }
  }

  const reaction = reportIso && bars.length ? earningsReaction(bars, reportIso) : null;

  // ── News from the report window — the only place call commentary can come from ──
  //
  // Alpaca carries a searchable news archive, so with keys configured this works
  // for any past quarter. Without them we fall back to Yahoo search, which only
  // returns the latest ~20 items and cannot be queried by date — so coverage is
  // recoverable for a fresh report and simply gone for an older one. Report which
  // case we are in rather than substituting today's unrelated headlines.
  let news = [];
  let newsStatus = 'none-found';
  const windowFrom = reportIso ? isoAddDays(reportIso, -1) : null;
  const windowTo   = reportIso ? isoAddDays(reportIso, 5) : null;
  const hasAlpaca  = Boolean(env?.ALPACA_KEY && env?.ALPACA_SECRET);

  if (reportIso) {
    if (hasAlpaca) {
      try {
        const d = await alpacaFetch(
          `/v1beta1/news?symbols=${sym}&start=${windowFrom}T00:00:00Z&end=${windowTo}T00:00:00Z` +
          '&limit=30&sort=asc&include_content=false', env,
        );
        news = (d.news || []).map(n => ({
          date:    n.created_at?.slice(0, 10) ?? null,
          source:  n.source ?? null,
          title:   n.headline ?? '',
          summary: (n.summary || '').replace(/\s+/g, ' ').slice(0, 400),
        })).filter(n => n.title);
      } catch (e) {
        console.error(`[earnings] Alpaca news failed for ${sym}:`, e.message);
      }
    }
    if (!news.length) {
      try {
        const resp = await fetch(
          `https://query2.finance.yahoo.com/v1/finance/search?q=${sym}&quotesCount=0&newsCount=20`,
          { headers: YAHOO_HEADERS },
        );
        if (resp.ok) {
          const d = await resp.json();
          news = (d.news || []).map(n => ({
            date:    n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString().slice(0, 10) : null,
            source:  n.publisher ?? null,
            title:   n.title ?? '',
            summary: '',
          })).filter(n => n.title && n.date && n.date >= windowFrom && n.date <= windowTo);
        }
      } catch (_) {}
    }
    if (news.length) newsStatus = 'ok';
    else if (!hasAlpaca) newsStatus = 'no-archive';
  } else {
    newsStatus = 'no-report-date';
  }

  const t0 = (r.earningsTrend?.trend || []).find(t => t.period === '0q') || {};
  const t1 = (r.earningsTrend?.trend || []).find(t => t.period === '+1q') || {};

  return {
    ticker:     sym,
    company:    r.price?.longName ?? r.price?.shortName ?? sym,
    reportDate: reportIso,
    dateSource,
    history:    history.slice(-4),
    revenue:    (r.earnings?.financialsChart?.quarterly || []).map(q => ({
      quarter: q.date ?? null, revenue: num(q.revenue), earnings: num(q.earnings),
    })).filter(q => q.quarter),
    nextQuarter: {
      epsEstimate:      eps(num(t1.earningsEstimate?.avg)),
      revenueEstimate:  num(t1.revenueEstimate?.avg),
      epsRevisedUp:     num(t1.epsRevisions?.upLast30days),
      epsRevisedDown:   num(t1.epsRevisions?.downLast30days),
      growthPct:        num(t1.growth) != null ? Math.round(num(t1.growth) * 1000) / 10 : null,
    },
    currentQuarter: {
      epsEstimate: eps(num(t0.earningsEstimate?.avg)),
      growthPct:   num(t0.growth) != null ? Math.round(num(t0.growth) * 1000) / 10 : null,
    },
    profile: {
      marketCap:      num(r.price?.marketCap),
      trailingPE:     num(r.summaryDetail?.trailingPE),
      forwardPE:      num(r.summaryDetail?.forwardPE),
      profitMargin:   num(r.financialData?.profitMargins) != null ? Math.round(num(r.financialData.profitMargins) * 1000) / 10 : null,
      revenueGrowth:  num(r.financialData?.revenueGrowth) != null ? Math.round(num(r.financialData.revenueGrowth) * 1000) / 10 : null,
      targetMean:     num(r.financialData?.targetMeanPrice),
      currentPrice:   num(r.price?.regularMarketPrice),
    },
    reaction,
    news,
    newsStatus,
    newsWindow: reportIso ? { from: windowFrom, to: windowTo } : null,
    newsSource: news.length ? (hasAlpaca ? 'Alpaca news wire' : 'Yahoo Finance news') : null,
  };
}

async function handleEarningsAnalysis(ticker, params, origin, env, ctx) {
  if (!ticker) return err('ticker required', 400, origin);
  const sym   = ticker.toUpperCase();
  const force = params?.get('refresh') === '1';
  const key   = `earnings:${sym}`;

  if (!force) {
    try {
      const cached = await env?.REC_LOG?.get(key, 'json');
      if (cached && Date.now() - cached.ts < EARNINGS_TTL) {
        return json({ ...cached, cached: true }, 200, origin);
      }
    } catch (_) {}
  }

  if (!env?.ANTHROPIC_API_KEY) return err('ANTHROPIC_API_KEY not configured', 500, origin);

  let facts;
  try {
    facts = await gatherEarningsFacts(sym, env);
  } catch (e) {
    console.error(`[earnings] data gather failed for ${sym}:`, e.message);
    return err('could not load earnings data', 502, origin);
  }

  // ?facts=1 returns the gathered data without spending a Claude call — for
  // checking what the upstreams actually returned.
  if (params?.get('facts') === '1') {
    return json({ ticker: sym, facts, analysis: null, factsOnly: true, ts: Date.now() }, 200, origin);
  }

  if (!facts.reportDate && !facts.history.length) {
    return json({
      ticker: sym, facts, analysis: null,
      error: 'No earnings history available for this symbol.',
      ts: Date.now(),
    }, 200, origin);
  }

  const histLines = facts.history.map(h =>
    `• ${h.quarter}: EPS ${h.epsActual ?? '?'} vs ${h.epsEstimate ?? '?'} est` +
    (h.surprisePct != null ? ` (${h.surprisePct > 0 ? '+' : ''}${h.surprisePct}% surprise)` : '')).join('\n');

  const revLines = facts.revenue.slice(-4).map(q =>
    `• ${q.quarter}: revenue ${q.revenue != null ? '$' + (q.revenue / 1e9).toFixed(2) + 'B' : '?'}` +
    `, earnings ${q.earnings != null ? '$' + (q.earnings / 1e9).toFixed(2) + 'B' : '?'}`).join('\n');

  const rx = facts.reaction;
  const rxBlock = rx ? [
    `Report date: ${rx.reportDate} (${facts.dateSource})`,
    `Session that traded the print: ${rx.reactionDate} (${rx.timing})`,
    `Close before the print: $${rx.priorClose}`,
    rx.openGapPct != null ? `Opening gap: ${rx.openGapPct > 0 ? '+' : ''}${rx.openGapPct}%` : null,
    `Move that session: ${rx.day1Pct > 0 ? '+' : ''}${rx.day1Pct}% (${rx.isPartial ? 'last trade' : 'closed'} $${rx.reactionClose})`,
    rx.isPartial ? 'NOTE: that session is still in progress — the move is live and incomplete, and session volume is not yet comparable to completed days. Describe it as the move so far, not a settled outcome.' : null,
    rx.volumeVsAvg != null ? `Volume: ${rx.volumeVsAvg}× the prior 30-session average` : null,
    rx.day5Pct != null ? `Five sessions later: ${rx.day5Pct > 0 ? '+' : ''}${rx.day5Pct}% vs the pre-print close` : null,
    `As of the latest close (${rx.sessionsSince} sessions on): ${rx.sinceReportPct > 0 ? '+' : ''}${rx.sinceReportPct}% vs the pre-print close`,
  ].filter(Boolean).join('\n') : 'Price reaction could not be measured — no usable report date.';

  const NEWS_EMPTY = {
    'no-archive':     'NONE AVAILABLE. This deployment has no news archive configured, so coverage from that date could not be retrieved. No commentary exists for you to summarise.',
    'no-report-date': 'NONE AVAILABLE. The report date could not be established, so no coverage window could be searched.',
    'none-found':     'NONE AVAILABLE. No coverage was published in the searched window.',
  };
  const newsBlock = facts.news.length
    ? facts.news.map(n => `• [${n.date}${n.source ? ' · ' + n.source : ''}] ${n.title}${n.summary ? ` — ${n.summary}` : ''}`).join('\n')
    : (NEWS_EMPTY[facts.newsStatus] || NEWS_EMPTY['none-found']);

  const prompt = `You are an equity research analyst. Summarise the most recent earnings report for ${facts.company} (${sym}) for a trader who wants to know what happened and why the stock moved.

EPS HISTORY (most recent last):
${histLines || 'Not available'}

QUARTERLY REVENUE / EARNINGS:
${revLines || 'Not available'}

PRICE REACTION (measured from daily bars):
${rxBlock}

FORWARD ESTIMATES:
• Current quarter: EPS est ${facts.currentQuarter.epsEstimate ?? '?'}, growth ${facts.currentQuarter.growthPct ?? '?'}%
• Next quarter: EPS est ${facts.nextQuarter.epsEstimate ?? '?'}, growth ${facts.nextQuarter.growthPct ?? '?'}%, analyst revisions last 30d: ${facts.nextQuarter.epsRevisedUp ?? 0} up / ${facts.nextQuarter.epsRevisedDown ?? 0} down

CONTEXT: market cap ${facts.profile.marketCap ? '$' + (facts.profile.marketCap / 1e9).toFixed(1) + 'B' : '?'}, trailing P/E ${facts.profile.trailingPE?.toFixed(1) ?? '?'}, forward P/E ${facts.profile.forwardPE?.toFixed(1) ?? '?'}, profit margin ${facts.profile.profitMargin ?? '?'}%, revenue growth ${facts.profile.revenueGrowth ?? '?'}%, price $${facts.profile.currentPrice ?? '?'}, mean analyst target $${facts.profile.targetMean ?? '?'}

NEWS PUBLISHED AROUND THE REPORT${facts.newsWindow ? ` (window ${facts.newsWindow.from} → ${facts.newsWindow.to}${facts.newsSource ? ', via ' + facts.newsSource : ''})` : ''}:
${newsBlock}

Return ONLY valid JSON (no markdown fences):
{
  "quarter": "which quarter this report covered, e.g. Q2 FY2026",
  "verdict": "BEAT" | "MISS" | "MIXED",
  "headline": "one sentence, max 130 chars, on what the print did to the stock",
  "scorecard": [ { "metric": "EPS", "actual": "$1.42", "estimate": "$1.30", "result": "beat" | "miss" | "inline" } ],
  "highlights": [ "3-5 bullets of the most important context from the numbers — growth, margins, segment or guidance detail" ],
  "callCommentary": [ { "theme": "short label", "detail": "what management or coverage said", "source": "publication name" } ],
  "priceAction": "2-3 sentences explaining the move: what the market rewarded or punished, and whether it held",
  "watchNext": [ "2-3 forward-looking items for the next report" ]
}

CRITICAL RULES:
- Every number you cite must come from the data above. Do not estimate or recall figures from training data.
- callCommentary must be grounded ONLY in the NEWS block above, with "source" naming the publication it came from. Never invent or paraphrase a quote that is not in that block. If the news block contains no management commentary or guidance detail, return an empty array — an empty array is the correct answer, not a reason to improvise.
- scorecard: every entry needs both an actual and an estimate drawn from the data above. If a metric has no estimate in the data, set "estimate" to "not available" and "result" to "n/a" — never call something a beat or a miss without an estimate to compare it against. Reported revenue is listed above without a consensus figure, so it can never be scored as a beat or miss.
- If the price reaction could not be measured, say so plainly in priceAction rather than guessing.`;

  let analysis = null;
  try {
    const text    = await workerClaude(prompt, env, 1800);
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    analysis = JSON.parse(cleaned);
  } catch (e) {
    console.error(`[earnings] analysis failed for ${sym}:`, e.message);
    return err('analysis generation failed', 502, origin);
  }

  // Enforce the rules the prompt asks for rather than trusting them. A metric
  // with no consensus figure cannot be a beat or a miss — the model gets this
  // right most of the time, and this makes it right every time.
  const arr = (v) => Array.isArray(v) ? v : [];
  const MISSING = /^(not available|n\/?a|none|unknown|—|-|\?|)$/i;
  analysis.scorecard = arr(analysis.scorecard).map(s => {
    const estimate = String(s?.estimate ?? '').trim();
    return MISSING.test(estimate)
      ? { ...s, estimate: 'not available', result: 'n/a' }
      : s;
  });
  analysis.highlights     = arr(analysis.highlights);
  analysis.watchNext      = arr(analysis.watchNext);
  // Commentary must be attributable; drop anything that lost its source.
  analysis.callCommentary = arr(analysis.callCommentary).filter(c => c?.detail && c?.source);

  const payload = {
    ticker: sym, facts, analysis, ts: Date.now(),
    _meta: srcMeta('Yahoo + Claude synthesis', {
      ttlSeconds: TTL.earnings, asOf: facts.reportDate || null,
      note: `last report${facts.dateSource ? ` · ${facts.dateSource}` : ''}`,
    }),
  };
  try { await env?.REC_LOG?.put(key, JSON.stringify(payload), { expirationTtl: 172800 }); } catch (_) {}
  return json(payload, 200, origin);
}

/* ── Week Ahead (Friday only, 18h KV cache) ── */
async function handleWeekAhead(origin, env) {
  try {
    const cached = await env?.REC_LOG?.get('market:week-ahead', 'json');
    if (cached && Date.now() - cached.ts < 64_800_000) return json(cached, 200, origin);
  } catch (_) {}

  // --- Date range: next Mon–Fri in PT ---
  const now    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const today  = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const daysToMon = now.getDay() === 0 ? 1 : 8 - now.getDay();
  const mon = new Date(now); mon.setDate(now.getDate() + daysToMon);
  const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
  const pad  = n => String(n).padStart(2, '0');
  const iso  = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const monIso = iso(mon);
  const friIso = iso(fri);
  const weekOf = `${mon.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}–${fri.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

  // --- Fetch verified earnings dates from Yahoo for a broad set of major tickers ---
  // 40 tickers max — bounds total subrequests (earnings + crumb + news + Claude).
  // Sized under the Free plan's 50; kept at 40 because Yahoo throttles long
  // before the current 10,000 cap does.
  const EARNINGS_WATCH = [
    // Watchlist core (22)
    'PLTR','NVDA','AMD','AAPL','AMZN','GOOGL','QUBT','TWLO','NOW','TSM',
    'MU','APP','CRCL','CRWV','MRK','UNH','TSLA','PANW','RDDT','CAVA','JPM','HOOD',
    // High-impact additions (18)
    'MSFT','META','NFLX','ORCL','CRM',   // major tech
    'HD','WMT','TGT','COST','LOW',        // retail (HD, WMT move markets)
    'GS','MS','BAC','WFC',                // major banks
    'LLY','PFE',                          // pharma
    'BA','XOM',                           // industrial / energy
  ];

  await getYahooCrumb(env).catch(() => {});
  const confirmedEarnings = [];
  const CHUNK = 8;
  for (let i = 0; i < EARNINGS_WATCH.length; i += CHUNK) {
    const batch = EARNINGS_WATCH.slice(i, i + CHUNK);
    const results = await Promise.allSettled(
      batch.map(t => yahooAuth(`/v10/finance/quoteSummary/${t}`, '?modules=calendarEvents', env)),
    );
    for (let j = 0; j < batch.length; j++) {
      if (results[j].status !== 'fulfilled') continue;
      const r     = results[j].value?.quoteSummary?.result?.[0];
      const dates = r?.calendarEvents?.earnings?.earningsDate || [];
      for (const ep of dates) {
        const fmt = ep.fmt ?? iso(new Date((ep.raw ?? ep) * 1000));
        if (fmt >= monIso && fmt <= friIso) {
          const d = new Date((ep.raw ?? ep) * 1000);
          confirmedEarnings.push({
            ticker:  batch[j],
            isoDate: fmt,
            label:   d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
          });
          break;
        }
      }
    }
  }

  const earningsBlock = confirmedEarnings.length
    ? 'CONFIRMED EARNINGS from Yahoo Finance — use these exact dates, do NOT alter or add others:\n' +
      confirmedEarnings
        .sort((a, b) => a.isoDate.localeCompare(b.isoDate))
        .map(e => `• ${e.ticker}: ${e.label}`)
        .join('\n')
    : 'No confirmed earnings from the monitored ticker list fall within this week.';

  // --- Gather news for macro / geopolitical context ---
  let newsLines = '';
  try {
    if (env?.ALPACA_KEY && env?.ALPACA_SECRET) {
      const data = await alpacaFetch('/v1beta1/news?limit=20&sort=desc', env);
      newsLines = (data.news || []).slice(0, 15).map(n => `• ${n.headline}`).join('\n');
    } else {
      const r = await fetch(
        'https://query2.finance.yahoo.com/v1/finance/search?q=stock+market+week+ahead&quotesCount=0&newsCount=15',
        { headers: YAHOO_HEADERS },
      );
      if (r.ok) {
        const d = await r.json();
        newsLines = (d.news || []).slice(0, 15).map(n => `• ${n.title}`).join('\n');
      }
    }
  } catch (_) {}

  const weekEcon = econEventsBetween(monIso, friIso, (await getEconReleases(env)).events);
  const econBlock = weekEcon.length
    ? 'CONFIRMED MACRO CALENDAR for this week (official Fed / BLS schedule — use these exact dates, do NOT alter or add others):\n' +
      econPromptLines(weekEcon)
    : 'No FOMC or CPI events fall within this week. Do NOT invent any.';

  const prompt = `You are a professional stock market strategist. Today is ${today}.

${earningsBlock}

${econBlock}

RECENT HEADLINES (for macro/geopolitical context):
${newsLines || 'Not available'}

Generate a "Week Ahead" preview for the trading week of ${weekOf}.

STRICT RULES:
1. Earnings events: ONLY include tickers from the CONFIRMED EARNINGS list above. Use the exact dates given. Do NOT add earnings for any company not listed.
2. Fed and scheduled-economic-data events (FOMC decisions, FOMC minutes, CPI): ONLY include events from the CONFIRMED MACRO CALENDAR above, using the exact dates given. Never state or estimate a date for an FOMC meeting or CPI print from memory — your training data is out of date and those dates would be wrong.
3. Geopolitical / Macro events may be drawn from the headlines above, but describe them as ongoing themes rather than assigning them a specific scheduled date you cannot verify.
4. Each Earnings title must include the full company name and ticker symbol.

Return ONLY valid JSON (no markdown):
{
  "weekOf": "${weekOf}",
  "overview": "2-sentence macro setup and dominant themes for the week",
  "events": [
    {
      "day": "Mon",
      "date": "May 19",
      "type": "Earnings|Fed|Economic|Geopolitical|Macro",
      "title": "Concise event title",
      "impact": "HIGH|MEDIUM|LOW",
      "note": "1-2 sentences on what to watch and expected market impact"
    }
  ]
}

Include 6–10 events total. Order chronologically Mon→Fri.`;

  let result;
  try {
    const text    = await workerClaude(prompt, env, 2000);
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    result = JSON.parse(cleaned);
  } catch (e) {
    console.error('[week-ahead] failed:', e.message);
    return err('generation failed', 500, origin);
  }

  const payload = {
    ...result, ts: Date.now(),
    _meta: srcMeta('Claude synthesis + FOMC/FRED calendar', {
      ttlSeconds: 64_800, note: 'week ahead · event dates from the calendar tables, not model memory',
    }),
  };
  try { await env?.REC_LOG?.put('market:week-ahead', JSON.stringify(payload), { expirationTtl: 64800 }); } catch (_) {}
  return json(payload, 200, origin);
}

/* ── Cron: daily snapshot ── */
async function generateDailySnapshot(env) {
  const mark = instrMark();
  // FRED supplies the statistical-release dates; FOMC comes from the hardcoded table.
  const fredEvents = (await getEconReleases(env)).events;
  // Dedup: skip only if a *complete* snapshot was generated in the last 2 hours.
  // A previously-cached empty fallback (Claude failed) must NOT block a retry,
  // otherwise one 6am hiccup leaves the briefing blank until tomorrow.
  let existingSnapshot = null;
  try {
    existingSnapshot = await env?.REC_LOG?.get('daily:snapshot', 'json');
    const isComplete = existingSnapshot &&
      ((existingSnapshot.newsCards?.length || 0) > 0 || existingSnapshot.opportunity);
    if (existingSnapshot && isComplete && Date.now() - existingSnapshot.ts < 7_200_000) {
      console.log('[cron] snapshot fresh, skipping');
      return;
    }
  } catch (_) {}

  // NOTE: yesterday's EOD and midday pulse are cleared AFTER the new snapshot is
  // safely written, not here. This block used to delete them up front, before it
  // knew whether the briefing would generate at all — so a Claude failure, a
  // Yahoo outage or an exception anywhere below left the page with no morning
  // briefing AND no close recap. A stale-but-labelled recap beats a blank card.
  // See the delete beside the successful `put` further down.

  // Gather macro news
  let newsLines = '';
  try {
    if (env?.ALPACA_KEY && env?.ALPACA_SECRET) {
      const data = await alpacaFetch('/v1beta1/news?limit=20&sort=desc', env);
      newsLines = (data.news || []).slice(0, 15).map(n => `• ${n.headline}`).join('\n');
    } else {
      const r = await fetch(
        'https://query2.finance.yahoo.com/v1/finance/search?q=market+today&quotesCount=0&newsCount=15',
        { headers: YAHOO_HEADERS },
      );
      if (r.ok) {
        const d = await r.json();
        newsLines = (d.news || []).slice(0, 15).map(n => `• ${n.title}`).join('\n');
      }
    }
  } catch (_) {}

  // Gather market context
  let marketLines = '';
  try {
    const tickers = Object.keys(SNAPSHOT_SYMBOLS);
    const results = await allSettledCounted(
      tickers.map(t => yahoo(`/v8/finance/chart/${encodeURIComponent(t)}`, '?range=1d&interval=1d')),
    'snapshot:index-charts');
    marketLines = tickers.map((t, i) => {
      if (results[i].status !== 'fulfilled') return null;
      const meta      = results[i].value?.chart?.result?.[0]?.meta || {};
      const price     = meta.regularMarketPrice;
      const prev      = meta.chartPreviousClose ?? meta.previousClose;
      if (price == null || prev == null) return null;
      const chg = ((price - prev) / prev * 100).toFixed(2);
      return `${SNAPSHOT_SYMBOLS[t]}: ${price.toFixed(2)} (${chg > 0 ? '+' : ''}${chg}%)`;
    }).filter(Boolean).join('\n');
  } catch (_) {}

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    timeZone: 'America/Los_Angeles',
  });

  const prompt = `You are a professional stock market analyst. Today is ${today}.

MARKET DATA:
${marketLines || 'Not available'}

RECENT NEWS HEADLINES:
${newsLines || 'Not available'}

UPCOMING MACRO CALENDAR (official Fed / BLS schedule — the only source for these dates):
${econPromptLines(econEventsAhead(4, etToday(), fredEvents)) || 'Nothing scheduled in the tracked calendar.'}

Generate a morning market briefing as valid JSON with exactly these fields:
{
  "headline": "One-sentence market summary (max 120 chars)",
  "open": {
    "headline": "One-sentence market open outlook (max 120 chars)",
    "body": "2-3 sentences on key levels, sectors to watch, and the expected tone of today's session."
  },
  "newsCards": [
    { "title": "short title", "body": "2-sentence analysis", "tag": "Macro|Fed|Sector|Geopolitical|Earnings" }
  ],
  "opportunity": { "ticker": "SYMBOL", "reason": "1-2 sentences" },
  "avoid": { "ticker": "SYMBOL", "reason": "1-2 sentences" }
}

newsCards must have exactly 8 items. For opportunity and avoid, choose from: ${DEFAULT_WATCHLIST.join(', ')}.
If you reference an FOMC meeting or CPI release, use ONLY the macro calendar above — never a date recalled from training data.
Return ONLY valid JSON, no markdown fences.`;

  let snapshot = null;
  try {
    const text    = await workerClaude(prompt, env, 2200);
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    snapshot = JSON.parse(cleaned);
  } catch (e) {
    console.error('[cron] snapshot generation failed:', e.message);
  }

  // Cache the headline snapshot only if it has content. On failure, preserve any
  // existing complete snapshot rather than overwriting it with an empty shell
  // (and leave the cache "incomplete" so handleDailyGet retries on next visit).
  // NOTE: a headline failure must NOT abort the watchlist/sector refresh below.
  const hasContent = snapshot && ((snapshot.newsCards?.length || 0) > 0 || snapshot.opportunity);
  if (hasContent) {
    await env?.REC_LOG?.put(
      'daily:snapshot',
      JSON.stringify({ ...snapshot, ts: Date.now(), _instr: instrSince(mark, 'briefing') }),
      { expirationTtl: 172800 },
    );
    console.log('[cron] daily snapshot saved');

    // Only now is it safe to drop yesterday's close recap and midday pulse: the
    // new pre-market briefing exists to replace them. Doing this before the
    // generation (as it used to) meant any failure below wiped the recap and
    // replaced it with nothing.
    try { await env?.REC_LOG?.delete('daily:eod'); } catch (_) {}
    try { await env?.REC_LOG?.delete('daily:midday'); } catch (_) {}
  } else {
    const existingComplete = existingSnapshot &&
      ((existingSnapshot.newsCards?.length || 0) > 0 || existingSnapshot.opportunity);
    if (existingComplete) {
      console.warn('[cron] headline generation failed — keeping prior complete snapshot');
    } else {
      // Nothing usable anywhere: write a minimal headline so the page isn't broken,
      // but with ts=0 so handleDailyGet treats it as stale and keeps retrying.
      await env?.REC_LOG?.put(
        'daily:snapshot',
        JSON.stringify({ headline: `Market update for ${today}`, newsCards: [], opportunity: null, avoid: null, ts: 0 }),
        { expirationTtl: 172800 },
      );
      console.warn('[cron] headline generation failed and no prior snapshot — wrote stale placeholder');
    }
  }

  // Refresh the consolidated recommendation for every Watchlist-tab ticker so the
  // columns are current each morning without the user clicking into each stock.
  await refreshWatchlistAnalyses(env);

  // Pre-warm sector intelligence so the Market tab loads instantly in the morning
  // instead of forcing the first visitor through a ~50s cold-cache regeneration.
  try {
    const sectors = await generateSectors(env);
    console.log(sectors ? '[cron] sectors pre-warmed' : '[cron] sectors pre-warm failed');
  } catch (e) {
    console.error('[cron] sectors pre-warm error:', e.message);
  }

  // Re-stamp with the WHOLE job's cost. The inline `_instr` above only covers the
  // briefing itself, because that write happens before the watchlist and sector
  // fan-out. `phase` is the tell: a stored payload still reading `briefing` means
  // this function never reached the end.
  await stampInstr(env, 'daily:snapshot', mark, 'complete', 172800);
}

/* ── Cron: refresh per-ticker watchlist analysis ──
   Uses the user's persisted watchlist (saved from the dashboard) unioned with
   DEFAULT_WATCHLIST so the morning briefing's opportunity/avoid picks are always
   covered too. Each ticker is written to analysis:{TICKER} for the batch endpoint
   to serve, so the consolidated recommendation renders instantly on page load. */
async function refreshWatchlistAnalyses(env) {
  let tickers = [...DEFAULT_WATCHLIST];
  try {
    const saved = await env?.REC_LOG?.get('watchlist:tickers', 'json');
    if (Array.isArray(saved) && saved.length) {
      tickers = [...new Set([...saved, ...DEFAULT_WATCHLIST].map(t => String(t).toUpperCase()))];
    }
  } catch (_) {}
  tickers = tickers.slice(0, 60); // safety cap on subrequest volume

  for (let i = 0; i < tickers.length; i += 5) {
    await allSettledCounted(
      tickers.slice(i, i + 5).map(t => refreshTickerAnalysis(t, env)),
    'snapshot:watchlist-analyses');
  }
  console.log(`[cron] ${tickers.length} watchlist analyses refreshed`);
}

/* ── Cron: end-of-day summary (1:15pm PT, ~15 min after market close) ── */
async function generateEODSummary(env) {
  const mark = instrMark();
  // FRED supplies the statistical-release dates; FOMC comes from the hardcoded table.
  const fredEvents = (await getEconReleases(env)).events;
  try {
    const existing = await env?.REC_LOG?.get('daily:eod', 'json');
    if (existing && Date.now() - existing.ts < 7_200_000) {
      console.log('[cron] eod fresh, skipping');
      return;
    }
  } catch (_) {}

  // Current market snapshot
  let marketLines = '';
  try {
    const tickers = Object.keys(SNAPSHOT_SYMBOLS);
    const results = await allSettledCounted(
      tickers.map(t => yahoo(`/v8/finance/chart/${encodeURIComponent(t)}`, '?range=1d&interval=1d')),
    'eod:index-charts');
    marketLines = tickers.map((t, i) => {
      if (results[i].status !== 'fulfilled') return null;
      const meta  = results[i].value?.chart?.result?.[0]?.meta || {};
      const price = meta.regularMarketPrice;
      const prev  = meta.chartPreviousClose ?? meta.previousClose;
      if (price == null || prev == null) return null;
      const chg = ((price - prev) / prev * 100).toFixed(2);
      return `${SNAPSHOT_SYMBOLS[t]}: ${price.toFixed(2)} (${chg >= 0 ? '+' : ''}${chg}%)`;
    }).filter(Boolean).join('\n');
  } catch (_) {}

  // Today's news
  let newsLines = '';
  try {
    if (env?.ALPACA_KEY && env?.ALPACA_SECRET) {
      const data = await alpacaFetch('/v1beta1/news?limit=20&sort=desc', env);
      newsLines = (data.news || []).slice(0, 15).map(n => `• ${n.headline}`).join('\n');
    } else {
      const r = await fetch(
        'https://query2.finance.yahoo.com/v1/finance/search?q=stock+market&quotesCount=0&newsCount=15',
        { headers: YAHOO_HEADERS },
      );
      if (r.ok) {
        const d = await r.json();
        newsLines = (d.news || []).slice(0, 15).map(n => `• ${n.title}`).join('\n');
      }
    }
  } catch (_) {}

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    timeZone: 'America/Los_Angeles',
  });

  const prompt = `You are a professional market analyst. US markets just closed for ${dateStr}.

FINAL MARKET DATA:
${marketLines || 'Not available'}

TODAY'S NEWS:
${newsLines || 'Not available'}

UPCOMING MACRO CALENDAR (official Fed / BLS schedule — the only source for these dates):
${econPromptLines(econEventsAhead(4, etToday(), fredEvents)) || 'Nothing scheduled in the tracked calendar.'}

Write a concise end-of-day market summary as valid JSON (no markdown):
{
  "headline": "One-sentence session summary (max 120 chars)",
  "body": "3-4 sentences: overall session character, key sector rotation or notable movers, what the close sets up for tomorrow."
}

If you reference an FOMC meeting or CPI release, use ONLY the macro calendar above — never a date recalled from training data.`;

  let eod;
  try {
    const text    = await workerClaude(prompt, env, 500);
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    eod = JSON.parse(cleaned);
  } catch (e) {
    console.error('[cron] eod parse failed:', e.message);
    eod = { headline: `Market closed ${dateStr}`, body: 'Market data unavailable.' };
  }

  await env?.REC_LOG?.put(
    'daily:eod',
    JSON.stringify({ ...eod, ts: Date.now(), _instr: instrSince(mark, 'complete') }),
    { expirationTtl: 86400 },
  );
  console.log('[cron] eod summary saved');
}

/* ── Cron: midday market pulse (11:30am PT) ──
   Narrative of what has moved the market so far today, dynamic topic cards,
   next-trading-day events, trade ideas by style (short-term/swing/options/long-term)
   drawn from the watchlist, and big movers (≥10% + volume) regardless of
   watchlist status. Served via /api/daily as `midday`. */
async function generateMiddaySnapshot(env) {
  const mark = instrMark();
  // FRED supplies the statistical-release dates; FOMC comes from the hardcoded table.
  const fredEvents = (await getEconReleases(env)).events;
  // Dedup: skip only if a complete midday pulse was generated in the last 2 hours
  // (the DST cron pair means both UTC variants fire ~1h apart).
  try {
    const existing = await env?.REC_LOG?.get('daily:midday', 'json');
    if (existing && existing.narrative && Date.now() - existing.ts < 7_200_000) {
      console.log('[cron] midday fresh, skipping');
      return;
    }
  } catch (_) {}

  await getYahooCrumb(env).catch(() => {});

  // ── Intraday index / futures / commodities context ──
  let marketLines = '';
  try {
    const tickers = Object.keys(SNAPSHOT_SYMBOLS);
    const results = await allSettledCounted(
      tickers.map(t => yahoo(`/v8/finance/chart/${encodeURIComponent(t)}`, '?range=1d&interval=1d')),
    'midday:index-charts');
    marketLines = tickers.map((t, i) => {
      if (results[i].status !== 'fulfilled') return null;
      const meta  = results[i].value?.chart?.result?.[0]?.meta || {};
      const price = meta.regularMarketPrice;
      const prev  = meta.chartPreviousClose ?? meta.previousClose;
      if (price == null || prev == null) return null;
      const chg = ((price - prev) / prev * 100).toFixed(2);
      return `${SNAPSHOT_SYMBOLS[t]}: ${price.toFixed(2)} (${chg >= 0 ? '+' : ''}${chg}%)`;
    }).filter(Boolean).join('\n');
  } catch (_) {}

  // ── Big movers: ≥±10% on real volume, watchlist or not ──
  // Yahoo predefined screeners carry regularMarketVolume, so one pass gets both.
  const bigMovers = [];
  try {
    const [gr, lr] = await allSettledCounted([
      fetch('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=true&scrIds=day_gainers&count=25', { headers: YAHOO_HEADERS }),
      fetch('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=true&scrIds=day_losers&count=25',  { headers: YAHOO_HEADERS }),
    ], 'midday:movers');
    for (const res of [gr, lr]) {
      if (res.status !== 'fulfilled' || !res.value.ok) continue;
      const d = await res.value.json();
      for (const q of (d.finance?.result?.[0]?.quotes || [])) {
        const pct = q.regularMarketChangePercent?.raw ?? null;
        const vol = q.regularMarketVolume?.raw ?? null;
        const price = q.regularMarketPrice?.raw ?? null;
        if (pct == null || Math.abs(pct) < 10) continue;
        if (vol == null || vol < 1_000_000) continue; // require real volume behind the move
        bigMovers.push({
          ticker:    q.symbol,
          name:      q.shortName || q.longName || '',
          price:     price != null ? Math.round(price * 100) / 100 : null,
          changePct: Math.round(pct * 100) / 100,
          volume:    vol,
        });
      }
    }
    bigMovers.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  } catch (e) {
    console.error('[midday] movers failed:', e.message);
  }

  // ── Watchlist intraday state + confirmed earnings for the next trading day ──
  let tickers = [...DEFAULT_WATCHLIST];
  try {
    const saved = await env?.REC_LOG?.get('watchlist:tickers', 'json');
    if (Array.isArray(saved) && saved.length) {
      tickers = [...new Set([...saved, ...DEFAULT_WATCHLIST].map(t => String(t).toUpperCase()))];
    }
  } catch (_) {}
  tickers = tickers.slice(0, 25); // subrequest budget: one quoteSummary each

  // Next trading day (PT): skip weekends
  const ptNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const nextDay = new Date(ptNow);
  do { nextDay.setDate(nextDay.getDate() + 1); } while (nextDay.getDay() === 0 || nextDay.getDay() === 6);
  const pad = n => String(n).padStart(2, '0');
  const nextIso = `${nextDay.getFullYear()}-${pad(nextDay.getMonth() + 1)}-${pad(nextDay.getDate())}`;
  const nextLabel = nextDay.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const wlLines = [];
  const confirmedEarnings = [];
  const CHUNK = 5;
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const batch = tickers.slice(i, i + CHUNK);
    const results = await allSettledCounted(
      batch.map(t => yahooAuth(`/v10/finance/quoteSummary/${t}`, '?modules=price,calendarEvents', env)),
    'midday:quote-batch');
    for (let j = 0; j < batch.length; j++) {
      if (results[j].status !== 'fulfilled') continue;
      const r   = results[j].value?.quoteSummary?.result?.[0] || {};
      const p   = r.price || {};
      const price = p.regularMarketPrice?.raw ?? null;
      const pct   = p.regularMarketChangePercent?.raw != null
        ? Math.round(p.regularMarketChangePercent.raw * 10000) / 100 : null;
      const vol   = p.regularMarketVolume?.raw ?? null;
      if (price != null) {
        wlLines.push(`${batch[j]} $${price.toFixed(2)} (${pct != null ? (pct >= 0 ? '+' : '') + pct + '%' : 'N/A'})` +
          (vol != null ? ` vol ${(vol / 1e6).toFixed(1)}M` : ''));
      }
      for (const ep of (r.calendarEvents?.earnings?.earningsDate || [])) {
        const fmt = ep.fmt ?? null;
        if (fmt === nextIso) { confirmedEarnings.push(batch[j]); break; }
      }
    }
  }

  // ── News headlines for narrative context ──
  let newsLines = '';
  try {
    if (env?.ALPACA_KEY && env?.ALPACA_SECRET) {
      const data = await alpacaFetch('/v1beta1/news?limit=20&sort=desc', env);
      newsLines = (data.news || []).slice(0, 15).map(n => `• ${n.headline}`).join('\n');
    } else {
      const r = await fetch(
        'https://query2.finance.yahoo.com/v1/finance/search?q=stock+market+today&quotesCount=0&newsCount=15',
        { headers: YAHOO_HEADERS },
      );
      if (r.ok) {
        const d = await r.json();
        newsLines = (d.news || []).slice(0, 15).map(n => `• ${n.title}`).join('\n');
      }
    }
  } catch (_) {}

  const dateStr = ptNow.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const moverLines = bigMovers.slice(0, 15).map(m =>
    `${m.ticker} $${m.price ?? '?'} (${m.changePct >= 0 ? '+' : ''}${m.changePct}%) vol ${(m.volume / 1e6).toFixed(1)}M${m.name ? ` — ${m.name}` : ''}`,
  ).join('\n');

  const prompt = `You are a professional market analyst. It is 11:30am PT (2:30pm ET) on ${dateStr}. US markets have about 90 minutes left in the regular session.

INTRADAY MARKET DATA:
${marketLines || 'Not available'}

BIG MOVERS TODAY (≥10% move on ≥1M shares):
${moverLines || 'None flagged'}

WATCHLIST (price, % change, volume today):
${wlLines.join('\n') || 'Not available'}

CONFIRMED EARNINGS for ${nextLabel} (from Yahoo Finance — the ONLY tickers you may cite for earnings tomorrow):
${confirmedEarnings.length ? confirmedEarnings.join(', ') : 'None from the watchlist'}

CONFIRMED MACRO CALENDAR for ${nextLabel} (official Fed / BLS schedule — the ONLY Fed/economic events you may cite for tomorrow):
${econPromptLines(econEventsBetween(nextIso, nextIso, fredEvents)) || 'No FOMC or economic-release events scheduled for tomorrow.'}

MACRO CALENDAR still ahead (context only — do NOT list these as tomorrow's events):
${econPromptLines(econEventsAhead(4, isoAddDays(nextIso, 1), fredEvents)) || 'Nothing scheduled in the tracked calendar.'}

TODAY'S HEADLINES:
${newsLines || 'Not available'}

Generate a midday market pulse as valid JSON (no markdown fences):
{
  "headline": "One-sentence summary of what has moved the market so far today (max 120 chars)",
  "narrative": "3-4 sentences: what is driving today's tape — sector rotation, breadth, macro catalysts, notable reversals or momentum shifts since the open.",
  "topics": [
    { "title": "short title", "body": "2-sentence analysis of this theme's role in today's session", "tag": "Macro|Fed|Sector|Geopolitical|Earnings" }
  ],
  "tomorrow": [
    { "title": "Concise event title", "type": "Earnings|Fed|Economic|Geopolitical|Macro", "impact": "HIGH|MEDIUM|LOW", "note": "1 sentence on what to watch" }
  ],
  "trades": {
    "shortTerm": [ { "ticker": "SYM", "reason": "1 sentence on the 2-10 day setup, referencing daily-bar levels only" } ],
    "swing": [ { "ticker": "SYM", "reason": "1 sentence on the multi-day setup" } ],
    "options": [ { "ticker": "SYM", "strategy": "e.g. Bull call spread, Cash-secured put", "reason": "1 sentence" } ],
    "longTerm": [ { "ticker": "SYM", "reason": "1 sentence on why today's action creates a long-term entry" } ]
  }
}

RULES:
- topics: 3-5 cards, only themes actually moving today's market. Vary tags as appropriate.
- tomorrow: 3-6 events for ${nextLabel} (the next trading day). For Earnings events use ONLY the confirmed list above. For Fed/CPI/economic-calendar events use ONLY the confirmed macro calendar above — never date an FOMC meeting or CPI print from memory, your training data is out of date. If neither list has enough entries, fill the remainder with Macro/Geopolitical themes drawn from today's headlines, phrased as ongoing themes without invented dates.
- trades: 1-2 ideas per style. shortTerm/swing/options/longTerm tickers must come from the WATCHLIST above, chosen on today's specific price action (momentum, pullbacks to support, unusual volume, oversold bounces). If no watchlist name fits a style, return an empty array for it.
- shortTerm is NOT a day-trading bucket. Every idea in it must be a multi-day swing setup with a horizon of 2 to 10 trading days. You are working from daily bars and a delayed quote — you have no intraday data — so do NOT produce same-session entry or exit levels, opening-range or VWAP references, or any intraday timing ("buy the first hour", "exit before the close", "scalp the bounce"). Any level you cite must be a daily-bar level: a prior swing high or low, a moving average, or a support/resistance zone visible on daily closes.
Return ONLY valid JSON.`;

  let midday = null;
  try {
    const text    = await workerClaude(prompt, env, 2500);
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    midday = JSON.parse(cleaned);
  } catch (e) {
    console.error('[cron] midday generation failed:', e.message);
    return;
  }

  await env?.REC_LOG?.put(
    'daily:midday',
    JSON.stringify({ ...midday, bigMovers: bigMovers.slice(0, 12), ts: Date.now(), _instr: instrSince(mark, 'complete') }),
    { expirationTtl: 86400 },
  );
  console.log('[cron] midday pulse saved');
}

/* ── Sector Updates ── */
const SECTORS_KV_KEY = 'market:sectors';
const SECTORS_TTL    = 14_400_000; // 4 hours

async function handleMarketSectors(origin, env, ctx, params) {
  const force = params?.get('refresh') === '1';

  let cached = null;
  try { cached = await env?.REC_LOG?.get(SECTORS_KV_KEY, 'json'); } catch (_) {}

  // Stale-while-revalidate: paint whatever is banked, however old, then let the
  // caller refresh behind it. No tab should sit on "click to load".
  if (params?.get('cached') === '1') return json(cached || emptySnapshot('Claude synthesis', TTL.sectors), 200, origin);

  if (!force && cached && Date.now() - cached.ts < SECTORS_TTL) return json(cached, 200, origin);

  const result = await generateSectors(env);
  if (!result) return err('sector generation failed', 500, origin);
  return json(result, 200, origin);
}

// Builds sector intelligence, writes it to KV, and returns the result object
// (or null on failure). Used by the lazy request path and the morning cron warm-up.
async function generateSectors(env) {
  const etfTickers   = Object.keys(SECTOR_ETFS);
  const stockTickers = [...new Set(Object.values(SECTOR_STOCKS).flat())];
  const allTickers   = [...etfTickers, ...stockTickers];

  const results = await allSettledCounted(
    allTickers.map(t => yahoo(`/v8/finance/chart/${encodeURIComponent(t)}`, '?range=1d&interval=1d')),
  'sectors:etf-charts');

  const priceMap = {};
  allTickers.forEach((t, i) => {
    if (results[i].status !== 'fulfilled') return;
    const meta      = results[i].value?.chart?.result?.[0]?.meta || {};
    const price     = meta.regularMarketPrice ?? null;
    const prev      = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const changePct = price != null && prev != null
      ? Math.round((price - prev) / prev * 10000) / 100
      : null;
    priceMap[t] = { price, changePct };
  });

  // News for context
  let newsLines = '';
  try {
    if (env?.ALPACA_KEY && env?.ALPACA_SECRET) {
      const data = await alpacaFetch('/v1beta1/news?limit=15&sort=desc', env);
      newsLines = (data.news || []).slice(0, 10).map(n => `• ${n.headline}`).join('\n');
    } else {
      const r = await fetch(
        'https://query2.finance.yahoo.com/v1/finance/search?q=market+sector&quotesCount=0&newsCount=10',
        { headers: YAHOO_HEADERS },
      );
      if (r.ok) {
        const d = await r.json();
        newsLines = (d.news || []).slice(0, 10).map(n => `• ${n.title}`).join('\n');
      }
    }
  } catch (_) {}

  const sectorLines = etfTickers.map(etf => {
    const sector    = SECTOR_ETFS[etf];
    const etfData   = priceMap[etf];
    const etfPct    = etfData?.changePct != null ? `${etfData.changePct >= 0 ? '+' : ''}${etfData.changePct}%` : 'N/A';
    const stocksStr = (SECTOR_STOCKS[sector] || []).map(sym => {
      const d = priceMap[sym];
      if (!d || d.price == null) return null;
      const pct = d.changePct != null ? `${d.changePct >= 0 ? '+' : ''}${d.changePct}%` : 'N/A';
      return `${sym} $${d.price.toFixed(2)} (${pct})`;
    }).filter(Boolean).join(', ');
    return `${sector} [${etf} ${etfPct}]: ${stocksStr || 'no data'}`;
  }).join('\n');

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });

  const prompt = `You are a professional equity market analyst. Today is ${today}.

SECTOR PERFORMANCE (ETF % change today, key constituents):
${sectorLines}

RECENT NEWS:
${newsLines || 'Not available'}

For each of the 11 sectors, write a brief update for traders. Rules:
- Never pick penny stocks (under $5 price).
- Only recommend well-known, liquid large/mid-cap stocks.
- Opportunity and avoid picks should reflect today's specific conditions.
- You may pick stocks outside the listed constituents if better suited.

Return ONLY valid JSON (no markdown fences):
{
  "sectors": [
    {
      "sector": "Technology",
      "etf": "XLK",
      "summary": "1-2 sentence sector context for today's session",
      "opportunity": { "ticker": "SYMBOL", "reason": "1-2 sentences on why this is the top near-term opportunity" },
      "avoid": { "ticker": "SYMBOL", "reason": "1-2 sentences on why to avoid or short this today" }
    }
  ]
}

Include all 11 sectors in order: Technology, Financials, Energy, Health Care, Consumer Discretionary, Consumer Staples, Industrials, Materials, Real Estate, Communication Services, Utilities.`;

  let sectorData;
  try {
    const text    = await workerClaude(prompt, env, 3500);
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    sectorData = JSON.parse(cleaned);
    if (sectorData.sectors) {
      sectorData.sectors = sectorData.sectors.map(s => ({
        ...s,
        changePct: priceMap[s.etf]?.changePct ?? null,
        price:     priceMap[s.etf]?.price     ?? null,
      }));
    }
  } catch (e) {
    console.error('[sectors] generation failed:', e.message);
    return null;
  }

  if (!sectorData?.sectors?.length) {
    console.error('[sectors] generation produced no sectors');
    return null;
  }

  const result = {
    ...sectorData, ts: Date.now(),
    _meta: srcMeta('Yahoo Finance + Claude synthesis', {
      delayed: true, ttlSeconds: TTL.sectors,
      note: `11 SPDR sectors · ${YAHOO_DELAY_NOTE} · picks from Claude`,
    }),
  };
  await env?.REC_LOG?.put(SECTORS_KV_KEY, JSON.stringify(result), { expirationTtl: 14400 }).catch(() => {});
  return result;
}

/* ── Main fetch handler ── */
export default {
  async fetch(request, env, ctx) {
    // Count binding calls for the rest of this request. Substituted for `env`
    // wholesale so every handler downstream is measured without touching any of
    // them. Returns the original env on failure, so a counter fault can never
    // become a KV fault.
    env = instrWrapBindings(env);
    const origin = request.headers.get('Origin') || '';

    /* Preflight is answered FIRST, before the origin 403 and before any gate.
     *
     * This ordering is load-bearing: a preflight carries no custom headers by
     * definition — the browser sends `Access-Control-Request-Headers` naming
     * them, not the headers themselves. So if the gate ran before this, it would
     * reject its own preflight for want of the very header the preflight exists
     * to ask permission for, and nothing could ever succeed. Never move a check
     * above this block. */
    if (request.method === 'OPTIONS') {
      if (!isAllowedOrigin(origin)) {
        // No CORS headers at all — the browser blocks, which is the intent.
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    if (!isAllowedOrigin(origin)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status:  403,
        headers: { 'Content-Type': JSON_CT },
      });
    }

    const url   = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] !== 'api') return err('not found', 404, origin);

    try {
      const [, route, sub] = parts;
      switch (route) {
        case 'quote':    return await handleQuote(sub, origin, env);
        case 'chart':    return await handleChart(sub, url.searchParams, origin);
        case 'options': return await handleOptions(sub, url.searchParams, origin, env);
        case 'premium':
          // `batch` reads KV only — zero outbound calls, so a long watchlist
          // cannot put 60 tickers' worth of Yahoo traffic behind one page load.
          // (The KV reads themselves do count against the 10,000 cap; they are
          // just not fetches.) A bare ticker refreshes one name, ~5 subrequests.
          if (sub === 'batch') return await handlePremiumBatch(url.searchParams, origin, env);
          return await handlePremiumTicker(sub, url.searchParams, origin, env, ctx);
        case 'long':
          // Same shape as premium and for the same reason: `batch` is a KV read
          // so the tab paints without touching Yahoo, and a bare ticker is the
          // only spender (~5 warm, ~8-9 cold). Never fan out across the watchlist.
          if (sub === 'batch') return await handleLongBatch(url.searchParams, origin, env);
          return await handleLongTicker(sub, url.searchParams, origin, env);
        case 'iv':       return await handleIv(sub, url.searchParams, origin, env, ctx);
        case 'insider':  return await handleInsider(sub, url.searchParams, origin, env, ctx);
        case 'short':    return await handleShortInterest(sub, url.searchParams, origin, env, ctx);
        case '13f':      return await handle13F(sub, url.searchParams, origin, env, ctx);
        case 'search':   return await handleSearch(url.searchParams.get('q') || '', origin);
        case 'news':     return await handleNews(sub, origin, env);
        case 'peers':    return await handlePeers(sub, origin);
        // The general-purpose passthrough is GONE. It accepted arbitrary
        // `messages` and forwarded them on the owner's key. Kept as an explicit
        // 410 so anyone still pointing at it gets an answer, not a silent 404.
        case 'claude':
          return err('POST /api/claude has been removed. Use POST /api/ai/:type/:ticker — '
                   + 'prompts are built server-side and callers cannot supply prompt text.', 410, origin);
        case 'ai':
          if (request.method !== 'POST') return err('method not allowed', 405, origin);
          return await handleAi(sub, parts[3], request, origin, env, ctx);
        case 'log-rec': {
          // Writes the forward log the calibration card scores. Poisoning it
          // would corrupt the hit rate and Brier score silently.
          const g = requireSecret(request, env, origin);
          if (g) return g;
          return await handleLogRec(request, env, origin);
        }
        case 'track':    return await handleTrack(sub, env, origin);
        case 'earnings': {
          // Cache miss or ?refresh=1 spends Anthropic credit, so it takes the gate.
          const g = await aiGuard(request, env, origin);
          if (g) return g;
          return await handleEarningsAnalysis(sub, url.searchParams, origin, env, ctx);
        }
        case 'daily':    return await handleDailyGet(origin, env, ctx, request);
        case 'market':
          if (sub === 'snapshot')    return await handleMarketSnapshot(origin, env);
          if (sub === 'movers')      return await handleMarketMovers(origin, env);
          if (sub === 'ipos')        return await handleMarketIPOs(origin, env);
          if (sub === 'week-ahead') {
            const g = await aiGuard(request, env, origin);
            if (g) return g;
            return await handleWeekAhead(origin, env);
          }
          if (sub === 'sectors') {
            // Only ?refresh=1 forces a regenerate; a warm read is free and ungated
            // so the tab still paints for anyone the gate would reject.
            if (url.searchParams.get('refresh') === '1') {
              const g = await aiGuard(request, env, origin);
              if (g) return g;
            }
            return await handleMarketSectors(origin, env, ctx, url.searchParams);
          }
          if (sub === 'scanner')    return await handleScanner(url.searchParams, origin, env, ctx, request);
          if (sub === 'golden-cross') return await handleGoldenCross(origin, env, url.searchParams);
          if (sub === 'econ-calendar') return await handleEconCalendar(url.searchParams, origin, env);
          return err('unknown market route', 404, origin);
        case 'analysis':
          if (!sub) return err('ticker required', 400, origin);
          if (request.method === 'GET') {
            const cached = await env?.REC_LOG?.get(`analysis:${sub.toUpperCase()}`, 'json');
            return cached ? json(cached, 200, origin) : err('not found', 404, origin);
          }
          if (request.method === 'POST') {
            // Was an unauthenticated KV write: anyone could store text that then
            // rendered as this ticker's analysis on the watchlist card.
            const g = requireSecret(request, env, origin);
            if (g) return g;
            const body = await request.json().catch(() => null);
            if (!body) return err('invalid json', 400, origin);
            await env?.REC_LOG?.put(
              `analysis:${sub.toUpperCase()}`,
              JSON.stringify({ ...body, ts: Date.now() }),
              { expirationTtl: 172800 },
            );
            return json({ ok: true }, 200, origin);
          }
          if (request.method === 'DELETE') {
            const g = requireSecret(request, env, origin);
            if (g) return g;
            await env?.REC_LOG?.delete(`analysis:${sub.toUpperCase()}`);
            return json({ ok: true }, 200, origin);
          }
          return err('method not allowed', 405, origin);
        case 'watchlist':
          if (sub === 'batch') return await handleWatchlistBatch(
            url.searchParams.get('symbols') || '', origin, env, ctx, request,
          );
          if (sub === 'auction') return await handleWatchlistAuction(
            url.searchParams.get('symbols') || '', origin, env, ctx,
          );
          if (sub === 'save' && request.method === 'POST') {
            // Writes watchlist:tickers, which seeds the cron sweeps — so an
            // unauthenticated write here also steers what the crons spend on.
            const g = requireSecret(request, env, origin);
            if (g) return g;
            return await handleWatchlistSave(request, origin, env);
          }
          return err('unknown watchlist route', 404, origin);
        case 'admin':
          if (sub === 'refresh-daily' && request.method === 'POST') {
            const adminToken = await env?.REC_LOG?.get('admin:token');
            const auth = request.headers.get('Authorization') || '';
            if (!adminToken || auth !== `Bearer ${adminToken}`) {
              return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': JSON_CT } });
            }
            try { await env?.REC_LOG?.delete('daily:snapshot'); } catch (_) {}
            await generateDailySnapshot(env);
            return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': JSON_CT } });
          }
          if (sub === 'refresh-midday' && request.method === 'POST') {
            const adminToken = await env?.REC_LOG?.get('admin:token');
            const auth = request.headers.get('Authorization') || '';
            if (!adminToken || auth !== `Bearer ${adminToken}`) {
              return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': JSON_CT } });
            }
            // Await synchronously: the pipeline exceeds the ~30s fetch-context
            // waitUntil budget, so a fire-and-forget refresh would be killed mid-run.
            try { await env?.REC_LOG?.delete('daily:midday'); } catch (_) {}
            await generateMiddaySnapshot(env);
            const saved = await env?.REC_LOG?.get('daily:midday', 'json');
            return new Response(JSON.stringify({ ok: !!saved }), { headers: { 'Content-Type': JSON_CT } });
          }
          return err('unknown admin route', 404, origin);
        default:         return err('unknown route', 404, origin);
      }
    } catch (e) {
      console.error('[worker] unhandled:', e.message);
      return err(e.message, 500, origin);
    }
  },

  async scheduled(event, env, ctx) {
    // Same substitution as fetch(): cron jobs spend the same pool, and the
    // morning briefing's KV traffic was previously invisible in its own _instr.
    env = instrWrapBindings(env);

    // ── The cron expression is a COARSE WAKEUP AND NOTHING ELSE ──────────────
    // Every 15 min, UTC hours 13-22, ALL days. Every date and time decision is
    // made here, in code, against Pacific wall-clock. The expression carries no
    // day, no date, no month, and it must stay that way.
    //
    // It used to end in `1-5`, read as Mon-Fri. Cloudflare's day-of-week field
    // is 1-indexed with 1 = Sunday, so `1-5` actually meant Sun-Thu: no cron
    // ever ran on a Friday, and a full morning briefing burned every Sunday for
    // a market that was closed. Confirmed from invocation telemetry across
    // 2026-07-26 .. 2026-08-07 — every Sunday fired, both Fridays did not.
    //
    // The lesson is not "use 2-6". It is that cron-expression semantics are not
    // testable from here and this dispatcher's are, so the expression gets to
    // decide only how often we wake up. Everything else is a function call.
    //
    // Each generator's own KV dedup still prevents double-runs across the
    // adjacent firings inside a branch's window.
    instrReset('scheduled');

    const pt = new Date(new Date(event.scheduledTime).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const { iso, dow } = ptParts(pt);           // same Date object — one time basis
    const h = pt.getHours(), m = pt.getMinutes();
    const day = tradingDayStatus(iso, dow);

    const dowName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow];
    const at = `${iso} ${dowName} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} PT`;

    // Which trigger fired. With more than one cron registered the log is
    // otherwise ambiguous — a diagnostic probe and a real firing produce the
    // same line. `controller.cron` is the raw expression string; guard it
    // because the local `/cdn-cgi/handler/scheduled` route allows it to be absent.
    const via = `cron="${event.cron || '(none reported)'}"`;

    /* Log on EVERY invocation, skips included. A no-op that prints
       "Sat — skipped" is falsifiable; silence is what let the wrong day-of-week
       run for weeks without anyone being able to see it. */
    if (!day.open) {
      console.log(`[cron] ${at} · ${via} · not a trading day (${day.reason}) · branch=none`);
      return;
    }

    // TODO(2026-08-10): remove with PROBE_CRON and the second `crons` entry.
    //
    // Diagnostic probe: log and return WITHOUT dispatching. It fires every 5
    // minutes with no hour restriction, so on a trading day it lands inside the
    // dispatch windows three times as often as the real trigger. Each generator's
    // KV dedup absorbs that on a successful run — but a failed morning briefing
    // deliberately leaves its cache incomplete so it retries, and the probe would
    // turn a 2-attempt retry into 6 (~150 Claude calls instead of ~50). Monday
    // 6:00am PT is the first real observation of the day-of-week fix, and that
    // run has to be clean.
    //
    // Placed AFTER the trading-day gate so weekend and holiday firings still take
    // the branch=none path above and keep proving the gate works — which is half
    // of what the probe is for.
    if (event.cron === PROBE_CRON) {
      console.log(`[cron] ${at} · ${via} · trading day · branch=none (probe · dispatch suppressed)`);
      return;
    }

    let branch = 'idle';                        // in-window wakeup with no job due
    if (h === 6 && m < 30) {
      branch = 'morning-briefing';
      ctx.waitUntil(generateDailySnapshot(env));       // 6:00am PT morning briefing
    } else if ((h === 11 && m >= 30) || h === 12) {
      branch = 'midday-pulse';
      ctx.waitUntil(generateMiddaySnapshot(env));      // 11:30am PT midday pulse (retries to 1pm; KV dedup skips once complete)
    } else if (h === 13 && m >= 15 && m < 45) {
      branch = 'eod+iv-sweep';
      ctx.waitUntil(generateEODSummary(env));          // 1:15pm PT EOD summary
      ctx.waitUntil(recordWatchlistIv(env));           // 1:15pm PT bank one IV sample per watchlist name
    } else if (h === 14 && m < 30) {
      branch = 'forward-returns+moves';
      ctx.waitUntil(fillForwardReturns(env));          // 2:00pm PT resolve 5/20-session forward returns
      // 2:00pm PT bank the historical move distribution. Placed on THIS branch and
      // not the 1:15pm EOD one because the daily bar is settled by now — see the
      // note on collectMoveSeries(). Both jobs share this invocation's subrequest
      // budget: ctx.waitUntil does not get its own.
      ctx.waitUntil(collectMoveSeries(env));
    } else if (h === 10) {
      // Fires on all four firings of the hour: a slice is only 4 managers, so
      // four slices a day completes a 20-manager pass in ~1.3 days. 13F-HR lands
      // 45 days after quarter end, so that is ample.
      branch = '13f-slice';
      ctx.waitUntil(refresh13FIndexIfStale(env));      // 10:00am PT 13F index slice
    }

    console.log(
      `[cron] ${at} · ${via} · trading day · branch=${branch}` +
      (day.calendarStale ? ` · WARN holiday calendar ends ${NYSE_HOLIDAYS_THROUGH}, holidays no longer skipped` : ''),
    );
  },
};
