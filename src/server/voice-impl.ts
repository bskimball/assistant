import type { AIInteraction, ISODate, VoiceIntent, VoiceTranscript } from "@/lib/domain";
import {
  addDaysISO,
  createProductivityTask,
  flOzToMl,
  legacyTodoFromProductivityTask,
  mlToFlOz,
  resolveVoiceTargetDate,
  todayISO,
} from "@/lib/domain";
import { completeJSON, getGrokApiKey, getGrokJsonModel } from "@/server/adapters/ai";
import {
  addMacros,
  emptyMacros,
  estimateMacrosFromText,
  loadDailyNutritionImpl,
  saveDailyNutritionImpl,
} from "@/server/nutrition-impl";
import {
  loadProductivityTasksForDayImpl,
  saveProductivityTasksForDayImpl,
} from "@/server/productivity-impl";
import { getDomainStore } from "@/server/store";
import { loadTodosImpl, saveTodosImpl } from "@/server/todos";

export interface VoiceProcessResult {
  transcriptId: string;
  aiInteractionId: string;
  intent: VoiceIntent;
  spokenText: string;
  success: boolean;
  legacyTodo?: import("@/lib/todos").Todo;
  error?: string;
}

function buildIntentPrompt(transcriptText: string, today: ISODate): string {
  return `You are the intent parser for Brian's personal life assistant.
Today's date is ${today}.

Return ONLY JSON matching:
{
  "action": "createTask" | "logWater" | "logMeal" | "deleteTask" | "markTaskDone" | "unknown",
  "payload": {},
  "confidence": 0.0-1.0,
  "requiresConfirmation": boolean,
  "clarificationQuestion": "optional"
}

Rules:
- createTask/logWater/logMeal/markTaskDone can execute immediately.
- deleteTask requires confirmation.
- For createTask include { text: string, date?: "today"|"tomorrow"|YYYY-MM-DD }.
- For logMeal include { description: string, date?: ... } and explicit macro fields if spoken
  (use keys calories, protein, carbs, fat — not proteinGrams). If the user only states a macro
  (e.g. "log 40g protein"), set description to something like "40g protein" and protein: 40.
- For logWater include { fluidOunces: number } for US customary phrases, or
  { milliliters: number } if the user explicitly says ml. Infer 8 fl oz if vague "a glass".
- Extract the key request precisely. Do not invent.
- If garbage or ambiguous (confidence < 0.55) set action:"unknown" and provide a short spoken clarificationQuestion.

User said (verbatim):
"""${transcriptText}"""
`;
}

