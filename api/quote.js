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
    // Same "second-to-last bar" logic as above: with interval=1wk, the last bar is the
    // current, still-in-progress week, so the previous entry is the last completed week.
    try {
      const weeklyUpstream = await fetch(
        'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=3mo&interval=1wk',
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }
      );
      if (weeklyUpstream.ok) {
        const weeklyData = await weeklyUpstream.json();
        const wResult = weeklyData.chart && weeklyData.chart.result && weeklyData.chart.result[0];
        const wQuote = wResult && wResult.indicators && wResult.indicators.quote && wResult.indicators.quote[0];
        const wTs = wResult && wResult.timestamp;
        if (wQuote && wTs && wTs.length >= 2) {
          const wIdx = wTs.length - 2;
          data.prevWeekClose = typeof wQuote.close[wIdx] === 'number' ? wQuote.close[wIdx] : null;
          data.prevWeekHigh = typeof wQuote.high[wIdx] === 'number' ? wQuote.high[wIdx] : null;
          data.prevWeekLow = typeof wQuote.low[wIdx] === 'number' ? wQuote.low[wIdx] : null;
        }
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
