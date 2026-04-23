# StockRocket -- Price Invariants

These rules govern every price the app reads, renders, and writes to the
ledger. They exist because we violated them on 2026-04-18 and wrote six BTC
trades at a phantom $97,245.

## The incident

On 2026-04-18 the app recorded six BTC trades (three buys, three sells) at
$97,245 across two users. Real BTC price at the time was in the $74k-$78k
range. Root cause: the crypto price pipeline swallowed upstream failures
silently (`catch { return null }`) and the consumer hook fell back to a
hardcoded seed (`MOCK_CRYPTO` with BTC @ 97245). The UI rendered the seed
price as live, users traded against it, and the trade handler forwarded it
verbatim to the server. Server validated `price > 0` and accepted it.

Four things went wrong simultaneously:

1. The crypto fetcher had no explicit failure signal -- it returned `null`,
   which the consumer interpreted as "no update" rather than "feed is dead."
2. A hardcoded seed existed in code for layout stability. That seed looked
   identical to a real price to every downstream consumer.
3. The UI had no staleness indicator on crypto tiles, so users couldn't tell
   the price was 18 hours old.
4. The trade submission path did no price validation -- it trusted whatever
   the UI state held.

The data was repaired in `stockrocket_trades` + `stockrocket_portfolios`
(with audit trail in `stockrocket_trade_corrections`) on 2026-04-18.

## Invariants (MUST always be true)

### I1. A rendered price is either live or marked stale

Every asset object in UI state carries one of these shapes:

```js
{ symbol, price: <finite positive number>, stale: false, ... }   // live
{ symbol, price: null,                     stale: true,  ... }   // stale
```

There is no third state. `price: 0`, `price: undefined`, `price: NaN`, and
`price: <a seed value>` are all disallowed. Code that receives an asset
object must handle the stale branch explicitly -- it cannot assume price is
numeric.

### I2. Trade submission is guarded at a single choke point

`executeServerTrade()` rejects any request where `Number(price)` is not a
finite positive number. No call site may bypass this function. Adding a new
trade path that calls `/api/trades` directly is a violation.

### I3. Server-authoritative execution price

`/api/trades` POST fetches a live price server-side (same multi-source chain
as `/api/price`: Coinbase primary + CoinGecko fallback for crypto, Finnhub
for stocks) and USES IT as the execution price for the ledger row. The
client-submitted `price` is advisory only -- it drives a `display_drift_pct`
audit flag but never determines what the trade records.

The only hard rejection is `error: 'price_unverifiable'` (fail closed when
no vendor returns a price at all). There is no "deviation rejection" path --
a rejection loop on fast-moving markets was itself user harm for a paper-
trading app (per 2026-04-18 S54d pivot). The server always fills at its own
live price; the client never controls the ledger value.

This makes the phantom-price class of bug impossible: the server physically
cannot record a trade against a mock value because it never reads the
client's price as truth.

**Historical note:** 2026-04-18 to 2026-04-18 evening, this endpoint held
a hard 503 kill switch for all crypto POSTs (`error: 'crypto_trading_paused'`)
while the unified price service was under construction. The kill switch was
removed once Coinbase primary + CoinGecko fallback + server-side verification
shipped together (S54b). Deviation-rejection was tried briefly (S54c) and
replaced with the server-authoritative model (S54d) the same night.

### I4. No seed prices exist in code

`MOCK_CRYPTO` is a symbol directory only. Its price field is always `null`
and its `stale` flag is always `true`. Adding a non-null `price` to
`MOCK_CRYPTO` is a violation. Stock seeds (`MOCK_STOCKS`) are allowed to
carry last-known prices because US stock markets close and the prev-close
price is a real, honest number; crypto markets are 24/7, so there is no
equivalent "honest seed" -- any non-null seed price is by definition wrong.

### I5. Every live price carries a source and a timestamp

Responses from `/api/price` carry `source` (finnhub | coinbase | coingecko)
and `fetched_at` (ms since epoch) on every entry. Consumers use `fetched_at`
to compute staleness (`> 90s old` == stale for crypto, `> last tick` for
stocks).

### I7. Multiple vendors per asset class, primary + fallback

No asset class may depend on a single upstream vendor. For crypto, Coinbase
Exchange public stats is primary (fast, no key, reliable) and CoinGecko is
fallback. For stocks, Finnhub is primary; a fallback is tracked for
follow-up. A single-vendor outage may not silently kill a feed. The
per-symbol result still carries `source` so consumers can see which vendor
served this tick.

### I8. Limit fills execute at the trigger price, not the live price

**This is a deliberate exception to I3, admin-only and paper-only.**

