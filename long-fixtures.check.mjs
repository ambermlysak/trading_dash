/* Long-screen fixture checks — the paths live data cannot reach today.
 *
 * Three things on the long screen are unreachable against live Yahoo right now,
 * and "unreachable" is exactly how untested code ships:
 *
 *   1. `buyableFrom()`'s `rank` branch. IV rank is null until 60 days of samples
 *      exist, so every live row gates on the `proxy` branch. The rank branch is
 *      the one that takes over once collection completes — it has never run.
 *   2. Lane A with TWO Januaries. Every optionable ticker sampled on 2026-08-08
 *      listed exactly one January past 365 DTE, so the secondary slot has only
 *      ever rendered `not-listed`.
 *   3. The IV-outlier guard's behaviour at the boundary, on both screens.
 *
 * Functions are extracted from worker.js by source, not imported: every named
 * export in worker.js must be a function or workerd refuses to boot.
 *
 * Prints computed vs expected. Nothing asserts silently.
 */
import fs from 'fs';

const src = fs.readFileSync('worker.js', 'utf8');
function grab(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('missing ' + name);
  let p = src.indexOf('(', i), depth = 0, j = p;
  do { if (src[j] === '(') depth++; else if (src[j] === ')') depth--; j++; } while (depth > 0);
  let d = 0, k = src.indexOf('{', j);
  do { if (src[k] === '{') d++; else if (src[k] === '}') d--; k++; } while (d > 0);
  return src.slice(i, k);
}
function grabConst(name) {
  const m = src.match(new RegExp(`^const ${name}\\s*=\\s*([^;\\n]+);`, 'm'));
  if (!m) throw new Error('missing const ' + name);
  return `const ${name} = ${m[1]};`;
}

const M = new Function(
  [
    grabConst('IV_RANK_MIN_DAYS'), grabConst('IVR_BUY_MAX'), grabConst('RATIO_BUY_MAX'),
    grabConst('IV_OUTLIER_MULT'), grabConst('LEAPS_MIN_DTE'), grabConst('LEAPS_TARGET_DTE'),
    grab('buyableFrom'), grab('ivPlausible'), grab('dteOf'), grab('isMonthlyExpiry'),
    grab('pickJanuaries'),
  ].join('\n') +
  '\nreturn { buyableFrom, ivPlausible, pickJanuaries, IVR_BUY_MAX, RATIO_BUY_MAX, IV_OUTLIER_MULT, LEAPS_MIN_DTE };',
)();

const pad = (s, n) => String(s).padEnd(n);
let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`  ${pad(label, 46)} got ${pad(JSON.stringify(got), 26)} want ${pad(JSON.stringify(want), 26)} ${ok ? 'OK' : '<<< MISMATCH'}`);
};

console.log(`\n══ 1. buyableFrom() — the RANK branch, unreachable until IV rank exists ══`);
console.log(`   IVR_BUY_MAX = ${M.IVR_BUY_MAX} (rank, in points) · RATIO_BUY_MAX = ${M.RATIO_BUY_MAX} (proxy, ratio)`);
console.log(`   Live rows all take the proxy branch today, so these are the untested cases.\n`);
for (const [rank, expectBuyable] of [[0.00, true], [0.25, true], [0.40, true], [0.4001, false], [0.55, false], [1.00, false]]) {
  const r = M.buyableFrom(rank, null, 90);
  check(`ivRank ${(rank * 100).toFixed(2)} pts -> buyable`, [r.buyable, r.basis], [expectBuyable, 'rank']);
}
console.log('   boundary: 40 pts is INCLUSIVE (<=), 40.01 is not — matches IVR_BUY_MAX semantics\n');
console.log('   rank takes precedence over the proxy when both exist:');
{
  const r = M.buyableFrom(0.20, 5.0, 90);   // cheap rank, absurd proxy
  check('rank 20 + proxy 5.00x -> uses rank', [r.buyable, r.basis], [true, 'rank']);
  const r2 = M.buyableFrom(0.90, 0.10, 90); // rich rank, cheap proxy
  check('rank 90 + proxy 0.10x -> uses rank', [r2.buyable, r2.basis], [false, 'rank']);
}
console.log('\n   the proxy branch (what live data exercises), for contrast:');
for (const [ratio, expect] of [[0.50, true], [0.95, true], [0.9501, false], [1.30, false]]) {
  const r = M.buyableFrom(null, ratio, 12);
  check(`no rank, proxy ${ratio.toFixed(4)}x -> buyable`, [r.buyable, r.basis], [expect, 'proxy']);
}
console.log('\n   and the null case, which must NOT read as a fail:');
{
  const r = M.buyableFrom(null, null, 0);
  check('no rank, no proxy -> buyable', [r.buyable, r.basis], [null, 'none']);
}

