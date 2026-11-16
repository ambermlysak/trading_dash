/* The 7:15am PT post-open read — the five defects found in its first live run
 * (2026-11-16), replayed against that morning's banked records.
 *
 * FIXTURES (fixtures/postopen-2026-11-16.*): the REAL `daily:postopen`,
 * `daily:snapshot`, `market:sectors`, `macro:state` and `watchlist:tickers` as
 * served on 2026-11-16, pulled with `wrangler kv key get`. The 07:15 QUOTES are
 * NOT banked anywhere — the record keeps none — so `inputs.json` is a labelled
 * RECONSTRUCTION and every symbol in it names its source in `src`. Read its
 * `_provenance` before trusting any number this script prints about a single
 * name. The structural properties under test do not depend on it being exact.
 *
 * OFFLINE AND ON A FIXED CLOCK. `Date` is replaced with one pinned to the
 * record's own write instant, because the job reads "today" from the clock and
 * a fixture compared against a freshness window goes red on the calendar — the
 * rule in CLAUDE.md. Every fetch is stubbed; nothing reaches Yahoo or Anthropic.
 *
 * Sections:
 *   1. DEFECT 1 — every percent handed to the model re-derives from its own
 *      printed price and prior close within 0.005 pt; before/after per symbol;
 *      a negative control proving the check can fail; the prior-close session
 *      rule in `postOpenQuote`.
 *   2. DEFECT 2 — the plan items extracted from the 06:00 record, and that the
 *      06:03 sector read never becomes one.
 *   3. DEFECT 3 — the named opportunity / avoid tickers are quoted, at zero
 *      added fetches; a name that cannot be quoted stays a named refusal.
 *   4. DEFECT 4 — `detail{}` and the prose audit, on the real 07:15 body (which
 *      must trip it) and on a check-written compliant body (which must not).
 *   5. DEFECT 5 — provenance of every numeric token in the real 07:15 body.
 *   6. THE REAL `scheduled()` at 07:15 PT — every refusal path from 345f9c3, the
 *      degraded and complete paths, the dedup, and the slot shape on each.
 */
import fs from 'fs';
import { tally, record, reportVerdict, populated } from './check-harness.mjs';

/* ── The fixed clock — installed BEFORE the Worker is imported ───────────── */
const FX = (n) => JSON.parse(fs.readFileSync(`fixtures/postopen-2026-11-16.${n}.json`, 'utf8'));
const PO = FX('postopen'), SNAP = FX('snapshot'), SECT = FX('market_sectors'), MACRO = FX('macro_state');
const TICKERS = FX('watchlist_tickers'), INP = FX('inputs');
const RealDate = Date;
const FIXED = PO.ts;                                   // 2026-11-16 07:16:10 PT, the real write time
class FixedDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [FIXED])); }
  static now() { return FIXED; }
}
globalThis.Date = FixedDate;

/* ── A fetch dispatcher, also installed BEFORE import: INSTR captures
   `globalThis.fetch` at module load, so a later replacement would bypass it. */
let FETCH = async () => new Response('{}', { status: 404 });
const fetchLog = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  fetchLog.push(url);
  return FETCH(url, init);
};

const W = await import('./worker.js');
const {
  postOpenQuote, postOpenPlanItems, postOpenBuildPayload, postOpenPrompt, postOpenSentences,
  postOpenProvenance, postOpenAudit, postOpenReconcile, postOpenDetail, postOpenNamedSymbols,
} = W;
const worker = W.default;

const t = tally();
const pad = (s, n) => String(s).padEnd(n);
const j = v => JSON.stringify(v);
function row(label, got, want, ok = Object.is(got, want)) {
  record(t, ok);
  console.log(`  ${pad(label, 58)} got ${pad(j(got), 22)} want ${pad(j(want), 22)} ${ok ? 'ok' : '<<< MISMATCH'}`);
  return ok;
}
const hdr = s => console.log(`\n${'═'.repeat(100)}\n${s}\n${'═'.repeat(100)}`);

/* The fixture's quotes as the Map shape `yahooSparkQuotes` returns. */
const toMap = (syms) => new Map(syms.filter(s => INP.quotes[s]).map(s => [s, INP.quotes[s]]));
const MKT = ['^GSPC', '^IXIC', '^DJI', '^RUT', 'ES=F', 'NQ=F', 'GC=F', 'SI=F', 'CL=F', '^TNX', '^VIX', '^VIX3M',
             'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLB', 'XLRE', 'XLC', 'XLU'];
