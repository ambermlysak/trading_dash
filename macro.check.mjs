/* macroRegime phase 1 — the classifier, the date alignment, the smoothing, and
 * the state machine including every `unavailable` branch.
 *
 * Sections:
 *   1. THE SIGN CONVENTION. vixTermSpread = VIX − VIX3M, positive = backwardation
 *      = HOSTILE. Getting this backwards inverts the entire signal, and this
 *      codebase has already shipped a term-structure sign error once.
 *   2. The classification form at and around both thresholds, including the
 *      OR-clause that makes a contango session hostile on trend alone.
 *   3. `hostileVia` — which clause fired. null on every non-hostile state.
 *   4. DATE ALIGNMENT. The four live series have DIFFERENT lengths (2514 / 2512 /
 *      2512 / 2492 at 10y, measured 2026-08-11), so index-zipping would pair a
 *      VIX close with a VIX3M close up to 22 sessions away. Checked against a
 *      brute-force intersection built independently.
 *   5. `unavailable` with each input missing IN TURN, reason string printed.
 *      Four inputs = four branches, plus the all-missing case.
 *   6. TRAILING MEAN. Boundary behaviour and a hand-computed window.
 *   7. THE TWO REPRESENTATIONS OF THE TREND SPREAD MUST AGREE.
 *      `smaCrossState(closes).spread` (live) vs `maSpreadSeries(closes)` last
 *      element (history). Two derivations of the same quantity; if they drift,
 *      the stored slice describes a different regime from the rendered chip.
 *   8. The head/series split: `macro:state` stays small, `macro:series` carries
 *      the slice, and the classifier saw the SMOOTHED field.
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
/* Spans to the first `;` after the declaration, so a multi-line object literal
   (MACRO_SYMBOLS, MACRO_GATES) survives — `[^;\n]+` would truncate them. */
function grabConst(name) {
  const key = '\nconst ' + name;
  const i = src.indexOf(key);
  if (i < 0) throw new Error('missing const ' + name);
  const j = src.indexOf(';', i + key.length);
  return src.slice(i + 1, j + 1);
}

const M = new Function([
  grabConst('EMA_CROSS_NEAR_PCT'), grabConst('EMA_CROSS_SLOPE_BARS'),
  grabConst('MACRO_SCHEMA'), grabConst('MACRO_SYMBOLS'), grabConst('MACRO_RANGE'),
  grabConst('MACRO_SLICE_DAYS'), grabConst('MACRO_TREND_FAST'), grabConst('MACRO_TREND_SLOW'),
  grabConst('MACRO_SMOOTH_SESSIONS'), grabConst('T_BACK'), grabConst('T_CONTANGO'),
  grabConst('MACRO_GATES'),
  grab('smaSeries'), grab('crossStateFrom'), grab('smaCrossState'),
  grab('alignMacroSeries'), grab('maSpreadSeries'), grab('macroClassify'),
  grab('trailingMean'), grab('buildMacroRecord'),
  `return { alignMacroSeries, maSpreadSeries, macroClassify, trailingMean, buildMacroRecord,
            smaCrossState, MACRO_GATES, MACRO_SYMBOLS, MACRO_SCHEMA, MACRO_SLICE_DAYS,
            MACRO_SMOOTH_SESSIONS, T_BACK, T_CONTANGO };`,
].join('\n'))();

const G = M.MACRO_GATES;
const t = tally();
const eq = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);

