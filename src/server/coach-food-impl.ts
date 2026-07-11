/** Coach Engine food macro estimation and deterministic text-parser fallback (ADR-011). */

import { estimateMacrosFromText } from "@/server/domain-impl";
import { completeJSON, getGrokApiKey, getGrokJsonModel } from "@/server/adapters/ai";

export interface FoodMacroEstimate {
  /** Cleaned-up food/meal name to store on the log. */
  name: string;
  /** Portion amount the macros describe. */
  quantity: number;
  unit: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  confidence: "low" | "medium" | "high";
  generatedBy: "ai" | "fallback";
}

/** Deterministic fallback — only recovers numbers the user typed. */
function fallbackFoodMacros(description: string): FoodMacroEstimate {
  const { macros, confidence } = estimateMacrosFromText(description);
  return {
    name: description.trim() || "Meal",
    quantity: 1,
    unit: "serving",
    calories: macros.calories,
    protein: macros.protein,
    carbs: macros.carbs,
    fat: macros.fat,
    confidence,
    generatedBy: "fallback",
  };
}

export async function estimateFoodMacrosImpl(data: {
  description: string;
}): Promise<FoodMacroEstimate> {
  const description = String(data?.description || "").trim();
  if (!description) {
    return fallbackFoodMacros("");
  }

  const apiKey = await getGrokApiKey();
  if (!apiKey) return fallbackFoodMacros(description);

  const prompt = `You are a precise nutrition database. Estimate the nutrition facts for the food or meal described below.
If the description includes a portion/quantity (e.g. "6 oz", "2 eggs", "1 cup"), estimate for that exact portion.
If the description does NOT include a portion, assume one realistic amount a person would log/eat for that food, not a per-100g database row.

Food: "${description}"

Reply with ONLY one compact JSON object, no markdown:
{ "name": "concise food name", "quantity": number, "unit": "serving|g|oz|cup|piece|slice", "calories": number, "protein": number, "carbs": number, "fat": number, "confidence": "low|medium|high" }

Rules:
- calories in kcal; protein, carbs, fat in grams — all for the TOTAL portion described.
- Use realistic USDA-style values. Never return all zeros for a real food.
- Do not undercount rich prepared foods by silently assuming a tiny portion.
- If uncertain, choose a plausible typical serving and set confidence to "low" or "medium".
- confidence reflects how identifiable the food is.`;

  try {
    const parsed = await completeJSON<any>(apiKey, {
      model: await getGrokJsonModel(),
      messages: [
        {
          role: "system",
          content: "Return strictly valid minified JSON only. No prose.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      maxTokens: 200,
    });

    const num = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
    };
    const conf =
      parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
        ? parsed.confidence
        : "medium";
    const estimate: FoodMacroEstimate = {
      name:
        String(parsed.name || description)
          .trim()
          .slice(0, 80) || description,
      quantity: Number(parsed.quantity) > 0 ? Number(parsed.quantity) : 1,
      unit:
        String(parsed.unit || "serving")
          .trim()
          .slice(0, 16) || "serving",
      calories: num(parsed.calories),
      protein: num(parsed.protein),
      carbs: num(parsed.carbs),
      fat: num(parsed.fat),
      confidence: conf,
      generatedBy: "ai",
    };
    // If the model returned nothing usable, fall back to text parsing.
    if (
      estimate.calories === 0 &&
      estimate.protein === 0 &&
      estimate.carbs === 0 &&
      estimate.fat === 0
    ) {
      return fallbackFoodMacros(description);
    }
    return estimate;
  } catch (e) {
    console.warn("[coach] food macro estimate failed, using fallback", e);
    return fallbackFoodMacros(description);
  }
}
