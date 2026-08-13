#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   iv-capture.mjs — measure whether the IV sweep's SECOND pass rewrites the
   series with a different reading.

   WHY THIS EXISTS. `recordWatchlistIv` stamps `ivsweep:last` only on a complete
   run (`ok === tickers.length`). When it does not stamp, the 1:15pm branch's
   second firing at 1:30pm PT runs the whole sweep again — and the cron path
   passes no `skipIfPresent`, so it OVERWRITES every sample already banked.

   A 1:30pm post-close ATM IV is a different measurement from a 1:15pm one. If
   the guard misfires daily, every stored sample silently becomes the :30 reading
   with identical keys, identical shape and identical `src: 'sweep'` — a
   systematic shift in what the series measures, landing in the series `ivRank`
   percentiles at day 60. This script is the only chance to see it, because the
   two passes are 15 minutes apart and the second destroys the first.

   READ-ONLY. It reads KV through the Cloudflare REST API with wrangler's own
   credential. It NEVER calls `/api/iv/:ticker` — that endpoint WRITES a sample
   (`recordIvSample` at the "Record before ranking" call site) and would corrupt
   the very measurement being taken. For the same reason, do not open the Long
   tab and expand a row while this is running: `/api/long/:ticker` writes an
   `iv:` key with `src: 'long-live'`.

   WHY REST RATHER THAN 33 × `wrangler kv key get`. Each `npx wrangler` invocation
   costs seconds of startup; 33 of them serially can run past the 1:30pm boundary
   and turn pass 1 into a mixture of both sweeps. One wrangler call is still made
   first, purely to force an OAuth token refresh, and the same credential is then
   used in parallel. Same auth, same read-only operation, inside the window.

   USAGE
     node iv-capture.mjs            # run between 1:16pm and 1:28pm PT
     node iv-capture.mjs --force    # override the window guard, loudly
     node iv-capture.mjs --compare <pass1.json> <pass2.json>   # redo offline

   It refuses to run outside the window rather than producing a meaningless
   pass 1 — a snapshot taken before the first sweep has finished writing is not
   a baseline, it is half of one.
   ═══════════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ACCT = 'b73dcf57a4832dc660464d6d69c4fde3';
const NS   = '6e2feae8a08c4db0b564e5bce18d2b01';   // REC_LOG, from wrangler.toml
const CFG  = path.join(process.env.APPDATA || process.env.HOME || '',
                       'xdg.config', '.wrangler', 'config', 'default.toml');
const OUTDIR = process.env.IV_CAPTURE_DIR || path.join(process.cwd(), 'iv-capture-out');

/* ── window constants, derived from the observed 2026-08-12 firing ──────────
   First pass ran 13:15:07–13:15:18 PT (11s for 32 names). Second pass, if the
   stamp is withheld, starts 13:30:0x. */
const PASS1_OPEN   = { h: 13, m: 16 };   // +45s margin over the observed finish
const PASS1_CLOSE  = { h: 13, m: 28 };   // 2 min before the second pass starts
const PASS2_AFTER  = { h: 13, m: 33 };   // second pass writes through ~13:30:30
const STABILITY_MS = 45_000;             // re-read gap used to detect a still-running sweep

const args = process.argv.slice(2);
const FORCE = args.includes('--force');

/* ── PT helpers ─────────────────────────────────────────────────────────── */
const ptParts = (d = new Date()) => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return {
    date: `${f.year}-${f.month}-${f.day}`,
    h: +f.hour % 24, m: +f.minute, s: +f.second,
    dow: f.weekday,
    label: `${f.year}-${f.month}-${f.day} ${f.weekday} ${f.hour}:${f.minute}:${f.second} PT`,
  };
};
const minutesOf = (p) => p.h * 60 + p.m;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ── auth: one wrangler call to force a refresh, then read its token ────── */
function token() {
  try {
    execSync('npx wrangler kv key get --remote --binding REC_LOG macrosweep:last',
             { stdio: 'ignore', timeout: 120_000 });
  } catch (_) { /* the read may 404; we only want the token refresh */ }
  const toml = fs.readFileSync(CFG, 'utf8');
  const t = /oauth_token\s*=\s*"([^"]+)"/.exec(toml)?.[1];
  const exp = /expiration_time\s*=\s*"([^"]+)"/.exec(toml)?.[1];
  if (!t) throw new Error(`no oauth_token in ${CFG} — run: npx wrangler login`);
  if (exp && Date.parse(exp) < Date.now() + 60_000) {
    throw new Error(`wrangler token expires ${exp}, too soon to be usable — run: npx wrangler login`);
  }
  return t;
}

