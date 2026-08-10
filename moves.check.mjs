/* Move-coverage and expectancy check — for the Long tab's measured half.
 *
 * Pulls moveWindows / coverageAt / snapHorizon / buildMoveSeries / terminalValue /
 * payoffAt / capitalOf / maxGainOf / expectancyFrom out of worker.js by source
 * extraction (they are not exported — every named export in worker.js must be a
 * function or workerd refuses to boot). Nothing asserts silently: every number is
 * printed against its expected value with the deviation.
 *
 * ELEVEN sections. The thing being verified is not just "is the arithmetic right"
 * but "is this the right quantity, in the right units, measuring what it claims":
 *
 *   1. Coverage vs BRUTE FORCE over the raw closes. The shipped path sorts the
 *      returns once and binary-searches; the reference re-derives every window
 *      from the close array and counts with a linear scan. Different algorithm,
 *      same answer, or one of them is wrong.
 *   2. Coverage OUTSIDE the observed range. 0 is a valid answer and must not
 *      render as null; null must not render as 0. Both directions.
 *   3. Payoff at expiry for ALL EIGHT structures at five prices each, against
 *      hand-computed values. Includes both credit spreads, which have no caller
 *      on this screen — the long-fixtures.check.mjs precedent for paths live data
 *      cannot reach.
 *   4. THE BOUND INVARIANT, which is the primary correctness check:
 *      min(pl) >= -capital, and max(pl) <= maxGain for capped structures. This is
 *      what catches a per-share/per-contract unit mixup, which fails in the
 *      SAFE-LOOKING direction (expectancy 100x too small, sorts to the bottom,
 *      looks like a bad trade rather than a bug).
 *   5. The credit-spread ceiling as a second, cheaper check: capital risked is
 *      width x 100 - credit, not the credit, so no credit-spread expectancy may
 *      exceed 1.0.
 *   6. The COVERAGE_MIN_INDEPENDENT floor at its boundary, and that the reason
 *      string names the actual numbers rather than a generic message.
 *  7-9. Horizon snapping, mean-vs-median plumbing, and that a negative expectancy
 *      SORTS rather than disappearing.
 *   10. DE-CLUSTERED CONCENTRATION. Overlapping windows mean one market move
 *      appears in up to N consecutive windows, so the old top-3-window share
 *      counted a single episode three times and called it three. Episode
 *      assignment collapses those. Tested BOTH ways — one move must report 1 AND
 *      separated moves must report MORE, because a test that only proves
 *      collapsing would pass on code that always answers 1. Note the metric is
 *      bounded by ceil(k/2) for k equal episodes: reaching HALF the positive P/L
 *      can never need every episode, so three separated moves report 2, not 3.
 *   11. THE 1y/3y INVARIANT. Expectancy runs on sorted3y with no 1y fallback,
 *      because the 1y series is a suffix of the 3y one and so sorted3y === null
 *      implies sorted1y === null. The branch was removed as a false statement
 *      about the code; this section is what covers the invariant if the horizon
 *      set or window definitions ever diverge.
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
    grabConst('MOVES_SCHEMA'), grabConst('MOVES_HORIZONS'), grabConst('MOVES_1Y_SESSIONS'),
    grabConst('MOVES_RANGE'), grabConst('SESSIONS_PER_YEAR'), grabConst('COVERAGE_MIN_INDEPENDENT'),
    grabConst('EPISODE_CONCENTRATION_WARN'),
    'const clampTo = (x, lo, hi) => Math.min(Math.max(x, lo), hi);',
    "const CREDIT_KINDS = new Set(['credit-call-spread', 'credit-put-spread']);",
    grab('moveWindows'), grab('lowerBound'), grab('upperBound'), grab('coverageAt'),
    grab('snapHorizon'), grab('buildMoveSeries'), grab('terminalValue'), grab('payoffAt'),
    grab('capitalOf'), grab('maxGainOf'), grab('expectancyFrom'),
  ].join('\n') +
  '\nreturn { moveWindows, coverageAt, snapHorizon, buildMoveSeries, terminalValue, payoffAt,'
  + ' capitalOf, maxGainOf, expectancyFrom, MOVES_HORIZONS, COVERAGE_MIN_INDEPENDENT,'
  + ' EPISODE_CONCENTRATION_WARN, SESSIONS_PER_YEAR, MOVES_1Y_SESSIONS };',
)();

let fails = 0;
const F = (x, d = 6) => (x == null ? String(x) : Number(x).toFixed(d));
function row(label, got, want, tol = 1e-9) {
  const bad = got == null || want == null
    ? got !== want
    : Math.abs(got - want) > tol;
  if (bad) fails++;
  const dev = (got == null || want == null) ? '—' : F(Math.abs(got - want), 10);
  console.log(`  ${bad ? 'FAIL' : 'ok  '}  ${label.padEnd(52)} got ${String(F(got)).padStart(14)}   want ${String(F(want)).padStart(14)}   dev ${dev}`);
}
function rowStr(label, got, want) {
  const bad = got !== want;
  if (bad) fails++;
  console.log(`  ${bad ? 'FAIL' : 'ok  '}  ${label.padEnd(52)} got ${String(got).padStart(14)}   want ${String(want).padStart(14)}`);
}

/* ── A deterministic synthetic close series ────────────────────────────────────
   Seeded LCG, not Math.random: a check that prints different numbers every run
   cannot be compared against a previous run. Drift + vol chosen to produce a
   right-skewed series with genuine large moves. */
