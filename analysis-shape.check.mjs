/* The canonical `analysis:{TICKER}` record — one shape, two writers, and the
 * spend leak that the disagreement was funding.
 *
 * WHY THIS EXISTS. Two writers share this key and used to disagree about its
 * shape. The nightly pass (`ANALYSIS_SCHEMA`) wrote `recommendation` +
 * `drivers[]`; `POST /api/ai/synthesis` (`AI_SYNTHESIS_SCHEMA`) wrote `action` +
 * `factors{}` and no `recommendation` at all. Both directions were already broken
 * in production, and neither was cosmetic:
 *
 *   - `handleWatchlistBatch` gated on `cached.recommendation`, so a
 *     synthesis-written record read as UNANALYSED and the row queued a fresh
 *     Claude call. Opening a ticker page invalidated that name's watchlist row and
 *     bought a second analysis for a name already analysed — up to 30 per batch.
 *   - `renderSynthesis` in index.html read `factors{}`, so a nightly-written
 *     record painted four sentiment bars at `?? 50`. A missing measurement
 *     rendered as a measured neutral.
 *
 * Unified 2026-08-20. REQUIRED CORE `rating · confidence · recommendation ·
 * drivers[] · summary` from both writers; `factors{}` and `thesis` optional and
 * synthesis-only; `trend` / `pattern` / `action` dropped (zero readers, verified
 * by grep across worker.js, index.html and dashboard.html).
 *
 * Sections:
 *   1. `readAnalysisRecord` across every era that can be in KV right now.
 *   2. The `action` -> `recommendation` mapping is a RENAME, and `drivers` stays
 *      NULL on a legacy record rather than being manufactured from `factors`.
 *      Six factor notes are sitting right there and using them would put an
 *      unearned "these decided the call, in this order" claim on screen.
 *   3. THE SPEND LEAK, driven both ways: the OLD gate and the NEW gate over the
 *      same records, then the real `needsAnalysis` predicate LIFTED FROM SOURCE.
 *      Asserting the new gate alone would not show the leak was ever there.
 *   4. `legacy-quartet` must STILL regenerate. The fix loosens a gate, and a
 *      loosened gate that also swallows the pre-consolidation shape would put a
 *      rating badge on screen with an empty call beside it.
 *   5. `analysisRecordPayload` OMITS the optional half rather than nulling it,
 *      and never emits the three dropped fields.
 *   6. Both schemas agree on the core, at the source level.
 *   7. index.html no longer defaults a factor score to 50 anywhere.
 */
import fs from 'fs';
import { tally, record, reportVerdict, populated } from './check-harness.mjs';

const src  = fs.readFileSync('worker.js', 'utf8');
const page = fs.readFileSync('index.html', 'utf8');

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
/* Brace-matching, not scan-to-semicolon: these schema objects are multi-line
   literals and a `[^;]+` grab truncates them — the `mood.check.mjs` lesson. */
function grabObjConst(name) {
  const key = `const ${name} = {`;
  const i = src.indexOf(key);
  if (i < 0) throw new Error('missing const ' + name);
  let d = 0, k = src.indexOf('{', i);
  do { if (src[k] === '{') d++; else if (src[k] === '}') d--; k++; } while (d > 0);
  return src.slice(i, k) + ';';
}

const M = new Function([
  grabObjConst('AI_FACTOR_SCHEMA'), grabObjConst('AI_SYNTHESIS_SCHEMA'),
  grabObjConst('ANALYSIS_SCHEMA'),
  grab('readAnalysisRecord'), grab('analysisRecordPayload'),
  'return { readAnalysisRecord, analysisRecordPayload, AI_SYNTHESIS_SCHEMA, ANALYSIS_SCHEMA };',
].join('\n'))();

const t = tally();
const pad = (s, n) => String(s).padEnd(n);
const j = v => JSON.stringify(v);
function row(label, got, want, ok = Object.is(got, want)) {
  record(t, ok);
  console.log(`  ${pad(label, 46)} got ${pad(j(got), 22)} want ${pad(j(want), 22)} ${ok ? 'ok' : '<<< MISMATCH'}`);
}
const eq = (a, b) => j(a) === j(b);

const TS = Date.parse('2026-08-20T14:00:00Z');

