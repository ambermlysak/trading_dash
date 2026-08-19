/* Earnings session timing — BMO / AMC / unknown, and the anchor decode.
 *
 * WHAT THIS PINS, and why each section exists:
 *
 *   1. The shipped constants, read out of `worker.js` rather than restated here.
 *   2. THE ANCHORS, BOTH DST REGIMES. Yahoo encodes the session as a fixed UTC
 *      constant (12:30:00Z / 20:00:00Z), not as an ET wall-clock time — measured
 *      2026-08-19 over all 39 watchlist names, 39/39 on those two values. This
 *      section drives each anchor on an EDT-dated day and an EST-dated day, and
 *      prints the OLD wall-clock-only verdict beside the new one so the four
 *      cells that changed are visible rather than asserted.
 *   3. THE WALL-CLOCK WINDOWS, which are now the FALLBACK for a non-anchor time.
 *      Boundaries at 03:59/04:00, 09:29/09:30, 15:59/16:00 ET in both regimes,
 *      each printed with the branch that decided it — because two of those
 *      boundaries ARE anchors (16:00 EDT is exactly 20:00:00Z), and a test that
 *      does not say which branch answered proves nothing about either.
 *   4. THE MIDNIGHT-UTC PLACEHOLDER GUARD, including its ORDERING: 00:00:00Z is
 *      not an anchor and must be rejected before either later test sees it.
 *   5. THE MULTI-ENTRY START/END BRANCH — and its inverse, a duplicated single
 *      entry, which must NOT trip it.
 *   6. NO DATE AT ALL, in every absent shape.
 *   7. THE LIVE DISTRIBUTION. Re-probes the watchlist through the deployed
 *      Worker and asserts every name against the anchor rule. This is the
 *      section to re-run if Yahoo's encoding is ever suspected of moving.
 *   8. `earningsIsEstimateFrom` — the field-name half. `isEarningsDateEstimate`
 *      is the live name; the documented `earningsDateIsEstimate` is a fallback.
 *   9. The batch envelope actually ships the three fields.
 *
 * BLIND SPOTS, stated rather than discovered later:
 *   - §2 and §3 construct instants by arithmetic on a hand-picked UTC offset.
 *     That arithmetic is cross-checked against a DIFFERENT source — Intl's own
 *     `timeZoneName` and the shipped `etMinutesOfDay` — so a wrong offset shows
 *     up as a failed pre-condition rather than as a silently mislabelled case.
 *   - An anchor is a CONVENTION. A genuine report really scheduled at exactly
 *     20:00:00Z mid-session under EST would read AMC, and nothing in the payload
 *     could tell the two apart. §7 is the only thing that would notice a change.
 *   - §7 reads live data through the deployed Worker's /api/quote proxy (a laptop
 *     IP gets 429 from Yahoo). It measures what YAHOO sends, not that
 *     `handleWatchlistBatch` wired it up — §9's source check covers that half.
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
  grabConst('EARN_BMO_START_MIN'), grabConst('EARN_BMO_END_MIN'), grabConst('EARN_AMC_START_MIN'),
  grabConst('EARN_ANCHOR_BMO_UTC_SEC'), grabConst('EARN_ANCHOR_AMC_UTC_SEC'),
  grab('etMinutesOfDay'), grab('earningsTimingFrom'), grab('earningsIsEstimateFrom'),
  `return { etMinutesOfDay, earningsTimingFrom, earningsIsEstimateFrom,
            EARN_BMO_START_MIN, EARN_BMO_END_MIN, EARN_AMC_START_MIN,
            EARN_ANCHOR_BMO_UTC_SEC, EARN_ANCHOR_AMC_UTC_SEC };`,
].join('\n'))();

const t = tally();
function row(label, got, want) {
  const ok = record(t, got === want);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(64)} got ${String(got).padEnd(10)} want ${String(want)}`);
  return ok;
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

/** Classify a raw epoch-second value through the shipped function. */
const cls  = (...raws) => W.earningsTimingFrom({ earningsDate: raws.map(r => ({ raw: r })) });
const sess = (...raws) => cls(...raws).earningsSession;

/** THE PRE-CHANGE RULE, replicated here so §2 can print before→after. This is
 *  NOT the shipped code — it is the wall-clock-only classifier the anchor decode
 *  replaced, kept only to show which cells moved. */