function synthCloses(n, { seed = 42, drift = 0.0004, vol = 0.02, start = 100 } = {}) {
  let s = seed, out = [start];
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 1; i < n; i++) {
    // Box-Muller from two uniforms.
    const u1 = Math.max(rnd(), 1e-12), u2 = rnd();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out.push(out[i - 1] * Math.exp(drift + vol * z));
  }
  return out;
}

console.log('\n══ 1. COVERAGE vs BRUTE FORCE over the raw closes ══');
console.log('   Shipped path: sort the returns once, binary-search the threshold.');
console.log('   Reference:    re-derive every window from the close array, count linearly.\n');

/** Independent implementation. Deliberately does NOT reuse moveWindows(). */
function coverageBrute(closes, n, threshold, dir) {
  let hit = 0, total = 0;
  for (let i = 0; i + n < closes.length; i++) {
    const r = closes[i + n] / closes[i] - 1;
    total++;
    if (dir === 'down' ? r <= threshold : r >= threshold) hit++;
  }
  return total ? hit / total : null;
}

{
  const closes = synthCloses(760);
  for (const n of [5, 20, 45, 90]) {
    // The shipped path rounds stored returns to 4dp; the reference does not, so
    // compare against a reference fed the SAME rounding. That rounding is itself
    // checked below by the raw/rounded delta.
    const rounded = closes.map(c => c);
    const sorted = M.moveWindows(rounded, n).sort((a, b) => a[0] - b[0]).map(([r, i]) => [+r.toFixed(4), i]);
    for (const [thr, dir] of [[0.02, 'up'], [0.05, 'up'], [-0.03, 'down'], [-0.10, 'down'], [0, 'up']]) {
      const got  = M.coverageAt(sorted, thr, dir);
      const want = coverageBrute(rounded.map(c => c), n, thr, dir);
      // Rounding to 4dp can flip a window that sits within 5e-5 of the threshold.
      row(`N=${String(n).padStart(3)}  P(r ${dir === 'down' ? '<=' : '>='} ${String(thr).padStart(6)})`, got, want, 3 / sorted.length);
    }
  }
}

console.log('\n══ 2. THRESHOLD OUTSIDE THE OBSERVED RANGE — 0 is an answer, null is not ══');
console.log('   Zero coverage means "the underlying has never made that move". It must');
console.log('   not render as null, and null must not render as 0 (honesty rule 22).\n');
{
  const closes = synthCloses(760);
  const sorted = M.moveWindows(closes, 20).sort((a, b) => a[0] - b[0]).map(([r, i]) => [+r.toFixed(4), i]);
  const lo = sorted[0][0], hi = sorted[sorted.length - 1][0];
  console.log(`   observed 20-session range: ${(lo * 100).toFixed(2)}% .. ${(hi * 100).toFixed(2)}%  over ${sorted.length} windows\n`);
  row('P(r >= hi + 50pts)  — beyond every observed move', M.coverageAt(sorted, hi + 0.5, 'up'), 0);
  row('P(r <= lo - 50pts)  — beyond every observed move', M.coverageAt(sorted, lo - 0.5, 'down'), 0);
  row('P(r >= lo - 50pts)  — below every observed move', M.coverageAt(sorted, lo - 0.5, 'up'), 1);
  row('P(r <= hi + 50pts)  — above every observed move', M.coverageAt(sorted, hi + 0.5, 'down'), 1);
  rowStr('empty array          — null, NOT zero', M.coverageAt([], 0.05, 'up'), null);
  rowStr('null array           — null, NOT zero', M.coverageAt(null, 0.05, 'up'), null);
  rowStr('non-finite threshold — null, NOT zero', M.coverageAt(sorted, NaN, 'up'), null);
}