function row(label, got, want) {
  const ok = record(t, eq(got, want));
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(58)} got ${String(got).padEnd(16)} want ${want}`);
}

console.log('\n══ macroRegime phase 1 ══');
console.log(`  T_BACK ${M.T_BACK}   T_CONTANGO ${M.T_CONTANGO}   smoothing ${M.MACRO_SMOOTH_SESSIONS} sessions`);
console.log(`  gates.sign            ${G.sign}`);
console.log(`  gates.classifierInput ${G.classifierInput}`);

/* ── 1. THE SIGN CONVENTION ───────────────────────────────────────────────── */
console.log('\n§1  SIGN CONVENTION — positive term spread is backwardation and is HOSTILE');
const st = (term, spy = 5, qqq = 5) =>
  M.macroClassify({ spySpread: spy, qqqSpread: qqq, vixLevel: 20, vixTermSpread: term }, G).state;

// Both indices strongly ABOVE their 200D, so only the term input can move this.
row('term +5.00 (backwardation), indices up   -> hostile', st(+5), 'hostile');
row('term -5.00 (contango),      indices up   -> constructive', st(-5), 'constructive');
row('sign string names the subtraction', /VIX − VIX3M/.test(G.sign), true);
row('sign string names positive = backwardation', /POSITIVE = backwardation/.test(G.sign), true);
row('sign string names positive = hostile', /backwardation = hostile/.test(G.sign), true);
row('classifier input is the SMOOTHED field', G.classifierInput, 'vixTermSpreadSmoothed');
{
  // A ratio would invert: vix3m/vix > 1 is contango, i.e. the FRIENDLY state, and
  // any classifier reading "below 1.0 is backwardation" points the wrong way.
  const vix = 15.28, vix3m = 18.91;                       // live values, 2026-08-11
  row('hand-check spread = VIX − VIX3M', Math.round((vix - vix3m) * 100) / 100, -3.63);
  row('  ...that is contango, so NOT hostile on term', st(-3.63), 'constructive');
  row('  ...the ratio is >1 in the same state (why it must not classify)',
      Math.round(vix3m / vix * 1000) / 1000 > 1, true);
}

/* ── 2. CLASSIFICATION FORM, at and around the thresholds ─────────────────── */
console.log('\n§2  CLASSIFICATION FORM — boundaries are STRICT, both ways');
row(`term exactly T_BACK (${M.T_BACK}) is NOT hostile (> not >=)`, st(M.T_BACK), 'mixed');
row('term just above T_BACK is hostile', st(M.T_BACK + 0.01), 'hostile');
row(`term exactly T_CONTANGO (${M.T_CONTANGO}) is NOT constructive (< not <=)`, st(M.T_CONTANGO), 'mixed');
row('term just below T_CONTANGO is constructive', st(M.T_CONTANGO - 0.01), 'constructive');
row('term between the two, indices up -> mixed', st(-0.5), 'mixed');

console.log('  -- the OR clause: both indices below 200D is hostile on its own --');
row('contango + both indices DOWN -> hostile', st(-5, -6.5, -12.5), 'hostile');
row('contango + only SPY down     -> mixed', st(-5, -6.5, +12.5), 'mixed');
row('contango + only QQQ down     -> mixed', st(-5, +6.5, -12.5), 'mixed');
row('spread exactly 0 is neither up nor down (strict)', st(-5, 0, 5), 'mixed');
{
  /* THE REAL SESSION THIS EXISTS FOR. 2022-06-16: VIX 33.0, term -0.54 — i.e.
     IN CONTANGO — classified hostile purely on the trend clause. A chip reading
     a bare "hostile" would have implied a vol condition that was not present. */
  const r = M.macroClassify({ spySpread: -6.54, qqqSpread: -12.47, vixLevel: 33.0, vixTermSpread: -0.54 }, G);
  row('2022-06-16 (real session, in contango) -> hostile', r.state, 'hostile');
  row('  ...and hostileVia says trend, not term', r.hostileVia, 'trend');
}

/* ── 3. hostileVia ────────────────────────────────────────────────────────── */
console.log('\n§3  hostileVia — which clause fired');
const via = (term, spy, qqq) =>
  M.macroClassify({ spySpread: spy, qqqSpread: qqq, vixLevel: 20, vixTermSpread: term }, G).hostileVia;
row('backwardation only            -> term',  via(+5, +5, +5), 'term');
row('both indices below only       -> trend', via(-5, -5, -5), 'trend');
row('backwardation AND both below  -> both',  via(+5, -5, -5), 'both');
row('constructive                  -> null',  via(-5, +5, +5), null);
row('mixed                         -> null',  via(-0.5, +5, +5), null);
row('unavailable                   -> null',
    M.macroClassify({ spySpread: null, qqqSpread: 5, vixLevel: 20, vixTermSpread: -5 }, G).hostileVia, null);
row('label names the clause when hostile',
    /\(trend\)/.test(M.macroClassify({ spySpread: -5, qqqSpread: -5, vixLevel: 20, vixTermSpread: -5 }, G).label), true);

/* ── 4. DATE ALIGNMENT ────────────────────────────────────────────────────── */
console.log('\n§4  DATE ALIGNMENT — keyed on session date, never on index');
{
  const day = n => Math.floor(Date.UTC(2026, 0, 5 + n) / 1000);
  // SPY/QQQ/VIX have 6 sessions; VIX3M is MISSING day 2 and day 4. Index-zipping
  // would silently pair VIX day 3 with VIX3M day 5.
  const mk = (n, base) => ({ closes: Array.from({ length: n }, (_, i) => base + i),
                             timestamps: Array.from({ length: n }, (_, i) => day(i)) });
  const series = new Map([
    ['SPY',    mk(6, 100)],
    ['QQQ',    mk(6, 200)],
    ['^VIX',   mk(6, 10)],
    ['^VIX3M', { closes: [50, 51, 53, 55], timestamps: [day(0), day(1), day(3), day(5)] }],
  ]);
  const al = M.alignMacroSeries(series);
  row('alignment succeeds', al.ok, true);
  row('aligned length = |intersection|', al.aligned, 4);
  row('dropped 2 sessions VIX3M lacks', 6 - al.aligned, 2);

  // Brute-force intersection, built independently of the function under test.
  const asMap = s => new Map(s.timestamps.map((ts, i) =>
    [new Date(ts * 1000).toISOString().slice(0, 10), s.closes[i]]));
  const maps = ['SPY', 'QQQ', '^VIX', '^VIX3M'].map(k => asMap(series.get(k)));
  const want = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort();
  if (populated('brute-force intersection', want.length, al.dates.length)) {
    row('dates match brute force', al.dates.join(','), want.join(','));
    row('VIX values match brute force', al.vix.join(','), want.map(d => maps[2].get(d)).join(','));
    row('VIX3M values match brute force', al.vix3m.join(','), want.map(d => maps[3].get(d)).join(','));
  }
  // The whole point: pairing is by DATE, so VIX[i] and VIX3M[i] share a session.
  row('VIX/VIX3M paired on the same date (index 2)',
      al.vix[2] === maps[2].get(al.dates[2]) && al.vix3m[2] === maps[3].get(al.dates[2]), true);
  row('index-zipping would have been WRONG here',
      series.get('^VIX').closes[2] !== al.vix3m[2] - 40, true);   // 12 vs 53-40=13

  row('no lag when all four share the newest session', al.lagged, false);

  // Now make VIX3M stop a session early: `lagged` must fire and name it.
  const lagSeries = new Map(series);
  lagSeries.set('^VIX3M', { closes: [50, 51, 53], timestamps: [day(0), day(1), day(3)] });
  const al2 = M.alignMacroSeries(lagSeries);
  row('lagged fires when one input stops early', al2.lagged, true);
  row('  ...and names the lagging symbol', al2.laggingSymbols.join(','), '^VIX3M');

  // Failure paths return a reason, never a partial alignment.
  const missing = new Map(series); missing.delete('^VIX3M');
  row('absent symbol -> ok:false', M.alignMacroSeries(missing).ok, false);
  row('  ...and names it', /\^VIX3M/.test(M.alignMacroSeries(missing).reason), true);
  const mism = new Map(series);
  mism.set('^VIX3M', { closes: [1, 2, 3], timestamps: [day(0)] });
  row('closes/timestamps length mismatch -> ok:false', M.alignMacroSeries(mism).ok, false);
  const noShare = new Map(series);
  noShare.set('^VIX3M', { closes: [1], timestamps: [Math.floor(Date.UTC(1999, 0, 1) / 1000)] });
  row('no shared date -> ok:false', M.alignMacroSeries(noShare).ok, false);
}

/* ── 5. unavailable, EACH INPUT MISSING IN TURN ───────────────────────────── */
console.log('\n§5  unavailable — each input missing in turn, with its reason');
{
  const full = { spySpread: 5, qqqSpread: 5, vixLevel: 20, vixTermSpread: -5 };
  const names = {
    spySpread: 'SPY 50/200 SMA spread',
    qqqSpread: 'QQQ 50/200 SMA spread',
    vixLevel: 'VIX level',
    vixTermSpread: 'VIX term spread (^VIX − ^VIX3M)',
  };
  for (const k of Object.keys(full)) {
    for (const bad of [null, undefined, NaN, 'x']) {
      const r = M.macroClassify({ ...full, [k]: bad }, G);
      const ok = record(t, r.state === 'unavailable' && r.hostileVia === null
                        && typeof r.reason === 'string' && r.reason.includes(names[k]));
      if (bad === null) {
        console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${k} = null -> ${r.state}`);
        console.log(`         reason: ${r.reason}`);
      } else if (!ok) {
        console.log(`  FAIL ${k} = ${String(bad)} -> ${r.state}`);
      }
    }
  }
  const none = M.macroClassify({}, G);
  row('all four missing -> unavailable', none.state, 'unavailable');
  row('  ...reason names all four', ['SPY', 'QQQ', 'VIX level', 'term spread'].every(s => none.reason.includes(s)), true);
  row('  ...and cites the 205-bar smaCrossState floor', /205 sessions/.test(none.reason), true);
  row('null input object -> unavailable', M.macroClassify(null, G).state, 'unavailable');
  console.log(`         all-missing reason: ${none.reason}`);

  // A partial state must never be computed from three of four.
  row('3 of 4 inputs does NOT produce a state',
      M.macroClassify({ spySpread: 5, qqqSpread: 5, vixLevel: 20 }, G).state, 'unavailable');
}

