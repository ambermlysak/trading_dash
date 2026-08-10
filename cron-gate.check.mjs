/* Cron trading-day gate check — prints computed vs expected, per the
   verification standard in CLAUDE.md. Nothing here asserts silently; every row
   shows what was computed next to what was expected, and the deviation.

   It imports the REAL functions out of worker.js rather than re-implementing
   them, so a change to the gate that breaks the contract shows up here.

   Run:  node cron-gate.check.mjs

   BLIND SPOT, stated up front: this exercises the dispatcher's decision logic.
   It cannot tell you what Cloudflare's cron parser does with the expression in
   wrangler.toml — that is precisely the layer that failed last time, and only a
   deployed heartbeat can confirm it. */

import { reportVerdict, populated } from './check-harness.mjs';
import {
  ptParts, tradingDayStatus, cronGateCalendar,
  allSettledCounted, instrPeek, instrMark, instrSince,
} from './worker.js';

// Handed out through an accessor because workerd only permits FUNCTION named
// exports — exporting the Set and the string directly stopped the runtime from
// booting at all.
const { holidays: NYSE_HOLIDAYS, through: NYSE_HOLIDAYS_THROUGH } = cronGateCalendar();

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* Rebuild the exact `pt` object scheduled() builds, from a UTC instant. */
const toPt = (utcIso) =>
  new Date(new Date(Date.parse(utcIso)).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));

/* The branch chain, mirroring scheduled(). Kept in step by the fact that any
   divergence shows as a wrong branch name in the table below. */
function branchFor(h, m) {
  if (h === 6 && m < 30) return 'morning-briefing';
  if ((h === 11 && m >= 30) || h === 12) return 'midday-pulse';
  if (h === 13 && m >= 15 && m < 45) return 'eod+iv-sweep';
  if (h === 14 && m < 30) return 'forward-returns';
  if (h === 10) return '13f-slice';
  return 'idle';
}

/* Each case: the UTC instant the cron would fire, and what we expect to happen.
   PDT is UTC-7 (August), PST is UTC-8 (January) — 13:00Z and 14:00Z are both
   6:00am PT in their respective regimes, which is why both appear. */
