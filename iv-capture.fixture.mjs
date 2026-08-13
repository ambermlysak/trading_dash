#!/usr/bin/env node
/* Regression fixture for iv-capture.mjs's COMPARISON branch.
 *
 * WHY THIS EXISTS. The 2026-08-12 dry run against live KV exercised the
 * no-change path only — `rewritten: 0`, every `ts` identical. An empty
 * comparison is not a pass, and the logic that matters on a day the guard
 * misfires (rewrite detection, per-ticker delta arithmetic, the ts gap, and the
 * only-in-pass-1 / only-in-pass-2 buckets) had never executed against changed
 * data. This synthesises that data from the real snapshot and asserts the
 * arithmetic against hand-computed expectations.
 *
 *   node iv-capture.fixture.mjs            # build fixtures, assert, print
 *   node iv-capture.fixture.mjs --keep     # also leave them on disk for --compare
 *
 * Prints computed vs expected rather than asserting silently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const DIR = process.env.IV_FIXTURE_DIR
  || path.join(process.env.TEMP || '/tmp', 'iv-capture-fixture');
fs.mkdirSync(DIR, { recursive: true });

/* A pass-1 snapshot in the exact shape snapshot() writes: every watchlist name is
   a key, missing ones hold null. Values are the real 2026-08-12 readings. */
const BASE_TS = '2026-08-12T20:15:0';
const pass1 = {
  at: '2026-08-12T20:17:00.000Z', date: '2026-08-12', sweepStamp: null,
  rows: {
    NVDA: { atmIv: 30.61, expiry: '2026-08-19', dte: 7, spot: 224.09, ts: BASE_TS + '7.160Z', src: 'sweep' },
    AAPL: { atmIv: 20.85, expiry: '2026-08-19', dte: 7, spot: 302.25, ts: '2026-08-12T20:15:14.450Z', src: 'sweep' },
    PLTR: { atmIv: 44.71, expiry: '2026-08-21', dte: 9, spot: 171.04, ts: BASE_TS + '7.162Z', src: 'sweep' },
    MU:   { atmIv: 59.55, expiry: '2026-08-19', dte: 7, spot: 911.29, ts: BASE_TS + '9.242Z', src: 'sweep' },
    TSLA: { atmIv: 33.22, expiry: '2026-08-19', dte: 7, spot: 327.51, ts: '2026-08-12T20:15:11.098Z', src: 'sweep' },
    AMD:  { atmIv: 41.10, expiry: '2026-08-19', dte: 7, spot: 180.00, ts: BASE_TS + '8.000Z', src: 'sweep' },
    HOOD: { atmIv: 52.00, expiry: '2026-08-19', dte: 7, spot: 100.00, ts: BASE_TS + '8.500Z', src: 'sweep' },
    KTOS: null,          // missed by the first pass, as it really was on 08-12
    MRVL: null,          // never recorded either pass
  },
};

/* Pass 2 = what a SECOND sweep at 13:30 would leave behind. Six cases: */
const P2_TS = '2026-08-12T20:30:1';
const pass2 = { at: '2026-08-12T20:33:30.000Z', date: '2026-08-12', sweepStamp: null, rows: {
  // 1. rewritten, atmIv MOVED UP        delta +0.44, gap 903s
  NVDA: { atmIv: 31.05, expiry: '2026-08-19', dte: 7, spot: 224.40, ts: '2026-08-12T20:30:10.160Z', src: 'sweep' },
  // 2. rewritten, atmIv MOVED DOWN      delta -0.60, gap 896s
  AAPL: { atmIv: 20.25, expiry: '2026-08-19', dte: 7, spot: 302.60, ts: '2026-08-12T20:30:10.450Z', src: 'sweep' },
  // 3. rewritten, atmIv IDENTICAL       delta 0 — a rewrite with no measurement change
  PLTR: { atmIv: 44.71, expiry: '2026-08-21', dte: 9, spot: 171.10, ts: P2_TS + '1.000Z', src: 'sweep' },
  // 4. rewritten, large move            delta -2.30
  MU:   { atmIv: 57.25, expiry: '2026-08-19', dte: 7, spot: 910.00, ts: P2_TS + '2.000Z', src: 'sweep' },
  // 5. UNTOUCHED — identical ts, second pass never reached it
  TSLA: { atmIv: 33.22, expiry: '2026-08-19', dte: 7, spot: 327.51, ts: '2026-08-12T20:15:11.098Z', src: 'sweep' },
  // 6. present in pass 1, ABSENT in pass 2 — a key that disappeared
  AMD:  null,
  // 7. rewritten, tiny move             delta +0.01
  HOOD: { atmIv: 52.01, expiry: '2026-08-19', dte: 7, spot: 100.10, ts: P2_TS + '3.000Z', src: 'sweep' },
  // 8. absent in pass 1, PRESENT in pass 2 — the second pass RECOVERED it
  KTOS: { atmIv: 38.40, expiry: '2026-08-21', dte: 9, spot: 63.82, ts: P2_TS + '4.000Z', src: 'sweep' },
  // 9. absent in BOTH
  MRVL: null,
} };

