# ADR-007: Pre-computed Weekly Narrative & Analytics Surface

**Status**: Accepted  
**Date**: 2026-06-22  
**Deciders**: Brian Kimball

## Context

The Nightly Reflection & Weekly Review feature (ADR-006) introduced client-side weekly aggregation with lightweight, heuristic-based narrative. As the user experiences the value of longitudinal insight, the desire grows for a richer, pre-computed weekly narrative that:

- Runs on a rolling 7-day window (refreshed nightly) so the current week always feels fresh.
- Produces a full coaching-style narrative (150–200 words) with pattern recognition and 2–3 prioritized experiments.
- Adds domain-specific trend cards (7-day + 30-day) for nutrition, productivity, focus, and finance.
- Remains fully under user control (regenerate, edit experiments, delete).
- Follows the existing R2 key conventions (ADR-003) and single-user tenancy model.

This ADR promotes the weekly layer from purely client-side to a scheduled, LLM-generated artifact while keeping the daily reflection (ADR-006) as the lightweight close-of-day ritual.

## Decision

Implement a **pre-computed weekly narrative pipeline** plus **domain-specific trend analytics** with the following characteristics.

### 1. Trigger & Scheduling Cadence (Rolling 7-Day Window)

- A scheduled Cloudflare Worker / Workflow runs nightly (~23:30 local time).
- For the current in-progress week (e.g., `2026-W25`), the job regenerates `weekly/2026-W25/narrative.json`.
- Completed weeks remain static unless the user explicitly requests regeneration.
- The user can trigger an immediate refresh via voice (“refresh this week’s story”) or UI button at any time.
- This rolling model ensures the weekly surface always reflects the latest 7 days without requiring the user to wait until Sunday.

### 2. Weekly Narrative Content Depth (Coaching-Style Narrative)

Each `narrative.json` contains a richer synthesis than the daily reflection:

```json
{
  "weekKey": "2026-W25",
  "generatedAt": "2026-06-22T23:32:10Z",
  "modelVersion": "grok-4.3@2026-06",
  "headline": "Your most consistent nutrition week yet — focus now shifts to deep-work blocks",
  "narrative": "This week you hit 94 % of your protein target on average, with Tuesday and Thursday as standout days (142 g and 138 g). Task completion stayed strong at 78 %, but focus minutes dipped mid-week. The pattern is clear: your best deep-work sessions happen on days you log breakfast before 8 a.m. Your micro-experiments for next week: (1) protect a 90-minute deep-work block immediately after morning protein, (2) batch all admin tasks into a single 45-minute Friday afternoon window, (3) try a 10-minute evening walk after dinner to improve sleep consistency.",
  "experiments": [
    "Protect a 90-minute deep-work block right after morning protein",
    "Batch admin into one 45-minute Friday afternoon window",
    "10-minute evening walk after dinner for sleep consistency"
  ],
  "sourceMetrics": {
    "avgProteinPct": 94,
    "avgTaskCompletion": 78,
    "totalFocusMinutes": 312,
    "bestFocusDay": "2026-06-17",
    "nutritionConsistencyScore": 0.91
  }
}
```

- The prompt sends a compact 7-day aggregate payload (daily headlines, key metrics, recent AIInteractions) to Grok.
- The model is instructed to produce:
  - One headline sentence.
  - A 150–200 word coaching-style narrative that identifies patterns, celebrates wins, and surfaces friction points.
  - Exactly 2–3 concrete, testable experiments for the coming week.
- Token cost is higher than daily reflections (~400–600 tokens) but still modest; the value of a true weekly coaching artifact justifies the expense.

### 3. R2 Storage Layout (Year-Week Sharded Folder)

Weekly narratives live under a new top-level prefix:

```
assistant/brian/weekly/{YYYY-WNN}/narrative.json
```

- Example: `weekly/2026-W25/narrative.json`
- Co-location within the week folder allows future artifacts (raw 7-day aggregates, chart data exports, user-edited experiments) to sit alongside the narrative.
- The file is overwritten on each nightly refresh (idempotent). User edits to experiments are preserved via a sibling `user-experiments.json` or re-applied after regeneration (implementation detail).

### 4. Analytics Depth (Domain-Specific Trend Cards)

The weekly surface expands beyond the narrative to include:

- **7-day and 30-day trend cards** per domain:
  - Nutrition: protein consistency %, average intake vs target, macro balance trend.
  - Productivity: task completion velocity, open vs completed ratio, recurring task health.
  - Focus: total minutes, weekday distribution heat map, correlation with nutrition/finance.
  - Finance (if enabled): daily spend vs budget, category drift.
- Visualisations remain lightweight (spark lines, small bar charts, simple heat maps) and render client-side from the fetched weekly aggregates.
- No full interactive analytics dashboard yet; that scope is deferred to ADR-008 if usage data warrants it.

### 5. User Control & Privacy (Full Ownership)

- The user may:
  - Request regeneration of any week’s narrative via voice or UI.
  - Edit the `experiments` list inline (writes back to `narrative.json` or a user-edits sibling file).
  - Delete the narrative entirely (removes the file or writes a tombstone).
- All mutations go through the same authenticated `putObject` / `deleteObject` paths.
- No weekly narrative is ever generated without an explicit trigger (scheduled job or user request), preserving user agency.

## Consequences

**Positive**

- Rolling nightly refresh keeps the weekly coaching narrative continuously relevant.
- Full coaching-style depth (patterns + experiments) delivers higher perceived value than stitched daily headlines.
- Domain-specific 7-day/30-day trend cards give the user longitudinal insight without a full analytics suite.
- Storage layout scales cleanly and stays consistent with ADR-003 conventions.
- Full user control maintains the privacy-first, person-first contract.

**Negative**

- Higher per-week token cost (~400–600 tokens nightly) compared with daily reflections.
- Another scheduled job increases operational surface (mitigated by simple success/failure logging).
- User edits to experiments require careful merge logic on regeneration.

**Risks & Mitigations**

- LLM produces overly generic experiments → tighten prompt with user-specific context (past experiments, stated goals) and allow instant editing.
- 30-day trend calculation becomes expensive → pre-aggregate 30-day rollups into a small `analytics/30-day.json` snapshot refreshed nightly.
- User confusion between daily reflection and weekly narrative → clear UI labeling (“Close-of-day note” vs “Weekly coaching story”).

## Alternatives Considered

1. **Lightweight synthesis only (Option A)** – Rejected because it duplicates the client-side heuristic already in ADR-006 and fails to deliver new coaching value.
2. **End-of-week only scheduling (Option A in trigger question)** – Rejected because it leaves the current week stale for 6 days.
3. **Full interactive analytics dashboard (Option C)** – Powerful but out of scope for this iteration; deferred to ADR-008.

## Next Steps

1. Extend the nightly Worker to also generate weekly narratives on the rolling 7-day window.
2. Implement the richer weekly prompt template and Grok call helper (separate from the daily reflection prompt).
3. Add R2 helpers for `weekly/{YYYY-WNN}/narrative.json`.
4. Build the expanded weekly route/section with domain trend cards and editable experiments list.
5. Wire voice commands: “refresh this week’s story”, “edit my experiments”, “show me my 30-day focus trend”.
6. Update AGENTS.md to reflect the new weekly coaching layer as a completed priority.
7. (Optional) ADR-008: Full interactive analytics dashboard (heat maps, correlations, exports) if the trend cards prove high-value.