/* The /api/daily slot-merge contract — `daily:snapshot` / `daily:midday` /
 * `daily:eod` / `daily:postopen` are FOUR independent keys composed at read time,
 * and a briefing run may only ever touch its own. (`daily:postopen`, the 7:15am PT
 * post-open read, joined them on 2026-11-13; §10 is its own contract.)
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
 *   9. /api/daily request-path spend is gated — a source assertion that the
 *      `maySpend` control is WIRED on both regeneration branches.
 *  10. THE POST-OPEN SLOT: its clock (07:15 and 07:30, dispatched outside the
 *      if/else chain because its window is a SUBSET of morning-rows'), the
 *      06:30 PT staleness refusal in both DST regimes, the level band DERIVED
 *      from SWING_Z_THRESHOLD rather than copied, and the generator's own
 *      source contract — reads the briefing, never writes it, refuses on
 *      `stopReason === max_tokens`, and has no request-path self-heal.
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
  grabConst('SWING_Z_THRESHOLD'),
  grabConst('POSTOPEN_KEY'), grabConst('POSTOPEN_TTL'), grabConst('POSTOPEN_RECORD_SCHEMA'),
  grabConst('POSTOPEN_OPEN_PT_MIN'), grabConst('POSTOPEN_MOVE_PCT'), grabConst('POSTOPEN_NEAR_Z'),
  grabConst('POSTOPEN_CASH_SYMBOLS'),
  grab('dailySlotPtDate'), grab('purgeStaleDailySlots'),
  grab('postOpenDueAt'), grab('ptMinutesOfDay'),
  'return { ptDate, dailySlotPtDate, purgeStaleDailySlots, postOpenDueAt, ptMinutesOfDay,'
  + ' SWING_Z_THRESHOLD, POSTOPEN_KEY, POSTOPEN_TTL, POSTOPEN_RECORD_SCHEMA,'
  + ' POSTOPEN_OPEN_PT_MIN, POSTOPEN_MOVE_PCT, POSTOPEN_NEAR_Z, POSTOPEN_CASH_SYMBOLS };',
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
/* The fourth slot. 07:16 PT on each day — written 46 minutes after the open, which
   is the whole point of it, and which also puts its `ts` in a different UTC hour
   from either sibling so a ts-derived day cannot be right by coincidence. */
const POSTOPEN_TODAY = rec(TODAY, Date.parse('2026-08-19T14:16:00Z'),
  { body: 'Post-open read', complete: true, baseline: '06:00', dataAsOf: Date.parse('2026-08-19T14:01:00Z') });
const POSTOPEN_YDAY  = rec(YDAY,  Date.parse('2026-08-18T14:16:00Z'),
  { body: 'Yesterday post-open', complete: true, baseline: '06:00' });

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
  const kv = stubKV({ 'daily:eod': EOD_TODAY, 'daily:midday': MIDDAY_TODAY, 'daily:postopen': POSTOPEN_TODAY });
  const before = { ...kv.raw };
  const out = await M.purgeStaleDailySlots({ REC_LOG: kv.binding }, TODAY);
  row('eod verdict',                    out['daily:eod'], 'kept');
  row('midday verdict',                 out['daily:midday'], 'kept');
  row('postopen verdict',               out['daily:postopen'], 'kept');
  row('deletes issued',                 kv.ops.filter(o => o[0] === 'delete').length, 0);
  row('puts issued',                    kv.ops.filter(o => o[0] === 'put').length, 0);
  if (populated('byte-identity', before['daily:eod'].length, before['daily:midday'].length,
                                 before['daily:postopen'].length)) {
    row('eod bytes unchanged',          kv.raw['daily:eod'] === before['daily:eod'], true);
    row('midday bytes unchanged',       kv.raw['daily:midday'] === before['daily:midday'], true);
    row('postopen bytes unchanged',     kv.raw['daily:postopen'] === before['daily:postopen'], true);
    row('midday byte length',           kv.raw['daily:midday'].length, before['daily:midday'].length);
  }
}

