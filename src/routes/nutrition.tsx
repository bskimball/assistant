import { createFileRoute } from "@tanstack/react-router";
import { useState, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { nutritionQuery, userProfileQuery, queryKeys } from "@/lib/queries";
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
  Minus,
  Plus,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Reveal, revealDelay } from "@/components/motion";
import { saveDailyNutrition } from "@/server/domain";
import { estimateFoodMacros } from "@/server/coach";
import {
  flOzToMl,
  mlToFlOz,
  newId,
  todayISO,
  toISODate,
  type MealLog,
  type ISODate,
} from "@/lib/domain";

export const Route = createFileRoute("/nutrition")({
  validateSearch: (search: Record<string, unknown>): { date?: string } => {
    const raw = typeof search.date === "string" ? search.date : undefined;
    const valid = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
    return { date: valid };
  },
  loaderDeps: ({ search }) => ({ date: search.date }),
  loader: ({ context: { queryClient }, deps }) => {
    const date = (deps.date as ISODate) || todayISO();
    return Promise.all([
      queryClient.ensureQueryData(nutritionQuery(date)),
      queryClient.ensureQueryData(userProfileQuery()),
    ]);
  },
  component: NutritionPage,
});

type Targets = { calories: number; protein: number; waterOz: number };
const DEFAULT_TARGETS: Targets = { calories: 2000, protein: 150, waterOz: 85 };

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

  const queryClient = useQueryClient();
  // Primed by the loader (keyed on the selected date) → instant on revisit.
  const { data: nutrition = null, isPending: loading } = useQuery(nutritionQuery(selectedDate));
  const profileQuery = useQuery(userProfileQuery());
  const targets: Targets = {
    calories: profileQuery.data?.calorieTargetKcal ?? DEFAULT_TARGETS.calories,
    protein: profileQuery.data?.proteinTargetG ?? DEFAULT_TARGETS.protein,
    waterOz: mlToFlOz(profileQuery.data?.waterTargetMl) ?? DEFAULT_TARGETS.waterOz,
  };

  const [foodName, setFoodName] = useState("");
  const [foodEstimating, setFoodEstimating] = useState(false);
  // While dragging the water slider we hold the in-flight oz value here so the
  // fill follows the thumb; we commit to the server on release.
  const [waterDraft, setWaterDraft] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function flashStatus(msg: string, ms = 3000) {
    setStatus(msg);
    setTimeout(() => setStatus(null), ms);
  }

  function shiftDay(delta: number) {
    const d = new Date(selectedDate + "T00:00:00");
    d.setDate(d.getDate() + delta);
    navigate({ search: { date: toISODate(d) } });
  }

  // Timestamp for a new entry: "now" for today, otherwise the selected day at
  // the current wall-clock time so back-dated entries sort and display sanely.
  function entryTimestamp() {
    if (isToday) return Date.now();
    const now = new Date();
    const d = new Date(selectedDate + "T00:00:00");
    d.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
    return d.getTime();
  }

  // Persist a new mealLogs/waterMl set; the server recomputes totals.
  async function persist(next: { mealLogs: MealLog[]; waterMl?: number }) {
    const saved = await saveDailyNutrition({
      data: {
        date: selectedDate,
        nutrition: {
          mealLogs: next.mealLogs,
          totals: nutrition?.totals || {
            calories: 0,
            protein: 0,
            carbs: 0,
            fat: 0,
          },
          waterMl: next.waterMl,
        },
      },
    });
    // We have the authoritative saved doc — write it straight into the cache so
    // the UI updates instantly (no refetch needed).
    queryClient.setQueryData(queryKeys.nutrition(selectedDate), saved);
    return saved;
  }

  async function handleAddFood(e?: React.SyntheticEvent) {
    if (e) e.preventDefault();
    const description = foodName.trim();
    if (!description || foodEstimating) return;
    setFoodEstimating(true);
    setStatus("Looking up nutrition…");
    try {
      const est = await estimateFoodMacros({ data: { description } });
      const now = entryTimestamp();
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
      flashStatus(
        "Couldn’t estimate that food right now — add calories/macros or check the AI key.",
      );
    } finally {
      setFoodEstimating(false);
    }
  }

  // Set the day's water to an absolute oz total (clamped at 0).
  async function setWaterOz(totalOz: number) {
    if (busy) return;
    const oz = Math.max(0, Math.round(totalOz));
    setBusy(true);
    try {
      const saved = await persist({
        mealLogs: nutrition?.mealLogs || [],
        waterMl: flOzToMl(oz) ?? 0,
      });
      flashStatus(`Water set to ${mlToFlOz(saved.waterMl) ?? 0} fl oz`);
    } catch (err) {
      console.error("[nutrition] set water failed", err);
      flashStatus("Couldn’t update water — try again.");
    } finally {
      setBusy(false);
    }
  }

  // Commit the dragged slider value, then clear the draft so the bar tracks
  // the persisted total again.
  function commitWaterDraft() {
    if (waterDraft == null) return;
    void setWaterOz(waterDraft).finally(() => setWaterDraft(null));
  }

  async function handleDeleteMeal(id: string) {
    if (busy) return;
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

  const totals = nutrition?.totals || {
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
  };
  const waterOz = mlToFlOz(nutrition?.waterMl ?? 0) ?? 0;
  // The slider shows the draft while dragging, otherwise the persisted total.
  const displayWaterOz = waterDraft ?? waterOz;
  // Headroom above target (and current) so you can overshoot, rounded to 4 oz.
  const waterSliderMax = Math.max(
    Math.ceil((targets.waterOz * 1.5) / 4) * 4,
    Math.ceil(displayWaterOz / 4) * 4,
    8,
  );
  const meals = (nutrition?.mealLogs || [])
    .filter((m) => !m.deletedAt)
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className="bg-background px-4 pb-28 pt-8 sm:px-6 sm:pb-16">
      <div className="mx-auto w-full max-w-page">
        {/* Header + date nav */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs uppercase tracking-[2px] text-muted-foreground">Nutrition</div>
            <div className="text-3xl font-semibold tracking-tighter">{dateLabel}</div>
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
                    if (v)
                      navigate({
                        search: { date: v === today ? undefined : v },
                      });
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
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MacroTile
            icon={Flame}
            label="Calories"
            value={totals.calories}
            target={targets.calories}
            unit="cal"
            goal="under"
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
                {displayWaterOz} / {targets.waterOz} fl oz
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="size-9 shrink-0"
                disabled={busy || displayWaterOz <= 0}
                onClick={() => setWaterOz(waterOz - 4)}
                aria-label="Remove 4 fl oz"
              >
                <Minus className="size-4" />
              </Button>
              <WaterSlider
                value={displayWaterOz}
                target={targets.waterOz}
                max={waterSliderMax}
                disabled={busy}
                onDraft={setWaterDraft}
                onCommit={commitWaterDraft}
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="size-9 shrink-0"
                disabled={busy}
                onClick={() => setWaterOz(waterOz + 4)}
                aria-label="Add 4 fl oz"
              >
                <Plus className="size-4" />
              </Button>
            </div>
            <div className="mt-2 text-center text-[11px] text-muted-foreground">
              Drag the bar or use −/+ to adjust in 4 fl oz steps.
            </div>
          </CardContent>
        </Card>

        {/* Add food */}
        <Card className="mb-6">
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
              <Button type="submit" className="gap-1" disabled={!foodName.trim() || foodEstimating}>
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

        {/* Meals */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              <span>{isToday ? "Today’s log" : "Log"}</span>
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
                {meals.map((m, mi) => {
                  const items = m.foodItems || [];
                  const cals = items.reduce((s, i) => s + (i.macros?.calories ?? 0), 0);
                  return (
                    <Reveal
                      as="li"
                      key={m.id}
                      delay={revealDelay(mi)}
                      className="py-3 first:pt-0 last:pb-0"
                    >
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
                              <Badge
                                variant="secondary"
                                className="text-[10px] uppercase tracking-wide text-muted-foreground"
                              >
                                {m.estimateConfidence}
                              </Badge>
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
                      </div>
                    </Reveal>
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

function Progress({
  value,
  target,
  goal = "hit",
}: {
  value: number;
  target: number;
  // "hit" = higher is better (protein, water); "under" = stay below (calories).
  goal?: "hit" | "under";
}) {
  const ratio = value / Math.max(1, target);
  const pct = Math.min(100, Math.round(ratio * 100));
  const over = goal === "under" && ratio > 1.05;
  const tone = over
    ? "bg-destructive"
    : pct >= 80
      ? "bg-emerald-500"
      : pct >= 40
        ? "bg-amber-500"
        : "bg-primary";
  return (
    <div className="h-2 w-full overflow-hidden rounded bg-muted">
      <div className={`h-full transition-all ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function MacroTile({
  icon: Icon,
  label,
  value,
  target,
  unit,
  goal = "hit",
}: {
  icon: typeof Utensils;
  label: string;
  value: number;
  target?: number;
  unit: string;
  goal?: "hit" | "under";
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
              <Progress value={value} target={target} goal={goal} />
            </div>
            <div className="mt-1 text-[11px] tabular-nums text-muted-foreground">
              of {target} {unit}
            </div>
          </>
        ) : (
          // Carbs/Fat have no target — keep the tile the same height with a muted
          // track so the row reads as intentional rather than half-finished.
          <>
            <div className="mt-1.5 h-2 w-full rounded bg-muted/40" />
            <div className="mt-1 text-[11px] text-muted-foreground">no target set</div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
