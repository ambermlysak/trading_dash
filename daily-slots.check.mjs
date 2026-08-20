/* The /api/daily slot-merge contract — `daily:snapshot` / `daily:midday` /
 * `daily:eod` are THREE independent keys composed at read time, and a briefing
 * run may only ever touch its own.
 *
 * WHY THIS EXISTS. Measured 2026-08-19 from the decision_dash side: the daily
 * object held all three session records (open 06:02, midday 11:31, eod 13:13) at
 * 17:56 PT, and a re-run at 18:11 rewrote it wholesale — open and eod restamped
 * 18:11, midday GONE. `generateDailySnapshot` deleted `daily:eod` and
 * `daily:midday` unconditionally on every successful write. That is correct for
 * the 6:00am firing (the new pre-market briefing replaces yesterday's recap) and
 * destructive for any other run on the same PT day. A client that had not fetched
 * before the rewrite lost the midday slot permanently, because midday is the one
 * slot with no request-path self-heal.
 *
 * Sections:
 *   1. `dailySlotPtDate` over every record shape that can reach it — stamped,
 *      unstamped-with-ts, the `ts: 0` EOD placeholder, junk, null. The ts
 *      fallback is what lets pre-2026-08-20 records be classified at all, and it
 *      is a PACIFIC derivation: one case straddles UTC midnight, where a
 *      `.slice(0,10)` on the ISO string would answer the wrong day.
 *   2. SAME PT DAY: both siblings survive, and survive BYTE-IDENTICAL. The
 *      assertion is on the raw stored strings, not on a parsed object — a
 *      re-serialised record that happened to compare deep-equal would still be a
 *      rewrite, and the incident was about restamping as much as deletion.
 *   3. ROLLOVER: a new PT date clears both. The purge has to still work, or the
 *      fix trades one silent failure for another (yesterday's recap rendered
 *      under today's date).
 *   4. MIXED: eod today, midday yesterday. The per-key decision is what proves
 *      this is a date test rather than an all-or-nothing switch — a purge that
 *      always kept, and a purge that always cleared, would each pass one of §2
 *      and §3 alone.
 *   5. UNDATED and ABSENT records. Undated clears; that is the deliberate safe
 *      direction and it is asserted rather than assumed.
 *   6. SAME-SLOT RE-RUN: newest ts wins on the run's own slot while the siblings
 *      stay byte-identical. This is the case the spec explicitly allows and the
 *      fix must not block it.
 *   7. STRUCTURAL: every `daily:` mutation site in worker.js, attributed to the
 *      function it lives in. A behavioural test cannot see a second unconditional
 *      delete added somewhere else later; a source assertion can.
 *   8. UNREADABLE KV: the purge must not delete on a failed read, and must not
 *      throw. Deleting on a read error would destroy the exact slot it could not
 *      verify — the same class as instrumentation taking out what it measures.
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

const M = new Function([
  grabConst('ptDate'),
  grab('dailySlotPtDate'), grab('purgeStaleDailySlots'),
  'return { ptDate, dailySlotPtDate, purgeStaleDailySlots };',
].join('\n'))();

const t = tally();
const pad = (s, n) => String(s).padEnd(n);
const j = v => JSON.stringify(v);
function row(label, got, want, ok = Object.is(got, want)) {
  record(t, ok);
  console.log(`  ${pad(label, 44)} got ${pad(j(got), 24)} want ${pad(j(want), 24)} ${ok ? 'ok' : '<<< MISMATCH'}`);
}

/* A stub KV that records every operation, so a section can assert on what was NOT
   called as well as on what was. `raw` holds the exact stored string: byte-identity
   is the property under test in §2 and §6, and a parsed-object comparison cannot
   see it. */