function oldWallClockOnly(ts) {
  if (ts % 86400 === 0) return 'unknown';
  const mins = W.etMinutesOfDay(ts * 1000);
  if (mins == null) return 'unknown';
  if (mins >= W.EARN_BMO_START_MIN && mins < W.EARN_BMO_END_MIN) return 'bmo';
  if (mins >= W.EARN_AMC_START_MIN) return 'amc';
  return 'unknown';
}

const utcSecOf = ts => ((ts % 86400) + 86400) % 86400;
const hhmmss = ts => new Date(ts * 1000).toISOString().slice(11, 19) + 'Z';
const etLong = ts => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
}).format(new Date(ts * 1000));
const etAbbr = ts => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', timeZoneName: 'short',
}).formatToParts(new Date(ts * 1000)).find(p => p.type === 'timeZoneName')?.value;

/** Which branch of `earningsTimingFrom` decided this instant. Derived from the
 *  same predicates the function uses, in the same order — so a rewrite that
 *  reorders them shows up here as a changed narrative, not as a silent pass. */
function branchOf(ts) {
  const u = utcSecOf(ts);
  if (u === 0) return 'midnight-UTC guard';
  if (u === W.EARN_ANCHOR_BMO_UTC_SEC) return 'ANCHOR 12:30:00Z';
  if (u === W.EARN_ANCHOR_AMC_UTC_SEC) return 'ANCHOR 20:00:00Z';
  return 'ET wall clock';
}

/* Two reference days, one in each DST regime. DST ends 2026-11-01, so August is
   unambiguously EDT (UTC−4) and November 3rd unambiguously EST (UTC−5). Both
   assumptions are asserted below rather than assumed. */
const DAY_EDT = { label: 'EDT', date: Date.UTC(2026, 7, 26) / 1000, off: -4, abbr: 'EDT' }; // 2026-08-26
const DAY_EST = { label: 'EST', date: Date.UTC(2026, 10, 3) / 1000, off: -5, abbr: 'EST' }; // 2026-11-03

/** Epoch seconds for an ET wall-clock time on a reference day. */
const atEt = (day, h, m) => day.date + (h - day.off) * 3600 + m * 60;
/** Epoch seconds for a UTC time of day on a reference day. */
const atUtc = (day, h, m) => day.date + h * 3600 + m * 60;

