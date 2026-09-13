import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {finnhubFetch} from '../lib/finnhub-budget.js';
import {readFileSync} from 'node:fs';
const original=globalThis.fetch;
afterEach(()=>{globalThis.fetch=original;});
function fixture(){process.env.SUPABASE_URL='http://fixture.invalid';process.env.SUPABASE_SERVICE_KEY='fixture-only';}
test('denied shared budget never sends a vendor request',async()=>{
 fixture();let calls=0;globalThis.fetch=async url=>{calls++;assert(String(url).includes('take_finnhub_permit'));return Response.json(false);};
 assert.equal((await finnhubFetch('https://finnhub.io/api/v1/quote')).status,429);assert.equal(calls,1);
});
test('database failure fails closed with sanitized retryable response',async()=>{
 fixture();let calls=0;globalThis.fetch=async()=>{calls++;throw Error('sensitive fixture detail');};
 const response=await finnhubFetch('https://finnhub.io/api/v1/quote');assert.equal(response.status,503);assert.equal(calls,1);assert(!JSON.stringify(await response.json()).includes('sensitive'));
});
test('each HTTP attempt obtains its own durable permit including upstream429',async()=>{
 fixture();const calls=[];globalThis.fetch=async url=>{calls.push(String(url));return String(url).includes('take_finnhub_permit')?Response.json(true):new Response('',{status:429});};
 assert.equal((await finnhubFetch('https://finnhub.io/api/v1/quote')).status,429);
 assert.equal((await finnhubFetch('https://finnhub.io/api/v1/quote')).status,429);assert.equal(calls.length,4);
});
test('every current Finnhub consumer imports the shared transport',()=>{
 for(const file of ['api/finnhub.js','api/price.js','api/refresh-quotes.js','api/trades.js','api/predictions.js','api/resolve-predictions.js','lib/stock-orders.js']){
  const text=readFileSync(new URL('../'+file,import.meta.url),'utf8');assert(text.includes('import {finnhubFetch}'));
  assert(!/await fetch\(\s*`https:\/\/finnhub/.test(text));
 }
});
