import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Reveal, revealDelay } from "@/components/motion";
import { dashboardQuery, workoutSessionsQuery, financeHubQuery, queryKeys } from "@/lib/queries";
import {
  Mic,
  Square,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  CalendarDays,
  Lock,
  Dumbbell,
  Wallet,
  Utensils,
  Brain,
  Users,
  Target,
  Droplet,
  RefreshCw,
  Plus,
  Check,
  ListTodo,
  Minus,
  Trash2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { VoiceInput, speakAssistant } from "@/components/VoiceInput";
import { WorkoutCarousel } from "@/components/WorkoutCarousel";
import {
  processVoiceInput,
  saveProductivityTasksForDay,
  appendWorkoutSession,
  saveDailyFinance,
  appendTransaction,
  saveDailyNutrition,
  saveEveningCheckIn,
  recordRecommendationOutcome,
  type DailyDashboardPayload,
} from "@/server/domain";
import { type FinanceHubPayload } from "@/server/finance";
import {
  acceptDailyCoachingPlan,
  generateCoaching,
  estimateFoodMacros,
  type CoachingResult,
  type CoachDomain,
} from "@/server/coach";
import type { DailyNutrition, ISODate, DailyFocusScore, DailyPlan } from "@/lib/domain";
import { selectNextBestAction } from "@/lib/next-best-action";
import { stableRecommendationId } from "@/lib/recommendation-id";
import {
  createProductivityTask,
  flOzToMl,
  mlToFlOz,
  newId,
  summarizeCashFlow,
  todayISO,
  toISODate,
} from "@/lib/domain";
import {
  productivityTasksCollection,
  hydrateProductivityTasks,
  upsertProductivityTaskClient,
  getTasksForDate,
} from "@/lib/daily";

// Unified Daily Improvement Dashboard (ADR-005)
// Daily aggregates + TanStack DB for reactivity, now with a live AI coach.

type Search = { date?: string };

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): Search => {
    const raw = typeof search.date === "string" ? search.date : undefined;
    const valid = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
    return { date: valid };
  },
  loaderDeps: ({ search }) => ({ date: search.date }),
  loader: ({ context: { queryClient }, deps }) => {
    const date = (deps.date as ISODate) || todayISO();
    return Promise.all([
      queryClient.ensureQueryData(dashboardQuery(date)),
      queryClient.ensureQueryData(workoutSessionsQuery()),
      queryClient.ensureQueryData(financeHubQuery(date)),
    ]);
  },
  component: UnifiedDailyDashboard,
});

const DOMAIN_ICON: Record<CoachDomain, typeof Sparkles> = {
  focus: Target,
  fitness: Dumbbell,
  nutrition: Utensils,
  finance: Wallet,
  family: Users,
  general: Brain,
};

// Subtle per-domain icon colors (icons only — bars/cards stay neutral/primary).
const DOMAIN_COLOR: Record<CoachDomain, string> = {
  focus: "text-rose-500",
  fitness: "text-emerald-500",
  nutrition: "text-amber-500",
  finance: "text-green-600 dark:text-green-500",
  family: "text-violet-500",
  general: "text-indigo-500",
};

// Progress-bar fill color. `over` (e.g. calories past target) is the only "bad"
// state for these daily goals; otherwise green rewards progress, amber is partway.
function fillTone(pct: number, over = false): string {
  if (over) return "bg-destructive";
  if (pct >= 80) return "bg-emerald-500";
  if (pct >= 40) return "bg-amber-500";
  return "bg-primary";
}

/** Recent Activity shows AIInteraction.response — prefer spoken prose, never raw JSON. */
function humanizeAiActivity(response?: string, intent?: string): string {
  const raw = (response || intent || "").toString().trim();
  if (!raw) return "";
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as {
        result?: unknown;
        spokenText?: unknown;
      };
      const spoken =
        (typeof parsed.result === "string" && parsed.result) ||
        (typeof parsed.spokenText === "string" && parsed.spokenText);
      if (spoken) return spoken.slice(0, 120);
    } catch {
      /* keep raw slice below */
    }
  }
  return raw.slice(0, 120);
}

