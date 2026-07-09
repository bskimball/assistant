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

import type { Todo } from "./todos";

export type ISODate = string; // YYYY-MM-DD
export type ISOWeek = string; // YYYY-Www
export type Timestamp = number; // milliseconds since epoch

export interface BaseEntity {
  id: string;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
  deletedAt?: Timestamp;
}

/** Single root user (Brian). Partition key for all R2 objects. */
export interface User extends BaseEntity {
  preferences?: UserPreferences;
}

export interface UserPreferences {
  timezone?: string;
  units?: "metric" | "imperial";
}

/* ===================== USER PROFILE (ADR-013) ===================== */

export type Sex = "male" | "female" | "other";
export type ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active";
export type RiskTolerance = "conservative" | "moderate" | "aggressive";
/** User-facing workout categories the trainer can emphasize (ADR-013). */
export type WorkoutStyle = "strength" | "calisthenics" | "yoga" | "conditioning";
export const WORKOUT_STYLES: {
  value: WorkoutStyle;
  label: string;
  hint: string;
}[] = [
  {
    value: "strength",
    label: "Strength",
    hint: "Weights — push / pull / legs",
  },
  { value: "calisthenics", label: "Calisthenics", hint: "Bodyweight strength" },
  { value: "yoga", label: "Yoga & mobility", hint: "Flexibility + recovery" },
  { value: "conditioning", label: "Conditioning", hint: "Cardio + core" },
];

/**
 * Long-lived personalization context for the Coach Engine (ADR-013).
 *
 * Stored as a single reference object (`user-profile.json`), NOT a daily
 * aggregate — it changes rarely. Every field is optional so the coach degrades
 * gracefully when the profile is empty (same contract as a missing GROK key).
 */
export interface UserProfile extends BaseEntity {
  // Identity
  displayName?: string;
  birthDate?: ISODate;
  sex?: Sex;
  heightCm?: number;
  units?: "metric" | "imperial";
  timezone?: string;

  // Coaching context
  /** Free-form top-level goals, e.g. "lose 10 lb", "save $20k", "bench 225 lb". */
  goals?: string[];
  /** Preferred coach tone for nudges and feedback. */
  coachingStyle?: "gentle" | "balanced" | "direct";
  /** The deeper reason behind the member's goals. */
  motivation?: string;
  /** Current life constraints/context, e.g. work schedule, family, travel cadence. */
  lifeContext?: string;
  /** Current season of focus, e.g. "cutting until August", "money first". */
  currentFocus?: string;
  activityLevel?: ActivityLevel;

  // Fitness (personal trainer)
  /** Movements/areas to avoid, e.g. "left knee", "no overhead pressing". */
  injuries?: string[];
  trainingDaysPerWeek?: number;
  /** e.g. 'barbell', 'dumbbells', 'full gym', 'bodyweight only'. */
  equipmentAccess?: string[];
  /**
   * Workout styles the trainer should emphasize when building the weekly plan.
   * Empty/undefined → balanced default (strength + calisthenics + yoga).
   */
  preferredWorkoutStyles?: WorkoutStyle[];

  // Nutrition (dietitian)
  /** e.g. 'vegetarian', 'no dairy', 'nut allergy'. */
  dietaryRestrictions?: string[];
  /** Foods/cuisines the member prefers and will realistically eat. */
  foodPreferences?: string[];
  proteinTargetG?: number;
  calorieTargetKcal?: number;
  waterTargetMl?: number;

  // Finance (advisor)
  riskTolerance?: RiskTolerance;
  monthlySavingsGoal?: number;
  financeNotes?: string;
  /**
   * Professional skills the owner could monetize to earn more, e.g.
   * "IT infrastructure", "automation consulting", "Excel modeling". The growth
   * advisor uses these to ground its earn-more suggestions in what he can
   * actually sell rather than generic side-hustle ideas.
   */
  skills?: string[];
}

/** Compute current age in whole years from a birth date, or undefined. */
export function computeAge(birthDate?: ISODate, now: Date = new Date()): number | undefined {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return undefined;
  const b = new Date(birthDate + "T00:00:00");
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age >= 0 && age < 150 ? age : undefined;
}

