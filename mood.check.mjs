/* Market Mood — the candlestick engine, the macro classifier, the stance table,
 * and every refusal path.
 *
 * Sections:
 *   1. EVERY PATTERN PREDICATE, firing AND at a non-firing boundary value. A
 *      predicate tested only where it fires is half tested: the failure this
 *      catches is a threshold written with the wrong comparator, which passes
 *      every positive case and fires on everything.
 *   2. TREND-CONTEXT RECLASSIFICATION. The SAME candle geometry must read
 *      `hammer` in a downtrend, `hanging-man` in an uptrend, and a
 *      direction-neutral name when there is no trend. Getting this backwards
 *      puts a bullish reversal label on a bearish reversal.
 *   3. EMOTION THRESHOLD BOUNDARIES, both sides, plus the symmetry the cuts
 *      claim and the fact that only an exact 0 reaches `neutral`.
 *   4. THE MACRO CLASSIFIER driven with stub per-symbol reads across every
 *      state including `mixed`, its boundaries, the index/sector weighting, and
 *      the breadth qualifier.
 *   5. THE STANCE TABLE — every macroState resolves to a category and a
 *      non-empty sentence, `unavailable` included.
 *   6. REFUSAL PATHS: one index missing, all fetches failing, wrong schema.
 *   7. THE TEMPLATE FALLBACK for every (macroState, breadth qualifier) pair.
 *   8. THE SENTENCE GUARD — what makes a model rewrite unusable, including the
 *      check that stops a rephrase becoming a reclassification.
 *   9. collectMarketMood's exact cost with stub bindings. NOT read from
 *      `_instr`: the 2:00pm branch now dispatches three jobs through
 *      `ctx.waitUntil` and `instrSince()` subtracts invocation-wide counters,
 *      so a per-job figure from that branch is an upper bound and not a
 *      measurement. Counting the calls directly is isolated by construction.
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

/* Brace/bracket-matching, not scan-to-semicolon. The stance table's sentences
   contain semicolons — a `[^;]+` grab truncates the table mid-string and the
   generated module then fails to parse, which reads as a missing constant
   rather than as a harness bug. */
function grabConst(name) {
  const key = '\nconst ' + name;
  const i = src.indexOf(key);
  if (i < 0) throw new Error('missing const ' + name);
  let j = src.indexOf('=', i + key.length) + 1;
  while (/\s/.test(src[j])) j++;
  if (src[j] === '{' || src[j] === '[') {
    let d = 0, k = j;
    do {
      const ch = src[k];
      if (ch === '{' || ch === '[') d++;
      else if (ch === '}' || ch === ']') d--;
      k++;
    } while (d > 0);
    return src.slice(i + 1, k) + ';';
  }
  return src.slice(i + 1, src.indexOf(';', j) + 1);
}

const CONSTS = [
  // TTL first: MOOD_FRESH_MS is derived from it, so the badge's staleness
  // threshold and the reader's cannot be edited apart.
  'TTL', 'SECTOR_ETFS', 'MOOD_KEY', 'MOOD_SWEEP_KEY', 'MOOD_SCHEMA', 'MOOD_TTL',
  'MOOD_FRESH_MS', 'MOOD_RANGE',
  'MOOD_MIN_BARS', 'MOOD_PRECLOSE_PT_HOUR', 'MOOD_INDEX_ETFS', 'MOOD_SYMBOLS',
  'MOOD_DOJI_BODY_MAX', 'MOOD_SPIN_BODY_MAX', 'MOOD_SPIN_SHADOW_MIN',
  'MOOD_HAMMER_SHADOW_MIN', 'MOOD_HAMMER_OPP_MAX', 'MOOD_HAMMER_BODY_MAX',
  'MOOD_MARUBOZU_BODY_MIN', 'MOOD_LONG_BODY_MIN', 'MOOD_STAR_BODY_MAX',
  'MOOD_TREND_LOOKBACK', 'MOOD_TREND_SMA', 'MOOD_PATTERN_SCORE',
  'MOOD_CTX_SMA', 'MOOD_CTX_TREND',
  'MOOD_T_EUPHORIA', 'MOOD_T_GREED', 'MOOD_T_OPTIMISM',
  'MOOD_T_CAUTION', 'MOOD_T_FEAR', 'MOOD_T_CAPITULATION',
  'MOOD_BULLISH_EMOTIONS', 'MOOD_BEARISH_EMOTIONS',
  'MOOD_INDEX_WEIGHT', 'MOOD_SECTOR_WEIGHT',
  'MOOD_M_EUPHORIA', 'MOOD_M_GREED', 'MOOD_M_RISK_ON',
  'MOOD_M_RISK_OFF', 'MOOD_M_FEAR', 'MOOD_M_CAPITULATION',
  'MOOD_BREADTH_STRONG', 'MOOD_BREADTH_SPLIT', 'MOOD_STANCE', 'MOOD_BREADTH_CLAUSE',
  'MOOD_FAULT_CAUSES',
  'MOOD_ANSWER_TOKENS', 'MOOD_SENTENCE_MAX', 'MOOD_SENTENCE_MIN', 'MOOD_SENTENCE_SCHEMA',
];
const FNS = [
  'moodBars', 'moodSettledBars', 'moodCandle',
  'moodIsDoji', 'moodIsSpinningTop', 'moodIsHammerShape', 'moodIsInvertedShape',
  'moodIsBullMarubozu', 'moodIsBearMarubozu',
  'moodIsBullEngulfing', 'moodIsBearEngulfing', 'moodIsPiercingLine', 'moodIsDarkCloudCover',
  'moodIsMorningStar', 'moodIsEveningStar', 'moodIsThreeWhiteSoldiers', 'moodIsThreeBlackCrows',
  'moodTrendAt', 'moodPatternsAt', 'moodScoreOf', 'moodEmotionOf', 'moodReadFor',
  'moodBreadthOf', 'moodBreadthQualifier', 'moodMacroFrom', 'moodStanceFor',
  'moodSentenceUsable', 'moodPrompt', 'moodMetaOk',
];

const M = new Function([
  ...CONSTS.map(grabConst),
  'const ptDate = () => "2026-08-12";',
  ...FNS.map(grab),
  `return { ${[...CONSTS, ...FNS].join(', ')} };`,
].join('\n'))();

const t = tally();
const eq = (a, b) => a === b
  || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);

