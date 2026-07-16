import type { ReactNode } from "react";
import { Reveal } from "@/components/motion";
import { cn } from "@/lib/utils";

/**
 * Standard header anatomy for every non-home page:
 * eyebrow → title → optional coach voice → optional description → optional right slot.
 */
export function PageHeader({
  eyebrow,
  title,
  voice,
  description,
  children,
  className,
}: {
  eyebrow: string;
  title: ReactNode;
  /** Short coach line — uses the shared `.voice` typeface. */
  voice?: string;
  description?: ReactNode;
  /** Right slot: stats, date nav, actions. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-xs tracking-tight text-muted-foreground">{eyebrow}</div>
        <h1 className="text-balance text-3xl font-semibold tracking-tighter">{title}</h1>
        {voice ? (
          <Reveal y={6} className="voice mt-1.5 text-sm text-foreground/80">
            {voice}
          </Reveal>
        ) : null}
        {description ? (
          <div className="mt-1 text-pretty text-sm text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {children ? <div className="shrink-0 self-start sm:self-auto">{children}</div> : null}
    </header>
  );
}
