/* Long-row RETENTION, the 7:00am PT row sweep, and the `longarch:` sweep archive
 * — the three changes of 2026-08-31, which are one class of fix: retention that
 * survives the writer's own schedule gaps, and snapshots that survive their own
 * overwrites.
 *
 * WHY THIS EXISTS. Monday 2026-08-31, 8am PT: the entire Options surface read
 * "not loaded". Friday's 1:15pm PT sweep had written a `long:{TICKER}` row for
 * every watchlist name; `LONG_ROW_TTL` was 24h and the cron gate skips weekends,
 * so every key was evicted on the Saturday afternoon and nothing rewrote them
 * before Monday 1:15pm. Separately, Friday's GOOGL row carried a Lane B Oct 360
 * call at E[R] 165% against Monday's 14-19% on the same expiry — and the Friday
 * row was gone, because `long:{TICKER}` is one key overwritten in place, so every
 * computation destroys the evidence of the last one.
 *
 * Sections:
 *   1. The constants, and the KEY SHAPE. `longarch:` and `long:` must be
 *      DISJOINT prefixes — the whole reason the archive is not
 *      `long:{TICKER}:{DATE}` — and the dedup stamp must sit outside every
 *      scanned prefix. Asserted on the strings, not on the intent.
 *   2. `LONG_ROW_TTL`, RE-DERIVED FROM THE CALENDAR RATHER THAN RESTATED. The
 *      gap is computed from real Date arithmetic and then compared against BOTH
 *      the old value and the new one — a test that only shows 7d clears the gap
 *      would pass on any large number and would not show that 24h did not.
 *   3. THE THREE GUARDS THAT MAKE LONGER RETENTION SAFE, both behaviourally and
 *      at source level. Retention only got longer because nothing that RANKS or
 *      SCORES can reach an aged row; if any of the three goes, the TTL is no
 *      longer safe and this is where that has to show up. A behavioural test
 *      cannot see a guard deleted six months from now — a source assertion can.
 *   4. `archiveSweptRows` against stub bindings: verbatim bytes, the TTL, both
 *      slots, a REUSED row keeping its own `ts`, a KV failure reported rather
 *      than thrown, and every refusal path.
 *   5. THE READ ROUTE, driven through the REAL module. `?date=&slot=` must serve
 *      the stored bytes unchanged, write nothing, read exactly one key, carry no
 *      `macro`, and — the one that matters — must NOT fall through to a live
 *      refetch on a miss, which would answer today's question under a past
 *      date's URL.
 *   6. DISPATCH, driven through the REAL `scheduled()`, offline. Hour 7 is the
 *      new branch; 7:30 and 8:00 must stay idle; the weekend and holiday gate is
 *      upstream and must still swallow it. Plus the whole branch->jobs table
 *      lifted from source, which is what pins "the 1:15pm branch gained nothing".
 *   7. STRUCTURAL ATTRIBUTION. `collectMorningRows` must not contain a single
 *      reference to `collectTop3`, `top3Key` or `TOP3_SWEEP_KEY`: that dedup is a
 *      PT-date compare, so a 7am stamp on it would make the 1:15pm firing log
 *      "already built today" and silently replace the day's post-close ranking
 *      with one priced off opening spreads. No behavioural test can see that
 *      line being added later; this can.
 *
 * BLIND SPOTS, stated up front:
 *   · Nothing here touches Yahoo, so it cannot measure the sweep's real cost or
 *     wall time. The ~20 capCost/name and ~800 at N~=40 in CLAUDE.md are
 *     DERIVATIONS awaiting the first live 7am firing, whose `_instr` IS a
 *     measurement because that branch carries one job.
 *   · §6 drives only the hours whose jobs refuse offline (7 and the idle/closed
 *     cases). The other branches would spend real fetches, so they are pinned
 *     from SOURCE in §6c instead of by dispatch.
 *   · This script cannot tell you the archive is worth its ~78 writes/day. It can
 *     only tell you the writes go where they are supposed to.
 *
 * Run:  node longarch.check.mjs
 */
import fs from 'fs';
import { tally, record, reportVerdict, populated } from './check-harness.mjs';

/* Importing the real module is ALSO the parse check that `node --check` cannot
   perform: worker.js is an ES module, `node --check` parses it as a CommonJS
   script, and a duplicate `let`/`const` in one scope is not an error there. That
   gap gave a clean exit 0 on a file `workerd` refused to boot — and it did so
   again while this very change was being written. */
import worker from './worker.js';

const src = fs.readFileSync('worker.js', 'utf8');

function grab(name) {
  let i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('missing ' + name);
  if (src.slice(i - 6, i) === 'async ') i -= 6;
  let p = src.indexOf('(', i), depth = 0, j = p;
  do { if (src[j] === '(') depth++; else if (src[j] === ')') depth--; j++; } while (depth > 0);
  let d = 0, k = src.indexOf('{', j);
  do { if (src[k] === '{') d++; else if (src[k] === '}') d--; k++; } while (d > 0);
  return src.slice(i, k);
}
/* Disambiguating, as in top3.check.mjs: `\nconst LONGARCH_TTL` must not be
   satisfied by `LONGARCH_TTL_SOMETHING`, and grabbing the wrong constant would
   make every downstream comparison meaningless in the most confident way. */
function grabConst(name) {
  const key = '\nconst ' + name;
  let i = -1, from = 0;
  for (;;) {
    i = src.indexOf(key, from);
    if (i < 0) throw new Error('missing const ' + name);
    if (/[\s=]/.test(src[i + key.length])) break;
    from = i + 1;
  }
  return src.slice(i + 1, src.indexOf(';', i + key.length) + 1);
}

/* Stubs for the three things `top3Sweep` reaches out to, declared AHEAD of it in
   the generated module so its unqualified references resolve here. Nothing below
   touches the network or KV. */
