import type { CategoryGroup, Subscription, Transaction } from "@/lib/domain";
import { recurringBudgetBucket, recurringKindOf } from "@/lib/domain";
import { recurringMatchesTransaction } from "@/lib/finance-math";
import { completeJSON, getGrokApiKey, getGrokJsonModel } from "@/server/adapters/ai";
import {
  loadCategoryRulesImpl,
  loadSubscriptionsImpl,
  loadTransactionsImpl,
  updateTransactionsImpl,
} from "@/server/domain-impl";
import { normalizeMerchant, ruleGroupFor } from "@/server/finance-parse";
import { getDomainStore } from "@/server/store";

export interface AiMatchCacheEntry {
  group?: CategoryGroup;
  subId?: string | null;
  confidence: number;
  source: "ai" | "user";
  rejectedSubIds?: string[];
  updatedAt: number;
}

export interface AiMatchCache {
  entries: Record<string, AiMatchCacheEntry>;
  updatedAt: number;
}

interface AiMatchResult {
  i: number;
  group: string;
  subId: string | null;
  confidence: number;
}

interface AiMatchResponse {
  results: AiMatchResult[];
}

export interface EnrichStats {
  scanned: number;
  cacheHits: number;
  aiCalls: number;
  linked: number;
  suggested: number;
  recategorized: number;
}

export interface EnrichOptions {
  manual: boolean;
}

export interface RescanStats extends EnrichStats {
  merchantsScanned: number;
  merchantsRemaining: number;
}

export interface ApplyDecisionResult {
  transaction: Transaction;
  linked: boolean;
  suggested: boolean;
  recategorized: boolean;
}

export const AI_CACHE_REF = "finance-ai-cache.json";
export const AI_CACHE_MAX_ENTRIES = 500;
export const MAX_AI_CHARGES = 40;
export const MAX_RESCAN_MERCHANTS = 150;
export const AUTO_LINK_CONFIDENCE = 0.8;
export const SUGGEST_CONFIDENCE = 0.5;
export const CACHE_GROUP_CONFIDENCE = 0.6;

const CATEGORY_GROUPS = new Set<CategoryGroup>(["needs", "wants", "savings", "income", "transfer"]);

export const SYSTEM_PROMPT =
  "You are a precise bank-transaction classifier for a household budget app. Return strictly valid minified JSON only. No prose, no markdown.";

function emptyCache(): AiMatchCache {
  return { entries: {}, updatedAt: Date.now() };
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, n));
}

function isCategoryGroup(value: unknown): value is CategoryGroup {
  return typeof value === "string" && CATEGORY_GROUPS.has(value as CategoryGroup);
}

function descriptorFor(t: Pick<Transaction, "category" | "notes">): string {
  return t.category || t.notes || "";
}

export function cacheKeyFor(t: Pick<Transaction, "category" | "notes">): string {
  return normalizeMerchant(descriptorFor(t));
}

function activeSubscriptionMap(subs: Subscription[]): Map<string, Subscription> {
  return new Map(
    subs.filter((s) => !s.deletedAt && s.status === "active").map((s) => [s.id, s] as const),
  );
}

function amountGuardPasses(t: Transaction, sub: Subscription): boolean {
  return Math.abs(Math.abs(t.amount) - sub.amount) <= Math.max(1, sub.amount * 0.25);
}

function canAutoLinkGroup(group: CategoryGroup | undefined, sub: Subscription): boolean {
  return group !== "transfer" || recurringKindOf(sub) === "loan";
}

function emptyRescanStats(): RescanStats {
  return {
    scanned: 0,
    cacheHits: 0,
    aiCalls: 0,
    linked: 0,
    suggested: 0,
    recategorized: 0,
    merchantsScanned: 0,
    merchantsRemaining: 0,
  };
}

function confidentCacheEntry(entry: AiMatchCacheEntry | undefined): entry is AiMatchCacheEntry {
  return !!entry && (entry.source === "user" || entry.confidence >= CACHE_GROUP_CONFIDENCE);
}

function isRescanCandidate(t: Transaction): boolean {
  return (
    !t.deletedAt &&
    t.amount < 0 &&
    !t.recurringId &&
    t.recurringMatchSource !== "user" &&
    t.categoryGroup !== "transfer" &&
    t.categoryGroup !== "income"
  );
}

/**
 * Persist an unambiguous rules-based recurring match. Display-time reconciliation
 * uses the same matcher, so saving it here keeps the ledger and UI from disagreeing
 * across refreshes or deployments. Ambiguous matches remain unlinked for review.
 */