/* ── 6. TRAILING MEAN ─────────────────────────────────────────────────────── */
console.log('\n§6  trailingMean — the smoothing that classifies');
{
  const a = [10, 20, 30, 40, 50, 60, 70];
  const s = M.trailingMean(a, 5);
  row('index 0 is the raw value (partial window)', s[0], 10);
  row('index 1 = mean(10,20)', s[1], 15);
  row('index 4 = mean(10..50)', s[4], 30);
  row('index 6 = mean(30..70)', s[6], 50);
  row('length preserved', s.length, a.length);
  row('n=1 is a no-op', M.trailingMean(a, 1).join(','), a.join(','));
  row('rounded to 2dp', M.trailingMean([1, 2], 2)[1], 1.5);
  row('non-finite entries are skipped, not zeroed', M.trailingMean([10, null, 20], 3)[2], 15);
  row('all-null window -> null', M.trailingMean([null, null], 2)[1], null);
  // The property that matters: smoothing must not invent a crossing the raw
  // series never approached.
  const flat = M.trailingMean([-5, -5, -5, -5, -5, -5], 5);
  row('constant series is unchanged by smoothing', flat.every(v => v === -5), true);
}

/* ── 7. THE TWO TREND DERIVATIONS MUST AGREE ──────────────────────────────── */
console.log('\n§7  smaCrossState(live) vs maSpreadSeries(history) — same quantity');
{
  // A synthetic series long enough to clear the 205-bar floor, with structure so
  // the spread is not trivially zero.
  const closes = Array.from({ length: 400 }, (_, i) => 100 + i * 0.2 + 8 * Math.sin(i / 11));
  const live = M.smaCrossState(closes, M.MACRO_GATES.trendFast, M.MACRO_GATES.trendSlow);
  const hist = M.maSpreadSeries(closes);
  if (populated('trend derivations', live ? 1 : 0, hist ? hist.length : 0)) {
    row('live spread == last element of the history series', live.spread, hist[hist.length - 1]);
    row('history is null before the SMA200 warm-up', hist[M.MACRO_GATES.trendSlow - 2], null);
    row('history is non-null from bar slow-1', typeof hist[M.MACRO_GATES.trendSlow - 1], 'number');
  }
  // Three more offsets, so the agreement is not a coincidence at one index.
  for (const cut of [250, 300, 350]) {
    const sub = closes.slice(0, cut);
    const l = M.smaCrossState(sub, M.MACRO_GATES.trendFast, M.MACRO_GATES.trendSlow);
    const h = M.maSpreadSeries(sub);
    row(`agree at length ${cut}`, l.spread, h[h.length - 1]);
  }
  row('below the 205-bar floor smaCrossState returns null',
      M.smaCrossState(closes.slice(0, 204), 50, 200), null);
}

