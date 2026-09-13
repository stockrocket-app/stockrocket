import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {runSweep,WORKER_BUDGET_MS} from '../api/process-stock-orders.js';
import {database} from '../lib/stock-orders.js';
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
const pending=id=>({id:String(id),user_code:'FIXTURE',symbol:'AAPL',qty:1,target_price:200,status:'pending'});
test('fast quote starts remain below Finnhub 30/second per invocation',async()=>{
 let clock=0,next=0;const starts=[];
 const result=await runSweep({signal:new AbortController().signal,now:()=>clock,sleep:async ms=>{clock+=ms;},db:async()=>Array.from({length:5},()=>pending(next++)),quote:async()=>{starts.push(clock);return null;}});
 assert.equal(result.scanned,100);
 for(const at of starts)assert(starts.filter(t=>t>=at&&t<=at+1000).length<=25);
 assert.equal(clock,4750);
});
test('deadline includes slow database claims and stops quote calls',async()=>{
 let clock=0,claims=0,quotes=0;
 const result=await runSweep({signal:new AbortController().signal,now:()=>clock,sleep:async ms=>{clock+=ms;},db:async()=>{claims++;clock+=WORKER_BUDGET_MS;return [pending(1)];},quote:async()=>{quotes++;return null;}});
 assert.equal(claims,1);assert.equal(quotes,0);assert.equal(result.deferred,true);
});
test('quote latency exhausting the budget cannot start any fill RPC',async()=>{
 let clock=0,claims=0,fills=0;
 const result=await runSweep({signal:new AbortController().signal,now:()=>clock,sleep:async ms=>{clock+=ms;},db:async path=>{if(path.includes('scan')){claims++;return [pending(1)];}fills++;},quote:async()=>{clock+=WORKER_BUDGET_MS;return {price:210,at:new Date().toISOString()};}});
 assert.equal(claims,1);assert.equal(fills,0);assert.equal(result.deferred,true);
});
test('aborted invocation stops claiming and returns for the next scheduled retry',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;
 const result=await runSweep({signal:controller.signal,db:async()=>{calls++;},quote:async()=>{calls++;}});
 assert.equal(calls,0);assert.equal(result.deferred,true);
});
test('small pending queue is not quoted repeatedly within one invocation',async()=>{
 let calls=0;
 const result=await runSweep({signal:new AbortController().signal,db:async()=>Array.from({length:5},(_,i)=>pending(i)),quote:async()=>{calls++;return null;}});
 assert.equal(calls,5);assert.equal(result.scanned,5);
});
test('database fetch signal enforces invocation abort on a stalled response',async()=>{
 process.env.SUPABASE_URL='http://fixture.invalid';process.env.SUPABASE_SERVICE_KEY='fixture-only';
 const controller=new AbortController();let observed;
 globalThis.fetch=async(url,options)=>{observed=options.signal;return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});};
 const promise=database({signal:controller.signal})('rpc/stockrocket_scan_stock_orders',{});
 controller.abort(new DOMException('Fixture cancellation','AbortError'));
 await assert.rejects(promise,{name:'AbortError'});assert.equal(observed.aborted,true);
});
test('database per-fetch timeout is bounded to five seconds even without a caller signal',async()=>{
 process.env.SUPABASE_URL='http://fixture.invalid';process.env.SUPABASE_SERVICE_KEY='fixture-only';
 const original=AbortSignal.timeout;const durations=[];
 AbortSignal.timeout=ms=>{durations.push(ms);return new AbortController().signal;};
 globalThis.fetch=async()=>Response.json([]);
 try{await database()('rpc/stockrocket_scan_stock_orders',{});}finally{AbortSignal.timeout=original;}
 assert.deepEqual(durations,[5000]);
});
