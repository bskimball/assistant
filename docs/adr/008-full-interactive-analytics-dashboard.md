# ADR-008: Full Interactive Analytics Dashboard

**Status**: Accepted  
**Date**: 2026-06-22  
**Deciders**: Brian Kimball

## Context

The Pre-computed Weekly Narrative & Analytics Surface (ADR-007) introduced a rolling weekly coaching narrative plus domain-specific 7-day/30-day trend cards. As the user derives increasing value from longitudinal insight, the desire grows for a **full interactive analytics experience** that goes well beyond static cards:

- Arbitrary date-range exploration (not limited to 7/30/90-day presets).
- Rich interactive visualizations: weekday × hour-of-day heat maps, scatter correlation views, multi-metric overlays, goal vs actual comparisons.
- Export capabilities (CSV, JSON, PNG charts) for external analysis or sharing.
- Saved custom dashboards and shareable analytical views.
- A dedicated `/analytics` workspace that feels like a true data exploration environment.

This ADR defines the architecture, data strategy, visualization model, and user-control surface for that full analytics dashboard while preserving the single-user, privacy-first, voice-first principles established in prior ADRs.

## Decision

Build a **dedicated interactive analytics workspace** (`/analytics` route) with a hybrid pre-computed + smart-cached data strategy and a curated but powerful widget set.

### 1. Entry Point & Navigation Model (Dedicated `/analytics` Route)

- A top-level navigation item “Analytics” (or a prominent “Deep Dive” button from the Weekly view) opens `/analytics`.
- The route supports deep linking via query parameters:
  - `?range=2026-05-01..2026-06-22` (custom date range)
  - `?view=focus-heatmap` (direct widget focus)
  - `?metrics=protein,focus,tasks` (pre-selected metrics)
- Bookmarking and shareable links are first-class; the URL fully describes the current analytical state.
- The Weekly view retains its domain trend cards and contains a clear “Open full analytics” CTA that carries the current week’s context into the analytics workspace.

### 2. Data Scope & Pre-computation Strategy (Hybrid with Smart Caching)

Nightly scheduled jobs produce:

- `analytics/30-day.json`, `analytics/90-day.json`, `analytics/ytd.json` — pre-aggregated rollups for the most common windows.
- `analytics/correlations.json` — pairwise correlation coefficients and simple regression data for key metric pairs (protein vs focus, sleep vs task completion, etc.).
- `analytics/weekday-hour-heatmaps.json` — normalized focus, task, and nutrition density by weekday × hour-of-day.

On-demand Worker endpoints handle:

- Arbitrary date-range queries (`?from=2026-03-15&to=2026-06-22`).
- Custom metric combinations and derived calculations.
- Results are cached for 24 h (or until the next nightly job) using a deterministic cache key derived from the query parameters.

This hybrid approach keeps common views instant while still allowing flexible exploration without waiting for a nightly job.

### 3. Visualization & Interaction Model (Rich but Focused Widget Set)

The analytics workspace presents a curated collection of high-value interactive widgets:

- **Multi-metric line / bar charts** — overlay any combination of nutrition, task, focus, and finance metrics with goal lines and trend annotations.
- **Weekday × hour-of-day heat maps** — focus minutes, task density, or protein intake visualized as a calendar-style grid; clicking a cell filters the rest of the dashboard to that weekday/hour slice.
- **Scatter & correlation views** — draggable X/Y axis selectors with regression line and outlier highlighting; clicking a point surfaces the underlying daily record in a detail drawer.
- **Goal vs actual comparison** — for any metric with a defined target, show cumulative progress, streak information, and “days ahead/behind” calculations.
- **Date-range picker + presets** — classic calendar range selector plus quick presets (Last 7, 30, 90 days; Year to date; All time).
- **Export toolbar** — export the currently visible data as CSV/JSON; export any chart as PNG/SVG with current filters applied.

All widgets are reactive to the global date range and metric filters. The UI encourages exploration without overwhelming the user with an unbounded notebook canvas.

### 4. Saved Dashboards & Shareable Views

- Users can save the current widget layout + filters as a named “Dashboard” (stored in `analytics/dashboards/{slug}.json`).
- Saved dashboards appear in a collapsible “My Dashboards” sidebar and are accessible via `/analytics/d/{slug}`.
- Any analytical view (including unsaved ones) can be shared via a URL; the recipient sees the exact same widgets, range, and filters.
- Sharing is read-only by default; the recipient can “Duplicate to my dashboards” to gain edit rights.

### 5. User Control, Privacy & Voice Integration

- Full user ownership: the user may delete any saved dashboard, regenerate any pre-computed analytics artifact, or purge the analytics cache.
- All writes go through the same authenticated R2 paths used by the voice pipeline.
- Voice commands are supported for common actions:
  - “Show me my focus heat map for the last 90 days”
  - “Compare protein and focus for May”
  - “Export this view as CSV”
  - “Save this dashboard as Morning Routine Analysis”
- The analytics workspace is read-only for past data; the user cannot accidentally mutate historical records from within the analytics surface.

## Consequences

**Positive**

- A dedicated `/analytics` workspace provides a true data exploration environment without cluttering the daily or weekly views.
- Hybrid pre-computation + smart caching delivers both speed for common queries and flexibility for arbitrary ranges.
- The curated widget set (heat maps, correlations, goal overlays) surfaces high-value longitudinal insight without a steep learning curve.
- Saved dashboards + shareable URLs make analytical work reusable and collaborative.
- Voice integration keeps the entire analytics experience consistent with the voice-first principle.

**Negative**

- Additional scheduled jobs and cache-invalidation logic increase operational surface.
- The curated widget set may eventually feel limiting for power users (mitigated by future ADR-009 notebook canvas).
- Pre-computed correlation matrices must be regenerated when new daily data arrives; a 24-hour staleness window is acceptable but not real-time.

**Risks & Mitigations**

- Arbitrary date-range queries become expensive on large histories → enforce a reasonable maximum range (e.g., 2 years) and surface a “too broad — narrow your range” message.
- Saved dashboards proliferate → provide a simple management UI and a “last used” sort order.
- Voice command ambiguity in the analytics context → scope voice intents to the current widget set and provide disambiguation prompts.

## Alternatives Considered

1. **Expandable section inside Weekly view (Option B)** – Rejected because the feature richness justifies a dedicated workspace and deep-linkable URLs.
2. **Notebook-style free-form canvas (Option C)** – Powerful but overwhelming for v1; deferred to ADR-009.
3. **Fully pre-computed aggregates only (Option A)** – Rejected because it removes the ability to explore arbitrary historical ranges without waiting for a nightly job.

## Next Steps

1. Create the `/analytics` route and global date-range / metric filter context provider.
2. Implement the nightly pre-computation jobs for 30/90/YTD rollups, correlations, and heat-map data.
3. Build the core interactive widgets (multi-metric charts, weekday-hour heat maps, scatter correlations, goal comparisons).
4. Add the export toolbar (CSV/JSON data, PNG/SVG chart exports) and saved dashboard persistence layer.
5. Wire voice intents for common analytical commands and dashboard saving.
6. Update AGENTS.md to mark “Full interactive analytics dashboard” as the current priority.
7. (Optional) ADR-009: Notebook-style analytics canvas for power users who outgrow the curated widget set.
