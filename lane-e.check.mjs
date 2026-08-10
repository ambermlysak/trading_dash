/* Lane E — straddle and strangle. The two-sided half.
 *
 * Everything here is a quantity that did not exist before this lane: two-sided
 * coverage, two-sided P(BE), and the payoff pair across four breakevens. The
 * one-sided versions are covered by moves.check.mjs and nd2.check.mjs and are not
 * re-tested.
 *
 * WHY TWO-SIDED NEEDS ITS OWN CHECK. A one-sided figure that is silently used for
 * a two-tailed structure is off by roughly half and looks completely ordinary —
 * there is no shape to the number that reveals it. So both quantities are printed
 * against hand-computed values, and coverage additionally against a brute-force
 * loop over raw closes that never calls the shipped code.
 *
 * Sections:
 *   1. Two-sided pBe vs hand-computed N(d2) at five prices.
 *   2. Two-sided coverage vs brute force, including a zero-contribution tail.
 *   3. Straddle + strangle payoff at five prices spanning all four breakevens.
 *   4. min(pl) >= -capital, and the breakeven-crossing guard.
 *   5. upsideTruncated fires on both (uncapped upside).
 *   6. Upper/lower split on a trending series vs a range-bound one.
 */
import fs from 'fs';
import { tally, record, reportVerdict, populated } from './check-harness.mjs';

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
function grabConst(name) {
  const m = src.match(new RegExp(`^const ${name}\\s*=\\s*([^;\\n]+);`, 'm'));
  if (!m) throw new Error('missing const ' + name);
  return `const ${name} = ${m[1]};`;
}

const M = new Function(
  [
    grabConst('MOVES_SCHEMA'), grabConst('MOVES_HORIZONS'), grabConst('MOVES_1Y_SESSIONS'),
    grabConst('MOVES_RANGE'), grabConst('SESSIONS_PER_YEAR'), grabConst('COVERAGE_MIN_INDEPENDENT'),
    'const clampTo = (x, lo, hi) => Math.min(Math.max(x, lo), hi);',
    "const CREDIT_KINDS = new Set(['credit-call-spread', 'credit-put-spread']);",
    grab('normCdf'), grab('probBeyondBreakeven'), grab('probBeyondEither'),
    grab('lowerBound'), grab('upperBound'), grab('coverageAt'), grab('coverageTwoSided'),
    grab('moveWindows'), grab('buildMoveSeries'),
    grab('terminalValue'), grab('payoffAt'), grab('capitalOf'), grab('maxGainOf'),
    grab('expectancyFrom'),
  ].join('\n') +
  '\nreturn { probBeyondBreakeven, probBeyondEither, coverageAt, coverageTwoSided,'
  + ' moveWindows, buildMoveSeries, payoffAt, capitalOf, maxGainOf, expectancyFrom };',
)();

const T = tally();
const F = (x, d = 6) => (x == null ? String(x) : Number(x).toFixed(d));
function row(label, got, want, tol = 1e-9) {
  const bad = got == null || want == null ? got !== want : Math.abs(got - want) > tol;
  record(T, !bad);
  const dev = (got == null || want == null) ? '—' : F(Math.abs(got - want), 10);
  console.log(`  ${bad ? 'FAIL' : 'ok  '}  ${label.padEnd(50)} got ${String(F(got)).padStart(14)}   want ${String(F(want)).padStart(14)}   dev ${dev}`);
}

/* ── An independent normal CDF, series-erf. Same reference nd2.check.mjs uses:
      a DIFFERENT algorithm from A&S 26.2.17, so this is not the shipped
      approximation checked against itself. ── */
