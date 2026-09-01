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
 *      outlived its own cause and made guidance unreachable); the read path must
 *      contain no write; the carry-over must use `prevTradingDay` and yesterday's
 *      own day index rather than a re-scan; and the pre-bank must rank, measure
 *      and spend nothing. No behavioural test can see any of those change.
 *  12. THE PRE-BANKED QUARTER — the third and last way to name a report's
 *      quarter, driven BOTH ways, with the phantom miss a gate-free fallback
 *      would print shown beside the null the shipped code prints.
 *  13. THE TRADING-DAY WALKERS — `prevTradingDay` / `nextTradingDay` against a
 *      second day-of-week derivation, the Labor Day 2026-09-07 case with the two
 *      wrong answers printed beside the right one, and a 120-day sweep proving
 *      the walkers and the cron gate read one calendar.
 *  14. THE MDB REPLAY — the real 2026-09-01 record, read back out of the
 *      DEPLOYED Worker, driven through pre-bank -> pass 1 -> pass 2 ->
 *      carry-over, with the counterfactual (no pre-bank) beside it.
 *  15. GET /api/calendar/holidays through the REAL router, against a KV stub
 *      that THROWS on every method, so a single binding touch is a 500.
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
 *   · §14's REVENUE figures are SYNTHETIC and are labelled as such at every use.
 *     They are not a gap in the capture — they are the defect: Yahoo's
 *     `earningsTrend 0q` rolled from 2026-07-31 to 2026-10-31 in the 48 minutes
 *     between this repo's 20:42 UTC probe and the 21:30 UTC record, taking the
 *     revenue consensus with it, and no module retains it afterwards. The EPS
 *     half, the quarter, the tape and every refusal string in §14 are REAL.
 *   · Nothing here drives the real `collectPrintTape` / `collectPrintTapePreBank`
 *     end to end — they need Yahoo, a crumb and KV. §14's replay drives the pure
 *     functions in the order the job calls them and §11/§14z pin that order and
 *     those field names against SOURCE, which is the closest an offline script
 *     gets. The per-pass capCost remains a DERIVATION, not a measurement.
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
  grabConst('PRINTTAPE_GUIDANCE_CLASSES'), grabConst('PRINTTAPE_TAPE_WINDOWS'),
  grabConst('PRINTTAPE_CONSENSUS_SOURCES'),
  grabConst('printTapeKey'), grabConst('printTapeDayKey'), grabConst('PRINTTAPE_PASSES'),
  grabConst('LONG_SCHEMA'),
  grabConst('NYSE_HOLIDAY_TABLE'), grabConst('NYSE_HOLIDAYS'), grabConst('NYSE_HOLIDAYS_THROUGH'),
  grab('isoAddDays'), grab('isoDow'), grab('tradingDayStatus'), grab('walkTradingDays'),
  grabConst('prevTradingDay'), grabConst('nextTradingDay'),
  grab('printTapePassAt'), grabConst('printTapeReportDate'), grabConst('ptNum'),
  grab('printTapeSurprise'), grab('printTapePrintFrom'), grab('printTapeTapeFrom'),
  grab('printTapeFreshestWindow'),
  grab('printTapeImpliedFrom'), grab('printTapeDivergence'),
  grab('mergePrintTapeRecord'), grab('printTapeComplete'), grab('printTapeNeedsCarryOver'),
  `return { PRINTTAPE_SCHEMA, PRINTTAPE_TTL, PRINTTAPE_DIVERGENCE_PCT, PRINTTAPE_QUOTE_CHUNK,
            PRINTTAPE_SWEEP_CAP, PRINTTAPE_GUIDANCE_CLASSES, PRINTTAPE_TAPE_WINDOWS,
            PRINTTAPE_CONSENSUS_SOURCES, printTapeKey, printTapeDayKey,
            NYSE_HOLIDAY_TABLE, NYSE_HOLIDAYS, NYSE_HOLIDAYS_THROUGH,
            isoAddDays, isoDow, tradingDayStatus, walkTradingDays, prevTradingDay, nextTradingDay,
            PRINTTAPE_PASSES, printTapePassAt, printTapeReportDate, printTapeSurprise,
            printTapePrintFrom, printTapeTapeFrom, printTapeFreshestWindow, printTapeImpliedFrom,
            printTapeDivergence, mergePrintTapeRecord, printTapeComplete, printTapeNeedsCarryOver };`,
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
  /* SCHEMA 2. Bumped when `tape` became a pre/post PAIR and the record gained
     `consensusSource` / `consensusBankedTs`. Strict equality everywhere means a
     schema-1 record reads as absent, which is right: its `tape.changePct` sits
     at the top level and a schema-2 reader looks for it inside a window. */
  row('1a PRINTTAPE_SCHEMA', M.PRINTTAPE_SCHEMA, 2);
  row('1a tape windows', M.PRINTTAPE_TAPE_WINDOWS, ['pre', 'post']);
  row('1a consensus sources', M.PRINTTAPE_CONSENSUS_SOURCES, ['pre-banked', 'live-pass']);
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
  row('3a there are exactly five passes', M.PRINTTAPE_PASSES.length, 5);
  row('3a kinds', M.PRINTTAPE_PASSES.map(p => p.kind), ['prebank', 'measure', 'measure', 'measure', 'measure']);
  row('3a exactly one is a pre-bank', M.PRINTTAPE_PASSES.filter(p => p.kind === 'prebank').length, 1);
  row('3a sessions', M.PRINTTAPE_PASSES.map(p => `${p.session}${p.pass}`),
      ['null0', 'bmo1', 'bmo2', 'amc1', 'amc2']);
  /* THE PRE-BANK CARRIES NO SESSION, and that is the point: it is not a reading
     of a session, it is a reading taken a session BEFORE one. */
  row('3a the pre-bank has no session', M.PRINTTAPE_PASSES.find(p => p.kind === 'prebank').session, null);

  const plabel = p => (p.kind === 'prebank' ? 'prebank' : `${p.session}-pass${p.pass}`);
  const at = (h, m) => { const p = M.printTapePassAt(h, m); return p ? plabel(p) : null; };
  /* 13:15 PT — 16:15 ET, fifteen minutes after the close of the session BEFORE
     the report. It was a non-firing boundary at schema 1 and is now the
     pre-bank; the assertion MOVED rather than being deleted, so the change shows
     in the diff instead of as one fewer null. */
  row('3b 13:15 PT is the pre-bank', at(13, 15), 'prebank');
  row('3b 05:30 PT', at(5, 30), 'bmo-pass1');
  row('3b 06:15 PT', at(6, 15), 'bmo-pass2');
  row('3b 13:30 PT', at(13, 30), 'amc-pass1');
  row('3b 14:30 PT', at(14, 30), 'amc-pass2');

  /* NON-FIRING BOUNDARIES. A window that fired one tick early or late would
     double-run or miss, and neither announces itself. */
  for (const [h, m] of [[5, 15], [5, 45], [6, 0], [6, 30], [13, 0], [13, 45], [14, 0], [14, 15], [14, 45], [7, 30]]) {
    row(`3b ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} PT is NOT a pass`, at(h, m), null);
  }

  /* EXACTLY ONE FIRING PER PASS. The trigger is every 15 minutes, so a window
     wider than 15 would double-run the same pass on one day. */
  for (const p of M.PRINTTAPE_PASSES) {
    const fires = [0, 15, 30, 45].filter(m => m >= p.m0 && m < p.m1);
    row(`3c ${plabel(p)} admits exactly one firing`, fires.length, 1);
  }
  /* And no two passes claim the same instant. The pre-bank's 13:15-13:30 window
     abuts `amc-pass1` at 13:30 without overlapping it — an overlap would run a
     consensus-only pass and a measurement pass on one firing, against the same
     key, from two different clocks. */
  const claimed = [];
  for (let h = 0; h < 24; h++) for (const m of [0, 15, 30, 45]) if (M.printTapePassAt(h, m)) claimed.push(`${h}:${m}`);
  row('3c total firings claimed across the day', claimed.length, 5);
  row('3c the pre-bank does not overlap amc-pass1', at(13, 15) !== at(13, 30), true);
  row('3c ...and 13:30 is still amc-pass1', at(13, 30), 'amc-pass1');

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
    row(`3d ${plabel(p)} ${s} PT -> UTC [PDT,PST]`, [pdt, pst], [pdt, pst]);
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