/** Default empty profile shell (used by the loader when none is stored yet). */
export function createDefaultUserProfile(now: Timestamp = Date.now()): UserProfile {
  return { id: "user-profile", createdAt: now, units: "imperial" };
}

export const CM_PER_INCH = 2.54;
export const ML_PER_FL_OZ = 29.5735295625;

export function cmToInches(cm?: number): number | undefined {
  return typeof cm === "number" ? Math.round(cm / CM_PER_INCH) : undefined;
}

export function inchesToCm(inches?: number): number | undefined {
  return typeof inches === "number" ? Math.round(inches * CM_PER_INCH) : undefined;
}

export function mlToFlOz(ml?: number): number | undefined {
  return typeof ml === "number" ? Math.round(ml / ML_PER_FL_OZ) : undefined;
}

export function flOzToMl(flOz?: number): number | undefined {
  return typeof flOz === "number" ? Math.round(flOz * ML_PER_FL_OZ) : undefined;
}

/* ===================== FITNESS ===================== */

export type WorkoutPlanStatus = "draft" | "active" | "archived";
export type GeneratedBy = "ai" | "manual";

/**
 * Where an exercise sits in the session arc. Every structured workout runs
 * warm-up → main work → core → cooldown stretching so prep and recovery are
 * never skipped (ADR-013 trainer guidance).
 */
export type ExercisePhase = "warmup" | "main" | "core" | "cooldown";

export const EXERCISE_PHASES: { value: ExercisePhase; label: string }[] = [
  { value: "warmup", label: "Warm-up" },
  { value: "main", label: "Main" },
  { value: "core", label: "Core" },
  { value: "cooldown", label: "Cooldown" },
];

export interface PlannedExercise {
  exerciseId?: string;
  name: string;
  sets?: number;
  reps?: number | string;
  weightLb?: number;
  restSec?: number;
  notes?: string;
  /** Session arc segment; defaults to "main" when omitted. */
  phase?: ExercisePhase;
}

export interface WorkoutPlan extends BaseEntity {
  status: WorkoutPlanStatus;
  generatedBy: GeneratedBy;
  exercises: PlannedExercise[];
  /**
   * Template-structure version the plan was generated with. Lets the planner
   * transparently rebuild a stale weekly plan when the session template format
   * changes (e.g. adding the warm-up/core/cooldown arc) instead of leaving an
   * old plan in place until the week rolls over.
   */
  planVersion?: number;
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

/**
 * INVARIANT (ADR-002): Only one WorkoutPlan with status === 'active' may exist at a time.
 * Enforcement: see invariants.ts (or call assertSingleActiveWorkoutPlan before save).
 */

export interface PerformedExercise extends PlannedExercise {
  actualSets?: number;
  actualReps?: number | string;
  actualWeightLb?: number;
  rpe?: number;
}

export interface WorkoutSession extends BaseEntity {
  performedAt: Timestamp;
  planId?: string;
  exercises: PerformedExercise[];
  volume?: number;
  durationMinutes?: number;
  effortRating?: 1 | 2 | 3 | 4 | 5;
  sorenessRating?: 1 | 2 | 3 | 4 | 5;
  notes?: string;
  voiceTranscriptId?: string;
}

/**
 * INVARIANT (ADR-002): WorkoutSession.performedAt must not be a future date.
 * A session cannot be logged for tomorrow or later.
 */

export interface ExerciseDefinition {
  id: string;
  name: string;
  aliases?: string[];
  movementPattern?: string;
  equipment?: string;
  primaryMuscles?: string[];
  notes?: string;
}

export interface ExerciseLibrary extends BaseEntity {
  version: number;
  exercises: ExerciseDefinition[];
  userOverrides?: Record<string, Partial<ExerciseDefinition>>;
}

/* ===================== NUTRITION ===================== */

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
  unit: string;
  macros: Macros;
  source: "openfoodfacts" | "user" | "custom";
  brand?: string;
}

export interface MealLog extends BaseEntity {
  timestamp: Timestamp;
  foodItems: FoodItem[];
  notes?: string;
  estimateConfidence?: "low" | "medium" | "high";
}

/**
 * INVARIANT (ADR-002): A MealLog MUST contain at least one FoodItem.
 */

export interface DailyNutrition extends BaseEntity {
  date: ISODate;
  mealLogs: MealLog[];
  totals: Macros;
  waterMl?: number;
}

