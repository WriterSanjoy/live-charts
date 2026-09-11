// Deploy this as: api/quote.js  (in the root of your live-charts repo)
// Vercel auto-detects anything under /api as a serverless function.
//
// Usage from the browser: GET https://<your-project>.vercel.app/api/quote?symbol=RELIANCE.NS
// Runs server-side, so Yahoo's CORS block on browser-origin requests doesn't apply here —
// this function fetches Yahoo itself, then serves the JSON back to your page with its own
// CORS header allowing your GitHub Pages origin to read it.
//
// Unchanged for chart.html: the full Yahoo response is still passed through as-is, so
// data.chart.result[0].meta.regularMarketPrice / previousClose keep working exactly as before.
//
// Added for portfolio.html: requests explicit daily bars (range=5d&interval=1d) so the response
// carries enough history to derive the previous trading day's close/high/low — with this range,
// Yahoo's meta.previousClose/chartPreviousClose no longer reliably means "yesterday" (see below),
// so those are derived from the daily bars instead and exposed as new top-level `prevClose` /
// `prevHigh` / `prevLow` fields alongside the untouched `chart` object.
//
// Also added for portfolio.html's pivot columns: a second, weekly-bar fetch (range=3mo&interval=1wk)
// to derive the *last fully completed* week's close/high/low, exposed as `prevWeekClose` /
// `prevWeekHigh` / `prevWeekLow`. This matches how Moneycontrol's own pivot panel is computed —
// confirmed by back-solving their displayed R1/S1/R2/S2/R3/S3 against the classic pivot formula,
// which only reconciled once weekly (not daily) H/L/C was used as the input. Wrapped in its own
// try/catch so a hiccup fetching weekly bars never breaks the daily price data this endpoint
// already serves to chart.html.
//
// fetchNSEWeeklyOHLC: pulls the last completed Mon-Fri directly from NSE's own historical-
// data API (the same feed Moneycontrol's charts are built on), which is why it should track
// Moneycontrol's pivot numbers much more closely than Yahoo's resampled weekly bars. NSE
// requires a same-session cookie obtained from a normal page load first — it rejects direct
// API calls with no prior cookie as bot traffic. NOTE: NSE's IP-based bot detection can still
// block some datacenter/serverless IP ranges (including some on Vercel) even with a valid
// cookie and browser-like headers — if that's what's happening here, this will throw and the
// caller falls back to Yahoo automatically. Field names below (CH_TRADE_HIGH_PRICE etc.) match
// NSE's documented historical/cm/equity response as of this writing; if NSE has changed them,
// check the raw JSON (temporarily log `json` in Vercel's function logs) and adjust the `pick()`
// key lists accordingly.
async function fetchNSEWeeklyOHLC(symbol) {
  const bareSymbol = symbol.replace(/\.(NS|BO)$/i, '');
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
  const baseHeaders = {
    'User-Agent': ua,
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };

  const homeResp = await fetch('https://www.nseindia.com/get-quotes/equity?symbol=' + encodeURIComponent(bareSymbol), { headers: baseHeaders });
  const cookies = (typeof homeResp.headers.getSetCookie === 'function' ? homeResp.headers.getSetCookie() : String(homeResp.headers.get('set-cookie') || '').split(/,(?=[^;]+?=)/))
    .map(c => c.split(';')[0]).filter(Boolean).join('; ');
  if (!cookies) throw new Error('no NSE session cookie obtained');

  const fmt = d => String(d.getUTCDate()).padStart(2, '0') + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + d.getUTCFullYear();
  const today = new Date();
  const from = new Date(today.getTime() - 20 * 24 * 3600 * 1000);
  const url = 'https://www.nseindia.com/api/historical/cm/equity?symbol=' + encodeURIComponent(bareSymbol) +
    '&series=[%22EQ%22]&from=' + fmt(from) + '&to=' + fmt(today);

  const dataResp = await fetch(url, {
    headers: Object.assign({}, baseHeaders, {
      'Accept': 'application/json',
      'Referer': 'https://www.nseindia.com/get-quotes/equity?symbol=' + encodeURIComponent(bareSymbol),
      'Cookie': cookies,
    }),
  });
  if (!dataResp.ok) throw new Error('NSE historical fetch failed: ' + dataResp.status);
  const json = await dataResp.json();
  const rows = (json && json.data) || [];
  if (!rows.length) throw new Error('NSE returned no rows');

  const pick = (row, keys) => {
    for (const k of keys) {
      const v = row[k];
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && v.trim() && !isNaN(parseFloat(v))) return parseFloat(v);
    }
    return null;
  };

  const parsed = rows
    .map(r => ({
      date: r.CH_TIMESTAMP || r.mTIMESTAMP || r.TIMESTAMP,
      high: pick(r, ['CH_TRADE_HIGH_PRICE', 'HIGH', 'High']),
      low: pick(r, ['CH_TRADE_LOW_PRICE', 'LOW', 'Low']),
      close: pick(r, ['CH_CLOSING_PRICE', 'CLOSE', 'Close']),
    }))
    .filter(r => r.date && r.high != null && r.low != null && r.close != null)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!parsed.length) throw new Error('NSE rows had no usable OHLC fields');

  // Most recent Monday 00:00 UTC = start of the current, still-in-progress week.
  const now = new Date();
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const thisMonday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday);
  const lastMonday = thisMonday - 7 * 24 * 3600 * 1000;

  let weekRows = parsed.filter(r => {
    const t = new Date(r.date).getTime();
    return t >= lastMonday && t < thisMonday;
  });
  if (!weekRows.length) {
    // Fallback if week-boundary matching finds nothing (e.g. date-parsing quirk): just
    // use the most recent 5 completed trading days before this week.
    weekRows = parsed.filter(r => new Date(r.date).getTime() < thisMonday).slice(-5);
  }
  if (!weekRows.length) throw new Error('no completed-week NSE rows found');

  return {
    high: Math.max(...weekRows.map(r => r.high)),
    low: Math.min(...weekRows.map(r => r.low)),
    close: weekRows[weekRows.length - 1].close,
    source: 'nse',
  };
}

