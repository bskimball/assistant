# ADR-003: R2 Key Naming Conventions and Compaction Strategy for Daily Aggregates

**Status**: Accepted  
**Date**: 2026-06-22  
**Deciders**: Brian Kimball

> **Consolidation note**: This is the single canonical ADR-003.  
> It merges and supersedes the two overlapping draft proposals that previously lived in `003-r2-key-conventions.md` and `003-r2-key-naming-and-compaction.md`.  
> The simpler domain-based date keys (`{domain}/{YYYY-MM-DD}.json`) matching the current implementation and glossary were selected for v1.

## Context

ADR-002 established the Core Domain Model with daily/weekly aggregate objects (`DailyNutrition`, `DailyPlan`, `DailyFinanceSnapshot`, `ProductivityTask` collections, etc.) and append-only logs (`AIInteraction`, `VoiceTranscript`).

The existing implementation in `src/server/adapters/r2.ts` (and helpers added for ADR-002) already defines:

- `getUserPrefix(userId)` → `assistant/{userId}`
- `getKey(collection)` → `assistant/{userId}/{collection}.json`
- Domain-aware: `getDailyKey(date, domain)`, `getWeeklyKey(week, domain)`, `getLogKey(domain, date?)`, `getRefKey`, `appendLogLine`
- Current user: `brian` (hardcoded `USER_ID`)

ADR-001 warned of eventual consistency and the need for "folder/key prefix conventions in R2 for 'tables'". Daily aggregates require a clear compaction approach because live updates (meals, tasks, AI suggestions, voice notes) occur inside a day.

We need a consistent, query-friendly, and compaction-aware key layout that:

- Preserves the existing `assistant/brian/` prefix and all `get*` helpers.
- Supports cheap daily reads for the unified improvement dashboard.
- Handles mutable daily state via simple read-modify-write on aggregates (personal scale).
- Keeps `AIInteraction` and `VoiceTranscript` as pure append-only logs.
- Enables an efficient 7-day hard-delete worker via date-sharded indexes.
- Allows future evolution (per-domain daily event logs) without breaking existing keys.

## Decision

Adopt the following R2 key naming conventions and compaction rules.

### 1. Base Prefix (unchanged)

All objects live under:

```
assistant/brian/
```

The helpers `getUserPrefix()`, `getKey()`, `getDailyKey()`, `getWeeklyKey()`, `getLogKey()`, `getRefKey()`, and `getDomainKey()` in `src/server/adapters/r2.ts` are the single source of truth.

### 2. Key Layout (v1 — chosen for simplicity)

```
assistant/brian/
├── {domain}/
│   └── {YYYY-MM-DD}.json          (Daily aggregate: nutrition, plan, productivity-tasks, focus-score, finance, ...)
│   └── {YYYY-MM-DD}.jsonl         (Daily append-only log shard, optional)
│   └── {YYYY}-W{ww}.json          (Weekly aggregates)
│   (ai-interactions.jsonl, voice-transcripts.jsonl also supported as single-file)
├── workouts/                      (or flat ref collections for v1)
│   └── plans.json | sessions.json (current implementation uses ref stores)
├── library/
│   └── exercise-library.json
├── meta/
│   └── deleted/
│       └── {YYYY-MM-DD}.json      (date-sharded soft-delete index; array of {key, deletedAt, domain})
└── (legacy flat collections)
    └── todos.json, kanban.json    (absorbed gradually into daily/.../productivity*)
```

**Preferred daily aggregate pattern** (implemented):

```
assistant/brian/{domain}/{YYYY-MM-DD}.json
```

Examples:
- `assistant/brian/daily-nutrition/2026-06-22.json`
- `assistant/brian/daily-plan/2026-06-22.json`
- `assistant/brian/productivity-tasks/2026-06-22.json`
- `assistant/brian/focus-score/2026-06-22.json`

**Append-only logs** (never compacted):

```
assistant/brian/{domain}/{YYYY-MM-DD}.jsonl
# or a single growing file:
assistant/brian/ai-interactions.jsonl
```

**Long-lived reference data** (flat):

```
assistant/brian/{collection}.json   # e.g. workout-plans.json, exercise-library.json
```

**Legacy collections** may remain at top level during migration and are gradually absorbed into daily productivity aggregates.

### 3. Daily Aggregate Compaction Strategy (Read-Modify-Write)

Daily aggregate objects are the primary read surface.

- When a live update occurs inside a day (log a meal, complete a task, AI suggestion):
  1. Read the full daily object (`get` — cheap).
  2. Merge the change in memory.
  3. Write the entire object back (`put` replaces the key).

This is the compaction strategy for v1.

Rationale:
- Daily objects stay small at personal scale.
- Single `get` + `put` is the cheapest and simplest R2 operation.
- No separate compaction worker or eager event merging required for correctness.

**Future option** (not required now): introduce sibling `{date}-events.json` or per-day event shards + lazy merge on read when the snapshot lags. `lastCompactedAt` can be added to aggregates for optimistic checks if that path is taken.

`AIInteraction` and `VoiceTranscript` remain pure append-only logs forever.

### 4. Soft-Delete + 7-Day Hard-Delete Worker