/* ===================== FINANCE ===================== */

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

/**
 * The 50/30/20 bucket a transaction (or category) rolls up into.
 * `income` and `transfer` are excluded from the spend buckets so internal
 * money movement and paychecks don't distort needs/wants/savings.
 */
export type CategoryGroup = "needs" | "wants" | "savings" | "income" | "transfer";

export interface Transaction extends BaseEntity {
  timestamp: Timestamp;
  type: TransactionType;
  amount: number;
  currency: string;
  account?: string;
  category?: string;
  /** 50/30/20 bucket; assigned on import by the categorizer, user-overridable. */
  categoryGroup?: CategoryGroup;
  asset?: string;
  quantity?: number;
  notes?: string;
  /** Stable hash (date+amount+description+account) used to de-dupe re-imports. */
  dedupeKey?: string;
  /** Where this transaction came from. */
  source?: "manual" | "import" | "sync";
  /**
   * One-off charges (legal fees, a single big purchase) the user has marked so
   * they don't count against the recurring 50/30/20 monthly plan. This is still
   * tracked money and still shown in lists/totals; only plan comparison ignores it.
   */
  excludeFromBudget?: boolean;
  /** User dismissed the one-time suggestion; heuristics must not re-propose. */
  oneTimeSuggestionDismissed?: boolean;
  /**
   * Recurring item this charge pays. Set by AI enrichment at ingest or by the
   * user via "Link charge"; explicit links win over heuristic matching.
   */
  recurringId?: string;
  /**
   * Who decided the recurring link. "user" without `recurringId` means the
   * user explicitly unlinked this charge, so heuristics must not reclaim it.
   */
  recurringMatchSource?: "ai" | "user";
  /** Model confidence (0-1) for AI recurring matches. */
  recurringMatchConfidence?: number;
  /**
   * Low-confidence AI match surfaced as a link suggestion, never counted in
   * budget math until the user confirms it.
   */
  recurringSuggestedId?: string;
}

/* ---------- Budget (50/30/20) — ref object `budget.json` ---------- */

/** Default 50/30/20 split (needs / wants / savings) as fractions of take-home. */
export const DEFAULT_BUDGET_TARGETS = {
  needs: 0.5,
  wants: 0.3,
  savings: 0.2,
} as const;

export interface Budget extends BaseEntity {
  /** Monthly take-home (post-tax) pay the percentages apply to. */
  monthlyTakeHome: number;
  /** Target fractions; default 50/30/20. Should sum to ~1. */
  targets: { needs: number; wants: number; savings: number };
  /** Optional per-category dollar limits for power use (envelope-style). */
  categoryLimits?: Record<string, number>;
}

/* ---------- Subscriptions — ref object `subscriptions.json` ---------- */

export type SubscriptionCadence = "weekly" | "monthly" | "annual";
export type SubscriptionStatus = "active" | "canceled";

/**
 * The three flavors of recurring commitment we track, from most to least
 * essential:
 * - `loan` — a debt with a payment (mortgage, car, student loan); may carry a
 *   balance/APR for a payoff estimate. Counts as a Need.
 * - `bill` — a recurring essential (utilities, insurance, rent, phone). Need.
 * - `subscription` — discretionary recurring spend (streaming, gym, SaaS).
 *   Lives in Wants or Savings and is the money you could cut.
 */
export type RecurringKind = "loan" | "bill" | "subscription";

export interface Subscription extends BaseEntity {
  name: string;
  amount: number;
  cadence: SubscriptionCadence;
  /** Next expected charge (ISO date), when known. */
  nextChargeDate?: ISODate;
  account?: string;
  category?: string;
  status: SubscriptionStatus;
  /** How this entry originated. */
  source: "detected" | "manual";
  /** Last time a matching charge was seen in the ledger (ms epoch). */
  lastSeen?: Timestamp;
  /**
   * What kind of obligation this is. When unset (legacy rows) it's inferred
   * from `group`: a "needs" item is a bill, everything else a subscription.
   */
  kind?: RecurringKind;
  /** Loans only: outstanding principal, for a payoff estimate. Optional. */
  balance?: number;
  /** Loans only: annual interest rate as a percent (e.g. 6.1). Optional. */
  apr?: number;
  /**
   * Which 50/30/20 bucket this recurring item belongs to. Loans are always
   * needs. Bills can be needs or wants (for example lawn care). Discretionary
   * subscriptions default to wants and can also represent recurring savings.
   */
  group?: CategoryGroup;
  /**
   * Learned merchant-descriptor substrings that identify this item's charge in a
   * bank statement. A manually-named item ("Jeep payment") rarely matches its
   * real descriptor ("TRUIST IL PYMT"); confirming a candidate charge stores the
   * cleaned descriptor here (lowercased) so future charges match without
   * double-counting. Consumed by `recurringMatchesTransaction`.
   */
  matchHints?: string[];
}

