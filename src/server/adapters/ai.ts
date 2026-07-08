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

import { getServerEnvVar } from "@/server/env";

/**
 * Canonical Grok model IDs for this app.
 *
 * xAI recommends Grok 4.5 for chat/code/agentic work (flagship as of 2026-07).
 * Use the bare name (`grok-4.5`) so we track the stable alias for that line;
 * pin a dated id only if a workflow needs bit-for-bit reproducibility.
 * Override paths via env (see getGrokChatModel / getGrokJsonModel).
 */
export const GROK_MODELS = {
  /** Flagship: coaching, chat, finance advice, voice intent, nutrition parse. */
  default: "grok-4.5",
  /** Grok Imagine — exercise silhouettes and other image gen. */
  image: "grok-imagine-image",
} as const;

export async function getGrokApiKey(): Promise<string | undefined> {
  return getServerEnvVar("GROK_API_KEY");
}

/** Conversational chat (tool-capable). Override with `GROK_CHAT_MODEL`. */
export async function getGrokChatModel(): Promise<string> {
  return (await getServerEnvVar("GROK_CHAT_MODEL")) || GROK_MODELS.default;
}

/**
 * One-shot JSON completions (coach, finance, voice intent, meal macros).
 * Override with `GROK_JSON_MODEL` — falls back to the chat model, then default.
 */
export async function getGrokJsonModel(): Promise<string> {
  return (
    (await getServerEnvVar("GROK_JSON_MODEL")) ||
    (await getServerEnvVar("GROK_CHAT_MODEL")) ||
    GROK_MODELS.default
  );
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
      model: request.model ?? GROK_MODELS.default,
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
      model: request.model ?? GROK_MODELS.default,
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