/* ── 8. THE RECORD: head/series split ─────────────────────────────────────── */
console.log('\n§8  buildMacroRecord — head/series split and the classified field');
{
  const N = 900;
  const day = n => Math.floor(Date.UTC(2022, 0, 3) / 1000) + n * 86400;
  const dates = Array.from({ length: N }, (_, i) => new Date(day(i) * 1000).toISOString().slice(0, 10));
  const ramp  = Array.from({ length: N }, (_, i) => 100 + i * 0.1);
  /* Raw term flips positive on the FINAL bar only. The 5-session mean stays
     negative, so raw and smoothed disagree — which is exactly the case that
     proves which field the classifier read. */
  const vix3m = Array.from({ length: N }, () => 20);
  const vix   = Array.from({ length: N }, (_, i) => (i === N - 1 ? 26 : 15));
  const al = { ok: true, dates, spy: ramp, qqq: ramp, vix, vix3m,
               counts: { SPY: N, QQQ: N, '^VIX': N, '^VIX3M': N }, aligned: N,
               lastPerSymbol: {}, lagged: false, laggingSymbols: [] };
  const { head, series } = M.buildMacroRecord(al, { asOfTs: 1_700_000_000_000 });

  row('raw term on the last bar is backwardated', head.vixTermSpread, 6);
  row('smoothed term is still in contango', head.vixTermSpreadSmoothed, -2.8);
  row('THE CLASSIFIER READ THE SMOOTHED FIELD (not hostile)', head.state, 'constructive');
  row('  ...raw alone would have said hostile',
      M.macroClassify({ ...head, vixTermSpread: head.vixTermSpread }, G).state, 'hostile');

  row('head carries the schema', head.schema, M.MACRO_SCHEMA);
  row('series carries the same schema', series.schema, M.MACRO_SCHEMA);
  row('head does NOT carry the slice', head.series3y === undefined && head.dates === undefined, true);
  row('series length capped at MACRO_SLICE_DAYS', series.dates.length, M.MACRO_SLICE_DAYS);
  row('every slice array is the same length',
      [series.spySpread, series.qqqSpread, series.vixLevel, series.vixTermSpread,
       series.vixTermSpreadSmoothed].every(a => a.length === series.dates.length), true);
  row('asOfClose is the last aligned session', head.asOfClose, dates[N - 1]);
  row('head/series agree on asOfClose', series.asOfClose, head.asOfClose);
  row('vixTermRatio is display-only and present', head.vixTermRatio, Math.round(20 / 26 * 1000) / 1000);

  const headBytes = Buffer.byteLength(JSON.stringify(head), 'utf8');
  const serBytes  = Buffer.byteLength(JSON.stringify(series), 'utf8');
  console.log(`       macro:state ${headBytes} B   ·   macro:series ${serBytes.toLocaleString()} B`);
  row('head stays small enough for the request path (<2 KB)', headBytes < 2048, true);
  row('the split actually moved the bulk off the hot path', serBytes > headBytes * 10, true);

  // Provisional rides on the alignment lag, not on the classifier.
  const { head: h2 } = M.buildMacroRecord({ ...al, lagged: true, laggingSymbols: ['^VIX3M'],
                                            lastPerSymbol: { SPY: dates[N - 1], '^VIX3M': dates[N - 2] } },
                                          { asOfTs: 1 });
  row('lagged input sets provisional', h2.provisional, true);
  row('  ...and the reason names the symbol', /\^VIX3M/.test(h2.reason), true);
  row('non-lagged record is not provisional', head.provisional, false);
  row('non-lagged record has no reason', head.reason, null);
}