const TODAY = '2026-11-16';
const CLOCK = { etIso: TODAY, etHour: 10 };            // 07:15 PT = 10:15 ET
const buildArgs = (over = {}) => ({
  quotes: toMap([...MKT, 'UNH', 'APLD']), wlQuotes: toMap(TICKERS), tickers: TICKERS,
  snapshot: SNAP, baseLevels: SNAP.marketLevels, hasBaseProse: true, baseline: '06:00',
  baselineParts: ['prose', 'levels'], todayPt: TODAY, dataAsOf: INP.dataAsOf,
  dateStr: 'Monday, November 16, 2026', macroState: MACRO, sectorsBanked: SECT, todayEvents: '',
  missing: [], clock: CLOCK, ...over,
});
const P = postOpenBuildPayload(buildArgs());
const PROMPT = postOpenPrompt(P);

/* ═══════════════════════════════════════════════════════════════════════ */
hdr('§1  DEFECT 1 — every percent re-derives from the price and prior close printed beside it');
{
  const vendorShown = s => INP.quotes[s]?.changePct ?? null;
  const rows = [
    ...P.indices.map(r => ['index', r.sym, r.price, r.prevClose, r.changePct]),
    ...P.sectors.map(r => ['sector', r.etf, r.price, r.prevClose, r.changePct]),
    ...TICKERS.map(s => { const q = postOpenQuote(INP.quotes[s]); return ['watchlist', s, q?.price, q?.prevClose, q?.changePct]; }),
  ];
  console.log(`  ${pad('class', 10)}${pad('symbol', 8)}${pad('price', 12)}${pad('prior', 12)}${pad('BEFORE (vendor, as printed 07:15)', 35)}`
    + `${pad('AFTER (derived)', 17)}${pad('recomputed', 12)}diff     src`);
  let worst = 0, n = 0, mism = 0;
  for (const [cls, sym, price, prev, pct] of rows) {
    const exact = (price - prev) / prev * 100;
    const diff = Math.abs(pct - exact);
    worst = Math.max(worst, diff); n++;
    const before = vendorShown(sym);
    if (before != null && Math.abs(before - pct) > 0.005) mism++;
    console.log(`  ${pad(cls, 10)}${pad(sym, 8)}${pad(price, 12)}${pad(prev, 12)}${pad(before == null ? '—' : before, 35)}`
      + `${pad(pct, 17)}${pad(exact.toFixed(4), 12)}${pad(diff.toFixed(4), 9)}${INP.quotes[sym]?.src}`);
    record(t, diff <= 0.005 + 1e-9);
  }
  console.log(`\n  ${n} symbols checked · worst |printed − recomputed| ${worst.toFixed(5)} pt (tolerance 0.005)`
    + ` · ${mism} where the vendor percent the 07:15 body printed differs from the derived one by > 0.005`);
  row('§1 symbols checked (11 index + 11 sector + 40 watchlist)', n, 62);
  row('§1 worst difference within 0.005 pt', worst <= 0.005, true);

  const vix = P.indices.find(r => r.sym === '^VIX');
  row('§1 VIX price as printed 07:15',               vix.price, 21.48);
  row('§1 VIX prior close (pairs[n-2], = 06:00 prevClose)', vix.prevClose, 19.3);
  row('§1 VIX derived percent (21.48 / 19.30)',      vix.changePct, 11.3);
  row('§1 ...the vendor percent the body printed',    INP.quotes['^VIX'].changePct, 11.36);
  row('§1 the prompt carries +11.30%',                 /VIX \(\^VIX\): price 21\.48 · prior close 19\.3 · day change \+11\.30%/.test(PROMPT), true);
  row('§1 the prompt carries no vendor percent (11.36)', PROMPT.includes('11.36'), false);

  const rc = postOpenReconcile(P);
  console.log(`\n  postOpenReconcile over the whole payload: ${rc.checked} percents re-derived, ${rc.failures.length} failures`);
  row('§1 reconcile: percents re-derived (indices+06:00+since+sectors+movers+named)', rc.checked >= 60, true);
  row('§1 reconcile: failures', rc.failures.length, 0);
  // NEGATIVE CONTROL — the instrument must be able to fail.
  const bad = JSON.parse(JSON.stringify(P));
  bad.indices.find(r => r.sym === '^VIX').changePct = 11.36;
  const rcBad = postOpenReconcile(bad);
  row('§1 negative control: a vendor 11.36 beside 21.48/19.3 is caught', rcBad.failures.length, 1);
  row('§1 ...and names the symbol', rcBad.failures[0]?.sym, '^VIX');

  // the prior-close session rule
  const pairs = [{ iso: '2026-11-12', close: 100 }, { iso: '2026-11-13', close: 110 }, { iso: '2026-11-16', close: 121 }];
  const mt = Date.parse('2026-11-16T15:15:00Z');
  row('§1 today\'s bar present: prior close is pairs[n-2]', postOpenQuote({ price: 121, marketTime: mt, pairs }).prevClose, 110);
  row('§1 no bar yet today: prior close is pairs[n-1]', postOpenQuote({ price: 121, marketTime: mt, pairs: pairs.slice(0, 2) }).prevClose, 110);
  row('§1 ...and the percent follows it (121/110)', postOpenQuote({ price: 121, marketTime: mt, pairs: pairs.slice(0, 2) }).changePct, 10);
  row('§1 vendor percent kept for diagnosis only', postOpenQuote({ price: 121, changePct: 9.99, marketTime: mt, pairs }).vendorChangePct, 9.99);
  row('§1 no price -> null quote, never a zero', postOpenQuote({ price: null, pairs }), null);
}