function row(label, got, want) {
  const ok = record(t, eq(got, want));
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(60)} got ${String(got).padEnd(22)} want ${want}`);
}

const bar = (o, h, l, c, iso = '2026-08-11') => ({ iso, o, h, l, c });
const K = (o, h, l, c) => M.moodCandle(bar(o, h, l, c));

console.log('\n══ Market Mood ══');
console.log(`  universe ${M.MOOD_SYMBOLS.length} symbols · range ${M.MOOD_RANGE} · min bars ${M.MOOD_MIN_BARS}`);
console.log(`  emotion cuts  euphoria>=${M.MOOD_T_EUPHORIA} greed>=${M.MOOD_T_GREED} optimism>=${M.MOOD_T_OPTIMISM}`
          + ` | caution<=${M.MOOD_T_CAUTION} fear<=${M.MOOD_T_FEAR} capitulation<=${M.MOOD_T_CAPITULATION}`);
console.log(`  macro cuts    ${M.MOOD_M_CAPITULATION} / ${M.MOOD_M_FEAR} / ${M.MOOD_M_RISK_OFF} .. `
          + `${M.MOOD_M_RISK_ON} / ${M.MOOD_M_GREED} / ${M.MOOD_M_EUPHORIA}`);

/* ── 0. THE UNIVERSE ──────────────────────────────────────────────────────── */
console.log('\n§0  UNIVERSE — 4 indexes + 11 SPDR sectors, sector labels reused from SECTOR_ETFS');
row('total symbols', M.MOOD_SYMBOLS.length, 15);
row('indexes', M.MOOD_SYMBOLS.filter(s => s.group === 'index').length, 4);
row('sectors', M.MOOD_SYMBOLS.filter(s => s.group === 'sector').length, 11);
row('sector set matches SECTOR_ETFS exactly',
    M.MOOD_SYMBOLS.filter(s => s.group === 'sector').map(s => s.symbol).sort().join(','),
    Object.keys(M.SECTOR_ETFS).sort().join(','));
row('index symbols', M.MOOD_SYMBOLS.filter(s => s.group === 'index').map(s => s.symbol).join(','),
    'SPY,QQQ,DIA,IWM');
row('every entry carries a label', M.MOOD_SYMBOLS.every(s => typeof s.label === 'string' && s.label), true);
row('no duplicate symbols', new Set(M.MOOD_SYMBOLS.map(s => s.symbol)).size, 15);
row('freshness is derived from the global TTL table', M.MOOD_FRESH_MS, M.TTL.mood * 1000);
row('freshness and retention are NOT equal (a stale record must survive to be badged)',
    M.MOOD_FRESH_MS / 1000 === M.MOOD_TTL, false);
row('retention outlives freshness', M.MOOD_TTL > M.MOOD_FRESH_MS / 1000, true);

/* ── 1. PATTERN PREDICATES ────────────────────────────────────────────────── */
console.log('\n§1  PATTERN PREDICATES — each one firing, and at a NON-firing boundary');

console.log('  -- doji: |c-o| <= 10% of range --');
row(`bodyPct exactly ${M.MOOD_DOJI_BODY_MAX} fires`, M.moodIsDoji(K(100, 105, 95, 101)), true);
row('bodyPct 0.11 does NOT', M.moodIsDoji(K(100, 105, 95, 101.1)), false);
row('zero-range bar (h==l) fires nothing', M.moodIsDoji(K(100, 100, 100, 100)), false);
row('  ...and its ratios are null, not 0', K(100, 100, 100, 100).bodyPct, null);

console.log('  -- spinning top: body in (0.10, 0.30], BOTH shadows >= 0.25 --');
row('body 0.20, shadows 0.30/0.50 fires', M.moodIsSpinningTop(K(100, 105, 95, 102)), true);
row(`body exactly ${M.MOOD_SPIN_BODY_MAX} still fires`, M.moodIsSpinningTop(K(98, 105, 95, 101)), true);
row('body 0.31 does NOT', M.moodIsSpinningTop(K(98, 105, 95, 101.1)), false);
row('body in range but upper shadow 0.05 does NOT', M.moodIsSpinningTop(K(102.5, 105, 95, 104.5)), false);
row('a doji is not also a spinning top', M.moodIsSpinningTop(K(100, 105, 95, 101)), false);

console.log('  -- hammer SHAPE: body <= 0.35, lower >= 2x body, upper <= 0.25 --');
row('body 0.20, lower 7 vs 2x2 fires', M.moodIsHammerShape(K(102, 105, 95, 104)), true);
row('lower exactly 2x body fires (>=)', M.moodIsHammerShape(K(98.5, 101, 94.5, 100.5)), true);
row('lower 3.5 vs 2x2=4 does NOT', M.moodIsHammerShape(K(98.5, 101, 95, 100.5)), false);
row('zero body is a doji, NOT a hammer', M.moodIsHammerShape(K(100, 101, 90, 100)), false);

console.log('  -- inverted SHAPE: mirror image --');
row('body 0.20, upper 7 vs 2x2 fires', M.moodIsInvertedShape(K(96, 105, 95, 98)), true);
row('upper 3 vs 2x2=4 does NOT', M.moodIsInvertedShape(K(100, 105, 99, 102)), false);
row('a hammer is not an inverted hammer', M.moodIsInvertedShape(K(102, 105, 95, 104)), false);

console.log('  -- marubozu: body >= 90% of range --');
row(`bodyPct exactly ${M.MOOD_MARUBOZU_BODY_MIN}, close up, fires bullish`,
    M.moodIsBullMarubozu(K(100, 109.5, 99.5, 109)), true);
row('bodyPct 0.89 does NOT', M.moodIsBullMarubozu(K(100, 109.5, 99.5, 108.9)), false);
row('same geometry, close DOWN, fires bearish', M.moodIsBearMarubozu(K(109, 109.5, 99.5, 100)), true);
row('  ...and NOT bullish', M.moodIsBullMarubozu(K(109, 109.5, 99.5, 100)), false);

console.log('  -- engulfing: current BODY covers the prior BODY --');
{
  const pBear = K(105, 106, 99, 100), pBull = K(100, 106, 99, 105);
  row('bull engulfing fires', M.moodIsBullEngulfing(pBear, K(99.5, 106, 99, 105.5)), true);
  row('close exactly at prior open does NOT (> not >=)',
      M.moodIsBullEngulfing(pBear, K(99.5, 106, 99, 105)), false);
  row('open exactly at prior close does NOT (< not <=)',
      M.moodIsBullEngulfing(pBear, K(100, 106, 99, 105.5)), false);
  row('bear engulfing fires', M.moodIsBearEngulfing(pBull, K(105.5, 106, 99, 99.5)), true);
  row('a bull engulfing is not a bear engulfing',
      M.moodIsBearEngulfing(pBear, K(99.5, 106, 99, 105.5)), false);
}

console.log('  -- piercing / dark cloud: closes PAST the prior midpoint, not through it --');
{
  const pBear = K(110, 111, 99, 100);   // body 10/12 = 0.833, midpoint 105
  const pBull = K(100, 111, 99, 110);
  row('piercing fires (close 106 > mid 105, < open 110)',
      M.moodIsPiercingLine(pBear, K(99, 107, 98, 106)), true);
  row('close exactly AT the midpoint does NOT', M.moodIsPiercingLine(pBear, K(99, 107, 98, 105)), false);
  row('close THROUGH the prior open is an engulfing, not a piercing',
      M.moodIsPiercingLine(pBear, K(99, 112, 98, 111)), false);
  row('  ...and it IS a bull engulfing', M.moodIsBullEngulfing(pBear, K(99, 112, 98, 111)), true);
  row('prior body only 0.4 of range does NOT',
      M.moodIsPiercingLine(K(104, 111, 99, 100), K(99, 107, 98, 106)), false);
  row('dark cloud fires (close 104 < mid 105, > open 100)',
      M.moodIsDarkCloudCover(pBull, K(111, 112, 103, 104)), true);
  row('close exactly AT the midpoint does NOT', M.moodIsDarkCloudCover(pBull, K(111, 112, 103, 105)), false);
}

console.log('  -- morning / evening star: three bars, the middle one gaps --');
{
  const aBear = K(110, 111, 99, 100), aBull = K(100, 111, 99, 110);
  const starLow = K(98, 98.5, 97, 97.5), starHigh = K(112, 113, 111.5, 112.5);
  row('morning star fires', M.moodIsMorningStar(aBear, starLow, K(99, 108, 98.5, 107)), true);
  row('third bar closing exactly at the first midpoint does NOT',
      M.moodIsMorningStar(aBear, starLow, K(99, 108, 98.5, 105)), false);
  row('star that does NOT gap below the first body does NOT',
      M.moodIsMorningStar(aBear, K(100.5, 101, 99.5, 100), K(99, 108, 98.5, 107)), false);
  row('evening star fires', M.moodIsEveningStar(aBull, starHigh, K(111, 111.5, 102, 103)), true);
  row('third bar closing exactly at the first midpoint does NOT',
      M.moodIsEveningStar(aBull, starHigh, K(111, 111.5, 102, 105)), false);
  row('a morning star is not an evening star',
      M.moodIsEveningStar(aBear, starLow, K(99, 108, 98.5, 107)), false);
}

console.log('  -- three white soldiers / black crows --');
{
  const a = K(100, 104.5, 99.5, 104), b = K(102, 107.5, 101.5, 107);
  row('three white soldiers fires', M.moodIsThreeWhiteSoldiers(a, b, K(105, 110.5, 104.5, 110)), true);
  row('third bar GAPPING above the prior body does NOT',
      M.moodIsThreeWhiteSoldiers(a, b, K(108, 113.5, 107.5, 113)), false);
  row('a short third body does NOT',
      M.moodIsThreeWhiteSoldiers(a, b, K(105, 112, 104, 107.5)), false);
  const ca = K(110, 110.5, 105.5, 106), cb = K(108, 108.5, 102.5, 103);
  row('three black crows fires', M.moodIsThreeBlackCrows(ca, cb, K(105, 105.5, 99.5, 100)), true);
  row('third bar GAPPING below the prior body does NOT',
      M.moodIsThreeBlackCrows(ca, cb, K(102, 102.5, 96.5, 97)), false);
  row('soldiers are not crows', M.moodIsThreeBlackCrows(a, b, K(105, 110.5, 104.5, 110)), false);
}

/* ── 2. TREND-CONTEXT RECLASSIFICATION ────────────────────────────────────── */
console.log('\n§2  TREND CONTEXT — ONE candle geometry, THREE names');
{
  /* The last bar is byte-for-byte the same shape in all three series (body 1,
     lower shadow 6 = 6x body, upper 0.2). Only the 29 bars before it differ, so
     any difference in the reported pattern comes from trend context and from
     nothing else. */
  const plain = c => bar(c + 0.5, c + 1, c - 1, c);
  const series = (fn, last) => {
    const bars = [];
    for (let j = 0; j < 29; j++) bars.push(plain(fn(j)));
    bars.push(last);
    return bars;
  };
  const hammerAt   = c => bar(c + 1, c + 1.2, c - 6, c);
  const invertedAt = c => bar(c - 1, c + 6, c - 1.2, c);

  const down = series(j => 200 - 2 * j, hammerAt(142));
  const up   = series(j => 100 + 2 * j, invertedAt(158));
  const upH  = series(j => 100 + 2 * j, hammerAt(158));
  const downI = series(j => 200 - 2 * j, invertedAt(142));
  const flat = series(() => 150, hammerAt(150));
  const flatI = series(() => 150, invertedAt(150));

  const at = bars => M.moodPatternsAt(bars, bars.map(b => b.c), bars.length - 1);
  const trendOf = bars => M.moodTrendAt(bars.map(b => b.c), bars.length - 1);

  row('descending series reads dir=down', trendOf(down).dir, 'down');
  row('ascending series reads dir=up', trendOf(up).dir, 'up');
  row('flat series reads dir=flat', trendOf(flat).dir, 'flat');
  row('  ...flat means one vote each way or none, not "no data"', trendOf(flat).votes, 0);

  row('hammer shape in a DOWNTREND is a hammer', at(down).names.includes('hammer'), true);
  row('  ...and is NOT a hanging man', at(down).names.includes('hanging-man'), false);
  row('the SAME shape in an UPTREND is a hanging man', at(upH).names.includes('hanging-man'), true);
  row('  ...and is NOT a hammer', at(upH).names.includes('hammer'), false);
  row('the SAME shape with NO trend is direction-neutral',
      at(flat).names.includes('long-lower-shadow'), true);
  row('  ...and that neutral name scores 0', M.MOOD_PATTERN_SCORE['long-lower-shadow'], 0);

  row('inverted shape in an UPTREND is a shooting star', at(up).names.includes('shooting-star'), true);
  row('the SAME shape in a DOWNTREND is an inverted hammer',
      at(downI).names.includes('inverted-hammer'), true);
  row('the SAME shape with NO trend is direction-neutral',
      at(flatI).names.includes('long-upper-shadow'), true);

  row('the three hammer readings differ ONLY in the name',
      [at(down), at(upH), at(flat)].every(r => r.candle.body === 1 && Math.abs(r.candle.lower - 6) < 1e-9),
      true);
  row('trend below the SMA20 window returns null, not flat',
      M.moodTrendAt([1, 2, 3, 4, 5], 4), null);
  row('  ...and a null trend still yields the neutral name, never the bullish one',
      M.moodPatternsAt(down.slice(-3), down.slice(-3).map(b => b.c), 2).names.includes('long-lower-shadow'),
      true);

  console.log('  -- context contribution: at most +/-2, smaller than any confirmed reversal --');
  row('down series context is -2', M.moodScoreOf([], trendOf(down)), -2);
  row('up series context is +2', M.moodScoreOf([], trendOf(up)), +2);
  row('flat series context is 0', M.moodScoreOf([], trendOf(flat)), 0);
  row('hammer + downtrend context', M.moodScoreOf(['hammer'], trendOf(down)), 0);
  row('hanging man + uptrend context', M.moodScoreOf(['hanging-man'], trendOf(up)), 0);
  row('no trend read contributes nothing', M.moodScoreOf(['hammer'], null), 2);
  row('unknown pattern name contributes 0, never NaN', M.moodScoreOf(['not-a-pattern'], null), 0);
}

/* ── 3. EMOTION THRESHOLDS ────────────────────────────────────────────────── */
console.log('\n§3  EMOTION THRESHOLDS — both sides, boundaries inclusive');
const em = s => M.moodEmotionOf(s);
row(`score ${M.MOOD_T_EUPHORIA} (boundary)`, em(M.MOOD_T_EUPHORIA), 'euphoria');
row(`score ${M.MOOD_T_EUPHORIA - 1}`, em(M.MOOD_T_EUPHORIA - 1), 'greed');
row(`score ${M.MOOD_T_GREED} (boundary)`, em(M.MOOD_T_GREED), 'greed');
row(`score ${M.MOOD_T_GREED - 1}`, em(M.MOOD_T_GREED - 1), 'optimism');
row(`score ${M.MOOD_T_OPTIMISM} (boundary)`, em(M.MOOD_T_OPTIMISM), 'optimism');
row('score 0 is the ONLY value that reaches neutral', em(0), 'neutral');
row(`score ${M.MOOD_T_CAUTION} (boundary)`, em(M.MOOD_T_CAUTION), 'caution');
row(`score ${M.MOOD_T_FEAR + 1}`, em(M.MOOD_T_FEAR + 1), 'caution');
row(`score ${M.MOOD_T_FEAR} (boundary)`, em(M.MOOD_T_FEAR), 'fear');
row(`score ${M.MOOD_T_CAPITULATION + 1}`, em(M.MOOD_T_CAPITULATION + 1), 'fear');
row(`score ${M.MOOD_T_CAPITULATION} (boundary)`, em(M.MOOD_T_CAPITULATION), 'capitulation');
row('score -99 stays capitulation', em(-99), 'capitulation');
row('score +99 stays euphoria', em(99), 'euphoria');
row('null score is null, NOT neutral', em(null), null);
row('NaN score is null, NOT neutral', em(NaN), null);
row('cuts are symmetric about 0',
    [M.MOOD_T_EUPHORIA, M.MOOD_T_GREED, M.MOOD_T_OPTIMISM].join(','),
    [-M.MOOD_T_CAPITULATION, -M.MOOD_T_FEAR, -M.MOOD_T_CAUTION].join(','));
row('every emotion is classified bullish, bearish, or neutral',
    ['euphoria', 'greed', 'optimism', 'neutral', 'caution', 'fear', 'capitulation']
      .every(e => e === 'neutral' || M.MOOD_BULLISH_EMOTIONS.includes(e) || M.MOOD_BEARISH_EMOTIONS.includes(e)),
    true);

/* ── 4. THE MACRO CLASSIFIER ──────────────────────────────────────────────── */
console.log('\n§4  MACRO CLASSIFIER — stub reads, every state, both boundaries');
{
  /* Synthetic per-symbol scores drive the classifier directly, including
     fractional ones. The classifier takes a weighted MEAN, so a fractional
     score is the only way to sit a case exactly on a cut. */
  const reads = (idxScore, secScores) => [
    ...M.MOOD_SYMBOLS.filter(s => s.group === 'index').map(s => ({
      ...s, status: 'ok', score: idxScore, emotion: M.moodEmotionOf(idxScore),
    })),
    ...M.MOOD_SYMBOLS.filter(s => s.group === 'sector').map((s, i) => ({
      ...s, status: 'ok', score: secScores[i], emotion: M.moodEmotionOf(secScores[i]),
    })),
  ];
  const uniform = x => reads(x, Array(11).fill(x));
  const stateOf = x => M.moodMacroFrom(uniform(x)).state;

  row('denominator = 4 indexes x2 + 11 sectors x1', M.moodMacroFrom(uniform(0)).weightDenominator, 19);
  row('index weight is heavier than sector weight', M.MOOD_INDEX_WEIGHT > M.MOOD_SECTOR_WEIGHT, true);
  row('uniform score passes straight through as the mean', M.moodMacroFrom(uniform(2)).score, 2);

  row(`mean ${M.MOOD_M_EUPHORIA} (boundary) -> euphoria`, stateOf(M.MOOD_M_EUPHORIA), 'euphoria');
  row('just below -> greed', stateOf(M.MOOD_M_EUPHORIA - 0.01), 'greed');
  row(`mean ${M.MOOD_M_GREED} (boundary) -> greed`, stateOf(M.MOOD_M_GREED), 'greed');
  row('just below -> risk-on', stateOf(M.MOOD_M_GREED - 0.01), 'risk-on');
  row(`mean ${M.MOOD_M_RISK_ON} (boundary) -> risk-on`, stateOf(M.MOOD_M_RISK_ON), 'risk-on');
  row('just below -> mixed', stateOf(M.MOOD_M_RISK_ON - 0.01), 'mixed');
  row('mean 0 -> mixed', stateOf(0), 'mixed');
  row(`mean ${M.MOOD_M_RISK_OFF} (boundary) -> risk-off`, stateOf(M.MOOD_M_RISK_OFF), 'risk-off');
  row('just above -> mixed', stateOf(M.MOOD_M_RISK_OFF + 0.01), 'mixed');
  row(`mean ${M.MOOD_M_FEAR} (boundary) -> fear`, stateOf(M.MOOD_M_FEAR), 'fear');
  row('just above -> risk-off', stateOf(M.MOOD_M_FEAR + 0.01), 'risk-off');
  row(`mean ${M.MOOD_M_CAPITULATION} (boundary) -> capitulation`, stateOf(M.MOOD_M_CAPITULATION), 'capitulation');
  row('just above -> fear', stateOf(M.MOOD_M_CAPITULATION + 0.01), 'fear');
  row('all seven states are reachable',
      new Set([-5, -3, -1, 0, 1, 3, 5].map(stateOf)).size, 7);

  /* Per SYMBOL an index counts double; in AGGREGATE the 11 sectors (weight 11)
     still outweigh the 4 indexes (weight 8). Both halves are shown, because
     "the indexes are weighted heavier" is easy to misread as "the indexes
     decide", and 8 < 11 is the number that says otherwise. */
  console.log('  -- weight per symbol vs weight in aggregate --');
  row('index block weight', 4 * M.MOOD_INDEX_WEIGHT, 8);
  row('sector block weight', 11 * M.MOOD_SECTOR_WEIGHT, 11);
  // 4 x 5 x weight 2 = 40 over a denominator of 19.
  row('indexes +5, sectors 0 -> mean 40/19', Math.round(M.moodMacroFrom(reads(5, Array(11).fill(0))).score * 100) / 100, 2.11);
  row('  ...which is risk-on, not greed', M.moodMacroFrom(reads(5, Array(11).fill(0))).state, 'risk-on');
  row('indexes 0, sectors +5 -> mean 55/19', Math.round(M.moodMacroFrom(reads(0, Array(11).fill(5))).score * 100) / 100, 2.89);
  row('  ...which is greed', M.moodMacroFrom(reads(0, Array(11).fill(5))).state, 'greed');

  console.log('  -- breadth counts and the qualifier --');
  {
    const m = M.moodMacroFrom(reads(3, [3, 3, 3, 3, 3, 3, 3, 3, -3, -3, 0]));
    row('bullish sectors', m.breadth.bullish, 8);
    row('bearish sectors', m.breadth.bearish, 2);
    row('neutral sectors', m.breadth.neutral, 1);
    row('counted', m.breadth.counted, 11);
    row('8 vs 2 with a positive score -> broad', m.breadthQualifier, 'broad');
  }
  {
    const m = M.moodMacroFrom(reads(1, [3, 3, 3, 3, 3, 3, -3, -3, -3, -3, 0]));
    row('6 vs 4 -> narrow', m.breadthQualifier, 'narrow');
  }
  {
    const m = M.moodMacroFrom(reads(0, [3, 3, 3, 3, 3, -3, -3, -3, -3, -3, 0]));
    row('5 vs 5 -> split', m.breadthQualifier, 'split');
  }
  {
    const m = M.moodMacroFrom(reads(-3, [-3, -3, -3, -3, -3, -3, -3, 3, 3, 0, 0]));
    row('7 bearish with a negative score -> broad (the lead side follows the sign)',
        m.breadthQualifier, 'broad');
  }
  {
    // A sector that could not be read is counted as ABSENT, never as neutral.
    const r = reads(1, Array(11).fill(1));
    r[6] = { ...r[6], status: 'unavailable', emotion: null, score: null };
    const m = M.moodMacroFrom(r);
    row('an unreadable sector is absent, not neutral', m.breadth.absent, 1);
    row('  ...and is NOT counted as neutral', m.breadth.neutral, 0);
    row('  ...and drops out of the denominator', m.weightDenominator, 18);
    row('  ...leaving a state, not an unavailable verdict', m.state, 'risk-on');
  }
}

/* ── 5. THE STANCE TABLE ──────────────────────────────────────────────────── */
console.log('\n§5  STANCE TABLE — every macroState resolves');
const ALL_STATES = ['euphoria', 'greed', 'risk-on', 'mixed', 'risk-off', 'fear', 'capitulation', 'unavailable'];
for (const s of ALL_STATES) {
  const st = M.moodStanceFor(s);
  const ok = typeof st.category === 'string' && st.category.length > 0
          && typeof st.template === 'string' && st.template.length >= M.MOOD_SENTENCE_MIN;
  record(t, ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${s.padEnd(14)} -> ${String(st.category).padEnd(20)} "${st.template.slice(0, 62)}…"`);
}
row('every stance category is distinct', new Set(ALL_STATES.map(s => M.moodStanceFor(s).category)).size, 8);
row('an unknown state falls back to the no-read stance, NOT to mixed',
    M.moodStanceFor('not-a-state').category, M.MOOD_STANCE.unavailable.category);