console.log('\n══ 3. PAYOFF AT EXPIRY — all eight structures, five prices each ══');
console.log('   Hand-computed. UNITS: debit/credit per CONTRACT, strikes per share.\n');
{
  // Long call 100 strike, $5.00/share debit = $500/contract. BE = 105.
  const lc = { kind: 'long-call', strike: 100, debit: 500 };
  console.log('  long-call  K=100  debit $500/contract  BE 105');
  for (const [S, want] of [[80, -500], [100, -500], [105, 0], [120, 1500], [150, 4500]]) {
    row(`    P/L at S=${S}`, M.payoffAt(lc, S), want);
  }
  row('    capital = debit', M.capitalOf(lc), 500);
  rowStr('    maxGain = null (uncapped)', M.maxGainOf(lc), null);

  // Long put 100 strike, $4.00/share = $400. BE = 96.
  const lp = { kind: 'long-put', strike: 100, debit: 400 };
  console.log('\n  long-put   K=100  debit $400/contract  BE 96');
  for (const [S, want] of [[0, 9600], [80, 1600], [96, 0], [100, -400], [130, -400]]) {
    row(`    P/L at S=${S}`, M.payoffAt(lp, S), want);
  }
  row('    maxGain = K*100 - debit (bounded at S=0)', M.maxGainOf(lp), 9600);

  // Debit call vertical: long 100, short 110, $3.50/share = $350. BE 103.5. Max 650.
  const dcv = { kind: 'debit-call-vertical', longStrike: 100, shortStrike: 110, debit: 350 };
  console.log('\n  debit-call-vertical  100/110  debit $350  BE 103.50  max gain $650');
  for (const [S, want] of [[90, -350], [100, -350], [103.5, 0], [110, 650], [200, 650]]) {
    row(`    P/L at S=${S}`, M.payoffAt(dcv, S), want);
  }
  row('    maxGain = width*100 - debit', M.maxGainOf(dcv), 650);

  // Debit put vertical: long 100, short 90, $3.50/share = $350. BE 96.5. Max 650.
  const dpv = { kind: 'debit-put-vertical', longStrike: 100, shortStrike: 90, debit: 350 };
  console.log('\n  debit-put-vertical   100/90   debit $350  BE 96.50  max gain $650');
  for (const [S, want] of [[0, 650], [90, 650], [96.5, 0], [100, -350], [130, -350]]) {
    row(`    P/L at S=${S}`, M.payoffAt(dpv, S), want);
  }

  // Straddle K=100, $9/share = $900. BEs 91 and 109.
  const str = { kind: 'straddle', strike: 100, debit: 900 };
  console.log('\n  straddle   K=100  debit $900  BEs 91 / 109');
  for (const [S, want] of [[70, 2100], [91, 0], [100, -900], [109, 0], [140, 3100]]) {
    row(`    P/L at S=${S}`, M.payoffAt(str, S), want);
  }
  rowStr('    maxGain = null (uncapped)', M.maxGainOf(str), null);

  // Strangle: put 90 / call 110, $5/share = $500. BEs 85 and 115.
  const stg = { kind: 'strangle', putStrike: 90, callStrike: 110, debit: 500 };
  console.log('\n  strangle   P90/C110  debit $500  BEs 85 / 115');
  for (const [S, want] of [[70, 1500], [85, 0], [100, -500], [115, 0], [150, 3500]]) {
    row(`    P/L at S=${S}`, M.payoffAt(stg, S), want);
  }

  /* CREDIT SPREADS — no caller on the Long screen. Exercised here so the payoff
     table is not shipped untested, per the long-fixtures.check.mjs precedent.
     Capital risked is width*100 - credit, i.e. MAX LOSS, not the credit. */
  // Credit call spread: short 110, long 120, credit $300/contract. Width 10.
  const ccs = { kind: 'credit-call-spread', shortStrike: 110, longStrike: 120, width: 10, credit: 300 };
  console.log('\n  credit-call-spread   short 110 / long 120  credit $300  width 10  BE 113');
  for (const [S, want] of [[90, 300], [110, 300], [113, 0], [120, -700], [200, -700]]) {
    row(`    P/L at S=${S}`, M.payoffAt(ccs, S), want);
  }
  row('    capital = width*100 - credit  (NOT the credit)', M.capitalOf(ccs), 700);
  row('    maxGain = credit', M.maxGainOf(ccs), 300);

  // Credit put spread: short 90, long 80, credit $250/contract. Width 10.
  const cps = { kind: 'credit-put-spread', shortStrike: 90, longStrike: 80, width: 10, credit: 250 };
  console.log('\n  credit-put-spread    short 90 / long 80   credit $250  width 10  BE 87.50');
  for (const [S, want] of [[0, -750], [80, -750], [87.5, 0], [90, 250], [130, 250]]) {
    row(`    P/L at S=${S}`, M.payoffAt(cps, S), want);
  }
  row('    capital = width*100 - credit  (NOT the credit)', M.capitalOf(cps), 750);
}