/* ═══════════════════════════════════════════════════════════════════════ */
hdr('§2  DEFECT 2 — plan items come from the 06:00 record and nothing else');
{
  const items = P.plan;
  console.log('  TODAY (2026-11-16, the real 06:00 record):');
  for (const it of items) console.log(`    ${pad(it.id, 4)}${pad(it.kind, 12)}${pad(it.item, 34)}"${it.claim.slice(0, 90)}${it.claim.length > 90 ? '…' : ''}"`);
  const want = [
    ['tape', 'Open outlook'], ['tape', 'Tape expectation'],
    ['level', 'S&P 500 / S&P Futures 7500'], ['level', 'S&P 500 / S&P Futures 7450'],
    ['sector', 'Technology (XLK)'], ['sector', 'Health Care (XLV)'], ['sector', 'Consumer Staples (XLP)'],
    ['sector', 'Industrials (XLI)'], ['opportunity', 'Named opportunity UNH'], ['avoid', 'Named avoid APLD'],
  ];
  row('§2 item count', items.length, want.length);
  want.forEach(([k, label], i) => row(`§2 P${i + 1} ${label}`, `${items[i]?.kind}|${items[i]?.item}`, `${k}|${label}`));
  row('§2 Financials is NOT a plan item (the 06:00 text never named it)', items.some(i => i.etf === 'XLF'), false);
  row('§2 Energy is NOT a plan item',                                      items.some(i => i.etf === 'XLE'), false);
  row('§2 Industrials IS (the plan named it; 07:15 never scored it)',      items.some(i => i.etf === 'XLI'), true);
  row('§2 "S&P futures at 7532" (a description) is NOT a level item',      items.some(i => i.level === 7532), false);
  row('§2 "Friday\'s 7561 cash close" is NOT a level item',                 items.some(i => i.level === 7561), false);
  const lvl = items.find(i => i.level === 7500);
  row('§2 the 7500 item carries its deciding numbers', lvl?.data?.[0], 'S&P 500 (^GSPC) now 7469.28, -30.72 from 7500 (-0.41%) — below it');
  const planBlock = PROMPT.split('PLAN ITEMS —')[1].split('MACRO RELEASES')[0];
  row('§2 the prompt\'s plan block never mentions XLF', /XLF|Financials/.test(planBlock), false);
  row('§2 the 06:03 read is labelled a separate source', /06:03 SECTOR READ \(as-of [^)]+\) is a SEPARATE SOURCE/.test(PROMPT), true);
  row('§2 sector rows say "since the 06:03 sector read"', /Financials \(XLF\):[^\n]*since the 06:03 sector read -1\.07 pt/.test(PROMPT), true);

  /* A SECOND DAY. No second real 06:00 record exists anywhere reachable — KV
     holds one `daily:snapshot`, overwritten each morning, and no briefing text
     is saved in this repo. These are SYNTHETIC records, labelled as such, built
     to exercise the branches today's record does not. */
  console.log('\n  SYNTHETIC SECOND DAY (not a banked record — none other exists):');
  const day2 = {
    headline: 'Banks lead as the 10-year eases to 4.98%',
    open: { headline: 'Financials and energy expected to lead a firm open',
            body: 'S&P futures at 7612 sit just under resistance at 7,650, with 7,580 the support to watch. '
                + 'Rate relief favours banks and real estate while utilities lag. '
                + 'We expect a quiet, range-bound tape with VIX near 16.' },
    opportunity: { ticker: 'jpm', reason: 'Steepening curve.' }, avoid: null,
  };
  const lv2 = { '^GSPC': { label: 'S&P 500', price: 7630 }, 'ES=F': { label: 'S&P Futures', price: 7612 }, '^VIX': { label: 'VIX', price: 16.2 } };
  const it2 = postOpenPlanItems(day2, lv2);
  for (const it of it2) console.log(`    ${pad(it.kind, 12)}${pad(it.item, 34)}"${it.claim.slice(0, 80)}"`);
  row('§2 day2: levels named with a level word (7650 resistance, 7580 support)',
      it2.filter(i => i.kind === 'level').map(i => i.level).join(','), '7650,7580');
  row('§2 day2: "futures at 7612" is not a level', it2.some(i => i.level === 7612), false);
  row('§2 day2: "VIX near 16" (no level word) is not a level', it2.some(i => i.level === 16), false);
  row('§2 day2: sectors named', it2.filter(i => i.kind === 'sector').map(i => i.etf).join(','), 'XLF,XLE,XLRE,XLU');
  row('§2 day2: tape items (outlook + one "expect" sentence)', it2.filter(i => i.kind === 'tape').length, 2);
  row('§2 day2: ticker upper-cased, null avoid skipped', it2.filter(i => i.kind === 'opportunity' || i.kind === 'avoid').map(i => i.item).join(','), 'Named opportunity JPM');
  row('§2 placeholder record (ts:0, no prose) yields no plan', postOpenPlanItems({ headline: 'Market update for Monday', newsCards: [], opportunity: null, avoid: null }, null).length, 0);
  row('§2 absent record yields no plan', postOpenPlanItems(null, null).length, 0);
}