row('unavailable does NOT read as a neutral market',
    M.moodStanceFor('unavailable').category === M.moodStanceFor('mixed').category, false);

/* ── 6. REFUSAL PATHS ─────────────────────────────────────────────────────── */
console.log('\n§6  REFUSAL PATHS');
{
  const mk = (over = {}) => M.MOOD_SYMBOLS.map(s => ({
    ...s, status: 'ok', score: 1, emotion: 'optimism', ...(over[s.symbol] || {}),
  }));
  const dead = { status: 'unavailable', emotion: null, score: null, reason: 'chart fetch failed — Yahoo 502' };

  const one = M.moodMacroFrom(mk({ QQQ: dead }));
  row('ONE unreadable index -> unavailable', one.state, 'unavailable');
  row('  ...cause names the class', one.unavailableCause, 'index-missing');
  row('  ...and names WHICH symbol', one.missingIndexes.join(','), 'QQQ');
  row('  ...reason is non-empty prose', typeof one.reason === 'string' && one.reason.length > 40, true);
  row('  ...score is null, NOT 0', one.score, null);
  row('  ...but the sector board still counts', one.breadth.counted, 11);
  const all4 = M.moodMacroFrom(mk({ SPY: dead, QQQ: dead, DIA: dead, IWM: dead }));
  row('ALL FOUR indexes gone -> unavailable', all4.state, 'unavailable');
  row('  ...naming all four', all4.missingIndexes.join(','), 'SPY,QQQ,DIA,IWM');
  const sectorGone = M.moodMacroFrom(mk({ XLU: dead, XLRE: dead }));
  row('two unreadable SECTORS do NOT make the verdict unavailable', sectorGone.state, 'risk-on');
  row('  ...they are reported as absent', sectorGone.breadth.absent, 2);

  console.log('  -- a symbol with too little history is unavailable, never neutral --');
  const thin = M.moodReadFor(M.MOOD_SYMBOLS[0], Array.from({ length: 12 }, (_, j) => bar(100, 101, 99, 100)));
  row('thin history -> status unavailable', thin.status, 'unavailable');
  row('  ...emotion is null, NOT neutral', thin.emotion, null);
  row('  ...score is null, NOT 0', thin.score, null);
  row('  ...changePct is null, NOT 0', thin.changePct, null);
  row('  ...and it carries a reason naming the floor',
      thin.reason.includes(String(M.MOOD_MIN_BARS)), true);
  const none = M.moodReadFor(M.MOOD_SYMBOLS[0], []);
  row('zero bars -> unavailable with a reason', none.status === 'unavailable' && !!none.reason, true);
  row('  ...and asOfClose is null, not a stale date', none.asOfClose, null);
}

