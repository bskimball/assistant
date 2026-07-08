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
  CoachMemory,
  CoachMemoryCategory,
  ISODate,
  VoiceIntent,
} from "@/lib/domain";
import { todayISO, flOzToMl, newId } from "@/lib/domain";
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
  loadCoachMemoriesImpl,
  updateChatConversationsImpl,
  updateCoachMemoriesImpl,
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

export type MemoryActionName = "save_memory" | "update_memory" | "forget_memory";
export type VoiceChatActionName = "log_meal" | "log_water" | "add_task" | "mark_task_done";
export type ChatActionName = VoiceChatActionName | MemoryActionName;

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
  {
    type: "function",
    function: {
      name: "save_memory",
      description:
        "Remember a durable fact about the member across conversations: a goal, preference, constraint, upcoming life event, or milestone/win.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["goal", "preference", "constraint", "life_event", "milestone"],
          },
          content: {
            type: "string",
            description: "One durable fact in third person. Do not save transient daily logs.",
          },
        },
        required: ["category", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_memory",
      description:
        "Revise an existing remembered fact when it changed or the member corrected it. Use the memory id from the context.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The memory id to update." },
          content: { type: "string", description: "The revised durable fact." },
          category: {
            type: "string",
            enum: ["goal", "preference", "constraint", "life_event", "milestone"],
          },
        },
        required: ["id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget_memory",
      description:
        "Forget an existing remembered fact when the member disavows it or says it no longer applies. Use the memory id from the context.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The memory id to forget." },
        },
        required: ["id"],
      },
    },
  },
];

/** True when the buffer looks like a JSON/code payload rather than prose. */
function isLikelyJsonBlob(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("```")) return true;
  if (t.startsWith("{") || t.startsWith("[")) {
    // Ambiguous until we have a few chars; treat leading brace as JSON-ish.
    return true;
  }
  return false;
}

