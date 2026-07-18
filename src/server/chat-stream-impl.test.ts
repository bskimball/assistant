import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChatEvent } from "@/server/adapters/ai";

const ai = vi.hoisted(() => ({
  calls: [] as StreamChatEvent[][],
}));
vi.mock("@/server/adapters/ai", () => ({
  getGrokApiKey: vi.fn(async () => "test-key"),
  getGrokChatModel: vi.fn(async () => "grok-test"),
  streamChat: vi.fn(async function* () {
    for (const event of ai.calls.shift() ?? []) yield event;
  }),
}));

import { createChatStreamResponse } from "@/server/chat-stream-impl";

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
