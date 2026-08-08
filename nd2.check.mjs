/* P(BE)@exp and greeks check — for the Long tab.
 *
 * Pulls normCdf / normPdf / bsDelta / bsGreeks / probBeyondBreakeven out of
 * worker.js by source extraction (they are not exported — every named export in
 * worker.js must be a function or workerd refuses to boot, so the check reads
 * source rather than importing). Nothing here asserts silently: every number is
 * printed against its expected value with the deviation.
 *
 * THREE independent cross-checks, because the thing being verified is not just
 * "is the arithmetic right" but "is this the right quantity":
 *
 *   1. Reference CDF — a DIFFERENT algorithm (incomplete-gamma series erf,
 *      ~1e-15) rather than A&S 26.2.17 checked against itself.
 *   2. Structural — P(S_T > B) recovered as e^{rT}·(−∂C/∂K) at K=B, by central
 *      difference on a reference Black-Scholes price. This is a genuinely
 *      different derivation: if probBeyondBreakeven computed N(d1), or used the
 *      wrong sign on σ²/2, route 2 would disagree even though route 1 agreed.
 *   3. Greeks — theta and vega against numerical differentiation of the same
 *      reference price. They are new code and nothing else exercises them.
 *
 * The headline case is the last one: a long-dated high-IV LEAPS, where reading
 * the probability off the delta ladder (N(d1)) instead of computing N(d2)
 * overstates the answer by twenty-plus points.
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
const M = new Function(
  ['normCdf', 'normPdf', 'bsDelta', 'bsGreeks', 'probBeyondBreakeven'].map(grab).join('\n') +
  '\nreturn { normCdf, normPdf, bsDelta, bsGreeks, probBeyondBreakeven };',
)();

/* ── Independent reference: erf by Maclaurin series + continued-fraction tail ── */
function erfRef(x) {
  const ax = Math.abs(x);
  let out;
  if (ax < 3) {
    let term = ax, sum = ax;
    for (let n = 1; n < 300; n++) { term *= -ax * ax / n; sum += term / (2 * n + 1); }
    out = 2 / Math.sqrt(Math.PI) * sum;
  } else {
    let f = 1e-300, C = f, D = 0;
    for (let i = 1; i < 300; i++) {
      const a = i === 1 ? 1 : (i - 1) / 2, b = i % 2 ? ax : 1;
      D = b + a * D; if (D === 0) D = 1e-300;
      C = b + a / C; if (C === 0) C = 1e-300;
      D = 1 / D; const delta = C * D; f *= delta;
      if (Math.abs(delta - 1) < 1e-16) break;
    }
    out = 1 - Math.exp(-ax * ax) / Math.sqrt(Math.PI) * f;
  }
  return x >= 0 ? out : -out;
}
const cdfRef = x => 0.5 * (1 + erfRef(x / Math.SQRT2));

/* Reference Black-Scholes price, built only on cdfRef. */
function bsPriceRef(S, K, T, sig, r, type) {
  const d1 = (Math.log(S / K) + (r + sig * sig / 2) * T) / (sig * Math.sqrt(T));
  const d2 = d1 - sig * Math.sqrt(T);
  return type === 'put'
    ? K * Math.exp(-r * T) * cdfRef(-d2) - S * cdfRef(-d1)
    : S * cdfRef(d1) - K * Math.exp(-r * T) * cdfRef(d2);
}

const f = (v, n = 8) => (v == null ? String(v).padStart(12) : v.toFixed(n).padStart(12));
const dev = (a, b) => (a == null || b == null) ? '        n/a' : Math.abs(a - b).toExponential(3).padStart(11);
let worst = 0;
const track = (a, b) => { if (a != null && b != null) worst = Math.max(worst, Math.abs(a - b)); };

/* Cases: S, K/breakeven, T years, sigma, r, label. The last two are the ones
   this whole function exists for — long-dated and high-IV. */
