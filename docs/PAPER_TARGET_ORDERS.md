# Paper stock target sells

The served application is `index.html`. `js/app.jsx` is a historical, unserved snapshot.
Trade > Sell > Target sell creates a stock-only pending order, owned by the authenticated access code. Choose a stock holding, quantity and minimum sale price. Limit buys and crypto limits are disabled on this user surface; the separate admin crypto bot remains separate.

`POST /api/orders` requires `{symbol, shares, target_price, request_id}` with a UUID idempotency key. The browser persists an unconfirmed key across refresh and reuses it for retries. A successful response (or reconciliation in history) confirms and clears the draft. Server-side same-key/different-payload attempts fail. `GET /api/orders` returns all pending and the last 100 terminal orders; `DELETE /api/orders?id=...` cancels only the authenticated owner's pending order.

Saving commits the order before looking up a quote. Only a Finnhub positive finite `c` with provider `t` no older than 60 seconds and no more than 5 seconds in the future can fill. The locked database transaction rechecks freshness against its own clock. The fill uses the live quote rounded to four decimal places, never the client target as an execution price. Quantities support eight decimals; target prices four. Below-target, missing, stale, invalid or failed quotes leave the order pending. Closed-market timestamps ordinarily remain pending. No expiry; the user can cancel. No stock share reservation: competing orders or market sells may consume shares first; an otherwise executable order then becomes rejected, with no sale.

The scheduler `GET /api/process-stock-orders` requires `Authorization: Bearer <CRON_SECRET>`. Vercel configuration requests once per minute, independent of the user's browser. The database durably rotates up to 100 oldest-checked orders per invocation in five-order claims, within a 20-second invocation budget. Database and quote fetches have five-second timeouts; up to five quote starts are paced per 250ms. This per-invocation pacing does not enforce a shared vendor quota. Large queues take multiple ticks. Delays/timeouts do not create duplicate fills; observability should alert on invocation failure or pending queue age. Paper execution is sampled quotes, not a guarantee of capturing every intraminute market crossing.

## Atomicity and existing machinery

The existing crypto CRUD/fill engine was admin-only and crypto-only; it used separate trade/portfolio/order writes. It is not suitable as a user stock engine. A separate stock-order table keeps those contracts distinct while sharing `stockrocket_execute_trade` for monetary writes. Market trades and crypto bot fills now also lock the same portfolio row and commit ledger, holdings, cash and order state in one database transaction. Cancellation locks its order; terminal orders cannot fill again. A trade's rounded total is exactly the cash change. Crypto execution retains its existing trigger-price policy and `crypto_bot_limit` source. Stock fills use `stock_target_sell` source.

## Local tests

Node 24+; no runtime npm packages are required. `npm test` executes isolated request-handler/quote tests with all fetches intercepted and no real database or vendor credentials. PostgreSQL integration tests should apply the migration to a disposable database with the checked-in `migrations/002_trades_and_portfolios.sql`, fixture access-code table and Supabase-style roles. They must not use any production project URL. Run `python3 tests/transactions.py` with `psql` on PATH, `PGHOST` set to a Unix socket under `/tmp` or `/private/tmp`, and `PGDATABASE` set to a disposable `stockrocket_*_test` or `stockrocket_*_review` database. This test writes synthetic fixture rows and a temporary failure-injection trigger only in that isolated database. It exercises 12 concurrent fills, a cancellation/fill race, rollback after a ledger insert, quote expiry while waiting for a portfolio lock, and portfolio/ledger reconciliation. Do not run against a shared developer database.

## Review and deployment prerequisites

No migration or deployment has been applied to a remote project. Before rollout:

1. Review `supabase/migrations/20260913155146_paper_stock_target_orders.sql`, take the normal schema/data backup, and preflight actual existing tables, policies, grants and legacy crypto schema. The old repository omitted crypto DDL; that RPC expects the same `id,user_code,symbol,qty,side,name,trigger_price,status,expire_at,expired_reason,filled_at,filled_price,fill_trade_id` fields the existing endpoints used.
2. Apply the migration and deploy every changed writer together in a maintenance window. An old deployed writer can still overwrite a new atomic writer's portfolio state; do not run mixed versions. Existing ledger inconsistencies are not repaired automatically.
3. The migration enables RLS and revokes anonymous/authenticated direct access on portfolios/trades. Current access-code APIs use service_role; verify no out-of-repository client depends on the old permissive tables. RPCs are invoker functions, granted only to service_role, with a fixed search path.
4. Configure server-only `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `FINNHUB_KEY`, `CRON_SECRET`. Never put service keys in browser configuration or chat. Confirm Finnhub timestamps/coverage and quotas fit the selected trading scope.
5. Verify the hosting plan supports a minute cron and its execution duration; configure the equivalent trusted server scheduler if not. Verify real invocation logs and freshness behavior in staging before production approval.

There is no deployment in this change. Production data and all other projects are untouched.
