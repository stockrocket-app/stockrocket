-- =============================================
-- StockRocket -- Trade Persistence Schema
-- =============================================
-- Apply in App Lab Supabase SQL Editor.
-- Auth model: no Supabase Auth. Access is via X-User-Code header,
-- enforced by the Edge Function using the service_role key.
-- RLS stays OFF on these tables (service role bypasses anyway).

-- Append-only ledger of every BUY / SELL
CREATE TABLE IF NOT EXISTS stockrocket_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_code TEXT NOT NULL,
  trade_type TEXT NOT NULL CHECK (trade_type IN ('BUY', 'SELL')),
  asset_type TEXT NOT NULL DEFAULT 'stock' CHECK (asset_type IN ('stock', 'crypto')),
  symbol TEXT NOT NULL,
  name TEXT,
  shares NUMERIC(20,8) NOT NULL,
  price NUMERIC(20,4) NOT NULL,
  total NUMERIC(20,4) NOT NULL,
  cash_after NUMERIC(20,4) NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stockrocket_trades_user ON stockrocket_trades(user_code, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_stockrocket_trades_symbol ON stockrocket_trades(symbol);

-- Materialized current state, one row per family member
CREATE TABLE IF NOT EXISTS stockrocket_portfolios (
  user_code TEXT PRIMARY KEY,
  cash NUMERIC(20,4) NOT NULL DEFAULT 100000,
  starting_cash NUMERIC(20,4) NOT NULL DEFAULT 100000,
  holdings JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- holdings shape (keyed by symbol):
  --   { "NKE": { "symbol": "NKE", "name": "Nike Inc.", "assetType": "stock", "shares": 10, "avgCost": 75.5 } }
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stockrocket_portfolios_updated ON stockrocket_portfolios(updated_at DESC);

-- Auto-bump updated_at on portfolio writes
CREATE OR REPLACE FUNCTION stockrocket_portfolios_touch() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stockrocket_portfolios_touch_trigger ON stockrocket_portfolios;
CREATE TRIGGER stockrocket_portfolios_touch_trigger
  BEFORE UPDATE ON stockrocket_portfolios
  FOR EACH ROW EXECUTE FUNCTION stockrocket_portfolios_touch();