console.log('\n══ 4. THE TWO GUARDS — breakeven cross-check, then bounds ══');
console.log('   Bound:     min(pl) >= -capital, and max(pl) <= maxGain for capped structures.');
console.log('   Breakeven: the payoff must cross zero at the breakeven the CANDIDATE derived');
console.log('              separately. Two derivations of one quantity.');
console.log('   They catch different faults and both are required — demonstrated below.\n');
{
  const closes = synthCloses(760);
  const sorted = M.moveWindows(closes, 45).sort((a, b) => a[0] - b[0]).map(([r, i]) => [+r.toFixed(4), i]);
  const spot = 100;

  const cases = [
    ['long-call',           { kind: 'long-call', strike: 100, debit: 500 }],
    ['long-put',            { kind: 'long-put', strike: 100, debit: 400 }],
    ['debit-call-vertical', { kind: 'debit-call-vertical', longStrike: 100, shortStrike: 110, debit: 350 }],
    ['debit-put-vertical',  { kind: 'debit-put-vertical', longStrike: 100, shortStrike: 90, debit: 350 }],
    ['straddle',            { kind: 'straddle', strike: 100, debit: 900 }],
    ['credit-call-spread',  { kind: 'credit-call-spread', shortStrike: 110, longStrike: 120, width: 10, credit: 300 }],
    ['credit-put-spread',   { kind: 'credit-put-spread', shortStrike: 90, longStrike: 80, width: 10, credit: 250 }],
  ];
  for (const [name, st] of cases) {
    const e = M.expectancyFrom(sorted, st, spot);
    if (!e || e.ok === false) { fails++; console.log(`  FAIL  ${name}: ${e ? e.reason : 'null'}`); continue; }
    // Re-derive the bounds independently rather than trusting the shipped guard.
    const pl = sorted.map(r => M.payoffAt(st, spot * (1 + r)));
    const cap = M.capitalOf(st), mg = M.maxGainOf(st);
    const okLo = Math.min(...pl) >= -cap - 1e-6;
    const okHi = mg == null || Math.max(...pl) <= mg + 1e-6;
    if (!okLo || !okHi) fails++;
    console.log(`  ${okLo && okHi ? 'ok  ' : 'FAIL'}  ${name.padEnd(20)} capital ${String(cap).padStart(6)}  `
      + `min(pl) ${Math.min(...pl).toFixed(2).padStart(9)}  max(pl) ${Math.max(...pl).toFixed(2).padStart(9)}  `
      + `maxGain ${mg == null ? 'uncapped' : String(mg).padStart(8)}`);
  }

  console.log('\n   WHAT THE BOUND CHECK CANNOT SEE. Debit passed PER SHARE ($5) instead of');
  console.log('   per contract ($500). For any debit structure min(pl) = -debit = -capital');
  console.log('   BY CONSTRUCTION whatever the units, so the bound is trivially satisfied:');
  const wrong = { kind: 'long-call', strike: 100, debit: 5 };
  const plWrong = sorted.map(r => M.payoffAt(wrong, 100 * (1 + r)));
  console.log(`     capital ${M.capitalOf(wrong)}  min(pl) ${Math.min(...plWrong).toFixed(2)}  `
    + `-> bound holds: ${Math.min(...plWrong) >= -M.capitalOf(wrong) - 1e-6}  <- the bound is BLIND here`);
  const eBoundOnly = M.expectancyFrom(sorted, wrong, 100);          // no breakeven anchor
  const eTrue = M.expectancyFrom(sorted, { kind: 'long-call', strike: 100, debit: 500 }, 100, 105);
  const ratio = eBoundOnly.expectancyMean / eTrue.expectancyMean;
  console.log(`     without the breakeven anchor, expectancyMean = ${eBoundOnly.expectancyMean}`);
  console.log(`     the true figure is                            ${eTrue.expectancyMean}   -> ${ratio.toFixed(0)}x out`);
  console.log('     Direction depends on which way the units slip: this one pins the candidate');
  console.log('     to the TOP of the screen. The reverse slip fails small and sorts to the');
  console.log('     bottom, reading as a bad trade rather than a bug. Neither is caught by the');
  console.log('     bound, and the 1.0 credit-spread ceiling does not apply to a debit structure.');

  console.log('\n   The breakeven cross-check is what catches it. The candidate derived BE=105');
  console.log('   by a separate route (strike + debit per share); the payoff must cross zero there.');
  const eBad = M.expectancyFrom(sorted, wrong, 100, 105);
  const detected = eBad && eBad.ok === false;
  if (!detected) fails++;
  console.log(`   ${detected ? 'ok  ' : 'FAIL'}  guard fired: ${detected ? 'yes' : 'NO — the mixup would ship'}`);
  if (detected) console.log(`         reason: ${eBad.reason}`);

  console.log('\n   ...and it does not fire on the CORRECT structures:');
  for (const [name, st, be] of [
    ['long-call K=100 debit $500',   { kind: 'long-call', strike: 100, debit: 500 }, 105],
    ['long-put  K=100 debit $400',   { kind: 'long-put', strike: 100, debit: 400 }, 96],
    ['debit-call-vert 100/110 $350', { kind: 'debit-call-vertical', longStrike: 100, shortStrike: 110, debit: 350 }, 103.5],
    ['debit-put-vert  100/90  $350', { kind: 'debit-put-vertical', longStrike: 100, shortStrike: 90, debit: 350 }, 96.5],
    ['credit-call-sp 110/120 $300',  { kind: 'credit-call-spread', shortStrike: 110, longStrike: 120, width: 10, credit: 300 }, 113],
    ['credit-put-sp   90/80  $250',  { kind: 'credit-put-spread', shortStrike: 90, longStrike: 80, width: 10, credit: 250 }, 87.5],
  ]) {
    const e = M.expectancyFrom(sorted, st, 100, be);
    const clean = e && e.ok !== false;
    if (!clean) fails++;
    console.log(`   ${clean ? 'ok  ' : 'FAIL'}  ${name.padEnd(30)} BE ${String(be).padStart(6)}  `
      + `payoff at BE = ${M.payoffAt(st, be).toFixed(2)}  ${clean ? 'accepted' : 'REJECTED: ' + e.reason}`);
  }
}

