/**
 * Live stock quote adapter (ADR-016).
 *
 * Sources current prices from Yahoo Finance's public v8 chart endpoint — no API
 * key, no dependency. One symbol per request, fanned out with allSettled so one
 * bad symbol never sinks the batch.
 *
 * Like every external path in this app, callers must degrade gracefully: this
 * returns a partial map (only the symbols that resolved), so anything missing —
 * non-tickers like a "401K" balance, typos, delisted names, a Yahoo hiccup —
 * falls back to the user's last manually entered price at the call site.
 */

// Yahoo occasionally 429s requests without a browser-ish UA; mirror one.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

/** Fetch a single symbol's current price, or null if it can't be resolved. */
async function fetchOne(symbol: string, signal: AbortSignal): Promise<number | null> {
  const sym = encodeURIComponent(symbol.trim().toUpperCase());
  for (const host of HOSTS) {
    try {
      const resp = await fetch(`https://${host}/v8/finance/chart/${sym}?interval=1d&range=1d`, {
        headers: { "User-Agent": UA },
        signal,
      });
      if (!resp.ok) continue;
      const data: any = await resp.json();
      const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (Number.isFinite(price) && price > 0) return price;
    } catch {
      // try the next host, then give up (caller falls back to manual price)
    }
  }
  return null;
}

/**
 * Fetch current prices for the given symbols.
 * Returns an UPPERCASE-symbol → price map containing only resolvable symbols.
 * Never throws: failures yield a missing key, not an error.
 */
export async function fetchQuotes(symbols: string[]): Promise<Record<string, number>> {
  const wanted = [...new Set(symbols.map((s) => s.trim()).filter(Boolean))];
  if (!wanted.length) return {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const results = await Promise.all(
      wanted.map(async (s) => [s.toUpperCase(), await fetchOne(s, controller.signal)] as const),
    );
    const out: Record<string, number> = {};
    for (const [sym, price] of results) {
      if (price !== null) out[sym] = price;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}
