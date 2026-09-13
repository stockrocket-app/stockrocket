import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import trades from '../api/trades.js';
import {PAPER_STOCK_SYMBOLS,PAPER_CRYPTO_SYMBOLS,isOfferedPaperAsset} from '../lib/paper-assets.js';
const original=globalThis.fetch;afterEach(()=>{globalThis.fetch=original;});
const id='11111111-1111-4111-8111-111111111111';
function fixture({vendorAvailable=true,coinbaseAvailable=true}={}) {
 process.env.SUPABASE_URL='http://fixture.invalid';process.env.SUPABASE_SERVICE_KEY='fixture-only';process.env.FINNHUB_KEY='fixture-only';
 const writes=[],vendor=[];
 globalThis.fetch=async(url,opts={})=>{
  const u=new URL(url);
  if(u.pathname.endsWith('stockrocket_access_codes'))return Response.json([{code:'FIXTURE',active:true}]);
  if(u.pathname.endsWith('stockrocket_take_finnhub_permit'))return Response.json(true);
  if(u.pathname.endsWith('stockrocket_execute_trade')){const b=JSON.parse(opts.body);writes.push(b);return Response.json({ok:true,trade:{symbol:b.p_symbol,price:b.p_price},portfolio:{cash:99958,holdings:{}}});}
  assert(['finnhub.io','api.exchange.coinbase.com','api.coingecko.com'].includes(u.hostname),'No real database or unsupported vendor');vendor.push(u);
  if(!vendorAvailable)return new Response('',{status:503});
  if(u.hostname==='finnhub.io')return Response.json({c:42,t:Date.now()/1000});
  if(u.hostname==='api.exchange.coinbase.com')return coinbaseAvailable?Response.json({last:'42'}):new Response('',{status:503});
  return Response.json(Object.fromEntries(['bitcoin','ethereum','solana','cardano','polkadot'].map(k=>[k,{usd:42}])));
 };return {writes,vendor};
}
function request(symbol,type='stock'){return new Request('http://fixture/api/trades',{method:'POST',headers:{'X-User-Code':'FIXTURE','Content-Type':'application/json'},body:JSON.stringify({type:'BUY',symbol,asset_type:type,shares:1,price:null,request_id:id})});}
test('offered UI stock and crypto directories exactly match the guarded paper-buy universe',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const stocks=[...html.slice(html.indexOf('const MOCK_STOCKS = ['),html.indexOf('// CRYPTO DIRECTORY')).matchAll(/symbol: '([^']+)'/g)].map(m=>m[1]);
 const crypto=[...html.slice(html.indexOf('const MOCK_CRYPTO = ['),html.indexOf('const TRADER_INSIGHTS')).matchAll(/symbol: '([^']+)'/g)].map(m=>m[1]);
 assert.deepEqual(stocks,PAPER_STOCK_SYMBOLS);assert.deepEqual(crypto,PAPER_CRYPTO_SYMBOLS);assert(PAPER_STOCK_SYMBOLS.includes('ORCL'));assert.equal(stocks.length,57);assert.equal(crypto.length,5);
});
test('every one of the 62 offered assets reaches its server-priced paper BUY transaction',async()=>{
 for(const [type,symbols] of [['stock',PAPER_STOCK_SYMBOLS],['crypto',PAPER_CRYPTO_SYMBOLS]])for(const symbol of symbols){
  const {writes,vendor}=fixture();const res=await trades(request(symbol,type));assert.equal(res.status,200,symbol);assert.equal(writes.length,1,symbol);assert.equal(writes[0].p_symbol,symbol);assert.equal(writes[0].p_asset,type);assert.equal(writes[0].p_price,42);
  assert.equal(vendor[0].hostname,type==='stock'?'finnhub.io':'api.exchange.coinbase.com');if(type==='stock')assert.equal(vendor[0].searchParams.get('symbol'),symbol);
 }
});
test('every offered crypto retains CoinGecko fallback coverage',async()=>{
 for(const symbol of PAPER_CRYPTO_SYMBOLS){const {writes,vendor}=fixture({coinbaseAvailable:false});assert.equal((await trades(request(symbol,'crypto'))).status,200);assert.equal(writes[0].p_price,42);assert(vendor.some(u=>u.hostname==='api.coingecko.com'));}
});
test('missing ORCL vendor quote refuses execution rather than substituting an example price',async()=>{
 const {writes}=fixture({vendorAvailable:false});const res=await trades(request('ORCL'));assert.equal(res.status,400);assert.equal((await res.json()).error,'price_unverifiable');assert.equal(writes.length,0);
});
test('unsupported and mismatched assets cannot obtain a quote or create a paper buy',async()=>{
 for(const [symbol,type]of [['FAKECOIN','crypto'],['ARBITRARY','stock'],['ORCL','crypto'],['BTC','stock']]){
  assert.equal(isOfferedPaperAsset(symbol,type),false);const {writes,vendor}=fixture();assert.equal((await trades(request(symbol,type))).status,400);assert.equal(writes.length,0);assert.equal(vendor.length,0);
 }
});
test('browser helper sends null advisory when a supported asset has not loaded its quote',async()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');const source=html.slice(html.indexOf('async function executeServerTrade('),html.indexOf('// Human-readable message for server error codes.'));const bodies=[];
 const context=vm.createContext({crypto:{randomUUID:()=>id},API_BASE:'',fetch:async(url,opts)=>{bodies.push(JSON.parse(opts.body));return{ok:true,json:async()=>({ok:true})};}});vm.runInContext(source,context);
 await context.executeServerTrade({code:'FIXTURE',type:'BUY',symbol:'ORCL',assetType:'stock',shares:1,price:null});assert.equal(bodies[0].price,null);assert.equal(bodies[0].symbol,'ORCL');
});