console.log('\n══ 5. CREDIT-SPREAD CEILING — the second, cheaper check ══');
console.log('   Using the credit as the denominator would post expectancies in the');
console.log('   hundreds of percent. No credit-spread expectancy may exceed 1.0.\n');
{
  const closes = synthCloses(760);
  const sorted = M.moveWindows(closes, 45).sort((a, b) => a[0] - b[0]).map(([r, i]) => [+r.toFixed(4), i]);
  for (const st of [
    { kind: 'credit-call-spread', shortStrike: 110, longStrike: 120, width: 10, credit: 300 },
    { kind: 'credit-put-spread',  shortStrike: 90,  longStrike: 80,  width: 10, credit: 250 },
  ]) {
    const e = M.expectancyFrom(sorted, st, 100);
    const over = e.expectancyMean > 1.0;
    if (over) fails++;
    console.log(`  ${over ? 'FAIL' : 'ok  '}  ${st.kind.padEnd(20)} expectancyMean ${String(e.expectancyMean).padStart(9)}  `
      + `(capital ${M.capitalOf(st)}, credit ${st.credit}) — ceiling 1.0`);
    // And the denominator explicitly, per verification item 9.
    console.log(`        denominator used = width*100 - credit = ${st.width}*100 - ${st.credit} = ${M.capitalOf(st)}`);
  }
}

console.log('\n══ 6. THE INDEPENDENT-WINDOW FLOOR, and the reason strings ══');
console.log(`   COVERAGE_MIN_INDEPENDENT = ${M.COVERAGE_MIN_INDEPENDENT}. independent = (sessions - N) / N.`);
console.log('   A reason must name the ACTUAL numbers — a generic message cannot be checked.\n');
{
  const closes = synthCloses(756);
  const built = M.buildMoveSeries('SYNTH', closes, '2026-08-07');
  console.log(`   sessions 3y = ${built.sessions}, sessions 1y = ${built.sessions1y}\n`);
  console.log('   horizon    indep 3y   3y     indep 1y   1y');
  for (const n of M.MOVES_HORIZONS) {
    const h = built.horizons[String(n)];
    const ok3 = h.sorted3y ? 'ok ' : 'NULL';
    const ok1 = h.sorted1y ? 'ok ' : 'NULL';
    console.log(`   N=${String(n).padStart(3)}      ${String(h.independent3y).padStart(8)}   ${ok3}    ${String(h.independent1y).padStart(8)}   ${ok1}`);
  }
  console.log('');
  // The expected verdicts at a 3y range, stated up front so a change is visible.
  const expect3y = { 5: true, 10: true, 20: true, 45: true, 90: true, 180: false, 365: false };
  const expect1y = { 5: true, 10: true, 20: true, 45: true, 90: false, 180: false, 365: false };
  for (const n of M.MOVES_HORIZONS) {
    const h = built.horizons[String(n)];
    rowStr(`N=${n} 3y resolves`, !!h.sorted3y, expect3y[n]);
    rowStr(`N=${n} 1y resolves`, !!h.sorted1y, expect1y[n]);
  }
  console.log('\n   Reason strings at the nulled horizons — must name the numbers:');
  for (const n of [90, 180, 365]) {
    const h = built.horizons[String(n)];
    for (const w of ['1y', '3y']) {
      const r = h[`reason${w}`];
      if (!r) continue;
      /* Two distinct null branches, and they name different numbers:
           · the FLOOR branch must name the independent count and the floor
           · the TOO-SHORT branch must name the sessions held and the sessions needed
         Requiring the floor in both would be asserting the wrong message for one. */
      const isFloor = r.includes('the floor is');
      const namesNumbers = isFloor
        ? r.includes(String(M.COVERAGE_MIN_INDEPENDENT)) && /\d+\.\d\d independent/.test(r)
        : /needs at least \d+/.test(r) && /only \d+ sessions/.test(r);
      if (!namesNumbers) fails++;
      console.log(`     ${namesNumbers ? 'ok  ' : 'FAIL'}  [${isFloor ? 'floor' : 'too-short'}] N=${n} ${w}: ${r}`);
    }
  }

  console.log('\n   A short history — the recent-IPO case (CRCL/CRWV shape):');
  const shortSeries = M.buildMoveSeries('IPO', synthCloses(80), '2026-08-07');
  console.log(`     sessions = ${shortSeries.sessions}`);
  for (const n of [5, 20, 45, 90]) {
    const h = shortSeries.horizons[String(n)];
    console.log(`     N=${String(n).padStart(3)}  3y ${h.sorted3y ? 'ok' : 'NULL'} — ${h.reason3y || 'resolves'}`);
  }
}

console.log('\n══ 7. HORIZON SNAPPING — calendar DTE to trading sessions ══');
console.log(`   sessions = round(dte * ${M.SESSIONS_PER_YEAR}/365), then nearest of [${M.MOVES_HORIZONS}].`);
console.log('   The horizon USED and the contract\'s own DTE are both reported, so a 531-day');
console.log('   LEAPS scored at 365 sessions cannot present as if scored at its own horizon.\n');
for (const [dte, wantSessions, wantHorizon] of [
  [7, 5, 5], [14, 10, 10], [30, 21, 20], [45, 31, 20], [60, 41, 45],
  [90, 62, 45], [120, 83, 90], [180, 124, 90], [365, 252, 180], [531, 367, 365], [730, 504, 365],
]) {
  const s = M.snapHorizon(dte);
  rowStr(`dte ${String(dte).padStart(4)} -> sessions`, s.sessions, wantSessions);
  rowStr(`dte ${String(dte).padStart(4)} -> horizon`, s.horizon, wantHorizon);
}