function stubKV(initial = {}) {
  const raw = { ...initial };
  const ops = [];
  const failOn = new Set();
  return {
    raw, ops, failOn,
    binding: {
      async get(key, type) {
        ops.push(['get', key]);
        if (failOn.has(key)) throw new Error('simulated KV read failure');
        if (!(key in raw)) return null;
        return type === 'json' ? JSON.parse(raw[key]) : raw[key];
      },
      async put(key, value) { ops.push(['put', key]); raw[key] = value; },
      async delete(key) { ops.push(['delete', key]); delete raw[key]; },
    },
  };
}

const TODAY = '2026-08-19';
const YDAY  = '2026-08-18';
const rec = (ptDate, ts, extra = {}) => JSON.stringify({ ...extra, ts, ...(ptDate ? { ptDate } : {}) });

const EOD_TODAY    = rec(TODAY, Date.parse('2026-08-19T20:13:00Z'), { headline: 'Close recap', complete: true });
const MIDDAY_TODAY = rec(TODAY, Date.parse('2026-08-19T18:31:00Z'), { narrative: 'Midday pulse', bigMovers: [] });
const EOD_YDAY     = rec(YDAY,  Date.parse('2026-08-18T20:13:00Z'), { headline: 'Yesterday close', complete: true });
const MIDDAY_YDAY  = rec(YDAY,  Date.parse('2026-08-18T18:31:00Z'), { narrative: 'Yesterday pulse' });

console.log('\n== 1. dailySlotPtDate over every record shape ================================\n');
{
  const stampedTs = Date.parse('2026-08-19T20:13:00Z');   // 13:13 PT on the 19th
  row('stamped ptDate wins',                  M.dailySlotPtDate({ ptDate: TODAY, ts: 0 }), TODAY);
  row('stamped ptDate wins over a later ts',  M.dailySlotPtDate({ ptDate: YDAY, ts: Date.now() }), YDAY);
  row('no ptDate -> derived from ts',         M.dailySlotPtDate({ ts: stampedTs }), TODAY);
  /* 2026-08-20T05:30Z is 22:30 PT on the 19th — the UTC day and the PT day
     disagree, which is the whole reason this is a Pacific derivation and not a
     slice of the ISO string. A `.slice(0,10)` here answers 2026-08-20 and would
     spare a stale record from a genuine rollover. */
  row('ts across UTC midnight -> PT day',     M.dailySlotPtDate({ ts: Date.parse('2026-08-20T05:30:00Z') }), TODAY);
  row('ts: 0 placeholder -> null',            M.dailySlotPtDate({ ts: 0, complete: false }), null);
  row('no ts, no ptDate -> null',             M.dailySlotPtDate({ headline: 'x' }), null);
  row('malformed ptDate falls back to ts',    M.dailySlotPtDate({ ptDate: '19 Aug', ts: stampedTs }), TODAY);
  row('malformed ptDate, no ts -> null',      M.dailySlotPtDate({ ptDate: '19 Aug' }), null);
  row('null record -> null',                  M.dailySlotPtDate(null), null);
  row('string record -> null',                M.dailySlotPtDate('nope'), null);
}

console.log('\n== 2. SAME PT DAY - both siblings survive byte-identical =====================\n');
{
  const kv = stubKV({ 'daily:eod': EOD_TODAY, 'daily:midday': MIDDAY_TODAY });
  const before = { ...kv.raw };
  const out = await M.purgeStaleDailySlots({ REC_LOG: kv.binding }, TODAY);
  row('eod verdict',                    out['daily:eod'], 'kept');
  row('midday verdict',                 out['daily:midday'], 'kept');
  row('deletes issued',                 kv.ops.filter(o => o[0] === 'delete').length, 0);
  row('puts issued',                    kv.ops.filter(o => o[0] === 'put').length, 0);
  if (populated('byte-identity', before['daily:eod'].length, before['daily:midday'].length)) {
    row('eod bytes unchanged',          kv.raw['daily:eod'] === before['daily:eod'], true);
    row('midday bytes unchanged',       kv.raw['daily:midday'] === before['daily:midday'], true);
    row('midday byte length',           kv.raw['daily:midday'].length, before['daily:midday'].length);
  }
}

