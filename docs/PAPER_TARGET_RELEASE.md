# Paper target sells — draft release package

Status: user greenlit the coordinated paper-trading release on 2026-09-13. The steps below remain subject to verification; execution evidence is recorded separately. Paper trading only. See [behavior and architecture](PAPER_TARGET_ORDERS.md).

## Evidence (2026-09-13)

- Node 24.21.0 / npm 11.19.0; dependency-free Node suite: 26/26 passing, independently rerun.
- PostgreSQL 17.11 disposable Unix-socket fixtures: concurrent fills (12 contenders, one sale), cancellation races, injected transaction rollback, stale quote after lock wait, holdings/cash/ledger reconciliation, durable queue rotation and service-only RPC access passed. Independent reviewer reran checked-in `tests/crypto-compatibility.py`, which also runs `tests/transactions.py`.
- Crypto compatibility: BUY/SELL trigger-price policy, source attribution, fill-trade FK, update trigger, 12 retries, cancellation, expiry and insufficient holdings passed.
- Old cached clients without a trade UUID receive `409 client_update_required` before quote lookup or any trade write. Current UI trade helper supplies UUIDs. Reload is required for old clients.
- Local fixture preview exercised pending, fill, cancellation and refresh reconciliation using actual UI/API code and isolated PostgreSQL. It uses synthetic quotes and credentials; this is not hosted scheduler or market-data validation.

## Actual target schema: read-only preflight

Inspected App Lab's hosted PostgreSQL 17.6 catalog through read-only transactions, not account/portfolio row contents. The signed-in StockRocket Vercel project was also verified to point to App Lab, comparing the configuration URL privately without printing it.

Compatible catalog findings:

- `stockrocket_portfolios`: user_code text PK; cash/starting_cash numeric(20,4); holdings jsonb; timestamps. Expected touch trigger exists.
- `stockrocket_trades`: UUID PK; expected trade/asset checks, shares numeric(20,8), money numeric(20,4). Nullable text `source` already exists, with no source-value constraint. `request_id` does not yet exist.
- `stockrocket_crypto_orders`: all RPC-referenced fields exist, including numeric(18,8) qty/trigger/fill price, expiry, terminal fields and fill_trade_id FK (ON DELETE SET NULL); status/side/type/symbol checks and moddatetime update trigger are compatible. Local fixtures cover relevant behavior, not every hosted numeric boundary.
- Access-code PK/active/admin fields exist. All four existing tables have RLS enabled and service_role-only ALL policies. service_role has BYPASSRLS and schema USAGE. Broad anon/authenticated grants currently exist but do not bypass these RLS policies; the migration revokes portfolio/trade grants.
- New stock-order table, four new RPC names and new indexes are absent; no detected naming collisions.

This verifies structural compatibility, not historical data quality, host-to-project binding, unknown clients or a migration rehearsal against a full production copy. No migration was applied remotely. Repeat catalog preflight at the approved window and abort on drift.

## Configuration and operational blockers

Server-only variables required by current code: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `FINNHUB_KEY`, `CRON_SECRET`. Local app credentials are absent intentionally. Read-only Vercel inspection confirms FINNHUB_KEY and SUPABASE_SERVICE_KEY exist for Production and Preview; SUPABASE_URL exists for All Environments and matches App Lab. **CRON_SECRET was securely generated and saved for Production after release authorization**; no shared variables are linked. Secret validity was not tested against production trading endpoints. The new secret takes effect on the next deployment. Trusted bot callers using bearer authentication need the same private configuration. Never export values to logs, PRs or chat.

The checked-in cron requests `/api/process-stock-orders` every minute and supplies bearer authentication via Vercel's CRON_SECRET convention. [Native cron runs on production deployments](https://vercel.com/docs/cron-jobs), so preview fixtures do not prove native scheduling. [Hobby supports only daily schedules; Pro supports minute schedules](https://vercel.com/docs/cron-jobs/usage-and-pricing). The actual RSJ_Frame team is Pro and Cron Jobs is enabled. Existing refresh-quotes (minute during weekday UTC13–21) and resolve-predictions (daily22UTC) jobs are registered. The new process-stock-orders job is not yet registered, as expected before deployment. The existing refresh-quotes live log filter had no records during this Sunday inspection; this is not proof of successful execution. New scheduler registration, authenticated invocation and runtime logs still require staged/approved rollout verification.

