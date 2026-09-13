import {database,json,failure,stockQuote,processOrder} from '../lib/stock-orders.js';
export const config={runtime:'edge'};
export const WORKER_BUDGET_MS=20000;
export const QUOTE_BATCH_INTERVAL_MS=250; // At most 5 starts per 250ms: <=25 in any closed one-second interval.
function pause(ms,signal) {
 return new Promise((resolve,reject)=>{
  if(signal.aborted) return reject(signal.reason);
  const abort=()=>{clearTimeout(timer);reject(signal.reason);};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
  signal.addEventListener('abort',abort,{once:true});
 });
}
// Injectable clock/transport permits deterministic deadline and pacing tests.
export async function runSweep({db,quote,signal,now=Date.now,sleep=pause,deadline=now()+WORKER_BUDGET_MS}) {
 let scanned=0,filled=0,failed=0,nextQuoteAt=0,deferred=false;
 const seen=new Set();
 for(let batch=0;batch<20;batch++) {
  if(signal.aborted || now()>=deadline){deferred=true;break;}
  // Claim only five at a time. Orders not reached before the deadline retain
  // their old rotation priority; a slow vendor cannot repeatedly starve them.
  let orders;
  try {orders=await db('rpc/stockrocket_scan_stock_orders',{});}
  catch(error){if(signal.aborted||now()>=deadline){deferred=true;break;}throw error;}
  if(!orders.length)break;
  const fresh=orders.filter(o=>!seen.has(o.id));
  if(!fresh.length)break;
  const wait=Math.max(0,nextQuoteAt-now());
  if(signal.aborted || now()+wait>=deadline){deferred=true;break;}
  if(wait) {try{await sleep(wait,signal);}catch{deferred=true;break;}}
  if(signal.aborted || now()>=deadline){deferred=true;break;}
  nextQuoteAt=now()+QUOTE_BATCH_INTERVAL_MS;
  await Promise.all(fresh.map(async order=>{
   if(signal.aborted||now()>=deadline){deferred=true;return;}
   seen.add(order.id);scanned++;
   try {
    const current=await quote(order.symbol,{signal});
    if(signal.aborted||now()>=deadline){deferred=true;return;}
    const result=await processOrder(db,order,current);
    if(result.order?.status==='filled')filled++;
   }catch {if(signal.aborted||now()>=deadline)deferred=true;else failed++;}
  }));
  if(orders.length<5)break;
 }
 return {ok:failed===0,scanned,filled,failed,deferred};
}
export default async function handler(req) {
 if(!['GET','POST'].includes(req.method)) return json({error:'method_not_allowed'},405);
 if(!process.env.CRON_SECRET || req.headers.get('authorization')!==`Bearer ${process.env.CRON_SECRET}`) return json({error:'auth_required'},401);
 const deadline=Date.now()+WORKER_BUDGET_MS;
 const signal=AbortSignal.timeout(WORKER_BUDGET_MS);
 try {
  const result=await runSweep({db:database({signal}),quote:stockQuote,signal,deadline});
  return json(result,result.failed?503:200);
 }catch(error){return failure(error);}
}