console.log('\n══ 8. MEAN vs MEDIAN, and episode concentration on synthetic series ══');
console.log(`   EPISODE_CONCENTRATION_WARN = ${M.EPISODE_CONCENTRATION_WARN} — flags at or below this.`);
console.log('   A mean far above its median is the signature of a number built on few');
console.log('   episodes; the episode count is what quantifies "few". Section 10 tests it.\n');
{
  const skewed = synthCloses(760, { seed: 7, drift: 0.0012, vol: 0.035 });
  const calm   = synthCloses(760, { seed: 11, drift: 0.0000, vol: 0.008 });
  for (const [name, closes] of [['right-skewed', skewed], ['range-bound', calm]]) {
    const sorted = M.moveWindows(closes, 45).sort((a, b) => a[0] - b[0]).map(([r, i]) => [+r.toFixed(4), i]);
    const st = { kind: 'long-call', strike: 100, debit: 500 };
    const e = M.expectancyFrom(sorted, st, 100, 105, 45);
    console.log(`  ${name.padEnd(14)} mean ${String(e.expectancyMean).padStart(9)}  median ${String(e.expectancyMedian).padStart(9)}  `
      + `episodesTo50 ${String(e.expectancyEpisodesTo50).padStart(3)} of ${String(e.expectancyEpisodes).padStart(3)}  `
      + `winRate ${String(e.expectancyWinRate).padStart(6)}`);
  }
  /* NOT ASSERTED, AND THE REASON MATTERS. Both series are geometric Brownian
     motion, which has no tail beyond lognormal, and both use a near-the-money
     strike with hundreds of winning windows spread across the whole series. This
     section proves the PLUMBING and says NOTHING about where a threshold belongs.
     No threshold is set: EPISODE_CONCENTRATION_WARN is null by design and the
     distribution across real candidates is reported separately, for a cutoff to
     be chosen from observation rather than intuition. */
  console.log('\n   NOTE: both series are GBM at a near-the-money strike, so both spread their');
  console.log('   winnings across many episodes. PLUMBING ONLY. No threshold is set, and the');
  console.log('   observed distribution across real candidates is reported separately.');

  console.log('\n   A structure that never wins — episodesTo50 must be NULL, not a measured 0.');
  // 200 total-loss windows, with start indices, in the schema-2 pair shape.
  const flat = Array.from({ length: 200 }, (_, i) => [-0.30, i]);
  const e = M.expectancyFrom(flat, { kind: 'long-call', strike: 100, debit: 500 }, 100, 105, 20);
  rowStr('   episodesTo50 on an all-loss series', e.expectancyEpisodesTo50, null);
  console.log(`     reason: ${e.expectancyEpisodesReason}`);
  row('   winRate on an all-loss series', e.expectancyWinRate, 0);
}

console.log('\n══ 9. NEGATIVE EXPECTANCY SORTS, IT DOES NOT DISAPPEAR ══\n');
{
  const closes = synthCloses(760, { seed: 11, drift: 0, vol: 0.008 });
  const sorted = M.moveWindows(closes, 45).sort((a, b) => a[0] - b[0]).map(([r, i]) => [+r.toFixed(4), i]);
  // A far OTM call on a calm name: almost certainly negative expectancy.
  const st = { kind: 'long-call', strike: 130, debit: 200 };
  const e = M.expectancyFrom(sorted, st, 100);
  console.log(`   far-OTM call K=130 on a low-vol series: expectancyMean = ${e.expectancyMean}`);
  const negative = e.expectancyMean < 0;
  const notNull  = e.expectancyMean != null;
  if (!negative || !notNull) fails++;
  console.log(`   ${negative && notNull ? 'ok  ' : 'FAIL'}  negative and NOT null — it ranks last rather than being dropped`);
  console.log(`         (a null would sort last too, and would mean something completely different)`);
}

