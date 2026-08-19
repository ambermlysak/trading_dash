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

/**
 * Dispatch ONE cron job so that nothing it does can reach its siblings.
 *
 * TWO DISTINCT FAILURES, established by forcing each one locally 2026-08-11 and
 * reading the result from KV state rather than from logs (a failing invocation
 * loses its console output, so the logs were not a usable instrument):
 *
 *  1. A REJECTED promise does NOT stop siblings. Forced a rejection in
 *     `collectMacroState` and fired the 1:15pm branch with it dispatched LAST,
 *     then FIRST. Both times `daily:eod` and `ivsweep:last` were PRESENT
 *     afterwards and `macrosweep:last` ABSENT — the other two jobs completed and
 *     the failed one correctly declined to stamp. Order made no difference.
 *
 *  2. A SYNCHRONOUS throw at call time TAKES OUT THE WHOLE BRANCH. Forced one at
 *     dispatch position 1: `daily:eod`, `ivsweep:last` AND `macrosweep:last` were
 *     all ABSENT — no job ran at all, including the two that had nothing wrong
 *     with them. Everything after the throwing line is never reached.
 *
 * (2) is not reachable today: every job on every branch is an `async function`,
 * which converts a synchronous throw into a rejected promise. That is a property
 * of each job rather than of the dispatcher, so it is one ordinary refactor away
 * from being untrue — and the blast radius is a whole branch, silently. This
 * makes the isolation structural instead of incidental.
 *
 * ON SWALLOWING THE REJECTION, because rule #7 is explicit that `errors: 0` in
 * telemetry is not evidence of success. Catching here does remove the
 * invocation-level exception, and that is a deliberate trade: an invocation
 * marked failed says only "something on this branch broke", which is exactly the
 * ambiguity that made a failed job and a failed branch indistinguishable. What
 * replaces it is a greppable ERROR line naming the job — the same trade
 * `allSettledCounted` already makes.
 *
 * WHAT THIS LINE USED TO CLAIM, AND WHY IT WAS WRONG. It said "a job that fails
 * still fails: it stamps no dedup key, so the next firing retries it." That holds
 * on the REJECTION path this function sees — a throw before the stamp leaves the
 * key absent, verified — and it was false for the five jobs that swallowed their
 * own per-item failures and stamped anyway. `dispatchJob` never sees those: they
 * resolve normally, print no `JOB-FAILED`, and return a clean 200.
 *
 * Each of the five now guards its own stamp on the run having accomplished
 * something, and says so in an ERROR line of its own — `!! IV-SWEEP-INCOMPLETE !!`,
 * `!! MOVE-SWEEP-INCOMPLETE !!`, `!! FORWARD-FILL-INCOMPLETE !!`,
 * `!! SLICE-FAILED !!`, and the EOD placeholder's `ts: 0`. So the claim is true
 * again, but it is true because of THOSE guards and not because of this function.
 * Do not restate it as a property of `dispatchJob`.
 */
function dispatchJob(ctx, name, run) {
  let p;
  try {
    p = run();
  } catch (e) {
    console.error(`[cron] !! JOB-DISPATCH-THREW !! ${name} threw synchronously at dispatch — `
      + `${e?.message || e}. Every other job on this branch is unaffected and still runs.`);
    return;
  }
  try {
    ctx.waitUntil(Promise.resolve(p).catch((e) => {
      console.error(`[cron] !! JOB-FAILED !! ${name} — ${e?.message || e}. Every other job on this `
        + 'branch is unaffected. No dedup key was stamped by this job, so the next firing retries it.');
    }));
  } catch (e) {
    console.error(`[cron] !! JOB-WAITUNTIL-THREW !! ${name} — ${e?.message || e}`);
  }
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

/* ── THE SWEEP UNIVERSE — `watchlist:tickers`, and nothing else ─────────────
 *
 * `DEFAULT_WATCHLIST` is GONE. Every sweep used to read
 * `watchlist:tickers ∪ DEFAULT_WATCHLIST`, which meant the server permanently
 * covered names the dashboard did not show: measured 2026-08-11, the saved list
 * held 33 and the sweeps ran over 35, with MRK and JPM computed and stored on
 * every firing without ever appearing on screen. Two sources kept in agreement
 * is a thing to maintain; one source is a thing that cannot diverge.
 *
 * THE COST OF THAT DELETION IS A NEW FAILURE MODE, and it is closed here rather
 * than noted. With the fallback gone, an absent / unparseable / empty
 * `watchlist:tickers` yields ZERO names — and a sweep that writes zero keys is
 * indistinguishable from a cron that never fired, which is the exact signature
 * that already cost this codebase weeks (rule #7). Worse, the IV and move sweeps
 * stamp their dedup key on the way out, so a silent zero would persist all day.
 *
 * So this returns `null`, never `[]`, and logs at ERROR with a marker that can be
 * grepped. Callers that own a dedup key MUST refuse before stamping it, so the
 * next firing retries.
 *
 * @returns {Promise<string[]|null>} the universe, or null if there isn't one.
 */
async function sweepUniverse(env, job, cap = 60) {
  let raw = null, why = null;
  try {
    raw = await env?.REC_LOG?.get('watchlist:tickers', 'json');
  } catch (e) {
    why = `KV read failed — ${e.message}`;
  }
  if (!why) {
    if (raw == null)             why = 'key is absent (no dashboard has ever saved a watchlist)';
    else if (!Array.isArray(raw)) why = `key holds ${typeof raw}, not an array`;
    else if (!raw.length)         why = 'key holds an empty array';
  }
  if (!why) {
    const cleaned = [...new Set(raw.map(t => String(t).toUpperCase().trim()))]
      .filter(t => REC_SYMBOL_RE.test(t));
    const dropped = raw.length - cleaned.length;
    if (!cleaned.length) why = `all ${raw.length} entries failed the symbol-shape test`;
    else {
      if (dropped > 0) {
        console.warn(`[cron] ${job}: dropped ${dropped} watchlist entr${dropped === 1 ? 'y' : 'ies'} `
          + 'that are not valid symbol shapes');
      }
      return cleaned.slice(0, cap);
    }
  }
  /* UNMISTAKABLE, and at error level. "0 written" in an otherwise cheerful log
     line is the thing this exists to prevent being mistaken for a quiet success. */
  console.error(`[cron] !! EMPTY-UNIVERSE !! ${job} has ZERO tickers to sweep: watchlist:tickers ${why}. `
    + 'REFUSING to run rather than writing nothing — a sweep that covers zero names looks identical to a '
    + 'cron that never fired. Fix: open the dashboard, which pushes its watchlist on load. '
    + 'No dedup key has been stamped, so the next firing will retry.');
  return null;
}

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

// The every-5-minutes diagnostic probe and its PROBE_CRON suppression were removed
// 2026-08-10, together with the second `crons` entry in wrangler.toml. It existed
// because three post-deploy boundaries produced no [cron] line while observability
// logs were off, which made that silence uninterpretable. It proved what it was
// for — invocations happen, the weekend gate fires — and the Monday 6:00am run it
// was watching for came through clean. `scheduled()` now sees exactly one
// expression again.
//
// (Written as line comments deliberately: the probe's own expression contains the
// character pair that closes a block comment, which turned the first draft of this
// note into a syntax error that would have failed the Worker at startup.)

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
  /* One write a trading day (2:00pm PT), so the badge should only go amber once
     a whole daily cadence has been missed. `MOOD_FRESH_MS` is derived from this
     rather than declared beside the job, so the badge and the reader cannot
     disagree about what "fresh" means. A weekend or holiday legitimately ages
     the record past it — the section renders its own as-of date. */
  mood:     26 * 3600,
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

/* ── Linear-regression channel (the Watchlist "Swing" column) ────────────────
 * Mirrors thinkorswim's regression channel: an OLS fit through the last
 * SWING_REG_BARS *completed* daily closes, and a channel width measured as the
 * standard error of that REGRESSION — the spread of the closes about the fitted
 * line, NOT the standard deviation of the closes themselves. Those are different
 * quantities and on a trending name they differ by a lot: a stock marching
 * steadily higher has a large close-to-close stdev and a tiny residual stdev,
 * and using the former would report a name pinned to its own trend as sitting
 * quietly inside the channel while a genuine break barely registered.
 *
 * THE THRESHOLD LIVES HERE, NOT IN THE FRONTEND. `swingSignal` is decided in
 * this function and shipped decided; `swingThreshold` rides on the response
 * envelope purely so the column's tooltip can name the number it was gated on.
 * Same rule as every other gate in this codebase — a page must never re-derive a
 * decision the Worker already made, because the two then drift silently.
 * ─────────────────────────────────────────────────────────────────────────── */
const SWING_REG_BARS      = 30;   // completed daily bars in the fit
const SWING_Z_THRESHOLD   = 1.5;  // residual σ from the line at which BUY/SELL fires
const SWING_SETTLE_ET_HOUR = 16;  // 4:00pm ET — the bell today's daily bar settles at

/** Current hour in US Eastern (market) time, 0–23. `hourCycle: 'h23'` rather
 *  than `hour12: false`, which prints "24" for midnight under some ICU builds. */
const etHourNow = () => Number(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
}).format(new Date()));

/**
 * Fit the channel and place the live quote in it.
 *
 * `pairs` is date-aligned `{ iso, close }`, oldest first. All four outputs are
 * null together when the window cannot be built — a missing measurement, never
 * a zero (honesty rule 22: `0σ` means "sitting exactly on the line", which is a
 * finding, and it must not be what an absent fit renders as).
 */
function swingChannel(pairs, livePrice, today = etToday(), etHour = null) {
  const empty = { swingZ: null, swingSignal: null, swingFit: null, swingSigma: null,
                  swingEvalX: null, swingAsOf: null };
  if (!Array.isArray(pairs) || !pairs.length) return empty;
  if (livePrice == null || !Number.isFinite(livePrice)) return empty;

  /* Drop today's FORMING bar. Yahoo returns the in-progress session as an
     ordinary daily bar whose close is just the last print, so fitting it would
     mix a partial session into a series of completed ones and then compare the
     live price against a line that already contains it. Only dropped before the
     bell: after 4:00pm ET today's bar is final and is the most informative bar
     in the window — an unconditional drop would throw away a settled session
     every evening. Same shape as `moodSettledBars()`. */
  const hour = etHour == null ? etHourNow() : etHour;
  const lastPair = pairs[pairs.length - 1];
  const forming = !!lastPair && lastPair.iso === today
                  && Number.isFinite(hour) && hour < SWING_SETTLE_ET_HOUR;
  const bars = forming ? pairs.slice(0, -1) : pairs;

  if (bars.length < SWING_REG_BARS) return empty;
  const win = bars.slice(-SWING_REG_BARS);
  const n = SWING_REG_BARS;

  // OLS on x = 0 … n-1 against the closes.
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const y = win[i].close;
    if (!Number.isFinite(y)) return empty;
    sx += i; sy += y; sxx += i * i; sxy += i * y;
  }
  const denom = n * sxx - sx * sx;
  if (!(denom > 0)) return empty;
  const slope     = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;

  let ssr = 0;
  for (let i = 0; i < n; i++) {
    const resid = win[i].close - (intercept + slope * i);
    ssr += resid * resid;
  }
  /* n − 2, not n and not n − 1: the slope and the intercept were both estimated
     from this same window, so two degrees of freedom are already spent and
     dividing by n would understate the spread — which on this column means
     firing BUY/SELL slightly too often. This is the standard error of the
     regression, the same quantity a charting package's regression channel
     widths are quoted in. */
  const sigma = Math.sqrt(ssr / (n - 2));
  if (!Number.isFinite(sigma) || sigma <= 0) return empty;

  /* Evaluate the line at the session the LIVE quote belongs to, which is not
     always the last fitted bar. If the window ends yesterday, `regularMarketPrice`
     is today's print and the fair comparison is the line EXTRAPOLATED one bar to
     x = n. If the window already ends today (post-settlement), the quote and the
     last bar are the same session and the line is read at x = n − 1. Getting this
     wrong misstates the distance by exactly one bar of slope in whichever
     direction the name is trending — small, systematic, and invisible. */
  const lastIso = win[n - 1].iso;
  const evalX   = lastIso < today ? n : n - 1;
  const fit     = intercept + slope * evalX;
  const z       = (livePrice - fit) / sigma;
  if (!Number.isFinite(z)) return empty;

  const r2 = v => Math.round(v * 100) / 100;
  const zR = r2(z);
  // Gate on the ROUNDED z, so the signal and the number printed beside it can
  // never disagree about which side of the threshold the name is on.
  return {
    swingZ:      zR,
    swingSignal: zR <= -SWING_Z_THRESHOLD ? 'BUY' : zR >= SWING_Z_THRESHOLD ? 'SELL' : null,
    swingFit:    r2(fit),
    swingSigma:  r2(sigma),
    swingEvalX:  evalX,
    swingAsOf:   lastIso,
  };
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
/* `raw` opts into `{ text, stopReason }` instead of the bare string.
 * `claudeText()` cannot tell a complete answer from one the token cap cut off —
 * both arrive as text, and the truncated one parses or renders as though it were
 * whole. Every existing caller keeps the string return by omitting the flag. */
