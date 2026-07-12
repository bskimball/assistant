import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Dumbbell,
  Utensils,
  Wallet,
  Users,
  ListTodo,
  Mic,
  Brain,
  ShieldCheck,
  Target,
  ArrowRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/about")({
  component: About,
});

const PILLARS = [
  {
    Icon: Dumbbell,
    title: "Fitness",
    body: "AI-suggested workouts on a push/pull/legs rotation that respects your training days and injuries, plus session logging.",
  },
  {
    Icon: Utensils,
    title: "Nutrition",
    body: "Meal and water logging with protein targets, surfaced as daily progress and grounded coaching.",
  },
  {
    Icon: Wallet,
    title: "Finance",
    body: "A first-class net-worth snapshot from your accounts, with advice tuned to your risk tolerance and savings goal.",
  },
  {
    Icon: Users,
    title: "Family & Life",
    body: "Gentle nudges to protect distraction-free time — presence compounds more than productivity.",
  },
  {
    Icon: ListTodo,
    title: "Productivity",
    body: "A unified task model behind both the daily dashboard and the full Kanban board.",
  },
  {
    Icon: Mic,
    title: "Voice-first",
    body: "Speak to log a meal, add a task, or check in. Transcript → intent → action, with confirmation for anything destructive.",
  },
];

const PRINCIPLES = [
  {
    Icon: Target,
    title: "Person-first",
    body: "Every feature has to demonstrably improve your life — or it doesn't ship.",
  },
  {
    Icon: Brain,
    title: "Actionable",
    body: "The coach doesn't just track. It recommends, plans, and references your real numbers.",
  },
  {
    Icon: ShieldCheck,
    title: "Resilient",
    body: "Every AI path has a deterministic fallback, so the app stays useful with no API key.",
  },
];

function About() {
  return (
    <div className="bg-background px-4 pb-28 pt-8 sm:px-6 sm:pb-16">
      <div className="mx-auto w-full max-w-page">
        {/* Hero */}
        <div className="mb-8 rounded-2xl border-primary/20 bg-card p-6 shadow-sm ring-1 ring-foreground/10 sm:p-8">
          <div className="text-xs tracking-tight text-muted-foreground">About</div>
          <h1 className="mt-1 text-balance text-3xl font-semibold tracking-tighter sm:text-4xl">
            Your personal life-improvement assistant
          </h1>
          <p className="mt-3 max-w-2xl text-pretty text-base leading-7 text-muted-foreground">
            A voice-native AI coach that brings a life coach, personal trainer, and financial
            advisor into one place — turning what you log each day into specific, encouraging next
            steps across fitness, nutrition, finance, family, and focus.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              asChild
              size="sm"
              className="gap-1.5 transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
            >
              <Link to="/">
                Open dashboard{" "}
                <ArrowRight className="size-4 transition-transform duration-150 ease-out group-hover/button:translate-x-0.5" />
              </Link>
            </Button>
            <Button
              asChild
              variant="outline"
              size="sm"
              className="transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
            >
              <Link to="/profile">Set up your profile</Link>
            </Button>
          </div>
        </div>

        {/* Pillars */}
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">What it helps with</h2>
        <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PILLARS.map(({ Icon, title, body }) => (
            <Card
              key={title}
              className="transition-shadow duration-150 ease-out hover:shadow-sm hover:ring-foreground/20"
            >
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2.5 text-base">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/15">
                    <Icon className="size-4 text-primary" />
                  </span>
                  {title}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-pretty text-sm text-muted-foreground">
                {body}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Principles */}
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">How it works</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {PRINCIPLES.map(({ Icon, title, body }) => (
            <div
              key={title}
              className="rounded-xl bg-card p-4 shadow-[0_1px_0_rgba(0,0,0,0.05)] ring-1 ring-foreground/10 transition-shadow duration-150 ease-out hover:ring-foreground/20"
            >
              <div className="flex items-center gap-2.5 font-medium">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/15">
                  <Icon className="size-4 text-primary" />
                </span>
                {title}
              </div>
              <p className="mt-2 text-pretty text-sm text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>

        <p className="mt-8 text-pretty text-[11px] text-muted-foreground/70">
          Built on TanStack Start + Cloudflare Workers, with R2 for storage and a Grok-backed coach.
          Your data stays under your own user partition.
        </p>
      </div>
    </div>
  );
}
