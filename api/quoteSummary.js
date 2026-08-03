// Deploy this as: api/quoteSummary.js  (root of your live-charts repo, alongside quote.js)
//
// Separate on purpose from quote.js — see chat notes. This endpoint (Yahoo's quoteSummary API)
// carries valuation/fundamental fields the chart endpoint doesn't (PE, EPS, Beta, etc.), but it
// requires a Yahoo session cookie + crumb to work, which the plain chart endpoint does not need.
// Keeping it in its own function means if Yahoo changes something here, or this call gets rate
// limited, only the portfolio tool's fundamentals columns are affected — chart.html and the
// price proxy (quote.js) are untouched.
//
// Usage from the browser: GET https://<your-project>.vercel.app/api/quoteSummary?symbol=RELIANCE.NS

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Best-effort in-memory cache. Serverless functions may cold-start with no memory carried over,
// but when Vercel reuses a warm instance this saves a cookie+crumb round trip on every call.
let cachedCrumb = null;
let cachedCookie = null;
let crumbFetchedAt = 0;
const CRUMB_TTL_MS = 55 * 60 * 1000; // Yahoo crumbs/cookies are good for roughly an hour

async function getCrumbAndCookie() {
  const now = Date.now();
  if (cachedCrumb && cachedCookie && (now - crumbFetchedAt) < CRUMB_TTL_MS) {
    return { crumb: cachedCrumb, cookie: cachedCookie };
  }

  const cookieRes = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
  const setCookie = cookieRes.headers.get('set-cookie');
  if (!setCookie) throw new Error('no cookie from yahoo');
  const cookie = setCookie.split(';')[0];

  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': cookie }
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.includes('<')) throw new Error('no crumb from yahoo');

  cachedCrumb = crumb;
  cachedCookie = cookie;
  crumbFetchedAt = now;
  return { crumb, cookie };
}

function pickRaw(obj, key) {
  return obj && obj[key] && typeof obj[key].raw === 'number' ? obj[key].raw : null;
}

export default async function handler(req, res) {
  const { symbol } = req.query;
  if (!symbol) {
    res.status(400).json({ error: 'symbol query param required' });
    return;
  }

  try {
    const { crumb, cookie } = await getCrumbAndCookie();

    const modules = 'defaultKeyStatistics,financialData,summaryDetail,price';
    const url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' +
      encodeURIComponent(symbol) + '?modules=' + modules + '&crumb=' + encodeURIComponent(crumb);

    const upstream = await fetch(url, { headers: { 'User-Agent': UA, 'Cookie': cookie } });

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'upstream error ' + upstream.status });
      return;
    }

    const data = await upstream.json();
    const result = data && data.quoteSummary && data.quoteSummary.result && data.quoteSummary.result[0];
    if (!result) {
      res.status(404).json({ error: 'no data for symbol' });
      return;
    }

    const stats = result.defaultKeyStatistics || {};
    const fin = result.financialData || {};
    const summary = result.summaryDetail || {};
    const price = result.price || {};

    const out = {
      symbol,
      trailingPE: pickRaw(summary, 'trailingPE'),
      forwardPE: pickRaw(summary, 'forwardPE'),
      trailingEps: pickRaw(stats, 'trailingEps'),
      forwardEps: pickRaw(stats, 'forwardEps'),
      beta: pickRaw(stats, 'beta'),
      dividendYield: pickRaw(summary, 'dividendYield'),
      marketCap: pickRaw(summary, 'marketCap'),
      priceToBook: pickRaw(stats, 'priceToBook'),
      returnOnEquity: pickRaw(fin, 'returnOnEquity'),
      regularMarketOpen: pickRaw(price, 'regularMarketOpen')
    };

    // Fundamentals move slowly — cache much longer than the price proxy's 5s.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: 'proxy fetch failed: ' + e.message });
  }
}
