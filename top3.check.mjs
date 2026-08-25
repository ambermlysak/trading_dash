/**
 * top3.check.mjs — the daily top-3 options ranking (`top3:{PT-DATE}`).
 *
 * Nine sections, all of them PRINTING computed against expected rather than
 * asserting, because a claim that something passed is not a measurement.
 *
 *   1. the constant table, cross-checked against the SPEC's literals rather than
 *      against itself — restating `TOP3_ANCHORS` back at itself proves nothing,
 *      so the anchors and weights are typed out here independently and compared.
 *   2. `top3Subscores` against a hand-computed reference.
 *   3. clipping at BOTH bounds, plus the two extremes of the whole score (0/100).
 *   4. the min-of-coverage rule, shown against the average it is NOT.
 *   5. every gate FIRING and at a NON-FIRING boundary value — a gate tested only
 *      where it fires passes on code that always fires.
 *   6. `top3Sweep`'s classification with stub bindings: the `error` status that
 *      does NOT throw (which would otherwise have stamped a broken run out of the
 *      day), the domain statuses that are complete outcomes, the reuse rule, and
 *      the consecutive-failure run.
 *   7. `top3Rank` end to end on synthetic rows: both directions, HOLD, a stale
 *      verdict, one-slot-per-ticker, the top-3 cut, the tie-break, and the
 *      zero-qualifying case that must publish `[]` rather than refuse.
 *   8. `readTop3`'s STRICT schema equality and its failure paths.
 *   9. what `gates` actually ships, since a consumer is told not to hardcode.
 *
 * Everything is extracted from `worker.js` BY SOURCE, not imported — every named
 * export there must be a function or `workerd` refuses to boot.
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

/* Spans to the first `;` after the declaration so a multi-line object literal
   survives. The identifier boundary check is load-bearing here: a plain
   indexOf('\nconst TOP3_MAX') also matches `TOP3_MAX_EXCLUDED`, and grabbing the
   wrong constant would make every downstream comparison meaningless in the most
   confident possible way. */
function grabConst(name) {
  const key = '\nconst ' + name;
  let i = -1, from = 0;
  for (;;) {
    i = src.indexOf(key, from);
    if (i < 0) throw new Error('missing const ' + name);
    const next = src[i + key.length];
    if (/[\s=]/.test(next)) break;
    from = i + 1;
  }
  const j = src.indexOf(';', i + key.length);
  return src.slice(i + 1, j + 1);
}

/* STUBS FOR THE THREE THINGS THE SWEEP REACHES OUT TO. They are declared ahead of
   `top3Sweep` in the generated module, so its unqualified references resolve to
   these rather than to anything real. Nothing here touches the network or KV. */
const STUBS = `
let __cached = {};       // sym -> cached long row (or undefined)
let __refresh = {};      // sym -> () => row | throw
let __crumbCalls = 0;
async function getYahooCrumb() { __crumbCalls++; return 'stub-crumb'; }
async function readLongRow(sym) { return __cached[sym] ?? null; }
async function refreshLongTicker(sym) {
  const f = __refresh[sym];
  if (!f) throw new Error('no stub for ' + sym);
  return f();
}
function __setStubs(cached, refresh) { __cached = cached; __refresh = refresh; __crumbCalls = 0; }
function __crumb() { return __crumbCalls; }
`;

const M = new Function([
  grabConst('clampTo'),
  grabConst('ptDate'),
  grabConst('LONG_FRESH_MS'),
  grabConst('LONG_SPREAD_MAX_NEAR'), grabConst('LONG_SPREAD_MAX_LEAPS'), grabConst('LONG_MIN_OI'),
  grabConst('IVR_BUY_MAX'), grabConst('RATIO_BUY_MAX'),
  grabConst('TOP3_SCHEMA'), grabConst('TOP3_MAX'), grabConst('TOP3_TTL'),
  grabConst('TOP3_SWEEP_KEY'), grabConst('top3Key'),
  grabConst('TOP3_SWEEP_CAP'), grabConst('TOP3_LANES'), grabConst('TOP3_MIN_EPISODES_TO_50'),
  grabConst('TOP3_MAX_EXCLUDED'), grabConst('TOP3_SWEEP_WALL_WARN_MS'),
  grabConst('TOP3_SYSTEMIC_FAIL_RUN'),
  grabConst('TOP3_ANCHORS'), grabConst('TOP3_WEIGHTS'), grabConst('TOP3_WEIGHT_TOTAL'),
  grabConst('TOP3_SCORE_INPUTS'), grabConst('TOP3_GATE_ORDER'), grabConst('TOP3_DOMAIN_STATUSES'),
  grab('readAnalysisRecord'),
  grab('top3GatesDeclared'), grab('top3Subscores'), grab('top3GateCandidate'),
  grab('top3Contract'), grab('top3Entry'),
  STUBS,
  grab('top3Sweep'), grab('top3Rank'), grab('readTop3'),
  `return { clampTo, ptDate, LONG_FRESH_MS, TOP3_SCHEMA, TOP3_MAX, TOP3_TTL, TOP3_SWEEP_KEY, top3Key,
            TOP3_SWEEP_CAP, TOP3_LANES, TOP3_MIN_EPISODES_TO_50, TOP3_MAX_EXCLUDED,
            TOP3_SWEEP_WALL_WARN_MS, TOP3_SYSTEMIC_FAIL_RUN, TOP3_ANCHORS, TOP3_WEIGHTS,
            TOP3_WEIGHT_TOTAL, TOP3_SCORE_INPUTS, TOP3_GATE_ORDER, TOP3_DOMAIN_STATUSES,
            LONG_MIN_OI, IVR_BUY_MAX, RATIO_BUY_MAX,
            top3GatesDeclared, top3Subscores, top3GateCandidate, top3Contract, top3Entry,
            top3Sweep, top3Rank, readTop3, readAnalysisRecord, __setStubs, __crumb };`,
].join('\n'))();

