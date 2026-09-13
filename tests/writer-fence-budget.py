"""Dedicated-role writer and durable quota races in explicitly isolated PostgreSQL."""
from transactions import q
import concurrent.futures,uuid
u='fence-'+uuid.uuid4().hex
q(f"insert into stockrocket_access_codes(code,active) values('{u}',true);")
assert q("select pg_has_role('service_role','stockrocket_trade_writer','MEMBER');")=='f'
assert q("select has_table_privilege('service_role','stockrocket_portfolios','UPDATE') or has_table_privilege('service_role','stockrocket_trades','INSERT');")=='f'
assert q(f"set role service_role;insert into stockrocket_portfolios(user_code) values('{u}');reset role;",False).returncode==0
assert q(f"set role service_role;insert into stockrocket_portfolios(user_code,cash) values('{u}-invalid',999999);",False).returncode!=0
assert q(f"set role service_role;insert into stockrocket_portfolios(user_code) values('{u}') on conflict(user_code) do update set cash=999999;",False).returncode!=0
buy=f"set role service_role;select stockrocket_execute_trade('{u}','BUY','AAPL','Apple','stock',1,100,'{uuid.uuid4()}')->>'ok';"
assert q(buy).splitlines()[-1]=='true'
legacy=f"set role service_role;update stockrocket_portfolios set cash=999999,holdings='{{}}' where user_code='{u}';"
sell=f"set role service_role;select stockrocket_execute_trade('{u}','SELL','AAPL','Apple','stock',1,125,'{uuid.uuid4()}')->>'ok';"
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
 bad=pool.submit(q,legacy,False);good=pool.submit(q,sell);assert bad.result().returncode!=0;assert good.result().splitlines()[-1]=='true'
assert q(f"select cash=100025 and holdings='{{}}'::jsonb from stockrocket_portfolios where user_code='{u}';")=='t'
assert q(f"set role service_role;insert into stockrocket_trades(user_code,trade_type,asset_type,symbol,shares,price,total,cash_after) values('{u}','SELL','stock','AAPL',1,125,125,999999);",False).returncode!=0
q("update stockrocket_vendor_budget set admissions='{}' where name='finnhub';")
permit="set role service_role;select stockrocket_take_finnhub_permit();"
with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:results=list(pool.map(q,[permit]*70))
assert sum(x.splitlines()[-1]=='t' for x in results)==20
# Preserve minute count while moving the burst outside the six-second window.
q("update stockrocket_vendor_budget set admissions=array_fill(clock_timestamp()-interval '10 seconds',array[49]) where name='finnhub';")
with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:results=list(pool.map(q,[permit]*20))
assert sum(x.splitlines()[-1]=='t' for x in results)==1
assert q("select cardinality(admissions) from stockrocket_vendor_budget where name='finnhub';")=='50'
print('PASS: pristine bootstrap, denied legacy INSERT/UPSERT/UPDATE, concurrent RPC vs legacy writer, shared concurrent20burst/50minute budget')
