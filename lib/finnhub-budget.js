// Every in-repository Finnhub HTTP attempt consumes one shared database permit.
// Fail closed if budget/database is unavailable. Failed upstream attempts remain charged.
export async function finnhubFetch(url,options={}) {
 const base=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_KEY;
 if(!base||!key) return new Response(JSON.stringify({error:'quote_budget_unavailable'}),{status:503,headers:{'content-type':'application/json'}});
 const started=performance.now();
 const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000);
 try {
  const permit=await fetch(`${base.replace(/\/$/,'')}/rest/v1/rpc/stockrocket_take_finnhub_permit`,{method:'POST',signal,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:'{}'});
  if(!permit.ok) return new Response(JSON.stringify({error:'quote_budget_unavailable'}),{status:503,headers:{'content-type':'application/json'}});
  const allowed=await permit.json();
  if(allowed!==true) return new Response(JSON.stringify({error:'quote_budget_exhausted'}),{status:429,headers:{'content-type':'application/json','retry-after':'6'}});
  // The SQL windows include this bounded grant-to-start delay; an old permit
  // must never be used after a delayed response or event-loop pause.
  if(signal.aborted||performance.now()-started>=5000) return new Response(JSON.stringify({error:'quote_budget_unavailable'}),{status:503,headers:{'content-type':'application/json'}});
  return await fetch(url,options);
 }catch {return new Response(JSON.stringify({error:'quote_budget_unavailable'}),{status:503,headers:{'content-type':'application/json'}});}
}
