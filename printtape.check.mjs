/* Print vs tape — `printtape:{TICKER}:{ET-REPORT-DATE}`.
 *
 * WHY THIS EXISTS. The whole feature turns on one comparison being refused: an
 * EPS actual and an EPS consensus that belong to DIFFERENT quarters must never
 * be divided into a surprise percentage. Measured 2026-09-01 at 20:42 UTC — 42
 * minutes after PANW, DELL and MDB all reported after the close — Yahoo was
 * publishing the CONSENSUS for the quarter ending 2026-07-31 and, in
 * `earningsHistory` / `earningsChart`, the ACTUAL for the quarter ending
 * 2026-04-30. Taking the newest of each would have printed PANW at
 * EPS 0.85 vs 0.97745 = a confident 13% MISS that never happened, and every
 * number downstream of it — the divergence flag included — would have looked
 * completely ordinary.
 *
 * §5 drives that exact pair from a REAL captured fixture and asserts the
 * refusal, and §5f drives the failing direction by removing the alignment gate
 * from a copy of the function and showing the phantom miss appear. A check that
 * cannot fail proves nothing.
 *
 * Sections:
 *   1. Constants, and the KEY-SHAPE PREFIX DISJOINTNESS asserted in BOTH
 *      directions — `printtapeday:` must not be reachable from a
 *      `list({prefix:'printtape:'})`, the `ivsweep:last`-outside-`iv:` rule.
 *   2. `printTapeReportDate` — including the midnight-UTC placeholder, which is
 *      the one shape where a UTC reading and an ET reading differ by a day.
 *   3. `printTapePassAt` — every window, every non-firing boundary, exactly-one-
 *      firing-per-pass, and the UTC hour range in BOTH DST regimes (rule #2).
 *   4. `printTapeSurprise` — the null-before-arithmetic guard.
 *   5. `printTapePrintFrom` — the roll test, the alignment gate, and both
 *      directions of the fabricated-surprise failure.
 *   6. `printTapeTapeFrom` — both windows against the REAL reference closes,
 *      the staleness refusal, and the unconditional volume refusal.
 *   7. `printTapeImpliedFrom` — and that it never calls itself an earnings move.
 *   8. `printTapeDivergence` — `null` is a REFUSAL and is not `false`; the
 *      threshold driven at, side of, and past the boundary.
 *   9. `mergePrintTapeRecord` — field-level carry-forward, and the quarter
 *      mismatch that must refuse to merge.
 *  10. THE ENDPOINT through the REAL router: the gate, the date validation, an
 *      absent day distinguished from an empty one, and the skipped/measured
 *      reconciliation.
 *  11. STRUCTURAL — guidance may only be reached from `divergent === true`; the
 *      verdict must be RE-RUN after the merge (a refusal computed pre-merge
 *      outlived its own cause and made guidance unreachable); and the read path
 *      must contain no write. No behavioural test can see any of those change.
 *
 * BLIND SPOTS, stated up front:
 *   · Nothing here calls Yahoo, so it cannot tell you the modules still carry
 *     the fields §5 and §6 parse. The live probe behind those fixtures is in
 *     CLAUDE.md; re-run it if the shapes are ever suspected of moving.
 *   · It cannot measure the real per-pass capCost. The `ceil(N/20) + 4E + 4`
 *     figure is a DERIVATION from the structure, and §1 asserts only the
 *     constants that go into it. It WAS measured on the replay harness (17 at
 *     N=6/E=3 cold crumb, 5 at E=0); that run is not part of this script.
 *   · It cannot exercise the Claude guidance call. §11 pins the one thing that
 *     matters about it — that it is unreachable unless `divergent === true`.
 *
 * Run:  node printtape.check.mjs
 */
import fs from 'fs';
import { tally, record, reportVerdict, populated } from './check-harness.mjs';

/* Importing the real module is ALSO the ES-module parse `node --check` cannot
   perform — it parses worker.js as CommonJS, where a duplicate binding in one
   scope is not an error. That gap has produced a clean exit 0 on a file workerd
   refused to boot. */
import worker from './worker.js';

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
/* Brace-matching, NOT scan-to-semicolon: PRINTTAPE_PASSES is an array of objects
   and the reason-strings elsewhere in this block contain semicolons. The
   mood.check.mjs lesson — a `[^;]+` grab truncates mid-value and the generated
   module then fails to parse, which reads as a missing constant rather than as a
   harness bug. */
function grabConst(name) {
  const key = '\nconst ' + name;
  let i = -1, from = 0;
  for (;;) {
    i = src.indexOf(key, from);
    if (i < 0) throw new Error('missing const ' + name);
    if (/[\s=]/.test(src[i + key.length])) break;
    from = i + 1;
  }
  const eq = src.indexOf('=', i + key.length);
  let k = eq + 1;
  while (/\s/.test(src[k])) k++;
  if (src[k] === '[' || src[k] === '{') {
    const open = src[k], close = open === '[' ? ']' : '}';
    let d = 0;
    do { if (src[k] === open) d++; else if (src[k] === close) d--; k++; } while (d > 0);
    return src.slice(i + 1, src.indexOf(';', k) + 1);
  }
  return src.slice(i + 1, src.indexOf(';', i + key.length) + 1);
}

const M = new Function([
  grabConst('PRINTTAPE_SCHEMA'), grabConst('PRINTTAPE_TTL'), grabConst('PRINTTAPE_DIVERGENCE_PCT'),
  grabConst('PRINTTAPE_QUOTE_CHUNK'), grabConst('PRINTTAPE_SWEEP_CAP'),
  grabConst('PRINTTAPE_GUIDANCE_CLASSES'),
  grabConst('printTapeKey'), grabConst('printTapeDayKey'), grabConst('PRINTTAPE_PASSES'),
  grabConst('LONG_SCHEMA'),
  grab('printTapePassAt'), grabConst('printTapeReportDate'), grabConst('ptNum'),
  grab('printTapeSurprise'), grab('printTapePrintFrom'), grab('printTapeTapeFrom'),
  grab('printTapeImpliedFrom'), grab('printTapeDivergence'),
  grab('mergePrintTapeRecord'), grab('printTapeComplete'),
  `return { PRINTTAPE_SCHEMA, PRINTTAPE_TTL, PRINTTAPE_DIVERGENCE_PCT, PRINTTAPE_QUOTE_CHUNK,
            PRINTTAPE_SWEEP_CAP, PRINTTAPE_GUIDANCE_CLASSES, printTapeKey, printTapeDayKey,
            PRINTTAPE_PASSES, printTapePassAt, printTapeReportDate, printTapeSurprise,
            printTapePrintFrom, printTapeTapeFrom, printTapeImpliedFrom, printTapeDivergence,
            mergePrintTapeRecord, printTapeComplete };`,
].join('\n'))();