export function applyDeterministicRecurringMatch(
  transaction: Transaction,
  activeSubs: Subscription[],
): ApplyDecisionResult | null {
  const matches = activeSubs.filter((sub) => recurringMatchesTransaction(sub, transaction));
  if (matches.length !== 1) return null;

  const sub = matches[0];
  const group = recurringBudgetBucket(sub);
  return {
    transaction: {
      ...transaction,
      recurringId: sub.id,
      recurringSuggestedId: undefined,
      categoryGroup: group,
      updatedAt: Date.now(),
    },
    linked: true,
    suggested: false,
    recategorized: transaction.categoryGroup !== group,
  };
}

function countApplied(stats: EnrichStats, applied: ApplyDecisionResult): void {
  if (applied.linked) stats.linked++;
  if (applied.suggested) stats.suggested++;
  if (applied.recategorized) stats.recategorized++;
}

export function cachedGroupFor(description: string, cache: AiMatchCache): CategoryGroup | null {
  const entry = cache.entries[normalizeMerchant(description)];
  if (!entry?.group || entry.confidence < CACHE_GROUP_CONFIDENCE) return null;
  return entry.group;
}

export function pruneCache(cache: AiMatchCache, maxEntries = AI_CACHE_MAX_ENTRIES): AiMatchCache {
  const entries = Object.entries(cache.entries);
  if (entries.length <= maxEntries) return cache;
  const keep = new Set(
    entries
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, maxEntries)
      .map(([key]) => key),
  );
  return {
    ...cache,
    entries: Object.fromEntries(entries.filter(([key]) => keep.has(key))),
  };
}

export function buildMatchPrompt(charges: Transaction[], subs: Subscription[]): string {
  const subLines = subs.length
    ? subs
        .map(
          (s) =>
            `- ${s.id} | ${s.name} | ${recurringKindOf(s)} | $${s.amount.toFixed(2)} | ${s.cadence} | ${s.account || "-"}`,
        )
        .join("\n")
    : "- (none)";
  const chargeLines = charges
    .map((t, i) => {
      const amount = `${t.amount < 0 ? "-" : ""}$${Math.abs(t.amount).toFixed(2)}`;
      return `${i} | ${new Date(t.timestamp).toISOString().slice(0, 10)} | ${descriptorFor(t) || "-"} | ${amount} | ${t.account || "-"}`;
    })
    .join("\n");

  return `Classify each bank charge below and decide whether it is a payment for one of the household's known recurring items.

RECURRING ITEMS (id | name | kind | amount | cadence | account):
${subLines}

CHARGES (index | date | bank descriptor | amount | account):
${chargeLines}

For every charge return:
- "group": its 50/30/20 bucket - one of "needs","wants","savings","income","transfer". Credit-card payments, card payoffs, and moves between the household's own accounts are "transfer". Paychecks/deposits are "income". Investment/savings contributions are "savings".
- "subId": the id of the recurring item this charge pays, or null. Match on merchant semantics, not amount coincidence: a loan servicer's descriptor (e.g. "TRUIST IL PYMT") IS the loan payment even though the names differ; a bank/card payment (e.g. "SYNCHRONY BANK PAYMENT") is NOT a cleaning service or utility even if the amount is close. When unsure, use null.
- "confidence": 0 to 1 for the subId decision (use 0 when subId is null).

Reply with ONLY: {"results":[{"i":0,"group":"needs","subId":"sub-123","confidence":0.95},...]} - one entry per charge index.`;
}

export function applyAiDecision(
  txn: Transaction,
  decision: {
    group?: CategoryGroup;
    subId?: string | null;
    confidence: number;
    source: "ai" | "user";
    rejectedSubIds?: string[];
  },
  subsById: Map<string, Subscription>,
  rules: Record<string, CategoryGroup>,
): ApplyDecisionResult {
  let next = txn;
  let linked = false;
  let suggested = false;
  let recategorized = false;
  const confidence = clampConfidence(decision.confidence);
  const hasRule = ruleGroupFor(descriptorFor(txn), rules) !== null;

  if (decision.group && !hasRule && confidence >= CACHE_GROUP_CONFIDENCE) {
    if (next.categoryGroup !== decision.group) {
      next = { ...next, categoryGroup: decision.group, updatedAt: Date.now() };
      recategorized = true;
    }
  }

  if (!decision.subId || decision.rejectedSubIds?.includes(decision.subId)) {
    return { transaction: next, linked, suggested, recategorized };
  }

  const sub = subsById.get(decision.subId);
  if (!sub) return { transaction: next, linked, suggested, recategorized };

  const autoEligible =
    confidence >= AUTO_LINK_CONFIDENCE &&
    amountGuardPasses(txn, sub) &&
    canAutoLinkGroup(decision.group, sub);

  if (autoEligible) {
    next = {
      ...next,
      recurringId: sub.id,
      recurringMatchSource: decision.source,
      recurringMatchConfidence: decision.source === "ai" ? confidence : undefined,
      recurringSuggestedId: undefined,
      updatedAt: Date.now(),
    };
    linked = true;
  } else if (confidence >= SUGGEST_CONFIDENCE) {
    next = {
      ...next,
      recurringSuggestedId: sub.id,
      recurringMatchConfidence: decision.source === "ai" ? confidence : undefined,
      updatedAt: Date.now(),
    };
    suggested = true;
  }

  return { transaction: next, linked, suggested, recategorized };
}