`/api/crypto/fill-order` (the crypto bot's fill engine) writes trade rows at
the order's preset `trigger_price` -- NOT at the server's live price. The
endpoint:

1. Fetches a live price via the same multi-source chain (Coinbase -> CoinGecko).
2. Confirms the market crossed the trigger:
   -   SELL order: live >= trigger.
   -   BUY order: live <= trigger.
3. If crossed, validates target user's cash (BUY) or holdings (SELL). On
    insufficient, expires the order with a reason code, never writes a trade.
4. If funded, writes the trade at `trigger_price` with `source: 'crypto_bot_limit'`.
5. Never fills if no live price is available (fail-closed).

**Why this carve-out exists:** the bot's purpose is measurable prediction
accuracy. Every filled limit represents a call the admin made ("SELL BTC at
$100k"). Writing the fill at the live price instead of the trigger would
smear that signal with whatever tick happened to cross the threshold,
making outcome scoring noisy. Limit orders, by definition, say "execute at
THIS preset price when the market crosses it," and the ledger should honor
that.

**Why it's safe:**
-   Live price verification still applies. No fill ever happens without a
    real server-side fetch confirming the market crossed.
-   The endpoint is admin-only (auth via `X-Admin-Code` header or the Vercel
    Cron shared secret). No family user surface can call it.
-   Trades land with `source='crypto_bot_limit'` so the ledger is filterable
    and audit-trail is clear.
-   Only five assets allowed (BTC, ETH, ADA, SOL, XRP) via CHECK constraint
    on `stockrocket_crypto_orders`. No new-symbol attack surface.

**The invariant that limits this carve-out:** market orders from any other
surface (Trade page, Crypto page, direct POST to `/api/trades`) still follow
I3. Only the crypto bot's fill engine uses preset-price execution, and only
for pre-authorized limit orders that passed admin validation at creation
time.

### I6. Validation happens at the edge of every boundary

-   Vendor -> proxy (`/api/price`, `/api/finnhub`): validate upstream
    response, reject if invalid.
-   Proxy -> client: uniform response shape; no silent failures.
-   Client -> vendor fetcher: guard for malformed vendor payloads.
-   Client consumer hook: guard against partial batches + deviation.
-   Client UI -> trade submission: guard against stale / null prices.
-   Trade submission -> server: server re-validates price > 0.

Six layers. Removing any one of them re-opens the bug.

## Defences (currently in place)

### Deviation guard (crypto, client-side)

A crypto price tick that moves >30% from the last-known-good price for that
symbol is rejected for that tick and the symbol is marked stale. Three
consecutive deviant ticks for the same symbol are accepted as a real move
(flash crash, listing halt, etc.). Tunable via `CRYPTO_DEVIATION` and
`CRYPTO_DEVIATION_ACCEPT_AFTER` in `index.html`.

Rationale: A $97,245 BTC tick against a $75,000 last-known price is +30%,
right at the threshold. The current `0.30` setting is intentionally loose
because BTC volatility is real; lower it as we gather more data.

### Staleness check (crypto, client-side)

If `cryptoLastUpdated` is more than 90s old, crypto is derived-stale even if
the last fetch succeeded. This catches the case where the poll loop has
stalled. Tunable via `CRYPTO_STALE_MS`.

### Circuit breaker (crypto, client-side)

Three consecutive fetch failures open the breaker for 5 minutes. During that
window we do not call CoinGecko; all crypto entries remain `stale: true`.
This prevents the app from hammering a broken feed and keeps the UI honest.
Tunable via `CRYPTO_FAILURE_TRIP` and `CRYPTO_BREAKER_OPEN_MS`.

### Server-side price verification (stock + crypto, server-side)

`/api/trades` fetches a live price server-side before writing any trade
and rejects if the client price deviates more than 3% (stocks) or 5%
(crypto). Fail-closed if no live price is available. This replaces the
2026-04-18 crypto kill switch and applies equally to stocks and crypto --
so a phantom-price bug in the stock path cannot ship either.

## Not-yet-implemented defences

### Daily reconciliation job

A scheduled task that walks `stockrocket_trades` each night, pulls historical
candles from Finnhub/CoinGecko for each `(symbol, executed_at)` pair, and
flags any trade whose `price` deviates from the historical high-low range by
more than 10%. Flagged trades land in `stockrocket_trade_corrections` for
manual review. Task #77.

### Stock path migration to /api/price (client-side read)

Server-side trade verification for stocks already uses the unified multi-
source chain in `/api/trades` (Finnhub primary). Client-side read path for
stocks still flows through `/api/finnhub` for historical reasons -- the
validation is equivalent, but two read paths is one too many. Move stocks
to `/api/price` on the client in a follow-up.

### Stock fallback vendor

Finnhub is currently the only vendor for stock prices. If Finnhub goes
down, server-side verification fails closed (no trades) -- correct but
blocking. Add a secondary provider (Tiingo, Polygon, or Alpha Vantage
free tier) so a single vendor outage does not halt trading.

### Automated invariant tests

Unit tests against real failure modes: CoinGecko returning 500, CoinGecko
returning `{bitcoin: {usd: 0}}`, CoinGecko returning stale data, Finnhub
returning `{c: 0}`, network timeout, malformed JSON. Every fetcher must pass
all scenarios without returning a price. Task #78.

## How to change these rules

Every invariant in this file is load-bearing. Changes require:

1. A linked incident that motivates the change, OR a design review on the
   architecture channel.
2. A corresponding code change that updates enforcement at every layer.
3. An update to this doc noting what changed and why.
4. Notification to RSJ.

Silently relaxing an invariant ("just this once") is how we got the
2026-04-18 incident in the first place.
