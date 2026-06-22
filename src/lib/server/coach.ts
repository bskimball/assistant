/**
 * AI Coach — cross-domain suggestion + planning engine.
 *
 * One server module that acts as the user's "advisory board": a life coach,
 * personal trainer, and financial advisor rolled into structured, actionable
 * output. Powers:
 *   - "AI Suggestions" on the daily dashboard (focus / nutrition / finance / family)
 *   - "Workout Suggestions" (an AI-generated session for today)
 *   - A short motivational headline
 *
 * Design goals (AGENTS.md):
 *   - Actionable, not just descriptive.
 *   - Data-driven: suggestions reference the day's actual numbers.
 *   - Works with ZERO config — a deterministic fallback produces real,
 *     useful coaching when no GROK_API_KEY is present.
 */

import { createServerFn } from '@tanstack/react-start'
import type { ISODate, ISOWeek } from '@/lib/domain'
import { todayISO } from '@/lib/domain'
import { loadDailyDashboard, saveDailyPlan, loadDailyPlan } from '@/lib/server/domain'

export type CoachDomain = 'focus' | 'fitness' | 'nutrition' | 'finance' | 'family' | 'general'

export interface CoachSuggestion {
  domain: CoachDomain
  /** The actionable recommendation (one sentence). */
  text: string
  /** Optional voice/quick-command hint the user can act on immediately. */
  action?: string
}

export interface WorkoutSuggestion {
  title: string
  focus: string
  estimatedMinutes: number
  exercises: { name: string; sets: number; reps: string }[]
}

export interface CoachingResult {
  date: ISODate
  /** Short motivational, data-aware one-liner. */
  headline: string
  suggestions: CoachSuggestion[]
  workout: WorkoutSuggestion
  generatedBy: 'ai' | 'fallback'
  updatedAt: number
}

/** Snapshot of the day's numbers the coach reasons over. */
interface DaySignals {
  date: ISODate
  tasksTotal: number
  tasksDone: number
  proteinCurrent: number
  proteinTarget: number
  waterMl: number
  netWorth: number
  hasFinance: boolean
  mealsLogged: number
  dayOfWeek: number // 0 = Sun
}

async function collectSignals(date: ISODate): Promise<DaySignals> {
  const dash = await loadDailyDashboard({ data: date })
  const tasks = (dash.productivity?.tasks || []).filter((t) => !t.deletedAt)
  const tasksDone = tasks.filter((t) => t.done).length
  const proteinTarget = dash.plan?.nutritionTargets?.protein ?? 150
  return {
    date,
    tasksTotal: tasks.length,
    tasksDone,
    proteinCurrent: dash.nutrition?.totals?.protein ?? 0,
    proteinTarget,
    waterMl: dash.nutrition?.waterMl ?? 0,
    netWorth: dash.finance?.netWorth ?? 0,
    hasFinance: !!dash.finance && (dash.finance.accounts.length > 0 || dash.finance.netWorth > 0),
    mealsLogged: dash.nutrition?.mealLogs?.length ?? 0,
    dayOfWeek: new Date(date + 'T00:00:00').getDay(),
  }
}

/* ============================================================
   WORKOUT TEMPLATES (trainer)
   A weekly push/pull/legs-ish rotation so suggestions vary by day.
   ============================================================ */