const t = tally();
const pad = (s, n) => String(s).padEnd(n);
const j = v => JSON.stringify(v);
function row(label, got, want, ok = j(got) === j(want)) {
  record(t, ok);
  console.log(`  ${pad(label, 62)} got ${pad(j(got), 34)} want ${pad(j(want), 26)} ${ok ? 'ok' : '<<< MISMATCH'}`);
}

/* ════════════════════════════════════════════════════════════════════════════
   REAL FIXTURES, captured from the live Yahoo v10 response 2026-09-01 20:42 UTC.
   The numbers are transcribed exactly as measured; nothing here is invented.
   ════════════════════════════════════════════════════════════════════════════ */

// PANW, 42 minutes after reporting AMC on 2026-09-01. Consensus is for the
// quarter ending 2026-07-31; the newest ACTUAL is still the quarter ending
// 2026-04-30, reported 2026-06-02. THE PAIR THAT WOULD FABRICATE A MISS.
const PANW_AT_PRINT = {
  earningsTrend: { trend: [
    { period: '0q', endDate: '2026-07-31',
      earningsEstimate: { avg: { raw: 0.97745 } }, revenueEstimate: { avg: { raw: 3351856080 } } },
    { period: '+1q', endDate: '2026-10-31',
      earningsEstimate: { avg: { raw: 1.10 } }, revenueEstimate: { avg: { raw: 3500000000 } } },
  ] },
  calendarEvents: { earnings: {
    earningsDate: [{ raw: 1788292800, fmt: '2026-09-01' }],
    earningsAverage: { raw: 0.97745 }, revenueAverage: { raw: 3351856080 },
  } },
  earnings: {
    earningsChart: { quarterly: [
      { date: '1Q2026', actual: { raw: 0.85 }, estimate: { raw: 0.7972 }, surprisePct: '6.62',
        periodEndDate: { fmt: '2026-04-30' }, reportedDate: { fmt: '2026-06-02' } },
    ] },
    financialsChart: { quarterly: [{ date: '1Q2026', revenue: { raw: 3002000000 } }] },
  },
  price: {
    marketState: 'POST',
    regularMarketPrice: { raw: 362.09 }, regularMarketPreviousClose: { raw: 382.13 },
    postMarketPrice: { raw: 363.99 }, postMarketChange: { raw: 1.8999939 },
    postMarketChangePercent: { raw: 0.005247297 }, postMarketTime: 1788295373,
    preMarketPrice: { raw: 373.7 }, preMarketChangePercent: { raw: -0.022060536 },
    preMarketTime: 1788269399,
  },
};

// NVDA six days after reporting on 2026-08-26. The consensus has ROLLED to the
// quarter ending 2026-10-31; the actual for 2026-07-31 IS published, and its
// own EPS estimate survives on the entry while the revenue estimate does not.
const NVDA_ROLLED = {
  earningsTrend: { trend: [
    { period: '0q', endDate: '2026-10-31',
      earningsEstimate: { avg: { raw: 2.46983 } }, revenueEstimate: { avg: { raw: 108972821930 } } },
  ] },
  calendarEvents: { earnings: {
    earningsAverage: { raw: 2.46983 }, revenueAverage: { raw: 108972821930 },
  } },
  earnings: {
    earningsChart: { quarterly: [
      { date: '1Q2026', actual: { raw: 1.87 }, estimate: { raw: 1.77191 }, surprisePct: '5.54',
        periodEndDate: { fmt: '2026-04-30' }, reportedDate: { fmt: '2026-05-20' } },
      { date: '2Q2026', actual: { raw: 2.22 }, estimate: { raw: 2.09113 }, surprisePct: '6.16',
        periodEndDate: { fmt: '2026-07-31' }, reportedDate: { fmt: '2026-08-26' } },
    ] },
    // financialsChart LAGS: no 2Q2026 entry six days on. Measured, not assumed.
    financialsChart: { quarterly: [
      { date: '4Q2025', revenue: { raw: 68127000000 } },
      { date: '1Q2026', revenue: { raw: 81615000000 } },
    ] },
  },
  price: {},
};

// A synthetic FULL print — consensus current AND actual ingested for the same
// quarter. Constructed by moving PANW's own actual onto its consensus quarter,
// which is the state the second pass exists to reach.
const FULL = JSON.parse(JSON.stringify(PANW_AT_PRINT));
FULL.earnings.earningsChart.quarterly = [{
  date: '2Q2026', actual: { raw: 1.05 }, estimate: { raw: 0.97745 }, surprisePct: '7.42',
  periodEndDate: { fmt: '2026-07-31' }, reportedDate: { fmt: '2026-09-01' },
}];
FULL.earnings.financialsChart.quarterly = [{ date: '2Q2026', revenue: { raw: 3450000000 } }];

console.log('\n== 1. CONSTANTS AND THE KEY SHAPE ==========================================\n');
{
  row('1a PRINTTAPE_SCHEMA', M.PRINTTAPE_SCHEMA, 1);
  row('1a PRINTTAPE_TTL is 7d in seconds', M.PRINTTAPE_TTL, 7 * 24 * 3600);
  row('1a PRINTTAPE_DIVERGENCE_PCT', M.PRINTTAPE_DIVERGENCE_PCT, -3.0);
  row('1a it is NEGATIVE (a fall, not a rise)', M.PRINTTAPE_DIVERGENCE_PCT < 0, true);
  row('1a quote chunk matches yahooSparkCloses ceiling', M.PRINTTAPE_QUOTE_CHUNK, 20);
  row('1a sweep cap matches sweepUniverse default', M.PRINTTAPE_SWEEP_CAP, 60);
  row('1a guidance classes', M.PRINTTAPE_GUIDANCE_CLASSES, ['raised', 'held', 'cut', 'not-found']);

  const rk = M.printTapeKey('panw', '2026-09-01');
  row('1b record key shape', rk, 'printtape:PANW:2026-09-01');
  row('1b ticker is upper-cased', M.printTapeKey('mdb', '2026-09-01'), 'printtape:MDB:2026-09-01');
  const dk = M.printTapeDayKey('2026-09-01');
  row('1b day-index key shape', dk, 'printtapeday:2026-09-01');

  /* THE PREFIX DISJOINTNESS, BOTH DIRECTIONS. A one-directional assertion would
     pass on a scheme where one key is a prefix of the other. */
  row('1c day index is NOT under the record prefix', dk.startsWith('printtape:'), false);
  row('1c record is NOT under the day-index prefix', rk.startsWith('printtapeday:'), false);
  row('1c the two prefixes diverge at index 9', ['printtape:'[9], 'printtapeday:'[9]], [':', 'd']);
  /* And against the prefixes that already exist in this KV namespace. */
  for (const p of ['iv:', 'long:', 'longarch:', 'moves:', 'top3:', 'income:', 'incomerow:', 'rec:', 'daily:']) {
    row(`1c record key not under existing prefix ${p}`, rk.startsWith(p), false);
  }
}

