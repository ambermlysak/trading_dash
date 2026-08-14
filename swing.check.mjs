/* Watchlist "Swing" column — the linear-regression channel, end to end.
 *
 * WHAT THIS CHECKS, and why each section exists:
 *
 *   1. The shipped constants, read out of `worker.js` rather than restated here.
 *   2. LIVE BARS. For NVDA, AMD and SPCX (the shortest history on the list):
 *      the last bar's iso against `etToday()`, the ET hour, and therefore whether
 *      the forming bar was dropped — printed with the rule that decided it, not
 *      asserted. This is the half a fixture cannot cover, because "is today's bar
 *      still forming" is a fact about the clock.
 *   3. AN INDEPENDENT REGRESSION. Two derivations that share no code with
 *      `swingChannel`: the centered normal equations, and a numerical SSR
 *      minimiser seeded deliberately away from the answer. The second is the one
 *      that matters — it confirms the fitted line is the SSR MINIMISER rather
 *      than merely reproducing the same algebra a second time.
 *   4. σ IS THE RESIDUAL σ, NOT THE σ OF THE CLOSES. Printed side by side on a
 *      trending name, where they differ by several times. Getting this wrong
 *      still produces a plausible number in the right units, which is the whole
 *      reason it is checked separately.
 *   5. WHICH x THE LINE IS READ AT — 29 or 30 — for each ticker, in BOTH
 *      settlement regimes, with the rule that selected it.
 *   6. THE NULL PATH. Fewer than SWING_REG_BARS completed bars must return all
 *      four fields null. Not 0, not NaN: `0σ` means "sitting exactly on the
 *      line", which is a finding, and an absent fit must never render as one.
 *   7. THE THRESHOLD BRANCH, driven both ways.
 *   8. The response envelope carries `swingThreshold` / `swingBars`, and the
 *      frontend does not hardcode a copy of either.
 *
 * BLIND SPOTS, stated rather than discovered later:
 *   - Live bars are read through the DEPLOYED Worker's `/api/chart/:ticker`
 *     proxy, because Yahoo 429s a direct request from this host. It is the same
 *     `?range=3mo&interval=1d` upstream payload `handleWatchlistBatch` consumes,
 *     but it is not proof that the batch handler wired it up correctly — §8's
 *     source check and a `wrangler dev` boot cover that instead.
 *   - The live half describes the market as it stood when the script ran. Re-run
 *     on another day and §2/§7's numbers change; the rules they demonstrate do not.
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
  const key = '\nconst ' + name;
  const i = src.indexOf(key);
  if (i < 0) throw new Error('missing const ' + name);
  const j = src.indexOf(';', i + key.length);
  return src.slice(i + 1, j + 1);
}

const W = new Function([
  grabConst('etToday'), grabConst('etHourNow'),
  grabConst('SWING_REG_BARS'), grabConst('SWING_Z_THRESHOLD'), grabConst('SWING_SETTLE_ET_HOUR'),
  grab('swingChannel'),
  `return { swingChannel, etToday, etHourNow,
            SWING_REG_BARS, SWING_Z_THRESHOLD, SWING_SETTLE_ET_HOUR };`,
].join('\n'))();

const N     = W.SWING_REG_BARS;
const THR   = W.SWING_Z_THRESHOLD;
const SETTLE = W.SWING_SETTLE_ET_HOUR;
const t = tally();

const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;
function row(label, got, want, tol = 0) {
  const ok = record(t, tol === 0
    ? (got === want || (Number.isNaN(got) && Number.isNaN(want)))
    : near(got, want, tol));
  const dev = (typeof got === 'number' && typeof want === 'number')
    ? `  Δ ${(got - want).toExponential(2)}` : '';
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(56)} got ${String(got).padEnd(14)} want ${String(want).padEnd(14)}${dev}`);
  return ok;
}

/* ── Live bars, via the deployed Worker's chart proxy ─────────────────────── */
const API = 'https://stock-research-worker.ambermlysak.workers.dev/api';
async function livePairs(sym) {
  const r = await fetch(`${API}/chart/${sym}?range=3mo&interval=1d`, {
    headers: { Origin: 'http://localhost:8123' },
  });
  if (!r.ok) throw new Error(`chart ${sym} HTTP ${r.status}`);
  const res = (await r.json())?.chart?.result?.[0];
  const ts = res?.timestamp, q = res?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(q) || ts.length !== q.length) {
    throw new Error(`${sym}: timestamp/close length mismatch`);
  }
  const pairs = [];
  for (let i = 0; i < q.length; i++) {
    if (q[i] == null || !Number.isFinite(q[i]) || !Number.isFinite(ts[i])) continue;
    pairs.push({ iso: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: q[i] });
  }
  return { pairs, price: res?.meta?.regularMarketPrice ?? null };
}