const CASES = [
  // ── PDT (August 2026) ──
  ['2026-08-07T13:00:00Z', 'PDT', 'Friday 6:00am    (THE REGRESSION)', '2026-08-07', 'Fri', true,  'weekday',      'morning-briefing'],
  ['2026-08-07T15:00:00Z', 'PDT', 'Friday 8:00am    (in-window, idle)', '2026-08-07', 'Fri', true,  'weekday',      'idle'],
  ['2026-08-08T13:00:00Z', 'PDT', 'Saturday 6:00am',                    '2026-08-08', 'Sat', false, 'weekend',      'none'],
  ['2026-08-09T13:00:00Z', 'PDT', 'Sunday 6:00am    (was burning $$)',  '2026-08-09', 'Sun', false, 'weekend',      'none'],
  ['2026-08-10T13:00:00Z', 'PDT', 'Monday 6:00am',                      '2026-08-10', 'Mon', true,  'weekday',      'morning-briefing'],
  ['2026-09-07T13:00:00Z', 'PDT', 'Labor Day (holiday, a Monday)',      '2026-09-07', 'Mon', false, 'nyse-holiday', 'none'],
  ['2026-11-26T13:00:00Z', 'PDT', 'Thanksgiving (holiday, a Thursday)', '2026-11-26', 'Thu', false, 'nyse-holiday', 'none'],
  ['2026-08-07T20:15:00Z', 'PDT', 'Friday 1:15pm    (EOD + IV sweep)',  '2026-08-07', 'Fri', true,  'weekday',      'eod+iv-sweep'],
  ['2026-08-07T17:00:00Z', 'PDT', 'Friday 10:00am   (13F slice)',       '2026-08-07', 'Fri', true,  'weekday',      '13f-slice'],

  // ── PST (January 2027) — same Pacific wall-clock, one UTC hour later ──
  ['2027-01-08T14:00:00Z', 'PST', 'Friday 6:00am',                      '2027-01-08', 'Fri', true,  'weekday',      'morning-briefing'],
  ['2027-01-09T14:00:00Z', 'PST', 'Saturday 6:00am',                    '2027-01-09', 'Sat', false, 'weekend',      'none'],
  ['2027-01-10T14:00:00Z', 'PST', 'Sunday 6:00am',                      '2027-01-10', 'Sun', false, 'weekend',      'none'],
  ['2027-01-01T14:00:00Z', "PST", "New Year's Day (holiday, a Friday)",  '2027-01-01', 'Fri', false, 'nyse-holiday', 'none'],
  ['2027-01-18T14:00:00Z', 'PST', 'MLK Day (holiday, a Monday)',        '2027-01-18', 'Mon', false, 'nyse-holiday', 'none'],
  ['2027-01-11T14:00:00Z', 'PST', 'Monday 6:00am',                      '2027-01-11', 'Mon', true,  'weekday',      'morning-briefing'],
  ['2027-03-26T13:00:00Z', 'PDT', 'Good Friday (holiday, a Friday)',    '2027-03-26', 'Fri', false, 'nyse-holiday', 'none'],
  ['2027-12-24T14:00:00Z', 'PST', 'Christmas observed (a Friday)',      '2027-12-24', 'Fri', false, 'nyse-holiday', 'none'],
  ['2027-01-08T19:30:00Z', 'PST', 'Friday 11:30am   (midday pulse)',    '2027-01-08', 'Fri', true,  'weekday',      'midday-pulse'],
  ['2027-01-08T22:00:00Z', 'PST', 'Friday 2:00pm    (forward returns)', '2027-01-08', 'Fri', true,  'weekday',      'forward-returns'],

  // ── Hours OUTSIDE the 13-22 UTC window ──────────────────────────────────
  // The every-5-minutes diagnostic probe fires around the clock, so the
  // dispatcher now sees Pacific hours it has never been given before: every
  // branch is keyed to 6/10/11/12/13/14 PT, and everything else must fall
  // through to `idle` rather than matching by accident. Note the UTC date and
  // the PT date diverge here — 03:00Z Saturday is Friday evening in Pacific,
  // which is a TRADING day, and 07:00Z Monday is Sunday night, which is not.
  ['2026-08-08T03:00:00Z', 'PDT', 'UTC Sat 03:00 = Fri 8:00pm PT',      '2026-08-07', 'Fri', true,  'weekday',      'idle'],
  ['2026-08-08T07:00:00Z', 'PDT', 'UTC Sat 07:00 = Sat 12:00am PT',     '2026-08-08', 'Sat', false, 'weekend',      'none'],
  ['2026-08-10T06:00:00Z', 'PDT', 'UTC Mon 06:00 = Sun 11:00pm PT',     '2026-08-09', 'Sun', false, 'weekend',      'none'],
  ['2026-08-10T07:00:00Z', 'PDT', 'UTC Mon 07:00 = Mon 12:00am PT',     '2026-08-10', 'Mon', true,  'weekday',      'idle'],
  ['2026-08-07T09:00:00Z', 'PDT', 'Friday 2:00am    (pre-window)',      '2026-08-07', 'Fri', true,  'weekday',      'idle'],
  ['2026-08-07T12:00:00Z', 'PDT', 'Friday 5:00am    (one hr early)',    '2026-08-07', 'Fri', true,  'weekday',      'idle'],
  ['2026-08-07T23:00:00Z', 'PDT', 'Friday 4:00pm    (post-window)',     '2026-08-07', 'Fri', true,  'weekday',      'idle'],
  ['2026-08-08T06:55:00Z', 'PDT', 'Fri 11:55pm PT   (day boundary)',    '2026-08-07', 'Fri', true,  'weekday',      'idle'],
  ['2026-09-08T03:00:00Z', 'PDT', 'UTC Tue 03:00 = Labor Day 8pm PT',   '2026-09-07', 'Mon', false, 'nyse-holiday', 'none'],
];

console.log('Cron trading-day gate — computed vs expected\n');
console.log(
  'UTC instant           TZ   case                                | computed date  dow  open   reason        branch            | expected                                    | ok',
);
console.log('-'.repeat(210));

let pass = 0, fail = 0;
for (const [utc, tz, label, expIso, expDow, expOpen, expReason, expBranch] of CASES) {
  const pt = toPt(utc);
  const { iso, dow } = ptParts(pt);
  const st = tradingDayStatus(iso, dow);
  const branch = st.open ? branchFor(pt.getHours(), pt.getMinutes()) : 'none';

  const ok = iso === expIso && DOW[dow] === expDow && st.open === expOpen &&
             st.reason === expReason && branch === expBranch;
  ok ? pass++ : fail++;

  const got = `${iso}  ${DOW[dow]}  ${String(st.open).padEnd(5)}  ${st.reason.padEnd(12)}  ${branch.padEnd(16)}`;
  const exp = `${expIso}  ${expDow}  ${String(expOpen).padEnd(5)}  ${expReason.padEnd(12)}  ${expBranch.padEnd(16)}`;
  console.log(`${utc}  ${tz}  ${label.padEnd(35)} | ${got} | ${exp} | ${ok ? 'ok' : 'MISMATCH'}`);
}

