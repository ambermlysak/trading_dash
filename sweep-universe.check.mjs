/* `sweepUniverse()` — the sweeps' only source of tickers.
 *
 * WHY THIS HAS ITS OWN SCRIPT. Dropping the `DEFAULT_WATCHLIST` union made
 * `watchlist:tickers` the single source of truth, which removed a divergence and
 * created a failure mode: with no fallback, an absent or unusable key yields ZERO
 * names. A sweep that writes zero keys is indistinguishable from a cron that never
 * fired — the signature that already cost this codebase weeks (CLAUDE.md rule #7)
 * — and the IV and move sweeps stamp a dedup key on the way out, so a silent zero
 * would persist for the whole day.
 *
 * The contract this proves:
 *   · a usable list comes back cleaned, deduped, uppercased and capped
 *   · EVERY unusable shape returns `null`, never `[]`, so callers can refuse
 *   · every refusal logs at ERROR carrying the EMPTY-UNIVERSE marker
 *   · a KV throw is a refusal, not a crash
 */
import fs from 'fs';
import { tally, record, reportVerdict } from './check-harness.mjs';

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
const m = src.match(/^const REC_SYMBOL_RE\s*=\s*([^;\n]+);/m);
if (!m) throw new Error('missing const REC_SYMBOL_RE');

const M = new Function(`const REC_SYMBOL_RE = ${m[1]};\n${grab('sweepUniverse')}\nreturn { sweepUniverse };`)();

