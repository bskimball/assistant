import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useMemo, useRef } from "react";
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
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { VoiceInput, speakAssistant } from "@/components/VoiceInput";
import {
  processVoiceInput,
  loadDailyDashboard,
  saveProductivityTasksForDay,
  appendWorkoutSession,
  saveDailyFinance,
  loadWorkoutSessions,
  loadTransactions,
  appendTransaction,
  saveDailyNutrition,
  type DailyDashboardPayload,
} from "@/server/domain";
import {
  acceptDailyCoachingPlan,
  generateCoaching,
  type CoachingResult,
  type CoachDomain,
} from "@/server/coach";
import type {
  DailyNutrition,
  ISODate,
  DailyFocusScore,
  DailyPlan,
  WorkoutSession,
  Transaction,
} from "@/lib/domain";
import {
  createProductivityTask,
  mlToFlOz,
  newId,
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

  // Dashboard data state (ADR-005)
  const [dashboard, setDashboard] = useState<DailyDashboardPayload | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

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

  // Nutrition quick-add
  const [foodName, setFoodName] = useState("");
  const [foodProtein, setFoodProtein] = useState("");
  const [foodCalories, setFoodCalories] = useState("");

  // Finance quick-add
  const [acctName, setAcctName] = useState("");
  const [acctAmount, setAcctAmount] = useState("");
  const [txnAmount, setTxnAmount] = useState("");
  const [txnCategory, setTxnCategory] = useState("");
  const [txnNote, setTxnNote] = useState("");
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [workoutSessions, setWorkoutSessions] = useState<WorkoutSession[]>([]);

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
  const finance = dashboard?.finance ?? null;
  const focusScore = (dashboard?.focus || null) as
    | (DailyFocusScore & { updatedAt?: number })
    | null;
  const dailyPlan = (dashboard?.plan || null) as (DailyPlan & { updatedAt?: number }) | null;

  const proteinCurrent = nutrition?.totals?.protein ?? 0;
  const proteinTarget = dailyPlan?.nutritionTargets?.protein ?? 150;
  const proteinPct = Math.min(100, Math.round((proteinCurrent / Math.max(1, proteinTarget)) * 100));
  const waterOz = mlToFlOz(nutrition?.waterMl ?? 0) ?? 0;
  const focusMinutes = focusScore?.focusMinutes ?? 0;
  const selectedDayStart = new Date(selectedDate + "T00:00:00").getTime();
  const selectedDayEnd = new Date(selectedDate + "T23:59:59.999").getTime();
  const recentWorkout = [...workoutSessions]
    .filter((s) => s.performedAt <= selectedDayEnd)
    .sort((a, b) => b.performedAt - a.performedAt)[0];
  const weekWorkoutCount = workoutSessions.filter(
    (s) => s.performedAt >= selectedDayStart - 6 * 86400000 && s.performedAt <= selectedDayEnd,
  ).length;
  const dayTransactions = transactions.filter(
    (t) => t.timestamp >= selectedDayStart && t.timestamp <= selectedDayEnd,
  );
  const cashIn = dayTransactions
    .filter((t) => ["deposit", "dividend", "sell"].includes(t.type))
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const cashOut = dayTransactions
    .filter((t) => ["withdrawal", "buy", "fee", "other"].includes(t.type))
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);

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

  // Load data for a date (snapshot + recent activity)
  async function loadForDate(date: ISODate) {
    setIsLoading(true);
    try {
      const [data, sessionsStore, txnStore] = await Promise.all([
        loadDailyDashboard({ data: date }),
        loadWorkoutSessions(),
        loadTransactions(),
      ]);
      setDashboard(data);
      setCoaching(
        data.plan?.aiCoaching
          ? {
              date,
              headline: data.plan.aiCoaching.headline,
              suggestions: data.plan.aiCoaching.suggestions,
              workout: data.plan.aiCoaching.workout,
              generatedBy: data.plan.aiCoaching.generatedBy,
              updatedAt: data.plan.aiCoaching.updatedAt,
            }
          : null,
      );
      hydrateProductivityTasks(data.productivity?.tasks || []);
      setWorkoutSessions((sessionsStore?.sessions || []).filter((s) => !s.deletedAt));
      setTransactions((txnStore?.transactions || []).filter((t) => !t.deletedAt));
    } catch (e) {
      console.warn("[dashboard] loadDailyDashboard failed for", date, e);
      setDashboard({
        date,
        nutrition: null,
        finance: null,
        productivity: { tasks: [], updatedAt: Date.now() },
        plan: null,
        focus: null,
        recent: { interactions: [], transcripts: [] },
      });
      hydrateProductivityTasks([]);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadForDate(selectedDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  // Generate coaching for the current day (cached unless force-refreshing).
  async function refreshCoaching(force = true) {
    setCoachLoading(true);
    try {
      const result = await generateCoaching({ data: { date: selectedDate, force } });
      setCoaching(result);
      await loadForDate(selectedDate);
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

  async function handleQuickAdd(e?: React.FormEvent) {
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
  async function handleAddAccount(e?: React.FormEvent) {
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
      setDashboard((d) => (d ? { ...d, finance: saved } : d));
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
      await loadForDate(selectedDate);
      setVoiceStatus(`Plan accepted: ${result.tasksAdded.length} actions added`);
      setTimeout(() => setVoiceStatus(""), 2200);
    } catch (e) {
      console.error("[dashboard] accept plan failed", e);
    } finally {
      setSyncing(false);
    }
  }

  async function handleAddTransaction(e?: React.FormEvent) {
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
      setTransactions((items) => [...items, transaction]);
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

  // Add a meal/food item to today's nutrition log.
  async function handleAddFood(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!isToday) return;
    const name = foodName.trim();
    if (!name) return;
    const protein = parseFloat(foodProtein) || 0;
    const calories = parseFloat(foodCalories) || 0;
    setSyncing(true);
    try {
      const now = Date.now();
      const foodItem = {
        id: newId("food"),
        name,
        quantity: 1,
        unit: "serving",
        macros: { calories, protein, carbs: 0, fat: 0 },
        source: "user" as const,
      };
      const mealLog = {
        id: newId("meal"),
        timestamp: now,
        foodItems: [foodItem],
        createdAt: now,
        updatedAt: now,
      };
      const saved = await saveDailyNutrition({
        data: {
          date: selectedDate,
          nutrition: {
            mealLogs: [...(nutrition?.mealLogs || []), mealLog],
            totals: nutrition?.totals || { calories: 0, protein: 0, carbs: 0, fat: 0 },
            waterMl: nutrition?.waterMl,
          },
        },
      });
      setDashboard((d) => (d ? { ...d, nutrition: saved } : d));
      setFoodName("");
      setFoodProtein("");
      setFoodCalories("");
      refreshCoaching();
    } catch (e) {
      console.error("[dashboard] save nutrition failed", e);
    } finally {
      setSyncing(false);
    }
  }

  // Voice transcript handler (ADR-004)
  async function handleVoiceTranscript(text: string) {
    setIsVoiceProcessing(true);
    setVoiceStatus("Processing…");
    try {
      const result = await processVoiceInput({ data: { transcriptText: text } });
      setVoiceStatus(result.spokenText || "Done");
      await loadForDate(selectedDate);
      if (result.success) {
        speakAssistant(result.spokenText || "Done");
      } else if (result.intent?.requiresConfirmation) {
        setPendingConfirm({ transcript: text, intentText: result.intent.action });
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
      await loadForDate(selectedDate);
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
            className="text-primary transition-all"
          />
        </svg>
        <div className="mt-1 text-center">
          <div className="text-sm font-medium tabular-nums">{pct}%</div>
          <div className="text-[10px] text-muted-foreground -mt-0.5">{label}</div>
          {sub && <div className="text-[9px] text-muted-foreground/70 tabular-nums">{sub}</div>}
        </div>
      </div>
    );
  }

  const headline =
    coaching?.headline ||
    (isToday
      ? "Speak or tap to log progress — your coach is standing by."
      : "No activity recorded for this day.");

  return (
    <div className="min-h-dvh bg-background px-4 pb-24 pt-6 sm:px-6">
      <div className="mx-auto w-full max-w-page">
        {/* Top nav + date */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs uppercase tracking-[2px] text-muted-foreground">
              Daily Dashboard
            </div>
            <div className="text-3xl font-semibold tracking-tighter">How am I doing?</div>
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
                    className="h-8 w-full justify-center gap-1.5 tabular-nums font-medium sm:w-auto sm:min-w-[132px]"
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
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Lock className="size-2.5" /> Read-only
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Primary Headline: rings + synthesis */}
        <div className="mb-6 rounded-2xl border bg-card p-5">
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
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

            <div className="max-w-[420px] text-center sm:text-left">
              <div className="text-[13px] font-medium text-muted-foreground">Today at a glance</div>
              <div className="mt-1 text-xl leading-tight">
                {focusMinutes > 0 ? `${focusMinutes} min focus • ` : ""}
                {proteinCurrent > 0 ? `${proteinPct}% protein` : "Log nutrition or tasks"}
              </div>
              <div className="mt-2 line-clamp-3 text-sm text-muted-foreground">{headline}</div>
            </div>

            {isToday && (
              <button
                onClick={handleFabClick}
                disabled={isVoiceProcessing}
                className={`flex size-16 shrink-0 items-center justify-center rounded-full border transition-all active:scale-[0.985] ${isListening ? "border-red-500 bg-red-500 text-white shadow" : "border-border hover:border-primary hover:text-primary"}`}
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
            <div className="mt-3 text-center text-[10px] uppercase tracking-[1px] text-muted-foreground/70">
              {voiceStatus}
            </div>
          )}
        </div>

        {/* Listening overlay */}
        {isListeningOverlay && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="rounded-2xl bg-background px-8 py-7 text-center shadow-xl">
              <div className="flex items-center justify-center gap-2 text-sm font-medium tracking-wide text-muted-foreground">
                <Mic className="size-4 text-primary" /> Listening…
              </div>
              <div className="mt-3 flex items-end justify-center gap-1.5 h-10">
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="w-1.5 animate-pulse rounded bg-primary"
                    style={{ height: 12 + (i % 3) * 7, animationDelay: `${i * 110}ms` }}
                  />
                ))}
              </div>
              {interim && <div className="mt-3 text-sm text-muted-foreground">“{interim}”</div>}
              <button onClick={stopOverlayListening} className="mt-5 text-xs underline">
                Cancel
              </button>
              {listenError && <div className="mt-2 text-xs text-destructive">{listenError}</div>}
            </div>
          </div>
        )}

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
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Sparkles className="size-4 text-primary" /> Coach Suggestions
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
                    <li key={i} className="flex gap-2.5 text-sm">
                      <Icon className="mt-0.5 size-4 shrink-0 text-primary/80" />
                      <div className="min-w-0">
                        <span>{s.text}</span>
                        {s.action && isToday && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            — try “{s.action.trim()}”
                          </span>
                        )}
                      </div>
                    </li>
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
              <div className="text-sm text-muted-foreground">No suggestions yet — tap Refresh.</div>
            )}
            {coaching && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div className="text-[10px] text-muted-foreground/60">
                  {coaching.generatedBy === "ai" ? "Generated by Grok" : "Coach (offline rules)"} •
                  updated{" "}
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

        {/* WORKOUT SUGGESTION */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Dumbbell className="size-4 text-primary" /> Today’s Workout
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
              <div>
                <div className="flex items-baseline justify-between">
                  <div className="font-medium">{coaching.workout.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {coaching.workout.focus} • ~{coaching.workout.estimatedMinutes} min
                  </div>
                </div>
                <ul className="mt-2 space-y-1 text-sm">
                  {coaching.workout.exercises.map((ex, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between border-b border-border/40 py-1 last:border-0"
                    >
                      <span>{ex.name}</span>
                      <span className="tabular-nums text-xs text-muted-foreground">
                        {ex.sets} × {ex.reps}
                      </span>
                    </li>
                  ))}
                </ul>
                {isToday && (
                  <Button
                    size="sm"
                    className="mt-3 gap-1.5"
                    onClick={logSuggestedWorkout}
                    disabled={syncing}
                  >
                    <Check className="size-4" /> Mark complete
                  </Button>
                )}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                {coachLoading
                  ? "Building your session…"
                  : "Tap Refresh on suggestions to generate a session."}
              </div>
            )}
          </CardContent>
        </Card>

        {/* FOCUS & TASKS */}
        <Card className="mb-4">
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
            {tasks.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm">
                {tasks.slice(0, 6).map((t) => (
                  <li key={t.id} className="flex items-center gap-2">
                    <span
                      className={`flex size-4 items-center justify-center rounded-full border ${t.done ? "bg-primary text-primary-foreground border-primary" : "border-muted-foreground/40"}`}
                    >
                      {t.done && <Check className="size-3" />}
                    </span>
                    <span className={t.done ? "text-muted-foreground line-through" : ""}>
                      {t.text}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 text-[10px] text-muted-foreground">
              Voice/AI supported — try “add workout 30 min” or “remind me to call mom”.
            </div>
          </CardContent>
        </Card>

        {/* NUTRITION */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Utensils className="size-4 text-primary" /> Nutrition
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-2 flex items-center justify-between text-sm">
              <div>Protein</div>
              <div className="tabular-nums text-muted-foreground">
                {proteinCurrent}g / {proteinTarget}g
              </div>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${proteinPct}%` }}
              />
            </div>

            <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Droplet className="size-3.5" /> Water: {waterOz} fl oz
            </div>

            {(nutrition?.mealLogs?.length ?? 0) > 0 && (
              <div className="mt-3">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Recent logs
                </div>
                <ul className="space-y-0.5 text-sm">
                  {nutrition!.mealLogs
                    .slice(-3)
                    .reverse()
                    .map((m, idx) => (
                      <li key={idx} className="text-muted-foreground">
                        {new Date(m.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}{" "}
                        — {m.foodItems?.[0]?.name || "meal"}
                      </li>
                    ))}
                </ul>
              </div>
            )}

            {isToday && (
              <div className="mt-3 space-y-2">
                <form
                  onSubmit={handleAddFood}
                  className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_90px_90px_auto]"
                >
                  <Input
                    value={foodName}
                    onChange={(e) => setFoodName(e.target.value)}
                    placeholder="Food (e.g. Chicken breast)"
                  />
                  <Input
                    type="number"
                    step="1"
                    min="0"
                    value={foodProtein}
                    onChange={(e) => setFoodProtein(e.target.value)}
                    placeholder="Protein g"
                  />
                  <Input
                    type="number"
                    step="1"
                    min="0"
                    value={foodCalories}
                    onChange={(e) => setFoodCalories(e.target.value)}
                    placeholder="Cal"
                  />
                  <Button type="submit" size="sm" className="gap-1" disabled={!foodName.trim()}>
                    <Plus className="size-4" /> Food
                  </Button>
                </form>
                <div className="text-[10px] text-muted-foreground/70">
                  Or say “log 40g protein chicken” or “add water 12 oz”.
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* FINANCE — first-class snapshot */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Wallet className="size-4 text-primary" /> Finance Snapshot
              </span>
              <span className="text-lg font-semibold tabular-nums">
                ${(finance?.netWorth ?? 0).toLocaleString()}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Net worth
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded bg-muted px-2 py-1">
                <div className="text-muted-foreground">Cash in</div>
                <div className="font-medium tabular-nums">${cashIn.toLocaleString()}</div>
              </div>
              <div className="rounded bg-muted px-2 py-1">
                <div className="text-muted-foreground">Cash out</div>
                <div className="font-medium tabular-nums">${cashOut.toLocaleString()}</div>
              </div>
            </div>

            {finance?.accounts?.length ? (
              <ul className="mt-2 space-y-1 text-sm">
                {finance.accounts.map((a, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between border-b border-border/40 py-1 last:border-0"
                  >
                    <span>{a.account}</span>
                    <span className="tabular-nums text-muted-foreground">
                      ${a.amount.toLocaleString()}
                    </span>
                  </li>
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
                  .map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{t.category || t.notes || t.type}</span>
                      <span className="tabular-nums">${t.amount.toLocaleString()}</span>
                    </li>
                  ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* RECENT ACTIVITY */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="text-base">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {(() => {
              const rec = dashboard?.recent || { interactions: [], transcripts: [] };
              const combined = [
                ...(rec.interactions || []).map((i) => ({
                  ts: i.timestamp,
                  label: "AI",
                  text: (i.response || i.intent || "").toString().slice(0, 120),
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
                    <div key={idx} className="flex gap-2 text-muted-foreground">
                      <span className="mt-px inline-block w-[42px] shrink-0 font-mono text-[10px] text-muted-foreground/70">
                        {new Date(c.ts).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="shrink-0 font-medium text-foreground/80">{c.label}:</span>
                      <span className="min-w-0 flex-1">{c.text}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </CardContent>
        </Card>

        <div className="text-[10px] text-muted-foreground/60 flex items-center gap-2">
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