console.log('\n== 3. ROLLOVER - a new PT date clears both ===================================\n');
{
  const kv = stubKV({ 'daily:eod': EOD_YDAY, 'daily:midday': MIDDAY_YDAY, 'daily:postopen': POSTOPEN_YDAY });
  const out = await M.purgeStaleDailySlots({ REC_LOG: kv.binding }, TODAY);
  row('eod verdict',           out['daily:eod'], 'cleared');
  row('midday verdict',        out['daily:midday'], 'cleared');
  row('postopen verdict',      out['daily:postopen'], 'cleared');
  row('eod gone from KV',      'daily:eod' in kv.raw, false);
  row('midday gone from KV',   'daily:midday' in kv.raw, false);
  row('postopen gone from KV', 'daily:postopen' in kv.raw, false);
  row('deletes issued',        kv.ops.filter(o => o[0] === 'delete').length, 3);
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
    'daily:postopen': POSTOPEN_TODAY,
  });
  const middayBefore   = kv.raw['daily:midday'];
  const postOpenBefore = kv.raw['daily:postopen'];

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
  /* THE REQUIREMENT THE FOURTH SLOT WAS SPECIFIED WITH, asserted directly: a
     manual re-run of the 6:00am briefing must not drop the post-open read. It
     holds for the structural reason the other two hold for — the briefing writer
     touches its own key and then purges only by PT date — so this assertion is
     about that property continuing to hold, not about a new mechanism. */
  row('postOpen SURVIVES a 6:00am re-run', 'daily:postopen' in kv.raw, true);
  row('postOpen bytes unchanged',          kv.raw['daily:postopen'] === postOpenBefore, true);
  row('postOpen ts NOT restamped',         JSON.parse(kv.raw['daily:postopen']).ts, JSON.parse(POSTOPEN_TODAY).ts);

  // (b) the eod generator's own re-run replaces its slot and nothing else.
  const eodRerunTs = Date.parse('2026-08-20T01:12:00Z');
  await kv.binding.put('daily:eod', rec(TODAY, eodRerunTs, { headline: 'eod v2', complete: true }));
  row('eod ts advanced (newest wins)', JSON.parse(kv.raw['daily:eod']).ts, eodRerunTs);
  row('midday STILL byte-identical',   kv.raw['daily:midday'] === middayBefore, true);
  row('postOpen STILL byte-identical', kv.raw['daily:postopen'] === postOpenBefore, true);
  row('snapshot untouched by eod',     JSON.parse(kv.raw['daily:snapshot']).headline, 'rewritten');

  /* (c) THE POST-OPEN JOB'S OWN RE-RUN — the 07:30 retry. It replaces ONLY its
     own slot; the other three are byte-identical afterwards. This is the second
     half of the spec'd requirement and the symmetric case to (a). */
  const poRerunTs = Date.parse('2026-08-19T14:31:00Z');
  const snapBefore3 = kv.raw['daily:snapshot'], eodBefore3 = kv.raw['daily:eod'];
  await kv.binding.put('daily:postopen', rec(TODAY, poRerunTs, { body: 'Post-open v2', complete: true, baseline: '06:00' }));
  row('postOpen ts advanced on its retry', JSON.parse(kv.raw['daily:postopen']).ts, poRerunTs);
  row('postOpen body replaced',            JSON.parse(kv.raw['daily:postopen']).body, 'Post-open v2');
  row('snapshot bytes unchanged by it',    kv.raw['daily:snapshot'] === snapBefore3, true);
  row('midday bytes unchanged by it',      kv.raw['daily:midday'] === middayBefore, true);
  row('eod bytes unchanged by it',         kv.raw['daily:eod'] === eodBefore3, true);
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
  /* `daily:postopen` IS WRITTEN THROUGH A MODULE CONSTANT, NOT A STRING LITERAL
     (`POSTOPEN_KEY`, the `SECTORS_KV_KEY` / `MACRO_KEY` convention). A grep for
     the literal cannot see that site — and a structural check that quietly stops
     covering a key the moment someone names it is worse than no structural check
     at all, because it goes on passing. So the `daily:`-valued constants are
     RESOLVED from source first and the site grep matches either form, recording
     which one it saw. */
  const keyConsts = {};
  for (const m of src.matchAll(/\nconst ([A-Z0-9_]+)\s*=\s*'(daily:[a-z]+)'/g)) keyConsts[m[1]] = m[2];
  console.log(`     daily: key constants resolved: ${JSON.stringify(keyConsts)}`);
  row('7 POSTOPEN_KEY resolves to the slot key', keyConsts.POSTOPEN_KEY, 'daily:postopen');

  const sites = [...src.matchAll(/REC_LOG\??\.(put|delete)\(\s*(?:'(daily:[a-z]+)'|([A-Z0-9_]+))/g)]
    .map(m => ({ op: m[1], key: m[2] || keyConsts[m[3]], fn: fnAt(m.index), via: m[2] ? 'literal' : m[3] }))
    .filter(s => s.key);   // a non-`daily:` constant (MACRO_KEY, SECTORS_KV_KEY) drops out here

  if (populated('daily: mutation sites', sites.length)) {
    for (const s of sites) console.log(`     ${pad(s.op, 7)} ${pad(s.key, 16)} in ${pad(s.fn, 24)} via ${s.via}`);

    row('7 the postopen site was found via the constant, not a literal',
        sites.filter(s => s.key === 'daily:postopen').map(s => s.via).join(','), 'POSTOPEN_KEY');

    const OWNS = {
      generateDailySnapshot:  'daily:snapshot',
      generateEODSummary:     'daily:eod',
      generateMiddaySnapshot: 'daily:midday',
      generatePostOpenRead:   'daily:postopen',
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
    /* ALL THREE siblings, not two. `daily:postopen` joined the list in the same
       commit that created it — a slot the rollover purge does not know about is
       a slot that renders yesterday's reading under today's date, which is the
       exact failure this purge exists to prevent, reintroduced by omission. */
    row('purge iterates all three sibling keys',
        /for \(const key of \['daily:eod', 'daily:midday', 'daily:postopen'\]\)/.test(purgeSrc), true);
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

console.log('\n== 10. THE POST-OPEN SLOT - its clock, its gates, its refusals ===============\n');
{
  /* The fourth slot, added 2026-11-13. Three things here are not provable from
     the behavioural purge sections above: WHEN it runs, WHAT it refuses, and
     that nothing it needed was left as a second copy of a constant that already
     exists elsewhere in the Worker. */

  // (a) THE CLOCK. Its window is 07:15-07:44 and it is dispatched outside the
  //     if/else chain, because that window is a strict SUBSET of morning-rows'
  //     `h === 7 && m < 45` branch — an `else if` after that branch is
  //     unreachable code. The truth table is what makes "it never fired" and
  //     "it was never due" distinguishable.
  const due = [];
  for (const [h, m] of [[6, 45], [7, 0], [7, 14], [7, 15], [7, 30], [7, 44], [7, 45], [8, 15], [13, 15]]) {
    const v = M.postOpenDueAt(h, m);
    due.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}=${v ? 'Y' : 'n'}`);
  }
  row('10a the 7am truth table', due.join(' '),
      '06:45=n 07:00=n 07:14=n 07:15=Y 07:30=Y 07:44=Y 07:45=n 08:15=n 13:15=n');
  row('10a ...exactly TWO quarter-hour firings',
      [0, 15, 30, 45].filter(m => M.postOpenDueAt(7, m)).length, 2);
  /* 07:00 is morning-rows' FIRST firing and must NOT be one of ours: the
     post-open read is named for being after the open, and at 07:00 the freshest
     delayed print is 06:45 — fifteen minutes of session, not forty-five. */
  row('10a 07:00 is morning-rows only, not a post-open firing', M.postOpenDueAt(7, 0), false);

  // (b) THE STALENESS GATE is the 06:30 PT cash open, in PT minutes-of-day.
  row('10b the open, as PT minutes-of-day', M.POSTOPEN_OPEN_PT_MIN, 390);
  row('10b ...which is 06:30', `${Math.floor(M.POSTOPEN_OPEN_PT_MIN / 60)}:${String(M.POSTOPEN_OPEN_PT_MIN % 60).padStart(2, '0')}`, '6:30');

  /* `ptMinutesOfDay` across BOTH DST regimes and across UTC midnight. A gate
     measured in Pacific minutes against a UTC instant is exactly where a
     half-year-silent failure lives (rule #2's lesson applied to a reader rather
     than to the cron expression). */
  const ptm = [
    ['2026-11-13T14:01:00Z', 'PST  06:01 PT (pre-open)',  361],
    ['2026-11-13T14:30:00Z', 'PST  06:30 PT (the open)',  390],
    ['2026-11-13T15:10:00Z', 'PST  07:10 PT',             430],
    ['2026-09-02T13:01:00Z', 'PDT  06:01 PT (pre-open)',  361],
    ['2026-09-02T13:30:00Z', 'PDT  06:30 PT (the open)',  390],
    ['2026-09-02T14:10:00Z', 'PDT  07:10 PT',             430],
    ['2026-08-20T05:30:00Z', 'PDT  22:30 PT prev day',   1350],
  ];
  for (const [iso, label, want] of ptm) row(`10b ptMinutesOfDay ${label}`, M.ptMinutesOfDay(Date.parse(iso)), want);
  row('10b ptMinutesOfDay(null) is null, not 0', M.ptMinutesOfDay(null), null);
  row('10b ptMinutesOfDay(NaN) is null, not 0',  M.ptMinutesOfDay(NaN), null);

  /* THE GATE APPLIED. A 06:01 PT print is a PRE-OPEN price under both regimes,
     and the whole refusal exists because narrating one as a post-open reading is
     wrong about which session it describes rather than merely imprecise. */
  for (const [iso, label] of [['2026-11-13T14:01:00Z', 'PST'], ['2026-09-02T13:01:00Z', 'PDT']]) {
    row(`10b 06:01 PT under ${label} REFUSES`, M.ptMinutesOfDay(Date.parse(iso)) < M.POSTOPEN_OPEN_PT_MIN, true);
  }
  for (const [iso, label] of [['2026-11-13T15:10:00Z', 'PST'], ['2026-09-02T14:10:00Z', 'PDT']]) {
    row(`10b 07:10 PT under ${label} PASSES`, M.ptMinutesOfDay(Date.parse(iso)) >= M.POSTOPEN_OPEN_PT_MIN, true);
  }

  // (c) THE LEVEL BAND IS DERIVED FROM THE SWING GATE, never a second copy of
  //     1.5. The Worker decides the Swing signal and the frontend is forbidden
  //     its own copy of the threshold; a prompt that re-judged it would be the
  //     same drift by another route.
  row('10c SWING_Z_THRESHOLD, from source',       M.SWING_Z_THRESHOLD, 1.5);
  row('10c POSTOPEN_NEAR_Z is derived from it',   M.POSTOPEN_NEAR_Z, 1.0);
  row('10c ...and is strictly inside the gate',   M.POSTOPEN_NEAR_Z < M.SWING_Z_THRESHOLD, true);
  const nearSrc = grabConst('POSTOPEN_NEAR_Z');
  console.log(`     ${nearSrc.trim()}`);
  row('10c ...declared as an expression, not a literal', /SWING_Z_THRESHOLD/.test(nearSrc), true);

  // (d) THE SLOT CONSTANTS.
  row('10d the KV key',                  M.POSTOPEN_KEY, 'daily:postopen');
  row('10d retention matches the siblings (2d)', M.POSTOPEN_TTL, 172800);
  row('10d the mover cut',               M.POSTOPEN_MOVE_PCT, 3);
  row('10d the record schema version',   M.POSTOPEN_RECORD_SCHEMA, 1);
  /* CASH INDICES ONLY for the as-of. Futures quote overnight, so ES=F's
     regularMarketTime is fresh at 4am and would walk the staleness gate straight
     past a dead cash feed. */
  row('10d the as-of symbols are cash indices', M.POSTOPEN_CASH_SYMBOLS.join(','), '^GSPC,^IXIC,^DJI,^RUT');
  row('10d ...and carry NO futures contract',
      M.POSTOPEN_CASH_SYMBOLS.some(s => s.endsWith('=F')), false);

  // (e) SOURCE ASSERTIONS on the generator. Each needs a live Yahoo snapshot, a
  //     Claude call and a KV binding to exercise behaviourally; what can be
  //     pinned here is that the control is WIRED, which is section 9's standard.
  const gen = grab('generatePostOpenRead');
  row('10e reads daily:snapshot',            /get\('daily:snapshot', 'json'\)/.test(gen), true);
  row('10e NEVER writes daily:snapshot',     /put\('daily:snapshot'/.test(gen), false);
  row('10e writes only through POSTOPEN_KEY',
      (gen.match(/REC_LOG\??\.put\(/g) || []).length === 1 && /put\(POSTOPEN_KEY/.test(gen), true);
  row('10e deletes nothing at all',          /REC_LOG\??\.delete\(/.test(gen), false);
  /* The baseline must be TODAY'S record. Comparing an open against yesterday's
     pre-market brief would read as a plausible paragraph about the wrong day. */
  row('10e the baseline is gated on the PT date', /snapDay === todayPt/.test(gen), true);
  row('10e baseline "none" when no part is present', /baselineParts\.length \? '06:00' : 'none'/.test(gen), true);
  /* The dedup needs the CONTENT term, or a refusal written at 07:15 dedups the
     07:30 retry out of the day — the defect the EOD placeholder's `ts: 0` closed
     by a different route. */
  row('10e dedup requires complete === true', /existing\.complete === true && existing\.ptDate === todayPt/.test(gen), true);
  /* `claudeText()` cannot tell a complete answer from a truncated one, and this
     slot stores prose that renders as finished. */
  row('10e asks for stopReason (raw: true)',  /\{ raw: true \}/.test(gen), true);
  row('10e refuses on max_tokens',            /stopReason === 'max_tokens'/.test(gen), true);
  row('10e ...and does NOT store the truncated text as body',
      /phase: 'truncated'/.test(gen) && !/body: answer/.test(gen), true);
  row('10e a down source forces complete:false', /complete: missing\.length === 0/.test(gen), true);
  /* COMMENTS STRIPPED FIRST. A bare /ts: 0/ over the raw function matched the
     PROSE of this file's own explanation of why it does NOT use `ts: 0` — the
     same trap longarch §6f records, where a minute bound was read off a comment
     while the code said something else and the assertion passed on the fault it
     existed to catch. */
  const genCode = gen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  row('10e ts is always the real write time, never a sentinel',
      /ts: Date\.now\(\)/.test(genCode) && !/ts: 0/.test(genCode), true);
  row('10e uses the unauthenticated spark, not a crumb path',
      /yahooSparkQuotes\(/.test(gen) && !/yahooAuth\(/.test(gen), true);
  /* Since 2026-11-16 the level verdicts are decided in the PURE payload builder
     the generator calls, so a check can replay a banked morning through it. The
     property is unchanged: the SAME swingChannel as the Swing column, never a
     re-derivation — and the generator must actually route through the builder. */
  const builder = grab('postOpenBuildPayload');
  row('10e reuses swingChannel rather than re-deriving a level',
      /swingChannel\(q\.pairs, q\.price[,)]/.test(builder), true);
  row('10e ...and the generator builds its prompt through it',
      /postOpenBuildPayload\(\{/.test(gen) && /postOpenPrompt\(payload\)/.test(gen), true);

  // (f) THE 6:00am WRITER BANKS THE LEVELS the post-open read compares against.
  //     Without this the comparison is unanswerable, and the tempting wrong
  //     answer is to parse numbers back out of the briefing's own sentences.
  const snapGen = grab('generateDailySnapshot');
  row('10f the briefing collects marketLevels',  /const marketLevels = \{\}/.test(snapGen), true);
  row('10f ...and stores them on the record',    /ptDate: todayPt, marketLevels,/.test(snapGen), true);
  row('10f ...on the placeholder write too',     /ptDate: todayPt, marketLevels \}\)/.test(snapGen), true);
  row('10f ...at zero added subrequests (no new fetch in that block)',
      (snapGen.match(/snapshot:index-charts/g) || []).length, 1);

  // (g) THE READ PATH merges the slot and has NO request-path self-heal.
  //     Deliberate, and for the midday pulse's reason rather than the EOD one:
  //     this job spends a Claude call to describe a 45-minute-old open, so a 2pm
  //     page load triggering it would buy a billed call to narrate a session
  //     five hours gone.
  const handler = grab('handleDailyGet');
  row('10g /api/daily reads the slot',      /get\(POSTOPEN_KEY, 'json'\)/.test(handler), true);
  row('10g ...and merges it as postOpen',   /postOpen: postOpen \|\| null/.test(handler), true);
  row('10g NO request-path self-heal for it', /generatePostOpenRead\(env\)/.test(handler), false);
  row('10g the slot is read in the same allSettled as its siblings',
      /postOpenRes\] = await Promise\.allSettled/.test(handler), true);

  // (h) THE DISPATCH is outside the if/else chain, for the print-tape reason.
  row('10h dispatched via dispatchJob, never a bare waitUntil',
      /dispatchJob\(ctx, 'post-open-read', \(\) => generatePostOpenRead\(env\)\)/.test(src), true);
  row('10h ...OUTSIDE the chain (no `else if` introduces it)',
      /\} else if \([^)]*\) \{\s*(?:\/\*[\s\S]*?\*\/\s*)?branch = 'post-open/.test(src), false);
  row('10h the log line names it when due',  /\+ \(postOpenDue \? ' \+ post-open-read' : ''\)/.test(src), true);
}

process.exit(reportVerdict({
  label: 'daily slot merge', comparisons: t.comparisons, failures: t.failures, minComparisons: 139,
}));
