import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { formatDistanceToNow } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Item, Reveal, revealDelay, Stagger } from "@/components/motion";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { cn } from "@/lib/utils";
import { loadUserProfile, saveUserProfile } from "@/server/domain";
import { generateCoaching } from "@/server/coach";
import { loadCoachMemories, deleteCoachMemory } from "@/server/chat";
import type { CoachMemory, CoachMemoryCategory } from "@/lib/domain";
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
import {
  BarbellIcon,
  BrainIcon,
  CalendarIcon,
  CheckIcon,
  CompassIcon,
  FloppyDiskIcon,
  ForkKnifeIcon,
  SparkleIcon,
  TargetIcon,
  TrashIcon,
  UserIcon,
  WalletIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";

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
  coachingStyle: string;
  currentFocus: string;
  motivation: string;
  lifeContext: string;
  foodPreferences: string;
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
  skills: string;
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
  coachingStyle: "",
  currentFocus: "",
  motivation: "",
  lifeContext: "",
  foodPreferences: "",
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
  skills: "",
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

/** Human labels for the coach-memory categories (ADR-020). */
const MEMORY_CATEGORY_LABELS: Record<CoachMemoryCategory, string> = {
  goal: "Goal",
  preference: "Preference",
  constraint: "Constraint",
  life_event: "Life event",
  milestone: "Milestone",
};

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
    coachingStyle: p.coachingStyle ?? "",
    currentFocus: p.currentFocus ?? "",
    motivation: p.motivation ?? "",
    lifeContext: p.lifeContext ?? "",
    foodPreferences: csv(p.foodPreferences),
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
    skills: csv(p.skills),
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
    coachingStyle: (str(f.coachingStyle) as UserProfile["coachingStyle"]) ?? undefined,
    currentFocus: str(f.currentFocus),
    motivation: str(f.motivation),
    lifeContext: str(f.lifeContext),
    foodPreferences: fromCsv(f.foodPreferences),
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
    skills: fromCsv(f.skills),
  };
}

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

/**
 * Section header with a soft primary icon chip — gives each settings group a
 * touch of identity without introducing new colors.
 */
