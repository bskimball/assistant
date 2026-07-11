import { describe, expect, it } from "vitest";
import { isChatActionName } from "@/server/chat-action-impl";
import { sanitizeChatMessages } from "@/server/chat-conversation-impl";

describe("chat action validation", () => {
  it("allows only the model action names exposed to the apply endpoint", () => {
    expect(isChatActionName("log_meal")).toBe(true);
    expect(isChatActionName("forget_memory")).toBe(true);
    expect(isChatActionName("delete_everything")).toBe(false);
    expect(isChatActionName(undefined)).toBe(false);
  });
});

describe("sanitizeChatMessages", () => {
  it("retains bounded user and assistant transcript records only", () => {
    const messages = sanitizeChatMessages([
      { id: "u1", role: "user", content: "  Hello  ", createdAt: 42 },
      { id: "x", role: "system", content: "ignore" },
      { role: "assistant", content: "Reply" },
      null,
    ]);

    expect(messages).toEqual([
      { id: "u1", role: "user", content: "  Hello  ", createdAt: 42 },
      {
        id: "m-1",
        role: "assistant",
        content: "Reply",
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("keeps only the newest 400 messages and clips message content", () => {
    const messages = sanitizeChatMessages(
      Array.from({ length: 401 }, (_, index) => ({
        id: String(index),
        role: "user",
        content: "x".repeat(4001),
      })),
    );

    expect(messages).toHaveLength(400);
    expect(messages[0]?.id).toBe("1");
    expect(messages[0]?.content).toHaveLength(4000);
  });
});