const WORKOUT_ROTATION: WorkoutSuggestion[] = [
  {
    title: 'Active Recovery & Mobility',
    focus: 'Recovery',
    estimatedMinutes: 25,
    exercises: [
      { name: 'Brisk walk', sets: 1, reps: '20 min' },
      { name: 'World’s greatest stretch', sets: 2, reps: '6/side' },
      { name: 'Cat-cow', sets: 2, reps: '10' },
      { name: 'Dead hang', sets: 3, reps: '30s' },
    ],
  },
  {
    title: 'Push — Chest, Shoulders, Triceps',
    focus: 'Upper push',
    estimatedMinutes: 45,
    exercises: [
      { name: 'Bench press', sets: 4, reps: '6–8' },
      { name: 'Overhead press', sets: 3, reps: '8–10' },
      { name: 'Incline dumbbell press', sets: 3, reps: '10–12' },
      { name: 'Triceps rope pushdown', sets: 3, reps: '12–15' },
    ],
  },
  {
    title: 'Pull — Back & Biceps',
    focus: 'Upper pull',
    estimatedMinutes: 45,
    exercises: [
      { name: 'Deadlift', sets: 3, reps: '5' },
      { name: 'Pull-ups', sets: 4, reps: 'AMRAP' },
      { name: 'Barbell row', sets: 3, reps: '8–10' },
      { name: 'Face pulls', sets: 3, reps: '15' },
    ],
  },
  {
    title: 'Legs — Quads, Hamstrings, Glutes',
    focus: 'Lower body',
    estimatedMinutes: 50,
    exercises: [
      { name: 'Back squat', sets: 4, reps: '6–8' },
      { name: 'Romanian deadlift', sets: 3, reps: '10' },
      { name: 'Walking lunges', sets: 3, reps: '12/leg' },
      { name: 'Calf raises', sets: 4, reps: '15' },
    ],
  },
  {
    title: 'Conditioning & Core',
    focus: 'Conditioning',
    estimatedMinutes: 30,
    exercises: [
      { name: 'Row or bike intervals', sets: 6, reps: '40s on / 20s off' },
      { name: 'Hanging knee raise', sets: 3, reps: '12' },
      { name: 'Plank', sets: 3, reps: '45s' },
      { name: 'Russian twists', sets: 3, reps: '20' },
    ],
  },
]

function fallbackWorkout(signals: DaySignals): WorkoutSuggestion {
  // Map day-of-week to a sensible split; rest/recovery on Sunday & Wednesday.
  const byDay: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 0, 4: 3, 5: 1, 6: 4 }
  return WORKOUT_ROTATION[byDay[signals.dayOfWeek] ?? 1]
}

/* ============================================================
   DETERMINISTIC FALLBACK COACH (no API key needed)
   ============================================================ */

function fallbackCoaching(signals: DaySignals): CoachingResult {
  const suggestions: CoachSuggestion[] = []

  // FOCUS / PRODUCTIVITY
  if (signals.tasksTotal === 0) {
    suggestions.push({
      domain: 'focus',
      text: 'No tasks yet today — name your top 3 outcomes so the day has direction.',
      action: 'add task ',
    })
  } else if (signals.tasksDone === 0) {
    suggestions.push({
      domain: 'focus',
      text: `You have ${signals.tasksTotal} task(s) queued. Knock out the smallest one first to build momentum.`,
    })
  } else if (signals.tasksDone < signals.tasksTotal) {
    suggestions.push({
      domain: 'focus',
      text: `${signals.tasksDone}/${signals.tasksTotal} done — protect a 25-min focus block to clear one more.`,
    })
  } else {
    suggestions.push({
      domain: 'focus',
      text: 'All tasks complete. Bank the win and set tomorrow’s top priority tonight.',
    })
  }

  // NUTRITION (trainer + dietitian)
  const proteinGap = signals.proteinTarget - signals.proteinCurrent
  if (proteinGap > 0) {
    suggestions.push({
      domain: 'nutrition',
      text: `Protein is ${signals.proteinCurrent}g of ${signals.proteinTarget}g — ${proteinGap}g to go. A lean meat, Greek yogurt, or shake closes the gap.`,
      action: 'log 40g protein ',
    })
  } else {
    suggestions.push({
      domain: 'nutrition',
      text: `Protein target hit (${signals.proteinCurrent}g). Keep portions steady and prioritize whole foods.`,
    })
  }
  if (signals.waterMl < 2000) {
    suggestions.push({
      domain: 'nutrition',
      text: `Hydration at ${signals.waterMl} ml — aim for ~2.5 L. Grab a glass now.`,
      action: 'add water 300 ml',
    })
  }

  // FITNESS
  const w = fallbackWorkout(signals)
  suggestions.push({
    domain: 'fitness',
    text: `Today’s suggested session: ${w.title} (~${w.estimatedMinutes} min). Schedule it before the day fills up.`,
    action: 'add workout ' + w.estimatedMinutes + ' min',
  })

  // FINANCE (advisor)
  if (!signals.hasFinance) {
    suggestions.push({
      domain: 'finance',
      text: 'Add your account balances to start a net-worth baseline — you can’t improve what you don’t measure.',
    })
  } else {
    suggestions.push({
      domain: 'finance',
      text: `Net worth tracked at $${signals.netWorth.toLocaleString()}. Automate one transfer to savings/investments this week and review recurring subscriptions.`,
    })
  }

  // FAMILY / LIFE
  suggestions.push({
    domain: 'family',
    text: 'Block 20 distraction-free minutes with family today — presence compounds more than productivity.',
    action: 'add family time 20 min',
  })

  // HEADLINE
  const pct = signals.tasksTotal > 0 ? Math.round((signals.tasksDone / signals.tasksTotal) * 100) : 0
  const headline =
    signals.tasksTotal === 0
      ? 'Fresh start — set your intentions and the rest follows.'
      : pct >= 100
        ? 'Clean sweep on tasks. Recover well and keep the streak alive.'
        : pct >= 50
          ? `Solid momentum — ${pct}% through your tasks. Finish strong.`
          : 'Early in the day. One focused block changes everything.'

  return {
    date: signals.date,
    headline,
    suggestions,
    workout: w,
    generatedBy: 'fallback',
    updatedAt: Date.now(),
  }
}