async function workerClaude(prompt, env, maxTokens = 400, schema = null, { raw = false } = {}) {
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
      const data = await r.json();
      return raw
        ? { text: claudeText(data), stopReason: data?.stop_reason ?? null }
        : claudeText(data);
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
   SHORT-PREMIUM CONSTANTS  — what survives the deleted premium screen

   THE STANDALONE PREMIUM TAB AND ITS ROW MODEL ARE GONE. It was a separate
   surface weighted as though selling were the primary activity, and it priced
   NAKED single legs — a cash-secured put and a covered call, whose risk this
   codebase could not bound and whose capital base it could not know. Short
   premium is now Lane F of the Long screen: one lane of six, every structure
   defined-risk, ranked by the same expectancy as everything else.

   Deleted with it: `premiumRow`, `pickCandidates`, `sellableFrom`,
   `/api/premium/*`, `PREM_MIN_DTE`, `IVR_SELL_MIN`, `RATIO_SELL_MIN`, and the
   annualised-ROC figure computed against a naked-margin denominator — see
   ARCHITECTURE.md for why that denominator was wrong and must not come back.

   WHAT SURVIVES, and why each is still load-bearing:
     • `PREM_TARGETS`   — the 0.30/0.16 delta pair. Now feeds Lane F's short leg
                          and wing, and Lane E's strangle. One definition of
                          "the short strike", reused rather than re-chosen.
     • `ivPlausible` / `IV_OUTLIER_MULT` / `ivOutlierNote` — the strike-selection
                          guard, always shared, never premium-specific.
     • `ivRankFrom`     — also feeds `/api/iv` and the earnings facts payload.
     • `nextEarningsIso`— also feeds `longRow`.
     • `premium:{TICKER}` — repurposed. See the KV block below: it is no longer a
                          screen row, it is the shared IV/earnings header, and it
                          is now written by `refreshLongTicker` because deleting
                          the tab removed its only writer.
   ══════════════════════════════════════════════════════════════════════════ */

const PREM_TARGETS     = [0.30, 0.16];   // short strike / long wing — Lane F, and Lane E's strangle

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
// 3: header-only shape. A schema-2 value is a full premium-screen row, whose
//    fields this no longer means — `readPremiumRow`'s strict-equality guard
//    retires those rather than reading a row model as a header.
const PREM_SCHEMA      = 3;

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

/* `sellableFrom()` was deleted with the premium screen, and its lesson is kept
   because it applies to every gate here: it originally read
   `ivRank != null && ivRank * 100 >= IVR_SELL_MIN`, which treats a NULL rank as a
   FAIL. IV rank is null until 60 days of history exist, so that dimmed every row
   on the tab for the whole collection window — three months of a screen rendering
   as if nothing qualified. `buyableFrom()` carries the corrected tri-state shape
   ('rank' / 'proxy' / 'none', with null meaning "no basis to judge"), and Lane F
   deliberately has no vol gate of its own at all. */

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

/* ── Earnings session timing: BMO / AMC / unknown ─────────────────────────────

   THIS DECIDES A DEADLINE, NOT A LABEL. A before-open print means the hold/exit
   decision was the PRIOR session's close and the report day is reaction-only; an
   after-close print means the deadline is that day's own close. A wrong answer
   moves a deadline by a full session, so every ambiguous input resolves to
   'unknown' and the consumer assumes the earlier deadline and says it assumed.

   `unknown` WITH A REAL DATE IS A VALID AND COMMON ANSWER, not a failure — the
   source simply does not publish a time for most names.

   The input is `calendarEvents.earnings.earningsDate`, which the batch already
   fetches (`?modules=...,calendarEvents,...`), so this costs ZERO subrequests.
   Entries are epoch seconds. Two shapes arrive and only one carries a time:

     - a real scheduled instant, e.g. an after-close call
     - a DATE-ONLY placeholder at exactly midnight UTC

   The placeholder is the trap. Midnight UTC read as ET is 19:00 (EDT) or 20:00
   (EST) on the PREVIOUS day — past the 16:00 cut, so a naive ET reading
   classifies every date-only row as a confident AMC on the wrong day. It is
   therefore rejected on the UTC instant, BEFORE any ET conversion happens.

   A second-entry range (Yahoo's start/end pair) means "sometime that day" and is
   also unknown, regardless of what the first entry's clock says.

   ── YAHOO ENCODES SESSIONS AS FIXED UTC ANCHORS, NOT AS ET WALL CLOCK ────────

   MEASURED 2026-08-19 over all 39 watchlist names, one probe per name through
   the Worker's own /api/quote proxy. EVERY name resolved, and the whole
   population took exactly TWO distinct UTC times of day:

       20:00:00Z   n=28      12:30:00Z   n=11
       0 names with no entry · 0 with a second distinct entry · 0 at midnight UTC

   Both are DST-invariant, which is the finding. 20:00Z is 16:00 ET under EDT and
   15:00 ET under EST; 12:30Z is 08:30 ET under EDT and 07:30 ET under EST. So
   the ET wall clock is the FICTION here and the anchor is the datum — Yahoo is
   not publishing a time, it is publishing a session flag encoded as a constant.

   The original wall-clock-only rule therefore misread every after-close name
   whose date falls under EST: 20:00Z → 15:00 ET is mid-session, so it failed the
   ≥16:00 cut and came back `unknown`. That was 10 of the 28 AMC names in this
   measurement (PLTR AMD QUBT APP CRWV CAVA HOOD ARM SMR KTOS) — all genuine AMC
   reporters, all dated in November. BMO was never affected: 12:30Z lands inside
   04:00–09:30 ET in both regimes.

   So the anchors are decoded FIRST and the wall-clock windows stay as the
   fallback for any non-anchor time. That ordering is what keeps this honest if
   Yahoo ever starts publishing real times — a real time is not exactly 12:30:00Z
   or 20:00:00Z, so it falls straight through to the windows. If Yahoo instead
   re-anchors to some third constant, the windows decide it and an out-of-window
   constant degrades to `unknown`, which is the safe direction.

   RESIDUAL, stated rather than discovered later: an anchor is a CONVENTION, not
   an observation, so a genuine report scheduled at exactly 20:00:00Z that really
   was mid-session under EST would be read as AMC. Nothing in the payload could
   distinguish the two, and the convention is overwhelmingly the more likely
   reading at n=39/39. Re-run `node earnings-timing.check.mjs` §7 — which probes
   the live watchlist — if the distribution is ever suspected of having moved. */
const EARN_BMO_START_MIN = 4 * 60;        // 04:00 ET
const EARN_BMO_END_MIN   = 9 * 60 + 30;   // 09:30 ET — the opening bell
const EARN_AMC_START_MIN = 16 * 60;       // 16:00 ET — the closing bell

/* Yahoo's fixed UTC session anchors, as seconds past UTC midnight. Compared for
   EXACT equality: an anchor is a flag, and "near 20:00Z" is not the same claim. */
const EARN_ANCHOR_BMO_UTC_SEC = 12 * 3600 + 30 * 60;   // 12:30:00Z — before open
const EARN_ANCHOR_AMC_UTC_SEC = 20 * 3600;             // 20:00:00Z — after close

/** Minutes past ET midnight for an instant, or null. `hourCycle: 'h23'` because
 *  `hour12: false` renders midnight as "24" under some ICU builds, which would
 *  put a midnight ET value at 1440 and past every cut. */
function etMinutesOfDay(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const h = Number(parts.find(p => p.type === 'hour')?.value);
  const m = Number(parts.find(p => p.type === 'minute')?.value);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/** `{ earningsTs, earningsSession }` from a `calendarEvents.earnings` object.
 *  `earningsTs` is the raw first entry as ISO 8601 UTC — the same entry
 *  `earningsDate` and `daysToEarnings` already use, so the three cannot describe
 *  different reports. */
function earningsTimingFrom(cal) {
  const raws = (cal?.earningsDate || [])
    .map(e => Number.isFinite(e?.raw) ? e.raw : (Number.isFinite(e) ? e : null))
    .filter(v => v != null);
  if (!raws.length) return { earningsTs: null, earningsSession: 'unknown' };

  const ts  = raws[0];
  const iso = new Date(ts * 1000).toISOString();
  const out = s => ({ earningsTs: iso, earningsSession: s });

  // Start/end pair spanning the session — Yahoo saying "sometime that day".
  if (new Set(raws).size > 1) return out('unknown');

  // Seconds past UTC midnight, normalised so a pre-epoch value cannot go negative
  // and slip past an anchor comparison as some other constant.
  const utcSec = ((ts % 86400) + 86400) % 86400;

  // Date-only placeholder. Checked on the UTC instant: see the dateline note.
  // Stays FIRST of the three UTC tests — 00:00:00Z is not an anchor, and it must
  // be rejected before anything tries to read a session out of it.
  if (utcSec === 0) return out('unknown');

  // The fixed UTC anchors, exact equality. See the measurement above.
  if (utcSec === EARN_ANCHOR_BMO_UTC_SEC) return out('bmo');
  if (utcSec === EARN_ANCHOR_AMC_UTC_SEC) return out('amc');

  // Not an anchor: fall through to the ET wall-clock windows, which is the right
  // reading of a genuinely published time.
  const mins = etMinutesOfDay(ts * 1000);
  if (mins == null) return out('unknown');
  if (mins >= EARN_BMO_START_MIN && mins < EARN_BMO_END_MIN) return out('bmo');
  if (mins >= EARN_AMC_START_MIN) return out('amc');
  return out('unknown');
}

/** Yahoo's estimate flag as a boolean, or null when Yahoo omits it.
 *
 *  THE FIELD IS `isEarningsDateEstimate`. ARCHITECTURE.md's "Not yet done" item 2
 *  calls it `earningsDateIsEstimate` and that name does not exist in the live
 *  payload — reading it returns undefined for every ticker, which would have
 *  shipped a permanently-null flag that looked like "Yahoo never sends it".
 *  Verified 2026-08-18 against the live response: `calendarEvents.earnings` keys
 *  are earningsDate, earningsCallDate, `isEarningsDateEstimate`, earningsAverage,
 *  earningsLow, earningsHigh, revenueAverage, revenueLow, revenueHigh. The
 *  documented name is checked as a fallback in case Yahoo carries both.
 *
 *  Null is NOT false: "Yahoo did not say" and "the company confirmed it" are
 *  different claims, and a gate working from an estimate has to say which it has. */
function earningsIsEstimateFrom(cal) {
  for (const v of [cal?.isEarningsDateEstimate, cal?.earningsDateIsEstimate]) {
    if (typeof v === 'boolean') return v;
    if (typeof v?.raw === 'boolean') return v.raw;
  }
  return null;
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

/* ── `premium:{TICKER}` — REPURPOSED, and this is the part to read ───────────
   It is NO LONGER a premium-screen row. It is now the SHARED IV/EARNINGS HEADER
   that `longRow` reuses on its warm path: earnings date, front/back ATM IV, term
   structure, hv30, ivRank, ivHvRatio. Slow-moving fields only — spot and the
   expiry list are never reused, because a stale spot corrupts every breakeven.

   WHY IT SURVIVED THE TAB. `refreshLongTicker` reads it, and deleting
   `/api/premium/:ticker` removed its ONLY writer. Left as-is, the warm branch
   would have become permanently unreachable and every Long request would run
   cold: 8 external Yahoo fetches instead of 4, doubling crumb pressure on a
   35-name sequential "Load all" — and crumb rate-limiting, not the subrequest
   cap, is the binding constraint on that screen. So the writer moved to
   `refreshLongTicker`, which already computes every one of these fields when it
   runs cold.

   The KEY NAME is deliberately unchanged. Renaming it would orphan every live
   record for no behavioural gain; `PREM_SCHEMA` retires the old shape instead. */
const premiumKey = sym => `premium:${sym.toUpperCase()}`;

/** Bank the shared header out of a freshly computed cold `longRow`. */
async function storeSharedHeader(sym, row, env) {
  const header = {
    symbol: sym.toUpperCase(),
    schema: PREM_SCHEMA,
    ts: Date.now(),
    ok: true,
    status: 'ok',
    // Exactly the fields `longRow` declares as reusable in `sharedFields`, and no
    // more. Storing anything else would invite a future reader to reuse a field
    // that ages faster than this record does.
    earnings: row.earnings ?? null,
    front: row.front ?? null,
    back: row.back ?? null,
    termStructure: row.termStructure ?? null,
    hv30: row.hv30 ?? null,
    ivRank: row.ivRank ?? null,
    ivHvRatio: row.ivHvRatio ?? null,
    historyDays: row.historyDays ?? 0,
    rankReason: row.rankReason ?? null,
  };
  await env?.REC_LOG?.put(premiumKey(sym), JSON.stringify(header), { expirationTtl: PREMIUM_ROW_TTL });
}

async function readPremiumRow(sym, env) {
  try {
    const row = await env?.REC_LOG?.get(premiumKey(sym), 'json');
    // A row written under an older shape renders as blanks rather than failing
    // loudly, so retire it and let the caller report it as pending.
    return row && row.schema === PREM_SCHEMA ? row : null;
  } catch (_) { return null; }
}

/* ── GET /api/premium/batch?symbols= ─────────────────────────────────────────
   Cache-status read, NOT a data fetch: reads KV and makes ZERO outbound FETCHES,
   so the tab can paint every watchlist ticker on load without touching Yahoo.

   It does NOT cost zero subrequests, which is what this comment used to imply:
   one KV read per symbol, and KV counts against the same 10,000 pool. The number
   ships in `_instr`. Tickers with nothing cached come back in `missing` so the
/* ── GET /api/premium/:ticker ────────────────────────────────────────────────
   The only path in the premium screen that spends subrequests, and it spends
   ~5 against a 10,000 cap. **One ticker per invocation, never more** — not for
   the cap's sake but for Yahoo's: this is the whole reason the batch sweep is gone.

     (no param)   serve the cached row if it is inside PREMIUM_FRESH_MS,
                  otherwise refetch. A cache hit costs ZERO outbound calls.
     ?refresh=1   always refetch, whatever the cache says. Backs the ↻ control.
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
// 3: Lane E (straddle/strangle) adds the two-sided coverage split and the
//    lane-E entry shape. A row cached under 2 has neither, so it must retire.
// 4: Lane F (defined-risk credit spreads) adds the lane-F entry shape and
//    `gates.laneF`. A 3 row renders the Long tab with a lane missing.
const LONG_SCHEMA      = 4;
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

/* Lane E — straddle and strangle, ALWAYS AS A PAIR.
 *
 * The lane does not exist to surface these trades. It exists to answer, before
 * one is put on, whether the required move has historically happened — and most
 * of the time the honest answer is no, which the lane must be willing to say
 * rather than rendering something tradeable.
 *
 * STRIKE SELECTION REUSES EXISTING RULES. No new selection rule is invented:
 *   · straddle — the listed strike nearest spot, via `nearestTradeableStrike()`
 *   · strangle — `PREM_TARGETS[0]` (0.30Δ) on each side. That is the premium
 *     screen's canonical wide/OTM leg delta, already used to pick exactly this
 *     kind of strike on both the put and call sides. `PREM_TARGETS[1]` (0.16Δ)
 *     would give a second, wider strangle; the pair rule calls for one.
 * Derived from PREM_TARGETS rather than copied, so the two cannot drift. */
const LANE_E_STRANGLE_TARGET = PREM_TARGETS[0];

/* Lane F — DEFINED-RISK credit spreads, short ~0.30Δ / long ~0.16Δ.
 *
 * Short premium is secondary on this screen and is priced accordingly: every
 * structure here is defined-risk, and **max loss = width × 100 − credit is the
 * point of the lane**. Naked single-leg CSP and covered-call pricing is gone —
 * see the aROC note in ARCHITECTURE.md for why its denominator was wrong.
 *
 * Deltas are `PREM_TARGETS` — the same two the deleted premium screen selected,
 * reused rather than re-chosen so there is one definition of "the short strike"
 * and "the wing". [0] is the short leg, [1] the long wing.
 *
 * THE LANE IS POSITION-UNAWARE BY CONSTRUCTION. It cannot know whether shares are
 * held, so nothing here may imply a covered position: no covered-call framing, no
 * share-based capital, no assignment modelling. Every card is a defined-risk
 * spread on its own terms. */
const LANE_F_SHORT = PREM_TARGETS[0];
const LANE_F_LONG  = PREM_TARGETS[1];

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

/** Long-premium gate. It inherits its tri-state shape from the deleted
 *  `sellableFrom()` — deliberately, because the null case caused an incident on
 *  the old premium tab: treating "no basis to judge" as a fail dimmed every row
 *  for the whole 60-day collection window. `buyable: null` renders NEUTRAL, not
 *  dim. This is now the ONLY vol gate on the screen; Lane F has none.
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

/**
 * TWO-SIDED coverage, for a structure that pays on either tail.
 *
 *   P(r ≥ +reqUp) + P(r ≤ reqDown)     with reqDown < 0 < reqUp
 *
 * COMPOSED FROM `coverageAt`, NOT AN EXTENSION OF IT. `coverageAt` is load-bearing
 * on every other lane, and widening its contract to serve one caller would put the
 * two-sided branch inside the function every one-sided candidate already runs
 * through. Composition also produces the split for free — and the split is not a
 * diagnostic here, it is required output (see below).
 *
 * THE TAILS ARE RETURNED SEPARATELY AND MUST BE RENDERED SEPARATELY. On a trending
 * name drift inflates one tail and deflates the other, so a healthy-looking total
 * can rest almost entirely on one side: 24% split 22/2 is a long call wearing a
 * straddle's name, and 24% split 13/11 is an actual volatility trade. Summing them
 * on screen destroys exactly the distinction this lane exists to draw.
 *
 * The two events are disjoint (`reqDown < 0 < reqUp`), so the sum is a probability
 * and not an over-count. That is asserted rather than assumed: crossed or equal
 * thresholds return null, because a "straddle" whose breakevens overlap is not a
 * structure whose coverage means anything.
 */
function coverageTwoSided(sorted, reqUp, reqDown) {
  if (!Array.isArray(sorted) || !sorted.length) return null;
  if (!Number.isFinite(reqUp) || !Number.isFinite(reqDown)) return null;
  if (!(reqDown < reqUp)) return null;
  const upper = coverageAt(sorted, reqUp, 'up');
  const lower = coverageAt(sorted, reqDown, 'down');
  if (upper == null || lower == null) return null;
  return { upper, lower, total: upper + lower };
}

/**
 * Risk-neutral P(finish beyond EITHER breakeven).
 *
 * Composed from two `probBeyondBreakeven` calls — the call side above `beUpper`,
 * the put side below `beLower` — because a straddle's payoff needs both tails and
 * the one-sided figure would understate it by roughly half.
 *
 * Each leg takes its OWN sigma, from the listed strike nearest that breakeven,
 * following the same rule single-leg candidates use. Skew is real: the put-side
 * vol is normally the higher of the two, and averaging them or reusing ATM would
 * quietly misprice the side that carries most of the tail.
 *
 * Disjoint for the same reason as the coverage above, so the sum is a probability.
 */
function probBeyondEither({ spot, beUpper, beLower, tYears, volUp, volDown, rate }) {
  if (!Number.isFinite(beUpper) || !Number.isFinite(beLower) || !(beLower < beUpper)) return null;
  const up   = probBeyondBreakeven({ spot, breakeven: beUpper, tYears, vol: volUp,   rate, type: 'call' });
  const down = probBeyondBreakeven({ spot, breakeven: beLower, tYears, vol: volDown, rate, type: 'put'  });
  if (up == null || down == null) return null;
  return { up, down, total: up + down };
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
    /* TWO-SIDED SPLIT — populated only for Lane E, null everywhere else. Carried
       as separate fields rather than folded into `coverage*` because the total is
       the misleading number on a trending name and the UI must be able to show
       the tails apart. Null on a one-sided candidate is correct and meaningful:
       a long call HAS no lower tail, which is not the same as one measuring 0. */
    coverageUpper1y: null, coverageLower1y: null,
    coverageUpper3y: null, coverageLower3y: null,
    coverageTwoSided: false,
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

  /* TWO-SIDED (Lane E) vs ONE-SIDED. The branch is on the candidate carrying BOTH
     breakevens, not on its `type` — a straddle has no single direction, and
     inferring one from `type` is how a two-tailed structure ends up measured on
     one tail. Everything below this block (expectancy, episodes, concentration) is
     shared and unchanged: those already handle straddle/strangle through
     `payoffAt`, which pays on both tails without knowing it is doing so. */
  const twoSided = Number.isFinite(cand.beUpper) && Number.isFinite(cand.beLower) && spot > 0;

  if (twoSided) {
    out.coverageTwoSided = true;
    const reqUp   = cand.beUpper / spot - 1;
    const reqDown = cand.beLower / spot - 1;
    const c1 = coverageTwoSided(h.sorted1y, reqUp, reqDown);
    const c3 = coverageTwoSided(h.sorted3y, reqUp, reqDown);
    if (c1) { out.coverage1y = c1.total; out.coverageUpper1y = c1.upper; out.coverageLower1y = c1.lower; }
    if (c3) { out.coverage3y = c3.total; out.coverageUpper3y = c3.upper; out.coverageLower3y = c3.lower; }
  } else {
    const reqMove = Number.isFinite(cand.breakeven) && spot > 0 ? cand.breakeven / spot - 1 : null;
    /* `covDir` OVERRIDES the type inference, and Lane F is why it exists. For a
       debit structure the win condition is "moved past the breakeven", which the
       type implies. For a CREDIT spread the win condition is the opposite, so a
       bull put spread needs 'up' where a long put needs 'down'. Inferring from
       `type` there would silently report the LOSS frequency in the column Lane B
       uses for its win frequency. Default preserves every existing caller. */
    const dir = cand.covDir || (cand.type === 'PUT' ? 'down' : 'up');
    if (reqMove == null) {
      out.coverageReason = 'no breakeven to measure against';
      out.expectancyReason = out.coverageReason;
      return out;
    }
    out.coverage1y = coverageAt(h.sorted1y, reqMove, dir);
    out.coverage3y = coverageAt(h.sorted3y, reqMove, dir);
  }
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
 *  The IV-outlier guard is `ivPlausible()` in the shared-constants section above.
 *  It was shared with the deleted `pickCandidates()` for the same reason it is
 *  shared across lanes now: every lane selects strikes BY delta off the same
 *  chains, and a second copy of the guard is how two callers drift apart. */
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

/** The listed contract nearest a price that is actually tradeable: a plausible IV
 *  and a quoted ask. `ivNearPrice()` answers a different question — it returns the
 *  strike/IV pair for a P(BE) sigma and does not care whether the thing can be
 *  bought — so it cannot stand in here. */
function nearestTradeableStrike(list, price, atmIvDec) {
  const usable = (list || []).filter(o =>
    Number.isFinite(o?.strike) &&
    Number.isFinite(o?.impliedVolatility) &&
    ivPlausible(o.impliedVolatility, atmIvDec) &&
    Number.isFinite(o?.ask) && o.ask > 0);
  if (!usable.length || !Number.isFinite(price)) return null;
  return usable.reduce((best, o) =>
    Math.abs(o.strike - price) < Math.abs(best.strike - price) ? o : best);
}

/**
 * Lane E — one straddle or strangle, fully priced and measured.
 *
 * Both structures are built by this one function because they differ only in
 * strike selection: same two legs, same debit-is-the-ask rule, same two-sided
 * breakevens, same payoff shape. `kind` is 'straddle' or 'strangle' and feeds
 * `payoffAt` unchanged — those payoff functions already exist from the §6.2 work
 * and are NOT reimplemented here.
 *
 * WHY THE PAIR IS NEVER SPLIT. The strangle cuts the debit and cuts coverage by
 * more. That is a property of the structure rather than of any particular quote,
 * so seeing the two side by side once is the point of the lane. The caller
 * renders both or renders the missing one with its reason — never one alone.
 */
function laneECandidate(chain, ctx, kind) {
  const { spot, rate, dte, tYears, emPct, spreadMax, atmIv, moves } = ctx;
  if (!Number.isFinite(rate) || atmIv == null || !(spot > 0)) return null;
  const atmDec = atmIv / 100;

  let callOpt, putOpt;
  if (kind === 'straddle') {
    // Same strike both sides — the listed strike nearest spot. Resolved on the
    // call side and then matched on the put side so the two legs cannot end up on
    // different strikes, which would silently make it a strangle.
    callOpt = nearestTradeableStrike(chain?.calls, spot, atmDec);
    if (!callOpt) return null;
    putOpt = (chain?.puts || []).find(o => o.strike === callOpt.strike
      && Number.isFinite(o?.impliedVolatility) && ivPlausible(o.impliedVolatility, atmDec)
      && Number.isFinite(o?.ask) && o.ask > 0) || null;
    if (!putOpt) return null;
  } else {
    callOpt = nearestDelta(chain?.calls, spot, rate, tYears, 'call', LANE_E_STRANGLE_TARGET, { atmIv: atmDec });
    putOpt  = nearestDelta(chain?.puts,  spot, rate, tYears, 'put',  LANE_E_STRANGLE_TARGET, { atmIv: atmDec });
    if (!callOpt || !putOpt) return null;
    // A strangle needs the call above the put. Equal strikes IS a straddle, and
    // returning it under the strangle label would make the pair report the same
    // structure twice while appearing to compare two.
    if (!(callOpt.strike > putOpt.strike)) return null;
  }

  const cq = quoteOf(callOpt), pq = quoteOf(putOpt);
  if (cq.ask == null || pq.ask == null) return null;

  const cg = bsGreeks({ spot, strike: callOpt.strike, tYears, vol: callOpt.impliedVolatility, rate, type: 'call' });
  const pg = bsGreeks({ spot, strike: putOpt.strike,  tYears, vol: putOpt.impliedVolatility,  rate, type: 'put'  });
  if (!cg || !pg) return null;

  const debit    = cq.ask + pq.ask;                 // per share, both legs bought
  const debitPer = +(debit * 100).toFixed(2);       // per contract — what expectancy divides by
  const beUpper  = callOpt.strike + debit;
  const beLower  = putOpt.strike  - debit;
  if (!(beLower > 0) || !(beUpper > beLower)) return null;

  const upPct   = (beUpper / spot - 1) * 100;       // signed +
  const downPct = (1 - beLower / spot) * 100;       // reported as a magnitude
  // REQUIRED MOVE is the WIDER of the two breakevens. The narrow side flatters the
  // structure and is not what has to happen for the trade to work in both
  // directions — the headline number has to be the harder one.
  const requiredPct = Math.max(upPct, downPct);
  const beEm = Number.isFinite(emPct) && emPct > 0 ? requiredPct / emPct : null;

  // Sigma per side from the strike nearest THAT breakeven, never ATM and never
  // shared between the tails — put skew is real and normally makes the two differ.
  const ivUp   = ivNearPrice(chain?.calls, beUpper);
  const ivDown = ivNearPrice(chain?.puts,  beLower);
  const pb = (ivUp && ivDown)
    ? probBeyondEither({ spot, beUpper, beLower, tYears, volUp: ivUp.iv, volDown: ivDown.iv, rate })
    : null;

  const st = kind === 'straddle'
    ? { kind: 'straddle', strike: callOpt.strike, debit: debitPer }
    : { kind: 'strangle', callStrike: callOpt.strike, putStrike: putOpt.strike, debit: debitPer };

  /* Both breakevens go across, which is what selects the two-sided branch in
     attachCoverage. `breakeven` is ALSO passed, set to the upper one, purely as
     the independent anchor for expectancyFrom's guard 1 — a straddle's payoff
     crosses zero at both, so either satisfies it. */
  const cov = attachCoverage(
    { type: kind.toUpperCase(), breakeven: beUpper, beUpper, beLower },
    st,
    { moves, spot, dte, pBe: pb?.total ?? null },
  );

  const worstSpread = Math.max(cq.spreadPct ?? 0, pq.spreadPct ?? 0);
  const flags = [];
  if (worstSpread > spreadMax) flags.push('wide-spread');
  if (Math.min(callOpt.openInterest ?? 0, putOpt.openInterest ?? 0) < LONG_MIN_OI) flags.push('thin-oi');

  return {
    lane: 'E',
    kind,
    type: kind.toUpperCase(),
    status: worstSpread > spreadMax ? 'illiquid' : 'ok',
    callStrike: callOpt.strike,
    putStrike: putOpt.strike,
    // Actual leg deltas, not the targets they were selected against — the same
    // rule Lane C follows.
    callDelta: +cg.delta.toFixed(4),
    putDelta:  +pg.delta.toFixed(4),
    netDelta:  +(cg.delta + pg.delta).toFixed(4),
    targetDelta: kind === 'strangle' ? LANE_E_STRANGLE_TARGET : null,
    targetDeltaSource: kind === 'strangle' ? 'PREM_TARGETS[0]' : 'nearest listed strike to spot',
    callIv: +(callOpt.impliedVolatility * 100).toFixed(2),
    putIv:  +(putOpt.impliedVolatility * 100).toFixed(2),
    callAsk: cq.ask, putAsk: pq.ask,
    debit: debitPer,
    debitPerShare: +debit.toFixed(2),
    maxLoss: debitPer,
    beUpper: +beUpper.toFixed(2),
    beLower: +beLower.toFixed(2),
    beUpperPct: +upPct.toFixed(2),
    beLowerPct: +downPct.toFixed(2),
    requiredPct: +requiredPct.toFixed(2),
    requiredSide: upPct >= downPct ? 'upside' : 'downside',
    beEm: beEm == null ? null : +beEm.toFixed(3),
    pBe: pb ? +pb.total.toFixed(4) : null,
    pBeUp:   pb ? +pb.up.toFixed(4)   : null,
    pBeDown: pb ? +pb.down.toFixed(4) : null,
    pBeIvUp:   ivUp   ? +(ivUp.iv * 100).toFixed(2)   : null,
    pBeIvDown: ivDown ? +(ivDown.iv * 100).toFixed(2) : null,
    pBeIvStrikeUp:   ivUp?.strike   ?? null,
    pBeIvStrikeDown: ivDown?.strike ?? null,
    pBeReason: pb != null ? null
      : (!Number.isFinite(rate) ? 'no risk-free rate — P(BE) suppressed rather than computed at r=0'
                                : 'no listed strike near one of the breakevens quotes a usable IV; '
                                  + 'ATM IV is not substituted, and a one-sided P(BE) is not shown in its place'),
    netVega:  +(cg.vega + pg.vega).toFixed(2),
    thetaDay: +((cg.theta + pg.theta) / 365 * 100).toFixed(2),
    openInterest: Math.min(callOpt.openInterest ?? 0, putOpt.openInterest ?? 0),
    spreadPct: +worstSpread.toFixed(4),
    spreadMax,
    flags,
    ...cov,
  };
}

/**
 * Lane F — one defined-risk credit spread, fully priced and measured.
 *
 * `type` is the side the spread is built on: 'put' → bull put spread (profits
 * while the stock stays ABOVE), 'call' → bear call spread (profits while it stays
 * BELOW). Short leg at `LANE_F_SHORT`, long wing at `LANE_F_LONG`.
 *
 * CREDIT IS THE BID ON THE SHORT LEG AND THE ASK ON THE WING — the mirror of a
 * debit structure, and what a seller can actually hit rather than the mid.
 *
 * ══ THE DIRECTION INVERSION, which is the easiest thing here to get wrong ══
 *
 * For every other lane, `coverage` is the frequency with which the stock MOVED
 * PAST the breakeven, and that is the win condition. For a credit spread the win
 * condition is the stock NOT moving past it. Reporting the shared definition here
 * would put the LOSS frequency in a column labelled the same as Lane B's win
 * frequency — two opposite quantities under one heading.
 *
 * So Lane F reports coverage as P(WIN), which inverts the direction relative to a
 * long option of the same side:
 *
 *   bull put spread  (type 'put')  → wins ABOVE breakeven → dir 'up'
 *   bear call spread (type 'call') → wins BELOW breakeven → dir 'down'
 *
 * A long put uses 'down' and a long call uses 'up', so this is the opposite of
 * what `attachCoverage`'s type inference would pick — hence `covDir` is passed
 * EXPLICITLY. `pBe` is inverted the same way, by calling `probBeyondBreakeven`
 * with the opposite `type`, so `gap = coverage − pBe` stays a comparison of two
 * estimates of the same event.
 */
function creditSpreadCandidate(chainSide, ctx, type) {
  const { spot, rate, dte, tYears, emPct, spreadMax, atmIv, moves } = ctx;
  if (!Number.isFinite(rate) || atmIv == null || !(spot > 0)) return null;
  const band = { atmIv: atmIv / 100 };

  const shortOpt = nearestDelta(chainSide, spot, rate, tYears, type, LANE_F_SHORT, band);
  const longOpt  = nearestDelta(chainSide, spot, rate, tYears, type, LANE_F_LONG,  band);
  if (!shortOpt || !longOpt || shortOpt.strike === longOpt.strike) return null;
  // The wing is always further OTM than the short leg: below it on a put spread,
  // above it on a call spread. Anything else is not this structure.
  if (type === 'put' ? !(longOpt.strike < shortOpt.strike) : !(longOpt.strike > shortOpt.strike)) return null;

  const sq = quoteOf(shortOpt), lq = quoteOf(longOpt);
  if (sq.bid == null || lq.ask == null) return null;
  const creditShare = sq.bid - lq.ask;
  if (!(creditShare > 0)) return null;          // a debit here means the chain is broken

  const sg = bsGreeks({ spot, strike: shortOpt.strike, tYears, vol: shortOpt.impliedVolatility, rate, type });
  const lg = bsGreeks({ spot, strike: longOpt.strike,  tYears, vol: longOpt.impliedVolatility,  rate, type });
  if (!sg || !lg) return null;

  const width  = Math.abs(shortOpt.strike - longOpt.strike);
  const credit = +(creditShare * 100).toFixed(2);          // per contract
  /* MAX LOSS = width × 100 − credit. This is the figure the lane exists to show,
     and it is ALSO the capital denominator — computed once here so the number on
     the card and the number expectancy divides by cannot drift apart. Using the
     credit instead would post expectancies in the hundreds of percent. */
  const maxLoss = +(width * 100 - credit).toFixed(2);
  if (!(maxLoss > 0)) return null;

  const breakeven = type === 'put' ? shortOpt.strike - creditShare : shortOpt.strike + creditShare;
  const bePct = Math.abs(breakeven / spot - 1) * 100;
  const beEm  = Number.isFinite(emPct) && emPct > 0 ? bePct / emPct : null;

  // Inverted on purpose — see the header. A bull put spread's win is P(S ≥ be),
  // which `probBeyondBreakeven` expresses as the CALL side.
  const winType = type === 'put' ? 'call' : 'put';
  const beIv = ivNearPrice(chainSide, breakeven);
  const pBe  = beIv ? probBeyondBreakeven({ spot, breakeven, tYears, vol: beIv.iv, rate, type: winType }) : null;

  const st = {
    kind: type === 'put' ? 'credit-put-spread' : 'credit-call-spread',
    shortStrike: shortOpt.strike, longStrike: longOpt.strike, width, credit,
  };
  const cov = attachCoverage(
    { type: type.toUpperCase(), breakeven, covDir: type === 'put' ? 'up' : 'down' },
    st,
    { moves, spot, dte, pBe },
  );

  const worstSpread = Math.max(sq.spreadPct ?? 0, lq.spreadPct ?? 0);
  const flags = [];
  if (worstSpread > spreadMax) flags.push('wide-spread');
  if (Math.min(shortOpt.openInterest ?? 0, longOpt.openInterest ?? 0) < LONG_MIN_OI) flags.push('thin-oi');

  return {
    lane: 'F',
    type: type.toUpperCase(),
    structure: type === 'put' ? 'bull put spread' : 'bear call spread',
    status: worstSpread > spreadMax ? 'illiquid' : 'ok',
    shortStrike: shortOpt.strike,
    longStrike: longOpt.strike,
    // Actual leg deltas, not the targets — the same rule Lanes C and E follow.
    shortDelta: +sg.delta.toFixed(4),
    longDelta:  +lg.delta.toFixed(4),
    targetDeltas: [LANE_F_SHORT, LANE_F_LONG],
    shortIv: +(shortOpt.impliedVolatility * 100).toFixed(2),
    longIv:  +(longOpt.impliedVolatility * 100).toFixed(2),
    width: +width.toFixed(2),
    credit,
    creditPerShare: +creditShare.toFixed(2),
    maxLoss,
    maxProfit: credit,
    riskReward: +(credit / maxLoss).toFixed(3),
    // Credit ÷ capital at risk. NOT annualised against a share position: this
    // structure has no share leg, and the naked-margin denominator the deleted
    // premium screen used was wrong for a holder — see ARCHITECTURE.md.
    returnOnRisk: +(credit / maxLoss).toFixed(4),
    breakeven: +breakeven.toFixed(2),
    bePct: +bePct.toFixed(2),
    beEm: beEm == null ? null : +beEm.toFixed(3),
    pBe: pBe == null ? null : +pBe.toFixed(4),
    pBeIvStrike: beIv?.strike ?? null,
    pBeIvUsed: beIv ? +(beIv.iv * 100).toFixed(2) : null,
    pBeReason: pBe != null ? null
      : (!Number.isFinite(rate) ? 'no risk-free rate — P(BE) suppressed rather than computed at r=0'
                                : 'no listed strike near the breakeven quotes a usable IV; ATM IV is not substituted'),
    netDelta: +(lg.delta - sg.delta).toFixed(4),
    thetaDay: +((lg.theta - sg.theta) / 365 * 100).toFixed(2),
    vegaPerPoint: +(lg.vega - sg.vega).toFixed(2),
    openInterest: Math.min(shortOpt.openInterest ?? 0, longOpt.openInterest ?? 0),
    spreadPct: +worstSpread.toFixed(4),
    spreadMax,
    flags,
    // Stated on the card. The lane cannot see a share position and must not imply one.
    positionNote: 'Defined-risk spread priced on its own terms. This screen cannot see whether you '
      + 'hold shares, so nothing here is a covered position and no share-based capital is assumed.',
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
/** `moves` is passed in by the caller rather than read here, because `longRow()`
 *  already holds it for the coverage block — so the per-ticker magnitude bar
 *  costs ZERO additional binding ops. Without it the ticker basis would be the
 *  only one with no magnitude figure, which would read as a defect rather than as
 *  the deliberate absence it is not. */
async function directionalRead(sym, env, moves = null) {
  let a = null, entries = [], pooled = null;
  try { a = await env?.REC_LOG?.get(`analysis:${sym}`, 'json'); } catch (_) {}
  try { entries = (await env?.REC_LOG?.get(`rec:${sym}`, 'json')) || []; } catch (_) {}
  // ONE read, not a scan. The pooled record is precomputed by the 2:00pm cron
  // from a list it was already performing — see buildPooledCalibration().
  try {
    const p = await env?.REC_LOG?.get(POOLED_CALIB_KEY, 'json');
    if (p && p.schema === POOLED_CALIB_SCHEMA) pooled = p;
  } catch (_) {}

  const rating = ['BUY', 'HOLD', 'SELL'].includes(a?.rating) ? a.rating : null;
  // Same bar and base rates the pooled record uses, from the series already in hand.
  const ownRates = baseRatesFrom(moves, 20);
  const ownMap   = ownRates ? new Map([[sym.toUpperCase(), ownRates]]) : new Map();
  const own      = recCalibration(entries, {
    statsFor: e => statsForEntry({ ...e, ticker: e.ticker || sym }, ownMap),
  });

  /* TRI-STATE BASIS, the shape inherited from the deleted `sellableFrom()` and
     now carried by `buyableFrom()`: 'ticker' | 'pooled' |
     'none'. This ticker's own record wins when it clears the floor; the pooled
     record stands in while it does not; neither resolving is 'none'.

     THE BASIS TRAVELS WITH THE NUMBERS AND MUST BE RENDERED. A pooled hit rate
     shown as though it were this ticker's own is the same class of error as
     substituting an HV percentile for IV rank — plausible, indistinguishable on
     screen, and wrong about which question it answers. */
  const useOwn    = own.reason == null;
  const usePooled = !useOwn && pooled && pooled.reason == null;
  const basis  = useOwn ? 'ticker' : usePooled ? 'pooled' : 'none';
  const source = useOwn ? own : usePooled ? pooled : null;
  const resolvedBasis = basis !== 'none';

  /* ── SORT INFLUENCE IS DISABLED, AND THIS IS A DATA-DRIVEN DISABLE ──────────
     NOT DEAD CODE. Do not delete this block by applying the rule that removed the
     unreachable 1y fallback — that branch could never fire; this one is switched
     off by a measurement and is meant to light up again if the measurement
     changes. Everything below it still computes.

     Measured 2026-08-10 over the whole recommendation log, against the BASE RATE
     for the same population and window:

       sign-scored BUY       53.3%   base 61.4%   edge  −8.1 pts
       magnitude-scored BUY  17.3%   base 34.3%   edge −16.9 pts
       (both over the same 75 benchmarked outcomes)

     53.3% reads as a coin flip and is in fact a NEGATIVE edge: these names drifted
     up, so being long unconditionally beat the rating. Both outcomes score below
     their benchmark, so any sort influence would be reordering candidates on a
     measured non-edge — which is worse than reordering on nothing, because the
     ordering carries an implicit claim the data contradicts.

     The tag still renders. It just does not reorder. To re-enable, the condition
     is a rate that BEATS its base rate on a population that clears both floors —
     `edgePts > 0` on the cell in use — not a rate that merely exists. */
  const cellFor = r => (source && r ? source.byRating?.[r] ?? null : null);
  const liveCell = cellFor(rating);
  const hasEdge  = Number.isFinite(liveCell?.edgePts) && liveCell.edgePts > 0;
  const scored   = false;   // ← the disable. See above before changing.

  const basisReason = basis === 'ticker'
    ? `${own.n} resolved outcomes for ${sym} — this ticker's own record`
    : basis === 'pooled'
      ? `${sym} has ${own.n} of ${own.minN} resolved outcomes, so this is the POOLED record across `
        + `${pooled.tickersContributing} tickers (n=${pooled.n}). It describes the model's average `
        + `behaviour, NOT this ticker's.`
      : `${own.n} of ${own.minN} resolved for ${sym}, and no pooled record has resolved either`;

  return {
    rating,
    source: rating ? `analysis:${sym}` : null,
    asOf: a?.ts ?? null,
    confidence: Number.isFinite(a?.confidence) ? a.confidence : null,
    calibration: {
      basis, basisReason,
      n:       source ? source.n : own.n,
      tickerN: own.n,
      pooledN: pooled?.n ?? null,
      minN:       own.minN,
      ratingMinN: own.ratingMinN,
      reason: resolvedBasis ? null : basisReason,
      /* EVERY RATE SHIPS WITH ITS BASE RATE AND EDGE. Nothing renders a hit rate
         without them — a rate alone is unreadable, which is the whole finding
         behind the sort disable above. `hitRateReason` says why a rate is null:
         HOLD makes no claim, or the per-rating floor was not met. */
      hitRate:       liveCell?.hitRate ?? null,
      hitRateReason: liveCell?.hitRateReason ?? null,
      // The count the rate was actually computed over — the BENCHMARKED rows, not
      // all rows. Rendering `n` beside a rate computed on a subset would reprint
      // the population mismatch the cell() fix removed. `hitRateNAll` carries the
      // wider count so the shrinkage stays visible.
      hitRateN:      liveCell?.benchmarkedN ?? null,
      hitRateNAll:   liveCell?.n ?? null,
      baseRate:      liveCell?.baseRate ?? null,
      edgePts:       liveCell?.edgePts ?? null,
      brier:         source ? source.brier : null,
      // The magnitude-scored outcome, ALONGSIDE the sign-scored one above — never
      // instead of it. Null with a reason until a move series exists for the bar.
      magnitudeHitRate:   rating ? source?.byRatingMagnitude?.[rating]?.hitRate ?? null : null,
      magnitudeHitRateReason: rating ? source?.byRatingMagnitude?.[rating]?.hitRateReason ?? null : null,
      // Benchmarked count again, for the same reason as `hitRateN` above.
      magnitudeN:         rating ? source?.byRatingMagnitude?.[rating]?.benchmarkedN ?? null : null,
      magnitudeNAll:      rating ? source?.byRatingMagnitude?.[rating]?.n ?? null : null,
      magnitudeBarPct:    rating ? source?.byRatingMagnitude?.[rating]?.barPct ?? null : null,
      magnitudeBaseRate:  rating ? source?.byRatingMagnitude?.[rating]?.baseRate ?? null : null,
      magnitudeEdgePts:   rating ? source?.byRatingMagnitude?.[rating]?.edgePts ?? null : null,
      magnitudeReason:    source ? source.magnitudeReason : null,
      pooledAsOf: pooled?.d ?? null,
      // Why the tag does not reorder. Carried as data so the card can name both
      // numbers inline rather than deferring to a legend.
      sortDisabled: true,
      sortDisabledEdge: liveCell?.edgePts ?? null,
      sortWouldQualify: hasEdge,
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

  // One KV read. Banked daily by the 2:00pm PT sweep, so this path never fetches
  // for it — a per-ticker chart fetch here would put 22 invocations against Yahoo
  // the moment anyone hit "Load all".
  // Read BEFORE the directional read, which reuses it for the magnitude bar.
  const moves = await readMoveSeries(sym, env);
  const read = await directionalRead(sym, env, moves);
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

  /* Lane F — defined-risk credit spreads, on Lane B's already-fetched chains.
     Zero extra subrequests, the same arrangement as Lanes C, D and E.

     NO RATING GATE and no vol gate of its own: the lane is demoted to one of five
     and participates in the ordinary cross-lane expectancy sort rather than
     getting special placement. `analysis:` is informational-only for the reason
     recorded on Lane E. */
  for (const [exp, chain] of [[bExp1, bChain1], [bExp2, bChain2]]) {
    if (exp == null || !chain || !Number.isFinite(rate)) continue;
    const ctx = ctxFor(exp, chain);
    if (ctx.atmIv == null) continue;
    const entry = { lane: 'F', expiry: expiryIso(exp), dte: dteOf(exp), atmIv: ctx.atmIv,
                    expectedMovePct: ctx.emPct == null ? null : +ctx.emPct.toFixed(2), candidates: [] };
    for (const type of ['put', 'call']) {
      const c = creditSpreadCandidate(type === 'call' ? chain.calls : chain.puts, ctx, type);
      if (c) entry.candidates.push(c);
    }
    entry.status = entry.candidates.length ? 'ok' : 'no-iv';
    if (!entry.candidates.length) {
      entry.reason = `no ${LANE_F_SHORT}/${LANE_F_LONG}-delta pair on this expiry prices a credit spread `
        + 'with a positive net credit on both legs';
    }
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

  /* ── Lane E — straddle + strangle, on Lane B's already-fetched monthlies ────
     Zero extra subrequests, the same arrangement Lanes C and D use.

     THE LANE ALWAYS RENDERS. Failing a gate produces an entry naming the gate
     that failed, never a hidden or blank one: "this did not qualify, and here is
     why" is the product. Hiding it would make "no straddle worth looking at" and
     "no data for this name" identical on screen.

     THE RATING IS DELIBERATELY NOT A GATE. `analysis:{TICKER}` measured a NEGATIVE
     edge (sign-scored BUY 50.5% against a 60.5% base rate, 2026-08-10), which is
     why the alignment tag is informational-only. Gating a lane on a measured
     non-edge would reintroduce exactly what was just disabled — and a straddle
     makes no directional claim in the first place. */
  for (const [exp, chain] of [[bExp1, bChain1], [bExp2, bChain2]]) {
    if (exp == null) continue;
    const iso = expiryIso(exp), edte = dteOf(exp);
    const entry = { lane: 'E', expiry: iso, dte: edte, candidates: [], gateFailed: [], gateDetail: {} };

    if (!chain || !Number.isFinite(rate)) {
      entry.status = !chain ? 'error' : 'no-rate';
      entry.reason = !chain ? 'expiry chain did not load'
                            : 'no risk-free rate — greeks suppressed rather than computed at r=0';
      lanes.push(entry);
      continue;
    }
    const ectx = ctxFor(exp, chain);
    entry.atmIv = ectx.atmIv;
    entry.expectedMovePct = ectx.emPct == null ? null : +ectx.emPct.toFixed(2);

    /* GATE 1 — vol is not rich. `buyable === null` is NOT a failure: it means no
       basis to judge yet (rank still collecting, no HV30), and treating it as a
       fail is the bug that dimmed the whole Premium tab for three months. */
    if (gate.buyable === false) {
      entry.gateFailed.push('vol-not-cheap');
      entry.gateDetail.vol = `IV is not cheap enough to buy premium — ${gate.reason}`;
    }
    /* GATE 2 — a catalyst sits INSIDE the expiry. Without one there is no reason
       to expect the move that has to happen; a straddle on no catalyst is paying
       theta for a coin flip. */
    const catalystIn = earnIso != null && iso != null && earnIso >= etToday() && earnIso <= iso;
    if (!catalystIn) {
      entry.gateFailed.push('no-catalyst-inside');
      entry.gateDetail.catalyst = earnIso == null
        ? 'no scheduled earnings date from Yahoo, so no catalyst can be confirmed inside this expiry'
        : `next earnings ${earnIso} falls outside this expiry (${iso})`;
    }
    // GATE 3 — term structure. Positive termStructure is backwardation: the front
    // premium a buyer pays is the rich end of the curve.
    if (termStructure != null && termStructure > 0) {
      entry.gateFailed.push('hostile-term');
      entry.gateDetail.term = `front IV is ${termStructure.toFixed(1)} pts richer than back `
        + '(backwardation) — buying the rich end of the curve';
    }

    const straddle = laneECandidate(chain, ectx, 'straddle');
    const strangle = laneECandidate(chain, ectx, 'strangle');

    /* THE PAIR IS NEVER SPLIT. If one fails to price, the other still renders and
       the missing one is reported with its reason — the comparison between them is
       the point, and a lone straddle silently drops the fact that the strangle
       costs less and covers disproportionately less. */
    if (straddle) entry.candidates.push(straddle);
    else entry.candidates.push({ lane: 'E', kind: 'straddle', status: 'not-priced',
      reason: 'no strike near spot quotes a plausible IV and an ask on both the call and put side' });
    if (strangle) entry.candidates.push(strangle);
    else entry.candidates.push({ lane: 'E', kind: 'strangle', status: 'not-priced',
      reason: `no ${LANE_E_STRANGLE_TARGET}-delta pair on this expiry quotes a plausible IV and an ask `
        + 'on both sides, with the call strike above the put' });

    // GATE 4 — coverage has to resolve, or there is no measured answer to give and
    // the lane has nothing to say that the other lanes do not already say better.
    const covOk = straddle && straddle.coverage3y != null;
    if (!covOk) {
      entry.gateFailed.push('no-coverage');
      entry.gateDetail.coverage = straddle
        ? (straddle.coverageReason || 'coverage does not resolve at this horizon')
        : 'the straddle did not price, so there is no breakeven to measure coverage against';
    }

    /* THE HEADLINE — three numbers, one line, in this order:
         required move / expected move / typical realized move
       Everything else on the card is supporting detail. `typicalRealizedPct` is
       the median ABSOLUTE N-session move from the stored series at this horizon,
       which is the honest comparator for a structure that pays on either tail. */
    const snap = snapHorizon(edte);
    entry.headline = {
      requiredPct:  straddle?.requiredPct ?? null,
      expectedPct:  entry.expectedMovePct,
      typicalRealizedPct: snap ? medianAbsMovePct(moves, snap.horizon) : null,
      horizon: snap?.horizon ?? null,
      sessions: snap?.sessions ?? null,
      reason: straddle ? null : 'no straddle priced, so there is no required move to state',
    };

    /* THE EARNINGS-STRADDLE CAVEAT — visible text, not a comment.
       Expectancy and coverage both assume HOLD TO EXPIRY. The trade actually worth
       considering into a print is buy-before / sell-after: a two-day vega trade,
       not a 45-day terminal-value trade. IV crush can take that position down even
       when the move happens, and these figures do not model it.
       NO IV-CRUSH MODEL IS ATTEMPTED. There is no vol-surface history in this
       codebase to support one, so the limitation is stated and the derivation
       stops — the same refusal Lane D makes rather than assuming a future IV. */
    if (catalystIn) {
      entry.holdToExpiryCaveat =
        'These figures assume the position is HELD TO EXPIRATION. The straddle actually worth '
        + `considering into the ${earnIso} print is buy-before / sell-after — a two-day vega trade, `
        + 'not a terminal-value trade over ' + edte + ' days. IV crush after the print can take that '
        + 'position down even when the move happens, and NOTHING here models it: there is no vol-surface '
        + 'history in this codebase to model it from. Coverage and expectancy below describe a trade you '
        + 'would probably not put on.';
    }

    entry.status = entry.gateFailed.length ? 'gated' : 'ok';
    if (entry.gateFailed.length) {
      entry.reason = `did not qualify: ${entry.gateFailed.join(', ')}`;
    }
    lanes.push(entry);
  }

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
    laneF: { short: LANE_F_SHORT, long: LANE_F_LONG },
  };
  await storeLongRow(row, env);

  /* BANK THE SHARED HEADER so the next request can take the warm path.
     Until the Premium tab was deleted, `premium:{TICKER}` was written by
     `/api/premium/:ticker` and read here. Deleting the tab removed its only
     writer, which would have made the warm branch permanently unreachable and
     put every Long request on the cold path — 8 external Yahoo fetches instead
     of 4, doubling crumb pressure on a 35-name "Load all", which is the binding
     constraint on this screen rather than the subrequest cap.
     So the record survives the tab, now written by whoever computed the fields.
     Only written when this run was COLD: on a warm run the fields came from the
     record, and rewriting them would refresh `ts` without refreshing the data —
     a stale row that reports itself as fresh. */
  if (!premium && row.ok) {
    try {
      await storeSharedHeader(sym, row, env);
    } catch (e) { console.warn(`[long] ${sym} shared-header write failed:`, e.message); }
  }
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

  /* ONE macro read for the whole batch — 1 binding op for 33 symbols, not 33.
     It goes in the ENVELOPE beside `_meta` and is never attached to a row: macro
     is one fact about the day, and repeating it per row would be 33 copies of
     the same object and would invite a renderer to draw it per row. */
  const macro = await readMacroState(env);

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
      // `strangleDeltaSource` ships the PROVENANCE, not just the number: the whole
      // point of reusing PREM_TARGETS[0] is that no new selection rule was
      // invented, and a bare 0.3 on the frontend would lose that.
      E: { strangleDelta: LANE_E_STRANGLE_TARGET, strangleDeltaSource: 'PREM_TARGETS[0]',
           straddleRule: 'nearest listed strike to spot' },
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
    macro,
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

  /* ENVELOPE, not the row — the same rule as `/api/long/batch`. One extra KV
     read of the ~640-byte `macro:state` key on every path, cache hits included,
     so a refreshed row and the header chip beside it describe the same moment.
     `macro:series` is never read here. */
  const macro = await readMacroState(env);

  if (cached && (fresh || cachedOnly)) {
    return json({ row: cached, cached: true, stale: !fresh, ageMs: age, macro,
                  _instr: stamp('cache-hit'), _meta: longRowMeta(cached) }, 200, origin);
  }
  if (cachedOnly) {
    return json({
      row: null, cached: true, macro,
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
    row, cached: false, stale: false, ageMs: 0, macro,
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
    //
    // EVERY CALLER SETS `src`. Two did not until 2026-08-12, and the cost was that
    // sweep completeness could not be measured at all: the cron and
    // `/api/iv/:ticker` both wrote unprovenanced, so an `iv:` count conflated a
    // scheduled sweep with whatever anyone happened to look at. 2026-08-10 showed
    // 35 samples against a 33-name watchlist and the sweep had not run — every one
    // of them was `long-live` plus traffic.
    //
    // AN ABSENT `src` MEANS PRE-2026-08-12, NOT `'api'`. Historical keys are
    // deliberately not backfilled: the gaps and their provenance are the evidence
    // for how biased the series is, and rewriting them would destroy it. Anything
    // reading `src` must treat absent as UNKNOWN, never as a default.
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
  // `src: 'api'` — a request-path write, present only for names someone looked at.
  // This is the viewing-biased half of the series and must be distinguishable from
  // the scheduled sweep; see the provenance note in recordIvSample().
  try { await recordIvSample(sym, snap, env, { src: 'api' }); }
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

  // REFUSES on an empty universe, and does so BEFORE `ivsweep:last` is stamped
  // below — otherwise a zero-name run would dedup itself out for the whole day.
  const tickers = await sweepUniverse(env, 'iv sweep', 50); // 1–2 chain fetches each
  if (!tickers) return;

  let ok = 0;
  for (let i = 0; i < tickers.length; i += 5) {
    const results = await Promise.allSettled(tickers.slice(i, i + 5).map(async (t) => {
      const snap = await ivSnapshot(t, env);
      if (!snap) return false;
      // `src: 'sweep'` — the ONLY provenance that makes this series a daily
      // series rather than a record of what someone opened. Without it, sweep
      // completeness is unmeasurable: see the note in recordIvSample().
      await recordIvSample(t, snap, env, { src: 'sweep' });
      return true;
    }));
    ok += results.filter(r => r.status === 'fulfilled' && r.value).length;
  }

  /* STAMP ONLY A COMPLETE RUN. `allSettled` turns every rejection into a fulfilled
     result, so `ok` can reach 0 with the loop reporting no error at all — and this
     stamped anyway, dedupping a zero-sample run out of the day's second firing
     while the invocation reported a clean 200. Measured 2026-08-12: every
     `ivSnapshot` forced to throw, 0 samples written, key stamped.

     The threshold is `ok === tickers.length`, not `ok > 0`, and that is deliberate:
     per-ticker writes are idempotent (one key per ticker per PT day), so a retry
     fills the gaps rather than duplicating work. 2026-08-06 banked 7 of N and a
     partial-tolerant threshold would have accepted it.

     COST, BOUNDED AND STATED: the 1:15pm window admits exactly two firings, so a
     name that fails persistently costs one extra pass per day and no more. That is
     the right trade — `ivRank` needs an unbroken daily series and a missed day
     never backfills. */
  const complete = ok === tickers.length;
  if (complete) {
    try { await env?.REC_LOG?.put('ivsweep:last', ptDate(), { expirationTtl: 172800 }); } catch (_) {}
    console.log(`[cron] iv samples recorded for ${ok}/${tickers.length} tickers`);
  } else {
    console.error(`[cron] !! IV-SWEEP-INCOMPLETE !! ${ok}/${tickers.length} tickers recorded. NOT stamping `
      + 'ivsweep:last, so the next firing retries the missing names. Writes are per-ticker idempotent.');
  }
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

const REGIME_GATES = {
  ivrHigh: IVR_HIGH, ivrLow: IVR_LOW,
  ratioHigh: RATIO_HIGH, ratioLow: RATIO_LOW,
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

  /* TWO GUARDS, and this job needed both because its dedup has a SEVEN-DAY window
     rather than one day.

     1. THE CURSOR DOES NOT ADVANCE PAST A BATCH THAT WHOLLY FAILED. It used to
        advance unconditionally, so four SEC timeouts retired those managers until
        the pass wrapped.
     2. `lastFullPass` IS ONLY SET IF THE PASS REPRESENTS ANY MANAGER AT ALL.
        It used to be set on wrap regardless. Measured 2026-08-12: five slices with
        every `fetch13F` throwing left `managersOk: 0` with `lastFullPass` set, and
        `refresh13FIndexIfStale` then idled — slices 6 and 7 were byte-identical
        no-ops. A whole week of an index representing nobody. */
  const batchOk = batch.some(inv => store.byManager[inv.cik]?.ok);
  const next    = at + THIRTEENF_BATCH;
  const wrapped = batchOk && next >= SUPER_INVESTORS.length;
  if (wrapped && store.stats.managersOk > 0) store.lastFullPass = new Date().toISOString();

  try {
    await env?.REC_LOG?.put(THIRTEENF_KEY, JSON.stringify(store), { expirationTtl: THIRTEENF_TTL });
    await env?.REC_LOG?.put(THIRTEENF_CURSOR, JSON.stringify({
      at: wrapped ? 0 : (batchOk ? next : at),
      passStartedAt: wrapped ? null : passStartedAt,
    }), { expirationTtl: THIRTEENF_TTL });
  } catch (e) { console.warn('[13f] write failed:', e.message); }
  if (!batchOk) {
    console.error(`[13f] !! SLICE-FAILED !! every manager in batch ${at}–${Math.min(next, SUPER_INVESTORS.length) - 1} `
      + 'failed. Cursor held at ' + at + ' and lastFullPass not set, so the next firing retries this batch.');
  }

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

/* PER-RATING floor, deliberately a SEPARATE constant from REC_CALIB_MIN_N even
   though it currently holds the same value. `REC_CALIB_MIN_N` gates the TOTAL
   resolved count; `hitRate` is computed per RATING, and a ticker can clear the
   total while a rating cell rests on one observation.

   That is not hypothetical. Measured 2026-08-10 across the whole log: PLTR had 32
   resolved entries so calibration reported as resolved — but 31 were HOLD, which
   is excluded from hit rate by design, leaving BUY n=1 and a card rendering a
   confident 100%. AAPL (n=2), AMD (n=1) and CAVA (n=1) did the same. The pooled
   record introduced a fourth instance at SELL n=4.

   A confident 100% from one call is the most trustworthy-LOOKING number on the
   card and the least trustworthy — strictly worse than a null, because a null
   invites a second look and a percentage does not. Below this floor the rating's
   hit rate is null with a reason naming the actual count. Same floor, same
   treatment, for the magnitude-scored rate. */
const REC_RATING_MIN_N = 10;

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

/* ── The magnitude bar ────────────────────────────────────────────────────────
   `fwd20 > 0` scores "did it go up at all". A long option needs "did it move far
   enough to pay", which is a different question and the only one relevant to how
   this screen is used. The bar is the MEDIAN 20-session ABSOLUTE move for that
   underlying, taken from `moves:{TICKER}` — a typical move for that name, so the
   threshold is per-ticker and measured rather than assumed.

   NO FIXED PERCENTAGE STAND-IN. Without a stored series the magnitude figures are
   null with a reason, exactly as `ivRank` is null before 60 days of samples.

   UNITS: `moves` returns are FRACTIONS (0.0523) and `fwd20` is PERCENT (5.23).
   This returns percent so it can be compared with `fwd20` directly, and that
   conversion is the single most likely place for this to go silently wrong. */
function medianAbsMovePct(moves, horizon = 20) {
  const arr = moves?.horizons?.[String(horizon)]?.sorted3y;
  if (!Array.isArray(arr) || !arr.length) return null;
  const abs = arr.map(([r]) => Math.abs(r)).sort((a, b) => a - b);
  const m = abs.length % 2
    ? abs[(abs.length - 1) / 2]
    : (abs[abs.length / 2 - 1] + abs[abs.length / 2]) / 2;
  return Number.isFinite(m) ? +(m * 100).toFixed(3) : null;   // fraction -> percent
}

/**
 * BASE RATES — the benchmark without which a hit rate is unreadable.
 *
 * Over the same underlying and the same 20-session window set, how often does the
 * outcome happen ANYWAY, with no signal involved? A signal with no edge scores its
 * base rate; above is edge, below is worse than no signal at all.
 *
 * This is not decoration. Measured 2026-08-10, the BUY rating's sign-scored hit
 * rate of 53.3% reads as a coin flip and is in fact a **negative** edge against a
 * base rate of 61.4% — these names drifted up, so being long unconditionally beat
 * the rating. No amount of staring at "53.9%" reveals that.
 *
 * Direction-matched to the rating: a BUY is scored on upside, a SELL on downside,
 * so the benchmark has to be too. HOLD makes no directional claim and gets none.
 */
function baseRatesFrom(moves, horizon = 20) {
  const arr = moves?.horizons?.[String(horizon)]?.sorted3y;
  if (!Array.isArray(arr) || !arr.length) return null;
  const barPct = medianAbsMovePct(moves, horizon);
  if (!Number.isFinite(barPct)) return null;
  const f = barPct / 100;
  return {
    barPct,
    BUY:  { sign: coverageAt(arr, 0, 'up'),   magnitude: coverageAt(arr,  f, 'up')   },
    SELL: { sign: coverageAt(arr, 0, 'down'), magnitude: coverageAt(arr, -f, 'down') },
    HOLD: { sign: null, magnitude: null },
  };
}

/** Per-entry stats for `recCalibration`, direction-matched to that entry's rating.
 *  `ratesByTicker` lets the pooled record use each ticker's OWN bar and base rate
 *  rather than one blended figure across names with wildly different vol. */
function statsForEntry(e, ratesByTicker) {
  const rates = ratesByTicker.get(String(e.ticker || '').toUpperCase());
  if (!rates) return null;
  const side = rates[e.rating] || { sign: null, magnitude: null };
  return { barPct: rates.barPct, signBase: side.sign, magBase: side.magnitude };
}

/**
 * Calibration over the resolved slice of a log.
 *
 * "Resolved" means fwd20 is filled — an entry logged nine sessions ago has no
 * outcome yet and cannot count. Below REC_CALIB_MIN_N the figures are returned
 * as nulls with a reason: a hit rate over four entries is noise wearing a
 * percentage sign, and it would read on screen exactly like a real one.
 *
 * TWO FLOORS, and they gate different things. REC_CALIB_MIN_N gates the TOTAL
 * resolved count. REC_RATING_MIN_N gates each RATING's own cell — a ticker can
 * clear the total while a rating rests on one observation, which is how a
 * confident 100% from n=1 shipped.
 *
 * TWO OUTCOMES, reported side by side and never one instead of the other:
 *   sign-scored      did fwd20 go the right way
 *   magnitude-scored did it move at least a typical 20-session move for the name
 * The gap between them is the point.
 *
 * EVERY RATE CARRIES ITS BASE RATE. A hit rate without the benchmark for the same
 * population and window is unreadable — 53.9% looks like a coin flip and is a
 * negative edge against 61.4%. `baseRate` and `edgePts` ride on every cell, and
 * nothing renders a rate without them.
 *
 * `statsFor(entry)` supplies the per-entry bar and base rates, so the pooled
 * record can use each ticker's OWN figures rather than one blended set across
 * names with wildly different vol.
 */
function recCalibration(list, { statsFor = null } = {}) {
  const resolved = list.filter(e => Number.isFinite(e.fwd20));
  const n = resolved.length;

  if (n < REC_CALIB_MIN_N) {
    return {
      n, minN: REC_CALIB_MIN_N, ratingMinN: REC_RATING_MIN_N,
      brier: null, brierN: 0, byRating: null, byRatingMagnitude: null,
      magnitudeReason: `${n} of ${REC_CALIB_MIN_N} resolved — magnitude scoring needs the same floor`,
      magnitudeN: 0,
      reason: `${n} of ${REC_CALIB_MIN_N} recommendations have a 20-session outcome. `
            + `Each entry needs 20 trading days to elapse before it resolves.`,
    };
  }

  const st      = e => (statsFor ? statsFor(e) : null);
  const barFor  = e => st(e)?.barPct ?? null;
  const withBar = resolved.filter(e => Number.isFinite(barFor(e)));
  const magnitudeReason = withBar.length === 0
    ? 'no stored move series to derive a magnitude bar from — the 2:00pm PT sweep banks one daily. '
      + 'No fixed percentage is substituted.'
    : withBar.length < REC_CALIB_MIN_N
      ? `${withBar.length} of ${REC_CALIB_MIN_N} resolved entries have a move series behind them`
      : null;

  const mean = arr => arr.length
    ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)
    : null;
  // Entry-weighted, because each entry carries its own ticker's benchmark.
  const meanRate = vals => {
    const v = vals.filter(Number.isFinite);
    return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4) : null;
  };

  /* One cell.
   *
   * THE RATE AND ITS BASE RATE ARE COMPUTED OVER THE SAME ROWS. Not every entry
   * has a stored move series behind it — the sweep covers the watchlist, the
   * recommendation log covers every ticker ever browsed — so a rate taken over
   * all rows and a benchmark taken over the subset with a series would be two
   * different populations printed side by side as if comparable. That is the
   * precise failure the base-rate rule exists to stop, so the cell restricts BOTH
   * to the benchmarked rows and reports `n` (all) and `benchmarkedN` separately,
   * making the shrinkage visible instead of silent.
   *
   * Three distinct null states, which must not collapse into one another:
   *   HOLD          makes no directional claim, so no outcome counts as right
   *   no rows       nothing resolved for this rating at all
   *   below floor   too few to publish, and the reason names the count
   */
  const cell = (rating, rows, hitFn, baseOf, extra = {}) => {
    const benched = rows.filter(e => Number.isFinite(baseOf(e)));
    const isHold  = rating === 'HOLD';
    const short   = benched.length < REC_RATING_MIN_N;
    const hits    = (isHold || !benched.length) ? null : benched.filter(hitFn).length;
    const rate    = (hits == null || short) ? null : +(hits / benched.length).toFixed(4);
    const baseRate = benched.length ? meanRate(benched.map(baseOf)) : null;
    return {
      n: rows.length,
      benchmarkedN: benched.length,
      hitRate: rate,
      hitRateReason: isHold
        ? 'HOLD makes no directional claim, so no outcome counts as right'
        : rows.length === 0
          ? 'no resolved outcomes for this rating'
          : benched.length === 0
            ? `${rows.length} resolved outcome${rows.length === 1 ? '' : 's'}, but none has a stored move `
              + `series to benchmark against — a rate with no base rate is not published`
            : short
              ? `${benched.length} of ${REC_RATING_MIN_N} benchmarked outcomes for this rating — too few to `
                + `publish a rate. A hit rate over ${benched.length} call${benched.length === 1 ? '' : 's'} `
                + `is noise wearing a percentage sign.`
              : null,
      // The benchmark travels with the rate, always, over the same rows.
      baseRate,
      edgePts: (rate != null && Number.isFinite(baseRate))
        ? +((rate - baseRate) * 100).toFixed(1) : null,
      ...extra,
    };
  };

  const byRating = {};
  for (const r of ['BUY', 'HOLD', 'SELL']) {
    const rows = resolved.filter(e => e.rating === r);
    byRating[r] = cell(r, rows,
      e => (r === 'BUY' ? e.fwd20 > 0 : e.fwd20 < 0),
      e => st(e)?.signBase ?? null, {
        meanFwd5:  mean(rows.filter(e => Number.isFinite(e.fwd5)).map(e => e.fwd5)),
        meanFwd20: mean(rows.map(e => e.fwd20)),
      });
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

  let byRatingMagnitude = null;
  if (!magnitudeReason) {
    byRatingMagnitude = {};
    for (const r of ['BUY', 'HOLD', 'SELL']) {
      const rows = withBar.filter(e => e.rating === r);
      const bars = rows.map(e => barFor(e)).filter(Number.isFinite).sort((a, b) => a - b);
      byRatingMagnitude[r] = cell(r, rows,
        e => (r === 'BUY' ? e.fwd20 >= barFor(e) : e.fwd20 <= -barFor(e)),
        e => st(e)?.magBase ?? null, {
          // Median of the per-entry bars actually applied — one number cannot
          // describe a pooled set spanning several tickers, so this is explicitly
          // the median bar, not "the" bar.
          barPct: bars.length ? +bars[Math.floor(bars.length / 2)].toFixed(2) : null,
        });
    }
  }

  return {
    n, minN: REC_CALIB_MIN_N, ratingMinN: REC_RATING_MIN_N,
    reason: null, brier, brierN: scored.length, byRating,
    byRatingMagnitude, magnitudeReason, magnitudeN: withBar.length,
  };
}

async function handleTrack(ticker, env, origin) {
  if (!env.REC_LOG) return err('REC_LOG KV not bound', 500, origin);
  const list = (await env.REC_LOG.get(`rec:${ticker.toUpperCase()}`, 'json')) || [];
  const trackRates = new Map();
  try {
    const r = baseRatesFrom(await readMoveSeries(ticker, env), 20);
    if (r) trackRates.set(ticker.toUpperCase(), r);
  } catch (_) {}
  return json({
    ticker:      ticker.toUpperCase(),
    entries:     list,
    /* One extra KV read so this payload carries base rates too. The new rule —
       no rate on screen without the benchmark for the same population — is
       retroactive, and this endpoint feeds the Recommendation History card.
       The per-rating floor arrives here for free, so the n=1 100% cell is
       already fixed on that card. NOTE the card itself still renders only the
       raw rate; surfacing `baseRate` / `edgePts` there is a separate commit,
       since it means touching index.html. */
    calibration: recCalibration(list, {
      statsFor: (e) => statsForEntry(
        { ...e, ticker: e.ticker || ticker.toUpperCase() },
        trackRates),
    }),
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
/* ── Pooled calibration ───────────────────────────────────────────────────────
   Requiring 10 RESOLVED entries per ticker splits the evidence 63 ways, so
   `affectsSort` is false almost everywhere and the alignment tag reorders nothing
   on any ticker. Pooled across the log the same evidence clears the floor
   immediately.

   WHERE THIS RUNS, AND WHY IT IS NOT ON THE REQUEST PATH. A pooled scan is
   `list('rec:')` plus one `get` per key — measured at 64 binding ops against 63
   keys in production, and the key count GROWS with every ticker ever browsed.
   `directionalRead()` runs on every `/api/long/:ticker`, where the whole binding
   budget is currently 8, so that would be a 9× increase per request. A TTL cache
   would not fix it either: a cache still pays the full scan on every miss, and
   the miss lands on whichever user's request happens to be first.

   `fillForwardReturns()` ALREADY performs exactly this scan — it lists `rec:` and
   reads every key to fill forward returns. So the pooled figures are computed
   there, from data already in hand, for **zero additional list or get ops**. The
   only new cost is one KV write of the result and one read on the request path.

   `calib:pooled` has no TTL: it is rewritten every trading day by this job, and a
   stale pooled figure is strictly better than none — but `ptDate` and `ts` ride
   along so the reader can age it. */
const POOLED_CALIB_KEY    = 'calib:pooled';
/* SCHEMA 2 — every rate cell now carries `baseRate` / `edgePts`, and the
   per-rating floor can null a `hitRate` that schema 1 would have published. A
   schema-1 record read as schema 2 would show rates with no benchmark beside
   them, which the new rule forbids, so the reader rejects it outright. */
const POOLED_CALIB_SCHEMA = 2;

/**
 * Build the pooled record from the per-ticker lists the caller already holds.
 * `ratesByTicker` maps TICKER -> `baseRatesFrom()` output: the magnitude bar and
 * the direction-matched base rates for that name.
 */
function buildPooledCalibration(listsByTicker, ratesByTicker) {
  const all = [];
  let contributing = 0;
  for (const [tkr, list] of listsByTicker) {
    if (!Array.isArray(list) || !list.length) continue;
    let used = 0;
    for (const e of list) {
      if (!Number.isFinite(e.fwd20)) continue;
      // Tag each entry with its own ticker so the magnitude bar stays per-name.
      all.push({ ...e, ticker: e.ticker || tkr });
      used++;
    }
    if (used) contributing++;
  }

  const calib = recCalibration(all, { statsFor: e => statsForEntry(e, ratesByTicker) });

  return {
    schema: POOLED_CALIB_SCHEMA,
    ts: Date.now(),
    d: ptDate(),
    tickersContributing: contributing,
    tickersWithBar: ratesByTicker.size,
    ...calib,
  };
}

/** The shape a Yahoo-resolvable symbol has. Mirrors the guard on
 *  `/api/ai/:type/:ticker`. Anything in the `rec:` log failing this can never
 *  resolve a forward return, because the chart fetch behind it 404s by
 *  construction. */
const REC_SYMBOL_RE = /^[A-Z][A-Z.\-]{0,9}$/;

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
  let tickers = 0, filled = 0, chartFailures = 0;

  /* Every list this walk reads is retained for the pooled calibration below.
     The scan is the expensive part and it is already being paid for here — see
     the note above buildPooledCalibration(). Accumulate BEFORE the `continue`s,
     or tickers with nothing pending (which is most of them, most days) would be
     silently excluded from the pool. */
  const listsByTicker = new Map();

  for (const key of keys) {
    const ticker = key.slice(4);
    let list;
    try { list = await env.REC_LOG.get(key, 'json'); } catch (_) { continue; }
    if (!Array.isArray(list) || !list.length) continue;
    listsByTicker.set(ticker.toUpperCase(), list);

    const pending = list.filter(e =>
      Number.isFinite(e.price) && REC_FWD_HORIZONS.some(h => e[h.ret] == null));
    if (!pending.length) continue;

    /* A key whose name cannot be a Yahoo symbol 404s on every run, forever —
       `rec:/BTC` has produced a daily `chart failed — Yahoo 404` warn since it
       was logged. Skipping the fetch is NON-DESTRUCTIVE: the key is untouched
       and its entries still reach the pooled calibration below. The outcome is
       identical to today (those forward returns never resolved either), minus
       one doomed request and minus a warn line that reads like a fault.

       Deliberately NOT deleting the key. A KV delete is irreversible, and a
       malformed symbol is not worth that. Logged at `log`, not `warn`, and the
       line says it is expected — a recurring red herring in the log costs more
       reader-time than the fetch costs budget. */
    if (!REC_SYMBOL_RE.test(ticker.toUpperCase())) {
      console.log(`[cron] forward fill: skipped rec:${ticker} — name is not a valid symbol `
        + `shape, so its chart fetch would 404. EXPECTED, not an error; its forward returns `
        + `can never resolve and the key is left in place.`);
      continue;
    }

    let bars;
    try {
      const chart = await yahoo(`/v8/finance/chart/${encodeURIComponent(ticker)}`, '?range=2y&interval=1d');
      bars = chartDailyBars(chart);
    } catch (e) {
      console.warn(`[cron] forward fill ${ticker}: chart failed — ${e.message}`);
      chartFailures++;
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

  /* STAMP ONLY A COMPLETE RUN. `filled > 0` is the WRONG threshold here — most
     days nothing is pending and 0 filled is a correct, complete outcome. What
     makes a run incomplete is a ticker we could not read at all, so the guard is
     `chartFailures === 0`. Previously each failure just `continue`d and the stamp
     ran regardless, so a Yahoo outage dedupped the fill out for the whole day. */
  if (chartFailures === 0) {
    try { await env.REC_LOG.put('recfwd:last', ptDate(), { expirationTtl: 172800 }); } catch (_) {}
    console.log(`[cron] forward fill: ${filled} value(s) across ${tickers} ticker(s)`);
  } else {
    console.error(`[cron] !! FORWARD-FILL-INCOMPLETE !! ${chartFailures} ticker(s) had no readable chart `
      + `(${filled} value(s) filled across ${tickers}). NOT stamping recfwd:last, so the next firing retries.`);
  }

  /* ── Pooled calibration, from the lists just read ──────────────────────────
     Wrapped end to end: this is bookkeeping bolted onto a job that has already
     done its real work and written its results. A failure here must not make the
     forward fill look failed, and must never throw past the `recfwd:last` write
     above — otherwise a bookkeeping slip re-runs the whole fill tomorrow. */
  try {
    /* The magnitude bar per ticker. One `moves:` read per ticker that has at
       least one resolved entry — tickers with nothing resolved cannot contribute
       to calibration, so reading their series would be pure cost.

       DAY-ONE RACE, STATED: `collectMoveSeries` runs on this same 2:00pm branch
       under a separate ctx.waitUntil, so on the very first day the `moves:` keys
       may not exist yet when this runs. The magnitude fields then null with their
       reason and resolve on the next firing. They are deliberately NOT sequenced:
       chaining them would mean a hang in the sweep also blocks the forward fill,
       trading a one-day delay for a permanent robustness regression. */
    const ratesByTicker = new Map();
    for (const [tkr, list] of listsByTicker) {
      if (!list.some(e => Number.isFinite(e.fwd20))) continue;
      const m = await readMoveSeries(tkr, env);
      const rates = baseRatesFrom(m, 20);
      if (rates) ratesByTicker.set(tkr, rates);
    }

    const pooled = buildPooledCalibration(listsByTicker, ratesByTicker);
    await env.REC_LOG.put(POOLED_CALIB_KEY, JSON.stringify(pooled));
    console.log(
      `[cron] pooled calibration: n=${pooled.n} across ${pooled.tickersContributing} ticker(s), `
      + `magnitude n=${pooled.magnitudeN} over ${ratesByTicker.size} with a bar`
      + `${pooled.reason ? ` · sign-scored unresolved: ${pooled.reason}` : ''}`
      + `${pooled.magnitudeReason ? ` · magnitude unresolved: ${pooled.magnitudeReason}` : ''}`);
  } catch (e) {
    console.warn('[cron] pooled calibration failed:', e.message);
  }
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

  // Same refusal, and for the same reason: `movesweep:last` is stamped below.
  const tickers = await sweepUniverse(env, 'move-series sweep', LONG_MAX_SYMBOLS);
  if (!tickers) return;

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

  /* STAMP ONLY A COMPLETE RUN — same `allSettled` shape as the IV sweep and the
     same defect: a run where every ticker rejected reported no error and stamped.
     `absent` counts names spark did not return, which is a real upstream failure
     and not a reason to call the day done. `skipped` IS accounted for: those names
     are already current, so written + skipped === N is a complete outcome. */
  const accountedFor = written + skipped;
  if (accountedFor === tickers.length) {
    try { await env.REC_LOG.put(MOVES_SWEEP_KEY, ptDate(), { expirationTtl: 172800 }); } catch (_) {}
    console.log(
      `[cron] move-series sweep: ${written} written, ${skipped} already current, ${absent} not returned by spark, `
      + `${thin} with thin history · ${JSON.stringify(instrSince(mark, 'complete'))}`,
    );
  } else {
    console.error(`[cron] !! MOVE-SWEEP-INCOMPLETE !! ${accountedFor}/${tickers.length} accounted for `
      + `(${written} written, ${skipped} current, ${absent} absent from spark). NOT stamping ${MOVES_SWEEP_KEY}, `
      + `so the next firing retries · ${JSON.stringify(instrSince(mark, 'incomplete'))}`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MARKET MOOD — a candlestick emotion read across 4 index ETFs and the 11 SPDR
   sector ETFs, collapsed into ONE macro emotion and ONE stance line.

   ── HYBRID, AND THE SPLIT IS THE WHOLE DESIGN ───────────────────────────────
   Every state here — each symbol's emotion, the macro emotion, the stance
   category — is decided by the rules in this section and by nothing else.
   Claude is handed the FINISHED verdict and asked for one readable sentence.
   It cannot change a state: the prompt says the verdict is decided, the schema
   returns a sentence and nothing else, and `moodSentenceUsable()` rejects an
   answer that names a different state. A fixed template per (macroState,
   breadth qualifier) pair is what renders when the call fails or comes back
   unusable, and `sentenceSource` on the payload says which one is on screen.

   Why that split rather than asking the model for the read: the `analysis:`
   rating was wired into sort order before anyone measured it and came back with
   a NEGATIVE edge, and the macro chip ships display-only for the same reason.
   A model's read is allowed to write here. It is never allowed to decide.

   ── THIS IS PATTERN RECOGNITION, NOT A MEASURED EDGE ────────────────────────
   Nothing in this section has been scored against forward returns. The
   emotion, the macro state and the stance are a rules-based reading of price
   shape, and the payload carries `usedForRanking: false` so no reader has to
   infer that. It sorts, gates and filters nothing.

   ── SETTLED BARS ────────────────────────────────────────────────────────────
   Runs on the 2:00pm PT branch for the same reason `collectMoveSeries` does:
   the NYSE closes at 1:00pm PT, so by 2:00pm the day's daily bar is final and
   is the most informative bar in the series. `moodSettledBars()` still drops a
   final bar dated today when the job runs BEFORE the bell (PT hour <
   MOOD_PRECLOSE_PT_HOUR) — that covers a manual or admin-triggered run, which
   is the only way a forming bar can reach this code. An unconditional drop
   would discard a settled bar every single day and make the 2:00pm placement
   buy nothing.
   ══════════════════════════════════════════════════════════════════════════ */

const MOOD_KEY       = 'mood:state';
/* OUTSIDE the `mood:` prefix, the same rule as `ivsweep:last` / `movesweep:last`
   / `macrosweep:last`: nothing scanning that prefix may read the dedup stamp as
   a record. Stamped LAST, after the payload write, so any failure leaves the
   next firing to retry. */
const MOOD_SWEEP_KEY = 'moodsweep:last';
const MOOD_SCHEMA    = 1;
const MOOD_TTL       = 7 * 24 * 3600;          // 7d retention
/* Freshness ≠ retention, the same split as `long:` / `macro:` / `econ:dgs3mo`.
   Past 26h the section still renders, badged stale and carrying its as-of date;
   a labelled old read beats a blank one. Derived from the global TTL table so
   the badge's threshold and the reader's cannot drift. */
const MOOD_FRESH_MS  = TTL.mood * 1000;
const MOOD_RANGE     = '3mo';                  // ~63 sessions: SMA20 + context + slack
const MOOD_MIN_BARS  = 30;                     // below this the trend context cannot be formed
const MOOD_PRECLOSE_PT_HOUR = 13;              // PT hour the 1:00pm bell has rung by

/* ── THE UNIVERSE ────────────────────────────────────────────────────────────
   Candlestick patterns need OHLC, and `yahooSparkCloses` is close-only — so
   this is one /v8 chart fetch per symbol, 15 of them, and there is no batched
   substitute. That is the cost of the feature, stated rather than discovered.

   The sector half REUSES `SECTOR_ETFS` rather than restating the 11 names.
   Both tables are symbol -> label; an inverted twin of an existing table is the
   "looks like a copy, means the opposite" hazard this codebase has already been
   caught by once, so the direction matches deliberately. */
const MOOD_INDEX_ETFS = {
  'SPY': 'S&P 500',
  'QQQ': 'Nasdaq 100',
  'DIA': 'Dow 30',
  'IWM': 'Russell 2000',
};
const MOOD_SYMBOLS = [
  ...Object.entries(MOOD_INDEX_ETFS).map(([symbol, label]) => ({ symbol, label, group: 'index' })),
  ...Object.entries(SECTOR_ETFS).map(([symbol, label]) => ({ symbol, label, group: 'sector' })),
];

/* ── CANDLE GEOMETRY THRESHOLDS ──────────────────────────────────────────────
   Every predicate below is an exact OHLC test against one of these. They are
   ratios of the bar's own range or its own body, never absolute prices: a 0.40
   body on SPY and on XLU mean the same thing, a $2 body does not. */
const MOOD_DOJI_BODY_MAX     = 0.10;   // |c-o| <= 10% of the high-low range
const MOOD_SPIN_BODY_MAX     = 0.30;   // spinning top: small body...
const MOOD_SPIN_SHADOW_MIN   = 0.25;   //   ...with BOTH shadows >= 25% of range
const MOOD_HAMMER_SHADOW_MIN = 2.00;   // hammer family: long shadow >= 2x the body
const MOOD_HAMMER_OPP_MAX    = 0.25;   //   ...and the opposite shadow <= 25% of range
const MOOD_HAMMER_BODY_MAX   = 0.35;   //   ...and the body itself <= 35% of range
const MOOD_MARUBOZU_BODY_MIN = 0.90;   // body >= 90% of range: no meaningful shadows
const MOOD_LONG_BODY_MIN     = 0.60;   // "long" body, for engulfing / star / soldier quality
const MOOD_STAR_BODY_MAX     = 0.35;   // the star's own (middle) body
const MOOD_TREND_LOOKBACK    = 5;      // sessions in the prior-return half of the trend read
const MOOD_TREND_SMA         = 20;     // SMA of closes the current close is placed against

/* ── PATTERN SCORES ──────────────────────────────────────────────────────────
   Sign is direction, magnitude is conviction. Three-candle confirmations and
   engulfings carry the most because they encode a completed reversal rather
   than a single indecisive bar; doji and spinning top carry ZERO because
   indecision is not a direction, and giving them a sign would manufacture one.

   THESE ARE NOT CALIBRATED WEIGHTS. They are a stated ordering, and the payload
   ships them so nothing downstream re-invents a different one. */
const MOOD_PATTERN_SCORE = {
  'doji':                  0,
  'spinning-top':          0,
  'long-lower-shadow':     0,
  'long-upper-shadow':     0,
  'hammer':               +2,
  'inverted-hammer':      +1,
  'hanging-man':          -2,
  'shooting-star':        -2,
  'bullish-marubozu':     +2,
  'bearish-marubozu':     -2,
  'bullish-engulfing':    +3,
  'bearish-engulfing':    -3,
  'piercing-line':        +2,
  'dark-cloud-cover':     -2,
  'morning-star':         +3,
  'evening-star':         -3,
  'three-white-soldiers': +3,
  'three-black-crows':    -3,
};

/* Context adds at most ±2: one for which side of the SMA20 the close sits on,
   one for the sign of the prior 5-session return. Deliberately smaller than any
   confirmed reversal pattern — context should colour a read, not carry it. */
const MOOD_CTX_SMA   = 1;
const MOOD_CTX_TREND = 1;

/* ── EMOTION THRESHOLDS ──────────────────────────────────────────────────────
   Symmetric by construction: a score and its negation land the same distance
   from neutral. Positive cuts are `>=`, negative cuts are `<=`, and score 0 is
   the only value that reaches `neutral`. */
const MOOD_T_EUPHORIA     =  5;
const MOOD_T_GREED        =  3;
const MOOD_T_OPTIMISM     =  1;
const MOOD_T_CAUTION      = -1;
const MOOD_T_FEAR         = -3;
const MOOD_T_CAPITULATION = -5;

const MOOD_BULLISH_EMOTIONS = ['optimism', 'greed', 'euphoria'];
const MOOD_BEARISH_EMOTIONS = ['caution', 'fear', 'capitulation'];

/* ── MACRO CLASSIFIER ────────────────────────────────────────────────────────
   The indexes are what the phrase "the market" means, so they carry double the
   weight of one sector. Eleven sectors at weight 1 against four indexes at
   weight 2 gives the sector half 11/19 of the blend — enough that a broad
   sector move can outvote the indexes, which is the point of looking at both. */
const MOOD_INDEX_WEIGHT  = 2;
const MOOD_SECTOR_WEIGHT = 1;

const MOOD_M_EUPHORIA     =  4.0;
const MOOD_M_GREED        =  2.5;
const MOOD_M_RISK_ON      =  0.75;
const MOOD_M_RISK_OFF     = -0.75;
const MOOD_M_FEAR         = -2.5;
const MOOD_M_CAPITULATION = -4.0;

/* Breadth qualifier cutoffs, over the sectors that returned a reading. */
const MOOD_BREADTH_STRONG = 7;   // >= 7 of 11 leaning one way is broad
const MOOD_BREADTH_SPLIT  = 1;   // |bullish - bearish| <= 1 is split

/* ── STANCE ──────────────────────────────────────────────────────────────────
   Written for a trader whose primary structure is BOUGHT premium on
   high-conviction directional setups (long calls/puts, debit verticals), with
   short structures secondary and defined-risk only. That is why greed reads as
   a warning rather than a green light: for a buyer of options, a crowded tape
   is where the debit is most expensive and the edge is worst.

   EVERY macroState resolves here, `unavailable` included — a missing read gets
   an explicit no-stance rather than falling through to the neutral one, because
   "we could not compute this" and "the market is balanced" are different facts
   and must not produce the same line. */
const MOOD_STANCE = {
  'euphoria': {
    category: 'stand-down',
    sentence: 'Stand down on new longs — the tape is crowded and long premium is at its most expensive, '
            + 'so wait for the pullback rather than paying up for continuation.',
  },
  'greed': {
    category: 'wait-for-pullback',
    sentence: 'Do not chase — wait for pullback entries, because long premium is expensive here and every '
            + 'strike is already priced for the move to continue.',
  },
  'risk-on': {
    category: 'press-longs',
    sentence: 'Constructive for bought calls and call debit verticals — take the higher-conviction setups '
            + 'at normal size and let the trend do the work.',
  },
  'mixed': {
    category: 'setup-only',
    sentence: 'No macro edge either way — trade only names with their own catalyst, keep debits small, '
            + 'and skip anything that needs the whole tape to cooperate.',
  },
  'risk-off': {
    category: 'defensive',
    sentence: 'Defensive — no new swing longs into strength, bought puts and put debit verticals are the '
            + 'cleaner side, and any short structure stays defined-risk.',
  },
  'fear': {
    category: 'defined-risk-only',
    sentence: 'No new swing longs — defined-risk only, and watch for a reversal pattern to print before '
            + 'catching anything falling.',
  },
  'capitulation': {
    category: 'wait-for-reversal',
    sentence: 'Do not knife-catch — wait for a confirmed reversal candle, because premium is at its most '
            + 'expensive exactly where the urge to buy it is strongest.',
  },
  'unavailable': {
    category: 'no-read',
    sentence: 'No stance — the mood read could not be computed, and an absent reading is not a calm one.',
  },
};

/* Appended to the template sentence. A breadth qualifier changes how firmly the
   state is held, never which state it is — so it is a clause on the sentence
   rather than a second key into the stance table. */
const MOOD_BREADTH_CLAUSE = {
  'broad':  ' Breadth is broad, so the index read is confirmed across sectors.',
  'narrow': ' Breadth is narrow, so this rests on a few sectors rather than the whole tape.',
  'split':  ' Breadth is split, so treat the index read as weakly held.',
};

/* ── WHICH MISSING-RECORD CAUSES ARE ACTUALLY FAULTS ─────────────────────────
   `unavailable` is not one condition. A cold start and a sweep that has been
   refusing for days are both "no record", and only the second is wrong.

   THIS EXISTS BECAUSE THE BADGE AND THE CHIP DISAGREED. `_meta.ok` was
   `state !== 'unavailable'`, which painted the provenance badge RED on
   `never-collected` — while the chip beside it deliberately stayed neutral,
   under a comment saying a cold start is not a fault. One fact, two elements,
   opposite tones, and the red one was the more eye-catching of the two.

   So the split is named once, here, and SHIPS ON THE PAYLOAD as `faultCauses`.
   The frontend needs its own list anyway — it adds `endpoint-absent` and
   `request-failed`, which the Worker can never send because they describe the
   request rather than the record — and a hardcoded copy of the Worker's half is
   exactly how the two drift apart again. */
const MOOD_FAULT_CAUSES = ['stale-sweep', 'record-missing'];

/** `_meta.ok` for a mood payload: false ONLY where something is genuinely
 *  broken. `never-collected` (nothing has run yet) and `schema` (an old record
 *  retiring after a deploy) are both expected transitional states — neither says
 *  anything about the market and neither is a source failure. */
function moodMetaOk(rec) {
  if (!rec || rec.state !== 'unavailable') return true;
  return !MOOD_FAULT_CAUSES.includes(rec.unavailableCause);
}

const MOOD_ANSWER_TOKENS   = 200;
const MOOD_SENTENCE_MAX    = 260;   // chars; longer is not one sentence
const MOOD_SENTENCE_MIN    = 30;    // chars; shorter is not a usable rewrite

const MOOD_SENTENCE_SCHEMA = {
  type: 'object',
  properties: {
    sentence: {
      type: 'string',
      description: 'One sentence of plain prose, 15-40 words, no markdown, no bullet points.',
    },
  },
  required: ['sentence'],
  additionalProperties: false,
};

/** OHLC bars from a Yahoo /v8 chart response. Every predicate below needs all
 *  four values, so a bar missing any one of them is dropped rather than carried
 *  with a null that would silently make a comparison false. */
function moodBars(chart) {
  const res = chart?.chart?.result?.[0];
  const ts  = res?.timestamp || [];
  const q   = res?.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
    out.push({ iso: new Date(ts[i] * 1000).toISOString().slice(0, 10), o, h, l, c });
  }
  return out;
}

/** Drop a final bar dated today ONLY when the bell has not rung yet.
 *  See the settled-bars note above: at 2:00pm PT today's bar is final and is
 *  the bar this whole feature exists to read. */
function moodSettledBars(bars, today = ptDate(), ptHour = null) {
  const hour = ptHour == null
    ? Number(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hour12: false }))
    : ptHour;
  const last = bars.length ? bars[bars.length - 1] : null;
  if (last && last.iso === today && Number.isFinite(hour) && hour < MOOD_PRECLOSE_PT_HOUR) {
    return { bars: bars.slice(0, -1), droppedForming: true };
  }
  return { bars, droppedForming: false };
}

/** One bar's geometry. A zero-range bar (no trade, or a halt printing one price)
 *  yields null ratios, and every predicate then answers false rather than
 *  dividing by zero into a pattern that did not happen. */
function moodCandle(b) {
  const range = b.h - b.l;
  const body  = Math.abs(b.c - b.o);
  const upper = b.h - Math.max(b.o, b.c);
  const lower = Math.min(b.o, b.c) - b.l;
  const ok    = range > 0;
  return {
    ...b, range, body, upper, lower,
    bull: b.c > b.o, bear: b.c < b.o,
    bodyPct:  ok ? body / range  : null,
    upperPct: ok ? upper / range : null,
    lowerPct: ok ? lower / range : null,
  };
}

/* ── SINGLE-CANDLE PREDICATES ───────────────────────────────────────────────
   The hammer and inverted-hammer SHAPES are direction-neutral. Which name they
   take is decided by trend context in `moodPatternsAt` — a hammer in an uptrend
   is a hanging man, and calling both "hammer" would put a bullish reversal
   label on a bearish one. */
function moodIsDoji(k) {
  return k.bodyPct != null && k.bodyPct <= MOOD_DOJI_BODY_MAX;
}
function moodIsSpinningTop(k) {
  return k.bodyPct != null
      && k.bodyPct > MOOD_DOJI_BODY_MAX && k.bodyPct <= MOOD_SPIN_BODY_MAX
      && k.upperPct >= MOOD_SPIN_SHADOW_MIN && k.lowerPct >= MOOD_SPIN_SHADOW_MIN;
}
/** Long lower shadow, small body near the high. `body > 0` keeps a true doji out
 *  of this family: with a zero body, `lower >= 2 * body` is trivially true and
 *  every dragonfly doji would also report as a hammer. */
function moodIsHammerShape(k) {
  return k.bodyPct != null && k.body > 0
      && k.bodyPct <= MOOD_HAMMER_BODY_MAX
      && k.lower >= MOOD_HAMMER_SHADOW_MIN * k.body
      && k.upperPct <= MOOD_HAMMER_OPP_MAX;
}
/** Mirror image: long upper shadow, small body near the low. */
function moodIsInvertedShape(k) {
  return k.bodyPct != null && k.body > 0
      && k.bodyPct <= MOOD_HAMMER_BODY_MAX
      && k.upper >= MOOD_HAMMER_SHADOW_MIN * k.body
      && k.lowerPct <= MOOD_HAMMER_OPP_MAX;
}
function moodIsBullMarubozu(k) {
  return k.bodyPct != null && k.bull && k.bodyPct >= MOOD_MARUBOZU_BODY_MIN;
}
function moodIsBearMarubozu(k) {
  return k.bodyPct != null && k.bear && k.bodyPct >= MOOD_MARUBOZU_BODY_MIN;
}

/* ── TWO-CANDLE PREDICATES ──────────────────────────────────────────────────
   `p` is the prior bar, `k` the current one. Engulfing compares BODIES, not
   ranges — the classical definition, and the one that survives a long shadow.

   Piercing and dark cloud test the open against the prior CLOSE rather than the
   prior low/high. The stricter variant requires a gap past the extreme, which
   on index and sector ETFs is close to unreachable — a predicate that cannot
   fire is worse than no predicate, which this repo has already shipped once.

   ── KNOWN WATCH ITEM, UNTESTED AGAINST LIVE DATA — 2026-08-12 ───────────────
   THESE TWO ARE THE LOOSENED PREDICATES, AND ONLY FIXTURES HAVE EXERCISED THEM.
   The first live run (15 symbols, 2026-08-12) produced marubozu, engulfing,
   three-white-soldiers, spinning-top and the direction-neutral shadow names —
   piercing line and dark cloud cover fired on NEITHER. So the loosening did its
   job in the test harness and has never been observed against a real chain.

   THE FAILURE MODE TO WATCH IS OVER-FIRING, NOT SILENCE. Moving the open test
   from the prior extreme to the prior close widens the window, and each of
   these carries ±2 — so if they fire on ordinary two-day chop rather than on
   genuine reversals, per-symbol scores skew toward `caution` / `optimism` and
   away from `neutral`, and the macro blend drifts with them. Nothing errors and
   nothing looks wrong; the board just reads more decisive than the tape.

   HOW TO CHECK IT, once there is live history: count how often each of the two
   fires across `mood:state` days against the other patterns. A rate materially
   above the engulfing rate is the signal to tighten back toward the prior
   extreme — engulfing is the right comparator because it tests the same two
   bars and is the strict version of the same idea. Do NOT tighten on a single
   surprising day: `mood.check.mjs` §1 pins both the firing and the non-firing
   boundary, so any change has to move those fixtures deliberately. */
function moodIsBullEngulfing(p, k) {
  return p.bear && k.bull && p.body > 0 && k.body > 0 && k.c > p.o && k.o < p.c;
}
function moodIsBearEngulfing(p, k) {
  return p.bull && k.bear && p.body > 0 && k.body > 0 && k.c < p.o && k.o > p.c;
}
function moodIsPiercingLine(p, k) {
  if (!(p.bear && k.bull) || p.bodyPct == null || p.bodyPct < MOOD_LONG_BODY_MIN) return false;
  const mid = (p.o + p.c) / 2;
  // Closes back INTO the prior body past its midpoint, but not through it —
  // through it is an engulfing, and the two must stay mutually exclusive.
  return k.o < p.c && k.c > mid && k.c < p.o;
}
function moodIsDarkCloudCover(p, k) {
  if (!(p.bull && k.bear) || p.bodyPct == null || p.bodyPct < MOOD_LONG_BODY_MIN) return false;
  const mid = (p.o + p.c) / 2;
  return k.o > p.c && k.c < mid && k.c > p.o;
}

/* ── THREE-CANDLE PREDICATES ────────────────────────────────────────────────
   `a` is the oldest of the three, `k` the current bar. */
function moodIsMorningStar(a, b, k) {
  return a.bear && a.bodyPct != null && a.bodyPct >= MOOD_LONG_BODY_MIN
      && b.bodyPct != null && b.bodyPct <= MOOD_STAR_BODY_MAX
      && Math.max(b.o, b.c) < a.c                 // the star gaps below the first body
      && k.bull && k.c > (a.o + a.c) / 2;         // and the third closes back into it
}
function moodIsEveningStar(a, b, k) {
  return a.bull && a.bodyPct != null && a.bodyPct >= MOOD_LONG_BODY_MIN
      && b.bodyPct != null && b.bodyPct <= MOOD_STAR_BODY_MAX
      && Math.min(b.o, b.c) > a.c
      && k.bear && k.c < (a.o + a.c) / 2;
}
function moodIsThreeWhiteSoldiers(a, b, k) {
  return a.bull && b.bull && k.bull
      && a.bodyPct != null && b.bodyPct != null && k.bodyPct != null
      && a.bodyPct >= MOOD_LONG_BODY_MIN && b.bodyPct >= MOOD_LONG_BODY_MIN && k.bodyPct >= MOOD_LONG_BODY_MIN
      && b.c > a.c && k.c > b.c                    // each closes higher
      && b.o > a.o && b.o < a.c                    // and opens inside the prior body
      && k.o > b.o && k.o < b.c;
}
function moodIsThreeBlackCrows(a, b, k) {
  return a.bear && b.bear && k.bear
      && a.bodyPct != null && b.bodyPct != null && k.bodyPct != null
      && a.bodyPct >= MOOD_LONG_BODY_MIN && b.bodyPct >= MOOD_LONG_BODY_MIN && k.bodyPct >= MOOD_LONG_BODY_MIN
      && b.c < a.c && k.c < b.c
      && b.o < a.o && b.o > a.c
      && k.o < b.o && k.o > b.c;
}

/**
 * Trend context at bar `i`: which side of the SMA20 the close sits on, and the
 * sign of the prior `MOOD_TREND_LOOKBACK`-session return ENDING AT `i-1` — the
 * move that led into this bar, not one that includes it.
 *
 * Returns null when the history is too short. Null is not "flat": a caller must
 * not read "we could not form a trend" as "there is no trend", so the reversal
 * names fall back to their direction-neutral form rather than to a bullish one.
 */
function moodTrendAt(closes, i) {
  const need = Math.max(MOOD_TREND_SMA - 1, MOOD_TREND_LOOKBACK + 1);
  if (!Array.isArray(closes) || i < need || i >= closes.length) return null;
  let sum = 0;
  for (let j = i - MOOD_TREND_SMA + 1; j <= i; j++) sum += closes[j];
  const sma  = sum / MOOD_TREND_SMA;
  const from = closes[i - 1 - MOOD_TREND_LOOKBACK];
  const to   = closes[i - 1];
  if (!(from > 0)) return null;
  const priorRet = (to - from) / from * 100;
  const smaVote   = closes[i] > sma ? 1 : closes[i] < sma ? -1 : 0;
  const trendVote = priorRet > 0 ? 1 : priorRet < 0 ? -1 : 0;
  const votes = smaVote + trendVote;
  return {
    sma, priorRet, smaVote, trendVote, votes,
    aboveSma: smaVote > 0, belowSma: smaVote < 0,
    // BOTH signals must agree before a direction is claimed. One-of-two is
    // `flat`, which is a real answer here rather than a missing one.
    dir: votes >= 2 ? 'up' : votes <= -2 ? 'down' : 'flat',
  };
}

/**
 * Every pattern present on bar `i`, with the reversal shapes named by trend.
 *
 * The `flat` names — `long-lower-shadow` / `long-upper-shadow` — exist because
 * a hammer shape with no trend behind it has nothing to reverse. Calling it a
 * hammer would assert a bullish reversal from a bar that is only a bar; both
 * carry score 0, so the shape is reported without a direction being invented.
 */
function moodPatternsAt(bars, closes, i) {
  const k = moodCandle(bars[i]);
  const p = i >= 1 ? moodCandle(bars[i - 1]) : null;
  const a = i >= 2 ? moodCandle(bars[i - 2]) : null;
  const trend = moodTrendAt(closes, i);
  const dir   = trend ? trend.dir : 'flat';
  const names = [];

  if (moodIsDoji(k)) names.push('doji');
  else if (moodIsSpinningTop(k)) names.push('spinning-top');

  if (moodIsBullMarubozu(k)) names.push('bullish-marubozu');
  if (moodIsBearMarubozu(k)) names.push('bearish-marubozu');

  if (moodIsHammerShape(k)) {
    names.push(dir === 'up' ? 'hanging-man' : dir === 'down' ? 'hammer' : 'long-lower-shadow');
  }
  if (moodIsInvertedShape(k)) {
    names.push(dir === 'up' ? 'shooting-star' : dir === 'down' ? 'inverted-hammer' : 'long-upper-shadow');
  }

  if (p) {
    if (moodIsBullEngulfing(p, k))  names.push('bullish-engulfing');
    if (moodIsBearEngulfing(p, k))  names.push('bearish-engulfing');
    if (moodIsPiercingLine(p, k))   names.push('piercing-line');
    if (moodIsDarkCloudCover(p, k)) names.push('dark-cloud-cover');
  }
  if (a && p) {
    if (moodIsMorningStar(a, p, k))         names.push('morning-star');
    if (moodIsEveningStar(a, p, k))         names.push('evening-star');
    if (moodIsThreeWhiteSoldiers(a, p, k))  names.push('three-white-soldiers');
    if (moodIsThreeBlackCrows(a, p, k))     names.push('three-black-crows');
  }
  return { names, trend, candle: k };
}

/** Pattern scores plus at most ±2 of context. Returns null when there is no
 *  trend read at all, because a score built from patterns alone is not the same
 *  quantity as one built from patterns and context. */
function moodScoreOf(names, trend) {
  let score = 0;
  for (const n of names) score += MOOD_PATTERN_SCORE[n] ?? 0;
  if (trend) {
    score += trend.smaVote * MOOD_CTX_SMA;
    score += trend.trendVote * MOOD_CTX_TREND;
  }
  return score;
}

/** Score -> emotion. Negative cuts are tested BEFORE the neutral fallthrough,
 *  so only an exact 0 reaches `neutral`. */
function moodEmotionOf(score) {
  if (score == null || !Number.isFinite(score)) return null;
  if (score >= MOOD_T_EUPHORIA)     return 'euphoria';
  if (score >= MOOD_T_GREED)        return 'greed';
  if (score >= MOOD_T_OPTIMISM)     return 'optimism';
  if (score <= MOOD_T_CAPITULATION) return 'capitulation';
  if (score <= MOOD_T_FEAR)         return 'fear';
  if (score <= MOOD_T_CAUTION)      return 'caution';
  return 'neutral';
}

/** One symbol's read from its settled bars. Returns an `unavailable` row with a
 *  reason rather than a neutral emotion whenever it cannot compute one — a
 *  missing read must never be indistinguishable from a calm market. */
function moodReadFor(entry, bars) {
  const base = { symbol: entry.symbol, label: entry.label, group: entry.group };
  if (!Array.isArray(bars) || bars.length < MOOD_MIN_BARS) {
    return {
      ...base, status: 'unavailable', emotion: null, score: null, patterns: [],
      changePct: null, asOfClose: bars?.length ? bars[bars.length - 1].iso : null,
      reason: `only ${bars?.length || 0} settled daily bars returned, and ${MOOD_MIN_BARS} are needed `
            + `before the ${MOOD_TREND_SMA}-session trend context can be formed`,
    };
  }
  const i      = bars.length - 1;
  const closes = bars.map(b => b.c);
  const { names, trend } = moodPatternsAt(bars, closes, i);
  const score   = moodScoreOf(names, trend);
  const prev    = closes[i - 1];
  // `x == null` and `x === 0` must not render the same way, so a change that
  // cannot be computed is null and never 0.
  const changePct = prev > 0 ? (closes[i] - prev) / prev * 100 : null;
  return {
    ...base,
    status: 'ok',
    emotion:   moodEmotionOf(score),
    score,
    patterns:  names,
    changePct: changePct == null ? null : Math.round(changePct * 100) / 100,
    asOfClose: bars[i].iso,
    trend: trend ? {
      dir: trend.dir,
      aboveSma: trend.aboveSma,
      priorReturnPct: Math.round(trend.priorRet * 100) / 100,
    } : null,
    reason: null,
  };
}

/** Bullish / bearish / neutral counts over the sector rows that produced a read.
 *  `absent` is counted separately and is NOT folded into neutral — a sector we
 *  could not read is not a sector sitting still. */
function moodBreadthOf(sectorReads) {
  const counts = { bullish: 0, bearish: 0, neutral: 0, counted: 0, absent: 0 };
  for (const r of sectorReads) {
    if (r.status !== 'ok' || r.emotion == null) { counts.absent++; continue; }
    counts.counted++;
    if (MOOD_BULLISH_EMOTIONS.includes(r.emotion)) counts.bullish++;
    else if (MOOD_BEARISH_EMOTIONS.includes(r.emotion)) counts.bearish++;
    else counts.neutral++;
  }
  return counts;
}

/** How firmly the state is held across sectors. Checked split-first: a 5/5/1
 *  board is split even though neither side reaches the `broad` cutoff. */
function moodBreadthQualifier(counts, macroScore) {
  if (!counts || !counts.counted) return null;
  if (Math.abs(counts.bullish - counts.bearish) <= MOOD_BREADTH_SPLIT) return 'split';
  const lead = (macroScore != null && macroScore < 0) ? counts.bearish : counts.bullish;
  return lead >= MOOD_BREADTH_STRONG ? 'broad' : 'narrow';
}

/**
 * The macro verdict: deterministic, from the four index reads at double weight
 * and the sector reads at single weight.
 *
 * ANY unreadable INDEX makes the whole verdict unavailable and names which.
 * The four index ETFs are what the macro claim is about; computing one from
 * sectors alone and calling it "the market" would be a different measurement
 * wearing the same label. Sector rows that failed simply drop out of the blend
 * and are reported in `breadth.absent`.
 */
function moodMacroFrom(reads) {
  const idx = reads.filter(r => r.group === 'index');
  const sec = reads.filter(r => r.group === 'sector');
  const idxBad = idx.filter(r => r.status !== 'ok' || r.emotion == null);
  const breadth = moodBreadthOf(sec);

  if (idxBad.length || !idx.length) {
    const named = idxBad.map(r => r.symbol).join(', ') || 'all four';
    return {
      state: 'unavailable', score: null, breadth, breadthQualifier: null,
      unavailableCause: 'index-missing',
      missingIndexes: idxBad.map(r => r.symbol),
      reason: `no readable daily bars for ${named}, and the macro verdict is a claim about the index `
            + 'ETFs. Sector detail below is whatever did return — the verdict itself is withheld rather '
            + 'than rebuilt from a different set of symbols under the same name.',
    };
  }

  let num = 0, den = 0;
  for (const r of idx) { num += r.score * MOOD_INDEX_WEIGHT;  den += MOOD_INDEX_WEIGHT; }
  for (const r of sec) {
    if (r.status !== 'ok' || r.score == null) continue;
    num += r.score * MOOD_SECTOR_WEIGHT; den += MOOD_SECTOR_WEIGHT;
  }
  const score = den > 0 ? num / den : null;
  const state = score == null ? 'unavailable'
    : score >= MOOD_M_EUPHORIA     ? 'euphoria'
    : score >= MOOD_M_GREED        ? 'greed'
    : score >= MOOD_M_RISK_ON      ? 'risk-on'
    : score <= MOOD_M_CAPITULATION ? 'capitulation'
    : score <= MOOD_M_FEAR         ? 'fear'
    : score <= MOOD_M_RISK_OFF     ? 'risk-off'
    : 'mixed';

  return {
    state,
    score: score == null ? null : Math.round(score * 100) / 100,
    weightDenominator: den,
    breadth,
    breadthQualifier: moodBreadthQualifier(breadth, score),
    unavailableCause: null, missingIndexes: [], reason: null,
  };
}

/** The stance for a macro state, and the template sentence that renders when
 *  Claude is not used or is not usable. Every state resolves. */
function moodStanceFor(state, qualifier = null) {
  const st = MOOD_STANCE[state] || MOOD_STANCE.unavailable;
  const clause = (state === 'unavailable' || !qualifier) ? '' : (MOOD_BREADTH_CLAUSE[qualifier] || '');
  return { category: st.category, template: st.sentence + clause };
}

/**
 * Is a model-written sentence usable as a rewrite of a verdict already decided?
 *
 * The last check is the one that matters: the answer may not name a macro state
 * other than the decided one. That is what stops a rephrase from becoming a
 * reclassification, and it is why the model can only ever change the words. A
 * legitimate sentence that happens to use another state's word in passing is
 * rejected too — falling back to the template loses phrasing and nothing else,
 * which is the cheap side of that trade.
 */
function moodSentenceUsable(text, state) {
  if (typeof text !== 'string') return { ok: false, reason: 'no text returned' };
  const s = text.trim();
  if (s.length < MOOD_SENTENCE_MIN) return { ok: false, reason: `sentence is ${s.length} chars, under the ${MOOD_SENTENCE_MIN}-char floor` };
  if (s.length > MOOD_SENTENCE_MAX) return { ok: false, reason: `sentence is ${s.length} chars, over the ${MOOD_SENTENCE_MAX}-char ceiling` };
  if (/\n/.test(s)) return { ok: false, reason: 'answer spans multiple lines, so it is not one sentence' };
  const others = Object.keys(MOOD_STANCE).filter(k => k !== state && k !== 'unavailable');
  for (const other of others) {
    const re = new RegExp(`(^|[^a-z-])${other.replace('-', '[- ]')}([^a-z-]|$)`, 'i');
    if (re.test(s)) return { ok: false, reason: `names the state "${other}" while the decided state is "${state}"` };
  }
  return { ok: true, reason: null, sentence: s };
}

/** The prompt. It states the verdict is decided and that the answer is a
 *  rewrite — the schema then makes anything but a sentence ungenerable. */
function moodPrompt(macro, stance, reads) {
  const line = r => `${r.symbol} (${r.label}): ` + (r.status === 'ok'
    ? `${r.emotion}, score ${r.score}, ${r.patterns.length ? r.patterns.join(' + ') : 'no named pattern'}, `
      + `${r.changePct == null ? 'change unavailable' : (r.changePct >= 0 ? '+' : '') + r.changePct + '% on the session'}`
    : `no reading (${r.reason})`);

  return `You are writing ONE sentence for a market dashboard.

THE VERDICT IS ALREADY DECIDED by a rules-based candlestick engine. You may not change it, argue with it, hedge it, or add a different conclusion. Your only job is to say the same thing in one readable sentence a trader can absorb at a glance.

DECIDED MACRO EMOTION: ${macro.state}
DECIDED STANCE CATEGORY: ${stance.category}
THE STANCE, IN THE HOUSE TEMPLATE: ${stance.template}

SECTOR BREADTH: ${macro.breadth.bullish} bullish, ${macro.breadth.bearish} bearish, ${macro.breadth.neutral} neutral of ${macro.breadth.counted} sectors read${macro.breadth.absent ? ` (${macro.breadth.absent} could not be read)` : ''} — qualifier: ${macro.breadthQualifier || 'none'}
BLENDED SCORE: ${macro.score}

PER-SYMBOL READ (indexes first):
${reads.map(line).join('\n')}

Write one sentence that states the macro emotion "${macro.state}" and the stance above. The reader buys options on directional setups — long calls, long puts and debit verticals — so what matters is whether to press, wait, or stand aside. Do not name a different emotion. Do not invent a price level, a ticker recommendation or a date. Do not use markdown.`;
}

/**
 * 2:00pm PT — bank one market-mood record.
 *
 * COST, STATED STRUCTURALLY rather than read off `_instr`. This branch now
 * dispatches THREE jobs through `ctx.waitUntil`, and `instrSince()` subtracts
 * invocation-wide counters over a span of time, so a per-job figure from this
 * branch is an upper bound on the job and a lower bound on the invocation —
 * never a measurement of either (rule #1). The structure is:
 *
 *   extFetches  15 chart calls (one per symbol, no batched OHLC substitute)
 *               + 1 Anthropic call            = 16
 *   bindingOps  1 dedup get + 1 mood:state put + 1 dedup put = 3
 *   capCost     19
 *
 * Against a 10,000 per-invocation ceiling, and alongside the forward-return
 * fill (~45 charts) and the move sweep (~5), the branch stays around 0.7% of it.
 *
 * REFUSES BEFORE STAMPING when every fetch failed, the same contract
 * `recordWatchlistIv` / `collectMoveSeries` / `collectMacroState` follow. A
 * partial run DOES store — a readable sector board with an unavailable verdict
 * is a finding — but it does not stamp, so the next firing retries the gaps.
 */
async function collectMarketMood(env) {
  if (!env?.REC_LOG) return;
  const mark = instrMark();

  try {
    const last = await env.REC_LOG.get(MOOD_SWEEP_KEY);
    if (last === ptDate()) { console.log('[cron] market mood already collected today, skipping'); return; }
  } catch (_) {}

  const today = ptDate();
  const results = await allSettledCounted(
    MOOD_SYMBOLS.map(async (entry) => {
      const chart = await yahoo(`/v8/finance/chart/${encodeURIComponent(entry.symbol)}`,
                                `?range=${MOOD_RANGE}&interval=1d`);
      const raw = moodBars(chart);
      const { bars, droppedForming } = moodSettledBars(raw, today);
      return { entry, bars, droppedForming };
    }),
    'market-mood chart fan-out',
  );

  let fetched = 0, droppedAny = 0;
  const reads = results.map((res, i) => {
    const entry = MOOD_SYMBOLS[i];
    if (res.status !== 'fulfilled') {
      /* A failed fetch is stored as `unavailable` WITH ITS REASON, never as a
         neutral emotion. Honesty rule 11: "we have not looked" and "there is
         nothing there" are different facts, and on a mood board a neutral row
         reads as a calm market. */
      return {
        symbol: entry.symbol, label: entry.label, group: entry.group,
        status: 'unavailable', emotion: null, score: null, patterns: [],
        changePct: null, asOfClose: null,
        reason: `chart fetch failed — ${res.reason?.message || res.reason}`,
      };
    }
    fetched++;
    if (res.value.droppedForming) droppedAny++;
    return moodReadFor(entry, res.value.bars);
  });

  if (fetched === 0) {
    console.error(`[cron] !! MOOD-COLLECT !! all ${MOOD_SYMBOLS.length} chart fetches failed. REFUSING to `
      + `write rather than storing a board of unavailable rows; no dedup key stamped, so the next firing `
      + `retries · ${JSON.stringify(instrSince(mark, 'refused'))}`);
    return;
  }

  const macro  = moodMacroFrom(reads);
  const stance = moodStanceFor(macro.state, macro.breadthQualifier);

  /* ONE Claude call, and only when there is a verdict to phrase. An unavailable
     verdict has nothing to rewrite, so it takes the template and spends nothing. */
  let sentence = stance.template;
  let sentenceSource = 'template';
  let sentenceNote = macro.state === 'unavailable'
    ? 'the verdict is unavailable, so no rewrite was requested and no Anthropic call was made'
    : null;

  if (macro.state !== 'unavailable') {
    try {
      const { text, stopReason } = await workerClaude(
        moodPrompt(macro, stance, reads), env, MOOD_ANSWER_TOKENS, MOOD_SENTENCE_SCHEMA, { raw: true },
      );
      if (stopReason === 'max_tokens') {
        sentenceNote = 'the model hit the token cap mid-answer, so the template stands rather than a '
                     + 'sentence that stops mid-clause';
      } else {
        const parsed = JSON.parse(text);
        const verdict = moodSentenceUsable(parsed?.sentence, macro.state);
        if (verdict.ok) { sentence = verdict.sentence; sentenceSource = 'claude'; sentenceNote = null; }
        else sentenceNote = `model sentence rejected — ${verdict.reason}`;
      }
    } catch (e) {
      sentenceNote = `rewrite failed — ${e.message}`;
    }
    if (sentenceSource === 'template') {
      console.warn(`[cron] market mood: using the template sentence · ${sentenceNote}`);
    }
  }

  const asOfClose = reads.filter(r => r.asOfClose).map(r => r.asOfClose).sort().pop() || null;

  const record = {
    schema: MOOD_SCHEMA,
    ts: Date.now(),
    asOfClose,
    state: macro.state,
    stance: stance.category,
    sentence,
    sentenceSource,
    sentenceNote,
    template: stance.template,
    score: macro.score,
    breadth: macro.breadth,
    breadthQualifier: macro.breadthQualifier,
    unavailableCause: macro.unavailableCause,
    missingIndexes: macro.missingIndexes,
    reason: macro.reason,
    symbols: reads,
    coverage: { fetched, total: MOOD_SYMBOLS.length, droppedFormingBars: droppedAny },
    /* Thresholds ship with the payload for the same reason every other gate in
       this Worker does: neither frontend may hardcode a number the Worker owns. */
    gates: {
      emotion: {
        euphoria: MOOD_T_EUPHORIA, greed: MOOD_T_GREED, optimism: MOOD_T_OPTIMISM,
        caution: MOOD_T_CAUTION, fear: MOOD_T_FEAR, capitulation: MOOD_T_CAPITULATION,
      },
      macro: {
        euphoria: MOOD_M_EUPHORIA, greed: MOOD_M_GREED, riskOn: MOOD_M_RISK_ON,
        riskOff: MOOD_M_RISK_OFF, fear: MOOD_M_FEAR, capitulation: MOOD_M_CAPITULATION,
      },
      breadth: { strong: MOOD_BREADTH_STRONG, split: MOOD_BREADTH_SPLIT },
      weights: { index: MOOD_INDEX_WEIGHT, sector: MOOD_SECTOR_WEIGHT },
      patternScores: MOOD_PATTERN_SCORE,
    },
    usedForRanking: false,
    notUsedNote: 'A rules-based reading of candlestick shape. It has not been scored against forward '
               + 'returns, and it sorts, gates and filters nothing on this dashboard.',
    _instr: instrSince(mark, fetched === MOOD_SYMBOLS.length ? 'complete' : 'partial'),
  };

  try {
    await env.REC_LOG.put(MOOD_KEY, JSON.stringify(record), { expirationTtl: MOOD_TTL });
  } catch (e) {
    console.error(`[cron] !! MOOD-COLLECT !! KV write failed — ${e.message}. No dedup key stamped, `
      + 'so the next firing retries.');
    return;
  }

  /* STAMP ONLY A COMPLETE RUN. A partial board is worth storing and is NOT
     worth calling done: the write is idempotent (one key, rewritten whole), so
     a retry fills the gaps rather than duplicating work. The 2:00pm window
     admits two firings, so a persistently failing symbol costs one extra pass a
     day and no more. */
  if (fetched === MOOD_SYMBOLS.length) {
    try { await env.REC_LOG.put(MOOD_SWEEP_KEY, ptDate(), { expirationTtl: 172800 }); } catch (_) {}
    console.log(
      `[cron] market mood: ${macro.state}${macro.breadthQualifier ? ` (${macro.breadthQualifier})` : ''} · `
      + `stance ${stance.category} · score ${macro.score} · breadth ${macro.breadth.bullish}B/`
      + `${macro.breadth.bearish}S/${macro.breadth.neutral}N of ${macro.breadth.counted} · `
      + `asOf ${asOfClose} · sentence from ${sentenceSource} · ${JSON.stringify(instrSince(mark, 'complete'))}`,
    );
  } else {
    console.error(`[cron] !! MOOD-SWEEP-INCOMPLETE !! ${fetched}/${MOOD_SYMBOLS.length} symbols fetched `
      + `(state ${macro.state}). Payload STORED so the readable rows render, but NOT stamping `
      + `${MOOD_SWEEP_KEY}, so the next firing retries · ${JSON.stringify(instrSince(mark, 'partial'))}`);
  }
}

/** ONE KV read of `mood:state`. A schema mismatch reads as ABSENT so an old
 *  shape retires rather than rendering under field meanings it was not written
 *  for — the same strict equality `readMoveSeries` and `readMacroState` use. */
async function readMarketMood(env) {
  let rec = null;
  try { rec = await env?.REC_LOG?.get(MOOD_KEY, 'json'); } catch (_) { rec = null; }

  if (!rec || rec.schema !== MOOD_SCHEMA) {
    /* The same three missing-record situations `readMacroState` separates, and
       for the same reason: a cold start on a freshly deployed Worker and a
       sweep that has been refusing for days are different facts with different
       fixes, and one message for both is the collapsed state honesty rule 11
       exists to prevent. */
    let sweptOn = null;
    if (!rec) { try { sweptOn = await env?.REC_LOG?.get(MOOD_SWEEP_KEY); } catch (_) {} }
    const today = ptDate();
    const cause = rec ? 'schema'
                : !sweptOn ? 'never-collected'
                : sweptOn === today ? 'record-missing'
                : 'stale-sweep';
    const reason = {
      schema: `the stored record is schema ${rec?.schema}, not ${MOOD_SCHEMA} — it retires rather than `
            + 'rendering under field meanings it was not written for. The next 2:00pm PT firing rewrites it.',
      'never-collected': 'the mood collection has never completed, so there is nothing to show yet. This is '
            + 'the expected state of a newly deployed Worker until the first 2:00pm PT firing — it is NOT a '
            + 'data failure and says nothing about the market.',
      'record-missing': `the collection completed today (${today}) but the record is not in KV. That is a `
            + 'storage fault rather than an upstream one, and it clears on the next firing.',
      'stale-sweep': `the collection last completed on ${sweptOn} and has not completed since — it has been `
            + 'REFUSING, which means an upstream failure. Grep the Worker logs for "!! MOOD-COLLECT !!" and '
            + '"!! MOOD-SWEEP-INCOMPLETE !!". This one is worth acting on.',
    }[cause];

    const stance = moodStanceFor('unavailable');
    return {
      schema: MOOD_SCHEMA, state: 'unavailable', unavailableCause: cause,
      lastSweptOn: sweptOn || null,
      /* Shipped so the frontend tones this state from the Worker's own split
         rather than from a hardcoded copy of it. */
      faultCauses: MOOD_FAULT_CAUSES,
      isFault: MOOD_FAULT_CAUSES.includes(cause),
      stance: stance.category, sentence: stance.template, sentenceSource: 'template',
      sentenceNote: null, template: stance.template,
      score: null, breadth: null, breadthQualifier: null,
      missingIndexes: [], reason,
      symbols: [], coverage: null, asOfClose: null,
      ts: null, ageMs: null, stale: true, freshMs: MOOD_FRESH_MS,
      usedForRanking: false,
      notUsedNote: 'A rules-based reading of candlestick shape. It has not been scored against forward '
                 + 'returns, and it sorts, gates and filters nothing on this dashboard.',
    };
  }

  const ageMs = Number.isFinite(rec.ts) ? Date.now() - rec.ts : null;
  return { ...rec, ageMs, stale: ageMs == null ? true : ageMs >= MOOD_FRESH_MS, freshMs: MOOD_FRESH_MS };
}

/** GET /api/market/mood — ONE KV read, zero outbound fetches, no Claude call.
 *  Origin-gated like every other market read; deliberately NOT behind `aiGuard`,
 *  because nothing on this path can spend. */
async function handleMarketMood(origin, env) {
  const mark = instrMark();
  const rec  = await readMarketMood(env);
  const note = rec.state === 'unavailable'
    ? `no verdict — ${rec.unavailableCause}`
    : `${rec.coverage?.fetched ?? '?'}/${rec.coverage?.total ?? MOOD_SYMBOLS.length} symbols read · `
      + `sentence from ${rec.sentenceSource}`;
  return json({
    ...rec,
    _instr: instrSince(mark, 'mood'),
    _meta: srcMeta('Yahoo daily bars · candlestick rules', {
      // NOT `state !== 'unavailable'` — that reddened the badge on a cold start,
      // contradicting the neutral chip beside it. See MOOD_FAULT_CAUSES.
      ok: moodMetaOk(rec),
      delayed: true,
      ttlSeconds: TTL.mood,
      asOf: rec.asOfClose,
      note,
    }),
  }, 200, origin);
}

/* ═══════════════════════════════════════════════════════════════════════════
   MACRO REGIME — phase 1, DISPLAY ONLY

   PHASE 1 DOES NOT AFFECT RANKING, GATING, OR ANY EXISTING FIGURE. That is a
   deliberate constraint, not an unfinished edge.

   The `analysis:` rating was wired into sort order before anyone measured
   whether it had edge. When it was finally measured against a base rate it came
   back NEGATIVE — pooled sign-scored BUY 50.5% against a 60.5% base rate,
   -10.1 pts — and the sort influence had to be disabled after the fact
   (`directionalRead()` still carries `sortDisabled`). Macro state is the same
   shape of thing: a plausible signal that feels like it should matter. So it
   ships as a DISPLAYED CONDITION with no measured relationship to outcomes, and
   the card says so in visible text. Sort influence, if it is ever justified,
   comes out of phase 2's regime-conditioned coverage measurement and nowhere
   else. Do not add a demotion, a tie-break or a threshold adjustment here.

   ── THE SIGN CONVENTION IS A SUBTRACTION, NOT A RATIO ────────────────────────
   `vixTermSpread = vix - vix3m`. POSITIVE IS BACKWARDATION AND POSITIVE IS
   HOSTILE.

   This is not a stylistic choice. `longRow` already stores
   `termStructure = front - back` with positive meaning backwardation, and Lane E
   gates `hostile-term` on `termStructure > 0`. A macro field where *below 1.0*
   meant backwardation would put two opposite polarities for the same concept on
   one screen — the "inverted thing that looks like a copy" hazard the Long tab
   section is built around. `vixTermRatio` (vix3m / vix) ships as a display field
   and MUST NEVER be the classifier.
   ══════════════════════════════════════════════════════════════════════════ */

/* ── TWO KEYS, NOT ONE, AND THE SPLIT IS A REQUEST-PATH COST DECISION ────────
   The classified state is ~640 bytes; the 756-session phase-2 slice is ~27 KB.
   A single key would make every `/api/long/*` request read 27 KB out of KV to
   render a 640-byte chip. Stripping the slice on read does NOT avoid that — the
   transfer and the JSON.parse have already happened; it only hides them.

   So: `macro:state` is read on the request path and `macro:series` is read by
   NOTHING in phase 1. Both are written by the same 1:15pm collection, both carry
   `MACRO_SCHEMA`, and they are bumped together — a state record whose series is
   from an older shape is exactly the mismatch strict-equality schema checks
   exist to prevent. */
const MACRO_KEY        = 'macro:state';
const MACRO_SERIES_KEY = 'macro:series';
const MACRO_SWEEP_KEY  = 'macrosweep:last';  // OUTSIDE the `macro:` prefix, so nothing
                                             // scanning that prefix reads it as a record
const MACRO_SCHEMA     = 1;
const MACRO_TTL       = 90 * 24 * 3600;      // 90d retention — see the freshness split below
/* FRESHNESS AND RETENTION DIFFER ON PURPOSE, the same split as `long:` /
   `premium:` / `econ:dgs3mo`. The record is written once a trading day by the
   1:15pm PT branch, so 26h covers a normal weekday cadence plus slack; past that
   the chip badges stale rather than disappearing. Retention is 90 days because a
   labelled old macro read beats a blank one — `econ:dgs3mo` moved 7d -> 90d for
   exactly this reason, and §4's age treatment means an old record is labelled
   rather than misleading. Note a weekend or holiday legitimately ages the record
   past 26h; the chip states the age, which is the honest answer. */
const MACRO_FRESH_MS  = 26 * 3600_000;

/* Field name -> Yahoo symbol. Field names are what the record and the payload
   use; the carets never leak past this table. */
const MACRO_SYMBOLS = { spy: 'SPY', qqq: 'QQQ', vix: '^VIX', vix3m: '^VIX3M' };

/* VERIFIED AGAINST THE LIVE API 2026-08-11, because nothing in this codebase had
   ever fetched a caret symbol through spark — the only other `^VIX` fetch is
   `handleMarketSnapshot`, which uses /v8/finance/chart. Measured, per symbol,
   sessions returned at each range:
     range=1y   ^VIX 253   ^VIX3M 234
     range=3y   ^VIX 753   ^VIX3M 734   SPY 751   QQQ 751
     range=10y  ^VIX 2514  ^VIX3M 2492  SPY 2512  QQQ 2512
     range=max  ^VIX3M 1      <- a Yahoo quirk; do NOT use 'max' here
   So spark serves carets, ^VIX3M specifically resolves, and 10y is honoured.
   The counts DISAGREE, which is why alignMacroSeries() keys on date. */
const MACRO_RANGE       = '10y';   // derivation range — spans 2020 and 2022
const MACRO_SLICE_DAYS  = 756;     // ~3y of sessions, aligned with MOVES_RANGE, stored for phase 2
const MACRO_TREND_FAST  = 50;
const MACRO_TREND_SLOW  = 200;

/* ── THE CLASSIFIER SEES THE SMOOTHED TERM SPREAD, NOT THE RAW ONE ───────────
   A trailing 5-session mean. Measured over the same 2,293 sessions, at the
   shipped thresholds:

     input       hostile   hostile run median/p90   transitions   flip rate
     raw           22.5%             2 /  9              229        10.0%
     smoothed5     21.7%             7 / 55               98         4.3%

   A two-session median run is not a regime, it is noise wearing a regime label,
   and a chip that changes every other day trains the reader to ignore it.
   Smoothing costs 0.8pp of frequency and buys a 3.5x longer median run and 57%
   fewer transitions. The distribution itself barely moves (median -2.13 vs
   -2.15, above-zero 7.2% vs 8.0%), so this is de-noising rather than
   re-definition.

   THE COST OF SMOOTHING IS LAG, AND IT WAS MEASURED BEFORE THE CONSTANT WAS SET
   rather than assumed away. A 5-session mean drops 34 of 55 raw backwardation
   episodes (55 runs of median 1 -> 21 of median 5); some of those were noise and
   some could have been the first days of a real spike. First session classified
   hostile, raw vs smoothed, on six stress episodes:

     probe         raw onset     smoothed onset   lag   fired via
     2020-03-16    2020-02-24    2020-02-25        1    term
     2020-03-23    2020-02-24    2020-02-25        1    term
     2018-12-24    2018-12-06    2018-12-07        1    term
     2025-04-07    2025-04-02    2025-04-03        1    term
     2022-06-16    2022-03-14    2022-03-14        0    trend
     2022-10-12    2022-03-14    2022-03-14        0    trend
                                        MEDIAN LAG  1   (mean 0.67, max 1)

   One session, never more. The pre-registered stop condition was a median above
   3. 2022-10-12 is the instructive one: its raw term clause fired for a single
   day (2022-10-11) and the smoothed one never crossed — a noise episode
   correctly suppressed, with the composite state hostile anyway via trend.

   `vixTermSpread` (raw) is stored and rendered beside it. DO NOT CLASSIFY ON THE
   RAW FIELD: it has the more obvious name and is not the input. `gates
   .classifierInput` names the deciding field in the payload for that reason. */
const MACRO_SMOOTH_SESSIONS = 5;

/* ── T_BACK / T_CONTANGO — derived from the distribution, 2026-08-11 ─────────
   Population: 2,293 classifiable sessions, 2017-05-31 .. 2026-08-11, from a 10y
   spark pull aligned to 2,492 sessions (199 lost to the SMA200 warm-up).

   vixTermSpread = VIX - VIX3M, raw:
     min -6.66  p10 -3.67  p25 -2.88  median -2.15  p75 -1.25  p90 -0.30
     p95 +0.59  max +18.23  mean -1.93   ·   above zero 8.0% (183 sessions)

   T_BACK = 0 — the sign convention's own zero, needing no justification beyond
   the definition of backwardation. The choice barely matters: hostile runs
   22.5% at 0, 20.5% at +0.5, 19.4% at +1.0, 18.4% at +2.0, because backwardation
   is rare and when it happens it is large. REJECTED: +0.5 or +1.0 as a "noise
   band". They buy 2-3pp of frequency at the cost of a constant that has to be
   explained, and the noise they were meant to absorb is what the smoothing above
   actually removes.

   T_CONTANGO = -1.0, derived on the SMOOTHED series because that is what gets
   classified. Sweep at T_BACK = 0:

     input       T_CONT   constructive   mixed   hostile   transitions
     smoothed5    -0.5        71.9%       6.4%    21.7%         86
     smoothed5    -1.0        66.1%      12.3%    21.7%         98
     smoothed5    -2.0        48.1%      30.3%    21.7%        134

   -1.0 sits between p75 (-1.25) and p90 (-0.30) and keeps constructive clearly
   dominant, which is the correct shape: contango is the normal condition of the
   VIX term structure. REJECTED: -2.0, which sits essentially ON the median
   (-2.15) and would make constructive a coin flip on the term input alone;
   and -0.5, which crushes `mixed` to 6.4% — a band that narrow is a rounding
   artifact rather than a state.

   ANTI-TUNING RECORD. Today's values were printed and reported BEFORE these
   constants were chosen: 2026-08-11, SPY +6.88%, QQQ +12.18%, VIX 15.28,
   VIX3M 18.91, raw term -3.63, smoothed5 -2.84 -> constructive under every
   candidate pair tested. Neither threshold changes that.

   CLAUSE ATTRIBUTION, and it does not match the design's premise. Of the 21.7%
   hostile under the shipping configuration: 'trend' 14.5% of all sessions
   (66.8% of hostile), 'term' 5.8% (26.8%), 'both' 1.4% (6.4%). The index-trend
   clause does roughly 2.5x the work of the backwardation clause the spec called
   load-bearing. That is why `hostileVia` exists and is rendered — 2022-06-16
   classified HOSTILE at VIX 33.0 with the term spread at -0.54, i.e. while in
   CONTANGO, and a bare "hostile" would have misdescribed it. Phase 2 should
   condition on the clause, not only on the state. */
const T_BACK     = 0;
const T_CONTANGO = -1.0;

const MACRO_GATES = {
  backSpread:     T_BACK,       // classifier input ABOVE this reads hostile
  contangoSpread: T_CONTANGO,   // classifier input BELOW this reads constructive
  trendFast:      MACRO_TREND_FAST,
  trendSlow:      MACRO_TREND_SLOW,
  smoothSessions: MACRO_SMOOTH_SESSIONS,
  /* Both travel IN THE PAYLOAD, not only in this comment, so no frontend can
     re-derive the sign the other way round or classify on the wrong field. */
  sign: 'vixTermSpread = VIX − VIX3M · POSITIVE = backwardation = hostile',
  classifierInput: 'vixTermSpreadSmoothed',
};

/**
 * Align the four macro series ON DATE, never on index.
 *
 * MEASURED 2026-08-11 at range=10y: ^VIX returned 2514 sessions, SPY and QQQ
 * 2512 each, ^VIX3M 2492. Zipping those by index would pair a VIX close with a
 * VIX3M close up to 22 sessions away and yield a term spread that is
 * arithmetically fine and describes nothing — the silent-wrong-answer shape this
 * codebase keeps getting caught by. So each series is keyed by its own session
 * date and only dates present in ALL FOUR survive.
 */
function alignMacroSeries(series) {
  const byDate = {}, counts = {}, lastPerSymbol = {};
  for (const [field, sym] of Object.entries(MACRO_SYMBOLS)) {
    const s = series?.get?.(sym);
    if (!s?.closes?.length || !Array.isArray(s.timestamps) || s.timestamps.length !== s.closes.length) {
      return { ok: false, symbol: sym,
               reason: `${sym} returned no usable dated series — spark drops unknown symbols silently, `
                     + `and a close array with no matching timestamps cannot be aligned` };
    }
    const m = new Map();
    for (let i = 0; i < s.closes.length; i++) {
      const v = s.closes[i];
      if (!Number.isFinite(v)) continue;
      m.set(new Date(s.timestamps[i] * 1000).toISOString().slice(0, 10), v);
    }
    if (!m.size) return { ok: false, symbol: sym, reason: `${sym} returned no finite closes` };
    byDate[field] = m;
    counts[sym] = m.size;
    lastPerSymbol[sym] = [...m.keys()].sort().pop();
  }

  const fields = Object.keys(MACRO_SYMBOLS);
  const dates = [...byDate[fields[0]].keys()]
    .filter(d => fields.every(f => byDate[f].has(d)))
    .sort();
  if (!dates.length) return { ok: false, symbol: null, reason: 'the four series share no session date' };

  const out = { ok: true, dates, counts, lastPerSymbol, aligned: dates.length };
  for (const f of fields) out[f] = dates.map(d => byDate[f].get(d));

  /* A LAGGING INPUT IS THE ONE THING DATE-INTERSECTION CAN HIDE. If ^VIX3M has
     not published today's value while SPY has, the intersection silently steps
     back a session and the state describes an older market than the freshest
     data available. That is what `provisional` is for; it is a rare, observable
     condition rather than a permanently-true flag. */
  const newest = Object.values(lastPerSymbol).sort().pop();
  const lagging = Object.entries(lastPerSymbol).filter(([, d]) => d !== newest).map(([s]) => s);
  out.lagged = dates[dates.length - 1] !== newest;
  out.laggingSymbols = lagging;
  return out;
}

/** Per-session fast/slow SMA spread, in % of the slow MA. Same quantity and same
 *  2dp rounding as `crossStateFrom`'s `spread`, so the last element of this
 *  series equals `smaCrossState(closes).spread` — asserted in macro.check.mjs. */
function maSpreadSeries(closes, fast = MACRO_TREND_FAST, slow = MACRO_TREND_SLOW) {
  const sf = smaSeries(closes, fast), ss = smaSeries(closes, slow);
  if (!sf || !ss) return null;
  return closes.map((_, i) =>
    (sf[i] == null || ss[i] == null || !ss[i]) ? null
      : Math.round((sf[i] - ss[i]) / ss[i] * 100 * 100) / 100);
}

/**
 * Classify one session's four inputs. Mirrors `volRegime()`'s shape deliberately
 * — it is the established regime read here, and a second differently-shaped one
 * would be a drift hazard.
 *
 *   hostile       vixTermSpread > T_BACK, OR both SPY and QQQ spread < 0
 *   constructive  vixTermSpread < T_CONTANGO AND both SPY and QQQ spread > 0
 *   mixed         everything else
 *
 * ANY NULL INPUT -> 'unavailable', naming which. A partial state computed from
 * three of four inputs is indistinguishable on screen from a full one, which is
 * honesty rule 3 applied to a composite. The four are NOT blended into a numeric
 * score: three states plus the raw numbers keeps every input visible and the
 * classification auditable.
 *
 * `vixLevel` is carried and displayed but does NOT enter the classification —
 * an absolute fear level is not comparable across regimes. It still counts as a
 * required input, because a null VIX means the term spread is null too.
 */
function macroClassify(inputs, gates = MACRO_GATES) {
  const { spySpread, qqqSpread, vixLevel, vixTermSpread } = inputs || {};
  const missing = [];
  if (!Number.isFinite(spySpread))     missing.push(`SPY ${gates.trendFast}/${gates.trendSlow} SMA spread`);
  if (!Number.isFinite(qqqSpread))     missing.push(`QQQ ${gates.trendFast}/${gates.trendSlow} SMA spread`);
  if (!Number.isFinite(vixLevel))      missing.push('VIX level');
  if (!Number.isFinite(vixTermSpread)) missing.push('VIX term spread (^VIX − ^VIX3M)');

  if (missing.length) {
    const trendMissing = missing.some(m => m.includes('SMA'));
    return {
      state: 'unavailable',
      hostileVia: null,
      label: `Macro state unavailable — ${missing.join(', ')} missing`,
      provisional: false,
      reason: `${missing.join(', ')} unavailable, so no state is computed. A macro read assembled from `
            + `${4 - missing.length} of 4 inputs is indistinguishable on screen from a complete one.`
            + (trendMissing
                ? ` A trend spread is null below ${gates.trendSlow + EMA_CROSS_SLOPE_BARS} sessions of `
                  + `closes, which is smaCrossState()'s floor.`
                : ''),
    };
  }

  const backwardated = vixTermSpread > gates.backSpread;
  const bothDown     = spySpread < 0 && qqqSpread < 0;
  const bothUp       = spySpread > 0 && qqqSpread > 0;
  const state = (backwardated || bothDown) ? 'hostile'
              : (vixTermSpread < gates.contangoSpread && bothUp) ? 'constructive'
              : 'mixed';

  /* WHICH CLAUSE FIRED, because "hostile" on its own misdescribes the common
     case. Measured over 2,293 sessions: 66.8% of hostile sessions came from the
     trend clause alone, 26.8% from backwardation alone, 6.4% from both. So the
     chip is currently more a trend read than a vol read, and a reader must not
     have to guess which. 2022-06-16 is the case that proves it: VIX 33.0 with
     the term spread at -0.54 — hostile while in CONTANGO. Same principle as
     Lane E naming its failed gate instead of blanking. `null` on every
     non-hostile state; never an empty string. */
  const hostileVia = state !== 'hostile' ? null
                   : (backwardated && bothDown) ? 'both'
                   : backwardated ? 'term' : 'trend';

  const sgn = v => (v > 0 ? '+' : '') + v.toFixed(2);
  const because = state === 'hostile'
    ? [backwardated ? `term ${sgn(vixTermSpread)} above ${sgn(gates.backSpread)} (backwardation)` : null,
       bothDown ? 'SPY and QQQ both below their 200D' : null].filter(Boolean).join(' and ')
    : state === 'constructive'
      ? `term ${sgn(vixTermSpread)} below ${sgn(gates.contangoSpread)} (contango) and both indices above their 200D`
      : `term ${sgn(vixTermSpread)} between ${sgn(gates.contangoSpread)} and ${sgn(gates.backSpread)}`
        + (bothUp ? '' : bothDown ? '' : ', indices split');

  return {
    state,
    hostileVia,
    label: `Macro ${state}${hostileVia ? ` (${hostileVia})` : ''} — ${because} · SPY ${sgn(spySpread)}% `
         + `QQQ ${sgn(qqqSpread)}% vs ${gates.trendSlow}D · VIX ${vixLevel.toFixed(2)} · term ${sgn(vixTermSpread)}`,
    provisional: false,
    reason: null,
  };
}

/** Trailing mean over the last `n` values, per position. Leading positions
 *  average what exists rather than returning null — a partial mean at index 0 is
 *  the raw value, which is the honest answer and not a stand-in for anything. */
function trailingMean(arr, n) {
  return arr.map((_, i) => {
    const w = arr.slice(Math.max(0, i - (n - 1)), i + 1).filter(Number.isFinite);
    return w.length ? Math.round(w.reduce((a, b) => a + b, 0) / w.length * 100) / 100 : null;
  });
}

/**
 * Build BOTH records from an aligned pull: `{ head, series }`, stored under
 * `macro:state` and `macro:series` respectively. Split out from the collector so
 * the check script can drive it with fixtures and so the Part A derivation could
 * classify every historical session with the SAME code the live read uses.
 */
function buildMacroRecord(al, { asOfTs = Date.now(), gates = MACRO_GATES } = {}) {
  const spySpreads = maSpreadSeries(al.spy);
  const qqqSpreads = maSpreadSeries(al.qqq);
  const n = al.dates.length;
  const last = n - 1;

  const termRaw = al.vix.map((v, i) => {
    const b = al.vix3m[i];
    return (Number.isFinite(v) && Number.isFinite(b)) ? Math.round((v - b) * 100) / 100 : null;
  });
  /* Smoothed over the FULL pull before slicing, so the slice's first sessions
     carry a complete trailing window rather than a shorter partial one. */
  const termSmooth = trailingMean(termRaw, gates.smoothSessions ?? MACRO_SMOOTH_SESSIONS);

  /* The LIVE trend values come from `smaCrossState`, which is the function §1
     names and which carries the <205-bar null guard. `maSpreadSeries` supplies
     the history. They compute the same quantity with the same rounding; the
     check script asserts they agree at the last index rather than trusting it. */
  const spyState = smaCrossState(al.spy, gates.trendFast, gates.trendSlow);
  const qqqState = smaCrossState(al.qqq, gates.trendFast, gates.trendSlow);

  const spySpread = spyState?.spread ?? null;
  const qqqSpread = qqqState?.spread ?? null;
  const vixLevel  = Number.isFinite(al.vix[last]) ? Math.round(al.vix[last] * 100) / 100 : null;

  /* THE CLASSIFIER IS HANDED THE SMOOTHED SPREAD. `vixTermSpread` (raw) is
     stored and rendered beside it but decides nothing — see the constants block.
     Passing the raw one here would silently restore a 2-session median run. */
  const cls = macroClassify({ spySpread, qqqSpread, vixLevel, vixTermSpread: termSmooth[last] }, gates);

  const vix3mLast = al.vix3m[last];
  const vixTermRatio = (Number.isFinite(vixLevel) && Number.isFinite(vix3mLast) && vixLevel)
    ? Math.round(vix3mLast / vixLevel * 1000) / 1000
    : null;

  const laggedReason = al.lagged
    ? `One input lagged: ${al.laggingSymbols.join(', ')} had no close on `
      + `${Object.values(al.lastPerSymbol).sort().pop()}, so the state describes ${al.dates[last]} — `
      + `the newest session all four share.`
    : null;

  const head = {
    schema: MACRO_SCHEMA,
    state: cls.state,
    hostileVia: cls.hostileVia,
    label: cls.label,
    provisional: cls.provisional || !!al.lagged,
    reason: [cls.reason, laggedReason].filter(Boolean).join(' ') || null,
    asOfClose: al.dates[last],
    spySpread, qqqSpread, vixLevel,
    vixTermSpread: termRaw[last],              // RAW — displayed, never classified on
    vixTermSpreadSmoothed: termSmooth[last],   // the value the classifier saw
    vixTermRatio,                              // display only, never the classifier
    gates,
    ts: asOfTs,
    sessions: { ...al.counts, aligned: al.aligned },
    range: MACRO_RANGE,
  };

  /* THE STORED SLICE IS THE DERIVED PER-SESSION STATE, NOT RAW CLOSES.
     Phase 2 needs the regime each historical window started in, and the trend
     spreads must be computed over the FULL 10y pull so the SMA200 is valid from
     the slice's first session. Storing closes instead would force phase 2 to
     redo that with a shorter runway and quietly different numbers.
     Read by NOTHING in phase 1 — that is the point of the separate key. */
  const from = Math.max(0, n - MACRO_SLICE_DAYS);
  const series = {
    schema: MACRO_SCHEMA,
    note: 'derived per-session inputs, computed over the full pull then sliced — phase 2 reads these. '
        + 'Nothing on the request path reads this key.',
    ts: asOfTs,
    asOfClose: al.dates[last],
    gates,
    dates:                 al.dates.slice(from),
    spySpread:             (spySpreads || []).slice(from),
    qqqSpread:             (qqqSpreads || []).slice(from),
    vixLevel:              al.vix.slice(from).map(v => Math.round(v * 100) / 100),
    vixTermSpread:         termRaw.slice(from),
    vixTermSpreadSmoothed: termSmooth.slice(from),
  };
  head.sessions.stored = series.dates.length;

  return { head, series };
}

/** ONE KV read of the ~640-byte `macro:state` key. `macro:series` is NOT read
 *  here and must not be — see the two-key note above.
 *  A schema mismatch reads as ABSENT so an old shape retires rather than
 *  rendering as blanks: the same strict equality `readMoveSeries` uses, for the
 *  same reason. */
async function readMacroState(env) {
  let rec = null;
  try { rec = await env?.REC_LOG?.get(MACRO_KEY, 'json'); } catch (_) { rec = null; }
  if (!rec || rec.schema !== MACRO_SCHEMA) {
    /* "We have not looked yet" is not "there is nothing there" (honesty rule 11)
       — and THREE situations produce a missing record, which must not collapse
       into one sentence on the card:

         never-collected  the sweep has never completed. This is the state of a
                          freshly deployed Worker until the first 1:15pm PT
                          firing, and it is EXPECTED, not a fault.
         stale-sweep      the sweep last completed on some earlier date and has
                          not completed since — i.e. it has been REFUSING. That
                          is an upstream failure and it is the one worth acting on.
         record-missing   the sweep completed today but the record is gone
                          (expired, or deleted out from under us).

       A cold-start blank reading identically to a data failure is the collapsed
       state the premium screen shipped for three months (honesty rule 11), so
       `macrosweep:last` is consulted to separate them. THE EXTRA READ HAPPENS
       ONLY ON THIS PATH — the happy path stays at exactly one binding op, and
       this branch has no data to render anyway. */
    let sweptOn = null;
    if (!rec) { try { sweptOn = await env?.REC_LOG?.get(MACRO_SWEEP_KEY); } catch (_) {} }
    const today = ptDate();
    const cause = rec ? 'schema'
                : !sweptOn ? 'never-collected'
                : sweptOn === today ? 'record-missing'
                : 'stale-sweep';
    const reason = {
      schema: `the stored record is schema ${rec?.schema}, not ${MACRO_SCHEMA} — it retires rather than `
            + 'rendering under field meanings it was not written for. The next 1:15pm PT firing rewrites it.',
      'never-collected': 'the macro collection has never completed, so there is nothing to show yet. This is '
            + 'the expected state of a newly deployed Worker until the first 1:15pm PT firing — it is NOT a '
            + 'data failure and says nothing about the market.',
      'record-missing': `the collection completed today (${today}) but the record is not in KV. That is a `
            + 'storage fault rather than an upstream one; the next firing will dedup out, so it clears tomorrow.',
      'stale-sweep': `the collection last completed on ${sweptOn} and has not completed since — it has been `
            + 'REFUSING, which means an upstream failure (Yahoo spark, or a symbol missing from the response). '
            + 'Grep the Worker logs for "!! MACRO-COLLECT !!". This one is worth acting on.',
    }[cause];

    return {
      schema: MACRO_SCHEMA, state: 'unavailable', hostileVia: null,
      unavailableCause: cause,
      lastSweptOn: sweptOn || null,
      label: `Macro state unavailable — ${cause}`,
      provisional: false,
      reason,
      asOfClose: null, spySpread: null, qqqSpread: null, vixLevel: null,
      vixTermSpread: null, vixTermSpreadSmoothed: null, vixTermRatio: null,
      gates: MACRO_GATES, ts: null,
      ageMs: null, stale: true, freshMs: MACRO_FRESH_MS,
      usedForRanking: false,
      notUsedNote: 'Shown for context. Macro state does not sort, gate or filter anything on this screen — '
                 + 'it has not been measured against outcomes.',
    };
  }
  const ageMs = Number.isFinite(rec.ts) ? Date.now() - rec.ts : null;
  return {
    ...rec,
    ageMs,
    stale: ageMs == null ? true : ageMs >= MACRO_FRESH_MS,
    freshMs: MACRO_FRESH_MS,
    /* PHASE 1 IS DISPLAY ONLY, and the payload says so rather than leaving it to
       the frontend's copy. Removing this sentence is a phase 2 decision. */
    usedForRanking: false,
    notUsedNote: 'Shown for context. Macro state does not sort, gate or filter anything on this screen — '
               + 'it has not been measured against outcomes.',
  };
}

/**
 * 1:15pm PT — bank one macro record.
 *
 * A SEPARATE SPARK CALL, deliberately not appended to `sweepUniverse()`'s array.
 * Three reasons and the third would have been silent: that array also drives the
 * per-ticker write loop (so merged symbols would write `moves:^VIX` keys); it
 * puts non-watchlist symbols inside the empty-universe refusal logic that was
 * built to have exactly one source; and `collectMoveSeries` returns early when
 * `movesweep:last === ptDate()`, so a macro collection nested inside it would
 * silently not run whenever the move sweep had already run — rule #7's signature
 * exactly. The merge would have been free on chunk arithmetic (spark chunks at
 * 20, so 33 and 37 are both 2 chunks — the boundary is 40, not 20). Taken
 * separately anyway: 1 external fetch/day for total isolation and an independent
 * range.
 *
 * REFUSES BEFORE STAMPING `macrosweep:last`, the same contract `recordWatchlistIv`
 * and `collectMoveSeries` follow, so the next firing retries. It also never
 * overwrites a good record with an unavailable one: a partial pull is an upstream
 * failure to retry, not a finding to publish.
 */
async function collectMacroState(env) {
  if (!env?.REC_LOG) return;
  const mark = instrMark();

  try {
    const last = await env.REC_LOG.get(MACRO_SWEEP_KEY);
    if (last === ptDate()) { console.log('[cron] macro state already collected today, skipping'); return; }
  } catch (_) {}

  const symbols = Object.values(MACRO_SYMBOLS);
  let series;
  try {
    series = await yahooSparkCloses(symbols, MACRO_RANGE, 4, { withTimestamps: true });
  } catch (e) {
    console.error(`[cron] !! MACRO-COLLECT !! spark failed for ${symbols.join(',')} — ${e.message}. `
      + 'REFUSING to write; no dedup key stamped, so the next firing retries.');
    return;
  }

  const al = alignMacroSeries(series);
  if (!al.ok) {
    console.error(`[cron] !! MACRO-COLLECT !! ${al.reason}. REFUSING to write rather than storing a partial `
      + 'state — an existing record is left alone and no dedup key is stamped, so the next firing retries.');
    return;
  }

  const { head, series: slice } = buildMacroRecord(al);
  if (head.state === 'unavailable') {
    console.error(`[cron] !! MACRO-COLLECT !! ${head.reason} REFUSING to overwrite the stored record with an `
      + 'unavailable one; no dedup key stamped.');
    return;
  }

  /* SERIES FIRST, STATE SECOND, DEDUP LAST. Phase 1 reads only the state key, so
     writing the series first means a half-written pair never leaves the request
     path pointing at a state whose series is older. Either write failing skips
     the dedup stamp, so the next firing rewrites both — the whole thing is
     idempotent. */
  const seriesBody = JSON.stringify(slice);
  const headBody   = JSON.stringify(head);
  try {
    await env.REC_LOG.put(MACRO_SERIES_KEY, seriesBody, { expirationTtl: MACRO_TTL });
    await env.REC_LOG.put(MACRO_KEY, headBody, { expirationTtl: MACRO_TTL });
  } catch (e) {
    console.error(`[cron] !! MACRO-COLLECT !! KV write failed — ${e.message}. No dedup key stamped, `
      + 'so the next firing retries.');
    return;
  }
  try { await env.REC_LOG.put(MACRO_SWEEP_KEY, ptDate(), { expirationTtl: 172800 }); } catch (_) {}

  console.log(
    `[cron] macro state: ${head.state}${head.hostileVia ? ` (via ${head.hostileVia})` : ''} · `
    + `asOf ${head.asOfClose} · SPY ${head.spySpread} QQQ ${head.qqqSpread} VIX ${head.vixLevel} · `
    + `term raw ${head.vixTermSpread} / smoothed${MACRO_SMOOTH_SESSIONS} ${head.vixTermSpreadSmoothed} `
    + `(VIX−VIX3M, positive=backwardation=hostile; the SMOOTHED one classifies) · `
    + `sessions ${JSON.stringify(head.sessions)} · macro:state ${headBody.length}B `
    + `macro:series ${seriesBody.length}B · ${JSON.stringify(instrSince(mark, 'complete'))}`,
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

/* ═══════════════════════════════════════════════════════════════════════════
   RADAR — off-watchlist discovery.  GET /api/radar

   Answers exactly one question: which QUALITY names that are NOT on the saved
   watchlist deserve attention today. At most RADAR_MAX (5), never padded — a
   thin day returns two, or zero, and says so.

   NO CLAUDE CALL ANYWHERE ON THIS PATH. Every `why` string is assembled from
   the numbers that qualified the name, so it is a restatement of the gates
   rather than generated prose. Origin-gated like the other market reads and
   deliberately NOT behind `aiGuard`: nothing here spends, and the only write is
   its own day cache.

   TWO SOURCES, and a failing one is NAMED rather than silently narrowing
   discovery. `sources: [{name, ok, reason, rows}]` carries one entry each, and
   `complete` is true only when every source reported ok. A thin day and a
   broken source must not look the same.

     a. Yahoo predefined screeners (`day_gainers`, `most_actives`). These carry
        `marketCap`, `regularMarketPrice`, `regularMarketVolume` and
        `averageDailyVolume3Month` on every row, so the whole gate set runs on
        the screener payload with ZERO extra fetches.
     b. The sector `opportunity` picks already banked in `market:sectors`. Those
        are routinely off-watchlist quality names (CAT, LLY, COST). The banked
        record carries only the ETF's price, not the pick's, so the picks take
        ONE batched `/v7/finance/quote` call between them — not one per name.

   S&P 500 GOLDEN-CROSS SWEEP IS DELIBERATELY OUT OF v1. There is no verified
   constituent source wired into this Worker, and a hand-typed 500-name list is
   exactly the unverifiable constant that produced 7 wrong super-investor CIKs
   (honesty rule 18). v2 needs a constituent list fetched from a source whose
   identifiers can be checked — then the sweep itself is cheap, because
   `yahooSparkCloses` takes 20 symbols per request and `smaCrossState` already
   exists (~25 external fetches for 500 names).

   COST, per rule #1, quoted as capCost = extFetches + bindingOps. MEASURED on a
   `wrangler dev --remote` run against production KV, 2026-08-19:

     warm (any request after the first of the PT day)   1  (one KV get)
     cold, warm crumb                                  13  (8 ext + 5 bindings)
     cold, cold crumb                                  16  (10 ext + 6 bindings)

       1  KV get radar:{PT-date}            (miss)
       1  KV get watchlist:tickers          (the exclusion set)
       2  screener fetches                  (RADAR_SCREENERS.length)
       1  KV get market:sectors
       0-4 Yahoo crumb                      (warm: 0. Cold: 2 fetches + 1 KV get
                                             + 1 KV put, inside getYahooCrumb)
       1  batched /v7/finance/quote         (all sector picks in one call)
       ≤5 option-chain fetches              (RADAR_MAX — the ONLY per-name fetch,
                                             and it runs on the final ≤5 only,
                                             never on the whole screener result)
       1  KV put radar:{PT-date}

   A refusal costs 2 (radar get + watchlist get) and writes nothing.
   ══════════════════════════════════════════════════════════════════════════ */

const RADAR_SCHEMA = 1;

/* THE GATES. Every candidate from every source clears all of these. */
const RADAR_MIN_MARKET_CAP = 10_000_000_000;  // > $10B — "quality" as size
const RADAR_MIN_PRICE      = 20;              // > $20  — keeps low-priced churn out
/* Average daily DOLLAR volume floor, computed as
   `regularMarketPrice × averageDailyVolume3Month`. Its job is to drop a large
   cap that barely trades — where the option chain is a fiction even when it is
   listed. At the $20 price floor, $50M/day is 2.5M shares.

   IT IS A BACKSTOP ON THIS UNIVERSE, NOT A BINDING GATE, and that is measured
   rather than assumed. Over the 111 rows considered on 2026-08-19 it eliminated
   ZERO: of the 53 that had already cleared price + market-cap, the minimum
   average dollar volume was $76M (p10 $245M, median $1.2B, max $46.1B). That is
   structural — `most_actives` selects for volume by definition and `day_gainers`
   requires a move — so the earlier gates catch the thin names first. 11 rows in
   the same raw screener output DID sit below $50M (DRD $9M, ALMR $11M, OGC $13M,
   AAUC/AYA $17M, KC $19M …), all eliminated by price or market-cap ahead of it.

   THE GATE IS REACHABLE, demonstrated by driving it: raised to $2B on the same
   data it eliminated 29 rows and changed every survivor. So this is not the
   `no-leaps` failure (honesty rule 23) — the condition can fire, it simply did
   not today. Re-read it against the live distribution with `?trail=1`, which
   prints the dollar volume of every row at every gate, rather than arguing the
   number. */
const RADAR_MIN_DOLLAR_VOL = 50_000_000;
/* "Listed options with real OI": total open interest across BOTH sides of the
   NEAREST listed expiry. A chain that exists but carries no open interest is
   not tradeable, and `listed: true, oi: 0` is a finding rather than an absence. */
const RADAR_MIN_CHAIN_OI   = 1_000;

/* SLOTS. Ranking is by relative volume (today's volume ÷ 3-month average), which
   is the direct measure of "something is happening here today", tie-broken on
   the absolute move. Ranked in one pool, the sector picks would never surface —
   a large cap on an ordinary day sits at ~1.0× while a gainer sits at 3-10× —
   which would make source (b) a branch that cannot fire (honesty rule 23). So
   each lane gets a reserved allocation and UNUSED slots spill to the other lane.
   Spilling only ever promotes a name that already cleared every gate; nothing is
   padded to reach RADAR_MAX. */
const RADAR_MAX           = 5;
const RADAR_MOVER_SLOTS   = 3;
const RADAR_SECTOR_SLOTS  = 2;

const RADAR_SCREENERS = [
  { id: 'day_gainers',  count: 50 },
  { id: 'most_actives', count: 50 },
];

/* Bound on how many sector picks one batched quote call carries. 11 sectors ×
   1 opportunity pick = 11, so this does not bite today; it exists so a future
   sectors payload cannot turn one call into an unbounded URL. If it ever does
   bite it is LOGGED and reported on the source entry — a silent truncation
   reads as "covered everything". */
const RADAR_SECTOR_PROBE_MAX = 20;

const radarKey = d => `radar:${d}`;
/* Retention outlives the PT day it is keyed on, so a late-evening read still
   finds the day's answer instead of paying for a rebuild after the close. The
   key carries its own date, so there is no freshness question to get wrong. */
const RADAR_TTL      = 36 * 3600;
/* An INCOMPLETE build (a source was down) is cached like any other so the cost
   stays bounded, but it is re-built rather than re-served once this much time
   has passed. Same shape as the EOD placeholder: store the honest partial,
   retry on a bounded cadence, never let a broken source define the whole day. */
const RADAR_RETRY_MS = 10 * 60_000;

const RADAR_GATE_ORDER = [
  'shape', 'exchange', 'on-watchlist', 'duplicate', 'no-quote',
  'price', 'market-cap', 'dollar-volume', 'rank', 'optionable', 'selected',
];

function radarGatesDeclared() {
  return {
    minMarketCap:         RADAR_MIN_MARKET_CAP,
    minPrice:             RADAR_MIN_PRICE,
    minAvgDollarVolume:   RADAR_MIN_DOLLAR_VOL,
    minChainOpenInterest: RADAR_MIN_CHAIN_OI,
    max:                  RADAR_MAX,
    moverSlots:           RADAR_MOVER_SLOTS,
    sectorSlots:          RADAR_SECTOR_SLOTS,
    rankedBy:             'rvol (today volume ÷ 3-month average), tie-break |chgPct|',
    excludedFrom:         'watchlist:tickers',
  };
}

/** Compact money for the `why` line. Returns null rather than a fabricated 0 —
 *  a missing figure and a zero must never render the same way. */
function radarMoney(n) {
  if (n == null || !Number.isFinite(n)) return null;
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (a >= 1e9)  return `$${(n / 1e9).toFixed(n / 1e9 >= 100 ? 0 : 1)}B`;
  if (a >= 1e6)  return `$${(n / 1e6).toFixed(0)}M`;
  return `$${Math.round(n)}`;
}

/**
 * The exclusion set. THIS IS THE ONLY THING THAT CAN REFUSE THE WHOLE ENDPOINT.
 *
 * Radar is defined as "not on my watchlist". With `watchlist:tickers`
 * unreadable the exclusion cannot be applied, and a radar that quietly includes
 * watchlist names is not a thinner answer — it is a different question answered
 * under the first one's label. So all four unusable shapes refuse, each with its
 * own message, exactly as `sweepUniverse()` does for the crons.
 *
 * Deliberately NOT `sweepUniverse()`: that helper caps at 60, is worded for a
 * cron ("no dedup key has been stamped"), and returns the sweep universe rather
 * than an exclusion set. Same discipline, different contract.
 */
async function radarExclusionSet(env) {
  let raw = null, why = null;
  try {
    raw = await env?.REC_LOG?.get('watchlist:tickers', 'json');
  } catch (e) {
    why = `KV read failed — ${e.message}`;
  }
  if (!why) {
    if (raw == null)              why = 'key is absent (no dashboard has ever saved a watchlist)';
    else if (!Array.isArray(raw)) why = `key holds ${typeof raw}, not an array`;
    else if (!raw.length)         why = 'key holds an empty array';
  }
  let set = null;
  if (!why) {
    set = new Set(raw.map(t => String(t).toUpperCase().trim()).filter(t => REC_SYMBOL_RE.test(t)));
    if (!set.size) { set = null; why = `all ${raw.length} entries failed the symbol-shape test`; }
  }
  if (why) {
    const reason = `radar cannot be built: watchlist:tickers ${why}. Radar is defined as "quality names `
      + 'NOT on the watchlist", so with no exclusion set every candidate could already be a name you '
      + 'hold. REFUSING rather than returning a list that answers a different question. Nothing has '
      + 'been cached, so the next request retries. Fix: open the dashboard, which saves its watchlist.';
    console.error(`[radar] !! NO-EXCLUSION-SET !! ${reason}`);
    return { set: null, reason };
  }
  return { set, reason: null };
}

/** One Yahoo predefined screener. Throws with a nameable reason — the caller
 *  turns that into the source's `reason`, never into a silent empty list. */
async function radarScreener(id, count) {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=true`
    + `&scrIds=${encodeURIComponent(id)}&count=${count}`,
    { headers: YAHOO_HEADERS },
  );
  if (!r.ok) throw new Error(`Yahoo screener ${id} HTTP ${r.status}`);
  const d = await r.json();
  const quotes = d?.finance?.result?.[0]?.quotes;
  if (!Array.isArray(quotes)) throw new Error(`Yahoo screener ${id} returned no quotes array`);
  return quotes;
}

/** Screener rows (`formatted=true`, so `{raw,fmt}`) and `/v7/finance/quote` rows
 *  (bare numbers) carry the same field names; `num` accepts either shape. */
function radarNormalize(q, source, lane, extra = {}) {
  const num = v => (v && typeof v === 'object' ? (v.raw ?? null) : (v ?? null));
  const price  = num(q.regularMarketPrice);
  const vol    = num(q.regularMarketVolume);
  const avgVol = num(q.averageDailyVolume3Month) ?? num(q.averageDailyVolume10Day);
  const cap    = num(q.marketCap);
  const chg    = num(q.regularMarketChangePercent);
  return {
    ticker:    String(q.symbol || '').toUpperCase().trim(),
    name:      q.longName || q.shortName || '',
    exchange:  q.exchange || '',
    price:     price != null ? Math.round(price * 100) / 100 : null,
    chgPct:    chg   != null ? Math.round(chg   * 100) / 100 : null,
    marketCap: cap,
    volume:    vol,
    avgVol,
    // Guarded before the arithmetic: a null must not divide or multiply to 0.
    dollarVol: price != null && avgVol != null ? Math.round(price * avgVol) : null,
    rvol:      vol != null && avgVol ? Math.round(vol / avgVol * 10) / 10 : null,
    source, lane, ...extra,
  };
}

/** Returns the name of the gate that eliminated this candidate, or null if it
 *  cleared every one. Order matters only for the trail's readability. */
function radarGate(c, excluded) {
  if (!c.ticker || !REC_SYMBOL_RE.test(c.ticker))                 return 'shape';
  if (c.exchange && !SCANNER_MAJOR_EXCHANGES.has(c.exchange))     return 'exchange';
  if (excluded.has(c.ticker))                                     return 'on-watchlist';
  if (c.price == null || c.price <= RADAR_MIN_PRICE)              return 'price';
  if (c.marketCap == null || c.marketCap <= RADAR_MIN_MARKET_CAP) return 'market-cap';
  if (c.dollarVol == null || c.dollarVol < RADAR_MIN_DOLLAR_VOL)  return 'dollar-volume';
  return null;
}

const radarRank = (a, b) =>
  (b.rvol ?? 0) - (a.rvol ?? 0) || Math.abs(b.chgPct ?? 0) - Math.abs(a.chgPct ?? 0);

/**
 * Optionability — ONE chain fetch, and only ever for a name already in the
 * final ≤5. `listed: false` (Yahoo has no chain) and `listed: null` (the fetch
 * failed) are different facts and both are recorded; only `true` with enough
 * open interest passes.
 */
async function radarOptionable(sym, env) {
  let res;
  try {
    const d = await yahooAuth(`/v7/finance/options/${encodeURIComponent(sym)}`, '', env);
    res = d?.optionChain?.result?.[0];
  } catch (e) {
    return { listed: null, oi: null, expiries: null, expiry: null, reason: `chain fetch failed — ${e.message}` };
  }
  if (!res) return { listed: false, oi: 0, expiries: 0, expiry: null, reason: 'Yahoo returned no option chain for this symbol' };
  const expiries = Array.isArray(res.expirationDates) ? res.expirationDates.length : 0;
  const chain    = res.options?.[0];
  if (!expiries || !chain) {
    return { listed: false, oi: 0, expiries, expiry: null, reason: 'no listed expiries' };
  }
  const sumOi = side => (Array.isArray(side) ? side : [])
    .reduce((t, o) => t + (Number(o?.openInterest?.raw ?? o?.openInterest) || 0), 0);
  const oi = sumOi(chain.calls) + sumOi(chain.puts);
  return {
    listed: true, oi, expiries,
    expiry: chain.expirationDate ? expiryIso(chain.expirationDate) : null,
    reason: null,
  };
}

/** MECHANICAL. Every clause is a number that qualified this name, in the units
 *  the gates are expressed in. Nothing here is generated or inferred. */
function radarWhy(c) {
  const bits = [];
  if (c.lane === 'sector' && c.sector) bits.push(`${c.sector} opportunity pick`);
  if (c.chgPct != null)  bits.push(`${c.chgPct >= 0 ? '+' : ''}${c.chgPct}% today`);
  if (c.rvol   != null)  bits.push(`${c.rvol}× avg volume`);
  if (c.marketCap != null) bits.push(`${radarMoney(c.marketCap)} cap`);
  if (c.dollarVol != null) bits.push(`${radarMoney(c.dollarVol)}/day avg $-volume`);
  if (c.optionable?.oi != null) bits.push(`${c.optionable.oi.toLocaleString('en-US')} OI on the front chain`);
  return bits.join(' · ');
}

async function radarBuild(env) {
  const nowIso  = ptDate();
  const trail   = [];
  const sources = [];
  const push    = (c, gate, note = null) => trail.push({
    ticker: c.ticker, source: c.source, lane: c.lane, gate,
    price: c.price ?? null, chgPct: c.chgPct ?? null,
    marketCap: c.marketCap ?? null, dollarVol: c.dollarVol ?? null, rvol: c.rvol ?? null,
    ...(note ? { note } : {}),
  });

  const excl = await radarExclusionSet(env);
  if (!excl.set) {
    /* candidates is NULL, not []. `[]` means the gates ran and nothing survived;
       `null` means they never ran. Collapsing the two is the whole failure this
       endpoint's honesty rules exist to prevent. */
    return {
      schema: RADAR_SCHEMA, ts: Date.now(), ptDate: nowIso,
      refused: true, reason: excl.reason, complete: false,
      candidates: null, count: null, excludedCount: null,
      sources: [], funnel: null, trail: [], gates: radarGatesDeclared(),
    };
  }

  const pool = new Map();   // ticker -> candidate that cleared every static gate

  /* ── Source (a): Yahoo predefined screeners ─────────────────────────────── */
  for (const s of RADAR_SCREENERS) {
    const name = `yahoo:${s.id}`;
    let rows = null, reason = null;
    try { rows = await radarScreener(s.id, s.count); }
    catch (e) { reason = e.message; console.warn(`[radar] source ${name} failed: ${reason}`); }
    sources.push({ name, ok: rows != null, reason, rows: rows?.length ?? 0 });
    for (const q of (rows || [])) {
      const c = radarNormalize(q, name, 'mover');
      if (c.ticker && pool.has(c.ticker)) { push(c, 'duplicate'); continue; }
      const g = radarGate(c, excl.set);
      if (g) { push(c, g); continue; }
      pool.set(c.ticker, c);
    }
  }

  /* ── Source (b): the banked sector opportunity picks ────────────────────── */
  const bName = `kv:${SECTORS_KV_KEY}`;
  let sectorRec = null, bReason = null, picks = [];
  try { sectorRec = await env?.REC_LOG?.get(SECTORS_KV_KEY, 'json'); }
  catch (e) { bReason = `KV read failed — ${e.message}`; }
  if (!bReason) {
    if (!sectorRec) {
      bReason = 'no market:sectors snapshot is banked (the 4h cache has expired, or the Sectors tab '
              + 'has never been built on this Worker)';
    } else if (!Array.isArray(sectorRec.sectors) || !sectorRec.sectors.length) {
      bReason = 'the banked market:sectors record carries no sectors array';
    } else {
      const seen = new Set();
      for (const s of sectorRec.sectors) {
        const t = String(s?.opportunity?.ticker || '').toUpperCase().trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        picks.push({ ticker: t, sector: s.sector || null });
      }
      if (!picks.length) bReason = 'the banked market:sectors record names no opportunity tickers';
    }
  }

  // Cheap gates first, so the one batched quote call only carries live prospects.
  const probe = [];
  for (const p of picks) {
    const stub = { ticker: p.ticker, source: bName, lane: 'sector', sector: p.sector };
    if (!REC_SYMBOL_RE.test(p.ticker))  { push(stub, 'shape');        continue; }
    if (excl.set.has(p.ticker))         { push(stub, 'on-watchlist'); continue; }
    if (pool.has(p.ticker))             { push(stub, 'duplicate');    continue; }
    probe.push(p);
  }
  let probeDropped = 0;
  if (probe.length > RADAR_SECTOR_PROBE_MAX) {
    probeDropped = probe.length - RADAR_SECTOR_PROBE_MAX;
    console.warn(`[radar] sector picks capped at ${RADAR_SECTOR_PROBE_MAX}; ${probeDropped} not probed`);
    probe.length = RADAR_SECTOR_PROBE_MAX;
  }

  if (!bReason && probe.length) {
    let quotes = null;
    try {
      const d = await yahooAuth(
        '/v7/finance/quote',
        `?symbols=${probe.map(p => encodeURIComponent(p.ticker)).join(',')}`,
        env,
      );
      const arr = d?.quoteResponse?.result;
      if (!Array.isArray(arr)) throw new Error('/v7/finance/quote returned no quoteResponse.result array');
      quotes = new Map(arr.map(q => [String(q.symbol || '').toUpperCase(), q]));
    } catch (e) {
      bReason = `sector picks read from KV, but the batched quote check failed — ${e.message}`;
      console.warn(`[radar] source ${bName} quote batch failed: ${e.message}`);
    }
    for (const p of (quotes ? probe : [])) {
      const q = quotes.get(p.ticker);
      if (!q) { push({ ticker: p.ticker, source: bName, lane: 'sector', sector: p.sector }, 'no-quote'); continue; }
      const c = radarNormalize(q, bName, 'sector', { sector: p.sector });
      if (!c.ticker) c.ticker = p.ticker;
      if (pool.has(c.ticker)) { push(c, 'duplicate'); continue; }
      const g = radarGate(c, excl.set);
      if (g) { push(c, g); continue; }
      pool.set(c.ticker, c);
    }
  }
  sources.push({
    name: bName, ok: !bReason, reason: bReason,
    rows: picks.length,
    ...(probeDropped ? { cappedOut: probeDropped, capNote: `RADAR_SECTOR_PROBE_MAX=${RADAR_SECTOR_PROBE_MAX}` } : {}),
  });

  /* ── Rank into slots ────────────────────────────────────────────────────── */
  const movers  = [...pool.values()].filter(c => c.lane === 'mover').sort(radarRank);
  const sectorC = [...pool.values()].filter(c => c.lane === 'sector').sort(radarRank);
  const takeM = movers.slice(0, RADAR_MOVER_SLOTS);
  const takeS = sectorC.slice(0, RADAR_SECTOR_SLOTS);
  const take  = [...takeM, ...takeS];
  // Unused slots spill — only ever to a name that already cleared every gate.
  if (take.length < RADAR_MAX) take.push(...movers.slice(takeM.length, takeM.length + (RADAR_MAX - take.length)));
  if (take.length < RADAR_MAX) take.push(...sectorC.slice(takeS.length, takeS.length + (RADAR_MAX - take.length)));
  take.sort(radarRank);

  const taken = new Set(take.map(c => c.ticker));
  for (const c of [...movers, ...sectorC]) if (!taken.has(c.ticker)) push(c, 'rank');

  /* ── Optionability: the ONLY per-name fetch, and only for the final ≤5 ──── */
  const chains = await allSettledCounted(take.map(c => radarOptionable(c.ticker, env)), 'radar:chains');
  const candidates = [];
  take.forEach((c, i) => {
    const r = chains[i];
    c.optionable = r.status === 'fulfilled'
      ? r.value
      : { listed: null, oi: null, expiries: null, expiry: null, reason: `chain fetch rejected — ${r.reason?.message || r.reason}` };
    if (c.optionable.listed !== true || (c.optionable.oi ?? 0) < RADAR_MIN_CHAIN_OI) {
      push(c, 'optionable', c.optionable.reason
        || `front-chain OI ${c.optionable.oi} < ${RADAR_MIN_CHAIN_OI}`);
      return;   // No backfill by design: a failed name reduces the count, it
                // does not promote the next one behind an unchecked chain.
    }
    candidates.push({
      ticker: c.ticker, name: c.name, why: radarWhy(c), source: c.source, lane: c.lane,
      sector: c.sector ?? null,
      price: c.price, chgPct: c.chgPct, marketCap: c.marketCap,
      rvol: c.rvol, dollarVol: c.dollarVol,
      optionable: { listed: c.optionable.listed, oi: c.optionable.oi, expiry: c.optionable.expiry },
    });
    push(c, 'selected');
  });

  const funnel = Object.fromEntries(RADAR_GATE_ORDER.map(g => [g, trail.filter(t => t.gate === g).length]));
  const complete = sources.length > 0 && sources.every(s => s.ok);

  return {
    schema: RADAR_SCHEMA, ts: Date.now(), ptDate: nowIso,
    refused: false, reason: null, complete,
    candidates, count: candidates.length,
    excludedCount: excl.set.size,
    sources, funnel, trail, gates: radarGatesDeclared(),
    considered: trail.length,
  };
}

/** Shape the stored record into a response. The trail is stored either way and
 *  emitted only under `?trail=1`, so a cached record can still answer for it. */
function radarResponse(rec, { cached, wantTrail, mark }) {
  const { trail, ...rest } = rec;
  const note = rec.refused
    ? 'refused — no exclusion set'
    : `${rec.count} of ${rec.considered ?? 0} considered · ${rec.excludedCount} watchlist names excluded`
      + (rec.complete ? '' : ' · INCOMPLETE, a source is down');
  return {
    ...rest,
    cached: !!cached,
    ...(wantTrail ? { trail } : {}),
    _instr: instrSince(mark, 'radar'),
    _meta: srcMeta('Yahoo screeners + banked sector picks', {
      ok: !rec.refused && rec.complete,
      delayed: true,
      ttlSeconds: RADAR_TTL,
      asOf: rec.ptDate,
      note,
    }),
  };
}

/** GET /api/radar — origin-gated, no `x-dash-key`: no Claude call, no spend,
 *  and the only write is this endpoint's own day cache. */
async function handleRadar(origin, env, params) {
  const mark      = instrMark();
  const key       = radarKey(ptDate());
  const wantTrail = params?.get('trail') === '1';
  const force     = params?.get('refresh') === '1';

  let cached = null;
  try { cached = await env?.REC_LOG?.get(key, 'json'); } catch (_) {}
  if (cached && cached.schema !== RADAR_SCHEMA) cached = null;   // strict equality

  /* A COMPLETE build is the day's answer. An INCOMPLETE one is re-served only
     inside RADAR_RETRY_MS, so a source that was down at 6am does not define
     discovery for the rest of the day. */
  if (!force && cached && (cached.complete === true || Date.now() - (cached.ts || 0) < RADAR_RETRY_MS)) {
    return json(radarResponse(cached, { cached: true, wantTrail, mark }), 200, origin);
  }

  const built = await radarBuild(env);
  // A refusal is never cached: it is a fact about our own config, not about the day.
  if (!built.refused) {
    try { await env?.REC_LOG?.put(key, JSON.stringify(built), { expirationTtl: RADAR_TTL }); }
    catch (e) { console.warn('[radar] cache write failed:', e.message); }
  }
  return json(radarResponse(built, { cached: false, wantTrail, mark }), 200, origin);
}

/* ═══════════════════════════════════════════════════════════════════════════
   INCOME SLEEVE  (/api/income) — the dividend half of decision_dash

   THREE ENDPOINTS, ONE SAVED LIST, NO CLAUDE CALL ANYWHERE, NO CRON CHANGE.

     GET  /api/income/list            origin-gated read of `income:tickers`
     POST /api/income/save            requireSecret — it is a KV write
     GET  /api/income/batch?symbols=  one mechanical row per name

   `income:tickers` IS A DIFFERENT LIST FROM `watchlist:tickers` AND MUST STAY
   ONE. Different purpose (hold-for-yield vs trade), different cadence, and —
   the load-bearing part — `sweepUniverse()` reads `watchlist:tickers` and
   nothing else, so folding the sleeve into it would silently enlarge the IV
   sweep, the move-series sweep and the analysis refresh. Nothing here is ever
   read by a cron.

   Entries are OBJECTS, not bare strings: `{ ticker, addBelow }`, where
   `addBelow` is an optional user-set price. `addBelow` is USER DATA, which is
   why `inAddZone` is an honest event — it compares a live price to a number the
   user typed, not to one this Worker invented.

   ── WHAT YAHOO ACTUALLY RETURNS, probed live 2026-08-19 rather than recalled.
      This is the FINRA field-name lesson; every one of these was wrong-by-
      documentation and right-by-probe:

     • `summaryDetail.dividendYield` is populated for EQUITY and **EMPTY `{}` for
       every ETF**. ETFs carry it as `summaryDetail.yield` (and
       `defaultKeyStatistics.yield`). Measured: KO `dividendYield` 0.0239; SCHD /
       JEPQ / VYM `dividendYield` `{}` with `yield` 0.0313 / 0.1076 / 0.0224.
       Reading only `dividendYield` ships a permanently-null yield on every fund
       in an income sleeve — i.e. on most of it.
     • Both are **decimals**. They are normalised to PERCENT here, and the field
       that decided each row rides along as `dividendYieldSource`.
     • **`trailingAnnualDividendRate` IS A FABRICATED ZERO ON ETFs.** SCHD and
       JEPQ both report `0` while paying quarterly and monthly respectively; VYM
       reports `{}`. A vendor 0 against a paying history is not a fact, so it is
       **nulled** with `trailingRateNote` saying why, and `ttmRate` — summed from
       the dividend history this handler already fetches — is shipped beside it.
     • `payoutRatio` is `{}` for every ETF and `0` for a non-payer. Null payout
       produces NO `payoutHigh` event, which is not the same as a passing one.
     • `defaultKeyStatistics.lastDividendValue` / `lastDividendDate` are populated
       for EQUITY (KO 0.53 / 2026-06-15, matching the chart history exactly) and
       **empty for every ETF**, so the dividend history is the primary source for
       the last payment and Yahoo's pair is only a cross-check.

   ── THE EX-DIVIDEND GOTCHA, quantified. `summaryDetail.exDividendDate` is
      routinely the most recent PAST date rather than the next one — the same
      defect the catalyst card was fixed for. Measured over 15 payers on
      2026-08-19: **9 published a PAST date** (XOM PG MO ABBV HD T VZ IBM O),
      6 a future one, and all 3 ETFs published NOTHING. So the date ships as
      published with `exDivIsPast` computed against ET today, and
      **the next one is never estimated from cadence** — a projected date is
      indistinguishable on screen from a declared one.

   ── DIVIDEND HISTORY comes from `/v8/finance/chart?events=div`, no crumb.
      `events.dividends[].date` is the **EX-DIVIDEND date**, not the pay date —
      verified against KO, whose chart event 2026-06-15 equals
      `defaultKeyStatistics.lastDividendDate` while `calendarEvents.dividendDate`
      (the pay date) is 2026-10-01. The field is therefore named `lastDivExDate`.
      `interval=1mo` carries the identical event set at **10,255 bytes against
      164,899** for `interval=1d` (KO, range=6y, 24 events either way).

   ── TAX CHARACTER (qualified vs ordinary) IS OMITTED ENTIRELY, not nulled.
      Nothing in any Yahoo module carries it, and it is not derivable: it depends
      on the issuer's own 1099-DIV box allocation and on the holder's own holding
      period, neither of which this Worker can see. A field that could only ever
      be a guess is worse than an absent one, because a guess renders.

   ── COST, per rule #1, capCost = extFetches + bindingOps. Per NAME:
        1 quoteSummary (crumbed) + 1 dividend chart          = 2 external
        1 KV get + 1 KV put on a cold row                    = 2 bindings
        1 KV get only, on a warm row                         = 1 binding
      Plus, ONCE per batch: ceil(N/20) spark fetches and 1 KV get for the sleeve
      (+1 get and +2 fetches and +1 put when the Yahoo crumb is also cold).

        cold batch  = 4N + ceil(N/20) + 1   (+4 for a cold crumb)
        warm batch  =  N + ceil(N/20) + 1   (+4 for a cold crumb)

      MEASURED on `wrangler dev --remote` against production KV, 2026-08-19,
      N=10 (PG MO ABBV MCD HD T VZ IBM LMT PEP), crumb warm:

        cold  extFetches 21 · bindingOps 21 · **capCost 42**   (model: 41 + crumb)
        warm  extFetches  1 · bindingOps 11 · **capCost 12**   (model: 12)

      The one spark fetch is what makes the warm read cheap: the price half is
      live for every name at ceil(N/20) fetches total, so nothing has to refetch
      a quoteSummary just to keep `inAddZone` honest.
   ══════════════════════════════════════════════════════════════════════════ */

const INCOME_SCHEMA      = 1;
const INCOME_FRESH_MS    = 6 * 3600_000;   // freshness horizon — drives the stale badge
const INCOME_ROW_TTL     = 36 * 3600;      // retention OUTLIVES freshness so stale can render
const INCOME_MAX_SYMBOLS = 30;             // per batch request
const INCOME_MAX_SLEEVE  = 60;             // per saved list

/* Dividend history pull. `1mo` bars because only the EVENTS are wanted — see
   the payload measurement above. 6y so a 5-year growth rate has a margin. */
const INCOME_DIV_RANGE    = '6y';
const INCOME_DIV_INTERVAL = '1mo';

/* THE FIXED-RATE vs VARIABLE CLASSIFIER, and it is measured rather than guessed.
   A declared-dividend equity holds the SAME amount for several periods and then
   raises; a fund distributes whatever it collected, so the amount moves nearly
   every period. So the discriminator is "does the amount repeat", not "how much
   does it vary" — `zeroFrac`, the fraction of consecutive payments that are
   EXACTLY equal over the last `INCOME_DIST_WINDOW`.

   MEASURED 2026-08-19 over 30 names, and this falsified two obvious alternatives:

     coefficient of variation   variable 1.3-85.4%  vs  steady ETF 7.2-22.1%
                                -> OVERLAPS COMPLETELY. QYLD/RYLD/SPYI/NUSI are
                                   all STEADIER than SCHD/VYM/DGRO. Unusable.
     down-moves / n             variable 0.18-0.55  vs  steady ETF 0.45-0.55
                                -> overlaps. Unusable.
     zeroFrac                   14 equities  73%, 82%, 100%   (min 73%)
                                16 funds     0-18%            (max 18%)
                                -> separates cleanly, threshold in a 55-pt gap.

   AND IT GETS `O` RIGHT: Realty Income pays MONTHLY and scores 82%, because it
   declares a monthly rate and holds it. A "monthly implies variable" rule would
   have suppressed its growth and its cut flag, both of which are meaningful.

   CONSEQUENCE THE CALLER MUST KNOW: SCHD, VYM, DGRO, VIG, SPYD, HDV and DVY all
   classify VARIABLE (zeroFrac 0-9%, median period change 6.9-19.7%). Their
   quarterly amount genuinely moves — SCHD's latest is -1.56% on the prior — so
   suppressing `cut` for them is the point rather than a side effect: that -1.56%
   is a distribution fluctuation and rendering it as a dividend cut is exactly
   the false positive this classifier exists to prevent. */
const INCOME_DIST_WINDOW           = 12;   // payments in the classifier window
const INCOME_FIXED_RATE_MIN_REPEAT = 0.5;  // zeroFrac at or above this = fixed-rate
const INCOME_DIST_MIN_CHANGES      = 4;    // below this the kind is `unknown`, never guessed

const INCOME_GROWTH_YEARS      = 5;
const INCOME_GROWTH_MATCH_DAYS = 45;  // how near the 5y-ago anchor a payment must sit
const INCOME_EXDIV_UPCOMING_DAYS = 7;
const INCOME_PAYOUT_HIGH_PCT     = 90;
const INCOME_SHRINK_WARN_PCT     = 0.30;

/* THE PER-NAME ROW LIVES UNDER `incomerow:`, NOT UNDER `income:`, AND THAT IS
   NOT COSMETIC. The saved list is `income:tickers` (named by the spec) and its
   snapshot is `income:prev`. Both `TICKERS` and `PREV` pass `REC_SYMBOL_RE`, so
   a row key of `income:{TICKER}` would put the sleeve list inside the same
   prefix as the rows — and any future `list({ prefix: 'income:' })` over the
   rows would read the sleeve itself as a ticker called TICKERS. That is exactly
   why `ivsweep:last`, `movesweep:last`, `macrosweep:last` and `moodsweep:last`
   all sit OUTSIDE the prefixes they belong to. Nothing scans either prefix
   today; this keeps it impossible rather than merely unused. */
const incomeKey = sym => `incomerow:${sym.toUpperCase()}`;

const INCOME_CADENCE = [
  [35,  'monthly'], [115, 'quarterly'], [220, 'semi-annual'], [400, 'annual'],
];
function incomeCadenceLabel(days) {
  if (days == null) return null;
  for (const [max, label] of INCOME_CADENCE) if (days <= max) return label;
  return 'irregular';
}

/** Today in US Eastern time as `YYYY-MM-DD` — the reference `exDivIsPast` is
 *  computed against, because an ex-dividend date is an exchange-calendar date. */
const etDateToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

const isoOfUnix = sec => (sec == null ? null : new Date(sec * 1000).toISOString().slice(0, 10));
const daysBetweenIso = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Yahoo wraps scalars as `{raw, fmt}` and uses `{}` for absent. Both collapse
 *  to null here — `{}` is NOT zero, and that distinction is the whole ETF bug. */
const incNum = v => {
  if (v == null) return null;
  if (typeof v === 'object') return typeof v.raw === 'number' ? v.raw : null;
  return typeof v === 'number' ? v : null;
};

/* THE SLEEVE ENTRY IS AN ALLOWLIST, AND EVERY DEPARTURE FROM IT IS REPORTED.
 *
 * `income:tickers` is written by a caller and read back to render, so the stored
 * shape is FIXED rather than whatever JSON arrived — reflecting arbitrary caller
 * fields into a value that later renders is the shape of the unauthenticated
 * `/api/analysis/:ticker` write CLAUDE.md rule #5 exists to close. That decision
 * stands; what changed is that the allowlist no longer applies itself in silence.
 *
 * `category` is on the allowlist as an ENUM: it is the Diversify tab's storage —
 * a user-assigned classification the consumer renders groups from — and the
 * design for it lives in decision_dash's DESIGN.md. Constraining it to four
 * values keeps the reflection concern satisfied: still an allowlist, now with one
 * enum-constrained field rather than free text.
 *
 * THE SILENCE WAS THE DEFECT, NOT THE STRIPPING. A client that sent `category`
 * before this got a clean 200 and found out on the next read, because `rejected`
 * counts only entries whose TICKER failed and says nothing about fields. Both
 * failure kinds are now collected into `report` and surfaced by the caller:
 *
 *   report.unknown  a field name not on the allowlist — STRIPPED
 *   report.invalid  an allowlisted field whose value failed — COERCED TO NULL
 *
 * Neither ever rejects the entry. A bad `category` must not cost you the ticker.
 */
const INCOME_CATEGORIES   = ['income', 'cyclical', 'value', 'defensive'];
const INCOME_ENTRY_FIELDS = ['ticker', 'addBelow', 'category'];

/**
 * Normalise one saved sleeve entry. Objects are the shape; a bare string is
 * tolerated and coerced, because an older client sending strings should degrade
 * to "no add-below set" rather than dropping the name out of the sleeve.
 *
 * `report` is optional: pass `{ unknown: Set, invalid: [] }` to collect what was
 * stripped or coerced. Omit it where the caller only wants the entry.
 */
function incomeEntry(raw, report = null) {
  const t = typeof raw === 'string' ? raw : raw?.ticker;
  const ticker = String(t ?? '').toUpperCase().trim();
  if (!REC_SYMBOL_RE.test(ticker)) return null;
  const obj = typeof raw === 'object' && raw ? raw : null;

  const abRaw = obj ? obj.addBelow : undefined;
  const ab = obj ? Number(abRaw) : NaN;
  const addBelow = Number.isFinite(ab) && ab > 0 ? Math.round(ab * 100) / 100 : null;
  if (report && abRaw != null && addBelow === null) {
    report.invalid.push({
      ticker, field: 'addBelow', value: abRaw,
      reason: 'not a finite number greater than 0 — coerced to null',
    });
  }

  let category = null;
  const catRaw = obj ? obj.category : undefined;
  if (catRaw != null) {
    const c = String(catRaw).toLowerCase().trim();
    if (INCOME_CATEGORIES.includes(c)) category = c;
    else if (report) {
      report.invalid.push({
        ticker, field: 'category', value: catRaw,
        reason: `not one of ${INCOME_CATEGORIES.join(' | ')} — coerced to null`,
      });
    }
  }

  if (report && obj) {
    for (const k of Object.keys(obj)) if (!INCOME_ENTRY_FIELDS.includes(k)) report.unknown.add(k);
  }
  return { ticker, addBelow, category };
}

const incomeReport = () => ({ unknown: new Set(), invalid: [] });

/**
 * Read the saved sleeve. Returns `{ entries, byTicker, reason }` with entries
 * NULL — never `[]` — on every unusable shape, each with its own message. `[]`
 * would mean "the user has a sleeve and it is empty"; null means there is no
 * sleeve, which is a different thing and the one an empty key actually is.
 * NO SERVER-SIDE DEFAULT SEEDING: an absent key means the user has not built a
 * sleeve, and every endpoint says exactly that.
 */
async function readIncomeSleeve(env) {
  let raw = null, why = null;
  try {
    raw = await env?.REC_LOG?.get('income:tickers', 'json');
  } catch (e) {
    why = `KV read failed — ${e.message}`;
  }
  if (!why) {
    if (raw == null)              why = 'key is absent — no income sleeve has been saved yet';
    else if (!Array.isArray(raw)) why = `key holds ${typeof raw}, not an array`;
    else if (!raw.length)         why = 'key holds an empty array';
  }
  if (!why) {
    /* The READ normalises through the same allowlist, so `category` round-trips
       and nothing outside it can arrive from a hand-written KV value. It reports
       too: a stored record carrying an unknown field or an out-of-enum category
       did not come from `handleIncomeSave`, and that is worth seeing rather than
       quietly flattening. Normally both are empty. */
    const report = incomeReport();
    const entries = raw.map(r => incomeEntry(r, report)).filter(Boolean);
    const seen = new Map();
    for (const e of entries) if (!seen.has(e.ticker)) seen.set(e.ticker, e);
    if (!seen.size) why = `all ${raw.length} entries failed the symbol-shape test`;
    else {
      if (report.unknown.size || report.invalid.length) {
        console.warn(`[income] stored sleeve carried fields the allowlist does not: `
          + `unknown [${[...report.unknown].join(', ')}] · invalid ${JSON.stringify(report.invalid)}`);
      }
      return {
        entries: [...seen.values()], byTicker: seen, reason: null,
        dropped: raw.length - seen.size,
        storedDroppedFields: [...report.unknown],
        storedInvalidValues: report.invalid,
      };
    }
  }
  return {
    entries: null, byTicker: new Map(), reason: `income:tickers ${why}`, dropped: 0,
    storedDroppedFields: [], storedInvalidValues: [],
  };
}

/** GET /api/income/list — origin-gated. An absent sleeve is a NAMED state. */
async function handleIncomeList(origin, env) {
  const mark = instrMark();
  const s = await readIncomeSleeve(env);
  return json({
    entries: s.entries, count: s.entries?.length ?? null, reason: s.reason,
    ...(s.dropped ? { droppedEntries: s.dropped } : {}),
    /* Normally absent. Present only when the STORED value carried something the
       allowlist does not — which means it did not come from this Worker's save
       path, and is worth seeing rather than being flattened in silence. */
    ...(s.storedDroppedFields?.length ? { storedDroppedFields: s.storedDroppedFields } : {}),
    ...(s.storedInvalidValues?.length ? { storedInvalidValues: s.storedInvalidValues } : {}),
    categories: INCOME_CATEGORIES,
    _instr: instrSince(mark, 'income-list'),
    _meta: srcMeta('Cloudflare KV', { ok: !!s.entries, ttlSeconds: null, note: s.reason || `${s.entries.length} names` }),
  }, 200, origin);
}

/**
 * POST /api/income/save — `requireSecret`, because it is a KV write.
 *
 * Same guard pattern as the watchlist and for the same reason: the previous
 * value goes to `income:prev` before every overwrite, and a shrink past
 * `INCOME_SHRINK_WARN_PCT` logs at WARN naming both counts and the dropped
 * names. It does NOT block — deleting names is something the user is allowed to
 * do, and a screen that refuses to save is worse than a log line. The snapshot
 * is what makes a clobber recoverable.
 *
 * THE ALLOWLIST REPORTS ITSELF. `rejected` counts entries whose TICKER failed and
 * says nothing about fields, so a client that sent an unknown field used to get a
 * clean 200 and discover the loss on the next read. `droppedFields` names every
 * field stripped and `invalidValues` every allowlisted field coerced to null;
 * both also log at WARN. Neither ever rejects the entry — a bad `category` must
 * not cost you the ticker.
 */
async function handleIncomeSave(request, origin, env) {
  const body = await request.json().catch(() => null);
  const list = Array.isArray(body?.tickers) ? body.tickers : null;
  if (!list) return err('tickers required — an array of { ticker, addBelow, category }', 400, origin);

  const report = incomeReport();
  const seen = new Map();
  let rejected = 0;
  for (const raw of list) {
    const e = incomeEntry(raw, report);
    if (!e) { rejected++; continue; }
    if (!seen.has(e.ticker)) seen.set(e.ticker, e);
  }
  const entries = [...seen.values()].slice(0, INCOME_MAX_SLEEVE);
  if (!entries.length) return err('no usable entries — each needs a { ticker } of valid symbol shape', 400, origin);

  let prev = null;
  try { prev = await env?.REC_LOG?.get('income:tickers', 'json'); } catch (_) {}
  const prevCount = Array.isArray(prev) ? prev.length : 0;

  if (prevCount) {
    try {
      await env?.REC_LOG?.put('income:prev', JSON.stringify({ tickers: prev, replacedAt: Date.now() }));
    } catch (e) { console.warn('[income] prev snapshot failed:', e.message); }
  }
  if (prevCount && entries.length < prevCount * (1 - INCOME_SHRINK_WARN_PCT)) {
    const kept = new Set(entries.map(e => e.ticker));
    const gone = prev.map(p => incomeEntry(p)?.ticker).filter(t => t && !kept.has(t));
    console.warn(`[income] SHRINK: ${prevCount} -> ${entries.length} names. The previous value is in `
      + `income:prev. Dropped: ${gone.join(', ')}`);
  }

  const droppedFields = [...report.unknown];
  if (droppedFields.length) {
    console.warn(`[income] save STRIPPED ${droppedFields.length} field name(s) not on the allowlist `
      + `(${INCOME_ENTRY_FIELDS.join(', ')}): ${droppedFields.join(', ')}. The entries were saved without them.`);
  }
  if (report.invalid.length) {
    console.warn(`[income] save COERCED ${report.invalid.length} value(s) to null: `
      + report.invalid.map(i => `${i.ticker}.${i.field}=${JSON.stringify(i.value)}`).join(', ')
      + '. The entries themselves were kept.');
  }

  await env?.REC_LOG?.put('income:tickers', JSON.stringify(entries));
  return json({
    ok: true, count: entries.length, previousCount: prevCount, rejected,
    /* Always present, empty arrays included: a consumer checking `.length` must
       not have to distinguish "nothing was dropped" from "this Worker predates
       the reporting". Compare the frontend-newer-than-Worker failure mode. */
    droppedFields,
    invalidValues: report.invalid,
    allowedFields: INCOME_ENTRY_FIELDS,
    categories: INCOME_CATEGORIES,
  }, 200, origin);
}

/* ── The dividend history read ──────────────────────────────────────────────
   ONE chart fetch per name. Returns the sorted payment list plus everything
   derived from it. Every refusal carries its own reason string; nothing here
   returns a zero standing in for an absence. */
async function incomeDividendHistory(sym) {
  const d = await yahoo(
    `/v8/finance/chart/${encodeURIComponent(sym)}`,
    `?range=${INCOME_DIV_RANGE}&interval=${INCOME_DIV_INTERVAL}&events=div`,
  );
  const res = d?.chart?.result?.[0];
  const ev  = res?.events?.dividends;
  const list = ev
    ? Object.values(ev)
        .filter(x => x && typeof x.amount === 'number' && typeof x.date === 'number')
        .sort((a, b) => a.date - b.date)
    : [];
  return list;
}

/**
 * Everything the payment list supports, and nothing it does not.
 *
 * The ordering matters: the KIND is decided first, and `growth5y` / `cut` are
 * then either computed or refused on it. A variable distribution's
 * period-over-period move is not a cut and its point-to-point 5y ratio is two
 * noisy draws, so both refuse WITH THE REASON rather than rendering a number.
 */
function incomeDividendFacts(list) {
  const out = {
    paysDividend: false, distributionKind: 'none', distributionKindBasis: null,
    cadenceDays: null, cadence: null, paymentsPerYear: null,
    lastDivAmount: null, lastDivExDate: null, priorDivAmount: null, lastVsPriorPct: null,
    divHistoryCount: 0, divHistorySpanYears: null,
    ttmRate: null, ttmSum5yAgo: null,
    growth5y: null, growth5yReason: 'no dividend history',
    cut: null, cutPct: null, cutReason: 'no dividend history',
  };
  if (!list.length) {
    out.growth5yReason = 'no dividend has ever been paid in the window read';
    out.cutReason      = out.growth5yReason;
    return out;
  }

  out.paysDividend    = true;
  out.divHistoryCount = list.length;
  const last  = list[list.length - 1];
  const prior = list.length >= 2 ? list[list.length - 2] : null;
  out.lastDivAmount  = last.amount;
  out.lastDivExDate  = isoOfUnix(last.date);      // EX-DIV date, not the pay date
  out.priorDivAmount = prior?.amount ?? null;
  if (prior && prior.amount > 0) {
    out.lastVsPriorPct = Math.round((last.amount - prior.amount) / prior.amount * 10000) / 100;
  }
  out.divHistorySpanYears =
    Math.round((last.date - list[0].date) / 86400 / 365.25 * 100) / 100;

  // Cadence, from the median gap over the recent window.
  const gaps = [];
  for (let i = Math.max(1, list.length - INCOME_DIST_WINDOW); i < list.length; i++) {
    gaps.push((list[i].date - list[i - 1].date) / 86400);
  }
  if (gaps.length) {
    const g = [...gaps].sort((a, b) => a - b);
    out.cadenceDays = Math.round(g.length % 2 ? g[(g.length - 1) / 2] : (g[g.length / 2 - 1] + g[g.length / 2]) / 2);
    out.cadence = incomeCadenceLabel(out.cadenceDays);
  }

  /* Trailing 12 months of distributions — the honest annual rate for a fund
     whose vendor `trailingAnnualDividendRate` is a fabricated 0, and the raw
     input for a TTM-sum growth rate later.

     TAKE ONE YEAR'S WORTH OF PAYMENTS AT THE OBSERVED CADENCE, NOT A 365-DAY
     DATE WINDOW. A 365-day window is off by one whenever the cadence divides it
     unevenly: four quarterly gaps span ~364 days, so the fifth payment back
     falls INSIDE the window and the sum reads five quarters. Measured before the
     fix — JNJ 6.54 against Yahoo's 5.24, and O 3.513 against 3.235, both exactly
     one payment too many. After: JNJ 5.24 and KO 2.08, matching Yahoo's own
     field to the cent on every name where Yahoo publishes one. */
  const perYear = out.cadenceDays ? Math.max(1, Math.round(365 / out.cadenceDays)) : null;
  const sumLastN = (endIdx, n) => {
    if (!n || endIdx + 1 < n) return null;
    let t = 0;
    for (let i = endIdx; i > endIdx - n; i--) t += list[i].amount;
    return Math.round(t * 1e6) / 1e6;
  };
  out.paymentsPerYear = perYear;
  out.ttmRate = sumLastN(list.length - 1, perYear);
  // The same construction anchored five years back, so a TTM-sum growth rate can
  // be computed later without a second fetch. Null unless a real anchor exists.
  const fiveBackS = last.date - INCOME_GROWTH_YEARS * 365.25 * 86400;
  let fiveIdx = -1, fiveGap = Infinity;
  for (let i = 0; i < list.length; i++) {
    const g = Math.abs((list[i].date - fiveBackS) / 86400);
    if (g < fiveGap) { fiveGap = g; fiveIdx = i; }
  }
  out.ttmSum5yAgo = (fiveIdx >= 0 && fiveGap <= INCOME_GROWTH_MATCH_DAYS)
    ? sumLastN(fiveIdx, perYear) : null;

  // ── Kind. Measured on repeats, not on variance. See the constant's block. ──
  const win = list.slice(-(INCOME_DIST_WINDOW + 1));
  const chg = [];
  for (let i = 1; i < win.length; i++) {
    if (win[i - 1].amount > 0) chg.push((win[i].amount - win[i - 1].amount) / win[i - 1].amount);
  }
  if (chg.length < INCOME_DIST_MIN_CHANGES) {
    out.distributionKind = 'unknown';
    out.distributionKindBasis = { changes: chg.length, needed: INCOME_DIST_MIN_CHANGES, zeroFrac: null };
    const r = `only ${chg.length} payment-to-payment change${chg.length === 1 ? '' : 's'} available, `
            + `${INCOME_DIST_MIN_CHANGES} needed to tell a declared fixed rate from a variable distribution`;
    out.growth5yReason = r;
    out.cutReason      = r;
    return out;
  }
  const zeroFrac = chg.filter(c => Math.abs(c) < 1e-9).length / chg.length;
  out.distributionKind = zeroFrac >= INCOME_FIXED_RATE_MIN_REPEAT ? 'fixed-rate' : 'variable';
  out.distributionKindBasis = {
    zeroFrac: Math.round(zeroFrac * 1000) / 1000, changes: chg.length,
    threshold: INCOME_FIXED_RATE_MIN_REPEAT,
  };

  if (out.distributionKind === 'variable') {
    const r = 'variable distribution — this fund passes through what it collects, so the amount moves '
      + `almost every period (${Math.round(zeroFrac * 100)}% of consecutive payments repeat, against the `
      + `${Math.round(INCOME_FIXED_RATE_MIN_REPEAT * 100)}% a declared fixed rate clears). A period-over-period `
      + 'decline is a distribution fluctuation, not a cut, and a point-to-point 5y ratio is two noisy draws. '
      + '`ttmRate` and `ttmSum5yAgo` are shipped as the raw inputs.';
    out.growth5yReason = r;
    out.cutReason      = r;
    return out;
  }

  // ── Fixed rate: a decline IS a cut, because the amount otherwise repeats. ──
  if (prior == null) {
    out.cutReason = 'only one payment on record — nothing to compare it against';
  } else {
    out.cut = last.amount < prior.amount;
    /* ONLY populated when `cut` is true. It read `lastVsPriorPct` unconditionally,
       so JNJ — which RAISED — shipped `cut: false, cutPct: 3.08`: a positive
       number under a field named for a cut. The signed change is already
       `lastVsPriorPct` and is shipped either way. */
    out.cutPct = out.cut ? out.lastVsPriorPct : null;
    out.cutReason = null;
  }

  // ── Fixed rate: 5y growth, point to point, only on a real 5y anchor. ──
  const target = last.date - INCOME_GROWTH_YEARS * 365.25 * 86400;
  let anchor = null, best = Infinity;
  for (const p of list) {
    const gap = Math.abs((p.date - target) / 86400);
    if (gap < best) { best = gap; anchor = p; }
  }
  if (!anchor || best > INCOME_GROWTH_MATCH_DAYS) {
    out.growth5yReason = `history spans ${out.divHistorySpanYears}y and the nearest payment to the `
      + `${INCOME_GROWTH_YEARS}-year anchor is ${Math.round(best)} days away (tolerance `
      + `${INCOME_GROWTH_MATCH_DAYS}d) — not enough to state a ${INCOME_GROWTH_YEARS}-year growth rate`;
  } else if (!(anchor.amount > 0)) {
    out.growth5yReason = `the payment ${INCOME_GROWTH_YEARS} years ago was ${anchor.amount}, so a growth rate is undefined`;
  } else {
    const cagr = Math.pow(last.amount / anchor.amount, 1 / INCOME_GROWTH_YEARS) - 1;
    out.growth5y = Math.round(cagr * 10000) / 100;   // percent
    out.growth5yFrom = { amount: anchor.amount, exDate: isoOfUnix(anchor.date) };
    out.growth5yReason = null;
  }
  return out;
}

/** Build one cold row: 1 crumbed quoteSummary + 1 dividend chart. */
async function incomeRow(sym, env) {
  const [qsRes, divRes] = await Promise.allSettled([
    yahooAuth(
      `/v10/finance/quoteSummary/${encodeURIComponent(sym)}`,
      '?modules=price,summaryDetail,defaultKeyStatistics,calendarEvents',
      env,
    ),
    incomeDividendHistory(sym),
  ]);

  const res = qsRes.status === 'fulfilled' ? (qsRes.value?.quoteSummary?.result?.[0] || {}) : null;
  const divList = divRes.status === 'fulfilled' ? divRes.value : null;

  if (!res && divList == null) {
    return {
      symbol: sym.toUpperCase(), schema: INCOME_SCHEMA, ts: Date.now(), ok: false,
      status: 'no-data',
      reason: `both upstream reads failed — quoteSummary: ${qsRes.reason?.message || 'n/a'}; `
            + `dividend history: ${divRes.reason?.message || 'n/a'}`,
    };
  }

  const sd = res?.summaryDetail || {};
  const ks = res?.defaultKeyStatistics || {};
  const ce = res?.calendarEvents || {};
  const pr = res?.price || {};

  /* YIELD — the field that carries it depends on the instrument, so the field
     that decided the number ships with it rather than being assumed. */
  let dividendYield = incNum(sd.dividendYield), dividendYieldSource = 'summaryDetail.dividendYield';
  if (dividendYield == null) { dividendYield = incNum(sd.yield); dividendYieldSource = 'summaryDetail.yield'; }
  if (dividendYield == null) { dividendYield = incNum(ks.yield); dividendYieldSource = 'defaultKeyStatistics.yield'; }
  if (dividendYield == null) dividendYieldSource = null;
  else dividendYield = Math.round(dividendYield * 10000) / 100;   // decimal -> percent

  let payoutRatioRaw = incNum(sd.payoutRatio);
  const facts = incomeDividendFacts(divList || []);

  /* Yahoo's trailing rate, and the ETF zero it fabricates. A 0 against a history
     that plainly shows payments is a vendor artifact, not a fact about the fund. */
  let trailingAnnualDividendRate = incNum(sd.trailingAnnualDividendRate);
  let trailingRateNote = null;
  if (trailingAnnualDividendRate === 0 && facts.ttmRate) {
    trailingRateNote = `Yahoo reports trailingAnnualDividendRate 0 while the dividend history shows `
      + `${facts.ttmRate} paid over the trailing 12 months — a known vendor artifact on funds. `
      + 'Suppressed rather than shipped as a fact; read `ttmRate`, which is summed from the history.';
    trailingAnnualDividendRate = null;
  }

  /* A NON-PAYER RENDERS "no dividend", NEVER ZEROS. Yahoo hands back
     `trailingAnnualDividendRate: 0` and `payoutRatio: 0` for TSLA — arithmetically
     defensible and, on screen, a measured 0% payout sitting next to a measured
     $0.00 rate. There is nothing to measure: the company pays nothing. Both are
     suppressed and `noDividendNote` says which state this is. */
  let noDividendNote = null;
  if (!facts.paysDividend) {
    noDividendNote = `No dividend. ${divList == null ? 'The dividend history could not be read' : `Yahoo's dividend history carries no payment in the ${INCOME_DIV_RANGE} window read`}`
      + `, so the yield, trailing rate and payout ratio are suppressed rather than shipped as zeros`
      + `${trailingAnnualDividendRate === 0 || payoutRatioRaw === 0 ? ' (Yahoo returns 0 for both)' : ''}.`;
    trailingAnnualDividendRate = null;
    payoutRatioRaw = null;
    trailingRateNote = null;
    dividendYield = null;
    dividendYieldSource = null;
  }

  const exDivUnix = incNum(sd.exDividendDate) ?? incNum(ce.exDividendDate);
  const exDivDate = isoOfUnix(exDivUnix);
  /* THE REASON MUST NAME ITS OWN CAUSE (honesty rule 17). This said "Yahoo
     publishes none for any ETF" on TSLA — an EQUITY that simply pays no
     dividend. Three different states, three different sentences. */
  const exDivReason = exDivDate ? null
    : !facts.paysDividend
      ? 'no dividend is paid, so there is no ex-dividend date to publish'
      : (pr.quoteType === 'ETF' || pr.quoteType === 'MUTUALFUND')
        ? `Yahoo publishes no exDividendDate for funds — it returned none for any of SCHD, JEPQ or VYM. `
          + `The last ex-div this fund actually went through is \`lastDivExDate\` (${facts.lastDivExDate}); `
          + 'the NEXT one is deliberately NOT estimated from the payment cadence, because a projected '
          + 'date renders identically to a declared one.'
        : 'Yahoo published no exDividendDate for this symbol. The next one is deliberately NOT estimated '
          + 'from the payment cadence, because a projected date renders identically to a declared one.';

  return {
    symbol: sym.toUpperCase(), schema: INCOME_SCHEMA, ts: Date.now(), ok: true, status: 'ok',
    name: pr.longName || pr.shortName || null,
    quoteType: pr.quoteType || null,
    quotePrice: incNum(pr.regularMarketPrice),      // as of THIS build; the batch overlays live
    dividendYield, dividendYieldSource,
    trailingAnnualDividendRate, trailingRateNote,
    payoutRatio: payoutRatioRaw == null ? null : Math.round(payoutRatioRaw * 10000) / 100,   // percent
    exDivDate, exDivReason,
    noDividendNote,
    yahooLastDividendValue: incNum(ks.lastDividendValue),
    yahooLastDividendDate:  isoOfUnix(incNum(ks.lastDividendDate)),
    ...facts,
    partial: !res || divList == null,
    partialReason: !res ? `quoteSummary failed — ${qsRes.reason?.message}`
      : divList == null ? `dividend history failed — ${divRes.reason?.message}` : null,
  };
}

async function readIncomeRow(sym, env) {
  try {
    const row = await env?.REC_LOG?.get(incomeKey(sym), 'json');
    return row && row.schema === INCOME_SCHEMA ? row : null;   // strict equality
  } catch (_) { return null; }
}

/**
 * GET /api/income/batch?symbols=
 *
 * The row's SLOW half (yield, payout, dividend history, published ex-div) is
 * cached `INCOME_FRESH_MS` and retained `INCOME_ROW_TTL` — the two differ on
 * purpose, same as `premium:` and `long:`: evicting at the freshness horizon
 * leaves nothing to render AS stale, and a 7-hour-old payout ratio badged stale
 * beats a blank row.
 *
 * The FAST half (price, change, trend, and therefore `inAddZone`) is taken LIVE
 * from the spark on every request — one fetch per 20 names — and carries its own
 * `priceAsOf`. A 6-hour-old price would make `inAddZone` a fiction, and that
 * event is the whole reason `addBelow` exists.
 */
async function handleIncomeBatch(symbols, origin, env, params) {
  const mark = instrMark();
  const requested = symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const tickers = [...new Set(requested)].filter(t => REC_SYMBOL_RE.test(t)).slice(0, INCOME_MAX_SYMBOLS);
  if (!tickers.length) return err('symbols required', 400, origin);
  const force = params?.get('refresh') === '1';

  // `addBelow` is user data and comes from the saved sleeve — one KV read.
  const sleeve = await readIncomeSleeve(env);

  await getYahooCrumb(env).catch(() => {});
  const sparkPromise = yahooSparkCloses(tickers, '1y', 4, { withTimestamps: true }).catch(() => new Map());

  const rows = {};
  const CHUNK = 4;   // same reason as the watchlist batch: do not fan out at Yahoo
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const batch = tickers.slice(i, i + CHUNK);
    await allSettledCounted(batch.map(async (t) => {
      let row = force ? null : await readIncomeRow(t, env);
      let cachedAge = row ? Date.now() - (row.ts || 0) : null;
      if (!row || cachedAge >= INCOME_FRESH_MS) {
        const fresh = await incomeRow(t, env).catch(e => ({
          symbol: t, schema: INCOME_SCHEMA, ts: Date.now(), ok: false, status: 'no-data',
          reason: `row build failed — ${e.message}`,
        }));
        /* A failed build must not evict a good stale row: a labelled 7-hour-old
           yield beats a blank cell (honesty rule 24). Only a successful build
           is written. */
        if (fresh.ok) {
          try { await env?.REC_LOG?.put(incomeKey(t), JSON.stringify(fresh), { expirationTtl: INCOME_ROW_TTL }); }
          catch (e) { console.warn(`[income] cache write failed for ${t}:`, e.message); }
          row = fresh;
        } else if (!row) {
          row = fresh;
        }
      }
      rows[t] = row;
    }), 'income:rows');
  }

  const spark = await sparkPromise;
  const etToday = etDateToday();
  const out = [];
  for (const t of tickers) {
    const row = rows[t] || { symbol: t, schema: INCOME_SCHEMA, ok: false, status: 'not-loaded', ts: null,
      reason: 'the row was neither cached nor built on this request' };

    // ── Live half, from the spark. ──
    const s = spark.get(t);
    const closes = Array.isArray(s?.closes) ? s.closes : [];
    const stamps = Array.isArray(s?.timestamps) ? s.timestamps : null;
    let price = null, prevClose = null, chgPct = null, priceAsOf = null;
    if (closes.length) {
      price = closes[closes.length - 1];
      priceAsOf = stamps ? isoOfUnix(stamps[stamps.length - 1]) : null;
      if (closes.length >= 2) {
        prevClose = closes[closes.length - 2];
        if (prevClose > 0) chgPct = Math.round((price - prevClose) / prevClose * 10000) / 100;
      }
    }
    /* SMA200 over COMPLETED closes: the final bar is dropped only when the spark's
       OWN timestamps say it is today's forming one. The window is decided by the
       same call's data, never by a second clock read. */
    let sma200 = null, aboveSma200 = null, trendReason = null;
    const settled = (stamps && priceAsOf === etToday) ? closes.slice(0, -1) : closes;
    if (settled.length >= 200) {
      sma200 = Math.round(settled.slice(-200).reduce((a, b) => a + b, 0) / 200 * 10000) / 10000;
      if (price != null) aboveSma200 = price > sma200;
    } else {
      trendReason = `${settled.length} completed daily closes available, 200 needed for a 200-day average`;
    }

    const saved = sleeve.byTicker.get(t) || null;
    const addBelow = saved?.addBelow ?? null;
    /* Rides along with `addBelow` for the same reason it does: both are user
       data from the sleeve, and the Diversify tab groups rows by `category`.
       Shipping one and not the other would leave the consumer fetching the
       sleeve separately to render a grouping it already has the rows for. */
    const category = saved?.category ?? null;
    const inAddZone = addBelow != null && price != null ? price <= addBelow : null;

    const exDivDaysAway = row.exDivDate ? daysBetweenIso(etToday, row.exDivDate) : null;
    const exDivIsPast   = row.exDivDate ? exDivDaysAway < 0 : null;

    // ── Events. A null input produces NO event — never a firing one. ──
    const events = [];
    if (exDivIsPast === false && exDivDaysAway <= INCOME_EXDIV_UPCOMING_DAYS) events.push('exDivUpcoming');
    if (row.cut === true) events.push('cut');
    if (row.payoutRatio != null && row.payoutRatio > INCOME_PAYOUT_HIGH_PCT) events.push('payoutHigh');
    if (inAddZone === true) events.push('inAddZone');

    const age = row.ts ? Date.now() - row.ts : null;
    out.push({
      ...row,
      ticker: t,
      price, prevClose, chgPct, priceAsOf,
      priceReason: closes.length ? null : 'the spark returned no closes for this symbol',
      sma200, aboveSma200, trendReason,
      exDivIsPast, exDivDaysAway,
      addBelow,
      category,
      addBelowSource: sleeve.entries ? 'income:tickers' : 'unavailable',
      categorySource: sleeve.entries ? 'income:tickers' : 'unavailable',
      inAddZone,
      events,
      /* Two ages, never one: the dividend half is cached and the price half is
         live, so one as-of for both would be a lie about whichever is older. */
      divAgeMs: age, stale: age == null ? true : age >= INCOME_FRESH_MS, freshMs: INCOME_FRESH_MS,
    });
  }

  const loaded = out.filter(r => r.ok).length;
  return json({
    schema: INCOME_SCHEMA,
    count: out.length, loaded,
    rows: out,
    dropped: requested.length - tickers.length,
    /* The sleeve's own state rides along, because `addBelow` — and therefore the
       `inAddZone` event — is silently absent when the sleeve is unreadable, and
       a silently absent event is indistinguishable from one that did not fire. */
    sleeve: { ok: !!sleeve.entries, count: sleeve.entries?.length ?? null, reason: sleeve.reason },
    categories: INCOME_CATEGORIES,
    gates: {
      exDivUpcomingDays: INCOME_EXDIV_UPCOMING_DAYS,
      payoutHighPct: INCOME_PAYOUT_HIGH_PCT,
      fixedRateMinRepeat: INCOME_FIXED_RATE_MIN_REPEAT,
      growthYears: INCOME_GROWTH_YEARS,
      freshMs: INCOME_FRESH_MS,
    },
    /* THE FIELD ITSELF IS OMITTED, not shipped as null — a null invites a column
       that renders "—" as though the value were merely pending. Only the note
       exists, so a consumer reaching for the value finds the reason instead. */
    taxCharacterNote: 'Qualified vs ordinary is NOT shipped and is not derivable here. No Yahoo module '
      + 'carries it, and it depends on the issuer\'s own 1099-DIV allocation and on the holder\'s holding '
      + 'period — neither of which this Worker can see. Omitted rather than estimated.',
    etToday,
    _instr: instrSince(mark, 'income-batch'),
    _meta: srcMeta('Yahoo quoteSummary + dividend history', {
      ok: loaded > 0, delayed: true, ttlSeconds: Math.round(INCOME_FRESH_MS / 1000), asOf: etToday,
      note: `${loaded}/${out.length} rows · dividends cached ${Math.round(INCOME_FRESH_MS / 3600000)}h · `
          + `price live · ${YAHOO_DELAY_NOTE}`,
    }),
  }, 200, origin);
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
/* ── GET /api/watchlist ──────────────────────────────────────────────────────
   Exists so a browser with an EMPTY localStorage can ADOPT the saved list rather
   than pushing its own defaults over it. Without this read there is no way for a
   fresh profile to tell "the server has 33 names" from "the server has nothing",
   and it guesses — which is how a new device silently reset the one key every
   sweep now depends on.

   Origin-gated only, like every other GET. It is not secret-gated: it returns the
   user's own ticker list to their own dashboard, and requiring the key here would
   make the adopt path fail exactly when the key is misconfigured — the moment it
   most needs to not overwrite anything. */
async function handleWatchlistList(origin, env) {
  let tickers = null, reason = null;
  try {
    const saved = await env?.REC_LOG?.get('watchlist:tickers', 'json');
    if (Array.isArray(saved) && saved.length) tickers = saved;
    else reason = saved == null ? 'no watchlist saved yet' : 'saved value is empty or not an array';
  } catch (e) {
    reason = `KV read failed — ${e.message}`;
  }
  return json({
    tickers, count: tickers?.length ?? 0, reason,
    _meta: srcMeta('Cloudflare KV', { ok: !!tickers, ttlSeconds: null }),
  }, 200, origin);
}

/* SHRINK GUARD. A save that replaces 33 names with 22 is indistinguishable from a
   legitimate edit down to 22 — same request, same shape — so this does NOT block.
   What it does is make the event visible and RECOVERABLE, which is what the
   DEFAULT_WATCHLIST deletion took away: before it, a clobbered watchlist still
   swept the defaults, so the damage was bounded. Now it is not.
     · the previous value is copied to `watchlist:prev` before every overwrite,
       giving a one-step undo
     · a shrink past SHRINK_WARN_PCT logs at WARN naming both counts
   Blocking was considered and rejected: the user is allowed to delete tickers,
   and a screen that refuses to save is worse than a log line. */
const WL_SHRINK_WARN_PCT = 0.30;

async function handleWatchlistSave(request, origin, env) {
  const body = await request.json().catch(() => null);
  const tickers = Array.isArray(body?.tickers)
    ? [...new Set(body.tickers.map(t => String(t).trim().toUpperCase()).filter(Boolean))].slice(0, 60)
    : null;
  if (!tickers || !tickers.length) return err('tickers required', 400, origin);

  let prev = null;
  try { prev = await env?.REC_LOG?.get('watchlist:tickers', 'json'); } catch (_) {}
  const prevCount = Array.isArray(prev) ? prev.length : 0;

  if (prevCount) {
    try {
      await env?.REC_LOG?.put('watchlist:prev', JSON.stringify({ tickers: prev, replacedAt: Date.now() }));
    } catch (e) { console.warn('[watchlist] prev snapshot failed:', e.message); }
  }
  if (prevCount && tickers.length < prevCount * (1 - WL_SHRINK_WARN_PCT)) {
    console.warn(`[watchlist] SHRINK: ${prevCount} -> ${tickers.length} names `
      + `(-${prevCount - tickers.length}). Legitimate if you deleted tickers; if a fresh browser `
      + 'pushed its defaults over a populated list, the previous value is in watchlist:prev. '
      + `Dropped: ${prev.filter(t => !tickers.includes(String(t).toUpperCase())).join(', ')}`);
  }

  await env?.REC_LOG?.put('watchlist:tickers', JSON.stringify(tickers));
  return json({ ok: true, count: tickers.length, previousCount: prevCount }, 200, origin);
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
        let swingPairs = [];

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

          /* Date-aligned pairs for the regression channel. ZERO ADDED SUBREQUEST
             COST — this is the `?range=3mo&interval=1d` response already fetched
             above, read a second way. Deliberately NOT built from `closes`: that
             array is filtered bare and carries no dates, so a dropped null bar is
             indistinguishable from a session that never existed and the forming-bar
             test would have nothing to test against. Timestamps are filtered on the
             SAME predicate as the closes so the two stay aligned — the pattern
             `yahooSparkCloses`' `withTimestamps` path already uses — and a length
             mismatch yields no pairs rather than a silently mispaired series. */
          const stamps = result?.timestamp;
          const rawCloses = q.close;
          if (Array.isArray(stamps) && Array.isArray(rawCloses) && stamps.length === rawCloses.length) {
            for (let i = 0; i < rawCloses.length; i++) {
              const c = rawCloses[i];
              if (c == null || !Number.isFinite(c) || !Number.isFinite(stamps[i])) continue;
              swingPairs.push({ iso: new Date(stamps[i] * 1000).toISOString().slice(0, 10), close: c });
            }
          }
        }

        let pe = null, forwardPE = null, targetLow = null, targetMean = null, targetHigh = null;
        let shortPct = null, earningsDate = null, daysToEarnings = null, sector = null;
        let sma50 = null, sma200 = null;
        // Session timing. Defaults are the no-data answer, not a guess: an absent
        // calendarEvents block leaves ts null and the session 'unknown'.
        let earningsTs = null, earningsSession = 'unknown', earningsIsEstimate = null;

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

          const cal = r.calendarEvents?.earnings;
          const epoch = cal?.earningsDate?.[0]?.raw;
          if (epoch) {
            const d = new Date(epoch * 1000);
            earningsDate   = `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}, '${String(d.getFullYear()).slice(2)}`;
            daysToEarnings = Math.ceil((d.getTime() - Date.now()) / 86_400_000);
          }
          // Read off the SAME `cal` object, so the timestamp, the formatted date
          // and the countdown all describe one report.
          ({ earningsTs, earningsSession } = earningsTimingFrom(cal));
          earningsIsEstimate = earningsIsEstimateFrom(cal);
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

        /* Regression channel, evaluated HERE rather than in the chart block above
           so it uses the same `price` the row renders — the quoteSummary price
           module overwrites the chart meta's quote a few lines up, and a σ
           distance measured against a price the column does not show would be an
           inconsistency nobody could see. Same reason `levelPct` below is
           computed at this point. */
        const swing = swingChannel(swingPairs, price);

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
          // Session timing. `earningsSession` is always one of 'bmo'|'amc'|
          // 'unknown' — never null — so a consumer cannot confuse "no field"
          // (an older Worker) with "we could not tell" (this one, saying so).
          earningsTs,
          earningsSession,
          earningsIsEstimate,
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
          // Regression channel. `swingSignal` is decided in the Worker against
          // SWING_Z_THRESHOLD; the page renders it, it never re-derives it.
          ...swing,
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
    // The Swing column's gate, shipped so the header tooltip can name the number
    // the signal was decided against instead of hardcoding a copy that drifts.
    // A payload without these two came from an older Worker — the page must say
    // "not shipped", never assume 1.5 (the frontend runs ahead of the Worker).
    swingThreshold: SWING_Z_THRESHOLD,
    swingBars:      SWING_REG_BARS,
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

  /* The opportunity/avoid universe. THIS SITE DEGRADES WORSE THAN THE SWEEPS DO:
     with the old `DEFAULT_WATCHLIST.join(', ')` and an empty list the prompt read
     "choose from: " — an empty constraint, which does not stop the model, it just
     stops constraining it. The briefing would name arbitrary tickers and look
     entirely normal. So an absent universe changes the INSTRUCTION rather than
     interpolating nothing: the model is told to return null and why. */
  const pickUniverse = await sweepUniverse(env, 'briefing opportunity/avoid', 60);
  const pickLine = pickUniverse && pickUniverse.length
    ? `For opportunity and avoid, choose from: ${pickUniverse.join(', ')}.`
    : 'There is no saved watchlist, so you have no universe to pick from. Return null for BOTH '
      + '"opportunity" and "avoid" — do NOT substitute tickers of your own choosing.';

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

newsCards must have exactly 8 items. ${pickLine}
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
   Covers exactly `watchlist:tickers` — the dashboard's own list and nothing
   more. Each ticker is written to analysis:{TICKER} for the batch endpoint to
   serve, so the consolidated recommendation renders instantly on page load. */
async function refreshWatchlistAnalyses(env) {
  /* This one SKIPS rather than refuses: it owns no dedup key, so there is
     nothing to poison, and the morning briefing around it still has value
     without per-ticker analyses. The error is logged either way. */
  const tickers = await sweepUniverse(env, 'watchlist analyses', 60);
  if (!tickers) return;

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
    // `complete` is the content term. Without it a placeholder written on a Claude
    // failure satisfied this check for two hours and killed the retry.
    if (existing && existing.complete && Date.now() - existing.ts < 7_200_000) {
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

  let eod, generated = true;
  try {
    const text    = await workerClaude(prompt, env, 500);
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    eod = JSON.parse(cleaned);
  } catch (e) {
    console.error('[cron] eod parse failed:', e.message);
    eod = { headline: `Market closed ${dateStr}`, body: 'Market data unavailable.' };
    generated = false;
  }

  /* TWO INDEPENDENT GUARDS, copied from generateDailySnapshot — a placeholder must
     not dedup itself out of the day's remaining firings. This wrote
     `ts: Date.now()` unconditionally and the dedup above tested freshness with no
     content term, so ONE Claude hiccup at 1:15pm left "Market data unavailable."
     on the card until tomorrow, with the second firing skipping and the invocation
     reporting a clean 200. Measured 2026-08-12: fire 2 skipped, identical hash.

     1. `ts: 0` on the placeholder, so the freshness test cannot match it.
     2. `complete` in the payload, which the dedup requires as well as freshness —
        so an old-shape record lacking the field also retries rather than sticking. */
  await env?.REC_LOG?.put(
    'daily:eod',
    JSON.stringify({
      ...eod,
      complete: generated,
      ts: generated ? Date.now() : 0,
      _instr: instrSince(mark, generated ? 'complete' : 'placeholder'),
    }),
    { expirationTtl: 86400 },
  );
  console.log(generated
    ? '[cron] eod summary saved'
    : '[cron] eod generation FAILED — wrote placeholder with ts:0 so the next firing retries');
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
  // Skips this SECTION on an empty universe; the pulse's narrative and movers do
  // not depend on it, so losing the whole midday job would be the worse trade.
  const tickers = (await sweepUniverse(env, 'midday watchlist state', 25)) || [];

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
        /* `/api/premium/*` is GONE — 410, not 404, and not silently absent.
           The screen became Lane F of the Long tab. A 404 would read as "wrong
           URL" to anyone with a stale bookmark or a cached frontend; 410 with the
           replacement named says the route was retired on purpose. The KV key
           `premium:{TICKER}` still exists but is now the shared IV/earnings
           header, not a row this route ever served. */
        case 'premium':
          return json({
            error: 'gone',
            message: 'The standalone premium screen was removed. Short premium is now Lane F '
              + '(defined-risk credit spreads) on the Long tab: GET /api/long/:ticker.',
            replacement: '/api/long/:ticker',
          }, 410, origin);
        case 'long':
          // `batch` is a KV read so the tab paints without touching Yahoo, and a
          // bare ticker is the only spender (capCost 13 warm, 18-20 cold - cold is
          // a range, see the measured table in CLAUDE.md). Never
          // fan out across the watchlist.
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
        /* Off-watchlist discovery. Origin-gated only — no Claude call anywhere
           on the path, so there is nothing for `aiGuard` to protect, and the
           only write is its own `radar:{PT-date}` day cache. */
        case 'radar':    return await handleRadar(origin, env, url.searchParams);
        /* The income sleeve. No Claude call anywhere in this feature, so the
           two reads are origin-gated only; `save` writes `income:tickers` and
           therefore takes `requireSecret`, the same rule as every other KV
           write. Nothing here is read by a cron — `income:tickers` is a
           SEPARATE list from `watchlist:tickers`, which is the only sweep
           universe. */
        case 'income':
          if (sub === 'batch') return await handleIncomeBatch(
            url.searchParams.get('symbols') || '', origin, env, url.searchParams,
          );
          if (sub === 'save') {
            if (request.method !== 'POST') return err('method not allowed', 405, origin);
            const g = requireSecret(request, env, origin);
            if (g) return g;
            return await handleIncomeSave(request, origin, env);
          }
          if (!sub || sub === 'list') return await handleIncomeList(origin, env);
          return err('unknown income route', 404, origin);
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
          // KV read only — zero outbound fetches and no Claude call, so it is
          // origin-gated like the other market reads and NOT behind aiGuard.
          // The request path for Market Mood cannot spend.
          if (sub === 'mood')       return await handleMarketMood(origin, env);
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
          // Read path for the adopt-on-empty bootstrap. Deliberately NOT
          // secret-gated — see the note on the handler.
          if (!sub || sub === 'list') return await handleWatchlistList(origin, env);
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

    let branch = 'idle';                        // in-window wakeup with no job due
    if (h === 6 && m < 30) {
      branch = 'morning-briefing';
      dispatchJob(ctx, 'morning-briefing', () => generateDailySnapshot(env));   // 6:00am PT
    } else if ((h === 11 && m >= 30) || h === 12) {
      branch = 'midday-pulse';
      dispatchJob(ctx, 'midday-pulse', () => generateMiddaySnapshot(env));      // 11:30am PT (retries to 1pm; KV dedup skips once complete)
    } else if (h === 13 && m >= 15 && m < 45) {
      branch = 'eod+iv-sweep+macro';
      dispatchJob(ctx, 'eod-summary', () => generateEODSummary(env));           // 1:15pm PT
      dispatchJob(ctx, 'iv-sweep', () => recordWatchlistIv(env));               // 1:15pm PT one IV sample per watchlist name
      /* 1:15pm PT, NOT the 2:00pm branch. `collectMoveSeries` runs at 2:00pm, so
         a macro record written here is 45 minutes old when the move sweep could
         read it, with no request-path race — the same no-race pattern already
         specified for the `gap` structural baseline reading `iv:{TICKER}:{DATE}`.
         Costs 1 external fetch (4 symbols, one spark chunk). Shares this
         invocation's subrequest budget with the two jobs above: `ctx.waitUntil`
         does not get its own. */
      dispatchJob(ctx, 'macro-state', () => collectMacroState(env));            // 1:15pm PT one macro state record
    } else if (h === 14 && m < 30) {
      branch = 'forward-returns+moves+mood';
      dispatchJob(ctx, 'forward-returns', () => fillForwardReturns(env));       // 2:00pm PT resolve 5/20-session forward returns
      // 2:00pm PT bank the historical move distribution. Placed on THIS branch and
      // not the 1:15pm EOD one because the daily bar is settled by now — see the
      // note on collectMoveSeries(). Both jobs share this invocation's subrequest
      // budget: ctx.waitUntil does not get its own.
      dispatchJob(ctx, 'move-series', () => collectMoveSeries(env));
      /* 2:00pm PT bank the candlestick mood board. On THIS branch for the same
         settlement reason as the move sweep: the bell rang at 1:00pm PT, so the
         bar this reads is final. Costs 15 chart fetches + 1 Anthropic call + 3
         binding ops; the branch now runs THREE jobs sharing one subrequest
         budget, so no per-job `_instr` from here is a measurement — see the cost
         note on collectMarketMood. */
      dispatchJob(ctx, 'market-mood', () => collectMarketMood(env));
    } else if (h === 10) {
      // Fires on all four firings of the hour: a slice is only 4 managers, so
      // four slices a day completes a 20-manager pass in ~1.3 days. 13F-HR lands
      // 45 days after quarter end, so that is ample.
      branch = '13f-slice';
      dispatchJob(ctx, '13f-slice', () => refresh13FIndexIfStale(env));         // 10:00am PT 13F index slice
    }

    console.log(
      `[cron] ${at} · ${via} · trading day · branch=${branch}` +
      (day.calendarStale ? ` · WARN holiday calendar ends ${NYSE_HOLIDAYS_THROUGH}, holidays no longer skipped` : ''),
    );
  },
};