async function kvGet(TOK, key) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCT}/storage/kv/namespaces/${NS}/values/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${TOK}` } });
  if (!r.ok) return null;
  return r.text();
}

/** One snapshot: every iv:{T}:{DATE} value plus ivsweep:last. */
async function snapshot(TOK, tickers, date) {
  const at = new Date().toISOString();
  const rows = {};
  for (let i = 0; i < tickers.length; i += 8) {
    const batch = tickers.slice(i, i + 8);
    const got = await Promise.all(batch.map(async (t) => {
      const raw = await kvGet(TOK, `iv:${t}:${date}`);
      if (raw == null) return [t, null];
      try { return [t, JSON.parse(raw)]; } catch { return [t, { parseError: raw.slice(0, 80) }]; }
    }));
    for (const [t, v] of got) rows[t] = v;
  }
  const sweepStamp = await kvGet(TOK, 'ivsweep:last');
  return { at, date, sweepStamp, rows };
}

const fingerprint = (snap) => JSON.stringify(
  Object.entries(snap.rows).filter(([, v]) => v).map(([t, v]) => [t, v.atmIv, v.ts]).sort());

/* ── comparison ─────────────────────────────────────────────────────────── */
function compare(p1, p2) {
  const names = [...new Set([...Object.keys(p1.rows), ...Object.keys(p2.rows)])].sort();
  const onlyP1 = [], onlyP2 = [], missingBoth = [], changed = [], same = [];

  for (const t of names) {
    const a = p1.rows[t], b = p2.rows[t];
    if (!a && !b) { missingBoth.push(t); continue; }
    if (a && !b)  { onlyP1.push(t); continue; }
    if (!a && b)  { onlyP2.push(t); continue; }
    const dIv = (Number.isFinite(a.atmIv) && Number.isFinite(b.atmIv)) ? +(b.atmIv - a.atmIv).toFixed(4) : null;
    const gap = (a.ts && b.ts) ? Math.round((Date.parse(b.ts) - Date.parse(a.ts)) / 1000) : null;
    (a.ts !== b.ts ? changed : same).push({ t, ivA: a.atmIv, ivB: b.atmIv, dIv, gap, srcA: a.src ?? '(none)', srcB: b.src ?? '(none)' });
  }

  console.log('\n════════ IV CAPTURE ════════');
  console.log(`pass 1 at ${p1.at}   ivsweep:last = ${p1.sweepStamp ?? 'ABSENT'}`);
  console.log(`pass 2 at ${p2.at}   ivsweep:last = ${p2.sweepStamp ?? 'ABSENT'}`);
  console.log(`\nnames: ${names.length}   rewritten: ${changed.length}   untouched: ${same.length}`
    + `   only in pass 1: ${onlyP1.length}   only in pass 2: ${onlyP2.length}   absent both: ${missingBoth.length}`);

  if (!changed.length) {
    console.log('\nNO SECOND PASS DETECTED — every ts identical across both reads.');
    console.log(p2.sweepStamp
      ? `  ivsweep:last is stamped (${p2.sweepStamp}), so the sweep completed on the first firing.`
      : '  ivsweep:last is ABSENT yet nothing was rewritten — the second firing did not run the sweep.'
        + ' That is unexpected; check the branch fired at all before drawing a conclusion.');
  } else {
    console.log('\nREWRITTEN BY THE SECOND PASS — this is the systematic-shift measurement:');
    console.log('  ticker    :15 atmIv   :30 atmIv     delta     ts gap(s)   src');
    for (const c of changed.sort((x, y) => Math.abs(y.dIv ?? 0) - Math.abs(x.dIv ?? 0))) {
      console.log(`  ${c.t.padEnd(8)} ${String(c.ivA).padStart(9)} ${String(c.ivB).padStart(11)} `
        + `${String(c.dIv).padStart(9)} ${String(c.gap).padStart(11)}   ${c.srcA}→${c.srcB}`);
    }
    const ds = changed.map(c => c.dIv).filter(Number.isFinite);
    if (ds.length) {
      const abs = ds.map(Math.abs).sort((a, b) => a - b);
      const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
      const rel = changed.filter(c => Number.isFinite(c.dIv) && c.ivA)
        .map(c => Math.abs(c.dIv / c.ivA) * 100);
      console.log(`\n  SIGNED MEAN delta ${mean.toFixed(4)} IV points (sign matters: a consistent`
        + ' direction is a systematic shift, scatter around 0 is noise)');
      console.log(`  |delta|  median ${abs[Math.floor(abs.length / 2)]}   max ${abs.at(-1)}`);
      if (rel.length) console.log(`  |delta| as % of the :15 reading — median `
        + `${rel.sort((a, b) => a - b)[Math.floor(rel.length / 2)].toFixed(2)}%   max ${Math.max(...rel).toFixed(2)}%`);
    }
  }
  if (onlyP1.length) console.log(`\nONLY IN PASS 1 (present at :15, gone at :30 — should be impossible): ${onlyP1.join(' ')}`);
  if (onlyP2.length) console.log(`\nONLY IN PASS 2 (the second pass RECOVERED these): ${onlyP2.join(' ')}`);
  if (missingBoth.length) console.log(`\nABSENT IN BOTH (never recorded today): ${missingBoth.join(' ')}`);
  console.log('\nREAD THIS AGAINST THE PRE-REGISTRATION in ARCHITECTURE.md #16 before interpreting.');
}

/* ── offline re-comparison ──────────────────────────────────────────────── */
if (args[0] === '--compare') {
  const [, f1, f2] = args;
  if (!f1 || !f2) { console.error('usage: node iv-capture.mjs --compare <pass1.json> <pass2.json>'); process.exit(2); }
  compare(JSON.parse(fs.readFileSync(f1, 'utf8')), JSON.parse(fs.readFileSync(f2, 'utf8')));
  process.exit(0);
}

/* ── main ───────────────────────────────────────────────────────────────── */
const now = ptParts();
console.log(`iv-capture · now ${now.label}`);
if (FORCE) console.warn('!! --force: the window guard is overridden. Any refusal printed below is'
  + ' ADVISORY ONLY and the run continues — the two passes may be indistinguishable. !!');

if (now.dow === 'Sat' || now.dow === 'Sun') {
  console.error(`REFUSING: ${now.dow} is not a trading day, so no sweep runs. Nothing to capture.`);
  if (!FORCE) process.exit(1);
}
const mins = minutesOf(now);
if (mins < minutesOf(PASS1_OPEN)) {
  console.error(`REFUSING: too early. The first sweep pass starts at 13:15 PT and took 11s on 2026-08-12;`
    + ` reading before ${PASS1_OPEN.h}:${String(PASS1_OPEN.m).padStart(2, '0')} PT can capture a half-written set,`
    + ' which is not a baseline. Wait and re-run.');
  if (!FORCE) process.exit(1);
}
if (mins > minutesOf(PASS1_CLOSE)) {
  console.error(`REFUSING: too late. The second sweep pass starts at 13:30 PT, so a pass-1 read after`
    + ` ${PASS1_CLOSE.h}:${String(PASS1_CLOSE.m).padStart(2, '0')} PT may already contain it — the two`
    + ' passes would be indistinguishable. Today is lost; run tomorrow.');
  if (!FORCE) process.exit(1);
}
fs.mkdirSync(OUTDIR, { recursive: true });
const TOK = token();

// Ticker list from the same place the sweep gets it.
const wlRaw = await kvGet(TOK, 'watchlist:tickers');
if (!wlRaw) { console.error('REFUSING: could not read watchlist:tickers.'); process.exit(1); }
const wl = JSON.parse(wlRaw);
const tickers = (Array.isArray(wl) ? wl : wl.tickers || []).map(s => String(s).toUpperCase());
if (!tickers.length) { console.error('REFUSING: watchlist is empty.'); process.exit(1); }
console.log(`watchlist: ${tickers.length} names · PT date ${now.date}`);

// ── pass 1, with a stability check so a still-running sweep is detected ──
let p1 = await snapshot(TOK, tickers, now.date);
console.log(`pass 1 read at ${p1.at} — ${Object.values(p1.rows).filter(Boolean).length}/${tickers.length} present,`
  + ` ivsweep:last = ${p1.sweepStamp ?? 'ABSENT'}`);
console.log(`  confirming the first pass has finished writing (re-reading in ${STABILITY_MS / 1000}s)…`);
await sleep(STABILITY_MS);
const p1b = await snapshot(TOK, tickers, now.date);
if (fingerprint(p1b) !== fingerprint(p1)) {
  console.warn('  ! the set was still changing — the first sweep was mid-flight. Using the LATER read as pass 1.');
  p1 = p1b;
} else {
  console.log('  stable — the first pass had finished.');
}
const f1 = path.join(OUTDIR, `pass1-${now.date}.json`);
fs.writeFileSync(f1, JSON.stringify(p1, null, 1));
console.log(`  saved ${f1}`);

// ── wait for the second pass to finish ──────────────────────────────────
while (minutesOf(ptParts()) < minutesOf(PASS2_AFTER)) {
  const p = ptParts();
  process.stdout.write(`\r  waiting for the 1:30pm pass to finish · ${p.label}   `);
  await sleep(15_000);
}
process.stdout.write('\n');

const p2 = await snapshot(TOK, tickers, now.date);
const f2 = path.join(OUTDIR, `pass2-${now.date}.json`);
fs.writeFileSync(f2, JSON.stringify(p2, null, 1));
console.log(`pass 2 read at ${p2.at} — ${Object.values(p2.rows).filter(Boolean).length}/${tickers.length} present,`
  + ` ivsweep:last = ${p2.sweepStamp ?? 'ABSENT'}`);
console.log(`  saved ${f2}`);

compare(p1, p2);
console.log(`\nRaw snapshots kept at ${OUTDIR} — re-run the comparison any time with:`);
console.log(`  node iv-capture.mjs --compare "${f1}" "${f2}"`);