const SWEEP_STUBS = `
let __cached = {}, __refresh = {}, __refreshCalls = [];
async function getYahooCrumb() { return 'stub'; }
async function readLongRow(sym) { return __cached[sym] ?? null; }
async function refreshLongTicker(sym) { __refreshCalls.push(sym); return __refresh[sym]?.() ?? null; }
function __setStubs(c, r) { __cached = c; __refresh = r; __refreshCalls = []; }
function __refreshed() { return __refreshCalls; }
`;

const M = new Function([
  grabConst('LONG_SCHEMA'), grabConst('LONG_FRESH_MS'), grabConst('LONG_ROW_TTL'),
  grabConst('LONGARCH_TTL'), grabConst('LONGARCH_SLOTS'), grabConst('LONGARCH_DATE_RE'),
  grabConst('longArchKey'), grabConst('longKey'),
  grabConst('TOP3_TTL'), grabConst('MOVES_TTL'),
  grabConst('TOP3_DOMAIN_STATUSES'), grabConst('TOP3_SYSTEMIC_FAIL_RUN'),
  grabConst('TOP3_SWEEP_WALL_WARN_MS'),
  grabConst('MORNING_ROWS_KEY'), grabConst('MORNING_ROWS_STAMP_TTL'),
  grab('archiveSweptRows'),
  SWEEP_STUBS,
  grab('top3Sweep'),
  `return { LONG_SCHEMA, LONG_FRESH_MS, LONG_ROW_TTL, LONGARCH_TTL, LONGARCH_SLOTS,
            LONGARCH_DATE_RE, longArchKey, longKey, TOP3_TTL, MOVES_TTL,
            MORNING_ROWS_KEY, MORNING_ROWS_STAMP_TTL,
            archiveSweptRows, top3Sweep, __setStubs, __refreshed };`,
].join('\n'))();

/* The REAL `readLongRow`, in its OWN module. It must not be in `M`: `top3Sweep`
   has to resolve that name against the stub above, and a second declaration of it
   there would be a silent collision whose winner depends on declaration order —
   the module would still build and §3a would then be testing the wrong function. */
const R = new Function([
  grabConst('LONG_SCHEMA'), grabConst('longKey'), grab('readLongRow'),
  'return { readLongRow };',
].join('\n'))();

const t = tally();
const pad = (s, n) => String(s).padEnd(n);
const j = v => JSON.stringify(v);
function row(label, got, want, ok = j(got) === j(want)) {
  record(t, ok);
  console.log(`  ${pad(label, 56)} got ${pad(j(got), 30)} want ${pad(j(want), 30)} ${ok ? 'ok' : '<<< MISMATCH'}`);
}
const quiet = () => {
  const o = { l: console.log, w: console.warn, e: console.error };
  console.log = console.warn = console.error = () => {};
  return () => Object.assign(console, { log: o.l, warn: o.w, error: o.e });
};

const H = 3600;   // seconds in an hour, so the derivations below read as hours

console.log('\n== 1. CONSTANTS AND THE KEY SHAPE ===========================================\n');
{
  row('LONGARCH_TTL is 7d, in seconds', M.LONGARCH_TTL, 7 * 24 * H);
  row('LONGARCH_SLOTS', M.LONGARCH_SLOTS, ['open', 'eod']);
  row('slot count is exactly two', M.LONGARCH_SLOTS.length, 2);
  row('key shape, ticker upper-cased', M.longArchKey('googl', '2026-08-31', 'eod'),
      'longarch:GOOGL:2026-08-31:eod');
  row('the `open` slot builds a DIFFERENT key', M.longArchKey('GOOGL', '2026-08-31', 'open'),
      'longarch:GOOGL:2026-08-31:open');

  /* THE PREFIX RULE, ASSERTED BOTH DIRECTIONS. This is the entire reason the
     archive is not `long:{TICKER}:{DATE}` — a key inside another key's prefix
     corrupts any list() over it, the same rule that keeps `ivsweep:last` out of
     `iv:` and `incomerow:` out of `income:`. */
  row('longarch key does NOT start with the `long:` prefix',
      M.longArchKey('X', '2026-08-31', 'eod').startsWith('long:'), false);
  row('...and the row key DOES, so the prefixes are genuinely different things',
      M.longKey('X').startsWith('long:'), true);
  row('a long: prefix scan cannot see an archive key',
      [M.longKey('X'), M.longArchKey('X', '2026-08-31', 'eod')]
        .filter(k => k.startsWith('long:')).length, 1);

  row('LONGARCH_DATE_RE accepts an ISO PT date', M.LONGARCH_DATE_RE.test('2026-08-31'), true);
  for (const bad of ['2026-8-31', '26-08-31', '2026-08-31T00:00:00Z', '', 'yesterday']) {
    row(`...and rejects ${j(bad)}`, M.LONGARCH_DATE_RE.test(bad), false);
  }

  row('MORNING_ROWS_KEY', M.MORNING_ROWS_KEY, 'morningrows:last');
  row('MORNING_ROWS_STAMP_TTL is 2d, matching the sibling stamps',
      M.MORNING_ROWS_STAMP_TTL, 172800);
  /* The stamp must sit outside every prefix anything scans, and — the load-bearing
     half — it must NOT be `top3sweep:last`. §7 proves the function never writes
     that key; this proves the two names cannot be confused for each other. */
  for (const prefix of ['long:', 'longarch:', 'iv:', 'top3:', 'moves:', 'income:']) {
    row(`stamp is outside the ${prefix} prefix`, M.MORNING_ROWS_KEY.startsWith(prefix), false);
  }
  row('the morning stamp is NOT top3sweep:last', M.MORNING_ROWS_KEY === 'top3sweep:last', false);
}

