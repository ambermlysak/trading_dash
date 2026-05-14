/**
 * Stock Research Dashboard — Cloudflare Worker
 *
 * Endpoints:
 *   GET  /api/quote/:ticker              → Yahoo v10 fundamentals + Alpaca/chart-meta price
 *   GET  /api/chart/:ticker?range&intvl  → Yahoo v8 OHLCV
 *   GET  /api/options/:ticker[?date]     → Yahoo v7 options chain
 *   GET  /api/search?q=                  → Yahoo ticker search
 *   GET  /api/news/:ticker               → Alpaca news (Yahoo fallback)
 *   GET  /api/peers/:ticker              → Yahoo recommendationsBySymbol
 *   POST /api/claude                     → Anthropic Messages API proxy
 *   POST /api/log-rec                    → Append rating to KV
 *   GET  /api/track/:ticker              → Read rating history from KV
 *   GET  /api/market/snapshot            → Index + futures + commodities + bonds strip
 *   GET  /api/market/movers              → Pre-market / day gainers + losers
 *   GET  /api/market/ipos                → Upcoming IPO calendar (12h KV cache)
 *   GET  /api/watchlist/batch?symbols=   → Bulk fundamentals + RSI + Claude analysis
 *   GET  /api/daily                      → Daily Claude synthesis (6am PT cron)
 *
 * Required secrets (npx wrangler secret put <NAME>):
 *   ANTHROPIC_API_KEY  ALPACA_KEY  ALPACA_SECRET
 */

const ALLOWED_ORIGINS = [
  'https://ambermlysak.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

const CLAUDE_MODEL = 'claude-sonnet-4-6';

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
};

const SNAPSHOT_SYMBOLS = {
  '^GSPC': 'S&P 500',
  '^IXIC': 'NASDAQ',
  '^DJI':  'Dow Jones',
  '^RUT':  'Russell 2000',
  'ES=F':  'S&P Futures',
  'NQ=F':  'NQ Futures',
  'GC=F':  'Gold',
  'SI=F':  'Silver',
  'CL=F':  'WTI Oil',
  '^TNX':  '10Y Yield',
  '^VIX':  'VIX',
};

const DEFAULT_WATCHLIST = [
  'PLTR','NVDA','AMD','AAPL','AMZN','GOOGL','QUBT','TWLO','NOW','TSM',
  'MU','APP','CRCL','CRWV','MRK','UNH','TSLA','PANW','RDDT','CAVA','JPM','HOOD',
];

/* ── CORS ── */
function isAllowedOrigin(origin) {
  if (!origin || origin === 'null') return true;
  return ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + ':'));
}

const cors = (origin = '') => ({
  'Access-Control-Allow-Origin': isAllowedOrigin(origin)
    ? (origin && origin !== 'null' ? origin : '*')
    : ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
});

const json = (data, status = 200, origin = '') =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });

const err = (msg, status = 500, origin = '') => json({ error: msg }, status, origin);

/* ── Yahoo Finance (no-auth) ── */
async function yahoo(path, search = '') {
  const url = `https://query2.finance.yahoo.com${path}${search}`;
  const r = await fetch(url, {
    headers: YAHOO_HEADERS,
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  return r.json();
}

/* ── Yahoo crumb authentication ── */
let _crumbCache = null;
let _crumbInflight = null; // dedup concurrent fetches

async function scanStream(response, regex, limitBytes = 150_000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (buf.length < limitBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const m = buf.match(regex);
      if (m) { reader.cancel().catch(() => {}); return m[1]; }
    }
  } catch (_) {}
  reader.cancel().catch(() => {});
  return null;
}

function extractCookie(rawSetCookie, ...names) {
  for (const name of names) {
    const m = rawSetCookie.match(new RegExp(`${name}=([^;,\\s]+)`));
    if (m) return `${name}=${m[1]}`;
  }
  return '';
}

async function getYahooCrumb(env) {
  const now = Date.now();
  const TTL = 3_000_000; // 50 minutes

  // Fast path — no await needed
  if (_crumbCache && _crumbCache.ts > now - TTL) return _crumbCache;

  // Dedup: if another concurrent call is already fetching, piggyback on it
  if (_crumbInflight) return _crumbInflight;

  _crumbInflight = (async () => {
    try {
      // KV cache
      try {
        const kv = await env?.REC_LOG?.get('yahoo:crumb', 'json');
        if (kv && kv.ts > Date.now() - TTL) { _crumbCache = kv; return _crumbCache; }
      } catch (_) {}

      let crumb = null;
      let cookie = '';

      // Strategy A: direct user-agent endpoint
      try {
        const r = await fetch('https://query2.finance.yahoo.com/v1/finance/user-agent', {
          headers: YAHOO_HEADERS,
        });
        if (r.ok) {
          cookie = extractCookie(r.headers.get('set-cookie') || '', 'A1', 'B');
          const txt = (await r.text()).trim();
          if (txt && txt.length < 50 && !txt.startsWith('<')) crumb = txt;
        }
      } catch (_) {}

      // Strategy B: scan finance.yahoo.com HTML stream
      if (!crumb) {
        try {
          const r = await fetch('https://finance.yahoo.com', {
            headers: { ...YAHOO_HEADERS, Accept: 'text/html' },
            redirect: 'follow',
          });
          cookie = extractCookie(r.headers.get('set-cookie') || '', 'A1', 'B') || cookie;
          crumb = await scanStream(r, /"crumb"\s*:\s*"([^"\\]{1,30})"/, 200_000);

          if (!crumb && cookie) {
            const r2 = await fetch('https://query2.finance.yahoo.com/v1/finance/user-agent', {
              headers: { ...YAHOO_HEADERS, Cookie: cookie },
            });
            if (r2.ok) {
              const txt = (await r2.text()).trim();
              if (txt && txt.length < 50 && !txt.startsWith('<')) crumb = txt;
            }
          }
        } catch (_) {}
      }

      if (!crumb) throw new Error('Yahoo crumb unavailable (all strategies exhausted)');

      _crumbCache = { crumb, cookie, ts: Date.now() };
      env?.REC_LOG?.put('yahoo:crumb', JSON.stringify(_crumbCache), { expirationTtl: 3600 }).catch(() => {});
      return _crumbCache;
    } finally {
      _crumbInflight = null;
    }
  })();

  return _crumbInflight;
}