/**
 * Resolve a recurring item's kind, inferring it from the legacy `group` field
 * for rows saved before `kind` existed (needs → bill, otherwise subscription).
 */
export function recurringKindOf(sub: Pick<Subscription, "kind" | "group">): RecurringKind {
  if (sub.kind) return sub.kind;
  return sub.group === "needs" ? "bill" : "subscription";
}

/**
 * A "bill" here means a fixed recurring obligation, not necessarily a Needs
 * bucket item. This keeps monthly bills distinct from discretionary
 * subscriptions so the cuttable-subscription total stays meaningful.
 */
export function isBillSubscription(sub: Pick<Subscription, "kind" | "group">): boolean {
  const kind = recurringKindOf(sub);
  return kind === "loan" || kind === "bill";
}

/** Which 50/30/20 bucket an active recurring commitment contributes to. */
export function recurringBudgetBucket(
  sub: Pick<Subscription, "kind" | "group">,
): "needs" | "wants" | "savings" {
  const kind = recurringKindOf(sub);
  if (kind === "loan") return "needs";
  if (kind === "bill") return sub.group === "wants" ? "wants" : "needs";
  return sub.group === "savings" ? "savings" : "wants";
}

/**
 * Cuttable subscriptions are discretionary recurring costs. Recurring savings
 * contributions are tracked under the same recurring mechanism but are money
 * kept, not subscription burn.
 */
export function isCuttableSubscription(sub: Pick<Subscription, "kind" | "group">): boolean {
  return recurringKindOf(sub) === "subscription" && recurringBudgetBucket(sub) === "wants";
}

/**
 * Months to pay off a loan given its balance, APR, and monthly payment, using
 * the standard amortization formula. Returns null when there's not enough info
 * or the payment doesn't cover the monthly interest (never pays off).
 */
export function loanPayoffMonths(
  balance: number | undefined,
  apr: number | undefined,
  monthlyPayment: number,
): number | null {
  if (!balance || balance <= 0 || !monthlyPayment || monthlyPayment <= 0) return null;
  const r = (apr ?? 0) / 100 / 12;
  if (r === 0) return Math.ceil(balance / monthlyPayment);
  const denom = 1 - (r * balance) / monthlyPayment;
  if (denom <= 0) return null; // payment doesn't even cover interest
  return Math.ceil(-Math.log(denom) / Math.log(1 + r));
}

/* ---------- AI growth advisor (ADR-016) ---------- */

export type FinanceAdviceCategory = "budget" | "subscriptions" | "investing" | "earn";

export interface FinanceAdviceItem {
  category: FinanceAdviceCategory;
  /** One specific, actionable recommendation. */
  text: string;
  /** Short imperative label, used as the task title when accepted. */
  action?: string;
}

/** Normalize a subscription's cost to a monthly figure for totals/comparison. */
export function subscriptionMonthlyCost(sub: Pick<Subscription, "amount" | "cadence">): number {
  switch (sub.cadence) {
    case "weekly":
      return (sub.amount * 52) / 12;
    case "annual":
      return sub.amount / 12;
    default:
      return sub.amount;
  }
}

/**
 * Turn a raw bank-statement description ("GOOGLE *Microsoft One 06/20 PURCHASE 85")
 * into a readable merchant label ("Google Microsoft One"). Strips dates, store/phone
 * numbers, and processor noise, then title-cases the first few meaningful words.
 * Roughly idempotent on already-clean names ("Netflix" -> "Netflix").
 */
