import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/orders.js';
import trades from '../api/trades.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import processor from '../api/process-stock-orders.js';
import {freshQuote} from '../lib/stock-orders.js';
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const order={id,user_code:'FIXTURE',symbol:'AAPL',qty:2,target_price:160,status:'pending',request_id:id};
function setup(quote={c:150,t:Date.now()/1000}) {
 process.env.SUPABASE_URL='http://fixture.invalid';process.env.SUPABASE_SERVICE_KEY='fixture-only';process.env.FINNHUB_KEY='fixture-only';process.env.CRON_SECRET='fixture-only';
 const calls=[];
 globalThis.fetch=async(url,options={})=>{
  const u=new URL(url);calls.push({path:u.pathname,body:options.body?JSON.parse(options.body):null});
  if(u.hostname==='finnhub.io')return Response.json(quote);
  assert.equal(u.hostname,'fixture.invalid','test must not access a real database');
  if(u.pathname.endsWith('stockrocket_access_codes'))return Response.json([{code:'FIXTURE',active:true}]);
  if(u.pathname.endsWith('stockrocket_create_stock_order'))return Response.json(order);
  if(u.pathname.endsWith('stockrocket_execute_trade'))return Response.json({ok:true,order:{...order,status:quote.c>=160?'filled':'pending'}});
  if(u.pathname.endsWith('stockrocket_cancel_stock_order'))return Response.json({...order,status:'cancelled'});
  if(u.pathname.endsWith('stockrocket_scan_stock_orders'))return Response.json([order]);
  if(u.pathname.endsWith('stockrocket_stock_orders'))return Response.json([order]);
  throw Error('Unexpected fixture request');
 };return calls;
}
function create(body={symbol:'AAPL',shares:2,target_price:160,request_id:id}) {return new Request('http://local/api/orders',{method:'POST',headers:{'X-User-Code':'FIXTURE','Content-Type':'application/json'},body:JSON.stringify(body)});}
test('freshness rejects nonfinite, stale, future, missing and nonpositive quotes',()=>{
 const now=Date.now();assert(freshQuote(10,now,now));assert(freshQuote(10,now-60000,now));
 for(const [p,t]of [[NaN,now],[Infinity,now],[0,now],[10,now-60001],[10,now+5001],[10,NaN]])assert.equal(freshQuote(p,t,now),false);
});
test('saving routes to persistent order RPC; never immediate market endpoint',async()=>{
 const calls=setup();const res=await handler(create());assert.equal(res.status,200);assert.equal((await res.json()).order.status,'pending');
 assert(calls.some(c=>c.path.endsWith('stockrocket_create_stock_order')));assert(!calls.some(c=>c.path==='/api/trades'));
 assert.equal(calls.find(c=>c.path.endsWith('stockrocket_create_stock_order')).body.p_request,id);
});
test('fresh satisfying quote can fill after order is persisted',async()=>{
 const calls=setup({c:165,t:Date.now()/1000});const result=await (await handler(create())).json();assert.equal(result.order.status,'filled');
 assert(calls.findIndex(c=>c.path.endsWith('stockrocket_create_stock_order'))<calls.findIndex(c=>c.path.endsWith('stockrocket_execute_trade')));
});
test('stale quote persists pending and never requests fill',async()=>{
 const calls=setup({c:999,t:Date.now()/1000-61});assert.equal((await(await handler(create())).json()).order.status,'pending');assert(!calls.some(c=>c.path.endsWith('stockrocket_execute_trade')));
});
test('invalid quantity or missing request id fails before creation',async()=>{
 const calls=setup();assert.equal((await handler(create({symbol:'AAPL',shares:0,target_price:160,request_id:id}))).status,400);assert.equal((await handler(create({symbol:'AAPL',shares:2,target_price:160}))).status,400);assert(!calls.some(c=>c.path.endsWith('stockrocket_create_stock_order')));
});
test('cancellation passes authenticated owner to transactional RPC',async()=>{
 const calls=setup();assert.equal((await handler(new Request(`http://local/api/orders?id=${id}`,{method:'DELETE',headers:{'X-User-Code':'FIXTURE'}}))).status,200);assert.deepEqual(calls.at(-1).body,{p_user:'FIXTURE',p_id:id});
});
test('scheduler rejects unauthenticated calls and supports cron GET',async()=>{
 const calls=setup({c:165,t:Date.now()/1000});assert.equal((await processor(new Request('http://local/api/process-stock-orders'))).status,401);assert.equal(calls.length,0);
 const response=await processor(new Request('http://local/api/process-stock-orders',{headers:{Authorization:'Bearer fixture-only'}}));assert.equal(response.status,200);assert.equal((await response.json()).filled,1);
});
test('unauthenticated user cannot create an order',async()=>{setup();assert.equal((await handler(new Request('http://local/api/orders'))).status,401);});

