import {
  dayBoundsLocal,
  isTimestampOnLocalDay,
  lastNDatesISO,
  mlToFlOz,
  mondayOfISO,
  toISOWeek,
  weekDatesISO,
  type DailyFinanceSnapshot,
  type DailyNutrition,
  type DailyPlan,
  type ISODate,
  type ProductivityTask,
  type Transaction,
  type VoiceTranscript,
  type WorkoutSession,
} from "@/lib/domain";

export type AnalyticsRange = 7 | 14 | 30;

export interface ReviewDashboard {
  productivity?: { tasks: ProductivityTask[] } | null;
  nutrition?: Pick<DailyNutrition, "mealLogs" | "totals" | "waterMl"> | null;
  finance?: Pick<DailyFinanceSnapshot, "netWorth"> | null;
  plan?: Pick<DailyPlan, "nutritionTargets" | "eveningCheckIn"> | null;
  recent?: { transcripts: VoiceTranscript[] } | null;
}

export interface WeekStats {
  tasksCompleted: number;
  tasksTotal: number;
  workouts: number;
  avgProteinPct: number;
  avgWaterOz: number;
  netWorth: number;
  activeDays: number;
  checkInDays: number;
  avgEnergy: number;
  avgDayRating: number;
  checkInWins: string[];
  checkInFrictions: string[];
  perDayCompletion: { date: ISODate; pct: number; total: number }[];
}

export interface DayPoint {
  date: ISODate;
  completionPct: number;
  tasksTotal: number;
  proteinPct: number;
  waterOz: number;
  netWorth: number;
  workouts: number;
  cashflow: number;
}

type SessionWindowItem = Pick<WorkoutSession, "performedAt" | "deletedAt">;
type CashflowItem = Pick<Transaction, "timestamp" | "amount" | "categoryGroup" | "deletedAt">;

export function reduceWeeklyData(
  dates: ISODate[],
  dashboards: ReviewDashboard[],
  sessions: SessionWindowItem[],
): WeekStats {
  let tasksCompleted = 0;
  let tasksTotal = 0;
  let proteinPctSum = 0;
  let proteinDays = 0;
  let waterSum = 0;
  let waterDays = 0;
  let netWorth = 0;
  let activeDays = 0;
  let checkInDays = 0;
  let energySum = 0;
  let dayRatingSum = 0;
  const checkInWins: string[] = [];
  const checkInFrictions: string[] = [];
  const perDayCompletion: WeekStats["perDayCompletion"] = [];

  dashboards.forEach((dash, index) => {
    const tasks = (dash.productivity?.tasks ?? []).filter((task) => !task.deletedAt);
    const done = tasks.filter((task) => task.done).length;
    tasksTotal += tasks.length;
    tasksCompleted += done;
    perDayCompletion.push({
      date: dates[index],
      pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
      total: tasks.length,
    });

    const protein = dash.nutrition?.totals.protein ?? 0;
    const target = dash.plan?.nutritionTargets?.protein ?? 150;
    if (protein > 0) {
      proteinPctSum += Math.min(100, Math.round((protein / Math.max(1, target)) * 100));
      proteinDays++;
    }
    const water = dash.nutrition?.waterMl ?? 0;
    if (water > 0) {
      waterSum += water;
      waterDays++;
    }
    if (dash.finance?.netWorth) netWorth = dash.finance.netWorth;
    const checkIn = dash.plan?.eveningCheckIn;
    if (checkIn) {
      checkInDays++;
      energySum += checkIn.energy;
      dayRatingSum += checkIn.dayRating;
      if (checkIn.win) checkInWins.push(checkIn.win);
      if (checkIn.friction) checkInFrictions.push(checkIn.friction);
    }

    if (
      tasks.length > 0 ||
      (dash.nutrition?.mealLogs.length ?? 0) > 0 ||
      water > 0 ||
      (dash.recent?.transcripts.length ?? 0) > 0 ||
      !!checkIn
    ) {
      activeDays++;
    }
  });

  const monday = dates[0];
  const sunday = dates[dates.length - 1];
  const weekStart = monday ? dayBoundsLocal(monday).start : 0;
  const weekEnd = sunday ? dayBoundsLocal(sunday).end : -1;
  const workouts = sessions.filter(
    (session) =>
      !session.deletedAt && session.performedAt >= weekStart && session.performedAt <= weekEnd,
  ).length;

  return {
    tasksCompleted,
    tasksTotal,
    workouts,
    avgProteinPct: proteinDays ? Math.round(proteinPctSum / proteinDays) : 0,
    avgWaterOz: mlToFlOz(waterDays ? Math.round(waterSum / waterDays) : 0) ?? 0,
    netWorth,
    activeDays,
    checkInDays,
    avgEnergy: checkInDays ? Math.round((energySum / checkInDays) * 10) / 10 : 0,
    avgDayRating: checkInDays ? Math.round((dayRatingSum / checkInDays) * 10) / 10 : 0,
    checkInWins,
    checkInFrictions,
    perDayCompletion,
  };
}