export function resolveFromCache(
  txn: Transaction,
  cache: AiMatchCache,
  subsById: Map<string, Subscription>,
  rules: Record<string, CategoryGroup>,
): ApplyDecisionResult | null {
  const entry = cache.entries[cacheKeyFor(txn)];
  if (!entry) return null;
  return applyAiDecision(
    txn,
    {
      group: entry.group,
      subId: entry.subId,
      confidence: entry.confidence,
      source: entry.source,
      rejectedSubIds: entry.rejectedSubIds,
    },
    subsById,
    rules,
  );
}

export function validateAiResults(
  response: AiMatchResponse,
  charges: Transaction[],
  subsById: Map<string, Subscription>,
): Map<string, { group?: CategoryGroup; subId: string | null; confidence: number }> {
  const out = new Map<
    string,
    { group?: CategoryGroup; subId: string | null; confidence: number }
  >();
  if (!Array.isArray(response?.results)) return out;
  for (const raw of response.results) {
    if (!Number.isInteger(raw?.i) || raw.i < 0 || raw.i >= charges.length) continue;
    const txn = charges[raw.i];
    const group = isCategoryGroup(raw.group) ? raw.group : undefined;
    const subId = raw.subId && subsById.has(raw.subId) ? raw.subId : null;
    out.set(txn.id, { group, subId, confidence: clampConfidence(raw.confidence) });
  }
  return out;
}

export function mergeAiCacheEntry(
  current: AiMatchCacheEntry | undefined,
  next: { group?: CategoryGroup; subId: string | null; confidence: number; updatedAt: number },
): AiMatchCacheEntry {
  if (current?.source === "user") return current;
  return {
    group: next.group,
    subId: next.subId,
    confidence: next.confidence,
    source: "ai",
    rejectedSubIds: current?.rejectedSubIds,
    updatedAt: next.updatedAt,
  };
}

export async function loadAiMatchCache(): Promise<AiMatchCache> {
  const store = await getDomainStore({ shared: true });
  return (await store.ref.get<AiMatchCache>(AI_CACHE_REF)) ?? emptyCache();
}

export async function rememberUserRecurringLink(txn: Transaction, subId: string): Promise<void> {
  const key = cacheKeyFor(txn);
  if (!key) return;
  const now = Date.now();
  const store = await getDomainStore({ shared: true });
  await store.ref.update<AiMatchCache>(AI_CACHE_REF, (current) => {
    const cache = current ?? emptyCache();
    const previous = cache.entries[key];
    return pruneCache({
      entries: {
        ...cache.entries,
        [key]: {
          group: previous?.group,
          subId,
          confidence: 1,
          source: "user",
          rejectedSubIds: previous?.rejectedSubIds?.filter((id) => id !== subId),
          updatedAt: now,
        },
      },
      updatedAt: now,
    });
  });
}

export async function rememberUserRecurringUnlink(
  txn: Transaction,
  rejectedSubId?: string,
): Promise<void> {
  const key = cacheKeyFor(txn);
  if (!key || !rejectedSubId) return;
  const now = Date.now();
  const store = await getDomainStore({ shared: true });
  await store.ref.update<AiMatchCache>(AI_CACHE_REF, (current) => {
    const cache = current ?? emptyCache();
    const previous = cache.entries[key];
    const rejected = Array.from(new Set([...(previous?.rejectedSubIds ?? []), rejectedSubId]));
    return pruneCache({
      entries: {
        ...cache.entries,
        [key]: {
          group: previous?.group,
          subId: previous?.subId === rejectedSubId ? null : (previous?.subId ?? null),
          confidence: previous?.confidence ?? 1,
          source: "user",
          rejectedSubIds: rejected,
          updatedAt: now,
        },
      },
      updatedAt: now,
    });
  });
}

