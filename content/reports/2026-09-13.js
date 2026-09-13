// Editorial snapshot. Dates and source links are part of the report, not live quotes.
window.STOCKROCKET_WEEKLY_REPORT = {
  id: 'week-2026-09-07', weekStart: 'Sep 7', weekEnd: 'Sep 13, 2026', volume: 46, isCurrent: true,
  briefing: {
    title: 'Oracle: growth, cash demands and the week ahead',
    asOf: 'Published September 13, 2026 • Recap: September 7–13 • Outlook: September 14–18 • Prices below are dated historical observations, not execution quotes.',
    summary: 'Oracle is this week’s focus after its September 10 earnings release. The central question is whether rapid cloud expansion can produce durable cash returns. Inflation and the September Fed meeting add a second source of uncertainty for the coming week. This briefing separates reported results, historical prices and our interpretation; it does not assign unsupported price targets or conviction scores.',
    sections: [
      {
        id: 'oracle-results', title: 'Oracle stock report — what changed',
        paragraphs: [
          'Oracle reported fiscal Q1 2027 revenue of $19.3 billion, up 30% year over year. Cloud infrastructure revenue reached $7.4 billion, up 121%; total cloud revenue was $11.6 billion. Remaining performance obligations reached $664 billion. These are company-reported results, not forecasts.',
          'Management’s full-year outlook calls for at least $90 billion of revenue and $8.10 of non-GAAP earnings per share. That guidance is forward-looking. Our interpretation: demand is growing quickly, but backlog must become delivered service and profitable revenue before shareholders receive its full benefit.'
        ],
        metrics: [
          {label:'Q1 FY27 revenue',value:'$19.3B / +30% YoY'},
          {label:'Cloud infrastructure growth',value:'+121% YoY'},
          {label:'Contracted remaining obligations',value:'$664B'},
          {label:'FY27 adjusted EPS guidance',value:'$8.10 — forecast'}
        ],
        sources:[{label:'Oracle: September 10 Q1 FY27 earnings release',url:'https://www.oracle.com/news/announcement/q1fy27-earnings-release-2026-09-10/'}]
      },
      {
        id:'oracle-cash',title:'Oracle — the cash-flow test',
        paragraphs:[
          'The quarterly SEC filing reports $23.103 billion of operating cash flow and $28.499 billion of capital spending, producing negative $5.396 billion of free cash flow. Operating cash inflows included $11.4 billion of customer prepayments with a significant financing component; those receipts should not be mistaken for recurring earnings.',
          'Oracle also received $19.9 billion net from issuing common stock. Our interpretation: financing and customer commitments help fund expansion, but investors must watch dilution, construction execution and the economics of each new unit of capacity. High revenue growth alone does not settle those questions.'
        ],
        bullets:[
          'Bull case: capacity comes online efficiently and customer demand converts into sustained cash generation.',
          'Base case: growth continues while heavy spending keeps cash returns uneven.',
          'Bear case: deployment delays, weaker utilization or financing pressure offset the growth story.'
        ],
        sources:[{label:'Oracle Form 10-Q, quarter ended August 31, 2026 — cash flows and liquidity',url:'https://www.sec.gov/Archives/edgar/data/1341439/000119312526389274/orcl-20260831.htm'}]
      },
      {
        id:'oracle-price',title:'Oracle — price action and valuation context',
        paragraphs:[
          'ORCL closed September 11 at $150.28, down 1.74% that day. It closed September 4 at $158.78: the close-to-close weekly change was approximately −5.35%, excluding dividends. September 11’s intraday range was $149.84–$166.00, illustrating substantial volatility around the earnings news.',
          'Using that historical close and management’s $8.10 adjusted EPS outlook gives approximately 18.6 times guided earnings. This calculation uses non-GAAP guidance, not realized GAAP earnings, and is not a fair-value estimate. A lower share price can still be expensive if the forecast weakens.'
        ],
        metrics:[{label:'September 11 regular-session close',value:'$150.28'},{label:'Week versus September 4 close',value:'−5.35% (calculated)'},{label:'Price / guided non-GAAP EPS',value:'≈18.6× (calculated)'}],
        sources:[{label:'ORCL historical daily prices — S&P Global data via Stock Analysis',url:'https://stockanalysis.com/stocks/orcl/history/'},{label:'Oracle FY27 adjusted EPS guidance',url:'https://www.oracle.com/news/announcement/q1fy27-earnings-release-2026-09-10/'}]
      },
      {
        id:'weekly-macro',title:'This week’s macro signal — inflation remains mixed',
        paragraphs:[
          'The September 11 BLS release reported August headline CPI up 0.4% month over month, seasonally adjusted, and 3.4% year over year. Core CPI, excluding food and energy, rose 0.3% monthly and 2.4% yearly.',
          'Interpretation: the monthly pickup and lower core annual reading send different signals. One release does not determine the Fed’s decision. For paper portfolios, the useful exercise is to record how growth-sensitive holdings behave around the policy announcement rather than assume a rate move in advance.'
        ],
        sources:[{label:'BLS: Consumer Price Index, August 2026 (released September 11)',url:'https://www.bls.gov/news.release/archives/cpi_09112026.htm'}]
      },
      {
        id:'week-ahead',title:'Next week — September 14–18',
        paragraphs:[
          'The Federal Reserve schedules its next two-day meeting for September 15–16, with a Summary of Economic Projections. The policy outcome is unknown as of this report. Industrial production and capacity utilization are scheduled for September 18 at 9:15 a.m. Eastern.',
          'Watch the decision, projections and market reaction as separate events. A company’s earnings story and the market’s discount rate can move in opposite directions; that is especially relevant when studying capital-intensive growth businesses.'
        ],
        sources:[{label:'Federal Reserve: 2026 FOMC meeting calendar',url:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'},{label:'Federal Reserve: September 2026 release calendar',url:'https://www.federalreserve.gov/newsevents/2026-september.htm'}]
      },
      {
        id:'paper-practice',title:'Paper-trading practice — make the thesis testable',
        paragraphs:[
          'Use the ORCL paper-buy button to open an order ticket; it does not submit a purchase. Record why you would enter, the amount of paper capital at risk and what evidence would change your view. Compare that journal entry with subsequent results rather than judging the idea from one price move.',
          'StockRocket market buys execute from a valid server quote, which can be a last-close quote when stocks are closed. Target-price stock sells wait for a fresh qualifying quote and can be delayed by quote availability. Historical report prices are never sent as execution prices. Crypto trading is available around the clock when its price provider is available.'
        ],
        bullets:['RPO: contracted revenue still to be recognized; it is not cash already earned.','Free cash flow: operating cash flow minus capital spending.','Non-GAAP EPS: an adjusted earnings measure; compare its reconciliation with GAAP.'],
        sources:[]
      }
    ],
    watchlist:[
      {ticker:'ORCL',name:'Oracle',note:'Featured research: track capacity delivery, cash conversion and dilution.'},
      {ticker:'NVDA',name:'NVIDIA',note:'Comparative study: distinguish hardware demand from cloud-provider returns.'},
      {ticker:'MSFT',name:'Microsoft',note:'Comparative study: examine the balance between cloud growth and spending.'},
      {ticker:'AMZN',name:'Amazon',note:'Comparative study: compare cloud economics with Oracle’s model.'},
      {ticker:'BTC',name:'Bitcoin',note:'Separate high-volatility watch item around macro announcements; not a forecast of direction.'}
    ],
    outlook:[
      {date:'September 15–16',event:'Federal Reserve meeting',note:'Decision and economic projections; outcome not known at publication.'},
      {date:'September 18, 9:15 a.m. ET',event:'Industrial production',note:'Scheduled Federal Reserve release; check the official calendar for changes.'}
    ]
  }
};
