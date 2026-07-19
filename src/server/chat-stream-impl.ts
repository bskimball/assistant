import type { ISODate } from "@/lib/domain";
import {
  getGrokApiKey,
  getGrokChatModel,
  streamChat,
  type ChatMessage,
  type ChatTool,
} from "@/server/adapters/ai";
import type { ChatActionName } from "@/server/chat-action-impl";
import {
  executeFinanceReadTool,
  isFinanceReadToolName,
  type ChatFinanceToolData,
} from "@/server/chat-finance-tools-impl";

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

export const ACTION_TOOLS: ChatTool[] = [
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
  {
    type: "function",
    function: {
      name: "find_transactions",
      description:
        "Search the household transaction ledger without changing it. Use for charge disputes, merchant searches, account/date/amount filtering, or to locate a transaction id. Set includeDeleted when investigating missing or deleted charges.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Merchant or descriptor text." },
          startDate: { type: "string", description: "Inclusive ISO date YYYY-MM-DD." },
          endDate: { type: "string", description: "Inclusive ISO date YYYY-MM-DD." },
          account: { type: "string", description: "Account name substring." },
          minAmount: { type: "number", description: "Minimum absolute dollar amount." },
          maxAmount: { type: "number", description: "Maximum absolute dollar amount." },
          includeDeleted: { type: "boolean", description: "Include soft-deleted transactions." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_recurring",
      description:
        "Inspect a bill, loan, or subscription by fuzzy name: configuration, recent matched charges, and a concise health insight. Use for subscription questions and 'did X get paid?'.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Bill or recurring item name." } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "explain_bill_health",
      description:
        "First stop for 'why does bill X look unpaid?' or 'something is wrong with X'. Returns the matching window, matched charges, and near-misses with exact reasons, including matched-but-deleted transaction ids.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Bill or recurring item name." } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "restore_transaction",
      description:
        "Propose restoring a soft-deleted transaction. Use when explain_bill_health reports matched-but-deleted; requires member approval before it changes the ledger.",
      parameters: {
        type: "object",
        properties: {
          transactionId: {
            type: "string",
            description: "Deleted transaction id from a read tool.",
          },
        },
        required: ["transactionId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_bill_paid",
      description:
        "Propose manually marking a bill paid for a month when no real ledger charge should be restored. Requires member approval and creates the existing manual paid transaction.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Bill or recurring item name." },
          month: { type: "string", description: "Payment month YYYY-MM; omit for current month." },
        },
        required: ["name"],
      },
    },
  },
];

function isLikelyJsonBlob(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return t.startsWith("```") || t.startsWith("{") || t.startsWith("[");
}

function falselyClaimsAppliedAction(text: string): boolean {
  return /\b(?:logged|recorded|added|created|marked|completed|applied|done|saved|finished)\b/i.test(
    text,
  );
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
- For bill disputes, subscription questions, or "did X get paid?", use the finance read tools instead of guessing from the compact finance summary. For "why does bill X look unpaid?" or "something is wrong with X", call explain_bill_health first. If its trace reports a matched-but-deleted candidate, explain that finding and propose restore_transaction with that exact transaction id; use mark_bill_paid only when a real charge should not be restored.
- Read-only finance tools execute privately during this response and their results are returned to you. Do not expose raw JSON. restore_transaction and mark_bill_paid are write proposals and are NOT executed until the member presses Apply.
- When the member clearly wants to RECORD or CHANGE something (e.g. "log 40g protein", "add a task to call the dentist", "I drank 16 oz of water", "mark the laundry done"), call the matching function. Non-memory actions are proposals that are NOT executed until the member presses Apply. Also answer in a short plain-English sentence saying what is ready to Apply or queued for approval, plus any progress toward their targets. Never claim a meal, drink, task, task completion, restored charge, or bill payment was already logged/applied. Do not only emit a tool call with no prose.
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
  financeToolData?: ChatFinanceToolData;
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
        const toolNames: ChatActionName[] = [];
        const pendingActions: Array<{
          type: "action";
          id: string;
          name: ChatActionName;
          args: Record<string, unknown>;
        }> = [];
        let roundMessages = messages;
        for (let round = 0; round < 4; round++) {
          const readResults: string[] = [];
          let calledReadTool = false;
          for await (const ev of streamChat(apiKey, {
            model,
            messages: roundMessages,
            tools: ACTION_TOOLS,
          })) {
            if (ev.type === "delta") {
              textBuf += ev.text;
              continue;
            }
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(ev.arguments || "{}");
            } catch {
              args = {};
            }
            if (isFinanceReadToolName(ev.name)) {
              calledReadTool = true;
              const result = input.financeToolData
                ? executeFinanceReadTool(ev.name, args, input.financeToolData)
                : { error: "Finance records were unavailable for this response." };
              readResults.push(`${ev.name} result: ${JSON.stringify(result)}`);
              continue;
            }
            const name = ev.name as ChatActionName;
            toolNames.push(name);
            const action = { type: "action" as const, id: ev.id, name, args };
            if (isMemoryActionName(name)) controller.enqueue(sse(action));
            else pendingActions.push(action);
          }
          if (!calledReadTool) break;
          roundMessages = [
            ...roundMessages,
            {
              role: "system",
              content:
                "Finance read-tool results (private data; summarize in prose, never print raw JSON):\n" +
                readResults.join("\n"),
            },
          ];
        }

        let prose = isLikelyJsonBlob(textBuf) ? "" : textBuf;
        const hasPendingActions = pendingActions.length > 0;
        if (hasPendingActions && falselyClaimsAppliedAction(prose)) prose = "";

        if (toolNames.length > 0 && !prose.trim()) {
          const followUp = toolNames.every(isMemoryActionName)
            ? "You already saved the durable fact(s) the member shared — do not mention tools or print JSON. Answer their last message in a short plain-English sentence."
            : `You proposed action card(s) (${toolNames.join(", ")}) that have NOT been executed. Do not call tools or print JSON/code. In one short plain-English sentence, say they are ready to Apply or queued for approval and, if relevant, how approval would move the member toward today's targets. Never say food, water, or a task was already logged/applied.`;
          for await (const ev of streamChat(apiKey, {
            model,
            messages: [...messages, { role: "system", content: followUp }],
          })) {
            if (ev.type === "delta") prose += ev.text;
          }
          if (hasPendingActions && falselyClaimsAppliedAction(prose)) {
            prose = "That action is ready to Apply.";
          }
        }
        if (prose) controller.enqueue(sse({ type: "delta", text: prose }));
        for (const action of pendingActions) controller.enqueue(sse(action));
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