console.log(`\n══ 2. Lane A with TWO Januaries — never seen live ══`);
console.log(`   Every ticker sampled 2026-08-08 listed exactly one January past ${M.LEAPS_MIN_DTE} DTE.`);
console.log(`   Fixtures are third-Friday Januaries as unix seconds, measured from today.\n`);
const jan = (y, d) => Math.floor(Date.UTC(y, 0, d) / 1000);
const iso = u => u == null ? null : new Date(u * 1000).toISOString().slice(0, 10);
const dte = u => u == null ? null : Math.round((Date.UTC(new Date(u * 1000).getUTCFullYear(), new Date(u * 1000).getUTCMonth(), new Date(u * 1000).getUTCDate()) - Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())) / 86400000);

const CASES = [
  ['live shape: only Jan-2028 listed', [jan(2027, 15), jan(2028, 21)]],
  ['TWO qualifying: Jan-2028 + Jan-2029', [jan(2027, 15), jan(2028, 21), jan(2029, 19)]],
  ['THREE qualifying', [jan(2028, 21), jan(2029, 19), jan(2030, 18)]],
  ['none past the floor (near Jan only)', [jan(2027, 15)]],
  ['no Januaries at all', []],
];
for (const [label, exps] of CASES) {
  const r = M.pickJanuaries(exps);
  console.log(`  ${pad(label, 40)} qualifying=${r.januaries.length}` +
    `  primary=${pad(iso(r.janPrimary) + (r.janPrimary ? ` (${dte(r.janPrimary)}d)` : ''), 22)}` +
    `  secondary=${iso(r.janSecondary) || 'null'}${r.janSecondary ? ` (${dte(r.janSecondary)}d)` : ''}`);
}
console.log('\n   assertions:');
{
  const one = M.pickJanuaries([jan(2027, 15), jan(2028, 21)]);
  check('one qualifying -> secondary is null', one.janSecondary, null);
  const two = M.pickJanuaries([jan(2027, 15), jan(2028, 21), jan(2029, 19)]);
  check('two qualifying -> primary is the 540-nearest', iso(two.janPrimary), '2028-01-21');
  check('two qualifying -> secondary is the next out', iso(two.janSecondary), '2029-01-19');
  check('sub-365 January is excluded entirely', two.januaries.map(iso).includes('2027-01-15'), false);
  const none = M.pickJanuaries([jan(2027, 15)]);
  check('none past floor -> primary null', none.janPrimary, null);
  check('none past floor -> secondary null', none.janSecondary, null);
  const empty = M.pickJanuaries([]);
  check('empty input -> no throw, both null', [empty.janPrimary, empty.janSecondary], [null, null]);
}

console.log(`\n══ 3. ivPlausible() — the SHARED selection guard (premium + long) ══`);
console.log(`   IV_OUTLIER_MULT = ${M.IV_OUTLIER_MULT}. atmIv 24% -> accepted band [6%, 96%].\n`);
const atm = 0.24;
for (const [iv, expect, note] of [
  [0.2400, true,  'at ATM'],
  [0.9600, true,  'exactly 4x — inclusive'],
  [0.9601, false, 'just over 4x'],
  [1.9572, false, 'the real AAPL 420P quote (195.72%)'],
  [0.0600, true,  'exactly 1/4x — inclusive'],
  [0.0599, false, 'just under 1/4x'],
  [0.4800, true,  '2x — inside genuine skew, deliberately NOT excluded'],
]) {
  check(`iv ${(iv * 100).toFixed(2)}% vs atm 24%  (${note})`, M.ivPlausible(iv, atm), expect);
}
console.log('\n   degenerate inputs:');
check('iv null              -> reject', M.ivPlausible(null, atm), false);
check('iv 0                 -> reject', M.ivPlausible(0, atm), false);
check('atmIv null -> guard DISABLED (no reference, no verdict)', M.ivPlausible(1.9572, null), true);
check('atmIv 0    -> guard disabled', M.ivPlausible(1.9572, 0), true);

console.log(`\n${fails === 0 ? 'All checks matched.' : fails + ' MISMATCH(ES) — see above.'}`);
process.exitCode = fails === 0 ? 0 : 1;