/* ============================================================
   GROK-BACKED COACH
   ============================================================ */

async function getGrokKey(): Promise<string | undefined> {
  let apiKey: string | undefined
  try {
    const { env: cfEnv } = await import('cloudflare:workers')
    apiKey = (cfEnv as any)?.GROK_API_KEY
  } catch {
    /* not in CF env */
  }
  return apiKey || (globalThis as any).GROK_API_KEY || process?.env?.GROK_API_KEY
}

function buildCoachPrompt(signals: DaySignals): string {
  return `You are Brian's personal advisory board: an elite life coach, a certified strength & conditioning coach, and a CFP-level financial advisor. Give concise, actionable coaching for TODAY based on his real data.

Today's data (${signals.date}, weekday index ${signals.dayOfWeek} where 0=Sunday):
- Tasks: ${signals.tasksDone}/${signals.tasksTotal} complete
- Protein: ${signals.proteinCurrent}g of ${signals.proteinTarget}g target
- Water: ${signals.waterMl} ml
- Meals logged: ${signals.mealsLogged}
- Net worth tracked: ${signals.hasFinance ? '$' + signals.netWorth : 'not set up yet'}

Reply with ONLY one compact JSON object (no markdown):
{
  "headline": "short motivational, data-aware one-liner",
  "suggestions": [
    { "domain": "focus|fitness|nutrition|finance|family|general", "text": "one actionable sentence", "action": "optional voice command e.g. 'log 40g protein'" }
  ],
  "workout": {
    "title": "session name",
    "focus": "muscle group / goal",
    "estimatedMinutes": number,
    "exercises": [ { "name": "Exercise", "sets": number, "reps": "8-10" } ]
  }
}

Rules:
- 4 to 6 suggestions, one per domain where relevant, each referencing his actual numbers.
- The workout must suit the weekday (lighter/recovery on overloaded days; push/pull/legs rotation otherwise).
- Be specific and encouraging. No fluff, no disclaimers.`
}

