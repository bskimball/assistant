import { useState } from "react";
import { Dumbbell } from "lucide-react";
import type { ExercisePhase } from "@/lib/domain";
import { PHASE_META, exerciseImageUrl } from "@/lib/workout-phases";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";

export type ExerciseDetail = {
  name: string;
  sets?: number;
  reps?: number | string;
  weightLb?: number;
  restSec?: number;
  notes?: string;
  phase?: ExercisePhase;
};

function formatRestSec(restSec: number): string {
  if (restSec < 60) return `${restSec}s`;
  const minutes = Math.floor(restSec / 60);
  const seconds = restSec % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function ExerciseDetailBody({ exercise }: { exercise: ExerciseDetail }) {
  const phase = exercise.phase ?? "main";
  const meta = PHASE_META[phase];
  const [imgState, setImgState] = useState<"loading" | "loaded" | "error">("loading");

  const reps = exercise.reps ?? "";
  const setsReps =
    exercise.sets !== undefined ? `${exercise.sets} × ${reps || "—"}` : reps ? String(reps) : null;

  return (
    <div className="space-y-4">
      <div className="relative aspect-[4/5] w-full overflow-hidden rounded-xl bg-muted outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10">
        {imgState !== "error" && (
          <img
            src={exerciseImageUrl(exercise.name)}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={() => setImgState("loaded")}
            onError={() => setImgState("error")}
            className={`size-full object-cover transition-opacity duration-300 ${
              imgState === "loaded" ? "opacity-100" : "opacity-0"
            }`}
          />
        )}
        {imgState !== "loaded" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Dumbbell
              className={`size-12 ${meta.text} ${
                imgState === "loading" ? "animate-pulse opacity-50" : "opacity-40"
              }`}
            />
          </div>
        )}
        {imgState === "loaded" && (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/35 to-transparent" />
        )}
        {exercise.phase && (
          <span className="absolute left-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-full bg-black/45 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white/90 backdrop-blur-sm">
            <span className={`size-1.5 rounded-full ${meta.dot}`} />
            {meta.label}
          </span>
        )}
      </div>

      <div className="space-y-3 px-1">
        {(setsReps || exercise.weightLb !== undefined || exercise.restSec !== undefined) && (
          <dl className="grid grid-cols-3 gap-2 text-center">
            {setsReps && (
              <div className="rounded-lg bg-muted/60 px-2 py-2">
                <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Sets × reps
                </dt>
                <dd className="mt-0.5 text-sm font-semibold tabular-nums">{setsReps}</dd>
              </div>
            )}
            {exercise.weightLb !== undefined && (
              <div className="rounded-lg bg-muted/60 px-2 py-2">
                <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Weight
                </dt>
                <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                  {exercise.weightLb} lb
                </dd>
              </div>
            )}
            {exercise.restSec !== undefined && (
              <div className="rounded-lg bg-muted/60 px-2 py-2">
                <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Rest
                </dt>
                <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                  {formatRestSec(exercise.restSec)}
                </dd>
              </div>
            )}
          </dl>
        )}

        {exercise.notes && (
          <p className="text-sm leading-relaxed text-muted-foreground">{exercise.notes}</p>
        )}
      </div>
    </div>
  );
}

export function ExerciseDetailDialog({
  open,
  onOpenChange,
  exercise,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exercise: ExerciseDetail | null;
}) {
  const desktop = useMediaQuery("(min-width: 640px)");
  const title = exercise?.name ?? "Exercise";
  const body = exercise ? <ExerciseDetailBody exercise={exercise} /> : null;

  if (desktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[90vh] overflow-y-auto rounded-t-xl pb-6">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className="px-4 pt-2">{body}</div>
      </SheetContent>
    </Sheet>
  );
}