console.log('\n== 2. THE REPORT DATE — the UTC calendar date, and why ======================\n');
{
  row('2a AMC anchor 20:00Z', M.printTapeReportDate('2026-09-01T20:00:00.000Z'), '2026-09-01');
  row('2a BMO anchor 12:30Z', M.printTapeReportDate('2026-10-15T12:30:00.000Z'), '2026-10-15');
  /* THE ONE SHAPE WHERE UTC AND ET DISAGREE BY A DAY. Midnight UTC read in ET is
     19:00/20:00 the PREVIOUS day, so an ET reading files the row under yesterday
     and nothing ever looks for it there. `earningsTimingFrom` separately refuses
     to read a SESSION out of this instant; the two facts are independent. */
  const placeholder = '2026-09-01T00:00:00.000Z';
  row('2b placeholder files under the day Yahoo meant', M.printTapeReportDate(placeholder), '2026-09-01');
  const etOfPlaceholder = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
    .format(new Date(placeholder));
  row('2b an ET reading would have filed it under', etOfPlaceholder, '2026-08-31');
  row('2b so the two DO differ, by one day', M.printTapeReportDate(placeholder) !== etOfPlaceholder, true);
  /* ...and for both real anchors they do NOT differ, which is why UTC is safe. */
  for (const iso of ['2026-09-01T20:00:00.000Z', '2026-10-15T12:30:00.000Z', '2027-01-06T20:00:00.000Z']) {
    const et = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso));
    row(`2b anchor ${iso.slice(11, 16)}Z agrees with ET`, M.printTapeReportDate(iso), et);
  }
  row('2c a null timestamp yields null', M.printTapeReportDate(null), null);
}

