# ADR-020: Coach Memory & Adaptive Profile (durable facts across conversations)

**Status**: Proposed
**Date**: 2026-07-06
**Deciders**: Brian Kimball

## Context

The conversational Coach (ADR-018) is data-aware but **amnesiac across conversations**: each turn sees the profile, today's dashboard, and the 7-day trend, plus at most the last 24 turns of the _current_ conversation. Anything the member shares in chat that isn't reflected in logged data or the profile — a new goal, an upcoming event, a constraint, a preference — is forgotten the moment a new chat starts. The member wants continuous, compounding coaching: the app should change with them as needs and wants change over time.

Two gaps, two complementary fixes:

1. **No cross-conversation memory.** Stuffing past transcripts into the prompt bloats context and buries signal; what's needed is a store of _extracted durable facts_ the coach itself maintains.
2. **The profile captures facts and targets, not how to coach or why.** It has protein targets and injuries but nothing about coaching style, motivation, life context, or the member's current season of focus.

## Decision

### 1. Coach memory store (`coach-memories.json`, personal scope)

A new domain type in `src/lib/domain.ts`:

```ts
export type CoachMemoryCategory = "goal" | "preference" | "constraint" | "life_event" | "milestone";

export interface CoachMemory {
  id: string;
  category: CoachMemoryCategory;
  /** One durable fact in third person, e.g. "Training for a 5K in September with his daughter." */
  content: string;
  createdAt: number;
  updatedAt: number;
  /** Conversation the fact was learned in (traceability). */
  sourceConversationId?: string;
  deletedAt?: number;
}
```

Stored **personal-scoped** (memories are as private as chat transcripts) in `coach-memories.json` via `loadCoachMemoriesImpl` / `updateCoachMemoriesImpl` in `domain-impl.ts`, using the same etag-CAS update pattern as `chat-conversations.json`. Capped at **100 live memories** (oldest non-constraint entries dropped first); soft-deleted like conversations.

### 2. Writing memories: model tools, auto-applied client-side

Three new function tools alongside the existing four action tools in `src/server/chat.ts`:

- `save_memory(category, content)` — record a new durable fact.
- `update_memory(id, content, category?)` — revise a fact that changed ("gave up on the marathon" updates, not appends).
- `forget_memory(id)` — remove a fact the member disavows or that no longer applies.

The system prompt instructs the model to call these when the member shares something durable, and lists current memories **with their ids** so `update`/`forget` can target them.

**Why not write during the stream:** per ADR-017/018 the per-user scope is bound only inside the function middleware, and all store access must happen _before_ the streamed `Response` is returned. So memory tool-calls flow through the existing SSE `action` frames, and the **client auto-applies them** (no Apply button — memory is low-stakes and approval friction would kill it) through the scoped `applyChatAction` server fn, which is extended to handle memory actions directly against the memory impl (they don't map to voice intents). The chat UI renders an auto-applied memory as a subtle inline **"Remembered: …"** chip instead of an action card, so the member always sees what was written.

### 3. Reading memories: shared context injection

A `memoriesBlock(memories)` helper renders live memories — constraints and goals first, then by recency, capped at ~30 lines — into a **"What you remember about the member"** section:

- appended to `buildUserContextBlock` (`src/server/context.ts`) → every chat turn sees them;
- appended to the one-shot Coach prompt (`buildCoachPrompt` in `coach.ts`) → daily coaching also adapts, so memory improves the whole app, not just chat.

### 4. Adaptive profile fields (`UserProfile`)

New optional fields, all injected via `profileBlock`:

| field             | type                                 | why                                                                                                                 |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `coachingStyle`   | `"gentle" \| "balanced" \| "direct"` | the biggest lever on whether coaching feels personal                                                                |
| `motivation`      | `string`                             | the "why" behind the goals — lets nudges connect to what actually matters                                           |
| `lifeContext`     | `string`                             | work schedule, family, travel cadence — changes every recommendation                                                |
| `currentFocus`    | `string`                             | the member's current season ("cutting until August", "money first") — the field that makes the app change with them |
| `foodPreferences` | `string[]`                           | restrictions say what's forbidden; this says what will actually get eaten                                           |

`currentFocus` is the natural graduation path for memories: the coach can suggest promoting an observed theme into the profile.

### 5. Surfaces

- **Profile page** (`/profile`): a new **"Coaching style & context"** card for the fields above, and a **"What your coach remembers"** card listing live memories (category badge, relative time, delete button). Memory the member can't see or correct drifts wrong and feels creepy; visibility is what makes adaptive coaching trustworthy. Server fns: `loadCoachMemories`, `deleteCoachMemory`.
- **Chat page** (`/chat`): "Remembered" chips on auto-applied memory actions; no other UI change.

### 6. Fallbacks

No `GROK_API_KEY` → tools never fire; memory features degrade to empty sections exactly like an empty profile (AGENTS.md zero-config requirement). Empty memory store → the context section is omitted entirely.

## Consequences

- **Pro:** Continuous coaching across conversations with bounded prompt cost (extracted facts, not transcripts); one memory source feeds chat _and_ daily coaching; member-visible and correctable; reuses existing store, CAS, SSE-action, and scoped-server-fn patterns wholesale.
- **Con:** Memory quality depends on the model calling the tools well; a bad extraction persists until noticed (mitigated by the visible memory card + chips and `update`/`forget` tools). The memory list adds ~30 lines to every AI prompt.
- The one-tap approval invariant (ADR-018 "never auto-execute") is deliberately relaxed **only for memory writes**, which mutate coach context, not domain data (meals, tasks, money). Domain actions keep the Apply/Dismiss flow.

## Alternatives considered

1. **Inject recent conversation summaries instead of extracted facts.** Cheaper to build, but grows unboundedly, mixes signal with noise, and can't be corrected item-by-item.
2. **Post-turn extraction pass (second LLM call after each save).** Works without tool support and catches missed facts, but doubles LLM calls per turn; the tool-call path reuses the existing SSE plumbing at zero marginal cost. Can be added later as a supplement.
3. **Auto-execute memory writes server-side during the stream.** Simplest UX, but violates the scope-binding invariant (ADR-017): no store access after the streamed Response is returned. Client-side auto-apply through a scoped server fn preserves the invariant with identical UX.
