import { cn } from "@/lib/utils";
import { getDaypart } from "@/lib/scope";
import type { ReactNode } from "react";

/**
 * Shared immersion shell for every route except the home Action Stack
 * (which owns its own vivid daypart treatment).
 *
 * Grammar:
 *   atmosphere — calm (coach), vital (health), focus (money/review/tasks)
 *   density    — medium (readable cards), dense (tables/boards)
 *   width      — page (default), wide (kanban), full (chat viewport)
 *
 * Header always sits above local workspace tabs. Bottom padding leaves room
 * for the mobile tab bar.
 */

export type Atmosphere = "calm" | "vital" | "focus" | "vivid";
export type Density = "medium" | "dense";
export type ShellWidth = "page" | "wide" | "full";

const WIDTH: Record<ShellWidth, string> = {
  page: "max-w-2xl xl:max-w-4xl",
  wide: "max-w-6xl",
  full: "max-w-2xl xl:max-w-5xl",
};

export function PageShell({
  atmosphere = "focus",
  density = "medium",
  width = "page",
  daypart,
  className,
  contentClassName,
  children,
}: {
  atmosphere?: Atmosphere;
  density?: Density;
  width?: ShellWidth;
  /** Override clock daypart (e.g. home peeks). Defaults to now. */
  daypart?: "morning" | "midday" | "evening";
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  const part = daypart ?? getDaypart();
  return (
    <div
      className={cn("zen-ambient px-4 pb-28 pt-4 sm:px-6", className)}
      data-daypart={part}
      data-density={density}
      data-atmosphere={atmosphere}
    >
      <div className={cn("relative z-10 mx-auto w-full", WIDTH[width], contentClassName)}>
        {children}
      </div>
    </div>
  );
}
