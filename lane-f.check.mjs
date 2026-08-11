/* Lane F — defined-risk credit spreads.
 *
 * The credit-spread payoff functions have existed since the §6.2 work and until
 * now had NO CALLER. Both branches of `terminalValue`, the `CREDIT_KINDS` branch
 * of `payoffAt`, and the `width × 100 − credit` branch of `capitalOf` execute for
 * the first time on real data with this lane. Untested-because-uncalled is exactly
 * how a wrong sign ships, so they are checked here against hand-computed values
 * before anything renders.
 *
 * Sections:
 *   1. Both credit payoffs at five prices each, hand-computed.
 *   2. capitalOf = width × 100 − credit, NOT the credit. The single most
 *      consequential line in the lane.
 *   3. min(pl) >= -capital and the breakeven-crossing guard, both structures.
 *   4. No credit-spread expectancy above 1.0, and the algebra saying when that
 *      bound can legitimately break.
 *   5. The DIRECTION INVERSION: coverage for a credit spread must measure the
 *      win, which is the opposite direction to a long option of the same side.
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
    grabConst('PREM_TARGETS'), grabConst('LANE_F_SHORT'), grabConst('LANE_F_LONG'),
    'const clampTo = (x, lo, hi) => Math.min(Math.max(x, lo), hi);',
    "const CREDIT_KINDS = new Set(['credit-call-spread', 'credit-put-spread']);",
    grab('lowerBound'), grab('upperBound'), grab('coverageAt'),
    grab('moveWindows'), grab('buildMoveSeries'),
    grab('terminalValue'), grab('payoffAt'), grab('capitalOf'), grab('maxGainOf'),
    grab('expectancyFrom'),
  ].join('\n') +
  '\nreturn { terminalValue, payoffAt, capitalOf, maxGainOf, expectancyFrom, coverageAt,'
  + ' buildMoveSeries, LANE_F_SHORT, LANE_F_LONG, PREM_TARGETS };',
)();

const T = tally();
const F = (x, d = 4) => (x == null ? String(x) : Number(x).toFixed(d));
function row(label, got, want, tol = 1e-9) {
  const bad = got == null || want == null ? got !== want : Math.abs(got - want) > tol;
  record(T, !bad);
  console.log(`  ${bad ? 'FAIL' : 'ok  '}  ${label.padEnd(50)} got ${String(F(got)).padStart(13)}   want ${String(F(want)).padStart(13)}`);
}

console.log('\n══ 0. The lane reuses PREM_TARGETS rather than re-choosing deltas ══');
row('LANE_F_SHORT === PREM_TARGETS[0]', M.LANE_F_SHORT, M.PREM_TARGETS[0]);
row('LANE_F_LONG  === PREM_TARGETS[1]', M.LANE_F_LONG,  M.PREM_TARGETS[1]);

/* Bull put spread: short 95 put, long 90 put, $1.50 credit/share = $150/contract.
   width 5 -> max loss 500 - 150 = 350. Breakeven 95 - 1.50 = 93.50. */
const PUT = { kind: 'credit-put-spread', shortStrike: 95, longStrike: 90, width: 5, credit: 150 };
/* Bear call spread: short 105 call, long 110 call, $1.20 credit = $120/contract.
   width 5 -> max loss 500 - 120 = 380. Breakeven 105 + 1.20 = 106.20. */
const CALL = { kind: 'credit-call-spread', shortStrike: 105, longStrike: 110, width: 5, credit: 120 };

console.log('\n══ 1. Credit payoffs at five prices — hand-computed, first-ever caller ══');
console.log('   bull put 95/90, credit $150/contract, max loss $350, BE 93.50');
for (const [S, want] of [[110, 150], [95, 150], [93.5, 0], [92, -150], [85, -350]]) {
  row(`  S=${S}`, M.payoffAt(PUT, S), want);
}
console.log('   bear call 105/110, credit $120/contract, max loss $380, BE 106.20');
for (const [S, want] of [[90, 120], [105, 120], [106.2, 0], [108, -180], [120, -380]]) {
  row(`  S=${S}`, M.payoffAt(CALL, S), want);
}
console.log('\n   the loss is CAPPED by the wing — this is the whole point of the lane:');
row('put spread at S=0 is still only -maxLoss',  M.payoffAt(PUT, 0),   -350);
row('call spread at S=1e6 is still -maxLoss',    M.payoffAt(CALL, 1e6), -380);

console.log('\n══ 2. capitalOf = width × 100 − credit, NOT the credit ══');
row('capitalOf(put)  = 500 - 150', M.capitalOf(PUT), 350);
row('capitalOf(call) = 500 - 120', M.capitalOf(CALL), 380);
row('maxGainOf(put)  = credit',    M.maxGainOf(PUT), 150);
row('maxGainOf(call) = credit',    M.maxGainOf(CALL), 120);
console.log('   if capital were the CREDIT instead, expectancy would be inflated by:');
console.log(`     put  ${(350 / 150).toFixed(2)}×      call ${(380 / 120).toFixed(2)}×`);