function UnifiedDailyDashboard() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const dateInputRef = useRef<HTMLInputElement>(null);

  const today = todayISO();
  const selectedDate: ISODate = (search.date as ISODate) || today;
  const isToday = selectedDate === today;
  const dateLabel = new Date(selectedDate + "T00:00:00").toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  // Dashboard data (ADR-005) — cached by date in the Query cache and primed by
  // the route loader, so revisiting "/" is instant. Mutations write back via the
  // setDashboardData/setHubData helpers or invalidate via reload().
  const queryClient = useQueryClient();
  const dashKey = dashboardQuery(selectedDate).queryKey;
  const hubKey = financeHubQuery(selectedDate).queryKey;
  const dashQuery = useQuery(dashboardQuery(selectedDate));
  const sessionsQ = useQuery(workoutSessionsQuery());
  const hubQuery = useQuery(financeHubQuery(selectedDate));
  const dashboard = dashQuery.data ?? null;
  const isLoading = dashQuery.isPending;
  const [syncing, setSyncing] = useState(false);
  const [hiddenNextBestActionDate, setHiddenNextBestActionDate] = useState<ISODate | null>(null);

  const reload = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.dashboard(selectedDate),
      }),
      queryClient.invalidateQueries({ queryKey: queryKeys.workoutSessions() }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.financeHub(selectedDate),
      }),
    ]);
  const setDashboardData = (fn: (d: DailyDashboardPayload) => DailyDashboardPayload) =>
    queryClient.setQueryData(dashKey, (d) => (d ? fn(d) : d));
  const setHubData = (fn: (h: FinanceHubPayload) => FinanceHubPayload) =>
    queryClient.setQueryData(hubKey, (h) => (h ? fn(h) : h));

  // Coaching state
  const [coaching, setCoaching] = useState<CoachingResult | null>(null);
  const [coachLoading, setCoachLoading] = useState(false);

  // Voice state (ADR-004)
  const [voiceStatus, setVoiceStatus] = useState<string>("");
  const [pendingConfirm, setPendingConfirm] = useState<{
    transcript: string;
    intentText?: string;
  } | null>(null);
  const [isVoiceProcessing, setIsVoiceProcessing] = useState(false);

  // Listening overlay (for persistent mic FAB)
  const [isListeningOverlay, setIsListeningOverlay] = useState(false);
  const [interim, setInterim] = useState("");
  const [listenError, setListenError] = useState<string | null>(null);

  // Local quick-add for tasks (Focus section)
  const [taskInput, setTaskInput] = useState("");

  // Nutrition quick-add (AI estimates macros from the description)
  const [foodName, setFoodName] = useState("");
  const [foodEstimating, setFoodEstimating] = useState(false);
  const [foodStatus, setFoodStatus] = useState<string | null>(null);
  // While dragging the water slider we hold the in-flight oz here so the fill
  // follows the thumb; we commit to the server on release.
  const [waterDraft, setWaterDraft] = useState<number | null>(null);
  const [checkInEnergy, setCheckInEnergy] = useState(3);
  const [checkInRating, setCheckInRating] = useState(3);
  const [checkInWin, setCheckInWin] = useState("");
  const [checkInFriction, setCheckInFriction] = useState("");
  const [checkInSaving, setCheckInSaving] = useState(false);

  // Finance quick-add
  const [acctName, setAcctName] = useState("");
  const [acctAmount, setAcctAmount] = useState("");
  const [txnAmount, setTxnAmount] = useState("");
  const [txnCategory, setTxnCategory] = useState("");
  const [txnNote, setTxnNote] = useState("");
  // Derived from the cached queries.
  const financeHub = hubQuery.data ?? null;
  const transactions = (hubQuery.data?.transactions || []).filter((t) => !t.deletedAt);
  const workoutSessions = (sessionsQ.data?.sessions || []).filter((s) => !s.deletedAt);

  // Subscribe to productivity collection for instant updates
  const [tasksVersion, setTasksVersion] = useState(0);
  useEffect(() => {
    const sub = productivityTasksCollection.subscribeChanges(() => setTasksVersion((v) => v + 1));
    return () => sub.unsubscribe();
  }, []);

  const tasks = useMemo(() => getTasksForDate(selectedDate), [selectedDate, tasksVersion]);
  const doneTasks = tasks.filter((t) => t.done && !t.deletedAt);
  const focusProgress = tasks.length > 0 ? Math.round((doneTasks.length / tasks.length) * 100) : 0;

  // Derived headline signals (no extra LLM)
  const nutrition = dashboard?.nutrition as (DailyNutrition & { updatedAt?: number }) | null;
  const finance = financeHub?.snapshot ?? dashboard?.finance ?? null;
  const focusScore = (dashboard?.focus || null) as
    | (DailyFocusScore & { updatedAt?: number })
    | null;
  const dailyPlan = (dashboard?.plan || null) as (DailyPlan & { updatedAt?: number }) | null;

  const proteinCurrent = nutrition?.totals?.protein ?? 0;
  const proteinTarget = dailyPlan?.nutritionTargets?.protein ?? 150;
  const proteinPct = Math.min(100, Math.round((proteinCurrent / Math.max(1, proteinTarget)) * 100));
  const caloriesCurrent = nutrition?.totals?.calories ?? 0;
  const carbsCurrent = nutrition?.totals?.carbs ?? 0;
  const fatCurrent = nutrition?.totals?.fat ?? 0;
  const caloriesTarget = dailyPlan?.nutritionTargets?.calories ?? 2000;
  const waterOz = mlToFlOz(nutrition?.waterMl ?? 0) ?? 0;
  const waterTargetOz = 85;
  const waterPct = Math.min(100, Math.round((waterOz / Math.max(1, waterTargetOz)) * 100));
  // The slider shows the draft while dragging, otherwise the persisted total.
  const displayWaterOz = waterDraft ?? waterOz;
  // Headroom above target (and current) so you can overshoot, rounded to 4 oz.
  const waterSliderMax = Math.max(
    Math.ceil((waterTargetOz * 1.5) / 4) * 4,
    Math.ceil(displayWaterOz / 4) * 4,
    8,
  );
  const focusMinutes = focusScore?.focusMinutes ?? 0;
  const selectedDayStart = new Date(selectedDate + "T00:00:00").getTime();
  const selectedDayEnd = new Date(selectedDate + "T23:59:59.999").getTime();
  const recentWorkout = [...workoutSessions]
    .filter((s) => s.performedAt <= selectedDayEnd)
    .sort((a, b) => b.performedAt - a.performedAt)[0];
  const weekWorkoutCount = workoutSessions.filter(
    (s) => s.performedAt >= selectedDayStart - 6 * 86400000 && s.performedAt <= selectedDayEnd,
  ).length;
  const activeTasks = tasks.filter((task) => !task.deletedAt && !task.done);
  const orderedTopTask = dailyPlan?.topTaskIds
    .map((id) => activeTasks.find((task) => task.id === id))
    .find(Boolean);
  const topTask =
    orderedTopTask ??
    [...activeTasks].sort(
      (a, b) => (a.priority ?? 4) - (b.priority ?? 4) || a.createdAt - b.createdAt,
    )[0];
  const todaysPlannedWorkout = dailyPlan?.aiCoaching?.workout;
  const workoutCompletedToday = workoutSessions.some(
    (session) => session.performedAt >= selectedDayStart && session.performedAt <= selectedDayEnd,
  );
  const nextBestAction = selectNextBestAction({
    incompleteTopTask: topTask ? { title: topTask.text, overdue: false } : undefined,
    plannedWorkoutIncomplete: !!todaysPlannedWorkout && !workoutCompletedToday,
    plannedWorkoutTitle: todaysPlannedWorkout?.title,
    hourLocal: isToday ? new Date().getHours() : 0,
    proteinPct,
    waterPct,
    financeStatus: financeHub?.safeToSpend?.status,
    safeToSpendThisMonth: financeHub?.safeToSpend?.safeToSpendThisMonth,
  });
  const nextBestActionText = `${nextBestAction.title}\n${nextBestAction.reason}`;
  const selectedMonth = selectedDate.slice(0, 7);
  const monthTransactions = transactions.filter(
    (t) => new Date(t.timestamp).toISOString().slice(0, 7) === selectedMonth,
  );
  const dayTransactions = transactions.filter(
    (t) => t.timestamp >= selectedDayStart && t.timestamp <= selectedDayEnd,
  );
  const takeHome = financeHub?.budget?.monthlyTakeHome ?? 0;
  const usePlannedIncome = takeHome > 0;
  // Shared definition so Today / Finance / Analytics agree (transfers excluded).
  const {
    income: financeIncome,
    spend: financeSpend,
    cashFlow: financeCashFlow,
  } = summarizeCashFlow(monthTransactions, takeHome);

  // Date nav
  function changeDate(deltaOrDate: number | ISODate) {
    let next: ISODate;
    if (typeof deltaOrDate === "number") {
      const d = new Date(selectedDate + "T00:00:00");
      d.setDate(d.getDate() + deltaOrDate);
      next = toISODate(d);
    } else {
      next = deltaOrDate;
    }
    navigate({ search: { date: next } });
  }

  function goToday() {
    navigate({ search: {} });
  }

  // When the day's dashboard arrives or changes, hydrate the tasks collection
  // and seed the coaching panel from the persisted plan. The dashboard is the
  // source of truth for aiCoaching, so mirroring it here keeps them in sync.
  useEffect(() => {
    if (!dashboard) return;
    hydrateProductivityTasks(dashboard.productivity?.tasks || []);
    setCoaching(
      dashboard.plan?.aiCoaching
        ? {
            date: selectedDate,
            headline: dashboard.plan.aiCoaching.headline,
            suggestions: dashboard.plan.aiCoaching.suggestions,
            workout: dashboard.plan.aiCoaching.workout,
            generatedBy: dashboard.plan.aiCoaching.generatedBy,
            updatedAt: dashboard.plan.aiCoaching.updatedAt,
          }
        : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard]);

  // Generate coaching for the current day (cached unless force-refreshing).
  async function refreshCoaching(force = true) {
    setCoachLoading(true);
    try {
      const result = await generateCoaching({
        data: { date: selectedDate, force },
      });
      setCoaching(result);
      // generateCoaching persists into the day's plan → refresh the dashboard.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.dashboard(selectedDate),
      });
    } catch (e) {
      console.warn("[dashboard] coaching failed", e);
    } finally {
      setCoachLoading(false);
    }
  }

  // Auto-generate coaching only when this date has no persisted coach snapshot.
  useEffect(() => {
    if (isToday && dashboard && !dashboard.plan?.aiCoaching && !coaching && !coachLoading) {
      refreshCoaching(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard]);

  // Persist current day's productivity tasks (RMW via aggregate)
  async function persistTasks(date: ISODate) {
    setSyncing(true);
    try {
      const current = getTasksForDate(date);
      await saveProductivityTasksForDay({ data: { date, tasks: current } });
    } catch (e) {
      console.error("[dashboard] Failed to persist productivity tasks", e);
    } finally {
      setSyncing(false);
    }
  }

  async function handleQuickAdd(e?: React.SyntheticEvent) {
    if (e) e.preventDefault();
    if (!isToday || !taskInput.trim()) return;
    const newTask = createProductivityTask({
      text: taskInput.trim(),
      date: selectedDate,
      source: "daily",
    });
    upsertProductivityTaskClient(newTask);
    setTaskInput("");
    await persistTasks(selectedDate);
  }

  async function recordNextBestActionOutcome(status: "completed" | "dismissed") {
    if (!isToday || hiddenNextBestActionDate === selectedDate) return;
    setSyncing(true);
    try {
      await recordRecommendationOutcome({
        data: {
          id: stableRecommendationId(selectedDate, "next-best-action", nextBestActionText),
          date: selectedDate,
          source: "next-best-action",
          text: nextBestActionText,
          status,
        },
      });
      setHiddenNextBestActionDate(selectedDate);
    } catch (e) {
      console.error("[dashboard] next-best-action outcome failed", e);
    } finally {
      setSyncing(false);
    }
  }

  // Log the suggested workout as a completed session.
  async function logSuggestedWorkout() {
    if (!coaching || !isToday) return;
    setSyncing(true);
    try {
      await appendWorkoutSession({
        data: {
          performedAt: Date.now(),
          notes: coaching.workout.title,
          durationMinutes: coaching.workout.estimatedMinutes,
          effortRating: 3,
          exercises: coaching.workout.exercises.map((e) => ({
            name: e.name,
            sets: e.sets,
            reps: e.reps,
          })),
        },
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.workoutSessions(),
      });
      setVoiceStatus(`Logged: ${coaching.workout.title}`);
      speakAssistant(`Nice work. Logged ${coaching.workout.title}.`);
      setTimeout(() => setVoiceStatus(""), 2200);
    } catch (e) {
      console.error("[dashboard] log workout failed", e);
    } finally {
      setSyncing(false);
    }
  }

  // Add / update a finance account balance.
  async function handleAddAccount(e?: React.SyntheticEvent) {
    if (e) e.preventDefault();
    if (!isToday) return;
    const name = acctName.trim();
    const amount = parseFloat(acctAmount);
    if (!name || isNaN(amount)) return;
    setSyncing(true);
    try {
      const existing = finance?.accounts || [];
      const idx = existing.findIndex((a) => a.account.toLowerCase() === name.toLowerCase());
      const nextAccounts =
        idx >= 0
          ? existing.map((a, i) => (i === idx ? { ...a, amount } : a))
          : [...existing, { account: name, amount, currency: "USD" }];
      const saved = await saveDailyFinance({
        data: {
          date: selectedDate,
          finance: {
            date: selectedDate,
            accounts: nextAccounts,
            positions: finance?.positions || [],
          },
        },
      });
      setDashboardData((d) => ({ ...d, finance: saved }));
      setHubData((h) => ({ ...h, snapshot: saved }));
      setAcctName("");
      setAcctAmount("");
      refreshCoaching();
    } catch (e) {
      console.error("[dashboard] save finance failed", e);
    } finally {
      setSyncing(false);
    }
  }

  async function handleAcceptCoachPlan() {
    if (!coaching || !isToday || dailyPlan?.acceptedAt) return;
    setSyncing(true);
    try {
      const result = await acceptDailyCoachingPlan({
        data: {
          date: selectedDate,
          suggestions: coaching.suggestions,
          workout: coaching.workout,
        },
      });
      hydrateProductivityTasks(result.tasksAdded.concat(getTasksForDate(selectedDate)));
      await reload();
      setVoiceStatus(`Plan accepted: ${result.tasksAdded.length} actions added`);
      setTimeout(() => setVoiceStatus(""), 2200);
    } catch (e) {
      console.error("[dashboard] accept plan failed", e);
    } finally {
      setSyncing(false);
    }
  }

  async function handleAddTransaction(e?: React.SyntheticEvent) {
    if (e) e.preventDefault();
    if (!isToday) return;
    const amount = parseFloat(txnAmount);
    if (!amount || isNaN(amount)) return;
    setSyncing(true);
    try {
      const transaction = await appendTransaction({
        data: {
          timestamp: Date.now(),
          type: amount >= 0 ? "deposit" : "withdrawal",
          amount,
          currency: "USD",
          category: txnCategory.trim() || undefined,
          notes: txnNote.trim() || undefined,
        },
      });
      setHubData((h) => ({
        ...h,
        transactions: [...h.transactions, transaction],
      }));
      setTxnAmount("");
      setTxnCategory("");
      setTxnNote("");
      refreshCoaching();
    } catch (e) {
      console.error("[dashboard] transaction save failed", e);
    } finally {
      setSyncing(false);
    }
  }

  // Add a food/meal: the AI estimates calories + macros from the description,
  // then we log it to today's nutrition.
  async function handleAddFood(e?: React.SyntheticEvent) {
    if (e) e.preventDefault();
    if (!isToday) return;
    const description = foodName.trim();
    if (!description || foodEstimating) return;
    setFoodEstimating(true);
    setFoodStatus("Looking up nutrition…");
    try {
      const est = await estimateFoodMacros({ data: { description } });
      const now = Date.now();
      const foodItem = {
        id: newId("food"),
        name: est.name,
        quantity: est.quantity,
        unit: est.unit,
        macros: {
          calories: est.calories,
          protein: est.protein,
          carbs: est.carbs,
          fat: est.fat,
        },
        source: "custom" as const,
      };
      const mealLog = {
        id: newId("meal"),
        timestamp: now,
        foodItems: [foodItem],
        estimateConfidence: est.confidence,
        createdAt: now,
        updatedAt: now,
      };
      const saved = await saveDailyNutrition({
        data: {
          date: selectedDate,
          nutrition: {
            mealLogs: [...(nutrition?.mealLogs || []), mealLog],
            totals: nutrition?.totals || {
              calories: 0,
              protein: 0,
              carbs: 0,
              fat: 0,
            },
            waterMl: nutrition?.waterMl,
          },
        },
      });
      setDashboardData((d) => ({ ...d, nutrition: saved }));
      setFoodName("");
      setFoodStatus(
        `Logged ${est.name} — ${est.calories} cal, ${est.protein}g protein` +
          (est.generatedBy === "fallback" ? " (rough estimate)" : ""),
      );
      setTimeout(() => setFoodStatus(null), 4000);
      refreshCoaching();
    } catch (e) {
      console.error("[dashboard] add food failed", e);
      setFoodStatus(
        "Couldn’t estimate that food right now — add calories/macros or check the AI key.",
      );
      setTimeout(() => setFoodStatus(null), 3000);
    } finally {
      setFoodEstimating(false);
    }
  }

  // Set the day's water to an absolute oz total (clamped at 0).
  async function setWaterOz(totalOz: number) {
    if (!isToday || foodEstimating) return;
    const oz = Math.max(0, Math.round(totalOz));
    try {
      const saved = await saveDailyNutrition({
        data: {
          date: selectedDate,
          nutrition: {
            mealLogs: nutrition?.mealLogs || [],
            totals: nutrition?.totals || {
              calories: 0,
              protein: 0,
              carbs: 0,
              fat: 0,
            },
            waterMl: flOzToMl(oz) ?? 0,
          },
        },
      });
      setDashboardData((d) => ({ ...d, nutrition: saved }));
      setFoodStatus(`Water set to ${mlToFlOz(saved.waterMl) ?? 0} fl oz`);
      setTimeout(() => setFoodStatus(null), 3000);
      refreshCoaching();
    } catch (e) {
      console.error("[dashboard] set water failed", e);
      setFoodStatus("Couldn’t update water — try again.");
      setTimeout(() => setFoodStatus(null), 3000);
    }
  }

  // Commit the dragged slider value, then clear the draft so the bar tracks
  // the persisted total again.
  function commitWaterDraft() {
    if (waterDraft == null) return;
    void setWaterOz(waterDraft).finally(() => setWaterDraft(null));
  }

  async function handleDeleteMeal(id: string) {
    if (!isToday || foodEstimating) return;
    try {
      const saved = await saveDailyNutrition({
        data: {
          date: selectedDate,
          nutrition: {
            mealLogs: (nutrition?.mealLogs || []).filter((meal) => meal.id !== id),
            totals: nutrition?.totals || {
              calories: 0,
              protein: 0,
              carbs: 0,
              fat: 0,
            },
            waterMl: nutrition?.waterMl,
          },
        },
      });
      setDashboardData((d) => ({ ...d, nutrition: saved }));
      setFoodStatus("Removed food entry.");
      setTimeout(() => setFoodStatus(null), 3000);
      refreshCoaching();
    } catch (e) {
      console.error("[dashboard] delete meal failed", e);
      setFoodStatus("Couldn’t remove that food — try again.");
      setTimeout(() => setFoodStatus(null), 3000);
    }
  }

  // Voice transcript handler (ADR-004)
  async function handleVoiceTranscript(text: string) {
    setIsVoiceProcessing(true);
    setVoiceStatus("Processing…");
    try {
      const result = await processVoiceInput({
        data: { transcriptText: text },
      });
      setVoiceStatus(result.spokenText || "Done");
      await reload();
      if (result.success) {
        speakAssistant(result.spokenText || "Done");
      } else if (result.intent?.requiresConfirmation) {
        setPendingConfirm({
          transcript: text,
          intentText: result.intent.action,
        });
        speakAssistant(result.spokenText);
      } else {
        speakAssistant(result.spokenText);
      }
    } catch (e: any) {
      const msg = "Voice error. " + (e?.message || "");
      setVoiceStatus(msg);
      speakAssistant("Sorry, something went wrong.");
    } finally {
      setIsVoiceProcessing(false);
      setTimeout(() => setVoiceStatus(""), 2200);
    }
  }

  async function confirmVoiceAction(confirmed: boolean) {
    if (!pendingConfirm) return;
    const { transcript } = pendingConfirm;
    setPendingConfirm(null);
    if (!confirmed) {
      setVoiceStatus("Cancelled");
      setTimeout(() => setVoiceStatus(""), 1200);
      return;
    }
    setIsVoiceProcessing(true);
    setVoiceStatus("Executing…");
    try {
      const result = await processVoiceInput({
        data: { transcriptText: transcript, forceExecute: true },
      });
      setVoiceStatus(result.spokenText || "");
      await reload();
      if (result.success) speakAssistant(result.spokenText);
    } catch {
      setVoiceStatus("Confirm failed");
    } finally {
      setIsVoiceProcessing(false);
      setTimeout(() => setVoiceStatus(""), 2000);
    }
  }

  // === Persistent Mic FAB + Listening overlay (ADR-005) ===
  const isListening = isListeningOverlay;

  function stopOverlayListening() {
    const rec = (window as any).__dashRec;
    if (rec) {
      try {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        rec.stop();
      } catch {}
      (window as any).__dashRec = null;
    }
    setInterim("");
    setIsListeningOverlay(false);
  }

  function startMainListening() {
    if (!isToday) return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setListenError("Voice not supported. Use Chrome/Edge.");
      return;
    }
    setListenError(null);
    setInterim("");
    setIsListeningOverlay(true);

    const rec = new SR();
    (window as any).__dashRec = rec;
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (event: any) => {
      let finalText = "";
      let curInterim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else curInterim += res[0].transcript;
      }
      if (curInterim) setInterim(curInterim.trim());
      if (finalText) {
        const cleaned = finalText.trim();
        stopOverlayListening();
        handleVoiceTranscript(cleaned);
      }
    };
    rec.onerror = () => {
      stopOverlayListening();
      setListenError("No speech or recognition error.");
      setTimeout(() => setListenError(null), 1800);
    };
    rec.onend = () => {
      if (isListeningOverlay) setIsListeningOverlay(false);
      (window as any).__dashRec = null;
    };

    try {
      rec.start();
    } catch {
      stopOverlayListening();
      setListenError("Could not start mic.");
    }
  }

  function handleFabClick() {
    if (isListening) {
      stopOverlayListening();
      return;
    }
    startMainListening();
  }

  // Progress ring component (focus + protein)
  function ProgressRing({ value, label, sub }: { value: number; label: string; sub?: string }) {
    const pct = Math.max(0, Math.min(100, value));
    const r = 28;
    const c = 2 * Math.PI * r;
    const off = c * (1 - pct / 100);
    // These rings track "higher is better" goals (tasks done, protein), so the
    // color rewards progress: green on track, amber partway, muted when barely started.
    const tone =
      pct >= 80 ? "text-emerald-500" : pct >= 40 ? "text-amber-500" : "text-muted-foreground";
    return (
      <div className="flex flex-col items-center">
        <svg width="68" height="68" className="-rotate-90">
          <circle
            cx="34"
            cy="34"
            r={r}
            stroke="currentColor"
            strokeOpacity={0.12}
            strokeWidth="6"
            fill="none"
          />
          <circle
            cx="34"
            cy="34"
            r={r}
            stroke="currentColor"
            strokeWidth="6"
            fill="none"
            strokeDasharray={c}
            strokeDashoffset={off}
            className={`${tone} transition-all`}
          />
        </svg>
        <div className="mt-1 text-center">
          <div className={`text-sm font-medium tabular-nums ${tone}`}>{pct}%</div>
          <div className="text-[10px] text-muted-foreground -mt-0.5">{label}</div>
          {sub && <div className="text-[9px] text-muted-foreground/70 tabular-nums">{sub}</div>}
        </div>
      </div>
    );
  }

  useEffect(() => {
    const checkIn = dailyPlan?.eveningCheckIn;
    if (!checkIn) return;
    setCheckInEnergy(checkIn.energy);
    setCheckInRating(checkIn.dayRating);
    setCheckInWin(checkIn.win ?? "");
    setCheckInFriction(checkIn.friction ?? "");
  }, [dailyPlan?.eveningCheckIn]);

  async function submitEveningCheckIn() {
    if (!isToday || checkInSaving) return;
    if (
      ![checkInEnergy, checkInRating].every(
        (value) => Number.isInteger(value) && value >= 1 && value <= 5,
      )
    )
      return;
    setCheckInSaving(true);
    try {
      await saveEveningCheckIn({
        data: {
          date: selectedDate,
          checkIn: {
            energy: checkInEnergy as 1 | 2 | 3 | 4 | 5,
            dayRating: checkInRating as 1 | 2 | 3 | 4 | 5,
            win: checkInWin.trim() || undefined,
            friction: checkInFriction.trim() || undefined,
            completedAt: Date.now(),
          },
        },
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedDate) });
    } finally {
      setCheckInSaving(false);
    }
  }

  const headline =
    coaching?.headline ||
    (isToday
      ? "Speak or tap to log progress — your coach is standing by."
      : "No activity recorded for this day.");

  return (
    <div className="bg-background px-4 pb-28 pt-8 sm:px-6 sm:pb-16">
      <div className="mx-auto w-full max-w-page">
        {/* Top nav + date */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs tracking-tight text-muted-foreground">Daily Dashboard</div>
            <div className="text-balance text-3xl font-semibold tracking-tighter">
              How am I doing?
            </div>
          </div>

          <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
            <div className="flex items-center gap-2 text-sm">
              {/* Today indicator — highlights when on the current day, jumps back otherwise */}
              <Button
                variant={isToday ? "default" : "outline"}
                size="sm"
                onClick={goToday}
                disabled={isToday}
                className="h-8 shrink-0 gap-1.5 disabled:opacity-100"
                aria-label={isToday ? "Showing today" : "Go to today"}
              >
                <span
                  className={`size-1.5 rounded-full bg-current transition-opacity ${isToday ? "opacity-100" : "opacity-0"}`}
                />
                Today
              </Button>

              <div className="flex flex-1 items-center gap-1.5 sm:flex-none">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8 shrink-0"
                  onClick={() => changeDate(-1)}
                  aria-label="Previous day"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                {/* Date label doubles as the picker trigger */}
                <div className="relative flex-1 sm:flex-none">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => dateInputRef.current?.showPicker?.()}
                    className="h-8 w-full justify-center gap-1.5 tabular-nums font-medium sm:w-auto sm:min-w-33"
                    aria-label="Pick a date"
                  >
                    <CalendarDays className="size-3.5 text-muted-foreground" />
                    {dateLabel}
                  </Button>
                  <input
                    ref={dateInputRef}
                    type="date"
                    value={selectedDate}
                    onChange={(e) => {
                      const v = e.target.value as ISODate;
                      if (v) changeDate(v);
                    }}
                    className="pointer-events-none absolute inset-0 size-full opacity-0"
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8 shrink-0"
                  onClick={() => changeDate(1)}
                  aria-label="Next day"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>

            {/* Read-only indicator sits under the nav; reserved height avoids layout shift */}
            <div className="flex h-5 items-center justify-end">
              {!isToday && (
                <Badge
                  variant="secondary"
                  className="gap-1 rounded-full text-[10px] text-muted-foreground"
                >
                  <Lock className="size-2.5" /> Read-only
                </Badge>
              )}
            </div>
          </div>
        </div>

        {isToday && hiddenNextBestActionDate !== selectedDate && (
          <Reveal>
            <Card className="mb-6 border-l-4 border-l-primary" aria-live="polite">
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Next best action · {nextBestAction.domain}
                  </div>
                  <div className="mt-1 font-semibold">{nextBestAction.title}</div>
                  <p className="mt-1 text-sm text-muted-foreground">{nextBestAction.reason}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => recordNextBestActionOutcome("dismissed")}
                    disabled={syncing}
                  >
                    Skip
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => recordNextBestActionOutcome("completed")}
                    disabled={syncing}
                  >
                    Done
                  </Button>
                  <Button asChild>
                    <Link to={nextBestAction.href}>Take action</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </Reveal>
        )}

        {/* Primary Headline: rings + synthesis */}
        <Reveal>
          <div className="aurora-hero relative mb-6 overflow-hidden rounded-2xl border border-border p-5 shadow-sm">
            <div className="relative flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
              <div className="flex items-center gap-6">
                <ProgressRing
                  value={focusProgress}
                  label="Focus"
                  sub={`${doneTasks.length}/${tasks.length} tasks`}
                />
                <ProgressRing
                  value={proteinPct}
                  label="Protein"
                  sub={`${proteinCurrent}g / ${proteinTarget}g`}
                />
              </div>

              <div className="max-w-105 text-center sm:text-left">
                <div className="text-[13px] font-medium text-muted-foreground">
                  Today at a glance
                </div>
                <div className="mt-1 text-xl leading-tight">
                  {focusMinutes > 0 ? `${focusMinutes} min focus • ` : ""}
                  {proteinCurrent > 0 ? `${proteinPct}% protein` : "Log nutrition or tasks"}
                </div>
                <Reveal key={headline} className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                  {headline}
                </Reveal>
              </div>

              {isToday && (
                <button
                  onClick={handleFabClick}
                  disabled={isVoiceProcessing}
                  className={`flex size-16 shrink-0 items-center justify-center rounded-full border shadow-sm transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96] ${isListening ? "border-red-500 bg-red-500 text-white shadow" : "border-border hover:border-primary hover:text-primary"}`}
                  aria-label={isListening ? "Stop listening" : "Start voice input"}
                >
                  {isListening ? (
                    <Square className="size-6 fill-current" />
                  ) : (
                    <Mic className="size-6" />
                  )}
                </button>
              )}
            </div>

            {(voiceStatus || isVoiceProcessing) && (
              <div className="relative mt-3 text-center text-[10px] text-muted-foreground/70">
                {voiceStatus}
              </div>
            )}
          </div>
        </Reveal>

        {/* Listening overlay */}
        <Dialog
          open={isListeningOverlay}
          onOpenChange={(open) => {
            if (!open) stopOverlayListening();
          }}
        >
          <DialogContent className="w-fit text-center sm:max-w-fit">
            <DialogTitle className="flex items-center justify-center gap-2 text-sm font-medium tracking-wide text-muted-foreground">
              <Mic className="size-4 text-primary" /> Listening…
            </DialogTitle>
            <div className="mt-1 flex h-10 items-end justify-center gap-1.5">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="w-1.5 animate-pulse rounded bg-primary"
                  style={{
                    height: 12 + (i % 3) * 7,
                    animationDelay: `${i * 110}ms`,
                  }}
                />
              ))}
            </div>
            {interim && <div className="mt-3 text-sm text-muted-foreground">“{interim}”</div>}
            <Button variant="link" size="sm" onClick={stopOverlayListening} className="mx-auto">
              Cancel
            </Button>
            {listenError && <div className="mt-2 text-xs text-destructive">{listenError}</div>}
          </DialogContent>
        </Dialog>

        {/* Confirmation banner */}
        {pendingConfirm && (
          <div className="mb-4 rounded border border-border bg-accent/40 px-3 py-2 text-sm flex flex-wrap items-center justify-between gap-3">
            <div>
              Confirm: <span className="font-medium">{pendingConfirm.intentText}</span>
              <span className="text-muted-foreground"> — say “yes” or use buttons</span>
            </div>
            <div className="flex items-center gap-2">
              <VoiceInput
                confirmMode
                confirmPrompt={`Say yes to ${pendingConfirm.intentText || "this action"} or no.`}
                onConfirm={confirmVoiceAction}
              />
              <Button variant="ghost" size="sm" onClick={() => confirmVoiceAction(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => confirmVoiceAction(true)}>
                Yes
              </Button>
            </div>
          </div>
        )}

        {/* AI COACH SUGGESTIONS */}
        <Reveal delay={revealDelay(1)}>
          <Card className="mb-6 overflow-hidden border-border bg-card shadow-sm">
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Sparkles className="size-4 text-indigo-500" /> Coach Suggestions
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => refreshCoaching(true)}
                  disabled={coachLoading || !isToday}
                  className="h-7 gap-1.5 text-xs font-normal"
                >
                  <RefreshCw className={`size-3.5 ${coachLoading ? "animate-spin" : ""}`} />
                  {coachLoading ? "Thinking…" : "Refresh"}
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {coaching?.suggestions?.length ? (
                <ul className="space-y-2">
                  {coaching.suggestions.map((s, i) => {
                    const Icon = DOMAIN_ICON[s.domain] || Brain;
                    return (
                      <Reveal
                        as="li"
                        key={i}
                        delay={revealDelay(i)}
                        className="flex gap-2.5 text-sm"
                      >
                        <Icon
                          className={`mt-0.5 size-4 shrink-0 ${DOMAIN_COLOR[s.domain] || "text-indigo-500"}`}
                        />
                        <div className="min-w-0">
                          <span>{s.text}</span>
                          {s.action && isToday && (
                            <span className="ml-1 text-xs text-muted-foreground">
                              — try “{s.action.trim()}”
                            </span>
                          )}
                        </div>
                      </Reveal>
                    );
                  })}
                </ul>
              ) : coachLoading ? (
                <div className="text-sm text-muted-foreground">Your coach is reviewing today…</div>
              ) : dailyPlan?.aiSuggestions?.length ? (
                <ul className="space-y-1.5 text-sm">
                  {dailyPlan.aiSuggestions.slice(0, 6).map((s, i) => (
                    <li key={i} className="flex gap-2">
                      <Brain className="mt-0.5 size-4 shrink-0 text-primary/80" />
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-sm text-muted-foreground">
                  No suggestions yet — tap Refresh.
                </div>
              )}
              {coaching && (
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="text-[10px] text-muted-foreground/60">
                    {coaching.generatedBy === "ai" ? "Generated by Grok" : "Coach (offline rules)"}{" "}
                    • updated{" "}
                    {new Date(coaching.updatedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                  {isToday && (
                    <Button
                      size="sm"
                      variant={dailyPlan?.acceptedAt ? "outline" : "default"}
                      className="h-7 gap-1.5 text-xs"
                      onClick={handleAcceptCoachPlan}
                      disabled={syncing || !!dailyPlan?.acceptedAt}
                    >
                      <Check className="size-3.5" />
                      {dailyPlan?.acceptedAt ? "Plan accepted" : "Accept plan"}
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </Reveal>

        {/* WORKOUT SUGGESTION */}
        <Reveal delay={revealDelay(2)}>
          <Card className="mb-6 overflow-hidden border-border bg-card shadow-sm">
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Dumbbell className="size-4 text-emerald-500" /> Today’s Workout
                </span>
                <Link to="/workouts" className="text-sm font-normal text-primary hover:underline">
                  Open workouts →
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded bg-muted px-2 py-1 tabular-nums">
                  {weekWorkoutCount} workout{weekWorkoutCount === 1 ? "" : "s"} in 7 days
                </span>
                {recentWorkout && (
                  <span className="rounded bg-muted px-2 py-1">
                    Last: {recentWorkout.notes || "session"}{" "}
                    {recentWorkout.durationMinutes ? `• ${recentWorkout.durationMinutes} min` : ""}
                    {recentWorkout.effortRating ? ` • effort ${recentWorkout.effortRating}/5` : ""}
                  </span>
                )}
              </div>
              {coaching?.workout ? (
                <Reveal key={coaching.workout.title}>
                  <WorkoutCarousel
                    title={coaching.workout.title}
                    focus={coaching.workout.focus}
                    estimatedMinutes={coaching.workout.estimatedMinutes}
                    exercises={coaching.workout.exercises}
                  />
                  {isToday && (
                    <Button
                      size="sm"
                      className="mt-1 gap-1.5"
                      onClick={logSuggestedWorkout}
                      disabled={syncing}
                    >
                      <Check className="size-4" /> Mark complete
                    </Button>
                  )}
                </Reveal>
              ) : (
                <div className="text-sm text-muted-foreground">
                  {coachLoading
                    ? "Building your session…"
                    : "Tap Refresh on suggestions to generate a session."}
                </div>
              )}
            </CardContent>
          </Card>
        </Reveal>

        {/* FOCUS & TASKS */}
        <Reveal delay={revealDelay(3)}>
          <Card className="mb-6 overflow-hidden border-border bg-card shadow-sm">
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <ListTodo className="size-4 text-primary" /> Focus &amp; Tasks
                </span>
                <Link to="/kanban" className="text-sm font-normal text-primary hover:underline">
                  Open full Kanban →
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isToday ? (
                <form onSubmit={handleQuickAdd} className="flex items-center gap-2">
                  <Input
                    value={taskInput}
                    onChange={(e) => setTaskInput(e.target.value)}
                    placeholder="Quick add task for today…"
                    className="flex-1"
                  />
                  <Button type="submit" size="sm" disabled={!taskInput.trim()} className="gap-1">
                    <Plus className="size-4" /> Add
                  </Button>
                  <VoiceInput onTranscript={handleVoiceTranscript} />
                </form>
              ) : (
                <div className="text-sm text-muted-foreground">
                  Tasks for past days are view-only here. Use the full Kanban to edit.
                </div>
              )}
              {tasks.length > 0 ? (
                <ul className="mt-3 space-y-1 text-sm">
                  {tasks.slice(0, 6).map((t, i) => (
                    <Reveal
                      as="li"
                      key={t.id}
                      delay={revealDelay(i)}
                      className="flex items-center gap-2"
                    >
                      <span
                        className={`flex size-4 items-center justify-center rounded-full border ${t.done ? "bg-primary text-primary-foreground border-primary" : "border-muted-foreground/40"}`}
                      >
                        {t.done && <Check className="size-3" />}
                      </span>
                      <span className={t.done ? "text-muted-foreground line-through" : ""}>
                        {t.text}
                      </span>
                      {t.shared && (
                        <Badge
                          variant="secondary"
                          className="gap-0.5 bg-primary/10 px-1 text-[10px] text-primary"
                        >
                          <Users className="size-2.5" /> Shared
                        </Badge>
                      )}
                    </Reveal>
                  ))}
                </ul>
              ) : isToday ? (
                <div className="mt-3 text-sm text-muted-foreground">
                  No tasks yet today — add one above or ask the coach for a plan.
                </div>
              ) : (
                <div className="mt-3 text-sm text-muted-foreground">
                  No tasks were logged for this day.
                </div>
              )}
              <div className="mt-2 text-[10px] text-muted-foreground">
                Voice/AI supported — try “add workout 30 min” or “remind me to call mom”.
              </div>
            </CardContent>
          </Card>
        </Reveal>

        {/* NUTRITION */}
        <Reveal delay={revealDelay(4)}>
          <Card className="mb-6 overflow-hidden border-border bg-card shadow-sm">
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Utensils className="size-4 text-amber-500" /> Nutrition
                </span>
                <Link
                  to="/nutrition"
                  search={{ date: isToday ? undefined : selectedDate }}
                  className="text-sm font-normal text-primary hover:underline"
                >
                  Open nutrition →
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {/* Calories — headline number for the day */}
              <div className="mb-2 flex items-center justify-between text-sm">
                <div>Calories</div>
                <div className="tabular-nums text-muted-foreground">
                  {caloriesCurrent} / {caloriesTarget} cal
                </div>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
                <div
                  className={`h-full transition-all ${fillTone(
                    Math.min(
                      100,
                      Math.round((caloriesCurrent / Math.max(1, caloriesTarget)) * 100),
                    ),
                    caloriesCurrent > caloriesTarget * 1.05,
                  )}`}
                  style={{
                    width: `${Math.min(100, Math.round((caloriesCurrent / Math.max(1, caloriesTarget)) * 100))}%`,
                  }}
                />
              </div>

              {/* Protein */}
              <div className="mb-2 mt-3 flex items-center justify-between text-sm">
                <div>Protein</div>
                <div className="tabular-nums text-muted-foreground">
                  {proteinCurrent}g / {proteinTarget}g
                </div>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
                <div
                  className={`h-full transition-all ${fillTone(proteinPct)}`}
                  style={{ width: `${proteinPct}%` }}
                />
              </div>

              {/* Carbs / Fat */}
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded bg-muted px-2 py-1">
                  <div className="text-muted-foreground">Carbs</div>
                  <div className="font-medium tabular-nums">{carbsCurrent}g</div>
                </div>
                <div className="rounded bg-muted px-2 py-1">
                  <div className="text-muted-foreground">Fat</div>
                  <div className="font-medium tabular-nums">{fatCurrent}g</div>
                </div>
              </div>

              {/* Water — draggable slider (same control as the nutrition page) */}
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Droplet className="size-3.5" /> Water
                  </span>
                  <span className="tabular-nums">
                    {displayWaterOz} / {waterTargetOz} fl oz
                  </span>
                </div>
                {isToday ? (
                  <div className="flex items-center gap-3">
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="size-9 shrink-0"
                      disabled={foodEstimating || displayWaterOz <= 0}
                      onClick={() => setWaterOz(waterOz - 4)}
                      aria-label="Remove 4 fl oz"
                    >
                      <Minus className="size-4" />
                    </Button>
                    <WaterSlider
                      value={displayWaterOz}
                      target={waterTargetOz}
                      max={waterSliderMax}
                      disabled={foodEstimating}
                      onDraft={setWaterDraft}
                      onCommit={commitWaterDraft}
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="size-9 shrink-0"
                      disabled={foodEstimating}
                      onClick={() => setWaterOz(waterOz + 4)}
                      aria-label="Add 4 fl oz"
                    >
                      <Plus className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
                    <div
                      className={`h-full transition-all ${fillTone(waterPct)}`}
                      style={{ width: `${waterPct}%` }}
                    />
                  </div>
                )}
              </div>

              {(nutrition?.mealLogs?.length ?? 0) > 0 && (
                <div className="mt-3">
                  <div className="mb-1 text-[10px] text-muted-foreground">Recent logs</div>
                  <ul className="space-y-1 text-sm">
                    {nutrition!.mealLogs
                      .filter((m) => !m.deletedAt)
                      .slice(-5)
                      .reverse()
                      .map((m, idx) => {
                        const items = m.foodItems || [];
                        const name =
                          items.length > 1
                            ? `${items[0]?.name || "meal"} +${items.length - 1}`
                            : items[0]?.name || "meal";
                        const cals = items.reduce((s, i) => s + (i.macros?.calories ?? 0), 0);
                        const prot = items.reduce((s, i) => s + (i.macros?.protein ?? 0), 0);
                        return (
                          <Reveal
                            as="li"
                            key={m.id}
                            delay={revealDelay(idx)}
                            className="flex items-end gap-2"
                          >
                            <span className="min-w-0 truncate">
                              <span className="text-muted-foreground">
                                {new Date(m.timestamp).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </span>{" "}
                              {name}
                            </span>
                            <span className="mb-1 min-w-4 flex-1 border-b border-dotted border-muted-foreground/35" />
                            <span className="ml-auto shrink-0 text-right tabular-nums text-muted-foreground">
                              {cals} cal · {prot}g
                            </span>
                            {isToday && (
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                                disabled={foodEstimating}
                                onClick={() => handleDeleteMeal(m.id)}
                                aria-label={`Remove ${name}`}
                                title="Remove food entry"
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            )}
                          </Reveal>
                        );
                      })}
                  </ul>
                </div>
              )}

              {isToday && (
                <div className="mt-3 space-y-2">
                  <form onSubmit={handleAddFood} className="flex items-center gap-2">
                    <Input
                      value={foodName}
                      onChange={(e) => setFoodName(e.target.value)}
                      placeholder="Add food (e.g. 6oz chicken breast)…"
                      className="flex-1"
                      disabled={foodEstimating}
                    />
                    <Button
                      type="submit"
                      size="sm"
                      className="gap-1"
                      disabled={!foodName.trim() || foodEstimating}
                    >
                      {foodEstimating ? (
                        <RefreshCw className="size-4 animate-spin" />
                      ) : (
                        <Sparkles className="size-4" />
                      )}
                      {foodEstimating ? "Estimating…" : "Add food"}
                    </Button>
                  </form>
                  {foodStatus ? (
                    <div className="text-[11px] text-muted-foreground">{foodStatus}</div>
                  ) : (
                    <div className="text-[10px] text-muted-foreground/70">
                      Type any food — the AI fills in calories &amp; protein. Or say “log 40g
                      protein chicken”.
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </Reveal>

        {/* FINANCE — first-class snapshot */}
        <Reveal delay={revealDelay(5)}>
          <Card className="mb-6 overflow-hidden border-border bg-card shadow-sm">
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                <Link
                  to="/finance"
                  className="flex items-center gap-2 transition-colors hover:text-primary"
                >
                  <Wallet className="size-4 text-green-600 dark:text-green-500" /> Finance Snapshot
                </Link>
                <span className="text-lg font-semibold tabular-nums">
                  ${(finance?.netWorth ?? 0).toLocaleString()}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-[10px] text-muted-foreground">Net worth</div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div className="rounded bg-muted px-2 py-1">
                  <div className="text-muted-foreground">Cash flow (mo)</div>
                  <div
                    className={`font-medium tabular-nums ${
                      financeCashFlow < 0
                        ? "text-destructive"
                        : "text-green-600 dark:text-green-500"
                    }`}
                  >
                    {financeCashFlow < 0 ? "-" : "+"}$
                    {Math.abs(Math.round(financeCashFlow)).toLocaleString()}
                  </div>
                </div>
                <div className="rounded bg-muted px-2 py-1">
                  <div className="text-muted-foreground">
                    {usePlannedIncome ? "Income (mo)" : "Income (MTD)"}
                  </div>
                  <div className="font-medium tabular-nums">${financeIncome.toLocaleString()}</div>
                </div>
                <div className="rounded bg-muted px-2 py-1">
                  <div className="text-muted-foreground">Spending (mo)</div>
                  <div className="font-medium tabular-nums">${financeSpend.toLocaleString()}</div>
                </div>
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                {monthTransactions.length
                  ? `${monthTransactions.length} transaction${monthTransactions.length === 1 ? "" : "s"} in ${selectedMonth}`
                  : `No transactions imported for ${selectedMonth}`}
              </div>

              {financeHub?.safeToSpend && (
                <div
                  className={`mt-3 rounded-md border px-2.5 py-2 text-xs ${
                    financeHub.safeToSpend.status === "on-track"
                      ? "border-emerald-500/25 bg-emerald-500/5"
                      : financeHub.safeToSpend.status === "over-plan"
                        ? "border-destructive/30 bg-destructive/5"
                        : financeHub.safeToSpend.status === "tight"
                          ? "border-amber-500/30 bg-amber-500/5"
                          : "border-border bg-muted/20"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">Monthly budget guardrail</span>
                    {financeHub.safeToSpend.status !== "unavailable" && (
                      <span className="tabular-nums">
                        ${financeHub.safeToSpend.safeToSpendThisMonth.toLocaleString()} this month ·
                        ${financeHub.safeToSpend.safeToSpendPerDay.toLocaleString()}
                        /day
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {financeHub.safeToSpend.explanation} Not available cash or net worth.
                  </p>
                </div>
              )}

              {finance?.accounts?.length ? (
                <ul className="mt-2 space-y-1 text-sm">
                  {finance.accounts.map((a, i) => (
                    <Reveal
                      as="li"
                      key={i}
                      delay={revealDelay(i)}
                      className="flex items-center justify-between border-b border-border/40 py-1 last:border-0"
                    >
                      <span>{a.account}</span>
                      <span className="tabular-nums text-muted-foreground">
                        ${a.amount.toLocaleString()}
                      </span>
                    </Reveal>
                  ))}
                </ul>
              ) : (
                <div className="mt-2 text-sm text-muted-foreground">
                  No accounts tracked yet. Add balances below to start your net-worth baseline.
                </div>
              )}

              {isToday && (
                <div className="mt-3 space-y-2">
                  <form onSubmit={handleAddAccount} className="flex items-center gap-2">
                    <Input
                      value={acctName}
                      onChange={(e) => setAcctName(e.target.value)}
                      placeholder="Account (e.g. Checking)"
                      className="flex-1"
                    />
                    <Input
                      type="number"
                      step="0.01"
                      value={acctAmount}
                      onChange={(e) => setAcctAmount(e.target.value)}
                      placeholder="Balance"
                      className="w-32"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      className="gap-1"
                      disabled={!acctName.trim() || !acctAmount}
                    >
                      <Plus className="size-4" /> Balance
                    </Button>
                  </form>
                  <form
                    onSubmit={handleAddTransaction}
                    className="grid grid-cols-1 gap-2 sm:grid-cols-[110px_1fr_1fr_auto]"
                  >
                    <Input
                      type="number"
                      step="0.01"
                      value={txnAmount}
                      onChange={(e) => setTxnAmount(e.target.value)}
                      placeholder="+/- amount"
                    />
                    <Input
                      value={txnCategory}
                      onChange={(e) => setTxnCategory(e.target.value)}
                      placeholder="Category"
                    />
                    <Input
                      value={txnNote}
                      onChange={(e) => setTxnNote(e.target.value)}
                      placeholder="Note"
                    />
                    <Button type="submit" size="sm" className="gap-1" disabled={!txnAmount}>
                      <Plus className="size-4" /> Cashflow
                    </Button>
                  </form>
                </div>
              )}
              {dayTransactions.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                  {dayTransactions
                    .slice(-3)
                    .reverse()
                    .map((t, i) => (
                      <Reveal
                        as="li"
                        key={t.id}
                        delay={revealDelay(i)}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="truncate">{t.category || t.notes || t.type}</span>
                        <span className="tabular-nums">${t.amount.toLocaleString()}</span>
                      </Reveal>
                    ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </Reveal>

        {/* RECENT ACTIVITY */}
        <Reveal delay={revealDelay(6)}>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base">Recent Activity</CardTitle>
            </CardHeader>
            <CardContent>
              {(() => {
                const rec = dashboard?.recent || {
                  interactions: [],
                  transcripts: [],
                };
                const combined = [
                  ...(rec.interactions || []).map((i) => ({
                    ts: i.timestamp,
                    label: "AI",
                    text: humanizeAiActivity(i.response, i.intent),
                  })),
                  ...(rec.transcripts || []).map((v) => ({
                    ts: v.timestamp,
                    label: "Voice",
                    text: v.transcriptText?.slice(0, 120) || "",
                  })),
                ]
                  .sort((a, b) => b.ts - a.ts)
                  .slice(0, 8);

                if (combined.length === 0)
                  return (
                    <div className="text-sm text-muted-foreground">
                      No voice or AI activity for this day.
                    </div>
                  );

                return (
                  <div className="space-y-2 text-sm">
                    {combined.map((c, idx) => (
                      <Reveal
                        as="div"
                        key={idx}
                        delay={revealDelay(idx)}
                        className="flex gap-2 text-muted-foreground"
                      >
                        <span className="mt-px inline-block w-10.5 shrink-0 font-mono text-[10px] text-muted-foreground/70">
                          {new Date(c.ts).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <span className="shrink-0 font-medium text-foreground/80">{c.label}:</span>
                        <span className="min-w-0 flex-1">{c.text}</span>
                      </Reveal>
                    ))}
                  </div>
                );
              })()}
            </CardContent>
          </Card>
        </Reveal>

        {isToday && (
          <Reveal delay={revealDelay(7)}>
            <Card className="mb-6 border-primary/25">
              <CardHeader>
                <CardTitle className="text-base">Evening check-in</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span>Energy (1–5)</span>
                    <Input
                      type="number"
                      min={1}
                      max={5}
                      value={checkInEnergy}
                      onChange={(e) => setCheckInEnergy(Number(e.target.value))}
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span>Day rating (1–5)</span>
                    <Input
                      type="number"
                      min={1}
                      max={5}
                      value={checkInRating}
                      onChange={(e) => setCheckInRating(Number(e.target.value))}
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span>Today’s win</span>
                    <Input
                      value={checkInWin}
                      onChange={(e) => setCheckInWin(e.target.value)}
                      placeholder="What went well?"
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span>Friction or blocker</span>
                    <Input
                      value={checkInFriction}
                      onChange={(e) => setCheckInFriction(e.target.value)}
                      placeholder="What got in the way?"
                    />
                  </label>
                </div>
                <Button onClick={submitEveningCheckIn} disabled={checkInSaving}>
                  {checkInSaving
                    ? "Saving…"
                    : dailyPlan?.eveningCheckIn
                      ? "Update check-in"
                      : "Save check-in"}
                </Button>
              </CardContent>
            </Card>
          </Reveal>
        )}

        <div className="flex items-center gap-2 text-[10px] tabular-nums text-muted-foreground/60">
          {selectedDate} • TanStack Start + R2 {syncing && "• syncing…"} {isLoading && "• loading…"}
        </div>
      </div>

      {/* Hidden voice input kept mounted for confirm flows */}
      <div className="hidden">
        <VoiceInput onTranscript={() => {}} />
      </div>
    </div>
  );
}

// A draggable water slider. Fill, thumb, and the (invisible) native range
// input all share the same 0..max scale so the cursor sits exactly on the
// handle. The day's target is shown as a tick so you can see the goal.
function WaterSlider({
  value,
  target,
  max,
  disabled,
  onDraft,
  onCommit,
}: {
  value: number;
  target: number;
  max: number;
  disabled?: boolean;
  onDraft: (oz: number) => void;
  onCommit: () => void;
}) {
  const valuePct = Math.max(0, Math.min(100, (value / max) * 100));
  const targetPct = Math.max(0, Math.min(100, (target / max) * 100));
  const ratio = value / Math.max(1, target);
  const tone = ratio >= 0.8 ? "bg-emerald-500" : ratio >= 0.4 ? "bg-amber-500" : "bg-primary";
  return (
    <div className="relative flex flex-1 items-center py-2">
      {/* track */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full transition-all ${tone}`} style={{ width: `${valuePct}%` }} />
      </div>
      {/* target tick */}
      <div
        className="pointer-events-none absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/40"
        style={{ left: `${targetPct}%` }}
        aria-hidden="true"
      />
      {/* visible thumb (driven by value; the range overlay handles input) */}
      <div
        className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow transition-all"
        style={{ left: `${valuePct}%` }}
        aria-hidden="true"
      />
      <input
        type="range"
        min={0}
        max={max}
        step={4}
        value={value}
        disabled={disabled}
        onChange={(e) => onDraft(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
        aria-label="Water intake in fluid ounces"
        className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
    </div>
  );
}