/* ── 9. PHASE 1 MUST NOT RANK ─────────────────────────────────────────────── */
console.log('\n§9  phase 1 is display-only — asserted against the source, not assumed');
{
  // A grep is a weak test, but the failure it guards is real: a later edit that
  // sorts or gates on macro state would otherwise ship silently.
  const laneSrc = src.slice(src.indexOf('function attachCoverage'), src.indexOf('function longRow'));
  row('attachCoverage does not read macro state', /macro/i.test(laneSrc), false);
  const sortSrc = src.slice(src.indexOf('function buyableFrom'), src.indexOf('function normPdf'));
  row('the vol gate does not read macro state', /macro/i.test(sortSrc), false);
  row('readMacroState declares usedForRanking:false', /usedForRanking: false/.test(src), true);
  row('macro:series is never read on the request path',
      (src.match(/MACRO_SERIES_KEY/g) || []).length, 2);   // the const, and the single put
}

/* ── 10. THE COLLECTOR: exact cost, and the refusal contract ──────────────── */
console.log('\n§10 collectMacroState — cost counted with stub bindings, and refusal before dedup');
{
  /* WHY THIS IS NOT MEASURED FROM `_instr`. The 1:15pm branch dispatches three
     jobs through `ctx.waitUntil`, and `instrSince()` subtracts INVOCATION-WIDE
     counters over a span of time — so the EOD summary's and the IV sweep's KV
     calls land inside this job's bracket. Measured locally on that branch the
     macro job reported `bindingOps 5` where its own structure predicts 4;
     contamination is strictly additive, so 5 is an upper bound, not the cost.
     Counting the calls directly is isolated BY CONSTRUCTION. */
  const mkEnv = (existing = {}) => {
    const calls = [];
    return {
      calls,
      env: { REC_LOG: {
        get: async (k) => { calls.push(['get', k]); return existing[k] ?? null; },
        put: async (k, v) => { calls.push(['put', k, v.length]); return undefined; },
        delete: async (k) => { calls.push(['delete', k]); },
      } },
    };
  };
  const N = 300;
  const day = n => Math.floor(Date.UTC(2024, 0, 2) / 1000) + n * 86400;
  const mkSeries = (base, step) => ({
    closes: Array.from({ length: N }, (_, i) => base + i * step),
    timestamps: Array.from({ length: N }, (_, i) => day(i)),
  });
  const goodSpark = () => new Map([
    ['SPY', mkSeries(400, 0.3)], ['QQQ', mkSeries(350, 0.4)],
    ['^VIX', mkSeries(16, 0)],   ['^VIX3M', mkSeries(19, 0)],
  ]);

  let fetches = 0, sparkImpl = goodSpark;
  const C = new Function([
    grabConst('MACRO_KEY'), grabConst('MACRO_SERIES_KEY'), grabConst('MACRO_SWEEP_KEY'),
    grabConst('MACRO_TTL'), grabConst('MACRO_SCHEMA'), grabConst('MACRO_SYMBOLS'),
    grabConst('MACRO_RANGE'), grabConst('MACRO_SLICE_DAYS'), grabConst('MACRO_SMOOTH_SESSIONS'),
    grabConst('MACRO_TREND_FAST'), grabConst('MACRO_TREND_SLOW'),
    grabConst('T_BACK'), grabConst('T_CONTANGO'), grabConst('MACRO_GATES'),
    grabConst('EMA_CROSS_NEAR_PCT'), grabConst('EMA_CROSS_SLOPE_BARS'),
    'const ptDate = () => "2026-08-11";',
    'const instrMark = () => ({});',
    'const instrSince = () => ({ stub: true });',
    'const yahooSparkCloses = async () => { bumpFetch(); return sparkImpl(); };',
    grab('smaSeries'), grab('crossStateFrom'), grab('smaCrossState'),
    grab('alignMacroSeries'), grab('maSpreadSeries'), grab('macroClassify'),
    grab('trailingMean'), grab('buildMacroRecord'), grab('collectMacroState'),
    'return collectMacroState;',
  ].join('\n'))
    .call(null);
  // The generated function closes over these names from this module's scope.
  globalThis.bumpFetch = () => { fetches++; };
  Object.defineProperty(globalThis, 'sparkImpl', { get: () => sparkImpl, configurable: true });

  // -- happy path --
  {
    fetches = 0;
    const { calls, env } = mkEnv();
    await C(env);
    const gets = calls.filter(c => c[0] === 'get').length;
    const puts = calls.filter(c => c[0] === 'put').length;
    row('external fetches (one spark call, 4 symbols)', fetches, 1);
    row('binding gets (the dedup probe)', gets, 1);
    row('binding puts (series + state + dedup)', puts, 3);
    row('TOTAL bindingOps', calls.length, 4);
    row('TOTAL capCost = ext + binding', fetches + calls.length, 5);
    row('write order: series before state', calls.findIndex(c => c[1] === 'macro:series')
        < calls.findIndex(c => c[1] === 'macro:state'), true);
    row('dedup stamped LAST', calls[calls.length - 1][1], 'macrosweep:last');
    console.log('       calls: ' + calls.map(c => `${c[0]} ${c[1]}${c[2] ? ` (${c[2]}B)` : ''}`).join(' | '));
  }
  // -- already ran today: one get, nothing else --
  {
    fetches = 0;
    const { calls, env } = mkEnv({ 'macrosweep:last': '2026-08-11' });
    await C(env);
    row('deduped run makes NO fetch', fetches, 0);
    row('deduped run costs exactly one get', calls.length, 1);
  }
  // -- REFUSAL: spark throws. Must not stamp, must not write. --
  {
    fetches = 0;
    sparkImpl = () => { throw new Error('spark 429'); };
    const { calls, env } = mkEnv();
    await C(env);
    row('spark failure writes nothing', calls.filter(c => c[0] === 'put').length, 0);
    row('  ...and does NOT stamp the dedup key',
        calls.some(c => c[1] === 'macrosweep:last' && c[0] === 'put'), false);
    sparkImpl = goodSpark;
  }
  // -- REFUSAL: a symbol missing from the response. Same contract. --
  {
    sparkImpl = () => { const m = goodSpark(); m.delete('^VIX3M'); return m; };
    const { calls, env } = mkEnv();
    await C(env);
    row('missing ^VIX3M writes nothing', calls.filter(c => c[0] === 'put').length, 0);
    row('  ...and does NOT stamp the dedup key',
        calls.some(c => c[1] === 'macrosweep:last' && c[0] === 'put'), false);
    sparkImpl = goodSpark;
  }
  // -- REFUSAL: too little history for SMA200 -> unavailable, never stored. --
  {
    const short = () => new Map([
      ['SPY', { closes: [1, 2, 3], timestamps: [day(0), day(1), day(2)] }],
      ['QQQ', { closes: [1, 2, 3], timestamps: [day(0), day(1), day(2)] }],
      ['^VIX', { closes: [16, 16, 16], timestamps: [day(0), day(1), day(2)] }],
      ['^VIX3M', { closes: [19, 19, 19], timestamps: [day(0), day(1), day(2)] }],
    ]);
    sparkImpl = short;
    const { calls, env } = mkEnv();
    await C(env);
    row('unavailable state is never written to KV', calls.filter(c => c[0] === 'put').length, 0);
    row('  ...and does NOT stamp the dedup key',
        calls.some(c => c[1] === 'macrosweep:last' && c[0] === 'put'), false);
    sparkImpl = goodSpark;
  }
  // -- A KV write failure must also leave the dedup key unstamped. --
  {
    const calls = [];
    const env = { REC_LOG: {
      get: async (k) => { calls.push(['get', k]); return null; },
      put: async (k) => { calls.push(['put', k]); if (k !== 'macrosweep:last') throw new Error('KV down'); },
    } };
    await C(env);
    row('KV write failure does not stamp the dedup key',
        calls.some(c => c[0] === 'put' && c[1] === 'macrosweep:last'), false);
  }
  row('no REC_LOG binding -> returns without throwing',
      await C({}).then(() => true).catch(() => false), true);
}

console.log('');
process.exit(reportVerdict({
  label: 'macroRegime phase 1',
  comparisons: t.comparisons,
  failures: t.failures,
  /* The OBSERVED count, set at the exact number this run performs. A change in
     population is something a human should have to notice and update
     deliberately, not something that slides. */
  minComparisons: 119,
}));