export async function rescanUnmatchedCharges(opts: EnrichOptions): Promise<RescanStats> {
  const stats = emptyRescanStats();

  try {
    const [{ transactions }, { subscriptions }, { rules }, cache] = await Promise.all([
      loadTransactionsImpl(),
      loadSubscriptionsImpl(),
      loadCategoryRulesImpl(),
      loadAiMatchCache(),
    ]);
    const activeSubs = subscriptions.filter((s) => !s.deletedAt && s.status === "active");
    const subsById = activeSubscriptionMap(activeSubs);
    const candidateGroups = new Map<string, Transaction[]>();

    for (const txn of transactions) {
      if (!isRescanCandidate(txn)) continue;
      const key = cacheKeyFor(txn);
      if (!key) continue;
      const group = candidateGroups.get(key) ?? [];
      group.push(txn);
      candidateGroups.set(key, group);
    }

    stats.scanned = [...candidateGroups.values()].reduce((sum, group) => sum + group.length, 0);
    if (!candidateGroups.size) return stats;

    for (const group of candidateGroups.values()) {
      group.sort((a, b) => b.timestamp - a.timestamp);
    }

    const updates = new Map<string, Transaction>();
    const cacheEntries: Record<
      string,
      { group?: CategoryGroup; subId: string | null; confidence: number; updatedAt: number }
    > = {};
    const needsModel: { key: string; charges: Transaction[]; representative: Transaction }[] = [];

    for (const [key, charges] of candidateGroups.entries()) {
      const cachedEntry = cache.entries[key];
      if (confidentCacheEntry(cachedEntry)) {
        stats.merchantsScanned++;
        cacheEntries[key] = {
          group: cachedEntry.group,
          subId: cachedEntry.subId ?? null,
          confidence: cachedEntry.confidence,
          updatedAt: Date.now(),
        };
        for (const charge of charges) {
          const applied = resolveFromCache(charge, cache, subsById, rules);
          if (!applied) continue;
          stats.cacheHits++;
          countApplied(stats, applied);
          if (applied.transaction !== charge) updates.set(charge.id, applied.transaction);
        }
      } else {
        const unresolved: Transaction[] = [];
        for (const charge of charges) {
          const applied = applyDeterministicRecurringMatch(charge, activeSubs);
          if (!applied) {
            unresolved.push(charge);
            continue;
          }
          countApplied(stats, applied);
          updates.set(charge.id, applied.transaction);
        }
        if (unresolved.length) {
          needsModel.push({ key, charges: unresolved, representative: unresolved[0] });
        }
      }
    }

    needsModel.sort((a, b) => b.representative.timestamp - a.representative.timestamp);
    const apiKey = await getGrokApiKey();
    const modelGroups = apiKey ? needsModel.slice(0, MAX_RESCAN_MERCHANTS) : [];
    stats.merchantsRemaining = needsModel.length - modelGroups.length;

    for (let i = 0; i < modelGroups.length; i += MAX_AI_CHARGES) {
      const batchGroups = modelGroups.slice(i, i + MAX_AI_CHARGES);
      const batchCharges = batchGroups.map((group) => group.representative);
      if (!batchCharges.length) continue;

      stats.aiCalls++;
      const parsed = await completeJSON<AiMatchResponse>(apiKey!, {
        model: await getGrokJsonModel(),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildMatchPrompt(batchCharges, activeSubs) },
        ],
        temperature: 0.1,
        maxTokens: 2000,
        timeoutMs: opts.manual ? 25_000 : 45_000,
      });
      const decisions = validateAiResults(parsed, batchCharges, subsById);
      const now = Date.now();

      for (const group of batchGroups) {
        const decision = decisions.get(group.representative.id);
        if (!decision) continue;

        const rejectedSubIds = cache.entries[group.key]?.rejectedSubIds;
        cacheEntries[group.key] = { ...decision, updatedAt: now };
        stats.merchantsScanned++;

        for (const charge of group.charges) {
          const applied = applyAiDecision(
            charge,
            { ...decision, source: "ai", rejectedSubIds },
            subsById,
            rules,
          );
          countApplied(stats, applied);
          if (applied.transaction !== charge) updates.set(charge.id, applied.transaction);
        }
      }
    }

    if (updates.size) {
      await updateTransactionsImpl((transactions) =>
        transactions.map((t) => updates.get(t.id) ?? t),
      );
    }

    if (Object.keys(cacheEntries).length) {
      const store = await getDomainStore({ shared: true });
      await store.ref.update<AiMatchCache>(AI_CACHE_REF, (current) => {
        const cache = current ?? emptyCache();
        const entries = { ...cache.entries };
        for (const [key, entry] of Object.entries(cacheEntries)) {
          entries[key] = mergeAiCacheEntry(entries[key], entry);
        }
        return pruneCache({ entries, updatedAt: Date.now() });
      });
    }

    return stats;
  } catch (err) {
    console.warn("[finance] AI rescan failed", err);
    return { ...stats, aiCalls: stats.aiCalls };
  }
}

