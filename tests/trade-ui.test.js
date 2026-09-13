import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from '@babel/core';
import jsx from '@babel/plugin-transform-react-jsx';
import {JSDOM} from 'jsdom';
import React from 'react';
const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.local'});
globalThis.window=dom.window;globalThis.document=dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {Simulate}=await import('react-dom/test-utils');
const {act}=React;
let root;
afterEach(async()=>{if(root)await act(async()=>root.unmount());root=null;dom.window.localStorage.clear();});
const asset=(symbol,price=150)=>({symbol,name:symbol,price,type:'stock',change:0,changePercent:0});
const holding=(symbol,shares=150)=>({symbol,name:symbol,shares,assetType:'stock',avgCost:100,currentPrice:150,gain:50*shares,returnPercent:50});
async function mount(holdings=[holding('NVDA')],assets={stocks:[asset('AAPL'),asset('NVDA')],crypto:[]}) {
 const requests=[],notifications=[];let orders=[];
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const source=html.slice(html.indexOf('function TradePage('),html.indexOf('// ==================== MARKETS'));
 const code=transformSync('const {useState,useEffect,useRef}=React;'+source,{plugins:[jsx],babelrc:false,configFile:false}).code;
 const context=vm.createContext({React,window:dom.window,localStorage:dom.window.localStorage,API_BASE:'',
  useChartData:()=>({data:[],loading:false}),Icon:()=>null,RowSparkline:()=>null,NebulaChart:()=>null,
  formatCurrency:n=>'$'+Number(n).toFixed(2),fetchServerPortfolio:async()=>null,
  setInterval:()=>1,clearInterval:()=>{},setTimeout:()=>1,
  fetch:async(url,opts={})=>{requests.push({url,method:opts.method||'GET',body:opts.body?JSON.parse(opts.body):null});if(opts.method==='POST'){orders.push({id:'fixture-order',...JSON.parse(opts.body),qty:JSON.parse(opts.body).shares,status:'pending'});return {ok:true,json:async()=>({ok:true,order:orders.at(-1)})};}return {ok:true,json:async()=>({ok:true,orders})};},
  executeServerTrade:async()=>{throw Error('Target selling must not execute a market trade');},
 });
 vm.runInContext(code,context);
 root=createRoot(document.getElementById('root'));
 await act(async()=>root.render(React.createElement(context.TradePage,{stocks:assets.stocks,crypto:assets.crypto,portfolio:{cash:100000,holdings,trades:[]},setPortfolio:()=>{},setNotification:n=>notifications.push(n),code:'FIXTURE'})));
 return {requests,notifications};
}
const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
async function click(text){const b=button(text);assert(b,`Missing button ${text}`);await act(async()=>b.click());}
async function change(input,value){assert(input,'Missing accessible input');await act(async()=>Simulate.change(input,{target:{value}}));}
test('Sell selects owned NVDA instead of unowned default AAPL',async()=>{
 await mount();await click('Sell');
 const selector=document.querySelector('select[aria-label="Holding to sell"]');assert(selector,'Sell needs an interactive holding selector');assert.equal(selector.value,'NVDA');assert(![...selector.options].some(o=>o.value==='AAPL'));
});
test('actual target form saves a pending NVDA order, with clear target CTA',async()=>{
 const {requests}=await mount();await click('Sell');await click('Target sell');
 await change(document.getElementById('trade-target-price'),'200');await change(document.getElementById('trade-shares'),'3');
 await click('Review target sell');await click('Save pending order');
 const writes=requests.filter(r=>r.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].url,'/api/orders');assert.equal(writes[0].body.symbol,'NVDA');assert.equal(writes[0].body.shares,3);assert.equal(writes[0].body.target_price,200);assert(writes[0].body.request_id);assert(document.body.textContent.includes('pending'));
});
test('holding outside market list is selectable, and changing holdings clears target and quantity',async()=>{
 await mount([holding('NVDA'),holding('PRIVATE',4)]);await click('Sell');await click('Target sell');
 await change(document.getElementById('trade-target-price'),'200');await change(document.getElementById('trade-shares'),'3');
 await change(document.querySelector('select[aria-label="Holding to sell"]'),'PRIVATE');
 assert.equal(document.getElementById('trade-target-price').value,'');assert.equal(document.getElementById('trade-shares').value,'');assert.equal(document.querySelector('select[aria-label="Holding to sell"]').value,'PRIVATE');
});
test('Sell with no holdings explains the empty state and offers no target submit',async()=>{
 await mount([]);await click('Sell');assert(document.body.textContent.includes('No holdings available to sell'));assert(!button('Review target sell'));
 await click('Buy');assert.equal(document.querySelector('select[aria-label="Asset"]').value,'AAPL');
});

