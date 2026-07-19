import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChatEvent } from "@/server/adapters/ai";

const ai = vi.hoisted(() => ({
  calls: [] as StreamChatEvent[][],
  requests: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/server/adapters/ai", () => ({
  getGrokApiKey: vi.fn(async () => "test-key"),
  getGrokChatModel: vi.fn(async () => "grok-test"),
  streamChat: vi.fn(async function* (_apiKey: string, request: Record<string, unknown>) {
    ai.requests.push(request);
    for (const event of ai.calls.shift() ?? []) yield event;
  }),
}));

import type { Subscription, Transaction } from "@/lib/domain";
import { executeFinanceReadTool } from "@/server/chat-finance-tools-impl";
import { ACTION_TOOLS, createChatStreamResponse } from "@/server/chat-stream-impl";

async function frames(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data:"))
    .map((chunk) => JSON.parse(chunk.slice(5).trim()));
}

describe("chat action SSE ordering", () => {
  beforeEach(() => {
    ai.calls = [];
    ai.requests = [];
  });

  it("emits meal prose before the approval action", async () => {
    ai.calls.push([
      {
        type: "tool_call",
        id: "meal-1",
        name: "log_meal",
        arguments: '{"description":"oatmeal creme pie"}',
      },
      {
        type: "delta",
        text: "Your oatmeal creme pie is queued and ready to Apply.",
      },
    ]);

    const result = await frames(
      await createChatStreamResponse({
        contextBlock: "Today: no meals logged.",
        date: "2026-07-15",
        turns: [{ role: "user", content: "Log an oatmeal creme pie" }],
      }),
    );

    expect(result.map((frame) => frame.type)).toEqual(["delta", "action", "done"]);
    expect(result[0]?.text).toContain("ready to Apply");
  });

  it("replaces false already-logged prose before showing a meal action", async () => {
    ai.calls.push(
      [
        { type: "delta", text: "Logged your oatmeal cream pie." },
        {
          type: "tool_call",
          id: "meal-2",
          name: "log_meal",
          arguments: '{"description":"oatmeal cream pie"}',
        },
      ],
      [{ type: "delta", text: "Your oatmeal cream pie is ready to Apply." }],
    );

    const result = await frames(
      await createChatStreamResponse({
        contextBlock: "Today: no meals logged.",
        date: "2026-07-15",
        turns: [{ role: "user", content: "Log an oatmeal cream pie" }],
      }),
    );

    expect(result.map((frame) => frame.type)).toEqual(["delta", "action", "done"]);
    expect(result[0]?.text).toBe("Your oatmeal cream pie is ready to Apply.");
  });

  it("replaces other false execution claims before showing an approval action", async () => {
    ai.calls.push(
      [
        { type: "delta", text: "I've saved and applied that meal." },
        {
          type: "tool_call",
          id: "meal-3",
          name: "log_meal",
          arguments: '{"description":"sandwich"}',
        },
      ],
      [{ type: "delta", text: "Your sandwich is ready to Apply." }],
    );

    const result = await frames(
      await createChatStreamResponse({
        contextBlock: "Today: no meals logged.",
        date: "2026-07-15",
        turns: [{ role: "user", content: "Log a sandwich" }],
      }),
    );

    expect(result.map((frame) => frame.type)).toEqual(["delta", "action", "done"]);
    expect(result[0]?.text).toBe("Your sandwich is ready to Apply.");
  });

  it("keeps memory actions immediate and does not convert them to approval cards", async () => {
    ai.calls.push([
      {
        type: "tool_call",
        id: "memory-1",
        name: "save_memory",
        arguments: '{"category":"preference","content":"Likes yoga"}',
      },
      { type: "delta", text: "I'll remember that you like yoga." },
    ]);

    const result = await frames(
      await createChatStreamResponse({
        contextBlock: "No memories.",
        date: "2026-07-15",
        turns: [{ role: "user", content: "Remember that I like yoga" }],
      }),
    );

    expect(result.map((frame) => frame.type)).toEqual(["action", "delta", "done"]);
  });
});

