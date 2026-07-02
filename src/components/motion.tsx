/**
 * Shared motion primitives for content reveals (make-interfaces-feel-better).
 *
 * The enter recipe is fixed by the skill: opacity 0→1, y 8→0, blur 4px→0, on a
 * spring (duration 0.3, bounce 0). Reduced motion is honored app-wide by the
 * <MotionConfig reducedMotion="user"> wrapper in __root.tsx, so nothing here
 * needs to check it.
 *
 * Usage intent: animate content that *arrives* — AI tokens, data pulled from
 * the store — not the static page shell (the route transition already handles
 * that). Wrap the data-dependent branch so it mounts (and animates) the moment
 * the data lands.
 *
 *   <Reveal>…one block…</Reveal>
 *   {items.map((it, i) => <Reveal as="li" key={it.id} delay={revealDelay(i)} />)}
 *   <Stagger><Item/>…<Item/></Stagger>   // orchestrated cascade
 */

import { motion, type Variants } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const SPRING = { type: "spring", duration: 0.3, bounce: 0 } as const;

/** Hidden→visible variant for children of a <Stagger> (or any variant parent). */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 8, filter: "blur(4px)" },
  visible: { opacity: 1, y: 0, filter: "blur(0px)", transition: SPRING },
};

/** Per-index delay for a one-shot list cascade. Capped so long lists don't drag. */
export function revealDelay(index: number, step = 0.04, max = 0.32): number {
  return Math.min(index * step, max);
}

const TAGS = {
  div: motion.div,
  li: motion.li,
  ul: motion.ul,
  section: motion.section,
  span: motion.span,
} as const;

type RevealTag = keyof typeof TAGS;

/**
 * One-shot reveal: mounts → animates in once. Re-renders don't replay it, so
 * it's safe around streaming/often-updating content. `delay` lets a mapped list
 * cascade (see `revealDelay`).
 */
export function Reveal({
  as = "div",
  children,
  className,
  delay = 0,
  y = 8,
}: {
  as?: RevealTag;
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
}) {
  const M = TAGS[as];
  return (
    <M
      className={className}
      initial={{ opacity: 0, y, filter: "blur(4px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ ...SPRING, delay }}
    >
      {children}
    </M>
  );
}

/**
 * Orchestrating parent: set once on mount, staggers descendant <Item>s (variant
 * propagation works through plain DOM in between, so a <ul> wrapper is fine).
 */
export function Stagger({
  as = "div",
  children,
  className,
  stagger = 0.07,
  delayChildren = 0,
}: {
  as?: RevealTag;
  children: ReactNode;
  className?: string;
  stagger?: number;
  delayChildren?: number;
}) {
  const M = TAGS[as];
  return (
    <M
      className={className}
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: stagger, delayChildren } },
      }}
    >
      {children}
    </M>
  );
}

/** Child of <Stagger>: inherits the cascade timing via the `fadeUp` variant. */
export function Item({
  as = "div",
  children,
  className,
}: {
  as?: RevealTag;
  children: ReactNode;
  className?: string;
}) {
  const M = TAGS[as];
  return (
    <M className={cn(className)} variants={fadeUp}>
      {children}
    </M>
  );
}
