import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  User,
  Target,
  Dumbbell,
  Utensils,
  Wallet,
  Save,
  Check,
  Calendar as CalendarIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { loadUserProfile, saveUserProfile } from "@/server/domain";
import { generateCoaching } from "@/server/coach";
import {
  cmToInches,
  computeAge,
  flOzToMl,
  inchesToCm,
  mlToFlOz,
  toISODate,
  WORKOUT_STYLES,
  type UserProfile,
  type WorkoutStyle,
} from "@/lib/domain";

// User Profile settings (ADR-013): the personalization context the Coach Engine
// reads. Grouped by the four advisor lenses so it mirrors how the coach reasons.

export const Route = createFileRoute("/profile")({
  component: ProfilePage,
});

/** Form mirror of UserProfile — all values are strings for controlled inputs. */
type Form = {
  displayName: string;
  birthDate: string;
  sex: string;
  heightIn: string;
  units: string;
  timezone: string;
  goals: string;
  activityLevel: string;
  injuries: string;
  trainingDaysPerWeek: string;
  equipmentAccess: string;
  preferredWorkoutStyles: WorkoutStyle[];
  dietaryRestrictions: string;
  proteinTargetG: string;
  calorieTargetKcal: string;
  waterTargetOz: string;
  riskTolerance: string;
  monthlySavingsGoal: string;
  financeNotes: string;
};

const EMPTY: Form = {
  displayName: "",
  birthDate: "",
  sex: "",
  heightIn: "",
  units: "imperial",
  timezone: "",
  goals: "",
  activityLevel: "",
  injuries: "",
  trainingDaysPerWeek: "",
  equipmentAccess: "",
  preferredWorkoutStyles: [],
  dietaryRestrictions: "",
  proteinTargetG: "",
  calorieTargetKcal: "",
  waterTargetOz: "",
  riskTolerance: "",
  monthlySavingsGoal: "",
  financeNotes: "",
};

const csv = (arr?: string[]) => (arr?.length ? arr.join(", ") : "");
const fromCsv = (s: string): string[] | undefined => {
  const items = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
};
const num = (s: string): number | undefined => {
  const n = parseFloat(s);
  return s.trim() !== "" && !isNaN(n) ? n : undefined;
};
const str = (s: string): string | undefined => (s.trim() ? s.trim() : undefined);

function profileToForm(p: UserProfile): Form {
  return {
    displayName: p.displayName ?? "",
    birthDate: p.birthDate ?? "",
    sex: p.sex ?? "",
    heightIn: cmToInches(p.heightCm)?.toString() ?? "",
    units: p.units ?? "imperial",
    timezone: p.timezone ?? "",
    goals: csv(p.goals),
    activityLevel: p.activityLevel ?? "",
    injuries: csv(p.injuries),
    trainingDaysPerWeek: p.trainingDaysPerWeek?.toString() ?? "",
    equipmentAccess: csv(p.equipmentAccess),
    preferredWorkoutStyles: p.preferredWorkoutStyles ?? [],
    dietaryRestrictions: csv(p.dietaryRestrictions),
    proteinTargetG: p.proteinTargetG?.toString() ?? "",
    calorieTargetKcal: p.calorieTargetKcal?.toString() ?? "",
    waterTargetOz: mlToFlOz(p.waterTargetMl)?.toString() ?? "",
    riskTolerance: p.riskTolerance ?? "",
    monthlySavingsGoal: p.monthlySavingsGoal?.toString() ?? "",
    financeNotes: p.financeNotes ?? "",
  };
}

