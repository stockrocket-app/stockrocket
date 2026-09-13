-- Apply only after review. All monetary mutations share a portfolio row lock.
create table public.stockrocket_stock_orders (
 id uuid primary key default gen_random_uuid(), user_code text not null,
 request_id uuid not null, symbol text not null, qty numeric(20,8) not null check(qty>0),
 target_price numeric(20,4) not null check(target_price>0),
 status text not null default 'pending' check(status in ('pending','filled','cancelled','rejected')),
 reason text, last_checked_at timestamptz not null default '-infinity', created_at timestamptz not null default now(), filled_at timestamptz,
 filled_price numeric(20,4), quote_at timestamptz,
 fill_trade_id uuid unique references public.stockrocket_trades(id),
 unique(user_code,request_id)
);
create index stockrocket_stock_orders_pending on public.stockrocket_stock_orders(created_at,id) where status='pending';
alter table public.stockrocket_stock_orders enable row level security;
revoke all on public.stockrocket_stock_orders from public,anon,authenticated;
grant all on public.stockrocket_stock_orders to service_role;
-- Legacy tables must not be writable through anonymous Data API clients.
alter table public.stockrocket_portfolios enable row level security;
alter table public.stockrocket_trades enable row level security;
revoke all on public.stockrocket_portfolios, public.stockrocket_trades from anon,authenticated;
grant all on public.stockrocket_portfolios,public.stockrocket_trades to service_role;
alter table public.stockrocket_trades add column if not exists request_id uuid;
alter table public.stockrocket_trades add column if not exists source text;
create unique index stockrocket_trade_request on public.stockrocket_trades(user_code,request_id) where request_id is not null;

create function public.stockrocket_create_stock_order(p_user text,p_request uuid,p_symbol text,p_qty numeric,p_target numeric)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare p stockrocket_portfolios; o stockrocket_stock_orders;
begin
 if p_request is null or p_symbol !~ '^[A-Z][A-Z0-9.-]{0,14}$' or p_qty is null or p_qty<=0 or p_qty<>round(p_qty,8) or p_target is null or p_target<=0 or p_target<>round(p_target,4) or p_qty::text in ('NaN','Infinity') or p_target::text in ('NaN','Infinity') then raise exception 'invalid_order'; end if;
 select * into p from stockrocket_portfolios where user_code=p_user for update;
 select * into o from stockrocket_stock_orders where user_code=p_user and request_id=p_request;
 if found then
  if o.symbol<>p_symbol or o.qty<>p_qty or o.target_price<>p_target then raise exception 'idempotency_conflict'; end if;
  return to_jsonb(o);
 end if;
 if p.user_code is null or coalesce(p.holdings->p_symbol->>'assetType','stock')<>'stock' or coalesce((p.holdings->p_symbol->>'shares')::numeric,0)<p_qty then raise exception 'insufficient_shares'; end if;
 insert into stockrocket_stock_orders(user_code,request_id,symbol,qty,target_price) values(p_user,p_request,p_symbol,p_qty,p_target) returning * into o;
 return to_jsonb(o);
end $$;

create function public.stockrocket_cancel_stock_order(p_user text,p_id uuid)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare o stockrocket_stock_orders;
begin
 select * into o from stockrocket_stock_orders where id=p_id and user_code=p_user for update;
 if not found then raise exception 'order_not_found'; end if;
 if o.status='pending' then update stockrocket_stock_orders set status='cancelled' where id=o.id returning * into o; end if;
 return to_jsonb(o);
end $$;

-- p_order and p_crypto identify authoritative database orders, never browser prices.
-- All callers obtain prices server-side; only service_role can execute this RPC.
create function public.stockrocket_execute_trade(p_user text,p_type text,p_symbol text,p_name text,p_asset text,p_qty numeric,p_price numeric,p_request uuid default null,p_order uuid default null,p_quote_at timestamptz default null,p_crypto uuid default null)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare p stockrocket_portfolios; o stockrocket_stock_orders; c jsonb; t stockrocket_trades;
 h jsonb; old numeric; avg numeric; total numeric; remaining numeric;
