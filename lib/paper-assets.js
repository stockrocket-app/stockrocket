// Offered paper-buy universe. Catalog parity is enforced by tests.
export const PAPER_STOCK_SYMBOLS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "JPM", "V", "MA", "GS", "BRK.B", "UNH", "LLY", "JNJ", "PFE", "WMT", "COST", "HD", "NKE", "SBUX", "MCD", "KO", "PEP", "DIS", "TGT", "CMG", "YUM", "QSR", "WEN", "DPZ", "XOM", "CVX", "COP", "BA", "CAT", "LMT", "RTX", "NOC", "GD", "LHX", "HII", "T", "NFLX", "SPOT", "AMD", "CRM", "ORCL", "PLTR", "SMCI", "AVGO", "TSM", "SNOW", "ANET", "VRT", "ARM", "PANW"];
export const PAPER_CRYPTO_SYMBOLS = ["BTC", "ETH", "SOL", "ADA", "DOT"];
export function isOfferedPaperAsset(symbol,type) {return (type==='stock'?PAPER_STOCK_SYMBOLS:type==='crypto'?PAPER_CRYPTO_SYMBOLS:[]).includes(symbol);}