console.log('  -- settled bars: today\'s bar survives a post-close run, not a pre-close one --');
{
  const bars = [bar(1, 2, 0.5, 1, '2026-08-11'), bar(1, 2, 0.5, 1, '2026-08-12')];
  row('run at 09:00 PT drops today\'s forming bar',
      M.moodSettledBars(bars, '2026-08-12', 9).bars.length, 1);
  row('  ...and says it dropped one', M.moodSettledBars(bars, '2026-08-12', 9).droppedForming, true);
  row('run at 14:00 PT (post-bell) KEEPS it',
      M.moodSettledBars(bars, '2026-08-12', 14).bars.length, 2);
  row(`  ...boundary: exactly ${M.MOOD_PRECLOSE_PT_HOUR}:00 PT keeps it`,
      M.moodSettledBars(bars, '2026-08-12', M.MOOD_PRECLOSE_PT_HOUR).bars.length, 2);
  row('a last bar dated yesterday is never dropped',
      M.moodSettledBars(bars, '2026-08-13', 9).bars.length, 2);
  row('empty input does not throw', M.moodSettledBars([], '2026-08-12', 9).bars.length, 0);
}

/* ── 7. TEMPLATE FALLBACK, every (state, qualifier) pair ──────────────────── */
console.log('\n§7  TEMPLATE FALLBACK — every (macroState, breadth qualifier) pair renders');
{
  const quals = [null, 'broad', 'narrow', 'split'];
  let pairs = 0;
  for (const s of ALL_STATES) {
    for (const q of quals) {
      const st = M.moodStanceFor(s, q);
      const base = M.MOOD_STANCE[s].sentence;
      const wantClause = (s !== 'unavailable' && q) ? M.MOOD_BREADTH_CLAUSE[q] : '';
      const ok = st.template === base + wantClause && st.template.length >= M.MOOD_SENTENCE_MIN;
      record(t, ok);
      pairs++;
      if (!ok) console.log(`  FAIL ${s} / ${q} -> "${st.template}"`);
    }
  }
  console.log(`  ok   ${pairs} (macroState, qualifier) pairs all render a non-empty template`);
  row('the breadth clause is APPENDED, not substituted',
      M.moodStanceFor('greed', 'split').template.startsWith(M.MOOD_STANCE.greed.sentence), true);
  row('unavailable takes NO breadth clause (there is no breadth to qualify)',
      M.moodStanceFor('unavailable', 'broad').template, M.MOOD_STANCE.unavailable.sentence);
  row('every template names an action, not just a mood',
      ALL_STATES.every(s => /\b(wait|do not|stand|no |trade|take|defensive|skip)/i.test(M.moodStanceFor(s).template)),
      true);
}