const MERCHANT_STOPWORDS =
  /\b(?:purchase|pos|debit|credit|card|payment|recurring|ach|web|id|ppd|des|indn|co|www|com|net|org|llc|inc|usa|us)\b/gi;

export function cleanMerchantName(raw: string): string {
  const cleaned = raw
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ") // dates like 06/20
    .replace(/[*#]/g, " ")
    .replace(/[^A-Za-z0-9& ]+/g, " ") // drop slashes, dots, dashes, punctuation
    .replace(MERCHANT_STOPWORDS, " ")
    .replace(/\b\d+\b/g, " ") // standalone numbers (store ids, phone parts)
    .replace(/\s+/g, " ")
    .trim();
  const seen = new Set<string>();
  const words = cleaned
    .split(" ")
    .filter((w) => w && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()))
    .slice(0, 3);
  const name = words
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
  return name || raw.slice(0, 24).trim();
}

/** Which 50/30/20 bucket a category group counts toward, or null if excluded. */
export function spendBucketOf(
  group: CategoryGroup | undefined,
): "needs" | "wants" | "savings" | null {
  if (group === "needs" || group === "wants" || group === "savings") return group;
  return null;
}

/**
 * Single source of truth for cash flow so every page (Today, Finance, Analytics)
 * reports the same number for the same transactions. Caller pre-filters the list
 * to the period it cares about (a month, a rolling window, a day).
 *
 * Transfers (credit-card payments, moving money between your own accounts) are
 * excluded — they aren't real income or spending and otherwise make cash flow
 * look far worse than it is. When `monthlyTakeHome` is set it stands in for
 * income, since imported deposits miss paychecks landing in un-imported accounts.
 */
export function summarizeCashFlow(
  transactions: Transaction[],
  monthlyTakeHome = 0,
): { income: number; spend: number; cashFlow: number; importedIncome: number } {
  let importedIncome = 0;
  let spend = 0;
  for (const t of transactions) {
    if (t.deletedAt || t.categoryGroup === "transfer") continue;
    if (t.amount > 0) importedIncome += t.amount;
    else spend += Math.abs(t.amount);
  }
  const income = monthlyTakeHome > 0 ? monthlyTakeHome : importedIncome;
  return { income, spend, cashFlow: income - spend, importedIncome };
}

/* ===================== PRODUCTIVITY ===================== */

/**
 * ProductivityTask is the unified replacement for the legacy Todo and Kanban items.
 * It supports both list views and kanban board columns.
 */
export type TaskStatus = "pending" | "in_progress" | "done" | "cancelled";

export interface ProductivityTask extends BaseEntity {
  text: string;
  status: TaskStatus;
  /** Convenience flag: true when status === 'done' */
  done: boolean;
  date: ISODate;
  completedAt?: Timestamp;
  due?: ISODate;
  notes?: string;
  tags?: string[];
  priority?: 1 | 2 | 3;
  project?: string;
  estimatedMinutes?: number;
  energy?: "low" | "medium" | "high";
  /** Kanban board column (e.g. 'backlog' | 'today' | 'doing' | 'done') */
  column?: string;
  /** Link to owning/surfacing DailyPlan */
  dailyPlanId?: string;
  source?: "inbox" | "daily" | "ai";
  /**
   * Household sharing (ADR-017). When true the task is stored in the shared
   * household scope and visible to both members; otherwise it is personal to
   * the signed-in user. Set on load from the store it was read from.
   */
  shared?: boolean;
}

export interface DailyFocusScore extends BaseEntity {
  date: ISODate;
  tasksCompleted: number;
  focusMinutes: number;
  energyRating?: 1 | 2 | 3 | 4 | 5;
  notes?: string;
}

/* ===================== PLANNING ===================== */

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
    exercises: {
      name: string;
      sets: number;
      reps: string;
      phase?: ExercisePhase;
    }[];
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

/* ===================== AI & VOICE ===================== */

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
}

export interface VoiceTranscript extends BaseEntity {
  timestamp: Timestamp;
  audioR2Key: string;
  transcriptText: string;
  durationSec: number;
  language?: string;
  aiInteractionId?: string;
}

/**
 * Structured intent returned by the voice pipeline (ADR-004).
 * Produced by LLM from raw transcript. Executed with safety rules.
 */
