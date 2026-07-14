# ADR-024: Durable Productivity Board (cross-day todos)

**Status**: Accepted  
**Date**: 2026-07-14  
**Deciders**: Brian Kimball

## Context

`ProductivityTask` records were stored only as per-day R2 aggregates (`productivity-tasks/{YYYY-MM-DD}.json`). The dashboard and Kanban filtered by `task.date === selectedDate`, so open todos vanished overnight even though they were never completed. Users need a durable board: todos persist until done, cancelled, or deleted, and day views record history rather than define ownership.

## Decision

Split productivity storage into:

1. **Durable board** — `productivity-board.json` (ref store, personal + household scopes) holds every open task (`pending` / `in_progress`, not soft-deleted). Concurrent writes use `ref.update` CAS.
2. **Day archive** — `productivity-tasks/{date}.json` holds tasks completed or cancelled on that day (and remains the historical surface for analytics / weekly review).

### Load for day `D`

- Always load the durable board (personal + shared).
- Load the day archive for `D`.
- If `D` is today: return **open board tasks + today's archived tasks**.
- If `D` is a past day: return **that day's archive only** (read-only history of what finished or was recorded then).
- One-time migration: any still-open tasks found inside a day archive are merged into the board and removed from that archive so they stop disappearing.

### Save for day `D`

- Open tasks in the payload update the durable board (CAS; personal/shared split by `shared`).
- Done/cancelled/deleted tasks for `D` replace the day archive for `D`.
- Open tasks are never written back into day archives.

### Client visibility

- `getTasksForDate(today)` returns all open board tasks plus today's archive.
- Past dates return only tasks hydrated for that archive day.
- Kanban loads from the server when the selected date changes (not only via dashboard hydration).

### Semantics of `ProductivityTask.date`

- `date` remains the planned/created day (analytics, coach copy).
- Longevity is determined by `status` / `done` / `deletedAt`, not by `date` equaling "today".
- Optional `due` continues to drive reminders and overdue next-best-action.

## Consequences

**Positive**

- Open todos persist across midnights and reloads.
- Shared vs personal scoping unchanged (board + archive both split by `shared`).
- Day archives stay useful for weekly/analytics completion rates.
- Matches household mental model: a board of work, not a disposable daily list.

**Negative**

- Two storage surfaces to keep consistent on every write.
- Past-day views no longer re-show still-open tasks that were created earlier (they live on the board under "today").
- Existing open tasks only migrate when their day archive is next loaded.

## Alternatives considered

- **Carry-forward copy** of yesterday's open tasks into today: duplicates IDs or rewrites history; worse multi-writer behavior.
- **Single flat `todos.json` only**: reintroduces the legacy shim and loses day-level completion history for weekly review.