/* ── Independent regression #1: centered normal equations ─────────────────── */
function bruteFit(ys) {
  const n = ys.length;
  const xbar = (n - 1) / 2;
  const ybar = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (i - xbar) * (ys[i] - ybar); sxx += (i - xbar) ** 2; }
  const slope = sxy / sxx;
  const intercept = ybar - slope * xbar;
  let ssr = 0;
  for (let i = 0; i < n; i++) { const r = ys[i] - (intercept + slope * i); ssr += r * r; }
  return { slope, intercept, ssr, sigma: Math.sqrt(ssr / (n - 2)) };
}

/* ── Independent regression #2: a numerical SSR minimiser ─────────────────────
   No normal equations at all — coordinate descent with a shrinking step, seeded
   deliberately away from the answer. If this lands on the same line, the line is
   the least-squares fit rather than the output of the same algebra written twice. */
const ssrOf = (ys, a, b) => ys.reduce((s, y, i) => s + (y - (a + b * i)) ** 2, 0);
function searchFit(ys, seedA, seedB) {
  let a = seedA, b = seedB, stepA = 20, stepB = 5;
  for (let pass = 0; pass < 400; pass++) {
    for (const [k, st] of [['a', stepA], ['b', stepB]]) {
      const cur = ssrOf(ys, a, b);
      const up  = k === 'a' ? ssrOf(ys, a + st, b) : ssrOf(ys, a, b + st);
      const dn  = k === 'a' ? ssrOf(ys, a - st, b) : ssrOf(ys, a, b - st);
      if (up < cur && up <= dn)      { if (k === 'a') a += st; else b += st; }
      else if (dn < cur)             { if (k === 'a') a -= st; else b -= st; }
    }
    stepA *= 0.97; stepB *= 0.97;
  }
  return { intercept: a, slope: b, ssr: ssrOf(ys, a, b) };
}

const stdev = (ys) => {
  const m = ys.reduce((a, b) => a + b, 0) / ys.length;
  return Math.sqrt(ys.reduce((s, y) => s + (y - m) ** 2, 0) / (ys.length - 1));
};

/* ── Reproduce the worker's own window selection, for the printed narrative ── */
function windowOf(pairs, today, hour) {
  const last = pairs[pairs.length - 1];
  const forming = !!last && last.iso === today && hour < SETTLE;
  const bars = forming ? pairs.slice(0, -1) : pairs;
  return { forming, completed: bars.length, win: bars.slice(-N) };
}

