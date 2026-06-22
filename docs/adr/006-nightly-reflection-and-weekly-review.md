# ADR-006: Nightly Reflection Generation & Weekly Review Surface

**Status**: Accepted  
**Date**: 2026-06-22  
**Deciders**: Brian Kimball

## Context

The Unified Daily Improvement Dashboard (ADR-005) answers “How am I doing today?” with live aggregates and the most recent voice/AI note. As usage grows, the user wants a higher-level synthesized view that:

- Produces a concise, human-sounding nightly reflection summarizing the day’s key signals.
- Offers a weekly overview surface that aggregates the last 7 days without extra LLM cost.
- Remains fully under user control (regenerate, edit, delete).
- Follows the existing R2 key conventions (ADR-003) and single-user tenancy model.

The nightly reflection is explicitly **optional** — the dashboard headline already provides zero-cost insight. ADR-006 adds value only when the user wants deeper narrative synthesis.

## Decision

Implement an **optional nightly reflection pipeline** plus a **client-side weekly review surface** with the following characteristics.

### 1. Trigger & Scheduling Model (Hybrid)

- A scheduled Cloudflare Worker / Workflow runs nightly at ~23:30 local time.
- The job checks whether `daily/{YYYY-MM-DD}/reflection.json` already exists for the *completed* day.
- If absent (or older than a configurable TTL), it generates a fresh reflection using the hybrid template + lightweight LLM approach.
- For the *current mutable day*, the user can explicitly request “refresh today’s reflection” via voice (“Hey assistant, give me today’s reflection”) or a UI button; this triggers an immediate on-demand generation that overwrites the existing file.
- Past days remain read-only unless the user explicitly triggers regeneration.

### 2. Reflection Content & Synthesis Model (Template + Lightweight LLM)

Each `reflection.json` contains:

```json
{
  "generatedAt": "2026-06-22T23:31:05Z",
  "modelVersion": "grok-4.3-lite@2026-06",
  "headline": "Strong nutrition day, solid task momentum",
  "body": "You hit 142 g protein (95 % of target) and completed 7 of 9 tasks. Focus score was 48 minutes — a good base but room to grow deep-work blocks.",
  "microSuggestion": "Block two 25-minute Pomodoros for the highest-priority task before lunch tomorrow.",
  "sourceMetrics": {
    "proteinPct": 95,
    "tasksDone": 7,
    "tasksTotal": 9,
    "focusMinutes": 48
  }
}
```

- A deterministic template first assembles the factual skeleton from `DailyNutrition`, `ProductivityTask` counts, `DailyFocusScore`, and `AIInteraction` volume.
- A lightweight Grok call (short prompt, ~150 tokens) then contributes:
  - One encouraging tone sentence.
  - One concrete micro-suggestion (≤ 140 characters) that is actionable the next day.
- The `sourceMetrics` object is stored for transparency and future analytics; it also allows the UI to show “based on 95 % protein, 78 % task completion…”.

### 3. R2 Storage Location

Reflections live inside the existing daily folder:

```
assistant/brian/daily/{YYYY-MM-DD}/reflection.json
```

- Co-location keeps all day-level data together (nutrition, productivity, plan, reflection).
- The dashboard can fetch the entire day’s state with a single `listObjects` prefix call.
- Regeneration simply overwrites the file (idempotent). If an audit trail is later required, a `reflection-regenerated` event can be appended to an events file.

### 4. Weekly Review Surface (Client-Side Aggregation)

- A new route `/weekly` (or a collapsible “This Week” section on the dashboard) displays the last 7 days.
- On load the client fetches the 7 `reflection.json` files (or falls back to the underlying aggregates if a day has no reflection yet).
- Visualisation:
  - 7-day trend spark lines for protein %, task completion %, focus minutes.
  - One-sentence weekly narrative synthesized client-side from the 7 headlines (no extra LLM call).
  - Highlighted “best day” and “focus opportunity” based on simple heuristics.
- Because aggregation is purely client-side, there is zero additional scheduled work or storage cost for weekly views.

### 5. User Control & Privacy

- Full user ownership: the user may:
  - Request regeneration of any day’s reflection via voice or UI.
  - Edit the `microSuggestion` inline (writes back to `reflection.json`).
  - Delete the reflection entirely (removes the file or writes a tombstone).
- All mutations go through the same authenticated `putObject` / `deleteObject` paths used by the voice pipeline.
- No reflection is ever generated without an explicit trigger (scheduled job or user request), preserving the “optional” nature of the feature.

## Consequences

**Positive**

- Nightly reflections give the user a reflective, encouraging close-of-day ritual without manual journaling.
- Template + lightweight LLM keeps token cost low (~150 tokens vs. full daily payload) while still sounding personal.
- Client-side weekly aggregation adds zero infrastructure cost and remains fast.
- Full user control aligns with privacy-first and person-first principles.
- Storage co-location with daily aggregates simplifies future analytics.

**Negative**

- Another background job (even if lightweight) increases operational surface.
- The micro-suggestion may occasionally feel generic if the template metrics lack nuance; user editing mitigates this.
- Weekly narrative quality is limited by client-side heuristics; may need promotion to pre-computed artifact later.

**Risks & Mitigations**

- Scheduled job fails silently → add simple success/failure logging to a `jobs/` prefix and a dashboard “last reflection run” indicator.
- User edits to micro-suggestion are overwritten on next regeneration → store user edits in a sibling `reflection-user-edits.json` or simply re-apply the edit after regeneration (future enhancement).
- LLM occasionally produces off-brand tone → keep the prompt tightly scoped and allow instant user edit.

## Alternatives Considered

1. **Pure LLM synthesis every night (Option A)** – Highest narrative quality but sends the entire daily payload; rejected for cost and latency.
2. **Pre-computed weekly snapshot (Option B)** – Would require another scheduled job and extra R2 object; deferred until usage data justifies it.
3. **Read-only reflections after generation (Option B in control question)** – Simpler but contradicts user-ownership principle; rejected.

## Next Steps

1. Create the scheduled Worker / Workflow entry point (`src/workers/nightly-reflection.ts` or equivalent).
2. Implement the template builder + lightweight Grok call helper.
3. Add R2 read/write helpers for `reflection.json` following ADR-003 conventions.
4. Build the `/weekly` route or dashboard section with 7-day client-side aggregation and spark lines.
5. Wire voice commands: “give me today’s reflection”, “regenerate yesterday’s reflection”, “edit my suggestion”.
6. Update AGENTS.md to mark “Nightly reflection + weekly review” as the next priority after the core dashboard.
7. (Optional) ADR-007: Pre-computed weekly narrative + deeper analytics if the weekly surface proves high-value.