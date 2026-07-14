import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dumbbell, Clock, ChevronLeft, ChevronRight } from "lucide-react";
import type { ExercisePhase } from "@/lib/domain";
import { PHASE_META, PHASE_ORDER, exerciseImageUrl } from "@/lib/workout-phases";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface CarouselExercise {
  name: string;
  sets?: number;
  reps?: number | string;
  phase?: ExercisePhase;
}

interface Props {
  title: string;
  focus?: string;
  estimatedMinutes?: number;
  exercises: CarouselExercise[];
}

/**
 * Phase-segmented carousel for a workout routine: silhouette cards grouped by
 * phase (warm-up → main → core → cooldown) with prev/next paging, snap, swipe,
 * jump-to-phase chips, and a dot indicator. Silhouettes are lazily generated +
 * cached server-side; cards fall back to a phase-tinted placeholder.
 */
export function WorkoutCarousel({ title, focus, estimatedMinutes, exercises }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  const [active, setActive] = useState(0);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  // Group in fixed phase order, dropping empty phases. Keep a flat list plus the
  // first flat index of each phase (for the jump chips).
  const { ordered, phaseStart } = useMemo(() => {
    const flat: { ex: CarouselExercise; phase: ExercisePhase }[] = [];
    const starts = new Map<ExercisePhase, number>();
    for (const phase of PHASE_ORDER) {
      const items = exercises.filter((e) => (e.phase ?? "main") === phase);
      if (items.length === 0) continue;
      starts.set(phase, flat.length);
      items.forEach((ex) => flat.push({ ex, phase }));
    }
    return { ordered: flat, phaseStart: starts };
  }, [exercises]);

  const phasesPresent = useMemo(() => [...phaseStart.keys()], [phaseStart]);

  const updateControls = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const { scrollLeft, scrollWidth, clientWidth } = scroller;
    setCanPrev(scrollLeft > 2);
    setCanNext(scrollLeft < scrollWidth - clientWidth - 2);
    // Active = card whose left edge is nearest the viewport's left edge.
    const base = scroller.getBoundingClientRect().left;
    let nearest = 0;
    let best = Infinity;
    cardRefs.current.forEach((el, i) => {
      if (!el) return;
      const d = Math.abs(el.getBoundingClientRect().left - base);
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
    setActive(nearest);
  }, []);

  useEffect(() => {
    updateControls();
    const scroller = scrollerRef.current;
    if (!scroller) return;
    window.addEventListener("resize", updateControls);
    return () => window.removeEventListener("resize", updateControls);
  }, [updateControls, ordered.length]);

  const scrollToIndex = useCallback((index: number) => {
    const scroller = scrollerRef.current;
    const card = cardRefs.current[index];
    if (!scroller || !card) return;
    const delta = card.getBoundingClientRect().left - scroller.getBoundingClientRect().left;
    scroller.scrollTo({ left: scroller.scrollLeft + delta - 4, behavior: "smooth" });
  }, []);

  if (ordered.length === 0) return null;

  const step = (dir: 1 | -1) => {
    const next = Math.min(ordered.length - 1, Math.max(0, active + dir));
    scrollToIndex(next);
  };

  const showChips = phasesPresent.length > 1;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <div className="truncate font-medium">{title}</div>
          {focus && <div className="text-xs text-muted-foreground">{focus}</div>}
        </div>
        {typeof estimatedMinutes === "number" && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
            <Clock className="size-3.5" /> ~{estimatedMinutes} min · {ordered.length} moves
          </div>
        )}
      </div>

      {showChips && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {phasesPresent.map((phase) => {
            const meta = PHASE_META[phase];
            const isActive = (ordered[active]?.phase ?? "main") === phase;
            return (
              <Button
                key={phase}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => scrollToIndex(phaseStart.get(phase) ?? 0)}
                className={cn(
                  "h-auto gap-1.5 rounded-full px-2.5 py-1 text-xs active:scale-[0.97]",
                  isActive
                    ? "border-transparent bg-muted text-foreground"
                    : "text-muted-foreground",
                )}
              >
                <span className={cn("size-1.5 rounded-full", meta.dot)} />
                {meta.label}
              </Button>
            );
          })}
        </div>
      )}

      {/* Viewport + edge arrows */}
      <div className="relative">
        <CarouselArrow dir="prev" disabled={!canPrev} onClick={() => step(-1)} />
        <CarouselArrow dir="next" disabled={!canNext} onClick={() => step(1)} />

        <div
          ref={scrollerRef}
          onScroll={updateControls}
          className="flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {ordered.map(({ ex, phase }, i) => (
            <div
              key={i}
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              className="w-36 shrink-0 snap-start sm:w-40"
            >
              <ExerciseCard ex={ex} phase={phase} />
            </div>
          ))}
        </div>
      </div>

      {/* Dot indicator */}
      <div className="mt-2.5 flex items-center justify-center gap-1.5">
        {ordered.map(({ phase }, i) => {
          const meta = PHASE_META[phase];
          const isActive = i === active;
          return (
            <button
              key={i}
              type="button"
              aria-label={`Go to exercise ${i + 1}`}
              onClick={() => scrollToIndex(i)}
              className={`h-1.5 rounded-full transition-all duration-200 ${
                isActive
                  ? `w-4 ${meta.dot}`
                  : "w-1.5 bg-muted-foreground/25 hover:bg-muted-foreground/50"
              }`}
            />
          );
        })}
      </div>
    </div>
  );
}