console.log('\n== 2. LONG_ROW_TTL — the gap, RE-DERIVED from the calendar ==================\n');
{
  const OLD = 24 * H;                       // the value that produced the incident
  const hoursBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 3_600_000;

  /* (a) THE INCIDENT ITSELF. Friday's 1:15pm PT write, read Monday 8:00am PT.
         Both instants are PDT (UTC-7) and written as such, so the span is real
         clock time rather than a count of calendar boxes. */
  const weekend = hoursBetween('2026-08-28T13:15:00-07:00', '2026-08-31T08:00:00-07:00');
  row('Fri 13:15 PT -> Mon 08:00 PT, in hours', weekend, 66.75);
  row('...the OLD 24h did NOT cover it — the incident reproduces', OLD / H > weekend, false);
  row('...the NEW value does', M.LONG_ROW_TTL / H > weekend, true);

  /* (b) THE BINDING CASE, which is not the incident but the deepest gap the NYSE
         calendar produces around one missed run: a Thursday 1:15pm write read on
         the Tuesday morning after a Friday+Monday closure. */
  const binding = hoursBetween('2026-08-27T13:15:00-07:00', '2026-09-01T08:00:00-07:00');
  row('Thu 13:15 PT -> Tue 08:00 PT, in hours', binding, 114.75);
  row('...in days', +(binding / 24).toFixed(2), 4.78);
  row('the OLD 24h did not cover the binding case either', OLD / H > binding, false);
  row('7d covers it', M.LONG_ROW_TTL / H > binding, true);
  row('...with headroom for one more missed cron (>= 24h spare)',
      M.LONG_ROW_TTL / H - binding >= 24, true);

  /* (c) SAME CLASS, SAME FIGURE. The point of quoting TOP3_TTL and MOVES_TTL in
         the derivation is that they exist for this exact gap; if one of them
         moves and this does not, the claim in CLAUDE.md has quietly become false. */
  row('LONG_ROW_TTL === TOP3_TTL', M.LONG_ROW_TTL, M.TOP3_TTL);
  row('LONG_ROW_TTL === MOVES_TTL', M.LONG_ROW_TTL, M.MOVES_TTL);
  row('LONGARCH_TTL === LONG_ROW_TTL', M.LONGARCH_TTL, M.LONG_ROW_TTL);

  /* (d) RETENTION IS NOT FRESHNESS, and this change moved only one of them. The
         freshness/retention split is what lets a stale row still render, badged;
         collapsing them is the failure `premium:` and `incomerow:` are guarded
         against by the same rule. */
  row('LONG_FRESH_MS is still 4h', M.LONG_FRESH_MS, 4 * 3600_000);
  row('freshness and retention are NOT equal', M.LONG_ROW_TTL * 1000 === M.LONG_FRESH_MS, false);
  row('retention outlives freshness', M.LONG_ROW_TTL * 1000 > M.LONG_FRESH_MS, true);
  row('...by a factor of', Math.round(M.LONG_ROW_TTL * 1000 / M.LONG_FRESH_MS), 42);
}