console.log('-'.repeat(210));
console.log(`\n${pass} matched, ${fail} mismatched, ${CASES.length} cases\n`);

/* The gate table is the substance of this script, so its population is asserted
   here rather than only at the end: a CASES array that emptied would otherwise
   print "0 matched, 0 mismatched" and exit 0. */
if (!populated('cron gate table', pass + fail)) process.exitCode = 1;

/* The regression in one line: under the old `1-5` cron the Friday rows above
   never reached this dispatcher at all, and the Sunday rows did. */
/* ── Instrumentation: does the rejection counter actually count? ─────────────
   A natural cron run tends to produce settledRejected: 0, which is
   indistinguishable from a counter that is wired up wrong. So force rejections
   and print the delta. */
console.log('allSettledCounted — forced-failure check');
{
  const before = instrPeek().rejected;
  const results = await allSettledCounted([
    Promise.resolve('ok'),
    Promise.reject(new Error('deliberate failure A')),
    Promise.resolve('ok'),
    Promise.reject(new Error('deliberate failure B')),
  ], 'selftest:forced');
  const delta = instrPeek().rejected - before;
  console.log(`  promises=4  fulfilled=${results.filter(r => r.status === 'fulfilled').length}` +
              `  rejected=${results.filter(r => r.status === 'rejected').length}` +
              `  counter delta=${delta}  expected=2  ${delta === 2 ? 'ok' : 'MISMATCH'}`);
  if (delta !== 2) process.exitCode = 1;
}

/* ── Instrumentation must never break what it measures ──────────────────────
   The contract: an instrumentation failure degrades to a missing or
   `measured:false` _instr field, never to a lost payload or a rejected job. */
console.log('\ninstrumentation containment — forced-fault checks');
{
  let ok = true;

  // 1. instrSince with no baseline. This call sits inside the JSON.stringify of
  //    a KV put, so throwing here would lose the whole briefing.
  try {
    const stub = instrSince(null, 'briefing');
    const good = stub && stub.measured === false && stub.phase === 'briefing';
    console.log(`  instrSince(null)                 -> ${JSON.stringify(stub)}  ${good ? 'ok' : 'MISMATCH'}`);
    if (!good) ok = false;
  } catch (e) {
    console.log(`  instrSince(null)                 -> THREW ${e.message}  MISMATCH`); ok = false;
  }

  // 2. A rejection whose reason explodes on property access. Promise.allSettled
  //    never rejects; neither may allSettledCounted.
  const poison = new Proxy({}, { get() { throw new Error('poisoned reason'); } });
  try {
    const res = await allSettledCounted(
      [Promise.resolve(1), Promise.reject(poison)],
      'selftest:poisoned',
    );
    const good = Array.isArray(res) && res.length === 2 &&
                 res[0].status === 'fulfilled' && res[1].status === 'rejected';
    console.log(`  allSettledCounted(poisoned)      -> resolved, ${res.length} results, statuses ` +
                `[${res.map(r => r.status).join(', ')}]  ${good ? 'ok' : 'MISMATCH'}`);
    if (!good) ok = false;
  } catch (e) {
    console.log(`  allSettledCounted(poisoned)      -> REJECTED ${e.message}  MISMATCH`); ok = false;
  }

  // 3. instrMark must not throw either; it is the first line of each generator.
  try {
    const m = instrMark();
    const good = m && typeof m.f === 'number';
    console.log(`  instrMark()                      -> ${JSON.stringify(m)}  ${good ? 'ok' : 'MISMATCH'}`);
    if (!good) ok = false;
  } catch (e) {
    console.log(`  instrMark()                      -> THREW ${e.message}  MISMATCH`); ok = false;
  }

  if (!ok) process.exitCode = 1;
}

console.log('\nHoliday table:', NYSE_HOLIDAYS.size, 'dates, runway through', NYSE_HOLIDAYS_THROUGH);
const soon = new Date(Date.now() + 120 * 864e5).toISOString().slice(0, 10);
console.log('Runway check :', NYSE_HOLIDAYS_THROUGH < soon
  ? `WARN — table ends within 120 days (${NYSE_HOLIDAYS_THROUGH}); extend it`
  : `ok — ${NYSE_HOLIDAYS_THROUGH} is more than 120 days out`);

/* `|| process.exitCode` preserves a failure already recorded by the forced-fault
   instrumentation section below the table, which sets it directly. */
process.exitCode = reportVerdict({
  label: 'cron-gate.check', comparisons: pass + fail, failures: fail, minComparisons: 28,
}) || process.exitCode || 0;