export interface VoiceIntent {
  action: "createTask" | "logWater" | "logMeal" | "deleteTask" | "markTaskDone" | "unknown";
  payload: Record<string, any>;
  confidence: number;
  requiresConfirmation: boolean;
  clarificationQuestion?: string;
}

/* ===================== COACH CHAT (ADR-018) ===================== */

export type CoachMemoryCategory = "goal" | "preference" | "constraint" | "life_event" | "milestone";

export interface CoachMemory {
  id: string;
  category: CoachMemoryCategory;
  /** One durable fact in third person, e.g. "Training for a 5K in September with his daughter." */
  content: string;
  createdAt: number;
  updatedAt: number;
  /** Conversation the fact was learned in (traceability). */
  sourceConversationId?: string;
  deletedAt?: number;
}

export interface CoachMemoriesStore {
  memories: CoachMemory[];
  updatedAt: number;
}

export type ChatRole = "user" | "assistant";

/** One persisted turn of a coach conversation. */
export interface ChatMessageRecord {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
}

/** A full coach conversation (transcript + metadata), stored per-user. */
export interface ChatConversation {
  id: string;
  /** Short label derived from the first user message. */
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessageRecord[];
  deletedAt?: number;
}

/** Lightweight conversation row for the history list (no full transcript). */
export interface ChatConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** First line of the most recent message, truncated. */
  preview: string;
}

export interface ChatConversationsStore {
  conversations: ChatConversation[];
  updatedAt: number;
}

/* ===================== CROSS-CUTTING ===================== */

export interface Attachment extends BaseEntity {
  entityType: string;
  entityId: string;
  r2Key: string;
  mimeType: string;
  sizeBytes: number;
  filename?: string;
}

/** Reusable tag definition (optional registry) */
export interface TagDefinition {
  id: string;
  name: string;
  color?: string;
}

/* ===================== FACTORIES & CREATORS ===================== */

export function createProductivityTask(input: {
  text: string;
  date?: ISODate;
  due?: ISODate;
  notes?: string;
  tags?: string[];
  priority?: 1 | 2 | 3;
  project?: string;
  estimatedMinutes?: number;
  energy?: "low" | "medium" | "high";
  column?: string;
  source?: ProductivityTask["source"];
  shared?: boolean;
}): ProductivityTask {
  const now = Date.now();
  const date = input.date ?? todayISO();
  return {
    id: newId("task"),
    text: input.text.trim(),
    status: "pending",
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
    source: input.source ?? "daily",
    shared: input.shared ? true : undefined,
  };
}

export function updateTaskStatus(task: ProductivityTask, status: TaskStatus): ProductivityTask {
  const now = Date.now();
  const done = status === "done";
  return {
    ...task,
    status,
    done,
    completedAt: done ? now : task.completedAt,
    updatedAt: now,
  };
}

/** Convert legacy Todo shape to ProductivityTask (best-effort). */
export function productivityTaskFromLegacyTodo(todo: {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
  date: string;
  completedAt?: number | null;
  notes?: string;
  tags?: string[];
  priority?: 1 | 2 | 3;
  due?: string;
  project?: string;
  estimatedMinutes?: number;
  energy?: "low" | "medium" | "high";
  source?: string;
}): ProductivityTask {
  const status: TaskStatus = todo.done ? "done" : "pending";
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
    source: (todo.source as any) ?? "daily",
  };
}

/**
 * MIGRATION NOTE (ADR-002):
 * Legacy `Todo` (src/lib/todos.ts) + future kanban items are absorbed by
 * `ProductivityTask`. New code should use ProductivityTask + the
 * productivity daily aggregate persistence (src/server/domain.ts).
 *
 * Existing todos UI continues to work against the legacy `todos.json`
 * collection during the transition period.
 * A future one-time migration script can move items into
 * `productivity-tasks/{date}.json` daily aggregates.
 */

/* ===================== INVARIANTS & VALIDATORS ===================== */

export const INVARIANTS = {
  SINGLE_ACTIVE_WORKOUT_PLAN: 'Only one WorkoutPlan with status="active" may exist for the user',
  NO_FUTURE_WORKOUT_SESSION: "WorkoutSession.performedAt cannot be in the future",
  MEALLOG_REQUIRES_ITEMS: "MealLog must contain at least one FoodItem",
} as const;