/* ═══════════════════════════════════════════════════════════════════════ */
hdr('§3  DEFECT 3 — the named opportunity / avoid are always quoted');
{
  const named = postOpenNamedSymbols(SNAP);
  const MARKET23 = MKT.length;
  const added = named.filter(s => !MKT.includes(s));
  console.log(`  named on the 06:00 record: ${named.join(', ')} · both on the watchlist: ${named.every(s => TICKERS.includes(s))}`);
  console.log(`  market spark symbols ${MARKET23} -> ${MARKET23 + added.length}; requests ceil(${MARKET23}/20)=${Math.ceil(MARKET23 / 20)}`
    + ` -> ceil(${MARKET23 + added.length}/20)=${Math.ceil((MARKET23 + added.length) / 20)}`);
  row('§3 UNH is on the 2026-11-16 watchlist (the brief\'s premise was wrong)', TICKERS.includes('UNH'), true);
  row('§3 added external fetches', Math.ceil((MARKET23 + added.length) / 20) - Math.ceil(MARKET23 / 20), 0);
  row('§3 worst case (two names) still adds none', Math.ceil((MARKET23 + 2) / 20) - Math.ceil(MARKET23 / 20), 0);
  const unh = P.named.find(n => n.ticker === 'UNH');
  console.log(`  UNH in the payload: ${j(unh)}`);
  row('§3 UNH has a price', Number.isFinite(unh?.price), true);
  row('§3 ...from the market spark', unh?.source, 'market-spark');
  row('§3 ...and is in the prompt', /UNH \(opportunity\): price [\d.]+ · prior close [\d.]+ · day change [+-][\d.]+%/.test(PROMPT), true);
  const noUnh = postOpenBuildPayload(buildArgs({ quotes: toMap(MKT), wlQuotes: toMap(TICKERS.filter(s => s !== 'UNH')) }));
  const u2 = noUnh.named.find(n => n.ticker === 'UNH');
  row('§3 unquotable name: stays named, with a reason', typeof u2?.unavailable === 'string' && u2.price === undefined, true);
  row('§3 ...and its plan item says NO QUOTE, not a stand-in', /^NO QUOTE/.test(noUnh.plan.find(i => i.kind === 'opportunity').data[0]), true);
}

