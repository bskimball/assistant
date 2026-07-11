import type { ISODate } from "@/lib/domain";
import {
  getGrokApiKey,
  getGrokChatModel,
  streamChat,
  type ChatMessage,
  type ChatTool,
} from "@/server/adapters/ai";
import type { ChatActionName } from "@/server/chat-action-impl";

/** A single conversation turn sent from the client. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Keep the prompt bounded: only the most recent turns are sent to the model. */
const MAX_TURNS = 24;
const MAX_CONTENT = 4000;

const DATE_PARAM_DESCRIPTION =
  "Target day. Use 'today', 'yesterday', or 'tomorrow' for relative days; otherwise an absolute ISO date YYYY-MM-DD. Omit for today.";

const ACTION_TOOLS: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "log_meal",
      description:
        "Record a meal/food the member ate. Defaults to today; set `date` when they name another day. Provide macros when the member states them; otherwise omit and they'll be estimated.",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "What was eaten, e.g. '2 eggs and toast'",
          },
          calories: { type: "number" },
          protein: { type: "number", description: "grams" },
          carbs: { type: "number", description: "grams" },
          fat: { type: "number", description: "grams" },
          date: { type: "string", description: DATE_PARAM_DESCRIPTION },
        },
        required: ["description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_water",
      description:
        "Record water the member drank, in US fluid ounces. Defaults to today; set `date` when they name another day.",
      parameters: {
        type: "object",
        properties: {
          ounces: { type: "number", description: "fluid ounces" },
          date: { type: "string", description: DATE_PARAM_DESCRIPTION },
        },
        required: ["ounces"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_task",
      description:
        "Add a task/to-do for the member. Defaults to today; set `date` when they name another day.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          priority: {
            type: "number",
            description: "1 (highest) to 3 (lowest)",
          },
          date: { type: "string", description: DATE_PARAM_DESCRIPTION },
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
        properties: {
          text: { type: "string", description: "text of the task to complete" },
        },
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

function isLikelyJsonBlob(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return t.startsWith("```") || t.startsWith("{") || t.startsWith("[");
}

function systemPrompt(contextBlock: string, date: ISODate): string {
  const weekday = new Date(date + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC",
  });
  return `You are Compass Coach — the member's personal life coach, certified strength & conditioning coach, and CFP-level financial advisor, all in one warm, direct voice. You converse about their real, recorded data and help them improve their fitness, nutrition, finances, productivity, and family life.

Today is ${date} (${weekday}). When the member logs something for a past or future day (e.g. "yesterday", "on Monday"), pass the target day in the action's \`date\` field — prefer 'today'/'yesterday'/'tomorrow', otherwise an absolute YYYY-MM-DD you compute from today's date. Omit \`date\` for today.

${contextBlock}

How to respond:
- Ground every answer in the data above. Cite their actual numbers; if a domain says "not set up yet" or "not logged", say so honestly and suggest logging it.
- Use US customary units in everything user-facing: pounds, inches/feet, fluid ounces, US dollars. Never kg/cm/ml.
- Respect any injuries and dietary restrictions in the profile without exception.
- Never propose that his wife start a business, sell products, or take on income work; her time as a stay-at-home parent is not spare capacity. Anything involving her must be jointly chosen and put the execution burden on Brian.
- Be concise and actionable. No medical/financial disclaimers, no filler.
- When the member shares something durable (a new goal, preference, constraint, upcoming life event, milestone, or win), call save_memory. When a remembered fact changed or is disavowed, call update_memory or forget_memory using the ids shown in the "What you remember about the member" section. Never save transient daily facts that belong in logs.
- When the member clearly wants to RECORD or CHANGE something (e.g. "log 40g protein", "add a task to call the dentist", "I drank 16 oz of water", "mark the laundry done"), call the matching function. Also answer in a short plain-English sentence (what you queued + any progress toward their targets). Do not only emit a tool call with no prose.
- Never print JSON, code fences, function-call syntax, or raw tool arguments to the member. Tools are for the app; prose is for the member. Never invent data you weren't given.`;
}

function sse(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

/**
 * Build a raw SSE response from a context block already read by the caller.
 * This module intentionally performs no domain/store reads: callers must build
 * the scoped context before returning this Response (ADR-017/018).
 */
export async function createChatStreamResponse(input: {
  contextBlock: string;
  date: ISODate;
  turns: ChatTurn[];
}): Promise<Response> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(input.contextBlock, input.date) },
    ...input.turns
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
      .slice(-MAX_TURNS)
      .map((m) => ({
        role: m.role,
        content: String(m.content).slice(0, MAX_CONTENT),
      })),
  ];
  const apiKey = await getGrokApiKey();

  if (!apiKey) {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          sse({
            type: "delta",
            text:
              "AI chat isn't configured yet (no GROK_API_KEY), so I can't reason live — but here's the snapshot I'd be working from:\n\n" +
              input.contextBlock +
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
        for await (const ev of streamChat(apiKey, {
          model,
          messages,
          tools: ACTION_TOOLS,
        })) {
          if (ev.type === "delta") {
            if (sawProse) {
              if (ev.text) controller.enqueue(sse({ type: "delta", text: ev.text }));
              continue;
            }
            textBuf += ev.text;
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

        if (toolNames.length > 0 && !sawProse) {
          const followUp = toolNames.every(isMemoryActionName)
            ? "You already saved the durable fact(s) the member shared — do not mention tools or print JSON. Answer their last message in a short plain-English sentence."
            : `You already proposed action card(s) (${toolNames.join(", ")}) for the member to Apply — do not call tools or print JSON/code. Confirm in one short plain-English sentence what you queued and, if relevant, how it moves them toward today's targets.`;
          for await (const ev of streamChat(apiKey, {
            model,
            messages: [...messages, { role: "system", content: followUp }],
          })) {
            if (ev.type === "delta" && ev.text)
              controller.enqueue(sse({ type: "delta", text: ev.text }));
          }
        }
        controller.enqueue(sse({ type: "done" }));
      } catch (e) {
        console.warn("[chat] stream failed", e);
        controller.enqueue(
          sse({
            type: "error",
            message: "The coach hit a snag. Please try again.",
          }),
        );
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

function isMemoryActionName(name: ChatActionName): boolean {
  return name === "save_memory" || name === "update_memory" || name === "forget_memory";
}