export default async function handler(req, res) {
  const { symbol } = req.query;
  if (!symbol) {
    res.status(400).json({ error: 'symbol query param required' });
    return;
  }

  try {
    const upstream = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=5d&interval=1d',
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }
    );

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'upstream error ' + upstream.status });
      return;
    }

    const data = await upstream.json();

    // Derive the previous completed trading day's close/high/low from the daily bars.
    // The last entry in each array is today's still-forming bar; the one before it
    // is the last fully completed session. Deliberately NOT using meta.previousClose /
    // meta.chartPreviousClose here: with range=5d, Yahoo anchors chartPreviousClose to
    // the close before the whole 5-day window (i.e. ~6 trading days back), not to yesterday.
    try {
      const result = data.chart && data.chart.result && data.chart.result[0];
      const quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
      const ts = result && result.timestamp;
      if (quote && ts && ts.length >= 2) {
        const idx = ts.length - 2;
        data.prevClose = typeof quote.close[idx] === 'number' ? quote.close[idx] : null;
        data.prevHigh = typeof quote.high[idx] === 'number' ? quote.high[idx] : null;
        data.prevLow = typeof quote.low[idx] === 'number' ? quote.low[idx] : null;
        // Also patch meta.previousClose itself: chart.html reads meta.previousClose directly
        // and was never changed to know about the new top-level fields above. Without this,
        // chart.html would silently inherit the same "anchored to start of range" bug.
        if (result.meta && typeof data.prevClose === 'number') {
          result.meta.previousClose = data.prevClose;
        }
      }
    } catch (e) {
      // If anything about the daily-bar shape is unexpected, just leave these absent
      // rather than failing the whole price request.
    }

    // Derive the last fully completed week's close/high/low, for pivot calculations.
    // Two-tier approach:
    //   1) Try NSE's own historical daily-bar API and aggregate the last completed
    //      Mon-Fri into H/L/C ourselves. This is the same underlying data Moneycontrol's
    //      own charts are built on, so it's the closest match available — but NSE
    //      actively blocks non-browser traffic (including many serverless IPs), so it
    //      can intermittently fail with a 401/403.
    //   2) If that fails for any reason, fall back to Yahoo's weekly-interval bars,
    //      picking the completed week by date-distance rather than array position
    //      (a "current week bar always at length-2" assumption doesn't hold — and even
    //      a naive "before this Monday" cutoff can still misfire, since Yahoo's own
    //      week-start convention isn't guaranteed to be Monday).
    try {
      let weekly = null;
      try {
        weekly = await fetchNSEWeeklyOHLC(symbol);
      } catch (nseErr) {
        data.prevWeekNSEError = String((nseErr && nseErr.message) || nseErr);
        weekly = null; // fall through to Yahoo below
      }

      if (!weekly) {
        const weeklyUpstream = await fetch(
          'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=3mo&interval=1wk',
          { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }
        );
        if (weeklyUpstream.ok) {
          const weeklyData = await weeklyUpstream.json();
          const wResult = weeklyData.chart && weeklyData.chart.result && weeklyData.chart.result[0];
          const wQuote = wResult && wResult.indicators && wResult.indicators.quote && wResult.indicators.quote[0];
          const wTs = wResult && wResult.timestamp;
          if (wQuote && wTs && wTs.length) {
            // Pick by date-distance from today, not array position or a hardcoded weekday
            // cutoff: if the most recent bar started less than 7 days ago, it's still the
            // current, possibly-incomplete week — step back one. Otherwise it's already
            // a completed week regardless of which weekday Yahoo anchors weeks to.
            const nowSec = Date.now() / 1000;
            let wIdx = wTs.length - 1;
            if (nowSec - wTs[wIdx] < 7 * 24 * 3600) wIdx -= 1;
            if (wIdx >= 0) {
              weekly = {
                close: typeof wQuote.close[wIdx] === 'number' ? wQuote.close[wIdx] : null,
                high: typeof wQuote.high[wIdx] === 'number' ? wQuote.high[wIdx] : null,
                low: typeof wQuote.low[wIdx] === 'number' ? wQuote.low[wIdx] : null,
                source: 'yahoo',
              };
            }
            // Debug payload so we can see exactly which bar got picked and why, without
            // guessing again — inspect this in the Network tab response JSON.
            data.prevWeekDebug = {
              nowIso: new Date(nowSec * 1000).toISOString(),
              chosenIndex: wIdx,
              arrayLength: wTs.length,
              allBarDates: wTs.map(t => new Date(t * 1000).toISOString().slice(0, 10)),
              ageOfLastBarDays: Math.round((nowSec - wTs[wTs.length - 1]) / 86400 * 10) / 10,
            };
          }
        }
      }

      if (weekly) {
        data.prevWeekClose = weekly.close;
        data.prevWeekHigh = weekly.high;
        data.prevWeekLow = weekly.low;
        data.prevWeekSource = weekly.source || 'yahoo';
      }
    } catch (e) {
      // Same principle as the daily-bar derivation above: never let a weekly-bar hiccup
      // fail the whole price request. Pivot columns just show '-' until refreshed again.
    }

    // Allow any origin to read this — it's just public market data, no secrets involved.
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Very short edge cache — just enough to absorb near-simultaneous requests, not to hold stale data.
    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=5');
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: 'proxy fetch failed' });
  }
}
