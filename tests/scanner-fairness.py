"""Durable small-claim rotation against an explicitly isolated test DB."""
from transactions import q
import uuid,json
u='rotation-'+uuid.uuid4().hex
# Only the local fixture database is touched; prioritize this synthetic queue.
q("update stockrocket_stock_orders set last_checked_at=clock_timestamp() where status='pending';")
q(f"insert into stockrocket_stock_orders(user_code,request_id,symbol,qty,target_price) select '{u}',gen_random_uuid(),'AAPL',1,9999 from generate_series(1,201);")
seen=set()
for _ in range(41):
 rows=json.loads(q("select coalesce(json_agg(q),'[]') from stockrocket_scan_stock_orders() q;"))
 assert len(rows)<=5
 own=[row['id'] for row in rows if row['user_code']==u]
 assert not seen.intersection(own), 'An interrupted invocation must not restart from the same early orders'
 seen.update(own)
assert len(seen)==201
print('PASS: five-order claims durably rotate through all 201 queued orders across invocations')
