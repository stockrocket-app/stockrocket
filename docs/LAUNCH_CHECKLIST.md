# v1.0 Launch Checklist

Target: nephew can use an access code on launch day (April 18, 2026).

## Code changes

- [ ] Access-code gate on login (reject invalid codes)
- [ ] Move ADMIN_SECRET out of client bundle (env var on server-side verification, OR remove admin path from launch)
- [ ] Tier field on user model
- [ ] Terms-accept checkbox on first login (hard block until checked)
- [ ] APP_ENV (`development` | `production`) and API_BASE constants
- [ ] Vercel Web Analytics script tag
- [ ] Footer disclaimer: "For education only. No real money. Not financial advice."

## Content / legal

- [ ] /terms page
- [ ] /privacy page
- [ ] /disclaimer page
- [ ] COPPA note: no PII collection, display name only

## Infrastructure

- [ ] GitHub org `stockrocket-app` created
- [ ] Repo `stockrocket-app/stockrocket` created and pushed
- [ ] Vercel team `stockrocket` created
- [ ] Vercel project `stockrocket` created from repo
- [ ] Domain checked and registered (shortlist: stockrocket.app, .io, .com, getstockrocket.com)
- [ ] Production alias wired to custom domain

## Pre-launch smoke test

- [ ] Load on desktop Chrome
- [ ] Load on iOS Safari
- [ ] Load on Android Chrome
- [ ] Login flow with access code
- [ ] Buy flow (market order)
- [ ] Sell flow
- [ ] Chart renders
- [ ] Portfolio persists through refresh
- [ ] Weekly report renders
- [ ] Academy lesson opens
- [ ] Network tab: no leaked API keys, no CORS errors
- [ ] Console: no errors

## Handoff

- [ ] Nephew access code generated
- [ ] Parents briefed (no real money, no PII)
- [ ] StockRocket row updated in `public.apps`
- [ ] CHANGELOG entry written
- [ ] Snapshot in `__system/snapshots/`