/* ═══════════════════════════════════════════════════════════════════════ */
hdr('§4  DEFECT 4 — detail{} and the prose audit');
const OLD_BODY = PO.body;
{
  const d = postOpenDetail(P, null, 'not scored: replay');
  console.log(`  detail.movers ${d.movers.length} · detail.levels ${d.levels.length} · detail.plan ${d.plan.length}`);
  console.log(`  levels: ${d.levels.map(l => `${l.ticker} ${l.z} ${l.state}`).join(' · ')}`);
  row('§4 detail.movers length = payload count', d.movers.length, P.watchlist.counts.movers);
  row('§4 detail.levels length = at-through + approaching', d.levels.length, P.watchlist.counts.atThrough + P.watchlist.counts.approaching);
  /* The live record counted 21. The replay counts every mover whose price came
     from the body (21) PLUS any the 1-minute reconstruction pushed over ±3% —
     a FIXTURE ARTIFACT, printed rather than hidden: the body never printed those
     names, so their 07:15 prices are unknowable. */
  const artifacts = d.movers.filter(m => INP.quotes[m.ticker]?.src === '1m-reconstruction');
  console.log(`  movers from the 1-minute reconstruction (fixture artifacts, not in the 07:15 body): ${j(artifacts)}`);
  row('§4 body-sourced movers = the live record\'s count (21)', d.movers.length - artifacts.length, PO.inputs.movers);
  row('§4 levels as the live record counted them (11)', d.levels.length, PO.inputs.atLevel);
  row('§4 every level state is one of the four', d.levels.every(l => ['at-through-lower', 'approaching-lower', 'approaching-upper', 'at-through-upper'].includes(l.state)), true);
  row('§4 movers sorted by magnitude', d.movers.every((m, i) => i === 0 || Math.abs(d.movers[i - 1].changePct) >= Math.abs(m.changePct)), true);
  row('§4 an unscored plan verdict is null, never defaulted', d.plan.every(p => p.verdict === null && /not scored/.test(p.evidence)), true);
  row('§4 detail.movers carries {ticker, changePct} only', j(Object.keys(d.movers[0])), j(['ticker', 'changePct']));
  row('§4 detail.levels carries {ticker, price, z, state}', j(Object.keys(d.levels[0])), j(['ticker', 'price', 'z', 'state']));

  const a = postOpenAudit(OLD_BODY, null, P);
  const sent = postOpenSentences(OLD_BODY);
  console.log(`\n  THE 07:15 BODY (BEFORE): ${a.bodyChars} chars, ${a.bodySentences} sentences by the frontend splitter`);
  console.log(`    words per sentence: ${sent.map(s => s.split(/\s+/).length).join(', ')}`);
  console.log(`    fold (first three sentences) = ${sent.slice(0, 3).join(' ').length} chars`);
  console.log(`    style: ${j(a.style)}`);
  console.log(`    fold check: ${j(a.foldCheck)}`);
  row('§4 before: body chars', a.bodyChars, 2739);
  row('§4 before: over the 1,400-char target', a.style.overLimits.chars, true);
  row('§4 before: ALL-CAPS emphasis caught (EXTENDED, NOW, CONFIRMED…)', ['EXTENDED', 'NOW', 'CONFIRMED'].every(w => a.style.allCaps.includes(w)), true);
  row('§4 before: first person caught ("I cannot score it")', a.style.firstPerson.includes('I'), true);
  row('§4 before: sentences over 40 words', a.style.overLimits.longSentences.length > 0, true);
  row('§4 before: movers named beyond the top five', a.style.moversNamedBeyondTop.length > 0, true);
  row('§4 before: plan check reports every item missing', a.planCheck.missing.length, P.plan.length);

  /* A COMPLIANT BODY, WRITTEN BY THIS CHECK from the payload's own numbers — not
     a model answer. It exists to prove the audit's clean path: a body that obeys
     the contract must come back with nothing recorded against it. */
  const spx = P.indices.find(r => r.sym === '^GSPC'), es = P.indices.find(r => r.sym === 'ES=F');
  const vix = P.indices.find(r => r.sym === '^VIX'), tnx = P.indices.find(r => r.sym === '^TNX');
  const sg = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
  const top = P.watchlist.topMovers;
  const good = [
    `The opening gap extended, with the S&P 500 at ${spx.price}, ${sg(spx.changePct)}% on the day, and S&P futures ${es.since0600.abs} (${sg(es.since0600.pct)}%) since 6:00am as of ${P.asOfClock} PT.`,
    `VIX is ${vix.price}, ${vix.since0600.abs >= 0 ? 'up' : 'down'} ${Math.abs(vix.since0600.abs)} since 6:00am, the term structure is ${P.term.spread} and still in contango, and the 10Y is ${tnx.price} against ${tnx.at0600.price} at 6:00am.`,
    'Of the plan items, two were confirmed, five were contradicted and three were untested, with the named avoid confirmed and the 7450 shelf untested.',
    `Sector heat sits in staples and health care, while technology is weakest at ${sg(P.sectors.find(s => s.etf === 'XLK').changePct)}%.`,
    `The watchlist has ${P.watchlist.counts.movers} names moving 3% or more, led by semiconductors: ${top.map(m => `${m.ticker} ${sg(m.changePct)}%`).join(', ')}.`,
    `Channel levels show ${P.watchlist.counts.atThrough} names at or through a band and ${P.watchlist.counts.approaching} approaching one, including ${P.watchlist.levels.slice(0, 3).map(l => l.ticker).join(', ')}.`,
  ].join(' ');
  const plan = P.plan.map((it, i) => ({ id: it.id, verdict: i === 0 ? 'confirmed' : 'untested',
    evidence: i === 0 ? `XLK ${sg(P.sectors.find(s => s.etf === 'XLK').changePct)}%` : 'not decidable from the snapshot' }));
  const g = postOpenAudit(good, plan, P);
  console.log(`\n  CHECK-WRITTEN COMPLIANT BODY (AFTER-shape, not a model answer): ${g.bodyChars} chars, ${g.bodySentences} sentences`);
  console.log(`    ${good}`);
  console.log(`    unsourced ${j(g.unsourcedNumbers)} · style ${j(g.style)} · fold ${j(g.foldCheck)} · plan ${j(g.planCheck)}`);
  row('§4 compliant: sentences in 6..9', g.bodySentences >= 6 && g.bodySentences <= 9, true);
  row('§4 compliant: within the char target', g.style.overLimits.chars, false);
  row('§4 compliant: no sentence over 40 words', g.style.overLimits.longSentences.length, 0);
  row('§4 compliant: no ALL-CAPS emphasis', g.style.allCaps.length, 0);
  row('§4 compliant: no first person', g.style.firstPerson.length, 0);
  row('§4 compliant: no stray clock time', g.style.clockTimes.length, 0);
  row('§4 compliant: unsourced numbers', g.unsourcedNumbers.length, 0);
  row('§4 compliant: plan evidence unsourced', g.planUnsourcedNumbers.length, 0);
  row('§4 compliant: fold order (gap / vol / plan)', g.foldCheck.s1Gap && g.foldCheck.s2Vol && g.foldCheck.s3Plan, true);
  row('§4 compliant: plan coverage complete', g.planCheck.missing.length + g.planCheck.added.length + g.planCheck.invalidVerdicts.length, 0);
  const plan2 = [...plan.slice(1), { id: 'P99', verdict: 'confirmed', evidence: 'x' }];
  const g2 = postOpenAudit(good, plan2, P);
  row('§4 a skipped item is reported', j(g2.planCheck.missing), j(['P1']));
  row('§4 an added item is reported', j(g2.planCheck.added), j(['P99']));
}