async function aiCoaching(signals: DaySignals, apiKey: string): Promise<CoachingResult> {
  const resp = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-3-mini',
      messages: [
        { role: 'system', content: 'Return strictly valid minified JSON only. No prose.' },
        { role: 'user', content: buildCoachPrompt(signals) },
      ],
      temperature: 0.5,
      max_tokens: 700,
    }),
  })
  if (!resp.ok) throw new Error('Grok HTTP ' + resp.status)
  const data: any = await resp.json()
  const raw = (data.choices?.[0]?.message?.content || '{}').trim()
  const cleaned = raw.replace(/^```json\s*|\s*```$/g, '').trim()
  const parsed = JSON.parse(cleaned)

  const fb = fallbackWorkout(signals)
  const workout: WorkoutSuggestion =
    parsed.workout && Array.isArray(parsed.workout.exercises) && parsed.workout.exercises.length
      ? {
          title: String(parsed.workout.title || fb.title),
          focus: String(parsed.workout.focus || fb.focus),
          estimatedMinutes: Number(parsed.workout.estimatedMinutes) || fb.estimatedMinutes,
          exercises: parsed.workout.exercises.slice(0, 8).map((e: any) => ({
            name: String(e.name || 'Exercise'),
            sets: Number(e.sets) || 3,
            reps: String(e.reps ?? '10'),
          })),
        }
      : fb

  const suggestions: CoachSuggestion[] = Array.isArray(parsed.suggestions)
    ? parsed.suggestions.slice(0, 6).map((s: any) => ({
        domain: (s.domain || 'general') as CoachDomain,
        text: String(s.text || '').trim(),
        action: s.action ? String(s.action) : undefined,
      }))
    : fallbackCoaching(signals).suggestions

  return {
    date: signals.date,
    headline: String(parsed.headline || fallbackCoaching(signals).headline),
    suggestions: suggestions.filter((s) => s.text),
    workout,
    generatedBy: 'ai',
    updatedAt: Date.now(),
  }
}

/* ============================================================
   PUBLIC SERVER FN
   ============================================================ */

/**
 * Generate (and persist) coaching for a date. Persists the suggestion text +
 * workout summary into the DailyPlan so the dashboard renders instantly on
 * reload without re-calling the LLM.
 */
export const generateCoaching = createServerFn({ method: 'POST' })
  .validator((data: { date?: ISODate }) => data)
  .handler(async ({ data }): Promise<CoachingResult> => {
    const date = data.date || todayISO()
    const signals = await collectSignals(date)

    let result: CoachingResult
    const apiKey = await getGrokKey()
    if (apiKey) {
      try {
        result = await aiCoaching(signals, apiKey)
      } catch (e) {
        console.warn('[coach] Grok coaching failed, using fallback', e)
        result = fallbackCoaching(signals)
      }
    } else {
      result = fallbackCoaching(signals)
    }

    // Persist into the DailyPlan so reloads are free.
    try {
      const existing = await loadDailyPlan({ data: date })
      await saveDailyPlan({
        data: {
          id: existing?.id || `plan-${date}`,
          createdAt: existing?.createdAt || Date.now(),
          date,
          topTaskIds: existing?.topTaskIds || [],
          workoutPlanId: existing?.workoutPlanId,
          nutritionTargets: existing?.nutritionTargets ?? { protein: signals.proteinTarget },
          voiceNoteIds: existing?.voiceNoteIds,
          notes: existing?.notes,
          aiSuggestions: result.suggestions.map((s) =>
            `[${s.domain}] ${s.text}` + (s.action ? `  (try: "${s.action}")` : ''),
          ),
        },
      })
    } catch (e) {
      console.warn('[coach] failed to persist suggestions to DailyPlan', e)
    }

    return result
  })

/* ============================================================
   WEEKLY REVIEW NARRATIVE (life coach)
   ============================================================ */

export interface WeeklyStatsInput {
  week: ISOWeek
  tasksCompleted: number
  tasksTotal: number
  workouts: number
  avgProteinPct: number
  avgWaterMl: number
  netWorth: number
  activeDays: number
}

export interface WeeklyNarrativeResult {
  week: ISOWeek
  reflection: string
  wins: string[]
  blockers: string[]
  nextWeekFocus: string[]
  generatedBy: 'ai' | 'fallback'
}

