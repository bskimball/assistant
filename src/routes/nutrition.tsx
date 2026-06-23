import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  Utensils,
  Droplet,
  Flame,
  Beef,
  Wheat,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  RefreshCw,
  Trash2,
  ArrowLeft,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loadDailyNutrition, loadUserProfile, saveDailyNutrition } from "@/server/domain";
import { estimateFoodMacros } from "@/server/coach";
import {
  flOzToMl,
  mlToFlOz,
  newId,
  todayISO,
  toISODate,
  type DailyNutrition,
  type MealLog,
  type ISODate,
} from "@/lib/domain";

export const Route = createFileRoute("/nutrition")({
  validateSearch: (search: Record<string, unknown>): { date?: string } => {
    const raw = typeof search.date === "string" ? search.date : undefined;
    const valid = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
    return { date: valid };
  },
  component: NutritionPage,
});

type Targets = { calories: number; protein: number; waterOz: number };
const DEFAULT_TARGETS: Targets = { calories: 2000, protein: 150, waterOz: 85 };

const WATER_QUICK_ADD = [8, 16, 24];

function NutritionPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const dateInputRef = useRef<HTMLInputElement>(null);

  const today = todayISO();
  const selectedDate: ISODate = (search.date as ISODate) || today;
  const isToday = selectedDate === today;
  const dateLabel = new Date(selectedDate + "T00:00:00").toLocaleDateString([], {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  const [nutrition, setNutrition] = useState<DailyNutrition | null>(null);
  const [targets, setTargets] = useState<Targets>(DEFAULT_TARGETS);
  const [loading, setLoading] = useState(false);

  const [foodName, setFoodName] = useState("");
  const [foodEstimating, setFoodEstimating] = useState(false);
  const [customWater, setCustomWater] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [n, profile] = await Promise.all([
        loadDailyNutrition({ data: selectedDate }),
        loadUserProfile(),
      ]);
      setNutrition(n);
      setTargets({
        calories: profile.calorieTargetKcal ?? DEFAULT_TARGETS.calories,
        protein: profile.proteinTargetG ?? DEFAULT_TARGETS.protein,
        waterOz: mlToFlOz(profile.waterTargetMl) ?? DEFAULT_TARGETS.waterOz,
      });
    } catch (e) {
      console.error("[nutrition] load failed", e);
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    void load();
  }, [load]);

  function flashStatus(msg: string, ms = 3000) {
    setStatus(msg);
    setTimeout(() => setStatus(null), ms);
  }

  function shiftDay(delta: number) {
    const d = new Date(selectedDate + "T00:00:00");
    d.setDate(d.getDate() + delta);
    navigate({ search: { date: toISODate(d) } });
  }

  // Persist a new mealLogs/waterMl set; the server recomputes totals.
  async function persist(next: { mealLogs: MealLog[]; waterMl?: number }) {
    const saved = await saveDailyNutrition({
      data: {
        date: selectedDate,
        nutrition: {
          mealLogs: next.mealLogs,
          totals: nutrition?.totals || { calories: 0, protein: 0, carbs: 0, fat: 0 },
          waterMl: next.waterMl,
        },
      },
    });
    setNutrition(saved);
    return saved;
  }

  async function handleAddFood(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const description = foodName.trim();
    if (!description || foodEstimating || !isToday) return;
    setFoodEstimating(true);
    setStatus("Looking up nutrition…");
    try {
      const est = await estimateFoodMacros({ data: { description } });
      const now = Date.now();
      const mealLog: MealLog = {
        id: newId("meal"),
        timestamp: now,
        foodItems: [
          {
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
            source: "custom",
          },
        ],
        estimateConfidence: est.confidence,
        createdAt: now,
        updatedAt: now,
      };
      await persist({
        mealLogs: [...(nutrition?.mealLogs || []), mealLog],
        waterMl: nutrition?.waterMl,
      });
      setFoodName("");
      flashStatus(
        `Logged ${est.name} — ${est.calories} cal, ${est.protein}g protein` +
          (est.generatedBy === "fallback" ? " (rough estimate)" : ""),
        4000,
      );
    } catch (err) {
      console.error("[nutrition] add food failed", err);
      flashStatus("Couldn’t log that food — try again.");
    } finally {
      setFoodEstimating(false);
    }
  }

  async function handleAddWater(oz: number) {
    if (!isToday || busy) return;
    const addMl = flOzToMl(oz);
    if (!addMl) return;
    setBusy(true);
    try {
      const saved = await persist({
        mealLogs: nutrition?.mealLogs || [],
        waterMl: (nutrition?.waterMl ?? 0) + addMl,
      });
      flashStatus(`Logged ${oz} fl oz — ${mlToFlOz(saved.waterMl) ?? 0} fl oz today`);
    } catch (err) {
      console.error("[nutrition] add water failed", err);
      flashStatus("Couldn’t log water — try again.");
    } finally {
      setBusy(false);
    }
  }

  function handleCustomWater(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const oz = Number(customWater);
    if (!Number.isFinite(oz) || oz <= 0) return;
    setCustomWater("");
    void handleAddWater(Math.round(oz));
  }

  async function handleDeleteMeal(id: string) {
    if (!isToday || busy) return;
    setBusy(true);
    try {
      await persist({
        mealLogs: (nutrition?.mealLogs || []).filter((m) => m.id !== id),
        waterMl: nutrition?.waterMl,
      });
      flashStatus("Removed.");
    } catch (err) {
      console.error("[nutrition] delete meal failed", err);
      flashStatus("Couldn’t remove that entry — try again.");
    } finally {
      setBusy(false);
    }
  }

  const totals = nutrition?.totals || { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const waterOz = mlToFlOz(nutrition?.waterMl ?? 0) ?? 0;
  const meals = (nutrition?.mealLogs || [])
    .filter((m) => !m.deletedAt)
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className="min-h-dvh bg-background px-4 pb-24 pt-6 sm:px-6">
      <div className="mx-auto w-full max-w-page">
        {/* Header + date nav */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link
              to="/"
              search={{ date: isToday ? undefined : selectedDate }}
              className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" /> Dashboard
            </Link>
            <div className="text-xs uppercase tracking-[2px] text-muted-foreground">Nutrition</div>
            <div className="flex items-center gap-2 text-3xl font-semibold tracking-tighter">
              <Utensils className="size-7 text-primary" /> {dateLabel}
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Button
              variant={isToday ? "default" : "outline"}
              size="sm"
              onClick={() => navigate({ search: { date: undefined } })}
              disabled={isToday}
              className="h-8 shrink-0 gap-1.5 disabled:opacity-100"
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
                onClick={() => shiftDay(-1)}
                aria-label="Previous day"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <div className="relative flex-1 sm:flex-none">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => dateInputRef.current?.showPicker?.()}
                  className="h-8 w-full justify-center gap-1.5 font-medium tabular-nums sm:w-auto sm:min-w-[150px]"
                  aria-label="Pick a day"
                >
                  <CalendarDays className="size-3.5 text-muted-foreground" />
                  {selectedDate}
                </Button>
                <input
                  ref={dateInputRef}
                  type="date"
                  max={today}
                  value={selectedDate}
                  onChange={(e) => {
                    const v = e.target.value as ISODate;
                    if (v) navigate({ search: { date: v === today ? undefined : v } });
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
                onClick={() => shiftDay(1)}
                disabled={isToday}
                aria-label="Next day"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Macro summary tiles */}
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MacroTile
            icon={Flame}
            label="Calories"
            value={totals.calories}
            target={targets.calories}
            unit="cal"
          />
          <MacroTile
            icon={Beef}
            label="Protein"
            value={totals.protein}
            target={targets.protein}
            unit="g"
          />
          <MacroTile icon={Wheat} label="Carbs" value={totals.carbs} unit="g" />
          <MacroTile icon={Utensils} label="Fat" value={totals.fat} unit="g" />
        </div>

        {/* Water */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              <span className="flex items-center gap-2">
                <Droplet className="size-4 text-primary" /> Water
              </span>
              <span className="tabular-nums text-sm text-muted-foreground">
                {waterOz} / {targets.waterOz} fl oz
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Progress value={waterOz} target={targets.waterOz} />
            {isToday && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {WATER_QUICK_ADD.map((oz) => (
                  <Button
                    key={oz}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-1"
                    disabled={busy}
                    onClick={() => handleAddWater(oz)}
                  >
                    <Droplet className="size-3.5" /> +{oz} oz
                  </Button>
                ))}
                <form onSubmit={handleCustomWater} className="flex items-center gap-1.5">
                  <Input
                    value={customWater}
                    onChange={(e) => setCustomWater(e.target.value)}
                    inputMode="numeric"
                    placeholder="oz"
                    className="h-8 w-16"
                    disabled={busy}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={busy || !customWater.trim()}
                  >
                    Add
                  </Button>
                </form>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Add food */}
        {isToday && (
          <Card className="mb-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="size-4 text-primary" /> Log food
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleAddFood} className="flex items-center gap-2">
                <Input
                  value={foodName}
                  onChange={(e) => setFoodName(e.target.value)}
                  placeholder="e.g. 6oz grilled chicken breast, 1 cup white rice…"
                  className="flex-1"
                  disabled={foodEstimating}
                />
                <Button
                  type="submit"
                  className="gap-1"
                  disabled={!foodName.trim() || foodEstimating}
                >
                  {foodEstimating ? (
                    <RefreshCw className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  {foodEstimating ? "Estimating…" : "Add"}
                </Button>
              </form>
              <div className="mt-2 text-[11px] text-muted-foreground">
                {status ?? "The AI estimates calories & macros from your description."}
              </div>
            </CardContent>
          </Card>
        )}
        {!isToday && status && (
          <div className="mb-4 text-[11px] text-muted-foreground">{status}</div>
        )}

        {/* Meals */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              <span>Today’s log</span>
              <span className="text-sm font-normal text-muted-foreground">
                {meals.length} {meals.length === 1 ? "entry" : "entries"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading && !nutrition ? (
              <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
            ) : meals.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Nothing logged {isToday ? "yet today" : "this day"}.
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {meals.map((m) => {
                  const items = m.foodItems || [];
                  const cals = items.reduce((s, i) => s + (i.macros?.calories ?? 0), 0);
                  return (
                    <li key={m.id} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {new Date(m.timestamp).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                            {m.estimateConfidence && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                {m.estimateConfidence}
                              </span>
                            )}
                          </div>
                          <ul className="mt-1 space-y-0.5">
                            {items.map((it) => (
                              <li
                                key={it.id}
                                className="flex items-baseline justify-between gap-2 text-sm"
                              >
                                <span className="truncate">
                                  {it.name}
                                  {it.quantity ? (
                                    <span className="text-muted-foreground">
                                      {" "}
                                      · {it.quantity}
                                      {it.unit ? ` ${it.unit}` : ""}
                                    </span>
                                  ) : null}
                                </span>
                                <span className="shrink-0 tabular-nums text-muted-foreground">
                                  {it.macros?.calories ?? 0} cal · {it.macros?.protein ?? 0}p ·{" "}
                                  {it.macros?.carbs ?? 0}c · {it.macros?.fat ?? 0}f
                                </span>
                              </li>
                            ))}
                          </ul>
                          {items.length > 1 && (
                            <div className="mt-1 text-xs tabular-nums text-muted-foreground">
                              Total: {cals} cal
                            </div>
                          )}
                        </div>
                        {isToday && (
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                            disabled={busy}
                            onClick={() => handleDeleteMeal(m.id)}
                            aria-label="Remove entry"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Progress({ value, target }: { value: number; target: number }) {
  const pct = Math.min(100, Math.round((value / Math.max(1, target)) * 100));
  return (
    <div className="h-2 w-full overflow-hidden rounded bg-muted">
      <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

function MacroTile({
  icon: Icon,
  label,
  value,
  target,
  unit,
}: {
  icon: typeof Utensils;
  label: string;
  value: number;
  target?: number;
  unit: string;
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5" /> {label}
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">
          {value}
          <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span>
        </div>
        {target ? (
          <>
            <div className="mt-1.5">
              <Progress value={value} target={target} />
            </div>
            <div className="mt-1 text-[11px] tabular-nums text-muted-foreground">
              of {target} {unit}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
