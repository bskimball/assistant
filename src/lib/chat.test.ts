import { describe, expect, it } from "vitest";
import type { ChatConversation, ChatMessageRecord } from "./domain";
import { deriveTitle, sortByRecent, toSummary, upsertConversation } from "./chat";

function msg(role: "user" | "assistant", content: string, createdAt = 0): ChatMessageRecord {
  return { id: `m-${createdAt}-${role}`, role, content, createdAt };
}

function conv(id: string, updatedAt: number, messages: ChatMessageRecord[] = []): ChatConversation {
  return { id, title: deriveTitle(messages), createdAt: 0, updatedAt, messages };
}

describe("deriveTitle", () => {
  it("uses the first user message, collapsing whitespace", () => {
    expect(deriveTitle([msg("assistant", "hi"), msg("user", "How's   my\nprotein?")])).toBe(
      "How's my protein?",
    );
  });

  it("truncates long titles with an ellipsis", () => {
    const long = "a".repeat(120);
    const title = deriveTitle([msg("user", long)]);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back when there is no user message", () => {
    expect(deriveTitle([])).toBe("New chat");
  });
});

describe("toSummary", () => {
  it("captures count and a preview of the last message, without the transcript", () => {
    const c = conv("c1", 5, [msg("user", "log water", 1), msg("assistant", "Logged 16 fl oz.", 2)]);
    const s = toSummary(c);
    expect(s).toMatchObject({ id: "c1", messageCount: 2, preview: "Logged 16 fl oz." });
    expect(s).not.toHaveProperty("messages");
  });
});

describe("upsertConversation", () => {
  it("replaces an existing conversation by id and re-sorts by recency", () => {
    const list = [conv("a", 1), conv("b", 2)];
    const updated = upsertConversation(list, conv("a", 3));
    expect(updated.map((c) => c.id)).toEqual(["a", "b"]);
    expect(updated.find((c) => c.id === "a")!.updatedAt).toBe(3);
  });

  it("prepends a new conversation", () => {
    const list = [conv("a", 5)];
    const updated = upsertConversation(list, conv("z", 1));
    expect(updated.map((c) => c.id)).toEqual(["a", "z"]);
    expect(updated).toHaveLength(2);
  });
});

describe("sortByRecent", () => {
  it("orders most-recently-updated first", () => {
    expect(sortByRecent([conv("a", 1), conv("b", 3), conv("c", 2)]).map((c) => c.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
});