/* ── 8. THE SENTENCE GUARD ────────────────────────────────────────────────── */
console.log('\n§8  SENTENCE GUARD — the model may phrase, never reclassify');
{
  const good = 'Sectors are leaning risk-on together, so take the higher-conviction call setups at normal size.';
  row('a clean sentence is accepted', M.moodSentenceUsable(good, 'risk-on').ok, true);
  row('  ...and comes back trimmed', M.moodSentenceUsable('   ' + good + '  ', 'risk-on').sentence, good);
  row('naming a DIFFERENT state is rejected',
      M.moodSentenceUsable('The tape reads euphoria, so stand aside from every new position today.', 'risk-on').ok,
      false);
  row('  ...and the reason names both states',
      /euphoria/.test(M.moodSentenceUsable('The tape reads euphoria, so stand aside from every new one today.', 'risk-on').reason),
      true);
  row('naming its OWN state is fine',
      M.moodSentenceUsable('This is a risk-on tape, so press the cleaner directional setups at normal size.', 'risk-on').ok,
      true);
  row('the word "unavailable" is not treated as a rival state',
      M.moodSentenceUsable('Breadth data was unavailable for two sectors, so keep new debit size modest here.', 'mixed').ok,
      true);
  row('empty string rejected', M.moodSentenceUsable('', 'mixed').ok, false);
  row('null rejected', M.moodSentenceUsable(null, 'mixed').ok, false);
  row('non-string rejected', M.moodSentenceUsable({ sentence: 'x' }, 'mixed').ok, false);
  row(`under ${M.MOOD_SENTENCE_MIN} chars rejected`, M.moodSentenceUsable('Too short.', 'mixed').ok, false);
  row(`over ${M.MOOD_SENTENCE_MAX} chars rejected`, M.moodSentenceUsable('x'.repeat(M.MOOD_SENTENCE_MAX + 1), 'mixed').ok, false);
  row('multi-line answer rejected (it is not one sentence)',
      M.moodSentenceUsable('First line of the macro read here.\nSecond line of the macro read here.', 'mixed').ok,
      false);
  row('a rejection always carries a reason',
      typeof M.moodSentenceUsable('short', 'mixed').reason === 'string', true);

  console.log('  -- the JSON schema, not a "return strict JSON" instruction --');
  row('schema type', M.MOOD_SENTENCE_SCHEMA.type, 'object');
  row('schema returns exactly one field', Object.keys(M.MOOD_SENTENCE_SCHEMA.properties).join(','), 'sentence');
  row('additionalProperties is closed', M.MOOD_SENTENCE_SCHEMA.additionalProperties, false);
  row('no minLength/maxLength (the API schema subset rejects them)',
      JSON.stringify(M.MOOD_SENTENCE_SCHEMA).includes('inLength'), false);

  console.log('  -- the prompt states the verdict is decided --');
  const macro = { state: 'greed', score: 2.8, breadth: { bullish: 8, bearish: 2, neutral: 1, counted: 11, absent: 0 }, breadthQualifier: 'broad' };
  const p = M.moodPrompt(macro, M.moodStanceFor('greed', 'broad'), [
    { symbol: 'SPY', label: 'S&P 500', status: 'ok', emotion: 'greed', score: 4, patterns: ['bullish-marubozu'], changePct: 1.2 },
    { symbol: 'XLU', label: 'Utilities', status: 'unavailable', reason: 'chart fetch failed' },
  ]);
  row('prompt says the verdict is already decided', /ALREADY DECIDED/.test(p), true);
  row('prompt forbids changing it', /may not change it/.test(p), true);
  row('prompt carries the decided state', p.includes('DECIDED MACRO EMOTION: greed'), true);
  row('prompt carries the stance category', p.includes('wait-for-pullback'), true);
  row('prompt carries the breadth counts', p.includes('8 bullish, 2 bearish'), true);
  row('prompt reports an unreadable symbol as no reading, not as neutral',
      /XLU \(Utilities\): no reading/.test(p), true);
  row('prompt does NOT ask for strict JSON in prose', /strict json/i.test(p), false);
}

