/**
 * Conversational Coach chat (ADR-018).
 *
 * A streaming chat with Grok that reasons over the member's recorded life
 * (health, nutrition, fitness, finance, tasks, profile) and can propose
 * concrete actions the member applies with one tap.
 *
 * Why a server function (not an `/api` route): domain data is only readable
 * when the per-user scope is bound, and that binding happens inside the global
 * function middleware (`auth-middleware.ts`). Server functions are the only
 * scope-bound path, so the streaming endpoint lives here. All domain reads
 * (context assembly) happen *before* the Response is returned — i.e. while the
 * scope is still bound — and the streamed body carries only LLM output, so no
 * store access escapes the bound scope.
 *
 * Transport: xAI is OpenAI-chat-completions compatible, so we stream directly
 * via `streamChat` (see `adapters/ai.ts`) using the stable SSE wire format
 * rather than the TanStack AI alpha adapter internals. Every path has a
 * deterministic fallback so the page works with no `GROK_API_KEY`.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireAuthSession } from "@/lib/auth";
import type {
  ChatConversation,
  ChatConversationSummary,
  ChatMessageRecord,
  ISODate,
  VoiceIntent,
} from "@/lib/domain";
import { todayISO, flOzToMl } from "@/lib/domain";
import { deriveTitle, sortByRecent, toSummary, upsertConversation } from "@/lib/chat";
import {
  getGrokApiKey,
  getGrokChatModel,
  streamChat,
  type ChatMessage,
  type ChatTool,
} from "@/server/adapters/ai";
import { buildUserContextBlock } from "@/server/context";
import {
  executeVoiceIntentImpl,
  loadChatConversationsImpl,
  updateChatConversationsImpl,
} from "@/server/domain-impl";

/** A single conversation turn sent from the client. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** A model-proposed action surfaced to the user for one-tap approval. */
export interface ProposedAction {
  id: string;
  name: ChatActionName;
  args: Record<string, unknown>;
}

export type ChatActionName = "log_meal" | "log_water" | "add_task" | "mark_task_done";

/** Keep the prompt bounded: only the most recent turns are sent to the model. */
const MAX_TURNS = 24;
const MAX_CONTENT = 4000;

/* ============================================================
   ACTION TOOLS (function-calling for *detection* only)
   The model proposes; the user approves; `applyChatAction` executes via the
   shared voice-intent executor. Tool names map 1:1 to ChatActionName.
   ============================================================ */

const ACTION_TOOLS: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "log_meal",
      description:
        "Record a meal/food the member ate today. Provide macros when the member states them; otherwise omit and they'll be estimated.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "What was eaten, e.g. '2 eggs and toast'" },
          calories: { type: "number" },
          protein: { type: "number", description: "grams" },
          carbs: { type: "number", description: "grams" },
          fat: { type: "number", description: "grams" },
        },
        required: ["description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_water",
      description: "Record water the member drank today, in US fluid ounces.",
      parameters: {
        type: "object",
        properties: { ounces: { type: "number", description: "fluid ounces" } },
        required: ["ounces"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_task",
      description: "Add a task/to-do for the member.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          priority: { type: "number", description: "1 (highest) to 3 (lowest)" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_task_done",
      description: "Mark an existing task complete by matching its text.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "text of the task to complete" } },
        required: ["text"],
      },
    },
  },
];

function systemPrompt(contextBlock: string, date: ISODate): string {
  return `You are Compass Coach — the member's personal life coach, certified strength & conditioning coach, and CFP-level financial advisor, all in one warm, direct voice. You converse about their real, recorded data and help them improve their fitness, nutrition, finances, productivity, and family life.

Today is ${date}.

${contextBlock}

How to respond:
- Ground every answer in the data above. Cite their actual numbers; if a domain says "not set up yet" or "not logged", say so honestly and suggest logging it.
- Use US customary units in everything user-facing: pounds, inches/feet, fluid ounces, US dollars. Never kg/cm/ml.
- Respect any injuries and dietary restrictions in the profile without exception.
- Be concise and actionable. No medical/financial disclaimers, no filler.
- When the member clearly wants to RECORD or CHANGE something (e.g. "log 40g protein", "add a task to call the dentist", "I drank 16 oz of water", "mark the laundry done"), call the matching function instead of only describing it. Otherwise, just answer in prose. Never invent data you weren't given.`;
}

