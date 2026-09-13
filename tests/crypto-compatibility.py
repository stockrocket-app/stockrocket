"""Legacy crypto RPC compatibility in the same explicitly disposable local database.
Importing transactions also runs the common stock/concurrency/rollback suite.
The fixture models the verified crypto columns/constraints used by this RPC.
"""
from transactions import q
import uuid, concurrent.futures
q("""
create extension if not exists moddatetime;
create table if not exists stockrocket_crypto_orders (
 id uuid primary key default gen_random_uuid(), user_code text not null,
 symbol text not null,name text,side text not null check(side in ('BUY','SELL')),
 trigger_price numeric not null,qty numeric not null,thesis text not null,
 source text not null check(length(trim(source))>0),
 status text not null default 'pending' check(status in ('pending','filled','cancelled','expired')),
 expire_at timestamptz not null,expired_reason text,filled_at timestamptz,filled_price numeric,
 fill_trade_id uuid references stockrocket_trades(id) on delete set null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
drop trigger if exists fixture_crypto_touch on stockrocket_crypto_orders;
create trigger fixture_crypto_touch before update on stockrocket_crypto_orders
 for each row execute function moddatetime(updated_at);
""")
u='crypto-review-'+uuid.uuid4().hex
q(f"insert into stockrocket_access_codes(code,active) values('{u}',true);insert into stockrocket_portfolios(user_code,holdings) values('{u}','{{}}');")
def create(side='BUY',qty=1,expiry="clock_timestamp()+interval '1 day'",status='pending'):
 return q(f"insert into stockrocket_crypto_orders(user_code,symbol,name,side,trigger_price,qty,thesis,source,expire_at,status) values('{u}','BTC','Bitcoin','{side}',100,{qty},'isolated fixture','fixture',{expiry},'{status}') returning id;").splitlines()[0]
def fill(oid,price):
 return f"select stockrocket_execute_trade('{u}','BUY','BTC','Bitcoin','crypto',1,{price},null,null,null,'{oid}')->>'action';"
buy=create()
assert q(fill(buy,101))=='wait'
assert q(fill(buy,99))=='filled'
assert q(f"select cash=99900 and (holdings->'BTC'->>'shares')::numeric=1 from stockrocket_portfolios where user_code='{u}';")=='t'
assert q(f"select price=100 and source='crypto_bot_limit' and asset_type='crypto' from stockrocket_trades where user_code='{u}';")=='t'
assert q(f"select filled_price=100 and fill_trade_id is not null and updated_at>=created_at from stockrocket_crypto_orders where id='{buy}';")=='t'
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
 assert set(ex.map(q,[fill(buy,99)]*12))=={'filled'}
assert q(f"select count(*) from stockrocket_trades where user_code='{u}';")=='1'
sell=create('SELL',.5)
assert q(fill(sell,99))=='wait';assert q(fill(sell,110))=='filled'
assert q(f"select cash=99950 and (holdings->'BTC'->>'shares')::numeric=.5 from stockrocket_portfolios where user_code='{u}';")=='t'
insufficient=create('SELL',2)
assert q(fill(insufficient,110))=='expired'
expired=create(expiry="clock_timestamp()-interval '1 second'")
assert q(fill(expired,99))=='expired'
cancelled=create(status='cancelled')
assert q(fill(cancelled,99))=='cancelled'
assert q(f"select count(*)=2 and sum(case when trade_type='SELL' then total else -total end)=-50 from stockrocket_trades where user_code='{u}';")=='t'
print('PASS: legacy crypto BUY/SELL trigger pricing, source, touch trigger, fill FK, 12 retries, expiry, cancellation, insufficient holdings and cash/ledger reconciliation')