const t = tally();
const j = v => JSON.stringify(v);
const near = (a, b, eps = 1e-9) =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < eps : j(a) === j(b);

function row(label, got, want, eps) {
  const ok = record(t, near(got, want, eps));
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(56)} got ${String(j(got)).padEnd(22)} want ${j(want)}`);
}

/* ═══ 1. THE CONSTANT TABLE, against the spec's own literals ═════════════════ */
console.log('\n§1  constants — source table vs the SPEC, typed out independently');

const SPEC_WEIGHTS = { probMarket: 20, probMeasured: 15, sharpe: 25, win: 15, beEm: 15, dollars: 10 };
const SPEC_ANCHORS = { pBe: 0.50, coverageMin: 0.60, sharpe: 0.80, winRate: 0.70,
                       beEmCeiling: 1.20, beEmSpan: 0.90, expectedDollars: 5000 };

for (const [k, v] of Object.entries(SPEC_WEIGHTS)) row(`weight ${k}`, M.TOP3_WEIGHTS[k], v);
for (const [k, v] of Object.entries(SPEC_ANCHORS)) row(`anchor ${k}`, M.TOP3_ANCHORS[k], v);
row('weights sum to 100', M.TOP3_WEIGHT_TOTAL, 100);
row('weight keys match the spec exactly', Object.keys(M.TOP3_WEIGHTS).sort().join(','),
    Object.keys(SPEC_WEIGHTS).sort().join(','));
row('anchor keys match the spec exactly', Object.keys(M.TOP3_ANCHORS).sort().join(','),
    Object.keys(SPEC_ANCHORS).sort().join(','));
row('TOP3_MAX', M.TOP3_MAX, 3);
row('min episodes-to-50 gate', M.TOP3_MIN_EPISODES_TO_50, 2);
row('eligible lanes', M.TOP3_LANES.join(','), 'B,C');
row('score inputs, all seven', M.TOP3_SCORE_INPUTS.join(','),
    'pBe,coverage1y,coverage3y,expectancySharpe,expectancyWinRate,expectedDollars,beEm');
row('dedup key sits OUTSIDE the top3: prefix', M.TOP3_SWEEP_KEY.startsWith('top3:'), false);
row('  …and is the documented name', M.TOP3_SWEEP_KEY, 'top3sweep:last');
row('record key is date-namespaced', M.top3Key('2026-08-25'), 'top3:2026-08-25');
row('retention outlives the day it names (>24h)', M.TOP3_TTL > 24 * 3600, true);
row('domain statuses are the three "nothing screenable" ones',
    M.TOP3_DOMAIN_STATUSES.join(','), 'no-options,no-iv,no-expiries');
row('`error` is NOT a domain status', M.TOP3_DOMAIN_STATUSES.includes('error'), false);

/* ═══ 2. THE SCORE, against a hand-computed reference ════════════════════════ */
console.log('\n§2  top3Subscores — hand-computed reference');

const CAND = {
  pBe: 0.35, coverage1y: 0.40, coverage3y: 0.55,
  expectancySharpe: 0.40, expectancyWinRate: 0.49,
  expectedDollars: 2500, beEm: 0.75,
};
/* By hand, from the spec:
     probMarket   0.35 / 0.50            = 0.70    x 20 = 14.0
     probMeasured min(0.40,0.55) / 0.60  = 0.6667  x 15 = 10.0
     sharpe       0.40 / 0.80            = 0.50    x 25 = 12.5
     win          0.49 / 0.70            = 0.70    x 15 = 10.5
     beEm         (1.20 - 0.75) / 0.90   = 0.50    x 15 =  7.5
     dollars      2500 / 5000            = 0.50    x 10 =  5.0
                                                   total 59.5                       */
const s = M.top3Subscores(CAND);
console.log(`     components: ${Object.entries(s.subscores)
  .map(([k, v]) => `${k}=${v.component}(${v.points}pt)`).join('  ')}`);
row('probMarket component',   s.subscores.probMarket.component, 0.70);
row('probMeasured component', s.subscores.probMeasured.component, 0.6667);
row('sharpe component',       s.subscores.sharpe.component, 0.50);
row('win component',          s.subscores.win.component, 0.70);
row('beEm component',         s.subscores.beEm.component, 0.50);
row('dollars component',      s.subscores.dollars.component, 0.50);
row('probMarket points',      s.subscores.probMarket.points, 14.0);
row('probMeasured points',    s.subscores.probMeasured.points, 10.0);
row('sharpe points',          s.subscores.sharpe.points, 12.5);
row('win points',             s.subscores.win.points, 10.5);
row('beEm points',            s.subscores.beEm.points, 7.5);
row('dollars points',         s.subscores.dollars.points, 5.0);
row('score (hand total)',     s.score, 59.5);
row('score IS the point sum — decomposable, not a bare number',
    +Object.values(s.subscores).reduce((a, x) => a + x.points, 0).toFixed(2), s.score);
row('every component ships its raw input',
    Object.values(s.subscores).every(x => Number.isFinite(x.input)), true);
row('every component ships its anchor',
    Object.values(s.subscores).every(x => Number.isFinite(x.anchor)), true);

/* ═══ 3. CLIPPING AT BOTH BOUNDS, and the two score extremes ═════════════════ */
console.log('\n§3  clipping — at BOTH bounds, and at the boundary where it must NOT fire');

const one = over => M.top3Subscores({ ...CAND, ...over });

row('pBe 0.90 -> raw 1.80, clipped to 1', one({ pBe: 0.90 }).subscores.probMarket.component, 1);
row('  …and reports itself clipped',      one({ pBe: 0.90 }).subscores.probMarket.clipped, true);
row('pBe 0.50 -> raw 1.00, NOT clipped',  one({ pBe: 0.50 }).subscores.probMarket.clipped, false);
row('  …component exactly 1 there',       one({ pBe: 0.50 }).subscores.probMarket.component, 1);
row('sharpe -0.50 -> raw -0.625, clipped to 0',
    one({ expectancySharpe: -0.50 }).subscores.sharpe.component, 0);
row('sharpe 0 -> component 0, NOT clipped',
    one({ expectancySharpe: 0 }).subscores.sharpe.clipped, false);
row('beEm 1.20 (the ceiling) -> component 0', one({ beEm: 1.20 }).subscores.beEm.component, 0);
row('  …NOT clipped at the ceiling',          one({ beEm: 1.20 }).subscores.beEm.clipped, false);
row('beEm 0.30 (ceiling - span) -> component 1', one({ beEm: 0.30 }).subscores.beEm.component, 1);
row('  …NOT clipped there either',               one({ beEm: 0.30 }).subscores.beEm.clipped, false);
row('beEm 0.20 -> below the span, clipped to 1', one({ beEm: 0.20 }).subscores.beEm.component, 1);
row('  …and reports itself clipped',             one({ beEm: 0.20 }).subscores.beEm.clipped, true);
row('beEm 1.50 -> above the ceiling, clipped to 0', one({ beEm: 1.50 }).subscores.beEm.component, 0);
row('beEm INVERTS: 0.40 scores above 0.90',
    one({ beEm: 0.40 }).score > one({ beEm: 0.90 }).score, true);
row('expectedDollars 0 is FINITE and scores 0, not missing',
    one({ expectedDollars: 0 }).subscores.dollars.points, 0);

const MAXED = { pBe: 1, coverage1y: 1, coverage3y: 1, expectancySharpe: 5,
                expectancyWinRate: 1, expectedDollars: 999_999, beEm: 0 };
const FLOORED = { pBe: 0, coverage1y: 0, coverage3y: 0, expectancySharpe: -9,
                  expectancyWinRate: 0, expectedDollars: -9999, beEm: 9 };
row('every component maxed -> score 100', M.top3Subscores(MAXED).score, 100);
row('every component floored -> score 0', M.top3Subscores(FLOORED).score, 0);

/* ═══ 4. THE MIN RULE, shown against the average it is NOT ═══════════════════ */
console.log('\n§4  probMeasured takes the MIN of the two windows, never the average');

const lowFirst  = one({ coverage1y: 0.20, coverage3y: 0.90 });
const highFirst = one({ coverage1y: 0.90, coverage3y: 0.20 });
row('min is order-independent (1y low)',  lowFirst.subscores.probMeasured.input, 0.20);
row('min is order-independent (3y low)',  highFirst.subscores.probMeasured.input, 0.20);
row('the two agree exactly',              lowFirst.score, highFirst.score);
const avgComponent = M.clampTo(((0.20 + 0.90) / 2) / M.TOP3_ANCHORS.coverageMin, 0, 1);
console.log(`     a 1y collapse (1y 0.20 / 3y 0.90): min -> component `
  + `${lowFirst.subscores.probMeasured.component}, an AVERAGE would give ${+avgComponent.toFixed(4)} — `
  + `${+(15 * (avgComponent - lowFirst.subscores.probMeasured.component)).toFixed(2)} points of difference`);
row('the min really is the binding one (below the average)',
    lowFirst.subscores.probMeasured.component < avgComponent, true);

/* ═══ 5. EVERY GATE, FIRING AND NOT FIRING ══════════════════════════════════ */
console.log('\n§5  the four hard gates — each one firing AND at a non-firing boundary');

const PASSING = {
  lane: 'B', type: 'CALL', status: 'ok', flags: [], spreadMax: 0.15, openInterest: 500,
  expectancyEpisodesTo50: 4, expectancyEpisodes: 11, ...CAND,
};
const ROW_OK = { buyable: true, buyableReason: 'IVR 22 — at or below the 40 ceiling' };
const gate = (c, r = ROW_OK) => M.top3GateCandidate({ ...PASSING, ...c }, { ...ROW_OK, ...r });

row('a fully passing candidate passes', gate({}).ok, true);

console.log('   liquidity');
row('  status `illiquid` fails',        gate({ status: 'illiquid' }).gate, 'liquidity');
row('  status `no-quote` fails',        gate({ status: 'no-quote' }).gate, 'liquidity');
row('  a wide-spread flag fails',       gate({ flags: ['wide-spread'] }).gate, 'liquidity');
row('  a thin-oi flag fails',           gate({ flags: ['thin-oi'] }).gate, 'liquidity');
row('  both flags fail',                gate({ flags: ['wide-spread', 'thin-oi'] }).gate, 'liquidity');
row('  status ok + NO flags passes',    gate({ status: 'ok', flags: [] }).ok, true);

console.log('   vol — TRI-STATE, and null is not a failure');
row('  buyable false excludes',         gate({}, { buyable: false, buyableReason: 'IVR 71 — above 40' }).gate, 'vol');
row('  buyable null PASSES (collecting)', gate({}, { buyable: null }).ok, true);
row('  buyable true PASSES (cheap)',    gate({}, { buyable: true }).ok, true);

console.log('   episodes');
row('  episodesTo50 1 fails',           gate({ expectancyEpisodesTo50: 1 }).gate, 'episodes');
row('  episodesTo50 2 PASSES (the boundary)', gate({ expectancyEpisodesTo50: 2 }).ok, true);
row('  episodesTo50 null fails',        gate({ expectancyEpisodesTo50: null }).gate, 'episodes');
row('  episodesTo50 undefined fails',   gate({ expectancyEpisodesTo50: undefined }).gate, 'episodes');
row('  a missing count names it as missing, not as low',
    /missing input is not a pass/.test(gate({ expectancyEpisodesTo50: null }).reason), true);

console.log('   inputs — each of the seven, nulled in turn');
for (const f of M.TOP3_SCORE_INPUTS) {
  const g = gate({ [f]: null });
  row(`  ${f} null excludes, field named`, `${g.gate}/${g.field}`, `inputs/${f}`);
}
row('  NaN is not numeric either',      gate({ pBe: NaN }).gate, 'inputs');
row('  a string is not numeric',        gate({ pBe: '0.35' }).gate, 'inputs');
row('  0 is a VALUE, not a missing input', gate({ expectedDollars: 0 }).ok, true);

console.log('   ordering — liquidity is decided before vol');
row('  illiquid + rich vol reports liquidity',
    gate({ status: 'illiquid' }, { buyable: false, buyableReason: 'x' }).gate, 'liquidity');

/* ═══ 6. THE SWEEP'S CLASSIFICATION, with stub bindings ═════════════════════ */
console.log('\n§6  top3Sweep — the `error` status does NOT throw, and that is the whole point');

const okRow  = (sym, ts = Date.now()) => ({ symbol: sym, ok: true,  status: 'ok', ts, lanes: [] });
const errRow = (sym) => ({ symbol: sym, ok: false, status: 'error', ts: Date.now(),
                           reason: 'options chain fetch failed: 500', lanes: [] });
const domRow = (sym) => ({ symbol: sym, ok: false, status: 'no-options', ts: Date.now(),
                           reason: 'no listed options for this ticker', lanes: [] });

const sweepWith = async (cached, refresh, tickers) => {
  M.__setStubs(cached, refresh);
  return M.top3Sweep({}, tickers);
};

{
  const fresh = okRow('FRESH');
  const stale = { ...okRow('STALE'), ts: Date.now() - M.LONG_FRESH_MS - 1000 };
  const cachedErr = errRow('CACHEDERR');
  const sw = await sweepWith(
    { FRESH: fresh, STALE: stale, CACHEDERR: cachedErr },
    {
      STALE:     () => okRow('STALE'),
      CACHEDERR: () => okRow('CACHEDERR'),
      COLD:      () => okRow('COLD'),
      DOMAIN:    () => domRow('DOMAIN'),
      ERRSTAT:   () => errRow('ERRSTAT'),
      THROWS:    () => { throw new Error('yahoo 429'); },
    },
    ['FRESH', 'STALE', 'CACHEDERR', 'COLD', 'DOMAIN', 'ERRSTAT', 'THROWS'],
  );
  console.log(`     counts: fetched ${sw.fetched} · reused ${sw.reused} · skipped ${sw.skipped} · `
    + `failed ${sw.failed} · statuses ${j(sw.byStatus)}`);
  row('a fresh ok row is REUSED',                sw.rows.get('FRESH').rowSource, 'reused');
  row('a stale ok row is REFETCHED',             sw.rows.get('STALE').rowSource, 'fetched');
  row('a fresh ERROR row is NOT reused',         sw.rows.get('CACHEDERR').rowSource, 'fetched');
  row('an uncached ticker is fetched',           sw.rows.get('COLD').rowSource, 'fetched');
  row('a `no-options` row is KEPT',              !!sw.rows.get('DOMAIN'), true);
  row('  …and counted as skipped, not failed',   sw.skipped, 1);
  row('a status:`error` row is a FAILURE',       sw.rows.has('ERRSTAT'), false);
  row('  …recorded with its symbol and reason',
      j(sw.failures.find(f => f.symbol === 'ERRSTAT')?.via), '"row-status"');
  row('a THROWN error is a failure too',         sw.rows.has('THROWS'), false);
  row('  …and says it threw',
      j(sw.failures.find(f => f.symbol === 'THROWS')?.via), '"threw"');
  row('failed counts BOTH kinds',                sw.failed, 2);
  row('one failure does NOT abort the sweep',    sw.rows.size, 5);
  row('reused + fetched + failed === N',         sw.reused + sw.fetched + sw.failed, 7);
  row('one crumb warm-up for the whole sweep',   M.__crumb(), 1);
  row('wall time is measured',                   Number.isFinite(sw.wallMs), true);
  row('sequential — every ticker attempted',     Object.keys(sw.byStatus).length > 0, true);
}
{
  // 4 consecutive failures then a success: below the systemic bar.
  const four = await sweepWith({}, {
    A: () => { throw new Error('x'); }, B: () => { throw new Error('x'); },
    C: () => { throw new Error('x'); }, D: () => { throw new Error('x'); },
    E: () => okRow('E'),
  }, ['A', 'B', 'C', 'D', 'E']);
  row(`${M.TOP3_SYSTEMIC_FAIL_RUN - 1} consecutive failures is not systemic`, four.systemicSuspected, false);
  row('  …but they are still all recorded', four.failed, 4);

  const five = await sweepWith({}, {
    A: () => { throw new Error('x'); }, B: () => { throw new Error('x'); },
    C: () => { throw new Error('x'); }, D: () => { throw new Error('x'); },
    E: () => { throw new Error('x'); }, F: () => okRow('F'),
  }, ['A', 'B', 'C', 'D', 'E', 'F']);
  row(`${M.TOP3_SYSTEMIC_FAIL_RUN} consecutive failures IS systemic`, five.systemicSuspected, true);
  row('  …and the sweep still finished the rest', five.rows.has('F'), true);
}
{
  // A run where every ticker failed: no rows at all, which the caller refuses on.
  const none = await sweepWith({}, { A: () => { throw new Error('x'); } }, ['A']);
  row('every ticker failing leaves zero rows', none.rows.size, 0);
}

/* ═══ 7. THE RANKING PASS, end to end on synthetic rows ═════════════════════ */
console.log('\n§7  top3Rank — direction, one slot per ticker, the cut, and zero-qualifying');

const TODAY = M.ptDate();
const cand = (type, over = {}) => ({
  lane: 'B', type, status: 'ok', flags: [], spreadMax: 0.15, strike: 100, delta: 0.55,
  debit: 500, debitPerShare: 5, breakeven: 105, bePct: 5,
  expectancyEpisodesTo50: 4, expectancyEpisodes: 11, ...CAND, ...over,
});
const laneB = (cands) => ({ lane: 'B', expiry: '2026-10-16', dte: 52, atmIv: 30,
                            expectedMovePct: 11.3, candidates: cands });
const laneC = (cands) => ({ lane: 'C', expiry: '2026-10-16', dte: 52, atmIv: 30,
                            expectedMovePct: 11.3, candidates: cands });
const laneA = (cands) => ({ lane: 'A', expiry: '2028-01-21', dte: 880, atmIv: 35, candidates: cands });
const mkRow = (sym, lanes, over = {}) => ({
  symbol: sym, ok: true, status: 'ok', ts: Date.now(), spot: 100, lanes,
  buyable: true, buyableBasis: 'rank', buyableReason: 'IVR 22 — at or below the 40 ceiling',
  ivRank: 0.22, ivHvRatio: 0.8, historyDays: 90, regime: { state: 'depressed' }, ...over,
});
const verdictRec = (rating, ts = Date.now()) => ({
  rating, confidence: 70, recommendation: 'Do the thing', drivers: ['a', 'b'],
  summary: 'One. Two.', ts,
});

const mkEnv = (verdicts) => ({ REC_LOG: {
  get: async (k) => verdicts[k.replace('analysis:', '')] ?? null,
} });

{
  const rows = new Map([
    ['BUYER',  { row: mkRow('BUYER',  [laneB([cand('CALL'), cand('PUT')])]), rowSource: 'fetched', rowAgeMs: 0 }],
    ['SELLER', { row: mkRow('SELLER', [laneB([cand('CALL'), cand('PUT')])]), rowSource: 'fetched', rowAgeMs: 0 }],
    ['HOLDER', { row: mkRow('HOLDER', [laneB([cand('CALL'), cand('PUT')])]), rowSource: 'fetched', rowAgeMs: 0 }],
    ['NOVERD', { row: mkRow('NOVERD', [laneB([cand('CALL')])]),              rowSource: 'fetched', rowAgeMs: 0 }],
    ['STALEV', { row: mkRow('STALEV', [laneB([cand('CALL')])]),              rowSource: 'fetched', rowAgeMs: 0 }],
  ]);
  const env = mkEnv({
    BUYER:  verdictRec('BUY'),
    SELLER: verdictRec('SELL'),
    HOLDER: verdictRec('HOLD'),
    STALEV: verdictRec('BUY', Date.now() - 3 * 86_400_000),
  });
  const r = await M.top3Rank(env, [...rows.keys()], { rows, failures: [] }, TODAY);
  const bySym = Object.fromEntries(r.entries.map(e => [e.symbol, e]));
  const exc = Object.fromEntries(r.excluded.map(e => [e.symbol, e]));

  console.log(`     ranked: ${r.entries.map(e => `${e.rank}.${e.symbol}/${e.type}`).join(' ')}`);
  row('BUY picks a CALL',                    bySym.BUYER?.type, 'CALL');
  row('SELL picks a PUT',                    bySym.SELLER?.type, 'PUT');
  row('HOLD is excluded entirely',           !!bySym.HOLDER, false);
  row('  …with HOLD named as the reason',    /HOLD/.test(exc.HOLDER?.reason || ''), true);
  row('no verdict is excluded entirely',     !!bySym.NOVERD, false);
  row('  …at the verdict stage',             exc.NOVERD?.stage, 'verdict');
  row('a verdict from another PT day is excluded', !!bySym.STALEV, false);
  row('  …naming the day it belongs to',     /not \d{4}-\d{2}-\d{2}/.test(exc.STALEV?.reason || ''), true);
  row('directional tickers counted',         r.pool.tickersDirectional, 2);
  // BUYER and SELLER each price [CALL, PUT]; the other three never reach the candidate loop.
  row('wrong-direction candidates never enter the pool', r.pool.gateFunnel.direction, 2);
  row('4 candidates considered, only the 2 matching enter the pool', r.pool.candidatesConsidered, 4);
  row('pool holds only the matching direction', r.pool.candidatesInPool, 2);
  row('the verdict rides on the entry',      bySym.BUYER?.verdict?.rating, 'BUY');
  row('  …with its as-of',                   Number.isFinite(bySym.BUYER?.verdict?.asOf), true);
  row('  …and its record era',               bySym.BUYER?.verdict?.era, 'canonical');
  row('row provenance rides too',            bySym.BUYER?.rowSource, 'fetched');
}
{
  // ONE SLOT PER TICKER: four gated-in candidates on one name, three tickers.
  const many = [laneB([cand('CALL', { pBe: 0.30 }), cand('CALL', { pBe: 0.45 })]),
                laneC([cand('CALL', { pBe: 0.20, lane: 'C', longStrike: 100, shortStrike: 110, width: 10 }),
                       cand('CALL', { pBe: 0.25, lane: 'C', longStrike: 100, shortStrike: 120, width: 20 })])];
  const rows = new Map();
  for (const sym of ['AAA', 'BBB', 'CCC', 'DDD']) {
    rows.set(sym, { row: mkRow(sym, many), rowSource: 'fetched', rowAgeMs: 0 });
  }
  const env = mkEnv(Object.fromEntries(['AAA', 'BBB', 'CCC', 'DDD'].map(s => [s, verdictRec('BUY')])));
  const r = await M.top3Rank(env, ['AAA', 'BBB', 'CCC', 'DDD'], { rows, failures: [] }, TODAY);
  console.log(`     ${r.pool.candidatesGatedIn} candidates gated in across `
    + `${r.pool.tickersQualified} tickers -> ${r.entries.length} published`);
  row('16 candidates gated in',              r.pool.candidatesGatedIn, 16);
  row('4 tickers qualified',                 r.pool.tickersQualified, 4);
  row('only TOP3_MAX published',             r.entries.length, M.TOP3_MAX);
  row('no ticker appears twice',             new Set(r.entries.map(e => e.symbol)).size, r.entries.length);
  row('each entry is that ticker\'s BEST candidate (pBe 0.45)',
      r.entries.every(e => e.pBe === 0.45), true);
  row('ranks are 1..3 in order',             r.entries.map(e => e.rank).join(','), '1,2,3');
  row('scores are non-increasing',
      r.entries.every((e, i) => i === 0 || e.score <= r.entries[i - 1].score), true);
  row('the 4th qualifier is recorded as excluded',
      r.excluded.filter(e => e.stage === 'rank').length, 1);
  row('  …with its score, so the cut is auditable',
      Number.isFinite(r.excluded.find(e => e.stage === 'rank')?.score), true);
  // Determinism: identical inputs, identical order.
  const again = await M.top3Rank(env, ['AAA', 'BBB', 'CCC', 'DDD'], { rows, failures: [] }, TODAY);
  row('tie-break is deterministic across runs',
      again.entries.map(e => e.symbol).join(','), r.entries.map(e => e.symbol).join(','));
  row('  …and it is alphabetical on a pure tie',
      r.entries.map(e => e.symbol).join(','), 'AAA,BBB,CCC');
}
{
  // Lane A / D / E / F candidates must never enter the pool.
  const rows = new Map([['XXX', { row: mkRow('XXX', [laneA([cand('CALL')]),
                                                     { lane: 'F', expiry: '2026-10-16', dte: 52,
                                                       candidates: [cand('CALL')] }]),
                                  rowSource: 'fetched', rowAgeMs: 0 }]]);
  const r = await M.top3Rank(mkEnv({ XXX: verdictRec('BUY') }), ['XXX'],
                             { rows, failures: [] }, TODAY);
  row('Lane A and Lane F are not even considered', r.pool.candidatesConsidered, 0);
  row('nothing published from them',              r.entries.length, 0);
  row('the ticker is excluded at the gates stage', r.excluded[0]?.stage, 'gates');
}
{
  // ZERO qualifying is a published result, not a refusal.
  const rows = new Map([['ZZZ', { row: mkRow('ZZZ', [laneB([cand('CALL', { expectancyEpisodesTo50: 1 })])],
                                             { buyable: false, buyableReason: 'IVR 71 — above 40' }),
                                  rowSource: 'fetched', rowAgeMs: 0 }]]);
  const r = await M.top3Rank(mkEnv({ ZZZ: verdictRec('BUY') }), ['ZZZ'], { rows, failures: [] }, TODAY);
  row('zero qualifying yields [] — an ARRAY, not null', Array.isArray(r.entries), true);
  row('  …of length 0',                                 r.entries.length, 0);
  row('  …with the gate that did it recorded',          r.pool.gateFunnel.vol, 1);
}
{
  // A failed ticker is excluded by NAME, carrying the error the sweep recorded.
  const rows = new Map();
  const r = await M.top3Rank(mkEnv({}), ['GONE'],
                             { rows, failures: [{ symbol: 'GONE', error: 'yahoo 429', via: 'threw' }] },
                             TODAY);
  row('a swept-failure ticker is excluded by name', r.excluded[0]?.symbol, 'GONE');
  row('  …carrying the error text',                 /yahoo 429/.test(r.excluded[0]?.reason || ''), true);
}
{
  // A row from an earlier PT day cannot ride in under today's key.
  const rows = new Map([['OLD', { row: mkRow('OLD', [laneB([cand('CALL')])],
                                             { ts: Date.parse('2020-01-02T18:00:00Z') }),
                                  rowSource: 'reused', rowAgeMs: 9e9 }]]);
  const r = await M.top3Rank(mkEnv({ OLD: verdictRec('BUY') }), ['OLD'], { rows, failures: [] }, TODAY);
  row('a row from another PT day is excluded', r.entries.length, 0);
  row('  …at the row stage',                   r.excluded[0]?.stage, 'row');
  row('  …and tickersWithTodayRow stays 0',    r.pool.tickersWithTodayRow, 0);
}
{
  // The excluded list is capped and SAYS SO rather than silently truncating.
  const rows = new Map();
  const syms = [];
  for (let i = 0; i < M.TOP3_MAX_EXCLUDED + 5; i++) {
    const s = `T${String(i).padStart(3, '0')}`;
    syms.push(s);
    rows.set(s, { row: mkRow(s, [laneB([cand('CALL')])]), rowSource: 'fetched', rowAgeMs: 0 });
  }
  const r = await M.top3Rank(mkEnv(Object.fromEntries(syms.map(s => [s, verdictRec('HOLD')]))),
                             syms, { rows, failures: [] }, TODAY);
  if (populated('excluded cap', r.excludedTotal)) {
    row('stored excluded[] is capped',        r.excluded.length, M.TOP3_MAX_EXCLUDED);
    row('  …and the true total is reported',  r.excludedTotal, M.TOP3_MAX_EXCLUDED + 5);
    row('  …and truncation is declared',      r.excludedTruncated, true);
  }
}

/* ═══ 8. readTop3 — STRICT schema equality ══════════════════════════════════ */
console.log('\n§8  readTop3 — strict schema equality, and the three ways it returns null');

const envWith = (val, throws = false) => ({ REC_LOG: {
  get: async () => { if (throws) throw new Error('kv down'); return val; },
} });
const GOOD = { schema: M.TOP3_SCHEMA, ptDate: TODAY, entries: [] };
row('schema 1 record is returned',        (await M.readTop3(envWith(GOOD)))?.ptDate, TODAY);
row('schema 99 reads as ABSENT',          await M.readTop3(envWith({ ...GOOD, schema: 99 })), null);
row('schema 0 reads as ABSENT',           await M.readTop3(envWith({ ...GOOD, schema: 0 })), null);
row('a missing schema reads as ABSENT',   await M.readTop3(envWith({ ptDate: TODAY })), null);
row('no record reads as null',            await M.readTop3(envWith(null)), null);
row('a KV throw reads as null, not a crash', await M.readTop3(envWith(GOOD, true)), null);
row('no binding at all reads as null',    await M.readTop3({}), null);

/* ═══ 9. WHAT `gates` SHIPS ═════════════════════════════════════════════════ */
console.log('\n§9  the declared gates — a consumer is told not to hardcode, so they must be there');

const G = M.top3GatesDeclared();
row('schema declared',            G.schema, M.TOP3_SCHEMA);
row('max declared',               G.max, M.TOP3_MAX);
row('lanes declared',             G.lanes.join(','), 'B,C');
row('weights declared',           j(G.weights), j(M.TOP3_WEIGHTS));
row('anchors declared',           j(G.anchors), j(M.TOP3_ANCHORS));
row('weight total declared',      G.weightTotal, 100);
row('liquidity floors declared',  `${G.liquidity.spreadMaxNear}/${G.liquidity.spreadMaxLeaps}/${G.liquidity.minOi}`,
    `0.15/0.3/${M.LONG_MIN_OI}`);
row('vol thresholds declared',    `${G.vol.ivrBuyMax}/${G.vol.ratioBuyMax}`,
    `${M.IVR_BUY_MAX}/${M.RATIO_BUY_MAX}`);
row('episode floor declared',     G.episodes.minEpisodesTo50, M.TOP3_MIN_EPISODES_TO_50);
row('required inputs declared',   G.inputs.required.join(','), M.TOP3_SCORE_INPUTS.join(','));
row('the score formula is stated', /100 x SUM/.test(G.scoreFormula), true);
row('the tie-break is stated',     /score desc/.test(G.tieBreak), true);
row('one-slot-per-ticker is stated', /ONE slot per ticker/.test(G.slotRule), true);
row('the reuse window is stated',  G.longFreshMs, M.LONG_FRESH_MS);
row('the null-is-not-a-failure rule is stated', /null = still collecting/.test(G.vol.rule), true);

process.exit(reportVerdict({
  label: 'top3 daily options ranking',
  comparisons: t.comparisons,
  failures: t.failures,
  minComparisons: 130,
}));
