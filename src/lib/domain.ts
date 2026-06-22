/**
 * Core Domain Model (runtime types)
 *
 * Implements ADR-002: Core Domain Model v0.3
 *
 * All persistent domain objects are defined here.
 * - Use these types for R2 serialization, server functions, and client state.
 * - See docs/ai/core-domain-model.ts for the agent-consumable mirror.
 * - See docs/ai/glossary.md for canonical definitions.
 */

import type { Todo } from './todos'

export type ISODate = string // YYYY-MM-DD
export type ISOWeek = string // YYYY-Www
export type Timestamp = number // milliseconds since epoch

export interface BaseEntity {
  id: string
  createdAt: Timestamp
  updatedAt?: Timestamp
  deletedAt?: Timestamp
}

/** Single root user (Brian). Partition key for all R2 objects. */
export interface User extends BaseEntity {
  preferences?: UserPreferences
}

export interface UserPreferences {
  timezone?: string
  units?: 'metric' | 'imperial'
}

/* ===================== FITNESS ===================== */

export type WorkoutPlanStatus = 'draft' | 'active' | 'archived'
export type GeneratedBy = 'ai' | 'manual'

export interface PlannedExercise {
  exerciseId?: string
  name: string
  sets?: number
  reps?: number | string
  weightKg?: number
  restSec?: number
  notes?: string
}

export interface WorkoutPlan extends BaseEntity {
  status: WorkoutPlanStatus
  generatedBy: GeneratedBy
  exercises: PlannedExercise[]
  goalAlignment?: string
  activatedAt?: Timestamp
  archivedAt?: Timestamp
}

/**
 * INVARIANT (ADR-002): Only one WorkoutPlan with status === 'active' may exist at a time.
 * Enforcement: see invariants.ts (or call assertSingleActiveWorkoutPlan before save).
 */

export interface PerformedExercise extends PlannedExercise {
  actualSets?: number
  actualReps?: number | string
  actualWeightKg?: number
  rpe?: number
}

export interface WorkoutSession extends BaseEntity {
  performedAt: Timestamp
  planId?: string
  exercises: PerformedExercise[]
  volume?: number
  notes?: string
  voiceTranscriptId?: string
}

/**
 * INVARIANT (ADR-002): WorkoutSession.performedAt must not be a future date.
 * A session cannot be logged for tomorrow or later.
 */

export interface ExerciseDefinition {
  id: string
  name: string
  aliases?: string[]
  movementPattern?: string
  equipment?: string
  primaryMuscles?: string[]
  notes?: string
}

export interface ExerciseLibrary extends BaseEntity {
  version: number
  exercises: ExerciseDefinition[]
  userOverrides?: Record<string, Partial<ExerciseDefinition>>
}

/* ===================== NUTRITION ===================== */

export interface Macros {
  calories: number
  protein: number
  carbs: number
  fat: number
}

export interface FoodItem {
  id: string
  name: string
  quantity: number
  unit: string
  macros: Macros
  source: 'openfoodfacts' | 'user' | 'custom'
  brand?: string
}

export interface MealLog extends BaseEntity {
  timestamp: Timestamp
  foodItems: FoodItem[]
  notes?: string
}

/**
 * INVARIANT (ADR-002): A MealLog MUST contain at least one FoodItem.
 */

export interface DailyNutrition extends BaseEntity {
  date: ISODate
  mealLogs: MealLog[]
  totals: Macros
  waterMl?: number
}

/* ===================== FINANCE ===================== */

export interface AccountBalance {
  account: string
  amount: number
  currency: string
}

export interface Position {
  symbol: string
  quantity: number
  price: number
  value: number
}

export interface DailyFinanceSnapshot extends BaseEntity {
  date: ISODate
  netWorth: number
  accounts: AccountBalance[]
  positions: Position[]
}

export type TransactionType =
  | 'buy'
  | 'sell'
  | 'transfer'
  | 'deposit'
  | 'withdrawal'
  | 'dividend'
  | 'fee'
  | 'other'

export interface Transaction extends BaseEntity {
  timestamp: Timestamp
  type: TransactionType
  amount: number
  currency: string
  account?: string
  asset?: string
  quantity?: number
  notes?: string
}

/* ===================== PRODUCTIVITY ===================== */

/**
 * ProductivityTask is the unified replacement for the legacy Todo and Kanban items.
 * It supports both list views and kanban board columns.
 */
export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'cancelled'

