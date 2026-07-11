import { describe, expect, it } from "vitest";
import type { Subscription, Transaction, UserProfile } from "@/lib/domain";
import {
  addUnseenRecurringToBuckets,
  buildBudgetInsight,
  analyzeRecurringHealth,
  buildCashFlowProjection,
  calculateEmergencyFund,
  detectOneTimeCandidates,
  detectRecurringCandidates,
  fallbackFinanceAdvice,
  inferCadence,
  normalizeMerchant,
  recurringItemsForMonth,
  recurringMatchesTransaction,
  rollupMonth,
  simulateDebtPayoff,
  transactionsBeforeMonth,
  transactionsForMonth,
} from "@/lib/finance-math";

const jan = Date.UTC(2026, 0, 15);
const feb = Date.UTC(2026, 1, 1);

function txn(partial: Partial<Transaction>): Transaction {
  return {
    id: partial.id ?? "txn",
    createdAt: partial.createdAt ?? jan,
    timestamp: partial.timestamp ?? jan,
    type: partial.type ?? (partial.amount && partial.amount > 0 ? "deposit" : "withdrawal"),
    amount: partial.amount ?? -10,
    currency: partial.currency ?? "USD",
    category: partial.category ?? "Vendor",
    categoryGroup: partial.categoryGroup ?? "wants",
    account: partial.account,
    notes: partial.notes,
    excludeFromBudget: partial.excludeFromBudget,
    recurringId: partial.recurringId,
    recurringMatchSource: partial.recurringMatchSource,
    recurringMatchConfidence: partial.recurringMatchConfidence,
    recurringSuggestedId: partial.recurringSuggestedId,
    oneTimeSuggestionDismissed: partial.oneTimeSuggestionDismissed,
    source: partial.source,
    deletedAt: partial.deletedAt,
  };
}

function sub(partial: Partial<Subscription>): Subscription {
  return {
    id: partial.id ?? "sub",
    createdAt: partial.createdAt ?? jan,
    name: partial.name ?? "Netflix",
    amount: partial.amount ?? 15,
    cadence: partial.cadence ?? "monthly",
    status: partial.status ?? "active",
    source: partial.source ?? "manual",
    account: partial.account,
    kind: partial.kind,
    group: partial.group,
    lastSeen: partial.lastSeen,
    balance: partial.balance,
    apr: partial.apr,
    matchHints: partial.matchHints,
  };
}