describe("chat finance tools", () => {
  beforeEach(() => {
    ai.calls = [];
    ai.requests = [];
  });

  it("exposes the finance read and approval-write schemas", () => {
    const tools = new Map(ACTION_TOOLS.map((tool) => [tool.function.name, tool.function]));
    expect([...tools.keys()]).toEqual(
      expect.arrayContaining([
        "find_transactions",
        "inspect_recurring",
        "explain_bill_health",
        "restore_transaction",
        "mark_bill_paid",
      ]),
    );
    expect(tools.get("restore_transaction")?.parameters).toMatchObject({
      required: ["transactionId"],
    });
    expect(tools.get("mark_bill_paid")?.parameters).toMatchObject({ required: ["name"] });
  });

  it("returns a compact capped transaction search shape including deletion details", () => {
    const now = Date.UTC(2026, 5, 30, 12);
    const transactions: Transaction[] = Array.from({ length: 35 }, (_, index) => ({
      id: `txn-${index}`,
      createdAt: now,
      timestamp: now - index * 86400000,
      type: "withdrawal",
      amount: -64.38,
      currency: "USD",
      account: "Checking",
      category: `ADT SECURITY ${index}`,
      source: "sync",
      ...(index === 0 ? { deletedAt: now + 1, deletedReason: "sync-undo" } : {}),
    }));
    const result = executeFinanceReadTool(
      "find_transactions",
      { query: "ADT", includeDeleted: true },
      {
        subscriptions: [],
        transactions,
      },
    );
    expect(result.count).toBe(30);
    const rows = result.transactions as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(30);
    expect(rows[0]).toEqual({
      date: "2026-06-30",
      amount: -64.38,
      descriptor: "ADT SECURITY 0",
      account: "Checking",
      source: "sync",
      deleted: true,
      deletedReason: "sync-undo",
      id: "txn-0",
    });
  });

  it("fuzzy-resolves ADT and reports a matched-but-deleted candidate", () => {
    const now = Date.now();
    const subscription: Subscription = {
      id: "sub-adt",
      createdAt: now,
      name: "ADT SECURITY*320556313 05/31 PURCHASE WW",
      amount: 64.38,
      cadence: "monthly",
      status: "active",
      source: "detected",
    };
    const deletedTransaction: Transaction = {
      id: "txn-adt-deleted",
      createdAt: now,
      timestamp: now - 5 * 86400000,
      type: "withdrawal",
      amount: -64.38,
      currency: "USD",
      account: "Checking",
      category: "CHECKCARD 0630 ADT SECURITY*XXXXX6313",
      source: "sync",
      deletedAt: now - 1000,
      deletedReason: "sync-undo",
    };
    const result = executeFinanceReadTool(
      "explain_bill_health",
      { name: "ADT bill" },
      {
        subscriptions: [subscription],
        transactions: [deletedTransaction],
      },
    );
    expect(result).toMatchObject({
      found: true,
      recurring: { id: "sub-adt", amount: 64.38 },
      trace: {
        nearMisses: [
          {
            transactionId: "txn-adt-deleted",
            amount: 64.38,
            reason: "matched-but-deleted",
            deletedReason: "sync-undo",
          },
        ],
      },
    });
  });

  it("executes a read tool privately, feeds its result back, then emits prose", async () => {
    ai.calls.push(
      [
        {
          type: "tool_call",
          id: "find-1",
          name: "find_transactions",
          arguments: '{"query":"ADT","includeDeleted":true}',
        },
      ],
      [{ type: "delta", text: "I found the deleted ADT charge." }],
    );
    const result = await frames(
      await createChatStreamResponse({
        contextBlock: "Finance summary only.",
        financeToolData: { subscriptions: [], transactions: [] },
        date: "2026-07-15",
        turns: [{ role: "user", content: "Find my ADT charge" }],
      }),
    );
    expect(result).toEqual([
      { type: "delta", text: "I found the deleted ADT charge." },
      { type: "done" },
    ]);
    expect(ai.requests).toHaveLength(2);
    expect(JSON.stringify(ai.requests[1])).toContain("find_transactions result");
  });
});
