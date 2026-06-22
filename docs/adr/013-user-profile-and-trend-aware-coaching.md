# ADR-013: User Profile + Trend-Aware Coaching

**Status**: Accepted
**Date**: 2026-06-22
**Deciders**: Brian Kimball

## Context

The Coach Engine (ADR-011) gave genuinely cross-domain advice, but it reasoned from **today's numbers only** and knew **nothing about the person**. Two structural blind spots:

1. **No personalization.** `user-preferences.json` was named in the storage conventions (ADR-003) but never written or read. The coach had no age, height, goals, injuries, dietary restrictions, equipment, or risk tolerance. It could prescribe overhead pressing to someone with a shoulder injury or suggest a steak to a vegetarian, because it had no way to know better. Protein/water targets were hardcoded constants.
2. **No memory of momentum.** `collectSignals` loaded a single day. The coach literally could not say "protein is trending down this week" or "you've trained twice — hit your third session," because it never looked at more than one day. The headline even claimed to "keep the streak alive" while nothing tracked a streak.

The grilling questions:

- **"Can advice be good without knowing the person?"** No — generic coaching is the failure mode we're trying to beat.
- **"Where does identity live?"** A daily aggregate is wrong; this is long-lived reference data.
- **"How much history is enough?"** Enough to see direction without making the coach expensive to run.

## Decision

Add a **long-lived `UserProfile`** and a **trailing 7-day trend**, and feed both into every coaching path (AI and deterministic fallback alike).

### 1. `UserProfile` (long-lived reference)

- New `UserProfile` type (`src/lib/domain.ts`) with optional fields across all four advisor lenses: identity (age via `birthDate`, sex, height, units, timezone), coaching (goals, activity level), fitness (injuries, training days/week, equipment), nutrition (dietary restrictions, protein/calorie/water targets), finance (risk tolerance, monthly savings goal, notes).
- Persisted as a single reference object at `assistant/brian/user-profile.json` (NOT a daily aggregate — it changes rarely), via `loadUserProfile` / `saveUserProfile` server functions. `saveUserProfile` **merges** partial updates so one form never clobbers unrelated fields.
- **Every field is optional.** An empty profile degrades gracefully — same contract as a missing `GROK_API_KEY`. `computeAge()` derives age from `birthDate` so we never store a number that goes stale.

### 2. Trailing 7-day trend (`collectTrend`)

- New `TrendSignals` summarizing the window ending on the target date: active days, window-wide task completion %, average protein % of target + days on target + direction (`up`/`down`/`flat`), average water, workouts performed, and net-worth change.
- Built from the **lighter per-domain loaders** (`loadDailyNutrition` / `loadProductivityTasksForDay` / `loadDailyFinance`) plus one `loadWorkoutSessions` read — deliberately **not** `loadDailyDashboard` per day, to avoid 7× of the per-day `.jsonl` log reads.

### 3. Wiring into the coach

- `collectSignals(date, profile)` now resolves the protein target as **plan target → profile target → 150g default**.
- The Grok prompt gains a profile block and a trend block, with explicit instructions to **never contradict injuries or dietary restrictions** and to personalize to the trend.
- The deterministic fallback now references the trend (workouts vs. target, net-worth change, a momentum suggestion) and the profile (injury caveats, savings goal, water target, name in the headline) — so the zero-config experience improves too.

## Consequences

**Positive**

- One change multiplies the quality of _all_ existing advice — focus, fitness, nutrition, finance — because every suggestion is now personalized and momentum-aware.
- Injuries and dietary restrictions are first-class constraints, not things the coach can blunder into.
- The deterministic fallback got materially better, preserving the "works with no API key" guarantee.

**Negative**

- `collectTrend` adds ~22 R2 reads per coaching run (3 domains × 7 days + sessions). Acceptable at personal scale; cache/window-tuning is available if it ever matters.
- The profile is only useful once filled in; an empty profile yields the same generic advice as before (mitigated: the coach nudges the user to fill it out).

**Risks & Mitigations**

- _Stale profile_ (e.g. a healed injury) → fields are easy to edit and merge-saved; age is derived not stored.
- _Sparse history skews trends_ → trend metrics are guarded (averages only over days that logged food; momentum suggestion only fires with ≥2 active days; protein direction needs ≥2 data points).

## Alternatives Considered

1. **Reuse `UserPreferences` (ADR-002)** — Too thin (timezone/units only) and overloaded; a dedicated coaching profile keeps concerns clean.
2. **Store profile as a daily aggregate** — Wrong granularity; identity isn't a per-day fact and would fragment across files.
3. **Compute trends from `loadDailyDashboard` per day** — Simpler to call but pays for per-day `.jsonl` reads the trend doesn't use. Rejected on cost.
4. **Push trend computation into a precomputed weekly rollup (ADR-007)** — Good future optimization, but couples the daily coach to the weekly pipeline. Deferred.

## Next Steps

1. Add a `/profile` settings route so the user can actually fill in the profile (currently API-only).
2. Re-run coaching automatically when the profile changes (mirror the finance-save → re-coach behavior from ADR-012).
3. Feed the profile into the weekly narrative (`generateWeeklyNarrative`) too.
4. Use `activityLevel` + age + height + sex to derive default calorie/protein targets when the user hasn't set them.