console.log('\n== 6. THE TAPE — the window PAIR, staleness, and the volume refusal =========\n');
{
  const AMC_TS = '2026-09-01T20:00:00.000Z';
  /* SCHEMA 2: the block is a PAIR. An AMC print is traded in the post-market of
     its report day AND the pre-market of the next trading day, and `usedWindow`
     names which reading the verdict took — the freshest by quoteTime. */
  const amc = M.printTapeTapeFrom(PANW_AT_PRINT.price, 'amc', AMC_TS);
  const post = amc.post;
  row('6a both windows are allowed for an AMC print', amc.sessionWindows, ['pre', 'post']);
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
  /* THE PRE WINDOW OF THE SAME PAYLOAD IS REFUSED, and on the staleness line
     rather than by any clock test: that morning's pre-market quote (13:29:59Z)
     is EARLIER than the 20:00Z print. This is what makes reading both windows
     unconditionally safe — the same-evening pass cannot pick up a pre-market
     reaction to yesterday's session and file it as this print's. */
  row('6a ...and the same payload\'s PRE window is refused as stale', amc.pre.status, 'unavailable');
  row('6a so the used window is the post one', amc.usedWindow, 'post');

  const bmo = M.printTapeTapeFrom(PANW_AT_PRINT.price, 'bmo', '2026-09-01T12:30:00.000Z');
  const pre = bmo.pre;
  row('6b only the pre window applies to a BMO print', bmo.sessionWindows, ['pre']);
  row('6b window', pre.window, 'pre');
  row('6b price', pre.price, 373.7);
  row('6b changePct', pre.changePct, -2.2061);
  /* THE OTHER CLOSE. A pre-market move is against YESTERDAY's close, and using
     today's would be the sign-inversion class of error. */
  row('6b reference close is YESTERDAY\'s close', pre.referenceClose, 382.13);
  row('6b ...named on the record', pre.referenceCloseField, 'regularMarketPreviousClose');
  const preDerived = +((373.7 - 382.13) / 382.13 * 100).toFixed(4);
  row('6b agrees with price-minus-prev-close', pre.changePct, preDerived);
  /* A BMO print's own post-market is a whole regular session later — a reaction
     to the session, not to the print. Refused STRUCTURALLY, with its own status,
     so it can never be the freshest window and win. */
  row('6b the post window is not-applicable to a BMO print', bmo.post.status, 'not-applicable');
  row('6b ...and the used window is pre', bmo.usedWindow, 'pre');

  // ── 6c. Staleness — a quote from before the print is not this print's reaction ──
  const stale = M.printTapeTapeFrom(PANW_AT_PRINT.price, 'bmo', '2026-09-01T20:00:00.000Z');
  row('6c a pre-market quote stamped before the print refuses', stale.status, 'unavailable');
  row('6c ...and names both timestamps',
      /13:29:59/.test(stale.reason || '') && /20:00:00/.test(stale.reason || ''), true);
  /* The boundary: a quote at EXACTLY the report instant is not stale. */
  const exact = M.printTapeTapeFrom(
    { ...PANW_AT_PRINT.price, postMarketTime: Date.parse(AMC_TS) / 1000 }, 'amc', AMC_TS);
  row('6c a quote AT the report instant is accepted', exact.post.status, undefined);
  const oneSecEarly = M.printTapeTapeFrom(
    { ...PANW_AT_PRINT.price, postMarketTime: Date.parse(AMC_TS) / 1000 - 1 }, 'amc', AMC_TS);
  row('6c one second earlier is refused', oneSecEarly.status, 'unavailable');
  row('6c ...as a BLOCK-level refusal, because neither window was readable',
      /no usable extended-hours quote in any window/.test(oneSecEarly.reason || ''), true);

  // ── 6d. Absent fields, and an unknown session ──
  row('6d no extended-hours quote refuses', M.printTapeTapeFrom({}, 'amc', AMC_TS).status, 'unavailable');
  const unk = M.printTapeTapeFrom(PANW_AT_PRINT.price, 'unknown', AMC_TS);
  row('6d unknown session refuses', unk.status, 'unavailable');
  row('6d ...because no window can be identified', /neither the pre-market nor the post-market/.test(unk.reason || ''), true);

  /* ── 6f. THE FRESHEST WINDOW WINS, BY quoteTime AND BY NOTHING ELSE ────────
     Driven in BOTH orders on the same pair. A rule that only ever returned the
     later-listed window would pass a one-directional test and would silently
     pick the stale reading the day the array order changed. */
  const mk = (w, iso) => ({ window: w, changePct: -5, quoteTime: iso });
  const later = { pre: mk('pre', '2026-09-02T12:00:00.000Z'), post: mk('post', '2026-09-01T21:30:00.000Z') };
  row('6f pre newer than post -> pre', M.printTapeFreshestWindow(later), 'pre');
  const earlier = { pre: mk('pre', '2026-09-01T13:00:00.000Z'), post: mk('post', '2026-09-01T21:30:00.000Z') };
  row('6f post newer than pre -> post', M.printTapeFreshestWindow(earlier), 'post');
  row('6f a refused window can never win',
      M.printTapeFreshestWindow({ pre: { status: 'unavailable', quoteTime: '2099-01-01T00:00:00.000Z' },
                                  post: mk('post', '2026-09-01T21:30:00.000Z') }), 'post');
  row('6f both refused -> null',
      M.printTapeFreshestWindow({ pre: { status: 'x' }, post: { status: 'y' } }), null);
  row('6f a window with no quoteTime can never win',
      M.printTapeFreshestWindow({ pre: { window: 'pre', changePct: -9 }, post: mk('post', '2026-09-01T21:30:00.000Z') }), 'post');

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
  /* SCHEMA 2: the verdict reads `tape[tape.usedWindow]`, never a hoisted
     top-level `changePct`. The helper therefore builds the PAIR shape the job
     stores, and 8g below drives the case that shape exists for. */
  const tape = (pct, window = 'post', quoteTime = '2026-09-01T21:30:00.000Z') => ({
    sessionWindows: ['pre', 'post'],
    [window]: { window, price: 1, changePct: pct, quoteTime },
    [window === 'post' ? 'pre' : 'post']: { status: 'unavailable', reason: 'not read in this fixture' },
    usedWindow: window,
  });
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
    /* A tape block with BOTH windows refused but no block-level status would
       have slipped past the `tape?.status` guard at schema 1's shape. */
    ['no usable window', D('amc', print(1.05, 0.97, 3450, 3351),
      { sessionWindows: ['pre', 'post'], pre: { status: 'x' }, post: { status: 'y' }, usedWindow: null }),
      /tape\.changePct/],
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

  /* ── 8g. THE VERDICT READS `usedWindow` AND NOTHING ELSE ──────────────────

     The carry-over's whole point: a record holding LAST NIGHT's post reading and
     THIS MORNING's pre reading must be judged on the pre one. Driven with the
     two windows disagreeing about the answer, so a verdict that read the wrong
     one is a different boolean rather than the same one by luck. */
  const bothWays = (used) => ({
    sessionWindows: ['pre', 'post'],
    post: { window: 'post', changePct: -0.5, quoteTime: '2026-09-01T21:30:00.000Z' },
    pre:  { window: 'pre',  changePct: -9.8, quoteTime: '2026-09-02T12:00:00.000Z' },
    usedWindow: used,
  });
  const beat = print(1.05, 0.97, 3450, 3351);
  row('8g usedWindow=post reads the post reading', D('amc', beat, bothWays('post')).test.changePct, -0.5);
  row('8g ...and does NOT fire on it', D('amc', beat, bothWays('post')).divergent, false);
  row('8g usedWindow=pre reads the pre reading', D('amc', beat, bothWays('pre')).test.changePct, -9.8);
  row('8g ...and DOES fire on it', D('amc', beat, bothWays('pre')).divergent, true);
  row('8g the test names the window it read', D('amc', beat, bothWays('pre')).test.usedWindow, 'pre');
  row('8g ...and the quote time behind it',
      D('amc', beat, bothWays('pre')).test.quoteTime, '2026-09-02T12:00:00.000Z');
  /* And the two really are different answers on identical print inputs, which is
     what makes the assertion above about the READ rather than about the data. */
  row('8g the two windows disagree, so the choice is load-bearing',
      D('amc', beat, bothWays('post')).divergent !== D('amc', beat, bothWays('pre')).divergent, true);
  row('8g a null usedWindow refuses', D('amc', beat, bothWays(null)).divergent, null);
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


  /* ── 9h. THE TAPE MERGES PER WINDOW, AND `usedWindow` IS RE-DERIVED ────────

     Schema 1 merged the tape whole-block, which cannot be right once a record
     holds two windows: the morning carry-over reads a `pre` window and can no
     longer see last night's `post` one, so a whole-block rule would throw away
     whichever side the pass could not re-read. */
  const nightBefore = {
    schema: S, ticker: 'MDB', pass: 'amc-pass2', ts: 1000,
    print: { quarter: '2026-07-31', epsActual: 1.9, epsEst: 1.60897, revActual: null, revEst: 587e6 },
    tape: {
      sessionWindows: ['pre', 'post'],
      post: { window: 'post', changePct: -14.5598, quoteTime: '2026-09-01T21:30:21.000Z' },
      pre:  { status: 'unavailable', reason: 'stale — earlier than the print' },
      usedWindow: 'post',
    },
    passes: [{ pass: 'amc-pass2' }],
  };
  const nextMorning = {
    schema: S, ticker: 'MDB', pass: 'bmo-pass1-carryover', ts: 2000,
    print: { quarter: '2026-07-31', epsActual: 1.9, epsEst: 1.60897, revActual: 609.12e6, revEst: null },
    tape: {
      sessionWindows: ['pre', 'post'],
      pre:  { window: 'pre', changePct: -14.212, quoteTime: '2026-09-02T13:00:00.000Z' },
      post: { status: 'unavailable', reason: 'Yahoo drops postMarket* once the pre session opens' },
      usedWindow: 'pre',
    },
    passes: [{ pass: 'bmo-pass1-carryover' }],
  };
  const mt = M.mergePrintTapeRecord(nightBefore, nextMorning);
  row('9h the banked post window survives', mt.tape.post.changePct, -14.5598);
  row('9h ...marked with the pass it came from', mt.tape.post.carriedFromPass, 'amc-pass2');
  row('9h this pass\'s pre window is kept', mt.tape.pre.changePct, -14.212);
  row('9h the carried window is NAMED', mt.carriedForward.includes('tape.post'), true);
  row('9h usedWindow is the FRESHEST of the merged pair', mt.tape.usedWindow, 'pre');
  /* And it is RE-DERIVED, not carried: neither input record had this pair, so a
     `usedWindow` copied from either side would be a claim about a state that
     never existed. Driven by handing in a prev whose usedWindow disagrees. */
  const lying = { ...nightBefore, tape: { ...nightBefore.tape, usedWindow: 'pre' } };
  row('9h a prev usedWindow cannot leak through', M.mergePrintTapeRecord(lying, nextMorning).tape.usedWindow, 'pre');
  const reversed = M.mergePrintTapeRecord(nextMorning, nightBefore);
  row('9h ...and in the other order it derives post',
      [reversed.tape.pre.changePct, reversed.tape.usedWindow], [-14.212, 'pre']);
  /* A whole-block tape refusal still carries the banked pair intact. */
  const blindTape = { ...nextMorning, tape: { status: 'unavailable', reason: 'quoteSummary failed' } };
  row('9h a blind pass keeps the banked pair', M.mergePrintTapeRecord(nightBefore, blindTape).tape.post.changePct, -14.5598);
  row('9h ...as a whole block', M.mergePrintTapeRecord(nightBefore, blindTape).carriedForward.includes('tape (whole block)'), true);

  /* ── 9i. CONSENSUS PROVENANCE — two fields, two different questions ────────

     `consensusBankedTs` says a bank was TAKEN (a fact about the report).
     `consensusSource` says where THIS record's figures came from. A pass that
     read a live consensus of its own says `live-pass` even with a bank sitting
     beside it, because anything else would describe a read that did not happen. */
  const banked = {
    schema: S, ticker: 'MDB', pass: 'prebank', ts: 500,
    consensusSource: 'pre-banked', consensusBankedTs: '2026-08-31T20:15:00.000Z',
    print: { quarter: '2026-07-31', epsActual: null, epsEst: 1.60897, revActual: null, revEst: 587e6 },
    tape: { status: 'not-yet', reason: 'not happened' }, passes: [],
  };
  const readsLive = {
    schema: S, ticker: 'MDB', pass: 'amc-pass1', ts: 600,
    consensusSource: 'live-pass', consensusBankedTs: null,
    print: { quarter: '2026-07-31', epsActual: 1.9, epsEst: 1.60897, revActual: null, revEst: 587e6 },
    tape: { status: 'unavailable', reason: 'x' }, passes: [],
  };
  const mLive = M.mergePrintTapeRecord(banked, readsLive);
  row('9i a live read keeps consensusSource live-pass', mLive.consensusSource, 'live-pass');
  row('9i ...but the bank timestamp still travels', mLive.consensusBankedTs, '2026-08-31T20:15:00.000Z');
  row('9i ...because nothing was carried from the bank', mLive.print.carriedFields, undefined);

  const rolledAway = { ...readsLive, consensusSource: 'live-pass',
    print: { ...readsLive.print, revEst: null, revenue: { status: 'not-published', reason: 'rolled' } } };
  const mBank = M.mergePrintTapeRecord(banked, rolledAway);
  row('9i a carried revEst flips it to pre-banked', mBank.consensusSource, 'pre-banked');
  row('9i ...and the figure really is the banked one', mBank.print.revEst, 587e6);
  /* An epsActual carried forward is NOT a consensus, so it must not flip it. */
  const carriesActualOnly = { ...readsLive,
    print: { quarter: '2026-07-31', epsActual: null, epsEst: 1.60897, revActual: 609e6, revEst: 587e6 } };
  const bankWithActual = { ...banked, print: { ...banked.print, epsActual: 1.9 } };
  const mActual = M.mergePrintTapeRecord(bankWithActual, carriesActualOnly);
  row('9i carrying epsActual alone does NOT claim pre-banked', mActual.print.carriedFields, ['epsActual']);
  row('9i ...so consensusSource stays live-pass', mActual.consensusSource, 'live-pass');
  /* A quarter MISMATCH refuses the bank, so it must not claim pre-banked either
     — that is the fabricated-surprise gate reaching the provenance field. */
  const wrongQuarter = { ...rolledAway, print: { ...rolledAway.print, quarter: '2026-10-31' } };
  const mWrongQ = M.mergePrintTapeRecord(banked, wrongQuarter);
  row('9i a quarter mismatch carries nothing', mWrongQ.print.revEst, null);
  row('9i ...and does NOT claim pre-banked', mWrongQ.consensusSource, 'live-pass');

  /* ── 9j. THE CARRY-OVER TEST — the spec's own words, driven both ways ──────*/
  const answered = { schema: S, divergent: false, print: { quarter: 'q' } };
  row('9j an answered record does not carry over', M.printTapeNeedsCarryOver(answered).need, false);
  row('9j a divergent:true record does not either',
      M.printTapeNeedsCarryOver({ ...answered, divergent: true }).need, false);
  row('9j divergent:null carries over', M.printTapeNeedsCarryOver({ ...answered, divergent: null }).need, true);
  row('9j a refused print block carries over',
      M.printTapeNeedsCarryOver({ ...answered, print: { status: 'not-published', reason: 'r' } }).need, true);
  row('9j a not-published EPS half carries over',
      M.printTapeNeedsCarryOver({ ...answered, print: { quarter: 'q', eps: { status: 'not-published', reason: 'r' } } }).need, true);
  row('9j a not-published REVENUE half carries over',
      M.printTapeNeedsCarryOver({ ...answered, print: { quarter: 'q', revenue: { status: 'not-published', reason: 'r' } } }).need, true);
  row('9j an ABSENT record carries over', M.printTapeNeedsCarryOver(null).need, true);
  row('9j ...saying nothing was banked at all', /no record was banked/.test(M.printTapeNeedsCarryOver(null).reason), true);
  row('9j a stale-schema record carries over', M.printTapeNeedsCarryOver({ schema: 99 }).need, true);
  row('9j every verdict carries a reason',
      [answered, { ...answered, divergent: null }, null, { schema: 99 }]
        .every(r => typeof M.printTapeNeedsCarryOver(r).reason === 'string'), true);
  /* IT IS A DIFFERENT QUESTION FROM `printTapeComplete`, and the difference is
     load-bearing: complete asks "is there anything left for a same-session pass
     to read", this asks "is there anything a NIGHT could have fixed". The
     divergence appears on a record with a refused revenue half and an answered
     verdict — which the same-session pass 2 would skip and a carry-over must
     not. */
  const half = { schema: S, divergent: false, print: { quarter: 'q', revenue: { status: 'not-published', reason: 'lag' } }, tape: {} };
  row('9j the half-published record reads COMPLETE', M.printTapeComplete(half), true);
  row('9j ...and still NEEDS the carry-over', M.printTapeNeedsCarryOver(half).need, true);
  /* Same record, OPPOSITE actions: pass 2 skips it, the next morning takes it. */
  row('9j pass 2 would SKIP it / the carry-over TAKES it',
      [M.printTapeComplete(half) ? 'skip' : 'measure',
       M.printTapeNeedsCarryOver(half).need ? 'measure' : 'skip'], ['skip', 'measure']);

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


  /* ── 11g. THE CARRY-OVER'S CALENDAR AND ITS SOURCE ────────────────────────

     Two things no behavioural test in this file can see, and both would fail
     silently: a `-1 day` walk that lands on a closed exchange, and a re-scan
     that looks for yesterday's reporters in a quote field Yahoo has already
     rolled forward. */
  row('11g the prior session comes from prevTradingDay', /prevTradingDay\(today\)/.test(collect), true);
  row('11g ...and only on the BMO passes',
      /sessionWanted === 'bmo' \? prevTradingDay\(today\) : null/.test(collect), true);
  row('11g it does NOT walk back by one calendar day', /isoAddDays\(today, -1\)/.test(collect), false);
  /* The candidate list is yesterday's OWN day index, never a second eligibility
     scan — `earningsTimestampStart` names the NEXT report and has rolled by the
     morning, so a re-scan would find nothing and report it as "nobody
     reported". */
  row('11g the carry-over reads the prior day index',
      /printTapeDayKey\(prevDate\)/.test(collect), true);
  row('11g ...and does NOT re-run the eligibility scan for it',
      (collect.match(/printTapeEligible\(/g) || []).length, 1);
  row('11g the eligibility scan is asked for today only',
      /printTapeEligible\(env, tickers, new Set\(\[today\]\)\)/.test(collect), true);
  row('11g every screened name goes through printTapeNeedsCarryOver',
      /printTapeNeedsCarryOver\(prev\)/.test(collect), true);
  /* WITHOUT AN `earningsTs` THE STALENESS GUARD CANNOT RUN, and a pre-market
     quote from the wrong session would render as this print's reaction. That is
     the one refusal this feature does not trade away. */
  row('11g a name with no earningsTs is refused, not measured',
      /if \(!earningsTs\)/.test(collect), true);
  row('11g ...naming the guard it could not apply',
      /staleness guard could not be applied/.test(collect), true);

  /* 11h. THE CARRY-OVER WRITES UNDER THE REPORT DATE, not today's. Filing it
     under the morning's date would create a second record for one report, under
     a day on which the company did not report. */
  row('11h the record key is built from the item\'s report date',
      /printTapeKey\(cand\.symbol, item\.reportDate\)/.test(collect), true);
  row('11h ...and the carry-over item carries the prior date',
      /reportDate: prevDate, prev, carry: true/.test(collect), true);
  /* And the REPORT day's index is appended to, or the endpoint would assemble
     that day from a `measured` list the record is not in. */
  row('11h the prior day index is appended when something was measured',
      /if \(carryMeasured\.length\)/.test(collect), true);
  row('11h ...and today\'s index records the carry-over either way',
      /carryOver: prevDate \?/.test(collect), true);

  /* 11i. THE PRE-BANK IS A SEPARATE JOB AND MUST NOT RANK, MEASURE OR SPEND. */
  const prebank = grab('collectPrintTapePreBank');
  for (const k of ['top3sweep:last', 'ivsweep:last', 'movesweep:last', 'morningrows:last',
                   'macrosweep:last', 'moodsweep:last', 'daily:', 'watchlist:prev']) {
    row(`11i the pre-bank never writes ${k}`, prebank.includes(k), false);
  }
  row('11i the pre-bank writes only the record key directly', /printTapeKey\(/.test(prebank), true);
  row('11i ...and the day index through the shared append helper',
      /printTapeAppendDay\(env, target,/.test(prebank), true);
  row('11i ...which is the only other key it names',
      (prebank.match(/env\.REC_LOG\.put\(/g) || []).length, 1);
  row('11i it reads the universe through sweepUniverse', /sweepUniverse\(/.test(prebank), true);
  row('11i it makes no Claude call anywhere', /workerClaude\(|cronMaySpend\(/.test(prebank), false);
  row('11i ...and never computes a divergence verdict it could store as true',
      /divergent === true/.test(prebank), false);
  /* Its `tape` is a distinct status: "we looked and Yahoo had nothing" and
     "there was nothing to look at yet" are different facts. */
  row('11i the pre-bank tape status is not-yet', /status: 'not-yet'/.test(prebank), true);

  /* 11j. THE DAY-INDEX WRITE IS STILL UNCONDITIONAL in both jobs — it moved into
     a helper, and a helper is exactly where an early return could hide. */
  const appendFn = grab('printTapeAppendDay');
  row('11j the append helper writes unconditionally', /\.put\(printTapeDayKey\(date\)/.test(appendFn), true);
  row('11j ...and swallows a KV failure rather than propagating it',
      /catch \(e\) \{ console\.warn/.test(appendFn), true);
  row('11j the pre-bank appends exactly once', (prebank.match(/printTapeAppendDay\(/g) || []).length, 1);
  row('11j the measurement job appends today and, conditionally, the report day',
      (collect.match(/printTapeAppendDay\(/g) || []).length, 2);

  /* 11d. THE DAY INDEX IS WRITTEN UNCONDITIONALLY — that is the dispatch
     evidence rule #7 requires, and an early return before it would make a quiet
     day indistinguishable from a job that never ran. The ONLY returns above it
     are the two that write nothing at all by design. */
  const beforeIndex = collect.slice(0, collect.indexOf('await printTapeAppendDay(env, today,'));
  row('11d returns above the day-index write', (beforeIndex.match(/\breturn;/g) || []).length, 2);
  row('11d ...one is the no-KV guard', /if \(!env\?\.REC_LOG\) return;/.test(beforeIndex), true);
  row('11d ...the other is sweepUniverse refusing', /if \(!tickers\) return;/.test(beforeIndex), true);

  /* 11e. The dispatcher wires the job, outside the branch chain, and logs it. */
  const sched = src.slice(src.indexOf('async scheduled(event, env, ctx)'));
  row('11e scheduled() dispatches it via dispatchJob', /dispatchJob\(ctx, `print-tape-/.test(sched), true);
  row('11e ...decided by printTapePassAt', /printTapePassAt\(h, m\)/.test(sched), true);
  row('11e ...ahead of the branch chain',
      sched.indexOf('printTapePassAt(h, m)') < sched.indexOf("let branch = 'idle'"), true);
  row('11e ...and named in the [cron] line', /print-tape=\$\{ptLabel\}/.test(sched), true);
  /* The label must distinguish the PRE-BANK from a measurement pass, or rule
     #7's "every firing says which pass was due" quietly becomes "every firing
     says a pass was due". */
  row('11e ...with the pre-bank labelled distinctly',
      /ptPass\.kind === 'prebank' \? 'prebank'/.test(sched), true);
  row('11e the pre-bank is dispatched through dispatchJob',
      /dispatchJob\(ctx, 'print-tape-prebank'/.test(sched), true);
  row('11e ...calling collectPrintTapePreBank', /collectPrintTapePreBank\(env\)/.test(sched), true);
  row('11e the measurement dispatch is unchanged',
      /collectPrintTape\(env, ptPass\.session, ptPass\.pass\)/.test(sched), true);
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

console.log('\n== 12. THE PRE-BANKED QUARTER — a backstop that relaxes no comparison =======\n');
{
  /* THE STATE THIS EXISTS FOR, and it is not hypothetical. MDB's `earningsTrend
     0q` read 2026-07-31 at 20:42 UTC on 2026-09-01 and 2026-10-31 at 21:30 UTC
     the SAME DAY — measured, from this repo's own two observations, 48 minutes
     apart. Once it has rolled, a report whose actual Yahoo has not yet stamped
     with this report date cannot be identified at all, and the whole print
     refuses. The banked quarter is the third and last way to name it. */
  const ROLLED_NO_ACTUAL = {
    earningsTrend: { trend: [{ period: '0q', endDate: '2026-10-31',
      earningsEstimate: { avg: { raw: 2.05 } }, revenueEstimate: { avg: { raw: 640000000 } } }] },
    calendarEvents: { earnings: {} },
    earnings: {
      // The newest published actual is still the PREVIOUS quarter.
      earningsChart: { quarterly: [{ date: '1Q2026', actual: { raw: 1.00 }, estimate: { raw: 0.95 },
        periodEndDate: { fmt: '2026-04-30' }, reportedDate: { fmt: '2026-06-03' } }] },
      financialsChart: { quarterly: [{ date: '1Q2026', revenue: { raw: 549000000 } }] },
    },
    price: {},
  };

  const without = M.printTapePrintFrom(ROLLED_NO_ACTUAL, '2026-09-01');
  row('12a with no bank, the whole print refuses', without.status, 'not-published');
  row('12a ...naming the roll', /ROLLED PAST the report date 2026-09-01/.test(without.reason || ''), true);
  row('12a ...and saying no quarter was pre-banked', /no quarter was pre-banked/.test(without.reason || ''), true);

  const with_ = M.printTapePrintFrom(ROLLED_NO_ACTUAL, '2026-09-01', '2026-07-31');
  row('12b with the bank, the quarter is established', with_.quarter, '2026-07-31');
  row('12b ...and the provenance says which read it came from',
      /PRE-BANKED consensus quarter/.test(with_.quarterVia || ''), true);
  row('12b it is NOT a refusal any more', with_.status, undefined);

  /* 12c. AND IT FABRICATES NOTHING. The alignment gate is still string equality:
     the newest actual is 2026-04-30, which is NOT the banked quarter, so no EPS
     actual is taken and no surprise is computed. This is the §5f failure driven
     against the NEW code path — the one place a "helpful" fallback could have
     reintroduced it. */
  row('12c the misaligned actual is NOT taken', with_.epsActual, null);
  row('12c ...so no surprise is computed', with_.epsSurprisePct, null);
  row('12c ...and the EPS half says why', with_.eps.status, 'not-published');
  row('12c the revenue half is refused too', with_.revenue.status, 'not-published');
  /* The phantom miss §5f produced, computed here against what a fallback WITHOUT
     the gate would have printed, so the number that must not appear is on screen
     beside the null that does. */
  const phantom = +(((1.00 - 2.05) / Math.abs(2.05)) * 100).toFixed(2);
  row('12c the miss a gate-free fallback would print', phantom, -51.22);
  row('12c ...and the shipped code prints', with_.epsSurprisePct, null);
  row('12c so the two are different values', with_.epsSurprisePct !== phantom, true);

  /* 12d. THE ORDER: a LIVE reading always wins over the bank, so the bank can
     never override a consensus Yahoo is still publishing. Driven on PANW's real
     pre-roll payload with a deliberately WRONG bank. */
  const live = M.printTapePrintFrom(PANW_AT_PRINT, '2026-09-01', '1999-01-31');
  row('12d a live consensus outranks the bank', live.quarter, '2026-07-31');
  row('12d ...via the live field', /earningsTrend\.0q\.endDate/.test(live.quarterVia || ''), true);
  /* And an actual whose reportedDate IS this report also outranks it. */
  const viaActual = M.printTapePrintFrom(NVDA_ROLLED, '2026-08-26', '1999-01-31');
  row('12d an actual stamped with this report date also outranks it', viaActual.quarter, '2026-07-31');
  row('12d ...via the earningsChart entry', /earningsChart/.test(viaActual.quarterVia || ''), true);

  // 12e. A non-string bank changes nothing.
  for (const bad of [null, undefined, '', 0, false, {}]) {
    row(`12e bank ${j(bad)} is ignored`, M.printTapePrintFrom(ROLLED_NO_ACTUAL, '2026-09-01', bad).status,
        'not-published');
  }
}

console.log('\n== 13. THE TRADING-DAY WALKERS — and Labor Day 2026-09-07 ===================\n');
{
  row('13a the table and the Set agree in length', M.NYSE_HOLIDAY_TABLE.length, M.NYSE_HOLIDAYS.size);
  row('13a every table date is in the Set',
      M.NYSE_HOLIDAY_TABLE.every(h => M.NYSE_HOLIDAYS.has(h.date)), true);
  row('13a every entry carries a name',
      M.NYSE_HOLIDAY_TABLE.every(h => typeof h.name === 'string' && h.name.length > 3), true);
  row('13a every date is well-formed and sorted',
      M.NYSE_HOLIDAY_TABLE.map(h => h.date).join() ===
      M.NYSE_HOLIDAY_TABLE.map(h => h.date).slice().sort().join(), true);
  row('13a the runway', M.NYSE_HOLIDAYS_THROUGH, '2027-12-31');
  row('13a 2026 closures in the table', M.NYSE_HOLIDAY_TABLE.filter(h => h.date < '2027-01-01').length, 3);
  row('13a 2027 closures in the table', M.NYSE_HOLIDAY_TABLE.filter(h => h.date >= '2027-01-01').length, 10);

  /* 13b. `isoDow` against a SECOND derivation — `Intl` in UTC — rather than
     against itself. A day-of-week read one off is a walker that skips the wrong
     day, and it would look entirely ordinary. */
  const dowVia = iso => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    .indexOf(new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' })
      .format(new Date(`${iso}T12:00:00Z`)));
  for (const iso of ['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08',
                     '2026-12-25', '2027-01-01', '2027-03-26']) {
    row(`13b isoDow ${iso}`, M.isoDow(iso), dowVia(iso));
  }

  /* ── 13c. THE LABOR DAY CASE, which is the first live one ─────────────────
     A Friday 2026-09-04 AMC print must be reachable from the Tuesday morning
     passes on 2026-09-08. The walk crosses a holiday AND a weekend. */
  row('13c prevTradingDay(2026-09-08)', M.prevTradingDay('2026-09-08'), '2026-09-04');
  /* The wrong answers, printed beside it so the assertion is about the CALENDAR
     and not about arithmetic that happens to land right. */
  row('13c a naive -1 calendar day would give', M.isoAddDays('2026-09-08', -1), '2026-09-07');
  row('13c ...which is Labor Day, a full closure', M.NYSE_HOLIDAYS.has('2026-09-07'), true);
  const weekdayOnly = (() => { let c = '2026-09-08';
    for (let i = 0; i < 10; i++) { c = M.isoAddDays(c, -1); const d = M.isoDow(c); if (d !== 0 && d !== 6) return c; }
    return null; })();
  row('13c a weekday-only walk would give', weekdayOnly, '2026-09-07');
  row('13c ...so weekday-only is WRONG here', weekdayOnly !== M.prevTradingDay('2026-09-08'), true);
  row('13c ...and it is wrong by one trading session, not one day',
      M.prevTradingDay('2026-09-08') < weekdayOnly, true);

  // 13d. The ordinary weekend, both directions.
  row('13d prevTradingDay(Mon 2026-09-14)', M.prevTradingDay('2026-09-14'), '2026-09-11');
  row('13d prevTradingDay(Tue 2026-09-15)', M.prevTradingDay('2026-09-15'), '2026-09-14');
  row('13d nextTradingDay(Fri 2026-09-11)', M.nextTradingDay('2026-09-11'), '2026-09-14');
  row('13d nextTradingDay(Fri 2026-09-04) crosses Labor Day', M.nextTradingDay('2026-09-04'), '2026-09-08');
  row('13d nextTradingDay(Sat 2026-09-05)', M.nextTradingDay('2026-09-05'), '2026-09-08');

  /* 13e. Thanksgiving 2026-11-26 (Thursday) — the walk must NOT stop on the
     Friday, because 2026-11-27 is a trading day (an EARLY CLOSE, which this
     Worker deliberately does not model — see the note on NYSE_HOLIDAY_TABLE). */
  row('13e nextTradingDay(2026-11-25)', M.nextTradingDay('2026-11-25'), '2026-11-27');
  row('13e prevTradingDay(2026-11-27)', M.prevTradingDay('2026-11-27'), '2026-11-25');
  row('13e 2026-11-27 is NOT a full closure', M.NYSE_HOLIDAYS.has('2026-11-27'), false);

  /* 13f. The longest gap this calendar produces: Christmas 2026-12-25 is a
     Friday, so Thursday 2026-12-24 to Monday 2026-12-28 is a four-calendar-day
     hop — which is what `TOP3_TTL` / `LONG_ROW_TTL` / `PRINTTAPE_TTL` are all
     sized against. */
  row('13f nextTradingDay(2026-12-24)', M.nextTradingDay('2026-12-24'), '2026-12-28');
  row('13f prevTradingDay(2026-12-28)', M.prevTradingDay('2026-12-28'), '2026-12-24');
  row('13f the hop, in calendar days',
      Math.round((Date.parse('2026-12-28') - Date.parse('2026-12-24')) / 86400000), 4);

  /* 13g. THE WALKERS AND THE CRON GATE READ THE SAME CALENDAR. Two copies is how
     they drift, so every date either walker RETURNS must be open by the gate,
     and every date it SKIPS must be closed by it. Driven across a whole quarter
     rather than on the cases above. */
  let returned = 0, skipped = 0, disagreements = 0;
  for (let i = 0; i < 120; i++) {
    const d = M.isoAddDays('2026-09-01', i);
    const p = M.prevTradingDay(d);
    if (p) { returned++; if (!M.tradingDayStatus(p, M.isoDow(p)).open) disagreements++; }
    let c = d;
    for (;;) { c = M.isoAddDays(c, -1); if (c === p) break;
      skipped++; if (M.tradingDayStatus(c, M.isoDow(c)).open) disagreements++; }
  }
  row('13g dates the walker returned over 120 days', returned, 120);
  row('13g ...dates it skipped past', skipped > 40, true);
  row('13g ...and disagreements with tradingDayStatus', disagreements, 0);

  // 13h. Refusals rather than guesses.
  for (const bad of ['2026-9-8', 'yesterday', '', null, undefined, '20260908']) {
    row(`13h prevTradingDay(${j(bad)}) refuses`, M.prevTradingDay(bad), null);
  }
  /* Past the runway every weekday reads as open — the walker still answers, and
     the CALLER is the one told the calendar is stale. */
  row('13h past the runway the walk still returns a weekday',
      M.prevTradingDay('2028-06-06'), '2028-06-05');
  row('13h ...and that date is past NYSE_HOLIDAYS_THROUGH', '2028-06-05' > M.NYSE_HOLIDAYS_THROUGH, true);
}

console.log('\n== 14. THE MDB REPLAY — pre-bank -> pass 1 -> pass 2 -> carry-over ==========\n');
{
  /* ════════════════════════════════════════════════════════════════════════
     THE RECORD THIS SECTION REPLAYS IS REAL. It was read back out of the
     DEPLOYED Worker's own `/api/printtape?date=2026-09-01` at 22:09 UTC on
     2026-09-01, an hour after the `amc-pass2` firing at 21:30:23 UTC wrote it:

       print.epsActual        1.9
       print.epsEst           1.60897
       print.epsSurprisePct   18.09      (and Yahoo's own figure agreed: 18.09)
       print.quarter          2026-07-31, quarterLabel 2Q2026, reported 2026-09-01
       print.quarterVia       "consensus has ROLLED FORWARD"
       print.revActual        null   — financialsChart had no 2Q2026 entry
       print.revEst           null   — "earningsTrend 0q has rolled to 2026-10-31
                                       and NO module retains a prior quarter's
                                       revenue estimate"
       tape.window            post
       tape.price             370.99  against regularMarketPrice 434.21
       tape.changePct         -14.5598
       tape.quoteTime         2026-09-01T21:30:21.000Z
       divergent              null    — "2 are absent: revActual, revEst"

     A DOUBLE-DIGIT SELL-OFF ON AN 18% EPS BEAT — the exact shape this feature
     exists to catch — and it could not be judged, because the schedule sat
     between "the actual is not published yet" and "the consensus is already
     gone". The record was correct. The clock was wrong.

     AND THE ROLL IS MEASURED, not assumed: this repo probed MDB's
     `earningsTrend 0q` at 20:42 UTC and read 2026-07-31, then this record read
     2026-10-31 at 21:30 UTC. FORTY-EIGHT MINUTES. A first pass 30 minutes after
     the print is a coin toss against that, which is why the consensus is now
     banked a whole trading session early instead.

     WHAT IS SYNTHETIC HERE, stated rather than buried: the REVENUE figures. The
     consensus for 2026-07-31 was destroyed by Yahoo's roll before this was
     written and cannot be recovered from any module — that is the defect, not a
     gap in the capture — and the actual had not been published at all. They are
     marked SYNTHETIC at each use and chosen only so revenue BEATS. Everything
     else is transcribed from the record above.                                */
  const REV_EST_SYNTH    = 587_000_000;      // SYNTHETIC — the real one no longer exists anywhere
  const REV_ACTUAL_SYNTH = 609_120_000;      // SYNTHETIC — not published as of the capture
  const PRE_PRICE_SYNTH  = 372.50;           // SYNTHETIC — the next morning had not happened yet

  const MDB_TS   = '2026-09-01T20:00:00.000Z';   // real: the 20:00Z AMC anchor
  const REPORT   = '2026-09-01';
  const PREV_SES = '2026-08-31';                 // the session the pre-bank runs on
  const NEXT_SES = '2026-09-02';                 // the morning the carry-over runs on

  // ── The payload as it stood BEFORE the roll (the 20:42 UTC probe state) ──
  const MDB_PREBANK = {
    earningsTrend: { trend: [{ period: '0q', endDate: '2026-07-31',
      earningsEstimate: { avg: { raw: 1.60897 } },
      revenueEstimate:  { avg: { raw: REV_EST_SYNTH } } }] },
    calendarEvents: { earnings: { earningsDate: [{ raw: 1788292800 }],
      earningsAverage: { raw: 1.60897 }, revenueAverage: { raw: REV_EST_SYNTH } } },
    earnings: {
      earningsChart: { quarterly: [{ date: '1Q2026', actual: { raw: 1.00 }, estimate: { raw: 0.95 },
        periodEndDate: { fmt: '2026-04-30' }, reportedDate: { fmt: '2026-06-03' } }] },
      financialsChart: { quarterly: [{ date: '1Q2026', revenue: { raw: 549000000 } }] },
    },
    price: { marketState: 'POST', regularMarketPrice: { raw: 441.00 } },
  };

  // ── The payload as CAPTURED at 21:30 UTC: rolled, EPS actual in, revenue not ──
  const MDB_AT_PASS = {
    earningsTrend: { trend: [{ period: '0q', endDate: '2026-10-31',
      earningsEstimate: { avg: { raw: 2.05 } }, revenueEstimate: { avg: { raw: 640000000 } } }] },
    calendarEvents: { earnings: {} },
    earnings: {
      earningsChart: { quarterly: [{ date: '2Q2026', actual: { raw: 1.9 }, estimate: { raw: 1.60897 },
        surprisePct: '18.09', periodEndDate: { fmt: '2026-07-31' }, reportedDate: { fmt: '2026-09-01' } }] },
      financialsChart: { quarterly: [{ date: '1Q2026', revenue: { raw: 549000000 } }] },
    },
    price: {
      marketState: 'POST',
      regularMarketPrice: { raw: 434.21 }, regularMarketPreviousClose: { raw: 441.00 },
      postMarketPrice: { raw: 370.99 }, postMarketChangePercent: { raw: -0.145598 },
      postMarketTime: 1788298221,
    },
  };

  /* ── The payload the NEXT MORNING: revenue actual finally ingested, and the
        pre-market trading the same print. Yahoo drops the postMarket* fields
        once the pre-market session opens, which is why the post reading has to
        survive as a BANKED window rather than be re-read. */
  const MDB_NEXT_MORNING = {
    ...MDB_AT_PASS,
    earnings: {
      earningsChart: MDB_AT_PASS.earnings.earningsChart,
      financialsChart: { quarterly: [
        { date: '1Q2026', revenue: { raw: 549000000 } },
        { date: '2Q2026', revenue: { raw: REV_ACTUAL_SYNTH } },     // SYNTHETIC
      ] },
    },
    price: {
      marketState: 'PRE',
      regularMarketPrice: { raw: 434.21 }, regularMarketPreviousClose: { raw: 434.21 },
      preMarketPrice: { raw: PRE_PRICE_SYNTH },                      // SYNTHETIC
      preMarketChangePercent: { raw: (PRE_PRICE_SYNTH - 434.21) / 434.21 },
      preMarketTime: Date.parse('2026-09-02T13:00:00Z') / 1000,      // SYNTHETIC
    },
  };

  /* The record shape each pass builds, mirroring `printTapeMeasure` exactly.
     §14z below asserts against SOURCE that the real function sets the same two
     provenance fields and hands the banked quarter through, so this replay
     cannot drift away from the function it stands in for. */
  const mk = (payload, reportDate, session, passLabel, prev, isPreBank = false) => {
    const bankedQuarter = (prev && prev.schema === M.PRINTTAPE_SCHEMA && prev.print && !prev.print.status
      && typeof prev.print.quarter === 'string') ? prev.print.quarter : null;
    const print = M.printTapePrintFrom(payload, reportDate, isPreBank ? null : bankedQuarter);
    const tape = isPreBank
      ? { status: 'not-yet', reason: 'the report has not happened' }
      : M.printTapeTapeFrom(payload.price, session, MDB_TS);
    const v = M.printTapeDivergence(session, print, tape);
    return {
      schema: M.PRINTTAPE_SCHEMA, ticker: 'MDB', reportDate, session, earningsTs: MDB_TS,
      pass: passLabel, ts: Date.parse(`${reportDate}T00:00:00Z`),
      consensusSource: isPreBank ? (print.status ? 'live-pass' : 'pre-banked') : 'live-pass',
      consensusBankedTs: isPreBank && !print.status ? `${PREV_SES}T20:15:00.000Z` : null,
      print, tape, implied: { status: 'not-computed', reason: 'not part of this replay' },
      divergent: v.divergent, refusalReason: v.refusalReason,
      guidance: null, passes: [{ pass: passLabel, ts: 1 }],
    };
  };
  /* And the merge-then-RE-RUN-the-verdict step the job performs, in the order it
     performs it (§11a-bis pins that order against source). */
  const commit = (prev, next) => {
    const rec = M.mergePrintTapeRecord(prev, next);
    const merged = M.printTapeDivergence(rec.session, rec.print, rec.tape);
    rec.divergent = merged.divergent;
    rec.refusalReason = merged.refusalReason;
    if (merged.test) rec.divergenceTest = merged.test; else delete rec.divergenceTest;
    return rec;
  };

  // ── 14a. THE PRE-BANK, on the session BEFORE the report ──
  const bank = mk(MDB_PREBANK, REPORT, 'amc', 'prebank', null, true);
  row('14a the pre-bank names the quarter', bank.print.quarter, '2026-07-31');
  row('14a ...from the live consensus', /consensus still current/.test(bank.print.quarterVia || ''), true);
  row('14a EPS consensus banked (REAL)', bank.print.epsEst, 1.60897);
  row('14a revenue consensus banked (SYNTHETIC)', bank.print.revEst, REV_EST_SYNTH);
  row('14a no actual exists yet', [bank.print.epsActual, bank.print.revActual], [null, null]);
  row('14a consensusSource', bank.consensusSource, 'pre-banked');
  row('14a consensusBankedTs is stamped', typeof bank.consensusBankedTs, 'string');
  row('14a the verdict is refused, not answered', bank.divergent, null);
  row('14a ...because the report has not happened', /tape unavailable/.test(bank.refusalReason || ''), true);

  // ── 14b. PASS 1 — the captured 21:30 UTC state. The consensus has ROLLED. ──
  const p1raw = mk(MDB_AT_PASS, REPORT, 'amc', 'amc-pass1', bank);
  row('14b this pass reads NO revenue consensus at all', p1raw.print.revEst, null);
  row('14b ...because 0q has rolled to', MDB_AT_PASS.earningsTrend.trend[0].endDate, '2026-10-31');
  row('14b the EPS actual IS published (REAL)', p1raw.print.epsActual, 1.9);
  row('14b ...and the surprise matches the live record', p1raw.print.epsSurprisePct, 18.09);
  row('14b ...cross-checked against Yahoo\'s own figure', p1raw.print.epsSurpriseAgrees, true);
  const pass1 = commit(bank, p1raw);
  row('14b the merge carries the banked revenue consensus', pass1.print.revEst, REV_EST_SYNTH);
  row('14b ...and says so', pass1.print.carriedFields, ['revEst']);
  row('14b consensusSource flips to pre-banked', pass1.consensusSource, 'pre-banked');
  row('14b consensusBankedTs survives the merge', pass1.consensusBankedTs, bank.consensusBankedTs);
  row('14b the tape reads the post window', pass1.tape.usedWindow, 'post');
  row('14b ...at the REAL captured change', pass1.tape.post.changePct, -14.5598);
  /* STILL REFUSED, and for ONE reason instead of the live record's two. The
     bank has already recovered half of what was lost. */
  row('14b still refused — the revenue ACTUAL is not published', pass1.divergent, null);
  row('14b ...on revActual alone now', /1 is absent: revActual/.test(pass1.refusalReason || ''), true);
  /* THE COMPARISON THAT MAKES THAT A MEASUREMENT: the same pass with NO bank
     behind it. The live record's own refusal read "2 are absent: revActual,
     revEst"; with the bank it is one. Both counts are computed here from the
     same payload, so this is the bank's effect and not a restatement. */
  const p1noBank = commit(null, mk(MDB_AT_PASS, REPORT, 'amc', 'amc-pass1', null));
  row('14b without the bank the SAME pass is refused on two',
      /2 are absent: revActual, revEst/.test(p1noBank.refusalReason || ''), true);
  /* Against the LIVE record's own refusal string, transcribed from the deployed
     Worker's response — a different source from this replay's arithmetic. */
  row('14b ...word for word what the LIVE record said',
      (p1noBank.refusalReason || '').slice(0, 55),
      'the test needs all five inputs and 2 are absent: revActual, revEst'.slice(0, 55));
  row('14b so the bank recovered exactly one of the two inputs',
      [/revEst/.test(p1noBank.refusalReason || ''), /revEst/.test(pass1.refusalReason || '')], [true, false]);

  // ── 14c. PASS 2 — nothing has changed, and the record does not decay ──
  const pass2 = commit(pass1, mk(MDB_AT_PASS, REPORT, 'amc', 'amc-pass2', pass1));
  row('14c the banked consensus is still there', pass2.print.revEst, REV_EST_SYNTH);
  row('14c consensusSource is still pre-banked', pass2.consensusSource, 'pre-banked');
  row('14c the post tape reading is unchanged', pass2.tape.post.changePct, -14.5598);
  row('14c still refused', pass2.divergent, null);
  row('14c and the carry-over test says it needs another pass', M.printTapeNeedsCarryOver(pass2).need, true);
  row('14c ...naming the refusal as the cause', /divergent is null/.test(M.printTapeNeedsCarryOver(pass2).reason), true);

  /* ── 14d. THE CARRY-OVER, the next morning's BMO pass ──────────────────────
     Filed under the REPORT date, not the morning's date, and merging onto the
     same key. Yahoo has had overnight to publish the revenue actual, and the
     pre-market has traded the same print. */
  const carryRaw = mk(MDB_NEXT_MORNING, REPORT, 'amc', 'bmo-pass1-carryover', pass2);
  row('14d it is filed under the report date, not the morning', carryRaw.reportDate, REPORT);
  row('14d the revenue actual is published now (SYNTHETIC)', carryRaw.print.revActual, REV_ACTUAL_SYNTH);
  row('14d the pre-market window is readable', carryRaw.tape.pre.status, undefined);
  row('14d ...and the post window is not, this morning', carryRaw.tape.post.status, 'unavailable');
  const carry = commit(pass2, carryRaw);

  // THE FOUR THINGS THIS WHOLE CHANGE EXISTS TO PRODUCE:
  row('14d >>> divergent flips to TRUE', carry.divergent, true);
  row('14d >>> consensusSource', carry.consensusSource, 'pre-banked');
  row('14d >>> tape.usedWindow', carry.tape.usedWindow, 'pre');
  row('14d >>> and the post reading SURVIVED the merge', carry.tape.post.changePct, -14.5598);

  row('14d the verdict decomposes', [carry.divergenceTest.epsBeat, carry.divergenceTest.revBeat,
      carry.divergenceTest.sold], [true, true, true]);
  const preChg = +(((PRE_PRICE_SYNTH - 434.21) / 434.21) * 100).toFixed(4);
  row('14d the change it judged on', carry.divergenceTest.changePct, preChg);
  row('14d ...is the PRE reading, not the post one',
      carry.divergenceTest.changePct !== carry.tape.post.changePct, true);
  row('14d ...and it is past the -3.00 threshold', preChg <= M.PRINTTAPE_DIVERGENCE_PCT, true);
  row('14d the quote time it judged on', carry.divergenceTest.quoteTime, '2026-09-02T13:00:00.000Z');
  row('14d ...which is newer than the post quote',
      carry.divergenceTest.quoteTime > carry.tape.post.quoteTime, true);
  row('14d no refusal reason survives', carry.refusalReason, null);
  row('14d the record is COMPLETE now', M.printTapeComplete(carry), true);
  row('14d ...so nothing carries it over again', M.printTapeNeedsCarryOver(carry).need, false);
  /* THE COUNTERFACTUAL, which is what makes 14d a measurement of the FIX rather
     than of the fixture: with no pre-bank in the chain, the same three payloads
     in the same order still cannot answer, because the revenue consensus is gone
     from every module by pass 1. */
  const noBank1 = commit(null, mk(MDB_AT_PASS, REPORT, 'amc', 'amc-pass1', null));
  const noBank2 = commit(noBank1, mk(MDB_AT_PASS, REPORT, 'amc', 'amc-pass2', noBank1));
  const noBank3 = commit(noBank2, mk(MDB_NEXT_MORNING, REPORT, 'amc', 'bmo-pass1-carryover', noBank2));
  row('14e without the pre-bank, revEst is never recovered', noBank3.print.revEst, null);
  row('14e ...so the carry-over still refuses', noBank3.divergent, null);
  row('14e ...on revEst', /revEst/.test(noBank3.refusalReason || ''), true);
  row('14e so the pre-bank is what flips it', carry.divergent !== noBank3.divergent, true);
  /* And the tape half of the fix is independent of the print half: without the
     carry-over pass, the freshest window is still the post one and the verdict
     would have been judged on -14.56 at a moment the print could not be read. */
  row('14e without the carry-over pass, the used window is post', pass2.tape.usedWindow, 'post');

  /* ── 14z. THE REPLAY MIRRORS THE REAL FUNCTIONS, asserted against SOURCE ───
     `mk` and `commit` above stand in for `printTapeMeasure` and the job's
     merge-then-re-run step. If the real ones stop setting these fields the
     replay would keep passing on its own private copy, which is the failure
     mode a replay harness is most prone to. */
  const meas = grab('printTapeMeasure');
  row('14z printTapeMeasure takes the prior record', /printTapeMeasure\(env, cand, reportDate, passLabel, prev = null\)/.test(meas), true);
  row('14z ...and derives a bankedQuarter from it', /const bankedQuarter =/.test(meas), true);
  row('14z ...which it hands to printTapePrintFrom',
      /printTapePrintFrom\(r, reportDate, bankedQuarter\)/.test(meas), true);
  row('14z ...only when the prior print is a measurement',
      /prev\.print && !prev\.print\.status/.test(meas), true);
  row('14z it stamps consensusSource live-pass', /consensusSource: 'live-pass'/.test(meas), true);
  row('14z ...and a null bank timestamp', /consensusBankedTs: null/.test(meas), true);
  const preb = grab('collectPrintTapePreBank');
  row('14z the pre-bank targets the NEXT trading day', /nextTradingDay\(today\)/.test(preb), true);
  row('14z ...and refuses rather than guessing when that is null', /if \(!target\)/.test(preb), true);
  row('14z the pre-bank never calls printTapeTapeFrom', /printTapeTapeFrom\(/.test(preb), false);
  row('14z ...and never asks for guidance', /printTapeGuidance\(/.test(preb), false);
  row('14z ...and never reads a long row', /readLongRow\(/.test(preb), false);
  row('14z it stamps consensusBankedTs', /consensusBankedTs:/.test(preb), true);
}

console.log('\n== 15. GET /api/calendar/holidays — through the REAL router ==================\n');
{
  const SECRET = 'c'.repeat(64);
  let writes = 0;
  const env = {
    AI_GATE_SECRET: SECRET,
    REC_LOG: {
      async get() { throw new Error('the calendar endpoint must not read KV'); },
      async put() { writes++; throw new Error('the calendar endpoint must not write KV'); },
      async delete() { writes++; throw new Error('the calendar endpoint must not delete KV'); },
      async list() { throw new Error('the calendar endpoint must not list KV'); },
    },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const call = (url, hdrs) => worker.fetch(new Request(url, { headers: hdrs }), env, ctx);
  const OK = { Origin: 'http://localhost', 'x-dash-key': SECRET };

  // ── 15a. The gate, and it fails CLOSED ──
  row('15a no x-dash-key', (await call('https://h/api/calendar/holidays', { Origin: 'http://localhost' })).status, 401);
  row('15a wrong x-dash-key',
      (await call('https://h/api/calendar/holidays', { Origin: 'http://localhost', 'x-dash-key': 'no' })).status, 401);
  row('15a disallowed origin',
      (await call('https://h/api/calendar/holidays', { Origin: 'https://evil.example', 'x-dash-key': SECRET })).status, 403);
  row('15a AI_GATE_SECRET unset fails CLOSED',
      (await worker.fetch(new Request('https://h/api/calendar/holidays', { headers: OK }),
        { ...env, AI_GATE_SECRET: undefined }, ctx)).status, 503);
  row('15a an unknown calendar sub-route 404s',
      (await call('https://h/api/calendar/nope', OK)).status, 404);

  // ── 15b. THE ANSWER, and it touches nothing ──
  const res = await call('https://h/api/calendar/holidays?date=2026-09-08', OK);
  const body = await res.json();
  row('15b status', res.status, 200);
  row('15b charset is declared', res.headers.get('Content-Type'), 'application/json; charset=utf-8');
  /* The stub THROWS on every binding method, so a single KV touch would surface
     as a 500 rather than as a counter this test has to trust. */
  row('15b IT READS AND WRITES NO KV', writes, 0);
  row('15b the date it answered for', body.date, '2026-09-08');
  row('15b it is a trading day', body.isTradingDay, true);

  /* ── 15c. THE LABOR DAY CASE, over the wire ──────────────────────────────── */
  row('15c >>> prevTradingDay(2026-09-08)', body.prevTradingDay, '2026-09-04');
  row('15c ...which is NOT the previous calendar day', body.prevTradingDayIsPriorCalendarDay, false);
  row('15c nextTradingDay(2026-09-08)', body.nextTradingDay, '2026-09-09');
  const labor = await (await call('https://h/api/calendar/holidays?date=2026-09-07', OK)).json();
  row('15c Labor Day itself is not a trading day', labor.isTradingDay, false);
  row('15c ...with the reason named', labor.reason, 'nyse-holiday');
  row('15c ...and it is bracketed by 09-04 and 09-08',
      [labor.prevTradingDay, labor.nextTradingDay], ['2026-09-04', '2026-09-08']);
  const sat = await (await call('https://h/api/calendar/holidays?date=2026-09-05', OK)).json();
  row('15c a Saturday is refused for a DIFFERENT reason', sat.reason, 'weekend');
  row('15c ...so holiday and weekend are distinguishable', labor.reason !== sat.reason, true);

  // ── 15d. The table itself, which is the point of the endpoint ──
  row('15d holidays are served with names',
      body.holidays.find(h => h.date === '2026-09-07')?.name, 'Labor Day');
  row('15d ...the whole table', body.holidays.length, M.NYSE_HOLIDAY_TABLE.length);
  row('15d ...matching the Worker\'s own Set',
      body.holidays.every(h => M.NYSE_HOLIDAYS.has(h.date)), true);
  row('15d the runway is published', body.through, '2027-12-31');
  row('15d the calendar is not stale for this date', body.calendarStale, false);
  row('15d ...and there is no stale note when it is not', body.calendarStaleNote, null);

  /* 15e. PAST THE RUNWAY the answer is a weekend test and says so, rather than
     quietly claiming every weekday is open. */
  const past = await (await call('https://h/api/calendar/holidays?date=2028-06-06', OK)).json();
  row('15e past the runway, calendarStale', past.calendarStale, true);
  row('15e ...with a note naming the constant', /NYSE_HOLIDAYS_THROUGH/.test(past.calendarStaleNote || ''), true);
  row('15e ...and it still answers', past.prevTradingDay, '2028-06-05');

  /* 15f. EARLY CLOSES ARE OMITTED WITH THE REASON, never nulled into a list a
     consumer reads as "there are none" — the income sleeve's tax-character
     precedent. */
  row('15f earlyCloses is null', past.earlyCloses, null);
  row('15f ...with the omission explained', /NOT\s+modelled/.test(body.earlyClosesNote || ''), true);
  row('15f 2026-11-27 (an early close) is NOT in the holiday table',
      body.holidays.some(h => h.date === '2026-11-27'), false);

  // ── 15g. Date validation, same shape as /api/printtape ──
  for (const bad of ['2026-9-8', 'tomorrow', '20260908', '2026-09-08T00:00:00Z']) {
    row(`15g date ${j(bad)} is rejected`, (await call(`https://h/api/calendar/holidays?date=${encodeURIComponent(bad)}`, OK)).status, 400);
  }
  row('15g no date at all is accepted (defaults to ET today)',
      (await call('https://h/api/calendar/holidays', OK)).status, 200);

  // ── 15h. STRUCTURAL: the route, and the handler's purity ──
  const handler = grab('handleCalendarHolidays');
  row('15h the handler makes no fetch', /fetch\(/.test(handler), false);
  row('15h ...touches no binding', /REC_LOG/.test(handler), false);
  row('15h ...and reads the SAME table the cron gate does',
      /NYSE_HOLIDAY_TABLE/.test(handler) && /tradingDayStatus\(/.test(handler), true);
  const rStart = src.indexOf("case 'calendar':");
  const route = src.slice(rStart, src.indexOf('\n        }', rStart) + 10);
  row('15h route uses requireSecret', /requireSecret\(request, env, origin\)/.test(route), true);
  row('15h route does NOT use aiGuard', /aiGuard/.test(route), false);
}

console.log(`
Fixtures in §5 and §6 are transcribed from a LIVE Yahoo v10 probe on 2026-09-01
at 20:42 UTC, 42 minutes after PANW / DELL / MDB reported AMC. §14's MDB record
was read back out of the DEPLOYED Worker at 22:09 UTC the same day. None of it is
invented, except §14's REVENUE figures, which are marked SYNTHETIC at each use
because Yahoo's roll had destroyed the real consensus before this was written —
which is the defect this change exists to fix, not a gap in the capture.

BLIND SPOTS: nothing here calls Yahoo, so it cannot detect the modules changing
shape; the per-pass capCost is a DERIVATION, not a measurement; the guidance
Claude call is pinned only structurally (§11a) and never executed; and the two
cron jobs are never driven end to end — §14 replays the pure functions in the
order the job calls them, with §11 and §14z pinning that order against source.`);

/* THE FLOOR IS THE EXACT COUNT, the longarch.check.mjs rule: every section here
   is deterministic and offline — no live tape, no calendar-relative fixture — so
   there is no observed total to distinguish from a fixed one. A section that
   stops running drops the count into a NO VERDICT rather than quietly passing on
   fewer comparisons. */
process.exit(reportVerdict({
  label: 'print vs tape',
  comparisons: t.comparisons,
  failures: t.failures,
  minComparisons: 543,
}));
