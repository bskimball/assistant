# ADR-011: AI Coach Engine — Cross-Domain Coaching & Workout Suggestions

**Status**: Accepted
**Date**: 2026-06-22
**Deciders**: Brian Kimball

## Context

The mission (AGENTS.md) is an assistant that doesn't just _track_ but _coaches_ — it should "recommend and plan" across fitness, nutrition, finance, family, and productivity. In practice the dashboard rendered a `DailyPlan.aiSuggestions` list, but **nothing ever produced those suggestions**. There was no suggestion generator, no workout recommender, and the "Plan & AI Suggestions" card was almost always empty. The voice pipeline (ADR-004) classifies intents but does not give proactive advice.

The grilling questions that shaped this ADR:

- **"Who is the advisor?"** A single coherent voice (one model call, cross-domain) vs. many per-feature AI calls.
- **"Does it work with no API key?"** The app must be useful before any Grok key is configured.
- **"Is advice grounded in the user's actual data, or generic?"**
- **"How do we avoid paying for an LLM call on every page load?"**

## Decision

Introduce a single **AI Coach engine** (`src/server/coach.ts`) that acts as the user's "advisory board" (life coach + strength coach + financial advisor) and produces structured, actionable output from the day's real numbers.

### 1. One engine, structured output

`generateCoaching({ date })` returns a typed `CoachingResult`:

- `headline` — a short, data-aware motivational line.
- `suggestions[]` — 4–6 `CoachSuggestion`s, each tagged with a `domain` (`focus | fitness | nutrition | finance | family | general`), one actionable sentence, and an optional `action` voice-command hint (e.g. `"log 40g protein"`).
- `workout` — a `WorkoutSuggestion` (title, focus, estimated minutes, exercises with sets/reps).
- `generatedBy: 'ai' | 'fallback'` + `updatedAt`.

### 2. Data-grounded

The engine first collects `DaySignals` (tasks done/total, protein vs target, water, net worth presence, meals logged, weekday) from the existing `loadDailyDashboard` aggregate. Every suggestion references those numbers rather than offering generic tips.

### 3. Works with zero config (deterministic fallback)

- If `GROK_API_KEY` is present, the engine asks Grok (`grok-4.5`, via `getGrokJsonModel`) for the structured JSON and validates/normalizes the result, backfilling any missing pieces from the fallback.
- If no key (or on any LLM error), a **deterministic rules-based coach** produces real coaching from the same signals. The app is fully useful offline; the LLM is an upgrade, not a dependency.

### 4. Workout rotation

A weekday-mapped push/pull/legs + conditioning + recovery rotation provides a sensible default session. The AI may override it, but the fallback guarantees a coherent plan every day. Completing the suggested session logs a `WorkoutSession` (ADR-002 invariant: no future `performedAt`).

### 5. Cheap reloads

After generation, suggestions are persisted into the day's `DailyPlan.aiSuggestions`. Reloads render instantly from R2 without another LLM call; the user explicitly triggers regeneration via a Refresh control, and finance edits re-run it.

### 6. Weekly extension

`generateWeeklyNarrative(WeeklyStatsInput)` applies the same pattern at week granularity: it takes pre-computed weekly stats (so it doesn't re-load seven days server-side) and returns `reflection / wins / blockers / nextWeekFocus`, again AI-backed with a deterministic fallback. It powers the Weekly Review (ADR-006 surface).

## Consequences

**Positive**

- The app finally _coaches_: proactive, cross-domain, specific to today's data.
- No hard dependency on an API key — immediate value, predictable cost.
- A single prompt/model call per generation keeps advice coherent and cheap; persistence makes reloads free.
- Suggestion `action` hints close the loop back into the voice pipeline.

**Negative**

- The deterministic fallback's quality is bounded by its hand-written rules; it is good, not brilliant.
- Two code paths (AI + fallback) must be kept behaviorally consistent (shared types, fallback backfill).
- Prompt/response coupling to Grok's JSON formatting; mitigated by tolerant parsing + fallback.

**Risks & Mitigations**

- _LLM returns malformed JSON_ → strip code fences, `try/parse`, fall back on error; normalize/clamp fields.
- _Suggestions feel stale_ → persisted but regenerable on demand; finance edits auto-refresh.
- _Token cost creep_ → `max_tokens` capped, flagship `grok-4.5` (env-overridable), one call per explicit generation, results cached in `DailyPlan`.

## Alternatives Considered

1. **Per-feature AI calls** (separate nutrition tip, workout, finance tip) — More modular but more calls, higher cost, and fragmented/contradictory advice. Rejected in favor of one advisory-board call.
2. **Generate on every dashboard load** — Freshest output but adds latency + cost to a high-frequency view. Rejected; generate-and-cache with explicit refresh chosen instead.
3. **AI-only (no fallback)** — Simpler code, but the app is dead weight until a key is configured and brittle on API outages. Rejected; offline usefulness is a product requirement.
4. **TanStack AI abstraction now** — AGENTS.md prefers TanStack AI. Deferred: a direct, well-contained fetch keeps the fallback boundary obvious for v1; migrating the transport later is low-risk behind the `generateCoaching` server fn.

## Next Steps

1. Replace direct Grok fetches with the TanStack AI abstraction behind the same server-fn interface.
2. Personalize from history (recent `AIInteraction`s, trends) rather than a single day's signals.
3. Let users accept a suggestion to auto-create the corresponding task/plan entry.
4. Feed weekly narrative + analytics (ADR-008) into longer-horizon coaching.
