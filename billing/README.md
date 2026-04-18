# Billing (v2 placeholder)

This folder is reserved for Stripe integration in a future version.

## Plan

- **Free** -- paper trading, 1 portfolio, mock data fallback
- **Family** -- up to 5 users, real market data, shared leaderboard
- **Pro** -- unlimited users, weekly report archive, priority data refresh

## Implementation notes (not yet built)

- Stripe Checkout for subscription purchase
- Webhook handler for subscription lifecycle events
- User tier field drives feature gating client-side and API-side
- COPPA-aware: parent email required for any account under 13
