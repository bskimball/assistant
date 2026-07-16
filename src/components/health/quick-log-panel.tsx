import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";

export type HealthQuickLogKind = "meal" | "workout";

export function HealthQuickLogPanel({
  kind,
  open,
  onOpenChange,
  busy,
  onSubmit,
}: {
  kind: HealthQuickLogKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onSubmit: (value: { description: string; minutes?: number }) => Promise<void>;
}) {
  const desktop = useMediaQuery("(min-width: 640px)");
  const [description, setDescription] = useState("");
  const [minutes, setMinutes] = useState("");
  const title = kind === "meal" ? "Log a meal" : "Log a workout";
  const descriptionText =
    kind === "meal"
      ? "Describe what you ate. Compass will estimate calories and macros."
      : "Record a simple completed workout in minutes.";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = description.trim();
    if (!value || busy) return;
    const parsedMinutes = Number(minutes);
    try {
      await onSubmit({
        description: value,
        minutes:
          kind === "workout" && Number.isInteger(parsedMinutes) && parsedMinutes > 0
            ? parsedMinutes
            : undefined,
      });
      setDescription("");
      setMinutes("");
      onOpenChange(false);
    } catch {
      // The parent owns the visible error state; keep the form open for retry.
    }
  }

  const form = (
    <form onSubmit={submit} className="space-y-3 p-4 sm:p-0">
      <Input
        autoFocus
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder={kind === "meal" ? "e.g. turkey sandwich and an apple" : "e.g. brisk walk"}
        disabled={busy}
        aria-label={kind === "meal" ? "Meal description" : "Workout description"}
      />
      {kind === "workout" && (
        <Input
          value={minutes}
          onChange={(event) => setMinutes(event.target.value)}
          inputMode="numeric"
          placeholder="Minutes (optional)"
          disabled={busy}
          aria-label="Workout duration in minutes"
        />
      )}
      <Button type="submit" className="w-full gap-1.5" disabled={!description.trim() || busy}>
        <Plus className="size-4" /> {busy ? "Saving…" : title}
      </Button>
    </form>
  );

  if (desktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{descriptionText}</DialogDescription>
          </DialogHeader>
          {form}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-xl pb-6">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{descriptionText}</SheetDescription>
        </SheetHeader>
        {form}
      </SheetContent>
    </Sheet>
  );
}

export function QuickLogButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-auto min-h-11 justify-start gap-2 py-2"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