const f1 = path.join(DIR, 'fx-pass1.json');
const f2 = path.join(DIR, 'fx-pass2.json');
fs.writeFileSync(f1, JSON.stringify(pass1, null, 1));
fs.writeFileSync(f2, JSON.stringify(pass2, null, 1));

console.log('═══ FIXTURE ═══');
console.log(`  ${f1}\n  ${f2}\n`);

const out = execSync(`node "${path.join(process.cwd(), 'iv-capture.mjs')}" --compare "${f1}" "${f2}"`,
  { encoding: 'utf8' });
console.log(out);

/* ── hand-computed expectations, printed against what the tool reported ──── */
const gapS = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 1000);
const EXPECT = [
  ['rewritten count',            '5',      /rewritten: (\d+)/],
  ['untouched count',            '1',      /untouched: (\d+)/],
  ['only in pass 1',             '1',      /only in pass 1: (\d+)/],
  ['only in pass 2',             '1',      /only in pass 2: (\d+)/],
  ['absent both',                '1',      /absent both: (\d+)/],
  ['names total',                '9',      /names: (\d+)/],
];
let pass = 0, fail = 0;
console.log('═══ COMPUTED vs EXPECTED ═══');
for (const [label, want, re] of EXPECT) {
  const got = (re.exec(out) || [])[1];
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(22)} computed ${String(got).padStart(3)}   expected ${want}`);
}

// Hand-check the delta arithmetic on four rows, from the input values above.
const HAND = [
  ['NVDA', 30.61, 31.05, pass1.rows.NVDA.ts, pass2.rows.NVDA.ts],
  ['AAPL', 20.85, 20.25, pass1.rows.AAPL.ts, pass2.rows.AAPL.ts],
  ['MU',   59.55, 57.25, pass1.rows.MU.ts,   pass2.rows.MU.ts],
  ['PLTR', 44.71, 44.71, pass1.rows.PLTR.ts, pass2.rows.PLTR.ts],
];
console.log('\n  per-ticker delta and gap, hand-computed from the fixture inputs:');
for (const [t, a, b, ta, tb] of HAND) {
  const wantD = +(b - a).toFixed(4), wantG = gapS(ta, tb);
  const row = new RegExp(`^\\s*${t}\\s+([\\d.-]+)\\s+([\\d.-]+)\\s+([\\d.-]+)\\s+(-?\\d+)`, 'm').exec(out);
  const gotD = row ? +row[3] : null, gotG = row ? +row[4] : null;
  const ok = gotD === wantD && gotG === wantG;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${t.padEnd(6)} delta computed ${String(gotD).padStart(7)} expected ${String(wantD).padStart(7)}`
    + `   gap computed ${String(gotG).padStart(4)}s expected ${String(wantG).padStart(4)}s`);
}

// The two behaviours that must be DEFINED, not discovered.
const checks = [
  ['present in pass 1, absent in pass 2 reports DISTINCTLY from absent-in-both',
   /ONLY IN PASS 1[^\n]*AMD/.test(out) && /ABSENT IN BOTH[^\n]*MRVL/.test(out)
   && !/ONLY IN PASS 1[^\n]*MRVL/.test(out)],
  ['absent in pass 1, present in pass 2 reports as RECOVERED',
   /ONLY IN PASS 2[^\n]*KTOS/.test(out)],
  ['identical atmIv with a changed ts reports as REWRITTEN, not untouched',
   /^\s*PLTR\s/m.test(out) && /rewritten: 5/.test(out)],
  ['the no-measurement-change subset is called out explicitly',
   /identical atmIv/i.test(out)],
  ['signed mean is reported (direction, not just magnitude)',
   /SIGNED MEAN/.test(out)],
];
console.log('\n  defined behaviours:');
for (const [label, ok] of checks) { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`); }

console.log(`\n═══ ${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} across ${pass + fail} comparisons ═══`);
if (!process.argv.includes('--keep')) { fs.rmSync(f1, { force: true }); fs.rmSync(f2, { force: true }); }
process.exit(fail ? 1 : 0);