function erfRef(x) {
  const ax = Math.abs(x);
  let out;
  if (ax < 3) {
    let term = ax, sum = ax;
    for (let n = 1; n < 200; n++) { term *= -ax * ax / n; sum += term / (2 * n + 1); }
    out = 2 / Math.sqrt(Math.PI) * sum;
  } else {
    let f = 1e-300, C = f, D = 0;
    for (let i = 1; i < 300; i++) {
      const a = i === 1 ? 1 : (i - 1) / 2;
      const b = i % 2 === 1 ? ax * ax : 1;
      D = b + a * D; if (D === 0) D = 1e-300;
      C = b + a / C; if (C === 0) C = 1e-300;
      D = 1 / D; f *= C * D;
    }
    out = 1 - Math.exp(-ax * ax) / Math.sqrt(Math.PI) * f;
  }
  return x >= 0 ? out : -out;
}
const cdfRef = x => 0.5 * (1 + erfRef(x / Math.SQRT2));
/** Hand-computed two-sided: N(d2 at upper) + [1 - N(d2 at lower)]. */
function twoSidedRef({ spot, beUpper, beLower, tYears, volUp, volDown, rate }) {
  const d2 = (K, v) => (Math.log(spot / K) + (rate - v * v / 2) * tYears) / (v * Math.sqrt(tYears));
  return cdfRef(d2(beUpper, volUp)) + (1 - cdfRef(d2(beLower, volDown)));
}

console.log('\n══ 1. Two-sided P(BE) vs a hand-computed reference, five prices ══');
console.log('   P(finish beyond EITHER breakeven) = N(d2_upper) + [1 - N(d2_lower)].');
console.log('   Each side takes its OWN sigma — put skew is real and the tails differ.\n');
const PB = [
  { spot: 100, beUpper: 110, beLower:  90, tYears: 45 / 365, volUp: 0.40, volDown: 0.45, rate: 0.043, label: '45d  BE +-10%  skewed vol' },
  { spot: 100, beUpper: 105, beLower:  95, tYears: 45 / 365, volUp: 0.40, volDown: 0.40, rate: 0.043, label: '45d  BE +-5%   flat vol' },
  { spot: 100, beUpper: 130, beLower:  70, tYears: 45 / 365, volUp: 0.40, volDown: 0.50, rate: 0.043, label: '45d  BE +-30%  wide strangle' },
  { spot: 313.33, beUpper: 340, beLower: 285, tYears: 41 / 365, volUp: 0.2454, volDown: 0.2680, rate: 0.0432, label: 'AAPL-shaped, real spot' },
  { spot: 100, beUpper: 160, beLower:  40, tYears: 531 / 365, volUp: 0.50, volDown: 0.55, rate: 0.043, label: '531d 50% IV  LEAPS-dated' },
];
for (const c of PB) {
  const got = M.probBeyondEither(c);
  row(c.label, got?.total ?? null, twoSidedRef(c), 2e-7);
}
console.log('\n   the split must sum to the total, exactly:');
for (const c of PB.slice(0, 3)) {
  const g = M.probBeyondEither(c);
  row(`  ${c.label} — up + down`, g.up + g.down, g.total, 1e-12);
}
console.log('\n   one-sided vs two-sided — the error if the wrong one were used:');
for (const c of PB.slice(0, 3)) {
  const g = M.probBeyondEither(c);
  console.log(`     ${c.label.padEnd(34)} one-sided(call) ${(g.up * 100).toFixed(2)}%   two-sided ${(g.total * 100).toFixed(2)}%`
    + `   understated by ${((g.total - g.up) * 100).toFixed(2)} pts`);
}
console.log('\n   degenerate inputs must return null, never a number:');
row('crossed breakevens (upper < lower)', M.probBeyondEither({ ...PB[0], beUpper: 90, beLower: 110 }), null);
row('equal breakevens', M.probBeyondEither({ ...PB[0], beUpper: 100, beLower: 100 }), null);
row('vol 0 on one side', M.probBeyondEither({ ...PB[0], volDown: 0 }), null);

console.log('\n══ 2. Two-sided COVERAGE vs brute force over raw closes ══');
console.log('   Reference re-derives every window from the close array and counts');
console.log('   linearly. It never calls coverageAt, coverageTwoSided or moveWindows.\n');

function synthCloses(n, { seed = 7, drift = 0.0002, vol = 0.02, start = 100 } = {}) {
  let s = seed, out = [start];
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 1; i < n; i++) {
    const u1 = Math.max(rnd(), 1e-12), u2 = rnd();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out.push(out[i - 1] * Math.exp(drift + vol * z));
  }
  return out;
}
/** Independent two-sided coverage. Deliberately does not reuse shipped code. */
function bruteTwoSided(closes, n, reqUp, reqDown) {
  let up = 0, down = 0, total = 0;
  for (let i = 0; i + n < closes.length; i++) {
    const r = closes[i + n] / closes[i] - 1;
    total++;
    if (r >= reqUp) up++;
    if (r <= reqDown) down++;
  }
  return total ? { upper: up / total, lower: down / total, total: (up + down) / total } : null;
}

