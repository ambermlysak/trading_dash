/* Black-Scholes delta check.
 *
 * Pulls normCdf/bsDelta out of worker.js by source extraction (they are not
 * exported) and prints computed vs expected for every case. Nothing here
 * asserts silently — every number is shown.
 *
 * The reference CDF is a DIFFERENT algorithm (incomplete-gamma series erf,
 * ~1e-15) so this is not A&S being checked against itself.
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
const { normCdf, bsDelta } = new Function(
  `${grab('normCdf')}\n${grab('bsDelta')}\nreturn { normCdf, bsDelta };`,
)();

/* ── Independent reference: erf via its Maclaurin series (converges fine for
      |x| < 3) plus a continued fraction for the tail. Double precision. ── */
function erfRef(x) {
  const ax = Math.abs(x);
  let out;
  if (ax < 3) {
    let term = ax, sum = ax;
    for (let n = 1; n < 200; n++) {
      term *= -ax * ax / n;
      sum += term / (2 * n + 1);
    }
    out = 2 / Math.sqrt(Math.PI) * sum;
  } else {
    // erfc continued fraction (Lentz); erf = 1 - erfc
    let f = 1e-300, C = f, D = 0;
    for (let i = 1; i < 300; i++) {
      const a = i === 1 ? 1 : (i - 1) / 2;
      const b = i % 2 === 1 ? ax * ax : 1;
      D = b + a * D; if (D === 0) D = 1e-300;
      C = b + a / C; if (C === 0) C = 1e-300;
      D = 1 / D;
      f *= C * D;
    }
    out = 1 - Math.exp(-ax * ax) / Math.sqrt(Math.PI) * f;
  }
  return x >= 0 ? out : -out;
}
const cdfRef = x => 0.5 * (1 + erfRef(x / Math.SQRT2));

function deltaRef({ spot, strike, tYears, vol, rate, type }) {
  const d1 = (Math.log(spot / strike) + (rate + vol * vol / 2) * tYears) / (vol * Math.sqrt(tYears));
  const n = cdfRef(d1);
  return type === 'put' ? n - 1 : n;
}

const pad = (s, n) => String(s).padStart(n);
let worst = 0;
const row = (label, got, want, note = '', count = true) => {
  const diff = Math.abs(got - want);
  if (count) worst = Math.max(worst, diff);
  console.log(`  ${label.padEnd(34)} computed ${pad(got.toFixed(8), 12)}   expected ${pad(want.toFixed(8), 12)}   Δ ${diff.toExponential(2)}  ${note}`);
};

console.log('\n=== 1. normCdf vs an independent series-erf reference ===');
for (const z of [0, 1, 1.96, -1.645, 2.5758, -4, 0.35]) {
  row(`N(${z})`, normCdf(z), cdfRef(z));
}

console.log('\n=== 1b. the same points against published z-table values ===');
console.log('    (a literal I type from memory is the least trustworthy number here,');
console.log('     so these are shown but excluded from the tolerance check)');
row('N(0)',       normCdf(0),       0.5,         '', false);
row('N(1)',       normCdf(1),       0.8413447461, '', false);
row('N(1.96)',    normCdf(1.96),    0.9750021049, '(97.5th pctile)', false);
row('N(-1.645)',  normCdf(-1.645),  0.0499848549, '(5th pctile)', false);
row('N(2.5758293)', normCdf(2.5758293), 0.995,    '(99.5th pctile, z to 7dp)', false);

console.log('\n=== 2. bsDelta vs Hull, Options Futures & Other Derivatives ===');
console.log('    S=49 K=50 r=5% sigma=20% T=20/52 -- Hull prints call delta 0.522');
const hull = { spot: 49, strike: 50, tYears: 20 / 52, vol: 0.20, rate: 0.05 };
row('Hull call delta', bsDelta({ ...hull, type: 'call' }), 0.522, '(Hull, 3 sig figs)', false);
row('  vs series-erf reference', bsDelta({ ...hull, type: 'call' }), deltaRef({ ...hull, type: 'call' }));