console.log('\n══ 3. Bound invariant + breakeven guard, both structures ══');
function synthCloses(n, { seed = 5, drift = 0.0003, vol = 0.02, start = 100 } = {}) {
  let s = seed, out = [start];
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 1; i < n; i++) {
    const u1 = Math.max(rnd(), 1e-12), u2 = rnd();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out.push(out[i - 1] * Math.exp(drift + vol * z));
  }
  return out;
}
const series = M.buildMoveSeries('SYNTH', synthCloses(760), '2026-08-10');
const arr = series.horizons['45'].sorted3y;
for (const [st, be, label] of [[PUT, 93.5, 'bull put spread'], [CALL, 106.2, 'bear call spread']]) {
  const e = M.expectancyFrom(arr, st, 100, be, 45);
  const okShape = e && e.ok !== false;
  row(`${label} priced`, okShape, true);
  if (okShape) {
    const cap = M.capitalOf(st);
    const pls = arr.map(([r]) => M.payoffAt(st, 100 * (1 + r)));
    row('  min(pl) >= -capital', Math.min(...pls) >= -cap - 1e-9, true);
    row('  max(pl) <= maxGain',  Math.max(...pls) <= M.maxGainOf(st) + 1e-9, true);
    row('  payoff at stated BE ~ 0', Math.abs(M.payoffAt(st, be)) < Math.max(1, 0.01 * cap), true);
    row('  expectancy <= 1.0', e.expectancyMean <= 1.0, true);
    console.log(`     E[R] ${(e.expectancyMean * 100).toFixed(1)}%  win ${(e.expectancyWinRate * 100).toFixed(1)}%`
      + `  episodesTo50 ${e.expectancyEpisodesTo50}  windows ${e.expectancyWindows}`);
  }
}
console.log('\n   a wrong breakeven must be REJECTED, not priced:');
const badBe = M.expectancyFrom(arr, PUT, 100, 90, 45);
row('rejected', badBe && badBe.ok === false, true);
console.log(`     ${badBe?.reason?.slice(0, 100)}...`);

console.log('\n   capital denominated on the CREDIT must breach the bound:');
const wrongCap = { ...PUT, width: 1.5 };   // width*100 == credit -> capital 0
row('capitalOf returns null, not 0', M.capitalOf(wrongCap), null);
row('expectancyFrom refuses it', M.expectancyFrom(arr, wrongCap, 100, 93.5, 45), null);

console.log('\n══ 4. The <= 1.0 ceiling, and when it can legitimately break ══');
console.log('   expectancy <= maxGain/capital = credit / (width*100 - credit).');
console.log('   That exceeds 1 only when credit > width*50 — i.e. the credit is more');
console.log('   than HALF the width. At 0.30/0.16 deltas that is not a normal quote,');
console.log('   so a Lane F expectancy above 1.0 is a denominator bug until proven otherwise.');
for (const [w, cr, note] of [[5, 150, 'normal 30/16 spread'], [5, 240, 'rich but < half width'], [5, 260, 'credit > half width']]) {
  const st = { kind: 'credit-put-spread', shortStrike: 95, longStrike: 95 - w, width: w, credit: cr };
  const ceil = M.maxGainOf(st) / M.capitalOf(st);
  console.log(`     width ${w} credit ${cr}  ->  ceiling ${ceil.toFixed(3)}  ${ceil > 1 ? '<-- CAN exceed 1.0' : ''}  (${note})`);
}
row('normal spread ceiling <= 1.0', M.maxGainOf(PUT) / M.capitalOf(PUT) <= 1.0, true);

console.log('\n══ 5. THE DIRECTION INVERSION — coverage must measure the WIN ══');
console.log('   A bull put spread wins ABOVE its breakeven, so its coverage is dir "up"');
console.log('   at a NEGATIVE threshold. A long put of the same side uses "down".');
console.log('   Getting this from `type` would report the LOSS frequency.\n');
const reqPut = 93.5 / 100 - 1;      // -0.065
const win  = M.coverageAt(arr, reqPut, 'up');
const lose = M.coverageAt(arr, reqPut, 'down');
row('win  = P(r >= -6.5%)', win, 1 - lose, 1e-12);
/* NOT a strict partition in general: `coverageAt` counts a return exactly equal
   to the threshold as covered on BOTH sides, by design, so win+lose can exceed 1
   when a window lands exactly on the breakeven. It sums to 1 here because this
   series has no exact tie at -6.5%. Asserted at the value, not as a law. */
row('win + lose = 1 (no exact tie in this series)', win + lose, 1, 1e-12);
console.log(`     win ${(win * 100).toFixed(1)}%   lose ${(lose * 100).toFixed(1)}%`
  + `   -- reporting the wrong one would be ${((win - lose) * 100).toFixed(1)} pts out`);
row('win is the LARGER for a 0.30-delta short', win > lose, true);
console.log('\n   bear call spread: wins BELOW, so dir "down" at a POSITIVE threshold:');
const reqCall = 106.2 / 100 - 1;
const winC = M.coverageAt(arr, reqCall, 'down');
row('win = P(r <= +6.2%)', winC, 1 - M.coverageAt(arr, reqCall, 'up'), 1e-12);
console.log(`     win ${(winC * 100).toFixed(1)}%`);

if (!populated('lane-f comparisons', T.comparisons)) process.exitCode = 1;
process.exitCode = reportVerdict({
  label: 'lane-f.check', comparisons: T.comparisons, failures: T.failures, minComparisons: 36,
}) || process.exitCode || 0;