async function yahooAuth(path, search, env) {
  const make = async (crumb, cookie) => {
    const sep = search.includes('?') ? '&' : '?';
    const url = `https://query2.finance.yahoo.com${path}${search}${sep}crumb=${encodeURIComponent(crumb)}`;
    const headers = { ...YAHOO_HEADERS };
    if (cookie) headers['Cookie'] = cookie;
    return fetch(url, { headers, cf: { cacheTtl: 30, cacheEverything: true } });
  };

  let { crumb, cookie } = await getYahooCrumb(env);
  let r = await make(crumb, cookie);

  if (r.status === 401 || r.status === 403) {
    _crumbCache = null;
    ({ crumb, cookie } = await getYahooCrumb(env));
    r = await make(crumb, cookie);
  }

  if (!r.ok) throw new Error(`Yahoo v10 ${r.status}`);
  return r.json();
}

function chartMetaToQuoteSummary(meta, ticker) {
  const p = (v) => (v != null ? { raw: v, fmt: String(v) } : undefined);
  return {
    price: {
      symbol:                     meta.symbol || ticker,
      longName:                   meta.longName || meta.shortName || '',
      shortName:                  meta.shortName || '',
      exchangeName:               meta.exchangeName || '',
      fullExchangeName:           meta.fullExchangeName || '',
      marketState:                meta.marketState || 'CLOSED',
      regularMarketPrice:         p(meta.regularMarketPrice),
      regularMarketPreviousClose: p(meta.chartPreviousClose),
      regularMarketVolume:        p(meta.regularMarketVolume),
      regularMarketDayHigh:       p(meta.regularMarketDayHigh),
      regularMarketDayLow:        p(meta.regularMarketDayLow),
    },
    summaryDetail: {
      fiftyTwoWeekHigh: p(meta.fiftyTwoWeekHigh),
      fiftyTwoWeekLow:  p(meta.fiftyTwoWeekLow),
    },
  };
}

/* ── Alpaca Market Data API ── */
async function alpacaFetch(path, env) {
  if (!env?.ALPACA_KEY || !env?.ALPACA_SECRET) throw new Error('Alpaca keys not configured');
  const r = await fetch(`https://data.alpaca.markets${path}`, {
    headers: {
      'APCA-API-KEY-ID':     env.ALPACA_KEY,
      'APCA-API-SECRET-KEY': env.ALPACA_SECRET,
      'Accept':              'application/json',
    },
    cf: { cacheTtl: 15, cacheEverything: true },
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => String(r.status));
    throw new Error(`Alpaca ${r.status}: ${txt.slice(0, 120)}`);
  }
  return r.json();
}

/* ── Computation helpers ── */
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += -d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

function computeSR(highs, lows) {
  const n = Math.min(20, highs.length);
  const support = Math.min(...lows.slice(-n));
  const resist  = Math.max(...highs.slice(-n));
  return {
    support: Math.round(support * 100) / 100,
    resist:  Math.round(resist  * 100) / 100,
  };
}