test('old cached Limit payload without request_id cannot execute a market sale',async()=>{
 const calls=setup();
 const res=await trades(new Request('http://local/api/trades',{method:'POST',headers:{'X-User-Code':'FIXTURE','Content-Type':'application/json'},body:JSON.stringify({type:'SELL',symbol:'AAPL',asset_type:'stock',shares:2,price:160})}));
 assert.equal(res.status,409);assert.equal((await res.json()).error,'client_update_required');
 assert.equal(calls.length,1);assert(calls[0].path.endsWith('stockrocket_access_codes'));
});
test('malformed request_id is rejected before quote retrieval or monetary RPC',async()=>{
 const calls=setup();
 const res=await trades(new Request('http://local/api/trades',{method:'POST',headers:{'X-User-Code':'FIXTURE','Content-Type':'application/json'},body:JSON.stringify({type:'SELL',symbol:'AAPL',asset_type:'stock',shares:2,price:160,request_id:'broken'})}));
 assert.equal(res.status,400);assert.equal((await res.json()).error,'invalid_request_id');assert.equal(calls.length,1);
});
test('current market request forwards its valid UUID to the atomic RPC',async()=>{
 const calls=setup();
 const res=await trades(new Request('http://local/api/trades',{method:'POST',headers:{'X-User-Code':'FIXTURE','Content-Type':'application/json'},body:JSON.stringify({type:'SELL',symbol:'AAPL',asset_type:'stock',shares:2,price:150,request_id:id})}));
 assert.equal(res.status,200);assert.equal(calls.find(c=>c.path.endsWith('stockrocket_execute_trade')).body.p_request,id);
});
test('served executeServerTrade generates a UUID for callers omitting it',async()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const source=html.slice(html.indexOf('async function executeServerTrade('),html.indexOf('// Human-readable message for server error codes.'));
 const bodies=[];
 const context=vm.createContext({crypto:{randomUUID:()=>id},API_BASE:'',fetch:async(url,opts)=>{bodies.push(JSON.parse(opts.body));return {ok:true,json:async()=>({ok:true})};}});
 vm.runInContext(source,context);
 await context.executeServerTrade({code:'FIXTURE',type:'SELL',symbol:'AAPL',assetType:'stock',shares:2,price:150});
 assert.equal(bodies[0].request_id,id);
});

test('uncertain create timeout preserves retry identity with 503 instead of validation 400',async()=>{
 setup();const transport=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{if(String(url).endsWith('stockrocket_create_stock_order'))throw new DOMException('Timed out after possible commit','TimeoutError');return transport(url,options);};
 const response=await handler(create());assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'database_unavailable'});
});
test('unknown create transport errors remain retryable and do not disclose raw details',async()=>{
 setup();const transport=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{if(String(url).endsWith('stockrocket_create_stock_order'))throw new TypeError('fixture-sensitive-transport-detail');return transport(url,options);};
 const response=await handler(create());assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'database_unavailable'});
});