function fallbackParseIntent(text: string, _today: ISODate): VoiceIntent {
  const t = text.toLowerCase().trim();
  const addMatch = t.match(
    /(?:add|create|new|remind me to|todo|task)\s+(?:task\s+)?["']?(.+?)["']?(?:\s+(?:for|on)\s+(today|tomorrow|\d{4}-\d{2}-\d{2}))?$/i,
  );
  if (addMatch || t.startsWith("add ") || t.includes("remind me")) {
    const rawText = (
      addMatch?.[1] || text.replace(/^(add|create|new|remind me to|task)\s*/i, "")
    ).trim();
    const datePart = addMatch?.[2] || (t.includes("tomorrow") ? "tomorrow" : "today");
    const taskText = rawText.replace(/\s+(for|on)\s+(today|tomorrow).*$/i, "").trim() || text;
    return {
      action: "createTask",
      payload: { text: taskText, date: datePart },
      confidence: 0.75,
      requiresConfirmation: false,
    };
  }
  if (t.includes("water") || t.includes("drink")) {
    const waterMatch = t.match(
      /(\d+)\s*(oz|ounce|ounces|fl oz|fluid ounce|fluid ounces|ml|milli|glass|cup)/,
    );
    const unit = waterMatch?.[2] ?? "";
    const amount = waterMatch ? parseInt(waterMatch[1], 10) : 8;
    const ml =
      unit.includes("ml") || unit.includes("milli")
        ? amount
        : unit.includes("cup")
          ? (flOzToMl(amount * 8) ?? 237)
          : unit.includes("glass")
            ? (flOzToMl(amount * 8) ?? 237)
            : (flOzToMl(amount) ?? 237);
    return {
      action: "logWater",
      payload: { milliliters: ml },
      confidence: 0.8,
      requiresConfirmation: false,
    };
  }
  if (t.includes("delete") || t.includes("remove")) {
    const what = text.replace(/.*?(delete|remove)\s*/i, "").trim() || "item";
    return {
      action: "deleteTask",
      payload: { text: what },
      confidence: 0.65,
      requiresConfirmation: true,
    };
  }
  if (t.includes("done") || t.includes("complete") || t.includes("finish")) {
    const what =
      text.replace(/.*?(mark|set|make)\s+(.+?)\s+(done|complete).*/i, "$2").trim() || text;
    return {
      action: "markTaskDone",
      payload: { text: what },
      confidence: 0.7,
      requiresConfirmation: false,
    };
  }
  return {
    action: "unknown",
    payload: {},
    confidence: 0.3,
    requiresConfirmation: false,
    clarificationQuestion:
      'Sorry, I heard "' + text.slice(0, 60) + '..." — what would you like me to do?',
  };
}

async function extractVoiceIntentImpl(
  transcriptText: string,
  today: ISODate,
): Promise<VoiceIntent> {
  const apiKey = await getGrokApiKey();
  if (!apiKey) return fallbackParseIntent(transcriptText, today);

  try {
    const parsed = await completeJSON<any>(apiKey, {
      model: await getGrokJsonModel(),
      messages: [
        {
          role: "system",
          content: "Return strictly valid minified JSON only. No prose.",
        },
        { role: "user", content: buildIntentPrompt(transcriptText, today) },
      ],
      temperature: 0.1,
      maxTokens: 400,
    });
    return {
      action: parsed.action || "unknown",
      payload: parsed.payload || {},
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      requiresConfirmation: !!parsed.requiresConfirmation,
      clarificationQuestion: parsed.clarificationQuestion,
    };
  } catch (e) {
    console.warn("[voice] Grok intent failed, using fallback", e);
    return fallbackParseIntent(transcriptText, today);
  }
}

/**
 * Human-readable suffix naming the target day when it isn't today, so a
 * confirmation surfaces the *resolved* date — a mis-parsed "yesterday" is
 * visible instead of silently landing on the wrong day. Returns "" for today.
 */
function describeDay(date: ISODate, today: ISODate): string {
  if (date === today) return "";
  const rel =
    date === addDaysISO(today, -1)
      ? "yesterday"
      : date === addDaysISO(today, 1)
        ? "tomorrow"
        : new Date(date + "T12:00:00Z").toLocaleDateString("en-US", {
            weekday: "long",
            timeZone: "UTC",
          });
  const md = new Date(date + "T12:00:00Z").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return ` for ${rel}, ${md}`;
}

export async function executeVoiceIntentImpl(intent: VoiceIntent): Promise<{
  spokenText: string;
  success: boolean;
  legacyTodo?: import("@/lib/todos").Todo;
  error?: string;
}> {
  const now = Date.now();
  const today = todayISO();

  try {
    switch (intent.action) {
      case "createTask": {
        const text = (intent.payload.text || intent.payload.query || "").toString().trim();
        if (!text) throw new Error("Missing task text");
        const targetDate = resolveVoiceTargetDate(
          intent.payload.date ?? intent.payload.when,
          today,
        );
        const prodTask = createProductivityTask({
          text,
          date: targetDate,
          notes: intent.payload.notes,
          priority: intent.payload.priority,
          source: "ai",
        });
        const existing = await loadProductivityTasksForDayImpl(targetDate);
        await saveProductivityTasksForDayImpl({
          date: targetDate,
          tasks: [...(existing?.tasks || []), prodTask],
        });

        const legacy = legacyTodoFromProductivityTask(prodTask);
        const currentTodos = await loadTodosImpl();
        await saveTodosImpl({
          items: [...(currentTodos?.items || []), legacy],
        });

        return {
          spokenText: `Task added: ${text}${describeDay(targetDate, today)}`,
          success: true,
          legacyTodo: legacy,
        };
      }

      case "logWater": {
        const ml = Number(
          intent.payload.milliliters ?? intent.payload.amountMl ?? intent.payload.ml ?? 250,
        );
        const date = resolveVoiceTargetDate(intent.payload.date, today);
        const nutrition = await loadDailyNutritionImpl(date);
        await saveDailyNutritionImpl({
          date,
          nutrition: {
            ...nutrition,
            waterMl: (nutrition.waterMl ?? 0) + Math.max(1, Math.round(ml)),
            updatedAt: now,
          } as any,
        });
        return {
          spokenText: `Logged ${mlToFlOz(ml) ?? Math.round(ml)} fl oz water.${describeDay(date, today)}`,
          success: true,
        };
      }

      case "logMeal": {
        const date = resolveVoiceTargetDate(intent.payload.date, today);
        const nutrition = await loadDailyNutritionImpl(date);
        const explicitMacros = {
          calories: Number(intent.payload.calories ?? intent.payload.kcal ?? 0),
          protein: Number(
            intent.payload.protein ?? intent.payload.proteinG ?? intent.payload.proteinGrams ?? 0,
          ),
          carbs: Number(
            intent.payload.carbs ?? intent.payload.carbsG ?? intent.payload.carbGrams ?? 0,
          ),
          fat: Number(intent.payload.fat ?? intent.payload.fatG ?? intent.payload.fatGrams ?? 0),
        };
        // Models often return { proteinGrams: 40 } without a description.
        const desc = (
          intent.payload.description ||
          intent.payload.text ||
          (explicitMacros.protein > 0 ? `${explicitMacros.protein}g protein` : "meal")
        ).toString();
        const estimated = estimateMacrosFromText(desc);
        const macros =
          explicitMacros.calories ||
          explicitMacros.protein ||
          explicitMacros.carbs ||
          explicitMacros.fat
            ? addMacros(emptyMacros(), {
                ...explicitMacros,
                calories:
                  explicitMacros.calories ||
                  explicitMacros.protein * 4 + explicitMacros.carbs * 4 + explicitMacros.fat * 9,
              })
            : estimated.macros;
        const mealLog = {
          id: `meal-${now}`,
          timestamp: now,
          foodItems: [
            {
              id: `food-${now}`,
              name: desc,
              quantity: 1,
              unit: "serving",
              macros,
              source: "user" as const,
            },
          ],
          estimateConfidence: estimated.confidence,
          createdAt: now,
        };
        await saveDailyNutritionImpl({
          date,
          nutrition: {
            ...nutrition,
            mealLogs: [...(nutrition.mealLogs || []), mealLog],
          } as any,
        });
        return {
          spokenText: `Logged meal: ${desc}${describeDay(date, today)}`,
          success: true,
        };
      }

      case "markTaskDone": {
        const matchText = (intent.payload.text || "").toString().toLowerCase();
        const targetDate = resolveVoiceTargetDate(intent.payload.date, today);
        const payload = await loadProductivityTasksForDayImpl(targetDate);
        const updatedTasks = (payload?.tasks || []).map((t) =>
          t.text.toLowerCase().includes(matchText) || matchText.includes(t.text.toLowerCase())
            ? {
                ...t,
                status: "done" as const,
                done: true,
                completedAt: now,
                updatedAt: now,
              }
            : t,
        );
        await saveProductivityTasksForDayImpl({
          date: targetDate,
          tasks: updatedTasks,
        });

        const todos = await loadTodosImpl();
        const updatedLegacy = (todos?.items || []).map((t) =>
          t.text.toLowerCase().includes(matchText) ? { ...t, done: true, completedAt: now } : t,
        );
        await saveTodosImpl({ items: updatedLegacy });
        return { spokenText: "Marked task done.", success: true };
      }

      case "deleteTask": {
        const matchText = (intent.payload.text || "").toString().toLowerCase();
        const targetDate = resolveVoiceTargetDate(intent.payload.date, today);
        const payload = await loadProductivityTasksForDayImpl(targetDate);
        const filtered = (payload?.tasks || []).filter(
          (t) =>
            !(t.text.toLowerCase().includes(matchText) || matchText.includes(t.text.toLowerCase())),
        );
        await saveProductivityTasksForDayImpl({
          date: targetDate,
          tasks: filtered,
        });

        const todos = await loadTodosImpl();
        const filteredLegacy = (todos?.items || []).filter(
          (t) =>
            !(t.text.toLowerCase().includes(matchText) || matchText.includes(t.text.toLowerCase())),
        );
        await saveTodosImpl({ items: filteredLegacy });
        return { spokenText: "Task deleted.", success: true };
      }

      case "unknown":
      default:
        return {
          spokenText: intent.clarificationQuestion || "Can you say that again or be more specific?",
          success: false,
        };
    }
  } catch (e: any) {
    return {
      spokenText: "Sorry, I had trouble with that. " + (e?.message || ""),
      success: false,
      error: String(e),
    };
  }
}

export async function processVoiceInputImpl(data: {
  transcriptText: string;
  language?: string;
  forceExecute?: boolean;
}): Promise<VoiceProcessResult> {
  const now = Date.now();
  const today = todayISO();
  const text = (data.transcriptText || "").trim();
  if (!text) {
    return {
      transcriptId: "",
      aiInteractionId: "",
      intent: {
        action: "unknown",
        payload: {},
        confidence: 0,
        requiresConfirmation: false,
        clarificationQuestion: "Empty transcript.",
      },
      spokenText: "I did not hear anything.",
      success: false,
      error: "empty",
    };
  }

  const store = await getDomainStore();
  const transcriptId = `voice-${now}`;
  const transcript: VoiceTranscript = {
    id: transcriptId,
    createdAt: now,
    timestamp: now,
    audioR2Key: "",
    transcriptText: text,
    durationSec: Math.max(1, Math.round(text.split(" ").length / 2.5)),
    language: data.language,
  };
  await store.putVoiceTranscript(transcript);
  const dayForLog = new Date(now).toISOString().slice(0, 10);
  await store.log.append("voice-transcripts", dayForLog, transcript);

  const intent = await extractVoiceIntentImpl(text, today);
  const shouldExecute = data.forceExecute || !intent.requiresConfirmation;
  const exec = shouldExecute
    ? await executeVoiceIntentImpl(intent)
    : {
        spokenText: intent.clarificationQuestion || `About to ${intent.action}. Are you sure?`,
        success: false,
      };

  const interactionId = `ai-${now}`;
  // Human-readable only — Recent Activity on the dashboard shows `response`
  // verbatim. Keep structured debug data out of the user-facing string.
  const interaction: AIInteraction = {
    id: interactionId,
    createdAt: now,
    timestamp: now,
    intent: intent.action,
    prompt: `voice:${text.slice(0, 120)}`,
    response: exec.spokenText,
    model: "grok-voice-pipeline",
    tokensIn: undefined,
    tokensOut: undefined,
  };
  await store.putAIInteraction(interaction);
  await store.log.append("ai-interactions", dayForLog, interaction);
  await store.putVoiceTranscript({
    ...transcript,
    aiInteractionId: interactionId,
    updatedAt: now,
  });

  return {
    transcriptId,
    aiInteractionId: interactionId,
    intent,
    spokenText: exec.spokenText,
    success: exec.success && shouldExecute,
    legacyTodo: exec.legacyTodo,
    error: exec.error,
  };
}