export interface ProductivityTask extends BaseEntity {
  text: string
  status: TaskStatus
  /** Convenience flag: true when status === 'done' */
  done: boolean
  date: ISODate
  completedAt?: Timestamp
  due?: ISODate
  notes?: string
  tags?: string[]
  priority?: 1 | 2 | 3
  project?: string
  estimatedMinutes?: number
  energy?: 'low' | 'medium' | 'high'
  /** Kanban board column (e.g. 'backlog' | 'today' | 'doing' | 'done') */
  column?: string
  /** Link to owning/surfacing DailyPlan */
  dailyPlanId?: string
  source?: 'inbox' | 'daily' | 'ai'
}

export interface DailyFocusScore extends BaseEntity {
  date: ISODate
  tasksCompleted: number
  focusMinutes: number
  energyRating?: 1 | 2 | 3 | 4 | 5
  notes?: string
}

/* ===================== PLANNING ===================== */

export interface DailyPlan extends BaseEntity {
  date: ISODate
  workoutPlanId?: string
  nutritionTargets?: Partial<Macros>
  topTaskIds: string[]
  aiSuggestions?: string[]
  voiceNoteIds?: string[]
  notes?: string
}

export interface WeeklyReview extends BaseEntity {
  week: ISOWeek
  wins: string[]
  blockers: string[]
  nextWeekFocus: string[]
  reflection?: string
}

/* ===================== AI & VOICE ===================== */

export interface ToolCall {
  name: string
  arguments: Record<string, any>
  result?: any
}

export interface AIInteraction extends BaseEntity {
  timestamp: Timestamp
  intent: string
  prompt: string
  response: string
  toolCalls?: ToolCall[]
  model: string
  tokensIn?: number
  tokensOut?: number
}

export interface VoiceTranscript extends BaseEntity {
  timestamp: Timestamp
  audioR2Key: string
  transcriptText: string
  durationSec: number
  language?: string
  aiInteractionId?: string
}

/**
 * Structured intent returned by the voice pipeline (ADR-004).
 * Produced by LLM from raw transcript. Executed with safety rules.
 */
export interface VoiceIntent {
  action:
    | 'createTask'
    | 'logWater'
    | 'logMeal'
    | 'deleteTask'
    | 'markTaskDone'
    | 'unknown'
  payload: Record<string, any>
  confidence: number
  requiresConfirmation: boolean
  clarificationQuestion?: string
}

/* ===================== CROSS-CUTTING ===================== */

export interface Attachment extends BaseEntity {
  entityType: string
  entityId: string
  r2Key: string
  mimeType: string
  sizeBytes: number
  filename?: string
}

/** Reusable tag definition (optional registry) */
export interface TagDefinition {
  id: string
  name: string
  color?: string
}

/* ===================== FACTORIES & CREATORS ===================== */

export function createProductivityTask(input: {
  text: string
  date?: ISODate
  due?: ISODate
  notes?: string
  tags?: string[]
  priority?: 1 | 2 | 3
  project?: string
  estimatedMinutes?: number
  energy?: 'low' | 'medium' | 'high'
  column?: string
  source?: ProductivityTask['source']
}): ProductivityTask {
  const now = Date.now()
  const date = input.date ?? todayISO()
  return {
    id: newId('task'),
    text: input.text.trim(),
    status: 'pending',
    done: false,
    date,
    createdAt: now,
    due: input.due,
    notes: input.notes,
    tags: input.tags?.length ? input.tags : undefined,
    priority: input.priority,
    project: input.project,
    estimatedMinutes: input.estimatedMinutes,
    energy: input.energy,
    column: input.column,
    source: input.source ?? 'daily',
  }
}

export function updateTaskStatus(
  task: ProductivityTask,
  status: TaskStatus
): ProductivityTask {
  const now = Date.now()
  const done = status === 'done'
  return {
    ...task,
    status,
    done,
    completedAt: done ? now : task.completedAt,
    updatedAt: now,
  }
}

/** Convert legacy Todo shape to ProductivityTask (best-effort). */
export function productivityTaskFromLegacyTodo(todo: {
  id: string
  text: string
  done: boolean
  createdAt: number
  date: string
  completedAt?: number | null
  notes?: string
  tags?: string[]
  priority?: 1 | 2 | 3
  due?: string
  project?: string
  estimatedMinutes?: number
  energy?: 'low' | 'medium' | 'high'
  source?: string
}): ProductivityTask {
  const status: TaskStatus = todo.done ? 'done' : 'pending'
  return {
    id: todo.id,
    text: todo.text,
    status,
    done: todo.done,
    date: todo.date as ISODate,
    createdAt: todo.createdAt,
    completedAt: todo.completedAt ?? undefined,
    notes: todo.notes,
    tags: todo.tags,
    priority: todo.priority,
    due: todo.due as ISODate | undefined,
    project: todo.project,
    estimatedMinutes: todo.estimatedMinutes,
    energy: todo.energy,
    source: (todo.source as any) ?? 'daily',
  }
}

