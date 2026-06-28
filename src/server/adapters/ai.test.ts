import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChat, type StreamChatEvent } from "./ai";

/** Build a mock fetch Response whose body streams the given raw chunks (as if
 *  arriving over the wire — chunk boundaries deliberately split SSE frames). */
function mockStreamResponse(chunks: string[], ok = true): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(ok ? body : null, { status: ok ? 200 : 500 });
}

async function collect(gen: AsyncGenerator<StreamChatEvent>): Promise<StreamChatEvent[]> {
  const out: StreamChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("streamChat", () => {
  it("yields text deltas, reassembling frames split across chunk boundaries", async () => {
    // The first frame is split mid-JSON across two network chunks.
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockStreamResponse(chunks));

    const events = await collect(
      streamChat("key", { messages: [{ role: "user", content: "hi" }] }),
    );
    const text = events
      .filter((e): e is Extract<StreamChatEvent, { type: "delta" }> => e.type === "delta")
      .map((e) => e.text)
      .join("");

    expect(text).toBe("Hello there");
  });

  it("accumulates a tool call whose arguments arrive across multiple deltas", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"log_water","arguments":"{\\"oun"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ces\\":16}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockStreamResponse(chunks));

    const events = await collect(
      streamChat("key", { messages: [{ role: "user", content: "log water" }] }),
    );
    const toolCalls = events.filter(
      (e): e is Extract<StreamChatEvent, { type: "tool_call" }> => e.type === "tool_call",
    );

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("log_water");
    expect(toolCalls[0].id).toBe("call_1");
    expect(JSON.parse(toolCalls[0].arguments)).toEqual({ ounces: 16 });
  });

  it("throws on a non-OK response so callers can fall back", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockStreamResponse([], false));

    await expect(collect(streamChat("key", { messages: [] }))).rejects.toThrow(/Grok stream HTTP/);
  });
});