/* The four records that can be in KV on the morning of the deploy. */
const CANONICAL = {
  rating: 'BUY', confidence: 72, recommendation: 'Buy dips to $85, stop below $79',
  drivers: ['Momentum: 3M +18%', 'Macro: CPI risk Wed'], summary: 'Two sentences here. And another.',
  ts: TS,
};
const CANONICAL_RICH = {
  ...CANONICAL,
  factors: { technical: { score: 71, note: 'uptrend intact', narrative: 'n' } },
  thesis: 'Para one.\n\nPara two.',
};
const LEGACY_SYNTHESIS = {
  rating: 'HOLD', confidence: 55, trend: 'Sideways since June', pattern: 'Bull flag',
  action: 'Hold above $200, trim into $240', summary: 'Two sentences here. And another.',
  factors: {
    technical:   { score: 61, note: 'flag holding',   narrative: 'n' },
    fundamental: { score: 48, note: 'margins flat',   narrative: 'n' },
    sentiment:   { score: 44, note: 'headlines mixed', narrative: 'n' },
    analyst:     { score: 66, note: 'targets rising', narrative: 'n' },
    insider:     { score: 50, note: 'no activity',    narrative: 'n' },
    macro:       { score: 39, note: 'CPI overhang',   narrative: 'n' },
  },
  thesis: 'Para one.\n\nPara two.',
  ts: TS,
};
const LEGACY_QUARTET = { rating: 'SELL', confidence: 40, trend: 'Down', pattern: 'Head and shoulders', ts: TS };

console.log('\n== 1. readAnalysisRecord across every era in KV today ========================\n');
{
  const c = M.readAnalysisRecord(CANONICAL);
  row('canonical era',            c.era, 'canonical');
  row('canonical ok',             c.ok, true);
  row('canonical reason',         c.reason, null);
  row('canonical recommendation', c.recommendation, CANONICAL.recommendation);
  row('canonical drivers count',  c.drivers?.length, 2);
  row('canonical driversSource',  c.driversSource, 'record');
  row('canonical factors absent', c.factors, null);
  row('canonical thesis absent',  c.thesis, null);

  const r = M.readAnalysisRecord(CANONICAL_RICH);
  row('canonical+rich era',       r.era, 'canonical');
  row('canonical+rich ok',        r.ok, true);
  row('canonical+rich has factors', !!r.factors, true);
  row('canonical+rich has thesis',  !!r.thesis, true);

  const l = M.readAnalysisRecord(LEGACY_SYNTHESIS);
  row('legacy-synthesis era',     l.era, 'legacy-synthesis');
  row('legacy-synthesis ok',      l.ok, true);
  row('legacy-synthesis rating',  l.rating, 'HOLD');
  row('legacy-synthesis conf',    l.confidence, 55);

  const q = M.readAnalysisRecord(LEGACY_QUARTET);
  row('legacy-quartet era',       q.era, 'legacy-quartet');
  row('legacy-quartet ok',        q.ok, false);
  row('legacy-quartet keeps rating', q.rating, 'SELL');
  row('legacy-quartet reason',    q.reason, 'pre-consolidation record: rating only, no actionable call');

  row('null -> absent',           M.readAnalysisRecord(null).era, 'absent');
  row('null -> not ok',           M.readAnalysisRecord(null).ok, false);
  row('string -> absent',         M.readAnalysisRecord('nope').era, 'absent');
  row('empty object -> absent',   M.readAnalysisRecord({}).era, 'absent');
  row('bad rating rejected',      M.readAnalysisRecord({ ...CANONICAL, rating: 'STRONG BUY' }).rating, null);
  row('bad rating -> not ok',     M.readAnalysisRecord({ ...CANONICAL, rating: 'STRONG BUY' }).ok, false);
  row('blank recommendation',     M.readAnalysisRecord({ ...CANONICAL, recommendation: '   ' }).ok, false);
  row('non-numeric confidence',   M.readAnalysisRecord({ ...CANONICAL, confidence: 'high' }).confidence, null);
  row('confidence 0 survives',    M.readAnalysisRecord({ ...CANONICAL, confidence: 0 }).confidence, 0);
}

console.log('\n== 2. action -> recommendation is a RENAME; drivers are NOT manufactured =====\n');
{
  const l = M.readAnalysisRecord(LEGACY_SYNTHESIS);
  row('legacy action mapped across',   l.recommendation, LEGACY_SYNTHESIS.action);
  row('drivers stay NULL',             l.drivers, null);
  row('driversSource names the case',  l.driversSource, 'not-in-legacy-synthesis-shape');
  // The temptation, made explicit: six factor notes exist and none became a driver.
  row('factor notes available',        Object.keys(LEGACY_SYNTHESIS.factors).length, 6);
  row('none of them became a driver',  l.drivers === null, true);

  // A canonical record that carries recommendation AND action prefers the canonical
  // field — otherwise a rewritten record could regress to its own legacy value.
  const both = M.readAnalysisRecord({ ...CANONICAL, action: 'STALE legacy action' });
  row('canonical wins over action',    both.recommendation, CANONICAL.recommendation);
  row('and the era is canonical',      both.era, 'canonical');

  // Empty drivers array is not "some drivers".
  row('empty drivers[] -> null',       M.readAnalysisRecord({ ...CANONICAL, drivers: [] }).drivers, null);
  row('drivers with blanks filtered',
      M.readAnalysisRecord({ ...CANONICAL, drivers: ['Real one', '', '  '] }).drivers?.length, 1);
}

