"""Independent disposable-database review. Requires local PG socket, never production."""
import subprocess, concurrent.futures, time, uuid
import os, pathlib, shutil
host=os.environ.get('PGHOST','')
db=os.environ.get('PGDATABASE','')
assert host.startswith(('/tmp/','/private/tmp/')), 'PGHOST must be an isolated local Unix socket under /tmp'
assert db.startswith('stockrocket_') and db.endswith(('_test','_review')), 'Use a disposable stockrocket_*_test or stockrocket_*_review database'
PG=shutil.which('psql')
assert PG, 'Add PostgreSQL bin directory to PATH'
BASE=[PG,'-X','-h',host,'-d',db,'-At','-v','ON_ERROR_STOP=1','-c']
def q(sql,ok=True):
 r=subprocess.run(BASE+[sql],capture_output=True,text=True)
 if ok: assert r.returncode==0,r.stderr
 return r.stdout.strip() if ok else r
u='review-'+uuid.uuid4().hex
q(f"insert into stockrocket_access_codes(code,active) values('{u}',true);set role stockrocket_trade_writer;insert into stockrocket_portfolios(user_code,holdings) values('{u}','{{\"AAPL\":{{\"shares\":10,\"avgCost\":100,\"assetType\":\"stock\"}}}}');reset role;")
def create(n=2):
 key=str(uuid.uuid4());oid=q(f"select stockrocket_create_stock_order('{u}','{key}','AAPL',{n},120)->>'id';");return oid,key
def fill(oid,age=0): return f"select stockrocket_execute_trade('{u}','SELL','AAPL','Apple','stock',2,125,null,'{oid}',clock_timestamp()-interval '{age} seconds')->'order'->>'status';"
def count():return q(f"select count(*) from stockrocket_trades where user_code='{u}';")
o,k=create()
assert q(fill(o,61))=='pending';assert count()=='0'
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex: assert set(ex.map(q,[fill(o)]*12))=={'filled'}
assert count()=='1'
assert q(f"select cash=100250 and (holdings->'AAPL'->>'shares')::numeric=8 from stockrocket_portfolios where user_code='{u}';")=='t'
o,k=create()
cancel=f"select stockrocket_cancel_stock_order('{u}','{o}')->>'status';"
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex: results=list(ex.map(q,[cancel,fill(o)]*6))
assert len(set(results))==1
assert count()==('1' if results[0]=='cancelled' else '2')
o,k=create();before=count()
q("create or replace function fixture_fail() returns trigger language plpgsql as $$ begin raise exception 'injected_portfolio_failure'; end $$;create trigger fixture_fail before update on stockrocket_portfolios for each row execute function fixture_fail();")
try:
 assert q(fill(o),False).returncode!=0
 assert count()==before
 assert q(f"select status from stockrocket_stock_orders where id='{o}';")=='pending'
finally:q('drop trigger fixture_fail on stockrocket_portfolios;drop function fixture_fail();')
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
 lock=ex.submit(q,f"begin;select user_code from stockrocket_portfolios where user_code='{u}' for update;select pg_sleep(4);commit;")
 time.sleep(.5);result=ex.submit(q,fill(o,58));lock.result();assert result.result()=='pending'
assert count()==before
print('PASS: concurrent fill, cancel race, ledger reconciliation, rollback after ledger insert, quote aging while waiting on lock')