function CarouselArrow({
  dir,
  disabled,
  onClick,
}: {
  dir: "prev" | "next";
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = dir === "prev" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === "prev" ? "Previous exercise" : "Next exercise"}
      className={`absolute top-[4.25rem] z-10 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border bg-background/80 text-foreground shadow-sm backdrop-blur transition-all hover:bg-background active:scale-95 disabled:pointer-events-none disabled:opacity-0 sm:size-9 ${
        dir === "prev" ? "left-1" : "right-1"
      }`}
    >
      <Icon className="size-4" />
    </button>
  );
}

function ExerciseCard({ ex, phase }: { ex: CarouselExercise; phase: ExercisePhase }) {
  const meta = PHASE_META[phase];
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const reps = ex.reps ?? "";
  const setsReps = ex.sets ? `${ex.sets} × ${reps}` : String(reps);

  return (
    <div className="overflow-hidden rounded-xl bg-card shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)] transition-[box-shadow] hover:shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.08),0_2px_4px_0_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)] dark:hover:shadow-[0_0_0_1px_rgba(255,255,255,0.13)]">
      {/* Silhouette media frame — neutral warm-charcoal so one art style reads in
          both themes without a cold blue cast. */}
      <div className="relative aspect-square w-full bg-[oklch(0.24_0.008_150)] outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10">
        {state !== "error" && (
          <img
            src={exerciseImageUrl(ex.name)}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={() => setState("loaded")}
            onError={() => setState("error")}
            className={`size-full object-contain transition-opacity duration-300 ${
              state === "loaded" ? "opacity-100" : "opacity-0"
            }`}
          />
        )}
        {state !== "loaded" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Dumbbell
              className={`size-7 ${meta.text} ${state === "loading" ? "animate-pulse opacity-50" : "opacity-40"}`}
            />
          </div>
        )}
        {/* Phase tag */}
        <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white/90 backdrop-blur-sm">
          <span className={`size-1.5 rounded-full ${meta.dot}`} />
          {meta.label}
        </span>
      </div>

      <div className="p-2.5">
        <div className="line-clamp-2 min-h-[2.25rem] text-xs font-medium leading-snug">
          {ex.name}
        </div>
        {setsReps.trim() && (
          <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">{setsReps}</div>
        )}
      </div>
    </div>
  );
}