console.log('\n== 3. THE SPEND LEAK - old gate vs new gate, then the real predicate ========\n');
{
  /* Driven BOTH ways on purpose. Asserting only that the new gate passes would not
     show the leak was ever there, and a test that cannot reproduce the bug cannot
     prove the fix. The old gate is the literal expression that shipped. */
  const oldGate = c => !!(c && c.recommendation);
  const newGate = c => M.readAnalysisRecord(c).ok;

  const cases = [
    ['canonical',        CANONICAL,        true,  true ],
    ['legacy-synthesis', LEGACY_SYNTHESIS, false, true ],   // <- the leak
    ['legacy-quartet',   LEGACY_QUARTET,   false, false],
    ['absent',           null,             false, false],
  ];
  console.log('     record            old gate   new gate   verdict');
  for (const [name, rec, oldWant, newWant] of cases) {
    const o = oldGate(rec), n = newGate(rec);
    const note = (!o && n) ? 'LEAK CLOSED' : (o === n) ? 'unchanged' : 'CHANGED';
    console.log(`     ${pad(name, 18)}${pad(o, 11)}${pad(n, 11)}${note}`);
    row(`  ${name}: old gate`, o, oldWant);
    row(`  ${name}: new gate`, n, newWant);
  }

  /* The real predicate, LIFTED FROM SOURCE so it cannot drift away from this test.
     `needsAnalysis` is what decides the Claude fan-out; testing a hand-copy of it
     would be testing the copy. */
  const m = src.match(/const needsAnalysis = tickers\.filter\((.+?)\);/s);
  row('needsAnalysis predicate found in source', !!m, true);
  if (m && populated('predicate cases', cases.length)) {
    console.log(`     predicate: tickers.filter(${m[1]})`);
    const needsAnalysis = new Function('tickers', 'stocks',
      `return tickers.filter(${m[1]});`);

    // Build the stocks map exactly as handleWatchlistBatch does: the row's
    // `recommendation` is whatever the normaliser yielded.
    const stocks = {};
    for (const [name, rec] of cases) {
      const r = M.readAnalysisRecord(rec);
      const usable = r.ok && Date.now() - (r.ts || 0) < 172_800_000;
      stocks[name] = { symbol: name, recommendation: usable ? r.recommendation : null };
    }
    const queued = needsAnalysis(cases.map(c => c[0]), stocks);
    console.log(`     queued for a Claude call: ${j(queued)}`);

    row('synthesis record does NOT queue a call', queued.includes('legacy-synthesis'), false);
    row('canonical record does NOT queue a call', queued.includes('canonical'), false);
    row('legacy-quartet DOES queue a call',       queued.includes('legacy-quartet'), true);
    row('absent DOES queue a call',               queued.includes('absent'), true);
    row('exactly two names queued',               queued.length, 2);

    // And the same map built under the OLD gate, to show what it used to cost.
    const oldStocks = {};
    for (const [name, rec] of cases) {
      const usable = oldGate(rec) && Date.now() - (rec?.ts || 0) < 172_800_000;
      oldStocks[name] = { symbol: name, recommendation: usable ? rec.recommendation : null };
    }
    const oldQueued = needsAnalysis(cases.map(c => c[0]), oldStocks);
    console.log(`     under the OLD gate:       ${j(oldQueued)}`);
    row('old gate queued the synthesis record',   oldQueued.includes('legacy-synthesis'), true);
    row('old gate queued one more than new',      oldQueued.length - queued.length, 1);
  }

  // The stale-record path is unchanged: an old-enough record still regenerates.
  const stale = M.readAnalysisRecord({ ...CANONICAL, ts: Date.now() - 200_000_000 });
  row('stale canonical still ok (age is a separate test)', stale.ok, true);
  row('stale canonical fails the age window',
      Date.now() - stale.ts < 172_800_000, false);
}

console.log('\n== 4. legacy-quartet must STILL regenerate - the gate loosened, not opened ===\n');
{
  /* The fix widens what counts as analysed. The pre-consolidation shape must not
     be swept in with it: it carries a rating and nothing actionable, and the
     original guard was right to refuse it. */
  const q = M.readAnalysisRecord(LEGACY_QUARTET);
  row('not ok',                    q.ok, false);
  row('no recommendation',         q.recommendation, null);
  row('trend/pattern do not count', q.recommendation ?? null, null);
  row('rating still readable for the alignment tag', q.rating, 'SELL');
  // A quartet record with a summary but still no call: also refused.
  const withSummary = M.readAnalysisRecord({ ...LEGACY_QUARTET, summary: 'Two sentences.' });
  row('quartet + summary still refused', withSummary.ok, false);
}