/* ── 9. COST AND THE WRITE CONTRACT, with stub bindings ───────────────────── */
console.log('\n§9  collectMarketMood — cost counted directly, and the stamp contract');
{
  let fetches = 0, claudeCalls = 0;
  let yahooImpl = null, claudeImpl = null;

  const chart = (n = 60, endIso = '2026-08-11') => {
    const day = Math.floor(Date.UTC(2026, 4, 1) / 1000);
    const timestamp = [], open = [], high = [], low = [], close = [];
    for (let j = 0; j < n; j++) {
      const c = 100 + j * 0.5;
      timestamp.push(day + j * 86400);
      open.push(c - 0.2); high.push(c + 0.6); low.push(c - 0.6); close.push(c);
    }
    // Pin the final bar's date to endIso so the settled-bar guard is exercised.
    timestamp[n - 1] = Math.floor(Date.parse(endIso + 'T20:00:00Z') / 1000);
    return { chart: { result: [{ timestamp, indicators: { quote: [{ open, high, low, close }] } }] } };
  };

  const mkEnv = (existing = {}, failPut = null) => {
    const calls = [];
    return {
      calls,
      env: {
        ANTHROPIC_API_KEY: 'test',
        REC_LOG: {
          get: async (k) => { calls.push(['get', k]); return existing[k] ?? null; },
          put: async (k, v) => {
            // The body rides along so a test can read what was ACTUALLY stored,
            // rather than inferring it from the fact that a put happened.
            calls.push(['put', k, typeof v === 'string' ? v.length : 0, v]);
            if (failPut && k === failPut) throw new Error('KV down');
          },
          delete: async (k) => { calls.push(['delete', k]); },
        },
      },
    };
  };

  const C = new Function([
    ...CONSTS.map(grabConst),
    'const ptDate = () => "2026-08-12";',
    'const instrMark = () => ({});',
    'const instrSince = (m, phase) => ({ phase });',
    'const allSettledCounted = async (ps) => Promise.allSettled(ps);',
    'const yahoo = async (path, search) => { bumpFetch(); return yahooImpl(path, search); };',
    'const workerClaude = async (...a) => { bumpClaude(); return claudeImpl(...a); };',
    ...FNS.map(grab),
    grab('collectMarketMood'),
    grab('readMarketMood'),
    'return { collectMarketMood, readMarketMood };',
  ].join('\n'))();

  globalThis.bumpFetch  = () => { fetches++; };
  globalThis.bumpClaude = () => { claudeCalls++; };
  Object.defineProperty(globalThis, 'yahooImpl',  { get: () => yahooImpl,  configurable: true });
  Object.defineProperty(globalThis, 'claudeImpl', { get: () => claudeImpl, configurable: true });

  const okChart  = async () => chart();
  const okClaude = async () => ({
    text: JSON.stringify({ sentence: 'Breadth is leaning constructive across the board, so take the cleaner directional setups at normal size.' }),
    stopReason: 'end_turn',
  });

  // -- happy path --
  {
    fetches = 0; claudeCalls = 0; yahooImpl = okChart; claudeImpl = okClaude;
    const { calls, env } = mkEnv();
    await C.collectMarketMood(env);
    row('external fetches: 15 charts', fetches, 15);
    row('Anthropic calls: exactly 1', claudeCalls, 1);
    row('TOTAL extFetches (charts + Claude)', fetches + claudeCalls, 16);
    row('binding gets (the dedup probe)', calls.filter(c => c[0] === 'get').length, 1);
    row('binding puts (mood:state + dedup)', calls.filter(c => c[0] === 'put').length, 2);
    row('TOTAL bindingOps', calls.length, 3);
    row('TOTAL capCost = ext + binding', fetches + claudeCalls + calls.length, 19);
    row('dedup stamped LAST', calls[calls.length - 1][1], M.MOOD_SWEEP_KEY);
    row('dedup key is OUTSIDE the mood: prefix', M.MOOD_SWEEP_KEY.startsWith('mood:'), false);
    const stored = calls.find(c => c[1] === M.MOOD_KEY);
    row('payload is a few KB, not tens', stored[2] < 20000, true);
    console.log(`       calls: ${calls.map(c => `${c[0]} ${c[1]}${c[2] ? ` (${c[2]}B)` : ''}`).join(' | ')}`);
  }

  // -- already ran today --
  {
    fetches = 0; claudeCalls = 0;
    const { calls, env } = mkEnv({ [M.MOOD_SWEEP_KEY]: '2026-08-12' });
    await C.collectMarketMood(env);
    row('deduped run makes NO fetch', fetches, 0);
    row('deduped run makes NO Claude call', claudeCalls, 0);
    row('deduped run costs exactly one get', calls.length, 1);
  }

  // -- REFUSAL: every fetch fails --
  {
    fetches = 0; claudeCalls = 0;
    yahooImpl = async () => { throw new Error('Yahoo 502'); };
    const { calls, env } = mkEnv();
    await C.collectMarketMood(env);
    row('all fetches failing writes NOTHING', calls.filter(c => c[0] === 'put').length, 0);
    row('  ...and makes no Claude call', claudeCalls, 0);
    row('  ...and does NOT stamp the dedup key',
        calls.some(c => c[0] === 'put' && c[1] === M.MOOD_SWEEP_KEY), false);
    yahooImpl = okChart;
  }

  // -- PARTIAL: one index down. Stores, does NOT stamp. --
  {
    fetches = 0; claudeCalls = 0;
    yahooImpl = async (path) => { if (path.includes('QQQ')) throw new Error('Yahoo 502'); return chart(); };
    const { calls, env } = mkEnv();
    await C.collectMarketMood(env);
    const put = calls.find(c => c[0] === 'put' && c[1] === M.MOOD_KEY);
    row('a missing index still STORES the payload', !!put, true);
    row('  ...but does NOT stamp the dedup key, so the next firing retries',
        calls.some(c => c[0] === 'put' && c[1] === M.MOOD_SWEEP_KEY), false);
    row('  ...and spends NO Claude call on an unavailable verdict', claudeCalls, 0);
    yahooImpl = okChart;
  }

  // -- PARTIAL: one sector down. Verdict survives; still no stamp. --
  {
    fetches = 0; claudeCalls = 0;
    yahooImpl = async (path) => { if (path.includes('XLU')) throw new Error('Yahoo 502'); return chart(); };
    const { calls, env } = mkEnv();
    await C.collectMarketMood(env);
    row('a missing SECTOR still produces a verdict, so Claude runs', claudeCalls, 1);
    row('  ...the payload is stored', calls.some(c => c[0] === 'put' && c[1] === M.MOOD_KEY), true);
    row('  ...and the run is still incomplete, so no stamp',
        calls.some(c => c[0] === 'put' && c[1] === M.MOOD_SWEEP_KEY), false);
    yahooImpl = okChart;
  }

  // -- The KV write failing must also leave the dedup key unstamped. --
  {
    const { calls, env } = mkEnv({}, M.MOOD_KEY);
    await C.collectMarketMood(env);
    row('a failed payload write leaves the dedup key unstamped',
        calls.some(c => c[0] === 'put' && c[1] === M.MOOD_SWEEP_KEY), false);
  }

  // -- The Claude half degrades to the template and never blocks the write. --
  {
    claudeImpl = async () => { throw new Error('Claude 529 overloaded'); };
    const { calls, env } = mkEnv();
    await C.collectMarketMood(env);
    const body = JSON.parse(calls.find(c => c[0] === 'put' && c[1] === M.MOOD_KEY)?.[3] || 'null');
    row('a Claude failure still stores the payload',
        calls.some(c => c[0] === 'put' && c[1] === M.MOOD_KEY), true);
    row('  ...and still stamps, because the DATA half completed',
        calls.some(c => c[0] === 'put' && c[1] === M.MOOD_SWEEP_KEY), true);
    row('  ...sentenceSource says template, not claude', body.sentenceSource, 'template');
    row('  ...the sentence IS the template, not a blank', body.sentence, body.template);
    row('  ...and the note names the failure', /529/.test(body.sentenceNote), true);
  }
  {
    claudeImpl = async () => ({ text: '{"sentence":"cut off mid', stopReason: 'max_tokens' });
    const { calls, env } = mkEnv();
    await C.collectMarketMood(env);
    const body = JSON.parse(calls.find(c => c[0] === 'put' && c[1] === M.MOOD_KEY)?.[3] || 'null');
    row('a max_tokens answer falls back to the template', body.sentenceSource, 'template');
    row('  ...and the note says the cap was hit', /token cap/.test(body.sentenceNote), true);
  }
  {
    // A well-formed answer that reclassifies must be refused too.
    claudeImpl = async () => ({
      text: JSON.stringify({ sentence: 'The tape has tipped into euphoria, so stand down on every new position today.' }),
      stopReason: 'end_turn',
    });
    const { calls, env } = mkEnv();
    await C.collectMarketMood(env);
    const body = JSON.parse(calls.find(c => c[0] === 'put' && c[1] === M.MOOD_KEY)?.[3] || 'null');
    row('a model sentence naming a DIFFERENT state is refused', body.sentenceSource, 'template');
    row('  ...the stored state is the one the RULES decided', body.state, 'risk-on');
    row('  ...and the note says why it was rejected', /rejected/.test(body.sentenceNote), true);
  }
  {
    const { calls, env } = mkEnv();
    claudeImpl = okClaude;
    await C.collectMarketMood(env);
    const body = JSON.parse(calls.find(c => c[0] === 'put' && c[1] === M.MOOD_KEY)?.[3] || 'null');
    row('a usable sentence is stored and sourced to claude', body.sentenceSource, 'claude');
    row('  ...and the state is STILL the rules-decided one', body.state, 'risk-on');
    row('  ...the payload declares it ranks nothing', body.usedForRanking, false);
    row('  ...every symbol row carries a status', body.symbols.every(s => !!s.status), true);
    row('  ...and the board is 15 rows', body.symbols.length, 15);
  }

  // -- readMarketMood: schema, and the three missing-record causes --
  console.log('  -- readMarketMood: strict schema equality, and the three causes --');
  {
    const read = async (existing) => {
      const { env } = mkEnv(existing);
      return C.readMarketMood(env);
    };
    const goodRec = { schema: M.MOOD_SCHEMA, state: 'greed', ts: Date.now(), sentence: 'x'.repeat(50) };
    row('a matching schema reads through', (await read({ [M.MOOD_KEY]: goodRec })).state, 'greed');
    row('  ...and reports its own age', Number.isFinite((await read({ [M.MOOD_KEY]: goodRec })).ageMs), true);
    const older = { ...goodRec, schema: M.MOOD_SCHEMA - 1 };
    row('schema 0 retires rather than rendering', (await read({ [M.MOOD_KEY]: older })).state, 'unavailable');
    row('  ...naming schema as the cause', (await read({ [M.MOOD_KEY]: older })).unavailableCause, 'schema');
    const newer = { ...goodRec, schema: M.MOOD_SCHEMA + 1 };
    row('schema 2 ALSO retires (strict equality, not >=)',
        (await read({ [M.MOOD_KEY]: newer })).unavailableCause, 'schema');
    row('nothing stored, never swept -> never-collected',
        (await read({})).unavailableCause, 'never-collected');
    row('swept TODAY but no record -> record-missing',
        (await read({ [M.MOOD_SWEEP_KEY]: '2026-08-12' })).unavailableCause, 'record-missing');
    row('swept days ago and not since -> stale-sweep',
        (await read({ [M.MOOD_SWEEP_KEY]: '2026-08-05' })).unavailableCause, 'stale-sweep');
    row('  ...and stale-sweep is the one that names the grep',
        /MOOD-COLLECT/.test((await read({ [M.MOOD_SWEEP_KEY]: '2026-08-05' })).reason), true);
    row('a cold start does NOT read as a failure',
        /NOT a data failure/.test((await read({})).reason), true);
    row('every unavailable read carries a stance, not a blank',
        (await read({})).stance, M.MOOD_STANCE.unavailable.category);
    row('  ...and score stays null, never 0', (await read({})).score, null);
    row('a record with no ts reads as stale rather than fresh',
        (await read({ [M.MOOD_KEY]: { ...goodRec, ts: null } })).stale, true);
  }
}

