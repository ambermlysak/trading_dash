/* VERIFICATION DRIVER for the 7:15am PT post-open read.
 *
 * NOT one of the 19 check scripts and deliberately outside their total — it is
 * the `iv-capture.fixture.mjs` kind of thing: it hits the LIVE tape and the live
 * clock, so it cannot be a gate. It exists to print what the job actually does
 * on a real morning, against real Yahoo, through the real `scheduled()`.
 *
 * WHAT IT CAN AND CANNOT REACH.
 *  · It drives the REAL default export's `scheduled()` at a chosen PT instant,
 *    so the dispatch, the clock gate, the trading-day gate, the KV writes, the
 *    purge interaction and every arithmetic step are the shipped code.
 *  · Yahoo is LIVE. Every index, sector and watchlist number below came off the
 *    wire during this run.
 *  · ANTHROPIC IS NOT. There is no `.dev.vars` on a fresh clone and no key in
 *    the environment, so `api.anthropic.com` is intercepted: the PROMPT is
 *    captured verbatim (which is the thing worth checking — it is the complete
 *    set of numbers the model is permitted to use) and a STUB answer is
 *    returned so the write path completes. The stub is mechanical. IT IS NOT A
 *    MODEL ANSWER AND NOTHING HERE VERIFIES THAT THE MODEL OBEYS THE PROMPT'S
 *    HONESTY RULES — that needs a key and a real call, and it is reported as
 *    unverified rather than implied.
 *
 * Usage:  node postopen.verify.mjs [case]
 *   live        (default) today's PT date, 07:15, baseline from the live Worker
 *   no-baseline no `daily:snapshot` at all        -> baseline "none"
 *   stale       a frozen pre-open quote feed      -> refusal
 *   source-down the watchlist key is absent       -> complete:false, named
 *   synthetic   hand-chosen 6:00am levels, so the delta arithmetic is exact
 *   rerun       post-open first, then the 6:00am briefing's purge over it
 */
import worker from './worker.js';

const CASE = process.argv[2] || 'live';
const API  = 'https://stock-research-worker.ambermlysak.workers.dev/api';

/* ── A counting KV stub ─────────────────────────────────────────────────── */
function kv(seed = {}) {
  const store = new Map(Object.entries(seed));
  const ops = [];
  return {
    store, ops,
    async get(k, ty) { ops.push(['get', k]); const v = store.get(k); return v == null ? null : (ty === 'json' ? JSON.parse(v) : v); },
    async put(k, v, o) { ops.push(['put', k]); store.set(k, v); },
    async delete(k) { ops.push(['delete', k]); store.delete(k); },
    async list() { return { keys: [], list_complete: true }; },
  };
}

/* ── Intercept ONLY api.anthropic.com. Everything else goes to the wire. ──
 *
 * PLUS ONE HARNESS-SIDE WORKAROUND, STATED RATHER THAN HIDDEN, because "a
 * workaround adopted to make a test safe is evidence about production" and this
 * one is NOT: measured 2026-11-13 07:30 PT, Yahoo answers `curl` with 200 and
 * Node's `fetch` (undici) with 429 for the SAME url from the SAME ip — and
 * under Node the discriminator is the `User-Agent` header itself (no headers at
 * all: 200; any UA, including curl's own: 429). That is a property of undici's
 * client, not of this Worker's code: the deployed Worker sends `YAHOO_HEADERS`
 * through these same helpers and made 185 external fetches at 06:01 PT this
 * morning without one. So the UA is dropped for Yahoo HERE ONLY, so the harness
 * can reach the live tape at all. The real-runtime confirmation is a separate
 * `wrangler dev` run, which sends the real headers from workerd.
 */