async function mountNavigationPage(name) {
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const end=name==='DashboardPage'?'function PortfolioPage(':'function TradePage(';
 const source=html.slice(html.indexOf('function '+name+'('),html.indexOf(end));
 const code=transformSync('const {useState,useEffect,useRef}=React;'+source,{plugins:[jsx],babelrc:false,configFile:false}).code;
 const navigation=[],trading=[];
 const context=vm.createContext({React,TRADER_INSIGHTS:[],ACHIEVEMENTS:[],DONUT_PALETTE:[],
  Icon:()=>null,CharacterAvatar:()=>null,AllocationDonut:()=>null,NebulaChart:()=>null,
  formatCurrency:n=>'$'+Number(n).toFixed(2),formatCurrencySplit:n=>({whole:'$'+Math.floor(n),decimal:'.00'}),
  usePortfolioChart:()=>({data:[],loading:false}),useMarketCountdown:()=>({isOpen:false,label:'Closed',countdown:''}),
 });
 vm.runInContext(code,context);
 root=createRoot(document.getElementById('root'));
 await act(async()=>root.render(React.createElement(context[name],{stocks:[asset('AAPL'),asset('MSFT'),asset('NVDA')],crypto:[],portfolio:{cash:100000,holdings:[{...holding('NVDA'),value:22500}],trades:[]},user:'Fixture',leaderboard:[],onNavigate:p=>navigation.push(p),onTrade:(symbol,type)=>trading.push({symbol,type})})));
 return {navigation,trading};
}
test('Portfolio buttons route to real insights/report pages and Trade with selected holding',async()=>{
 const {navigation,trading}=await mountNavigationPage('PortfolioPage');
 await click('Market insights');await click('Reports');await click('Execute');
 assert.deepEqual(navigation,['insights','report']);assert.deepEqual(trading,[{symbol:'NVDA',type:'SELL'}]);
});
test('Dashboard search filters actual market rows and Execute forwards the selected symbol',async()=>{
 const {navigation,trading}=await mountNavigationPage('DashboardPage');
 await change(document.querySelector('[aria-label="Search watchlist"]'),'NVDA');
 const watchlist=document.querySelector('[aria-label="Search watchlist"]').closest('section');
 assert(watchlist.textContent.includes('NVDA'));assert(!watchlist.textContent.includes('AAPL'));
 await act(async()=>watchlist.querySelector('button[aria-label="Trade NVDA"]').click());
 await act(async()=>document.querySelector('button[aria-label="Browse markets"]').click());
 assert.deepEqual(trading,[{symbol:'NVDA',type:'BUY'}]);assert.deepEqual(navigation,['market']);
});
test('unavailable chat tools are visibly explained and disabled in served JSX',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 for(const label of ['Search chat','Pinned messages','More chat tools'])assert(html.includes(`disabled aria-label="${label} unavailable"`));
 assert(html.includes('Search, pins and more tools are not available yet.'));
});
test('cold live-data hook never exposes the example NVDA price while transport is pending',async()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const source=html.slice(html.indexOf('function useLiveData()'),html.indexOf('// Market-hours check used by useLiveData'));
 const context=vm.createContext({React,MOCK_STOCKS:[asset('NVDA',924.15)],MOCK_CRYPTO:[],isUsMarketOpen:()=>false,LiveData:{fetchCrypto:()=>new Promise(()=>{})},setInterval:()=>1,clearInterval:()=>{}});
 vm.runInContext('const {useState,useEffect,useRef,useCallback}=React;'+source,context);
 let state;function Probe(){state=context.useLiveData();return null;}
 root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(Probe)));
 assert.equal(state.stocks[0].price,null);assert.equal(state.stocks[0].stale,true);assert.equal(state.stocksLive,false);
});

