import { createFileRoute, Link } from "@tanstack/react-router";
import {
  useState,
  useEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence, useDragControls } from "motion/react";
import { Reveal, revealDelay } from "@/components/motion";
import { dashboardQuery, workoutSessionsQuery, financeHubQuery, queryKeys } from "@/lib/queries";
import {
  Mic,
  Square,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Lock,
  Dumbbell,
  Wallet,
  Utensils,
  Droplet,
  RefreshCw,
  Plus,
  Check,
  ListTodo,
  Minus,
  MoonStar,
  Sun,
  CloudSun,
  Cloud,
  CloudFog,
  CloudRain,
  CloudSnow,
  CloudLightning,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { VoiceInput, speakAssistant } from "@/components/voice-input";
import { WorkoutCarousel } from "@/components/workout-carousel";
import { useSession } from "@/lib/auth-client";
import { getDaypart, daypartGreeting, type Daypart } from "@/lib/scope";
import {
  processVoiceInput,
  saveProductivityTasksForDay,
  appendMealLog,
  appendWorkoutSession,
  setDailyWater,
  saveEveningCheckIn,
  type DailyDashboardPayload,
} from "@/server/domain";
import { generateCoaching, estimateFoodMacros, type CoachingResult } from "@/server/coach";
import { generateDailyQuote, type DailyQuoteResult } from "@/server/daily-quote";
import { useWeather, type WeatherConditionKey, type WeatherForecast } from "@/lib/use-weather";
import type { DailyNutrition, ISODate, DailyPlan } from "@/lib/domain";
import {
  createProductivityTask,
  flOzToMl,
  formatISODate,
  isTimestampOnLocalDay,
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

// Contextual Zen Stack (dashboard redesign)
//
// The home surface is a calm, time-of-day-aware "Action Stack": a large
// greeting, the voice mic, and a full deck of domain cards (tasks, workout,
// nutrition, reflection, finance). Daypart only focuses the most relevant
// card — it never hides the rest — so navigation stays complete all day.
// Everything deeper still lives on the detail pages behind the top nav. The
// daypart layer is fully independent of the light/dark theme: it decides
// focus + ambient tint, never brightness.

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
  component: ZenStackDashboard,
});

/**
 * Progress-bar fill tone using semantic status roles (never the crimson brand,
 * which is reserved for actions): success rewards near-complete progress,
 * warning is partway, info is early, destructive flags overshoot.
 */
function fillTone(pct: number, over = false): string {
  if (over) return "bg-destructive";
  if (pct >= 80) return "bg-success";
  if (pct >= 40) return "bg-warning";
  return "bg-info";
}

/**
 * Enter/exit recipe for transient status lines (voice status, food status,
 * errors, confirmation banner): a quiet opacity + small y slide on a short
 * ease so meaningful feedback fades in/out instead of popping. Reduced motion
 * is honored app-wide by <MotionConfig reducedMotion="user">.
 */
const statusFade = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 4 },
  transition: { duration: 0.2, ease: "easeOut" },
} as const;

/**
 * Acknowledgement badge (evening check-in "Completed"): a restrained opacity
 * fade with a gentle scale settle so the confirmation lands calmly.
 */
const badgeAck = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.95 },
  transition: { duration: 0.18, ease: "easeOut" },
} as const;

/**
 * Task-completion check glyph: opacity-only, no scale or blur, so frequent
 * toggles read as a quiet check rather than a pop.
 */
const checkAck = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.16, ease: "easeOut" },
} as const;

/** Lucide icon for each weather condition shown in the side rail. */
const weatherConditionIcon: Record<WeatherConditionKey, typeof Sun> = {
  clear: Sun,
  "partly-cloudy": CloudSun,
  cloudy: Cloud,
  fog: CloudFog,
  rain: CloudRain,
  snow: CloudSnow,
  thunderstorm: CloudLightning,
};

/**
 * Decorative quote. On wide screens the parent floats it toward the bottom-left
 * of the viewport (out of flow, so it never pushes the centered content) — pure
 * ambience with a decorative quotation mark. The `compact` variant is a small
 * centered quote the parent renders above the stack on narrow screens.
 */
function SideRail({
  quote,
  compact = false,
}: {
  quote: DailyQuoteResult | null;
  compact?: boolean;
}) {
  if (!quote) return null;
  if (compact) {
    return (
      <figure className="mx-auto max-w-md text-center">
        <blockquote className="voice text-pretty text-sm leading-relaxed text-muted-foreground">
          {quote.text}
        </blockquote>
        {quote.author && (
          <figcaption className="mt-1.5 text-xs text-muted-foreground/70">
            — {quote.author}
          </figcaption>
        )}
      </figure>
    );
  }
  return (
    <figure className="max-w-xs text-left">
      <blockquote className="voice relative text-pretty text-base leading-relaxed text-muted-foreground">
        <span
          aria-hidden
          className="greeting-display absolute -left-1 -top-3 text-3xl leading-none text-foreground/15 select-none"
        >
          &ldquo;
        </span>
        {quote.text}
      </blockquote>
      {quote.author && (
        <figcaption className="mt-2 text-xs text-muted-foreground/70">— {quote.author}</figcaption>
      )}
    </figure>
  );
}

/** Compact ambient weather line for the top utility row (matches renderings). */
function WeatherLine({
  weather,
  className = "",
}: {
  weather: WeatherForecast | null;
  className?: string;
}) {
  if (!weather) return null;
  const WeatherIcon = weatherConditionIcon[weather.condition];
  return (
    <span className={`inline-flex items-center gap-1.5 text-muted-foreground ${className}`}>
      <WeatherIcon className="size-4 shrink-0" />
      <span className="tabular-nums">
        {weather.currentTempF}°F · {weather.label} · H {weather.highF}° / L {weather.lowF}°
        {weather.precipitationProbability > 20 ? ` · ${weather.precipitationProbability}%` : ""}
      </span>
    </span>
  );
}