/* ── Worker-side Claude call ── */
async function workerClaude(prompt, env, maxTokens = 400) {
  if (!env?.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}`);
  const d = await r.json();
  return d.content?.[0]?.text?.trim() || '';
}

/* ── Existing route handlers ── */

async function handleQuote(ticker, origin, env) {
  const modules = [
    'price', 'summaryDetail', 'defaultKeyStatistics', 'financialData',
    'calendarEvents', 'recommendationTrend', 'upgradeDowngradeHistory',
    'assetProfile', 'insiderTransactions', 'netSharePurchaseActivity',
  ].join(',');

  const [yahooRes, chartRes, alpacaRes] = await Promise.allSettled([
    yahooAuth(`/v10/finance/quoteSummary/${ticker}`, `?modules=${modules}`, env),
    yahoo(`/v8/finance/chart/${ticker}`, '?range=1d&interval=1d'),
    alpacaFetch(`/v2/stocks/${ticker}/snapshot`, env),
  ]);

  let data;

  if (yahooRes.status === 'fulfilled') {
    data = yahooRes.value;
  } else {
    console.error(`[quote] Yahoo v10 failed (${yahooRes.reason?.message}); using chart meta fallback`);
    const chartMeta = chartRes.status === 'fulfilled'
      ? (chartRes.value?.chart?.result?.[0]?.meta || {})
      : {};
    data = {
      quoteSummary: {
        result: [chartMetaToQuoteSummary(chartMeta, ticker)],
        error:  null,
      },
    };
  }

  if (alpacaRes.status === 'fulfilled') {
    const snap   = alpacaRes.value;
    const result = data.quoteSummary?.result?.[0];
    if (result) {
      if (!result.price) result.price = {};
      const lp  = snap.latestTrade?.p ?? snap.dailyBar?.c;
      const pc  = snap.prevDailyBar?.c;
      const vol = snap.dailyBar?.v;
      const p   = (v) => v != null ? { raw: v, fmt: v.toFixed(2) } : undefined;
      if (lp  != null) result.price.regularMarketPrice        = p(lp);
      if (pc  != null) result.price.regularMarketPreviousClose = p(pc);
      if (vol != null) result.price.regularMarketVolume        = { raw: vol, fmt: String(vol) };
      result.price.symbol = result.price.symbol || ticker;

      if (!result.price.marketState || result.price.marketState === 'CLOSED') {
        const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const t    = et.getHours() * 100 + et.getMinutes();
        const open = et.getDay() > 0 && et.getDay() < 6 && t >= 930 && t < 1600;
        result.price.marketState = open ? 'REGULAR' : 'CLOSED';
      }
    }
  }

  return json(data, 200, origin);
}

async function handleChart(ticker, params, origin) {
  const range    = params.get('range')    || '1y';
  const interval = params.get('interval') || '1d';
  const data = await yahoo(
    `/v8/finance/chart/${ticker}`,
    `?range=${range}&interval=${interval}&includePrePost=false`,
  );
  return json(data, 200, origin);
}

async function handleOptions(ticker, params, origin) {
  const date   = params.get('date');
  const search = date ? `?date=${date}` : '';
  try {
    const data = await yahoo(`/v7/finance/options/${ticker}`, search);
    return json(data, 200, origin);
  } catch (e) {
    // Ticker may have no listed options — return empty chain instead of 500
    return json({ optionChain: { result: [], error: e.message } }, 200, origin);
  }
}

async function handleOptionsRecap(params, origin, env, ctx) {
  const symbolsParam = params.get('symbols') || '';
  const force   = params.get('refresh') === '1';
  const symbols = symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 25);
  if (!symbols.length) return err('symbols required', 400, origin);

  const cacheKey = `options:recap:${symbols.slice().sort().join(',')}`;

  if (!force) {
    try {
      const cached = await env?.REC_LOG?.get(cacheKey, 'json');
      if (cached && Date.now() - cached.ts < 7_200_000) return json(cached, 200, origin);
    } catch (_) {}
  }

  // Fetch nearest-expiration chain for each symbol in batches of 5
  const rawResults = [];
  for (let i = 0; i < symbols.length; i += 5) {
    const batch = await Promise.allSettled(
      symbols.slice(i, i + 5).map(sym => yahoo(`/v7/finance/options/${sym}`, '')),
    );
    rawResults.push(...batch);
  }

  const fmtNotional = n => n >= 1e6 ? '$' + (n/1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + (n/1e3).toFixed(0) + 'K' : '$' + n;

  const tickers = [];
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    if (rawResults[i].status !== 'fulfilled') continue;
    const chain = rawResults[i].value?.optionChain?.result?.[0];
    if (!chain) continue;

    const price = chain.quote?.regularMarketPrice ?? null;
    let totalCallVol = 0, totalPutVol = 0, totalCallOI = 0, totalPutOI = 0;
    const unusual = [];

    for (const exp of (chain.options || [])) {
      const expDte = exp.expirationDate
        ? Math.max(0, Math.round((exp.expirationDate * 1000 - Date.now()) / 86400000))
        : null;

      for (const c of (exp.calls || [])) {
        const vol = c.volume ?? 0;
        const oi  = c.openInterest ?? 0;
        totalCallVol += vol;
        totalCallOI  += oi;
        const mid = c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : c.lastPrice ?? 0;
        const notional = Math.round(vol * mid * 100);
        const voi = oi > 0 ? vol / oi : (vol > 0 ? 99 : 0);
        if (vol >= 100 && voi >= 2 && notional > 0)
          unusual.push({ type: 'CALL', strike: c.strike, dte: expDte, vol, oi, volOiRatio: +voi.toFixed(1), notional });
      }
      for (const p of (exp.puts || [])) {
        const vol = p.volume ?? 0;
        const oi  = p.openInterest ?? 0;
        totalPutVol += vol;
        totalPutOI  += oi;
        const mid = p.bid > 0 && p.ask > 0 ? (p.bid + p.ask) / 2 : p.lastPrice ?? 0;
        const notional = Math.round(vol * mid * 100);
        const voi = oi > 0 ? vol / oi : (vol > 0 ? 99 : 0);
        if (vol >= 100 && voi >= 2 && notional > 0)
          unusual.push({ type: 'PUT', strike: p.strike, dte: expDte, vol, oi, volOiRatio: +voi.toFixed(1), notional });
      }
    }

    tickers.push({
      symbol: sym, price,
      totalCallVol, totalPutVol, totalCallOI, totalPutOI,
      pcRatio:   totalCallVol > 0 ? +(totalPutVol / totalCallVol).toFixed(2) : null,
      pcOiRatio: totalCallOI  > 0 ? +(totalPutOI  / totalCallOI ).toFixed(2) : null,
      unusual: unusual.sort((a, b) => b.notional - a.notional).slice(0, 3),
    });
  }

  // Claude synthesis
  let synthesis = null;
  if (env?.ANTHROPIC_API_KEY && tickers.length > 0) {
    const lines = tickers.map(t => {
      const top = t.unusual.slice(0, 2)
        .map(u => `${u.vol} ${u.type}s $${u.strike} ${u.dte}d (${u.volOiRatio}× V/OI, ${fmtNotional(u.notional)})`)
        .join('; ');
      return `${t.symbol} $${t.price?.toFixed(2) ?? '?'}: calls ${t.totalCallVol} puts ${t.totalPutVol} P/C ${t.pcRatio ?? 'N/A'} P/C-OI ${t.pcOiRatio ?? 'N/A'}` +
        (top ? ` | unusual: ${top}` : '');
    }).join('\n');

    const prompt = `You are an options market analyst. Review today's options flow for this watchlist (nearest expiration, 15-min delay):

${lines}

Return ONLY valid JSON (no markdown):
{
  "overall": "2-sentence summary of collective options tone and any cross-ticker themes",
  "tickers": {
    "SYMBOL": "2-3 sentences: where call/put activity concentrated, what unusual prints imply, near-term directional read from the flow"
  }
}
Only include ticker keys that appear in the data above. Be specific about strikes and implications.`;

    try {
      const text    = await workerClaude(prompt, env, 1500);
      const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      synthesis = JSON.parse(cleaned);
    } catch (e) {
      console.error('[options recap] synthesis failed:', e.message);
    }
  }

  const result = { tickers, synthesis, ts: Date.now() };
  if (ctx) ctx.waitUntil(
    env?.REC_LOG?.put(cacheKey, JSON.stringify(result), { expirationTtl: 7200 }).catch(() => {}),
  );
  return json(result, 200, origin);
}

async function handleSearch(q, origin) {
  const r = await fetch(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`,
    { headers: YAHOO_HEADERS },
  );
  if (!r.ok) throw new Error(`Yahoo search ${r.status}`);
  return json(await r.json(), 200, origin);
}