const closes = synthCloses(760);
const series = M.buildMoveSeries('SYNTH', closes, '2026-08-10');
for (const N of [20, 45, 90]) {
  const sorted = series.horizons[String(N)].sorted3y;
  for (const [ru, rd, note] of [[0.10, -0.10, 'symmetric +-10%'], [0.05, -0.08, 'asymmetric'], [0.20, -0.15, 'wide']]) {
    const got = M.coverageTwoSided(sorted, ru, rd);
    const want = bruteTwoSided(closes, N, ru, rd);
    row(`N=${N} ${note} total`, got?.total ?? null, want?.total ?? null, 1e-12);
    row(`N=${N} ${note} upper`, got?.upper ?? null, want?.upper ?? null, 1e-12);
    row(`N=${N} ${note} lower`, got?.lower ?? null, want?.lower ?? null, 1e-12);
  }
}
console.log('\n   A TAIL THAT CONTRIBUTES ZERO — 0 is a valid answer and must not read as null:');
{
  const sorted = series.horizons['20'].sorted3y;
  const got = M.coverageTwoSided(sorted, 0.10, -0.95);      // no 20-session -95% move exists
  const want = bruteTwoSided(closes, 20, 0.10, -0.95);
  row('lower tail = 0 exactly', got?.lower ?? null, 0, 1e-12);
  row('   and it is 0, not null', got?.lower === 0, true);
  row('total still equals upper', got?.total ?? null, got?.upper ?? null, 1e-12);
  row('vs brute force', got?.total ?? null, want?.total ?? null, 1e-12);
}
console.log('\n   crossed thresholds return null rather than an over-count:');
row('reqDown > reqUp -> null', M.coverageTwoSided(series.horizons['20'].sorted3y, -0.10, 0.10), null);

console.log('\n══ 3. Straddle + strangle payoff across all four breakevens ══');
console.log('   Straddle K=100, debit $800/contract  -> BEs 92 / 108');
console.log('   Strangle 95P/105C, debit $400/contract -> BEs 91 / 109\n');
const STRAD = { kind: 'straddle', strike: 100, debit: 800 };
const STRANG = { kind: 'strangle', callStrike: 105, putStrike: 95, debit: 400 };
console.log('   straddle — hand-computed (max(0,S-100)+max(0,100-S))*100 - 800:');
for (const [S, want] of [[70, 2200], [92, 0], [100, -800], [108, 0], [130, 2200]]) {
  row(`  S=${S}`, M.payoffAt(STRAD, S), want, 1e-9);
}
console.log('   strangle — (max(0,S-105)+max(0,95-S))*100 - 400:');
for (const [S, want] of [[70, 2100], [91, 0], [100, -400], [109, 0], [130, 2100]]) {
  row(`  S=${S}`, M.payoffAt(STRANG, S), want, 1e-9);
}
console.log('\n   between the strangle strikes BOTH legs expire worthless — max loss:');
for (const S of [95, 100, 105]) row(`  S=${S} = -debit`, M.payoffAt(STRANG, S), -400, 1e-9);
console.log('\n   the strangle is cheaper AND pays less at every price outside its strikes:');
for (const S of [70, 130]) {
  const a = M.payoffAt(STRAD, S), b = M.payoffAt(STRANG, S);
  console.log(`     S=${S}  straddle ${a}   strangle ${b}   difference ${b - a}`
    + `  (cheaper by ${STRAD.debit - STRANG.debit}, pays ${a - b} less)`);
}