console.log('\n== 3. ROLLOVER - a new PT date clears both ===================================\n');
{
  const kv = stubKV({ 'daily:eod': EOD_YDAY, 'daily:midday': MIDDAY_YDAY });
  const out = await M.purgeStaleDailySlots({ REC_LOG: kv.binding }, TODAY);
  row('eod verdict',         out['daily:eod'], 'cleared');
  row('midday verdict',      out['daily:midday'], 'cleared');
  row('eod gone from KV',    'daily:eod' in kv.raw, false);
  row('midday gone from KV', 'daily:midday' in kv.raw, false);
  row('deletes issued',      kv.ops.filter(o => o[0] === 'delete').length, 2);
}

console.log('\n== 4. MIXED - eod today, midday yesterday: a PER-KEY decision ================\n');
{
  const kv = stubKV({ 'daily:eod': EOD_TODAY, 'daily:midday': MIDDAY_YDAY });
  const before = kv.raw['daily:eod'];
  const out = await M.purgeStaleDailySlots({ REC_LOG: kv.binding }, TODAY);
  row('eod verdict',           out['daily:eod'], 'kept');
  row('midday verdict',        out['daily:midday'], 'cleared');
  row('eod bytes unchanged',   kv.raw['daily:eod'] === before, true);
  row('midday gone',           'daily:midday' in kv.raw, false);
  row('exactly one delete',    kv.ops.filter(o => o[0] === 'delete').length, 1);
  row('the delete was midday', kv.ops.find(o => o[0] === 'delete')?.[1], 'daily:midday');
}

console.log('\n== 5. UNDATED and ABSENT records =============================================\n');
{
  /* The pre-2026-08-20 shape and the EOD placeholder. Both classify stale, which
     is the safe direction: they regenerate, where a wrong "current" verdict would
     render an old recap under today's date. */
  const kv = stubKV({
    'daily:eod':    JSON.stringify({ headline: 'placeholder', complete: false, ts: 0 }),
    'daily:midday': JSON.stringify({ narrative: 'undated legacy record' }),
  });
  const out = await M.purgeStaleDailySlots({ REC_LOG: kv.binding }, TODAY);
  row('ts:0 placeholder cleared', out['daily:eod'], 'cleared');
  row('undated legacy cleared',   out['daily:midday'], 'cleared');

  const empty = stubKV({});
  const out2 = await M.purgeStaleDailySlots({ REC_LOG: empty.binding }, TODAY);
  row('absent eod reported absent',    out2['daily:eod'], 'absent');
  row('absent midday reported absent', out2['daily:midday'], 'absent');
  row('no delete on an absent key',    empty.ops.filter(o => o[0] === 'delete').length, 0);
}