async function handleNews(ticker, origin, env) {
  if (env?.ALPACA_KEY && env?.ALPACA_SECRET) {
    try {
      const data = await alpacaFetch(`/v1beta1/news?symbols=${ticker}&limit=15&sort=desc`, env);
      const news = (data.news || []).map(n => ({
        title:               n.headline,
        link:                n.url,
        publisher:           n.source,
        providerPublishTime: Math.floor(new Date(n.created_at).getTime() / 1000),
      }));
      return json({ news }, 200, origin);
    } catch (e) {
      console.error('[news] Alpaca failed, falling back to Yahoo:', e.message);
    }
  }

  const r = await fetch(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${ticker}&quotesCount=0&newsCount=15`,
    { headers: YAHOO_HEADERS },
  );
  return json(await r.json(), 200, origin);
}

async function handlePeers(ticker, origin) {
  const data = await yahoo(`/v6/finance/recommendationsbysymbol/${ticker}`);
  return json(data, 200, origin);
}

async function handleClaude(request, env, origin) {
  if (!env.ANTHROPIC_API_KEY) return err('ANTHROPIC_API_KEY not configured', 500, origin);
  const body    = await request.json();
  const payload = {
    model:      CLAUDE_MODEL,
    max_tokens: body.max_tokens ?? 1500,
    messages:   body.messages,
    ...(body.system ? { system: body.system } : {}),
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });
  return json(await r.json(), r.status, origin);
}

async function handleLogRec(request, env, origin) {
  if (!env.REC_LOG) return err('REC_LOG KV not bound', 500, origin);
  const body = await request.json();
  const { ticker, rating, confidence, price, factors } = body;
  if (!ticker || !rating) return err('ticker and rating required', 400, origin);

  const entry = {
    ticker:     ticker.toUpperCase(),
    rating,
    confidence: confidence ?? null,
    price:      price      ?? null,
    factors:    factors    ?? {},
    ts:         new Date().toISOString(),
  };
  const key      = `rec:${entry.ticker}`;
  const existing = await env.REC_LOG.get(key, 'json');
  const list     = Array.isArray(existing) ? existing : [];
  list.push(entry);
  await env.REC_LOG.put(key, JSON.stringify(list.slice(-500)));
  return json({ ok: true, count: list.length }, 200, origin);
}

async function handleTrack(ticker, env, origin) {
  if (!env.REC_LOG) return err('REC_LOG KV not bound', 500, origin);
  const list = (await env.REC_LOG.get(`rec:${ticker.toUpperCase()}`, 'json')) || [];
  return json({ ticker: ticker.toUpperCase(), entries: list }, 200, origin);
}

/* ── New route handlers ── */

async function handleMarketSnapshot(origin, env) {
  const tickers = Object.keys(SNAPSHOT_SYMBOLS);
  const results = await Promise.allSettled(
    tickers.map(t => yahoo(`/v8/finance/chart/${encodeURIComponent(t)}`, '?range=1d&interval=1d')),
  );

  const snapshot = tickers.map((ticker, i) => {
    if (results[i].status !== 'fulfilled') {
      return { ticker, name: SNAPSHOT_SYMBOLS[ticker], price: null, changePct: null };
    }
    const meta      = results[i].value?.chart?.result?.[0]?.meta || {};
    const price     = meta.regularMarketPrice ?? null;
    const prev      = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const changePct = price != null && prev != null
      ? Math.round((price - prev) / prev * 10000) / 100
      : null;
    return {
      ticker,
      name:      SNAPSHOT_SYMBOLS[ticker],
      price:     price != null ? Math.round(price * 100) / 100 : null,
      changePct,
    };
  });

  return json({ snapshot, ts: Date.now() }, 200, origin);
}

async function handleMarketMovers(origin, env) {
  const MIN_PCT = 10;

  // Wider pool for Alpaca batch — increases hit rate for ≥10% moves
  const MOVER_POOL = [
    'AAPL','NVDA','MSFT','GOOGL','AMZN','META','TSLA','AMD','PLTR','HOOD',
    'RDDT','APP','CAVA','PANW','MU','NOW','TSM','JPM','UNH','MRK',
    'NFLX','UBER','COIN','MSTR','SMCI','ARM','AVGO','ORCL','CRM','SNOW',
    'RBLX','UPST','SOFI','RIVN','NIO','BABA','MELI','DKNG','IONQ','QUBT',
  ];

  // ── Regular / pre-market movers ──
  let dayMovers = [];

  if (env?.ALPACA_KEY && env?.ALPACA_SECRET) {
    try {
      const data = await alpacaFetch(`/v2/stocks/snapshots?symbols=${MOVER_POOL.join(',')}`, env);
      dayMovers = Object.entries(data).map(([sym, snap]) => {
        const price     = snap.latestTrade?.p ?? snap.dailyBar?.c ?? null;
        const prev      = snap.prevDailyBar?.c ?? null;
        const changePct = price != null && prev != null
          ? Math.round((price - prev) / prev * 10000) / 100
          : null;
        return { ticker: sym, price, changePct };
      }).filter(m => m.changePct != null);
    } catch (_) {}
  }

  // Yahoo screener fallback (broader universe, no Alpaca needed)
  if (!dayMovers.length) {
    try {
      const [gr, lr] = await Promise.allSettled([
        fetch('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=true&scrIds=day_gainers&count=25', { headers: YAHOO_HEADERS }),
        fetch('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=true&scrIds=day_losers&count=25',  { headers: YAHOO_HEADERS }),
      ]);
      for (const res of [gr, lr]) {
        if (res.status === 'fulfilled' && res.value.ok) {
          const d = await res.value.json();
          for (const q of (d.finance?.result?.[0]?.quotes || [])) {
            dayMovers.push({
              ticker:    q.symbol,
              price:     q.regularMarketPrice?.raw ?? null,
              changePct: q.regularMarketChangePercent?.raw != null
                ? Math.round(q.regularMarketChangePercent.raw * 100) / 100 : null,
            });
          }
        }
      }
    } catch (_) {}
  }

  // ── Post-market / after-hours movers (Yahoo extended-hours screeners) ──
  let postMovers = [];
  try {
    const [agr, alr] = await Promise.allSettled([
      fetch('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=true&scrIds=afterhr_gainers&count=25', { headers: YAHOO_HEADERS }),
      fetch('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=true&scrIds=afterhr_losers&count=25',  { headers: YAHOO_HEADERS }),
    ]);
    for (const res of [agr, alr]) {
      if (res.status === 'fulfilled' && res.value.ok) {
        const d = await res.value.json();
        for (const q of (d.finance?.result?.[0]?.quotes || [])) {
          // Prefer postMarketChangePercent; fall back to regularMarketChangePercent
          const pct   = q.postMarketChangePercent?.raw ?? q.regularMarketChangePercent?.raw ?? null;
          const price = q.postMarketPrice?.raw ?? q.regularMarketPrice?.raw ?? null;
          if (pct != null) {
            postMovers.push({
              ticker:    q.symbol,
              price,
              changePct: Math.round(pct * 100) / 100,
            });
          }
        }
      }
    }
  } catch (_) {}

  // Also supplement post-market with Alpaca after-hours data (latestTrade vs dailyBar close)
  if (env?.ALPACA_KEY && env?.ALPACA_SECRET && !postMovers.length) {
    try {
      const data = await alpacaFetch(`/v2/stocks/snapshots?symbols=${MOVER_POOL.join(',')}`, env);
      for (const [sym, snap] of Object.entries(data)) {
        const afterPrice  = snap.latestTrade?.p ?? null;
        const regularClose = snap.dailyBar?.c ?? null;
        if (afterPrice == null || regularClose == null) continue;
        const pct = Math.round((afterPrice - regularClose) / regularClose * 10000) / 100;
        postMovers.push({ ticker: sym, price: afterPrice, changePct: pct });
      }
    } catch (_) {}
  }

  const applyFilter = (list, positive) => list
    .filter(m => positive ? m.changePct >= MIN_PCT : m.changePct <= -MIN_PCT)
    .sort((a, b) => positive ? b.changePct - a.changePct : a.changePct - b.changePct)
    .slice(0, 10);

  return json({
    gainers:     applyFilter(dayMovers,  true),
    losers:      applyFilter(dayMovers,  false),
    postGainers: applyFilter(postMovers, true),
    postLosers:  applyFilter(postMovers, false),
    ts: Date.now(),
  }, 200, origin);
}

async function handleMarketIPOs(origin, env) {
  const KV_KEY = 'market:ipos';
  const TTL    = 43_200_000; // 12 hours

  try {
    const cached = await env?.REC_LOG?.get(KV_KEY, 'json');
    if (cached && Date.now() - cached.ts < TTL) return json(cached, 200, origin);
  } catch (_) {}

  const NASDAQ_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.nasdaq.com',
    'Referer': 'https://www.nasdaq.com/market-activity/ipos',
  };

  // Build list of months to fetch (current + next 2)
  const today = new Date();
  const months = [0, 1, 2].map(offset => {
    const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  let ipos = [];

  // Primary: NASDAQ IPO calendar API
  try {
    const results = await Promise.allSettled(
      months.map(m => fetch(`https://api.nasdaq.com/api/ipo/calendar?date=${m}`, { headers: NASDAQ_HEADERS })),
    );
    for (const res of results) {
      if (res.status !== 'fulfilled' || !res.value.ok) continue;
      const d = await res.value.json();
      // Upcoming (not yet priced)
      const upcoming = d.data?.upcoming?.upcomingTable?.rows || [];
      for (const row of upcoming) {
        const sym = row.proposedTickerSymbol?.trim() || '';
        if (ipos.find(i => i.ticker === sym && sym)) continue;
        ipos.push({
          name:     row.companyName || '',
          ticker:   sym,
          date:     row.expectedPriceDate || '',
          exchange: row.proposedExchange || '',
          price:    row.proposedSharePrice || 'TBD',
          status:   'upcoming',
        });
      }
      // Recently filed (S-1 / prospectus)
      const filings = d.data?.filings?.filingTable?.rows || [];
      for (const row of filings) {
        const sym = row.proposedTickerSymbol?.trim() || '';
        if (ipos.find(i => i.ticker === sym && sym)) continue;
        ipos.push({
          name:     row.companyName || '',
          ticker:   sym,
          date:     row.filedDate || '',
          exchange: row.proposedExchange || '',
          price:    row.proposedSharePrice || 'TBD',
          status:   'filed',
        });
      }
    }
  } catch (e) {
    console.error('[ipos] NASDAQ failed:', e.message);
  }

  // Fallback: Yahoo Finance IPO calendar
  if (!ipos.length) {
    try {
      const from = today.toISOString().split('T')[0];
      const to   = new Date(today.getTime() + 90 * 86_400_000).toISOString().split('T')[0];
      const r    = await fetch(
        `https://query2.finance.yahoo.com/v2/finance/calendar/ipo?from=${from}&to=${to}`,
        { headers: YAHOO_HEADERS },
      );
      if (r.ok) {
        const d      = await r.json();
        const events = d.ipoCalendar?.ipoData || [];
        ipos = events.map(e => ({
          name:     e.companyName || e.company || '',
          ticker:   e.symbol || '',
          date:     e.startDate?.fmt || e.date || '',
          exchange: e.exchange || '',
          price:    e.priceLow && e.priceHigh ? `$${e.priceLow}–$${e.priceHigh}` : (e.price || 'TBD'),
          status:   'upcoming',
        }));
      }
    } catch (e) {
      console.error('[ipos] Yahoo fallback failed:', e.message);
    }
  }

  // Sort: upcoming by date asc, filed after
  ipos.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'upcoming' ? -1 : 1;
    return (a.date || '').localeCompare(b.date || '');
  });

  const result = { ipos: ipos.slice(0, 20), ts: Date.now() };
  env?.REC_LOG?.put(KV_KEY, JSON.stringify(result), { expirationTtl: 43200 }).catch(() => {});
  return json(result, 200, origin);
}