console.log('\n=== 3. bsDelta closed-form case: ATM, 1 year ===');
console.log('    S=100 K=100 r=5% sigma=20% T=1  ->  d1 = 0.07/0.20 = 0.35 exactly');
const atm = { spot: 100, strike: 100, tYears: 1, vol: 0.20, rate: 0.05 };
row('call delta = N(0.35)', bsDelta({ ...atm, type: 'call' }), 0.63683065);
row('put delta  = N(0.35)-1', bsDelta({ ...atm, type: 'put' }), -0.36316935);

console.log('\n=== 4. put-call parity: call - put must be exactly 1 (no dividend) ===');
for (const k of [80, 100, 120]) {
  const c = bsDelta({ spot: 100, strike: k, tYears: 0.1, vol: 0.5, rate: 0.043, type: 'call' });
  const p = bsDelta({ spot: 100, strike: k, tYears: 0.1, vol: 0.5, rate: 0.043, type: 'put' });
  row(`K=${k}: call - put`, c - p, 1);
}

console.log('\n=== 5. the strikes this screen actually selects (30d, 40% IV, r=4.3%) ===');
console.log('    spot 100 -- shows where the 0.30 and 0.16 delta strikes land');
const live = { spot: 100, tYears: 30 / 365, vol: 0.40, rate: 0.043 };
for (const k of [88, 92, 96, 100, 104, 108, 112]) {
  const c = bsDelta({ ...live, strike: k, type: 'call' });
  const p = bsDelta({ ...live, strike: k, type: 'put' });
  const cr = deltaRef({ ...live, strike: k, type: 'call' });
  const pr = deltaRef({ ...live, strike: k, type: 'put' });
  worst = Math.max(worst, Math.abs(c - cr), Math.abs(p - pr));
  console.log(`  K=${pad(k, 4)}  call Δ ${c.toFixed(4)} (ref ${cr.toFixed(4)})   put Δ ${p.toFixed(4)} (ref ${pr.toFixed(4)})`);
}

console.log('\n=== 6. rate actually matters -- r=0 is not a neutral default ===');
const r0 = bsDelta({ spot: 100, strike: 108, tYears: 30 / 365, vol: 0.40, rate: 0,     type: 'call' });
const r4 = bsDelta({ spot: 100, strike: 108, tYears: 30 / 365, vol: 0.40, rate: 0.043, type: 'call' });
console.log(`  K=108 call delta at r=0.0%: ${r0.toFixed(4)}`);
console.log(`  K=108 call delta at r=4.3%: ${r4.toFixed(4)}`);
console.log(`  difference: ${((r4 - r0) * 100).toFixed(2)} delta points -- enough to move which strike gets picked`);

console.log('\n=== 7. unusable input returns null, never NaN ===');
for (const [label, args] of [
  ['tYears = 0',   { spot: 100, strike: 100, tYears: 0,    vol: 0.4, rate: 0.04 }],
  ['vol = 0',      { spot: 100, strike: 100, tYears: 0.1,  vol: 0,   rate: 0.04 }],
  ['spot = null',  { spot: null, strike: 100, tYears: 0.1, vol: 0.4, rate: 0.04 }],
  ['rate = null',  { spot: 100, strike: 100, tYears: 0.1,  vol: 0.4, rate: null }],
]) {
  const v = bsDelta({ ...args, type: 'call' });
  console.log(`  ${label.padEnd(14)} -> ${v === null ? 'null  OK' : `${v}  *** NOT NULL ***`}`);
}

console.log(`\nworst absolute deviation across every case above: ${worst.toExponential(3)}`);
console.log(`A&S 26.2.17 claims |error| < 7.5e-8 -- ${worst < 7.5e-8 ? 'within spec' : 'OUT OF SPEC'}`);
console.log('(case 2 excluded from the worst-case: Hull is printed to 3 significant figures)\n');