/* ═══════════════════════════════════════════════════════════════════════ */
hdr('§5  DEFECT 5 — provenance of every numeric token in the real 07:15 body');
{
  const prov = postOpenProvenance(OLD_BODY, P);
  const unm = prov.filter(x => !x.matched);
  for (const x of prov) console.log(`    ${pad(x.kind, 7)}${pad(x.token, 14)}${x.matched ? 'matched' : 'UNMATCHED'}`
    + `${x.matched ? '' : `   src of nearby symbol: see inputs.json`}`);
  console.log(`\n  ${prov.length} tokens · ${prov.length - unm.length} matched · ${unm.length} unmatched: ${j(unm.map(x => x.token))}`);
  if (populated('§5 provenance tokens', prov.length)) record(t, true); else record(t, false);
  row('§5 "+11.36" (the vendor VIX percent) is caught', unm.some(x => x.token === '+11.36'), true);
  row('§5 21.48 (VIX level, copied) is matched', prov.find(x => x.token === '21.48')?.matched, true);
  row('§5 7500 (a plan level, quoted from the plan) is matched', prov.find(x => x.token === '7500')?.matched, true);
  row('§5 the as-of clock 07:15 is matched', prov.find(x => x.kind === 'clock' && x.token === '07:15')?.matched, true);
  row('§5 the gate ±1.5σ is matched (allowlist)', prov.filter(x => x.token === '1.5').every(x => x.matched), true);
  row('§5 "+0.81" (the 06:03 XLF read) is in the payload', prov.find(x => x.token === '+0.81')?.matched, true);
  /* THE FOLD TRAP, pinned: a sentence that starts with a digit does not split. */
  row('§4/5 a digit-led sentence does not split in the fold', postOpenSentences('Tech fell 2%. 21 names moved. Then more.').length, 2);
  /* A body number in the payload but not in a matched form must not pass just
     because SOME symbol carries it; the set is magnitudes, which is the stated
     blind spot: a sign flip of a payload magnitude is NOT detected. */
  row('§5 blind spot pinned: a sign-flipped payload number still matches', postOpenProvenance('-21.48', P)[0].matched, true);
}