export function reduceAnalyticsData(
  dates: ISODate[],
  dashboards: ReviewDashboard[],
  sessions: SessionWindowItem[],
  transactions: CashflowItem[],
): DayPoint[] {
  const activeSessions = sessions.filter((session) => !session.deletedAt);
  const activeTransactions = transactions.filter((transaction) => !transaction.deletedAt);

  return dashboards.map((dash, index) => {
    const date = dates[index];
    const tasks = (dash.productivity?.tasks ?? []).filter((task) => !task.deletedAt);
    const done = tasks.filter((task) => task.done).length;
    const protein = dash.nutrition?.totals.protein ?? 0;
    const target = dash.plan?.nutritionTargets?.protein ?? 150;

    return {
      date,
      completionPct: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
      tasksTotal: tasks.length,
      proteinPct:
        protein > 0 ? Math.min(100, Math.round((protein / Math.max(1, target)) * 100)) : 0,
      waterOz: mlToFlOz(dash.nutrition?.waterMl ?? 0) ?? 0,
      netWorth: dash.finance?.netWorth ?? 0,
      workouts: activeSessions.filter((session) => isTimestampOnLocalDay(session.performedAt, date))
        .length,
      cashflow: activeTransactions
        .filter(
          (transaction) =>
            transaction.categoryGroup !== "transfer" &&
            isTimestampOnLocalDay(transaction.timestamp, date),
        )
        .reduce((sum, transaction) => sum + transaction.amount, 0),
    };
  });
}

export async function loadWeeklyData<TReview>(
  anchor: ISODate,
  loaders: {
    loadDashboard: (date: ISODate) => Promise<ReviewDashboard>;
    loadSessions: () => Promise<{ sessions: SessionWindowItem[] }>;
    loadReview: (week: string) => Promise<TReview>;
  },
): Promise<{ stats: WeekStats; review: TReview }> {
  const dates = weekDatesISO(anchor);
  const week = toISOWeek(mondayOfISO(anchor));
  const [dashboards, sessionStore, review] = await Promise.all([
    Promise.all(dates.map(loaders.loadDashboard)),
    loaders.loadSessions(),
    loaders.loadReview(week),
  ]);
  return { stats: reduceWeeklyData(dates, dashboards, sessionStore.sessions), review };
}

export async function loadAnalyticsRange(
  range: AnalyticsRange,
  loaders: {
    loadDashboard: (date: ISODate) => Promise<ReviewDashboard>;
    loadSessions: () => Promise<{ sessions: SessionWindowItem[] }>;
    loadTransactions: () => Promise<{ transactions: CashflowItem[] }>;
  },
  end: ISODate,
): Promise<DayPoint[]> {
  const dates = lastNDatesISO(range, end);
  const [dashboards, sessionStore, transactionStore] = await Promise.all([
    Promise.all(dates.map(loaders.loadDashboard)),
    loaders.loadSessions(),
    loaders.loadTransactions(),
  ]);
  return reduceAnalyticsData(
    dates,
    dashboards,
    sessionStore.sessions,
    transactionStore.transactions,
  );
}