async function handleWatchlistBatch(symbols, origin, env, ctx) {
  const tickers = symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 30);
  if (!tickers.length) return err('symbols required', 400, origin);

  // Pre-warm the crumb once so all parallel Yahoo v10 calls share it
  await getYahooCrumb(env).catch(() => {});

  const stocks = {};

  // Process in chunks of 4 to avoid rate-limiting Yahoo with 40+ concurrent requests
  const CHUNK = 4;
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const batch = tickers.slice(i, i + CHUNK);
    await Promise.allSettled(batch.map(async ticker => {
      try {
        const [chartRes, fundRes, analysisRes] = await Promise.allSettled([
          yahoo(`/v8/finance/chart/${ticker}`, '?range=3mo&interval=1d'),
          yahooAuth(
            `/v10/finance/quoteSummary/${ticker}`,
            '?modules=price,summaryDetail,defaultKeyStatistics,financialData,calendarEvents,assetProfile',
            env,
          ),
          env?.REC_LOG?.get(`analysis:${ticker}`, 'json'),
        ]);

        let price = null, changePct = null, volume = null;
        let w52High = null, w52Low = null;
        let rsi = null, support = null, resist = null;

        if (chartRes.status === 'fulfilled') {
          const result = chartRes.value?.chart?.result?.[0];
          const meta   = result?.meta || {};
          const q      = result?.indicators?.quote?.[0] || {};
          const closes = (q.close || []).filter(v => v != null);
          const highs  = (q.high  || []).filter(v => v != null);
          const lows   = (q.low   || []).filter(v => v != null);

          price   = meta.regularMarketPrice ?? null;
          volume  = meta.regularMarketVolume ?? null;
          w52High = meta.fiftyTwoWeekHigh ?? null;
          w52Low  = meta.fiftyTwoWeekLow  ?? null;
          // changePct derived from fundRes price module below for accuracy

          if (closes.length >= 15) rsi = computeRSI(closes);
          if (highs.length  >= 5)  ({ support, resist } = computeSR(highs, lows));
        }

        let pe = null, targetLow = null, targetMean = null, targetHigh = null;
        let shortPct = null, earningsDate = null, daysToEarnings = null, sector = null;

        if (fundRes.status === 'fulfilled') {
          const r = fundRes.value?.quoteSummary?.result?.[0] || {};
          pe         = r.summaryDetail?.trailingPE?.raw ?? r.defaultKeyStatistics?.forwardPE?.raw ?? null;
          targetLow  = r.financialData?.targetLowPrice?.raw ?? null;
          targetMean = r.financialData?.targetMeanPrice?.raw ?? null;
          targetHigh = r.financialData?.targetHighPrice?.raw ?? null;
          shortPct   = r.defaultKeyStatistics?.shortPercentOfFloat?.raw ?? null;
          sector     = r.assetProfile?.sector ?? null;

          // Use quoteSummary price module for authoritative 1-day values
          const qPrice   = r.price?.regularMarketPrice?.raw ?? null;
          const qPctRaw  = r.price?.regularMarketChangePercent?.raw ?? null;  // decimal, e.g. 0.025 = +2.5%
          const qPrev    = r.price?.regularMarketPreviousClose?.raw ?? null;
          if (qPrice  != null) price = qPrice;
          volume = r.price?.regularMarketVolume?.raw ?? volume;
          if (qPctRaw != null) {
            changePct = Math.round(qPctRaw * 10000) / 100;
          } else if (qPrice != null && qPrev != null) {
            changePct = Math.round((qPrice - qPrev) / qPrev * 10000) / 100;
          }

          const epoch = r.calendarEvents?.earnings?.earningsDate?.[0]?.raw;
          if (epoch) {
            const d = new Date(epoch * 1000);
            earningsDate   = `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}, '${String(d.getFullYear()).slice(2)}`;
            daysToEarnings = Math.ceil((d.getTime() - Date.now()) / 86_400_000);
          }
        }

        // Claude analysis from KV (written by cron or previous on-demand run)
        let trend = null, pattern = null, action = null, summary = null, rating = null, confidence = null, analysisTs = null;
        const cached = analysisRes.status === 'fulfilled' ? analysisRes.value : null;
        if (cached && Date.now() - (cached.ts || 0) < 172_800_000) {
          ({ trend, pattern, action, summary, rating, confidence } = cached);
          analysisTs = cached.ts;
        }

        stocks[ticker] = {
          symbol: ticker,
          price,
          changePct,
          volume,
          pe:         pe     != null ? Math.round(pe     * 10) / 10 : null,
          sector,
          w52High,
          w52Low,
          targetLow:  targetLow  != null ? Math.round(targetLow  * 100) / 100 : null,
          targetMean: targetMean != null ? Math.round(targetMean * 100) / 100 : null,
          targetHigh: targetHigh != null ? Math.round(targetHigh * 100) / 100 : null,
          shortPct:   shortPct   != null ? Math.round(shortPct   * 10000) / 100 : null,
          earningsDate,
          daysToEarnings,
          rsi,
          support,
          resist,
          trend,
          pattern,
          action,
          summary,
          rating,
          confidence,
          analysisTs,
        };
      } catch (e) {
        console.error(`[watchlist] ${ticker}:`, e.message);
        stocks[ticker] = { symbol: ticker, error: e.message };
      }
    }));
  }

  // Fire on-demand Claude analysis for tickers that have no cached entry.
  // Runs after the response is sent so it doesn't block the client.
  const needsAnalysis = tickers.filter(t => stocks[t] && !stocks[t].trend && !stocks[t].error);
  if (needsAnalysis.length > 0 && ctx && env?.ANTHROPIC_API_KEY) {
    ctx.waitUntil((async () => {
      for (let i = 0; i < needsAnalysis.length; i += 5) {
        await Promise.allSettled(
          needsAnalysis.slice(i, i + 5).map(t => refreshTickerAnalysis(t, env)),
        );
      }
    })());
  }

  return json({ stocks, analysisLoading: needsAnalysis.length > 0, ts: Date.now() }, 200, origin);
}