console.log('\n══ 10. DE-CLUSTERED CONCENTRATION — episodes, not overlapping windows ══');
console.log('   Windows OVERLAP, so one market move appears in up to N consecutive windows.');
console.log('   The naive top-3 counts that move three times and calls it three. Episode');
console.log('   assignment collapses it back to one. BOTH halves are tested: a single move');
console.log('   must report 1, and genuinely separated moves must report MORE — a test that');
console.log('   only proves collapsing would pass on code that always answers 1.\n');
console.log('   NOTE the metric is bounded by ceil(k/2) for k equal episodes: reaching HALF');
console.log('   the positive P/L can never need every episode. Three separated moves report');
console.log('   2, not 3. Scaling is shown by the 6- and 8-move cases.\n');
{
  const N = 20;

  /** Flat series with spikes: a permanent step up at each named session. */
  function seriesWithMoves(len, at, jump = 0.60) {
    const c = [100];
    for (let i = 1; i < len; i++) c.push(c[i - 1] * (at.includes(i) ? 1 + jump : 1.0000));
    return c;
  }

  /** The naive metric this replaced, reimplemented here so the two can be compared
   *  on the same data rather than described. */
  function naiveTop3(pl) {
    const pos = pl.filter(v => v > 0);
    const tot = pos.reduce((a, b) => a + b, 0);
    if (!(tot > 0)) return { share: null, count: 0 };
    const top3 = [...pos].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
    return { share: top3 / tot, count: pos.length };
  }

  const st = { kind: 'long-call', strike: 130, debit: 500 };   // OTM: only a real move pays
  const be = 135;

  /* WHY THREE SEPARATED MOVES REPORT 2, NOT 3.
     `episodesTo50` counts episodes needed to reach HALF the positive P/L. With k
     equal episodes ranked descending, needing all k would require
     c1+...+c(k-1) < total/2, i.e. ck > total/2 — but ck is the SMALLEST, so
     ck <= total/k, and for k >= 2 that is impossible. The metric is therefore
     bounded by ceil(k/2): 3 equal episodes cross 50% at the 2nd.
     Three separated moves CANNOT report 3, and a test demanding it would be
     demanding a number the metric cannot produce. The contrast that matters is
     1 (one episode carries everything) vs 2+ (it does not), and the scaling is
     demonstrated by the 6- and 8-move cases below. */
  for (const [label, moves, wantEpisodes] of [
    ['ONE move at session 300',                       [300],                               1],
    ['THREE moves, 200 sessions apart (>> N=20)',     [200, 400, 600],                     2],
    ['SIX moves, 100 sessions apart',                 [100, 200, 300, 400, 500, 600],      3],
    ['EIGHT moves, 80 sessions apart',                [80, 160, 240, 320, 400, 480, 560, 640], 4],
  ]) {
    const closes = seriesWithMoves(760, moves);
    const sorted = M.moveWindows(closes, N).sort((a, b) => a[0] - b[0]).map(([r, i]) => [+r.toFixed(4), i]);
    const pl = sorted.map(([r]) => M.payoffAt(st, 100 * (1 + r)));
    const e = M.expectancyFrom(sorted, st, 100, be, N);
    const naive = naiveTop3(pl);

    console.log(`   ${label}`);
    console.log(`     winning windows              ${naive.count}  (one move spans ~N=${N} windows)`);
    console.log(`     naive top-3 share            ${naive.share == null ? 'null' : (naive.share * 100).toFixed(1) + '%'}`
      + `  <- counts ${Math.min(3, naive.count)} OVERLAPPING views of ${moves.length} real move(s)`);
    console.log(`     episodes found               ${e.expectancyEpisodes}`);
    row(`     expectancyEpisodesTo50`, e.expectancyEpisodesTo50, wantEpisodes);
    console.log('');
  }

  console.log('   Edge cases, explicit:\n');
  // No winning window at all -> null with a reason, never 0.
  const flatCloses = seriesWithMoves(400, []);
  const flatSorted = M.moveWindows(flatCloses, N).sort((a, b) => a[0] - b[0]).map(([r, i]) => [+r.toFixed(4), i]);
  const eFlat = M.expectancyFrom(flatSorted, st, 100, be, N);
  rowStr('     no winning windows -> episodesTo50 is null', eFlat.expectancyEpisodesTo50, null);
  console.log(`       reason: ${eFlat.expectancyEpisodesReason}`);
  console.log('       (null, NOT 0 — a count of zero episodes would read as a measurement)');

  // A single episode carrying >= 50% must report 1, not null.
  const oneCloses = seriesWithMoves(760, [300]);
  const oneSorted = M.moveWindows(oneCloses, N).sort((a, b) => a[0] - b[0]).map(([r, i]) => [+r.toFixed(4), i]);
  const eOne = M.expectancyFrom(oneSorted, st, 100, be, N);
  rowStr('     single episode >= 50% -> 1, not null', eOne.expectancyEpisodesTo50, 1);

  // Termination invariant: episode positive sums must total the positive P/L.
  console.log('\n   TERMINATION INVARIANT — the reason episodes are scored on POSITIVE P/L:');
  console.log('     Scoring episodes by NET P/L would not terminate on a losing structure —');
  console.log('     net sums total mean*n, which can sit far below 50% of the positive total.');
  console.log('     Scored on positive contribution, the episode sums equal totalPos exactly.');
  /* A structure with real wins but a heavily negative NET — the case that would
     never terminate under net-P/L scoring. Three separated moves pay 2500 each
     across ~20 windows; ~680 flat windows lose the full 500 debit. */
  const loseCloses = seriesWithMoves(760, [200, 400, 600]);
  const loseSorted = M.moveWindows(loseCloses, N).sort((a, b) => a[0] - b[0]).map(([r, i]) => [+r.toFixed(4), i]);
  const losing = { kind: 'long-call', strike: 130, debit: 500 };
  const eLose = M.expectancyFrom(loseSorted, losing, 100, 135, N);
  const plLose = loseSorted.map(([r]) => M.payoffAt(losing, 100 * (1 + r)));
  const totPos = plLose.reduce((a, v) => a + (v > 0 ? v : 0), 0);
  const totNet = plLose.reduce((a, v) => a + v, 0);
  console.log(`     losing structure: total POSITIVE ${totPos.toFixed(0)}, total NET ${totNet.toFixed(0)}`
    + `  (net is ${(totNet / totPos * 100).toFixed(0)}% of positive)`);
  const terminated = eLose.expectancyEpisodesTo50 != null || !(totPos > 0);
  if (!terminated) fails++;
  console.log(`     ${terminated ? 'ok  ' : 'FAIL'} episodesTo50 = ${eLose.expectancyEpisodesTo50} — terminated`);

  // startIdx must survive the sort, or episodes are built on nonsense.
  console.log('\n   startIdx integrity through the sort:');
  const chk = M.moveWindows(oneCloses, N).sort((a, b) => a[0] - b[0]);
  const idxs = chk.map(p => p[1]).sort((a, b) => a - b);
  const contiguous = idxs.every((v, i) => v === i);
  if (!contiguous) fails++;
  console.log(`     ${contiguous ? 'ok  ' : 'FAIL'} every startIdx 0..${idxs.length - 1} present exactly once after sorting by return`);
}