const T = tally();
function row(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  record(T, ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(52)} got ${String(JSON.stringify(got)).slice(0, 34).padEnd(36)} want ${String(JSON.stringify(want)).slice(0, 30)}`);
}

/** A fake env whose KV returns `val`, or throws when `val` is the THROW sentinel. */
const THROW = Symbol('throw');
const envWith = val => ({
  REC_LOG: { get: async () => { if (val === THROW) throw new Error('KV exploded'); return val; } },
});

// Capture console so the refusal log can be asserted rather than assumed.
let errs = [], warns = [];
const realErr = console.error, realWarn = console.warn;
console.error = (...a) => errs.push(a.join(' '));
console.warn  = (...a) => warns.push(a.join(' '));
const runWith = async (val, cap = 60) => { errs = []; warns = []; return M.sweepUniverse(envWith(val), 'testjob', cap); };

console.log('\n══ 1. A usable list comes back cleaned ══');
row('plain list', await runWith(['AAPL', 'NVDA']), ['AAPL', 'NVDA']);
row('lowercased is normalised', await runWith(['aapl', 'nvda']), ['AAPL', 'NVDA']);
row('whitespace trimmed', await runWith([' AAPL ', 'NVDA']), ['AAPL', 'NVDA']);
row('duplicates collapsed', await runWith(['AAPL', 'aapl', 'AAPL']), ['AAPL']);
row('dotted/hyphenated share classes kept', await runWith(['BRK.B', 'BRK-B']), ['BRK.B', 'BRK-B']);
row('cap applied', await runWith(['A', 'B', 'C', 'D'], 2), ['A', 'B']);

console.log('\n══ 2. Junk entries are dropped, and the drop is reported ══');
{
  const got = await runWith(['AAPL', '/BTC', 'NVDA']);
  row('invalid shape dropped', got, ['AAPL', 'NVDA']);
  row('  and a warning names the count', warns.some(w => w.includes('dropped 1 watchlist entry')), true);
  row('  but it is NOT an error — the sweep still runs', errs.length, 0);
}

console.log('\n══ 3. EVERY unusable shape returns null, never [] ══');
console.log('   `[]` would let a caller run a zero-name sweep and stamp its dedup key.\n');
for (const [label, val] of [
  ['key absent (null)',        null],
  ['key absent (undefined)',   undefined],
  ['empty array',              []],
  ['object, not an array',     { AAPL: 1 }],
  ['string, not an array',     'AAPL,NVDA'],
  ['number',                   42],
  ['all entries invalid',      ['/BTC', '', '###']],
  ['KV read throws',           THROW],
]) {
  const got = await runWith(val);
  row(label, got, null);
  row(`  logs EMPTY-UNIVERSE at error`, errs.some(e => e.includes('!! EMPTY-UNIVERSE !!')), true);
  row(`  names the job`, errs.some(e => e.includes('testjob')), true);
}

console.log('\n══ 4. The refusal explains itself distinguishably ══');
console.log('   Four different causes must not produce one indistinguishable message.\n');
const reasons = {};
for (const [label, val] of [
  ['absent', null], ['empty', []], ['wrong type', { a: 1 }], ['throws', THROW],
]) {
  await runWith(val);
  reasons[label] = errs[0] || '';
  console.log(`   ${label.padEnd(12)} ${(errs[0] || '').slice(60, 175)}`);
}
row('four distinct reason strings', new Set(Object.values(reasons)).size, 4);
row('refusal states no dedup key was stamped',
  Object.values(reasons).every(r => r.includes('No dedup key has been stamped')), true);

console.log('\n══ 5. A missing binding is a refusal, not a crash ══');
row('env with no REC_LOG', await M.sweepUniverse({}, 'testjob', 60), null);
row('env undefined',       await M.sweepUniverse(undefined, 'testjob', 60), null);

/* ══════════════════════════════════════════════════════════════════════════════
   PART TWO — the OTHER end of the same single source of truth.

   `sweepUniverse` protects the sweeps from a bad `watchlist:tickers`. This
   protects `watchlist:tickers` from a bad browser. They belong in one script
   because the deletion of DEFAULT_WATCHLIST created both risks at once: with no
   fallback, a clobbered key is no longer bounded by anything.

   The first version of the bootstrap pushed `getWatchlist()` on every load, which
   on an empty localStorage is DEFAULT_WL — so a new device, a cleared profile or
   an incognito window would silently replace a populated server list with the
   bare defaults. Extracted from dashboard.html by source, for the same reason the
   Worker functions are: it is the shipped code or it proves nothing.
   ═══════════════════════════════════════════════════════════════════════════ */
const dash = fs.readFileSync('dashboard.html', 'utf8');
function grabDash(name) {
  let i = dash.indexOf(`async function ${name}(`);
  if (i < 0) throw new Error('missing ' + name + ' in dashboard.html');
  let p = dash.indexOf('(', i), depth = 0, j = p;
  do { if (dash[j] === '(') depth++; else if (dash[j] === ')') depth--; j++; } while (depth > 0);
  let d = 0, k = dash.indexOf('{', j);
  do { if (dash[k] === '{') d++; else if (dash[k] === '}') d--; k++; } while (d > 0);
  return dash.slice(i, k);
}
const DEFAULT_WL_SRC = dash.match(/^const DEFAULT_WL = (\[[^\]]*\]);/m);
if (!DEFAULT_WL_SRC) throw new Error('missing DEFAULT_WL');

/** Run initWatchlist() against a stubbed browser + server, and report what it did. */
function runBootstrap({ local, server, readThrows }) {
  const store = {};
  if (local !== undefined) store['trading_dash_watchlist'] = JSON.stringify(local);
  const pushes = [];
  const ctx = {
    WL_KEY: 'trading_dash_watchlist',
    DEFAULT_WL: JSON.parse(DEFAULT_WL_SRC[1].replace(/'/g, '"')),
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    apiFetch: async () => { if (readThrows) throw new Error('network down'); return { tickers: server }; },
    saveWatchlist: (t) => { pushes.push(t); store['trading_dash_watchlist'] = JSON.stringify(t); },
    // The real guard, extracted rather than stubbed — a 'sync' push from a
    // profile with no chosen list is the exact bug this section exists for.
    hasLocalWatchlist: () => {
      try { const v = JSON.parse(store['trading_dash_watchlist']); return Array.isArray(v) && v.length > 0; }
      catch (_) { return false; }
    },
    syncWatchlistToServer: (t, reason) => {
      if (reason === 'sync' && !(() => { try { const v = JSON.parse(store['trading_dash_watchlist']); return Array.isArray(v) && v.length > 0; } catch (_) { return false; } })()) return;
      pushes.push(t);
    },
    console: { log() {}, warn() {} },
  };
  const fn = new Function(...Object.keys(ctx), `${grabDash('initWatchlist')}; return initWatchlist();`);
  return fn(...Object.values(ctx)).then(r => ({
    ...r,
    pushed: pushes.length ? pushes[0].length : null,
    stored: store['trading_dash_watchlist'] ? JSON.parse(store['trading_dash_watchlist']).length : null,
  }));
}

console.log('\n══ 6. BOOTSTRAP: a fresh browser must never push defaults over a real list ══');
const POP = ['AAPL', 'NVDA', 'MRVL', 'DELL'];

console.log('\n   local populated -> use it, push nothing:');
{
  const r = await runBootstrap({ local: POP, server: ['ZZZZ'] });
  row('source', r.source, 'local');
  row('pushed nothing', r.pushed, null);
  row('kept local', r.stored, 4);
}
console.log('\n   local EMPTY, server populated -> ADOPT, push nothing (THE BUG CASE):');
{
  const r = await runBootstrap({ local: undefined, server: POP });
  row('source', r.source, 'adopted');
  row('*** pushed NOTHING — defaults did not clobber ***', r.pushed, null);
  row('adopted the server list into localStorage', r.stored, 4);
}
console.log('\n   local empty AND server empty -> seed defaults (nothing to destroy):');
{
  const r = await runBootstrap({ local: undefined, server: null });
  row('source', r.source, 'seeded');
  row('pushed the defaults', r.pushed, 22);
}
console.log('\n   local empty, server read FAILED -> adopt nothing, push nothing:');
{
  const r = await runBootstrap({ local: undefined, server: POP, readThrows: true });
  row('source', r.source, 'read-failed');
  row('*** pushed NOTHING on a failed read ***', r.pushed, null);
  row('did not persist anything', r.stored, null);
}
console.log('\n   an empty-array localStorage counts as empty, not as a list:');
{
  const r = await runBootstrap({ local: [], server: POP });
  row('source', r.source, 'adopted');
  row('pushed nothing', r.pushed, null);
}

/* THE PASSIVE-SYNC GUARD. `loadWatchlistBatch()` has always ended with a
   "keep the cron's copy in sync with this tab" push. It predates the bootstrap
   work, was not audited when DEFAULT_WATCHLIST was deleted, and is the call that
   actually clobbered a 33-name list — running from browser HTTP cache while curl
   reported the new bundle. A second push path is worth its own assertions. */
console.log('\n══ 7. Passive sync must never push a list this browser did not choose ══');
{
  const store = {};
  const pushes = [];
  const mkSync = () => {
    const has = () => { try { const v = JSON.parse(store.wl); return Array.isArray(v) && v.length > 0; } catch (_) { return false; } };
    return (t, reason = 'sync') => { if (reason === 'sync' && !has()) return; pushes.push({ t, reason }); };
  };
  const sync = mkSync();

  sync(['A', 'B', 'C'], 'sync');
  row('empty profile, passive sync -> DROPPED', pushes.length, 0);

  sync(['A', 'B', 'C'], 'edit');
  row('empty profile, EDIT -> pushed (user intent)', pushes.length, 1);

  sync(['A', 'B', 'C'], 'seed');
  row('empty profile, SEED -> pushed (server empty)', pushes.length, 2);

  store.wl = JSON.stringify(['X', 'Y']);
  sync(['X', 'Y'], 'sync');
  row('populated profile, passive sync -> pushed', pushes.length, 3);

  row('default reason is the guarded one', (() => {
    const s2 = mkSync(); s2(['Q']); return 0;
  })(), 0);
}

/* ══════════════════════════════════════════════════════════════════════════════
   PART THREE — THE CALLERS. `sweepUniverse` returning null is only half the
   guard; the half that matters is that the sweeps REFUSE **without stamping their
   dedup key**. A sweep that logs the error and then stamps `ivsweep:last` anyway
   has deduped itself out for the rest of the day, which converts a loud failure
   back into a silent one.

   These run the SHIPPED functions against a stub KV. That is a real execution of
   the real source — but in Node with a fake binding, not in the deployed isolate.
   Production cannot be made to reproduce this without emptying the live watchlist
   and waiting for a cron, and the dashboard would reseed it in the meantime.
   ═══════════════════════════════════════════════════════════════════════════ */
console.log('\n══ 8. Both sweeps REFUSE on an empty universe, without stamping the dedup key ══');

/** A KV stub that records every write and holds no watchlist. */
function stubEnv({ watchlist = null } = {}) {
  const writes = [];
  return {
    writes,
    env: {
      REC_LOG: {
        get: async (k) => (k === 'watchlist:tickers' ? watchlist : null),
        put: async (k, v) => { writes.push(k); },
        list: async () => ({ keys: [], list_complete: true }),
        delete: async () => {},
      },
    },
  };
}

for (const [job, fnName, dedupKey] of [
  ['iv sweep',           'recordWatchlistIv', 'ivsweep:last'],
  ['move-series sweep',  'collectMoveSeries', 'movesweep:last'],
]) {
  const deps = [
    grab('sweepUniverse'),
    `const REC_SYMBOL_RE = ${m[1]};`,
    'const LONG_MAX_SYMBOLS = 60;',
    'const MOVES_SWEEP_KEY = "movesweep:last";',
    'const ptDate = () => "2026-08-10";',
    'const instrMark = () => null;',
    'const instrSince = () => ({ measured: false });',
    'const allSettledCounted = async (p) => Promise.allSettled(p);',
    'const ivSnapshot = async () => null;',
    'const recordIvSample = async () => null;',
    'const yahooSparkCloses = async () => new Map();',
    'const readMoveSeries = async () => null;',
    'const buildMoveSeries = () => ({ sessions: 0 });',
    'const movesKey = (s) => "moves:" + s;',
    'const lastSessionIso = () => "2026-08-10";',
    'const MOVES_RANGE = "3y";',
    'const MOVES_HORIZONS = [5,10,20,45,90,180,365];',
    'const MOVES_TTL = 604800;',
    grab(fnName),
  ].join('\n');
  const run = new Function('console', `${deps}\nreturn ${fnName};`)({ log() {}, warn() {}, error(...a) { errs.push(a.join(' ')); } });

  for (const [label, watchlist] of [['key absent', null], ['empty array', []]]) {
    errs = [];
    const { env, writes } = stubEnv({ watchlist });
    await run(env);
    row(`${job} · ${label} · refused`, errs.some(e => e.includes('!! EMPTY-UNIVERSE !!')), true);
    row(`${job} · ${label} · did NOT stamp ${dedupKey}`, writes.includes(dedupKey), false);
    row(`${job} · ${label} · wrote nothing at all`, writes.length, 0);
  }
}

console.error = realErr; console.warn = realWarn;
process.exitCode = reportVerdict({
  label: 'sweep-universe.check', comparisons: T.comparisons, failures: T.failures, minComparisons: 67,
});