function fallbackWeekly(s: WeeklyStatsInput): WeeklyNarrativeResult {
  const completion = s.tasksTotal > 0 ? Math.round((s.tasksCompleted / s.tasksTotal) * 100) : 0
  const wins: string[] = []
  const blockers: string[] = []
  const nextWeekFocus: string[] = []

  if (s.tasksCompleted > 0) wins.push(`Completed ${s.tasksCompleted} task(s) (${completion}% of planned).`)
  if (s.workouts > 0) wins.push(`Trained ${s.workouts} time(s) this week.`)
  if (s.avgProteinPct >= 90) wins.push(`Strong protein intake (${s.avgProteinPct}% of target on average).`)
  if (s.activeDays >= 5) wins.push(`Logged activity on ${s.activeDays} days — great consistency.`)
  if (wins.length === 0) wins.push('Showed up — every logged day is a foundation to build on.')

  if (completion < 60 && s.tasksTotal > 0) blockers.push(`Task completion at ${completion}% — likely over-committed or too many context switches.`)
  if (s.workouts < 3) blockers.push(`Only ${s.workouts} workout(s) — aim for at least 3 sessions.`)
  if (s.avgProteinPct < 80) blockers.push(`Protein averaged ${s.avgProteinPct}% of target — front-load protein at breakfast.`)
  if (s.activeDays < 4) blockers.push(`Active only ${s.activeDays} days — a 30-second daily check-in keeps momentum.`)

  if (s.workouts < 3) nextWeekFocus.push('Schedule 3–4 workouts in advance and treat them as appointments.')
  nextWeekFocus.push('Pick the 3 outcomes that matter most each morning before opening anything else.')
  if (s.avgProteinPct < 90) nextWeekFocus.push('Hit a protein target every day — prep two high-protein staples.')
  if (s.netWorth > 0) nextWeekFocus.push('Review one recurring expense and automate one savings transfer.')

  const reflection =
    `This week you completed ${s.tasksCompleted}/${s.tasksTotal} tasks (${completion}%), trained ${s.workouts} time(s), ` +
    `and averaged ${s.avgProteinPct}% of your protein target across ${s.activeDays} active day(s). ` +
    (completion >= 70
      ? 'Momentum is real — protect what’s working and add one small stretch goal.'
      : 'Tighten focus next week: fewer commitments, finished fully, beats many started.')

  return { week: s.week, reflection, wins, blockers, nextWeekFocus, generatedBy: 'fallback' }
}

export const generateWeeklyNarrative = createServerFn({ method: 'POST' })
  .validator((data: WeeklyStatsInput) => data)
  .handler(async ({ data }): Promise<WeeklyNarrativeResult> => {
    const apiKey = await getGrokKey()
    if (!apiKey) return fallbackWeekly(data)

    const completion = data.tasksTotal > 0 ? Math.round((data.tasksCompleted / data.tasksTotal) * 100) : 0
    const prompt = `You are Brian's life coach + strength coach + financial advisor writing his WEEKLY REVIEW for ${data.week}.

Data this week:
- Tasks: ${data.tasksCompleted}/${data.tasksTotal} complete (${completion}%)
- Workouts: ${data.workouts}
- Avg protein vs target: ${data.avgProteinPct}%
- Avg water: ${data.avgWaterMl} ml
- Net worth: ${data.netWorth > 0 ? '$' + data.netWorth : 'not tracked'}
- Active (logged) days: ${data.activeDays}/7

Reply with ONLY one compact JSON object:
{ "reflection": "2-3 sentence honest, encouraging summary", "wins": ["..."], "blockers": ["..."], "nextWeekFocus": ["..."] }
Each array has 2-4 specific, actionable items referencing the numbers. No markdown.`

    try {
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'grok-3-mini',
          messages: [
            { role: 'system', content: 'Return strictly valid minified JSON only. No prose.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.5,
          max_tokens: 600,
        }),
      })
      if (!resp.ok) throw new Error('Grok HTTP ' + resp.status)
      const json: any = await resp.json()
      const raw = (json.choices?.[0]?.message?.content || '{}').trim()
      const parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim())
      const arr = (v: any): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 4) : [])
      const fb = fallbackWeekly(data)
      return {
        week: data.week,
        reflection: String(parsed.reflection || fb.reflection),
        wins: arr(parsed.wins).length ? arr(parsed.wins) : fb.wins,
        blockers: arr(parsed.blockers).length ? arr(parsed.blockers) : fb.blockers,
        nextWeekFocus: arr(parsed.nextWeekFocus).length ? arr(parsed.nextWeekFocus) : fb.nextWeekFocus,
        generatedBy: 'ai',
      }
    } catch (e) {
      console.warn('[coach] weekly narrative failed, using fallback', e)
      return fallbackWeekly(data)
    }
  })