console.log('\n== 6. SAME-SLOT RE-RUN - newest ts wins, siblings untouched ==================\n');
{
  /* The 18:11 case, replayed. A same-PT-day briefing re-run writes its OWN slot
     and purges nothing; the eod generator then rewrites its own. The property
     under test is that neither touches the other's bytes. */
  const kv = stubKV({
    'daily:snapshot': rec(TODAY, Date.parse('2026-08-19T13:02:00Z'), { headline: 'morning', open: { headline: 'open' } }),
    'daily:midday':   MIDDAY_TODAY,
    'daily:eod':      EOD_TODAY,
  });
  const middayBefore = kv.raw['daily:midday'];

  // (a) the briefing re-run: writes its own slot, then purges.
  const rerunTs = Date.parse('2026-08-20T01:11:00Z');   // 18:11 PT on the 19th
  await kv.binding.put('daily:snapshot', rec(TODAY, rerunTs, { headline: 'rewritten', open: { headline: 'open2' } }));
  await M.purgeStaleDailySlots({ REC_LOG: kv.binding }, TODAY);

  row('snapshot ts replaced',       JSON.parse(kv.raw['daily:snapshot']).ts, rerunTs);
  row('snapshot headline replaced', JSON.parse(kv.raw['daily:snapshot']).headline, 'rewritten');
  row('midday SURVIVES the re-run', 'daily:midday' in kv.raw, true);
  row('midday bytes unchanged',     kv.raw['daily:midday'] === middayBefore, true);
  row('midday ts unchanged',        JSON.parse(kv.raw['daily:midday']).ts, JSON.parse(middayBefore).ts);
  row('eod SURVIVES the re-run',    'daily:eod' in kv.raw, true);
  row('eod ts NOT restamped',       JSON.parse(kv.raw['daily:eod']).ts, JSON.parse(EOD_TODAY).ts);

  // (b) the eod generator's own re-run replaces its slot and nothing else.
  const eodRerunTs = Date.parse('2026-08-20T01:12:00Z');
  await kv.binding.put('daily:eod', rec(TODAY, eodRerunTs, { headline: 'eod v2', complete: true }));
  row('eod ts advanced (newest wins)', JSON.parse(kv.raw['daily:eod']).ts, eodRerunTs);
  row('midday STILL byte-identical',   kv.raw['daily:midday'] === middayBefore, true);
  row('snapshot untouched by eod',     JSON.parse(kv.raw['daily:snapshot']).headline, 'rewritten');
}

