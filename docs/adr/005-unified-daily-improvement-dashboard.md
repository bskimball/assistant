# ADR-005: Unified Daily Improvement Dashboard

**Status**: Accepted  
**Date**: 2026-06-22  
**Deciders**: Brian Kimball

## Context

The voice pipeline (ADR-004) produces `VoiceTranscript` and `AIInteraction` records and executes domain actions that mutate daily aggregates (`DailyNutrition`, `ProductivityTask`, `DailyPlan`, etc.). The user needs a single, always-current surface that shows the result of those actions and answers the question “How am I doing today?”

ADR-002 defined the core daily aggregates. ADR-003 established the R2 key layout (`daily/{YYYY-MM-DD}/...` snapshots + events). The existing home page (`src/routes/index.tsx`) only shows the legacy todo list. We now need a unified dashboard that:

- Aggregates all daily domain data for a chosen date.
- Reacts instantly to voice-driven updates.
- Surfaces the most recent voice/AI activity without extra LLM cost.
- Provides a clear, voice-first entry point.
- Works for both the mutable current day and read-only past days.

## Decision

Build a **Unified Daily Improvement Dashboard** as the default route (`/`) with the following characteristics.

### 1. Default View & Primary Headline

- On load the dashboard defaults to **today** (derived from the client clock, normalized to `YYYY-MM-DD`).
- The topmost element is a **progress ring + headline** that synthesizes three high-signal metrics:
  - Focus progress (tasks done / total + focus minutes from `DailyFocusScore`)
  - Nutrition protein progress (current / target from `DailyNutrition`)
  - Most recent AI/voice note (the `assistantResponse` text or last `VoiceTranscript` text from the most recent `AIInteraction` / `VoiceTranscript` for the day)
- The headline answers “How am I doing today?” in one glance. All other sections (nutrition details, task list, recent activity) appear below in a scrollable, collapsible layout.

### 2. Data Fetching & Reactivity

- The dashboard uses **TanStack DB collections** for the active day’s aggregates (`DailyNutrition`, `ProductivityTask` list, `DailyPlan`, etc.).
- On initial load or date change it performs a single `get` for the compacted snapshot (`daily/{date}/nutrition.json`, `productivity.json`, etc.).
- If the day is the current mutable day, it also fetches the sibling `*-events.json` file and merges events on the client (lazy compaction per ADR-003).
- The dashboard subscribes to TanStack DB changes. Any voice pipeline write (new `MealLog`, new `ProductivityTask`, etc.) triggers an immediate re-render without a full page reload.
- For past days only the compacted snapshot is fetched; the events file is skipped.

### 3. Date Navigation & URL State

- A compact date navigation bar appears at the top: `◀ Yesterday | Today (highlighted) | Tomorrow ▶` plus a calendar date picker.
- The selected date is reflected in the URL query parameter: `/?date=2026-06-22`.
- On load the route reads the `date` param (defaulting to today if absent or invalid).
- Changing the date updates the URL (history push), making the view bookmarkable and refresh-safe.
- When viewing a past date the UI is read-only: voice input, quick-add forms, and edit controls are disabled. Only the current day shows the full interactive surface.

### 4. Voice Input Activation

- A persistent, prominent **microphone FAB** (or large top-bar mic icon) is always visible when viewing the current day.
- Tapping it starts browser `SpeechRecognition` (ADR-004).
- While listening:
  - The dashboard background dims slightly.
  - A centered “Listening…” overlay with a simple animated waveform appears.
  - The FAB becomes a pulsing red stop button.
- On successful transcript or cancellation the overlay disappears and the result appears inline with a subtle success indicator.
- The same control remains active for the voice confirmation step required by destructive actions (“Delete this task – are you sure?”).

### 5. AI / Voice Headline Source (No Extra LLM Call)

- The headline’s third signal is taken directly from the most recent `AIInteraction.assistantResponse` or the last `VoiceTranscript.rawTranscript` for the selected day.
- No additional Grok call is made on dashboard load. This keeps the experience fast, zero-cost, and truly voice-native.
- Future enhancement (ADR-006 or later) may add an optional nightly “daily reflection” generation if synthesized insights become valuable.

### 6. Section Layout (Initial v1)

The dashboard body contains (top to bottom, collapsible):

1. **Focus & Tasks** – `DailyFocusScore` ring + top 5 open `ProductivityTask`s + quick-add / voice-add entry.
2. **Nutrition** – Protein / macro progress bars from `DailyNutrition` + recent `MealLog` list.
3. **Plan & AI Suggestions** – Today’s `DailyPlan` targets and any AI-generated recommendations.
4. **Recent Activity** – Chronological list of today’s `AIInteraction` and `VoiceTranscript` entries (most recent first).
5. **Finance** (optional, collapsed by default) – `DailyFinanceSnapshot` summary.

All sections read from the daily aggregates defined in ADR-002 and stored under the ADR-003 key layout.

## Consequences

**Positive**

- Single source of truth for “How am I doing today?” that unifies every domain.
- Instant reactivity to voice interactions via TanStack DB.
- Zero extra LLM cost for the headline insight.
- URL-driven date navigation is bookmarkable and resilient.
- Clear voice-first entry point (mic FAB) makes the voice pipeline feel complete.
- Read-only past days prevent accidental edits while still allowing historical review.

**Negative**

- Client must implement the snapshot + events merge logic for the current day.
- Two write paths (new daily aggregate + legacy `todos.json`) remain during the migration window.
- The headline is only as good as the last assistant response; if the user has not spoken yet the section may feel sparse.

**Risks & Mitigations**

- Event log grows large on a heavy day → keep events small; lazy merge runs on every dashboard load for the current day.
- URL date param tampering → server/client validation that the date is a valid `YYYY-MM-DD` within a reasonable window (e.g., last 90 days).
- Legacy todo drift during migration → once the dashboard and task UI are updated, remove the legacy write shim.

## Alternatives Considered

1. **Fresh Grok insight on every load (Option A)** – Higher quality synthesized summary but adds latency and cost. Rejected for v1.
2. **Pre-computed nightly insight stored in `daily/{date}/insight.json` (Option B)** – Good middle ground, but still requires a background worker and extra storage. Deferred.
3. **Client-side only state with no URL date param** – Simpler implementation but loses bookmarking and refresh safety. Rejected.

## Next Steps

1. Replace the current `src/routes/index.tsx` with the new Unified Daily Improvement Dashboard component.
2. Create TanStack DB collections and R2 read helpers for `DailyNutrition`, `ProductivityTask`, `DailyPlan`, `DailyFocusScore`, etc.
3. Implement the date navigation bar + URL query param handling.
4. Add the persistent microphone FAB + listening overlay (re-uses the `VoiceInput` component from ADR-004).
5. Wire the headline to the most recent `AIInteraction` / `VoiceTranscript`.
6. Update AGENTS.md to mark “Voice input/output system” and “Unified daily/weekly improvement dashboard” as the current top priorities.
7. ADR-006 (optional): Nightly AI reflection generation + weekly review surface.