const main = async () => {
console.log('\n══ Earnings session timing — anchors, windows, and every refusal ══');

/* ── §1  CONSTANTS ────────────────────────────────────────────────────────── */
console.log('\n§1  SHIPPED CONSTANTS (read out of worker.js, not restated here)');
row('EARN_BMO_START_MIN  (04:00 ET)',        W.EARN_BMO_START_MIN, 240);
row('EARN_BMO_END_MIN    (09:30 ET bell)',   W.EARN_BMO_END_MIN,   570);
row('EARN_AMC_START_MIN  (16:00 ET bell)',   W.EARN_AMC_START_MIN, 960);
row('EARN_ANCHOR_BMO_UTC_SEC (12:30:00Z)',   W.EARN_ANCHOR_BMO_UTC_SEC, 45000);
row('EARN_ANCHOR_AMC_UTC_SEC (20:00:00Z)',   W.EARN_ANCHOR_AMC_UTC_SEC, 72000);

console.log('\n    reference days — the DST regime of each is asserted, not assumed:');
for (const d of [DAY_EDT, DAY_EST]) {
  const noon = d.date + 12 * 3600;
  console.log(`      ${new Date(noon * 1000).toISOString().slice(0, 10)}  reads ${etAbbr(noon)}  (UTC${d.off})`);
  row(`${d.label} reference day really is ${d.abbr}`, etAbbr(noon), d.abbr);
  // Cross-check the offset arithmetic against the shipped ET reader.
  row(`  ...and atEt(${d.label}, 10:00) reads 10:00 ET`, W.etMinutesOfDay(atEt(d, 10, 0) * 1000), 600);
}

/* ── §2  THE ANCHORS, BOTH REGIMES ────────────────────────────────────────── */
console.log('\n§2  THE FIXED UTC ANCHORS — decoded FIRST, in both DST regimes');
console.log('    measured 2026-08-19: 39/39 watchlist names on exactly two values,');
console.log('    20:00:00Z (n=28) and 12:30:00Z (n=11). Both are DST-invariant.\n');
console.log('    anchor      day    ET wall clock         NEW      OLD (wall-clock only)   branch');
{
  const cases = [
    ['12:30:00Z', DAY_EDT, 12, 30, 'bmo', 'bmo'],   // 08:30 EDT — inside the BMO window either way
    ['12:30:00Z', DAY_EST, 12, 30, 'bmo', 'bmo'],   // 07:30 EST — inside the BMO window either way
    ['20:00:00Z', DAY_EDT, 20,  0, 'amc', 'amc'],   // 16:00 EDT — on the bell, both agree
    ['20:00:00Z', DAY_EST, 20,  0, 'amc', 'unknown'], // 15:00 EST — THE CELL THAT CHANGED
  ];
  let changed = 0;
  for (const [name, day, h, m, want, wantOld] of cases) {
    const ts  = atUtc(day, h, m);
    const got = sess(ts);
    const old = oldWallClockOnly(ts);
    if (got !== old) changed++;
    console.log(`    ${name}  ${day.label}   ${etLong(ts).padEnd(22)} ${got.padEnd(8)} ${old.padEnd(23)} ${branchOf(ts)}`);
    row(`${name} under ${day.label} -> ${want}`, got, want);
    row(`  ...and the OLD rule said ${wantOld}`, old, wantOld);
    row(`  ...decided by the anchor branch`, branchOf(ts), name === '12:30:00Z' ? 'ANCHOR 12:30:00Z' : 'ANCHOR 20:00:00Z');
  }
  console.log(`\n    ${changed} of ${cases.length} anchor cells changed verdict — the AMC anchor under EST, and only that.`);
  row('exactly one anchor cell changed', changed, 1);

  // The anchor is EXACT: one second either side must not be read as a flag.
  console.log('\n    exactness — an anchor is a flag, so "near 20:00Z" is a different claim:');
  for (const [dsec, label] of [[-1, '19:59:59Z'], [1, '20:00:01Z']]) {
    const ts = atUtc(DAY_EST, 20, 0) + dsec;
    console.log(`      ${label} under EST -> ET ${etLong(ts)}  branch ${branchOf(ts)}  -> ${sess(ts)}`);
    row(`${label} under EST is NOT the anchor`, branchOf(ts), 'ET wall clock');
    row(`  ...and the window calls it unknown (15:59/16:00 EST)`, sess(ts), 'unknown');
  }
  for (const [dsec, label] of [[-1, '19:59:59Z'], [1, '20:00:01Z']]) {
    const ts = atUtc(DAY_EDT, 20, 0) + dsec;
    console.log(`      ${label} under EDT -> ET ${etLong(ts)}  branch ${branchOf(ts)}  -> ${sess(ts)}`);
    row(`${label} under EDT is NOT the anchor`, branchOf(ts), 'ET wall clock');
    row(`  ...and the window decides it`, sess(ts), dsec < 0 ? 'unknown' : 'amc');
  }
}

/* ── §3  THE WALL-CLOCK WINDOWS, AS FALLBACK ──────────────────────────────── */
console.log('\n§3  ET WALL-CLOCK BOUNDARIES — the fallback for a non-anchor time');
console.log('    Two of these ARE anchors (16:00 EDT is exactly 20:00:00Z), so each row');
console.log('    names the branch that answered it. A boundary decided by an anchor is');
console.log('    not evidence about the window, and is re-driven one second off below.\n');
console.log('    ET       day   UTC        verdict   branch');
{
  const bounds = [
    [ 3, 59, 'unknown', 'below the 04:00 BMO start'],
    [ 4,  0, 'bmo',     'the 04:00 BMO start, inclusive'],
    [ 9, 29, 'bmo',     'the last minute before the bell'],
    [ 9, 30, 'unknown', 'the 09:30 bell, exclusive — mid-session, not BMO'],
    [15, 59, 'unknown', 'the last minute before the close'],
    [16,  0, 'amc',     'the 16:00 close, inclusive'],
  ];
  for (const day of [DAY_EDT, DAY_EST]) {
    for (const [h, m, want, why] of bounds) {
      const ts = atEt(day, h, m);
      const br = branchOf(ts);
      console.log(`    ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}    ${day.label}   ${hhmmss(ts)}  `
        + `${sess(ts).padEnd(9)} ${br}${br === 'ET wall clock' ? '' : '   <- ANCHOR, not the window'}`);
      row(`${day.label} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ET -> ${want}  (${why})`, sess(ts), want);
      // Pre-condition: the constructed instant really is that ET wall clock.
      row(`  ...instant really reads ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ET`,
          W.etMinutesOfDay(ts * 1000), h * 60 + m);
    }
  }

  /* The 16:00 EDT boundary above was decided by the anchor. Re-drive the WINDOW
     at that same boundary by moving one second off the anchor, so the ≥16:00 cut
     is proven independently of the flag that happens to sit on top of it. */
  console.log('\n    the 16:00 cut, re-driven OFF the anchor so the window itself is exercised:');
  for (const day of [DAY_EDT, DAY_EST]) {
    for (const [h, m, s, want] of [[15, 59, 59, 'unknown'], [16, 0, 1, 'amc']]) {
      const ts = atEt(day, h, m) + s;
      console.log(`      ${day.label} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ET  `
        + `= ${hhmmss(ts)}  branch ${branchOf(ts)}  -> ${sess(ts)}`);
      row(`${day.label} ${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ET is off-anchor`, branchOf(ts), 'ET wall clock');
      row(`  ...and the window says ${want}`, sess(ts), want);
    }
  }
}

/* ── §4  THE MIDNIGHT-UTC PLACEHOLDER GUARD, AND ITS ORDERING ─────────────── */
console.log('\n§4  DATE-ONLY PLACEHOLDER — rejected on the UTC instant, BEFORE any ET read');
{
  for (const day of [DAY_EDT, DAY_EST]) {
    const ts = day.date;                       // exactly 00:00:00Z
    const mins = W.etMinutesOfDay(ts * 1000);
    console.log(`    ${new Date(ts * 1000).toISOString()}  ->  ET ${etLong(ts)}  `
      + `(${mins} min past ET midnight, on the PREVIOUS day)`);
    row(`${day.label} midnight-UTC placeholder -> unknown`, sess(ts), 'unknown');
    row('  ...decided by the guard, not by an anchor or a window', branchOf(ts), 'midnight-UTC guard');
    // The trap this guard exists for: read as ET it is past the 16:00 cut.
    row('  ...and a naive ET read WOULD have said amc',
        mins >= W.EARN_AMC_START_MIN, true);
    // The ts is still reported — an unknown session is not a missing date.
    row('  ...but the date itself is still returned', cls(ts).earningsTs, new Date(ts * 1000).toISOString());
  }
  // Ordering: 00:00:00Z must not collide with either anchor constant.
  row('00:00:00Z is not the BMO anchor', 0 === W.EARN_ANCHOR_BMO_UTC_SEC, false);
  row('00:00:00Z is not the AMC anchor', 0 === W.EARN_ANCHOR_AMC_UTC_SEC, false);
  // A pre-epoch value must normalise rather than go negative past the guard.
  const preEpoch = -86400;                     // 1969-12-31T00:00:00Z
  console.log(`    pre-epoch ${preEpoch} -> ${new Date(preEpoch * 1000).toISOString()}  utcSec ${utcSecOf(preEpoch)}`);
  row('pre-epoch midnight still hits the guard', sess(preEpoch), 'unknown');
}

/* ── §5  THE MULTI-ENTRY START/END BRANCH ─────────────────────────────────── */
console.log('\n§5  MULTI-ENTRY RANGE — "sometime that day", regardless of the first clock');
{
  const a = atUtc(DAY_EDT, 20, 0);             // the AMC anchor
  const b = a + 6 * 3600;                      // Yahoo's end-of-range partner
  console.log(`    [${hhmmss(a)}, ${hhmmss(b)}]  first entry is the AMC anchor -> ${sess(a, b)}`);
  row('two DISTINCT entries -> unknown even though entry 0 is an anchor', sess(a, b), 'unknown');
  row('  ...and entry 0 alone would have been amc', sess(a), 'amc');
  row('  ...and earningsTs is still entry 0', cls(a, b).earningsTs, new Date(a * 1000).toISOString());

  const bmo = atUtc(DAY_EST, 12, 30);
  row('two distinct entries -> unknown for the BMO anchor too', sess(bmo, bmo + 3600), 'unknown');

  // The inverse: a DUPLICATED single entry is one date, not a range.
  console.log(`    [${hhmmss(a)}, ${hhmmss(a)}]  duplicate of one instant -> ${sess(a, a)}`);
  row('duplicated single entry does NOT trip the range branch', sess(a, a), 'amc');
  row('  ...same for the BMO anchor', sess(bmo, bmo), 'bmo');
  row('three identical entries still resolve', sess(a, a, a), 'amc');
}

/* ── §6  NO DATE AT ALL ───────────────────────────────────────────────────── */
console.log('\n§6  ABSENT DATE — every shape, and the session is NEVER null');
{
  const shapes = [
    ['undefined calendarEvents.earnings', undefined],
    ['null',                              null],
    ['{}',                                {}],
    ['{ earningsDate: [] }',              { earningsDate: [] }],
    ['{ earningsDate: null }',            { earningsDate: null }],
    ['entries with no raw',               { earningsDate: [{ fmt: '2026-11-03' }] }],
    ['entries with a non-finite raw',     { earningsDate: [{ raw: NaN }, { raw: null }] }],
  ];
  for (const [label, cal] of shapes) {
    const out = W.earningsTimingFrom(cal);
    console.log(`    ${label.padEnd(36)} -> ts ${String(out.earningsTs)}  session ${out.earningsSession}`);
    row(`${label}: earningsTs null`, out.earningsTs, null);
    row(`${label}: session 'unknown', never null`, out.earningsSession, 'unknown');
  }
  // Bare numbers, which the mapper also accepts.
  const bare = W.earningsTimingFrom({ earningsDate: [atUtc(DAY_EST, 20, 0)] });
  console.log(`    bare number entry (no {raw})         -> ts ${bare.earningsTs}  session ${bare.earningsSession}`);
  row('bare-number entry still decodes the anchor', bare.earningsSession, 'amc');
}

/* ── §7  THE LIVE DISTRIBUTION ────────────────────────────────────────────── */
console.log('\n§7  LIVE — re-probe the watchlist and assert every name against the anchor rule');
console.log('    (this is the section to re-run if Yahoo\'s encoding is suspected of moving)');
{
  const API = 'https://stock-research-worker.ambermlysak.workers.dev/api';
  const H = { Origin: 'http://localhost:8123' };
  let tickers = [];
  try {
    tickers = (await (await fetch(`${API}/watchlist`, { headers: H })).json())?.tickers || [];
  } catch (e) { console.log(`    watchlist fetch failed: ${e.message}`); }

  const seen = new Map();
  const probed = [];
  for (const sym of tickers) {
    try {
      const r = await fetch(`${API}/quote/${sym}`, { headers: H });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const cal = (await r.json())?.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
      const raws = (cal?.earningsDate || []).map(e => e?.raw).filter(Number.isFinite);
      probed.push({ sym, raws, out: W.earningsTimingFrom(cal) });
      for (const v of raws) seen.set(hhmmss(v), (seen.get(hhmmss(v)) || 0) + 1);
    } catch (e) { console.log(`      ${sym}: ${e.message}`); }
    await new Promise(s => setTimeout(s, 350));
  }

  if (populated('live earnings probe', probed.length)) {
    console.log(`\n    ${probed.length} of ${tickers.length} names probed`);
    console.log('    distinct UTC time-of-day observed:');
    for (const [k, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${k}   n=${n}`);
    }
    row('at most 4 distinct UTC times across the whole watchlist', seen.size <= 4, true);
    row('12:30:00Z is one of them', seen.has('12:30:00Z'), true);
    row('20:00:00Z is one of them', seen.has('20:00:00Z'), true);
    const anchored = [...seen.entries()].filter(([k]) => k === '12:30:00Z' || k === '20:00:00Z')
      .reduce((s, [, n]) => s + n, 0);
    const total = [...seen.values()].reduce((s, n) => s + n, 0);
    console.log(`    anchored entries: ${anchored}/${total} = ${(100 * anchored / total).toFixed(1)}%`);
    row('the two anchors dominate the distribution (> 80%)', anchored / total > 0.8, true);

    // Every name: the session must equal what the anchor rule says of its raw.
    let bmoN = 0, amcN = 0, unkN = 0, wouldHaveBeenUnknown = [];
    for (const p of probed) {
      const first = p.raws[0];
      const want = p.raws.length === 0 ? 'unknown'
        : new Set(p.raws).size > 1 ? 'unknown'
        : utcSecOf(first) === 0 ? 'unknown'
        : utcSecOf(first) === W.EARN_ANCHOR_BMO_UTC_SEC ? 'bmo'
        : utcSecOf(first) === W.EARN_ANCHOR_AMC_UTC_SEC ? 'amc'
        : oldWallClockOnly(first);
      record(t, p.out.earningsSession === want);
      if (p.out.earningsSession !== want) {
        console.log(`      FAIL ${p.sym}: got ${p.out.earningsSession} want ${want}`);
      }
      if (p.out.earningsSession === 'bmo') bmoN++;
      else if (p.out.earningsSession === 'amc') amcN++;
      else unkN++;
      if (p.raws.length === 1 && oldWallClockOnly(first) !== p.out.earningsSession) {
        wouldHaveBeenUnknown.push(`${p.sym} ${oldWallClockOnly(first)}->${p.out.earningsSession}`);
      }
    }
    console.log(`    classification: bmo ${bmoN} · amc ${amcN} · unknown ${unkN}`);
    console.log(`    names the OLD wall-clock-only rule got differently (${wouldHaveBeenUnknown.length}):`);
    console.log(`      ${wouldHaveBeenUnknown.join(', ') || '(none)'}`);
    row('every live name is now classified (0 unknown is not required, but 0 errors is)',
        probed.filter(p => !['bmo', 'amc', 'unknown'].includes(p.out.earningsSession)).length, 0);
  }
}

/* ── §8  THE ESTIMATE FLAG, AND ITS FIELD NAME ────────────────────────────── */
console.log('\n§8  earningsIsEstimateFrom — the live field is `isEarningsDateEstimate`');
{
  const f = W.earningsIsEstimateFrom;
  row('live name, boolean true',        f({ isEarningsDateEstimate: true }),  true);
  row('live name, boolean false',       f({ isEarningsDateEstimate: false }), false);
  row('live name, wrapped {raw:true}',  f({ isEarningsDateEstimate: { raw: true } }),  true);
  row('live name, wrapped {raw:false}', f({ isEarningsDateEstimate: { raw: false } }), false);
  row('documented-name fallback',       f({ earningsDateIsEstimate: true }),  true);
  row('live name wins when both present', f({ isEarningsDateEstimate: false, earningsDateIsEstimate: true }), false);
  row('absent -> null, NOT false',      f({}), null);
  row('undefined cal -> null',          f(undefined), null);
  row('non-boolean -> null',            f({ isEarningsDateEstimate: 'true' }), null);
  row('worker.js reads the LIVE field name', /cal\?\.isEarningsDateEstimate/.test(src), true);
}

/* ── §9  THE BATCH ENVELOPE ───────────────────────────────────────────────── */
console.log('\n§9  ENVELOPE — the three fields actually ship on the watchlist row');
{
  const bStart = src.indexOf('async function handleWatchlistBatch(');
  const bEnd   = src.indexOf('async function handleWatchlistAuction(');
  const batch  = src.slice(bStart, bEnd);
  row('row ships earningsTs',         /^\s*earningsTs,\s*$/m.test(batch), true);
  row('row ships earningsSession',    /^\s*earningsSession,\s*$/m.test(batch), true);
  row('row ships earningsIsEstimate', /^\s*earningsIsEstimate,\s*$/m.test(batch), true);
  row('the batch calls earningsTimingFrom',   /earningsTimingFrom\(cal\)/.test(batch), true);
  row('the batch calls earningsIsEstimateFrom', /earningsIsEstimateFrom\(cal\)/.test(batch), true);
  row('session defaults to \'unknown\', never null', /earningsSession\s*=\s*'unknown'/.test(batch), true);
  row('calendarEvents is already in the batch module list',
      /modules=[^']*calendarEvents/.test(batch), true);
  row('no new Yahoo fetch was added for the timing fields',
      (batch.match(/yahooAuth\(|yahooSparkCloses\(|yahoo\(/g) || []).length, 3);
}

process.exit(reportVerdict({
  label: 'earnings session timing',
  comparisons: t.comparisons, failures: t.failures,
  /* Floor. §1–§6, §8 and §9 are a FIXED 113 comparisons, none of them
     tape-dependent. §7 added 44 on 2026-08-19 — 5 aggregate rows plus one per
     watchlist name that probed (39) — and every one of those is contingent on
     the network and on a watchlist whose length changes. So the floor is the
     FIXED count and nothing more: an offline run still has to clear the whole
     deterministic half, and §7 announces its own emptiness through `populated`
     rather than by dragging the verdict down. Never raise this to an observed
     total. */
  minComparisons: 113,
}));
};

main().catch(e => { console.error('\nHARNESS ERROR:', e.message); process.exit(1); });
