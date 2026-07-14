/**
 * Core Domain Model — v0.3
 * Source of truth for agent prompts, code generation, and runtime types.
 *
 * This file mirrors the accepted model from ADR-002.
 * DO NOT edit without also updating the ADR, glossary, and src/lib/domain.ts.
 *
 * Single user: "Brian" (USER_ID = 'brian')
 * All data partitioned under assistant/brian/
 */

export type ISODate = string; // YYYY-MM-DD
export type ISOWeek = string; // YYYY-Www e.g. 2026-W25
export type Timestamp = number; // ms since epoch

export interface BaseEntity {
  id: string;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
  /** Soft delete marker. Nightly worker hard-deletes when deletedAt < now-7d */
  deletedAt?: Timestamp;
}

/** Root (single user partition key) */
export interface User extends BaseEntity {
  preferences?: UserPreferences;
}

export interface UserPreferences {
  timezone?: string;
  units?: "metric" | "imperial";
  // Future: voice settings, notification prefs, etc.
}

/** ========== USER PROFILE (ADR-013) ==========
 * Long-lived personalization context for the Coach Engine.
 * Stored as a single reference object (user-profile.json), all fields optional.
 */
export type Sex = "male" | "female" | "other";
export type ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active";
export type RiskTolerance = "conservative" | "moderate" | "aggressive";
export type WorkoutStyle = "strength" | "calisthenics" | "yoga" | "conditioning";

export interface UserProfile extends BaseEntity {
  // Identity
  displayName?: string;
  birthDate?: ISODate;
  sex?: Sex;
  heightCm?: number;
  units?: "metric" | "imperial";
  timezone?: string;
  // Coaching
  goals?: string[];
  activityLevel?: ActivityLevel;
  // Fitness
  injuries?: string[];
  trainingDaysPerWeek?: number;
  equipmentAccess?: string[];
  /** Empty/undefined means balanced default: strength + calisthenics + yoga. */
  preferredWorkoutStyles?: WorkoutStyle[];
  // Nutrition
  dietaryRestrictions?: string[];
  proteinTargetG?: number;
  calorieTargetKcal?: number;
  waterTargetMl?: number;
  // Finance
  riskTolerance?: RiskTolerance;
  monthlySavingsGoal?: number;
  financeNotes?: string;
}

/** ========== FITNESS ========== */

export type WorkoutPlanStatus = "draft" | "active" | "archived";
export type GeneratedBy = "ai" | "manual";

export interface PlannedExercise {
  exerciseId?: string; // from ExerciseLibrary
  name: string;
  sets?: number;
  reps?: number | string; // "8-12" or exact
  weightLb?: number;
  restSec?: number;
  notes?: string;
}

export interface WorkoutPlan extends BaseEntity {
  status: WorkoutPlanStatus;
  generatedBy: GeneratedBy;
  exercises: PlannedExercise[];
  /** Monday/Sunday bounds for weekly AI plans. */
  weekStartDate?: ISODate;
  weekEndDate?: ISODate;
  plannedSessions?: PlannedWorkoutSession[];
  goalAlignment?: string;
  activatedAt?: Timestamp;
  archivedAt?: Timestamp;
}

export interface PlannedWorkoutSession {
  date: ISODate;
  title: string;
  focus: string;
  estimatedMinutes: number;
  exercises: PlannedExercise[];
}

/** Invariant: only ONE WorkoutPlan with status==='active' at any time. */

export interface PerformedExercise extends PlannedExercise {
  actualSets?: number;
  actualReps?: number | string;
  actualWeightLb?: number;
  rpe?: number; // 1-10
}

export interface WorkoutSession extends BaseEntity {
  performedAt: Timestamp; // MUST NOT be in the future (invariant)
  planId?: string;
  exercises: PerformedExercise[];
  volume?: number; // total volume calculated
  durationMinutes?: number;
  effortRating?: 1 | 2 | 3 | 4 | 5;
  sorenessRating?: 1 | 2 | 3 | 4 | 5;
  notes?: string;
  voiceTranscriptId?: string;
}

/** Invariant: WorkoutSession.performedAt <= now (server time at creation). */