function formToProfile(f: Form): Partial<UserProfile> {
  return {
    displayName: str(f.displayName),
    birthDate: str(f.birthDate),
    sex: (str(f.sex) as UserProfile["sex"]) ?? undefined,
    heightCm: inchesToCm(num(f.heightIn)),
    units: (str(f.units) as UserProfile["units"]) ?? "imperial",
    timezone: str(f.timezone),
    goals: fromCsv(f.goals),
    activityLevel: (str(f.activityLevel) as UserProfile["activityLevel"]) ?? undefined,
    injuries: fromCsv(f.injuries),
    trainingDaysPerWeek: num(f.trainingDaysPerWeek),
    equipmentAccess: fromCsv(f.equipmentAccess),
    preferredWorkoutStyles: f.preferredWorkoutStyles.length ? f.preferredWorkoutStyles : undefined,
    dietaryRestrictions: fromCsv(f.dietaryRestrictions),
    proteinTargetG: num(f.proteinTargetG),
    calorieTargetKcal: num(f.calorieTargetKcal),
    waterTargetMl: flOzToMl(num(f.waterTargetOz)),
    riskTolerance: (str(f.riskTolerance) as UserProfile["riskTolerance"]) ?? undefined,
    monthlySavingsGoal: num(f.monthlySavingsGoal),
    financeNotes: str(f.financeNotes),
  };
}

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * A labelled form row. Defined at module scope (NOT inside ProfilePage) — a
 * component declared inline would get a new identity on every render, causing
 * React to remount its subtree and steal focus from inputs on each keystroke.
 */
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Parse a "YYYY-MM-DD" string to a local Date (or undefined if malformed). */
function parseISODate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return Number.isNaN(dt.getTime()) ? undefined : dt;
}

/** shadcn date picker (Popover + Calendar) with a year dropdown for fast birth-year selection. */
function BirthDatePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = parseISODate(value);
  const today = new Date();
  const label = selected
    ? selected.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
    : "Pick a date";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-9 w-full justify-start gap-2 px-3 font-normal",
            !selected && "text-muted-foreground",
          )}
        >
          <CalendarIcon className="size-4 text-muted-foreground" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected ?? new Date(today.getFullYear() - 30, today.getMonth())}
          captionLayout="dropdown"
          startMonth={new Date(1920, 0)}
          endMonth={new Date(today.getFullYear(), 11)}
          disabled={{ after: today }}
          onSelect={(date) => {
            if (date) {
              onChange(toISODate(date));
              setOpen(false);
            }
          }}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}