**Duration fix verified locally:** the worker now has a 20-second whole-invocation abort budget, including database requests, with five-second per-fetch limits. It durably claims five orders at a time, up to 100 per invocation; deferred work retains retry safety. Tests verify deadline handling, stalled database cancellation, no late fill start, small-queue behavior and pacing. This leaves margin under the [Edge 25-second response-start requirement](https://vercel.com/docs/functions/runtimes/edge); real hosted latency and scheduler logs remain rollout checks. Unknown/aborted transport failures return a sanitized 503 so uncertain order creation keeps its retry UUID rather than duplicating an order.

**Shared quote budget:** all seven in-repository Finnhub consumers now obtain a serialized database permit before each request. Rolling admission limits are 50 per 65 seconds and 20 per six seconds, with at most five seconds from requesting a permit to starting vendor HTTP. This conservatively bounds changed-code traffic below 50/minute and 20/second. Denial, database failure or vendor429 cannot trigger a sale; the order stays pending. Independent tests cover concurrent permits and failure behavior. Existing external apps or old deployments using the same key remain outside this app-scoped limiter; their traffic can reduce quote availability. A dedicated key is preferable but is not required for transaction correctness. Never rotate a shared key without considering other consumers. Monitor pending age and vendor throttling. The account tier remains unverified; no guarantee of every intraminute price crossing is made. Finnhub's [official limit](https://finnhub.io/docs/api/rate-limit) includes a 30-calls/second ceiling.

**Legacy-writer fence:** the migration revokes direct service-role monetary DML. A NOLOGIN, NOINHERIT, NOBYPASSRLS role owns the two privileged creation/execution RPCs, with narrowly scoped grants and RLS policies. Triggers reject non-RPC monetary writes; only pristine portfolio creation remains allowed. Old immutable deployments can no longer overwrite portfolios or insert partial ledger rows. The remaining RPCs retain invoker security. Unknown SQL-admin writers remain an operator responsibility; no application credential inherits the writer role. Independent rehearsal used a non-superuser CREATEROLE operator matching hosted privileges.

Vercel automatic deployment is disabled in `vercel.json` for this review branch only, using [deploymentEnabled](https://vercel.com/docs/project-configuration/git-configuration). Main retains its existing behavior: merge only after the atomic database cutover succeeds. No repository GitHub Actions workflows were found. Hosting integrations and external bots still require owner inventory.

## Authorized coordinated rollout

1. Confirm Vercel project/database binding and the four server variable names/scopes without showing values. Verify plan, scheduler authentication and logs. Verify the shared quote limiter and bounded worker tests. Use isolated paper fixtures in staging; invoke a trusted scheduler explicitly if native cron is unavailable there.
2. Inventory supported writers and external bots. The reviewed cutover acquires ACCESS EXCLUSIVE locks on portfolios, trades and crypto orders, draining older writes before it snapshots and installs the fence in the same transaction. A 15-second lock timeout aborts rather than hanging. After commit all old application monetary writes fail closed until the matching artifact is deployed, including through immutable URLs. A private operator prefix captures affected rows, columns, ACLs, RLS, triggers and functions under an unexposed schema with revoked application access. This is point-in-time recovery evidence, not a whole-project disaster backup.
3. Record release and previous deployment SHAs, migration checksum and backups in the private operator record. Verify the private cutover snapshot. Repeat catalog compatibility and check external direct-table clients. Do not publish backups or connection strings.
4. Within the reviewed lock/snapshot transaction, apply **only** `supabase/migrations/20260913155146_paper_stock_target_orders.sql` using the approved migration path, fail-on-error and one transaction. Example for an operator's securely configured psql connection: `psql -X -v ON_ERROR_STOP=1 --single-transaction -f supabase/migrations/20260913155146_paper_stock_target_orders.sql`. Do not blindly push unrelated historical migrations. Verify table/index/RPC signatures and service-only privileges before proceeding.
5. Deploy one coordinated artifact containing `api/trades.js`, `api/orders.js`, `api/process-stock-orders.js`, `api/crypto/fill-order.js`, `api/crypto/orders.js`, `lib/stock-orders.js`, `index.html` and `vercel.json`. Existing crypto fills must use the same atomic writer as stock/market trades. Keep earlier deployments and outside writers blocked. Never mix old read-modify-write portfolio code with the atomic writer.
6. With maintenance still enforced, use a separately approved synthetic paper account to verify pending/refresh/cancel/fill/retry and ledger balances, scheduler authentication and logs. The user authorized this synthetic paper-account verification with the release greenlight. Check old-client rejection and instruct users to reload. Abort on any mismatch.
7. Enable the verified scheduler and compatible traffic together, then monitor invocation failures, quota errors, pending age, rejects and balance/ledger consistency. Remove maintenance only once the artifact and database are verified. No real-money brokerage integration is part of this release.

## Rollback

Prefer a forward fix. If verification fails, keep all trade writers, schedulers and external bots blocked and drain requests before changing the deployment. Preserve the stock-order table, terminal states, request IDs and ledger; do not delete orders, reverse completed fills automatically, weaken privileges or drop the migration to make old code work.

A blind Vercel rollback is unsafe: the old writers can overwrite atomically updated portfolios. Reverting UI/read routes is possible only while every writer stays blocked. Re-enable trading only with a reviewed artifact compatible with the retained schema and shared transaction writer. Any data repair requires separate review and approval based on reconciled records, never reset/replay. Keep a private incident record and evidence of the halted scheduler.

## Residual operational limits

The exact Finnhub account allowance and unrelated consumers remain unverified; fail-closed quota handling preserves correctness when quotes are unavailable. Sunday rollout cannot prove an open-market fresh provider crossing. Check the first active-market scheduler run and pending age. Do not infer a real-money brokerage capability from this paper-only release.
