# v1.0 Launch Checklist

Target: nephew can use an access code on launch day (April 18, 2026).
Production domain: **stockrocket.live** (3-year registration, GoDaddy).

## Code changes

- [x] Access-code gate on login (reject invalid codes)
- [x] ADMIN_SECRET removed from client bundle (admin is a property of the RSJ-ADMIN access code)
- [x] Tier field on user model (free / family / pro)
- [x] Terms-accept checkbox on first login (hard block until checked)
- [x] APP_ENV (`development` | `production`) and API_BASE constants
- [x] Vercel Web Analytics script tag
- [x] Footer disclaimer: "For education only. No real money. Not financial advice."

## Content / legal

- [x] /terms page (routed via in-app LegalPage component)
- [x] /privacy page (routed via in-app LegalPage component)
- [x] /disclaimer page (routed via in-app LegalPage component)
- [x] COPPA note: no PII collection, display name only

## Infrastructure

- [x] GitHub org `stockrocket-app` created
- [x] Repo `stockrocket-app/stockrocket` created and pushed
- [ ] Vercel team `stockrocket` created (user action -- vercel.com/teams/new)
- [ ] Vercel project `stockrocket` created from repo
- [x] Domain registered: **stockrocket.live** (GoDaddy, 3-year registration, April 18, 2026, ~$100.59 total)
- [ ] Production alias wired to custom domain (stockrocket.live + www.stockrocket.live)
- [ ] GoDaddy nameservers pointed to Vercel (ns1.vercel-dns.com / ns2.vercel-dns.com) OR A record to Vercel IPs

## Pre-launch smoke test

- [ ] Load on desktop Chrome
- [ ] Load on iOS Safari
- [ ] Load on Android Chrome
- [ ] Login flow with access code (NEPHEW-APR18)
- [ ] Terms checkbox blocks submit when unchecked
- [ ] Invalid access code shows error
- [ ] Buy flow (market order)
- [ ] Sell flow
- [ ] Chart renders
- [ ] Portfolio persists through refresh
- [ ] Weekly report renders
- [ ] Academy lesson opens
- [ ] Legal footer links open Terms/Privacy/Disclaimer pages
- [ ] Network tab: no leaked API keys, no CORS errors
- [ ] Console: no errors

## Handoff

- [x] Nephew access code generated: **NEPHEW-APR18**
- [ ] Parents briefed (no real money, no PII)
- [ ] StockRocket row updated in `public.apps`
- [ ] CHANGELOG entry written
- [ ] Snapshot in `__system/snapshots/`