begin
 insert into stockrocket_portfolios(user_code) values(p_user) on conflict do nothing;
 select * into p from stockrocket_portfolios where user_code=p_user for update;
 if p_order is not null then
  select * into o from stockrocket_stock_orders where id=p_order and user_code=p_user for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status<>'pending' then return jsonb_build_object('ok',true,'order',to_jsonb(o),'portfolio',to_jsonb(p)); end if;
  if not exists(select 1 from stockrocket_access_codes where code=p_user and active) then return jsonb_build_object('ok',true,'order',to_jsonb(o)); end if;
  if p_quote_at is null or p_quote_at<clock_timestamp()-interval '60 seconds' or p_quote_at>clock_timestamp()+interval '5 seconds' or p_price is null or p_price<=0 or p_price::text in ('NaN','Infinity') or p_price<o.target_price then return jsonb_build_object('ok',true,'order',to_jsonb(o),'portfolio',to_jsonb(p)); end if;
  p_symbol:=o.symbol; p_qty:=o.qty; p_type:='SELL'; p_asset:='stock'; p_name:=coalesce(p.holdings->p_symbol->>'name',p_symbol);
 end if;
 if p_crypto is not null then
  execute 'select to_jsonb(o) from stockrocket_crypto_orders o where id=$1 and user_code=$2 for update' into c using p_crypto,p_user;
  if c is null then raise exception 'order_not_found'; end if;
  if c->>'status'<>'pending' then return jsonb_build_object('ok',true,'action',c->>'status'); end if;
  if (c->>'expire_at')::timestamptz<=clock_timestamp() then
   execute 'update stockrocket_crypto_orders set status=''expired'',expired_reason=''ttl'' where id=$1' using p_crypto;
   return jsonb_build_object('ok',true,'action','expired');
  end if;
  p_symbol:=c->>'symbol'; p_qty:=(c->>'qty')::numeric; p_type:=c->>'side'; p_asset:='crypto'; p_name:=c->>'name';
  if p_price is null or p_price<=0 or p_price::text in ('NaN','Infinity') or (p_type='SELL' and p_price<(c->>'trigger_price')::numeric) or (p_type='BUY' and p_price>(c->>'trigger_price')::numeric) then return jsonb_build_object('ok',true,'action','wait'); end if;
  p_price:=(c->>'trigger_price')::numeric;
 end if;
 if p_type not in ('BUY','SELL') or p_asset not in ('stock','crypto') or p_qty is null or p_qty<=0 or p_qty<>round(p_qty,8) or p_price is null or p_price<=0 or p_qty::text in ('NaN','Infinity') or p_price::text in ('NaN','Infinity') then raise exception 'invalid_trade'; end if;
 if p_request is not null then
  select * into t from stockrocket_trades where user_code=p_user and request_id=p_request;
  if found then
   if t.trade_type<>p_type or t.symbol<>p_symbol or t.shares<>p_qty or t.asset_type<>p_asset then raise exception 'idempotency_conflict'; end if;
   return jsonb_build_object('ok',true,'trade',to_jsonb(t),'portfolio',to_jsonb(p));
  end if;
 end if;
 h:=p.holdings->p_symbol; old:=coalesce((h->>'shares')::numeric,0); avg:=coalesce((h->>'avgCost')::numeric,0);
 p_price:=round(p_price,4); total:=round(p_qty*p_price,4);
 if total<=0 then raise exception 'invalid_trade'; end if;
 if (h is not null and coalesce(h->>'assetType','stock')<>p_asset) or (p_type='SELL' and old<p_qty) or (p_type='BUY' and p.cash<total) then
  if p_order is not null then
   update stockrocket_stock_orders set status='rejected',reason='insufficient_shares' where id=o.id returning * into o;
   return jsonb_build_object('ok',true,'order',to_jsonb(o),'portfolio',to_jsonb(p));
  elsif p_crypto is not null then
   execute 'update stockrocket_crypto_orders set status=''expired'',expired_reason=''insufficient_holdings_or_cash'' where id=$1' using p_crypto;
   return jsonb_build_object('ok',true,'action','expired');
  end if;
  if p_type='SELL' then raise exception 'insufficient_shares'; else raise exception 'insufficient_cash'; end if;
 end if;
 if p_type='SELL' then
  p.cash:=p.cash+total; remaining:=old-p_qty;
  if remaining=0 then p.holdings:=p.holdings-p_symbol; else p.holdings:=jsonb_set(p.holdings,array[p_symbol,'shares'],to_jsonb(remaining)); end if;
 else
  p.cash:=p.cash-total;
  p.holdings:=jsonb_set(p.holdings,array[p_symbol],jsonb_build_object('symbol',p_symbol,'name',coalesce(p_name,p_symbol),'assetType',p_asset,'shares',old+p_qty,'avgCost',(old*avg+total)/(old+p_qty)));
 end if;
 insert into stockrocket_trades(user_code,trade_type,asset_type,symbol,name,shares,price,total,cash_after,request_id,source)
 values(p_user,p_type,p_asset,p_symbol,p_name,p_qty,p_price,total,p.cash,p_request,case when p_crypto is not null then 'crypto_bot_limit' when p_order is not null then 'stock_target_sell' else 'market' end) returning * into t;
 update stockrocket_portfolios set cash=p.cash,holdings=p.holdings where user_code=p_user returning * into p;
 if p_order is not null then
  update stockrocket_stock_orders set status='filled',filled_at=t.executed_at,filled_price=t.price,quote_at=p_quote_at,fill_trade_id=t.id where id=o.id returning * into o;
 end if;
 if p_crypto is not null then execute 'update stockrocket_crypto_orders set status=''filled'',filled_at=$2,filled_price=$3,fill_trade_id=$4 where id=$1' using p_crypto,t.executed_at,t.price,t.id; end if;
 return jsonb_build_object('ok',true,'trade',to_jsonb(t),'portfolio',to_jsonb(p),'order',case when p_order is not null then to_jsonb(o) else null end,'action','filled','execution',jsonb_build_object('executed_price',t.price,'avg_cost_at_trade',avg,'realized_gain',case when p_type='SELL' then (t.price-avg)*p_qty else null end,'realized_gain_pct',case when p_type='SELL' and avg>0 then (t.price-avg)/avg*100 else null end,'new_avg_cost',case when p_type='BUY' then (p.holdings->p_symbol->>'avgCost')::numeric else null end));
end $$;
revoke all on function stockrocket_create_stock_order(text,uuid,text,numeric,numeric),stockrocket_cancel_stock_order(text,uuid),stockrocket_execute_trade(text,text,text,text,text,numeric,numeric,uuid,uuid,timestamptz,uuid) from public,anon,authenticated;
grant execute on function stockrocket_create_stock_order(text,uuid,text,numeric,numeric),stockrocket_cancel_stock_order(text,uuid),stockrocket_execute_trade(text,text,text,text,text,numeric,numeric,uuid,uuid,timestamptz,uuid) to service_role;

-- Durable rotation: a worker timeout or a long-lived pending order cannot starve later orders.
create function public.stockrocket_scan_stock_orders() returns setof public.stockrocket_stock_orders
language sql security invoker set search_path=public,pg_temp as $$
 with candidates as (select id from stockrocket_stock_orders where status='pending' order by last_checked_at,id limit 5 for update skip locked)
 update stockrocket_stock_orders o set last_checked_at=clock_timestamp() from candidates c where o.id=c.id returning o.*;
$$;
revoke all on function stockrocket_scan_stock_orders() from public,anon,authenticated;
grant execute on function stockrocket_scan_stock_orders() to service_role;