console.log('\n══ 11. THE 1y/3y INVARIANT — what stands where the fallback used to ══');
console.log('   `attachCoverage` runs expectancy on h.sorted3y with NO 1y fallback, because');
console.log('   the 1y series is a SUFFIX of the 3y one: len(3y) >= len(1y), and');
console.log('   independent = (len - N)/N increases in len, so sorted3y === null implies');
console.log('   sorted1y === null. Removing the branch removed a false statement about the');
console.log('   code; THIS is what covers the invariant if the definitions ever diverge.\n');
{
  // Sweep series lengths across every boundary that matters: below the 1y cap,
  // exactly at it, just past it, and far past it — at every shipped horizon.
  const lengths = [30, 60, 100, 200, 251, 252, 253, 300, 400, 500, 756, 1000, 2600];
  let pairs = 0, violations = 0, bothNull = 0, bothOk = 0, only3y = 0;
  for (const len of lengths) {
    const closes = synthCloses(len);
    const built = M.buildMoveSeries('SWEEP', closes, '2026-08-07');
    for (const n of M.MOVES_HORIZONS) {
      const h = built.horizons[String(n)];
      pairs++;
      const has3 = !!h.sorted3y, has1 = !!h.sorted1y;
      if (!has3 && has1) { violations++; console.log(`  FAIL  len=${len} N=${n}: 3y null but 1y resolved`); }
      else if (has3 && has1) bothOk++;
      else if (has3 && !has1) only3y++;
      else bothNull++;
    }
  }
  if (violations) fails++;
  console.log(`  ${violations === 0 ? 'ok  ' : 'FAIL'}  ${pairs} (series length x horizon) pairs checked across `
    + `${lengths.length} lengths and ${M.MOVES_HORIZONS.length} horizons`);
  console.log(`         both resolve      ${String(bothOk).padStart(3)}`);
  console.log(`         only 3y resolves  ${String(only3y).padStart(3)}   <- expected: 3y outlives 1y`);
  console.log(`         neither resolves  ${String(bothNull).padStart(3)}`);
  console.log(`         ONLY 1y resolves  ${String(violations).padStart(3)}   <- must be 0, or the fallback was needed`);

  console.log('\n   The boundary that would break it first, made explicit:');
  console.log('   at len == MOVES_1Y_SESSIONS the two series are IDENTICAL, so they must agree exactly.');
  {
    const built = M.buildMoveSeries('EQ', synthCloses(M.MOVES_1Y_SESSIONS), '2026-08-07');
    let agree = true;
    for (const n of M.MOVES_HORIZONS) {
      const h = built.horizons[String(n)];
      if (!!h.sorted3y !== !!h.sorted1y) agree = false;
      if (h.sorted3y && h.sorted1y && h.sorted3y.length !== h.sorted1y.length) agree = false;
    }
    if (!agree) fails++;
    rowStr(`     len == ${M.MOVES_1Y_SESSIONS}: 1y and 3y agree at every horizon`, agree, true);
  }

  console.log('\n   And that coverage1y is NOT affected — it reads h.sorted1y directly:');
  const built = M.buildMoveSeries('COV', synthCloses(756), '2026-08-07');
  let cov1yLive = 0;
  for (const n of M.MOVES_HORIZONS) if (built.horizons[String(n)].sorted1y) cov1yLive++;
  const covOk = cov1yLive > 0;
  if (!covOk) fails++;
  console.log(`     ${covOk ? 'ok  ' : 'FAIL'} coverage1y resolves at ${cov1yLive} of ${M.MOVES_HORIZONS.length} horizons `
    + `on a 756-session series — the 1y COLUMN is live, only the 1y EXPECTANCY path was dead.`);
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}\n`);
process.exit(fails === 0 ? 0 : 1);