console.log('\n== 3. THE FOUR PASSES — windows, boundaries, and rule #2 ====================\n');
{
  row('3a there are exactly four passes', M.PRINTTAPE_PASSES.length, 4);
  row('3a sessions', M.PRINTTAPE_PASSES.map(p => `${p.session}${p.pass}`), ['bmo1', 'bmo2', 'amc1', 'amc2']);

  const at = (h, m) => { const p = M.printTapePassAt(h, m); return p ? `${p.session}-pass${p.pass}` : null; };
  row('3b 05:30 PT', at(5, 30), 'bmo-pass1');
  row('3b 06:15 PT', at(6, 15), 'bmo-pass2');
  row('3b 13:30 PT', at(13, 30), 'amc-pass1');
  row('3b 14:30 PT', at(14, 30), 'amc-pass2');

  /* NON-FIRING BOUNDARIES. A window that fired one tick early or late would
     double-run or miss, and neither announces itself. */
  for (const [h, m] of [[5, 15], [5, 45], [6, 0], [6, 30], [13, 15], [13, 45], [14, 0], [14, 15], [14, 45], [7, 30]]) {
    row(`3b ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} PT is NOT a pass`, at(h, m), null);
  }

  /* EXACTLY ONE FIRING PER PASS. The trigger is every 15 minutes, so a window
     wider than 15 would double-run the same pass on one day. */
  for (const p of M.PRINTTAPE_PASSES) {
    const fires = [0, 15, 30, 45].filter(m => m >= p.m0 && m < p.m1);
    row(`3c ${p.session}-pass${p.pass} admits exactly one firing`, fires.length, 1);
  }
  /* And no two passes claim the same instant. */
  const claimed = [];
  for (let h = 0; h < 24; h++) for (const m of [0, 15, 30, 45]) if (M.printTapePassAt(h, m)) claimed.push(`${h}:${m}`);
  row('3c total firings claimed across the day', claimed.length, 4);

  /* RULE #2 — every pass hour inside the trigger's UTC window in BOTH regimes,
     with the window READ FROM wrangler.toml rather than restated here. */
  const toml = fs.readFileSync('wrangler.toml', 'utf8');
  const expr = (toml.match(/crons = \["([^"]+)"\]/) || [])[1] || '';
  const parts = expr.split(/\s+/);
  row('3d cron expression', expr, expr);
  row('3d no day-of-week / day-of-month / month', [parts[2], parts[3], parts[4]], ['*', '*', '*']);
  const hm = (parts[1] || '').match(/^(\d+)-(\d+)$/);
  const [lo, hi] = hm ? [Number(hm[1]), Number(hm[2])] : [NaN, NaN];
  row('3d hour field is a UTC range', !!hm, true);
  const utcH = (iso) => new Date(Date.parse(iso)).getUTCHours();
  for (const p of M.PRINTTAPE_PASSES) {
    const s = String(p.h).padStart(2, '0') + ':' + String(p.m0).padStart(2, '0');
    const pdt = utcH(`2026-09-02T${s}:00-07:00`);
    const pst = utcH(`2027-01-06T${s}:00-08:00`);
    row(`3d ${p.session}-pass${p.pass} ${s} PT -> UTC [PDT,PST]`, [pdt, pst], [pdt, pst]);
    row(`3d   ...both inside ${lo}-${hi}`, pdt >= lo && pdt <= hi && pst >= lo && pst <= hi, true);
  }
  /* THE ONE THAT FORCED THE WIDENING, stated as a comparison rather than a
     comment: 05:30 PT under PDT is 12:30 UTC, which the OLD 13-22 did not cover. */
  row('3e 05:30 PT under PDT, in UTC hours', utcH('2026-09-02T05:30:00-07:00'), 12);
  row('3e the OLD 13-22 window would have missed it', 12 >= 13 && 12 <= 22, false);
  row('3e the CURRENT window covers it', 12 >= lo && 12 <= hi, true);
}

console.log('\n== 4. SURPRISE — the null guard, BEFORE the arithmetic ======================\n');
{
  row('4a a real beat', M.printTapeSurprise(1.05, 0.97745), 7.42);
  row('4a a real miss', M.printTapeSurprise(0.90, 1.00), -10);
  row('4a exactly inline', M.printTapeSurprise(1.00, 1.00), 0);
  /* `x == null` and `x === 0` must never render the same way. `(null-est)/est`
     would be a number, and a missing measurement would ship as a real one. */
  row('4b null actual refuses', M.printTapeSurprise(null, 1.0), null);
  row('4b null estimate refuses', M.printTapeSurprise(1.0, null), null);
  row('4b both null refuses', M.printTapeSurprise(null, null), null);
  row('4b undefined refuses', M.printTapeSurprise(undefined, 1.0), null);
  row('4b NaN refuses', M.printTapeSurprise(NaN, 1.0), null);
  row('4c a ZERO consensus refuses rather than dividing', M.printTapeSurprise(1.0, 0), null);
  /* A NEGATIVE consensus still divides, on |est| — a loss narrowing from -1.00
     to -0.50 is a +50% surprise, not -50%. */
  row('4d negative consensus uses |est|', M.printTapeSurprise(-0.50, -1.00), 50);
}

console.log('\n== 5. THE PRINT — the roll test and the ALIGNMENT GATE ======================\n');
{
  // ── 5a. PANW at the print: consensus current, actual is the PRIOR quarter ──
  const p = M.printTapePrintFrom(PANW_AT_PRINT, '2026-09-01');
  row('5a quarter is taken from the CONSENSUS', p.quarter, '2026-07-31');
  row('5a epsEst is published', p.epsEst, 0.97745);
  row('5a revEst is published', p.revEst, 3351856080);
  /* THE WHOLE POINT. */
  row('5a epsActual is REFUSED (wrong quarter)', p.epsActual, null);
  row('5a revActual is REFUSED (wrong quarter)', p.revActual, null);
  row('5a epsSurprisePct is null, not fabricated', p.epsSurprisePct, null);
  row('5a revSurprisePct is null, not fabricated', p.revSurprisePct, null);
  row('5a the EPS refusal names the quarter it found', /2026-04-30/.test(p.eps?.reason || ''), true);
  row('5a the refusal is a status, not a silent null', p.eps?.status, 'not-published');
  /* And the number that WOULD have been printed, so the size of the averted
     error is on the record rather than asserted. */
  const phantom = M.printTapeSurprise(0.85, 0.97745);
  row('5a the phantom miss this refuses', phantom, -13.04);
  row('5a Yahoo cross-check is withheld too', p.epsSurpriseYahoo, null);
  row('5a consensus cross-check agrees', p.consensusCrosscheck?.agrees, true);

  // ── 5b. NVDA rolled: actual aligned, EPS est survives, revenue est does NOT ──
  const n = M.printTapePrintFrom(NVDA_ROLLED, '2026-08-26');
  row('5b quarter comes from the ACTUAL once consensus rolled', n.quarter, '2026-07-31');
  row('5b quarterVia says the consensus rolled', /rolled/.test(n.quarterVia || ''), true);
  row('5b epsActual is published', n.epsActual, 2.22);
  row('5b epsEst survives on the entry', n.epsEst, 2.09113);
  row('5b epsEstVia names the entry, not 0q', /earningsChart/.test(n.epsEstVia || ''), true);
  row('5b epsSurprisePct is computed', n.epsSurprisePct, 6.16);
  row('5b ...and agrees with Yahoo\'s own figure', n.epsSurpriseAgrees, true);
  /* The rolled 0q must NOT be borrowed as this quarter's consensus. */
  row('5b epsEst is NOT the rolled 0q value', n.epsEst === 2.46983, false);
  row('5b revEst is REFUSED (rolled away)', n.revEst, null);
  row('5b revActual is REFUSED (financialsChart lags)', n.revActual, null);
  row('5b the revenue refusal explains the roll', /no longer published/.test(n.revenue?.reason || ''), true);
  row('5b ...and that it can only be banked earlier', /first pass/.test(n.revenue?.reason || ''), true);

  // ── 5c. The complete state the second pass exists to reach ──
  const f = M.printTapePrintFrom(FULL, '2026-09-01');
  row('5c quarter', f.quarter, '2026-07-31');
  row('5c epsActual / epsEst', [f.epsActual, f.epsEst], [1.05, 0.97745]);
  row('5c revActual / revEst', [f.revActual, f.revEst], [3450000000, 3351856080]);
  row('5c epsSurprisePct', f.epsSurprisePct, 7.42);
  row('5c revSurprisePct', f.revSurprisePct, 2.93);
  row('5c no eps refusal object', f.eps, undefined);
  row('5c no revenue refusal object', f.revenue, undefined);

  // ── 5d. Nothing usable at all ──
  const empty = M.printTapePrintFrom({}, '2026-09-01');
  row('5d empty payload refuses the whole block', empty.status, 'not-published');
  row('5d ...and says the quarter could not be established',
      /could not establish which quarter/.test(empty.reason || ''), true);

  // ── 5e. THE ROLL TEST IS AN INEQUALITY, driven at the boundary ──
  const rolledJustPast = JSON.parse(JSON.stringify(PANW_AT_PRINT));
  rolledJustPast.earningsTrend.trend[0].endDate = '2026-09-02';   // one day AFTER the report
  const rp = M.printTapePrintFrom(rolledJustPast, '2026-09-01');
  row('5e 0q one day AFTER the report reads as rolled', rp.status, 'not-published');
  const onTheDay = JSON.parse(JSON.stringify(PANW_AT_PRINT));
  onTheDay.earningsTrend.trend[0].endDate = '2026-09-01';         // EQUAL to the report date
  row('5e 0q EQUAL to the report date is still usable',
      M.printTapePrintFrom(onTheDay, '2026-09-01').quarter, '2026-09-01');

  // ── 5f. THE FAILING DIRECTION — remove the gate, watch the phantom appear ──
  /* A check that cannot fail proves nothing. This rebuilds the function with the
     alignment equality forced TRUE, which is precisely the bug, and shows the
     -13.04% miss materialise on the same fixture §5a refuses. */
  let mutated = grab('printTapePrintFrom')
    .replace('const actAligned = actQuarter != null && actQuarter === quarter;',
             'const actAligned = actQuarter != null;');
  row('5f the mutation applied', mutated.includes('const actAligned = actQuarter != null;'), true);
  const BAD = new Function([grabConst('ptNum'), grab('printTapeSurprise'), mutated,
                            'return printTapePrintFrom;'].join('\n'))();
  const bad = BAD(PANW_AT_PRINT, '2026-09-01');
  row('5f WITHOUT the gate, epsActual leaks in', bad.epsActual, 0.85);
  row('5f WITHOUT the gate, a MISS is fabricated', bad.epsSurprisePct, -13.04);
  row('5f WITH the gate (the shipped code), it is null', p.epsSurprisePct, null);
  row('5f so the gate is load-bearing, not decorative',
      bad.epsSurprisePct !== p.epsSurprisePct, true);
}

console.log('\n== 6. THE TAPE — both windows, staleness, and the volume refusal ============\n');
{
  const AMC_TS = '2026-09-01T20:00:00.000Z';
  const post = M.printTapeTapeFrom(PANW_AT_PRINT.price, 'amc', AMC_TS);
  row('6a window', post.window, 'post');
  row('6a price', post.price, 363.99);
  /* Yahoo carries this as a DECIMAL FRACTION; the record carries PERCENT. The
     same units trap as `impliedVolatility`. */
  row('6a changePct is percent, not a fraction', post.changePct, 0.5247);
  row('6a reference close is TODAY\'s regular close', post.referenceClose, 362.09);
  row('6a ...named on the record', post.referenceCloseField, 'regularMarketPrice');
  /* Cross-check against Yahoo's own `postMarketChange`, a DIFFERENT derivation. */
  const derived = +((363.99 - 362.09) / 362.09 * 100).toFixed(4);
  row('6a agrees with price-minus-close', post.changePct, derived);
  row('6a quoteTime', post.quoteTime, '2026-09-01T20:42:53.000Z');

  const pre = M.printTapeTapeFrom(PANW_AT_PRINT.price, 'bmo', '2026-09-01T12:30:00.000Z');
  row('6b window', pre.window, 'pre');
  row('6b price', pre.price, 373.7);
  row('6b changePct', pre.changePct, -2.2061);
  /* THE OTHER CLOSE. A pre-market move is against YESTERDAY's close, and using
     today's would be the sign-inversion class of error. */
  row('6b reference close is YESTERDAY\'s close', pre.referenceClose, 382.13);
  row('6b ...named on the record', pre.referenceCloseField, 'regularMarketPreviousClose');
  const preDerived = +((373.7 - 382.13) / 382.13 * 100).toFixed(4);
  row('6b agrees with price-minus-prev-close', pre.changePct, preDerived);

  // ── 6c. Staleness — a quote from before the print is not this print's reaction ──
  const stale = M.printTapeTapeFrom(PANW_AT_PRINT.price, 'bmo', '2026-09-01T20:00:00.000Z');
  row('6c a pre-market quote stamped before the print refuses', stale.status, 'unavailable');
  row('6c ...and names both timestamps',
      /13:29:59/.test(stale.reason || '') && /20:00:00/.test(stale.reason || ''), true);
  /* The boundary: a quote at EXACTLY the report instant is not stale. */
  const exact = M.printTapeTapeFrom(
    { ...PANW_AT_PRINT.price, postMarketTime: Date.parse(AMC_TS) / 1000 }, 'amc', AMC_TS);
  row('6c a quote AT the report instant is accepted', exact.status, undefined);
  const oneSecEarly = M.printTapeTapeFrom(
    { ...PANW_AT_PRINT.price, postMarketTime: Date.parse(AMC_TS) / 1000 - 1 }, 'amc', AMC_TS);
  row('6c one second earlier is refused', oneSecEarly.status, 'unavailable');

  // ── 6d. Absent fields, and an unknown session ──
  row('6d no extended-hours quote refuses', M.printTapeTapeFrom({}, 'amc', AMC_TS).status, 'unavailable');
  const unk = M.printTapeTapeFrom(PANW_AT_PRINT.price, 'unknown', AMC_TS);
  row('6d unknown session refuses', unk.status, 'unavailable');
  row('6d ...because no window can be identified', /neither the pre-market nor the post-market/.test(unk.reason || ''), true);

  // ── 6e. VOLUME IS REFUSED UNCONDITIONALLY, and that is the measurement ──
  row('6e volume is null on a good post reading', post.volume, null);
  row('6e volume is null on a good pre reading', pre.volume, null);
  row('6e the refusal is a named status', post.volumeStatus, 'not-published');
  row('6e ...carrying the measurement behind it', /2026-09-01/.test(post.volumeReason || ''), true);
  row('6e ...and saying it is deliberately not summed', /Not summed/.test(post.volumeReason || ''), true);
  /* The refusal must cost NOTHING — there is no point spending a subrequest to
     refuse, so the tape must be derivable from the price module alone. */
  row('6e the tape needs only the price module',
      grab('printTapeTapeFrom').includes('fetch('), false);
}

console.log('\n== 7. THE IMPLIED MOVE — and what it is careful NOT to claim ================\n');
{
  const ROW = { symbol: 'PANW', schema: 4, ts: Date.parse('2026-09-01T20:17:58.784Z'),
                expectedMove: { pct: 10.53, dollars: 38.94, dte: 8, expiry: '2026-09-09' } };
  const im = M.printTapeImpliedFrom(ROW, '2026-09-01');
  row('7a movePct', im.movePct, 10.53);
  row('7a expiry and dte ride along', [im.expiry, im.dte], ['2026-09-09', 8]);
  row('7a asOf is the ROW\'s ts, not now', im.asOf, '2026-09-01T20:17:58.784Z');
  row('7a the expiry straddles the report', im.straddlesReport, true);
  /* The label is the point. Calling a front-expiry move "the implied earnings
     move" is the HV30-labelled-as-IV failure — a real number under a name that
     belongs to a different quantity. */
  row('7b basis says NOT earnings-isolated', /NOT an\s+earnings-isolated move/.test(im.basis), true);
  row('7b basis names the formula', /sqrt\(dte\/365\)/.test(im.basis), true);
  row('7b nothing calls it an earnings move', /implied earnings move/i.test(j(im)), false);

  const before = M.printTapeImpliedFrom(
    { ...ROW, expectedMove: { ...ROW.expectedMove, expiry: '2026-08-28' } }, '2026-09-01');
  row('7c an expiry BEFORE the report is flagged', before.straddlesReport, false);

  row('7d no row refuses', M.printTapeImpliedFrom(null, '2026-09-01').status, 'not-computed');
  row('7d ...naming LONG_SCHEMA', /LONG_SCHEMA 4/.test(M.printTapeImpliedFrom(null, '2026-09-01').reason), true);
  row('7d a row with no expectedMove refuses',
      M.printTapeImpliedFrom({ symbol: 'X', ts: 1 }, '2026-09-01').status, 'not-computed');
  row('7d a row with a non-finite pct refuses',
      M.printTapeImpliedFrom({ symbol: 'X', ts: 1, expectedMove: { pct: null } }, '2026-09-01').status, 'not-computed');
}

console.log('\n== 8. THE DIVERGENCE TEST — null is a REFUSAL, never a "no" =================\n');
{
  const tape = (pct) => ({ window: 'post', price: 1, changePct: pct, quoteTime: 'x' });
  const print = (ea, ee, ra, re) => ({ quarter: '2026-07-31', epsActual: ea, epsEst: ee, revActual: ra, revEst: re });
  const D = (s, p, tp) => M.printTapeDivergence(s, p, tp);

  // ── 8a. The one direction it fires on ──
  const fires = D('amc', print(1.05, 0.97, 3450, 3351), tape(-12.1));
  row('8a double beat + tape down 12.1%', fires.divergent, true);
  row('8a ...with no refusal reason', fires.refusalReason, null);
  row('8a the test decomposes', [fires.test.epsBeat, fires.test.revBeat, fires.test.sold], [true, true, true]);

  // ── 8b. Real falses — the question WAS asked and came back no ──
  row('8b beat + beat but tape flat', D('amc', print(1.05, 0.97, 3450, 3351), tape(0.5)).divergent, false);
  row('8b EPS miss + rev beat + tape down', D('amc', print(0.90, 0.97, 3450, 3351), tape(-12.1)).divergent, false);
  row('8b EPS beat + rev miss + tape down', D('amc', print(1.05, 0.97, 3300, 3351), tape(-12.1)).divergent, false);
  row('8b a real false carries NO refusal reason',
      D('amc', print(1.05, 0.97, 3450, 3351), tape(0.5)).refusalReason, null);

  // ── 8c. THE THRESHOLD, at and either side of the boundary ──
  row('8c exactly -3.00 fires (<=)', D('amc', print(1.05, 0.97, 3450, 3351), tape(-3.0)).divergent, true);
  row('8c -3.01 fires', D('amc', print(1.05, 0.97, 3450, 3351), tape(-3.01)).divergent, true);
  row('8c -2.99 does NOT fire', D('amc', print(1.05, 0.97, 3450, 3351), tape(-2.99)).divergent, false);

  // ── 8d. A beat is STRICTLY greater — inline is not a beat ──
  row('8d EPS exactly inline is not a beat', D('amc', print(0.97, 0.97, 3450, 3351), tape(-12)).divergent, false);
  row('8d revenue exactly inline is not a beat', D('amc', print(1.05, 0.97, 3351, 3351), tape(-12)).divergent, false);

  // ── 8e. REFUSALS — every one is null, and every one carries a reason ──
  const cases = [
    ['unknown session', D('unknown', print(1.05, 0.97, 3450, 3351), tape(-12)), /session is 'unknown'/],
    ['print refused', D('amc', { status: 'not-published', reason: 'lagging' }, tape(-12)), /print unavailable/],
    ['tape refused', D('amc', print(1.05, 0.97, 3450, 3351), { status: 'unavailable', reason: 'stale' }), /tape unavailable/],
    ['no epsActual', D('amc', print(null, 0.97, 3450, 3351), tape(-12)), /epsActual/],
    ['no epsEst', D('amc', print(1.05, null, 3450, 3351), tape(-12)), /epsEst/],
    ['no revActual', D('amc', print(1.05, 0.97, null, 3351), tape(-12)), /revActual/],
    ['no revEst', D('amc', print(1.05, 0.97, 3450, null), tape(-12)), /revEst/],
    ['no changePct', D('amc', print(1.05, 0.97, 3450, 3351), tape(null)), /changePct/],
  ];
  for (const [what, res, re] of cases) {
    row(`8e ${what} -> divergent`, res.divergent, null);
    row(`8e ${what} -> reason matches`, re.test(res.refusalReason || ''), true);
  }
  /* THE DISTINCTION THIS WHOLE SHAPE EXISTS FOR. */
  row('8f refusal and "no" are different values',
      D('unknown', print(1.05, 0.97, 3450, 3351), tape(-12)).divergent
      === D('amc', print(1.05, 0.97, 3450, 3351), tape(0.5)).divergent, false);
  row('8f a refusal carries no decomposed test',
      D('unknown', print(1.05, 0.97, 3450, 3351), tape(-12)).test, undefined);
}

console.log('\n== 9. THE CROSS-PASS MERGE — field level, gated on the quarter ==============\n');
{
  const S = M.PRINTTAPE_SCHEMA;
  // Pass 1: consensus banked, no actual (the PANW-at-print state).
  const pass1 = {
    schema: S, ticker: 'PANW', pass: 'amc-pass1', ts: 1000,
    print: { quarter: '2026-07-31', epsActual: null, epsEst: 0.97745, revActual: null, revEst: 3351856080,
             revenue: { status: 'not-published', reason: 'lag' }, eps: { status: 'not-published', reason: 'lag' } },
    tape: { window: 'post', changePct: -12.1 },
    implied: { movePct: 10.53 },
    guidance: null, passes: [{ pass: 'amc-pass1' }],
  };
  // Pass 2: actual has landed and the consensus has ROLLED AWAY.
  const pass2 = {
    schema: S, ticker: 'PANW', pass: 'amc-pass2', ts: 2000,
    print: { quarter: '2026-07-31', epsActual: 1.05, epsEst: 0.97745, revActual: 3450000000, revEst: null,
             revenue: { status: 'not-published', reason: 'rolled' } },
    tape: { status: 'unavailable', reason: 'quote absent' },
    implied: { status: 'not-computed', reason: 'no row' },
    guidance: null, passes: [{ pass: 'amc-pass2' }],
  };
  const m = M.mergePrintTapeRecord(pass1, pass2);
  row('9a revEst is carried forward from pass 1', m.print.revEst, 3351856080);
  row('9a the pass-2 actual is kept', m.print.revActual, 3450000000);
  row('9a ...so revSurprisePct becomes computable', m.print.revSurprisePct, 2.93);
  row('9a epsSurprisePct too', m.print.epsSurprisePct, 7.42);
  row('9a the carried field is NAMED', m.print.carriedFields, ['revEst']);
  row('9a ...and the pass it came from', m.print.carriedFromPass, 'amc-pass1');
  row('9a the revenue refusal is cleared once whole', m.print.revenue, undefined);
  row('9b a refused tape does NOT replace a banked one', m.tape.changePct, -12.1);
  row('9b ...and says so', /banked reading stands/.test(m.tape.carriedNote || ''), true);
  row('9b a refused implied does not replace either', m.implied.movePct, 10.53);
  row('9b what was carried is listed', m.carriedForward.includes('tape (whole block)'), true);
  row('9b passes accumulate', m.passes.map(p => p.pass), ['amc-pass1', 'amc-pass2']);

  /* 9c. THE QUARTER GATE. Merging across quarters is the §5 bug with an extra
     step, so a mismatch must carry NOTHING and say why. */
  const wrongQ = { ...pass2, print: { ...pass2.print, quarter: '2026-10-31' } };
  const mq = M.mergePrintTapeRecord(pass1, wrongQ);
  row('9c a different quarter carries nothing', mq.print.revEst, null);
  row('9c ...and refuses out loud', /different quarter/.test(mq.print.mergeRefused || ''), true);
  row('9c no surprise is fabricated across it', mq.print.revSurprisePct, undefined);

  /* 9d. A pass that read nothing at all leaves the banked block whole. */
  const blind = { ...pass2, print: { status: 'not-published', reason: 'Yahoo failed' } };
  const mb = M.mergePrintTapeRecord(pass1, blind);
  row('9d a blind pass keeps the banked print', mb.print.epsEst, 0.97745);
  row('9d ...marked as carried', /banked\s+measurement is served unchanged/.test(mb.print.carriedNote || ''), true);

  /* 9e. Guidance is never re-asked — one Claude call per ticker per report. */
  const withG = { ...pass1, guidance: { class: 'raised', quote: 'q' } };
  row('9e banked guidance survives a later pass',
      M.mergePrintTapeRecord(withG, pass2).guidance.class, 'raised');

  /* 9f. No prior record, or a schema mismatch, merges nothing. */
  row('9f no prior record returns this pass', M.mergePrintTapeRecord(null, pass2).print.epsActual, 1.05);
  row('9f a schema mismatch reads as absent',
      M.mergePrintTapeRecord({ ...pass1, schema: 99 }, pass2).print.revEst, null);

  /* 9g. printTapeComplete — a REFUSAL is never complete, which is why pass 2 runs. */
  row('9g an answered record is complete',
      M.printTapeComplete({ schema: S, divergent: false, print: {}, tape: {} }), true);
  row('9g a refusal is NOT complete', M.printTapeComplete({ schema: S, divergent: null, print: {}, tape: {} }), false);
  row('9g an answered record with a refused print is NOT complete',
      M.printTapeComplete({ schema: S, divergent: false, print: { status: 'x' }, tape: {} }), false);
  row('9g a wrong schema is NOT complete',
      M.printTapeComplete({ schema: 99, divergent: false, print: {}, tape: {} }), false);
  row('9g absent is NOT complete', M.printTapeComplete(null), false);
}

console.log('\n== 10. THE ENDPOINT — through the REAL router ===============================\n');
{
  const SECRET = 'x'.repeat(64);
  const store = new Map();
  let writes = 0;
  const env = {
    AI_GATE_SECRET: SECRET,
    REC_LOG: {
      async get(k, type) { const v = store.get(k); return v == null ? null : (type === 'json' ? JSON.parse(v) : v); },
      async put(k, v) { writes++; store.set(k, v); },
      async delete(k) { writes++; store.delete(k); },
      async list() { return { keys: [], list_complete: true }; },
    },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const call = (url, hdrs) => worker.fetch(new Request(url, { headers: hdrs }), env, ctx);
  const OK = { Origin: 'http://localhost', 'x-dash-key': SECRET };

  // Seed one day: two eligible, one measured, one skipped.
  const DATE = '2026-09-01';
  store.set(`printtapeday:${DATE}`, JSON.stringify({
    schema: M.PRINTTAPE_SCHEMA, date: DATE, ts: Date.parse('2026-09-01T21:31:00Z'),
    passes: [
      { pass: 'amc-pass1', ptTs: 'p1', wallMs: 900, universe: 40, scanOk: true, scanReason: null, divergent: [],
        eligible: [{ ticker: 'PANW', session: 'amc' }, { ticker: 'MDB', session: 'amc' }],
        measured: ['PANW'], skipped: [{ ticker: 'MDB', reason: 'measurement threw: boom' }] },
      { pass: 'amc-pass2', ptTs: 'p2', wallMs: 800, universe: 40, scanOk: true, scanReason: null, divergent: ['MDB'],
        eligible: [{ ticker: 'PANW', session: 'amc' }, { ticker: 'MDB', session: 'amc' }],
        measured: ['MDB'], skipped: [] },
    ],
  }));
  store.set(`printtape:PANW:${DATE}`, JSON.stringify({ schema: M.PRINTTAPE_SCHEMA, ticker: 'PANW', divergent: null }));
  store.set(`printtape:MDB:${DATE}`, JSON.stringify({ schema: M.PRINTTAPE_SCHEMA, ticker: 'MDB', divergent: true }));

  // ── 10a. The gate ──
  const noKey = await call('https://h/api/printtape', { Origin: 'http://localhost' });
  row('10a no x-dash-key', noKey.status, 401);
  const wrong = await call('https://h/api/printtape', { Origin: 'http://localhost', 'x-dash-key': 'nope' });
  row('10a wrong x-dash-key', wrong.status, 401);
  const badOrigin = await call('https://h/api/printtape', { Origin: 'https://evil.example', 'x-dash-key': SECRET });
  row('10a disallowed origin', badOrigin.status, 403);
  /* The gate must FAIL CLOSED with no secret configured — a control that
     disables itself on a missing config is not a control. */
  const noSecret = await worker.fetch(new Request('https://h/api/printtape', { headers: OK }),
    { ...env, AI_GATE_SECRET: undefined }, ctx);
  row('10a AI_GATE_SECRET unset fails CLOSED', noSecret.status, 503);

  // ── 10b. Date validation ──
  for (const bad of ['2026-9-1', 'yesterday', '20260901', '2026-09-01T00:00:00Z']) {
    row(`10b date ${j(bad)} is rejected`, (await call(`https://h/api/printtape?date=${encodeURIComponent(bad)}`, OK)).status, 400);
  }
  row('10b a valid date is accepted', (await call(`https://h/api/printtape?date=${DATE}`, OK)).status, 200);

  // ── 10c. The assembly ──
  const before = writes;
  const res = await call(`https://h/api/printtape?date=${DATE}`, OK);
  const body = await res.json();
  row('10c status', res.status, 200);
  row('10c charset is declared', res.headers.get('Content-Type'), 'application/json; charset=utf-8');
  row('10c THE READ WRITES NOTHING', writes - before, 0);
  row('10c records, sorted', body.records.map(r => r.ticker), ['MDB', 'PANW']);
  row('10c eligible is the UNION across passes', body.meta.eligible.map(e => e.ticker), ['PANW', 'MDB']);
  row('10c measured is the union', body.meta.measured.sort(), ['MDB', 'PANW']);
  /* A ticker skipped on pass 1 and measured on pass 2 is NOT a skip — reporting
     it as one would describe a name whose record is sitting right there. */
  row('10c MDB is not reported as skipped', body.meta.skipped.length, 0);
  row('10c ran', body.meta.ran, true);
  row('10c the threshold is published', body.meta.divergencePct, -3.0);
  row('10c passes are summarised', body.meta.passes.map(p => p.pass), ['amc-pass1', 'amc-pass2']);

  // ── 10d. ABSENT and EMPTY are different states ──
  const absent = await (await call('https://h/api/printtape?date=2026-08-11', OK)).json();
  row('10d a day nothing ran: ran', absent.meta.ran, false);
  row('10d ...records', absent.records, []);
  row('10d ...and the reason distinguishes it', /did not run that day/.test(absent.meta.ranReason || ''), true);
  store.set('printtapeday:2026-08-12', JSON.stringify({
    schema: M.PRINTTAPE_SCHEMA, date: '2026-08-12', ts: 1,
    passes: [{ pass: 'amc-pass1', eligible: [], measured: [], skipped: [], scanOk: true }],
  }));
  const quiet = await (await call('https://h/api/printtape?date=2026-08-12', OK)).json();
  row('10d a day nobody reported: ran', quiet.meta.ran, true);
  row('10d ...records', quiet.records, []);
  row('10d ...with no ranReason', quiet.meta.ranReason, null);
  row('10d so the two are distinguishable', absent.meta.ran !== quiet.meta.ran, true);

  // ── 10e. A record whose schema moved reads as absent and is NAMED ──
  store.set(`printtape:PANW:${DATE}`, JSON.stringify({ schema: 99, ticker: 'PANW' }));
  const mixed = await (await call(`https://h/api/printtape?date=${DATE}`, OK)).json();
  row('10e a stale-schema record is dropped', mixed.records.map(r => r.ticker), ['MDB']);
  row('10e ...and reported, not silently missing', mixed.meta.unreadable.map(u => u.ticker), ['PANW']);
  row('10e ...with the schema it found', /schema 99/.test(mixed.meta.unreadable[0].reason), true);
}

console.log('\n== 11. STRUCTURAL — what no behavioural test can see ========================\n');
{
  const collect = grab('collectPrintTape');
  const handler = grab('handlePrintTape');

  /* 11a. GUIDANCE MAY ONLY BE REACHED FROM `divergent === true`. Strict
     equality, because `null` is a refusal and a truthiness test would spend a
     Claude call on every name whose question could not be answered. */
  row('11a guidance is called exactly once in the job',
      (collect.match(/printTapeGuidance\(/g) || []).length, 1);
  row('11a ...guarded by strict === true', /rec\.divergent === true && \(!rec\.guidance/.test(collect), true);
  row('11a no truthiness test on divergent', /if \(rec\.divergent\)/.test(collect), false);
  row('11a the guidance call is nowhere else',
      (src.match(/printTapeGuidance\(/g) || []).length, 2);   // the definition + the one call

  /* 11a-bis. THE VERDICT IS RE-RUN AFTER THE MERGE, and the ORDER is the whole
     assertion. `printTapeMeasure` decides `divergent` from what one pass could
     read; the merge then supplies fields that pass could not see. Computing the
     verdict only before the merge left MDB reading `divergent: null,
     "1 is absent: revEst"` on a merged record whose own print reported
     revSurprisePct 3.77 — a refusal that had outlived its cause, and one that
     also made `guidance` unreachable for any name whose evidence completes
     across two passes, which is the only reason there are two. */
  const iMerge = collect.indexOf('mergePrintTapeRecord(');
  const iVerdict = collect.indexOf('printTapeDivergence(');
  const iGuidance = collect.indexOf('printTapeGuidance(');
  row('11a-bis the job re-runs the verdict', iVerdict > -1, true);
  row('11a-bis ...AFTER the merge', iVerdict > iMerge, true);
  row('11a-bis ...and BEFORE the guidance call', iVerdict < iGuidance, true);
  row('11a-bis it assigns the merged verdict back', /rec\.divergent = merged\.divergent/.test(collect), true);
  row('11a-bis ...and the reason with it', /rec\.refusalReason = merged\.refusalReason/.test(collect), true);
  /* A stale decomposed test beside a fresh verdict is two facts that can
     disagree, so it is deleted rather than left. */
  row('11a-bis a refusal deletes the stale test', /delete rec\.divergenceTest/.test(collect), true);

  /* 11b. THE READ PATH WRITES NOTHING. §10c proves it behaviourally for one
     input; this proves it for every input, including ones never driven. */
  row('11b handler contains no put', /\.put\(/.test(handler), false);
  row('11b handler contains no delete', /\.delete\(/.test(handler), false);
  row('11b handler makes no fetch', /fetch\(/.test(handler), false);

  /* 11c. THE JOB MUST NOT TOUCH ANY OTHER FEATURE'S KEYS. A dedup stamp written
     into a sibling's namespace is the `morningrows:last` vs `top3sweep:last`
     failure, which silently replaced a whole day's ranking. */
  for (const k of ['top3sweep:last', 'ivsweep:last', 'movesweep:last', 'morningrows:last',
                   'macrosweep:last', 'moodsweep:last', 'daily:', 'watchlist:prev']) {
    row(`11c the job never writes ${k}`, collect.includes(k), false);
  }
  row('11c it writes only its own two key builders',
      /printTapeKey\(/.test(collect) && /printTapeDayKey\(/.test(collect), true);
  row('11c it reads the universe through sweepUniverse', /sweepUniverse\(/.test(collect), true);

  /* 11d. THE DAY INDEX IS WRITTEN UNCONDITIONALLY — that is the dispatch
     evidence rule #7 requires, and an early return before it would make a quiet
     day indistinguishable from a job that never ran. The ONLY returns above it
     are the two that write nothing at all by design. */
  const beforeIndex = collect.slice(0, collect.indexOf('printTapeDayKey('));
  row('11d returns above the day-index write', (beforeIndex.match(/\breturn;/g) || []).length, 2);
  row('11d ...one is the no-KV guard', /if \(!env\?\.REC_LOG\) return;/.test(beforeIndex), true);
  row('11d ...the other is sweepUniverse refusing', /if \(!tickers\) return;/.test(beforeIndex), true);

  /* 11e. The dispatcher wires the job, outside the branch chain, and logs it. */
  const sched = src.slice(src.indexOf('async scheduled(event, env, ctx)'));
  row('11e scheduled() dispatches it via dispatchJob', /dispatchJob\(ctx, `print-tape-/.test(sched), true);
  row('11e ...decided by printTapePassAt', /printTapePassAt\(h, m\)/.test(sched), true);
  row('11e ...ahead of the branch chain',
      sched.indexOf('printTapePassAt(h, m)') < sched.indexOf("let branch = 'idle'"), true);
  row('11e ...and named in the [cron] line', /print-tape=\$\{ptPass\.session\}/.test(sched), true);
  /* It must NOT be an `else if` on the branch chain, which would silence it on
     the two passes whose windows an existing branch already owns. */
  row('11e it is not an else-if branch', /else if \([^)]*ptPass/.test(sched), false);

  /* 11f. The router mounts it with requireSecret, not aiGuard — this endpoint
     cannot spend, and debiting the Claude ceiling for it would let a page poll
     exhaust the budget the crons need. */
  /* The route's OWN block only — bounded at the next `case`, because the comment
     that introduces the following route mentions `aiGuard` and a fixed-width
     slice would read it as this route's. */
  const rStart = src.indexOf("case 'printtape':");
  const route = src.slice(rStart, src.indexOf('\n        }', rStart) + 10);
  row('11f the route block was isolated', route.length > 80 && route.length < 500, true);
  row('11f route uses requireSecret', /requireSecret\(request, env, origin\)/.test(route), true);
  row('11f route does NOT use aiGuard', /aiGuard/.test(route), false);
}

console.log(`
Fixtures in §5 and §6 are transcribed from a LIVE Yahoo v10 probe on 2026-09-01
at 20:42 UTC, 42 minutes after PANW / DELL / MDB reported AMC. None is invented.

BLIND SPOTS: nothing here calls Yahoo, so it cannot detect the modules changing
shape; the per-pass capCost is a DERIVATION, not a measurement; and the guidance
Claude call is pinned only structurally (§11a) and never executed.`);

/* THE FLOOR IS THE EXACT COUNT, the longarch.check.mjs rule: every section here
   is deterministic and offline — no live tape, no calendar-relative fixture — so
   there is no observed total to distinguish from a fixed one. A section that
   stops running drops the count into a NO VERDICT rather than quietly passing on
   fewer comparisons. */
process.exit(reportVerdict({
  label: 'print vs tape',
  comparisons: t.comparisons,
  failures: t.failures,
  minComparisons: 272,
}));