console.log('\n== 5. analysisRecordPayload - OMITS the optional half, never nulls it =======\n');
{
  const lean = M.analysisRecordPayload(M.readAnalysisRecord(CANONICAL));
  row('lean: factors key absent',   'factors' in lean, false);
  row('lean: thesis key absent',    'thesis' in lean, false);
  row('lean: has recommendation',   lean.recommendation, CANONICAL.recommendation);
  row('lean: schemaEra shipped',    lean.schemaEra, 'canonical');
  row('lean: driversSource shipped',lean.driversSource, 'record');

  const rich = M.analysisRecordPayload(M.readAnalysisRecord(CANONICAL_RICH));
  row('rich: factors key present',  'factors' in rich, true);
  row('rich: thesis key present',   'thesis' in rich, true);

  const legacy = M.analysisRecordPayload(M.readAnalysisRecord(LEGACY_SYNTHESIS));
  row('legacy: era travels',        legacy.schemaEra, 'legacy-synthesis');
  row('legacy: factors survive',    'factors' in legacy, true);
  row('legacy: drivers null, named',legacy.driversSource, 'not-in-legacy-synthesis-shape');

  // The three dropped fields must not reappear on any payload.
  for (const k of ['trend', 'pattern', 'action']) {
    row(`payload never carries ${k}`,
        [lean, rich, legacy].some(p => k in p), false);
  }
}

console.log('\n== 6. Both schemas agree on the required core ================================\n');
{
  const CORE = ['rating', 'confidence', 'recommendation', 'drivers', 'summary'];
  const nightly = M.ANALYSIS_SCHEMA.required;
  const synth   = M.AI_SYNTHESIS_SCHEMA.required;
  if (populated('schema required arrays', nightly.length, synth.length)) {
    console.log(`     nightly required: ${j(nightly)}`);
    console.log(`     synth   required: ${j(synth)}`);
    for (const f of CORE) {
      row(`nightly requires ${f}`, nightly.includes(f), true);
      row(`synth requires ${f}`,   synth.includes(f), true);
    }
    row('nightly required IS the core exactly', eq([...nightly].sort(), [...CORE].sort()), true);
    row('synth adds exactly factors + thesis',
        eq(synth.filter(f => !CORE.includes(f)).sort(), ['factors', 'thesis']), true);
    for (const k of ['trend', 'pattern', 'action']) {
      row(`synth schema drops ${k}`, k in M.AI_SYNTHESIS_SCHEMA.properties, false);
    }
    row('synth prompt no longer asks for trend/pattern/action',
        /- (trend|pattern|action):/.test(src), false);
    row('synth prompt asks for recommendation', /- recommendation:/.test(src), true);
    row('synth prompt asks for drivers',        /- drivers:/.test(src), true);
  }

  // Every KV read of the key goes through the normaliser.
  const reads = [...src.matchAll(/REC_LOG\??\.get\(`analysis:\$\{[^}]+\}`/g)];
  if (populated('analysis: read sites', reads.length)) {
    console.log(`     analysis: KV read sites: ${reads.length}`);
    row('normaliser is used at least as often as the key is read',
        (src.match(/readAnalysisRecord\(/g) || []).length >= reads.length, true);
  }
}

console.log('\n== 7. index.html no longer fabricates a factor score =========================\n');
{
  /* The specific fabrication: `?? 50` on a factor score, which made a missing
     measurement render as a measured neutral.

     COMMENTS ARE STRIPPED FIRST, and that is not a convenience. The first run of
     this section counted 2 and failed — both hits were inside the comments this
     very fix added, describing the bug being removed. A source assertion that
     matches its own prose is measuring the documentation, not the code, and it
     fails loudest exactly when the fix is most thoroughly explained. */
  const code = page
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const fabrications = [...code.matchAll(/\?\?\s*50\b/g)];
  const inProse      = [...page.matchAll(/\?\?\s*50\b/g)].length - fabrications.length;
  console.log(`     '?? 50' in index.html: ${fabrications.length} in code, ${inProse} in comments`);
  row("no '?? 50' default in index.html CODE", fabrications.length, 0);
  row('the comment hits were real (harness sanity)', inProse > 0, true);
  row('factor bars gated on Number.isFinite',
      /Number\.isFinite\(f\?*\.score\)/.test(page), true);
  row('sentiment score gated on Number.isFinite',
      /Number\.isFinite\(factors\?\.sentiment\?\.score\)/.test(page), true);
  row('absence is a NAMED state, not a blank',
      /not produced for this record/.test(page), true);
  row('panels are written for every key, not only present ones',
      /FACTOR_PANEL_KEYS/.test(page), true);
}

process.exit(reportVerdict({
  label: 'analysis record shape', comparisons: t.comparisons, failures: t.failures, minComparisons: 80,
}));