describe("finance math", () => {
  it("matches recurring subscriptions by normalized name or account plus amount", () => {
    expect(
      recurringMatchesTransaction(
        sub({ name: "Netflix", amount: 15 }),
        txn({ amount: -15.49, category: "NETFLIX.COM" }),
      ),
    ).toBe(true);
    expect(
      recurringMatchesTransaction(
        sub({ name: "Gym", amount: 20, account: "Checking" }),
        txn({ amount: -20, category: "Unknown charge", account: "checking" }),
      ),
    ).toBe(true);
    expect(
      recurringMatchesTransaction(
        sub({ name: "Netflix", amount: 15 }),
        txn({ amount: -25, category: "NETFLIX.COM" }),
      ),
    ).toBe(false);
  });

  it("matches recurring subscriptions by raw descriptor match hints plus amount", () => {
    expect(
      recurringMatchesTransaction(
        sub({ name: "Jeep payment", amount: 418, account: "Manual", matchHints: ["truist"] }),
        txn({ amount: -418.5, category: "TRUIST IL PYMT", account: "Checking" }),
      ),
    ).toBe(true);
  });

  it("matches variable monthly bills inside the wider bill tolerance", () => {
    expect(
      recurringMatchesTransaction(
        sub({ name: "Comcast Xfinity", amount: 186, kind: "bill" }),
        txn({ amount: -208, category: "Comcast Xfinity" }),
      ),
    ).toBe(true);
  });

  it("keeps loan matching tight when payment amounts drift", () => {
    expect(
      recurringMatchesTransaction(
        sub({ name: "Jeep payment", amount: 418, kind: "loan" }),
        txn({ amount: -500, category: "Jeep payment" }),
      ),
    ).toBe(false);
  });

  it("does not match recurring subscriptions by hint when the amount is outside tolerance", () => {
    expect(
      recurringMatchesTransaction(
        sub({ name: "Jeep payment", amount: 418, matchHints: ["truist"] }),
        txn({ amount: -500, category: "TRUIST IL PYMT" }),
      ),
    ).toBe(false);
  });

  it("lets explicit recurring links win over amount and name heuristics", () => {
    const subA = sub({ id: "subA", name: "Jeep payment", amount: 418 });
    const subB = sub({ id: "subB", name: "Netflix", amount: 999 });
    const linked = txn({
      amount: -999,
      category: "TOTALLY UNRELATED",
      recurringId: "subA",
      recurringMatchSource: "ai",
    });

    expect(recurringMatchesTransaction(subA, linked)).toBe(true);
    expect(recurringMatchesTransaction(subB, linked)).toBe(false);
  });

  it("honors explicit user unlink veto before heuristic matching", () => {
    expect(
      recurringMatchesTransaction(
        sub({ name: "Jeep payment", amount: 418, account: "Manual", matchHints: ["truist"] }),
        txn({
          amount: -418.5,
          category: "TRUIST IL PYMT",
          account: "Checking",
          recurringMatchSource: "user",
        }),
      ),
    ).toBe(false);
  });

  it("never matches deposits even with an explicit recurring id", () => {
    expect(
      recurringMatchesTransaction(
        sub({ id: "subA", name: "Payroll", amount: 1000 }),
        txn({ amount: 1000, category: "Payroll", recurringId: "subA" }),
      ),
    ).toBe(false);
  });

  it("keeps existing recurring match behavior when match hints are undefined", () => {
    expect(
      recurringMatchesTransaction(
        sub({ name: "Gym", amount: 20, account: "Checking" }),
        txn({ amount: -20, category: "Unknown charge", account: "checking" }),
      ),
    ).toBe(true);
    expect(
      recurringMatchesTransaction(
        sub({ name: "Gym", amount: 20 }),
        txn({ amount: -20, category: "Unknown charge", account: "checking" }),
      ),
    ).toBe(false);
  });

  it("classifies weekly/monthly/annual cadences and rejects irregular gaps", () => {
    expect(inferCadence(7)).toBe("weekly");
    expect(inferCadence(30)).toBe("monthly");
    expect(inferCadence(31)).toBe("monthly");
    expect(inferCadence(365)).toBe("annual");
    expect(inferCadence(3)).toBeNull();
    expect(inferCadence(15)).toBeNull();
    expect(inferCadence(100)).toBeNull();
  });

  it("normalizes merchant descriptors by stripping store ids and noise", () => {
    expect(normalizeMerchant("STARBUCKS #1234 SEATTLE")).toBe(
      normalizeMerchant("STARBUCKS #5678 SEATTLE"),
    );
    expect(normalizeMerchant("CPP *PURE FITNESS 98765")).toBe("cpp pure fitness");
  });

  it("detects three same-amount gym memberships as one monthly candidate", () => {
    // Three household members billed the same day each month — short gaps
    // between same-day charges must not poison the monthly cadence.
    const now = Date.UTC(2026, 3, 1);
    const day0 = Date.UTC(2026, 0, 5);
    const day30 = Date.UTC(2026, 1, 5);
    const day60 = Date.UTC(2026, 2, 5);
    const charges = [day0, day30, day60].flatMap((ts, monthIdx) =>
      [0, 1, 2].map((member) =>
        txn({
          id: `gym-${monthIdx}-${member}`,
          timestamp: ts + member * 60_000,
          amount: -49.99,
          category: "CPP PURE FITNESS",
          categoryGroup: "wants",
        }),
      ),
    );
    const candidates = detectRecurringCandidates({
      transactions: charges,
      subscriptions: [],
      now,
      lookbackDays: 120,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      cadence: "monthly",
      amount: 49.99,
      source: "detected",
    });
    expect(candidates[0].name.toLowerCase()).toContain("pure");
  });

  it("detects three differently-priced gym memberships as separate candidates", () => {
    const now = Date.UTC(2026, 3, 1);
    const months = [Date.UTC(2026, 0, 5), Date.UTC(2026, 1, 5), Date.UTC(2026, 2, 5)];
    const prices = [45, 35, 25]; // Me / Sophia / Theo — well apart
    const charges = months.flatMap((ts, monthIdx) =>
      prices.map((price, member) =>
        txn({
          id: `gym-${monthIdx}-${member}`,
          timestamp: ts + member * 60_000,
          amount: -price,
          category: "Cpp Pure Fitness",
          categoryGroup: "wants",
        }),
      ),
    );
    const candidates = detectRecurringCandidates({
      transactions: charges,
      subscriptions: [],
      now,
      lookbackDays: 120,
    });
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.amount).sort((a, b) => b - a)).toEqual([45, 35, 25]);
    expect(candidates.every((c) => c.cadence === "monthly")).toBe(true);
    // Same merchant, multiple streams → amount disambiguates the Detect labels.
    expect(candidates.every((c) => c.name.includes("$"))).toBe(true);
  });

  it("detects Progressive Auto and Boat as separate Prog Northern streams", () => {
    // Real-world pattern: same ACH descriptor, premiums within a loose 15% band
    // but on different days of the month. Merging them yields ~15-day gaps and
    // kills monthly cadence — they must cluster by amount first.
    const now = Date.UTC(2026, 3, 1);
    const autoDays = [Date.UTC(2026, 0, 3), Date.UTC(2026, 1, 3), Date.UTC(2026, 2, 3)];
    const boatDays = [Date.UTC(2026, 0, 17), Date.UTC(2026, 1, 17), Date.UTC(2026, 2, 17)];
    const charges = [
      ...autoDays.map((ts, i) =>
        txn({
          id: `auto-${i}`,
          timestamp: ts,
          amount: -198.4,
          category: "PROG NORTHERN",
          categoryGroup: "needs",
        }),
      ),
      ...boatDays.map((ts, i) =>
        txn({
          id: `boat-${i}`,
          timestamp: ts,
          amount: -176.2,
          category: "PROG NORTHERN",
          categoryGroup: "needs",
        }),
      ),
    ];
    const candidates = detectRecurringCandidates({
      transactions: charges,
      subscriptions: [],
      now,
      lookbackDays: 120,
    });
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.amount).sort((a, b) => b - a)).toEqual([198.4, 176.2]);
    expect(candidates.every((c) => c.cadence === "monthly")).toBe(true);
    expect(candidates.every((c) => /prog northern/i.test(c.name))).toBe(true);
    expect(candidates.every((c) => c.name.includes("$"))).toBe(true);

    // Storing Auto as a bill must not swallow Boat (wide bill amount tolerance).
    const storedAuto = sub({
      id: "prog-auto",
      name: "Prog Northern · $198.40",
      amount: 198.4,
      kind: "bill",
      group: "needs",
    });
    const afterAuto = detectRecurringCandidates({
      transactions: charges,
      subscriptions: [storedAuto],
      now,
      lookbackDays: 120,
    });
    expect(afterAuto).toHaveLength(1);
    expect(afterAuto[0].amount).toBe(176.2);
  });

  it("does not re-detect a stored recurring item (match or linked charges)", () => {
    const now = Date.UTC(2026, 3, 1);
    const months = [Date.UTC(2026, 0, 10), Date.UTC(2026, 1, 10), Date.UTC(2026, 2, 10)];
    const netflix = sub({ id: "netflix", name: "Netflix", amount: 15.99, kind: "subscription" });
    const unlinked = months.map((ts, i) =>
      txn({
        id: `nf-${i}`,
        timestamp: ts,
        amount: -15.99,
        category: "NETFLIX.COM",
        categoryGroup: "wants",
      }),
    );
    expect(
      detectRecurringCandidates({
        transactions: unlinked,
        subscriptions: [netflix],
        now,
        lookbackDays: 120,
      }),
    ).toEqual([]);

    // Linked charges are excluded even if the stored name no longer matches.
    const linked = months.map((ts, i) =>
      txn({
        id: `nf-linked-${i}`,
        timestamp: ts,
        amount: -15.99,
        category: "NETFLIX.COM",
        categoryGroup: "wants",
        recurringId: "netflix",
      }),
    );
    expect(
      detectRecurringCandidates({
        transactions: linked,
        subscriptions: [netflix],
        now,
        lookbackDays: 120,
      }),
    ).toEqual([]);
  });

  it("still surfaces a second membership price after the first is stored", () => {
    const now = Date.UTC(2026, 3, 1);
    const months = [Date.UTC(2026, 0, 5), Date.UTC(2026, 1, 5), Date.UTC(2026, 2, 5)];
    const stored = sub({
      id: "gym-me",
      name: "Cpp Pure Fitness",
      amount: 45,
      kind: "subscription",
    });
    const charges = months.flatMap((ts, monthIdx) => [
      txn({
        id: `me-${monthIdx}`,
        timestamp: ts,
        amount: -45,
        category: "Cpp Pure Fitness",
        categoryGroup: "wants",
      }),
      txn({
        id: `sophia-${monthIdx}`,
        timestamp: ts + 60_000,
        amount: -30,
        category: "Cpp Pure Fitness",
        categoryGroup: "wants",
      }),
    ]);
    const candidates = detectRecurringCandidates({
      transactions: charges,
      subscriptions: [stored],
      now,
      lookbackDays: 120,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].amount).toBe(30);
    expect(candidates[0].cadence).toBe("monthly");
  });

  it("suppresses a stored item after a modest upward price hike", () => {
    const now = Date.UTC(2026, 3, 1);
    const months = [Date.UTC(2026, 0, 12), Date.UTC(2026, 1, 12), Date.UTC(2026, 2, 12)];
    const stored = sub({ id: "netflix", name: "Netflix", amount: 15.99 });
    // ~12% hike — outside the 5% match/stream band, but still an upward hike
    // so detect should not re-propose it as a brand-new recurring item.
    const hiked = months.map((ts, i) =>
      txn({
        id: `nf-${i}`,
        timestamp: ts,
        amount: -17.99,
        category: "NETFLIX.COM",
        categoryGroup: "wants",
      }),
    );
    expect(
      detectRecurringCandidates({
        transactions: hiked,
        subscriptions: [stored],
        now,
        lookbackDays: 120,
      }),
    ).toEqual([]);
  });

  it("skips irregular, one-off, transfer, income, and deleted charges", () => {
    const now = Date.UTC(2026, 3, 1);
    const candidates = detectRecurringCandidates({
      now,
      lookbackDays: 120,
      subscriptions: [],
      transactions: [
        // only one charge — not enough
        txn({ id: "once", timestamp: Date.UTC(2026, 2, 1), amount: -40, category: "Once" }),
        // irregular gaps
        txn({ id: "a1", timestamp: Date.UTC(2026, 0, 1), amount: -20, category: "Irregular" }),
        txn({ id: "a2", timestamp: Date.UTC(2026, 0, 20), amount: -20, category: "Irregular" }),
        txn({ id: "a3", timestamp: Date.UTC(2026, 2, 15), amount: -20, category: "Irregular" }),
        // transfer / income / deleted
        txn({
          id: "xfer",
          timestamp: Date.UTC(2026, 0, 5),
          amount: -100,
          category: "Transfer",
          categoryGroup: "transfer",
        }),
        txn({
          id: "pay",
          timestamp: Date.UTC(2026, 0, 5),
          amount: 2000,
          category: "Payroll",
          categoryGroup: "income",
        }),
        txn({
          id: "gone",
          timestamp: Date.UTC(2026, 0, 5),
          amount: -50,
          category: "Gone",
          deletedAt: Date.UTC(2026, 0, 6),
        }),
      ],
    });
    expect(candidates).toEqual([]);
  });

  it("flags a novel large needs charge as a one-time candidate", () => {
    const now = Date.UTC(2026, 0, 20);
    const candidates = detectOneTimeCandidates({
      now,
      month: "2026-01",
      monthlyTakeHome: 5000,
      subscriptions: [],
      transactions: [
        txn({
          id: "legal",
          timestamp: Date.UTC(2026, 0, 10),
          amount: -400,
          category: "Legal Aid",
          categoryGroup: "needs",
        }),
        txn({
          id: "grocery",
          timestamp: Date.UTC(2026, 0, 11),
          amount: -90,
          category: "Market",
          categoryGroup: "needs",
        }),
      ],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      transactionId: "legal",
      amount: 400,
      merchant: "Legal Aid",
      reason: "New merchant · 2× size threshold",
    });
  });

  it("skips non-candidates for one-time detection", () => {
    const now = Date.UTC(2026, 0, 20);
    const netflix = sub({ id: "netflix", name: "Netflix", amount: 15 });
    const candidates = detectOneTimeCandidates({
      now,
      month: "2026-01",
      monthlyTakeHome: 5000,
      subscriptions: [netflix],
      transactions: [
        txn({ id: "subscription", amount: -15, category: "Netflix", categoryGroup: "wants" }),
        txn({ id: "small", amount: -40, category: "Small Novel", categoryGroup: "wants" }),
        txn({
          id: "dismissed",
          amount: -500,
          category: "Dismissed",
          categoryGroup: "needs",
          oneTimeSuggestionDismissed: true,
        }),
        txn({
          id: "excluded",
          amount: -500,
          category: "Excluded",
          categoryGroup: "needs",
          excludeFromBudget: true,
        }),
        txn({ id: "income", amount: 500, category: "Payroll", categoryGroup: "income" }),
        txn({
          id: "transfer",
          amount: -500,
          category: "Credit Card Payment",
          categoryGroup: "transfer",
        }),
      ],
    });

    expect(candidates).toEqual([]);
  });

  it("builds budget insight with one-time spend outside plan totals", () => {
    const insight = buildBudgetInsight({
      now: Date.UTC(2026, 0, 15),
      month: "2026-01",
      takeHome: 5000,
      targets: { needs: 0.5, wants: 0.3, savings: 0.2 },
      subscriptions: [sub({ id: "gym", name: "Gym", amount: 50, group: "wants" })],
      transactions: [
        txn({ id: "rent", amount: -2000, category: "Rent", categoryGroup: "needs" }),
        txn({ id: "dining", amount: -600, category: "Dining", categoryGroup: "wants" }),
        txn({
          id: "legal",
          amount: -400,
          category: "Legal Aid",
          categoryGroup: "needs",
          excludeFromBudget: true,
        }),
        txn({ id: "save", amount: -500, category: "Savings", categoryGroup: "savings" }),
      ],
    });

    expect(insight.planSpend).toBe(3100);
    expect(insight.oneTimeSpend).toBe(400);
    expect(insight.oneTimeCount).toBe(1);
    expect(insight.plannedRecurring).toBe(50);
    expect(insight.committedPlan).toBe(3150);
    expect(insight.variablePlanSpend).toBe(3100);
    expect(insight.totalSpent).toBe(3500);
    expect(insight.remainingCash).toBe(1500);
    expect(insight.remainingAfterCommitted).toBe(1450);
    expect(insight.bucketDeltas.needs).toBe(-500);
    expect(insight.bucketDeltas.wants).toBe(-850);
    expect(insight.bucketDeltas.savings).toBe(500);
    expect(insight.projectedPlanSpend).toBeCloseTo(6456.67, 2);
    expect(insight.lines[0]).toContain("Committed so far");
    expect(insight.lines[0]).toContain("$3,100 plan + $50 remaining recurring = $3,150");
    expect(insight.lines.length).toBeLessThanOrEqual(4);
    expect(insight.lines.join(" ")).toContain("Biggest one-time: Legal Aid, $400");
  });

  it("does not extrapolate fixed early-month bills as variable budget pace", () => {
    const now = Date.UTC(2026, 0, 3);
    const insight = buildBudgetInsight({
      now,
      month: "2026-01",
      takeHome: 11000,
      targets: { needs: 0.5, wants: 0.3, savings: 0.2 },
      subscriptions: [
        sub({ id: "mortgage", name: "Rocket Mortgage", amount: 3275, kind: "loan" }),
        sub({ id: "other-bills", name: "Other Bills", amount: 2000, kind: "bill" }),
      ],
      transactions: [
        txn({
          id: "mortgage-charge",
          timestamp: now,
          amount: -3275,
          category: "Rocket Mortgage",
          categoryGroup: "needs",
        }),
        txn({
          id: "coffee",
          timestamp: now,
          amount: -25,
          category: "Coffee Shop",
          categoryGroup: "wants",
        }),
      ],
    });

    expect(insight.planSpend).toBe(3300);
    expect(insight.plannedRecurring).toBe(2000);
    expect(insight.committedPlan).toBe(5300);
    expect(insight.variablePlanSpend).toBe(25);
    expect(insight.projectedPlanSpend).toBeCloseTo(5533.33, 2);
    expect(insight.projectedPlanSpend).toBeLessThan(11000 * 1.5);
    expect(insight.lines[0]).toContain("Committed so far");
    expect(insight.lines.join(" ")).not.toContain("At this pace");
  });

  it("surfaces a Comcast-style statement amount change", () => {
    const now = Date.UTC(2026, 6, 10);
    const insights = analyzeRecurringHealth({
      now,
      subscriptions: [
        sub({ id: "comcast", name: "Comcast Xfinity", amount: 186, kind: "bill", createdAt: jan }),
      ],
      transactions: [
        txn({ timestamp: Date.UTC(2026, 6, 6), amount: -208, category: "Comcast Xfinity" }),
      ],
    });

    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({
      subscriptionId: "comcast",
      kind: "amount-change",
      suggestedAmount: 208,
      lastChargeAmount: 208,
      matchCount: 1,
    });
  });

  it("surfaces a Halo-style likely cancellation when the previous complete month is missed", () => {
    const now = Date.UTC(2026, 6, 10);
    const oldCharge = Date.UTC(2026, 4, 15);
    const insights = analyzeRecurringHealth({
      now,
      subscriptions: [
        sub({
          id: "halo",
          name: "Halocollar Haloco",
          amount: 21,
          kind: "subscription",
          lastSeen: oldCharge,
        }),
      ],
      transactions: [txn({ timestamp: oldCharge, amount: -21, category: "Halocollar Haloco" })],
    });

    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({
      subscriptionId: "halo",
      kind: "likely-canceled",
      matchCount: 1,
    });
    expect(insights[0].reason).toContain("No charge in June 2026");
  });

  it("does not cancel a monthly commitment that charged in the previous complete month", () => {
    const now = Date.UTC(2026, 6, 10);
    const insights = analyzeRecurringHealth({
      now,
      subscriptions: [
        sub({
          id: "halo",
          name: "Halocollar Haloco",
          amount: 21,
          kind: "subscription",
          createdAt: jan,
          lastSeen: Date.UTC(2026, 5, 20),
        }),
      ],
      transactions: [
        txn({ timestamp: Date.UTC(2026, 5, 20), amount: -21, category: "Halocollar Haloco" }),
      ],
    });

    expect(insights).toEqual([]);
  });

  it("surfaces a weekly likely cancellation after the grace window", () => {
    const now = Date.UTC(2026, 6, 10);
    const oldCharge = now - 25 * 24 * 60 * 60 * 1000;
    const insights = analyzeRecurringHealth({
      now,
      subscriptions: [
        sub({
          id: "cleaner",
          name: "Cleaner",
          amount: 100,
          cadence: "weekly",
          kind: "bill",
          createdAt: jan,
          lastSeen: oldCharge,
        }),
      ],
      transactions: [txn({ timestamp: oldCharge, amount: -100, category: "Cleaner" })],
    });

    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({
      subscriptionId: "cleaner",
      kind: "likely-canceled",
      daysSinceLastCharge: 25,
    });
  });

  it("does not cancel an active monthly commitment that charged this week", () => {
    const now = Date.UTC(2026, 6, 10);
    const insights = analyzeRecurringHealth({
      now,
      subscriptions: [sub({ id: "gym", name: "YMCA", amount: 40, kind: "subscription" })],
      transactions: [txn({ timestamp: Date.UTC(2026, 6, 7), amount: -40, category: "YMCA" })],
    });

    expect(insights).toEqual([]);
  });

  it("does not mark loans likely canceled when there is no recent charge", () => {
    const now = Date.UTC(2026, 6, 10);
    const insights = analyzeRecurringHealth({
      now,
      subscriptions: [
        sub({ id: "loan", name: "Auto Loan", amount: 418, kind: "loan", createdAt: jan }),
      ],
      transactions: [],
    });

    expect(insights).toEqual([]);
  });

  it("skips canceled subscriptions", () => {
    const now = Date.UTC(2026, 6, 10);
    const insights = analyzeRecurringHealth({
      now,
      subscriptions: [
        sub({ id: "old", name: "Old Streaming", amount: 10, status: "canceled", createdAt: jan }),
      ],
      transactions: [],
    });

    expect(insights).toEqual([]);
  });

  it("ignores small recurring amount noise", () => {
    const now = Date.UTC(2026, 6, 10);
    const insights = analyzeRecurringHealth({
      now,
      subscriptions: [sub({ id: "comcast", name: "Comcast Xfinity", amount: 186, kind: "bill" })],
      transactions: [
        txn({ timestamp: Date.UTC(2026, 6, 6), amount: -187, category: "Comcast Xfinity" }),
      ],
    });

    expect(insights).toEqual([]);
  });

  it("rolls up a month while excluding transfers, deleted rows, and one-time charges", () => {
    const result = rollupMonth(
      [
        txn({ amount: 4000, categoryGroup: "income" }),
        txn({ amount: -1200, categoryGroup: "needs" }),
        txn({ amount: -100, categoryGroup: "wants", excludeFromBudget: true }),
        txn({ amount: -500, categoryGroup: "savings" }),
        txn({ amount: -300, categoryGroup: "transfer" }),
        txn({ amount: -20, categoryGroup: "wants", deletedAt: jan }),
        txn({ timestamp: feb, amount: -99, categoryGroup: "wants" }),
      ],
      "2026-01",
    );

    expect(result).toEqual({
      month: "2026-01",
      income: 4000,
      needs: 1200,
      wants: 0,
      savings: 500,
    });
  });

  it("adds active recurring commitments only when they are not already seen", () => {
    const subscriptions = [
      sub({ id: "seen", name: "Netflix", amount: 15, group: "wants" }),
      sub({ id: "unseen", name: "Car Loan", amount: 300, kind: "loan" }),
      sub({ id: "paused", name: "Paused", amount: 50, status: "canceled", group: "wants" }),
    ];
    const txns = [txn({ amount: -15, category: "Netflix", categoryGroup: "wants" })];
    const items = recurringItemsForMonth(subscriptions, txns);
    const buckets = { needs: 1000, wants: 15, savings: 200 };

    const additions = addUnseenRecurringToBuckets(buckets, subscriptions, txns);

    expect(items.wants.find((item) => item.id === "seen")?.seenThisMonth).toBe(true);
    expect(additions).toEqual({ needs: 300, wants: 0, savings: 0 });
    expect(buckets).toEqual({ needs: 1300, wants: 15, savings: 200 });
  });

  it("keeps the remaining weekly plan after only some weekly charges are seen", () => {
    const subscriptions = [
      sub({ id: "weekly", name: "Cleaner", amount: 100, cadence: "weekly", kind: "bill" }),
    ];
    const txns = [
      txn({ id: "week-1", amount: -100, category: "Cleaner" }),
      txn({ id: "week-2", amount: -100, category: "Cleaner" }),
    ];
    const items = recurringItemsForMonth(subscriptions, txns);
    const weekly = items.needs[0];
    const additions = addUnseenRecurringToBuckets(
      { needs: 200, wants: 0, savings: 0 },
      subscriptions,
      txns,
    );

    expect(weekly.expectedThisMonth).toBe(4);
    expect(weekly.matchedCount).toBe(2);
    expect(weekly.matchedAmount).toBe(200);
    expect(weekly.remainingMonthlyAmount).toBeCloseTo((100 * 52) / 12 - 200);
    expect(additions.needs).toBeCloseTo((100 * 52) / 12 - 200);
  });

  it("treats a manual cash/Venmo charge linked by recurringId as paid with no remaining plan", () => {
    const subscriptions = [
      sub({ id: "lawn", name: "Grass cutting", amount: 120, kind: "bill", group: "needs" }),
    ];
    // A manually-logged cash payment: no matching name, linked only by recurringId.
    const txns = [
      txn({
        id: "manual-1",
        amount: -120,
        category: "Grass cutting",
        categoryGroup: "needs",
        account: "Cash / Venmo",
        source: "manual",
        recurringId: "lawn",
        recurringMatchSource: "user",
      }),
    ];
    const items = recurringItemsForMonth(subscriptions, txns);
    const lawn = items.needs.find((item) => item.id === "lawn");

    expect(lawn?.seenThisMonth).toBe(true);
    expect(lawn?.matchedTxn?.manual).toBe(true);
    expect(lawn?.remainingMonthlyAmount).toBe(0);
    // No phantom "unseen recurring" is added on top of the real charge.
    expect(
      addUnseenRecurringToBuckets({ needs: 0, wants: 0, savings: 0 }, subscriptions, txns),
    ).toEqual({ needs: 0, wants: 0, savings: 0 });
  });

  it("populates matchedTxn from the most recent matching charge and derives seenThisMonth", () => {
    const early = Date.UTC(2026, 0, 3);
    const late = Date.UTC(2026, 0, 20);
    const subscriptions = [
      sub({ id: "netflix", name: "Netflix", amount: 15, group: "wants" }),
      sub({ id: "gym", name: "Gym", amount: 40, group: "wants" }),
    ];
    const txns = [
      txn({
        id: "old",
        timestamp: early,
        amount: -15.49,
        category: "NETFLIX.COM",
        account: "Visa",
      }),
      txn({ id: "new", timestamp: late, amount: -14.99, category: "NETFLIX.COM", account: "Amex" }),
    ];

    const items = recurringItemsForMonth(subscriptions, txns);
    const netflix = items.wants.find((item) => item.id === "netflix");
    const gym = items.wants.find((item) => item.id === "gym");

    // Most recent of the two Netflix matches wins (raw signed amount + account).
    expect(netflix?.seenThisMonth).toBe(true);
    expect(netflix?.matchedTxn).toEqual({
      id: "new",
      timestamp: late,
      amount: -14.99,
      account: "Amex",
      matchSource: undefined,
      manual: false,
    });
    // Unmatched item carries no matchedTxn and is not seen.
    expect(gym?.seenThisMonth).toBe(false);
    expect(gym?.matchedTxn).toBeUndefined();
  });

  it("reports lastPaidTxn from prior-month charges for a pending item", () => {
    const lastMonth = Date.UTC(2025, 11, 5); // Dec 5 — before the reported month
    const older = Date.UTC(2025, 9, 4); // Oct 4 — an even earlier charge
    const subscriptions = [sub({ id: "netflix", name: "Netflix", amount: 15, group: "wants" })];
    // No charge this month (empty), but two in prior months.
    const priorTxns = [
      txn({
        id: "oct",
        timestamp: older,
        amount: -14.99,
        category: "NETFLIX.COM",
        account: "Visa",
      }),
      txn({
        id: "dec",
        timestamp: lastMonth,
        amount: -15.49,
        category: "NETFLIX.COM",
        account: "Amex",
      }),
    ];

    const items = recurringItemsForMonth(subscriptions, [], priorTxns);
    const netflix = items.wants.find((item) => item.id === "netflix");

    expect(netflix?.seenThisMonth).toBe(false);
    // Most recent prior charge wins.
    expect(netflix?.lastPaidTxn).toEqual({
      id: "dec",
      timestamp: lastMonth,
      amount: -15.49,
      account: "Amex",
    });
  });

  it("omits lastPaidTxn when no prior transactions are provided", () => {
    const subscriptions = [sub({ id: "netflix", name: "Netflix", amount: 15, group: "wants" })];
    const items = recurringItemsForMonth(subscriptions, []);
    expect(items.wants[0]?.lastPaidTxn).toBeUndefined();
  });

  it("selects transactions strictly before a month key", () => {
    const txns = [txn({ id: "jan", timestamp: jan }), txn({ id: "feb", timestamp: feb })];
    const before = transactionsBeforeMonth(txns, "2026-02");
    expect(before.map((t) => t.id)).toEqual(["jan"]);
  });

  it("surfaces matched transaction id and AI match source for explicit links", () => {
    const subscriptions = [sub({ id: "jeep", name: "Jeep payment", amount: 418, kind: "loan" })];
    const txns = [
      txn({
        id: "ai-match",
        amount: -500,
        category: "TRUIST IL PYMT",
        recurringId: "jeep",
        recurringMatchSource: "ai",
      }),
    ];

    const jeep = recurringItemsForMonth(subscriptions, txns).needs[0];

    expect(jeep.seenThisMonth).toBe(true);
    expect(jeep.remainingMonthlyAmount).toBe(0);
    expect(jeep.matchedTxn).toMatchObject({
      id: "ai-match",
      matchSource: "ai",
      amount: -500,
    });
  });

  it("reconciles current bank descriptors against their tracked recurring items", () => {
    const cases = [
      { name: "Truist IL Pymt", amount: 1094.31, category: "TRUIST IL PYMT" },
      { name: "Rocket Mortgage Loan", amount: 3275.33, category: "ROCKET MORTGAGE LOAN" },
      { name: "Comcast Xfinity", amount: 199.83, category: "PURCHASE 0703 COMCAST / XFINITY" },
      {
        name: "PY Mosquito Authority302",
        amount: 159,
        category: "PY *MOSQUITO AUTHORITY302-346-2970",
      },
      { name: "Amazon Digital", amount: 12.99, category: "PURCHASE 0630 AMAZON DIGITAL" },
      {
        name: "Verizon Wireless Payments",
        amount: 302.61,
        category: "VERIZON WIRELESS PAYMENTS",
        transactionAmount: 297.8,
      },
    ];

    for (const item of cases) {
      const subscription = sub({ name: item.name, amount: item.amount });
      const transaction = txn({
        amount: -(item.transactionAmount ?? item.amount),
        category: item.category,
      });

      expect(recurringMatchesTransaction(subscription, transaction), item.name).toBe(true);
    }
  });

  it("filters transactions by stable UTC month key", () => {
    expect(
      transactionsForMonth([txn({ timestamp: jan }), txn({ timestamp: feb })], "2026-01"),
    ).toHaveLength(1);
  });

  it("builds a monthly cash-flow projection with unseen recurring commitments", () => {
    const projection = buildCashFlowProjection({
      startMonth: "2026-01",
      months: 2,
      startingCash: 1000,
      monthlyIncome: 5000,
      monthlyBuckets: { needs: 2000, wants: 900, savings: 500 },
      subscriptions: [
        sub({ id: "loan", name: "Car Loan", amount: 450, kind: "loan" }),
        sub({ id: "streaming", name: "Netflix", amount: 20, group: "wants" }),
      ],
    });

    expect(projection.months.map((m) => m.month)).toEqual(["2026-01", "2026-02"]);
    expect(projection.months[0]).toMatchObject({
      income: 5000,
      needs: 2000,
      wants: 900,
      savings: 500,
      recurringNeeds: 450,
      recurringWants: 20,
      totalOutflow: 3870,
      netCashFlow: 1130,
      startingCash: 1000,
      endingCash: 2130,
    });
    expect(projection.endingCash).toBe(3260);
    expect(projection.totalNetCashFlow).toBe(2260);
  });

  it("does not double-count recurring commitments already seen in projected transactions", () => {
    const projection = buildCashFlowProjection({
      startMonth: "2026-01",
      months: 1,
      monthlyIncome: 5000,
      monthlyBuckets: { needs: 2000, wants: 900, savings: 500 },
      transactions: [txn({ amount: -20, category: "Netflix", categoryGroup: "wants" })],
      subscriptions: [sub({ id: "streaming", name: "Netflix", amount: 20, group: "wants" })],
    });

    expect(projection.months[0].recurringWants).toBe(0);
    expect(projection.months[0].totalOutflow).toBe(3400);
  });

  it("simulates debt payoff using the highest APR first by default", () => {
    const result = simulateDebtPayoff({
      debts: [
        { id: "car", name: "Car Loan", balance: 1000, apr: 8, minimumPayment: 100 },
        { id: "card", name: "Credit Card", balance: 500, apr: 24, minimumPayment: 50 },
      ],
      extraMonthlyPayment: 300,
    });

    expect(result.feasible).toBe(true);
    expect(result.months).toBe(4);
    expect(result.payoffOrder[0]).toBe("card");
    expect(result.totalInterest).toBeGreaterThan(0);
    expect(result.debts.find((d) => d.id === "car")?.monthsToPayoff).toBe(4);
  });

  it("marks debt payoff infeasible when payments do not cover interest", () => {
    const result = simulateDebtPayoff({
      debts: [{ id: "bad", name: "Bad Debt", balance: 1000, apr: 120, minimumPayment: 5 }],
      maxMonths: 12,
    });

    expect(result.feasible).toBe(false);
    expect(result.months).toBeNull();
    expect(result.debts[0].monthsToPayoff).toBeNull();
  });

  it("calculates emergency fund targets, coverage, and timeline", () => {
    expect(
      calculateEmergencyFund({
        monthlyEssentialExpenses: 3000,
        currentSavings: 7500,
        monthlyContribution: 750,
      }),
    ).toEqual({
      monthlyEssentialExpenses: 3000,
      minimumTarget: 9000,
      target: 18000,
      currentSavings: 7500,
      shortfall: 10500,
      surplus: 0,
      monthsCovered: 2.5,
      monthsToTarget: 14,
      status: "not-started",
    });

    expect(
      calculateEmergencyFund({
        monthlyEssentialExpenses: 3000,
        currentSavings: 21000,
      }),
    ).toMatchObject({
      shortfall: 0,
      surplus: 3000,
      monthsToTarget: 0,
      status: "surplus",
    });
  });

  it("produces deterministic fallback advice without auth or network", () => {
    const profile: UserProfile = {
      id: "profile",
      createdAt: jan,
      displayName: "Brian",
      riskTolerance: "moderate",
      monthlySavingsGoal: 1200,
    };

    const items = fallbackFinanceAdvice({
      budget: {
        monthlyTakeHome: 5000,
        targets: { needs: 0.5, wants: 0.3, savings: 0.2 },
      },
      buckets: { month: "2026-01", income: 5000, needs: 2200, wants: 2000, savings: 400 },
      subscriptions: [sub({ amount: 20 })],
      netWorth: 25000,
      profile,
    });

    expect(items.map((item) => item.category)).toContain("budget");
    expect(items.map((item) => item.category)).toContain("subscriptions");
    expect(items.map((item) => item.category)).toContain("investing");
    expect(items.map((item) => item.category)).toContain("earn");
  });

  it("names the largest subscription as the cut candidate with annualized savings", () => {
    const items = fallbackFinanceAdvice({
      budget: { monthlyTakeHome: 5000, targets: { needs: 0.5, wants: 0.3, savings: 0.2 } },
      buckets: { month: "2026-01", income: 5000, needs: 2200, wants: 1200, savings: 1000 },
      subscriptions: [sub({ name: "Netflix", amount: 15 }), sub({ name: "Peloton", amount: 44 })],
      netWorth: 25000,
      profile: { id: "profile", createdAt: jan },
    });

    const subItem = items.find((i) => i.category === "subscriptions");
    expect(subItem?.text).toContain("Peloton");
    expect(subItem?.text).toContain("$528/yr"); // 44 * 12
    expect(subItem?.action).toBe("Cut Peloton");
  });

  it("flags the highest-APR loan as a payoff/refinance candidate", () => {
    const items = fallbackFinanceAdvice({
      budget: { monthlyTakeHome: 5000, targets: { needs: 0.5, wants: 0.3, savings: 0.2 } },
      buckets: { month: "2026-01", income: 5000, needs: 2200, wants: 1200, savings: 1000 },
      subscriptions: [],
      netWorth: 25000,
      profile: { id: "profile", createdAt: jan },
      loans: [
        sub({ name: "Mortgage", amount: 1800, kind: "loan", apr: 3.1, balance: 250000 }),
        sub({ name: "Car Loan", amount: 450, kind: "loan", apr: 9.2, balance: 18000 }),
      ],
    });

    const loanItem = items.find((i) => i.text.includes("APR"));
    expect(loanItem?.text).toContain("Car Loan");
    expect(loanItem?.text).toContain("9.2% APR");
    expect(loanItem?.action).toBe("Target Car Loan payoff");
  });

  it("observes idle cash above a 6-month emergency fund", () => {
    const items = fallbackFinanceAdvice({
      budget: { monthlyTakeHome: 5000, targets: { needs: 0.5, wants: 0.3, savings: 0.2 } },
      buckets: { month: "2026-01", income: 5000, needs: 2000, wants: 1200, savings: 1000 },
      subscriptions: [],
      netWorth: 60000,
      profile: { id: "profile", createdAt: jan },
      // Monthly needs floors at the 50% take-home target ($2,500) rather than
      // the $2,000 month-to-date spend, so 6mo fund = $15,000 and $5,000 idle.
      cashOnHand: 20000,
    });

    const cashItem = items.find((i) => i.action === "Deploy idle cash");
    expect(cashItem?.category).toBe("investing");
    expect(cashItem?.text).toContain("$20,000");
    expect(cashItem?.text).toContain("$15,000");
    expect(cashItem?.text).toContain("$5,000");
  });

  it("grounds the earn suggestion in profile skills when provided", () => {
    const items = fallbackFinanceAdvice({
      budget: { monthlyTakeHome: 5000, targets: { needs: 0.5, wants: 0.3, savings: 0.2 } },
      buckets: { month: "2026-01", income: 5000, needs: 2200, wants: 1200, savings: 400 },
      subscriptions: [],
      netWorth: 25000,
      profile: {
        id: "profile",
        createdAt: jan,
        skills: ["IT infrastructure", "automation consulting"],
      },
    });

    const earnItem = items.find((i) => i.category === "earn");
    expect(earnItem?.text).toContain("IT infrastructure");
    expect(earnItem?.action).toBe("Sell IT infrastructure");
  });
});
