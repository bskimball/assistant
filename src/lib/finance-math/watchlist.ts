import type { CategoryGroup, Transaction, WatchlistId } from "@/lib/domain";
import { isWatchlistId, transactionMerchant, WATCHLIST_IDS, WATCHLIST_META } from "@/lib/domain";
import { dollars, normalizeMerchant } from "./_shared";
import { transactionsForMonth } from "./budget";

/* ---------- Spending Watchlist (problem-area analysis) ---------- */

export type WatchlistRuleValue = {
  group?: CategoryGroup;
  watchlistId?: WatchlistId | null;
};

/** Built-in merchant keywords for auto watchlist assignment (deterministic). */
export const WATCHLIST_KEYWORDS: { id: WatchlistId; keywords: string[] }[] = [
  {
    id: "coffee_snacks",
    keywords: [
      "starbucks",
      "dunkin",
      "dutch bros",
      "peets",
      "peet's",
      "tim hortons",
      "7-eleven",
      "7 eleven",
      "wawa",
      "sheetz",
      "circle k",
    ],
  },
  {
    id: "dining",
    keywords: [
      "doordash",
      "uber eats",
      "grubhub",
      "postmates",
      "seamless",
      "restaurant",
      "mcdonald",
      "chipotle",
      "wendy",
      "taco bell",
      "burger king",
      "chick-fil-a",
      "chickfila",
      "panera",
      "subway",
      "olive garden",
      "applebee",
      "ihop",
      "denny",
      "pizza",
      "sushi",
      "steakhouse",
      "cafe",
      "coffee shop",
    ],
  },
  {
    id: "subscriptions",
    keywords: [
      "netflix",
      "hulu",
      "spotify",
      "disney+",
      "disney plus",
      "hbo",
      "max.com",
      "youtube premium",
      "prime video",
      "apple.com/bill",
      "icloud",
      "adobe",
      "microsoft 365",
      "planet fitness",
      "peloton",
      "gym membership",
      "patreon",
      "onlyfans",
      "chatgpt",
      "openai",
      "anthropic",
      "cursor",
    ],
  },
  {
    id: "shopping",
    keywords: [
      "amazon",
      "amzn",
      "ebay",
      "etsy",
      "best buy",
      "bestbuy",
      "nike",
      "//www.amazon",
      "apple store",
      "ebay o",
    ],
  },
  {
    id: "groceries",
    keywords: [
      "grocery",
      "groceries",
      "safeway",
      "kroger",
      "wegmans",
      "aldi",
      "costco",
      "walmart",
      "target",
      "trader joe",
      "whole foods",
      "publix",
      "food lion",
      "harris teeter",
      "sprouts",
      "lidl",
      "meijer",
    ],
  },
];

export function ruleWatchlistFor(
  description: string,
  rules: Record<string, WatchlistRuleValue | CategoryGroup>,
): WatchlistId | null | undefined {
  const norm = normalizeMerchant(description);
  if (!norm) return undefined;
  for (const [key, value] of Object.entries(rules)) {
    if (!norm.includes(key)) continue;
    // Legacy group-only rules don't answer watchlist — keep looking / fall through.
    if (typeof value === "string") continue;
    if (value.watchlistId === null) return null;
    if (isWatchlistId(value.watchlistId)) return value.watchlistId;
  }
  return undefined;
}

export function keywordWatchlistFor(description: string): WatchlistId | null {
  const haystack = description.toLowerCase();
  for (const { id, keywords } of WATCHLIST_KEYWORDS) {
    if (keywords.some((k) => haystack.includes(k))) return id;
  }
  return null;
}

/**
 * Auto-assign a watchlist label. Priority: user lock → learned rule → keywords.
 * Returns null when rules explicitly clear the label; undefined when no match.
 */
export function assignWatchlistId(
  description: string,
  rules: Record<string, WatchlistRuleValue | CategoryGroup>,
  current?: Pick<Transaction, "watchlistId" | "watchlistSource">,
): { watchlistId?: WatchlistId; watchlistSource?: Transaction["watchlistSource"] } | null {
  if (current?.watchlistSource === "user") return null;
  if (current?.watchlistId && current.watchlistSource) return null;

  const fromRule = ruleWatchlistFor(description, rules);
  if (fromRule === null) {
    return { watchlistId: undefined, watchlistSource: "rule" };
  }
  if (fromRule) {
    return { watchlistId: fromRule, watchlistSource: "rule" };
  }

  const fromKeyword = keywordWatchlistFor(description);
  if (fromKeyword) {
    return { watchlistId: fromKeyword, watchlistSource: "keyword" };
  }
  return null;
}

export function withAutoWatchlist<
  T extends Pick<
    Transaction,
    | "merchant"
    | "category"
    | "notes"
    | "watchlistId"
    | "watchlistSource"
    | "categoryGroup"
    | "amount"
  >,
>(transaction: T, rules: Record<string, WatchlistRuleValue | CategoryGroup>): T {
  // Only problem-area spend; income/transfers stay off the watchlist.
  // Never mutates categoryGroup / amount — watchlist is orthogonal to 50/30/20.
  if (
    transaction.categoryGroup === "income" ||
    transaction.categoryGroup === "transfer" ||
    transaction.categoryGroup === "savings" ||
    transaction.amount >= 0
  ) {
    return transaction;
  }
  const assigned = assignWatchlistId(transactionMerchant(transaction), rules, transaction);
  if (!assigned) return transaction;
  if (
    assigned.watchlistId === transaction.watchlistId &&
    assigned.watchlistSource === transaction.watchlistSource
  ) {
    return transaction;
  }
  // Explicit field writes only — do not reshape the rest of the transaction.
  if (!assigned.watchlistId) {
    if (
      transaction.watchlistId === undefined &&
      transaction.watchlistSource === assigned.watchlistSource
    ) {
      return transaction;
    }
    const next = { ...transaction, watchlistSource: assigned.watchlistSource };
    delete (next as { watchlistId?: WatchlistId }).watchlistId;
    return next;
  }
  return {
    ...transaction,
    watchlistId: assigned.watchlistId,
    watchlistSource: assigned.watchlistSource,
  };
}

export type WatchlistMonthRow = {
  id: WatchlistId;
  label: string;
  shortLabel: string;
  spent: number;
  count: number;
};

/** This-month watchlist totals (descending by spend). Omits empty labels. */
export function rollupWatchlistMonth(
  transactions: Transaction[],
  month: string,
): WatchlistMonthRow[] {
  const totals: Record<WatchlistId, { spent: number; count: number }> = {
    groceries: { spent: 0, count: 0 },
    dining: { spent: 0, count: 0 },
    shopping: { spent: 0, count: 0 },
    subscriptions: { spent: 0, count: 0 },
    coffee_snacks: { spent: 0, count: 0 },
  };
  for (const t of transactionsForMonth(transactions, month)) {
    if (t.deletedAt || t.amount >= 0 || !t.watchlistId) continue;
    if (!isWatchlistId(t.watchlistId)) continue;
    // Absolute outflow — watchlist is problem-area cash, not 50/30/20 plan math.
    totals[t.watchlistId].spent += Math.abs(t.amount);
    totals[t.watchlistId].count += 1;
  }
  return WATCHLIST_IDS.map((id) => ({
    id,
    label: WATCHLIST_META[id].label,
    shortLabel: WATCHLIST_META[id].shortLabel,
    spent: dollars(totals[id].spent),
    count: totals[id].count,
  }))
    .filter((row) => row.spent > 0 || row.count > 0)
    .sort((a, b) => b.spent - a.spent || a.label.localeCompare(b.label));
}
