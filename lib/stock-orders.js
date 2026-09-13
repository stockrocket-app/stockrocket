import {finnhubFetch} from './finnhub-budget.js';
// Service-side utilities. No client-provided execution quotes are accepted.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function json(value,status=200) { return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}); }
export function database({signal} = {}) {
 const base=process.env.SUPABASE_URL, key=process.env.SUPABASE_SERVICE_KEY;
 if (!base || !key) throw new Error('not_configured');
 return async (path, body) => {
  const res=await fetch(`${base.replace(/\/$/,'')}/rest/v1/${path}`,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000),method:body===undefined?'GET':'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!res.ok) { let d={}; try {d=await res.json();} catch{}; const safe=new Set(['invalid_order','invalid_trade','insufficient_shares','insufficient_cash','idempotency_conflict','order_not_found']); throw new Error(safe.has(d.message)?d.message:'database_unavailable'); }
  return res.json();
 };
}
export async function authenticate(req,db) {
 const code=(req.headers.get('x-user-code')||'').trim();
 if(!code) throw new Error('auth_required');
 const rows=await db(`stockrocket_access_codes?code=eq.${encodeURIComponent(code)}&active=eq.true&limit=1`);
 if(!rows?.[0]) throw new Error('auth_denied');
 return rows[0].code;
}
export function freshQuote(price,timestamp,now=Date.now()) {
 return Number.isFinite(price) && price>0 && Number.isFinite(timestamp) && timestamp>=now-60000 && timestamp<=now+5000;
}
export async function stockQuote(symbol,{signal} = {}) {
 if(!process.env.FINNHUB_KEY) return null;
 try {
  const res=await finnhubFetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(process.env.FINNHUB_KEY)}`,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000),cache:'no-store'});
  if(!res.ok) return null;
  const d=await res.json(),price=Number(d.c),time=Number(d.t)*1000;
  return freshQuote(price,time)?{price,at:new Date(time).toISOString()}:null;
 }catch{return null;}
}
export async function processOrder(db,order,quote) {
 if(!quote) return {ok:true,order};
 return db('rpc/stockrocket_execute_trade',{p_user:order.user_code,p_type:'SELL',p_symbol:order.symbol,p_name:order.symbol,p_asset:'stock',p_qty:Number(order.qty),p_price:quote.price,p_order:order.id,p_quote_at:quote.at});
}
export function failure(error) {
 const message=error.message;
 if(message==='auth_required') return json({error:message},401);
 if(message==='auth_denied') return json({error:message},403);
 if(['invalid_order','invalid_trade','insufficient_shares','insufficient_cash','idempotency_conflict','order_not_found'].includes(message)) return json({error:message},400);
 // A transport failure may follow a committed create. Return retryable status
 // so the browser preserves its UUID; never expose raw transport/DB messages.
 return json({error:message==='not_configured'?'not_configured':'database_unavailable'},503);
}