- Every entity carries optional `deletedAt` (soft delete).
- On soft delete of any entity, the implementation **records** an entry in the date-sharded index:
  `meta/deleted/{YYYY-MM-DD}.json`
  Record shape (example):
  ```json
  { "key": "assistant/brian/daily-nutrition/2026-06-22.json", "deletedAt": 1750000000000, "domain": "daily-nutrition" }
  ```
- The nightly (or periodic) hard-delete worker:
  1. For the last 8 date shards (today + previous 7 days), read each `meta/deleted/{date}.json`.
  2. For every record whose `deletedAt` is older than 7 days, call `deleteObject(key)`.
  3. After successful deletion, prune the processed old index shards.
- This keeps the worker O(days) instead of full-bucket `list()` scans (critical under eventual consistency and for cost).

Soft-delete is applied uniformly by setting `deletedAt` on the entity and (where applicable) recording the index entry. Entities with `deletedAt` are filtered out of normal reads.

### 5. AI / Voice Log Query Strategy (v1)

- Use daily-sharded `.jsonl` under `ai-interactions/` and `voice-transcripts/`.
- Simple prefix `list()` + in-code scan or line-by-line read is sufficient at personal scale.
- Future secondary indexes (e.g. `ai/indexes/by-intent/...`) can be layered on without changing primary log keys.

## Query Patterns Enabled

- "Tasks for today": prefix `assistant/brian/productivity-tasks/2026-06-22` + filter non-deleted.
- "Week nutrition": list `assistant/brian/daily-nutrition/2026-06-` and reduce totals.
- "Active workout plan": read the ref `workout-plans.json` and enforce single-active invariant in code.
- "Recent AI activity": read today's (or single) ai-interactions.jsonl.

### Compaction Strategy for Daily Aggregates

Daily objects are **not** append-only event logs. When a live update occurs inside a day (e.g., logging a second meal):

1. Read the full daily object (cheap `get`).
2. Merge the new event into the in-memory structure.
3. Write the entire object back (`put` replaces the key).

This is acceptable because:

- Daily objects stay small (personal scale).
- `get` + `put` on a single key is the cheapest R2 pattern.
- No compaction worker needed for daily objects.

**Exception**: If a daily object grows beyond ~500 KB (unlikely for one person), split into an immutable event shard + daily roll-up, but this is deferred.

## Consequences

**Positive**

- Daily aggregates map 1:1 (or day-sharded) to R2 keys → trivial, cheap `get` for dashboard.
- Append-only logs remain simple, auditable, and never compacted.
- Existing helpers in `src/server/adapters/r2.ts` are the source of truth; only additive functions were needed.
- Date-sharded delete index (`meta/deleted/`) makes the 7-day hard-delete worker efficient and cheap (O(days) work).
- Prefix listing + small daily objects gives effective "table scan" at personal scale without a DB.
- Read-modify-write compaction is simple to implement and reason about.

**Negative**

- Every update to a daily aggregate requires a full read-modify-write (no partial updates).
- No server-side indexing; filtering/aggregation happens in the Worker or client.
- Two files per active day only if/when we later adopt separate event shards (current v1 uses single aggregate file).

**Risks & Mitigations**

- Concurrent updates to the same daily key (voice + UI): optimistic UI + `updatedAt` timestamp / version vector or last-writer-wins (see ADR-001).
- Event log (jsonl) grows large on heavy day: daily shards + periodic rotation keep size bounded; compaction of aggregates is cheap.
- Worker must be careful with eventual consistency: use short lookback (8 days) and re-entrancy safe deletes.

## Alternatives Considered

1. **Everything flat under `assistant/brian/{collection}.json`** (pre-ADR-002 state): Rejected for daily aggregates. Loses natural per-day query surface and forces bigger objects.
2. **Nested daily folder + separate immutable event files per domain per day** (`daily/{date}/nutrition.json` + `nutrition-events.json`): Attractive for full event sourcing and audit, but adds write amplification and complexity. Rejected for v1 in favor of simple RMW aggregates + append logs.
3. **Eager compaction / full event sourcing from day one**: Overkill for single user; increases cost and latency without benefit.
4. **Single global index for deletes**: Would require listing large prefixes; date sharding wins.

**Chosen design** balances read performance (cheap daily gets), write safety (append logs + full RMW), storage cost (7d hard delete), and implementation simplicity.

## Next Steps

- (Done) Add `getDailyKey`, `getWeeklyKey`, `getLogKey`, `appendLogLine` and related helpers (completed alongside ADR-002).
- Implement date-sharded soft-delete index recording (`getDeletedIndexKey`, `recordSoftDelete`).
- Wire soft-delete paths in server domain functions to also write to the meta/deleted shards.
- Build the hard-delete maintenance function / worker (cron or on-demand) that consumes the last 8 delete shards.
- Migrate legacy `todos.json` / kanban into `productivity-tasks/{date}.json` over time (ProductivityTask already unifies the model).
- ADR-004: Voice interaction pipeline.
- Optional later: per-domain event shards + lazy compaction utility if a daily aggregate grows large.

---

**R2 key conventions and compaction rules defined in this ADR supersede any prior ad-hoc patterns and the previous duplicate 003 proposal.**

**Glossary and `docs/ai/` artifacts must be kept in sync with this ADR.**
