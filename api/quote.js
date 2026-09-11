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
// Also added for portfolio.html's pivot columns: a WEEKLY fetch (last completed Mon-Fri) and a
// MONTHLY fetch (last completed calendar month), exposed as `prevWeekHigh/Low/Close` and
// `prevMonthHigh/Low/Close`. Both are kept, because they map to two different pivot sets on
// Moneycontrol's own chart (confirmed directly via its indicator settings dialog — it's
// TradingView's "Pivots Traditional" with Timeframe set to Auto, which steps the pivot period
// up one level from the chart's own candle interval: <=15min->Daily, 15min-1Day->Weekly,
// 1Day-1Week->Monthly, >=1Week->Yearly):
//   - On an HOURLY chart, Auto resolves to Weekly  -> use prevWeek* for those pivots.
//   - On a DAILY chart, Auto resolves to Monthly   -> use prevMonth* for those pivots.
// Both were confirmed by back-solving Moneycontrol's displayed R1/R2/R3/S1/S2/S3 against the
// classic pivot formula and matching the resulting H/L/C against each period.
//
// NOTE: an NSE-direct data source was tried and removed — NSE's historical API blocks Vercel's
// IPs with a bot-detection HTML page instead of JSON, so it added a slow, always-failing round
// trip on every refresh for no benefit. Yahoo bars, picked correctly below, are the sole source.
//
// Picking the right bar for week/month: walk backward from the end of the array until finding
// a bar that is NOT part of the still-forming current period. NOT "second-to-last array entry" —
// Yahoo can append more than one trailing entry for the current period (confirmed via debugging:
// a normal cadence between historical bars, then one extra entry very close to the last one, and
// both trailing entries turned out to belong to the current period when cross-checked against
// daily bars). Walking back to the first bar that's definitively in a prior period is robust to
// however many of those trailing anomalies Yahoo throws in.

const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

function pickLastCompletedBar(ts, isCurrentPeriod) {
  for (let i = ts.length - 1; i >= 0; i--) {
    if (!isCurrentPeriod(ts[i])) return i;
  }
  return -1;
}

// Fetches one Yahoo chart interval and derives the OHLC of the last bar that is NOT still
// forming, per the caller's isCurrentPeriod(timestampSeconds) predicate. Returns null (never
// throws past this point) on any upstream/shape problem, so callers can treat missing period
// data as "just leave the columns blank" rather than failing the whole quote request.
async function fetchPeriodOHLC(symbol, interval, range, isCurrentPeriod) {
  const upstream = await fetch(
    'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=' + range + '&interval=' + interval,
    { headers: YAHOO_HEADERS }
  );
  if (!upstream.ok) return null;
  const json = await upstream.json();
  const result = json.chart && json.chart.result && json.chart.result[0];
  const quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
  const ts = result && result.timestamp;
  if (!quote || !ts || !ts.length) return null;

  const idx = pickLastCompletedBar(ts, isCurrentPeriod);
  if (idx < 0) return null;

  return {
    close: typeof quote.close[idx] === 'number' ? quote.close[idx] : null,
    high: typeof quote.high[idx] === 'number' ? quote.high[idx] : null,
    low: typeof quote.low[idx] === 'number' ? quote.low[idx] : null,
    debug: {
      chosenIndex: idx,
      arrayLength: ts.length,
      allBarDates: ts.map(t => new Date(t * 1000).toISOString().slice(0, 10)),
    },
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
      { headers: YAHOO_HEADERS }
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

    const nowSec = Date.now() / 1000;
    const nowDate = new Date();
    const curYearMonth = nowDate.getUTCFullYear() * 12 + nowDate.getUTCMonth();

    // Last completed WEEK — feeds Hourly-chart pivots on Moneycontrol.
    try {
      const weekly = await fetchPeriodOHLC(symbol, '1wk', '3mo', t => (nowSec - t) < 7 * 24 * 3600);
      if (weekly) {
        data.prevWeekClose = weekly.close;
        data.prevWeekHigh = weekly.high;
        data.prevWeekLow = weekly.low;
        data.prevWeekSource = 'yahoo';
        data.prevWeekDebug = weekly.debug; // safe to remove once confirmed reconciling
      }
    } catch (e) {
      // Never let a weekly-bar hiccup fail the whole price request.
    }

    // Last completed calendar MONTH — feeds Daily-chart pivots on Moneycontrol.
    try {
      const monthly = await fetchPeriodOHLC(symbol, '1mo', '1y', t => {
        const d = new Date(t * 1000);
        return (d.getUTCFullYear() * 12 + d.getUTCMonth()) >= curYearMonth;
      });
      if (monthly) {
        data.prevMonthClose = monthly.close;
        data.prevMonthHigh = monthly.high;
        data.prevMonthLow = monthly.low;
        data.prevMonthSource = 'yahoo';
        data.prevMonthDebug = monthly.debug; // safe to remove once confirmed reconciling
      }
    } catch (e) {
      // Never let a monthly-bar hiccup fail the whole price request.
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
