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
async function mount(holdings=[holding('NVDA')]) {
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
 await act(async()=>root.render(React.createElement(context.TradePage,{stocks:[asset('AAPL'),asset('NVDA')],crypto:[],portfolio:{cash:100000,holdings,trades:[]},setPortfolio:()=>{},setNotification:n=>notifications.push(n),code:'FIXTURE'})));
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