console.log('\n== 7. STRUCTURAL - every `daily:` mutation site in worker.js =================\n');
{
  /* A behavioural test cannot see a second unconditional delete added elsewhere
     six months from now. This can. Each site is attributed to the enclosing
     function by taking the nearest preceding `function <name>` declaration. */
  /* Attribution must see BOTH forms. The router lives in the exported default
     object as `async fetch(request, env, ctx) {` — a method, not a declaration —
     so a `function <name>` scan alone walks past it and blames the nearest
     preceding top-level function instead. The first run of this section did
     exactly that and printed the two admin-route deletes as living in
     `generateSectors`, which is a plausible, readable, entirely false line of
     output. A check that misattributes is worse than one that says nothing. */
  const fnAt = (idx) => {
    const head = src.slice(0, idx);
    const m = [...head.matchAll(
      /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|\n {2}(?:async )?([A-Za-z0-9_$]+)\(\w[^)]*\)\s*\{/g,
    )].pop();
    return m ? (m[1] || m[2]) : '(top level)';
  };
  const sites = [...src.matchAll(/REC_LOG\??\.(put|delete)\(\s*'(daily:[a-z]+)'/g)]
    .map(m => ({ op: m[1], key: m[2], fn: fnAt(m.index) }));

  if (populated('daily: mutation sites', sites.length)) {
    for (const s of sites) console.log(`     ${pad(s.op, 7)} ${pad(s.key, 16)} in ${s.fn}`);

    const OWNS = {
      generateDailySnapshot:  'daily:snapshot',
      generateEODSummary:     'daily:eod',
      generateMiddaySnapshot: 'daily:midday',
    };
    for (const [fn, own] of Object.entries(OWNS)) {
      const mine = sites.filter(s => s.fn === fn);
      const foreign = mine.filter(s => s.key !== own);
      // Both halves matter: the function must touch its own key (or the grep is
      // matching nothing and the next assertion is vacuous), and no other.
      row(`${fn} has sites`, mine.length > 0, true);
      row(`${fn} touches only ${own}`, foreign.map(s => `${s.op} ${s.key}`).join(','), '');
    }

    // The only remaining literal sibling deletes are the two admin refresh routes,
    // which are operator-triggered and each delete the slot they then regenerate.
    const deletes = sites.filter(s => s.op === 'delete');
    row('literal sibling deletes in generators',
        deletes.filter(s => s.fn in OWNS).map(s => `${s.fn}:${s.key}`).join(','), '');
    row('generateDailySnapshot deletes nothing',
        sites.filter(s => s.fn === 'generateDailySnapshot' && s.op === 'delete').length, 0);

    // The purge deletes through a loop over a key array, so it has no literal site
    // above. Assert its shape directly instead of inferring it from the grep.
    const purgeSrc = grab('purgeStaleDailySlots');
    row('purge iterates both sibling keys',
        /for \(const key of \['daily:eod', 'daily:midday'\]\)/.test(purgeSrc), true);
    row('purge deletes only by loop variable',
        /\.delete\(key\)/.test(purgeSrc) && !/\.delete\('daily:/.test(purgeSrc), true);
    row('purge gates the delete on a date compare',
        /day === today/.test(purgeSrc), true);

    row('purge is called with an explicit date',
        /purgeStaleDailySlots\(env, todayPt\)/.test(src), true);
    row('snapshot writer stamps ptDate',
        /ptDate: todayPt/.test(src), true);
    row('eod + midday writers stamp ptDate',
        (src.match(/ptDate: ptDate\(\)/g) || []).length, 2);
  }
}

console.log('\n== 8. UNREADABLE KV - must not delete what it could not verify ===============\n');
{
  const kv = stubKV({ 'daily:eod': EOD_YDAY, 'daily:midday': MIDDAY_YDAY });
  kv.failOn.add('daily:eod');
  let threw = null, out = null;
  try { out = await M.purgeStaleDailySlots({ REC_LOG: kv.binding }, TODAY); }
  catch (e) { threw = e.message; }
  row('purge did not throw',           threw, null);
  row('unreadable eod reported',       out?.['daily:eod'], 'unreadable');
  row('unreadable eod NOT deleted',    'daily:eod' in kv.raw, true);
  row('readable stale midday cleared', out?.['daily:midday'], 'cleared');

  // A missing binding entirely — the local-dev / misconfigured case.
  let out2 = null, threw2 = null;
  try { out2 = await M.purgeStaleDailySlots({}, TODAY); } catch (e) { threw2 = e.message; }
  row('no binding: did not throw', threw2, null);
  row('no binding: eod absent',    out2?.['daily:eod'], 'absent');
}

console.log('\n== 9. /api/daily request-path spend is gated ================================\n');
{
  /* Rule #5's table lists `GET /api/daily` as `maySpend` — degrade. That described
     the SNAPSHOT regeneration and silently overstated its coverage: the EOD
     self-heal fired `generateEODSummary` from an ordinary page load with no gate
     at all. Bounded in practice by that job's own 2h dedup, which is a blast
     radius, not an authorisation. Gated 2026-08-20.

     This is a source assertion because the branch needs a full request context —
     headers, KV rate-limit buckets, a live `aiGuard` — that a stub cannot supply
     honestly. Stated rather than papered over: it proves the gate is WIRED, not
     that it counts correctly. `aiGuard`'s counting is covered where it is tested. */
  const handler = grab('handleDailyGet');
  const eodBranch = handler.slice(handler.indexOf('let eodLoading'), handler.indexOf('// No fetch-path self-heal'));
  console.log('     EOD self-heal branch:');
  for (const line of eodBranch.trim().split('\n')) console.log(`       ${line.trim()}`);

  row('EOD self-heal calls generateEODSummary', /generateEODSummary\(env\)/.test(eodBranch), true);
  row('EOD self-heal is behind maySpend',       /await maySpend\(request, env\)/.test(eodBranch), true);
  row('maySpend precedes the waitUntil',
      eodBranch.indexOf('maySpend') < eodBranch.indexOf('ctx.waitUntil'), true);
  row('snapshot regeneration still gated too',
      /\(isStale \|\| !isComplete\) && await maySpend\(request, env\)/.test(handler), true);
  row('handleDailyGet receives request',        /function handleDailyGet\(origin, env, ctx, request\)/.test(src), true);
}

process.exit(reportVerdict({
  label: 'daily slot merge', comparisons: t.comparisons, failures: t.failures, minComparisons: 55,
}));