function systemPrompt(contextBlock: string, date: ISODate): string {
  return `You are Compass Coach — the member's personal life coach, certified strength & conditioning coach, and CFP-level financial advisor, all in one warm, direct voice. You converse about their real, recorded data and help them improve their fitness, nutrition, finances, productivity, and family life.

Today is ${date}.

${contextBlock}

How to respond:
- Ground every answer in the data above. Cite their actual numbers; if a domain says "not set up yet" or "not logged", say so honestly and suggest logging it.
- Use US customary units in everything user-facing: pounds, inches/feet, fluid ounces, US dollars. Never kg/cm/ml.
- Respect any injuries and dietary restrictions in the profile without exception.
- Be concise and actionable. No medical/financial disclaimers, no filler.
- When the member shares something durable (a new goal, preference, constraint, upcoming life event, milestone, or win), call save_memory. When a remembered fact changed or is disavowed, call update_memory or forget_memory using the ids shown in the "What you remember about the member" section. Never save transient daily facts that belong in logs.
- When the member clearly wants to RECORD or CHANGE something (e.g. "log 40g protein", "add a task to call the dentist", "I drank 16 oz of water", "mark the laundry done"), call the matching function. Also answer in a short plain-English sentence (what you queued + any progress toward their targets). Do not only emit a tool call with no prose.
- Never print JSON, code fences, function-call syntax, or raw tool arguments to the member. Tools are for the app; prose is for the member. Never invent data you weren't given.`;
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
  .handler(async ({ data }): Promise<Response> => {
    await requireAuthSession();
    const date: ISODate = data?.date || todayISO();

    // Read all domain data here, while the per-user scope is still bound.
    const contextBlock = await buildUserContextBlock(date);

    const turns: ChatMessage[] = (data?.messages || [])
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
          let textBuf = "";
          let sawProse = false;
          const toolNames: ChatActionName[] = [];
          for await (const ev of streamChat(apiKey, { model, messages, tools: ACTION_TOOLS })) {
            if (ev.type === "delta") {
              if (sawProse) {
                if (ev.text) controller.enqueue(sse({ type: "delta", text: ev.text }));
                continue;
              }
              textBuf += ev.text;
              // Hold back pure JSON blobs so tool payloads never appear as the
              // assistant message. Once we know it's prose, stream live.
              if (ev.text && !isLikelyJsonBlob(textBuf)) {
                controller.enqueue(sse({ type: "delta", text: textBuf }));
                sawProse = true;
                textBuf = "";
              }
            } else if (ev.type === "tool_call") {
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(ev.arguments || "{}");
              } catch {
                args = {};
              }
              toolNames.push(ev.name as ChatActionName);
              controller.enqueue(sse({ type: "action", id: ev.id, name: ev.name, args }));
            }
          }

          // Grok 4.5 often tool-calls with empty content. Memory tools auto-apply
          // (ADR-020) and log_* tools show an Apply card — either way the member
          // needs a prose reply. Follow-up is a pure LLM call (no store access).
          if (toolNames.length > 0 && !sawProse) {
            const followUp = toolNames.every(isMemoryAction)
              ? "You already saved the durable fact(s) the member shared — do not mention tools or print JSON. Answer their last message in a short plain-English sentence."
              : `You already proposed action card(s) (${toolNames.join(", ")}) for the member to Apply — do not call tools or print JSON/code. Confirm in one short plain-English sentence what you queued and, if relevant, how it moves them toward today's targets.`;
            for await (const ev of streamChat(apiKey, {
              model,
              messages: [...messages, { role: "system", content: followUp }],
            })) {
              if (ev.type === "delta" && ev.text) {
                controller.enqueue(sse({ type: "delta", text: ev.text }));
              }
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

function actionToIntent(name: VoiceChatActionName, args: Record<string, any>): VoiceIntent {
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

const COACH_MEMORY_CATEGORIES: readonly CoachMemoryCategory[] = [
  "goal",
  "preference",
  "constraint",
  "life_event",
  "milestone",
];

const MAX_LIVE_MEMORIES = 100;
const MAX_MEMORY_CONTENT = 500;

function normalizeMemoryCategory(value: unknown): CoachMemoryCategory {
  return COACH_MEMORY_CATEGORIES.includes(value as CoachMemoryCategory)
    ? (value as CoachMemoryCategory)
    : "preference";
}

function sanitizeMemoryContent(value: unknown): string {
  return String(value ?? "")
    .trim()
    .slice(0, MAX_MEMORY_CONTENT);
}

function enforceMemoryCap(memories: CoachMemory[], now: number): CoachMemory[] {
  const live = memories.filter((m) => !m.deletedAt);
  const excess = live.length - MAX_LIVE_MEMORIES;
  if (excess <= 0) return memories;

  const oldestFirst = (a: CoachMemory, b: CoachMemory) =>
    (a.updatedAt || a.createdAt) - (b.updatedAt || b.createdAt);
  const drop = [
    ...live.filter((m) => m.category !== "constraint").sort(oldestFirst),
    ...live.filter((m) => m.category === "constraint").sort(oldestFirst),
  ]
    .slice(0, excess)
    .map((m) => m.id);
  const dropIds = new Set(drop);

  return memories.map((m) => (dropIds.has(m.id) ? { ...m, deletedAt: now, updatedAt: now } : m));
}

function isMemoryAction(name: ChatActionName): name is MemoryActionName {
  return name === "save_memory" || name === "update_memory" || name === "forget_memory";
}

async function applyMemoryAction(
  name: MemoryActionName,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; message: string }> {
  const now = Date.now();

  if (name === "save_memory") {
    const content = sanitizeMemoryContent(args.content);
    if (!content) return { ok: false, message: "I need something specific to remember." };

    const memory: CoachMemory = {
      id: newId("mem"),
      category: normalizeMemoryCategory(args.category),
      content,
      createdAt: now,
      updatedAt: now,
      sourceConversationId:
        typeof args.sourceConversationId === "string"
          ? args.sourceConversationId
          : typeof args.conversationId === "string"
            ? args.conversationId
            : undefined,
    };

    await updateCoachMemoriesImpl((memories) => enforceMemoryCap([...memories, memory], now));
    return { ok: true, message: "Noted — I'll remember that." };
  }

  if (name === "update_memory") {
    const id = String(args.id ?? "").trim();
    const content = sanitizeMemoryContent(args.content);
    if (!id) return { ok: false, message: "I need the memory id to update." };
    if (!content) return { ok: false, message: "I need the updated memory text." };

    let found = false;
    await updateCoachMemoriesImpl((memories) =>
      memories.map((m) => {
        if (m.id !== id || m.deletedAt) return m;
        found = true;
        return {
          ...m,
          content,
          category:
            args.category === undefined ? m.category : normalizeMemoryCategory(args.category),
          updatedAt: now,
        };
      }),
    );
    return found
      ? { ok: true, message: "Updated — I'll remember it that way." }
      : { ok: false, message: "I couldn't find that memory to update." };
  }

  const id = String(args.id ?? "").trim();
  if (!id) return { ok: false, message: "I need the memory id to forget." };

  let found = false;
  await updateCoachMemoriesImpl((memories) =>
    memories.map((m) => {
      if (m.id !== id || m.deletedAt) return m;
      found = true;
      return { ...m, deletedAt: now, updatedAt: now };
    }),
  );
  return found
    ? { ok: true, message: "Forgotten." }
    : { ok: false, message: "I couldn't find that memory to forget." };
}

const VALID_ACTIONS: ReadonlySet<string> = new Set<ChatActionName>([
  "log_meal",
  "log_water",
  "add_task",
  "mark_task_done",
  "save_memory",
  "update_memory",
  "forget_memory",
]);

/**
 * Execute a single user-approved action. Returns a short confirmation the chat
 * appends to the conversation. Validates the action name and bounds inputs so a
 * malformed proposal can never reach the store unchecked.
 */
export const applyChatAction = createServerFn({ method: "POST" })
  .validator((data: { name: ChatActionName; args: Record<string, unknown> }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean; message: string }> => {
    await requireAuthSession();
    const name = data?.name as ChatActionName;
    if (!VALID_ACTIONS.has(name)) {
      return { ok: false, message: "Unknown action." };
    }
    if (isMemoryAction(name)) {
      return applyMemoryAction(name, data?.args || {});
    }
    const intent = actionToIntent(name, data?.args || {});
    const result = await executeVoiceIntentImpl(intent);
    return { ok: result.success, message: result.spokenText };
  });

/* ============================================================
   COACH MEMORIES (ADR-020)
   Personal-scoped durable facts the coach can use across conversations.
   Stored in `coach-memories.json`.
   ============================================================ */

/** List live coach memories, newest-updated first. */
export const loadCoachMemories = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ memories: CoachMemory[] }> => {
    await requireAuthSession();
    const store = await loadCoachMemoriesImpl();
    return {
      memories: store.memories
        .filter((m) => !m.deletedAt)
        .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)),
    };
  },
);

/** Soft-delete a coach memory by id. */
export const deleteCoachMemory = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    await requireAuthSession();
    const id = data?.id;
    const now = Date.now();
    await updateCoachMemoriesImpl((memories) =>
      memories.map((m) => (m.id === id ? { ...m, deletedAt: now, updatedAt: now } : m)),
    );
    return { ok: true };
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
  async (): Promise<{ conversations: ChatConversationSummary[] }> => {
    await requireAuthSession();
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
  .handler(async ({ data }): Promise<ChatConversation | null> => {
    await requireAuthSession();
    const store = await loadChatConversationsImpl();
    return store.conversations.find((c) => c.id === data?.id && !c.deletedAt) ?? null;
  });

/** Upsert a conversation's transcript. Returns the saved conversation's summary. */
export const saveChatConversation = createServerFn({ method: "POST" })
  .validator((data: { id: string; messages: ChatMessageRecord[] }) => data)
  .handler(async ({ data }): Promise<{ summary: ChatConversationSummary }> => {
    await requireAuthSession();
    const id = String(data?.id || "").trim();
    const messages = sanitizeMessages(data?.messages);
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
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    await requireAuthSession();
    const id = data?.id;
    const now = Date.now();
    await updateChatConversationsImpl((conversations) =>
      conversations.map((c) => (c.id === id ? { ...c, deletedAt: now, updatedAt: now } : c)),
    );
    return { ok: true };
  });