/* ============================================================
   STREAMING CHAT ENDPOINT
   ============================================================ */

function sse(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

/**
 * Stream a coaching reply. Returns a raw `text/event-stream` Response whose
 * frames are JSON objects: `{type:"delta",text}` for streamed text,
 * `{type:"action",...}` for a proposed action, `{type:"done"}` at the end, and
 * `{type:"error",message}` on failure. The client (`useChatStream`) reuses the
 * same envelope.
 */
export const chatStream = createServerFn({ method: "POST" })
  .validator((data: { messages: ChatTurn[]; date?: ISODate }) => data)
  .handler(async (ctx: any): Promise<Response> => {
    await requireAuthSession(ctx.request);
    const date: ISODate = ctx.data?.date || todayISO();

    // Read all domain data here, while the per-user scope is still bound.
    const contextBlock = await buildUserContextBlock(date);

    const turns: ChatMessage[] = (ctx.data?.messages || [])
      .filter((m: ChatTurn) => m && (m.role === "user" || m.role === "assistant") && m.content)
      .slice(-MAX_TURNS)
      .map((m: ChatTurn) => ({ role: m.role, content: String(m.content).slice(0, MAX_CONTENT) }));

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(contextBlock, date) },
      ...turns,
    ];

    const apiKey = await getGrokApiKey();

    // Deterministic fallback: no key → still functional, returns a data snapshot.
    if (!apiKey) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            sse({
              type: "delta",
              text:
                "AI chat isn't configured yet (no GROK_API_KEY), so I can't reason live — but here's the snapshot I'd be working from:\n\n" +
                contextBlock +
                "\n\nAdd a GROK_API_KEY to enable full conversational coaching.",
            }),
          );
          controller.enqueue(sse({ type: "done" }));
          controller.close();
        },
      });
      return new Response(stream, { headers: SSE_HEADERS });
    }

    const model = await getGrokChatModel();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const ev of streamChat(apiKey, { model, messages, tools: ACTION_TOOLS })) {
            if (ev.type === "delta") {
              controller.enqueue(sse({ type: "delta", text: ev.text }));
            } else if (ev.type === "tool_call") {
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(ev.arguments || "{}");
              } catch {
                args = {};
              }
              controller.enqueue(sse({ type: "action", id: ev.id, name: ev.name, args }));
            }
          }
          controller.enqueue(sse({ type: "done" }));
        } catch (e) {
          console.warn("[chat] stream failed", e);
          controller.enqueue(
            sse({ type: "error", message: "The coach hit a snag. Please try again." }),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  });

/* ============================================================
   APPLY ACTION (executes a model-proposed action, on user approval)
   Reuses the shared voice-intent executor so chat and voice share one
   write path — no duplicated domain mutation logic.
   ============================================================ */

