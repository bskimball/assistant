/** Coach Engine weekly-review narrative and deterministic fallback (ADR-011). */

import type { ISOWeek } from "@/lib/domain";
import { mlToFlOz } from "@/lib/domain";
import { completeJSON, getGrokApiKey, getGrokJsonModel } from "@/server/adapters/ai";
import { loadUserProfileImpl } from "@/server/domain-impl";
import { profileBlock } from "@/server/coach-daily-impl";

export interface WeeklyStatsInput {
  week: ISOWeek;
  tasksCompleted: number;
  tasksTotal: number;
  workouts: number;
  avgProteinPct: number;
  avgWaterMl: number;
  netWorth: number;
  activeDays: number;
  checkInDays?: number;
  avgEnergy?: number;
  avgDayRating?: number;
  checkInWins?: string[];
  checkInFrictions?: string[];
}

export interface WeeklyNarrativeResult {
  week: ISOWeek;
  reflection: string;
  wins: string[];
  blockers: string[];
  nextWeekFocus: string[];
  generatedBy: "ai" | "fallback";
}

function fallbackWeekly(s: WeeklyStatsInput): WeeklyNarrativeResult {
  const completion = s.tasksTotal > 0 ? Math.round((s.tasksCompleted / s.tasksTotal) * 100) : 0;
  const wins: string[] = [];
  const blockers: string[] = [];
  const nextWeekFocus: string[] = [];

  if (s.tasksCompleted > 0)
    wins.push(`Completed ${s.tasksCompleted} task(s) (${completion}% of planned).`);
  if (s.workouts > 0) wins.push(`Trained ${s.workouts} time(s) this week.`);
  if (s.avgProteinPct >= 90)
    wins.push(`Strong protein intake (${s.avgProteinPct}% of target on average).`);
  if (s.activeDays >= 5) wins.push(`Logged activity on ${s.activeDays} days — great consistency.`);
  if ((s.checkInDays ?? 0) >= 3)
    wins.push(`Completed ${s.checkInDays} evening check-ins with average energy ${s.avgEnergy}/5.`);
  if (s.checkInWins?.length) wins.push(`Check-in win: ${s.checkInWins[0]}`);
  if (wins.length === 0) wins.push("Showed up — every logged day is a foundation to build on.");

  if (completion < 60 && s.tasksTotal > 0)
    blockers.push(
      `Task completion at ${completion}% — likely over-committed or too many context switches.`,
    );
  if (s.workouts < 3) blockers.push(`Only ${s.workouts} workout(s) — aim for at least 3 sessions.`);
  if (s.avgProteinPct < 80)
    blockers.push(
      `Protein averaged ${s.avgProteinPct}% of target — front-load protein at breakfast.`,
    );
  if (s.activeDays < 4)
    blockers.push(`Active only ${s.activeDays} days — a 30-second daily check-in keeps momentum.`);
  if ((s.checkInDays ?? 0) > 0 && (s.avgEnergy ?? 5) < 3)
    blockers.push(`Energy averaged ${s.avgEnergy}/5 — reduce friction and protect recovery.`);
  if (s.checkInFrictions?.length)
    blockers.push(`Repeated friction to address: ${s.checkInFrictions[0]}`);

  if (s.workouts < 3)
    nextWeekFocus.push("Schedule 3–4 workouts in advance and treat them as appointments.");
  nextWeekFocus.push(
    "Pick the 3 outcomes that matter most each morning before opening anything else.",
  );
  if (s.avgProteinPct < 90)
    nextWeekFocus.push("Hit a protein target every day — prep two high-protein staples.");
  if (s.netWorth > 0)
    nextWeekFocus.push("Review one recurring expense and automate one savings transfer.");

  const reflection =
    `This week you completed ${s.tasksCompleted}/${s.tasksTotal} tasks (${completion}%), trained ${s.workouts} time(s), ` +
    `and averaged ${s.avgProteinPct}% of your protein target across ${s.activeDays} active day(s). ` +
    (completion >= 70
      ? "Momentum is real — protect what’s working and add one small stretch goal."
      : "Tighten focus next week: fewer commitments, finished fully, beats many started.");

  return {
    week: s.week,
    reflection,
    wins,
    blockers,
    nextWeekFocus,
    generatedBy: "fallback",
  };
}

export async function generateWeeklyNarrativeImpl(
  data: WeeklyStatsInput,
): Promise<WeeklyNarrativeResult> {
  const apiKey = await getGrokApiKey();
  if (!apiKey) return fallbackWeekly(data);
  const profile = await loadUserProfileImpl();

  const completion =
    data.tasksTotal > 0 ? Math.round((data.tasksCompleted / data.tasksTotal) * 100) : 0;
  const avgWaterOz = mlToFlOz(data.avgWaterMl) ?? 0;
  const prompt = `You are Brian's life coach + strength coach + financial advisor writing his WEEKLY REVIEW for ${data.week}.

Data this week:
- Tasks: ${data.tasksCompleted}/${data.tasksTotal} complete (${completion}%)
- Workouts: ${data.workouts}
- Avg protein vs target: ${data.avgProteinPct}%
- Avg water: ${avgWaterOz} fl oz
- Net worth: ${data.netWorth > 0 ? "$" + data.netWorth : "not tracked"}
- Active (logged) days: ${data.activeDays}/7
- Evening check-ins: ${data.checkInDays ?? 0}/7
- Avg check-in energy: ${data.avgEnergy ?? 0}/5
- Avg day rating: ${data.avgDayRating ?? 0}/5
- Wins noted: ${(data.checkInWins ?? []).join("; ") || "none"}
- Friction noted: ${(data.checkInFrictions ?? []).join("; ") || "none"}

User profile:
${profileBlock(profile)}

Reply with ONLY one compact JSON object:
{ "reflection": "2-3 sentence honest, encouraging summary", "wins": ["..."], "blockers": ["..."], "nextWeekFocus": ["..."] }
Each array has 2-4 specific, actionable items referencing the numbers. Use US customary units for bodyweight, exercise loads, height, and hydration. No markdown.`;

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
      temperature: 0.5,
      maxTokens: 600,
    });
    const arr = (v: any): string[] =>
      Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 4) : [];
    const fb = fallbackWeekly(data);
    return {
      week: data.week,
      reflection: String(parsed.reflection || fb.reflection),
      wins: arr(parsed.wins).length ? arr(parsed.wins) : fb.wins,
      blockers: arr(parsed.blockers).length ? arr(parsed.blockers) : fb.blockers,
      nextWeekFocus: arr(parsed.nextWeekFocus).length
        ? arr(parsed.nextWeekFocus)
        : fb.nextWeekFocus,
      generatedBy: "ai",
    };
  } catch (e) {
    console.warn("[coach] weekly narrative failed, using fallback", e);
    return fallbackWeekly(data);
  }
}