/* ── 10. _meta.ok — WHICH CAUSES ARE FAULTS ───────────────────────────────── */
console.log('\n§10 _meta.ok — a cold start is not a fault, and the badge must not say it is');
{
  /* THE BUG THIS PINS: `ok` was `state !== 'unavailable'`, so `never-collected`
     rendered `.src-tag.bad` — a RED provenance badge — beside a chip that was
     deliberately neutral for the same state. One fact, two elements, opposite
     tones. Verified against the live deployed Worker on 2026-08-13 before the
     fix: badgeClass "src-tag bad delayed" on a cold start. */
  const rec = (state, cause) => ({ state, unavailableCause: cause });
  row('a populated state is ok', M.moodMetaOk(rec('mixed', null)), true);
  row('every non-unavailable state is ok',
      ['euphoria', 'greed', 'risk-on', 'mixed', 'risk-off', 'fear', 'capitulation']
        .every(s => M.moodMetaOk(rec(s, null))), true);
  row('never-collected is NOT a fault (cold start)', M.moodMetaOk(rec('unavailable', 'never-collected')), true);
  row('schema is NOT a fault (an old record retiring after a deploy)',
      M.moodMetaOk(rec('unavailable', 'schema')), true);
  row('stale-sweep IS a fault', M.moodMetaOk(rec('unavailable', 'stale-sweep')), false);
  row('record-missing IS a fault', M.moodMetaOk(rec('unavailable', 'record-missing')), false);
  row('an unknown cause defaults to NOT a fault (never invent a failure)',
      M.moodMetaOk(rec('unavailable', 'something-new')), true);
  row('null record is ok rather than throwing', M.moodMetaOk(null), true);
  row('fault list is exactly the two', M.MOOD_FAULT_CAUSES.join(','), 'stale-sweep,record-missing');

  /* The frontend tones its chip from `faultCauses` on the payload plus its own
     two client-only causes. These must agree, or the badge and the chip diverge
     again — which is the whole defect this section exists for. */
  const page = fs.readFileSync('dashboard.html', 'utf8');
  row('the page reads faultCauses off the payload', /data\?\.faultCauses/.test(page), true);
  row('  ...with the Worker list as its deploy-window fallback',
      /\['stale-sweep', 'record-missing'\]/.test(page), true);
  row('  ...and adds only the client-only causes the Worker cannot send',
      /CLIENT_FAULT_CAUSES = \['request-failed'\]/.test(page), true);
  row('endpoint-absent is NOT toned as a fault (it is a deploy window)',
      /CLIENT_FAULT_CAUSES = \[[^\]]*endpoint-absent/.test(page), false);
  row('the unavailable detail panel does not repeat the reason',
      /the reason is stated above the fold/.test(page), true);
}

const populationOk = populated('mood engine', M.MOOD_SYMBOLS.length, ALL_STATES.length);
if (!populationOk) t.failures++;

process.exit(reportVerdict({
  label: 'Market Mood',
  comparisons: t.comparisons,
  failures: t.failures,
  minComparisons: 287,
}));