function ProfilePage() {
  const [form, setForm] = useState<Form>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    loadUserProfile()
      .then((p) => {
        if (active) setForm(profileToForm(p));
      })
      .catch((e) => console.warn("[profile] load failed", e))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  function set<K extends keyof Form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setSavedAt(null);
  }

  function toggleWorkoutStyle(style: WorkoutStyle) {
    setForm((f) => ({
      ...f,
      preferredWorkoutStyles: f.preferredWorkoutStyles.includes(style)
        ? f.preferredWorkoutStyles.filter((s) => s !== style)
        : [...f.preferredWorkoutStyles, style],
    }));
    setSavedAt(null);
  }

  async function handleSave(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setSaving(true);
    try {
      await saveUserProfile({ data: formToProfile(form) });
      // Re-run today's coaching so suggestions reflect the new profile immediately
      // (persists into the DailyPlan; mirrors the finance-save behavior in ADR-012).
      try {
        await generateCoaching({ data: { force: true } });
      } catch (err) {
        console.warn("[profile] re-coach after save failed", err);
      }
      setSavedAt(Date.now());
    } catch (e) {
      console.error("[profile] save failed", e);
    } finally {
      setSaving(false);
    }
  }

  const age = computeAge(str(form.birthDate));
  const profileSignals = [
    form.goals,
    form.injuries,
    form.trainingDaysPerWeek,
    form.equipmentAccess,
    form.dietaryRestrictions,
    form.proteinTargetG,
    form.waterTargetOz,
    form.riskTolerance,
    form.monthlySavingsGoal,
  ];
  const profileCompleteness = Math.round(
    (profileSignals.filter((value) => value.trim()).length / profileSignals.length) * 100,
  );
  const missingHighImpact = [
    !form.goals.trim() && "top goals",
    !form.injuries.trim() && "injuries or movement limits",
    !form.proteinTargetG.trim() && "protein target",
    !form.riskTolerance.trim() && "risk tolerance",
    !form.monthlySavingsGoal.trim() && "monthly savings goal",
  ].filter(Boolean);

  return (
    <div className="min-h-dvh bg-background px-4 pb-16 pt-8 sm:px-6">
      <div className="mx-auto w-full max-w-page">
        <div className="mb-6">
          <div className="text-xs uppercase tracking-[2px] text-muted-foreground">Settings</div>
          <div className="flex items-center gap-2 text-3xl font-semibold tracking-tighter">
            <User className="size-7 text-primary" /> Your Profile
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything here personalizes your coach — it respects your injuries and dietary
            restrictions, uses your own targets, and references your goals. All fields are optional.
          </p>
          {!loading && (
            <div className="mt-4 rounded-xl border bg-card p-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">Coach profile quality</span>
                <span className="tabular-nums text-muted-foreground">{profileCompleteness}%</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${profileCompleteness}%` }}
                />
              </div>
              {missingHighImpact.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Highest-impact missing fields: {missingHighImpact.slice(0, 3).join(", ")}.
                </p>
              )}
            </div>
          )}
        </div>

        {loading ? (
          <div className="text-sm text-muted-foreground">Loading your profile…</div>
        ) : (
          <form onSubmit={handleSave} className="space-y-6">
            {/* IDENTITY */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <User className="size-4 text-primary" /> Identity
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Display name">
                  <Input
                    value={form.displayName}
                    onChange={(e) => set("displayName", e.target.value)}
                    placeholder="Brian"
                  />
                </Field>
                <Field label={`Birth date${age != null ? ` (age ${age})` : ""}`}>
                  <BirthDatePicker
                    value={form.birthDate}
                    onChange={(v) => set("birthDate", v)}
                  />
                </Field>
                <Field label="Sex">
                  <select
                    className={selectClass}
                    value={form.sex}
                    onChange={(e) => set("sex", e.target.value)}
                  >
                    <option value="">—</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                    <option value="other">Other</option>
                  </select>
                </Field>
                <Field label="Height (in)">
                  <Input
                    type="number"
                    value={form.heightIn}
                    onChange={(e) => set("heightIn", e.target.value)}
                    placeholder="71"
                  />
                </Field>
                <Field label="Units">
                  <select
                    className={selectClass}
                    value={form.units}
                    onChange={(e) => set("units", e.target.value)}
                  >
                    <option value="imperial">US customary (lb/in/oz)</option>
                    <option value="metric">Metric</option>
                  </select>
                </Field>
                <Field label="Timezone" hint="e.g. America/Chicago">
                  <Input
                    value={form.timezone}
                    onChange={(e) => set("timezone", e.target.value)}
                    placeholder="America/Chicago"
                  />
                </Field>
              </CardContent>
            </Card>

            {/* COACHING & GOALS */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Target className="size-4 text-primary" /> Coaching &amp; Goals
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Field
                  label="Top goals"
                  hint="Comma-separated, e.g. lose 10 lb, save $20k, bench 225 lb"
                >
                  <Input
                    value={form.goals}
                    onChange={(e) => set("goals", e.target.value)}
                    placeholder="lose 10 lb, save $20k, run a 5k"
                  />
                </Field>
                <Field label="Activity level">
                  <select
                    className={selectClass}
                    value={form.activityLevel}
                    onChange={(e) => set("activityLevel", e.target.value)}
                  >
                    <option value="">—</option>
                    <option value="sedentary">Sedentary</option>
                    <option value="light">Light</option>
                    <option value="moderate">Moderate</option>
                    <option value="active">Active</option>
                    <option value="very_active">Very active</option>
                  </select>
                </Field>
              </CardContent>
            </Card>

            {/* FITNESS */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Dumbbell className="size-4 text-primary" /> Fitness
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Field
                  label="Injuries / limits"
                  hint="The coach will never prescribe movements that aggravate these"
                >
                  <Input
                    value={form.injuries}
                    onChange={(e) => set("injuries", e.target.value)}
                    placeholder="left knee, no overhead pressing"
                  />
                </Field>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Training days / week">
                    <Input
                      type="number"
                      min="0"
                      max="7"
                      value={form.trainingDaysPerWeek}
                      onChange={(e) => set("trainingDaysPerWeek", e.target.value)}
                      placeholder="4"
                    />
                  </Field>
                  <Field label="Equipment access" hint="Comma-separated">
                    <Input
                      value={form.equipmentAccess}
                      onChange={(e) => set("equipmentAccess", e.target.value)}
                      placeholder="full gym, dumbbells, pull-up bar"
                    />
                  </Field>
                </div>
                <Field
                  label="Preferred workout styles"
                  hint="What the trainer should emphasize. None selected = balanced mix of strength, calisthenics & yoga."
                >
                  <div className="flex flex-wrap gap-2">
                    {WORKOUT_STYLES.map((s) => {
                      const active = form.preferredWorkoutStyles.includes(s.value);
                      return (
                        <button
                          key={s.value}
                          type="button"
                          onClick={() => toggleWorkoutStyle(s.value)}
                          aria-pressed={active}
                          title={s.hint}
                          className={cn(
                            "rounded-full border px-3 py-1.5 text-xs transition-colors",
                            active
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-input bg-background hover:bg-muted",
                          )}
                        >
                          {s.label}
                        </button>
                      );
                    })}
                  </div>
                </Field>
              </CardContent>
            </Card>

            {/* NUTRITION */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Utensils className="size-4 text-primary" /> Nutrition
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Field
                  label="Dietary restrictions"
                  hint="The coach will never suggest foods that violate these"
                >
                  <Input
                    value={form.dietaryRestrictions}
                    onChange={(e) => set("dietaryRestrictions", e.target.value)}
                    placeholder="vegetarian, no dairy, nut allergy"
                  />
                </Field>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field label="Protein target (g)">
                    <Input
                      type="number"
                      value={form.proteinTargetG}
                      onChange={(e) => set("proteinTargetG", e.target.value)}
                      placeholder="150"
                    />
                  </Field>
                  <Field label="Calorie target (kcal)">
                    <Input
                      type="number"
                      value={form.calorieTargetKcal}
                      onChange={(e) => set("calorieTargetKcal", e.target.value)}
                      placeholder="2400"
                    />
                  </Field>
                  <Field label="Water target (fl oz)">
                    <Input
                      type="number"
                      value={form.waterTargetOz}
                      onChange={(e) => set("waterTargetOz", e.target.value)}
                      placeholder="85"
                    />
                  </Field>
                </div>
              </CardContent>
            </Card>

            {/* FINANCE */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Wallet className="size-4 text-primary" /> Finance
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Investing risk tolerance">
                    <select
                      className={selectClass}
                      value={form.riskTolerance}
                      onChange={(e) => set("riskTolerance", e.target.value)}
                    >
                      <option value="">—</option>
                      <option value="conservative">Conservative</option>
                      <option value="moderate">Moderate</option>
                      <option value="aggressive">Aggressive</option>
                    </select>
                  </Field>
                  <Field label="Monthly savings goal ($)">
                    <Input
                      type="number"
                      value={form.monthlySavingsGoal}
                      onChange={(e) => set("monthlySavingsGoal", e.target.value)}
                      placeholder="1500"
                    />
                  </Field>
                </div>
                <Field label="Finance notes" hint="Anything the advisor should keep in mind">
                  <Textarea
                    value={form.financeNotes}
                    onChange={(e) => set("financeNotes", e.target.value)}
                    placeholder="Paying down a car loan; maxing 401k match; prefer index funds."
                    rows={3}
                  />
                </Field>
              </CardContent>
            </Card>

            <div className="flex items-center gap-3 pb-4">
              <Button type="submit" disabled={saving} className="gap-1.5">
                {savedAt ? <Check className="size-4" /> : <Save className="size-4" />}
                {saving ? "Saving…" : "Save profile"}
              </Button>
              {savedAt && (
                <span className="text-sm text-muted-foreground">
                  Saved — your coach has been updated.
                </span>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