function ZenStackDashboard() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const today = todayISO();
  const selectedDate: ISODate = (search.date as ISODate) || today;
  const isToday = selectedDate === today;
  const dateLabel = formatISODate(selectedDate, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const queryClient = useQueryClient();
  const dashKey = dashboardQuery(selectedDate).queryKey;
  const dashQuery = useQuery(dashboardQuery(selectedDate));
  const sessionsQ = useQuery(workoutSessionsQuery());
  const hubQuery = useQuery(financeHubQuery(selectedDate));
  const dashboard = dashQuery.data ?? null;
  const [syncing, setSyncing] = useState(false);

  // Time-of-day CONTEXT layer — independent of the light/dark theme. Defaults
  // to the clock; the daypart pills let you peek at another part of the day.
  // Daypart only chooses which Action Stack card is focused, never which cards
  // exist — the full deck stays reachable so nothing is buried.
  const [daypartOverride, setDaypartOverride] = useState<Daypart | null>(null);
  const daypart: Daypart = daypartOverride ?? getDaypart();
  const stackFocusKey =
    daypart === "morning"
      ? "workout"
      : daypart === "midday"
        ? "nutrition"
        : isToday
          ? "evening"
          : "finance";

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

  // Coaching (headline + workout)
  const [coaching, setCoaching] = useState<CoachingResult | null>(null);
  const [coachLoading, setCoachLoading] = useState(false);

  // AI daily quote (side rail) — seeded from the plan, generated once for today.
  const [dailyQuote, setDailyQuote] = useState<DailyQuoteResult | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  // Voice (ADR-004)
  const [voiceStatus, setVoiceStatus] = useState<string>("");
  const [pendingConfirm, setPendingConfirm] = useState<{
    transcript: string;
    intentText?: string;
  } | null>(null);
  const [isVoiceProcessing, setIsVoiceProcessing] = useState(false);
  const [isListeningOverlay, setIsListeningOverlay] = useState(false);
  const [interim, setInterim] = useState("");
  const [listenError, setListenError] = useState<string | null>(null);

  // Quick-adds
  const [taskInput, setTaskInput] = useState("");
  const [foodName, setFoodName] = useState("");
  const [foodEstimating, setFoodEstimating] = useState(false);
  const [foodStatus, setFoodStatus] = useState<string | null>(null);
  const [waterDraft, setWaterDraft] = useState<number | null>(null);

  // Evening check-in
  const [checkInEnergy, setCheckInEnergy] = useState(3);
  const [checkInRating, setCheckInRating] = useState(3);
  const [checkInWin, setCheckInWin] = useState("");
  const [checkInFriction, setCheckInFriction] = useState("");
  const [checkInNote, setCheckInNote] = useState("");
  const [checkInSaving, setCheckInSaving] = useState(false);

  const financeHub = hubQuery.data ?? null;
  const transactions = (hubQuery.data?.transactions || []).filter((t) => !t.deletedAt);
  const workoutSessions = (sessionsQ.data?.sessions || []).filter((s) => !s.deletedAt);

  // Tasks via TanStack DB (reactive)
  const [tasksVersion, setTasksVersion] = useState(0);
  useEffect(() => {
    const sub = productivityTasksCollection.subscribeChanges(() => setTasksVersion((v) => v + 1));
    return () => sub.unsubscribe();
  }, []);
  const tasks = useMemo(() => getTasksForDate(selectedDate), [selectedDate, tasksVersion]);
  const activeTasks = tasks.filter((t) => !t.deletedAt && !t.done);

  // Derived signals
  const nutrition = dashboard?.nutrition as (DailyNutrition & { updatedAt?: number }) | null;
  const finance = financeHub?.snapshot ?? dashboard?.finance ?? null;
  const dailyPlan = (dashboard?.plan || null) as (DailyPlan & { updatedAt?: number }) | null;

  const proteinCurrent = nutrition?.totals?.protein ?? 0;
  const proteinTarget = dailyPlan?.nutritionTargets?.protein ?? 150;
  const proteinPct = Math.min(100, Math.round((proteinCurrent / Math.max(1, proteinTarget)) * 100));
  const caloriesCurrent = nutrition?.totals?.calories ?? 0;
  const caloriesTarget = dailyPlan?.nutritionTargets?.calories ?? 2000;
  const caloriesPct = Math.min(
    100,
    Math.round((caloriesCurrent / Math.max(1, caloriesTarget)) * 100),
  );
  const waterOz = mlToFlOz(nutrition?.waterMl ?? 0) ?? 0;
  const waterTargetOz = 85;
  const displayWaterOz = waterDraft ?? waterOz;
  const waterSliderMax = Math.max(
    Math.ceil((waterTargetOz * 1.5) / 4) * 4,
    Math.ceil(displayWaterOz / 4) * 4,
    8,
  );

  const workoutCompletedToday = workoutSessions.some((s) =>
    isTimestampOnLocalDay(s.performedAt, selectedDate),
  );

  const selectedMonth = selectedDate.slice(0, 7);
  const monthTransactions = transactions.filter(
    (t) => toISODate(t.timestamp).slice(0, 7) === selectedMonth,
  );
  const takeHome = financeHub?.budget?.monthlyTakeHome ?? 0;
  const {
    income: financeIncome,
    spend: financeSpend,
    cashFlow: financeCashFlow,
  } = summarizeCashFlow(monthTransactions, takeHome);

  function goToday() {
    navigate({ search: {} });
  }

  // Hydrate tasks + seed coaching from the persisted plan.
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

  async function refreshCoaching(force = true) {
    setCoachLoading(true);
    try {
      const result = await generateCoaching({
        data: { date: selectedDate, force },
      });
      setCoaching(result);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.dashboard(selectedDate),
      });
    } catch (e) {
      console.warn("[dashboard] coaching failed", e);
    } finally {
      setCoachLoading(false);
    }
  }

  useEffect(() => {
    if (isToday && dashboard && !dashboard.plan?.aiCoaching && !coaching && !coachLoading) {
      refreshCoaching(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard]);

  // Seed the daily quote from the persisted plan; otherwise generate once for
  // today (never on past days, never regenerated on reload).
  useEffect(() => {
    if (!dashboard) return;
    setDailyQuote(
      dashboard.plan?.dailyQuote ? { ...dashboard.plan.dailyQuote, date: selectedDate } : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard]);

  useEffect(() => {
    if (isToday && dashboard && !dashboard.plan?.dailyQuote && !dailyQuote && !quoteLoading) {
      setQuoteLoading(true);
      generateDailyQuote({ data: { date: selectedDate } })
        .then((result) => setDailyQuote(result))
        .catch((e) => console.warn("[dashboard] daily quote failed", e))
        .finally(() => setQuoteLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard]);

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

  async function handleQuickAdd(e?: SyntheticEvent) {
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

  async function toggleTask(id: string) {
    if (!isToday) return;
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    upsertProductivityTaskClient({
      ...t,
      done: !t.done,
      updatedAt: Date.now(),
    });
    await persistTasks(selectedDate);
  }

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

  async function handleAddFood(e?: SyntheticEvent) {
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
      const saved = await appendMealLog({
        data: { date: selectedDate, meal: mealLog },
      });
      setDashboardData((d) => ({ ...d, nutrition: saved }));
      setFoodName("");
      setFoodStatus(
        `Logged ${est.name} — ${est.calories} cal, ${est.protein}g protein` +
          (est.generatedBy === "fallback" ? " (rough estimate)" : ""),
      );
      setTimeout(() => setFoodStatus(null), 4000);
    } catch (e) {
      console.error("[dashboard] add food failed", e);
      setFoodStatus("Couldn’t estimate that food right now — try again in a moment.");
      setTimeout(() => setFoodStatus(null), 3000);
    } finally {
      setFoodEstimating(false);
    }
  }

  async function setWaterOzTotal(totalOz: number) {
    if (!isToday || foodEstimating) return;
    const oz = Math.max(0, Math.round(totalOz));
    try {
      const saved = await setDailyWater({
        data: { date: selectedDate, waterMl: flOzToMl(oz) ?? 0 },
      });
      setDashboardData((d) => ({ ...d, nutrition: saved }));
    } catch (e) {
      console.error("[dashboard] set water failed", e);
    }
  }
  function commitWaterDraft() {
    if (waterDraft == null) return;
    void setWaterOzTotal(waterDraft).finally(() => setWaterDraft(null));
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
      setVoiceStatus("Voice error. " + (e?.message || ""));
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

  // Mic FAB + listening overlay
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

  useEffect(() => {
    const checkIn = dailyPlan?.eveningCheckIn;
    if (!checkIn) return;
    setCheckInEnergy(checkIn.energy);
    setCheckInRating(checkIn.dayRating);
    setCheckInWin(checkIn.win ?? "");
    setCheckInFriction(checkIn.friction ?? "");
    setCheckInNote(checkIn.note ?? "");
  }, [dailyPlan?.eveningCheckIn]);

  async function submitEveningCheckIn() {
    if (!isToday || checkInSaving) return;
    if (![checkInEnergy, checkInRating].every((v) => Number.isInteger(v) && v >= 1 && v <= 5))
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
            note: checkInNote.trim() || undefined,
            completedAt: Date.now(),
          },
        },
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.dashboard(selectedDate),
      });
    } finally {
      setCheckInSaving(false);
    }
  }

  const headline =
    coaching?.headline ||
    (isToday
      ? "Speak or tap the mic — your coach is standing by."
      : "No activity recorded for this day.");

  const { data: greetSession } = useSession();
  const firstName = (greetSession?.user?.name || "").trim().split(/\s+/)[0];
  const greetingLead = isToday
    ? `${daypartGreeting(daypart)}${firstName ? `, ${firstName}` : ""}.`
    : `${dateLabel} — a look back.`;

  // Weather for the side rail — only fetched when viewing today.
  const { weather } = useWeather(isToday);

  const visibleTasks = tasks.filter((t) => !t.deletedAt).slice(0, 5);

  return (
    <div
      className="zen-ambient px-4 pb-28 pt-4 sm:px-6"
      data-daypart={daypart}
      data-atmosphere="vivid"
    >
      {/* Slim utility row: daypart pills + date context. Deliberately quiet.
          Lives OUTSIDE the centered column so it spans the full screen width —
          pills flush left, weather/date flush right — instead of being boxed
          into the narrow reading column. */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", duration: 0.4, bounce: 0 }}
        className="relative z-10 mb-10 flex w-full flex-wrap items-center justify-center gap-3 sm:mb-14 sm:justify-between"
      >
        {isToday ? (
          <div
            className="relative inline-flex items-center rounded-full bg-surface-raised p-1 ring-1 ring-border/50"
            role="tablist"
            aria-label="Focus of the day"
          >
            {(
              [
                ["morning", "Morning"],
                ["midday", "Midday"],
                ["evening", "Evening"],
              ] as [Daypart, string][]
            ).map(([part, label]) => {
              const active = daypart === part;
              return (
                <button
                  key={part}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setDaypartOverride(getDaypart() === part ? null : part)}
                  className={`relative flex min-h-9 items-center justify-center rounded-full px-4 text-[13px] font-medium transition-colors duration-200 ${
                    active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="daypart-active"
                      className="absolute inset-0 rounded-full bg-background shadow-sm ring-1 ring-border/60"
                      transition={{
                        type: "spring",
                        duration: 0.35,
                        bounce: 0,
                      }}
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-1.5">
                    {label}
                    <span
                      aria-hidden
                      className={`size-1.5 rounded-full transition-colors duration-200 ${
                        active ? "bg-primary" : "bg-transparent"
                      }`}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <Badge
            variant="secondary"
            className="gap-1 rounded-full text-[10px] text-muted-foreground"
          >
            <Lock className="size-2.5" /> Read-only
          </Badge>
        )}

        <div className="flex items-center gap-3 text-sm">
          {isToday && <WeatherLine weather={weather} />}
          {!isToday && (
            <Button variant="outline" size="sm" onClick={goToday} className="h-8">
              Today
            </Button>
          )}
          <span className="tabular-nums font-medium text-muted-foreground">{dateLabel}</span>
        </div>
      </motion.div>

      <div className="relative z-10 mx-auto w-full max-w-2xl">
        {/* Decorative quote — pinned toward the bottom-left of the viewport on
            wide screens (fixed, out of flow) so it never shifts the centered
            content. Pure ambience, no card. */}
        <Reveal
          as="section"
          className="pointer-events-none fixed bottom-10 left-6 z-10 hidden w-56 xl:block 2xl:left-12 2xl:w-64"
        >
          <SideRail quote={dailyQuote} />
        </Reveal>

        <div className="min-w-0 w-full">
          {/* Greeting — the emotional center of the page. Kept to just the
              greeting so the hero stays short; the day's coach advice moved to
              the ribbon below. */}
          <Reveal>
            <div className="mb-6 text-center sm:mb-8">
              <h1 className="greeting-display on-scene text-balance text-5xl text-foreground sm:text-6xl">
                {greetingLead}
              </h1>
              <AnimatePresence initial={false}>
                {(voiceStatus || isVoiceProcessing) && (
                  <motion.div
                    {...statusFade}
                    role="status"
                    aria-live="polite"
                    className="mt-3 text-sm text-muted-foreground"
                  >
                    {voiceStatus}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </Reveal>

          {/* Confirmation banner (voice) */}
          <AnimatePresence initial={false}>
            {pendingConfirm && (
              <motion.div
                {...statusFade}
                role="group"
                aria-label="Confirm voice action"
                className="zen-card mb-5 flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <div aria-live="polite">
                  Confirm: <span className="font-medium">{pendingConfirm.intentText}</span>
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
              </motion.div>
            )}
          </AnimatePresence>

          {/* Coach ribbon — the day's AI advice, decoupled from the greeting so
              the hero stays short and the cards rise up. Doubles as a doorway
              into the Coach chat for a deeper conversation. */}
          <Reveal className="mb-6">
            <Link
              to="/chat"
              className="zen-surface-nested coach-advice-ribbon group flex items-center gap-3 rounded-2xl px-4 py-3 text-sm transition-colors"
            >
              <Sparkles className="size-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 text-pretty leading-snug text-foreground/80">
                {headline}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Reveal>

          <ActionStack focusKey={stackFocusKey}>
            {/* WORKOUT — focused in the morning, always available */}
            <StackCard key="workout" label="Workout">
              <section className="zen-card p-5 sm:p-7">
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    <Dumbbell className="size-3.5" />
                    {isToday ? "Morning workout" : "Workout"}
                  </div>
                  <Link
                    to="/health/workouts"
                    className="text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
                  >
                    All workouts →
                  </Link>
                </div>
                {coaching?.workout ? (
                  <>
                    <WorkoutCarousel
                      title={coaching.workout.title}
                      focus={coaching.workout.focus}
                      estimatedMinutes={coaching.workout.estimatedMinutes}
                      exercises={coaching.workout.exercises}
                    />
                    {isToday && (
                      <div className="mt-4 flex items-center gap-3">
                        <Button
                          onClick={logSuggestedWorkout}
                          disabled={syncing || workoutCompletedToday}
                          className="gap-1.5"
                        >
                          <Check className="size-4" />
                          {workoutCompletedToday ? "Completed today" : "Mark complete"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => refreshCoaching(true)}
                          disabled={coachLoading}
                          className="gap-1.5 text-muted-foreground"
                        >
                          <RefreshCw className={`size-3.5 ${coachLoading ? "animate-spin" : ""}`} />
                          New session
                        </Button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                    <span>
                      {coachLoading ? "Building your session…" : "No session planned yet."}
                    </span>
                    {isToday && !coachLoading && (
                      <Button variant="outline" size="sm" onClick={() => refreshCoaching(true)}>
                        Generate
                      </Button>
                    )}
                  </div>
                )}
              </section>
            </StackCard>

            {/* NUTRITION — focused at midday, always available */}
            <StackCard key="nutrition" label="Nutrition">
              <section className="zen-card p-5 sm:p-7">
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    <Utensils className="size-3.5" />
                    Nutrition
                  </div>
                  <Link
                    to="/health/nutrition"
                    search={{ date: isToday ? undefined : selectedDate }}
                    className="text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
                  >
                    Details →
                  </Link>
                </div>

                {isToday && (
                  <form onSubmit={handleAddFood} className="mb-5 flex items-center gap-2">
                    <Input
                      value={foodName}
                      onChange={(e) => setFoodName(e.target.value)}
                      placeholder="What did you eat? (e.g. 6oz chicken breast)"
                      className="zen-input h-11 flex-1 rounded-lg px-4 text-sm"
                      disabled={foodEstimating}
                    />
                    <Button
                      type="submit"
                      className="h-11 gap-1.5 rounded-lg px-5"
                      disabled={!foodName.trim() || foodEstimating}
                    >
                      {foodEstimating ? (
                        <RefreshCw className="size-4 animate-spin" />
                      ) : (
                        <Sparkles className="size-4" />
                      )}
                      {foodEstimating ? "…" : "Log"}
                    </Button>
                  </form>
                )}
                <AnimatePresence initial={false}>
                  {foodStatus && (
                    <motion.div
                      {...statusFade}
                      role="status"
                      aria-live="polite"
                      className="mb-4 -mt-2 text-xs text-muted-foreground"
                    >
                      {foodStatus}
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                  <div>
                    <div className="mb-1.5 flex items-baseline justify-between text-xs">
                      <span className="text-muted-foreground">Calories</span>
                      <span className="font-semibold tabular-nums">
                        {caloriesCurrent}
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          / {caloriesTarget}
                        </span>
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
                      <div
                        className={`h-full transition-[width] ${fillTone(caloriesPct, caloriesCurrent > caloriesTarget * 1.05)}`}
                        style={{ width: `${caloriesPct}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="mb-1.5 flex items-baseline justify-between text-xs">
                      <span className="text-muted-foreground">Protein</span>
                      <span className="font-semibold tabular-nums">
                        {proteinCurrent}g
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          / {proteinTarget}g
                        </span>
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
                      <div
                        className={`h-full transition-[width] ${fillTone(proteinPct)}`}
                        style={{ width: `${proteinPct}%` }}
                      />
                    </div>
                  </div>
                </div>

                {/* Water */}
                <div className="mt-5">
                  <div className="mb-1.5 flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Droplet className="size-3.5" /> Water
                    </span>
                    <span className="font-semibold tabular-nums">
                      {displayWaterOz}
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        / {waterTargetOz} fl oz
                      </span>
                    </span>
                  </div>
                  {isToday ? (
                    <div className="flex items-center gap-2.5">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-10 shrink-0 rounded-full transition-transform active:scale-[0.96]"
                        disabled={foodEstimating || displayWaterOz <= 0}
                        onClick={() => setWaterOzTotal(waterOz - 4)}
                        aria-label="Remove 4 fl oz"
                      >
                        <Minus className="size-3.5" />
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
                        variant="ghost"
                        className="size-10 shrink-0 rounded-full transition-transform active:scale-[0.96]"
                        disabled={foodEstimating}
                        onClick={() => setWaterOzTotal(waterOz + 4)}
                        aria-label="Add 4 fl oz"
                      >
                        <Plus className="size-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
                      <div
                        className={`h-full transition-[width] ${fillTone(Math.round((waterOz / waterTargetOz) * 100))}`}
                        style={{
                          width: `${Math.min(100, Math.round((waterOz / waterTargetOz) * 100))}%`,
                        }}
                      />
                    </div>
                  )}
                </div>
              </section>
            </StackCard>

            {/* EVENING REFLECTION — focused in the evening (today only), always
              present when viewing today so the card is never a surprise. */}
            {isToday && (
              <StackCard key="evening" label="Reflect">
                <section className="zen-card p-5 sm:p-7">
                  <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      <MoonStar className="size-3.5" />
                      Evening reflection
                    </div>
                    <AnimatePresence initial={false}>
                      {dailyPlan?.eveningCheckIn && (
                        <motion.span key="checkin-done" {...badgeAck} className="inline-flex">
                          <Badge
                            variant="secondary"
                            className="gap-1 rounded-full border-0 bg-success/15 text-[9px] uppercase tracking-widest text-success"
                          >
                            <Check className="size-2.5" />
                            Completed
                          </Badge>
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      <span className="text-xs text-muted-foreground">Energy (1–5)</span>
                      <Input
                        type="number"
                        min={1}
                        max={5}
                        value={checkInEnergy}
                        onChange={(e) => setCheckInEnergy(Number(e.target.value))}
                        className="zen-input"
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-xs text-muted-foreground">Day rating (1–5)</span>
                      <Input
                        type="number"
                        min={1}
                        max={5}
                        value={checkInRating}
                        onChange={(e) => setCheckInRating(Number(e.target.value))}
                        className="zen-input"
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-xs text-muted-foreground">Today’s win</span>
                      <Input
                        value={checkInWin}
                        onChange={(e) => setCheckInWin(e.target.value)}
                        placeholder="What went well?"
                        className="zen-input"
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-xs text-muted-foreground">Friction or blocker</span>
                      <Input
                        value={checkInFriction}
                        onChange={(e) => setCheckInFriction(e.target.value)}
                        placeholder="What got in the way?"
                        className="zen-input"
                      />
                    </label>
                    <label className="space-y-1 text-sm sm:col-span-2">
                      <span className="text-xs text-muted-foreground">Optional note</span>
                      <Input
                        value={checkInNote}
                        onChange={(e) => setCheckInNote(e.target.value)}
                        placeholder="Anything else worth remembering?"
                        className="zen-input"
                      />
                    </label>
                  </div>
                  <Button
                    onClick={submitEveningCheckIn}
                    disabled={checkInSaving}
                    variant={dailyPlan?.eveningCheckIn ? "secondary" : "default"}
                    className="mt-4 overflow-hidden"
                  >
                    {(() => {
                      const label = checkInSaving
                        ? "Saving…"
                        : dailyPlan?.eveningCheckIn
                          ? "Update check-in"
                          : "Save check-in";
                      return (
                        <AnimatePresence initial={false}>
                          <motion.span
                            key={label}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.16, ease: "easeOut" }}
                            className="inline-block"
                          >
                            {label}
                          </motion.span>
                        </AnimatePresence>
                      );
                    })()}
                  </Button>
                </section>
              </StackCard>
            )}

            {/* FINANCE WRAP-UP — focused in the evening, always available */}
            <StackCard key="finance" label="Finance">
              <section className="zen-card p-5 sm:p-7">
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    <Wallet className="size-3.5" />
                    Finance wrap-up
                  </div>
                  <Link
                    to="/finance"
                    className="text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
                  >
                    Details →
                  </Link>
                </div>
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <div className="text-xs text-muted-foreground">Net worth</div>
                    <div className="text-3xl font-semibold tabular-nums tracking-tight">
                      ${(finance?.netWorth ?? 0).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex gap-6 text-sm">
                    <div>
                      <div className="text-xs text-muted-foreground">Cash flow (mo)</div>
                      <div
                        className={`font-semibold tabular-nums ${financeCashFlow < 0 ? "text-destructive" : ""}`}
                      >
                        {financeCashFlow < 0 ? "-" : "+"}$
                        {Math.abs(Math.round(financeCashFlow)).toLocaleString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Income</div>
                      <div className="font-semibold tabular-nums">
                        ${financeIncome.toLocaleString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Spending</div>
                      <div className="font-semibold tabular-nums">
                        ${financeSpend.toLocaleString()}
                      </div>
                    </div>
                  </div>
                </div>
                {financeHub?.safeToSpend && financeHub.safeToSpend.status !== "unavailable" && (
                  <div className="zen-surface-nested mt-4 flex items-center justify-between px-3.5 py-2.5 text-sm">
                    <span className="text-muted-foreground">Safe to spend this month</span>
                    <span className="font-semibold tabular-nums">
                      ${financeHub.safeToSpend.safeToSpendThisMonth.toLocaleString()}
                    </span>
                  </div>
                )}
              </section>
            </StackCard>

            {/* TASKS — always available, second focus after the daypart primary */}
            <StackCard key="tasks" label="Tasks">
              <section className="zen-card p-5 sm:p-7">
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    <ListTodo className="size-3.5" />
                    {daypart === "morning" ? "Morning focus" : "Tasks"}
                  </div>
                  <Link
                    to="/kanban"
                    className="text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
                  >
                    All tasks →
                  </Link>
                </div>

                {visibleTasks.length > 0 ? (
                  <ul className="mb-4 space-y-2.5 text-sm">
                    {visibleTasks.map((t, i) => (
                      <Reveal as="li" key={t.id} delay={revealDelay(i)}>
                        <button
                          type="button"
                          onClick={() => toggleTask(t.id)}
                          disabled={!isToday}
                          className="group flex w-full items-center gap-3 text-left disabled:cursor-default"
                        >
                          <span
                            className={`flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors ${t.done ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/35 group-hover:border-primary/60"}`}
                          >
                            <AnimatePresence initial={false}>
                              {t.done && (
                                <motion.span key="check" {...checkAck} className="flex">
                                  <Check className="size-3" />
                                </motion.span>
                              )}
                            </AnimatePresence>
                          </span>
                          <span
                            className={`min-w-0 flex-1 truncate transition-colors ${t.done ? "text-muted-foreground line-through" : ""}`}
                          >
                            {t.text}
                          </span>
                        </button>
                      </Reveal>
                    ))}
                  </ul>
                ) : (
                  <div className="mb-4 text-sm text-muted-foreground">
                    {isToday ? "Nothing on the list yet." : "No tasks were logged for this day."}
                  </div>
                )}

                {isToday && (
                  <form onSubmit={handleQuickAdd} className="flex items-center gap-2">
                    <Input
                      value={taskInput}
                      onChange={(e) => setTaskInput(e.target.value)}
                      placeholder="Add a task…"
                      className="zen-input h-10 flex-1 rounded-lg px-4 text-sm"
                    />
                    <Button
                      type="submit"
                      size="icon"
                      className="size-10 shrink-0 rounded-lg"
                      disabled={!taskInput.trim()}
                      aria-label="Add task"
                    >
                      <Plus className="size-4" />
                    </Button>
                  </form>
                )}
                {activeTasks.length > visibleTasks.filter((t) => !t.done).length && (
                  <div className="mt-3 text-xs text-muted-foreground">
                    +{activeTasks.length - visibleTasks.filter((t) => !t.done).length} more pending
                  </div>
                )}
              </section>
            </StackCard>
          </ActionStack>

          {/* Decorative quote for narrow screens (< xl), where the floating
              side rail is hidden: a centered quote placed below the content. */}
          {dailyQuote && (
            <Reveal className="mt-4 xl:hidden">
              <SideRail quote={dailyQuote} compact />
            </Reveal>
          )}
        </div>
      </div>

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
        </DialogContent>
      </Dialog>

      {/* Voice error surface — lives OUTSIDE the listening dialog so
          unsupported/start/recognition errors stay visible and announced even
          after the overlay closes. */}
      <AnimatePresence initial={false}>
        {listenError && (
          <motion.div
            {...statusFade}
            role="alert"
            aria-live="assertive"
            className="fixed inset-x-0 bottom-44 z-50 mx-auto w-fit max-w-[90vw] rounded-full bg-destructive px-4 py-2 text-center text-xs font-medium text-destructive-foreground shadow-lg lg:bottom-8 lg:left-auto lg:right-28 lg:mx-0"
          >
            {listenError}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Voice mic FAB — lower-right, above the mobile tab bar. */}
      {isToday && (
        <button
          onClick={handleFabClick}
          disabled={isVoiceProcessing}
          aria-label={isListening ? "Stop listening" : "Talk to your coach"}
          className={`fixed bottom-[calc(var(--tabbar-h)+1rem)] left-auto right-4 z-40 flex size-16 translate-x-0 items-center justify-center rounded-full transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96] lg:bottom-8 lg:right-8 ${
            isListening
              ? "bg-primary text-primary-foreground shadow-lg ring-4 ring-primary/20"
              : "bg-surface-raised text-primary shadow-xl ring-1 ring-primary/35 hover:bg-surface"
          }`}
        >
          {isVoiceProcessing ? (
            <RefreshCw className="size-6 animate-spin" />
          ) : isListening ? (
            <Square className="size-6 fill-current" />
          ) : (
            <Mic className="size-7" />
          )}
        </button>
      )}

      {/* Hidden voice input kept mounted for confirm flows */}
      <div className="hidden">
        <VoiceInput onTranscript={() => {}} />
      </div>
    </div>
  );
}

// A single card in the Action Stack. Thin marker wrapper: ActionStack reads
// `key` + `label` from the element props and owns all motion/layout itself.
function StackCard({
  children,
  label: _label,
}: {
  key?: string;
  label: string;
  children: ReactNode;
}) {
  void _label;
  return <>{children}</>;
}

/**
 * Interactive, buttery-smooth carousel/stack of Action cards.
 *
 * Every domain card stays in the deck. Daypart only chooses which card starts
 * in front — never which cards exist. Below xl, horizontal swipes select cards
 * while the scene transitions vertically, with adjacent cards peeking above or
 * below the focused card. At xl+, cards retain the full depth-stack treatment.
 * Compact dot controls keep navigation quiet while accessible labels preserve
 * the card names for assistive technology.
 */
const stackInteractiveSelector =
  "button,a,input,textarea,select,[contenteditable=true],[role=button],[role=link],[role=slider],[role=checkbox],[role=switch]";

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

function ActionStack({
  children,
  focusKey,
}: {
  children: ReactNode;
  /** Preferred front card key for the current daypart. */
  focusKey?: string;
}) {
  // Collect rendered StackCard children into a stable, keyed list. Falsy
  // entries (e.g. evening reflection on past days) are skipped. Daypart only
  // reorders the deck so the focused card is front-most — nothing is removed.
  const rawCards = (Array.isArray(children) ? children : [children])
    .flat()
    .filter((c): c is ReactElement<{ label?: string }> => Boolean(c))
    .map((c) => ({
      key: String(c.key),
      label:
        typeof c.props.label === "string" && c.props.label.trim() ? c.props.label : String(c.key),
      node: c,
    }));
  const preferredOrder =
    focusKey === "nutrition"
      ? ["nutrition", "tasks", "workout", "finance", "evening"]
      : focusKey === "evening" || focusKey === "finance"
        ? ["evening", "finance", "tasks", "nutrition", "workout"]
        : ["workout", "tasks", "nutrition", "finance", "evening"];
  const cards = [...rawCards].sort((a, b) => {
    const ai = preferredOrder.indexOf(a.key);
    const bi = preferredOrder.indexOf(b.key);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const cardKeys = cards.map((c) => c.key).join("|");
  const focusIndex = Math.max(0, focusKey ? cards.findIndex((c) => c.key === focusKey) : 0);
  // Key-based selection survives card set changes (e.g. evening only on today)
  // better than a raw index. Daypart focus re-homes the deck when it changes.
  const [activeKey, setActiveKey] = useState<string | null>(focusKey ?? null);
  const prevFocusKey = useRef(focusKey);
  useEffect(() => {
    if (prevFocusKey.current !== focusKey) {
      prevFocusKey.current = focusKey;
      if (focusKey) setActiveKey(focusKey);
      return;
    }
    setActiveKey((current) => {
      if (current && cards.some((c) => c.key === current)) return current;
      return focusKey ?? cards[0]?.key ?? null;
    });
  }, [focusKey, cardKeys]);

  const activeIndex = Math.max(
    0,
    activeKey ? cards.findIndex((c) => c.key === activeKey) : focusIndex,
  );
  const clampedActive = cards.length === 0 ? 0 : Math.min(activeIndex, cards.length - 1);

  const count = cards.length;
  const isDesktopStack = useMediaQuery("(min-width: 1280px)");
  const dragControls = useDragControls();
  const suppressDrag = useRef(false);
  if (count === 0) return null;

  const selectIndex = (i: number) => setActiveKey(cards[i]?.key ?? null);
  const go = (dir: number) => {
    const next = (clampedActive + dir + count) % count;
    selectIndex(next);
  };
  const startFrontDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    suppressDrag.current = Boolean(target.closest(stackInteractiveSelector));
    if (!suppressDrag.current && !isDesktopStack) dragControls.start(event);
  };

  return (
    <div className="action-stack overflow-hidden xl:overflow-visible">
      <div
        className="relative mb-6 flex min-h-[520px] items-start justify-center overflow-hidden pt-4 sm:pt-6 xl:overflow-visible"
        style={{ perspective: 1200 }}
      >
        <div className="relative w-full max-w-2xl pb-16 sm:pb-20 xl:max-w-4xl">
          <AnimatePresence initial={false}>
            {cards.map(({ key, label, node }, i) => {
              // Depth of this card relative to the front card (0 = front).
              const depth = (i - clampedActive + count) % count;
              const isFront = depth === 0;
              // Every card keeps a faint physical presence so a 5-card deck never
              // feels like a single surface. Deep peeks stay quiet but readable.
              const peekY = isFront ? 0 : 14 + depth * 20;
              const peekScale = isFront ? 1 : Math.max(0.86, 1 - depth * 0.04);
              const peekOpacity = isFront ? 1 : Math.max(0.22, 0.7 - depth * 0.12);
              const peekBlur = isFront ? 0 : Math.min(2.2, 0.35 + depth * 0.45);
              const rawDirection = i - clampedActive;
              const mobileDirection =
                Math.abs(rawDirection) <= count / 2
                  ? rawDirection
                  : rawDirection - Math.sign(rawDirection) * count;
              // Mobile keeps horizontal swipe input, but presents selection changes
              // as a vertical scene: the next card peeks below and the previous above.
              const mobileY =
                mobileDirection === 0
                  ? 0
                  : mobileDirection < 0
                    ? "calc(-100% + 20px)"
                    : "calc(100% - 20px)";
              return (
                <motion.div
                  key={key}
                  layout={isDesktopStack}
                  drag={isFront && !isDesktopStack ? "x" : false}
                  dragControls={dragControls}
                  dragListener={false}
                  dragElastic={0.18}
                  dragMomentum={false}
                  className={isFront ? "action-stack-card-front touch-pan-y" : undefined}
                  initial={{
                    opacity: 0,
                    x: 0,
                    y: isDesktopStack ? 48 : mobileY,
                    scale: isDesktopStack ? 0.94 : 1,
                    filter: isDesktopStack ? "blur(4px)" : "blur(0px)",
                  }}
                  animate={{
                    opacity: isDesktopStack ? peekOpacity : isFront ? 1 : 0.48,
                    x: 0,
                    y: isDesktopStack ? peekY : mobileY,
                    scale: isDesktopStack ? peekScale : 1,
                    filter: isDesktopStack ? `blur(${peekBlur}px)` : "blur(0px)",
                  }}
                  exit={{
                    opacity: 0,
                    x: 0,
                    y: isDesktopStack ? 48 : mobileY,
                    scale: isDesktopStack ? 0.94 : 1,
                    filter: isDesktopStack ? "blur(4px)" : "blur(0px)",
                  }}
                  transition={{
                    type: "spring",
                    stiffness: 320,
                    damping: 34,
                    mass: 0.9,
                  }}
                  onPointerDownCapture={isFront ? startFrontDrag : undefined}
                  onDragEnd={(_, info) => {
                    const wasSuppressed = suppressDrag.current;
                    suppressDrag.current = false;
                    if (wasSuppressed || isDesktopStack) return;
                    if (Math.abs(info.offset.x) >= 70 || Math.abs(info.velocity.x) >= 500) {
                      go(info.offset.x < 0 ? 1 : -1);
                    }
                  }}
                  onClick={() => {
                    if (!isFront) selectIndex(i);
                  }}
                  style={{
                    zIndex: isDesktopStack
                      ? count - depth
                      : isFront
                        ? count
                        : count - Math.abs(mobileDirection),
                    pointerEvents: "auto",
                    cursor: isFront ? (isDesktopStack ? "default" : "grab") : "pointer",
                    // Behind cards stack in the same space; the front card owns flow.
                    position: isFront ? "relative" : "absolute",
                    inset: isFront ? undefined : 0,
                    width: "100%",
                    transformOrigin: "top center",
                  }}
                  aria-hidden={!isFront}
                  aria-label={isFront ? undefined : `Show ${label}`}
                >
                  {/* Soft veil on peeks so the front card stays the clear focus
                      without fully erasing what sits behind it. */}
                  {!isFront && (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-0 z-[2] rounded-[inherit] bg-background/25 dark:bg-background/35"
                    />
                  )}
                  {node}
                </motion.div>
              );
            })}
          </AnimatePresence>

          {/* Desktop vertical controls — anchored to the card column's right
              edge (left-full + gap) so the rail tracks the deck at any width,
              no hardcoded viewport offset. */}
          {count > 1 && (
            <div className="pointer-events-auto absolute top-20 left-full z-10 ml-6 hidden flex-col items-center justify-center gap-3 xl:flex">
              <Button
                variant="ghost"
                size="icon"
                className="zen-input size-10 rounded-full border shadow-sm transition-[scale,background-color] active:scale-[0.96]"
                onClick={() => go(-1)}
                aria-label="Previous card"
              >
                <ChevronLeft className="size-4 rotate-90" />
              </Button>
              <div className="zen-input flex flex-col items-center rounded-full border px-1 py-2 shadow-sm">
                {cards.map(({ key, label }, i) => {
                  const isActive = i === clampedActive;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => selectIndex(i)}
                      aria-label={`Show ${label}`}
                      aria-current={isActive}
                      className="grid size-10 place-items-center rounded-full transition-colors hover:bg-foreground/5"
                    >
                      <motion.span
                        layout
                        animate={{
                          height: isActive ? 22 : 7,
                          width: 6,
                          opacity: isActive ? 1 : 0.55,
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 400,
                          damping: 30,
                        }}
                        className="block rounded-full bg-foreground"
                      />
                    </button>
                  );
                })}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="zen-input size-10 rounded-full border shadow-sm transition-[scale,background-color] active:scale-[0.96]"
                onClick={() => go(1)}
                aria-label="Next card"
              >
                <ChevronRight className="size-4 rotate-90" />
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Quiet mobile position status and direct-access dots. */}
      {count > 1 && (
        <div className="pointer-events-auto relative z-10 mt-2 flex flex-col items-center pb-6 xl:hidden">
          <div className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{cards[clampedActive]?.label}</span>
            <span className="mx-1.5" aria-hidden>
              ·
            </span>
            <span className="tabular-nums">
              {clampedActive + 1} of {count}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-center" aria-label="Choose a card">
            {cards.map(({ key, label }, i) => {
              const isActive = i === clampedActive;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => selectIndex(i)}
                  aria-label={`Show ${label}`}
                  aria-current={isActive ? "true" : undefined}
                  className="grid size-10 place-items-center rounded-full transition-colors hover:bg-foreground/5"
                >
                  <motion.span
                    layout
                    animate={{
                      width: isActive ? 22 : 7,
                      height: 6,
                      opacity: isActive ? 1 : 0.45,
                    }}
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    className="block rounded-full bg-foreground"
                  />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Draggable water slider — fill, thumb, and the invisible native range input
// share the same 0..max scale; the day's target is shown as a tick.
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
  const tone = ratio >= 0.8 ? "bg-success" : ratio >= 0.4 ? "bg-warning" : "bg-info";
  return (
    <div className="relative flex flex-1 items-center py-2">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
        <div className={`h-full transition-[width] ${tone}`} style={{ width: `${valuePct}%` }} />
      </div>
      <div
        className="pointer-events-none absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/40"
        style={{ left: `${targetPct}%` }}
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-info shadow transition-[left]"
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