console.log('\n══ 4. The bound invariant and the breakeven-crossing guard ══');
{
  const sorted = series.horizons['45'].sorted3y;
  const spot = 100;
  for (const [st, be, label] of [[STRAD, 108, 'straddle @ upper BE'], [STRANG, 109, 'strangle @ upper BE']]) {
    const e = M.expectancyFrom(sorted, st, spot, be, 45);
    const okShape = e && e.ok !== false;
    row(`${label} — priced`, okShape, true);
    if (okShape) {
      const cap = M.capitalOf(st);
      const pls = sorted.map(([r]) => M.payoffAt(st, spot * (1 + r)));
      row(`  min(pl) >= -capital (${cap})`, Math.min(...pls) >= -cap - 1e-9, true);
      row('  payoff at the stated BE is ~0', Math.abs(M.payoffAt(st, be)) < Math.max(1, 0.01 * cap), true);
    }
  }
  console.log('\n   the guard must REJECT a per-share debit passed where per-contract belongs:');
  const bad = M.expectancyFrom(sorted, { kind: 'straddle', strike: 100, debit: 8 }, 100, 108, 45);
  row('rejected', bad && bad.ok === false, true);
  console.log(`     reason: ${bad?.reason?.slice(0, 96)}...`);
  console.log('\n   and REJECT a breakeven that does not belong to the structure:');
  const bad2 = M.expectancyFrom(sorted, STRAD, 100, 150, 45);
  row('rejected', bad2 && bad2.ok === false, true);
}

console.log('\n══ 5. upsideTruncated fires on both — upside is genuinely unbounded ══');
row('maxGainOf(straddle) is null', M.maxGainOf(STRAD), null);
row('maxGainOf(strangle) is null', M.maxGainOf(STRANG), null);
{
  const sorted = series.horizons['45'].sorted3y;
  const e = M.expectancyFrom(sorted, STRAD, 100, 108, 45);
  row('straddle upsideTruncated', e.upsideTruncated, true);
  const e2 = M.expectancyFrom(sorted, STRANG, 100, 109, 45);
  row('strangle upsideTruncated', e2.upsideTruncated, true);
  console.log(`   reason: ${e.upsideTruncatedReason?.slice(0, 110)}...`);
  console.log(`   episodesTo50 straddle=${e.expectancyEpisodesTo50} strangle=${e2.expectancyEpisodesTo50}`
    + `  (1 is the warning — half the expected value from ONE episode)`);
}

console.log('\n══ 6. The DRIFT CONFOUND — upper/lower split, trending vs range-bound ══');
console.log('   On a trending name drift inflates one tail and deflates the other, so a');
console.log('   healthy TOTAL can rest almost entirely on one side. Summing hides it.\n');
const REGIMES = [
  ['strong uptrend  (drift +0.0016/session)', synthCloses(760, { seed: 11, drift: 0.0016, vol: 0.022 })],
  ['range-bound     (drift  0.0000/session)', synthCloses(760, { seed: 11, drift: 0.0000, vol: 0.022 })],
  ['downtrend       (drift -0.0016/session)', synthCloses(760, { seed: 11, drift: -0.0016, vol: 0.022 })],
];
console.log('   required move +-12% at N=45:');
let lopsided = null, balanced = null;
for (const [label, cl] of REGIMES) {
  const s = M.buildMoveSeries('X', cl, '2026-08-10').horizons['45'].sorted3y;
  const c = M.coverageTwoSided(s, 0.12, -0.12);
  const share = c.total > 0 ? c.upper / c.total : null;
  console.log(`     ${label}  total ${(c.total * 100).toFixed(1)}%  =  upper ${(c.upper * 100).toFixed(1)}%`
    + ` + lower ${(c.lower * 100).toFixed(1)}%   upper share ${share == null ? 'n/a' : (share * 100).toFixed(0) + '%'}`);
  if (label.startsWith('strong uptrend')) lopsided = share;
  if (label.startsWith('range-bound')) balanced = share;
}
row('uptrend upper-share > 0.80 (lopsided)', lopsided > 0.80, true);
row('range-bound is nearer balanced than the trend', Math.abs(balanced - 0.5) < Math.abs(lopsided - 0.5), true);
console.log('\n   THE READING: on the uptrend the coverage total is carried by the up-tail,');
console.log('   so the structure is closer to a long call than to a volatility trade.');

if (!populated('lane-e two-sided comparisons', T.comparisons)) process.exitCode = 1;
process.exitCode = reportVerdict({
  label: 'lane-e.check', comparisons: T.comparisons, failures: T.failures, minComparisons: 70,
}) || process.exitCode || 0;