test('all 62 offered assets remain selectable for BUY even without cached quotes',async()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const directory=vm.runInNewContext(html.slice(html.indexOf('const MOCK_STOCKS = ['),html.indexOf('const TRADER_INSIGHTS'))+';({stocks:MOCK_STOCKS.map(s=>({...s,price:null})),crypto:MOCK_CRYPTO});');
 await mount([],directory);const selector=document.querySelector('select[aria-label="Asset"]');assert.equal(selector.options.length,62);
 for(const item of [...directory.stocks,...directory.crypto]){await change(selector,item.symbol);assert.equal(selector.value,item.symbol);assert(button(`Buy 0 ${item.symbol}`));}
 await change(selector,'ORCL');assert(document.body.textContent.includes('Quote unavailable'));
});

test('actual Oracle report renders all watchlist actions, two outlook events, sources and archive navigation',async()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const data=html.slice(html.indexOf('const WEEKLY_REPORTS = ['),html.indexOf('// ==================== LIVE DATA LAYER'));
 const source=html.slice(html.indexOf('function WeeklyReportPage('),html.indexOf('// ==================== ADMIN PAGE'));
 const context=vm.createContext({React,window:{},Icon:()=>null,formatCurrency:n=>'$'+n});
 vm.runInContext(readFileSync(new URL('../content/reports/2026-09-13.js',import.meta.url),'utf8'),context);
 vm.runInContext(data,context);
 vm.runInContext(transformSync('const {useState}=React;'+source,{plugins:[jsx],babelrc:false,configFile:false}).code,context);
 const trading=[],details=[];root=createRoot(document.getElementById('root'));
 await act(async()=>root.render(React.createElement(context.WeeklyReportPage,{onTrade:(symbol,type)=>trading.push({symbol,type}),setStockDetail:symbol=>details.push(symbol)})));
 const briefing=context.window.STOCKROCKET_WEEKLY_REPORT.briefing;
 assert(document.body.textContent.includes(briefing.title));assert.equal(briefing.watchlist.length,5);assert.equal(briefing.outlook.length,2);
 for(const item of briefing.watchlist){await click(`Paper buy ${item.ticker}`);assert(document.body.textContent.includes(item.note));}
 for(const item of briefing.outlook)assert(document.body.textContent.includes(item.event));
 assert.equal(trading.length,5);assert(trading.every(t=>t.type==='BUY'));await click('View Oracle');assert.deepEqual(details,['ORCL']);
 assert.equal(document.querySelectorAll('a[href^="https://"]').length,briefing.sections.reduce((n,s)=>n+(s.sources?.length||0),0));
 await click('Archive · Apr 27');assert(document.body.textContent.includes('Weekly Intelligence'));await act(async()=>[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Current report')).click());assert(document.body.textContent.includes(briefing.title));
 assert.equal(vm.runInContext('WEEKLY_REPORTS.filter(r=>r.isCurrent).length',context),1);
});
test('closed-market refresh retries missing ORCL and retains stale cache labels',async()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');const source=html.slice(html.indexOf('function useLiveData()'),html.indexOf('// Market-hours check used by useLiveData'));
 let round=0,interval;
 const context=vm.createContext({React,MOCK_STOCKS:[asset('AAPL'),asset('ORCL')],MOCK_CRYPTO:[],isUsMarketOpen:()=>false,CRYPTO_FAILURE_TRIP:3,CRYPTO_BREAKER_OPEN_MS:300000,
  LiveData:{fetchCrypto:async()=>[],fetchAllStocks:async()=>{round++;return[{price:100,change:0,changePercent:0,stale:true},round===1?null:{price:42,change:0,changePercent:0,stale:false}];}},
  setInterval:fn=>{interval=fn;return 1;},clearInterval:()=>{},
 });
 vm.runInContext('const {useState,useEffect,useRef,useCallback}=React;'+source,context);let state;function Probe(){state=context.useLiveData();return null;}
 root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(Probe)));
 assert.equal(state.stocks[0].stale,true);assert.equal(state.stocks[1].price,null);
 await act(async()=>interval());assert.equal(round,2);assert.equal(state.stocks[1].price,42);assert.equal(state.stocks[0].stale,true);
});