const CASES = [
  { S: 100, B: 105,  T: 45 / 365,  sig: 0.40, r: 0.043, label: '45d  40% IV  BE +5%   (Lane B typical)' },
  { S: 100, B:  95,  T: 45 / 365,  sig: 0.40, r: 0.043, label: '45d  40% IV  BE -5%   (Lane B put)' },
  { S: 250, B: 268,  T: 63 / 365,  sig: 0.28, r: 0.043, label: '63d  28% IV  BE +7.2% (Lane C vertical)' },
  { S: 100, B: 100,  T: 1.0,       sig: 0.20, r: 0.05,  label: '1y   20% IV  ATM      (textbook anchor)' },
  { S: 180, B: 232,  T: 531 / 365, sig: 0.50, r: 0.043, label: '531d 50% IV  BE +29%  (Lane A LEAPS) ★' },
  { S:  60, B:  94,  T: 895 / 365, sig: 0.65, r: 0.043, label: '895d 65% IV  BE +57%  (Lane A far Jan) ★' },
];

console.log('\n══ 1. P(BE)@exp: worker A&S vs reference series-erf ══');
console.log('case                                        computed     reference       deviation');
for (const c of CASES) {
  const got = M.probBeyondBreakeven({ spot: c.S, breakeven: c.B, tYears: c.T, vol: c.sig, rate: c.r, type: 'call' });
  const d2  = (Math.log(c.S / c.B) + (c.r - c.sig * c.sig / 2) * c.T) / (c.sig * Math.sqrt(c.T));
  const ref = cdfRef(d2);
  track(got, ref);
  console.log(`${c.label.padEnd(42)}${f(got)} ${f(ref)}  ${dev(got, ref)}`);
}

console.log('\n══ 2. P(BE)@exp: structural check — e^{rT}·(−∂C/∂K) at K=BE ══');
console.log('   A digital call pays 1 iff S_T > B; its price is e^{-rT}·N(d2). Recovering');
console.log('   that from the K-derivative of a vanilla uses no N(d2) formula at all, so it');
console.log('   catches "right arithmetic, wrong quantity" — N(d1) would fail here.');
console.log('case                                        computed     from ∂C/∂K      deviation');
for (const c of CASES) {
  const got = M.probBeyondBreakeven({ spot: c.S, breakeven: c.B, tYears: c.T, vol: c.sig, rate: c.r, type: 'call' });
  const h   = c.B * 1e-5;
  const dCdK = (bsPriceRef(c.S, c.B + h, c.T, c.sig, c.r, 'call') - bsPriceRef(c.S, c.B - h, c.T, c.sig, c.r, 'call')) / (2 * h);
  const ref = -dCdK * Math.exp(c.r * c.T);
  track(got, ref);
  console.log(`${c.label.padEnd(42)}${f(got)} ${f(ref)}  ${dev(got, ref)}`);
}

console.log('\n══ 3. Put side: P(S_T < B) must equal 1 − P(S_T > B) ══');
console.log('case                                        put(computed) 1−call         deviation');
for (const c of CASES) {
  const put  = M.probBeyondBreakeven({ spot: c.S, breakeven: c.B, tYears: c.T, vol: c.sig, rate: c.r, type: 'put' });
  const call = M.probBeyondBreakeven({ spot: c.S, breakeven: c.B, tYears: c.T, vol: c.sig, rate: c.r, type: 'call' });
  track(put, 1 - call);
  console.log(`${c.label.padEnd(42)}${f(put)} ${f(1 - call)}  ${dev(put, 1 - call)}`);
}

console.log('\n══ 4. THE HEADLINE: N(d1) — the delta shortcut — vs N(d2), the right quantity ══');
console.log('   §4 forbids reading P(BE) off the delta ladder. This is why. The error is');
console.log('   small at 45 DTE and enormous on exactly the structure Lane A is built for.');
console.log('case                                        N(d1)=delta  N(d2)=P(BE)   OVERSTATEMENT   σ√T');
for (const c of CASES) {
  const nd2 = M.probBeyondBreakeven({ spot: c.S, breakeven: c.B, tYears: c.T, vol: c.sig, rate: c.r, type: 'call' });
  const nd1 = M.bsDelta({ spot: c.S, strike: c.B, tYears: c.T, vol: c.sig, rate: c.r, type: 'call' });
  const gap = (nd1 - nd2) * 100;
  console.log(`${c.label.padEnd(42)}${f(nd1, 6)} ${f(nd2, 6)}  ${(gap.toFixed(2) + ' pts').padStart(13)}  ${(c.sig * Math.sqrt(c.T)).toFixed(4)}`);
}