function actionToIntent(name: ChatActionName, args: Record<string, any>): VoiceIntent {
  switch (name) {
    case "log_meal":
      return {
        action: "logMeal",
        payload: {
          description: String(args.description ?? args.text ?? "meal"),
          calories: num(args.calories),
          protein: num(args.protein),
          carbs: num(args.carbs),
          fat: num(args.fat),
        },
        confidence: 1,
        requiresConfirmation: false,
      };
    case "log_water":
      return {
        action: "logWater",
        payload: { milliliters: flOzToMl(num(args.ounces)) ?? 250 },
        confidence: 1,
        requiresConfirmation: false,
      };
    case "add_task":
      return {
        action: "createTask",
        payload: {
          text: String(args.text ?? "").trim(),
          priority: num(args.priority) || undefined,
        },
        confidence: 1,
        requiresConfirmation: false,
      };
    case "mark_task_done":
      return {
        action: "markTaskDone",
        payload: { text: String(args.text ?? "").trim() },
        confidence: 1,
        requiresConfirmation: false,
      };
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const VALID_ACTIONS: ReadonlySet<string> = new Set<ChatActionName>([
  "log_meal",
  "log_water",
  "add_task",
  "mark_task_done",
]);

/**
 * Execute a single user-approved action. Returns a short confirmation the chat
 * appends to the conversation. Validates the action name and bounds inputs so a
 * malformed proposal can never reach the store unchecked.
 */
export const applyChatAction = createServerFn({ method: "POST" })
  .validator((data: { name: ChatActionName; args: Record<string, unknown> }) => data)
  .handler(async (ctx: any): Promise<{ ok: boolean; message: string }> => {
    await requireAuthSession(ctx.request);
    const name = ctx.data?.name as ChatActionName;
    if (!VALID_ACTIONS.has(name)) {
      return { ok: false, message: "Unknown action." };
    }
    const intent = actionToIntent(name, ctx.data?.args || {});
    const result = await executeVoiceIntentImpl(intent);
    return { ok: result.success, message: result.spokenText };
  });

/* ============================================================
   CONVERSATION HISTORY (ADR-018)
   Personal-scoped persistence so the transcript survives navigation/reloads
   and past chats are browsable. Stored in `chat-conversations.json`.
   ============================================================ */

/** Keep storage bounded — drop the oldest beyond this many conversations. */
const MAX_CONVERSATIONS = 100;
/** Per-conversation message cap (defensive — a runaway transcript can't bloat the store). */
const MAX_MESSAGES = 400;

function sanitizeMessages(raw: unknown): ChatMessageRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && m.content)
    .slice(-MAX_MESSAGES)
    .map((m: any, i: number) => ({
      id: String(m.id || `m-${i}`),
      role: m.role as ChatMessageRecord["role"],
      content: String(m.content).slice(0, MAX_CONTENT),
      createdAt: Number(m.createdAt) || Date.now(),
    }));
}

/** List past conversations as lightweight summaries (no transcripts), recent first. */
export const loadChatHistory = createServerFn({ method: "GET" }).handler(
  async (ctx: any): Promise<{ conversations: ChatConversationSummary[] }> => {
    await requireAuthSession(ctx.request);
    const store = await loadChatConversationsImpl();
    const conversations = sortByRecent(
      store.conversations.filter((c) => !c.deletedAt && c.messages.length > 0),
    ).map(toSummary);
    return { conversations };
  },
);

/** Load one full conversation transcript by id (null if missing/deleted). */
export const loadChatConversation = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async (ctx: any): Promise<ChatConversation | null> => {
    await requireAuthSession(ctx.request);
    const store = await loadChatConversationsImpl();
    return store.conversations.find((c) => c.id === ctx.data?.id && !c.deletedAt) ?? null;
  });

/** Upsert a conversation's transcript. Returns the saved conversation's summary. */
export const saveChatConversation = createServerFn({ method: "POST" })
  .validator((data: { id: string; messages: ChatMessageRecord[] }) => data)
  .handler(async (ctx: any): Promise<{ summary: ChatConversationSummary }> => {
    await requireAuthSession(ctx.request);
    const id = String(ctx.data?.id || "").trim();
    const messages = sanitizeMessages(ctx.data?.messages);
    if (!id || messages.length === 0) {
      throw new Error("A conversation id and at least one message are required.");
    }

    // CAS update: the mutate may re-run on write conflict, so it recomputes
    // from the freshest conversations each attempt.
    let saved: ChatConversation | null = null;
    await updateChatConversationsImpl((conversations) => {
      const existing = conversations.find((c) => c.id === id);
      const now = Date.now();
      saved = {
        id,
        title: deriveTitle(messages),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        messages,
      };
      return upsertConversation(
        conversations.filter((c) => !c.deletedAt),
        saved,
      ).slice(0, MAX_CONVERSATIONS);
    });
    if (!saved) throw new Error("Failed to save the conversation.");
    return { summary: toSummary(saved) };
  });

/** Soft-delete a conversation by id. */
export const deleteChatConversation = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async (ctx: any): Promise<{ ok: boolean }> => {
    await requireAuthSession(ctx.request);
    const id = ctx.data?.id;
    const now = Date.now();
    await updateChatConversationsImpl((conversations) =>
      conversations.map((c) => (c.id === id ? { ...c, deletedAt: now, updatedAt: now } : c)),
    );
    return { ok: true };
  });
