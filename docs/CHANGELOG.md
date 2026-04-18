# StockRocket Changelog

All notable changes to this product.

## [Unreleased]

### Added
- Access-code gate on login (Phase 1 -- launch)
- Tier field on user model (`free` / `family` / `pro`)
- Terms acceptance checkbox on first login
- APP_ENV and API_BASE config constants
- Vercel Web Analytics
- Placeholder `billing/` and `email/` folders for v2
- Legal disclaimer footer, Terms and Privacy pages

### Changed
- Migrated from `/apps/02_Personal/07_stockrocket/` inside COA monorepo to standalone repo under `stockrocket-app/stockrocket` GitHub org
- ADMIN_SECRET moved out of client bundle

### Infrastructure
- New GitHub org: `stockrocket-app`
- New Vercel team
- New (future) Supabase project

---

## Pre-history (captured from STOCKROCKET_SESSION.md)

### Session 1 -- March 19, 2026
- Initial build: 10 pages, Hardware Nebula design system, Ella the Cat as default
- 25 stocks + 5 crypto mock data
- React 18 via in-browser Babel
- Portfolio persistence in localStorage
- 12 Academy lessons drafted
- 2 weekly reports drafted (Vol 42, Vol 43)

### Interim work -- April 2026
- Milburn Pennybags character added for in-app chat
- Brand assets refined
- COPPA-safe data model decisions locked