export interface ExerciseDefinition {
  id: string;
  name: string;
  aliases?: string[];
  movementPattern?: string; // push, pull, squat, hinge, etc.
  equipment?: string;
  primaryMuscles?: string[];
  notes?: string;
}

export interface ExerciseLibrary {
  version: number;
  exercises: ExerciseDefinition[];
  userOverrides?: Record<string, Partial<ExerciseDefinition>>;
}

/** ========== NUTRITION ========== */

export interface Macros {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface FoodItem {
  id: string;
  name: string;
  quantity: number;
  unit: string; // g, ml, serving, etc.
  macros: Macros; // scaled to the quantity
  source: "openfoodfacts" | "user" | "custom";
  brand?: string;
}

export interface MealLog extends BaseEntity {
  timestamp: Timestamp;
  /** Invariant: foodItems.length >= 1 */
  foodItems: FoodItem[];
  notes?: string;
  // attachments?: Attachment[]
}

export interface DailyNutrition extends BaseEntity {
  date: ISODate;
  mealLogs: MealLog[];
  totals: Macros;
  waterMl?: number;
}

/** ========== FINANCE ========== */

export interface AccountBalance {
  account: string;
  amount: number;
  currency: string;
}

export interface Position {
  symbol: string;
  quantity: number;
  price: number;
  value: number;
  /** False when a synced account balance already includes this holding. */
  includedInNetWorth?: boolean;
}

export interface DailyFinanceSnapshot extends BaseEntity {
  date: ISODate;
  netWorth: number;
  accounts: AccountBalance[];
  positions: Position[];
}

export type TransactionType =
  | "buy"
  | "sell"
  | "transfer"
  | "deposit"
  | "withdrawal"
  | "dividend"
  | "fee"
  | "other";

export interface Transaction extends BaseEntity {
  timestamp: Timestamp;
  type: TransactionType;
  amount: number;
  currency: string;
  account?: string;
  category?: string;
  asset?: string;
  quantity?: number;
  notes?: string;
  source?: "manual" | "import" | "sync";
}

/** ========== PRODUCTIVITY ========== */

/** Replaces legacy Todo + kanban items. */
export type TaskStatus = "pending" | "in_progress" | "done" | "cancelled";

export interface ProductivityTask extends BaseEntity {
  text: string;
  status: TaskStatus;
  done: boolean; // derived convenience (status === 'done')
  date: ISODate; // the day this task is scheduled for
  completedAt?: Timestamp;
  due?: ISODate;
  notes?: string;
  tags?: string[];
  priority?: 1 | 2 | 3;
  project?: string;
  estimatedMinutes?: number;
  energy?: "low" | "medium" | "high";
  /** Optional kanban column for board views */
  column?: string;
  /** Optional link to the DailyPlan that owns/surfaced this task */
  dailyPlanId?: string;
  source?: "inbox" | "daily" | "ai";
}

export interface DailyFocusScore extends BaseEntity {
  date: ISODate;
  tasksCompleted: number;
  focusMinutes: number;
  energyRating?: 1 | 2 | 3 | 4 | 5;
  notes?: string;
}

/** ========== PLANNING ========== */

export interface DailyPlan extends BaseEntity {
  date: ISODate;
  workoutPlanId?: string;
  nutritionTargets?: Partial<Macros>;
  topTaskIds: string[];
  acceptedAt?: Timestamp;
  acceptedSuggestionIds?: string[];
  aiSuggestions?: string[];
  aiCoaching?: DailyCoachingSnapshot;
  voiceNoteIds?: string[];
  notes?: string;
}

export interface DailyCoachingSnapshot {
  headline: string;
  suggestions: {
    domain: "focus" | "fitness" | "nutrition" | "finance" | "family" | "general";
    text: string;
    action?: string;
  }[];
  workout: {
    title: string;
    focus: string;
    estimatedMinutes: number;
    exercises: { name: string; sets: number; reps: string }[];
  };
  generatedBy: "ai" | "fallback";
  updatedAt: Timestamp;
}

export interface WeeklyReview extends BaseEntity {
  week: ISOWeek;
  wins: string[];
  blockers: string[];
  nextWeekFocus: string[];
  reflection?: string;
}

/** ========== AI & VOICE (append-only) ========== */

export interface ToolCall {
  name: string;
  arguments: Record<string, any>;
  result?: any;
}

export interface AIInteraction extends BaseEntity {
  timestamp: Timestamp;
  intent: string;
  prompt: string;
  response: string;
  toolCalls?: ToolCall[];
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  // voiceTranscriptId?: string  // if triggered by voice
}

export interface VoiceTranscript extends BaseEntity {
  timestamp: Timestamp;
  audioR2Key: string; // points to the blob in R2 ('' in v1 per ADR-004)
  transcriptText: string;
  durationSec: number;
  language?: string;
  aiInteractionId?: string; // link to the AIInteraction that processed it
}

/**
 * Structured intent produced by the voice pipeline (ADR-004).
 * Sent from STT -> Grok (via TanStack AI or direct equiv) -> action.
 */
export interface VoiceIntent {
  action: "createTask" | "logWater" | "logMeal" | "deleteTask" | "markTaskDone" | "unknown";
  payload: Record<string, any>;
  confidence: number;
  requiresConfirmation: boolean;
  clarificationQuestion?: string;
}

/** ========== CROSS-CUTTING ========== */

export interface Attachment extends BaseEntity {
  entityType: string; // 'meal' | 'workout' | ...
  entityId: string;
  r2Key: string;
  mimeType: string;
  sizeBytes: number;
  filename?: string;
}

export interface Tag {
  id: string;
  name: string;
  color?: string;
}

/** ========== INVARIANTS (documented for enforcement) ========== */

/**
 * 1. Only one WorkoutPlan may have status === 'active'.
 * 2. WorkoutSession.performedAt must be <= current time at creation.
 * 3. Every MealLog must contain at least one FoodItem.
 */
export const INVARIANTS = {
  SINGLE_ACTIVE_WORKOUT_PLAN: 'Only one WorkoutPlan with status="active" may exist',
  NO_FUTURE_WORKOUT_SESSION: "WorkoutSession.performedAt cannot be in the future",
  MEALLOG_REQUIRES_ITEMS: "MealLog.foodItems must contain at least one FoodItem",
} as const;

/** Type helpers for agents and code */
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
  | Attachment;

export type DomainAggregate =
  | DailyNutrition
  | DailyFinanceSnapshot
  | DailyPlan
  | WeeklyReview
  | WorkoutPlan
  | ExerciseLibrary;

/**
 * R2 Key Patterns (see consolidated ADR-003 + glossary)
 *
 * Base prefix: assistant/brian/
 *
 * Daily aggregates (read-modify-write compaction):
 *   assistant/brian/{domain}/{YYYY-MM-DD}.json
 *   Examples: daily-nutrition/, daily-plan/, productivity-tasks/, focus-score/
 *
 * Weekly aggregates:
 *   assistant/brian/{domain}/{YYYY}-W{ww}.json   (e.g. weekly-review/)
 *
 * Append-only logs (AI & Voice — never compacted):
 *   assistant/brian/{domain}/{YYYY-MM-DD}.jsonl   or single {domain}.jsonl
 *
 * ADR-004 voice pipeline uses dedicated per-object layout for identity:
 *   assistant/brian/ai/transcripts/{transcriptId}.json
 *   assistant/brian/ai/interactions/{id}.json
 *
 * Reference / long-lived:
 *   assistant/brian/{collection}.json   (workout-plans.json, exercise-library.json, ...)
 *
 * Soft-delete index (for efficient 7-day hard-delete worker):
 *   assistant/brian/meta/deleted/{YYYY-MM-DD}.json
 *   Contains array of { key: string, deletedAt: Timestamp, domain?: string }
 *
 * Legacy flat collections (todos.json etc.) remain during transition and are
 * absorbed into daily productivity aggregates.
 *
 * Source of truth for key construction: src/server/adapters/r2.ts (getDailyKey, getLogKey, getRefKey, getDeletedIndexKey, appendLogLine, ...)
 */
