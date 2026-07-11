import type { CoachMemory, CoachMemoryCategory, VoiceIntent } from "@/lib/domain";
import { flOzToMl, newId } from "@/lib/domain";
import { updateCoachMemoriesImpl } from "@/server/domain-impl";
import { executeVoiceIntentImpl } from "@/server/voice-impl";

export type MemoryActionName = "save_memory" | "update_memory" | "forget_memory";
export type VoiceChatActionName = "log_meal" | "log_water" | "add_task" | "mark_task_done";
export type ChatActionName = VoiceChatActionName | MemoryActionName;

const VALID_ACTIONS: ReadonlySet<string> = new Set<ChatActionName>([
  "log_meal",
  "log_water",
  "add_task",
  "mark_task_done",
  "save_memory",
  "update_memory",
  "forget_memory",
]);
const COACH_MEMORY_CATEGORIES: readonly CoachMemoryCategory[] = [
  "goal",
  "preference",
  "constraint",
  "life_event",
  "milestone",
];
const MAX_LIVE_MEMORIES = 100;
const MAX_MEMORY_CONTENT = 500;

export function isChatActionName(value: unknown): value is ChatActionName {
  return typeof value === "string" && VALID_ACTIONS.has(value);
}

function actionToIntent(name: VoiceChatActionName, args: Record<string, unknown>): VoiceIntent {
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
          date: relDate(args.date),
        },
        confidence: 1,
        requiresConfirmation: false,
      };
    case "log_water":
      return {
        action: "logWater",
        payload: {
          milliliters: flOzToMl(num(args.ounces)) ?? 250,
          date: relDate(args.date),
        },
        confidence: 1,
        requiresConfirmation: false,
      };
    case "add_task":
      return {
        action: "createTask",
        payload: {
          text: String(args.text ?? "").trim(),
          priority: num(args.priority) || undefined,
          date: relDate(args.date),
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

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function relDate(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isMemoryAction(name: ChatActionName): name is MemoryActionName {
  return name === "save_memory" || name === "update_memory" || name === "forget_memory";
}

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
  const live = memories.filter((memory) => !memory.deletedAt);
  const excess = live.length - MAX_LIVE_MEMORIES;
  if (excess <= 0) return memories;

  const oldestFirst = (a: CoachMemory, b: CoachMemory) =>
    (a.updatedAt || a.createdAt) - (b.updatedAt || b.createdAt);
  const dropIds = new Set(
    [
      ...live.filter((memory) => memory.category !== "constraint").sort(oldestFirst),
      ...live.filter((memory) => memory.category === "constraint").sort(oldestFirst),
    ]
      .slice(0, excess)
      .map((memory) => memory.id),
  );
  return memories.map((memory) =>
    dropIds.has(memory.id) ? { ...memory, deletedAt: now, updatedAt: now } : memory,
  );
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

  const id = String(args.id ?? "").trim();
  if (!id) {
    return {
      ok: false,
      message:
        name === "update_memory"
          ? "I need the memory id to update."
          : "I need the memory id to forget.",
    };
  }
  if (name === "update_memory") {
    const content = sanitizeMemoryContent(args.content);
    if (!content) return { ok: false, message: "I need the updated memory text." };
    const store = await updateCoachMemoriesImpl((memories) =>
      memories.map((memory) => {
        if (memory.id !== id || memory.deletedAt) return memory;
        return {
          ...memory,
          content,
          category:
            args.category === undefined ? memory.category : normalizeMemoryCategory(args.category),
          updatedAt: now,
        };
      }),
    );
    const found = store.memories.some(
      (memory) => memory.id === id && !memory.deletedAt && memory.updatedAt === now,
    );
    return found
      ? { ok: true, message: "Updated — I'll remember it that way." }
      : { ok: false, message: "I couldn't find that memory to update." };
  }

  const store = await updateCoachMemoriesImpl((memories) =>
    memories.map((memory) => {
      if (memory.id !== id || memory.deletedAt) return memory;
      return { ...memory, deletedAt: now, updatedAt: now };
    }),
  );
  const found = store.memories.some((memory) => memory.id === id && memory.deletedAt === now);
  return found
    ? { ok: true, message: "Forgotten." }
    : { ok: false, message: "I couldn't find that memory to forget." };
}

/** Execute one approved action through the shared voice or memory write path. */
export async function applyChatActionImpl(
  name: ChatActionName,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; message: string }> {
  if (isMemoryAction(name)) return applyMemoryAction(name, args);
  const result = await executeVoiceIntentImpl(actionToIntent(name, args));
  return { ok: result.success, message: result.spokenText };
}

/** Soft-delete a memory without removing its audit trail. */
export async function deleteCoachMemoryImpl(id: string): Promise<void> {
  const now = Date.now();
  await updateCoachMemoriesImpl((memories) =>
    memories.map((memory) =>
      memory.id === id ? { ...memory, deletedAt: now, updatedAt: now } : memory,
    ),
  );
}
