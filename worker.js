/**
 * Stock Research Dashboard — Cloudflare Worker
 *
 * Data sources:
 *   - Yahoo Finance v8 chart API: OHLCV bars + price meta (no auth required)
 *   - Yahoo Finance v10 quoteSummary: fundamentals, analyst targets, insider data
 *     (requires crumb authentication — obtained via two-step cookie flow)
 *   - Alpaca Market Data API (optional): real-time price snapshot, news headlines
 *   - Anthropic Claude API: AI synthesis
 *
 * Endpoints:
 *   GET  /api/quote/:ticker              → Yahoo v10 fundamentals + Alpaca/chart-meta price
 *   GET  /api/chart/:ticker?range&intvl  → Yahoo v8 OHLCV (no crumb, always works)
 *   GET  /api/options/:ticker[?date]     → Yahoo v7 options chain
 *   GET  /api/search?q=                  → Yahoo ticker search
 *   GET  /api/news/:ticker               → Alpaca news (Yahoo fallback)
 *   GET  /api/peers/:ticker              → Yahoo recommendationsBySymbol
 *   POST /api/claude                     → Anthropic Messages API proxy
 *   POST /api/log-rec                    → Append rating to KV (forward log)
 *   GET  /api/track/:ticker              → Read rating history from KV
 *
 * Required secrets (set via: npx wrangler secret put <NAME>):
 *   ANTHROPIC_API_KEY  — Anthropic API key for Claude synthesis
 *   ALPACA_KEY         — Alpaca API key ID (optional but recommended for real-time price)
 *   ALPACA_SECRET      — Alpaca API secret key
 *
 * KV namespace (wrangler.toml):
 *   REC_LOG — rating history + Yahoo crumb/cookie cache
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

/* ── CORS ── */
function isAllowedOrigin(origin) {
  if (!origin || origin === 'null') return true; // file:// local dev
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

/* ── Yahoo Finance (no-auth endpoints) ── */
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
// In-memory per-isolate cache (supplemented by KV for cross-isolate sharing)
let _crumbCache = null;

/**
 * Read the first N bytes of a response stream looking for a pattern.
 * Returns the capture group [1] on match, null otherwise.
 * Cancels the stream as soon as a match is found or the limit is reached.
 */
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

/** Extract first matching cookie value from a Set-Cookie header string. */
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

  // 1) in-memory cache
  if (_crumbCache && _crumbCache.ts > now - TTL) return _crumbCache;

  // 2) KV cache
  try {
    const kv = await env?.REC_LOG?.get('yahoo:crumb', 'json');
    if (kv && kv.ts > now - TTL) { _crumbCache = kv; return _crumbCache; }
  } catch (_) {}

  let crumb = null;
  let cookie = '';

  // Strategy A: direct user-agent endpoint (works when Cloudflare IP has a session)
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

  // Strategy B: visit finance.yahoo.com, scan HTML for crumb + extract A1 cookie
  if (!crumb) {
    try {
      const r = await fetch('https://finance.yahoo.com', {
        headers: { ...YAHOO_HEADERS, Accept: 'text/html' },
        redirect: 'follow',
      });
      cookie = extractCookie(r.headers.get('set-cookie') || '', 'A1', 'B') || cookie;

      // Scan the HTML stream for the crumb string (stops after first match)
      crumb = await scanStream(r, /"crumb"\s*:\s*"([^"\\]{1,30})"/, 200_000);

      // If crumb not in HTML, try user-agent endpoint again with the cookie we just got
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

  _crumbCache = { crumb, cookie, ts: now };
  env?.REC_LOG?.put('yahoo:crumb', JSON.stringify(_crumbCache), { expirationTtl: 3600 }).catch(() => {});
  return _crumbCache;
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
    // Crumb expired — bust cache and retry once
    _crumbCache = null;
    ({ crumb, cookie } = await getYahooCrumb(env));
    r = await make(crumb, cookie);
  }

  if (!r.ok) throw new Error(`Yahoo v10 ${r.status}`);
  return r.json();
}

/**
 * Convert the `meta` object from a Yahoo v8 chart response into
 * a minimal quoteSummary `result[0]` structure the frontend expects.
 * Used as a fallback when v10 quoteSummary fails.
 */
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
    // Remaining modules (fundamentals, analyst, insider) will be empty
    // — the frontend renders "—" gracefully for missing values
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

/* ── Route handlers ── */

async function handleQuote(ticker, origin, env) {
  const modules = [
    'price', 'summaryDetail', 'defaultKeyStatistics', 'financialData',
    'calendarEvents', 'recommendationTrend', 'upgradeDowngradeHistory',
    'assetProfile', 'insiderTransactions', 'netSharePurchaseActivity',
  ].join(',');

  // Fetch Yahoo v10 fundamentals + chart meta (for fallback) + Alpaca snapshot in parallel
  const [yahooRes, chartRes, alpacaRes] = await Promise.allSettled([
    yahooAuth(`/v10/finance/quoteSummary/${ticker}`, `?modules=${modules}`, env),
    yahoo(`/v8/finance/chart/${ticker}`, '?range=1d&interval=1d'),
    alpacaFetch(`/v2/stocks/${ticker}/snapshot`, env),
  ]);

  let data;

  if (yahooRes.status === 'fulfilled') {
    data = yahooRes.value;
  } else {
    // Yahoo v10 failed — build minimal structure from chart meta
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

  // Patch Alpaca real-time price data over whatever price we have
  if (alpacaRes.status === 'fulfilled') {
    const snap   = alpacaRes.value;
    const result = data.quoteSummary?.result?.[0];
    if (result) {
      if (!result.price) result.price = {};
      const lp  = snap.latestTrade?.p ?? snap.dailyBar?.c;
      const pc  = snap.prevDailyBar?.c;
      const vol = snap.dailyBar?.v;

      const p = (v) => v != null ? { raw: v, fmt: v.toFixed(2) } : undefined;
      if (lp  != null) result.price.regularMarketPrice        = p(lp);
      if (pc  != null) result.price.regularMarketPreviousClose = p(pc);
      if (vol != null) result.price.regularMarketVolume        = { raw: vol, fmt: String(vol) };
      result.price.symbol = result.price.symbol || ticker;

      // Infer market state (Eastern Time)
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
  // Yahoo v8 chart works without crumb — keep using it
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
  const data   = await yahoo(`/v7/finance/options/${ticker}`, search);
  return json(data, 200, origin);
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
  // Prefer Alpaca news (more structured, includes sentiment signals)
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

  // Fallback: Yahoo search news
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

/* ── Main fetch handler ── */
export default {
  async fetch(request, env) {
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
      const [, route, ticker] = parts;
      switch (route) {
        case 'quote':   return await handleQuote(ticker, origin, env);
        case 'chart':   return await handleChart(ticker, url.searchParams, origin);
        case 'options': return await handleOptions(ticker, url.searchParams, origin);
        case 'search':  return await handleSearch(url.searchParams.get('q') || '', origin);
        case 'news':    return await handleNews(ticker, origin, env);
        case 'peers':   return await handlePeers(ticker, origin);
        case 'claude':  return await handleClaude(request, env, origin);
        case 'log-rec': return await handleLogRec(request, env, origin);
        case 'track':   return await handleTrack(ticker, env, origin);
        default:        return err('unknown route', 404, origin);
      }
    } catch (e) {
      console.error('[worker] unhandled:', e.message);
      return err(e.message, 500, origin);
    }
  },
};