async function handleWatchlistAuction(symbols, origin, env, ctx) {
  const tickers = symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 30);
  if (!tickers.length) return err('symbols required', 400, origin);

  const etDate   = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const cacheKey = `auction:${etDate}:${tickers.slice().sort().join(',')}`;

  try {
    const cached = await env?.REC_LOG?.get(cacheKey, 'json');
    if (cached && Date.now() - cached.ts < 72_000_000) return json(cached, 200, origin);
  } catch (_) {}

  // Return early if market hasn't closed yet (before 4:01pm ET)
  const nowParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const etH = parseInt(nowParts.find(p => p.type === 'hour').value);
  const etM = parseInt(nowParts.find(p => p.type === 'minute').value);
  if (etH < 16 || (etH === 16 && etM < 1)) {
    return json({ auction: {}, pending: true, ts: Date.now() }, 200, origin);
  }

  const auction = {};

  for (let i = 0; i < tickers.length; i += 5) {
    await Promise.allSettled(
      tickers.slice(i, i + 5).map(async ticker => {
        try {
          const data = await yahoo(
            `/v8/finance/chart/${ticker}`,
            '?range=1d&interval=1m&includePrePost=true',
          );
          const result = data?.chart?.result?.[0];
          if (!result) return;

          const meta       = result.meta       || {};
          const timestamps = result.timestamp  || [];
          const q          = result.indicators?.quote?.[0] || {};
          const closes  = q.close  || [];
          const volumes = q.volume || [];
          const opens   = q.open   || [];

          const regularClose = meta.regularMarketPrice ?? meta.chartPreviousClose ?? null;
          const closeTs      = meta.regularMarketTime  ?? null; // Unix secs, end of regular session
          if (regularClose == null || closeTs == null) return;

          // First bar strictly after the regular session close timestamp
          let ahIdx = -1;
          for (let j = 0; j < timestamps.length; j++) {
            if (timestamps[j] > closeTs) { ahIdx = j; break; }
          }
          if (ahIdx === -1) return;

          const ahVol    = volumes[ahIdx] ?? 0;
          const ahOpen   = opens[ahIdx]   ?? null;
          const ahClose  = closes[ahIdx]  ?? null;
          const ahChg    = ahClose != null ? Math.round((ahClose - regularClose) * 100) / 100 : null;
          const ahChgPct = ahClose != null ? Math.round((ahClose - regularClose) / regularClose * 10000) / 100 : null;

          auction[ticker] = { regularClose, ahVol, ahOpen, ahClose, ahChg, ahChgPct };
        } catch (e) {
          console.error(`[auction] ${ticker}:`, e.message);
        }
      })
    );
  }

  const result = { auction, pending: false, ts: Date.now() };
  if (ctx) ctx.waitUntil(
    env?.REC_LOG?.put(cacheKey, JSON.stringify(result), { expirationTtl: 72000 }).catch(() => {})
  );
  return json(result, 200, origin);
}

async function handleDailyGet(origin, env, ctx) {
  try {
    const [snapshotRes, eodRes] = await Promise.allSettled([
      env?.REC_LOG?.get('daily:snapshot', 'json'),
      env?.REC_LOG?.get('daily:eod', 'json'),
    ]);
    const snapshot = snapshotRes.status === 'fulfilled' ? snapshotRes.value : null;
    const eod      = eodRes.status === 'fulfilled' ? eodRes.value : null;

    // Auto-trigger EOD generation if market is closed, data is missing, and we have API access
    let eodLoading = false;
    if (!eod && ctx && env?.ANTHROPIC_API_KEY) {
      const ptNow    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
      const isWeekday = ptNow.getDay() >= 1 && ptNow.getDay() <= 5;
      const minsPT    = ptNow.getHours() * 60 + ptNow.getMinutes();
      // Market closes at 1pm PT; allow generation from 1pm through midnight
      if (isWeekday && minsPT >= 780) {
        ctx.waitUntil(generateEODSummary(env));
        eodLoading = true;
      }
    }

    if (snapshot) return json({ ...snapshot, eod: eod || null, eodLoading }, 200, origin);
  } catch (_) {}

  // No morning snapshot — kick off generation
  if (ctx && env?.ANTHROPIC_API_KEY) {
    ctx.waitUntil(generateDailySnapshot(env));
  }
  return json({ loading: true, ts: Date.now() }, 200, origin);
}