/* ═══════════════════════════════════════════════════════════════════════ */
hdr('§6  THE REAL scheduled() AT 07:15 PT — refusal table, degraded, complete, dedup');
{
  const SPARK_TS = iso => Date.parse(`${iso}T14:30:00Z`) / 1000;
  const sparkResponse = (url, mutate = q => q) => {
    const syms = decodeURIComponent(url.match(/symbols=([^&]+)/)[1]).split(',');
    const result = syms.filter(s => INP.quotes[s]).map(s => {
      const q = mutate(INP.quotes[s], s);
      return { symbol: s, response: [{
        meta: { regularMarketPrice: q.price, regularMarketChangePercent: q.changePct ?? undefined,
                regularMarketTime: Math.floor(q.marketTime / 1000) },
        timestamp: q.pairs.map(p => SPARK_TS(p.iso)),
        indicators: { quote: [{ close: q.pairs.map(p => p.close) }] } }] };
    });
    return new Response(JSON.stringify({ spark: { result } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const anth = (stop, text) => new Response(JSON.stringify({ stop_reason: stop,
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  function kv(seed) {
    const raw = { ...seed }, ops = [];
    return { raw, ops, async get(k, ty) { ops.push(['get', k]); return raw[k] == null ? null : (ty === 'json' ? JSON.parse(raw[k]) : raw[k]); },
      async put(k, v) { ops.push(['put', k]); raw[k] = v; }, async delete(k) { ops.push(['delete', k]); delete raw[k]; },
      async list() { return { keys: [], list_complete: true }; } };
  }
  const seedAll = () => ({
    'daily:snapshot': JSON.stringify(SNAP), 'market:sectors': JSON.stringify(SECT), 'macro:state': JSON.stringify(MACRO),
    'watchlist:tickers': JSON.stringify(TICKERS), 'morningrows:last': TODAY, 'econ:fred': JSON.stringify({ events: [] }),
  });
  const GOOD_ANSWER = JSON.stringify({ body: 'The opening gap extended, with the S&P 500 at 7469.28, -1.22% on the day. '
      + 'VIX is 21.48. Of the plan items, none were scored here. Sector heat sits in staples. Movers are many. Levels are near.',
    plan: P.plan.map(it => ({ id: it.id, verdict: 'untested', evidence: 'replay stub' })) });

  async function fire(store, { spark = 'ok', anthropic = ['end_turn', GOOD_ANSWER] } = {}) {
    fetchLog.length = 0;
    FETCH = async (url) => {
      if (url.includes('/v7/finance/spark')) {
        if (spark === 'down') return new Response('err', { status: 500 });
        if (spark === 'stale') return sparkResponse(url, q => ({ ...q, marketTime: Date.parse('2026-11-16T14:01:00Z') }));
        return sparkResponse(url);
      }
      if (url.includes('api.anthropic.com')) return anth(...anthropic);
      return new Response('{}', { status: 404 });
    };
    const logs = [], o = { l: console.log, w: console.warn, e: console.error };
    console.log = console.warn = console.error = (...a) => logs.push(a.join(' '));
    const jobs = [];
    try {
      await worker.scheduled({ scheduledTime: Date.parse('2026-11-16T15:15:00Z'), cron: '*/15 12-22 * * *' },
        { REC_LOG: store, ANTHROPIC_API_KEY: 'not-a-key-stubbed' }, { waitUntil: p => jobs.push(p), passThroughOnException() {} });
      await Promise.allSettled(jobs);
    } finally { Object.assign(console, { log: o.l, warn: o.w, error: o.e }); }
    const rec = store.raw['daily:postopen'] ? JSON.parse(store.raw['daily:postopen']) : null;
    return { rec, logs, sparkCalls: fetchLog.filter(u => u.includes('/spark')).length, anthCalls: fetchLog.filter(u => u.includes('anthropic')).length };
  }

  const cases = [
    { name: 'market spark down',       seed: seedAll(), opts: { spark: 'down' },  want: { reason: 'market-snapshot-unavailable', complete: false, phase: 'refused',           detail: false, anth: 0 } },
    { name: 'snapshot predates 06:30', seed: seedAll(), opts: { spark: 'stale' }, want: { reason: 'snapshot-predates-open',      complete: false, phase: 'refused',           detail: false, anth: 0 } },
    { name: 'answer truncated',        seed: seedAll(), opts: { anthropic: ['max_tokens', '{"body":"The opening gap ext'] },
                                                                                   want: { reason: 'answer-truncated',            complete: false, phase: 'truncated',         detail: true,  anth: 1 } },
    { name: 'no usable narrative',     seed: seedAll(), opts: { anthropic: ['end_turn', 'not json'] },
                                                                                   want: { reason: 'no-narrative',                complete: false, phase: 'generation-failed', detail: true,  anth: 1 } },
    { name: 'watchlist key absent',    seed: (() => { const s = seedAll(); delete s['watchlist:tickers']; return s; })(),
                                       opts: {},                                    want: { reason: /^inputs-missing: watchlist:tickers/, complete: false, phase: 'degraded', detail: true, anth: 1 } },
    { name: 'no 06:00 record',         seed: (() => { const s = seedAll(); delete s['daily:snapshot']; return s; })(),
                                       opts: {},                                    want: { reason: null,                          complete: true,  phase: 'complete',          detail: true,  anth: 1, baseline: 'none' } },
    { name: 'complete',                seed: seedAll(), opts: {},                   want: { reason: null,                          complete: true,  phase: 'complete',          detail: true,  anth: 1, baseline: '06:00' } },
  ];
  console.log(`  ${pad('case', 26)}${pad('reason', 46)}${pad('complete', 10)}${pad('phase', 19)}${pad('baseline', 10)}${pad('detail', 8)}${pad('spark', 7)}${pad('claude', 8)}ext/bind/cap`);
  let completeStore = null;
  for (const c of cases) {
    const store = kv(c.seed);
    const r = await fire(store, c.opts);
    const x = r.rec;
    console.log(`  ${pad(c.name, 26)}${pad(x?.reason ?? 'null', 46).slice(0, 46)}${pad(x?.complete, 10)}${pad(x?._instr?.phase, 19)}${pad(x?.baseline, 10)}`
      + `${pad(!!x?.detail, 8)}${pad(r.sparkCalls, 7)}${pad(r.anthCalls, 8)}${x?._instr?.extFetches}/${x?._instr?.bindingOps}/${x?._instr?.capCost}`);
    const w = c.want;
    row(`§6 ${c.name}: a record is written`, !!x, true);
    row(`§6 ${c.name}: reason`, w.reason instanceof RegExp ? w.reason.test(x?.reason || '') : x?.reason, w.reason instanceof RegExp ? true : w.reason);
    row(`§6 ${c.name}: complete`, x?.complete, w.complete);
    row(`§6 ${c.name}: phase`, x?._instr?.phase, w.phase);
    row(`§6 ${c.name}: detail present`, !!x?.detail, w.detail);
    row(`§6 ${c.name}: Claude calls`, r.anthCalls, w.anth);
    row(`§6 ${c.name}: schema stays 1`, x?.schema, 1);
    row(`§6 ${c.name}: ts is the real write time`, x?.ts, FIXED);
    if (w.baseline) row(`§6 ${c.name}: baseline`, x?.baseline, w.baseline);
    if (x?.detail) {
      row(`§6 ${c.name}: inputs.movers === detail.movers.length`, x.inputs.movers, x.detail.movers.length);
      row(`§6 ${c.name}: inputs.atLevel === detail.levels.length`, x.inputs.atLevel, x.detail.levels.length);
    }
    if (/truncated/.test(c.name)) row('§6 truncated: the cut-off text is NOT stored', x?.body.includes('The opening gap ext'), false);
    if (c.name === 'complete') completeStore = { store, r };
  }

  const { store, r } = completeStore;
  const x = r.rec;
  console.log(`\n  COMPLETE RECORD — inputs: ${j(Object.fromEntries(Object.entries(x.inputs).filter(([k]) => !['style', 'namedTickers'].includes(k))))}`);
  console.log(`  _instr: ${j(x._instr)}`);
  /* EVERY FIELD THE 345f9c3 SLOT HAD keeps its name; `detail` is the only new
     top-level key. Compared against the REAL live record's key set. */
  row('§6 top-level keys = the live record\'s + detail', j(Object.keys(x).filter(k => k !== 'detail').sort()), j(Object.keys(PO).sort()));
  row('§6 every live inputs key is still present', Object.keys(PO.inputs).every(k => k in x.inputs), true);
  row('§6 the stub body\'s numbers were audited', Array.isArray(x.inputs.unsourcedNumbers), true);
  row('§6 the audit did not change complete', x.complete, true);
  row('§6 plan coverage on the stub answer', x.inputs.planCheck.missing.length, 0);
  row('§6 detail.plan length = plan items', x.detail.plan.length, x.inputs.planItems);
  row('§6 spark requests: market 25 symbols + watchlist 40 = 2 + 2', r.sparkCalls, 4);
  row('§6 external fetches on the isolated job (4 spark + 1 Anthropic)', x._instr.extFetches, 5);
  row('§6 named tickers quoted from the market spark', x.inputs.namedTickers.map(n => `${n.ticker}:${n.source}`).join(','), 'UNH:market-spark,APLD:market-spark');

  // DEDUP: a COMPLETE record dedups the 07:30 firing for one read; a refusal does not.
  const before = store.raw['daily:postopen'], putsBefore = store.ops.filter(o => o[0] === 'put').length;
  const r2 = await fire(store);
  row('§6 07:30 after a complete record: no new write', store.ops.filter(o => o[0] === 'put').length, putsBefore);
  row('§6 ...record byte-identical', store.raw['daily:postopen'], before);
  row('§6 ...and no Claude call', r2.anthCalls, 0);
  const refused = kv(seedAll());
  await fire(refused, { spark: 'stale' });
  const r3 = await fire(refused);
  row('§6 07:30 after a REFUSAL retries and completes', r3.rec?.complete, true);
}

process.exit(reportVerdict({
  label: 'post-open read', comparisons: t.comparisons, failures: t.failures, minComparisons: 234,
}));