/**
 * MIGRATION NOTE (ADR-002):
 * Legacy `Todo` (src/lib/todos.ts) + future kanban items are absorbed by
 * `ProductivityTask`. New code should use ProductivityTask + the
 * productivity daily aggregate persistence (src/lib/server/domain.ts).
 *
 * Existing todos UI continues to work against the legacy `todos.json`
 * collection during the transition period.
 * A future one-time migration script can move items into
 * `productivity-tasks/{date}.json` daily aggregates.
 */

/* ===================== INVARIANTS & VALIDATORS ===================== */

export const INVARIANTS = {
  SINGLE_ACTIVE_WORKOUT_PLAN: 'Only one WorkoutPlan with status="active" may exist for the user',
  NO_FUTURE_WORKOUT_SESSION: 'WorkoutSession.performedAt cannot be in the future',
  MEALLOG_REQUIRES_ITEMS: 'MealLog must contain at least one FoodItem',
} as const

export function assertSingleActiveWorkoutPlan(plans: WorkoutPlan[]): void {
  const active = plans.filter((p) => p.status === 'active' && !p.deletedAt)
  if (active.length > 1) {
    throw new Error(INVARIANTS.SINGLE_ACTIVE_WORKOUT_PLAN)
  }
}

export function assertValidWorkoutSessionDate(performedAt: Timestamp, now: Timestamp = Date.now()): void {
  if (performedAt > now) {
    throw new Error(INVARIANTS.NO_FUTURE_WORKOUT_SESSION)
  }
}

export function assertValidMealLog(meal: MealLog): void {
  if (!meal.foodItems || meal.foodItems.length === 0) {
    throw new Error(INVARIANTS.MEALLOG_REQUIRES_ITEMS)
  }
}

/** Soft-delete helper (mutates a copy) */
export function softDelete<T extends BaseEntity>(entity: T): T {
  return {
    ...entity,
    deletedAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/** Convenience creator for ids (timestamp + random) */
export function newId(prefix = ''): string {
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 10)
  return prefix ? `${prefix}-${ts}-${rand}` : `${ts}-${rand}`
}

/** Day key helper (local date) */
export function toISODate(d: Date | number = new Date()): ISODate {
  const date = typeof d === 'number' ? new Date(d) : d
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayISO(): ISODate {
  return toISODate()
}

/** Simple ISO week (approximate, sufficient for personal use) */
export function toISOWeek(d: Date | number = new Date()): ISOWeek {
  const date = typeof d === 'number' ? new Date(d) : d
  const year = date.getFullYear()
  // Use a simple week number (Mon-based approximation)
  const firstJan = new Date(year, 0, 1)
  const days = Math.floor((date.getTime() - firstJan.getTime()) / 86400000)
  const week = Math.ceil((days + firstJan.getDay() + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** Resolve a voice date expression or ISO to a target ISODate (for tasks etc). */
export function resolveVoiceTargetDate(input: unknown, base: ISODate = todayISO()): ISODate {
  if (!input || typeof input !== 'string') return base
  const s = input.trim().toLowerCase()
  if (!s || s === 'today') return base
  if (s === 'tomorrow') {
    const d = new Date(base + 'T00:00:00')
    d.setDate(d.getDate() + 1)
    return toISODate(d)
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s as ISODate
  return base
}

/**
 * Convert a ProductivityTask (from voice/AI) into legacy Todo shape for the
 * compatibility shim. Keeps existing todo UI working during migration.
 */
export function legacyTodoFromProductivityTask(task: ProductivityTask): Todo {
  return {
    id: task.id,
    text: task.text,
    done: task.done,
    createdAt: task.createdAt,
    date: task.date,
    completedAt: task.completedAt ?? null,
    notes: task.notes,
    tags: task.tags,
    priority: task.priority,
    due: task.due,
    project: task.project,
    estimatedMinutes: task.estimatedMinutes,
    energy: task.energy,
    source: (task.source === 'ai' ? 'daily' : task.source) as Todo['source'],
  }
}

/* ===================== TYPE UNIONS ===================== */

export type DomainEntity =
  | WorkoutPlan
  | WorkoutSession
  | DailyNutrition
  | MealLog
  | DailyFinanceSnapshot
  | Transaction
  | ProductivityTask
  | DailyFocusScore
  | DailyPlan
  | WeeklyReview
  | AIInteraction
  | VoiceTranscript
  | Attachment

export type DomainCollectionKey =
  | 'workout-plans'
  | 'workout-sessions'
  | 'exercise-library'
  | 'daily-nutrition'
  | 'daily-finance'
  | 'transactions'
  | 'productivity-tasks'
  | 'focus-scores'
  | 'daily-plans'
  | 'weekly-reviews'
  | 'ai-interactions'
  | 'voice-transcripts'
