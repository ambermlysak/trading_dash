/* CROSS-CHECK the post-open payload against a DIFFERENT Yahoo endpoint.
 *
 * The job builds every number from `v7/finance/spark`. This pulls the same
 * quantities from `v8/finance/chart` — a different endpoint, a different
 * response shape, a different field path — and recomputes the regression
 * channel from scratch rather than calling the Worker's own `swingChannel`.
 * Agreement between two independent reads is the evidence; the Worker checking
 * itself would not be.
 *
 * THE TAPE MOVES WHILE THIS RUNS. Both sides are pulled inside the same few
 * seconds and every comparison prints BOTH values and the gap, so drift is
 * visible rather than absorbed. A gap of a few basis points on a live quote is
 * two reads a second apart, not a defect; a gap of a percent is a defect.
 *
 * The UA is dropped for Yahoo for the reason stated in postopen.verify.mjs:
 * Node's undici is being answered 429 on any User-Agent from this host today,
 * while curl and the deployed Worker are not.
 */
const H = { Accept: 'application/json,text/plain,*/*', 'Accept-Language': 'en-US,en;q=0.9' };

const SPARK = 'https://query1.finance.yahoo.com/v7/finance/spark';
const CHART = 'https://query2.finance.yahoo.com/v8/finance/chart';

const pad = (s, n) => String(s).padEnd(n);
let rows = 0, bad = 0;

function cmp(label, spark, chart, tolPct = 0.05, unit = '') {
  rows++;
  if (spark == null || chart == null) {
    bad++;
    console.log(`  ${pad(label, 46)} spark ${pad(spark, 14)} chart ${pad(chart, 14)} <<< MISSING`);
    return;
  }
  const gap    = spark - chart;
  const gapPct = chart === 0 ? 0 : Math.abs(gap / chart) * 100;
  const ok = gapPct <= tolPct;
  if (!ok) bad++;
  console.log(`  ${pad(label, 46)} spark ${pad(spark, 14)} chart ${pad(chart, 14)}`
    + ` gap ${pad((gap >= 0 ? '+' : '') + gap.toFixed(6) + unit, 16)} (${gapPct.toFixed(4)}%) ${ok ? 'ok' : '<<< OVER TOLERANCE'}`);
}

async function sparkOne(symbols, range = '3mo') {
  const r = await fetch(`${SPARK}?symbols=${symbols.map(encodeURIComponent).join(',')}&range=${range}&interval=1d`, { headers: H });
  if (!r.ok) throw new Error(`spark ${r.status}`);
  const d = await r.json();
  const out = new Map();
  for (const it of (d?.spark?.result || [])) {
    const resp = it?.response?.[0], meta = resp?.meta || {};
    const closes = resp?.indicators?.quote?.[0]?.close || [];
    const stamps = resp?.timestamp || [];
    const pairs = [];
    for (let k = 0; k < closes.length; k++) {
      if (closes[k] == null || stamps[k] == null) continue;
      pairs.push({ iso: new Date(stamps[k] * 1000).toISOString().slice(0, 10), close: closes[k] });
    }
    out.set(it.symbol, {
      price: meta.regularMarketPrice ?? null,
      changePct: meta.regularMarketChangePercent ?? null,
      prevClose: pairs.length >= 2 ? pairs[pairs.length - 2].close : null,
      marketTime: meta.regularMarketTime ? meta.regularMarketTime * 1000 : null,
      pairs,
    });
  }
  return out;
}

async function chartOne(sym, range = '3mo') {
  const r = await fetch(`${CHART}/${encodeURIComponent(sym)}?range=${range}&interval=1d`, { headers: H });
  if (!r.ok) throw new Error(`chart ${sym} ${r.status}`);
  const res = (await r.json())?.chart?.result?.[0];
  const meta = res?.meta || {};
  const closes = res?.indicators?.quote?.[0]?.close || [];
  const stamps = res?.timestamp || [];
  const pairs = [];
  for (let k = 0; k < closes.length; k++) {
    if (closes[k] == null || stamps[k] == null) continue;
    pairs.push({ iso: new Date(stamps[k] * 1000).toISOString().slice(0, 10), close: closes[k] });
  }
  return { price: meta.regularMarketPrice ?? null, marketTime: meta.regularMarketTime ? meta.regularMarketTime * 1000 : null, pairs };
}

/* The 1d chart is where `generateDailySnapshot` reads the prior close from, and
   on THAT range `chartPreviousClose` is the prior session's — unlike on a ranged
   spark, which is the trap the Worker comment warns about. Pulled separately so
   the prior close is cross-checked against the field the briefing itself uses. */
async function chartPrev(sym) {
  const r = await fetch(`${CHART}/${encodeURIComponent(sym)}?range=1d&interval=1d`, { headers: H });
  if (!r.ok) throw new Error(`chart1d ${sym} ${r.status}`);
  const m = (await r.json())?.chart?.result?.[0]?.meta || {};
  return m.chartPreviousClose ?? m.previousClose ?? null;
}

/* An INDEPENDENT regression channel. Deliberately NOT worker.js's
   `swingChannel`: the point is a second implementation, written from the
   definition (OLS over the last 30 COMPLETED daily closes; sigma = the standard
   error of the regression, ssr/(n-2); the line read one bar forward when the
   window ends before today). */
function channelIndependent(pairs, livePrice, todayIso) {
  const last = pairs[pairs.length - 1];
  const bars = (last && last.iso === todayIso) ? pairs.slice(0, -1) : pairs;   // drop the forming bar
  if (bars.length < 30) return null;
  const win = bars.slice(-30), n = 30;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const y = win[i].close; sx += i; sy += y; sxx += i * i; sxy += i * y; }
  const denom = n * sxx - sx * sx;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  let ssr = 0;
  for (let i = 0; i < n; i++) { const r = win[i].close - (intercept + slope * i); ssr += r * r; }
  const sigma = Math.sqrt(ssr / (n - 2));
  const evalX = win[n - 1].iso < todayIso ? n : n - 1;
  const fit = intercept + slope * evalX;
  return { fit, sigma, z: (livePrice - fit) / sigma, lastIso: win[n - 1].iso, evalX };
}

const etToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const ptClock = ms => new Date(ms).toLocaleString('en-US', {
  timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' PT';

console.log(`\nCROSS-CHECK  ·  ${ptClock(Date.now())}  ·  ET session day ${etToday()}`);
console.log('spark = v7/finance/spark (what the job uses) · chart = v8/finance/chart (independent)\n');

const SYMS = ['^GSPC', '^VIX', '^VIX3M', '^TNX', 'XLK', 'NVDA', 'AAPL'];
const sp = await sparkOne(SYMS);
const ch = {};
for (const s of SYMS) ch[s] = await chartOne(s);

console.log('── 1. ^GSPC: the level every index line is anchored on ──────────────────────');
cmp('^GSPC regularMarketPrice', sp.get('^GSPC').price, ch['^GSPC'].price);
const gspcPrev = await chartPrev('^GSPC');
cmp('^GSPC prior close  (spark pairs[n-2] vs 1d chartPreviousClose)', sp.get('^GSPC').prevClose, gspcPrev, 0.001);
{
  const s = sp.get('^GSPC');
  const derived = (s.price - s.prevClose) / s.prevClose * 100;
  console.log(`  ${pad('^GSPC changePct: Yahoo meta vs derived', 46)} meta  ${pad(s.changePct, 14)} derived ${derived.toFixed(4)}`);
  rows++; if (Math.abs(s.changePct - derived) > 0.02) { bad++; console.log('     <<< the two do not reconcile'); }
  else console.log('     ok — the percentage and the two levels reconcile');
}
console.log(`  as-of: spark ${ptClock(sp.get('^GSPC').marketTime)}  ·  chart ${ptClock(ch['^GSPC'].marketTime)}`);

console.log('\n── 2. The VIX term spread (VIX − VIX3M), the sign convention macroRegime uses ─');
const termSpark = sp.get('^VIX').price - sp.get('^VIX3M').price;
const termChart = ch['^VIX'].price - ch['^VIX3M'].price;
cmp('^VIX level', sp.get('^VIX').price, ch['^VIX'].price);
cmp('^VIX3M level', sp.get('^VIX3M').price, ch['^VIX3M'].price);
cmp('term spread = VIX − VIX3M', Math.round(termSpark * 100) / 100, Math.round(termChart * 100) / 100, 2);
console.log(`     sign: ${termSpark < 0 ? 'NEGATIVE = contango = constructive' : 'POSITIVE = backwardation = hostile'}`);

console.log('\n── 3. ^TNX, the 10Y line — the one the 2dp rounding broke ───────────────────');
cmp('^TNX level', sp.get('^TNX').price, ch['^TNX'].price);
{
  const s = sp.get('^TNX');
  const derived = (s.price - s.prevClose) / s.prevClose * 100;
  console.log(`  ${pad('^TNX changePct: Yahoo meta vs derived', 46)} meta  ${pad(s.changePct, 14)} derived ${derived.toFixed(4)}`);
  console.log(`  ${pad('as PRINTED by postOpenLevel (4dp, trimmed)', 46)} now ${Math.round(s.price * 10000) / 10000}`
    + `  prior close ${Math.round(s.prevClose * 10000) / 10000}`);
  rows++; if (Math.abs(s.changePct - derived) > 0.02) { bad++; console.log('     <<< does not reconcile'); }
  else console.log('     ok — reconciles at the printed precision');
}

console.log('\n── 4. A sector ETF (XLK) — the sector-heat line ─────────────────────────────');
cmp('XLK level', sp.get('XLK').price, ch['XLK'].price);
{
  const s = sp.get('XLK');
  console.log(`  ${pad('XLK changePct (what the heat line prints)', 46)} ${s.changePct}`);
}

console.log('\n── 5. The regression channel, recomputed from a second implementation ───────');
for (const sym of ['NVDA', 'AAPL']) {
  const s = sp.get(sym);
  const mine = channelIndependent(ch[sym].pairs, ch[sym].price, etToday());
  if (!mine) { console.log(`  ${sym}: fewer than 30 completed bars from the chart endpoint`); rows++; bad++; continue; }
  const theirs = channelIndependent(s.pairs, s.price, etToday());
  console.log(`  ${sym}  live ${s.price}  ·  window ends ${mine.lastIso}  ·  line read at x=${mine.evalX}`);
  cmp(`  ${sym} regression fit`,   Math.round(theirs.fit * 100) / 100,   Math.round(mine.fit * 100) / 100, 0.2);
  cmp(`  ${sym} sigma (std err of the regression)`, Math.round(theirs.sigma * 100) / 100, Math.round(mine.sigma * 100) / 100, 2);
  cmp(`  ${sym} z`, Math.round(theirs.z * 100) / 100, Math.round(mine.z * 100) / 100, 5);
  const z = Math.round(theirs.z * 100) / 100;
  console.log(`     gate ±1.5σ -> ${Math.abs(z) >= 1.5 ? 'AT OR THROUGH' : Math.abs(z) >= 1.0 ? 'APPROACHING' : 'inside the channel'}`
    + ` the ${z > 0 ? 'upper' : 'lower'} band`);
}

console.log(`\n${bad === 0 ? 'ALL' : bad + ' OF ' + rows + ' FAILED —'} ${rows} comparisons.\n`);
process.exit(bad === 0 ? 0 : 1);
