# StockRocket Changelog

All notable changes to this product.

## [1.0.0] -- 2026-04-18 -- Launch Day

### Added
- Access-code gate on login with five seed codes (NEPHEW-APR18, ELLA-2026, LAUNCH2026, RSJ-ADMIN, DEMO)
- Tier field on user model (`free` / `family` / `pro`); tier is a property of the access code
- Terms-accept checkbox as hard block on first login
- `validateAccessCode()` helper with expiration check
- APP_ENV and API_BASE config constants (auto-detects localhost/file vs production)
- APP_VERSION constant (shown in login footer)
- Vercel Web Analytics script tag (no-ops outside Vercel)
- LegalPage component serving Terms, Privacy, and Disclaimer inline
- Persistent legal footer on every page: "FOR EDUCATION ONLY -- NO REAL MONEY -- NOT FINANCIAL ADVICE"
- Session persisted to `stockrocket_auth` localStorage
- Tier display in sidebar user card (Rocket_Cadet / Family_Tier / Pro_Tier / Admin_Mode)
- Placeholder `billing/` and `email/` folders for v2

### Changed
- Migrated from `/apps/02_Personal/07_stockrocket/` inside COA monorepo to standalone repo under `stockrocket-app/stockrocket` GitHub org
- Login flow: username+password -> display name + access code + Terms accept
- Admin access: no longer via hardcoded password; admin flag is a property of the RSJ-ADMIN code

### Removed
- `ADMIN_SECRET = 'rocketadmin'` hardcoded constant from client bundle
- "Admin Login" quick-start button that bypassed password check

### Infrastructure
- New GitHub org: `stockrocket-app` (private)
- Production domain: **stockrocket.live** (GoDaddy, 3-year registration, $100.59 total)
- New Vercel team + project: pending user action
- New (future) Supabase project: v1.1

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