const realFetch = globalThis.fetch;
const captured = { prompts: [], calls: 0 };
let stubAnswer = null;              // set per case; null => mechanical default
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (url.includes('finance.yahoo.com') && init?.headers) {
    const h = { ...init.headers };
    delete h['User-Agent']; delete h['user-agent'];
    init = { ...init, headers: h };
  }
  if (url.includes('api.anthropic.com')) {
    captured.calls++;
    let prompt = '';
    try { prompt = JSON.parse(init.body).messages[0].content; } catch (_) {}
    captured.prompts.push(prompt);
    const text = stubAnswer ?? stubText(prompt);
    return new Response(JSON.stringify({
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(input, init);
};

/* STUBS, not a model. Shape-dispatched on the prompt so the OTHER cron jobs on
   the 6:00am path (the briefing itself, the per-ticker analyses, the sector
   pre-warm) can complete too — which is what the `rerun` case needs in order to
   drive the REAL `generateDailySnapshot` and therefore the REAL
   `purgeStaleDailySlots` over a real stored post-open record.
   Nothing here proves anything about model behaviour. */
function mechanicalAnswer(prompt) {
  const line = (re) => (prompt.match(re) || [])[0] || '';
  return '[STUB ANSWER — not a model] '
    + line(/S&P 500 \(\^GSPC\): [^\n|]+/) + ' // '
    + line(/VIX term structure NOW: [^\n]+/) + ' // '
    + 'This paragraph was assembled mechanically by postopen.verify.mjs and is not a reading of anything.';
}
function stubText(prompt) {
  if (/POST-OPEN READ/.test(prompt))        return JSON.stringify({ body: mechanicalAnswer(prompt) });
  if (/morning market briefing/.test(prompt)) return JSON.stringify({
    headline: '[STUB] re-run briefing',
    open: { headline: '[STUB] open', body: '[STUB] open body' },
    newsCards: Array.from({ length: 8 }, (_, i) => ({ title: `[STUB] ${i}`, body: '[STUB]', tag: 'Macro' })),
    opportunity: { ticker: 'AAPL', reason: '[STUB]' },
    avoid: { ticker: 'TSLA', reason: '[STUB]' },
  });
  if (/"sectors"/.test(prompt))             return JSON.stringify({ sectors: [{ sector: 'Technology', etf: 'XLK', summary: '[STUB]' }] });
  if (/"rating"/.test(prompt) || /recommendation/.test(prompt)) return JSON.stringify({
    rating: 'HOLD', confidence: 50, recommendation: '[STUB]', drivers: ['[STUB]'], summary: '[STUB]' });
  return JSON.stringify({ body: '[STUB] unrecognised prompt shape' });
}

/* ── Fire the real scheduled() at a PT instant ──────────────────────────── */
async function fire(isoLocal, store, { quiet = false } = {}) {
  const logs = [];
  const o = { l: console.log, w: console.warn, e: console.error };
  console.log = console.warn = console.error = (...a) => { logs.push(a.join(' ')); if (!quiet) o.l(...a); };
  const jobs = [];
  const ctx = { waitUntil: p => jobs.push(p), passThroughOnException() {} };
  const t0 = Date.now();
  try {
    /* A DUMMY KEY, NOT A REAL ONE. `workerClaude` throws before it ever fetches
       when the key is unset, which would skip the interceptor and leave the
       prompt uncaptured — and the prompt is the artefact worth reading. The
       value is never sent anywhere: `api.anthropic.com` is intercepted above. */
    await worker.scheduled({ scheduledTime: Date.parse(isoLocal), cron: '*/15 12-22 * * *' },
                           { REC_LOG: store, ANTHROPIC_API_KEY: 'not-a-key-interceptor-answers' }, ctx);
    await Promise.allSettled(jobs);
  } finally {
    Object.assign(console, { log: o.l, warn: o.w, error: o.e });
  }
  return { logs, jobs: jobs.length, wallMs: Date.now() - t0 };
}

const pad = (s, n) => String(s).padEnd(n);
const hdr = s => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);

/* ── PT helpers, independent of worker.js so they are a second opinion ──── */
const ptIso = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);
const ptClock = ms => new Date(ms).toLocaleString('en-US', {
  timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' PT';

/* Today at a given PT wall-clock, as an absolute instant — offset read from the
   zone itself rather than hardcoded, so this works under PST and PDT alike. */
function ptInstant(hh, mm) {
  const today = ptIso();
  const probe = new Date(`${today}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  const offMin = (new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }))
                - new Date(probe.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))) / 60000;
  return new Date(probe.getTime() + offMin * 60000).toISOString();
}

/* ── Seed: today's REAL daily:snapshot off the deployed Worker ──────────── */
async function liveSnapshot() {
  const r = await realFetch(`${API}/daily`, { headers: { Origin: 'https://ambermlysak.github.io' } });
  const j = await r.json();
  const { eod, eodLoading, midday, middayLoading, postOpen, loading, _meta, ...snap } = j;
  return snap;
}

/* The 06:00 levels block, built from the SAME endpoint and the SAME field
   extraction `generateDailySnapshot` uses. Used only by the `synthetic` case. */
const SNAP_SYMS = {
  '^GSPC': 'S&P 500', '^IXIC': 'NASDAQ', '^DJI': 'Dow Jones', '^RUT': 'Russell 2000',
  'ES=F': 'S&P Futures', 'NQ=F': 'NQ Futures', 'GC=F': 'Gold', 'SI=F': 'Silver',
  'CL=F': 'WTI Oil', '^TNX': '10Y Yield', '^VIX': 'VIX',
};
async function pullLevels() {
  const out = {};
  await Promise.all(Object.keys(SNAP_SYMS).map(async (t) => {
    try {
      const r = await realFetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=1d&interval=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
      const m = (await r.json())?.chart?.result?.[0]?.meta || {};
      const price = m.regularMarketPrice, prev = m.chartPreviousClose ?? m.previousClose;
      if (price == null || prev == null) return;
      out[t] = { label: SNAP_SYMS[t], price: Math.round(price * 10000) / 10000,
                 prevClose: Math.round(prev * 10000) / 10000,
                 changePct: Math.round((price - prev) / prev * 10000) / 100,
                 marketTime: Number.isFinite(m.regularMarketTime) ? m.regularMarketTime * 1000 : null };
    } catch (_) {}
  }));
  return out;
}

/* ── /api/daily, composed the way handleDailyGet composes it ────────────── */
async function dailyObject(store) {
  const g = async k => { const v = store.store.get(k); return v == null ? null : JSON.parse(v); };
  const snap = await g('daily:snapshot');
  return { ...(snap || {}), eod: await g('daily:eod'), midday: await g('daily:midday'),
           postOpen: await g('daily:postopen') };
}
function diffDaily(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const rows = [];
  for (const k of keys) {
    const a = JSON.stringify(before[k]), b = JSON.stringify(after[k]);
    rows.push({ key: k, changed: a !== b, beforeBytes: a == null ? 0 : a.length, afterBytes: b == null ? 0 : b.length });
  }
  return rows;
}

/* ═══════════════════════════════════════════════════════════════════════ */
const WATCHLIST = JSON.stringify(['AAPL', 'NVDA', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AMD',
                                  'AVGO', 'JPM', 'XOM', 'UNH', 'COST', 'NFLX', 'CRM']);

/* ISOLATION. 07:15 PT is inside morning-rows' window, so a bare firing runs BOTH
   jobs and no per-job `_instr` from it is a measurement — it is an upper bound on
   the job and a lower bound on the invocation (rule #1). Seeding
   `morningrows:last` with today's PT date dedups that sweep out, which leaves the
   post-open read ALONE on the invocation and makes its `_instr` a real
   measurement. Pass `--shared` to see the other case. */
const ISOLATE = !process.argv.includes('--shared');

const seedBase = async () => {
  const snap = await liveSnapshot();
  return {
    'daily:snapshot': JSON.stringify(snap),
    'watchlist:tickers': WATCHLIST,
    ...(ISOLATE ? { 'morningrows:last': ptIso() } : {}),
  };
};

hdr(`CASE: ${CASE}   ·   PT date ${ptIso()}   ·   fired at 07:15 PT = ${ptInstant(7, 15)}`
  + `\n${ISOLATE ? 'ISOLATED — morning-rows deduped out, so _instr IS a measurement of this job'
                 : 'SHARED — morning-rows runs too, so _instr is an upper bound on the job'}`);

let seed = await seedBase();
let fireAt = ptInstant(7, 15);

if (CASE === 'no-baseline') {
  delete seed['daily:snapshot'];
} else if (CASE === 'source-down') {
  delete seed['watchlist:tickers'];
} else if (CASE === 'stale') {
  /* FORCE THE REFUSAL. Yahoo's spark responses are rewritten on the way back so
     every `regularMarketTime` reads 06:01 PT — a pre-open print. Nothing else is
     touched: the prices are the real ones, which is the point. The job must
     refuse on the AS-OF alone. */
  const preOpen = Math.floor(Date.parse(ptInstant(6, 1)) / 1000);
  const f = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const res = await f(input, init);
    if (!url.includes('/v7/finance/spark')) return res;
    const d = await res.json();
    for (const it of (d?.spark?.result || [])) {
      if (it?.response?.[0]?.meta) it.response[0].meta.regularMarketTime = preOpen;
    }
    return new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
} else if (CASE === 'synthetic') {
  /* HAND-CHOSEN 6:00am LEVELS so the since-6:00am arithmetic is exactly
     checkable rather than approximately zero. Real symbols, invented prices. */
  const snap = JSON.parse(seed['daily:snapshot']);
  snap.marketLevels = {
    '^GSPC': { label: 'S&P 500',   price: 7500.00, prevClose: 7592.40, changePct: -1.22, marketTime: Date.parse(ptInstant(6, 1)) },
    '^VIX':  { label: 'VIX',       price: 20.00,   prevClose: 18.70,   changePct: 6.95,  marketTime: Date.parse(ptInstant(6, 1)) },
    '^TNX':  { label: '10Y Yield', price: 5.0000,  prevClose: 5.103,   changePct: -2.02, marketTime: Date.parse(ptInstant(6, 1)) },
  };
  seed['daily:snapshot'] = JSON.stringify(snap);
} else if (CASE === 'live') {
  /* The deployed Worker predates `marketLevels`, so today's real record carries
     none. Attach a block pulled from the SAME endpoint and the SAME extraction
     the briefing uses, stamped with its real pull time — which is NOW, not
     06:00. The since-6:00am deltas in this case are therefore near zero BY
     CONSTRUCTION; what it verifies is the shape and the plumbing, not the
     magnitude. The `synthetic` case is where the arithmetic is checked. */
  const snap = JSON.parse(seed['daily:snapshot']);
  snap.marketLevels = await pullLevels();
  console.log(`seeded marketLevels for ${Object.keys(snap.marketLevels).length} symbols `
    + `(pulled ${ptClock(Date.now())}, NOT 06:00 — see the note in this file)`);
  seed['daily:snapshot'] = JSON.stringify(snap);
}

const store = kv(seed);
const before = await dailyObject(store);

hdr('BEFORE  /api/daily');
console.log(JSON.stringify(before, null, 1).slice(0, 1400));

hdr('FIRING scheduled()');
const run = await fire(fireAt, store);
console.log(`\njobs dispatched: ${run.jobs} · wall ${run.wallMs}ms`);

const after = await dailyObject(store);

hdr('DIFF  — only postOpen may differ');
for (const r of diffDaily(before, after)) {
  console.log(`  ${pad(r.key, 12)} ${r.changed ? 'CHANGED' : 'identical'}  ${r.beforeBytes}B -> ${r.afterBytes}B`);
}

hdr('THE postOpen SLOT AS WRITTEN');
const po = after.postOpen;
if (!po) { console.log('  (absent)'); }
else {
  const { body, ...rest } = po;
  console.log(JSON.stringify(rest, null, 1));
  console.log(`\n  body (${body.length} chars):\n  ${body}`);
  console.log(`\n  dataAsOf -> ${po.dataAsOf ? ptClock(po.dataAsOf) : 'null'}`);
  console.log(`  ts       -> ${ptClock(po.ts)}`);
}

hdr('KV OPERATIONS ISSUED BY THIS RUN');
const counts = {};
for (const [op, k] of store.ops) counts[`${op} ${k}`] = (counts[`${op} ${k}`] || 0) + 1;
for (const [k, n] of Object.entries(counts)) console.log(`  ${pad(k, 36)} x${n}`);
console.log(`  TOTAL binding ops: ${store.ops.length}`);
console.log(`  Anthropic calls intercepted: ${captured.calls}`);

if (captured.prompts.length) {
  hdr('THE PROMPT THE MODEL WOULD RECEIVE  (every number it is permitted to use)');
  console.log(captured.prompts[captured.prompts.length - 1]);
}

if (CASE === 'rerun') {
  hdr('RE-RUN: the REAL 6:00am briefing job fires AFTER the post-open read');
  /* The spec'd requirement: "A manual re-run of the 6:00am briefing job must not
     drop postOpen{}." Driven through the real `generateDailySnapshot`, which
     writes its own slot and then calls the real `purgeStaleDailySlots` — the one
     function that is allowed to delete a sibling, and only on a PT-date
     rollover. Same PT day here, so it must delete nothing. */
  /* AGE THE SEEDED SNAPSHOT PAST THE BRIEFING'S OWN 2h DEDUP, keeping `ptDate`
     on today. Without this the re-run logs "snapshot fresh, skipping" and never
     reaches the purge — which is a pass that proves nothing. This is exactly the
     2026-08-19 shape: a same-PT-day regeneration of a snapshot that has gone
     stale by the clock. */
  {
    const s = JSON.parse(store.store.get('daily:snapshot'));
    s.ts = Date.now() - 3 * 3600_000;
    store.store.set('daily:snapshot', JSON.stringify(s));
    console.log(`  snapshot ts aged to ${ptClock(s.ts)} (ptDate still ${s.ptDate}) so the 2h dedup cannot skip`);
  }
  const snapshotBefore = store.store.get('daily:snapshot');
  const poBefore       = store.store.get('daily:postopen');
  console.log(`  postOpen bytes before the re-run: ${poBefore ? poBefore.length : 'ABSENT'}`);
  const deletesBefore = store.ops.filter(o => o[0] === 'delete').length;

  const rerun = await fire(ptInstant(6, 0), store, { quiet: true });
  for (const l of rerun.logs.filter(l => /daily slots|snapshot saved|branch=/.test(l))) console.log(`  [cron] ${l}`);

  const poAfter = store.store.get('daily:postopen');
  console.log(`\n  postOpen bytes after the re-run:  ${poAfter ? poAfter.length : 'ABSENT'}`);
  console.log(`  postOpen SURVIVED:                ${poAfter != null}`);
  console.log(`  postOpen BYTE-IDENTICAL:          ${poBefore === poAfter}`);
  console.log(`  snapshot was in fact REWRITTEN:   ${store.store.get('daily:snapshot') !== snapshotBefore}`);
  console.log(`  deletes issued by the re-run:     ${store.ops.filter(o => o[0] === 'delete').length - deletesBefore}`);
  console.log('\n  postOpen body after the re-run:');
  console.log(`  ${poAfter ? JSON.parse(poAfter).body.slice(0, 160) : '(gone)'}`);
}

hdr('DONE');
