# ADR-018: Conversational Coach Chat (data-aware Grok chat with one-tap actions)

**Status**: Proposed
**Date**: 2026-06-28
**Deciders**: Brian Kimball

## Context

Compass already has an AI Coach (**ADR-011**) that produces **one-shot** cross-domain suggestions on the daily dashboard, and a voice pipeline (**ADR-004**) that turns a single utterance into a structured intent and executes it. What's missing is a **conversation** — a place to ask open-ended questions about your own recorded life ("how's my protein trending?", "am I on track for my savings goal?", "what should I cook tonight given my macros?") and to record things in natural language outside the one-shot voice flow ("log 40g protein", "add a task to call the dentist").

This ADR adds a dedicated **Coach** chat page: a streaming conversation with Grok that (1) reads the member's recorded health, nutrition, fitness, finance, tasks, and profile as context, and (2) can **take actions** the member approves with one tap.

## Decision

### Surface

A top-level **Coach** tab → `/chat` (`src/routes/chat.tsx`), built on shadcn/ui. Streaming assistant replies, an empty-state with example prompts, and inline **proposed-action cards** (Apply / Dismiss).

### Context (what the model sees)

A compact, **US-customary-units** text block — today's dashboard numbers + the trailing 7-day trend + the long-lived profile — assembled by `buildUserContextBlock` (`src/server/context.ts`). This **reuses the exact loaders and trend math the AI Coach already relies on** (`collectTrend`, `profileBlock` from `coach.ts`, now exported) so the conversational and one-shot coaches reason over one source of truth. **Finance** is pulled via `loadFinanceContextImpl` (`finance.ts`) from the Finance Hub — net worth from the **most-recent** snapshot (not just today's, which is usually unlogged) plus this month's transaction rollup and savings-goal progress — so "am I on track for my savings goal?" is answerable instead of reading as "not set up".

### Transport — own SSE, not the TanStack AI adapter

The original intent was TanStack AI's `chat()` + official OpenAI adapter (pointed at xAI's OpenAI-compatible API). **This is not installable on our pinned alpha stack:** the `@tanstack/ai*` family is interlocked with exact (minor-locked) peers — `@tanstack/ai-event-client@0.6.3` ⇄ `ai@0.32.0` — so the adapter (which needs `ai@^0.38`) forces a disruptive full-family upgrade, and a custom `BaseTextAdapter` would mean hand-emitting TanStack AI's internal AG-UI event protocol against undocumented alpha internals (no reference adapter ships). We chose the **pragmatic, robust path**: own the SSE transport, reusing the proven Grok integration.

- `streamChat()` (`src/server/adapters/ai.ts`) POSTs to `https://api.x.ai/v1/chat/completions` with `stream: true` and yields text deltas + accumulates `tool_calls` deltas — the **standard OpenAI-compatible wire format**, stable on xAI, independent of TanStack AI alpha internals. (`completeJSON` is unchanged, still used for the one-shot JSON tasks.)
- The chat model is env-overridable (`GROK_CHAT_MODEL`, default `grok-3`) and tool-capable — distinct from the cheap `grok-3-mini` used elsewhere.

### Server endpoint is a **server function**, not an `/api` route

`chatStream` (`src/server/chat.ts`) is a `createServerFn` that returns a raw `text/event-stream` `Response`. This is deliberate (ADR-017): domain data is only readable when the **per-user scope is bound**, and that binding happens only inside the global function middleware (`auth-middleware.ts`). All domain reads (context assembly) happen **before** the Response is returned — i.e. while the scope is bound — and the streamed body carries only LLM output, so no store access escapes the bound scope. TanStack Start returns a server-fn `Response` raw (`x-tss-raw`), so the client reads `response.body` directly via a small owned `useChatStream` hook.

### Actions: function-calling for detection, "propose → Apply → scoped write" for execution

The model is given OpenAI-compatible **function tools** (`log_meal`, `log_water`, `add_task`, `mark_task_done`) and may emit `tool_calls`. We **never auto-execute**: proposed calls are surfaced as action cards. On Apply, `applyChatAction` (a scoped server fn) maps the call to a `VoiceIntent` and runs the **shared voice-intent executor** (`executeVoiceIntentImpl`) — so chat and voice share one write path with no duplicated mutation logic. This mirrors the codebase's existing closed-loop accept pattern (ADR-014).

### Deterministic fallback

With no `GROK_API_KEY`, `chatStream` streams a single assistant message containing the member's data snapshot and a note to configure the key — the page stays functional with zero config (AGENTS.md requirement).

### Persistence & history

Conversations are **personal-scoped** (a member's chats are private, like health data) and stored in `chat-conversations.json` via `loadChatConversationsImpl`/`saveChatConversationsImpl`. The route saves the active conversation after every completed turn (`saveChatConversation`, keyed by a client-generated conversation id, title derived from the first user message). Server fns: `loadChatHistory` (lightweight summaries, recent-first), `loadChatConversation` (one full transcript), `saveChatConversation` (upsert, capped at 100 conversations / 400 messages), `deleteChatConversation` (soft delete). Pure helpers (`deriveTitle`/`toSummary`/`upsertConversation`/`sortByRecent`) live in `src/lib/chat.ts` so client and server share one definition. The route keeps a **module-level session cache** of the active transcript + summary list so navigating away and back to `/chat` restores instantly (no refetch flash); the store is the durable backing read on a fresh page load. A **History** drawer (shadcn `Sheet`) lists past chats with select/delete, and **New** starts a fresh conversation.

## Consequences

- **Pro:** Ships on the current dependency set with no alpha churn; reuses context, write, and unit conventions already in the app; privacy-safe by construction (scope-bound server fn; key stays server-only).
- **Con:** We don't use TanStack AI's transport/agent loop — if we later upgrade the whole `@tanstack/ai*` family to a coherent line, the owned SSE transport and `useChatStream` can be revisited. The owned SSE envelope (`delta`/`action`/`done`/`error`) is small and documented in `chat.ts`.
- Actions are limited to what the voice executor supports today (meals, water, tasks); workouts/transactions can be added by extending the executor + tool list later.

## Alternatives considered

1. **Upgrade the entire `@tanstack/ai*` stack to the 0.38 line + official `@tanstack/ai-openai`.** Most "TanStack-native", but 4–5 coupled alpha bumps plus a new (optional) `@mcp-ui/client` peer; re-verification cost and churn risk rejected for now.
2. **Custom `BaseTextAdapter` for xAI on the current 0.32 stack.** No dep churn, but requires hand-emitting the internal AG-UI event protocol with no shipped reference adapter — highest fidelity/maintenance risk.
3. **`/api/chat` route + manual scope binding.** Clean fetch semantics, but duplicates the security-critical scope-resolution logic outside the middleware — rejected to avoid scope-binding divergence (a data-leak risk).