export async function enrichNewTransactions(
  newTxns: Transaction[],
  opts: EnrichOptions,
): Promise<EnrichStats> {
  const stats: EnrichStats = {
    scanned: newTxns.length,
    cacheHits: 0,
    aiCalls: 0,
    linked: 0,
    suggested: 0,
    recategorized: 0,
  };

  try {
    const charges = newTxns.filter((t) => !t.deletedAt && t.amount < 0);
    if (!charges.length) return stats;

    const [{ subscriptions }, { rules }, cache] = await Promise.all([
      loadSubscriptionsImpl(),
      loadCategoryRulesImpl(),
      loadAiMatchCache(),
    ]);
    const activeSubs = subscriptions.filter((s) => !s.deletedAt && s.status === "active");
    const subsById = activeSubscriptionMap(activeSubs);
    const updates = new Map<string, Transaction>();
    const aiCandidates: Transaction[] = [];

    for (const charge of charges) {
      const cached = resolveFromCache(charge, cache, subsById, rules);
      if (cached) {
        stats.cacheHits++;
        if (cached.linked) stats.linked++;
        if (cached.suggested) stats.suggested++;
        if (cached.recategorized) stats.recategorized++;
        if (cached.transaction !== charge) updates.set(charge.id, cached.transaction);
        continue;
      }
      const deterministic = applyDeterministicRecurringMatch(charge, activeSubs);
      if (deterministic) {
        countApplied(stats, deterministic);
        updates.set(charge.id, deterministic.transaction);
        continue;
      }
      aiCandidates.push(charge);
    }

    const apiKey = await getGrokApiKey();
    const aiBatch = aiCandidates.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_AI_CHARGES);
    const aiCacheEntries: Record<
      string,
      { group?: CategoryGroup; subId: string | null; confidence: number; updatedAt: number }
    > = {};

    if (apiKey && aiBatch.length) {
      stats.aiCalls = 1;
      const parsed = await completeJSON<AiMatchResponse>(apiKey, {
        model: await getGrokJsonModel(),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildMatchPrompt(aiBatch, activeSubs) },
        ],
        temperature: 0.1,
        maxTokens: 2000,
        timeoutMs: opts.manual ? 25_000 : 45_000,
      });
      const decisions = validateAiResults(parsed, aiBatch, subsById);
      const now = Date.now();
      for (const charge of aiBatch) {
        const decision = decisions.get(charge.id);
        if (!decision) continue;
        const key = cacheKeyFor(charge);
        if (key) aiCacheEntries[key] = { ...decision, updatedAt: now };
        const rejectedSubIds = key ? cache.entries[key]?.rejectedSubIds : undefined;
        const applied = applyAiDecision(
          charge,
          { ...decision, source: "ai", rejectedSubIds },
          subsById,
          rules,
        );
        if (applied.linked) stats.linked++;
        if (applied.suggested) stats.suggested++;
        if (applied.recategorized) stats.recategorized++;
        if (applied.transaction !== charge) updates.set(charge.id, applied.transaction);
      }
    }

    if (updates.size) {
      await updateTransactionsImpl((transactions) =>
        transactions.map((t) => updates.get(t.id) ?? t),
      );
    }

    if (Object.keys(aiCacheEntries).length) {
      const store = await getDomainStore({ shared: true });
      await store.ref.update<AiMatchCache>(AI_CACHE_REF, (current) => {
        const cache = current ?? emptyCache();
        const entries = { ...cache.entries };
        for (const [key, entry] of Object.entries(aiCacheEntries)) {
          entries[key] = mergeAiCacheEntry(entries[key], entry);
        }
        return pruneCache({ entries, updatedAt: Date.now() });
      });
    }

    return stats;
  } catch (err) {
    console.warn("[finance] AI enrich failed", err);
    return { ...stats, aiCalls: stats.aiCalls };
  }
}
