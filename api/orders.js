import {database,authenticate,json,failure,UUID,stockQuote,processOrder} from '../lib/stock-orders.js';
export const config={runtime:'edge'};
export default async function handler(req) {
 if(!['GET','POST','DELETE'].includes(req.method)) return json({error:'method_not_allowed'},405);
 try {
  const db=database(),user=await authenticate(req,db);
  if(req.method==='GET') {
   const orders=[];let cursor=null;
   do {
    const page=await db(`stockrocket_stock_orders?user_code=eq.${encodeURIComponent(user)}&status=eq.pending&order=id.asc&limit=500${cursor?`&id=gt.${cursor}`:''}`);
    orders.push(...page);cursor=page.length===500?page.at(-1).id:null;
   }while(cursor);
   const history=await db(`stockrocket_stock_orders?user_code=eq.${encodeURIComponent(user)}&status=neq.pending&order=created_at.desc,id.desc&limit=100`);
   return json({ok:true,orders:[...orders,...history]});
  }
  if(req.method==='DELETE') {
   const id=new URL(req.url).searchParams.get('id'); if(!UUID.test(id||'')) return json({error:'invalid_id'},400);
   return json({ok:true,order:await db('rpc/stockrocket_cancel_stock_order',{p_user:user,p_id:id})});
  }
  let b;try{b=await req.json();}catch{return json({error:'invalid_json'},400);}
  const symbol=String(b.symbol||'').trim().toUpperCase(),qty=Number(b.shares),target=Number(b.target_price);
  if(!UUID.test(b.request_id||'') || !/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) || !Number.isFinite(qty)||qty<=0||!Number.isFinite(target)||target<=0) return json({error:'invalid_order'},400);
  const order=await db('rpc/stockrocket_create_stock_order',{p_user:user,p_request:b.request_id,p_symbol:symbol,p_qty:qty,p_target:target});
  // Persistence succeeds first; quote/fill outage leaves a retryable pending order.
  try{return json(await processOrder(db,order,await stockQuote(symbol)));}catch{return json({ok:true,order,processing_delayed:true});}
 } catch(error){return failure(error);}
}
