# StockRocket

A paper-trading stock market learning app for kids and beginners. Trade stocks and crypto with virtual cash, chat with other traders, read weekly market intelligence reports, and learn investing fundamentals.

> **Status:** v1.0 launch candidate. Access-gated preview.
> **Owner:** DataGitSym (Robbie Johnstone)
> **Domain:** TBD (candidate: stockrocket.app)

---

## What This Is

- Virtual cash paper trading for ages 8-16
- Stocks + crypto with real market data (CoinGecko free tier, Finnhub free tier)
- Weekly market briefings written for beginners
- Built-in lessons covering the fundamentals
- Group chat so kids can talk trades together
- No real money. No payment collection. No personal data beyond a display name.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 via in-browser Babel (single-file HTML) |
| Styling | Custom CSS variables -- "Hardware Nebula" design system |
| Market data | CoinGecko (crypto, no key) + Finnhub (stocks, free tier) |
| Persistence | localStorage (v1) -> Supabase (v1.1) |
| Hosting | Vercel (static) |
| Analytics | Vercel Web Analytics (privacy-safe) |

## Running locally

Open `index.html` directly in a browser. No build step. No server. File:// works.

To enable live stock data (not required; falls back to mock):

```js
// In browser console on the app
localStorage.setItem('stockrocket_finnhub_key', 'YOUR_KEY_HERE')
```

## Structure

```
stockrocket/
  index.html              Single-file React app
  css/                    Nebula design system stylesheets
  js/                     Synced JSX copies (in-browser Babel compiles from index.html)
  assets/                 Design references and images
  content/                Academy lessons, weekly reports
  images/                 Logos, avatars
  supabase-schema.sql     Future DB schema (not yet deployed)
  billing/                v2 payment integration (placeholder)
  email/                  v2 transactional mail templates (placeholder)
  docs/                   Build notes, spec, changelog
  vercel.json             Deployment config
  .env.example            Template for env vars (none required at v1)
```

## Roadmap

- [x] Core paper trading loop with mock data
- [x] Portfolio persistence (localStorage)
- [x] Design system + 10 pages
- [x] Weekly report and Academy content
- [ ] Access-code gate for private launch
- [ ] Finnhub live-data wiring
- [ ] Legal pages (Terms, Privacy, disclaimer)
- [ ] Vercel deploy to production domain
- [ ] Supabase backend for multi-device + real-time chat
- [ ] Stripe for Family and Pro tiers

## License

Proprietary. All rights reserved.