console.log('\n══ 5. Greeks: bsGreeks vs numerical differentiation of the reference price ══');
console.log('   theta = −∂V/∂T (per year), vega = ∂V/∂σ (per 1.00 of sigma), delta = ∂V/∂S.');
for (const type of ['call', 'put']) {
  console.log(`\n  ${type.toUpperCase()}`);
  console.log('  case                                      greek   computed     numerical       deviation');
  for (const c of CASES) {
    const g = M.bsGreeks({ spot: c.S, strike: c.B, tYears: c.T, vol: c.sig, rate: c.r, type });
    const hS = c.S * 1e-5, hT = c.T * 1e-5, hV = c.sig * 1e-5;
    const nDelta = (bsPriceRef(c.S + hS, c.B, c.T, c.sig, c.r, type) - bsPriceRef(c.S - hS, c.B, c.T, c.sig, c.r, type)) / (2 * hS);
    const nTheta = -(bsPriceRef(c.S, c.B, c.T + hT, c.sig, c.r, type) - bsPriceRef(c.S, c.B, c.T - hT, c.sig, c.r, type)) / (2 * hT);
    const nVega  = (bsPriceRef(c.S, c.B, c.T, c.sig + hV, c.r, type) - bsPriceRef(c.S, c.B, c.T, c.sig - hV, c.r, type)) / (2 * hV);
    for (const [name, got, ref] of [['delta', g.delta, nDelta], ['theta', g.theta, nTheta], ['vega', g.vega, nVega]]) {
      // Deviations here are dominated by the finite-difference step, not by the
      // closed form; they are reported in RELATIVE terms for theta/vega, whose
      // magnitudes run to tens of dollars.
      const rel = Math.abs(ref) > 1e-9 ? Math.abs((got - ref) / ref) : Math.abs(got - ref);
      if (name === 'delta') track(got, ref);
      console.log(`  ${c.label.padEnd(42)}${name.padEnd(6)}${f(got, 6)} ${f(ref, 6)}  rel ${rel.toExponential(2).padStart(9)}`);
    }
  }
}

console.log('\n══ 6. Degenerate inputs must return null, never a number ══');
const bad = [
  ['vol = 0',        { spot: 100, breakeven: 105, tYears: 0.5, vol: 0,    rate: 0.04, type: 'call' }],
  ['tYears = 0',     { spot: 100, breakeven: 105, tYears: 0,   vol: 0.4,  rate: 0.04, type: 'call' }],
  ['rate = null',    { spot: 100, breakeven: 105, tYears: 0.5, vol: 0.4,  rate: null, type: 'call' }],
  ['breakeven = 0',  { spot: 100, breakeven: 0,   tYears: 0.5, vol: 0.4,  rate: 0.04, type: 'call' }],
  ['spot = NaN',     { spot: NaN, breakeven: 105, tYears: 0.5, vol: 0.4,  rate: 0.04, type: 'call' }],
];
for (const [label, args] of bad) {
  const got = M.probBeyondBreakeven(args);
  console.log(`  ${label.padEnd(18)} -> ${String(got).padStart(6)}  ${got === null ? 'OK' : 'WRONG — must be null so the card renders n/a'}`);
}

console.log(`\nworst absolute deviation across the probability checks: ${worst.toExponential(3)}`);
console.log('A&S 26.2.17 claims |error| < 7.5e-8 — the reference-erf and ∂C/∂K routes');
console.log('are both bounded by that plus the finite-difference step.\n');