function SectionTitle({ Icon, children }: { Icon: PhosphorIcon; children: React.ReactNode }) {
  return (
    <CardTitle className="flex items-center gap-2.5 text-base">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Icon className="size-4" weight="duotone" />
      </span>
      {children}
    </CardTitle>
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
    ? selected.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
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
          <CalendarIcon className="size-4 text-muted-foreground" weight="duotone" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
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
  const [memories, setMemories] = useState<CoachMemory[]>([]);

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

  // What the coach remembers (ADR-020) — display/manage only, outside the form.
  useEffect(() => {
    let active = true;
    loadCoachMemories()
      .then(({ memories }) => {
        if (active) setMemories(memories);
      })
      .catch((e) => console.warn("[profile] memories load failed", e));
    return () => {
      active = false;
    };
  }, []);

  async function handleForget(id: string) {
    // Optimistically drop it; the delete is best-effort (soft-delete server-side).
    setMemories((prev) => prev.filter((m) => m.id !== id));
    try {
      await deleteCoachMemory({ data: { id } });
    } catch (e) {
      console.warn("[profile] forget memory failed", e);
    }
  }

  function set<K extends keyof Form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setSavedAt(null);
  }

  function setWorkoutStyles(styles: WorkoutStyle[]) {
    setForm((f) => ({ ...f, preferredWorkoutStyles: styles }));
    setSavedAt(null);
  }

  async function handleSave(e?: React.SyntheticEvent) {
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
    form.currentFocus,
    form.motivation,
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
    <PageShell atmosphere="focus" density="medium">
      <PageHeader
        eyebrow="Settings"
        title="Your Profile"
        description="Everything here personalizes your coach — it respects your injuries and dietary restrictions, uses your own targets, and references your goals. All fields are optional."
      />
      {!loading && (
        <Reveal className="mb-6 overflow-hidden rounded-xl border border-primary/20 bg-card/70 backdrop-blur-xl backdrop-saturate-150 p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2.5 font-medium">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <SparkleIcon className="size-4" weight="duotone" />
              </span>
              Coach profile quality
            </span>
            <span className="tabular-nums text-muted-foreground">{profileCompleteness}%</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-[width] duration-300 ease-out ${
                profileCompleteness >= 100
                  ? "bg-emerald-500"
                  : profileCompleteness >= 60
                    ? "bg-amber-500"
                    : "bg-primary"
              }`}
              style={{ width: `${profileCompleteness}%` }}
            />
          </div>
          {missingHighImpact.length > 0 && (
            <p className="mt-2 text-pretty text-xs text-muted-foreground">
              Highest-impact missing fields: {missingHighImpact.slice(0, 3).join(", ")}.
            </p>
          )}
        </Reveal>
      )}

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading your profile…</div>
      ) : (
        <Stagger stagger={0.05}>
          <form onSubmit={handleSave} className="space-y-6">
            {/* IDENTITY */}
            <Item>
              <Card>
                <CardHeader>
                  <SectionTitle Icon={UserIcon}>Identity</SectionTitle>
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
                    <BirthDatePicker value={form.birthDate} onChange={(v) => set("birthDate", v)} />
                  </Field>
                  <Field label="Sex">
                    <Select
                      value={form.sex || "none"}
                      onValueChange={(v) => set("sex", v === "none" ? "" : v)}
                    >
                      <SelectTrigger aria-label="Sex" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="none">—</SelectItem>
                          <SelectItem value="male">Male</SelectItem>
                          <SelectItem value="female">Female</SelectItem>
                          <SelectItem value="other">Other</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
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
                    <Select value={form.units} onValueChange={(v) => set("units", v)}>
                      <SelectTrigger aria-label="Units" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="imperial">US customary (lb/in/oz)</SelectItem>
                          <SelectItem value="metric">Metric</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
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
            </Item>

            {/* COACHING & GOALS */}
            <Item>
              <Card>
                <CardHeader>
                  <SectionTitle Icon={TargetIcon}>Coaching &amp; Goals</SectionTitle>
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
                    <Select
                      value={form.activityLevel || "none"}
                      onValueChange={(v) => set("activityLevel", v === "none" ? "" : v)}
                    >
                      <SelectTrigger aria-label="Activity level" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="none">—</SelectItem>
                          <SelectItem value="sedentary">Sedentary</SelectItem>
                          <SelectItem value="light">Light</SelectItem>
                          <SelectItem value="moderate">Moderate</SelectItem>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="very_active">Very active</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </CardContent>
              </Card>
            </Item>

            {/* COACHING STYLE & CONTEXT */}
            <Item>
              <Card>
                <CardHeader>
                  <SectionTitle Icon={CompassIcon}>Coaching style &amp; context</SectionTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Field
                    label="Coaching style"
                    hint="How you want the coach to talk to you — gentle encouragement, a balanced mix, or direct and no-nonsense."
                  >
                    <Select
                      value={form.coachingStyle || "none"}
                      onValueChange={(v) => set("coachingStyle", v === "none" ? "" : v)}
                    >
                      <SelectTrigger aria-label="Coaching style" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="none">—</SelectItem>
                          <SelectItem value="gentle">Gentle</SelectItem>
                          <SelectItem value="balanced">Balanced</SelectItem>
                          <SelectItem value="direct">Direct</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field
                    label="Current focus"
                    hint="Your season right now — e.g. cutting until August, money is the priority this quarter."
                  >
                    <Input
                      value={form.currentFocus}
                      onChange={(e) => set("currentFocus", e.target.value)}
                      placeholder="Cutting until August; savings come first this quarter"
                    />
                  </Field>
                  <Field
                    label="What's driving you"
                    hint="The why behind your goals — lets the coach connect nudges to what actually matters."
                  >
                    <Textarea
                      value={form.motivation}
                      onChange={(e) => set("motivation", e.target.value)}
                      placeholder="Want to keep up with my kids and feel strong at 50."
                      rows={2}
                    />
                  </Field>
                  <Field
                    label="Life context"
                    hint="Work schedule, family, travel — anything that shapes your week."
                  >
                    <Textarea
                      value={form.lifeContext}
                      onChange={(e) => set("lifeContext", e.target.value)}
                      placeholder="Desk job, two young kids, travel for work about once a month."
                      rows={2}
                    />
                  </Field>
                  <Field
                    label="Food likes &amp; dislikes"
                    hint="Comma-separated. Restrictions say what's forbidden; this says what you'll actually eat."
                  >
                    <Input
                      value={form.foodPreferences}
                      onChange={(e) => set("foodPreferences", e.target.value)}
                      placeholder="love chicken and rice, hate cottage cheese, coffee daily"
                    />
                  </Field>
                </CardContent>
              </Card>
            </Item>

            {/* FITNESS */}
            <Item>
              <Card>
                <CardHeader>
                  <SectionTitle Icon={BarbellIcon}>Fitness</SectionTitle>
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
                    <ToggleGroup
                      type="multiple"
                      variant="outline"
                      value={form.preferredWorkoutStyles}
                      onValueChange={(v) => setWorkoutStyles(v as WorkoutStyle[])}
                      className="flex-wrap justify-start"
                    >
                      {WORKOUT_STYLES.map((s) => (
                        <ToggleGroupItem
                          key={s.value}
                          value={s.value}
                          title={s.hint}
                          className="rounded-full text-xs transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
                        >
                          {s.label}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </Field>
                </CardContent>
              </Card>
            </Item>

            {/* NUTRITION */}
            <Item>
              <Card>
                <CardHeader>
                  <SectionTitle Icon={ForkKnifeIcon}>Nutrition</SectionTitle>
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
            </Item>

            {/* FINANCE */}
            <Item>
              <Card>
                <CardHeader>
                  <SectionTitle Icon={WalletIcon}>Finance</SectionTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Investing risk tolerance">
                      <Select
                        value={form.riskTolerance || "none"}
                        onValueChange={(v) => set("riskTolerance", v === "none" ? "" : v)}
                      >
                        <SelectTrigger aria-label="Investing risk tolerance" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="none">—</SelectItem>
                            <SelectItem value="conservative">Conservative</SelectItem>
                            <SelectItem value="moderate">Moderate</SelectItem>
                            <SelectItem value="aggressive">Aggressive</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
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
                  <Field
                    label="Sellable skills"
                    hint="Comma-separated — what you could get paid for. The advisor grounds earn-more ideas in these."
                  >
                    <Input
                      value={form.skills}
                      onChange={(e) => set("skills", e.target.value)}
                      placeholder="IT infrastructure, automation consulting, Excel modeling"
                    />
                  </Field>
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
            </Item>

            {/* WHAT YOUR COACH REMEMBERS (ADR-020) — display/manage only,
                  not part of the form/save flow. */}
            <Item>
              <Card className="overflow-hidden border-primary/20 bg-card/70 backdrop-blur-xl backdrop-saturate-150 shadow-sm">
                <CardHeader>
                  <SectionTitle Icon={BrainIcon}>What your coach remembers</SectionTitle>
                </CardHeader>
                <CardContent>
                  {memories.length === 0 ? (
                    <p className="text-pretty text-sm text-muted-foreground">
                      As you chat, your coach saves durable facts — goals, preferences, constraints,
                      and life events — so it can pick up where you left off. They'll show up here,
                      and you can remove any that no longer fit.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {memories.map((m, i) => (
                        <Reveal
                          key={m.id}
                          delay={revealDelay(i)}
                          className="zen-surface-nested group flex items-start gap-3 px-3 py-2.5"
                        >
                          <div className="min-w-0 flex-1 space-y-1.5">
                            <div className="flex items-center gap-2">
                              <Badge
                                variant="secondary"
                                className="rounded-full text-[10px] font-medium text-muted-foreground"
                              >
                                {MEMORY_CATEGORY_LABELS[m.category]}
                              </Badge>
                              <span className="text-[10px] text-muted-foreground">
                                {formatDistanceToNow(m.updatedAt, { addSuffix: true })}
                              </span>
                            </div>
                            <p className="text-pretty text-sm leading-relaxed">{m.content}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleForget(m.id)}
                            aria-label="Forget this memory"
                            className="-my-1 -mr-1 flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,background-color,color,scale] duration-150 ease-out hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 active:scale-[0.96] group-hover:opacity-100"
                          >
                            <TrashIcon className="size-4" weight="duotone" />
                          </button>
                        </Reveal>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </Item>

            <Item className="flex items-center gap-3 pb-4">
              <Button
                type="submit"
                disabled={saving}
                className="gap-1.5 transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
              >
                {savedAt ? (
                  <CheckIcon className="size-4" weight="duotone" />
                ) : (
                  <FloppyDiskIcon className="size-4" weight="duotone" />
                )}
                {saving ? "Saving…" : "Save profile"}
              </Button>
              {savedAt && (
                <Reveal as="span" className="text-sm text-muted-foreground">
                  Saved — your coach has been updated.
                </Reveal>
              )}
            </Item>
          </form>
        </Stagger>
      )}
    </PageShell>
  );
}