console.log('\n== 3. THE THREE GUARDS THAT MAKE LONGER RETENTION SAFE ======================\n');
{
  /* (a) THE SWEEP REUSE GATE, behaviourally. A row older than LONG_FRESH_MS, or
         an `error` row of any age, must be REFETCHED rather than reused — which
         is what stops a 7-day-old row entering a sweep at all. */
  const okRow = (ts, status = 'ok') => ({ schema: 4, symbol: 'AAA', ok: status === 'ok', status, ts });
  const drive = async (cached) => {
    M.__setStubs({ AAA: cached }, { AAA: () => okRow(Date.now()) });
    const un = quiet();
    const swept = await M.top3Sweep({}, ['AAA']);
    un();
    return { refreshed: M.__refreshed(), fetched: swept.fetched, reused: swept.reused };
  };
  const fresh = await drive(okRow(Date.now() - 60_000));
  row('3a a 1-minute-old ok row is REUSED', [fresh.reused, fresh.fetched], [1, 0]);
  row('3a ...and no refetch happened', fresh.refreshed, []);

  const stale = await drive(okRow(Date.now() - (M.LONG_FRESH_MS + 60_000)));
  row('3a a row past LONG_FRESH_MS is REFETCHED', [stale.reused, stale.fetched], [0, 1]);
  row('3a ...and the refetch names the symbol', stale.refreshed, ['AAA']);

  const week = await drive(okRow(Date.now() - 6 * 24 * 3600_000));
  row('3a a 6-DAY-old row — now inside the TTL — is still REFETCHED',
      [week.reused, week.fetched], [0, 1]);

  const errRow = await drive(okRow(Date.now() - 60_000, 'error'));
  row('3a a FRESH `error` row is refetched, never reused',
      [errRow.reused, errRow.fetched], [0, 1]);

  /* Boundary, both sides: the gate is `<`, so exactly LONG_FRESH_MS old is NOT
     reusable. Driven with a real clock, so a 200ms run cannot land on the wrong
     side by accident — the stale case is nudged 1s past. */
  const justInside = await drive(okRow(Date.now() - (M.LONG_FRESH_MS - 5_000)));
  row('3a 5s inside the horizon: reused', justInside.reused, 1);
  const justOutside = await drive(okRow(Date.now() - (M.LONG_FRESH_MS + 1_000)));
  row('3a 1s outside the horizon: refetched', justOutside.fetched, 1);

  /* (c) THE SCHEMA RETIREMENT, behaviourally. A longer-lived row must not
         outlive its own shape — this is what stops a 7-day-old row from a
         previous LONG_SCHEMA rendering as a current one. */
  const kvOf = (v) => ({ REC_LOG: { async get(k, ty) { if (v instanceof Error) throw v;
                                                       return v == null ? null : (ty === 'json' ? v : JSON.stringify(v)); } } });
  row('3c current schema reads back', (await R.readLongRow('AAA', kvOf({ schema: M.LONG_SCHEMA, symbol: 'AAA' })))?.symbol, 'AAA');
  row('3c LONG_SCHEMA - 1 reads as ABSENT', await R.readLongRow('AAA', kvOf({ schema: M.LONG_SCHEMA - 1 })), null);
  row('3c LONG_SCHEMA + 1 reads as ABSENT', await R.readLongRow('AAA', kvOf({ schema: M.LONG_SCHEMA + 1 })), null);
  row('3c a schema-less row reads as ABSENT', await R.readLongRow('AAA', kvOf({ symbol: 'AAA' })), null);
  row('3c a KV throw reads as ABSENT, does not propagate', await R.readLongRow('AAA', kvOf(new Error('KV down'))), null);

  /* (b) THE PT-DATE DROP, at source. `top3Rank`'s behaviour is owned by
         top3.check.mjs; what is asserted here is that the guard the TTL change
         leans on still EXISTS, because that is the thing a later edit removes. */
  const rankSrc = grab('top3Rank');
  row('3b top3Rank still computes the row\'s own PT date',
      /const rowPt = .*ptDate\(new Date\(row\.ts\)\)/.test(rankSrc), true);
  row('3b ...and drops the row when it is not todayPt',
      /if \(rowPt !== todayPt\)[\s\S]{0,200}?drop\(/.test(rankSrc), true);
  row('3b ...before it counts the row as having today\'s data',
      rankSrc.indexOf('rowPt !== todayPt') < rankSrc.indexOf('tickersWithTodayRow++'), true);

  /* The source half of (a) and (c) too — same reason: a behavioural test passes
     happily on the day someone widens the gate to `age < LONG_ROW_TTL`. */
  row('3a the reuse gate names LONG_FRESH_MS, not LONG_ROW_TTL',
      /age < LONG_FRESH_MS/.test(grab('top3Sweep')), true);
  row('3a ...and LONG_ROW_TTL appears nowhere in the sweep',
      /LONG_ROW_TTL/.test(grab('top3Sweep')), false);
  row('3c readLongRow still uses STRICT schema equality',
      /row\.schema === LONG_SCHEMA/.test(grab('readLongRow')), true);
}

console.log('\n== 4. archiveSweptRows — stub bindings ======================================\n');
{
  const R4 = (sym, ts) => ({ schema: 4, symbol: sym, ok: true, status: 'ok', ts });
  const swept = (m) => ({ rows: new Map(Object.entries(m)) });

  const puts = [];
  const env = { REC_LOG: { async put(k, v, o) { puts.push({ k, v, ttl: o?.expirationTtl }); } } };
  const un = quiet();
  const out = await M.archiveSweptRows(env, swept({
    AAPL:  { row: R4('AAPL', 111), rowSource: 'fetched', rowAgeMs: 0 },
    GOOGL: { row: R4('GOOGL', 222), rowSource: 'reused', rowAgeMs: 7_000_000 },
  }), '2026-08-31', 'eod');
  un();

  row('attempted / written / failed', [out.attempted, out.written, out.failed], [2, 2, 0]);
  row('the slot and PT date come back on the result', [out.slot, out.ptDate], ['eod', '2026-08-31']);
  row('keys written', puts.map(p => p.k),
      ['longarch:AAPL:2026-08-31:eod', 'longarch:GOOGL:2026-08-31:eod']);
  row('every TTL is LONGARCH_TTL', puts.every(p => p.ttl === M.LONGARCH_TTL), true);
  row('the stored bytes are the row VERBATIM', puts[0].v, j(R4('AAPL', 111)));

  /* THE REUSED ROW. The 1:15pm sweep may bank a row computed at 11:04am; the
     SLOT names when the snapshot was taken and the row's own `ts` names when its
     data was computed, and neither may be rewritten to agree with the other. */
  row('a REUSED row is archived too', puts[1].v, j(R4('GOOGL', 222)));
  row('...keeping its OWN ts, not the snapshot clock', JSON.parse(puts[1].v).ts, 222);
  row('...and the sweep wrapper is NOT stored',
      ['rowSource', 'rowAgeMs'].filter(k => k in JSON.parse(puts[1].v)), []);

  const openPuts = [];
  const un2 = quiet();
  await M.archiveSweptRows({ REC_LOG: { async put(k) { openPuts.push(k); } } },
                           swept({ AAPL: { row: R4('AAPL', 1) } }), '2026-08-31', 'open');
  un2();
  row('the `open` slot writes the other key', openPuts, ['longarch:AAPL:2026-08-31:open']);

  /* A KV FAILURE IS REPORTED, NEVER THROWN AND NEVER GATING. The archive is a
     diagnostic artifact; the sweeps' products are the rows and the top3 record,
     and a failed archive write must not cost the day either of them. */
  const un3 = quiet();
  const partial = await M.archiveSweptRows(
    { REC_LOG: { async put(k) { if (k.includes('GOOGL')) throw new Error('KV down'); } } },
    swept({ AAPL: { row: R4('AAPL', 1) }, GOOGL: { row: R4('GOOGL', 2) } }), '2026-08-31', 'eod');
  un3();
  row('a KV throw does not propagate — a result comes back', typeof partial, 'object');
  row('attempted / written / failed after one failure',
      [partial.attempted, partial.written, partial.failed], [2, 1, 1]);
  row('the failure names the symbol', partial.failures.map(f => f.symbol), ['GOOGL']);
  row('...and carries the error', partial.failures[0].error, 'KV down');

  const un4 = quiet();
  const noEnv  = await M.archiveSweptRows(null, swept({ AAPL: { row: R4('AAPL', 1) } }), '2026-08-31', 'eod');
  const noRows = await M.archiveSweptRows({ REC_LOG: {} }, swept({}), '2026-08-31', 'eod');
  const badPuts = [];
  const badSlot = await M.archiveSweptRows({ REC_LOG: { async put(k) { badPuts.push(k); } } },
                                           swept({ AAPL: { row: R4('AAPL', 1) } }), '2026-08-31', 'midday');
  un4();
  row('no binding -> 0 attempted', noEnv.attempted, 0);
  row('no rows -> 0 attempted', noRows.attempted, 0);
  row('an UNKNOWN slot refuses and writes NOTHING', [badSlot.attempted, badPuts.length], [0, 0]);
}

console.log('\n== 5. THE READ ROUTE — /api/long/:ticker?date=&slot= ========================\n');
{
  const ORIGIN = 'https://ambermlysak.github.io';
  const req = (p) => new Request('https://w.dev' + p, { headers: { Origin: ORIGIN } });
  const ctx = () => ({ waitUntil() {}, passThroughOnException() {} });
  function kv(seed = {}) {
    const store = new Map(Object.entries(seed)), puts = [], gets = [];
    return { store, puts, gets,
      async get(k, ty) { gets.push(k); const v = store.get(k); return v == null ? null : (ty === 'json' ? JSON.parse(v) : v); },
      async put(k, v, o) { puts.push({ k, ttl: o?.expirationTtl }); store.set(k, v); },
      async delete(k) { store.delete(k); },
      async list() { return { keys: [], list_complete: true }; } };
  }
  const ROW = { schema: 4, symbol: 'GOOGL', ok: true, status: 'ok', ts: 1756400000000,
                lanes: [{ lane: 'B', status: 'ok' }] };
  const STORED = j(ROW);

  // (a) THE HIT.
  {
    const store = kv({ 'longarch:GOOGL:2026-08-28:eod': STORED });
    const res = await worker.fetch(req('/api/long/GOOGL?date=2026-08-28&slot=eod'), { REC_LOG: store }, ctx());
    const body = await res.json();
    row('5a status', res.status, 200);
    /* BYTE-IDENTICAL, not deep-equal: a re-serialised record that happened to
       compare equal would still be a rewrite, and "served verbatim" is the
       promise. Same instrument daily-slots.check.mjs §2 uses. */
    row('5a the row is served byte-identical to the stored value', j(body.row), STORED);
    row('5a archive.key names the key probed', body.archive.key, 'longarch:GOOGL:2026-08-28:eod');
    row('5a archive.slot / ptDate', [body.archive.slot, body.archive.ptDate], ['eod', '2026-08-28']);
    row('5a the archived flag is set', body.archived, true);
    row('5a NO `served` marker was bolted onto the row',
        ['served', 'servedAt', 'archived'].filter(k => k in body.row), []);
    /* `macro` is deliberately absent: every LIVE path puts today's macro:state in
       the envelope so the row and the chip describe one moment, and on an archive
       read that guarantee inverts into two days' facts under one header. */
    row('5a macro is NOT in the envelope', 'macro' in body, false);
    row('5a KV WRITES on the read path', store.puts.length, 0);
    row('5a KV READS — exactly the one archive key', store.gets, ['longarch:GOOGL:2026-08-28:eod']);
  }

  // (b) SLOT DEFAULTING, and the other slot.
  {
    const store = kv({ 'longarch:GOOGL:2026-08-28:eod': STORED });
    const body = await (await worker.fetch(req('/api/long/GOOGL?date=2026-08-28'), { REC_LOG: store }, ctx())).json();
    row('5b slot defaults to eod', body.archive.slot, 'eod');
    row('5b ...and probes the eod key', store.gets, ['longarch:GOOGL:2026-08-28:eod']);
  }
  {
    const store = kv({ 'longarch:GOOGL:2026-08-28:open': STORED });
    const res = await worker.fetch(req('/api/long/GOOGL?date=2026-08-28&slot=open'), { REC_LOG: store }, ctx());
    const body = await res.json();
    row('5b the `open` slot is reachable', res.status, 200);
    row('5b ...and probes the open key', body.archive.key, 'longarch:GOOGL:2026-08-28:open');
  }

  // (c) THE MISS. A refusal that names the key, never an empty 200, and — the one
  //     that matters — never a fall-through to a live refetch.
  {
    const store = kv({});
    const res = await worker.fetch(req('/api/long/GOOGL?date=2026-08-28&slot=eod'), { REC_LOG: store }, ctx());
    const body = await res.json();
    row('5c a miss is NOT a 200', res.status, 404);
    row('5c row is null', body.row, null);
    row('5c missing.status', body.missing.status, 'archive-miss');
    row('5c the reason NAMES THE KEY PROBED',
        body.missing.reason.includes('longarch:GOOGL:2026-08-28:eod'), true);
    row('5c ...and says the archive only runs forward',
        /cannot be backfilled/.test(body.missing.reason), true);
    row('5c nothing was written', store.puts.length, 0);
    row('5c DID NOT fall through to a live path — one key read, no crumb, no macro',
        store.gets, ['longarch:GOOGL:2026-08-28:eod']);
  }

  // (d) A KV READ FAILURE is a different state from a miss, and says so.
  {
    const store = { async get() { throw new Error('KV down'); }, async put() {}, async list() { return { keys: [] }; } };
    const res = await worker.fetch(req('/api/long/GOOGL?date=2026-08-28'), { REC_LOG: store }, ctx());
    const body = await res.json();
    row('5d a read failure is distinguishable from a miss', body.missing.status, 'archive-read-failed');
    row('5d ...and carries the error', /KV down/.test(body.missing.reason), true);
  }

  // (e) BAD INPUT is a 400 and spends nothing.
  for (const [q, why] of [['?date=2026-8-28', 'malformed date'],
                          ['?date=28-08-2026', 'wrong order'],
                          ['?date=2026-08-28&slot=noon', 'unknown slot'],
                          ['?date=2026-08-28&slot=', 'empty slot is not `eod`']]) {
    const store = kv({});
    const res = await worker.fetch(req('/api/long/GOOGL' + q), { REC_LOG: store }, ctx());
    // An empty `slot` param is falsy, so it defaults to eod rather than 400ing —
    // asserted as the behaviour it actually has, not the one the label guesses.
    const want = q.endsWith('slot=') ? 404 : 400;
    row(`5e ${why} -> ${want}`, res.status, want);
    if (want === 400) row(`5e ${why} read nothing from KV`, store.gets.length, 0);
  }

  // (f) NO `date` PARAM = the ordinary live path, untouched.
  {
    const store = kv({});
    const res = await worker.fetch(req('/api/long/GOOGL?cached=1'), { REC_LOG: store }, ctx());
    const body = await res.json();
    row('5f ?cached=1 still answers 200', res.status, 200);
    row('5f ...and still carries macro in the envelope', 'macro' in body, true);
    row('5f ...and read NO longarch key', store.gets.filter(k => k.startsWith('longarch:')), []);
    row('5f ...and did read the long: row key', store.gets.includes('long:GOOGL'), true);
  }
}

console.log('\n== 6. DISPATCH — the real scheduled(), offline ==============================\n');
{
  /* OFFLINE BY CONSTRUCTION. With `watchlist:tickers` absent, sweepUniverse
     refuses before a single fetch, so hour 7 can be driven for real without
     touching Yahoo. The hours whose jobs WOULD spend fetches are pinned from
     source in (c) instead — a check that goes red on the network is worse than
     no check. */
  function kv(seed = {}) {
    const store = new Map(Object.entries(seed)), puts = [], gets = [];
    return { store, puts, gets,
      async get(k, ty) { gets.push(k); const v = store.get(k); return v == null ? null : (ty === 'json' ? JSON.parse(v) : v); },
      async put(k, v, o) { puts.push({ k, ttl: o?.expirationTtl }); store.set(k, v); },
      async delete(k) { store.delete(k); },
      async list() { return { keys: [], list_complete: true }; } };
  }
  const ptOf = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);

  async function fire(isoLocal, seed = {}) {
    const logs = [];
    const o = { l: console.log, w: console.warn, e: console.error };
    console.log = console.warn = console.error = (...a) => logs.push(a.join(' '));
    const store = kv(seed);
    const jobs = [];
    const ctx = { waitUntil: (p) => jobs.push(p), passThroughOnException() {} };
    await worker.scheduled({ scheduledTime: Date.parse(isoLocal), cron: '*/15 13-22 * * *' },
                           { REC_LOG: store }, ctx);
    await Promise.allSettled(jobs);
    Object.assign(console, { log: o.l, warn: o.w, error: o.e });
    const line = logs.find(l => l.includes('branch=')) || '';
    return { branch: (line.match(/branch=([^\s·]+)/) || [])[1], jobs: jobs.length, store, logs };
  }

  // 2026-09-02 is a Wednesday and an ordinary trading day.
  // (a) the new branch, and its edges.
  const at700 = await fire('2026-09-02T07:00:00-07:00');
  row('6a 07:00 PT branch', at700.branch, 'morning-rows');
  row('6a ...dispatches exactly one job', at700.jobs, 1);
  const at715 = await fire('2026-09-02T07:15:00-07:00');
  row('6a 07:15 PT is the RETRY firing, same branch', at715.branch, 'morning-rows');
  /* THE EDGES ON BOTH SIDES. 06:45 is idle because the morning-briefing window is
     `h === 6 && m < 30` — so 7:00 is a NEW branch rather than an extension of the
     briefing's, and 07:30 closes it again. Getting 06:45 wrong on the first run
     of this section is exactly why the boundary is asserted rather than assumed.
     06:00 itself is deliberately NOT driven: it would dispatch the Claude
     briefing and spend real fetches, so it is pinned from source in (c). */
  for (const [hh, mm] of [['06', '45'], ['07', '30'], ['07', '45'], ['08', '00']]) {
    const f = await fire(`2026-09-02T${hh}:${mm}:00-07:00`);
    row(`6a ${hh}:${mm} PT branch`, f.branch, 'idle');
    row(`6a ${hh}:${mm} PT dispatched nothing`, f.jobs, 0);
  }

  /* (b) THE 7am JOB TOUCHES NO top3 KEY, and refuses without stamping. The empty
         universe is what makes this offline; the refusal contract says nothing may
         be stamped, which is also what the 7:15 retry depends on. */
  row('6b NO top3sweep:last was read', at700.store.gets.includes('top3sweep:last'), false);
  row('6b NO key starting `top3` was read', at700.store.gets.filter(k => k.startsWith('top3')), []);
  row('6b NO key starting `top3` was written', at700.store.puts.filter(p => p.k.startsWith('top3')), []);
  row('6b the morning dedup key WAS read', at700.store.gets.includes('morningrows:last'), true);
  row('6b an empty universe stamps NOTHING', at700.store.puts, []);
  row('6b ...and says so loudly', at700.logs.some(l => /EMPTY-UNIVERSE/.test(l)), true);

  // The dedup itself: a stamp for today short-circuits before the universe read.
  const today = ptOf(new Date());
  const dedup = await fire('2026-09-02T07:00:00-07:00', { 'morningrows:last': today });
  row('6b a today-stamp skips the run', dedup.store.gets, ['morningrows:last']);
  row('6b ...without reading the watchlist', dedup.store.gets.includes('watchlist:tickers'), false);
  row('6b ...and logs the skip', dedup.logs.some(l => /already swept today/.test(l)), true);

  // (c) THE WHOLE BRANCH -> JOBS TABLE, lifted from source. This is what pins
  //     "the 1:15pm branch gained nothing" without spending a fetch to find out.
  const schedSrc = src.slice(src.indexOf('async scheduled(event, env, ctx)'));
  const table = {};
  {
    const marks = [...schedSrc.matchAll(/branch = '([^']+)'/g)];
    if (populated('branch assignments in scheduled()', marks.length)) {
      marks.forEach((m, i) => {
        const seg = schedSrc.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : schedSrc.length);
        table[m[1]] = [...seg.matchAll(/dispatchJob\(ctx, '([^']+)'/g)].map(x => x[1]);
      });
      for (const [b, jobs] of Object.entries(table)) console.log(`     ${pad(b, 28)} ${j(jobs)}`);
    }
  }
  row('6c branch names, in dispatch order', Object.keys(table),
      ['idle', 'morning-briefing', 'morning-rows', 'midday-pulse',
       'eod+iv-sweep+macro', 'forward-returns+moves+mood', '13f-slice']);
  row('6c morning-rows dispatches exactly one job', table['morning-rows'], ['morning-rows']);
  row('6c the 1:15pm branch still has its FOUR jobs, unchanged',
      table['eod+iv-sweep+macro'], ['eod-summary', 'iv-sweep', 'macro-state', 'top3']);
  row('6c the 2:00pm branch is unchanged',
      table['forward-returns+moves+mood'], ['forward-returns', 'move-series', 'market-mood']);
  row('6c `idle` is a branch NAME with no job', table['idle'], []);
  row('6c the morning job appears on exactly ONE branch',
      Object.values(table).flat().filter(x => x === 'morning-rows').length, 1);
  row('6c ...and `top3` still appears on exactly one',
      Object.values(table).flat().filter(x => x === 'top3').length, 1);

  /* (d) THE CALENDAR GATE IS UPSTREAM, so the new branch inherits it and no
         date logic was added anywhere. Both closure kinds, at 7:00am PT. */
  for (const [iso, why] of [['2026-09-05', 'Saturday'], ['2026-09-06', 'Sunday'],
                            ['2026-09-07', 'Labor Day (a Monday)']]) {
    const f = await fire(`${iso}T07:00:00-07:00`);
    row(`6d ${why} 07:00 PT branch`, f.branch, 'none');
    row(`6d ${why} dispatched nothing`, f.jobs, 0);
  }

  /* (e) THE UTC WINDOW, checked in BOTH DST regimes, because a Pacific hour maps
         to two UTC hours across the year and a job outside 13-22 silently does
         not run for half of it (rule #2). Derived from the instants, not asserted
         from the comment. */
  const utcHour = (isoLocal) => new Date(Date.parse(isoLocal)).getUTCHours();
  const pdt = utcHour('2026-09-02T07:00:00-07:00');
  const pst = utcHour('2027-01-06T07:00:00-08:00');
  row('6e 7:00am PT under PDT, in UTC hours', pdt, 14);
  row('6e 7:00am PT under PST, in UTC hours', pst, 15);

  /* THE HOUR RANGE IS READ FROM `wrangler.toml`, NOT HARD-CODED HERE.
     This assertion used to pin the whole literal expression, which made a
     LEGITIMATE widening of the window read as a regression — and the window is
     the one thing in that expression that is allowed to change, because it is
     how often we wake up rather than a calendar rule. It widened to 12-22 on
     2026-09-01 for the print-vs-tape 05:30am PT pass (12:30 UTC under PDT).

     What must NOT change is the shape: minute step, an hour RANGE, and `*` in
     all three calendar fields. A day-of-week, day-of-month or month
     reappearing is the failure rule #2 exists for, and that is what is pinned. */
  const toml = fs.readFileSync('wrangler.toml', 'utf8');
  const cronM = toml.match(/crons = \["([^"]+)"\]/);
  row('6e wrangler.toml declares exactly one cron', !!cronM && toml.match(/crons = \[/g).length === 1, true);
  const expr = cronM ? cronM[1] : '';
  const parts = expr.split(/\s+/);
  row('6e cron expression', expr, expr);                      // printed for the record
  row('6e it has five fields', parts.length, 5);
  row('6e minute field is a step, not a calendar rule', /^\*\/\d+$/.test(parts[0] || ''), true);
  row('6e day-of-month field is `*` (no calendar logic)', parts[2], '*');
  row('6e month field is `*` (no calendar logic)', parts[3], '*');
  row('6e day-of-week field is `*` (no calendar logic)', parts[4], '*');
  const hm = (parts[1] || '').match(/^(\d+)-(\d+)$/);
  const [lo, hi] = hm ? [Number(hm[1]), Number(hm[2])] : [NaN, NaN];
  row('6e hour field is a UTC range', !!hm, true);
  row('6e 7:00am PT is inside it in BOTH regimes', [pdt, pst].every(h => h >= lo && h <= hi), true);
  /* Every OTHER scheduled Pacific hour, re-derived the same way — so widening or
     narrowing the window can never silently orphan a job that already exists. */
  for (const [ptH, ptM, what] of [[6, 0, 'morning briefing'], [7, 0, 'morning rows'],
                                  [10, 0, '13F slice'], [11, 30, 'midday pulse'],
                                  [13, 15, 'EOD branch'], [14, 0, '2pm branch'],
                                  [5, 30, 'print-tape BMO pass 1'], [6, 15, 'print-tape BMO pass 2'],
                                  [13, 30, 'print-tape AMC pass 1'], [14, 30, 'print-tape AMC pass 2']]) {
    const p = String(ptH).padStart(2, '0') + ':' + String(ptM).padStart(2, '0');
    const a = utcHour(`2026-09-02T${p}:00-07:00`);   // PDT
    const b = utcHour(`2027-01-06T${p}:00-08:00`);   // PST
    row(`6e ${what} (${p} PT) inside ${lo}-${hi} UTC in both regimes`,
        [a, b].every(h => h >= lo && h <= hi), true);
  }
}

console.log('\n== 7. STRUCTURAL — who may write what ======================================\n');
{
  /* Attribution by nearest preceding function declaration, and it must see BOTH
     forms — the router lives in the exported default object as a METHOD, and a
     `function <name>` scan alone walks past it and blames the previous top-level
     function instead. Lifted from daily-slots.check.mjs, where exactly that
     produced a plausible, readable, entirely false line of output. */
  const fnAt = (idx) => {
    const m = [...src.slice(0, idx).matchAll(
      /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|\n {2}(?:async )?([A-Za-z0-9_$]+)\(\w[^)]*\)\s*\{/g,
    )].pop();
    return m ? (m[1] || m[2]) : '(top level)';
  };
  const sitesOf = (re) => [...src.matchAll(re)].map(m => ({ at: m[0].trim(), fn: fnAt(m.index) }));

  // (a) WHO CALLS THE ARCHIVE WRITER. Cron sweeps only — never an on-demand
  //     refresh, or the archive becomes a log of what someone opened rather than
  //     a fixed-clock daily series.
  const callers = sitesOf(/await archiveSweptRows\(/g);
  if (populated('archiveSweptRows call sites', callers.length)) {
    for (const s of callers) console.log(`     archiveSweptRows() in ${s.fn}`);
    row('7a called from exactly the two cron sweeps',
        [...new Set(callers.map(s => s.fn))].sort(), ['collectMorningRows', 'collectTop3']);
    row('7a ...and from nowhere else', callers.length, 2);
  }
  row('7a NOT called from the on-demand refresh path',
      /archiveSweptRows/.test(grab('refreshLongTicker')), false);
  row('7a NOT called from the request handler',
      /archiveSweptRows/.test(grab('handleLongTicker')), false);

  // (b) WHO BUILDS AN ARCHIVE KEY.
  const keySites = sitesOf(/longArchKey\(/g).filter(s => s.fn !== '(top level)');
  if (populated('longArchKey() sites inside functions', keySites.length)) {
    for (const s of keySites) console.log(`     longArchKey() in ${s.fn}`);
    row('7b built only by the writer and the reader',
        [...new Set(keySites.map(s => s.fn))].sort(), ['archiveSweptRows', 'handleLongArchive']);
  }

  // (c) THE CONSTRAINT. collectMorningRows must not be able to rank, or to stamp
  //     the key that dedups the ranking.
  const mrSrc = grab('collectMorningRows');
  row('7c collectMorningRows does NOT call collectTop3', /collectTop3\s*\(/.test(mrSrc), false);
  row('7c ...does NOT reference TOP3_SWEEP_KEY', /TOP3_SWEEP_KEY/.test(mrSrc), false);
  row('7c ...does NOT build a top3 key', /top3Key\s*\(/.test(mrSrc), false);
  row('7c ...and writes exactly one key, its own stamp',
      [...mrSrc.matchAll(/REC_LOG\??\.put\(\s*([A-Za-z0-9_$]+)/g)].map(m => m[1]), ['MORNING_ROWS_KEY']);
  // Both halves: it must also actually DO its job, or the assertions above are vacuous.
  row('7c ...but it DOES run the shared sweep', /top3Sweep\(/.test(mrSrc), true);
  row('7c ...and DOES archive under the `open` slot', /archiveSweptRows\(env, swept, today, 'open'\)/.test(mrSrc), true);
  row('7c ...and refuses on an empty universe before stamping',
      mrSrc.indexOf('if (!tickers) return;') < mrSrc.indexOf('MORNING_ROWS_KEY, today'), true);
  row('7c ...and stamps only a complete run', /if \(complete\) \{[\s\S]{0,160}?MORNING_ROWS_KEY/.test(mrSrc), true);

  // (d) The mirror image: the top3 dedup stamp still belongs to collectTop3 alone.
  const stampSites = sitesOf(/REC_LOG\??\.put\(\s*TOP3_SWEEP_KEY/g);
  if (populated('TOP3_SWEEP_KEY put sites', stampSites.length)) {
    row('7d TOP3_SWEEP_KEY is written only by collectTop3',
        [...new Set(stampSites.map(s => s.fn))], ['collectTop3']);
  }
  const morningStamp = sitesOf(/REC_LOG\??\.put\(\s*MORNING_ROWS_KEY/g);
  if (populated('MORNING_ROWS_KEY put sites', morningStamp.length)) {
    row('7d MORNING_ROWS_KEY is written only by collectMorningRows',
        [...new Set(morningStamp.map(s => s.fn))], ['collectMorningRows']);
  }

  // (e) collectTop3 gained the archive hook and nothing else that mutates state.
  const ctSrc = grab('collectTop3');
  row('7e collectTop3 archives under the `eod` slot',
      /archiveSweptRows\(env, swept, today, 'eod'\)/.test(ctSrc), true);
  row('7e ...before the ranking is computed',
      ctSrc.indexOf('archiveSweptRows') < ctSrc.indexOf('await top3Rank('), true);
  row('7e ...and its own KV writes are unchanged: the record and the stamp',
      [...ctSrc.matchAll(/REC_LOG\??\.put\(\s*([A-Za-z0-9_$]+\(?)/g)].map(m => m[1]),
      ['top3Key(', 'TOP3_SWEEP_KEY']);

  // (f) LONG_ROW_TTL has exactly one write site, so the retention change is one
  //     fact rather than a value that could disagree with itself.
  const ttlSites = sitesOf(/expirationTtl: LONG_ROW_TTL/g);
  if (populated('LONG_ROW_TTL write sites', ttlSites.length)) {
    row('7f LONG_ROW_TTL is used at exactly one put site', ttlSites.length, 1);
    row('7f ...in storeLongRow', ttlSites.map(s => s.fn), ['storeLongRow']);
  }
  const archTtlSites = sitesOf(/expirationTtl: LONGARCH_TTL/g);
  if (populated('LONGARCH_TTL write sites', archTtlSites.length)) {
    row('7f LONGARCH_TTL is used at exactly one put site', archTtlSites.length, 1);
    row('7f ...in archiveSweptRows', archTtlSites.map(s => s.fn), ['archiveSweptRows']);
  }
}

console.log('\n== 8. THE MODULE LOADS AS AN ES MODULE =====================================\n');
{
  /* The import at the top of this file already proved it — this row states the
     claim so a reader knows the check was made. `node --check worker.js` parses
     it as CommonJS, where a duplicate `const` in one scope is NOT an error, and
     it has now twice returned exit 0 on a file workerd would refuse to boot. */
  row('8 worker.js exposes fetch + scheduled',
      [typeof worker.fetch, typeof worker.scheduled], ['function', 'function']);
}

process.exit(reportVerdict({
  label: 'long-row retention, the 7am sweep and the longarch archive',
  comparisons: t.comparisons,
  failures: t.failures,
  /* THE FLOOR IS THE FIXED COUNT. Every section here is deterministic and
     offline — no live tape, no calendar-relative fixture — so unlike
     swing.check.mjs and earnings-timing.check.mjs there is no observed total to
     distinguish from a fixed one, and the floor is the exact number of
     comparisons the script makes. If a section stops running, the count drops
     and the run reports NO VERDICT rather than a pass over nothing. */
  minComparisons: 183,
}));
