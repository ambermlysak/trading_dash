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

console.error = realErr; console.warn = realWarn;
process.exitCode = reportVerdict({
  label: 'sweep-universe.check', comparisons: T.comparisons, failures: T.failures, minComparisons: 37,
});