const main = async () => {
console.log('\n══ Watchlist Swing column — linear-regression channel ══');

/* ── §1  CONSTANTS ────────────────────────────────────────────────────────── */
console.log('\n§1  SHIPPED CONSTANTS (read out of worker.js, not restated here)');
row('SWING_REG_BARS', N, 30);
row('SWING_Z_THRESHOLD', THR, 1.5);
row('SWING_SETTLE_ET_HOUR (4:00pm ET bell)', SETTLE, 16);

/* ── §2  LIVE BARS AND THE FORMING-BAR DECISION ───────────────────────────── */
const today = W.etToday();
const hour  = W.etHourNow();
console.log(`\n§2  LIVE BARS — etToday() = ${today}, ET hour = ${String(hour).padStart(2, '0')}, `
  + `so today's bar is ${hour < SETTLE ? 'STILL FORMING (dropped)' : 'SETTLED (kept)'}`);
console.log(`    rule: drop the last pair iff  iso === etToday()  AND  etHour < ${SETTLE}`);

const SYMS = ['NVDA', 'AMD', 'SPCX'];
const live = {};
for (const sym of SYMS) {
  live[sym] = await livePairs(sym);
  const { pairs, price } = live[sym];
  const w = windowOf(pairs, today, hour);
  const out = W.swingChannel(pairs, price, today, hour);
  console.log(`\n  ${sym}  price $${price}`);
  console.log(`    pairs returned      ${pairs.length}  (${pairs[0].iso} … ${pairs[pairs.length - 1].iso})`);
  console.log(`    last pair iso       ${pairs[pairs.length - 1].iso}   etToday() ${today}   `
    + `equal? ${pairs[pairs.length - 1].iso === today}`);
  console.log(`    forming bar dropped ${w.forming}  ->  ${w.completed} completed bars`);
  console.log(`    fit window          ${w.win.length ? `${w.win[0].iso} … ${w.win[w.win.length - 1].iso}` : '(none)'}`);
  console.log(`    worker swingAsOf    ${out.swingAsOf}   evalX ${out.swingEvalX}   `
    + `z ${out.swingZ}   signal ${out.swingSignal}   fit ${out.swingFit}   σ ${out.swingSigma}`);
  // The dropped bar must be today's and nothing else.
  row(`${sym}: dropped-bar decision matches the rule`,
      w.forming, pairs[pairs.length - 1].iso === today && hour < SETTLE);
  row(`${sym}: swingAsOf is the last COMPLETED bar`,
      out.swingAsOf, w.win.length ? w.win[w.win.length - 1].iso : null);
  row(`${sym}: swingAsOf is never today while the bar forms`,
      hour < SETTLE ? out.swingAsOf !== today : true, true);
}

/* ── §3  AN INDEPENDENT REGRESSION, NVDA ──────────────────────────────────── */
console.log('\n§3  INDEPENDENT REGRESSION — NVDA, two derivations sharing no code with swingChannel');
{
  const { pairs, price } = live.NVDA;
  const w = windowOf(pairs, today, hour);
  const ys = w.win.map(p => p.close);
  if (populated('NVDA regression window', ys.length)) {
    const bf = bruteFit(ys);
    // Seeded away from the answer on purpose: intercept 10% low, slope flat.
    const sf = searchFit(ys, ys[0] * 0.9, 0);
    const evalX = w.win[w.win.length - 1].iso < today ? N : N - 1;
    const fit   = bf.intercept + bf.slope * evalX;
    const z     = (price - fit) / bf.sigma;
    const got   = W.swingChannel(pairs, price, today, hour);

    console.log(`    closes n=${ys.length}   ${ys[0].toFixed(2)} … ${ys[ys.length - 1].toFixed(2)}`);
    console.log(`    (i)  centered normal equations   slope ${bf.slope.toFixed(8)}  intercept ${bf.intercept.toFixed(8)}  SSR ${bf.ssr.toFixed(6)}`);
    console.log(`    (ii) numerical SSR minimiser     slope ${sf.slope.toFixed(8)}  intercept ${sf.intercept.toFixed(8)}  SSR ${sf.ssr.toFixed(6)}`);
    console.log(`    residual σ = sqrt(SSR/(n-2)) = sqrt(${bf.ssr.toFixed(6)}/${N - 2}) = ${bf.sigma.toFixed(8)}`);
    console.log(`    line at x=${evalX}: ${bf.intercept.toFixed(6)} + ${bf.slope.toFixed(6)}×${evalX} = ${fit.toFixed(8)}`);
    console.log(`    z = (${price} − ${fit.toFixed(6)}) / ${bf.sigma.toFixed(6)} = ${z.toFixed(8)}`);
    console.log('    ── worker vs independent ──');

    // (ii) must land on (i): that is the proof the fit minimises SSR. The
    // tolerance is the minimiser's own convergence floor (it stops on a shrinking
    // step, not on an exact solve) — 1e-3 against an SSR of ~1.7e3 is 6e-10 relative.
    row('(ii) minimiser SSR is not above (i) closed-form SSR', sf.ssr <= bf.ssr + 1e-3, true);
    row('(ii) slope agrees with (i)',     sf.slope,     bf.slope,     1e-4);
    row('(ii) intercept agrees with (i)', sf.intercept, bf.intercept, 1e-2);
    // A direct minimality probe: nudge the closed-form line and SSR must rise.
    row('SSR rises when the fit is nudged in slope',
        ssrOf(ys, bf.intercept, bf.slope + 0.01) > bf.ssr, true);
    row('SSR rises when the fit is nudged in intercept',
        ssrOf(ys, bf.intercept + 0.5, bf.slope) > bf.ssr, true);

    // Worker rounds to 2dp; compare against the rounded independent values.
    const r2 = v => Math.round(v * 100) / 100;
    row('worker swingFit   vs independent', got.swingFit,   r2(fit),        0);
    row('worker swingSigma vs independent', got.swingSigma, r2(bf.sigma),   0);
    row('worker swingZ     vs independent', got.swingZ,     r2(z),          0);
    row('worker evalX      vs independent', got.swingEvalX, evalX,          0);
    console.log(`    unrounded deviations:  fit ${(got.swingFit - fit).toExponential(3)}`
      + `   σ ${(got.swingSigma - bf.sigma).toExponential(3)}`
      + `   z ${(got.swingZ - z).toExponential(3)}   (all are the 2dp rounding, nothing else)`);
  }
}

/* ── §4  RESIDUAL σ IS NOT THE σ OF THE CLOSES ────────────────────────────── */
console.log('\n§4  σ OF THE RESIDUALS ≠ σ OF THE CLOSES — the quantity thinkorswim quotes');
for (const sym of SYMS) {
  const w = windowOf(live[sym].pairs, today, hour);
  const ys = w.win.map(p => p.close);
  if (!ys.length) continue;
  const bf = bruteFit(ys);
  const sc = stdev(ys);
  console.log(`    ${sym.padEnd(5)} residual σ ${bf.sigma.toFixed(4).padStart(9)}   close σ ${sc.toFixed(4).padStart(9)}`
    + `   ratio ${(sc / bf.sigma).toFixed(2)}×`);
  row(`${sym}: worker σ is the RESIDUAL σ, not the close σ`,
      W.swingChannel(live[sym].pairs, live[sym].price, today, hour).swingSigma,
      Math.round(bf.sigma * 100) / 100, 0);
}

/* ── §5  WHICH x, IN BOTH SETTLEMENT REGIMES ──────────────────────────────── */
console.log('\n§5  EVALUATION x — the live quote belongs to TODAY, so the line is read at today');
console.log(`    rule: lastCompletedBar.iso < etToday()  ->  x = ${N} (extrapolate one bar)`);
console.log(`          lastCompletedBar.iso === etToday() ->  x = ${N - 1} (same session)`);
for (const sym of SYMS) {
  const { pairs, price } = live[sym];
  // Pre-close: hour 10 ET. Today's bar forms, is dropped, window ends yesterday.
  const pre  = W.swingChannel(pairs, price, today, 10);
  // Post-close: hour 17 ET. Today's bar is settled and kept, window ends today.
  const post = W.swingChannel(pairs, price, today, 17);
  const lastIso = pairs[pairs.length - 1].iso;
  console.log(`    ${sym.padEnd(5)} pre-close(10 ET)  asOf ${pre.swingAsOf}  x=${pre.swingEvalX}   `
    + `post-close(17 ET) asOf ${post.swingAsOf}  x=${post.swingEvalX}`);
  row(`${sym}: pre-close reads x = ${N} (window ends before today)`,  pre.swingEvalX,  N);
  row(`${sym}: post-close reads x = ${N - 1} when the last bar IS today`,
      post.swingEvalX, lastIso === today ? N - 1 : N);
  /* What x=29 vs x=30 costs, ON ONE WINDOW. The two calls above use DIFFERENT
     windows (one ends yesterday, one ends today), so differencing their fits
     measures the window shift as well — the isolated quantity is the same
     window's line read at both x, which is exactly one bar of slope. */
  const w  = windowOf(pairs, today, hour);
  const bf = bruteFit(w.win.map(p => p.close));
  const at = (x) => bf.intercept + bf.slope * x;
  console.log(`          one window, line at x=${N - 1} ${at(N - 1).toFixed(4)} vs x=${N} ${at(N).toFixed(4)}`
    + `  ->  difference ${(at(N) - at(N - 1)).toFixed(6)} = slope ${bf.slope.toFixed(6)}`);
  row(`${sym}: x=${N} minus x=${N - 1} is exactly one bar of slope`,
      at(N) - at(N - 1), bf.slope, 1e-9);
  row(`${sym}: pre-close fit IS that window read at x=${N}`,
      pre.swingFit, Math.round(at(N) * 100) / 100, 0);
}

/* ── §6  THE NULL PATH ────────────────────────────────────────────────────── */
console.log('\n§6  TOO LITTLE HISTORY -> all four fields null (never 0, never NaN)');
{
  const spcx = live.SPCX;
  const w = windowOf(spcx.pairs, today, hour);
  console.log(`    SPCX is the shortest history on the watchlist: ${spcx.pairs.length} pairs, `
    + `${w.completed} completed — still ≥ ${N}, so it RESOLVES live today.`);
  console.log('    The null branch is therefore driven by TRUNCATING that real series,');
  console.log('    which is the only honest way to reach it while no listed name is short enough.');
  /* Truncate from the FRONT, keeping the tail: the series then still ends on
     today's forming bar, so the forming-bar drop and the bar-count gate are
     exercised together rather than one standing in for the other. */
  const keep = (completed) => spcx.pairs.slice(-(completed + (w.forming ? 1 : 0)));
  const shortPairs = keep(N - 1);                                      // 29 completed
  const sw = windowOf(shortPairs, today, hour);
  const out = W.swingChannel(shortPairs, spcx.price, today, hour);
  console.log(`    truncated to ${sw.completed} completed bars ->`, JSON.stringify(out));
  for (const f of ['swingZ', 'swingSignal', 'swingFit', 'swingSigma']) {
    row(`${sw.completed} completed bars: ${f} is null`, out[f], null);
    row(`  ...and is not 0`,   out[f] === 0,   false);
    row(`  ...and is not NaN`, Number.isNaN(out[f]), false);
  }
  const okPairs = keep(N);                                             // 30 completed
  const ok = W.swingChannel(okPairs, spcx.price, today, hour);
  console.log(`    one more bar (${windowOf(okPairs, today, hour).completed} completed) ->`, JSON.stringify(ok));
  row(`${N} completed bars: swingZ resolves`, ok.swingZ != null, true);

  // The other absent-input paths must degrade the same way.
  row('empty pairs   -> swingZ null', W.swingChannel([], 100, today, hour).swingZ, null);
  row('null price    -> swingZ null', W.swingChannel(spcx.pairs, null, today, hour).swingZ, null);
  row('flat series   -> σ = 0 -> swingZ null (no channel to measure against)',
      W.swingChannel(Array.from({ length: N + 1 }, (_, i) => ({ iso: `2026-01-${String(i + 1).padStart(2, '0')}`, close: 50 })),
                     50, today, hour).swingZ, null);
}

/* ── §7  THE THRESHOLD BRANCH ─────────────────────────────────────────────── */
console.log(`\n§7  THRESHOLD BRANCH at ±${THR}σ`);
console.log('    (a) live scan of the shipped DEFAULT_WL — 22 names, the list dashboard.html seeds');
{
  const WL = ['PLTR','NVDA','AMD','AAPL','AMZN','GOOGL','QUBT','TWLO','NOW','TSM','MU','APP',
              'CRCL','CRWV','MRK','UNH','TSLA','PANW','RDDT','CAVA','JPM','HOOD'];
  const scored = [];
  for (const sym of WL) {
    try {
      const { pairs, price } = live[sym] || await livePairs(sym);
      const out = W.swingChannel(pairs, price, today, hour);
      if (out.swingZ != null) scored.push({ sym, ...out });
    } catch (e) { console.log(`      ${sym}: ${e.message}`); }
  }
  scored.sort((a, b) => Math.abs(b.swingZ) - Math.abs(a.swingZ));
  console.log(`      ${scored.length} of ${WL.length} names resolved a channel`);
  for (const s of scored.slice(0, 6)) {
    console.log(`      ${s.sym.padEnd(6)} z ${String(s.swingZ).padStart(6)}σ  fit ${String(s.swingFit).padStart(9)}  `
      + `σ ${String(s.swingSigma).padStart(7)}  signal ${s.swingSignal ?? '(none — inside the channel)'}`);
  }
  const fired = scored.filter(s => s.swingSignal);
  const maxAbs = scored.length ? Math.abs(scored[0].swingZ) : null;
  if (fired.length) {
    console.log(`      LIVE THRESHOLD HIT: ${fired.map(f => `${f.sym} ${f.swingSignal} ${f.swingZ}σ`).join(', ')}`);
    for (const f of fired) {
      row(`${f.sym}: |z| ≥ ${THR} and the signal string is set`,
          f.swingSignal, f.swingZ <= -THR ? 'BUY' : 'SELL');
    }
  } else {
    console.log(`      NO live name reached ±${THR}σ today. Max |z| observed = ${maxAbs}σ `
      + `(${scored[0]?.sym}). The branch is exercised synthetically below instead.`);
  }
  if (populated('live channel scan', scored.length)) {
    row('every scored name inside ±THR carries a null signal',
        scored.filter(s => Math.abs(s.swingZ) < THR).every(s => s.swingSignal === null), true);
    row('no scored name outside ±THR carries a null signal',
        scored.filter(s => Math.abs(s.swingZ) >= THR).every(s => s.swingSignal !== null), true);
  }
}

console.log('    (b) synthetic series — the boundary driven from both sides regardless of the tape');
{
  /* A perfectly straight line has zero residual, so σ would be 0 and nothing
     would resolve. Alternate ±1 around the line: slope 1, intercept 100, and
     every residual is exactly ±1, giving SSR = n and σ = sqrt(n/(n-2)). */
  const mk = (bars) => bars.map((c, i) => ({ iso: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`, close: c }));
  const ys = Array.from({ length: N }, (_, i) => 100 + i + (i % 2 === 0 ? 1 : -1));
  const bars = mk(ys);                       // last iso is well before today -> evalX = N
  const bf = bruteFit(ys);
  const fitN = bf.intercept + bf.slope * N;
  console.log(`      synthetic: slope ${bf.slope.toFixed(6)}  intercept ${bf.intercept.toFixed(6)}  `
    + `σ ${bf.sigma.toFixed(6)}  line@x=${N} ${fitN.toFixed(6)}`);
  const at = (z) => Math.round((fitN + z * bf.sigma) * 1e6) / 1e6;
  for (const [z, want] of [[-2.00, 'BUY'], [-1.51, 'BUY'], [-THR, 'BUY'], [-1.49, null],
                           [0, null], [1.49, null], [THR, 'SELL'], [1.51, 'SELL'], [2.00, 'SELL']]) {
    const out = W.swingChannel(bars, at(z), today, hour);
    row(`price at ${String(z).padStart(6)}σ -> signal ${String(want)}`, out.swingSignal, want);
    row(`  ...and the printed z rounds to ${z}`, out.swingZ, Math.round(z * 100) / 100, 0.01);
  }
  row('synthetic evalX is N (window ends long before today)',
      W.swingChannel(bars, at(0), today, hour).swingEvalX, N);
}

/* ── §8  THE ENVELOPE AND THE FRONTEND ────────────────────────────────────── */
console.log('\n§8  ENVELOPE + FRONTEND — the threshold is shipped, and the page does not restate it');
{
  const batchStart = src.indexOf('async function handleWatchlistBatch(');
  const batchEnd   = src.indexOf('async function handleWatchlistAuction(');
  const batch = src.slice(batchStart, batchEnd);
  const envLines = batch.split('\n').filter(l => /swingThreshold|swingBars/.test(l));
  envLines.forEach(l => console.log(`      worker.js: ${l.trim()}`));
  row('envelope ships swingThreshold from the constant',
      /swingThreshold:\s*SWING_Z_THRESHOLD/.test(batch), true);
  row('envelope ships swingBars from the constant',
      /swingBars:\s*SWING_REG_BARS/.test(batch), true);
  row('the row spreads the channel result', /\.\.\.swing,/.test(batch), true);
  row('no second Yahoo fetch was added to the batch handler',
      (batch.match(/yahoo\(|yahooAuth\(|yahooSparkCloses\(/g) || []).length, 3);

  const dash = fs.readFileSync('dashboard.html', 'utf8');
  const wlStart = dash.indexOf('function swingCell(');
  const wlEnd   = dash.indexOf('function crossCell(');
  const cell = dash.slice(wlStart, wlEnd);
  row('frontend never compares z to a numeric threshold', /swingZ\s*[<>]=?\s*[01]\./.test(cell), false);
  row('frontend renders the Worker\'s swingSignal', /swingSignal\s*===\s*'BUY'/.test(cell), true);
  row('header tooltip interpolates the shipped threshold', /\$\{wlSwing\.threshold\}/.test(dash), true);
  row('header tooltip interpolates the shipped bar count', /\$\{bars\}/.test(dash), true);
  row('dashboard.html holds no hardcoded 1.5 threshold for this column',
      /swing[A-Za-z]*\s*[<>]=?\s*1\.5/.test(dash), false);
  const cols = (dash.match(/<colgroup>[\s\S]*?<\/colgroup>/) || [''])[0];
  row('watchlist colgroup has 15 <col> entries', (cols.match(/<col>/g) || []).length, 15);
  row('watchlist header has 15 <th>',
      (dash.slice(dash.indexOf('<table class="wl-table">'), dash.indexOf('<tbody id="wl-tbody">')).match(/<th[ >]/g) || []).length, 15);
  row('no colspan="14" survives in dashboard.html', /colspan="14"/.test(dash), false);
  row('colspan="15" occurrences', (dash.match(/colspan="15"/g) || []).length, 5);

  /* CELL ALIGNMENT. colgroup, header and row must all be 15 wide or every column
     right of Swing renders under the wrong heading — and nothing errors when they
     disagree. Counted off the row template: literal `<td` plus one per cell helper
     (each returns exactly one <td>).
     BLIND SPOT: this proves the COUNT matches, not that the page lays out. Only a
     browser can catch a CSS width or resize-handle problem, and one was not used. */
  const rowTpl = dash.slice(dash.indexOf('html += `<tr class="${earningsCls}'),
                            dash.indexOf('// Expanded row'));
  const helperCells = (rowTpl.match(/\$\{(recCell|crossCell|levelCell|swingCell)\(s\)\}/g) || []).length;
  const literalTds  = (rowTpl.match(/<td[ >]/g) || []).length;
  console.log(`      row template: ${literalTds} literal <td> + ${helperCells} helper cells = ${literalTds + helperCells}`);
  row('rendered row emits 15 cells', literalTds + helperCells, 15);
  row('  ...and swingCell is one of them', helperCells, 4);
}

process.exit(reportVerdict({
  label: 'swing regression channel',
  comparisons: t.comparisons, failures: t.failures,
  /* Floor. The fixed count is 88; exactly ONE block is tape-dependent — §7a
     asserts once per name that actually breached the threshold. Two runs an hour
     apart on 2026-08-14 reported 95 (7 names) and 96 (8). On a quiet day it is 0,
     so the floor must sit at the FIXED count, never at an observed total, or a
     run with no live breach reports NO VERDICT for the wrong reason. 84 leaves
     slack for a name the chart proxy drops. */
  minComparisons: 84,
}));
};

main().catch(e => { console.error('\nHARNESS ERROR:', e.message); process.exit(1); });
