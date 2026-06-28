export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface JSONChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

async function getCloudflareEnv(): Promise<Record<string, unknown> | undefined> {
  try {
    const importCloudflareWorkers = new Function(
      "return import('cloudflare:workers')",
    ) as () => Promise<{ env?: Record<string, unknown> }>;
    return (await importCloudflareWorkers()).env;
  } catch {
    return undefined;
  }
}

async function getLocalDevVar(key: string): Promise<string | undefined> {
  if (typeof process === "undefined" || process.env?.NODE_ENV === "production") return undefined;
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = await fs.readFile(path.join(process.cwd(), ".dev.vars"), "utf8");
    for (const line of file.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (!match || match[1].trim() !== key) continue;
      return match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function getGrokApiKey(): Promise<string | undefined> {
  const cfEnv = await getCloudflareEnv();
  const apiKey = cfEnv?.GROK_API_KEY;
  if (typeof apiKey === "string" && apiKey.length > 0) return apiKey;
  const globalKey = (globalThis as any).GROK_API_KEY || process?.env?.GROK_API_KEY;
  if (typeof globalKey === "string" && globalKey.length > 0) return globalKey;
  return getLocalDevVar("GROK_API_KEY");
}

/** Resolve the Grok model used for conversational chat (tool-capable).
 *  Distinct from the cheap `grok-3-mini` used for one-shot JSON tasks.
 *  Override with `GROK_CHAT_MODEL` (Cloudflare var / env / .dev.vars). */
export async function getGrokChatModel(): Promise<string> {
  const cfEnv = await getCloudflareEnv();
  const fromCf = cfEnv?.GROK_CHAT_MODEL;
  if (typeof fromCf === "string" && fromCf.length > 0) return fromCf;
  const fromGlobal = (globalThis as any).GROK_CHAT_MODEL || process?.env?.GROK_CHAT_MODEL;
  if (typeof fromGlobal === "string" && fromGlobal.length > 0) return fromGlobal;
  return (await getLocalDevVar("GROK_CHAT_MODEL")) || "grok-3";
}

/* ============================================================
   STREAMING CHAT (conversational coach, ADR-018)
   The xAI API is OpenAI-chat-completions compatible, so we stream
   directly with the standard SSE wire format — stable, well-documented,
   and independent of the TanStack AI alpha internals. Yields text deltas
   as they arrive and surfaces any tool calls (function-calling) the model
   proposes so the caller can turn them into user-approved actions.
   ============================================================ */

/** An OpenAI-compatible function tool the model may call. */
export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema for the function arguments. */
    parameters: Record<string, unknown>;
  };
}

export interface StreamChatRequest extends JSONChatRequest {
  tools?: ChatTool[];
}

/** A chunk of streamed assistant text. */
export interface StreamTextDelta {
  type: "delta";
  text: string;
}
/** A fully-accumulated tool call the model proposed (emitted at stream end). */
export interface StreamToolCall {
  type: "tool_call";
  id: string;
  name: string;
  /** Raw JSON arguments string as produced by the model. */
  arguments: string;
}
export type StreamChatEvent = StreamTextDelta | StreamToolCall;

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Stream a chat completion from xAI. Async-generates text deltas while they
 * arrive, then yields one `tool_call` event per function call the model made.
 * Throws on a non-OK HTTP response so callers can fall back deterministically.
 */
export async function* streamChat(
  apiKey: string,
  request: StreamChatRequest,
): AsyncGenerator<StreamChatEvent> {
  const resp = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: request.model ?? "grok-3",
      messages: request.messages,
      temperature: request.temperature ?? 0.6,
      max_tokens: request.maxTokens ?? 1200,
      stream: true,
      ...(request.tools?.length ? { tools: request.tools, tool_choice: "auto" } : {}),
    }),
  });
  if (!resp.ok || !resp.body) throw new Error("Grok stream HTTP " + resp.status);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  // Tool calls stream as deltas keyed by index; accumulate then emit at the end.
  const toolCalls = new Map<number, ToolCallAccumulator>();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; process complete lines only.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;

        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue; // ignore keep-alives / partial frames
        }

        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;

        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield { type: "delta", text: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const acc = toolCalls.get(idx) ?? { id: "", name: "", arguments: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            toolCalls.set(idx, acc);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  for (const acc of toolCalls.values()) {
    if (acc.name) {
      yield {
        type: "tool_call",
        id: acc.id || `call-${acc.name}`,
        name: acc.name,
        arguments: acc.arguments || "{}",
      };
    }
  }
}

export function stripJsonFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```json\s*|\s*```$/g, "")
    .trim();
}

export async function completeJSON<T>(apiKey: string, request: JSONChatRequest): Promise<T> {
  const resp = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: request.model ?? "grok-3-mini",
      messages: request.messages,
      temperature: request.temperature ?? 0.1,
      max_tokens: request.maxTokens ?? 400,
    }),
  });
  if (!resp.ok) throw new Error("Grok HTTP " + resp.status);
  const data: any = await resp.json();
  const raw = (data.choices?.[0]?.message?.content || "{}").trim();
  return JSON.parse(stripJsonFence(raw)) as T;
}
