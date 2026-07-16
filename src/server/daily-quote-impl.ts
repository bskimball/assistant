/** AI daily quote generation with date-stable fallback and DailyPlan persistence. */

import type { DailyQuote, ISODate } from "@/lib/domain";
import { todayISO } from "@/lib/domain";
import { completeJSON, getGrokApiKey, getGrokJsonModel } from "@/server/adapters/ai";
import { loadDailyPlanImpl, saveDailyPlanImpl } from "@/server/daily-dashboard-impl";

export type DailyQuoteResult = DailyQuote & { date: ISODate };

/** Built-in calm/zen quotes for deterministic fallback (stable per date). */
export const FALLBACK_QUOTES: ReadonlyArray<{ text: string; author?: string }> = [
  { text: "Small steps, taken steadily, become a life well lived.", author: "Coach" },
  { text: "Breathe. Begin where you are. That is enough for today.", author: "Coach" },
  { text: "Progress is quiet. Trust the work you already started.", author: "Coach" },
  { text: "One clear intention beats a dozen scattered hopes.", author: "Coach" },
  { text: "Rest is part of the path, not a detour from it.", author: "Coach" },
  { text: "Be kind to the person you are becoming.", author: "Coach" },
  { text: "Show up gently. Consistency is a form of care.", author: "Coach" },
  { text: "Clarity comes after action, not before it.", author: "Coach" },
  { text: "Protect your energy like it matters — because it does.", author: "Coach" },
  { text: "Today asks only for the next right thing.", author: "Coach" },
  { text: "Strength grows in the ordinary hours no one applauds.", author: "Coach" },
  { text: "Let this day be simple, honest, and enough.", author: "Coach" },
];

/** Stable non-negative index from an ISO date string (YYYY-MM-DD). */
export function dateHashIndex(date: ISODate, modulo: number): number {
  if (modulo <= 0) return 0;
  let h = 0;
  for (let i = 0; i < date.length; i++) {
    h = (h * 31 + date.charCodeAt(i)) >>> 0;
  }
  return h % modulo;
}

export function fallbackDailyQuote(date: ISODate): DailyQuote {
  const pick = FALLBACK_QUOTES[dateHashIndex(date, FALLBACK_QUOTES.length)]!;
  return {
    text: pick.text,
    author: pick.author,
    generatedAt: new Date().toISOString(),
    generatedBy: "fallback",
  };
}

function normalizeQuote(parsed: { text?: unknown; author?: unknown }, date: ISODate): DailyQuote {
  const text = String(parsed.text ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 280);
  if (!text) return fallbackDailyQuote(date);
  const authorRaw = parsed.author != null ? String(parsed.author).trim().slice(0, 80) : "";
  return {
    text,
    author: authorRaw || undefined,
    generatedAt: new Date().toISOString(),
    generatedBy: "ai",
  };
}

async function aiDailyQuote(date: ISODate, apiKey: string): Promise<DailyQuote> {
  const parsed = await completeJSON<{ text?: string; author?: string }>(apiKey, {
    model: await getGrokJsonModel(),
    messages: [
      {
        role: "system",
        content: "Return strictly valid minified JSON only. No prose.",
      },
      {
        role: "user",
        content: `Write one original motivational quote for a personal life-coach app.
Tone: calm, zen, warm, grounded — not hype or hustle-culture.
Length: 1–2 short sentences (under 200 characters).
Date context: ${date} (do not mention the date).
Optional: a short fictional or traditional-sounding author name, or omit author.

Reply with ONLY one compact JSON object:
{ "text": "the quote", "author": "optional name or omit" }`,
      },
    ],
    temperature: 0.7,
    maxTokens: 120,
  });
  return normalizeQuote(parsed, date);
}

export async function generateDailyQuoteImpl(data: {
  date?: ISODate;
  force?: boolean;
}): Promise<DailyQuoteResult> {
  const date = data.date || todayISO();
  const existing = await loadDailyPlanImpl(date);
  if (!data.force && existing?.dailyQuote?.text) {
    return { ...existing.dailyQuote, date };
  }

  let quote: DailyQuote;
  const apiKey = await getGrokApiKey();
  if (apiKey) {
    try {
      quote = await aiDailyQuote(date, apiKey);
    } catch (e) {
      console.warn("[daily-quote] Grok failed, using fallback", e);
      quote = fallbackDailyQuote(date);
    }
  } else {
    quote = fallbackDailyQuote(date);
  }

  try {
    await saveDailyPlanImpl({
      id: existing?.id || `plan-${date}`,
      createdAt: existing?.createdAt || Date.now(),
      date,
      topTaskIds: existing?.topTaskIds || [],
      workoutPlanId: existing?.workoutPlanId,
      nutritionTargets: existing?.nutritionTargets,
      voiceNoteIds: existing?.voiceNoteIds,
      notes: existing?.notes,
      eveningCheckIn: existing?.eveningCheckIn,
      acceptedAt: existing?.acceptedAt,
      acceptedSuggestionIds: existing?.acceptedSuggestionIds,
      aiSuggestions: existing?.aiSuggestions,
      aiCoaching: existing?.aiCoaching,
      dailyQuote: quote,
    });
  } catch (e) {
    console.warn("[daily-quote] failed to persist to DailyPlan", e);
  }

  return { ...quote, date };
}