export function assertSingleActiveWorkoutPlan(plans: WorkoutPlan[]): void {
  const active = plans.filter((p) => p.status === "active" && !p.deletedAt);
  if (active.length > 1) {
    throw new Error(INVARIANTS.SINGLE_ACTIVE_WORKOUT_PLAN);
  }
}

export function assertValidWorkoutSessionDate(
  performedAt: Timestamp,
  now: Timestamp = Date.now(),
): void {
  if (performedAt > now) {
    throw new Error(INVARIANTS.NO_FUTURE_WORKOUT_SESSION);
  }
}

export function assertValidMealLog(meal: MealLog): void {
  if (!meal.foodItems || meal.foodItems.length === 0) {
    throw new Error(INVARIANTS.MEALLOG_REQUIRES_ITEMS);
  }
}

/** Soft-delete helper (mutates a copy) */
export function softDelete<T extends BaseEntity>(entity: T): T {
  return {
    ...entity,
    deletedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Convenience creator for ids (timestamp + random) */
export function newId(prefix = ""): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  return prefix ? `${prefix}-${ts}-${rand}` : `${ts}-${rand}`;
}

/**
 * The household's timezone, used when day keys are computed server-side.
 * Cloudflare Workers run in UTC, so without this every server-derived "today"
 * flips to tomorrow during the members' evening (8pm EDT). In the browser the
 * runtime is already in the member's local timezone, so it is used as-is.
 */
export const HOUSEHOLD_TIMEZONE = "America/New_York";

// en-CA formats as YYYY-MM-DD. Constructed once — Intl formatters are costly.
const householdDayFormatter =
  typeof document === "undefined"
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: HOUSEHOLD_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
    : null;

/** Day key helper (member-local date; household timezone on the server) */
export function toISODate(d: Date | number = new Date()): ISODate {
  const date = typeof d === "number" ? new Date(d) : d;
  if (householdDayFormatter) return householdDayFormatter.format(date);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayISO(): ISODate {
  return toISODate();
}

/**
 * Add whole days to an ISO date with pure UTC math. Runtime-timezone-proof:
 * `new Date(iso + "T00:00:00")` → `toISODate(...)` round trips shift a day on
 * the server (UTC parse, household-timezone format), so day arithmetic on
 * ISO strings must go through this instead. Noon UTC is immune to DST shifts.
 */
export function addDaysISO(date: ISODate, days: number): ISODate {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Simple ISO week (approximate, sufficient for personal use) */
export function toISOWeek(d: Date | number = new Date()): ISOWeek {
  const date = typeof d === "number" ? new Date(d) : d;
  const year = date.getFullYear();
  // Use a simple week number (Mon-based approximation)
  const firstJan = new Date(year, 0, 1);
  const days = Math.floor((date.getTime() - firstJan.getTime()) / 86400000);
  const week = Math.ceil((days + firstJan.getDay() + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Resolve a voice date expression or ISO to a target ISODate (for tasks etc). */
export function resolveVoiceTargetDate(input: unknown, base: ISODate = todayISO()): ISODate {
  if (!input || typeof input !== "string") return base;
  const s = input.trim().toLowerCase();
  if (!s || s === "today") return base;
  if (s === "tomorrow") {
    return addDaysISO(base, 1);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s as ISODate;
  return base;
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
    source: (task.source === "ai" ? "daily" : task.source) as Todo["source"],
  };
}

/* ===================== TYPE UNIONS ===================== */

export type DomainEntity =
  | WorkoutPlan
  | WorkoutSession
  | DailyNutrition
  | MealLog
  | DailyFinanceSnapshot
  | Transaction
  | Budget
  | Subscription
  | ProductivityTask
  | DailyFocusScore
  | DailyPlan
  | WeeklyReview
  | CoachMemory
  | AIInteraction
  | VoiceTranscript
  | Attachment;

export type DomainCollectionKey =
  | "workout-plans"
  | "workout-sessions"
  | "exercise-library"
  | "daily-nutrition"
  | "daily-finance"
  | "transactions"
  | "productivity-tasks"
  | "focus-scores"
  | "daily-plans"
  | "weekly-reviews"
  | "ai-interactions"
  | "voice-transcripts";