/* ── Cron: per-ticker analysis ── */
async function refreshTickerAnalysis(ticker, env) {
  try {
    const [chartRes, fundRes] = await Promise.allSettled([
      yahoo(`/v8/finance/chart/${ticker}`, '?range=3mo&interval=1d'),
      yahooAuth(
        `/v10/finance/quoteSummary/${ticker}`,
        '?modules=price,summaryDetail,defaultKeyStatistics,financialData,assetProfile',
        env,
      ),
    ]);

    let priceCtx = '';
    if (chartRes.status === 'fulfilled') {
      const result = chartRes.value?.chart?.result?.[0];
      const meta   = result?.meta || {};
      const q      = result?.indicators?.quote?.[0] || {};
      const closes = (q.close || []).filter(v => v != null);
      const highs  = (q.high  || []).filter(v => v != null);
      const lows   = (q.low   || []).filter(v => v != null);
      const price  = meta.regularMarketPrice ?? 'N/A';
      const w52h   = meta.fiftyTwoWeekHigh ?? 'N/A';
      const w52l   = meta.fiftyTwoWeekLow  ?? 'N/A';
      const rsi    = closes.length >= 15 ? computeRSI(closes) : null;
      const sr     = highs.length  >= 5  ? computeSR(highs, lows) : null;
      priceCtx = `Price: $${price}, 52W: $${w52l}–$${w52h}` +
        (rsi != null ? `, RSI(14): ${rsi}` : '') +
        (sr  ? `, Support: $${sr.support}, Resistance: $${sr.resist}` : '');
    }

    let fundCtx = '';
    if (fundRes.status === 'fulfilled') {
      const r      = fundRes.value?.quoteSummary?.result?.[0] || {};
      const pe     = r.summaryDetail?.trailingPE?.raw ?? r.defaultKeyStatistics?.forwardPE?.raw ?? null;
      const sector = r.assetProfile?.sector ?? null;
      const target = r.financialData?.targetMeanPrice?.raw ?? null;
      fundCtx = [
        sector && `Sector: ${sector}`,
        pe     && `P/E: ${pe.toFixed(1)}`,
        target && `Analyst target: $${target}`,
      ].filter(Boolean).join(', ');
    }

    const prompt = `Analyze ${ticker} briefly as a stock trader. Given: ${priceCtx}. ${fundCtx}.

Return ONLY valid JSON (no markdown):
{
  "rating": "BUY" | "HOLD" | "SELL",
  "confidence": 0-100,
  "trend": "10-word trend description",
  "pattern": "Chart pattern name",
  "action": "Action phrase (e.g. Hold above $87, Buy dips to $85)",
  "summary": "2-sentence trader summary"
}`;

    const text    = await workerClaude(prompt, env, 300);
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const analysis = JSON.parse(cleaned);

    await env?.REC_LOG?.put(
      `analysis:${ticker}`,
      JSON.stringify({ ...analysis, ts: Date.now() }),
      { expirationTtl: 172800 },
    );
  } catch (e) {
    console.error(`[cron] analysis failed for ${ticker}:`, e.message);
  }
}

/* ── Cron: daily snapshot ── */
async function generateDailySnapshot(env) {
  // Dedup: skip if already generated in the last 2 hours
  try {
    const existing = await env?.REC_LOG?.get('daily:snapshot', 'json');
    if (existing && Date.now() - existing.ts < 7_200_000) {
      console.log('[cron] snapshot fresh, skipping');
      return;
    }
  } catch (_) {}

  // Clear yesterday's EOD so pre-market context takes over
  try { await env?.REC_LOG?.delete('daily:eod'); } catch (_) {}

  // Gather macro news
  let newsLines = '';
  try {
    if (env?.ALPACA_KEY && env?.ALPACA_SECRET) {
      const data = await alpacaFetch('/v1beta1/news?limit=20&sort=desc', env);
      newsLines = (data.news || []).slice(0, 15).map(n => `• ${n.headline}`).join('\n');
    } else {
      const r = await fetch(
        'https://query2.finance.yahoo.com/v1/finance/search?q=market+today&quotesCount=0&newsCount=15',
        { headers: YAHOO_HEADERS },
      );
      if (r.ok) {
        const d = await r.json();
        newsLines = (d.news || []).slice(0, 15).map(n => `• ${n.title}`).join('\n');
      }
    }
  } catch (_) {}

  // Gather market context
  let marketLines = '';
  try {
    const tickers = Object.keys(SNAPSHOT_SYMBOLS);
    const results = await Promise.allSettled(
      tickers.map(t => yahoo(`/v8/finance/chart/${encodeURIComponent(t)}`, '?range=1d&interval=1d')),
    );
    marketLines = tickers.map((t, i) => {
      if (results[i].status !== 'fulfilled') return null;
      const meta      = results[i].value?.chart?.result?.[0]?.meta || {};
      const price     = meta.regularMarketPrice;
      const prev      = meta.chartPreviousClose ?? meta.previousClose;
      if (price == null || prev == null) return null;
      const chg = ((price - prev) / prev * 100).toFixed(2);
      return `${SNAPSHOT_SYMBOLS[t]}: ${price.toFixed(2)} (${chg > 0 ? '+' : ''}${chg}%)`;
    }).filter(Boolean).join('\n');
  } catch (_) {}

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    timeZone: 'America/Los_Angeles',
  });

  const prompt = `You are a professional stock market analyst. Today is ${today}.

MARKET DATA:
${marketLines || 'Not available'}

RECENT NEWS HEADLINES:
${newsLines || 'Not available'}

Generate a morning market briefing as valid JSON with exactly these fields:
{
  "headline": "One-sentence market summary (max 120 chars)",
  "open": {
    "headline": "One-sentence market open outlook (max 120 chars)",
    "body": "2-3 sentences on key levels, sectors to watch, and the expected tone of today's session."
  },
  "newsCards": [
    { "title": "short title", "body": "2-sentence analysis", "tag": "Macro|Fed|Sector|Geopolitical|Earnings" }
  ],
  "opportunity": { "ticker": "SYMBOL", "reason": "1-2 sentences" },
  "avoid": { "ticker": "SYMBOL", "reason": "1-2 sentences" }
}

newsCards must have exactly 8 items. For opportunity and avoid, choose from: ${DEFAULT_WATCHLIST.join(', ')}.
Return ONLY valid JSON, no markdown fences.`;

  let snapshot;
  try {
    const text    = await workerClaude(prompt, env, 1500);
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    snapshot = JSON.parse(cleaned);
  } catch (e) {
    console.error('[cron] snapshot parse failed:', e.message);
    snapshot = { headline: `Market update for ${today}`, newsCards: [], opportunity: null, avoid: null };
  }

  await env?.REC_LOG?.put(
    'daily:snapshot',
    JSON.stringify({ ...snapshot, ts: Date.now() }),
    { expirationTtl: 172800 },
  );
  console.log('[cron] daily snapshot saved');

  // Refresh per-ticker Claude analysis in batches of 5
  for (let i = 0; i < DEFAULT_WATCHLIST.length; i += 5) {
    await Promise.allSettled(
      DEFAULT_WATCHLIST.slice(i, i + 5).map(t => refreshTickerAnalysis(t, env)),
    );
  }
  console.log('[cron] ticker analyses refreshed');
}

