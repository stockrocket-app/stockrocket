# StockRocket API

Server-side proxies. The client never calls upstream APIs directly -- all
Finnhub traffic is routed through `/api/finnhub` so the API key stays in Vercel
env vars and never lands in a browser devtools network log.

## Endpoints

### `/api/finnhub`

Vercel Edge Function. Takes a `path` query param + any upstream params and
proxies to `https://finnhub.io/api/v1/{path}`, injecting the API key server-side.

**Allowed paths:**
- `quote` -- real-time quote (`symbol=AAPL`)
- `candle` (alias `stock/candle`) -- historical OHLC (`symbol, resolution, from, to`)
- `profile2` -- company profile
- `metric` -- fundamentals
- `news` -- general market news (`category=general`)
- `company-news` -- per-symbol news (`symbol, from, to`)
- `search` -- ticker search (`q=`)

**Example from the client:**
```
GET /api/finnhub?path=quote&symbol=AAPL
GET /api/finnhub?path=candle&symbol=AAPL&resolution=D&from=1700000000&to=1705000000
```

## Deploy setup

1. Vercel project > Settings > Environment Variables
2. Add `FINNHUB_KEY` (Production + Preview + Development)
3. Redeploy

Free-tier limits: 60 calls/min. The proxy caches quote responses for 15s and
candle responses for 60s (via `Cache-Control: s-maxage`) to absorb multiple
clients without burning the budget.

## Adding a new upstream API

Follow the same pattern: `/api/{service}.js`, read the key from `process.env`,
allowlist paths, forward params, inject the key. Eventually this will consolidate
into a shared `/api/gateway` pattern that other COA apps can reuse (see the
"COA API Gateway" note in the Brain app backlog).