/* ── Cron: end-of-day summary (1:15pm PT, ~15 min after market close) ── */
async function generateEODSummary(env) {
  try {
    const existing = await env?.REC_LOG?.get('daily:eod', 'json');
    if (existing && Date.now() - existing.ts < 7_200_000) {
      console.log('[cron] eod fresh, skipping');
      return;
    }
  } catch (_) {}

  // Current market snapshot
  let marketLines = '';
  try {
    const tickers = Object.keys(SNAPSHOT_SYMBOLS);
    const results = await Promise.allSettled(
      tickers.map(t => yahoo(`/v8/finance/chart/${encodeURIComponent(t)}`, '?range=1d&interval=1d')),
    );
    marketLines = tickers.map((t, i) => {
      if (results[i].status !== 'fulfilled') return null;
      const meta  = results[i].value?.chart?.result?.[0]?.meta || {};
      const price = meta.regularMarketPrice;
      const prev  = meta.chartPreviousClose ?? meta.previousClose;
      if (price == null || prev == null) return null;
      const chg = ((price - prev) / prev * 100).toFixed(2);
      return `${SNAPSHOT_SYMBOLS[t]}: ${price.toFixed(2)} (${chg >= 0 ? '+' : ''}${chg}%)`;
    }).filter(Boolean).join('\n');
  } catch (_) {}

  // Today's news
  let newsLines = '';
  try {
    if (env?.ALPACA_KEY && env?.ALPACA_SECRET) {
      const data = await alpacaFetch('/v1beta1/news?limit=20&sort=desc', env);
      newsLines = (data.news || []).slice(0, 15).map(n => `• ${n.headline}`).join('\n');
    } else {
      const r = await fetch(
        'https://query2.finance.yahoo.com/v1/finance/search?q=stock+market&quotesCount=0&newsCount=15',
        { headers: YAHOO_HEADERS },
      );
      if (r.ok) {
        const d = await r.json();
        newsLines = (d.news || []).slice(0, 15).map(n => `• ${n.title}`).join('\n');
      }
    }
  } catch (_) {}

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    timeZone: 'America/Los_Angeles',
  });

  const prompt = `You are a professional market analyst. US markets just closed for ${dateStr}.

FINAL MARKET DATA:
${marketLines || 'Not available'}

TODAY'S NEWS:
${newsLines || 'Not available'}

Write a concise end-of-day market summary as valid JSON (no markdown):
{
  "headline": "One-sentence session summary (max 120 chars)",
  "body": "3-4 sentences: overall session character, key sector rotation or notable movers, what the close sets up for tomorrow."
}`;

  let eod;
  try {
    const text    = await workerClaude(prompt, env, 500);
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    eod = JSON.parse(cleaned);
  } catch (e) {
    console.error('[cron] eod parse failed:', e.message);
    eod = { headline: `Market closed ${dateStr}`, body: 'Market data unavailable.' };
  }

  await env?.REC_LOG?.put(
    'daily:eod',
    JSON.stringify({ ...eod, ts: Date.now() }),
    { expirationTtl: 86400 },
  );
  console.log('[cron] eod summary saved');
}

/* ── Main fetch handler ── */
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors(origin) });
    }

    if (!isAllowedOrigin(origin)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status:  403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const url   = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] !== 'api') return err('not found', 404, origin);

    try {
      const [, route, sub] = parts;
      switch (route) {
        case 'quote':    return await handleQuote(sub, origin, env);
        case 'chart':    return await handleChart(sub, url.searchParams, origin);
        case 'options':
          if (sub === 'recap') return await handleOptionsRecap(url.searchParams, origin, env, ctx);
          return await handleOptions(sub, url.searchParams, origin);
        case 'search':   return await handleSearch(url.searchParams.get('q') || '', origin);
        case 'news':     return await handleNews(sub, origin, env);
        case 'peers':    return await handlePeers(sub, origin);
        case 'claude':   return await handleClaude(request, env, origin);
        case 'log-rec':  return await handleLogRec(request, env, origin);
        case 'track':    return await handleTrack(sub, env, origin);
        case 'daily':    return await handleDailyGet(origin, env, ctx);
        case 'market':
          if (sub === 'snapshot') return await handleMarketSnapshot(origin, env);
          if (sub === 'movers')   return await handleMarketMovers(origin, env);
          if (sub === 'ipos')     return await handleMarketIPOs(origin, env);
          return err('unknown market route', 404, origin);
        case 'watchlist':
          if (sub === 'batch') return await handleWatchlistBatch(
            url.searchParams.get('symbols') || '', origin, env, ctx,
          );
          if (sub === 'auction') return await handleWatchlistAuction(
            url.searchParams.get('symbols') || '', origin, env, ctx,
          );
          return err('unknown watchlist route', 404, origin);
        default:         return err('unknown route', 404, origin);
      }
    } catch (e) {
      console.error('[worker] unhandled:', e.message);
      return err(e.message, 500, origin);
    }
  },

  async scheduled(event, env, ctx) {
    // EOD crons fire at 20:15 or 21:15 UTC (1:15pm PDT / PST)
    if (event.cron === '15 20 * * 1-5' || event.cron === '15 21 * * 1-5') {
      ctx.waitUntil(generateEODSummary(env));
    } else {
      ctx.waitUntil(generateDailySnapshot(env));
    }
  },
};
